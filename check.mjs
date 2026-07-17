// Social notifier for the lightskingio Discord server.
// Runs on a GitHub Actions cron. No dependencies — Node 20+ global fetch only.
// State (last-seen ids / live status) persists in state.json, committed back by the workflow.
//
// Design notes:
// - State is ONLY advanced after a webhook post succeeds, so a failed post is retried
//   next run instead of being silently lost.
// - TikTok: tikwm's /api/user/posts sits behind a Cloudflare challenge much of the time,
//   but /api/user/info stays up. So we poll the cheap info endpoint for videoCount and
//   only reach for the (blocked-prone) posts endpoint when a new upload actually exists.
//   If posts is unavailable we still announce, just with a profile link instead of a direct one.

import { readFileSync, writeFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const state = JSON.parse(readFileSync('state.json', 'utf8'));

const WEBHOOKS = {
  tiktok: process.env.WEBHOOK_TIKTOK,
  live: process.env.WEBHOOK_LIVE,
  youtube: process.env.WEBHOOK_YOUTUBE,
};

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      if (res.ok) return text;
      last = `HTTP ${res.status}`;
    } catch (e) { last = e.message; }
    if (i < tries - 1) await sleep(2000 * (i + 1));
  }
  console.log(`  fetch failed (${last}): ${url.split('?')[0]}`);
  return null;
}

async function fetchJson(url, tries = 3) {
  const text = await fetchText(url, tries);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { console.log(`  non-JSON response: ${url.split('?')[0]}`); return null; }
}

const roleMentions = (ids) => ids.map((id) => `<@&${id}>`).join(' ');

// ---------- source health ----------
// A source that quietly stops working is the dangerous case: no pings, no complaints.
// Track consecutive failures per source and alert staff once when one goes dark.
state.health = state.health || {};
const ALERT_AFTER = 12; // ~1 hour at the 5-minute cron
// rss-bridge caches, so its feed can trail a fresh upload by a few minutes. Wait this many
// runs (~30 min) for the exact link before falling back to a profile-link announcement.
const FEED_LAG_PATIENCE = 6;

function noteFailure(source) {
  const h = (state.health[source] = state.health[source] || { fails: 0, alerted: false });
  h.fails++;
}
function noteSuccess(source) {
  const h = state.health[source];
  if (h?.alerted) console.log(`${source}: recovered after ${h.fails} failed checks`);
  state.health[source] = { fails: 0, alerted: false };
}

async function reportHealth() {
  const staff = config.staffChannelId;
  if (!staff || !process.env.BOT_TOKEN) return;
  for (const [source, h] of Object.entries(state.health)) {
    if (h.fails >= ALERT_AFTER && !h.alerted) {
      const res = await fetch(`https://discord.com/api/v10/channels/${staff}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `⚠️ **Notifier warning:** the **${source}** source has failed ${h.fails} checks in a row (~${Math.round(h.fails * 5 / 60)}h). Alerts for it may be delayed. It keeps retrying — nothing is lost, and I'll confirm here when it recovers.`,
          allowed_mentions: { parse: [] },
        }),
      }).catch(() => null);
      if (res?.ok) { h.alerted = true; console.log(`health: alerted staff about ${source}`); }
    }
  }
}

// Returns true only when Discord accepted the message.
async function post(webhook, content, roleIds) {
  if (!webhook) { console.log('  no webhook configured — not posting'); return false; }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [], roles: roleIds } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.error(`  webhook post failed: ${res.status} ${await res.text()}`); return false; }
    return true;
  } catch (e) { console.error(`  webhook post error: ${e.message}`); return false; }
}

// ---------- TikTok ----------
// Video list sources, in preference order. Both yield the exact video URL;
// rss-bridge is primary because tikwm's user/posts is usually Cloudflare-challenged.
async function tiktokList(user) {
  const feed = await fetchJson(
    `https://rss-bridge.org/bridge01/?action=display&bridge=TikTokBridge&context=By+user&username=${user}&format=Json`,
    2
  );
  const items = feed?.items;
  if (Array.isArray(items) && items.length) {
    const list = items
      .map((it) => ({ id: it.url?.match(/\/video\/(\d+)/)?.[1], url: it.url, title: (it.title || '').trim() }))
      .filter((v) => v.id);
    if (list.length) { console.log(`tiktok: feed via rss-bridge (${list.length} items)`); return list; }
  }
  const posts = await fetchJson(`https://www.tikwm.com/api/user/posts?unique_id=${user}&count=10`, 2);
  const videos = posts?.data?.videos;
  if (Array.isArray(videos) && videos.length) {
    console.log(`tiktok: feed via tikwm (${videos.length} items)`);
    return videos.map((v) => ({
      id: v.video_id,
      url: `https://www.tiktok.com/@${config.tiktok}/video/${v.video_id}`,
      title: (v.title || '').trim(),
    }));
  }
  return null;
}

async function checkTikTok() {
  if (!config.tiktok) return;
  const user = encodeURIComponent(config.tiktok);

  // Cheap change-detector: videoCount stays available even when list endpoints are blocked.
  const info = await fetchJson(`https://www.tikwm.com/api/user/info?unique_id=${user}`, 2);
  const count = info?.data?.stats?.videoCount;
  const haveCount = typeof count === 'number';
  if (haveCount) noteSuccess('tiktok'); else noteFailure('tiktok');

  if (haveCount && state.tiktokCount != null && count <= state.tiktokCount) {
    if (count < state.tiktokCount) { state.tiktokCount = count; console.log(`tiktok: count dropped to ${count} (post deleted)`); }
    else console.log(`tiktok: no new posts (${count})`);
    return;
  }
  if (haveCount && state.tiktokCount != null) console.log(`tiktok: videoCount ${state.tiktokCount} -> ${count}`);

  const list = await tiktokList(user);

  if (!list) {
    // No list source available. Still announce if we know something new exists.
    if (haveCount && state.tiktokCount != null && count > state.tiktokCount) {
      const n = count - state.tiktokCount;
      const ok = await post(
        WEBHOOKS.tiktok,
        `${roleMentions(config.roles.video)} 🎵 **Gio just dropped ${n > 1 ? `${n} new TikToks` : 'a new TikTok'}!**\nhttps://www.tiktok.com/@${config.tiktok}`,
        config.roles.video
      );
      if (ok) { state.tiktokCount = count; console.log('tiktok: announced via profile-link fallback'); }
      else console.log('tiktok: fallback post failed — state not advanced, will retry');
    } else console.log('tiktok: no source available, will retry next run');
    return;
  }

  if (!state.tiktokLast) {
    state.tiktokLast = list[0].id;
    if (haveCount) state.tiktokCount = count;
    console.log(`tiktok: baseline set to ${list[0].id}`);
    return;
  }

  const idx = list.findIndex((v) => v.id === state.tiktokLast);
  if (idx === 0) {
    // The feed's newest is what we already announced. If videoCount says a newer post
    // exists, the feed is just lagging (rss-bridge caches) — do NOT advance the count,
    // or the announcement would be suppressed forever once the feed catches up.
    if (haveCount && state.tiktokCount != null && count > state.tiktokCount) {
      state.tiktokWait = (state.tiktokWait || 0) + 1;
      if (state.tiktokWait <= FEED_LAG_PATIENCE) {
        console.log(`tiktok: videoCount=${count} says a new post exists but the feed is stale — waiting (${state.tiktokWait}/${FEED_LAG_PATIENCE})`);
        return;
      }
      // Feed never caught up (deleted/private post, or bridge is broken). Announce anyway.
      console.log('tiktok: feed never caught up — announcing via profile link');
      const n = count - state.tiktokCount;
      const ok = await post(
        WEBHOOKS.tiktok,
        `${roleMentions(config.roles.video)} 🎵 **Gio just dropped ${n > 1 ? `${n} new TikToks` : 'a new TikTok'}!**\nhttps://www.tiktok.com/@${config.tiktok}`,
        config.roles.video
      );
      if (ok) { state.tiktokCount = count; state.tiktokWait = 0; }
      else console.log('tiktok: fallback post failed — state not advanced, will retry');
      return;
    }
    console.log('tiktok: no new posts');
    state.tiktokWait = 0;
    if (haveCount) state.tiktokCount = count;
    return;
  }
  // idx === -1 means last-seen fell off the feed; announce only the newest to avoid a spam burst.
  const fresh = (idx === -1 ? [list[0]] : list.slice(0, idx)).reverse();

  for (const v of fresh) {
    const ok = await post(
      WEBHOOKS.tiktok,
      `${roleMentions(config.roles.video)} 🎵 **Gio just dropped a new TikTok!**\n${v.title ? `> ${v.title}\n` : ''}${v.url}`,
      config.roles.video
    );
    if (!ok) { console.log('tiktok: post failed — state not advanced, will retry'); return; }
    console.log(`tiktok: posted ${v.id}`);
    state.tiktokLast = v.id;
  }
  state.tiktokWait = 0;
  if (haveCount) state.tiktokCount = count;
}

// ---------- Twitch ----------
// Returns true (live), false (offline), or null (unknown — never guess, a false
// positive would ping the whole server for a stream that isn't running).
async function twitchLive(login) {
  // Primary: Twitch's own GQL endpoint (structured, unambiguous).
  try {
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json', ...UA },
      body: JSON.stringify([{
        operationName: 'UseLive',
        variables: { channelLogin: login },
        extensions: { persistedQuery: { version: 1, sha256Hash: '639d5f11bfb8bf3053b424d9ef650d04c4ebb7d94711d644afb08fe9a0fad5d9' } },
      }]),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) {
      const data = (await r.json())?.[0]?.data;
      if (data && 'user' in data) {
        if (data.user === null) { console.log(`twitch: channel "${login}" not found — check config.twitch`); return null; }
        return !!data.user.stream;
      }
    }
    console.log(`  twitch gql: unusable response (HTTP ${r.status}), trying decapi`);
  } catch (e) { console.log(`  twitch gql failed (${e.message}), trying decapi`); }

  // Fallback: decapi, parsed strictly — anything unrecognized is "unknown", not "live".
  const text = await fetchText(`https://decapi.me/twitch/uptime/${encodeURIComponent(login)}`, 2);
  if (text === null) return null;
  const t = text.trim();
  if (/^\d+\s+(second|minute|hour|day)/i.test(t)) return true;
  if (/is offline/i.test(t)) return false;
  console.log(`  twitch decapi: unrecognized response "${t.slice(0, 60)}" — treating as unknown`);
  return null;
}

async function checkTwitch() {
  if (!config.twitch) { console.log('twitch: not configured'); return; }
  const isLive = await twitchLive(config.twitch);
  if (isLive === null) { noteFailure('twitch'); console.log('twitch: status unknown, will retry'); return; }
  noteSuccess('twitch');

  if (isLive && !state.twitchLive) {
    const ok = await post(
      WEBHOOKS.live,
      `${roleMentions(config.roles.live)} 🔴 **GIO IS LIVE ON TWITCH!** Get in here 👇\nhttps://twitch.tv/${config.twitch}`,
      config.roles.live
    );
    if (!ok) { console.log('twitch: post failed — state not advanced, will retry'); return; }
    console.log('twitch: went live, posted');

    if (process.env.BOT_TOKEN && config.contest?.guildId) {
      const start = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      const end = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      const r = await fetch(`https://discord.com/api/v10/guilds/${config.contest.guildId}/scheduled-events`, {
        method: 'POST',
        headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '🔴 Gio is LIVE on Twitch',
          entity_type: 3,
          entity_metadata: { location: `https://twitch.tv/${config.twitch}` },
          scheduled_start_time: start,
          scheduled_end_time: end,
          privacy_level: 2,
          description: 'Stream is up — pull up!',
        }),
      }).catch(() => null);
      console.log(`twitch: scheduled event ${r?.ok ? 'created' : 'skipped'}`);
    }
    state.twitchLive = true;
  } else {
    if (!isLive && state.twitchLive) console.log('twitch: stream ended');
    else console.log(`twitch: live=${isLive}`);
    state.twitchLive = isLive;
  }
}

// ---------- YouTube (official RSS) ----------
const decodeEntities = (s) => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&'); // last, so "&amp;lt;" doesn't become "<"

async function checkYouTube() {
  if (!config.youtubeChannelId) { console.log('youtube: not configured'); return; }
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${config.youtubeChannelId}`);
  if (xml === null) { noteFailure('youtube'); console.log('youtube: feed unavailable, will retry'); return; }
  if (!xml.includes('<feed')) {
    noteFailure('youtube');
    console.log('youtube: response is not an RSS feed (bad channel id?) — will retry');
    return;
  }
  noteSuccess('youtube');

  const entries = [...xml.matchAll(/<entry>[\s\S]*?<yt:videoId>(.*?)<\/yt:videoId>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/entry>/g)];
  if (!entries.length) { console.log('youtube: feed has no videos yet'); return; }

  const newestId = entries[0][1];
  if (!state.youtubeLast) {
    state.youtubeLast = newestId;
    console.log(`youtube: baseline set to ${newestId}`);
    return;
  }
  if (newestId === state.youtubeLast) { console.log('youtube: no new videos'); return; }

  const lastIdx = entries.findIndex(([, id]) => id === state.youtubeLast);
  // last-seen missing from the feed => only announce the newest, never a backlog burst
  const fresh = (lastIdx === -1 ? [entries[0]] : entries.slice(0, lastIdx)).reverse();
  for (const [, id, rawTitle] of fresh) {
    const title = decodeEntities(rawTitle).trim();
    const ok = await post(
      WEBHOOKS.youtube,
      `${roleMentions(config.roles.video)} ▶️ **New Gio video on YouTube!**\n${title ? `> ${title}\n` : ''}https://youtu.be/${id}`,
      config.roles.video
    );
    if (!ok) { console.log('youtube: post failed — state not advanced, will retry'); return; }
    console.log(`youtube: posted ${id}`);
    state.youtubeLast = id;
  }
}

const names = ['tiktok', 'twitch', 'youtube'];
const results = await Promise.allSettled([checkTikTok(), checkTwitch(), checkYouTube()]);
results.forEach((r, i) => {
  if (r.status === 'rejected') {
    console.error(`${names[i]} check crashed:`, r.reason);
    noteFailure(names[i]); // a thrown check is a failed check
  }
});

await reportHealth();
writeFileSync('state.json', JSON.stringify(state, null, 2) + '\n');
console.log('health:', JSON.stringify(state.health));
console.log('done');

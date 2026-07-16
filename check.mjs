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
    console.log('tiktok: no new posts');
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
  if (haveCount) state.tiktokCount = count;
}

// ---------- Twitch (decapi.me, no auth) ----------
async function checkTwitch() {
  if (!config.twitch) { console.log('twitch: not configured'); return; }
  const text = await fetchText(`https://decapi.me/twitch/uptime/${encodeURIComponent(config.twitch)}`);
  if (text === null) { console.log('twitch: unavailable, will retry'); return; }
  const t = text.trim();
  const isLive = !/is offline|error|not found|no user|unable/i.test(t) && /\d/.test(t);

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
async function checkYouTube() {
  if (!config.youtubeChannelId) { console.log('youtube: not configured'); return; }
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${config.youtubeChannelId}`);
  if (xml === null) { console.log('youtube: feed unavailable, will retry'); return; }
  const entries = [...xml.matchAll(/<entry>[\s\S]*?<yt:videoId>(.*?)<\/yt:videoId>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/entry>/g)];
  if (!entries.length) { console.log('youtube: no entries'); return; }

  const [, newestId] = entries[0];
  if (!state.youtubeLast) {
    state.youtubeLast = newestId;
    console.log(`youtube: baseline set to ${newestId}`);
    return;
  }
  if (entries[0][1] === state.youtubeLast) { console.log('youtube: no new videos'); return; }

  const lastIdx = entries.findIndex(([, id]) => id === state.youtubeLast);
  const fresh = (lastIdx === -1 ? [entries[0]] : entries.slice(0, lastIdx)).reverse();
  for (const [, id, title] of fresh) {
    const ok = await post(
      WEBHOOKS.youtube,
      `${roleMentions(config.roles.video)} ▶️ **New Gio video on YouTube!**\n> ${title}\nhttps://youtu.be/${id}`,
      config.roles.video
    );
    if (!ok) { console.log('youtube: post failed — state not advanced, will retry'); return; }
    console.log(`youtube: posted ${id}`);
    state.youtubeLast = id;
  }
}

const results = await Promise.allSettled([checkTikTok(), checkTwitch(), checkYouTube()]);
for (const r of results) if (r.status === 'rejected') console.error('check crashed:', r.reason);

writeFileSync('state.json', JSON.stringify(state, null, 2) + '\n');
console.log('done');

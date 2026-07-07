// Social notifier for the lightskingio Discord server.
// Runs on a GitHub Actions cron. No dependencies — Node 20+ global fetch only.
// State (last-seen post ids / live status) persists in state.json, committed back by the workflow.

import { readFileSync, writeFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const state = JSON.parse(readFileSync('state.json', 'utf8'));

const WEBHOOKS = {
  tiktok: process.env.WEBHOOK_TIKTOK,
  live: process.env.WEBHOOK_LIVE,
  youtube: process.env.WEBHOOK_YOUTUBE,
};

const UA = { 'User-Agent': 'Mozilla/5.0 (gio-notifier)' };

function roleMentions(ids) {
  return ids.map((id) => `<@&${id}>`).join(' ');
}

async function post(webhook, content, roleIds) {
  if (!webhook) { console.log('skip post — webhook not configured'); return; }
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [], roles: roleIds },
    }),
  });
  if (!res.ok) console.error(`webhook post failed: ${res.status} ${await res.text()}`);
}

// ---------- TikTok (via tikwm.com public API) ----------
async function checkTikTok() {
  if (!config.tiktok) return;
  const res = await fetch(
    `https://www.tikwm.com/api/user/posts?unique_id=${encodeURIComponent(config.tiktok)}&count=10`,
    { headers: UA }
  );
  const json = await res.json();
  const videos = json?.data?.videos;
  if (!Array.isArray(videos) || videos.length === 0) {
    console.log('tiktok: no data (api may be rate-limited), skipping');
    return;
  }
  // videos come newest-first
  const newest = videos[0].video_id;
  if (!state.tiktokLast) {
    state.tiktokLast = newest;
    console.log(`tiktok: baseline set to ${newest}`);
    return;
  }
  const lastIdx = videos.findIndex((v) => v.video_id === state.tiktokLast);
  const fresh = lastIdx === -1 ? [videos[0]] : videos.slice(0, lastIdx);
  for (const v of fresh.reverse()) {
    const title = (v.title || '').trim();
    const url = `https://www.tiktok.com/@${config.tiktok}/video/${v.video_id}`;
    await post(
      WEBHOOKS.tiktok,
      `${roleMentions(config.roles.video)} 🎵 **Gio just dropped a new TikTok!**\n${title ? `> ${title}\n` : ''}${url}`,
      config.roles.video
    );
    console.log(`tiktok: posted ${v.video_id}`);
  }
  state.tiktokLast = newest;
}

// ---------- Twitch (via decapi.me, no auth) ----------
async function checkTwitch() {
  if (!config.twitch) { console.log('twitch: not configured, skipping'); return; }
  const res = await fetch(`https://decapi.me/twitch/uptime/${encodeURIComponent(config.twitch)}`, { headers: UA });
  const text = (await res.text()).trim();
  const isLive = !/is offline|error|not found|no user/i.test(text) && /\d/.test(text);
  if (isLive && !state.twitchLive) {
    await post(
      WEBHOOKS.live,
      `${roleMentions(config.roles.live)} 🔴 **GIO IS LIVE ON TWITCH!** Get in here 👇\nhttps://twitch.tv/${config.twitch}`,
      config.roles.live
    );
    console.log('twitch: went live, posted');
  } else {
    console.log(`twitch: live=${isLive} (was ${!!state.twitchLive})`);
  }
  state.twitchLive = isLive;
}

// ---------- YouTube (via official RSS feed) ----------
async function checkYouTube() {
  if (!config.youtubeChannelId) { console.log('youtube: not configured, skipping'); return; }
  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${config.youtubeChannelId}`,
    { headers: UA }
  );
  if (!res.ok) { console.log(`youtube: feed http ${res.status}, skipping`); return; }
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>[\s\S]*?<yt:videoId>(.*?)<\/yt:videoId>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/entry>/g)];
  if (entries.length === 0) return;
  const [, newestId, newestTitle] = entries[0];
  if (!state.youtubeLast) {
    state.youtubeLast = newestId;
    console.log(`youtube: baseline set to ${newestId}`);
    return;
  }
  const lastIdx = entries.findIndex(([, id]) => id === state.youtubeLast);
  const fresh = lastIdx === -1 ? [entries[0]] : entries.slice(0, lastIdx);
  for (const [, id, title] of fresh.reverse()) {
    await post(
      WEBHOOKS.youtube,
      `${roleMentions(config.roles.video)} ▶️ **New Gio video on YouTube!**\n> ${title}\nhttps://youtu.be/${id}`,
      config.roles.video
    );
    console.log(`youtube: posted ${id}`);
  }
  state.youtubeLast = newestId;
}

const results = await Promise.allSettled([checkTikTok(), checkTwitch(), checkYouTube()]);
for (const r of results) if (r.status === 'rejected') console.error('check failed:', r.reason);

writeFileSync('state.json', JSON.stringify(state, null, 2) + '\n');
console.log('done');

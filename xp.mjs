// Daily XP crawl — free replacement for MEE6 leveling (which is now paywalled).
// Counts yesterday's messages in community channels, awards XP, auto-grants
// ⭐ OG Fan at the threshold, and posts a leaderboard every Sunday.

import { readFileSync, writeFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const { guildId } = config.contest;
const { channels, ogFanRoleId, ogFanXp, leaderboardChannelId } = config.xp;
const H = { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' };
const api = (p, opts = {}) => fetch(`https://discord.com/api/v10${p}`, { headers: H, ...opts });

let xp = {};
try { xp = JSON.parse(readFileSync('xp.json', 'utf8')); } catch {}
xp.users ??= {};
xp.ogFanGranted ??= [];

const DAY_MS = 24 * 60 * 60 * 1000;
const since = xp.lastRun ? new Date(xp.lastRun).getTime() : Date.now() - DAY_MS;

// --- count messages per author since last run (max 100/channel/day is plenty at this size) ---
const counts = {};
const names = {};
for (const ch of channels) {
  const res = await api(`/channels/${ch}/messages?limit=100`);
  if (!res.ok) { console.log(`skip channel ${ch}: http ${res.status}`); continue; }
  const msgs = await res.json();
  for (const m of msgs) {
    if (m.author.bot) continue;
    if (new Date(m.timestamp).getTime() <= since) continue;
    counts[m.author.id] = (counts[m.author.id] || 0) + 1;
    names[m.author.id] = m.author.username;
  }
}

// --- award XP: 5 per message, capped at 100/day per user (anti-spam) ---
for (const [uid, n] of Object.entries(counts)) {
  const gained = Math.min(n * 5, 100);
  xp.users[uid] = { xp: (xp.users[uid]?.xp || 0) + gained, name: names[uid] };
  console.log(`${names[uid]}: +${gained} xp (total ${xp.users[uid].xp})`);
}

// --- OG Fan auto-grant ---
for (const [uid, u] of Object.entries(xp.users)) {
  if (u.xp >= ogFanXp && !xp.ogFanGranted.includes(uid)) {
    const r = await api(`/guilds/${guildId}/members/${uid}/roles/${ogFanRoleId}`, { method: 'PUT' });
    if (r.ok) {
      xp.ogFanGranted.push(uid);
      await api(`/channels/${leaderboardChannelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: `⭐ **<@${uid}> just earned OG Fan** by being one of the most active people here. Respect. 🫡`,
          allowed_mentions: { parse: ['users'] },
        }),
      });
      console.log(`OG Fan granted: ${u.name}`);
    }
  }
}

// --- Sunday leaderboard ---
if (new Date().getUTCDay() === 0) {
  const top = Object.entries(xp.users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
  if (top.length > 0) {
    const medals = ['🥇', '🥈', '🥉'];
    const lines = top.map(([uid, u], i) => `${medals[i] || '▫️'} <@${uid}> — **${u.xp} XP**`);
    await api(`/channels/${leaderboardChannelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: `# 🏆 Weekly Activity Leaderboard\n${lines.join('\n')}\n\nChat more, climb higher. ⭐ OG Fan unlocks at **${ogFanXp} XP**.`,
        allowed_mentions: { parse: [] },
      }),
    });
    console.log('leaderboard posted');
  }
}

xp.lastRun = new Date().toISOString();
writeFileSync('xp.json', JSON.stringify(xp, null, 2) + '\n');
console.log('xp state saved');

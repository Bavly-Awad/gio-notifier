// Clip of the Week — runs every Friday.
// 1) Crowns last week's winner: the non-bot message in #clips with the most reactions.
// 2) Announces the new round.

import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const { guildId, clipsChannelId, clipEditorRoleId } = config.contest;
const TOKEN = process.env.BOT_TOKEN;
const H = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };
const api = (path, opts = {}) =>
  fetch(`https://discord.com/api/v10${path}`, { headers: H, ...opts });

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const cutoff = Date.now() - WEEK_MS;

// --- resolve last week's winner ---
const res = await api(`/channels/${clipsChannelId}/messages?limit=100`);
const messages = await res.json();
if (!Array.isArray(messages)) {
  console.error('failed to fetch messages:', JSON.stringify(messages));
  process.exit(1);
}

const entries = messages.filter((m) =>
  !m.author.bot &&
  new Date(m.timestamp).getTime() > cutoff &&
  (m.attachments?.length > 0 || m.embeds?.length > 0 || /https?:\/\//.test(m.content))
);

// everyone who entered this week gets pinged with the results (capped to keep it sane)
const participants = [...new Set(entries.map((m) => m.author.id))].slice(0, 20);

let announcement = '';
if (entries.length === 0) {
  announcement = 'No entries last week — this is your week to take it. 👀\n\n';
  console.log('no entries last week');
} else {
  const score = (m) => (m.reactions || []).reduce((s, r) => s + r.count, 0);
  const winner = entries.reduce((a, b) => (score(b) > score(a) ? b : a));
  const pts = score(winner);
  if (pts > 0) {
    if (!participants.includes(winner.author.id)) participants.unshift(winner.author.id);
    await api(`/guilds/${guildId}/members/${winner.author.id}/roles/${clipEditorRoleId}`, {
      method: 'PUT',
    });
    announcement =
      `🏆 **Last week's Clip of the Week goes to <@${winner.author.id}>** with ${pts} reactions! ` +
      `They now hold the ✂️ Clip Editor role.\n` +
      `https://discord.com/channels/${guildId}/${clipsChannelId}/${winner.id}\n\n`;
    console.log(`winner: ${winner.author.username} (${pts} reactions)`);
  } else {
    announcement = 'Entries last week got no reactions — react to the clips you like or the crown stays unclaimed! 👑\n\n';
    console.log('entries existed but no reactions');
  }
}

// --- announce the new round, pinging the people who care ---
// - this week's entrants (they want the results)
// - the ✂️ Clip Editor role (past winners: defend the crown)
// The bot's admin perms let it ping the role even though members can't.
const entrantLine = participants.length
  ? `🎬 This week's entrants: ${participants.map((id) => `<@${id}>`).join(' ')}\n\n`
  : '';
await api(`/channels/${clipsChannelId}/messages`, {
  method: 'POST',
  body: JSON.stringify({
    content:
      announcement +
      entrantLine +
      `# ✂️ CLIP OF THE WEEK — new round starts NOW\n` +
      `<@&${clipEditorRoleId}> — you hold the crown. Defend it. 👑\n\n` +
      `Post your best Gio clip or edit in this channel. The entry with the **most reactions by next Friday** wins:\n` +
      `> 🏆 The ✂️ Clip Editor role\n> 📣 A shoutout right here\n\n` +
      `One rule: it has to be YOUR edit. Cook. 🔥`,
    allowed_mentions: { parse: [], users: participants, roles: [clipEditorRoleId] },
  }),
});
console.log(`new round announced (pinged ${participants.length} entrants + Clip Editor role)`);

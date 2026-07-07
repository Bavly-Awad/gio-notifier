// Weekly config snapshot: roles, channels + overwrites, guild settings,
// AutoMod rules, onboarding, welcome screen -> backups/YYYY-MM-DD.json
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const G = config.contest.guildId;
const H = { Authorization: `Bot ${process.env.BOT_TOKEN}` };
const get = async (p) => {
  const r = await fetch(`https://discord.com/api/v10${p}`, { headers: H });
  return r.ok ? r.json() : { _error: r.status, _path: p };
};

const snapshot = {
  takenAt: new Date().toISOString(),
  guild: await get(`/guilds/${G}`),
  roles: await get(`/guilds/${G}/roles`),
  channels: await get(`/guilds/${G}/channels`),
  automod: await get(`/guilds/${G}/auto-moderation/rules`),
  onboarding: await get(`/guilds/${G}/onboarding`),
  welcomeScreen: await get(`/guilds/${G}/welcome-screen`),
};

mkdirSync('backups', { recursive: true });
const file = `backups/${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`snapshot written: ${file} (${snapshot.roles.length ?? '?'} roles, ${snapshot.channels.length ?? '?'} channels)`);

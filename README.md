# gio-notifier

Pings the lightskingio Discord server when Gio posts on his socials. Runs free on GitHub Actions every ~5 minutes.

| Source | How | Where it posts |
|---|---|---|
| TikTok `@lightskin.gio` | tikwm.com public API | #tiktok-uploads + Video Ping roles |
| Twitch live | decapi.me (no auth) | #live-streams + Live/Twitch Ping roles |
| YouTube uploads | official RSS feed | #youtube-uploads + Video Ping roles |

## Config

Edit [config.json](config.json):

- `twitch` — Twitch username (empty = disabled)
- `youtubeChannelId` — the `UC...` channel id (empty = disabled)

Webhook URLs live in repo **Settings → Secrets and variables → Actions**:
`WEBHOOK_TIKTOK`, `WEBHOOK_LIVE`, `WEBHOOK_YOUTUBE`.

## Notes

- First run for each source sets a baseline and does not ping.
- `state.json` is committed back by the workflow to remember what was already announced.
- GitHub cron is best-effort: real-world interval is usually 5–15 minutes.

# Key rotation runbook

Scope: every credential Quoky holds (ADR-0121 S0, MSIT item 3-3). Rule zero: a new value is typed by the owner into a
hidden dialog on the Mac. It is never pasted into Discord, Telegram, an issue, a commit or an AI chat. Token
rotation is scheduled for later; this runbook is for that day and for any incident.

## 1. Inventory

| Credential | Where it lives | Variable or file |
|---|---|---|
| Discord bot token | `.env.local` | `DISCORD_BOT_TOKEN` |
| Telegram bot token | `.env.local` | `QUOKY_TELEGRAM_BOT_TOKEN` |
| Google OAuth refresh tokens (Calendar, Gmail, Drive) | 0600 token files in the data dir; client id/secret in `.env.local` | `QUOKY_CALENDAR_GOOGLE_TOKEN_FILE`, `QUOKY_GMAIL_TOKEN_FILE`, `QUOKY_DRIVE_TOKEN_FILE`, `QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET` |
| Atlassian API token (Jira and Confluence share one) | `.env.local` | `QUOKY_JIRA_TOKEN`, `QUOKY_CONFLUENCE_TOKEN` |
| Slack token (read) and write token | `.env.local` | `QUOKY_SLACK_TOKEN`, `QUOKY_CONNECTOR_WRITE_SLACK_TOKEN` |
| GitHub App private key / fallback token | key file path, `.env.local` | `QUOKY_GITHUB_APP_PRIVATE_KEY_PATH`, `QUOKY_GITHUB_TOKEN` |
| OpenAI / Gemini keys (only if enabled) | `.env.local` | `QUOKY_OPENAI_API_KEY`, `QUOKY_GEMINI_API_KEY` |
| Ops-UI token | per-start file, 0600, minted at each start | `ops-ui.token` in the data dir (nothing to rotate; restart mints a new one) |

## 2. Entering a new value (all credentials)

Use a hidden macOS dialog; the value never appears in the terminal, history or chat. Run in the owner's own terminal,
in the repository, with the service stopped (`quokyctl.sh uninstall --apply`) or restarted afterwards:

```bash
KEY=QUOKY_TELEGRAM_BOT_TOKEN   # the variable name from the table
NEW="$(osascript -e "text returned of (display dialog \"New value for $KEY\" default answer \"\" with hidden answer)")" || exit 1
[ -n "$NEW" ] || exit 1
umask 077
KEY="$KEY" NEWVAL="$NEW" perl -0pi -e '$k=$ENV{KEY}; $v=$ENV{NEWVAL}; if (!s/^\Q$k\E=.*$/$k="$v"/m) { $_ .= "\n$k=\"$v\"\n" }' .env.local
unset NEW
chmod 600 .env.local && ls -l .env.local
```

The value is double-quoted because a value containing `#` would otherwise be cut. Check only the variable name and
mode (`grep -c '^QUOKY_TELEGRAM_BOT_TOKEN=' .env.local`), never print the value. Then restart
(`quokyctl.sh install --apply` or `restart --apply`) and run the verification in the section for that credential. The
Google token files are different: re-run `node apps/quoky/dist/tools/calendar-auth.js --out <new file> ...`, which writes a new
0600 file after the browser consent (see its header for `--gmail`, `--drive`, `--with-events`), then point the
`*_TOKEN_FILE` variable at the new file the same way.

## 3. Per credential

### Discord bot
- **Revoke and re-issue:** Discord Developer Portal, the application, Bot, Reset Token (the old one stops working at once).
- **Enter:** section 2 with `DISCORD_BOT_TOKEN`. Restart.
- **Verify:** `quokyctl.sh status`; the logs show the gateway login; send the owner DM a test message.
- **Usage history:** no per-token log exists in Discord. Check the bot's server audit log and the Quoky logs and ledger
  (destinations `discord.com`, `gateway.discord.gg`) for the exposure window.

### Telegram bot
- **Revoke and re-issue:** BotFather, `/mybots`, the bot, API Token, Revoke current token (or `/revoke`). A new token is issued at once.
- **Enter:** section 2 with `QUOKY_TELEGRAM_BOT_TOKEN`. Restart. A restart after a long stop resumes polling from the stored offset.
- **Verify:** `quokyctl.sh telegram` (read-only state), then an owner message.
- **Usage history:** Telegram offers none; use the Quoky ledger (`api.telegram.org`) and logs. Also confirm 2-step verification on the owner account.

### Google OAuth (Gmail, Drive, Calendar)
- **Revoke:** myaccount.google.com, Security, Third-party access, remove the Quoky OAuth app (this revokes every refresh
  token for it); also delete the old token files after the incident evidence is saved.
- **Re-issue:** run `calendar-auth.js` once per scope set (Calendar read/write, `--gmail`, `--drive`) and enter the new file path.
  If the client secret was exposed, rotate it in Google Cloud Console, Credentials, then enter `QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET` (section 2).
- **Verify:** an owner request for each connector (calendar, mail, Drive listing).
- **Usage history:** myaccount.google.com, Security, Recent security activity and the device list; Google Workspace
  admins can query the OAuth token audit log. Gmail "Last account activity" (Details) shows access by IP.

### Atlassian (Jira and Confluence)
- **Revoke and re-issue:** id.atlassian.com, Security, API tokens, revoke the old one, create a new one (set an
  expiry; prefer a scoped token). One token serves both products, so update `QUOKY_JIRA_TOKEN` and `QUOKY_CONFLUENCE_TOKEN`.
- **Verify:** an owner Jira search and a Confluence read.
- **Usage history:** admin.atlassian.com, the organization audit log; a token shows its last-used date on the API tokens page.

### Slack
- **Revoke and re-issue:** api.slack.com/apps, the app, OAuth and Permissions, Revoke Tokens, reinstall, copy the new user token and the write token (two
  separate tokens: `QUOKY_SLACK_TOKEN` and `QUOKY_CONNECTOR_WRITE_SLACK_TOKEN`).
- **Verify:** an owner Slack search; for the write token, a test approval card on a scratch channel.
- **Usage history:** workspace admin, Analytics and Access logs (Slack admins), and the app's Event Subscriptions / API call log.

### GitHub
- **Revoke and re-issue:** for the App, github.com settings, Developer settings, GitHub Apps, the app, Private keys:
  delete the exposed key, generate a new one, replace the file at `QUOKY_GITHUB_APP_PRIVATE_KEY_PATH` (0600; installation
  tokens are short-lived and expire by themselves). For a personal token: Settings, Developer settings, Tokens, Delete, then create a fine-grained one.
- **Verify:** an owner code-work read of an allowlisted repository.
- **Usage history:** the organization or personal Security log (Settings, Security log) filtered by the token or app; the app's Advanced tab shows recent deliveries.

### OpenAI / Gemini (only if enabled)
- Delete the key in the provider console, create a new one, enter it with section 2, and read the provider's usage page for the exposure window.

## 4. After any rotation

1. `pnpm security:secret-scan` (no new hit) and `ops/security/quoky-net-selfcheck.sh` (exit 0).
2. Write the date, credential, reason and usage-history result in the owner's rotation log (outside the repository).
3. If a value was ever committed or pasted somewhere shared, treat it as exposed even after deletion: rotate it and
   follow `security-incident-response.md`.

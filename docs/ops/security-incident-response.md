# Security incident response runbook

Scope: Quoky Platform on the owner's Mac (launchd service `com.quoky.personal`). Source: ADR-0121 S0, design
`docs/plans/agent-security-design-2026-10-13.md` section 4 (MSIT item 5-5). Everything here is an owner action; no step
sends a secret through chat.

## 1. Triggers

Treat any of these as an incident: a credential appears somewhere it should not (chat, log, repository, screenshot);
an unexpected destination or listener in the self-check; an unexpected owner DM or an action the owner did not ask for;
a security-team or vendor alert about this host or an account Quoky uses; excessive or unexplained traffic.

## 2. First 15 minutes: contain

1. **Stop the service.** `ops/launchd/quokyctl.sh uninstall --apply` unloads the agent and keeps data and logs
   (`quokyctl.sh status` confirms). Emergency alternative: `launchctl bootout gui/$(id -u)/com.quoky.personal`.
   If the agent kill switch exists (ADR-0121 S2), turn it off first; it never replaces stopping the service.
2. **Disable the bots** so a restart cannot reconnect: Discord Developer Portal, the application, Bot, Reset Token (also
   invalidates the old one); Telegram, BotFather `/revoke` for the bot. These two are also the fastest revocations
   (see `key-rotation.md`).
3. **Isolate the host from the network if the host itself is suspect:** turn Wi-Fi off (`networksetup -setairportpower
   en0 off`) and unplug Ethernet. Do not shut the Mac down yet; memory and connections are evidence.
4. **Do not delete anything.** No log cleanup, no `git` history rewrite, no token file removal until step 3.

## 3. Preserve evidence (before anything is rotated away)

Copy into a new directory `~/quoky-incident-YYYYMMDD-HHMM/` (mode 700), read-only afterwards:

- Service logs: `~/Library/Logs/Quoky/quoky.log*` (launcher and app logs).
- The traffic ledger: `egress-*.jsonl` under the Quoky data directory (`~/Library/Application Support/Quoky/audit/`
  or `data/audit/`; see `quoky-net-selfcheck.sh`, which prints the ledger state). Retention is 90 days, so copy now.
- The database and ops files: `~/Library/Application Support/Quoky/quoky.db` (use `quokyctl.sh backup --apply` while
  the service still runs, or copy the file after the stop) and `ops/`.
- The self-check output: `ops/security/quoky-net-selfcheck.sh > report.txt; ops/security/quoky-net-selfcheck.sh --json > report.json`.
- Host state: `ps -axo pid,ppid,lstart,comm > ps.txt`, `lsof -nP -i > lsof.txt`, `netstat -an > netstat.txt`,
  `ifconfig > ifconfig.txt`, `scutil --nc list > vpn.txt`. These contain no secrets; still review before sharing.
- Do **not** copy `.env.local` or the OAuth token files into the evidence folder; keep them where they are.
- Record a timeline: when noticed, what was seen, who was told, what was done (UTC and KST).

## 4. Rotate (after evidence is saved)

Follow `docs/ops/key-rotation.md`. Order by blast radius: Discord bot, Telegram bot, GitHub (App key or token), Slack,
Atlassian, Google OAuth grants, then the ops-UI token (deleted at restart: a new one is minted). For every
credential, check its usage history for the exposure window and put the result in the timeline.

## 5. Report

1. **Company security team first**, immediately, with the evidence folder summary (not the files by email). Share the
   self-check report; it is designed to be handed over.
2. **MSIT / KISA (KRCERT/CC):** the company security team normally files. If a report is required and has not been
   made, report at **boho.or.kr** (online incident report) or call **118** (KISA hotline, 24 h). Have ready: when
   it started, affected systems and accounts, what data may be involved, actions taken, contact person. Report within the
   period the company policy sets; do not wait for the root cause.
3. **Vendors:** Discord, Telegram, GitHub, Atlassian, Slack and Google each have an abuse or security contact; use it when
   an account was misused. Personal data exposure follows the company privacy-officer procedure.

## 6. Recover and close

1. Run `ops/security/quoky-net-selfcheck.sh` on the clean host: exit 0 is required before restart.
2. `pnpm security:secret-scan` and fix any new hit; rewrite history only with owner approval (it changes shared refs).
3. Re-enter the new credentials through the hidden dialog (`key-rotation.md` section 2), restart with
   `quokyctl.sh install --apply`, verify one owner DM round trip.
4. Write a short post-incident note (cause, timeline, fixes) and update the design or this runbook.

## 7. Owner contact steps

| Who | When | How |
|---|---|---|
| Owner (Jonghyung Jeon) | Any alert or finding | Discord DM from Quoky (if alive), then phone/KakaoTalk |
| Company security team | Step 5.1 | Internal security channel or the on-call number; attach the self-check report |
| KISA | If the company asks or reporting is required | boho.or.kr, or 118 |

Keep the on-call phone numbers outside the repository (a personal password-manager note); this file lists no numbers or
addresses.

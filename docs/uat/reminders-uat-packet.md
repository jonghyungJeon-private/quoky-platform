# Quoky Personal v2 — Owner Reminders Attended Live UAT Packet (ADR-0101)

> **This packet describes how to run the attended reminders Live UAT. Executing any part of it requires a separate,
> exact-scope Strict Product Owner approval** (`docs/governance/DEVELOPMENT-MODE.md`, ADR-0101 "Strict gates").
> Authoring or merging this document grants no runtime, Discord, `.env.local`, dev-DB or secret authority. Part B
> (channel delivery) needs its **own** separate approval on top of Part A's.

Status: **NOT EXECUTED.** Offline acceptance is the prerequisite and covers the composition, the tick lifecycle,
at-most-once dispatch, restart catch-up and FIRING recovery with fakes:
`apps/quoky/src/reminders/reminder-acceptance.test.ts`, `apps/quoky/src/reminders/reminder-tick-driver.test.ts`,
`packages/core/src/application/reminders/*.test.ts`, `packages/adapter-discord/src/notification.test.ts`,
`packages/storage-sqlite/src/reminder-repository.test.ts`. This packet covers only what fakes cannot prove: a real
Discord gateway, real DM/channel sends, a real process restart against the delegated dev DB.

## 1. Scope

| In scope | Out of scope (hard) |
|---|---|
| One owner · one bot · the owner DM · one allowlisted channel · the delegated dev DB (`QUOKY_RUNTIME_ENV=dev`) | Any non-owner recipient, shared/production server or DB |
| Part A: **DM-only default** (`QUOKY_REMINDERS_CHANNEL_DELIVERY=false`) — create/list/cancel, delivery, refusal, restart recovery, local brief | Any reminder action that calls a provider, connector or tool (needs a new ADR) |
| Part B (separately approved): channel delivery opt-in and allowlist-removal DM fallback | Flipping the release default of either flag (a PO decision after this UAT) |
| Log hygiene: no reminder body or secret in runtime logs | Applying v13 to any DB other than the delegated dev DB |

## 2. Preconditions

1. Exact-scope Strict approval for Part A is recorded (reference it in the result record). Part B is not run
   without its own approval.
2. The integration commit under test is checked out; record `git rev-parse HEAD`; `git status --short` is clean;
   `pnpm typecheck` and `pnpm test` are green on it.
3. The dev DB is the delegated development DB (AGENTS.md `AUTONOMOUS_DEV_DB`): `QUOKY_RUNTIME_ENV=dev`, the
   configured `QUOKY_DB_PATH` matches the intended file, no production/shared target. Startup applies migrations up
   to v13 to that file only.
4. Owner Discord account, owner DM with the bot, and one allowlisted channel (`QUOKY_DISCORD_CHANNEL_IDS`) exist.
5. `.env.local` (edited only under this approval; values never printed) sets:

   | Variable | Part A | Part B |
   |---|---|---|
   | `QUOKY_REMINDERS_ENABLED` | `true` | `true` |
   | `QUOKY_REMINDERS_CHANNEL_DELIVERY` | `false` (or unset) | `true` — only after the owner acknowledges that members of the allowlisted channel can read reminder text |
   | `QUOKY_TIMEZONE` | unset (`Asia/Seoul`) or the owner's IANA zone | same |

   Exact `true`/`false` only; anything else is a value-free startup error.

## 3. Runtime start (AGENTS.md "Temporary Local/UAT Runtime Environment")

1. Compare variable **names** only between `.env.local` and the process environment (never print values):

   ```sh
   grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.local | cut -d= -f1 | sort -u > /tmp/uat-envlocal-names
   env | cut -d= -f1 | sort -u > /tmp/uat-process-names
   comm -12 /tmp/uat-envlocal-names /tmp/uat-process-names
   ```

2. Any printed name is a collision: remove it for the launch with `env -u NAME`. Always remove (or prove absent)
   `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`. Never source `.env`.

   ```sh
   env -u DISCORD_BOT_TOKEN -u DISCORD_GUILD_ID pnpm dev
   ```

3. Before declaring readiness, verify read-only that the connected bot identity, guild and channel match the
   `.env.local` targets. On a mismatch or if it cannot be verified: stop the runtime, perform no Discord action,
   report a blocker.
4. Expected startup log lines (no body text): `database` (absolute path), provider readiness, `[reminders]
   reminder.tick.started initialDelayMs=5000 periodMs=15000`, then the started banner. With
   `QUOKY_REMINDERS_ENABLED=false` the line is `reminder.tick.disabled` and nothing else from the tick.

Record: collision check performed (yes/no), colliding **names** removed (no values), HEAD, flags used.

## 4. Part A — DM-only default (`QUOKY_REMINDERS_CHANNEL_DELIVERY=false`)

Use harmless reminder texts only (never a real secret). Precision is about 15 s (tick period). Record the reply
gist and PASS/FAIL per step.

| # | Action | Expected result |
|---|---|---|
| A1 | In the **owner DM**, send `2분 뒤에 스트레칭 알려줘` | Immediate confirmation with an absolute date, weekday, time and `#N`, plus `취소: '알림 N 취소'`; no model latency |
| A2 | Wait ~2 min | `알림 #N: 스트레칭` arrives **in the DM**, once; no emoji; mentions nobody |
| A3 | In the **allowlisted channel**, send `2분 뒤에 물 마시기 알려줘` | Confirmation in the channel |
| A4 | Wait ~2 min | The reminder arrives **in the owner DM, not the channel** (DM-only default); nothing is posted in the channel |
| A5 | Send `3분 뒤에 회의 준비 알려줘`, then `알림 목록` | The list shows it with its number, local time and `[1회]` |
| A6 | Send `알림 N 취소` for that number; wait past its time | `알림 #N 취소했어요: …`; it never fires; `알림 목록` no longer shows it |
| A7 | Send `오늘 <a time already past today, e.g. 오전 9시>에 회의 알려줘`, `30분 뒤에 알려줘` (no body) and `내일 25시에 회의 알려줘` | A clarification each time (past time / what to remind / invalid time); `알림 목록` shows no new reminder |
| A8 | Send a reminder whose body looks like a credential, using a **made-up** token-shaped value: `내일 오전 9시에 token=ghp_` followed by 36 invented letters/digits, then ` 알려줘` | Refused (`비밀번호나 토큰처럼 보이는 값`), the value is not echoed; nothing stored |
| A9 | Trigger a pending approval (any code-change preview that asks for 승인), then send `내일 9시에 회의 알려줘` | The pending-approval reminder (`"승인"` / `"거절"`); no reminder is created (`알림 목록` after resolving the approval) |
| A10 | Send `할 일 추가: 내일 9시에 회의 알려줘` | Handled as a to-do (work grammar), **not** a reminder |
| A11 | Send `도움말` | Help includes the reminder lines (`"알림 목록", "알림 N 취소"`) |
| A12 | Send `매일 <now+2 min>에 오늘 할 일 알려줘` (daily-brief body); wait for it | A local-only brief arrives **in the DM**; logs show zero provider or connector calls for it |
| A13 | Send `매일 <now+2 min, e.g. 오후 3시 12분>에 물 마시기 알려줘`; wait for it | Delivered in the DM; `알림 목록` still lists it (`[매일]`, `지난 알림: 전달됨`) with tomorrow's time |

### Part A — restart and recovery

| # | Action | Expected result |
|---|---|---|
| A14 | Create `3분 뒤에 서류 제출 알려줘` (ONCE) and `매일 <now+2 min>에 스트레칭 알려줘` (DAILY). **Stop the runtime** (Ctrl-C / SIGTERM; log shows `reminder.tick.stopped` before the platform closes). Wait until **more than 60 minutes** past the DAILY time and past the ONCE time. Restart per section 3 | Within ~5–20 s of readiness: exactly **one** late delivery of the ONCE reminder in the DM, labelled `(예정 …, 늦게 전달)` with the original time; the DAILY occurrence is **not** sent; `알림 목록` shows it `지난 알림: 시간이 지나 건너뜀` with its next time |
| A15 | Variant within the grace window: a DAILY reminder whose time passed **less than 60 minutes** before the restart | One catch-up delivery, labelled late |
| A16 | FIRING → `DELIVERY_UNCERTAIN` recovery (see below) | After restart: log `reminder.recover.done found=1 recovered=1`; **no** delivery for that reminder, ever; `알림 N 취소` answers `전달 여부를 확인할 수 없어 종료됐어요. 다시 보내지 않아요.` |

A16 method. A crash between claim and completion cannot be timed reliably live, so the FIRING row is staged
directly in the **delegated dev DB only**, with the **runtime stopped**, as one bounded update of one UAT
reminder that the owner created for this step (this dev-DB mutation is part of the same exact-scope approval):

```sql
-- sqlite3 "$QUOKY_DB_PATH"   (the delegated dev DB; verify the path first, never print secrets)
UPDATE reminders
SET status = 'FIRING',
    data = json_set(data, '$.status', 'FIRING',
                          '$.firingAttemptId', 'uat-simulated-crash',
                          '$.firingStartedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE display_no = :n AND status = 'SCHEDULED';
-- expect: 1 row changed
```

### Part A — log hygiene

| # | Check | Expected |
|---|---|---|
| A17 | Search the runtime log for each reminder body used above (e.g. `스트레칭`, `서류 제출`, `ghp_`) | No match. Reminder log lines carry codes, counts, ids of attempts and error classes only (`reminder.dispatch.tick claimed=…`, `owner notification delivery … status=SENT`) |

## 5. Part B — channel delivery opt-in (separate Strict approval)

> **BLOCKED in this build — composition wiring pending.** The Discord adapter reads `channelDelivery` from its own
> config (PRO-4), but the composition root still constructs it from `config.discord`, which does not carry
> `config.reminders.channelDelivery`. Until a one-line `app.module.ts` hunk passes
> `{ ...config.discord, channelDelivery: config.reminders.channelDelivery }` (outside PRO-5's owned files; reported
> as NEEDS_SCOPE_EXPANSION), setting `QUOKY_REMINDERS_CHANNEL_DELIVERY=true` has **no effect** and every reminder
> stays DM-only (the safe direction). Run Part B only on a build that contains that wiring and record its SHA.

Preconditions: Part A passed; the owner has acknowledged in writing (quickstart/operator-guide note and the
`.env.example` comment) that members of the allowlisted channel can read reminder text; `.env.local` sets
`QUOKY_REMINDERS_CHANNEL_DELIVERY=true`; runtime restarted per section 3.

| # | Action | Expected result |
|---|---|---|
| B1 | In the allowlisted channel, send `2분 뒤에 스트레칭 알려줘` | Delivered **in that channel**, mentioning only the owner |
| B2 | In the owner DM, send `2분 뒤에 물 마시기 알려줘` | Delivered in the DM |
| B3 | In the channel, create `3분 뒤에 회의 준비 알려줘`; stop the runtime; remove that channel from `QUOKY_DISCORD_CHANNEL_IDS`; restart; wait | Delivered once **in the owner DM** (same text; the adapter falls back within the same attempt); nothing in the channel |
| B4 | In the channel (restore the allowlist first), create a daily brief for the next minute | The brief arrives **in the DM** (BRIEF is always DM-only) |
| B5 | Log hygiene as A17 | No body text in logs |

Afterwards restore `QUOKY_REMINDERS_CHANNEL_DELIVERY=false` (or unset) and the original channel allowlist.

## 6. Teardown and result record

1. Cancel every remaining UAT reminder (`알림 목록`, then `알림 N 취소` one by one) and stop the runtime per AGENTS.md.
2. Leave `QUOKY_REMINDERS_ENABLED` as the owner directs (the release default stays `false` until the PO flips it).
3. Write the result record next to this packet: approval reference, HEAD, flags, collision-check names, per-step
   PASS/FAIL with reply gists (no secrets, no full bodies beyond the harmless UAT texts), any blocker, and Part B
   status (`BLOCKED (wiring)`, `NOT RUN` or results).

# Quoky Personal v2 — Work Chat Attended Live UAT Packet (ADR-0100, WORK-T5)

> **This packet describes how to run the attended work-chat Live UAT. Executing any part of it requires a separate,
> exact-scope Strict Product Owner approval** (`docs/governance/DEVELOPMENT-MODE.md`, ADR-0100 "Strict gates").
> Authoring or merging this document grants no authority for the runtime, Discord, provider execution, network
> access, `.env.local`, secret access or the dev database. The per-connector read-only probes (section 4) are Strict
> actions of their own and need their own approval line.

Status: **NOT EXECUTED.** Offline acceptance is the prerequisite and covers the composition, the to-do lifecycle on
real SQLite, anchored to-do precedence over reminders, named read-only lookups with fake connectors, summaries (with
and without a provider), the read-only refusal and the credential guards:
`apps/quoky/src/work-chat-acceptance.test.ts`, `packages/core/src/application/work-chat/*.test.ts`,
`packages/core/src/application/conversation-runtime-work-chat.test.ts`, the connector adapter tests under
`packages/connector-*/src`. This packet covers only what fakes cannot prove: real tenants and tokens, real Discord
rendering of replies and links, a real SUMMARIZATION provider, and persistence across a real process restart.

## 1. Scope

| In scope | Out of scope (hard) |
|---|---|
| One owner, one bot, the owner DM and one allowlisted channel, the delegated dev DB (`QUOKY_RUNTIME_ENV=dev`) | Any non-owner user, shared or production server, shared or production DB |
| Part A: to-do add / list / complete / cancel / link and restart persistence (local rows in the dev DB only) | Any connector write (create, update, comment, post, close, merge): out of scope by ADR-0100 D9 |
| Part B: read-only lookups per connector (Jira, GitHub, Slack, Confluence) and summaries | Any non-GET request to a connector, any history scan, any bulk export |
| Part C: refusal, precedence, pending-approval and flag checks | Switching any default flag (a PO decision after this UAT) |
| Part D: log and audit hygiene | Reading or printing token values, `.env.local` contents or tenant data beyond the harmless probe results |

## 2. Preconditions

1. Exact-scope Strict approval for the run is recorded and referenced in the result record. The connector probes in
   section 4 and the Slack user-token switch need their own approval lines (network + secret access).
2. The integration commit under test is checked out. Record `git rev-parse HEAD`; `git status --short` is clean;
   `pnpm typecheck` and `pnpm test` are green on it. The Part A to-do rows need no migration (they use the existing
   `work_items` table); the dev DB schema is whatever the delegated dev DB already holds (v13 or later).
3. The dev DB is the delegated development DB (AGENTS.md `AUTONOMOUS_DEV_DB`): `QUOKY_RUNTIME_ENV=dev`, the
   configured `QUOKY_DB_PATH` matches the intended file, no production or shared target. To-do rows are created in
   that file only.
4. Owner Discord account, owner DM with the bot, one allowlisted channel (`QUOKY_DISCORD_CHANNEL_IDS`).
5. A SUMMARIZATION provider is available (Claude CLI; Ollama if enabled). Record which ones are ready at startup.
6. `.env.local` (edited only under this approval; values never printed) provides:

   | Variable | Needed for |
   |---|---|
   | `QUOKY_ACTOR_IDENTITY_MAPPINGS` | Personal Jira and GitHub queries: the owner's Jira account id and GitHub login (there is no `@me` fallback; a missing mapping must produce the `IDENTITY_MISSING` copy, which is also checked below) |
   | `QUOKY_JIRA_BASE_URL`, `QUOKY_JIRA_EMAIL`, `QUOKY_JIRA_TOKEN` | Jira lookups |
   | `QUOKY_GITHUB_TOKEN` or the GitHub App group | GitHub review-request lookups (read scope only) |
   | `QUOKY_SLACK_TOKEN` | Slack search: a **user** token with `search:read` (a bot token must give the `INSUFFICIENT_SCOPE` guidance instead) |
   | `QUOKY_CONFLUENCE_BASE_URL`, `QUOKY_CONFLUENCE_TOKEN` | Confluence search (Bearer auth until a live probe says otherwise, ADR-0100 decision 4) |
   | `QUOKY_WORK_SUMMARY_ENABLED` | `true` (default) for Parts A to C; `false` only for step C6 |

   Exact `true`/`false` only for the flag; anything else is a value-free startup error
   (`WORK_SUMMARY_ENABLED_INVALID`). Owner decision 2 (egress) must be acknowledged: with summaries on, connector
   text may reach Claude when Ollama is not ready.

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
4. Expected startup log lines: `database` (absolute path), provider readiness, one registration line per configured
   connector (an incomplete connector group is **not** registered and the lookup then gives the not-configured copy),
   then the started banner.

Record: collision check performed (yes/no), colliding **names** removed (no values), HEAD, flags used, which
connectors registered.

## 4. Per-connector read-only probes (Strict, NOT EXECUTED)

Before the chat steps, each configured connector gets exactly **one** read-only probe, run through the work chat
itself (never with a hand-built request). Each probe is a single named GET-only query bounded by the adapter timeout.
Each needs its approval line (network + secret access). Record only the reply gist, the item count and PASS/FAIL.

| # | Connector | Probe (chat) | Expected result |
|---|---|---|---|
| P1 | Jira | `내 Jira 이슈 보여줘` | A `Jira 내 항목` list (or an empty-result statement), item refs such as `[jira:PROJ-1]`, titles and links; not a failure line |
| P2 | GitHub | `GitHub 리뷰 요청된 PR 알려줘` | A `GitHub 리뷰 요청` list or an empty-result statement; refs shaped `github:owner/repo#N` |
| P3 | Slack | `Slack에서 <harmless term> 검색` | A `Slack 검색` result list, or (bot token) the `search:read` user-token guidance. No channel history is read |
| P4 | Confluence | `Confluence에서 <harmless term> 찾아줘` | A `Confluence 검색` list or an empty-result statement; on `UNAUTHORIZED` record it for the Bearer-auth decision |

Stop at the first unexpected failure class (for example `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`) and record it
without retrying in a loop. Use harmless search terms only (never a real secret or personal data).

## 5. Part A — To-dos through chat (local rows, dev DB only)

Use harmless to-do texts. Record the reply gist and PASS/FAIL per step.

| # | Action | Expected result |
|---|---|---|
| A1 | `할 일 추가: UAT 주간 보고서 쓰기` | `할 일을 추가했어요: "UAT 주간 보고서 쓰기"`; no model latency, no approval prompt |
| A2 | `할 일 추가: UAT 배포 점검` | Added, named in the reply |
| A3 | `내 할 일 보여줘` | `내 할 일 (2건)` numbered 1 and 2 in creation order, then the `Jira·GitHub 업무` block; sources not configured or without an identity are named, never shown as "no work" |
| A4 | `완료 처리: 1` | `할 일을 완료 처리했어요: "UAT 주간 보고서 쓰기"` |
| A5 | `내 할 일 보여줘` | `내 할 일 (1건)`: only `UAT 배포 점검`, now numbered 1 |
| A6 | `할 일 연결: 1 Jira <a real key from P1>` | `할 일에 연결했어요` and `연결할 때 외부 시스템은 조회하지 않았어요.`; the connector log shows no request for this step |
| A7 | `내 할 일 보여줘` | The to-do shows `(연결: jira:<KEY>)` |
| A8 | `완료 처리: 9` | `9번 할 일을 찾지 못해서 아무것도 바꾸지 않았어요` and the open count; nothing changes |
| A9 | `할 일 추가: UAT 토큰 ` followed by a **made-up** token-shaped value (`ghp_` plus 36 invented letters and digits) | Refused (`민감한 값 ... 저장하지 않았어요`); the value is not echoed; no row stored |
| A10 | `할 일 취소: UAT 배포` (unique title fragment) | `할 일을 취소했어요: "UAT 배포 점검"` |
| A11 | `도움말` | Help lists the to-do line (`"할 일 추가: 내용", "완료 처리: 번호" …`) and the lookup line |

### Part A — restart persistence

| # | Action | Expected result |
|---|---|---|
| A12 | Add `할 일 추가: UAT 재시작 확인`. **Stop the runtime** (Ctrl-C / SIGTERM), then restart per section 3 | Startup is clean (no schema change, no error) |
| A13 | `내 할 일 보여줘` | `UAT 재시작 확인` is still listed with its number; the completed and canceled UAT items are not |

Read-only check of the dev DB afterwards (runtime stopped or readers only; verify the path first, never print
secrets): the `work_items` rows for the UAT titles exist and the `title` field is present in their JSON; no other
table changed for these steps.

## 6. Part B — Lookups and summaries (summaries enabled)

| # | Action | Expected result |
|---|---|---|
| B1 | `내 Jira 이슈 보여줘` | A short Korean summary, then the footer: `출처:` with up to 10 `<link>` lines and `외부 항목 N건을 요약에 사용했어요.` |
| B2 | `이번 주 마감` | The same shape, limited to Jira items due this week (the query follows server-side `endOfWeek()` and includes overdue items, an accepted ADR-0100 consequence) |
| B3 | `GitHub 리뷰 요청된 PR 알려줘` | Summary plus footer, or the deterministic list when the result is empty |
| B4 | `Slack에서 <term> 검색` | Summary plus footer (user token), or the `search:read` guidance (bot token); never a history scan |
| B5 | `Confluence에서 <term> 찾아줘` | Summary plus footer or an empty-result statement |
| B6 | Open each footer link | Every link opens the real item named next to it; the count matches the number of items the summary used |
| B7 | Compare a summary with its source items | No invented ticket keys, statuses or people; instruction-like text inside an item (if any exists in the tenant) is not obeyed |
| B8 | Unconfigured connector: with one connector's variable group removed (restart), run its lookup | `<Source> 연결이 설정되어 있지 않아요. 설정을 확인한 뒤 다시 시도해 주세요.` and nothing else; restore afterwards |
| B9 | Remove the owner's Jira or GitHub entry from `QUOKY_ACTOR_IDENTITY_MAPPINGS` (restart), run `내 Jira 이슈 보여줘` | The `IDENTITY_MISSING` copy (`내 계정 정보(identity)가 필요한데 설정되어 있지 않아요`); restore afterwards |

## 7. Part C — Refusal, precedence and flag

| # | Action | Expected result |
|---|---|---|
| C1 | `Jira 이슈 만들어줘` | The fixed read-only refusal (`쓰기 작업은 아직 할 수 없어요 … 읽기 전용`); logs show zero connector requests and zero provider calls for this turn |
| C2 | `Slack에 배포 완료 메시지 보내줘` | The same refusal for Slack; nothing is posted |
| C3 | `할 일 추가: 내일 9시에 회의 알려줘` | Handled as a **to-do** with that exact title (anchored prefix wins); no reminder is created (`알림 목록` is unchanged) |
| C4 | Trigger a pending code approval (any change preview that asks for 승인), then send `할 일 추가: x` | The pending-approval reminder (`"승인"` / `"거절"`) only; **no to-do is stored** (check `내 할 일` after resolving the approval) |
| C5 | While that approval is still pending send `내 Jira 이슈 보여줘` | The pending-approval reminder only; no connector request |
| C6 | Restart with `QUOKY_WORK_SUMMARY_ENABLED=false`, run `이번 주 마감` and `내 Jira 이슈 보여줘` | A deterministic list only (`Jira … (N건)` with item rows and links); no summary text, no footer, and **no provider call and no TaskRun** for these turns. Restore the flag afterwards |
| C7 | Search with a credential-shaped term (made-up `ghp_` + 36 invented characters): `Slack에서 <that value> 검색` | Refused (`검색어에 비밀번호나 토큰 … 외부 시스템에 보내지 않았어요`); no connector request |

## 8. Part D — Log and audit hygiene

| # | Check | Expected |
|---|---|---|
| D1 | Review the connector request logs for the whole run | **No external write request**: only GET (read) requests, and none during A6 (link), C1, C2, C4, C5, C7 |
| D2 | Search the runtime log for token-shaped strings (`ghp_`, `xoxp-`, `xoxb-`, `Bearer `, `token=`) and for the made-up values used in A9 and C7 | **0 matches**. Log lines carry codes, counts and error classes only (for example `work_chat.turn_handler.failed` with a handler id and error name) |
| D3 | Search the runtime log for to-do titles and for item titles returned by the connectors | No match |
| D4 | Compare each footer's links and counts with the real items (B6) | They match the items the summary used |
| D5 | Check which provider served each summary | It appears **only** in the TaskRun audit (the `work summary: <source> <query>` Task and its run), **never** in the Discord reply text |
| D6 | Count TaskRuns created by Part A, C1, C2, C4 to C7 | Zero for those turns (to-dos, refusals, list-only and captured turns are provider-free) |

## 9. Teardown and result record

1. Cancel or complete every remaining UAT to-do (`내 할 일`, then `할 일 취소: N`), restore any `.env.local` value
   changed for B8, B9 and C6, and stop the runtime per AGENTS.md.
2. Leave `QUOKY_WORK_SUMMARY_ENABLED` as the owner directs (the release default is `true`; set it `false` if workplace
   policy forbids sending connector text to a cloud model).
3. Write the result record next to this packet: approval reference, HEAD, flags, collision-check names, which
   connectors were registered, per-step PASS/FAIL with reply gists (no secrets, no tenant content beyond the harmless
   probe results), the provider that served the summaries (from the TaskRun audit), and any blocker. Steps that were
   not run are recorded as `NOT RUN`, never as PASS.

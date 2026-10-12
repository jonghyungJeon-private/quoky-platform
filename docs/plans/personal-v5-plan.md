# Quoky Personal v5 — Plan (post-v4)

- **Status:** **Draft — awaiting owner decisions.** Nothing in this plan is ratified. The answers to section 7 decide
  which tracks run. No ADR named here exists yet: GOV-6 drafts them after the owner answers.
- **Date:** 2026-10-12
- **Base:** `main` at `a965590` (PR #173 merged, v4 closed). SQLite schema v15. `ConversationRuntimeDeps` baseline 35.
  Golden ratchet `turn-handler-routing` minTotal 419 and `action-shaped-fallthrough` 155 (`baseline.v1.json`).
- **Inputs:** `ARCHITECTURE.md` (§2 principles, §13 evolution), `ROADMAP.md` ("Personal v4 — status", "Future"),
  `CURRENT_STATE.md` ("Personal v4 — closed"), `docs/plans/personal-v4-plan.md` (template),
  `docs/uat/personal-v4-qa-record.md`, the ADR-0114..0118 implementation notes and their **Residuals**, the ratification
  record of 2026-10-08, and the ADR-0103/0105/0107/0108 parking notes.
- **Structure:** mirrors the v4 plan. Where this plan and a ratified ADR disagree, the ADR wins and this plan is
  corrected.

## 1. Goal and scope

### 1.1 Where v4 leaves the Personal edition

Every v4 track is merged (#152-#173). Schema stays v15 and the deps baseline stays 35 (`CURRENT_STATE.md`). "Live" below
means recorded in `docs/uat/personal-v4-qa-record.md`; everything else is offline-tested only.

| State | Items (source: QA record session 1 of 2026-10-12, `CURRENT_STATE.md` "Personal v4 — closed") |
|---|---|
| **Live on the owner's service** | Telegram private chat: text, an image with a caption, a 👍 reaction recorded as feedback, the shared owner Actor, a reminder delivered on Telegram (T1-T7). Gmail and Drive read-only, DM-only (G1-G8; #171 and #172 fixed the live defects). Daily brief with the calendar section (10/9-10/12) and a pre-meeting reminder that followed a moved event (B1, B2). CODE-9 merge once on the sandbox repository (C1-C4). Earlier: UNC-1 network fault (#155), DET-2 and TBL-1 (2026-10-08) |
| **Offline acceptance only (INT-3)** | `OPS_*` notices and the ops-UI decision result for a Telegram-held approval reach the Discord owner; Gmail/Drive DM-only on both platforms; injection mail or documents cause no action; configured-but-unselected OpenAI/Gemini make no call; `TaskRun.usage` records reported counts |
| **Configured but off** | OpenAI (PRV-1) and Gemini (PRV-2): no API key on the service. `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED=true` with no remote provider selected. `QUOKY_GIT_MERGE_ENABLED=false` |
| **Pending (not run, not claimed)** | PRV-1/PRV-2 live; PRV-3 monthly DM (first fires in November); the Jira section of the brief (on since 2026-10-12, first seen at the next brief); LRN-5 remote round trip; TG-3 ops-panel visual check; the live re-run of the G9 marker-stripping fix (QA record G9) |

**Owner deferrals (owner instruction for this plan, 2026-10-12):** the OpenAI and Gemini API keys and Notion stay
deferred until the owner asks for them again. PRV-1/PRV-2 live and the LRN-5 round trip therefore stay Pending, and
Notion stays the unscheduled P3 candidate of v4 decision 20.

**In progress elsewhere (v4 polish PR, another branch):** three small residuals: listing numbers that survive a
restart (the in-memory list ↔ id mapping of GML-1 and DRV-1), the help-line bound (ADR-0096 D6 bound of 14 with Gmail
and Drive on), and Telegram links and block quotes (TG-3 "translation scope"). v5 does not own those files until that PR
merges (section 4, hot-file lane).

### 1.2 What v5 is for

The owner's daily surfaces are Discord, Telegram, the calendar, mail, Drive, the morning brief, reminders and code work
on a sandbox repository (owner brief for this plan). v4 added the platforms, vendors and connectors. The remaining value
is in depth on those daily surfaces and in closing the residuals that v4 recorded honestly, not in a new platform or
vendor. This plan gives no completion percentage; v4's "about 90%" was an estimate, and v5 adds no measured metric.

### 1.3 v5 target

For the owner, v5 is done when:

- Every v4 Pending item that needs no deferred key is run or explicitly accepted, and the docs match `main`.
- The v4 security-hygiene residuals with a cheap fix are fixed (bounded OAuth token reads).
- The brief and mail answer one more daily question each, if the owner wants them (BRF-3, GML-2).
- The two storage residuals are fixed in one migration, or accepted for good (STO-1).
- Every other v4 residual has a recorded disposition: fixed, accepted or parked.

**Left out on purpose:** new platforms or AI vendors, Notion, the multi-agent runtime, Team/Hosted tenancy, remote
operations-UI access (ADR-0113 D11), deploy/release automation, mail send, Confluence/GitHub-issue writes.

### 1.4 Priority tiers

P0 is needed to close v4 honestly. P1 makes daily use clearly better. P2 is worth doing if the owner confirms the need.
P3 is parked or recommended for dropping.

| Tier | Items |
|---|---|
| P0 | LIVE-2 v4 pending live checks, DOC-F docs and pipeline alignment |
| P1 | HARD-1 bounded OAuth token reads, BRF-3 mail section in the brief (if decision 6 is yes) |
| P2 | GML-2 Gmail threads and reply picks, DRV-2 shared drives, STO-1 storage hardening (migration v16), PLT-1 untrusted spans for the remaining Core values, CAL-2 more calendars (configuration) |
| P3 (parked or drop) | DRV-2b all sheets (new scope), CODE-10 merge on a second repository, COST-1 price table, Telegram inline approvals (ADR-0114 D10), SUB-3 and Stage 2A, LLM-3, LRN-4, ADR-0108 D4, a mobile/remote ops UI, Notion, "memory improvements" (unscoped), a new observability track |
| Out | Same as v4 "Out", plus PRV-1/PRV-2 live until the owner re-requests the keys |

## 2. Carry-over and residuals

No item is claimed as done. "Fix" means a v5 track; "accept" means a recorded residual with no planned work; "park"
means a re-entry condition.

| # | Item | Source | Recommendation |
|---|---|---|---|
| C1 | TG-3 Telegram ops panel, visual check | QA record Pending | **Fix:** LIVE-2 |
| C2 | Jira section of the brief | QA record Pending | **Fix:** LIVE-2 observes the next brief |
| C3 | G9 marker stripping, live re-run | QA record G9 | **Fix:** LIVE-2 (one `N번 문서 요약해줘`) |
| C4 | PRV-3 monthly usage DM | QA record Pending | **Fix:** LIVE-2 observes the first November DM; no action needed to trigger it |
| C5 | PRV-1/PRV-2 live, LRN-5 remote round trip | QA record Pending | **Park** until the owner re-requests the keys (section 1.1) |
| C6 | CODE-8 Strict gates: App installation narrowed to "Only select repositories", a sandbox run on a second allowlisted repository | `CURRENT_STATE.md` CODE-8 ("not been run"); no QA record entry | **Fix:** LIVE-2 verifies the installation setting read-only and records it. The second-repository run only with CODE-10 |
| C7 | `OPS_*` and ops-UI decision-result routing for a Telegram-held approval | INT-3 only | **Accept** the offline proof; record a live observation if a notice occurs naturally |
| C8 | Chief Architect review of LRN-5 | `CURRENT_STATE.md` LRN-5 says "pending"; no later record found | **Fix:** DOC-F confirms whether it ran and records it, or runs it (the egress rule is live-configured) |
| R1 | Session lookup ignores the platform: `findActiveByContext(channelId, threadId)`. Discord and Telegram ids are disjoint in practice only | ADR-0114 TG-1 residual (CA P3-7), carried by TG-3 | **Fix (P2):** STO-1, storage ADR-0119, migration v16 |
| R2 | Usage ledger query is a full scan of `task_runs` (about 38 ms per 20,000 runs locally) on each hourly evaluation and ops-UI load | ADR-0115 PRV-3 residual | **Fix only inside STO-1** (same v16); on its own, accept: the cost is negligible at personal scale |
| R3 | The claim guard is best-effort lexical; the fixed footer is the guarantee | ADR-0118 GML-1 and DRV-1 residuals | **Accept.** Add wordings as live QA finds them |
| R4 | Drive listings include files shared with the owner (a stranger can place a hostile name) | ADR-0118 DRV-1 residual | **Accept** (inside the ADR-0118 threat model). An owned-only filter is optional (decision 9) |
| R5 | Drive exports only the first sheet of a spreadsheet | ADR-0118 DRV-1 residual | **Park** (DRV-2b): a full read needs a new scope (decision 8) |
| R6 | Markdown in Core values without an `untrusted` span (some `response-composer.ts` paths interpolate file paths) may lose a `*`/`_` pair on Telegram; fidelity only, never markup | ADR-0114 TG-3 "translation scope" | **Fix (P2):** PLT-1 |
| R7 | The OAuth token response is read with `response.json()`, unbounded (pinned to `oauth2.googleapis.com`) | ADR-0118 GML-1 and DRV-1 residuals; the same call is in `connector-calendar-google/src/oauth.ts` | **Fix (P1):** HARD-1 |
| R8 | `NO_OWNER` uses a notice attempt like a retryable `NOT_SENT`; three ownerless hours give up that month's DM | ADR-0115 PRV-3 residual ("owner decision, kept as is") | **Accept** (already an owner decision) |
| R9 | The ops-UI token rotates at every start, so every restart or deploy needs a new sign-in | ADR-0113 D3 (by design); live-verified (v3 QA record A9) | **Accept.** It is the security property, not a defect |
| R10 | Discord web login was tab-scoped in the owner's QA browser tooling | Orchestrator report; no repository record | **Tooling note only.** DOC-F adds one line to the QA-record conventions; no product work |
| R11 | Listing numbers lost on restart; help-line bound; Telegram links and quotes | GML-1/DRV-1/TG-3 residuals | **In progress (v4 polish PR)** |
| R12 | Gateway-routed and code-work runs record no usage; a run that fails after the provider call records none; counts, not money | ADR-0115 PRV-3 residuals | **Accept.** The owner's chat runs on subscription CLIs (COST-1 parked) |
| R13 | `이 메일` means the single entry of the last list; replying to a listed message is not supported | ADR-0118 GML-1 residual | **Fix (P2):** GML-2 |
| R14 | HTML-only mail keeps CSS-hidden text in a summary | ADR-0118 GML-1 residual (review P3-3) | **Accept** (untrusted readout, no tool surface) |
| R15 | Pre-meeting reminder: a move earlier than the offset is announced late; the port exposes the calendar name, not its id (R8) | ADR-0117 BRF-2 R1, R8 | R1 **accept** (polling would be a scheduler, ADR-0101 D1). R8 **fix only with CAL-2** if two calendars are configured |
| R16 | Brief: a stop during the 30 s calendar read makes that brief `DELIVERY_UNCERTAIN` | ADR-0117 BRF-1 R1 | **Accept** (at-most-once by design) |
| R17 | Drive does not read uploaded text files (an ADR-0118 D2 amendment candidate; needs a binary sniff) | ADR-0118 DRV-1 note | **Park** unless the owner asks (decision 17) |
| R18 | Telegram panel counters reset at restart; a late album part becomes its own turn; an intake note may repeat after a crash | ADR-0114 TG-2/TG-3 residuals | **Accept** |
| R19 | `드라이브 코스 찾아줘` falls through to chat | QA record G7; DRV-1 live-QA list expects "not a Drive reply" | **Accept** (intended grammar) |
| R20 | v2/v3 accepted residuals R1-R8 (storage CAS, symlink TOCTOU, regex guard, forced-stop send, claim guard, calendar write intent, Codex containment, PGID reuse) | v4 plan section 2, decision 25 | **Keep all.** R1's second-writer trigger is still not hit |

## 3. Tracks

Constraints common to all tracks are unchanged from v4: dependencies point only `apps -> adapters -> core`; Core never
branches on a provider or platform id; new ports and tokens live in `packages/core/src/ports`; features arrive as
ADR-0096 turn handlers plus an `app/features/*.providers.ts` composition; the deps baseline stays 35 unless a track's ADR
says otherwise; AI HTTP APIs serve only the chat and image tiers (ADR-0115).

**Estimate scale.** One agent plus review: S ≤ 1 day, M 2-4 days, L 5-8 days. Attended live QA is extra. Estimates only.

### LIVE — v4 pending live checks and docs (P0)

- **Goal.** Close every v4 Pending item that needs no deferred key, and align the docs and the ship pipeline with v5.
- **Scope.**
  - **LIVE-2** (no code, Strict, owner-attended where noted): C1 panel visual (ego-browser on the loopback ops UI); C2
    read the next morning's brief; C3 one Drive summary; C4 observe the November DM; C6 read the GitHub App installation
    setting. Each defect becomes an ordinary follow-up PR in the owning package.
  - **DOC-F** (docs only): a v5 section in a new `docs/uat/personal-v5-qa-record.md`; C8 recorded; R10 noted in the QA
    conventions; the local `quoky-ship` skill text updated from "v4 waves" and `personal-v4-plan.md` to the v5 terms
    once decision 1 is answered.
- **ADR.** None.
- **Risks.** The November DM cannot be forced without touching the ledger state; it is observed, not triggered. DOC-F
  must not claim a result before the session that produced it.
- **Estimate.** DOC-F S. LIVE-2 one attended session of under an hour, plus two passive observations.
- **Dependencies.** The v4 polish PR merged first, so C3 runs on the final summary path.
- **AC.** C1-C4, C6 and C8 are PASS, FAIL with a follow-up, or "accepted by the owner" in the v5 QA record.

### HARD — Bounded OAuth token reads (P1)

- **Goal.** No connector reads an unbounded response body, including the token endpoint.
- **Scope.** **HARD-1.** Replace `response.json()` on the token endpoint in `connector-gmail/src/oauth.ts`,
  `connector-gdrive/src/oauth.ts` and `connector-calendar-google/src/oauth.ts` with a bounded stream read (a fixed cap,
  for example 64 KiB, with the remainder cancelled), mapped to the existing typed errors. The three copies stay
  separate, because adapters may not depend on each other (AGENTS.md). A grep confirms no other unbounded
  `.json()` remains on a connector's network path.
- **ADR.** None: an implementation note under ADR-0118 (and ADR-0110 for the calendar).
- **Risks.** A cap below Google's real response size breaks consent and refresh: the cap is chosen well above a token
  response, and the consent helper is re-run offline against recorded response shapes.
- **Estimate.** S.
- **Dependencies.** None.
- **AC.** An oversize or never-ending token body fails closed with a typed error and no token in the message; the
  existing oauth tests stay green; the read-only source scans stay green.
- **Live QA.** One token refresh on the service after deploy (the next calendar, mail or Drive read proves it).

### BRF — Mail in the morning brief (P1 if decision 6 is yes)

- **Goal.** The 08:00 brief also tells the owner whether there is unread mail worth opening.
- **Scope.** **BRF-3.** An opt-in section (`QUOKY_BRIEF_MAIL_ENABLED`, default `false`, parsed in
  `reminders/reminder-config.ts` as the Jira flag is) read through the existing `MAIL_READER`: the unread count and at
  most 3 sender/subject lines, using the GML-1 listing format, caps and guards. No body, no snippet, no model, DM-only as
  the brief already is. A failed read shows "불러오지 못했어요", never "no mail".
- **ADR.** An ADR-0117 amendment (a mail source for the brief) that relates ADR-0118 D4/D5 (listing format, DM-only).
- **Risks.** Subjects are hostile text in a scheduled DM: the same guarded clip as the listing, an `untrusted` span,
  and no link (display-mode `neutralizeLinks`). The brief's single-message fit (`firstFit`) must still hold with four
  sections.
- **Estimate.** S-M.
- **Dependencies.** None. GML-1 is merged.
- **AC.** Flag off: the brief is byte-identical. A fixture day with 0, 2 and 40 unread mails and an unreadable mailbox
  renders correctly. An injection subject changes nothing. No provider call.
- **Live QA.** The next morning's brief after the flag is set (Strict `.env.local` edit).

### CON — Connector depth (P2)

The owner works in Google Workspace (v4 plan CON; calendar and mail live). Each item below is read-only.

- **GML-2, Gmail threads and reply picks (P2).**
  - `이 스레드 요약해줘` summarizes one thread (bounded message count and bytes, head-and-tail clip, the GML-1 summary
    path).
  - A platform reply to a listing message picks that entry (closes R13). Core has no inbound reply reference today
    (`replyToMessageId` exists only on outbound messages), so both adapters map the platform's reply into a new
    additive, opaque inbound field. Core never reads platform message ids as anything but data.
  - `<라벨> 메일` lists a label read-only, only if the owner uses labels (decision 7). `gmail.readonly` already covers
    all three; no new scope.
- **DRV-2, Drive shared drives (P2).** Search and recent files include the owner's shared drives
  (`includeItemsFromAllDrives`, `supportsAllDrives`), still `drive.readonly`, still the ADR-0118 listing and export
  rules. Optional `내 문서` filter for owned files only (decision 9).
- **DRV-2b, all sheets (P3).** The Drive export returns only the first sheet as CSV. A full read needs either the
  `spreadsheets.readonly` scope (forbidden by ADR-0118 D3, "no other scope is ever requested") or parsing a zipped
  HTML export. Recommended: drop unless the owner works in multi-sheet spreadsheets (decision 8).
- **CAL-2, more calendars (P2, configuration).** Reading several calendars already works through
  `QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS` (the owner's host uses `primary`). Adding calendars is a Strict `.env.local` edit,
  no code. If two configured calendars can share an event id, an additive `calendarId` on `CalendarEvent` closes BRF-2
  R8. Writes stay on the primary calendar (ADR-0110 amendment); widening them is not recommended.
- **ADR.** One ADR-0118 amendment for GML-2 (the `MailReader` thread read, and the inbound reply field on the domain
  message, which both platform adapters fill) and DRV-2 (the corpus widening). CAL-2's port field, if needed, is an ADR-0110 amendment.
- **Risks.** Threads multiply hostile text per summary: the same untrusted framing, no tools, a tighter byte bound.
  Shared drives widen who can place a hostile name in a listing: the R4 threat model, now larger.
- **Estimate.** GML-2 M. DRV-2 S. CAL-2 S (S-M with the port field).
- **Dependencies.** The v4 polish PR merged (it owns the mail and Drive handlers). The amendment ratified.
- **AC.** Fixture adapters answer the new phrasings deterministically; an injection thread produces no action; listings
  stay DM-only; the routing corpus gains cases and nothing else moves.
- **Live QA.** About 10 phrasings per item on the owner's DM, including a long thread, a reply pick after a restart,
  and a shared-drive document.

### STO — Storage hardening, one migration (P2, Strict apply)

- **Goal.** Make two invariants enforced rather than incidental, in a single migration.
- **Scope.** **STO-1.**
  - **Session platform key (R1).** Migration v16 adds a `platform` column to `sessions`, backfilled from the
    `context.platform` already stored in the session JSON `data`, and an index on `(platform, channel_id, thread_id,
    status)`. The `SessionRepository.findActiveByContext` lookup includes the platform. The ADR picks the shape: an
    added parameter, or a `ConversationContext`-shaped argument. `platform` stays opaque data in Core.
  - **Usage scan index (R2).** An expression index on the run's finish time in `task_runs` so
    `forEachUsageFinishedBetween` reads a range instead of the table. No change to the ledger's output.
  - Additive and idempotent (ADR-0096 D10). The apply on the service DB is Strict: `quokyctl.sh backup --apply` and
    `--verify` first, then the migration at a restart the owner approves.
- **ADR.** **ADR-0119, session platform key and usage scan index.** It changes a Core storage port signature, so it is
  an architectural event (ARCHITECTURE.md §13 rule of evolution) and amends ADR-0115 D8 for the index. It relates
  ADR-0114 (CA P3-7).
- **Risks.** A wrong backfill splits an active conversation into a new session: the backfill reads the stored context,
  and a test opens a v15 fixture DB with Discord and Telegram sessions. The service DB is the owner's live data:
  backup and verify before apply, and no destructive step.
- **Estimate.** M, plus one Strict apply.
- **Dependencies.** ADR-0119 ratified. Nothing else in v5 needs a migration.
- **AC.** A v15 fixture DB migrates to v16 with every session found again; a Telegram and a Discord conversation with
  equal ids get separate sessions; the usage panel totals are byte-identical before and after; `EXPLAIN QUERY PLAN`
  shows the index for both queries.
- **Live QA.** After the apply: one turn on each platform continues its existing session; the ops-UI usage panel loads.

### PLT — Untrusted spans for the remaining Core values (P2)

- **PLT-1.** Move the outside values that `response-composer.ts` and similar paths still interpolate (file paths, for
  example) into `untrusted` spans, so Telegram's plain-mode translation never alters them (R6). Discord output must stay
  byte-identical: the 793-case PLT-0 golden fixture plus new cases. Implementation note only (PLT-0 already decided the
  span type).
- **Estimate.** M (a 3,107-line hot file). **Dependencies.** The v4 polish PR merged (it owns the Telegram formatting
  files).
- **Telegram inline approval buttons:** stay parked (ADR-0114 D10, decision 13). One approval grammar on both platforms
  still holds, and text phrases passed live.

### CODE — Merge default and multi-repository merge (P3)

- **Merge default.** CODE-9 passed once on the sandbox; the flag is back to `false`. Keeping it `false` is recommended
  unless the owner wants merges from chat on the sandbox (decision 11). No code either way.
- **CODE-10, merge on a second allowlisted repository (P3, recommend drop).** The CODE-8 allowlist and the CODE-9 merge
  are each proven; their combination adds little unless the owner actually works in a second repository. Re-entry: the
  owner registers a second real repository.

### Parked or recommended for dropping (P3)

| Item | Recommendation | Reason | Re-entry condition |
|---|---|---|---|
| COST-1 price table on the usage ledger | **Drop for now** | No metered provider is configured; Claude and Codex run on subscriptions, which cost nothing per token (ADR-0115 PRV-3 residual) | The owner adds an OpenAI or Gemini key |
| PRV-1/PRV-2 live, LRN-5 round trip | **Park** | Owner deferral (section 1.1) | The owner re-requests the keys |
| Notion connector | **Park** | v4 decision 20 undecided; owner deferral | The owner asks for it; then a new ADR |
| SUB-3 continuation, Stage 2A re-validation | **Keep parked** | No concrete background-job need appeared in v4; the brief and reminders cover "report back later" (ADR-0103 note) | The ADR-0103 note's condition, unchanged |
| LLM-3 MLX, LRN-4 fine-tuning | **Keep closed** | Chat still runs on Claude | The ADR-0105/0107 notes, unchanged |
| ADR-0108 D4 model-proposed PR text | **Keep parked** | The deterministic text passed live | The owner asks |
| Mobile or remote ops UI | **Out** | ADR-0113 D11; Telegram is the mobile surface | Team/Hosted |
| "Memory improvements" (ROADMAP "Future") | **No track** | ROADMAP names it without a scope; no QA record shows a memory defect | The owner names a concrete problem |
| New observability track | **No track** | The ops UI already has provider, usage and Telegram panels, and `OPS_NOTICE` covers crash loops, backups and Telegram halts. Persisting panel counters (R18) has no user-visible effect | A concrete monitoring gap in live use |

## 4. Waves

Owned files are exclusive within a wave. `core/` = `packages/core/src/`, `app/` = `apps/quoky/src/`. Waves after W0
assume section 7 is answered. A "no" drops the task without blocking the rest. Model per the tiering rule (section 5).

| Wave | Task | Track | Owned files (summary) | Model | Deps |
|---|---|---|---|---|---|
| 0 | (v4 polish PR) | — | (other branch) `core/application/mail/*`, `core/application/drive/*`, help lines, `adapter-telegram` formatting | — | — |
| 0 | LIVE-2 | LIVE | No code. Strict observations C1-C4, C6 | haiku (log reading), owner-attended | polish PR merged (C3 only) |
| 0 | DOC-F | LIVE | `docs/uat/personal-v5-qa-record.md` (new), `CURRENT_STATE.md`, the local `.claude/skills/quoky-ship/SKILL.md` (untracked) | sonnet | decision 1 |
| 1 | GOV-6 | GOV | `DECISIONS.md` (ADR-0119, the ADR-0117 and ADR-0118 amendments, the v5 ratification record), `ROADMAP.md`, this plan | opus | owner answers |
| 1 | HARD-1 | HARD | `connector-gmail/src/oauth.ts`, `connector-gdrive/src/oauth.ts`, `connector-calendar-google/src/oauth.ts` (+tests) | sonnet | — |
| 1 | PLT-1 | PLT | `core/application/response-composer.ts`, `core/application/message-rendering.ts`, `adapter-discord` golden fixture additions | sonnet (opus review) | polish PR merged |
| 2 | BRF-3 | BRF | `core/application/reminders/daily-brief.ts`, `daily-brief-sources.ts` (+tests), `app/reminders/brief-sources.ts`, `reminder-config.ts`, `.env.example` | sonnet | ADR-0117 amendment |
| 2 | GML-2 | CON | `core/application/mail/*`, `core/ports` mail port (additive), `core/domain/messaging.ts` (inbound reply field), `adapter-discord` and `adapter-telegram` inbound mapping, `connector-gmail/src/gmail-mail-reader.ts`, `app/features/mail.providers.ts`, golden corpora | opus | polish PR, ADR-0118 amendment |
| 2 | STO-1 | STO | `storage-sqlite/src/migrations.ts`, `storage-sqlite/src/index.ts` (session and run queries), `core/ports/storage-provider.port.ts`, `core/application/session-manager.ts` (+tests) | opus | ADR-0119 |
| 3 | DRV-2 | CON | `core/application/drive/*`, `connector-gdrive/src/gdrive-reader.ts`, `app/features/drive.providers.ts` | sonnet | GML-2 (shared amendment), polish PR |
| 3 | CAL-2 | CON | No code (`.env.local`, Strict); `core/domain` calendar event and `connector-calendar-google` only if the port field is approved | sonnet | decision 10 |
| 3 | INT-4 | INT | `app/personal-v5-acceptance.test.ts`, golden additions, `baseline.v1.json` | sonnet | merged tracks |
| 3 | DOC-G | DOC | `CURRENT_STATE.md`, `CHANGELOG.md`, `DECISIONS.md` (implementation notes), `ROADMAP.md`, quickstart, operator guide | sonnet | merged tracks |

Inside a wave, tasks run in parallel in separate worktrees. P2 tasks may be dropped without blocking INT-4.

### Lanes

**Migration lane** (ADR-0096 D10: additive, idempotent, numbers fixed). **v16 belongs to STO-1 only.** No other v5
task needs a migration (BRF-3, GML-2 and DRV-2 add no stored state; CAL-2's field lives in the event, not the DB). A
task that finds it needs one takes v17 after STO-1 merges. Applying any migration on the service DB is Strict.

**Hot-file lane** (one editor per wave):

| File | W1 | W2 | W3 |
|---|---|---|---|
| `response-composer.ts` (3,107 lines) | PLT-1 | — | — |
| `conversation-runtime.ts` (8,154 lines) | — | — (no task expected; a handler absorbs each change) | — |
| `core/application/mail/*` | — | GML-2 | — |
| `core/application/drive/*` | — | — | DRV-2 |
| `turn-handlers.providers.ts` | — | GML-2 (only if a new handler) | DRV-2 (rebased) |
| `.env.example` | — | BRF-3 | CAL-2 (comment only) |
| `storage-provider.port.ts`, `storage-sqlite/src/*` | — | STO-1 | — |
| `core/domain/messaging.ts`, platform adapters' inbound mapping | — | GML-2 | — |
| `core/application/reminders/*` | — | BRF-3 | — |
| `DECISIONS.md` | GOV-6 | — | DOC-G |

**Deps baseline.** 35. No v5 task is expected to add a `ConversationRuntimeDeps` key; a task that needs one says so
in its ADR first.

## 5. Governance and validation

- **Standing approval (decision 1).** The v4 approval is not inherited. The ratification record (decision 1) covers
  Push → PR → Merge after offline validation, independent review and Codex PASS. The `quoky-ship` skill's approval line
  also names deploying to the always-on service and a smoke check. v5 should state both explicitly: the recommended
  default renews the v4 terms **and** names the deploy and smoke steps. Every Strict item below is still confirmed per
  target.
- **ADR gate.** A track's first code merge waits for its ADR or amendment to be ratified. GOV-6 drafts ADR-0119 and the
  ADR-0117/ADR-0118 amendments after the owner answers. HARD-1, PLT-1 and the docs tasks need implementation notes
  only. A stalled ADR stalls only its own track.
- **Chief Architect review (independent, mandatory before merge):** STO-1 (a Core storage port and a migration), GML-2
  (a port widening and a larger injection surface), DRV-2 (a corpus widening), BRF-3 (hostile text in a scheduled DM),
  PLT-1 (untrusted rendering on both platforms). HARD-1 needs Codex only.
- **Codex review.** Sparse: required PASS per PR in the ship pipeline, plus a delta review after fixes. Codex is a
  reviewer, never the implementer of the same change.
- **Model tiering.** **haiku** for mechanical work (worktree setup and cleanup, rebases of doc conflicts, validation
  runs, log summaries); **sonnet** for well-specified implementation, tests, docs and review fix loops; **opus** for
  security, egress and boundary design, Chief Architect reviews and ambiguous debugging. Escalate to opus on a P1
  finding or after two failed fix loops. The model is passed explicitly on every sub-agent call and recorded in the
  report.
- **Ship pipeline.** The project skill `quoky-ship` (`.claude/skills/quoky-ship`, local and not checked in) calls
  `side-job` for the worktree, execution mode and model, then runs: offline validation → independent review (Codex PASS,
  Chief Architect where listed above) → rebase → push → PR → merge → deploy to the always-on service → smoke → owner
  report. DOC-F points it at this plan.
- **Per wave:** offline validation is `pnpm typecheck` plus focused tests; a hot-file task runs the full `pnpm test`;
  INT-4 adds `pnpm build`. Docs-only tasks run `git diff --check` and confirm unique `## ADR-` numbers.
- **Fix loops.** At most two per finding inside the approved scope; then narrow, defer or stop and report.
- **Strict, per target:** the service-DB migration v16 apply; each `.env.local` edit (BRF-3 flag, CAL-2 calendar ids,
  any merge-flag change); runtime restarts outside the ship pipeline; any new OAuth scope (none is recommended); the
  owner-attended LIVE-2 session.
- **Honesty.** No document claims a live result before the session that produced it. Pending stays Pending.

## 6. Risks

| Risk | Mitigation |
|---|---|
| The v16 migration damages the owner's live sessions or runs | Additive only; backfill from stored context; a v15 fixture test; `quokyctl.sh backup --apply` and `--verify` before the Strict apply; CA review |
| More hostile text reaches the owner (threads, shared drives, mail subjects in the brief) | Same untrusted framing, guarded clips, link neutralizing and DM-only rules as v4; no tool surface; CA review on each |
| PLT-1 changes Discord output | Byte-identical golden fixture (793 cases) plus new cases; full `pnpm test` |
| v5 collides with the in-flight v4 polish PR | It owns the mail, Drive, help and Telegram formatting files in W0; PLT-1, GML-2 and DRV-2 start after it merges |
| Low-value work crowds out the owner's attention | P2 items run only on a "yes" in section 7; COST-1, CODE-10, DRV-2b and the unscoped items are recommended for dropping |
| Stale docs mislead later agents (the per-track `CURRENT_STATE.md` sections still say "not run yet") | DOC-F records the C-rows; DOC-G closes v5; the honesty rule |
| The standing approval is read wider than granted | Decision 1 names every automatic step, including deploy and smoke; Strict items stay per target |

## 7. Owner decisions (open)

| # | Question | Recommended default | Reason |
|---|---|---|---|
| 1 | Renew the standing approval for v5 waves: automatic Push/PR/Merge, deploy to the service and a smoke check after offline validation, independent review and Codex PASS; Strict items still confirmed per target? | **Renew on the v4 terms, with deploy and smoke named explicitly** | It worked across v4 (#152-#173). The recorded v4 decision names Push/PR/Merge only, while the ship skill also deploys |
| 2 | Is v5 a depth-and-hardening release with no new platform, vendor or connector? | **Yes** | The owner's daily surfaces are all live; the remaining gaps are depth and recorded residuals |
| 3 | Keep the OpenAI/Gemini keys and Notion deferred until you ask again, with their live checks Pending? | **Yes** (your instruction) | Nothing in v5 depends on them |
| 4 | STO-1: fix the session platform key and add the usage index in one migration v16, applied on the service DB after a verified backup? | **Yes, as P2, in one migration**; if no, accept both as permanent residuals | Each migration costs a Strict apply, so bundling both is cheaper. Neither causes a visible problem today |
| 5 | HARD-1: bound the OAuth token reads in all three Google connectors? | **Yes** | Small, no behaviour change, closes a security-hygiene residual |
| 6 | BRF-3: add an opt-in unread-mail section (count plus up to 3 sender/subject lines, no body) to the morning brief? | **Yes, off by default**; you turn it on | Mail is live and used; the brief already runs daily |
| 7 | GML-2: thread summaries and reply-to-pick? Label listings too? | **Threads and reply picks yes; labels only if you use Gmail labels** | Reply picks close a recorded residual; labels are unused by any recorded QA |
| 8 | DRV-2b: read every sheet of a spreadsheet (needs the new `spreadsheets.readonly` scope or a zip-export parser)? | **No**, unless you work in multi-sheet spreadsheets | A new scope means an ADR-0118 D3 amendment and a new consent for an edge case |
| 9 | DRV-2: include your shared drives in Drive search? Add an owned-only `내 문서` filter? | **Shared drives yes; the filter optional (no)** | No new scope; accepting shared-with-me names is already the ADR-0118 threat model |
| 10 | CAL-2: add more calendars to `QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS` (read only; writes stay on primary)? | **Only if you have other calendars you want in `오늘 일정` and the brief** | It is configuration, not code; the port field is needed only for shared event ids |
| 11 | Keep `QUOKY_GIT_MERGE_ENABLED=false` on the service, and drop CODE-10? | **Yes to both** | Merge passed once on the sandbox; a second repository is not in daily use |
| 12 | COST-1 price table on the usage ledger? | **Drop for now** | No metered provider is configured |
| 13 | Telegram inline approval buttons? | **Keep parked** (ADR-0114 D10) | Text phrases passed live; buttons add a second decision surface |
| 14 | SUB-3 continuation and the Stage 2A re-validation? | **Keep parked** | No concrete background-job need appeared in v4 |
| 15 | PLT-1: move the remaining interpolated Core values into untrusted spans? | **Yes, P2** | Fidelity on Telegram, and it finishes what PLT-0 started; Discord stays byte-identical |
| 16 | Accept residuals R3, R4, R8, R9, R12, R14, R16, R18, R19 and keep R20 as documented? | **Accept all** | Each is by design or has no user-visible effect; R8 is already your decision |
| 17 | Let Drive read uploaded text files (an ADR-0118 D2 amendment with a binary sniff)? | **No** | Docs and Sheets cover the recorded use; a new egress path for little gain |
| 18 | "Memory improvements" (ROADMAP "Future"): plan it now? | **No track** until you name a concrete problem | No QA record shows a memory defect |
| 19 | LIVE-2 C6: may the orchestrator read the GitHub App installation setting in the browser to confirm the CODE-8 narrowing? | **Yes, read-only** | The narrowing was approved on 2026-10-08 but is not recorded as done |

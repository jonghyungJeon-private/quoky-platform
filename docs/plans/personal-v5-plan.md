# Quoky Personal v5 — Plan (post-v4)

- **Status:** **RATIFIED (2026-10-12).** After a Korean briefing of the draft, the Product Owner answered in the
  orchestrator chat on 2026-10-12 ("응 확정할게 진행하자"): every question in section 7 takes its recommended default,
  except decisions 7, 8 and 10, whose answers are in section 7. GOV-6 recorded the answers in the v5 ratification
  record in `DECISIONS.md` and appended ADR-0119 and the ADR-0117 and ADR-0118 amendments as Ratified. Ratification
  authorizes no Strict action by itself: each Strict target in section 5 still needs its own owner confirmation.
- **Natural-language routing (GOV-7, 2026-10-12).** After the live Telegram QA misses and the routing audit
  (`docs/plans/nl-intent-audit-2026-10-12.md`), the owner answered four more questions (section 7, decisions 20-23;
  design input `docs/plans/nl-intent-design-2026-10-12.md`). GOV-7 appended ADR-0120 (natural-language capability
  selection); the owner ratified it the same day. NL-1 joins wave 2, GML-2 moves to wave 3, and NL-2
  waits for the NL-1 shadow data (section 4).
- **Bounded agent (GOV-8, 2026-10-13).** The owner ratified ADR-0120 amendment A2 ("응 A2 승인하고"). The owner also asked
  for an assistant-style design with security controls and the company's MSIT guidance applied. GOV-8 appended
  ADR-0121 (**Proposed**: a bounded agent with information-flow control) and
  `docs/plans/agent-security-design-2026-10-13.md`. W4 becomes "NL-2 model-first + bounded agent design (ADR-0121)",
  gated on the owner's ratification of ADR-0121.
- **Ratification (GOV-9, 2026-10-13).** The owner ratified ADR-0121 with the principle "better, not imitate" and allowed the
  S1 egress (section 7, decisions 24-26). GOV-9 recorded it in `DECISIONS.md`, applied the amendment to `ARCHITECTURE.md`,
  `AGENTS.md` and `ROADMAP.md`, and marked the draft applied. W4 is now **NL-2 / S1 (unblocked), then S2**: S1 first, then
  S2 in `shadow` for at least 7 days and `active` only after the D11 gates. S3 writes still need their own amendment.
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
| **Live on the owner's service** | Telegram private chat: text, an image with a caption, a 👍 reaction recorded as feedback, the shared owner Actor, a reminder delivered on Telegram (T1-T7). Gmail and Drive read-only, DM-only (G1-G8; #171 and #172 fixed the live defects). Daily brief with the calendar section (10/9-10/12) and a pre-meeting reminder that followed a moved event (B1, B2). CODE-9 merge once on the sandbox repository (C1-C4). The PRV-3 threshold DM: sent once, not resent after a restart (U1-U3, 2026-10-12). Earlier (2026-10-08): UNC-1 network fault (#155), DET-2 and TBL-1, and the CODE-8 App installation narrowed to `quoky-uat-sandbox`, confirmed by the CODE-9 run through the App |
| **Offline acceptance only (INT-3)** | `OPS_*` notices and the ops-UI decision result for a Telegram-held approval reach the Discord owner; Gmail/Drive DM-only on both platforms; injection mail or documents cause no action; configured-but-unselected OpenAI/Gemini make no call; `TaskRun.usage` records reported counts |
| **Configured but off** | OpenAI (PRV-1) and Gemini (PRV-2): no API key on the service. `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED=true` (the owner delegated the decision, 2026-10-12) with no remote provider selected. `QUOKY_GIT_MERGE_ENABLED=false` |
| **Pending (not run, not claimed)** | PRV-1/PRV-2 live; PRV-3 monthly DM (first fires on 11/1; same delivery path and state machine as the verified threshold DM); a CODE-8 run on a second allowlisted repository; the Jira section of the brief (on since 2026-10-12, first seen at the next brief); LRN-5 remote round trip; TG-3 ops-panel visual check; the live re-run of the G9 marker-stripping fix (QA record G9) |

**Owner deferrals (owner's chat with the orchestrator, 2026-10-12):** "OpenAI / Gemini API Key는 필요시에 내가
재요청할게. Notion 도 마찬가지야." The keys and Notion stay deferred until the owner asks for them again. PRV-1/PRV-2 live and the LRN-5 round trip therefore stay Pending, and
Notion stays the unscheduled P3 candidate of v4 decision 20.

**Merged before v5 work began (v4 polish PR #174, 2026-10-12):** three small residuals: listing numbers that survive a
restart (the in-memory list ↔ id mapping of GML-1 and DRV-1), the help-line bound (ADR-0096 D6 bound of 14 with Gmail
and Drive on), and Telegram links and block quotes (TG-3 "translation scope"). The hot-file lane (section 4) is
therefore open to v5.

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
- Natural phrasings of the read questions reach the right capability without new phrase lists (NL-1 in shadow, NL-2
  active once the shadow data and the ADR-0120 gate allow it).
- Every other v4 residual has a recorded disposition: fixed, accepted or parked.

**Left out on purpose:** new platforms or AI vendors, Notion, the multi-agent runtime, Team/Hosted tenancy, remote
operations-UI access (ADR-0113 D11), deploy/release automation, mail send, Confluence/GitHub-issue writes.

### 1.4 Priority tiers

P0 is needed to close v4 honestly. P1 makes daily use clearly better. P2 is worth doing if the owner confirms the need.
P3 is parked or recommended for dropping.

| Tier | Items |
|---|---|
| P0 | LIVE-2 v4 pending live checks, DOC-F docs and pipeline alignment |
| P1 | HARD-1 bounded OAuth token reads, BRF-3 mail section in the brief (if decision 6 is yes), GOV-7 ADR-0120 and NL-1 natural-language capability selection (decision 23) |
| P2 | GML-2 Gmail threads and reply picks, DRV-2 shared drives and DRV-2b all sheets, STO-1 storage hardening (migration v16), PLT-1 untrusted spans for the remaining Core values, CAL-2 more calendars (read-only, going ahead: decision 10), NL-2 active mode (gated on the NL-1 shadow data) |
| P3 (parked or drop) | CODE-10 merge on a second repository, COST-1 price table, Telegram inline approvals (ADR-0114 D10), SUB-3 and Stage 2A, LLM-3, LRN-4, ADR-0108 D4, a mobile/remote ops UI, Notion, "memory improvements" (unscoped), a new observability track |
| Out | Same as v4 "Out", plus PRV-1/PRV-2 live until the owner re-requests the keys |

## 2. Carry-over and residuals

No item is claimed as done. "Fix" means a v5 track; "accept" means a recorded residual with no planned work; "park"
means a re-entry condition.

| # | Item | Source | Recommendation |
|---|---|---|---|
| C1 | TG-3 Telegram ops panel, visual check | QA record Pending | **Fix:** LIVE-2 |
| C2 | Jira section of the brief | QA record Pending | **Fix:** LIVE-2 observes the next brief |
| C3 | G9 marker stripping, live re-run | QA record G9 | **Fix:** LIVE-2 (one `N번 문서 요약해줘`) |
| C4 | PRV-3 monthly usage DM | QA record Pending; the threshold DM on the same path passed live (U1-U3) | **Fix:** LIVE-2 observes the 11/1 DM; no action needed to trigger it |
| C5 | PRV-1/PRV-2 live, LRN-5 remote round trip | QA record Pending | **Park** until the owner re-requests the keys (section 1.1) |
| C6 | CODE-8 run on a second allowlisted repository. (The App narrowing to `quoky-uat-sandbox` was done on 2026-10-08 and confirmed by the CODE-9 run.) | `CURRENT_STATE.md` CODE-8, QA record Pending | **Park** with CODE-10: run it only when a second real repository is registered (decision 19) |
| C7 | `OPS_*` and ops-UI decision-result routing for a Telegram-held approval | INT-3 only | **Accept** the offline proof; record a live observation if a notice occurs naturally |
| C8 | Chief Architect review of LRN-5 | Done: APPROVE WITH NITS, 6 nits fixed in `7374160`, Codex PASS, merged as #156 (PR body); `CURRENT_STATE.md` corrected | **Closed.** Only the live round trip stays Pending (C5) |
| R1 | Session lookup ignores the platform: `findActiveByContext(channelId, threadId)`. Discord and Telegram ids are disjoint in practice only | ADR-0114 TG-1 residual (CA P3-7), carried by TG-3 | **Fix (P2):** STO-1, storage ADR-0119, migration v16 |
| R2 | Usage ledger query is a full scan of `task_runs` (about 38 ms per 20,000 runs locally) on each hourly evaluation and ops-UI load | ADR-0115 PRV-3 residual | **Fix only inside STO-1** (same v16); on its own, accept: the cost is negligible at personal scale |
| R3 | The claim guard is best-effort lexical; the fixed footer is the guarantee | ADR-0118 GML-1 and DRV-1 residuals | **Accept.** Add wordings as live QA finds them |
| R4 | Drive listings include files shared with the owner (a stranger can place a hostile name) | ADR-0118 DRV-1 residual | **Accept** (inside the ADR-0118 threat model). An owned-only filter is optional (decision 9) |
| R5 | Drive exports only the first sheet of a spreadsheet | ADR-0118 DRV-1 residual | **Fix (P2):** DRV-2b, through the Sheets API under the existing `drive.readonly` scope (decision 8) |
| R6 | Markdown in Core values without an `untrusted` span (some `response-composer.ts` paths interpolate file paths) may lose a `*`/`_` pair on Telegram; fidelity only, never markup | ADR-0114 TG-3 "translation scope" | **Fix (P2):** PLT-1 |
| R7 | The OAuth token response is read with `response.json()`, unbounded (pinned to `oauth2.googleapis.com`) | ADR-0118 GML-1 and DRV-1 residuals; the same call is in `connector-calendar-google/src/oauth.ts` | **Fixed (P1):** HARD-1, merged in #175 (2026-10-12) |
| R8 | `NO_OWNER` uses a notice attempt like a retryable `NOT_SENT`; three ownerless hours give up that month's DM | ADR-0115 PRV-3 residual ("owner decision, kept as is") | **Accept** (already an owner decision) |
| R9 | The ops-UI token rotates at every start, so every restart or deploy needs a new sign-in | ADR-0113 D3 (by design); live-verified (v3 QA record A9) | **Accept.** It is the security property, not a defect |
| R10 | Discord web login was tab-scoped in the owner's QA browser tooling | Orchestrator report; no repository record | **Tooling note only.** DOC-F adds one line to the QA-record conventions; no product work |
| R11 | Listing numbers lost on restart; help-line bound; Telegram links and quotes | GML-1/DRV-1/TG-3 residuals | **Fixed:** v4 polish PR, merged in #174 (2026-10-12) |
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
    read the next morning's brief; C3 one Drive summary; C4 observe the 11/1 monthly DM. Each defect becomes an ordinary follow-up PR in the owning package.
  - **DOC-F** (docs only): a v5 section in a new `docs/uat/personal-v5-qa-record.md`; R10 noted in the QA
    conventions; the local `quoky-ship` skill text updated from "v4 waves" and `personal-v4-plan.md` to the v5 terms
    once decision 1 is answered.
- **ADR.** None.
- **Risks.** The November DM cannot be forced without touching the ledger state; it is observed, not triggered. DOC-F
  must not claim a result before the session that produced it.
- **Estimate.** DOC-F S. LIVE-2 one attended session of under an hour, plus two passive observations.
- **Dependencies.** The v4 polish PR merged first, so C3 runs on the final summary path.
- **AC.** C1-C4 are PASS, FAIL with a follow-up, or "accepted by the owner" in the v5 QA record.

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

### NL — Natural-language capability selection (P1, decision 23)

- **Goal.** The owner's natural phrasings reach the right read capability without new phrase lists. The audit routed
  176 of 372 capability phrases (47%); 193 of the 196 misses fell to chat.
- **Scope.**
  - **GOV-7** (docs only): ADR-0120 with every amended clause listed; ratified by the owner on 2026-10-12 (ratification
    record in DECISIONS.md).
  - **NL-1:** the closed catalog contributed by the handlers (ADR-0120 D1); the `INTENT_SELECTION` selector on the
    Claude CLI, Haiku-class by default (D2, D3); validation, grounding and symbolic time (D4); clarification,
    `lastSelection` and the interpretation preference in `Actor.metadata` (D7); `QUOKY_NL_INTENT_MODE` with `off`,
    `shadow` and Phase A `active` (selection acts only on messages bound for chat; ratification record decision 4) and
    content-free shadow logs (D11); the Jira `personal-work` window, role and status query (D13); an
    on-demand `brief.today` that reuses the brief composition, with no model and DM-only; honest chat (D9); the
    `nl-intent.v1.json` corpus and the offline suite (D12). Reads only (D5). The deps baseline becomes 36 (D14).
  - **NL-2** (gated on the NL-1 shadow data): Phase C (selection before the Class B grammars, which become the
    provider-down fallback), grammar-hit shadowing, the
    wave-2 gaps (mail ranges and subject keyword, Drive modified-since, calendar title keyword, Jira free-text search,
    GitHub filters), and retiring the Class B grammars under ADR-0120 D10.
- **ADR.** ADR-0120, ratified 2026-10-12.
- **Risks.** A valid but wrong selection (reads only, the basis line, the negative corpus); latency of a CLI spawn (p95
  target +3 s, measured in shadow); the owner's text egress (Phase A sends only messages already bound for chat).
- **Estimate.** GOV-7 S. NL-1 L. NL-2 M-L.
- **Dependencies.** ADR-0120 ratified. NL-1 merges after BRF-3 (shared reminders and `.env.example` files). NL-2 after
  the shadow data, the ADR-0120 D12 evaluation gate and the owner's yes.
- **AC.** ADR-0120 "Acceptance criteria": flag `off` is byte-identical; the offline suite and the evaluation gate pass;
  the owner's two phrases and "그 중에 위클리카만" answer correctly with the basis line.
- **Live QA.** About 40 phrasings per catalog entry on Telegram and Discord, including a provider-down case (NL-2).

### CON — Connector depth (P2)

The owner works in Google Workspace (v4 plan CON; calendar and mail live). Each item below is read-only.

- **GML-2, Gmail threads and reply picks (P2).**
  - `이 스레드 요약해줘` summarizes one thread (bounded message count and bytes, head-and-tail clip, the GML-1 summary
    path).
  - A platform reply to a listing message picks that entry (closes R13). Core has no inbound reply reference today
    (`replyToMessageId` exists only on outbound messages), so both adapters map the platform's reply into a new
    additive, opaque inbound field. Core never reads platform message ids as anything but data.
  - `gmail.readonly` already covers both; no new scope. Label listings are not built: the owner does not use Gmail
    labels (decision 7).
- **DRV-2, Drive shared drives (P2).** Search and recent files include the owner's shared drives
  (`includeItemsFromAllDrives`, `supportsAllDrives`), still `drive.readonly`, still the ADR-0118 listing and export
  rules. No `내 문서` owned-only filter (decision 9).
- **DRV-2b, all sheets (P2, decision 8: "모든 시트 필요").** The Drive export returns only the first sheet as CSV. The
  Sheets API reads every sheet: `spreadsheets.get` (sheet titles) and `spreadsheets.values.batchGet` (values). **Both
  methods accept `https://www.googleapis.com/auth/drive.readonly`** (Google Sheets API reference, "Authorization
  scopes", checked 2026-10-12), so ADR-0118 D3 holds: no new scope and no new consent. What changes is a new pinned
  host, `sheets.googleapis.com`, and the Google Sheets API must be enabled in the project `quoky-personal-510806`
  (Strict, owner-confirmed). Bounds and fallback are in the ADR-0118 amendment of 2026-10-12.
- **CAL-2, more calendars (P2, going ahead: decision 10, "다른 Google 캘린더가 있다").** Reading several calendars
  already works through `QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS` (the owner's host uses `primary`). The orchestrator lists
  the owner's calendars read-only, the owner picks which ones, and the ids go into `.env.local` (Strict). The extra
  calendars are read-only and appear in `오늘 일정` and the brief; writes stay on the primary calendar (ADR-0110
  amendment). If two configured calendars can share an event id, an additive `calendarId` on `CalendarEvent` closes
  BRF-2 R8; that port field needs its own ADR-0110 amendment first and is not part of GOV-6.
- **ADR.** The ADR-0118 amendment of 2026-10-12 (Ratified) covers GML-2 (the `MailReader` thread read, and the
  inbound reply field on the domain message, which both platform adapters fill), DRV-2 (the corpus widening) and DRV-2b
  (the Sheets API read). CAL-2 needs no ADR unless the port field is wanted.
- **Risks.** Threads multiply hostile text per summary: the same untrusted framing, no tools, a tighter byte bound.
  Shared drives widen who can place a hostile name in a listing: the R4 threat model, now larger. All sheets means more
  hostile cells per summary: the same 256 KiB bound across sheets, sheet titles as untrusted spans.
- **Estimate.** GML-2 M. DRV-2 S. DRV-2b M. CAL-2 S (S-M with the port field).
- **Dependencies.** The v4 polish PR merged (it owns the mail and Drive handlers). The amendment ratified.
- **AC.** Fixture adapters answer the new phrasings deterministically; an injection thread produces no action; listings
  stay DM-only; the routing corpus gains cases and nothing else moves.
- **Live QA.** About 10 phrasings per item on the owner's DM, including a long thread, a reply pick after a restart,
  a shared-drive document, a multi-sheet spreadsheet, and `오늘 일정` with the added calendars.

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

The parked items stay parked; the orchestrator recommends keeping them parked (2026-10-12).

| Item | Recommendation | Reason | Re-entry condition |
|---|---|---|---|
| COST-1 price table on the usage ledger | **Drop for now** | No metered provider is configured; Claude and Codex run on subscriptions, which cost nothing per token (ADR-0115 PRV-3 residual) | The owner adds an OpenAI or Gemini key |
| PRV-1/PRV-2 live, LRN-5 round trip | **Park** | Owner deferral, 2026-10-12 (section 1.1) | The owner re-requests the keys |
| Notion connector | **Park** | v4 decision 20 undecided; owner deferral, 2026-10-12 ("Notion 도 마찬가지야") | The owner asks for it; then a new ADR |
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
| 0 | LIVE-2 | LIVE | No code. Strict observations C1-C4 | haiku (log reading), owner-attended | polish PR merged (C3 only) |
| 0 | DOC-F | LIVE | `docs/uat/personal-v5-qa-record.md` (new), `CURRENT_STATE.md`, the local `.claude/skills/quoky-ship/SKILL.md` (untracked) | sonnet | decision 1 |
| 1 | GOV-6 | GOV | `DECISIONS.md` (ADR-0119, the ADR-0117 and ADR-0118 amendments, the v5 ratification record), `ROADMAP.md`, this plan | opus | owner answers |
| 1 | HARD-1 | HARD | `connector-gmail/src/oauth.ts`, `connector-gdrive/src/oauth.ts`, `connector-calendar-google/src/oauth.ts` (+tests) | sonnet | — |
| 1 | PLT-1 | PLT | `core/application/response-composer.ts`, `core/application/message-rendering.ts`, `adapter-discord` golden fixture additions | sonnet (opus review) | polish PR merged |
| 2 | BRF-3 | BRF | `core/application/reminders/daily-brief.ts`, `daily-brief-sources.ts` (+tests), `app/reminders/brief-sources.ts`, `reminder-config.ts`, `.env.example` | sonnet | ADR-0117 amendment |
| 2 | STO-1 | STO | `storage-sqlite/src/migrations.ts`, `storage-sqlite/src/index.ts` (session and run queries), `core/ports/storage-provider.port.ts`, `core/application/session-manager.ts` (+tests) | opus | ADR-0119 |
| 2 | GOV-7 | NL | `DECISIONS.md` (ADR-0120 and its ratification record, 2026-10-12), `ROADMAP.md`, this plan | opus | owner answers 20-23 |
| 2 | GOV-9 | GOV | `DECISIONS.md` (ADR-0121 ratification record, 2026-10-13), `ARCHITECTURE.md`, `AGENTS.md`, `ROADMAP.md`, `docs/plans/architecture-amendment-agent-draft.md`, this plan | opus | owner answers 24-26 (done) |
| 2 | NL-1 | NL | a new `core/application/nl-routing/*`, `core/ports/conversation-turn-handler.port.ts` (two optional members), `core/domain/enums.ts` (`INTENT_SELECTION`), `core/application/conversation-runtime.ts` (one dispatch point, one deps key), the catalog and `handleSelected` of `work-chat/*`, `calendar/*`, `mail/*`, `drive/*`, `help-intent/*` and `reminders/reminder-turn-handler.ts`, `core/ports/connector-query.ts` and `connector-jira` (D13), `intent-classifier.ts` and `chat-policy/*` and `prompt-composer.ts` (honest chat), `packages/ai-cli` (advertising the capability), `app/features/nl-intent.providers.ts` (new), `.env.example`, `golden/nl-intent.v1.json` (+tests) | opus (design, review), sonnet (handlers, tests) | ADR-0120 ratified; after BRF-3 (shared `reminders/*` and `.env.example`) |
| 3 | GML-2 | CON | `core/application/mail/*`, `core/ports` mail port (additive), `core/domain/messaging.ts` (inbound reply field), `adapter-discord` and `adapter-telegram` inbound mapping, `connector-gmail/src/gmail-mail-reader.ts`, `app/features/mail.providers.ts`, golden corpora | opus | polish PR, ADR-0118 amendment, NL-1 merged (it owns `mail/*` in W2) |
| 3 | DRV-2 + DRV-2b | CON | `core/application/drive/*`, `connector-gdrive/src/gdrive-reader.ts`, a new `connector-gdrive/src/sheets-reader.ts` (+ source scan), `app/features/drive.providers.ts` | opus (new host) | GML-2 merged first (same wave, sequential), polish PR, Sheets API enabled (Strict) |
| 3 | CAL-2 | CON | No code: the owner picks calendars, then the `.env.local` edit (Strict). `core/domain` calendar event and `connector-calendar-google` only if an ADR-0110 amendment adds `calendarId` | haiku (listing), sonnet | decision 10 (yes) |
| 3 | INT-4 | INT | `app/personal-v5-acceptance.test.ts`, golden additions, `baseline.v1.json` | sonnet | merged tracks |
| 3 | DOC-G | DOC | `CURRENT_STATE.md`, `CHANGELOG.md`, `DECISIONS.md` (implementation notes), `ROADMAP.md`, quickstart, operator guide | sonnet | merged tracks |
| 4 | NL-2 / S1, then S2 (ADR-0121, ratified 2026-10-13) | NL | Agent stages S0/S2 per ADR-0121 (`core/application/agent/*`, `app/security/*`, `ops/security/*`), ratified 2026-10-13 (GOV-9); `core/application/nl-routing/*`, `conversation-runtime.ts` (Phase C order), the Class B grammars being retired, `mail/*`, `drive/*`, `calendar/*`, `work-chat/*` and their read ports and adapters for the wave-2 gaps, golden corpora (+ its own acceptance and docs) | opus | satisfied 2026-10-13: ADR-0121 ratified (GOV-9), S0 shipped (#185/#186), the D8 egress yes for Phase C given; still gating: the ADR-0120 D12 evaluation gate for S1 and the ADR-0121 D11 gates for S2 |

Inside a wave, tasks run in parallel in separate worktrees, except where the Deps column orders two tasks of the same
wave. P2 tasks may be dropped without blocking INT-4. INT-4 and DOC-G close waves 1-3; NL-2 carries its own acceptance
and docs.

### Lanes

**Migration lane** (ADR-0096 D10: additive, idempotent, numbers fixed). **v16 belongs to STO-1 only.** No other v5
task needs a migration (BRF-3, GML-2 and DRV-2 add no stored state; CAL-2's field lives in the event, not the DB; NL-1
keeps its state in the existing `Session.metadata` and `Actor.metadata` JSON, ADR-0120 D7). A
task that finds it needs one takes v17 after STO-1 merges. Applying any migration on the service DB is Strict.

**Hot-file lane** (one editor per wave):

| File | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| `response-composer.ts` (3,107 lines) | PLT-1 | — | — | — |
| `conversation-runtime.ts` (8,154 lines) | — | NL-1 (one selection dispatch point, one deps key) | — | NL-2 (Phase C order) |
| `core/ports/conversation-turn-handler.port.ts` (handler port) | — | NL-1 (`catalog?`, `handleSelected?`) | — | — |
| `core/application/work-chat/*`, `ports/connector-query.ts`, `connector-jira` | — | NL-1 (catalog, `handleSelected`, Jira D13 query) | — | NL-2 |
| `intent-classifier.ts`, `chat-policy/*`, `prompt-composer.ts` | — | NL-1 (honest chat, QUAL-7 narrowing) | — | NL-2 |
| `core/application/mail/*` | — | NL-1 (catalog, `handleSelected` only) | GML-2 | NL-2 |
| `core/application/drive/*` | — | NL-1 (catalog, `handleSelected` only) | DRV-2 (after GML-2) | NL-2 |
| `turn-handlers.providers.ts` | — | NL-1 (only if a new handler) | GML-2 (only if a new handler), then DRV-2 (rebased) | — |
| `.env.example` | — | BRF-3, then NL-1 (rebased) | CAL-2 (comment only) | — |
| `storage-provider.port.ts`, `storage-sqlite/src/*` | — | STO-1 | — | — |
| `core/domain/messaging.ts`, platform adapters' inbound mapping | — | — | GML-2 | — |
| `core/application/reminders/*` | — | BRF-3 (`daily-brief*`), then NL-1 (`reminder-turn-handler.ts` only) | — | — |
| `DECISIONS.md` | GOV-6 | GOV-7 | DOC-G | NL-2 (implementation note) |

**Deps baseline.** 35 until NL-1 merges; NL-1 adds the one key `nlSelection?` (ADR-0120 D14: 35 → 36). No other v5 task
is expected to add one; a task that needs one says so in its ADR first.

## 5. Governance and validation

- **Standing approval (decision 1).** The v4 approval is not inherited. The ratification record (decision 1) covers
  Push → PR → Merge after offline validation, independent review and Codex PASS. The `quoky-ship` skill's approval line
  also names deploying to the always-on service and a smoke check. v5 should state both explicitly: the recommended
  default renews the v4 terms **and** names the deploy and smoke steps. Every Strict item below is still confirmed per
  target.
- **ADR gate.** A track's first code merge waits for its ADR or amendment to be ratified. GOV-6 appended ADR-0119 and the
  ADR-0117/ADR-0118 amendments, Ratified on 2026-10-12 with the owner's answers. HARD-1, PLT-1 and the docs tasks need implementation notes
  only. GOV-7 appended ADR-0120, which the owner ratified on 2026-10-12 (ratification record in `DECISIONS.md`); NL-2 waits
  for its own gates (ADR-0120 D6, D10, D12). A stalled ADR stalls only its own track.
- **Chief Architect review (independent, mandatory before merge):** STO-1 (a Core storage port and a migration), GML-2
  (a port widening and a larger injection surface), DRV-2 and DRV-2b (a corpus widening and a new pinned host), BRF-3 (hostile text in a scheduled DM),
  PLT-1 (untrusted rendering on both platforms), NL-1 and NL-2 (a new capability, a new dispatch point, two port
  members and a deps key). HARD-1 needs Codex only.
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
  any merge-flag change); enabling the Google Sheets API in `quoky-personal-510806` (DRV-2b); runtime restarts outside
  the ship pipeline; any new OAuth scope (none is needed); the owner-attended LIVE-2 session; each ADR-0120
  model-in-the-loop evaluation run (an approved plan digest per run); the `QUOKY_NL_INTENT_MODE` edits (`shadow`, then
  `active`); the NL live UAT; grammar-hit shadowing or Phase C (a new egress, the owner's yes first).
- **Honesty.** No document claims a live result before the session that produced it. Pending stays Pending.

## 6. Risks

| Risk | Mitigation |
|---|---|
| The v16 migration damages the owner's live sessions or runs | Additive only; backfill from stored context; a v15 fixture test; `quokyctl.sh backup --apply` and `--verify` before the Strict apply; CA review |
| More hostile text reaches the owner (threads, shared drives, mail subjects in the brief) | Same untrusted framing, guarded clips, link neutralizing and DM-only rules as v4; no tool surface; CA review on each |
| PLT-1 changes Discord output | Byte-identical golden fixture (793 cases) plus new cases; full `pnpm test` |
| v5 collides with the in-flight v4 polish PR | It owns the mail, Drive, help and Telegram formatting files in W0; PLT-1, GML-2 and DRV-2 start after it merges |
| Low-value work crowds out the owner's attention | P2 items run only on a "yes" in section 7; COST-1, CODE-10 and the unscoped items are dropped (decisions 11, 12, 18) |
| Stale docs mislead later agents (the per-track `CURRENT_STATE.md` sections still say "not run yet") | DOC-F records the C-rows; DOC-G closes v5; the honesty rule |
| The standing approval is read wider than granted | Decision 1 names every automatic step, including deploy and smoke; Strict items stay per target |
| NL selection picks a valid but wrong capability, or captures a negative | Reads only in wave 1 (decision 21); the basis line on every answer; owner-approved negatives with a 0-wrong-capture gate; shadow before active (ADR-0120 D5, D11, D12) |
| NL selection adds latency or fails when the Claude CLI is slow or down | One call, 4 s timeout, no retry; p95 measured in shadow before NL-2; the frozen Class B grammars and honest chat are the fallback (ADR-0120 D3, D6) |
| Regex widening creeps back in under deadline pressure | The Class B grammars are frozen at ratification; a miss becomes a corpus case, never a regex (ADR-0120 D10; owner, 2026-10-12: "하드코딩이면 안된다는 말임") |
| A stored interpretation preference answers with the wrong basis for 30 days | The basis line shows it on every answer, the owner overrides it in plain words, and it expires after 30 days (ADR-0120 D7, decision 22) |
| More owner text leaves the host | Phase A sends only messages already bound for Claude chat; grammar-hit shadowing and Phase C need the owner's separate yes (ADR-0120 D8) |

## 7. Owner decisions (answered 2026-10-12)

The Product Owner answered in the orchestrator chat on 2026-10-12 ("응 확정할게 진행하자"). Every question takes its
recommended default, except where the last column says otherwise. The answers are recorded in the v5 ratification
record in `DECISIONS.md`. Decisions 20-23 were asked later the same day, after the natural-language routing audit, and
answered in the orchestrator chat on 2026-10-12; they are the owner answers 1-4 quoted in ADR-0120, ratified on
2026-10-12 (its ratification record follows the ADR in `DECISIONS.md`).

| # | Question | Recommended default | Reason | Owner answer (2026-10-12) |
|---|---|---|---|---|
| 1 | Renew the standing approval for v5 waves: automatic Push/PR/Merge, deploy to the service and a smoke check after offline validation, independent review and Codex PASS; Strict items still confirmed per target? | **Renew on the v4 terms, with deploy and smoke named explicitly** | It worked across v4 (#152-#173). The recorded v4 decision names Push/PR/Merge only, while the ship skill also deploys | **Renewed** on the v4 terms, with deploy to the service and the smoke check named explicitly |
| 2 | Is v5 a depth-and-hardening release with no new platform, vendor or connector? | **Yes** | The owner's daily surfaces are all live; the remaining gaps are depth and recorded residuals | **Yes** (recommended default) |
| 3 | Keep the OpenAI/Gemini keys and Notion deferred until you ask again, with their live checks Pending? | **Yes** (your chat statement of 2026-10-12) | Nothing in v5 depends on them | **Yes**: "OpenAI / Gemini API Key는 필요시에 내가 재요청할게. Notion 도 마찬가지야." |
| 4 | STO-1: fix the session platform key and add the usage index in one migration v16, applied on the service DB after a verified backup? | **Yes, as P2, in one migration**; if no, accept both as permanent residuals | Each migration costs a Strict apply, so bundling both is cheaper. Neither causes a visible problem today | **Yes**, P2, one migration v16 (ADR-0119) |
| 5 | HARD-1: bound the OAuth token reads in all three Google connectors? | **Yes** | Small, no behaviour change, closes a security-hygiene residual | **Yes** (recommended default) |
| 6 | BRF-3: add an opt-in unread-mail section (count plus up to 3 sender/subject lines, no body) to the morning brief? | **Yes, off by default**; you turn it on | Mail is live and used; the brief already runs daily | **Yes, off by default** (ADR-0117 amendment of 2026-10-12) |
| 7 | GML-2: thread summaries and reply-to-pick? Label listings too? | **Threads and reply picks yes; labels only if you use Gmail labels** | Reply picks close a recorded residual; labels are unused by any recorded QA | **Threads and reply picks yes; labels no** (the owner does not use Gmail labels) |
| 8 | DRV-2b: read every sheet of a spreadsheet (the draft assumed this needs the new `spreadsheets.readonly` scope or a zip-export parser; GOV-6 found that the Sheets API accepts `drive.readonly`)? | **No**, unless you work in multi-sheet spreadsheets | The draft expected an ADR-0118 D3 amendment and a new consent for an edge case | **Yes**: "모든 시트 필요". Through the Sheets API under `drive.readonly`: no new scope or consent (ADR-0118 amendment) |
| 9 | DRV-2: include your shared drives in Drive search? Add an owned-only `내 문서` filter? | **Shared drives yes; the filter optional (no)** | No new scope; accepting shared-with-me names is already the ADR-0118 threat model | **Shared drives yes; no owned-only filter** (recommended default) |
| 10 | CAL-2: add more calendars to `QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS` (read only; writes stay on primary)? | **Only if you have other calendars you want in `오늘 일정` and the brief** | It is configuration, not code; the port field is needed only for shared event ids | **Yes**: "다른 Google 캘린더가 있다". Read-only in `오늘 일정` and the brief; writes stay on primary; the owner picks the calendars from the orchestrator's list |
| 11 | Keep `QUOKY_GIT_MERGE_ENABLED=false` on the service, and drop CODE-10? | **Yes to both** | Merge passed once on the sandbox; a second repository is not in daily use | **Yes to both** (recommended default) |
| 12 | COST-1 price table on the usage ledger? | **Drop for now** | No metered provider is configured | **Dropped for now** (recommended default) |
| 13 | Telegram inline approval buttons? | **Keep parked** (ADR-0114 D10) | Text phrases passed live; buttons add a second decision surface | **Kept parked** (recommended default) |
| 14 | SUB-3 continuation and the Stage 2A re-validation? | **Keep parked** | No concrete background-job need appeared in v4 | **Kept parked** (recommended default) |
| 15 | PLT-1: move the remaining interpolated Core values into untrusted spans? | **Yes, P2** | Fidelity on Telegram, and it finishes what PLT-0 started; Discord stays byte-identical | **Yes, P2** (recommended default) |
| 16 | Accept residuals R3, R4, R8, R9, R12, R14, R16, R18, R19 and keep R20 as documented? | **Accept all** | Each is by design or has no user-visible effect; R8 is already your decision | **Accepted** (recommended default) |
| 17 | Let Drive read uploaded text files (an ADR-0118 D2 amendment with a binary sniff)? | **No** | Docs and Sheets cover the recorded use; a new egress path for little gain | **No** (recommended default) |
| 18 | "Memory improvements" (ROADMAP "Future"): plan it now? | **No track** until you name a concrete problem | No QA record shows a memory defect | **No track** (recommended default) |
| 19 | CODE-8 on a second allowlisted repository (C6): keep it Pending until a second real repository is registered? | **Yes, park with CODE-10** | The narrowed installation is confirmed on the sandbox; a second repository is not in daily use | **Yes, parked with CODE-10** (recommended default) |
| 20 | NL selection: which provider and model, and on which messages? | — (open question of the design input) | Phase A (fall-through messages only) adds no new egress class; the model choice decides latency | **Claude CLI, fall-through messages only, Haiku if it passes the gate** (2026-10-12): "우선은 Claude CLI, 놓친 문장만으로 진행하되, 모델은 빠른 모델이니 하이쿠만으로도 대체가 되면 하이쿠만으로도 진행해도 좋아. 이번에 하이쿠 5.5가 발표되면서 하이쿠 성능도 좋아졌으니 …". Sonnet only if Haiku fails the ADR-0120 D12 gate; the model id is adapter configuration (ADR-0120 D2) |
| 21 | NL selection: may it start writes? | — (open question of the design input) | Writes are irreversible; the read results show whether selection is trustworthy | **Reads first, writes after seeing the read results** (2026-10-12): "1차는 조회, 쓰기는 조회 결과 보고 진행". NL-initiated writes need a later ADR-0120 amendment (D5) |
| 22 | An ambiguous phrase such as "오늘 등록된 jira 이슈" (created by whom?) | **One clarifying question, never chat** (a default of the design input); the 30-day TTL, basis line and override were the orchestrator's proposal on the answer | A guess is a wrong answer; chat deflects | **Ask once and remember the answer** (2026-10-12): "사용자한테 한번 물어보고, 그 물어본 답이 캐시로 되어 특정 시간에는 계속 캐시 연결 → 주제로 넘어가면 좋을거 같은데". Per actor and ambiguity key, 30-day TTL, a basis line on every answer, overridable at any time, stored in `Actor.metadata` with no migration (ADR-0120 D7) |
| 23 | When does NL selection start? | — (open question of the design input) | ADR-0120 must be ratified before any NL code | **Next wave** (2026-10-12): "다음 웨이브로 바로". GOV-7 and NL-1 join wave 2 with BRF-3 and STO-1; GML-2 moves to wave 3; NL-2 follows the shadow data (section 4) |

Decisions 24-26 were answered in the orchestrator chat on 2026-10-13 and are recorded in the ADR-0121 ratification
record in `DECISIONS.md` (GOV-9).

| # | Question | Answer |
|---|---|---|
| 24 | Ratify ADR-0121 and the ARCHITECTURE.md amendment? | **Yes, with a binding principle**: "확정이긴하지만 무조건적으로 OpenClaw 를 모방해서 개발하란 소린 아니니까 판단은 잘해야해 난 보다 나은 결과물을 얻고 싶은거야". OpenClaw is a reference, not a target. Each capability must earn its place by measured results (NL/plan eval, red-team 0 attacks, latency, owner UX); the simpler bounded or deterministic design wins when equal or better |
| 25 | S1: may Phase C send grammar-hit owner messages (prepared text only) to the selector? | **Yes**: "허용 (권장)". The same provider-family and pre-egress guard rules apply |
| 26 | The remaining design defaults (Q2, Q3, Q9) | "보안팀 공유는 빼고": Q2 (same-source references only, at most 10 ids) accepted; Q3 (calendar text local-only) accepted; Q9 (share the self-check with the security team) declined. Settled earlier the same day: Q4 observe 7 days then enforce with the owner's OK (ask due about 2026-10-20), Q5 token rotation later, Q6 Tailscale removed, Q7 in-repo secret scan (#186), Q8 L1 #185 and L2 #189 with the 6 s bound kept, Q10 OS-level control not now |

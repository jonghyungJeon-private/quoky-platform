# Quoky Personal v4 — Plan (post-v3)

- **Status:** **RATIFIED (2026-10-08).** The Product Owner answered section 7 in chat on 2026-10-08 ("v4 권장안대로
  진행하고"): every question takes its recommended default, except decision 20 (Notion), which is recorded as undecided.
  The answers are in section 7 and in the ADR-0114..0118 ratification record in `DECISIONS.md`. ADR-0114..0118 and the
  ADR-0109 amendment are Ratified. Ratification authorizes no Strict action by itself: each Strict target in section 5
  still needs its own owner confirmation.
- **Date:** 2026-10-08
- **Base:** `main` at `f14e97d` (PR #148 merged). SQLite schema v15. `ConversationRuntimeDeps` baseline 35. 10
  registered turn handlers. Golden ratchet `turn-handler-routing` minTotal 338 and `action-shaped-fallthrough` 121
  (`baseline.v1.json`).
- **Inputs:** `ARCHITECTURE.md`, `ROADMAP.md` ("Post-v3 extensions"), `CURRENT_STATE.md`, `docs/plans/personal-v3-plan.md`
  (template), ADR-0102..0113 and their amendments, the ADR-0092 and ADR-0111 amendments of 2026-10-07/08,
  `docs/uat/personal-v3-qa-record.md`, the `CHANGELOG.md` "Unreleased" entries, and the commit messages of PRs
  #135-#148.
- **Structure:** mirrors `docs/plans/personal-v3-plan.md`. Where this plan and a ratified ADR disagree, the ADR wins and
  this plan is corrected. GOV-5 assigned the ADR numbers on 2026-10-08: ADR-0114 (Telegram), ADR-0115 (HTTP API providers
  and the constitution amendment), ADR-0116 (learning-example egress), ADR-0117 (brief and pre-meeting reminders) and
  ADR-0118 (Google read connectors).

## 1. Goal and scope

### 1.1 Where v3 and its follow-ups leave the Personal edition

`CURRENT_STATE.md` estimated about 80% of the Personal edition after the v3 closeout (#134). This is an estimate, not
a measured metric. PRs #135-#148 then closed several live gaps and changed the provider picture. Each is listed below.

| PR | What changed |
|---|---|
| #135 | Truthful cross-session execution guidance: an execution phrase sent in another conversation (W6-L01, the owner DM) points to the waiting approval and never reports an unrelated old post as "이미 실행했어요" |
| #136 | 👍/👎 on replies posted before the last restart (uncached partials) are counted (W6-L10) |
| #137 | Git concept questions (`rebase와 merge 차이`) and handler commands are never captured by the code-chain word checks (W6-L06, W6-L11) |
| #138 | Text attachments reach the chat prompt as bounded, untrusted context, with hardened credential guards (invisible-character folding; W6-L07/L08) |
| #139 | QA record for live session 2 (W6-L01..L11) |
| #140 | Image provider selector `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` = `ollama` \| `claude` \| `off`. Claude (cloud) is available only when the owner selects it (ADR-0111 amendment) |
| #141 | Chat provider selector `QUOKY_CHAT_PROVIDER` = `claude` \| `codex` \| `ollama`. `CodexCliProvider` (OpenAI) serves the chat tier. ARCHITECTURE.md §2 principle 1 was amended with owner approval (ADR-0092 amendment) |
| #142 | Runtime model switching: an operations-UI default (`/providers`) and the session-scoped `모델 변경` / `/model` command. New Core port `ProviderSelectionPolicy`. ARCHITECTURE.md §12 now carries the session-preference exception (ADR-0092 amendment) |
| #143 | Model-switch follow-ups: `모델 목록` lists only chat-capable models, and image intake is byte-typed and canonicalized (structural validation, metadata dropped) |
| #144 | Semantic recall keeps its embedding model warm (`--keepalive 30m`). A provider that was not ready at boot is re-probed on demand (30/60/120 s) |
| #145 | Codex is an image-understanding option (`image:codex`). Model replies flagged `format: 'model-reply'` get safe Discord rendering of simple Markdown tables (ADR-0111 amendments) |
| #146 | Every backup includes a vector-store snapshot. New `quokyctl.sh backup` / `backup --apply` / `backup --verify` for on-demand verified copies and a read-only restore drill |
| #147 | Truthful execution-phrase replies: no stale "already sent", no "nothing sent" after an unconfirmed write. Revoke and execute are serialized under the approval and session locks (live QA session 3 D1/D11/D12, Codex P1) |
| #148 | Live QA session 3 defects. Calendar: undated change/delete resolves from the session's recent calendar context; the booking title keeps the whole noun phrase (D2, D10). Slack search: DMs and group DMs are dropped and results are labelled by channel name (D3, D15). Recall: a semantic score under the similarity floor is not an own-memory hit (D5). Operations-UI lookups are read-only (ADR-0113 D4). Labels and particles fixed (D8, D9, D13) |

**Owner decisions of 2026-10-07 (recorded in the ADR-0092 and ADR-0111 amendments):**

- General chat runs on Claude Sonnet: the service has `QUOKY_OLLAMA_ENABLED=false`, which the chat selector reads as
  `claude`.
- Images run on Claude.
- Rationale for cloud processing: comparable assistants (OpenClaw, Buzz, OpenAI Dots) also send conversations to
  Anthropic or OpenAI.
- Providers stay switchable, OpenClaw-style: from configuration, from the operations UI, or with a per-session
  `/model`.

**In progress elsewhere:** CODE-8, the multi-repository allowlist (ADR-0109, Ratified), is being implemented on another
branch. v4 does not own its files (section 4, hot-file lane).

**Documentation drift found while drafting (fixed by DOC-D in wave 0):**

- `CURRENT_STATE.md` still heads the chat-selector and runtime-switching entries "implemented on branch, not merged",
  although #141 and #142 are merged.
- `docs/uat/personal-v3-qa-record.md` has no section for live QA session 3. Its defects (D1-D15) are documented only in
  the #147/#148 commit messages. Those messages show that Slack search ran live with a user token. The QA record still
  lists Slack read lookups as NOT RUN.
- The `ROADMAP.md` Personal v3 row and the v3 status table predate #135-#148.

### 1.2 What the cloud decision changes

The owner now runs chat and images on cloud providers. Several v3 items were designed around a local model, so their
value has to be re-assessed:

1. **Local-model quality work loses most of its value.** LLM-2/LLM-3 and the W6-L05 finding (about 5 of 20 granite
   replies usable as is) concern a local model that no longer serves the owner's chat. Ollama still serves embeddings
   (`nomic-embed-text`). It stays an optional chat or vision choice.
2. **The owner-curated learning loop does nothing on the owner's setup.** LRN-2 examples are `LOCAL_ONLY`
   (ADR-0107 D5/D6, ARCHITECTURE.md §5.14), so they never reach Claude or Codex. Recalled memory, transcripts and
   attachments already go to the selected cloud provider (ADR-0092 amendment D4). The learning examples are the one
   piece of chat context that does not. This is owner decision 11.
3. **SUB-3's receiver path is bound to local models.** The `general-chat-v1` continuation receiver runs through the
   Stage 2B routed seam. Its production configuration binds only `ollama-cli:llama3.1:8b` (balanced) and
   `ollama-cli:granite3.3:8b` (semantic) (`apps/quoky/src/provider-routing/production-provider-routing-config.ts`).
   Activating it would run the long summaries on exactly the models the owner moved away from. Adding a cloud
   candidate would widen the Stage 2B scope, which ARCHITECTURE.md §5.9 limits to "only the ratified balanced and
   semantic Ollama candidates". That needs its own ADR.
4. **The Stage 2A provider-path re-validation guards only that disabled seam.** The bindings were invalidated by
   `prompt-composer.ts` edits (ADR-0107, the #138 attachment-context module). They gate the Stage 2B routed seam and
   continuation, which are both off. The everyday chat path uses the legacy `CapabilityRouter` and does not read them.

### 1.3 v4 target

**Target (estimate, not a measured metric): about 90% of the Personal edition.** The bar is unchanged: "needed for a
real user to use the service?". For the owner, v4 is done when:

- The owner can use Quoky from a second messenger (Telegram) as the same person: same memory, reminders and to-dos,
  same gates.
- The owner can choose among more providers for chat and images, under the same selection rules: Claude, Codex,
  Ollama, plus an OpenAI API adapter and a Gemini API adapter (ADR-0115).
- A morning brief arrives by DM with today's calendar next to reminders and to-dos, and Quoky can remind the owner
  before a meeting.
- The owner can ask about their own mail and Drive files read-only, under the same guards as the other connectors
  (ADR-0118).
- The v3 live items that are still PENDING are run or explicitly accepted. The docs match `main`.
- Every learned or curated improvement reaches the provider that actually answers (ADR-0116).

**Left out on purpose (the remaining ~10%):** the multi-agent runtime, Team/Hosted tenancy, remote access to the
operations UI and a separate client (ADR-0113 D11), deploy/release automation, Confluence and GitHub-issue writes, and
mail sending.

### 1.4 Priority tiers

P0 is needed for a real user. P1 makes the service clearly more useful. P2 is stretch work or waits on a decision. P3
means closed or parked: it is not planned in v4, but its ADR stays as ratified.

| Tier | Items |
|---|---|
| P0 | LIVE-1 carry-over live sessions, DOC-D docs drift, PLT-0 platform-neutral rendering (Telegram prerequisite), DET-2 deterministic coverage completion, LRN-5 learning egress realignment (ADR-0116) |
| P1 | TG-1/2/3 Telegram adapter, PRV-1/2 additional providers, BRF-1 calendar in the morning brief, GML-1 Gmail read, TBL-1 Discord table limits |
| P2 | BRF-2 pre-meeting reminders, DRV-1 Google Drive read, PRV-3 usage ledger, CODE-9 merge-enablement UAT, UNC-1 network-failure live test |
| P3 (closed or parked) | SUB-3 continuation activation, S2A-1 Stage 2A re-validation, LLM-3 MLX provider, LRN-4 local fine-tuning, a model-proposed PR title/body (ADR-0108 D4), a mobile or remote operations UI, a Notion connector (decision 20 undecided: an unscheduled candidate, revisited on the owner's request) |
| Out | Multi-agent runtime, Team/Hosted tenancy, remote ops-UI access, deploy automation, Confluence/GitHub-issue writes, mail send, Telegram groups (decision 3: private chat only) |

## 2. Carry-over from v3 (not yet live, or accepted residuals)

None of these items is claimed as done. Sources: the end of the QA record and `CURRENT_STATE.md` "STILL PENDING".

| # | Item | State | v4 handling |
|---|---|---|---|
| C1 | Operations UI: UI reject, the chat/UI race, UI reminder cancel and memory forget, per-panel check against chat, a foreign-Origin request, token rotation across a restart (ADR-0113 live QA) | UI approve PARTIAL PASS (W6-A2); the rest PENDING | **LIVE-1**, on a DB copy for cancel/forget, against the Slack test channel for approve/reject |
| C2 | Attachments: unsupported type, non-allowlisted channel (dropped), injection caption | PENDING (text log, image, oversize and credential-like files ran in session 2) | **LIVE-1** |
| C3 | CWR: W5-L01..L04 re-run | PENDING (fixed in #130, unit-tested). #147 rewrote much of that copy | **LIVE-1**, re-run against the #147 replies |
| C4 | CWR: mid-send network failure (`UNCERTAIN`) | PENDING; the owner approved running it on 2026-10-08 (Strict, scratch Docker runtime, never the service) | **UNC-1** (P2, owner decision 18) |
| C5 | SUB: a real host reboot | PENDING (session 2 used a `launchctl bootout`/`bootstrap` proxy) | **LIVE-1**, at an owner-chosen time |
| C6 | DET: the ~40-phrasing edge-case sweep per feature state; ADR-0104 D3 to-do/reminder status phrases | Sweep PENDING (wave 1 covered a sample); D3 not complete (memory phrases delivered by MEM-1) | **DET-2** |
| C7 | Slack read lookups | QA record says NOT RUN; the #148 commit messages show session 3 ran Slack search with a user token (D3/D15) | **DOC-D** records session 3 faithfully; **LIVE-1** re-checks DM filtering and channel labels after #148 |
| C8 | Stage 2A provider-path re-validation | Invalidated by `prompt-composer.ts` edits; the Strict re-run waits for owner approval | **S2A-1**, parked with SUB-3 (owner decision 16) |
| C9 | Live check of #140-#146 on the service: Codex chat, the runtime `/model` switch, the Codex image option, table rendering, the warm embedding model, `quokyctl backup --apply` | Partly run in session 3 (no record yet) | **DOC-D** records what ran; **LIVE-1** runs the rest |
| R1-R4 | v2 accepted residuals (storage CAS, symlink TOCTOU, regex credential guard, forced-stop send) | Accepted | Keep. R1's trigger (a second writer process) is not hit, because Telegram runs in the same process |
| R5 | Claim guard is best-effort lexical (ADR-0104) | Accepted | Keep. DET-2 adds corpus cases |
| R6 | Calendar write-intent detection (ADR-0110) | Accepted | Keep. #148 narrowed undated targets |
| R7 | Codex CLI containment is not "no tools at all" (ADR-0092 amendment) | Accepted | Keep. PRV-1 HTTP adapters, if approved, give a stronger containment option for OpenAI |
| R8 | PGID reuse window after a timeout (ADR-0092 amendment, runner) | Accepted | Keep |

## 3. Tracks

Each track lists the goal, scope, ADR need, risks, estimate, dependencies, priority, acceptance criteria (AC) and live
QA. Constraints common to all tracks:

- Dependencies point only `apps -> adapters -> core`. Adapter packages depend only on `@quoky/core` and their own
  library.
- Core never branches on a provider or platform id. Routing goes through capabilities, priority, `isAvailable()` and
  the `ProviderSelectionPolicy` data.
- New ports and their tokens go in `packages/core/src/ports`.
- A new feature arrives as an ADR-0096 turn handler plus an `app/features/*.providers.ts` composition. The deps baseline
  stays at 35 unless a track's ADR says otherwise.
- **AI HTTP APIs only for the chat and image tiers.** Owner decision 8 ratified the constitution amendment (ADR-0115;
  ARCHITECTURE.md §5.5 and AGENTS.md "Provider, Prompt, Context" amended on 2026-10-08). Every other capability stays
  on the CLI providers.

**Estimate scale.** Implementation effort by one agent plus review: S ≤ 1 day, M 2-4 days, L 5-8 days. Attended live QA
is extra and depends on owner availability. These are estimates.

### CARRY — Live carry-over and docs drift (P0)

- **Goal.** Close or explicitly accept every v3 PENDING item, and make the docs match `main` before new tracks start.
- **Scope.**
  - **LIVE-1** (no code): owner-attended sessions for C1, C2, C3, C5, C7 and C9, run with ego-browser on the dev bot and
    on the service where noted. Each fix goes to the owning package as an ordinary follow-up PR.
  - **DOC-D** (docs only): add a live QA session 3 section to the QA record, built from the #147/#148 commit messages
    and the session evidence. Correct the stale `CURRENT_STATE.md` headings and the `ROADMAP.md` v3 rows. Record the
    2026-10-07 owner decisions in `CURRENT_STATE.md`.
- **ADR.** None.
- **Risks.** Attended time is the bottleneck, so the QA list is ordered by user impact: ops UI handling, then
  attachments, then the reboot. DOC-D must not claim results that no session produced.
- **Estimate.** DOC-D S. LIVE-1 takes 2-3 attended sessions of about an hour each.
- **Dependencies.** None. DOC-D comes first so that LIVE-1 findings land in a correct record.
- **AC.** Every C-row is PASS, FAIL with a follow-up, or "accepted by the owner" in the QA record. `CURRENT_STATE.md`
  has no "not merged" heading for merged work.

### PLT — Platform-neutral rendering and the Telegram adapter (P0 for PLT-0, P1 for TG-1..3)

The owner decided on 2026-10-06 that Telegram is a post-v3 extension. ARCHITECTURE.md §13 already lists Telegram as a
`PlatformAdapter` evolution. `ROADMAP.md` "Post-v3 extensions" records the prerequisites.

- **Goal.** The owner can talk to Quoky from Telegram, as the same owner `Actor`, with the same admission, approval,
  credential and delivery guarantees as Discord.
- **Scope.**
  - **PLT-0, neutral rendering (P0, prerequisite).**
    - Core still escapes Discord markup in four modules: `work-chat/external-work-readout.ts` (`escapeDiscordText`),
      its use in `work-chat-renderer.ts`, `calendar/calendar-reply-renderer.ts` and
      `connector-writes/connector-write-copy.ts`.
    - Core will emit neutral text. Untrusted spans (connector readouts, calendar titles, write payloads) are marked
      with a domain-level type on `OutboundMessage`, following the `format: 'model-reply'` precedent of the ADR-0111
      amendment.
    - Each platform adapter applies its own escaping. Discord output must stay byte-identical, proven by golden
      before/after fixtures over every existing renderer test.
    - This restores ARCHITECTURE.md §2.2 ("The Core knows nothing concrete") for rendering. It needs no new decision.
      An implementation note in `DECISIONS.md` records the type.
  - **TG-1, text conversations.** A new `packages/adapter-telegram`. It uses the Bot API over HTTPS through `node:fetch`
    with long polling (`getUpdates`); webhooks are out because there is no inbound listener (decision 5).
    - Admission mirrors ADR-0091 per platform: `QUOKY_TELEGRAM_OWNER_IDS` (numeric `from.id`), private chats only
      (decision 3). Everything else is dropped with no reply and no download.
    - The startup identity check mirrors ADR-0102 D5: `getMe` must equal `QUOKY_TELEGRAM_EXPECTED_BOT_ID`.
    - Delivery: an adapter-owned chunker for Telegram's 4096-character limit, keeping the lossless preview chunking that
      `adapter-discord/src/delivery.ts` gives Discord today. Plain text by default; a fixed HTML subset only for code and diff previews, decided in
      the ADR.
    - Typing indicator: `sendChatAction`.
    - Identity: the Telegram owner id maps to the existing owner `Actor` through the ADR-0009 seam (decision 4), so
      actor-scoped recall, reminders, to-dos and learning items follow the owner. Sessions stay per platform
      conversation.
    - Composition: Core has a single `PLATFORM_ADAPTER` token today. The ADR picks a composite adapter in the
      composition root or a per-platform binding. Either way the runtime sees one `PlatformAdapter` contract, and
      `platform` stays opaque data that Core never branches on.
  - **TG-2, attachments, reactions, approvals.**
    - Attachments: the ADR-0111 bounds unchanged (at most 3; text ≤256 KiB; png/jpeg/webp ≤8 MiB), fetched through
      `getFile` only after admission, with sizes checked from metadata before download. The same canonical image
      intake as #143.
    - Feedback: 👍/👎 through `message_reaction` updates, if the Bot API delivers them in private bot chats (a spike
      verifies this). `onFeedback` is optional in the port, so a missing surface degrades cleanly.
    - Approvals: the existing text phrases (`승인`, `거절`, `… 실행`). Inline keyboard buttons are a later option
      (decision 7).
  - **TG-3, notifications and operations.**
    - `NotificationSink` routes by `target.platform`: a reminder is delivered on the platform where it was created.
      `OPS_NOTICE` and `OPS_DECISION_RESULT` go to the owner's primary platform (decision 6). `BRIEF` stays DM-only.
    - The operations UI gets a Telegram status panel: connected, identity verified, last poll and admitted-chat count.
      It shows no content.
    - `quokyctl` and the quickstart get a Telegram section. The bot is created through BotFather by the owner
      (Strict).
- **ADR.** **ADR-0114, Telegram platform adapter.** It covers per-platform owner admission (amends ADR-0091),
  identity mapping (ADR-0009), the composition of several platform adapters, the startup identity check (amends
  ADR-0102 D5), delivery and chunking (relates ADR-0016), attachment intake (amends ADR-0111 D1/D2 for the second
  platform), feedback (ADR-0098 D3), notification routing (amends ADR-0101 D8 and ADR-0113 for `OPS_*` targets), the
  operations-UI panel (ADR-0113), and its env keys. PLT-0 needs an implementation note only.
- **Risks.**
  - A second untrusted inbound surface: a bot is reachable by anyone who finds its handle. Exact numeric owner ids,
    private chats only, drop by default, nothing downloaded before admission.
  - Bot token theft gives full control of the bot: `.env.local` at mode 600, never logged, the identity check at
    startup.
  - Telegram's servers see the content, as Discord's do. The ADR records this egress as accepted on the same basis
    (decision 4 rationale).
  - Byte-identical Discord output after PLT-0: golden fixtures and a full `pnpm test`.
  - Two pollers on one token conflict (HTTP 409): the ADR-0102 single-instance lock already prevents this; a 409 is a
    typed startup error.
- **Estimate.** PLT-0 M. TG-1 L. TG-2 M. TG-3 M.
- **Dependencies.** PLT-0 before TG-1. ADR-0114 ratified before TG-1 merges. The owner creates the bot (Strict) before
  any live QA.
- **AC.**
  - Discord output is byte-identical after PLT-0, and no Core module names a platform's markup.
  - A non-owner, group or channel message on Telegram is dropped with no reply, download or log of content.
  - The owner's Telegram turn recalls a memory saved on Discord (same Actor).
  - A reminder created on Telegram is delivered on Telegram.
  - An approval granted on one platform cannot be executed from another conversation. The #135 cross-session
    guidance applies across platforms.
  - Attachment bounds and the credential guard behave as on Discord on one shared fixture set.
  - The startup identity mismatch fails closed.
- **Live QA.** Owner-confirmed new external target (Strict): one bot, one private chat. Covers chat, a memory round
  trip across platforms, a reminder, a to-do, a Jira comment approval, an attachment and an image, an oversize file, a
  non-owner account (dropped), a restart (polling resumes with no duplicate turn), and a reaction.

### PRV — More providers: OpenAI API and Gemini adapters (P1 for PRV-1/2, P2 for PRV-3)

OpenClaw-style switching already exists: the selector, the operations-UI default and the per-session `/model`
(#141/#142). The `ProviderSelectionPolicy` port, the provider catalog (`apps/quoky/src/provider-selection/`) and the
provider-free `parseModelSelectionCommand` grammar take new providers as opaque data. The work is adapters, catalog
entries and containment, not routing.

- **Goal.** The owner can pick an OpenAI API model or a Gemini model for the chat tier and for image understanding,
  next to Claude, Codex and Ollama, under the same rules. Code, review, planning, tests and policy-sensitive chat stay
  on Claude.
- **Scope.**
  - **PRV-1, constitution amendment and the OpenAI API adapter.**
    - ARCHITECTURE.md §5.5 ("v1 is CLI-only; no AI HTTP API"), the `ROADMAP.md` non-goal and the AGENTS.md line
      ("v1에 AI HTTP API를 추가하지 않는다") forbade HTTP providers. The owner ratified the constitution amendment on
      2026-10-08 (decision 8, ADR-0115 D1), and the three texts are amended.
    - A new `packages/ai-openai-api` (one provider concern per package; `node:fetch`, no SDK unless the
      ADR allows one). It implements the unchanged `AiProvider`, advertises the chat tier (`GENERAL_CHAT`,
      `SUMMARIZATION`, `DOCUMENT_ANALYSIS`, `READONLY_LOOKUP`) and optionally `IMAGE_UNDERSTANDING`, and declares
      `REMOTE`.
    - It sends no tool definitions, so the request has no tool surface at all. That is stronger containment than the
      Codex CLI (residual R7).
    - The API key lives in `.env.local` (secret access is Strict), is never logged and is sent only to the configured
      host.
    - Readiness is a bounded models-list call with no generation. Typed failure mapping as in the ADR-0092 amendment
      D5 (timeout, unavailable, rate limit, empty output).
  - **PRV-2, Gemini.** Through the Gemini API (decisions 8 and 9, ADR-0115 D4): `packages/ai-gemini-api`, following
    the PRV-1 pattern. The Gemini CLI route is not taken.
    - Chat tier first, image understanding second. The canonical image bytes of #143 only.
  - **Shared for PRV-1/2.**
    - Catalog entries and selection labels (for example `openai:<model>`, `gemini:<model>`), with a bounded model
      allow-list per provider, as for Claude aliases.
    - `모델 목록` and the `/providers` options.
    - The image locality policy opens `REMOTE` for the new image options exactly as for `claude`/`codex`: only while
      the option is the effective image choice.
    - Startup error codes for malformed keys or models.
  - **PRV-3, usage ledger (P2).** Per-call token counts reported by the HTTP adapters (and by the CLIs where their
    output exposes them) are recorded for audit on `TaskRun` (ARCHITECTURE.md §4: `Usage` is `[RESERVE]`). The
    operations UI shows monthly totals per selection label, and an optional monthly threshold sends an owner-DM notice
    (decision 10). There is no automatic provider switch. If storing usage needs a column, migration v16 is decided in
    the ADR.
- **ADR.**
  - **ADR-0115, AI HTTP providers.** It amends the constitution (ARCHITECTURE.md §5.5 and the matching AGENTS.md and
    `ROADMAP.md` lines), scoped to the chat tier and image understanding. It also covers the adapter packages, key
    handling, endpoint pinning, failure taxonomy and readiness, and amends ADR-0092/ADR-0111 for registration and
    image locality.
  - The Gemini CLI alternative (a narrower ADR-0092 amendment) is not needed: decision 8 is yes.
  - PRV-3 is ADR-0115 D8, with its own amendment if a migration is needed.
- **Risks.**
  - Per-token billing replaces subscription plans. PRV-3 shows the cost, and a threshold notice warns the owner.
  - Key leakage: `.env.local` at 0600; the key is never in argv, logs or audit; an endpoint allow-list.
  - Content egress to two more vendors: only on explicit selection; the selection-time Claude fallback is unchanged;
    `LOCAL_ONLY` data stays local unless LRN-5 changes the rule for owner-selected providers.
  - Weakening the CLI-only principle by accident: the amendment is limited to two capability tiers and lists the
    capabilities that stay on Claude.
- **Estimate.** ADR-0115 M (docs). PRV-1 M. PRV-2 M. PRV-3 M.
- **Dependencies.** ADR-0115 (ratified) before PRV-1. PRV-1 before PRV-2 (shared patterns). PRV-3 after
  PRV-1.
- **AC.**
  - Selecting a new provider changes only the chat tier (and images, if selected). The code, review and
    policy-sensitive capabilities keep their eligible sets byte-identical, extending the ADR-0092 amendment D4 test.
  - No tool definitions are sent. The key never appears in logs, audit or errors.
  - A not-ready provider falls back to Claude at selection time.
  - The image locality fence holds: no image bytes go to a provider that is not the effective image choice.
  - The routing corpus is unchanged with nothing selected.
- **Live QA.** Owner-confirmed new external targets (Strict, one per vendor): a short chat set, a summary, one image,
  a session `/model` switch and reset, an operations-UI default change, and an invalid-key startup.

### LRN — Learning egress realignment (P0, decision 11 yes; LRN-4 closed)

- **Goal.** Make the owner-curated loop take effect on the provider that actually answers.
- **Scope.**
  - **LRN-5.** An ADR-0107 amendment adds an egress class for curated examples: examples may reach a `REMOTE`
    chat-tier provider **only when the owner has explicitly selected it** (session override, operations-UI default or
    env selector). The derived default and the selection-time Claude fallback do not count as an owner selection.
  - A separate flag gates it, `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED`, default `false`.
  - The credential guard runs at capture and at use, as today.
  - The rule stays data-driven: it reads the provider's declared locality and the selection source, never a provider
    id.
  - **LRN-4 (local fine-tuning): closed for v4.** It would train a local model that no longer serves chat.
- **ADR.** ADR-0116, which amends ADR-0107 D5/D6 and, before LRN-5 merges, ARCHITECTURE.md §5.14 for the
  owner-selected `REMOTE` case.
- **Risks.** Personal text leaving the host: explicit selection only, the flag off by default, per-item consent
  unchanged, forget cascade unchanged.
- **Estimate.** S-M.
- **Dependencies.** ADR-0116 (ratified). No other track.
- **AC.**
  - With the flag off, prompts are byte-identical to today.
  - With the flag on and Claude selected explicitly, at most 2 examples are injected.
  - With Claude reached only as the fallback, none are injected.
  - A forgotten example is never injected.
- **Live QA.** A 👍 → `예시로 저장` round trip on the owner's Claude chat, then the same question in a new session.

### BRF — Morning brief and calendar-aware reminders (P1 for BRF-1, P2 for BRF-2)

What exists today:

- Recurring reminders (daily, weekly, weekdays; ADR-0101).
- A local-only `BRIEF` reminder kind (`매일 오전 8시에 브리핑 알려줘`): today's pending reminders plus ACTIVE to-dos,
  DM-only.

ADR-0101 D7 states that "an LLM- or connector-backed brief needs a new ADR". The brief has no calendar today.

- **Goal.** One morning DM with what the owner needs for the day. Optional reminders before meetings.
- **Scope.**
  - **BRF-1.** The `BRIEF` composer gains a "today's schedule" section read through the existing `CalendarReader`
    port. It is deterministic, has no model, keeps the source-unavailable note ("could not read" is never shown as
    empty) and stays DM-only.
  - Optional second section (decision 21, opt-in, off by default: `QUOKY_BRIEF_JIRA_ENABLED`): Jira items assigned to
    the owner that are due or updated today, through the existing named query of ADR-0100. Read-only, with bounded
    counts.
  - **BRF-2.** `회의 10분 전에 알려줘` creates a reminder relative to a specific calendar event. Its due time comes from
    the event's start, and it is re-checked at fire time: a moved event moves the reminder, a deleted event cancels it
    with a note. Opt-in per command; nothing is created automatically for every event (decision 22).
- **ADR.** ADR-0117: an ADR-0101 D7 amendment (a connector-backed brief) and an ADR-0101/ADR-0110 amendment for
  event-relative reminders. No migration is expected, because the event id is stored as the reminder's bounded
  reference. If a column is needed, v16 is shared with PRV-3 under the migration lane rules.
- **Risks.**
  - Calendar or Jira unavailable at 08:00: the existing "could not read" note.
  - Event text in a DM: titles only, credential-guarded.
  - A moved event: the fire-time re-check.
- **Estimate.** BRF-1 S-M. BRF-2 M.
- **Dependencies.** None for BRF-1. BRF-2 after BRF-1.
- **AC.**
  - A fixture day with events, an all-day event and an unreadable calendar renders correctly in `QUOKY_TIMEZONE`.
  - Event-relative reminders follow a moved event and cancel on a deleted one.
  - No provider call is made.
- **Live QA.** One brief on the owner's service the next morning; one pre-meeting reminder on a test event.

### CON — Google read connectors: Gmail and Drive (P1 for GML-1, P2 for DRV-1)

The owner already uses Google Workspace for the company calendar. The Google Cloud project `quoky-personal-510806` has
an Internal OAuth consent screen and a Desktop client (QA record GCP/CA). New read scopes reuse that client and the
consent helper.

- **Goal.** The owner can ask about their own mail and Drive documents, read-only.
- **Scope.**
  - **GML-1.** A `packages/connector-gmail` behind a narrow read port (`MailReader`: search and get with bounded
    fields), or a `ConnectorProvider` resource kind if ADR-0072/0100 fits without a contract change.
    - Scope `gmail.readonly`.
    - A pre-classify handler answers `안 읽은 메일`, `오늘 온 메일`, `<보낸 사람> 메일 찾아줘` deterministically: sender,
      subject, date and a credential-guarded snippet.
    - `이 메일 요약해줘` sends the body to the effective chat-tier provider only when asked (decision 19), as untrusted
      readout under the attachment rules.
    - No send, draft, label or delete.
  - **DRV-1.** A `packages/connector-gdrive`, scope `drive.readonly`. Search by name and recent files. Text export of
    Google Docs/Sheets within the ADR-0111 text bound, used as an untrusted Resource for summaries. No write and no
    sharing change.
  - **Notion.** Not planned. Decision 20 is undecided ("Notion 은 사용할 수도 있고 사용하지 않을 수 도 있어"): Notion
    stays an unscheduled P3 candidate, revisited on the owner's request.
- **ADR.** ADR-0118: mail and Drive read ports, scopes, the egress of mail and document text, bounds, and the
  injection rules (mail is the most hostile inbound text). It amends ADR-0100 and relates to ADR-0110/0111.
- **Risks.**
  - Prompt injection in mail bodies: untrusted readout framing, no tool surface, no write path from a mail turn,
    summaries only on explicit request.
  - Sensitive mail content in Discord or Telegram channels: deterministic listings are DM-only by default, as the
    `BRIEF` is.
  - Restricted Google scopes: Internal consent avoids app verification. The owner confirms the Workspace admin allows
    it.
  - Token handling: the calendar token-file pattern (mode 600), one token per grant set.
- **Estimate.** GML-1 L. DRV-1 M-L.
- **Dependencies.** ADR-0118 (ratified). The owner's consent with the new scope (Strict).
- **AC.**
  - Fixture adapters answer the listed phrasings deterministically.
  - A mail with an injection payload produces no action and no altered routing.
  - Listings in a channel are refused or redirected to DM per the ADR.
  - No body text leaves the host without an explicit summary request.
- **Live QA.** Owner-confirmed new external target (Strict): one read probe, then about 15 phrasings, including an
  empty inbox, a long thread, a non-Korean mail and an injection test mail the owner sends to themselves.

### QUAL — Leftover quality items (P0 for DET-2, P1 for TBL-1, P2 for UNC-1, P3 for S2A-1)

- **DET-2, deterministic coverage completion (P0).**
  - Finish ADR-0104 D3: handler-owned status phrases for to-dos and reminders (`할 일 추가됐어?`, `알림 설정했어?`)
    answered by the `work-chat.todo` and reminders handlers, with zero provider calls.
  - Run the remaining ~40-phrasing sweep per feature state (negation, wrong state, typos, mixed language, repeats,
    restarts), prioritising the newest surfaces: connector-write execution phrases after #147, calendar after #148,
    `/model`, and attachments.
  - Every miss becomes a `mustPass` case in `action-shaped-fallthrough` or `turn-handler-routing`.
  - No ADR (ADR-0104 D3 already decides it).
  - Estimate M. AC: the D3 phrases replay with zero provider calls; the ratchets rise; no regression on the how-to and
    concept corpora (#137).
- **TBL-1, Discord table rendering limits (P1).**
  - Today a flagged model reply's tables are converted only when the reply has no fenced block and no `>` quote line
    anywhere; otherwise the whole reply stays raw (ADR-0111 amendment of 2026-10-08).
  - Scope:
    - convert tables segment by segment outside fenced regions;
    - bound wide or long tables (for example more than 6 columns or more than 25 rows stay as a fenced block);
    - handle escaped pipes;
    - keep converted output within the delivery chunker's limits.
  - Telegram gets the same neutral rule through PLT-0.
  - ADR: a short ADR-0111 amendment, because the conversion rule changes.
  - Estimate S-M. AC: unflagged text stays byte-identical; a reply with a code block and a table converts only the
    table; a 40-row table stays a fenced block.
- **UNC-1, mid-send network failure live test (P2, Strict, owner decision 18: run it).**
  - Prove the `UNCERTAIN` path end to end once: the receipt is `UNCERTAIN`, there is no retry, the next phrase gets
    the uncertain warning (#147 wording), and the operations UI shows it.
  - Runs in a scratch Docker (OrbStack) runtime on a DB copy against the Slack test channel, never on the service
    (owner, 2026-10-08). The fault method is agreed before the session (for example a packet-filter rule raised after
    the request is written). The container is a test harness only; ADR-0105 D5 (no Docker for the model runtime) is
    unchanged.
  - If no deterministic method exists, the owner may accept the offline coverage as the residual.
  - Estimate S (plus one attended session).
- **S2A-1, Stage 2A provider-path re-validation (P3, Strict, owner decision 16: park).**
  - Parked with SUB-3 ("응 일단 이건 보류하자"; ADR-0103 note of 2026-10-08). The bindings gate only the disabled Stage 2B routed seam (section 1.2).
  - Re-entry: SUB-3 is resumed, or any Stage 2B seam is enabled.

### CODE — Multi-repository and merge (CODE-8 in progress; P2 for CODE-9)

- **CODE-8** (ADR-0109) is being implemented on another branch and is not owned here. v4 waves keep its files free
  (`push-target-resolution.ts`, `personal-hosting-guard.ts`, `config.ts`) until it merges.
  - Live QA after merge: a second allowlisted sandbox repository, and the App installation switched to "Only select
    repositories" (ADR-0109 D4, Strict). The owner approved the switch on 2026-10-08; the orchestrator makes it through
    the browser, for the repositories currently used for testing (ADR-0109 amendment of 2026-10-08).
  - The additive optional `approvedRepository` parameter that CODE-8 adds to the `GitProvider` port (review item C-2)
    is ratified as the ADR-0109 amendment of 2026-10-08.
- **CODE-9 merge enablement (P2, owner decision 17).**
  - No code is expected. It is a sandbox UAT of operator guide Scenarios B/C with `QUOKY_GIT_MERGE_ENABLED=true`, run
    on a scratch runtime after CODE-8 merges.
  - The release default stays `false`. Turning it on for the owner's service is a separate owner choice.
  - Estimate S (plus one attended session).
- **ADR-0108 D4 (model-proposed PR title/body): P3, parked.** The deterministic title and body passed live (P15-P17),
  and the model path adds egress and a guard surface for little gain.

### Closed or parked (P3)

| Item | Decision | Owner answer (2026-10-08) | Re-entry condition |
|---|---|---|---|
| SUB-3 continuation activation (ADR-0103, Ratified) | 15 | Parked (ADR-0103 note) | A concrete background-job use case the brief/reminder path cannot serve, **and** a ratified decision on the routed seam's provider set (a cloud candidate widens the Stage 2B scope that ARCHITECTURE.md §5.9 limits to the Ollama candidates) |
| S2A-1 Stage 2A re-validation | 16 | Parked with SUB-3 (ADR-0103 note) | Same as SUB-3 |
| LLM-3 MLX provider (ADR-0105 D2-D4, Ratified) | 13 | Closed for v4 (ADR-0105 note) | Owner switches chat back to a local model **and** a benchmark shows ≥1.5× tokens/s at equal harness score |
| LRN-4 local fine-tuning | 12 | Closed for v4 (ADR-0107 note) | Same as LLM-3, plus ≥300 approved examples |
| Local chat quality work (granite, runaway generation, appended translations) | 14 | New work stopped; Ollama kept for embeddings and as an optional choice | Owner selects a local chat model again |
| Mobile or remote operations UI | 23 | Not in v4 (ADR-0113 note): ADR-0113 D11 keeps remote access out of the Personal edition. Discord mobile and Telegram are the mobile surfaces. The page already sets a responsive viewport | Team/Hosted edition, or an ADR-0113 D11 amendment |
| ADR-0108 D4 model-proposed PR text | 24 | Parked, left unwired (ADR-0108 note) | Owner asks for it |

## 4. Waves

Owned files are exclusive within a wave. `core/` = `packages/core/src/`, `app/` = `apps/quoky/src/`. Waves after W0
assume the owner has answered section 7. A "no" answer drops the dependent task without blocking the rest.

| Wave | Task | Track | Owned files (summary) | Deps |
|---|---|---|---|---|
| 0 | DOC-D | CARRY | `CURRENT_STATE.md`, `docs/uat/personal-v3-qa-record.md` (session 3), `ROADMAP.md` | — |
| 0 | LIVE-1 | CARRY | No code. Strict attended sessions C1, C2, C3, C5, C7, C9; fixes as follow-up PRs in the owning package | DOC-D |
| 0 | CODE-8 | CODE | (other branch) `push-target-resolution.ts`, `personal-hosting-guard.ts`, `config.ts` | ADR-0109 |
| 1 | GOV-5 | GOV | `DECISIONS.md` (ADR-0114..0118, the ADR-0109 amendment and the closure notes appended as Ratified), `ARCHITECTURE.md` §5.5, `AGENTS.md` (constitution amendment, decision 8), `ROADMAP.md`, this plan | Owner answers (2026-10-08) |
| 1 | PLT-0 | PLT | `core/application/work-chat/external-work-readout.ts`, `work-chat-renderer.ts`, `calendar/calendar-reply-renderer.ts`, `connector-writes/connector-write-copy.ts`, `core/domain/messaging.ts` (span type), `adapter-discord/src/index.ts`, `adapter-discord/src/delivery.ts` (+tests, golden before/after fixtures) | — |
| 1 | DET-2 | QUAL | `core/application/reminders/reminder-turn-handler.ts`, the `work-chat.todo` handler (`core/application/work-chat/*`), `core/application/chat-policy/*`, golden corpora, `baseline.v1.json` | — |
| 1 | TBL-1 | QUAL | `adapter-discord/src/markdown-tables.ts` (+test) only (no `index.ts` hunk; PLT-0 owns it in W1) | ADR-0111 amendment |
| 2 | TG-1 | PLT | new `packages/adapter-telegram/*`, `core/ports/platform-adapter.port.ts` (only if the ADR needs an additive field), `app/app.module.ts` (composition), `app/config.ts`, `.env.example`, `app/main.ts` (identity check) | PLT-0, ADR-0114, CODE-8 merged (`config.ts`) |
| 2 | PRV-1 | PRV | new `packages/ai-openai-api/*`, `app/provider-selection/provider-catalog.ts`, `selection-choices.ts`, `app/chat-provider-composition.ts`, `app/image-understanding-provider.ts` | ADR-0115 (decision 8) |
| 2 | BRF-1 | BRF | `core/application/reminders/daily-brief.ts` (+test), `reminder-dispatch-service.ts` (brief input), `app/reminders/*` (calendar reader injection) | ADR-0117 |
| 2 | LRN-5 | LRN | `core/application/prompt-composer.ts` (+test), the example-egress policy in `core/application/feedback/*`, `app/context-builder-provider.ts` | ADR-0116 (decision 11) |
| 3 | TG-2 | PLT | `packages/adapter-telegram/src/attachments.ts`, `reactions.ts` (+tests) | TG-1 |
| 3 | PRV-2 | PRV | new `packages/ai-gemini-api/*` (or `packages/ai-cli/src/gemini-cli-provider.ts`; no `ai-cli/src/index.ts` hunk until W4), catalog entries | PRV-1 or the Gemini CLI amendment |
| 3 | GML-1 | CON | new `packages/connector-gmail/*`, mail port in `core/ports`, mail turn handler, `app/features/mail.providers.ts`, `turn-handlers.providers.ts`, `app.module.ts`, `config.ts`, `.env.example` | ADR-0118 (decision 19) |
| 3 | UNC-1 | QUAL | No code. Strict session on a scratch runtime | Decision 18 |
| 3 | CODE-9 | CODE | No code. Strict sandbox merge UAT | CODE-8 merged, decision 17 |
| 4 | TG-3 | PLT | `adapter-telegram/src/notification.ts`, the composite `NotificationSink` wiring in `app/`, `app/ops-ui/*` (Telegram panel), `ops/launchd/*` docs, quickstart Telegram section | TG-2 |
| 4 | BRF-2 | BRF | `core/application/reminders/*` (event-relative schedule), calendar handler hook, `chat-policy/*` | BRF-1, ADR-0117 |
| 4 | DRV-1 | CON | new `packages/connector-gdrive/*`, Drive handler, `app/features/drive.providers.ts`, `turn-handlers.providers.ts`, `app.module.ts`, `config.ts` | GML-1 (shared OAuth helper), ADR-0118 |
| 4 | PRV-3 | PRV | `core/domain/task.ts` (usage), `core/ports/ai-provider.port.ts` (additive usage on the result), HTTP adapters, `app/ops-ui/*` usage panel, `migrations.ts` only if v16 is ratified | PRV-1 |
| 4 | INT-3 | INT | `app/personal-v4-acceptance.test.ts`, golden additions, `baseline` | all merged tracks |
| 4 | DOC-E | DOC | `CURRENT_STATE.md`, `CHANGELOG.md`, `DECISIONS.md` (implementation records), `ROADMAP.md`, quickstart, operator guide | all merged tracks |

Parallel and sequential work: inside a wave, tasks run in parallel in separate worktrees. A track's later task waits
for its earlier one. P2 tasks (BRF-2, DRV-1, PRV-3, UNC-1, CODE-9) may be dropped without blocking INT-3.

### Lanes

**Migration lane** (ADR-0096 D10 rules: additive, idempotent, numbers fixed, no renumbering after a merge). v4 plans
**no migration**. If PRV-3 or BRF-2 needs a column, **v16** goes to whichever ADR is ratified first. The other task
rebases onto it or uses v17. Applying a migration on the always-on host's DB is Strict.

**Hot-file lane** (one editor per wave):

| File | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| `conversation-runtime.ts` (7,737 lines) | DET-2 (only if a handler cannot absorb it) | — | — | — |
| `response-composer.ts` (3,000 lines) | PLT-0 (only if escaping lives there) | — | — | — |
| `app.module.ts` | — | TG-1 | GML-1 | DRV-1 |
| `config.ts`, `.env.example` | (CODE-8, other branch) | TG-1 | GML-1 | DRV-1 |
| `main.ts` | — | TG-1 | — | TG-3 |
| `turn-handlers.providers.ts` | DET-2 | — | GML-1 | BRF-2, then DRV-1 (rebased) |
| `prompt-composer.ts` | — | LRN-5 | — | — |
| `adapter-discord/src/index.ts`, `delivery.ts` | PLT-0 | — | — | — |
| `platform-adapter.port.ts`, `core/domain/messaging.ts` | PLT-0 | TG-1 | — | — |
| `ai-cli/src/index.ts` | — | — | — | PRV-2 export (if CLI) |
| `provider-selection/*`, `chat-provider-composition.ts` | — | PRV-1 | PRV-2 | PRV-3 |
| `reminders/*` (core) | DET-2 | BRF-1 | — | BRF-2 |
| `app/ops-ui/*` | — | — | — | TG-3, then PRV-3 (rebased) |
| `DECISIONS.md` | GOV-5 | — | — | DOC-E |

**Deps baseline.** 35 at the base. No v4 task is expected to add a `ConversationRuntimeDeps` key. Platform adapters,
providers and connectors are composed outside the runtime deps, and turn handlers register through ADR-0096. A task
that needs a key must say so in its ADR before it merges.

## 5. Governance and validation

This mirrors v3.

- **ADR gate.** A track's first code merge waits for the owner to ratify its ADR (Proposed → Ratified). GOV-5 appended
  ADR-0114..0118 after the owner answered section 7, and the owner ratified them on 2026-10-08. A stalled ADR stalls only its own
  track. PLT-0, DET-2 and the docs tasks need no new ADR. TBL-1 needs a short ADR-0111 amendment.
- **Constitution.** ADR-0115 changes ARCHITECTURE.md §5.5 (and the matching AGENTS.md and ROADMAP lines). The owner
  approved the amended text on 2026-10-08 (decision 8), as the §2 principle 1 change of 2026-10-07 was approved, and
  GOV-5 applied it. HTTP provider code stays limited to the chat and image tiers. A request that conflicts with ARCHITECTURE.md stops and is reported (CLAUDE.md).
- **Per wave:**
  1. Implementation in separate worktrees.
  2. Offline validation: `pnpm typecheck` plus focused tests. A task on a hot file runs the full `pnpm test`. INT-3
     adds `pnpm build`. Docs-only tasks run `git diff --check` and check that `grep '^## ADR-' DECISIONS.md` gives
     unique numbers.
  3. An independent review (reviewer ≠ implementer). The independent Chief Architect review is mandatory before
     PLT-0, TG-1, PRV-1, LRN-5, GML-1 and PRV-3 merge: each changes a boundary, an egress rule or the constitution.
  4. A sparse Codex review: once per wave on the integration head, plus a delta review after fixes.
  5. Push, PR and merge, **only under a standing exact-scope approval for v4 waves** (decision 1). The v3 approval is
     not inherited automatically.
- **Fix loops.** At most two fix loops per finding inside the approved scope. After that the orchestrator decides:
  narrow the scope, defer to a follow-up, or stop and report.
- **Live QA.** Owner-attended QA via ego-browser after each wave that changes user-visible behaviour, recorded in a
  new `docs/uat/personal-v4-qa-record.md`. It covers edge cases (negation, wrong state, typos, mixed language,
  repeats, restarts) and, from TG-1 on, the same sweep on Telegram.
- **Strict, per target.** Each of these needs explicit owner confirmation for that target:
  - the Telegram bot (creation and live use);
  - each new AI vendor and its API key;
  - the Gmail and Drive scopes and consent;
  - the merge flag;
  - the network-failure test;
  - `.env.local` edits;
  - any migration on the service DB;
  - the GitHub App installation change (CODE-8);
  - the real host reboot.
- **Honesty.** No document claims a live result before the session that produced it has run. DOC-E keeps Pending
  items Pending.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A second messaging platform doubles the inbound attack surface | Exact numeric owner ids, private chats only, drop by default, nothing fetched before admission, startup identity check, one shared fixture suite for both adapters |
| PLT-0 regresses Discord output across many renderers | Golden before/after fixtures, byte-identical assertion, full `pnpm test`, Chief Architect review |
| The CLI-only principle erodes beyond the chat tier | ADR-0115 is limited to the chat tier and image understanding, lists the Claude-only capabilities, and the ADR-0092 amendment D4 test is extended to every new provider |
| Per-token billing surprises | PRV-3 usage ledger, monthly totals on the operations UI, threshold DM notice; HTTP providers off unless selected |
| Personal text reaches more cloud vendors | Only on explicit owner selection; `LOCAL_ONLY` data stays local unless LRN-5 is ratified; credential guards in Core before egress for every provider |
| Mail bodies carry prompt injection | Untrusted readout framing, no tool surface, no write path from mail turns, summaries only on request, DM-only listings |
| CODE-8 and v4 W2 both need `config.ts` | TG-1 starts its `config.ts` hunk only after CODE-8 merges; until then it works in its own config module |
| Attended time limits live QA | LIVE-1 first, ordered by impact; P2 sessions droppable |
| Stale docs mislead later agents | DOC-D in W0, DOC-E at the end, the honesty rule |

## 7. Owner decisions (answered 2026-10-08)

The Product Owner answered in chat on 2026-10-08: "v4 권장안대로 진행하고". Every question takes its recommended default,
except where the last column says otherwise. The answers are recorded in the ADR-0114..0118 ratification record in
`DECISIONS.md`.

| # | Question | Recommended default | Reason | Owner answer (2026-10-08) |
|---|---|---|---|---|
| 1 | Renew the standing approval for v4 waves: automatic Push/PR/Merge after offline validation, independent review and Codex review pass, with Live UAT of new external targets still confirmed per target? | **Renew**, on the same terms as v3 | It worked across v3 and the post-v3 PRs (#116-#148), and the per-target Strict gates stay | **Renewed**, on the v3 terms (recommended default) |
| 2 | Is Telegram the headline track of v4, starting with the PLT-0 prerequisite in wave 1? | **Yes**, P1 after PLT-0 (P0) | It is the one extension already decided (2026-10-06). PLT-0 also removes Discord markup from Core, which the constitution already requires | **Yes** (recommended default; ADR-0114) |
| 3 | Telegram scope in v4: private chat with the owner only, no groups or channels? | **Private chat only** | Matches the owner-DM model. Group admission needs member and admin rules that the Personal edition does not have | **Private chat only** (ADR-0114 D2) |
| 4 | Should the Telegram owner be the **same** owner `Actor` as on Discord (shared memory, reminders, to-dos, learning items)? | **Same Actor**, mapped explicitly in configuration | One person. Actor-scoped recall (ADR-0073 amendment) then works across platforms, and the Team edition seam (ADR-0009) stays intact | **Same Actor**, mapped in configuration (ADR-0114 D3) |
| 5 | Telegram transport: long polling (`getUpdates`) rather than a webhook? | **Long polling** | Polling needs no inbound listener or public endpoint, consistent with ADR-0113 D11 (no remote access) and the loopback-only design | **Long polling**, no inbound port (ADR-0114 D4) |
| 6 | Notification routing with two platforms: reminders on the platform where they were created; `OPS_NOTICE` and `OPS_DECISION_RESULT` on a primary platform. Which platform is primary? | **Discord is primary**; reminders go where created; `BRIEF` stays DM-only on the platform where it was created | Keeps the existing, live-verified operations path unchanged, and lets Telegram add without moving it | **Discord primary**; reminders return to the origin platform; `BRIEF` DM-only (ADR-0114 D11) |
| 7 | Telegram approvals: the existing text phrases only in v4, with inline buttons later? | **Text phrases only** | One approval grammar on both platforms. Buttons add a second decision surface that needs its own review | **Text phrases only** (ADR-0114 D10) |
| 8 | Amend the constitution (ARCHITECTURE.md §5.5 "CLI-only; no AI HTTP API", plus the AGENTS.md and ROADMAP lines) so that HTTP API providers may serve the **chat tier and image understanding only**? | **Yes, narrowly**: chat tier and images only, each provider off unless selected; code, review, planning, tests and policy-sensitive chat stay on the Claude CLI | Needed for the "beyond the CLIs" goal. An HTTP call with no tool definitions is better contained than an agent CLI (Codex residual R7) and avoids the ~8k-token Codex agent prompt per turn. Narrow scoping keeps the code chain on the tested path | **Yes, narrowly** (ADR-0115 D1; ARCHITECTURE.md §5.5 and AGENTS.md amended) |
| 9 | Gemini transport: the Gemini API (if 8 is yes) or the Gemini CLI? | **API if decision 8 is yes; otherwise the CLI**, after a containment spike | One pattern for both new vendors. The CLI route needs a Codex-style containment proof that may not reach the same bar | **Gemini API** (ADR-0115 D4) |
| 10 | Order of new vendors and cost guard: OpenAI API first, then Gemini; record token usage and send a DM notice at a monthly threshold? | **OpenAI API first; usage ledger with a threshold notice, no automatic switch** | The owner already uses OpenAI through Codex and can compare directly. Per-token billing is new, so it needs visibility, but an automatic switch would override the owner's selection | **OpenAI API first, then Gemini; usage ledger with a monthly DM notice, no automatic switch** (ADR-0115 D4/D8) |
| 11 | Allow owner-curated learning examples to reach a **cloud** chat provider when the owner has explicitly selected it (new flag, default off)? | **Yes, behind `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED=false`**; explicit selection only, never on the fallback | Today the examples are `LOCAL_ONLY`, so the curated loop does nothing on the owner's Claude chat, while memory and transcripts already go to the cloud by the 2026-10-07 decision | **Yes**, behind `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED=false` (ADR-0116) |
| 12 | Close LRN-4 (local fine-tuning) for v4? | **Close**; re-open only if chat moves back to a local model | It would train a model that no longer answers the owner's chat | **Closed** (ADR-0107 note) |
| 13 | Close LLM-3 (MLX provider) for v4? | **Close**; ADR-0105 D2-D4 stay ratified but dormant | Ollama now serves only embeddings, and an MLX speed-up has no user-visible effect on the cloud chat path | **Closed** (ADR-0105 note) |
| 14 | Stop new local-chat quality work (granite invented facts, runaway generation, appended translations) and keep Ollama for embeddings and as an optional choice? | **Yes** | The owner's chat runs on Claude. Effort goes to features. Ollama stays useful for recall and offline fallback | **Yes** (recommended default) |
| 15 | SUB-3 continuation activation (ADR-0103, Ratified, P2): park it? | **Park (P3)** until there is a concrete background-job need and a decision on the routed seam's provider set | The receiver runs on the Stage 2B seam, which binds only llama3.1/granite. Adding a cloud candidate widens the Stage 2B scope that ARCHITECTURE.md §5.9 limits to the Ollama candidates, which needs its own ADR. The morning brief and reminders cover "report back later" | **Parked (P3)** (ADR-0103 note) |
| 16 | Stage 2A provider-path re-validation (Strict): run it now or park it with SUB-3? | **Park with SUB-3** | It guards only the disabled routed seam. Running it now costs a Strict session for no user-visible effect | **Parked with SUB-3**: "응 일단 이건 보류하자" (ADR-0103 note) |
| 17 | CODE-9 merge enablement: run the sandbox merge UAT (Scenarios B/C) after CODE-8 merges, keeping the release default `QUOKY_GIT_MERGE_ENABLED=false`? Do you want merge from chat on your own service? | **Run the sandbox UAT once; keep the default `false`; enable on the service only if you want merge from chat** | The merge path has never run live. One sandbox run turns "untested" into "known" without changing the default | **Sandbox UAT once after CODE-8 merges; default stays `false`** (recommended default) |
| 18 | Network-failure (`UNCERTAIN`) live test: run it once in a scratch runtime against the Slack test channel, or accept the offline coverage? | **Run once if a deterministic fault method is agreed before the session; otherwise accept the offline coverage as a recorded residual** | It is the last unverified branch of the write state machine. It must never run on the owner's service | **Run it**: "네트워크 장애 테스트도 진행해", in a scratch Docker (OrbStack) runtime on a DB copy, never on the service. Another agent runs UNC-1 |
| 19 | Google read connectors: add Gmail (`gmail.readonly`) and then Drive (`drive.readonly`) on the existing Internal OAuth client? May mail and document text go to the selected chat-tier provider when you ask for a summary? | **Yes, Gmail first, Drive second. Listings deterministic and DM-only; text to the chat-tier provider only on an explicit summary request**; no send, draft or delete | Mail and documents are the most frequent personal-data questions after the calendar. The Google project and consent flow already exist. Summaries on request match the 2026-10-07 cloud decision without making every listing an egress | **Yes: Gmail first, Drive second**, as recommended (ADR-0118) |
| 20 | Do you use Notion for work? | **Not planned unless yes** | No QA record or configuration shows Notion use. A connector nobody uses adds credentials and attack surface | **Undecided**: "Notion 은 사용할 수도 있고 사용하지 않을 수 도 있어". Notion stays an unscheduled P3 candidate, revisited on request |
| 21 | Morning brief: add today's calendar to the existing `BRIEF` reminder; also add Jira items assigned to you that are due or updated today? | **Calendar yes; Jira optional (on, if you use Jira daily)**; deterministic, no model, DM-only | The brief exists but omits the calendar, the most-asked personal data. A model-written brief adds latency and egress for little gain | **Calendar yes; Jira opt-in, off by default** (ADR-0117 D1/D2) |
| 22 | Pre-meeting reminders (`회의 10분 전에 알려줘`): opt-in per command only, or automatic for every event? | **Opt-in per command** | Automatic reminders for every event would be noisy, and they are a scheduler, which ADR-0101 D1 rules out | **Opt-in per command** (ADR-0117 D5) |
| 23 | Keep the operations UI local-only (no remote or mobile access) in v4? | **Yes** (ADR-0113 D11 unchanged) | Remote access needs multi-actor authentication (Team/Hosted). Discord mobile and Telegram already cover mobile use | **Yes**, local-only (ADR-0113 note) |
| 24 | Leave the model-proposed PR title/body (ADR-0108 D4) unwired? | **Yes, park** | The deterministic title and body passed live, and the model path adds egress and a guard surface | **Yes, parked** (ADR-0108 note) |
| 25 | Accepted residuals R1-R8 (section 2): keep them as documented? | **Keep all** | None of their triggers is hit by v4: Telegram runs in the same process, so R1's second-writer trigger does not apply | **Keep all** (recommended default) |

**Further owner answers (2026-10-08):**

- **Design question D4** (an owner caption is treated as a trusted request; v3 QA record session 3 B3): kept ("응 유지 해").
  Recorded as an owner-confirmed design decision in the ADR-0111 note of 2026-10-08.
- **CODE-8 GitHub App narrowing** (ADR-0109 D4): approved. The orchestrator switches the installation to "Only select
  repositories" through the browser; the repository list is the repositories currently used for testing.
- **C-2** (CODE-8 review): the additive optional `approvedRepository` parameter on the `GitProvider` port is ratified as
  the ADR-0109 amendment of 2026-10-08.

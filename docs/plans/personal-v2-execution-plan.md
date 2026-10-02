# Quoky Personal v2 — Execution Plan

- **Status:** Proposed (GOV-1). The orchestrator follows this plan; nothing here authorizes a Strict action.
- **Date:** 2026-10-02
- **Base:** `origin/main` `b3985ec` (Personal v1 + UAT hotfixes; SQLite schema v11; `ConversationRuntimeDeps` = 32).
- **Decisions:** ADR-0096 (integration seams) and the track ADRs ADR-0097..ADR-0101 in `DECISIONS.md`, all
  **Proposed**. Where this plan and an ADR disagree, the ADR wins and this plan is corrected.

## 1. Tracks and ADR gates

| ADR | Track | Scope | Gates the merge of |
|---|---|---|---|
| ADR-0096 | SEAM | Turn-handler registry, help lines, feature composition, inert config, lanes | SEAM-1, SEAM-2 (and every later task) |
| ADR-0097 | OVR | Strict credential guard + one-time CRITICAL override (QA-023) | OVR-1..OVR-4 |
| ADR-0098 | QUAL | Chat policy, feedback capture (v12), golden eval, embedding recall | QUAL-1..QUAL-5 |
| ADR-0099 | CODE | ≤5-file change sets, new-file commit, branch commands, push→PR | CODE-1..CODE-5 |
| ADR-0100 | WORK | Work grammar, to-dos, read-only connector lookups and summaries | WORK-T1..WORK-T5 |
| ADR-0101 | PRO | Reminders (v13), tick driver, owner-only sink, local brief | PRO-1..PRO-5 |

Rule: a track's first code merge waits for Product Owner ratification of its ADR (Proposed → Accepted).
Recommended ratification order: ADR-0096, ADR-0097, ADR-0099 before wave 1 merges; ADR-0098 and ADR-0100 before
wave 2; ADR-0101 before wave 3. GOV, DOC and INT tasks need no ADR gate of their own. A stalled ADR stalls only its
track; the ADR-0096 stubs stay inert.

## 2. Waves

Owned files are exclusive within a wave. Paths are abbreviated: `core/` = `packages/core/src/`, `app/` =
`apps/quoky/src/`. "Deps" lists task dependencies (design order plus integration lanes).

| Wave | Task | Track | Owned files (summary) | Deps | ADR gate |
|---|---|---|---|---|---|
| 1 | GOV-1 | GOV | `DECISIONS.md` (append ADR-0096..0101), this plan | — | none |
| 1 | SEAM-1 | SEAM | `core/ports/conversation-turn-handler.port.ts`, `tokens.ts`, `ports/index.ts`; port/domain stubs (connector-query, feedback-repository, reminder-repository, notification-sink, reminder, feedback); `domain/index.ts`; `application/index.ts` + 7 sub-barrels; `conversation-runtime.ts` (+test, new turn-handlers test); `response-composer.ts` (+test); `app/features/*` (6 files); `app.module.ts` | — | 0096 |
| 1 | SEAM-2 | SEAM | `app/config.ts` (+test), `.env.example`, `app/reminders/reminder-config.ts` (+test) | — | 0096 |
| 1 | OVR-1 | OVR | `core/application/credential-guard.ts` (+test) | — | 0097 |
| 1 | CODE-1 | CODE | `workspace-writer.port.ts`, `domain/enums.ts`, `domain/workspace-change.ts`, `workspace-write-manager.ts` (+test), `packages/workspace-local/src/index.ts` (+2 tests) | — | 0099 |
| 2 | OVR-2 | OVR | `core/application/code-generation-context.ts` (+test) | OVR-1 | 0097 |
| 2 | QUAL-1 | QUAL | `chat-policy/chat-response-policy.ts` (+test, sub-barrel), `prompt-composer.ts` (+test), `packages/ai-cli/src/output-sanitizer.ts` (+test), `ai-cli/src/index.ts` (+test), `app/tools/provider-semantic-validation.ts` (+test) | SEAM-1 | 0098 |
| 2 | QUAL-3 | QUAL | `domain/feedback.ts`, `feedback-repository.port.ts`, `feedback/` (implicit-feedback, feedback-recorder, sub-barrel), `storage-sqlite` feedback-repository (+test), `migrations.ts` (+test), `guarded-task-run-start.local-e2e.test.ts`, `storage-sqlite/src/index.ts` | SEAM-1 | 0098 |
| 2 | CODE-2 | CODE | `git-provider.port.ts`, `domain/git.ts`, `git-manager.ts` (+test), `code-work/branch-name-policy.ts` (+test, sub-barrel), `packages/git-local/src/index.ts` (+test), `app/personal-git-guard.ts` (+test), `app/github-app-git-provider.ts` (+test), `app/first-release-acceptance.test.ts` | SEAM-1 | 0099 |
| 2 | WORK-T1 | WORK | `core/ports/connector-query.ts` (+test), `connector-provider.port.ts`, `packages/connector-{jira,github,slack,confluence}/src/index.ts` (+tests) | SEAM-1 | 0100 |
| 3 | OVR-3 | OVR | `credential-override/` (credential-override, stateless-credential-override-flow, copy; +tests, sub-barrel) | OVR-2 | 0097 |
| 3 | WORK-T2 | WORK | `domain/work-item.ts` (+test), `work-manager.ts` (+test), `storage-sqlite/src/work-item-repository.test.ts` | QUAL-3 (rebase; no schema pin) | 0100 |
| 3 | PRO-1 | PRO | `domain/reminder.ts` (+test), `reminder-repository.port.ts`, `notification-sink.port.ts`, `reminders/` (zoned-time, reminder-schedule, reminder-grammar; +tests, sub-barrel) | SEAM-1 | 0101 |
| 3 | QUAL-2 | QUAL | `core/application/golden/*` (6 corpora, golden-eval +test), `app/tools/answer-quality-*` (fixtures, checkers, eval, CLI), `package.json` | QUAL-1 | 0098 |
| 3 | CODE-3 | CODE | `code-work/code-change-set.ts` (+test, sub-barrel), `conversation-runtime.ts` (+test), `response-composer.ts` (+test), `newfile-preview-realchain.integration.test.ts` | CODE-1, CODE-2, SEAM-1 | 0099 |
| 4 | OVR-4 | OVR | `conversation-runtime.ts` (+test, new credential-override test), `response-composer.ts` (+test), `app.module.ts` | OVR-1..3, CODE-3 | 0097 |
| 4 | WORK-T3 | WORK | `work-chat/` (work-chat-command, external-work-readout, renderer, service; +tests, sub-barrel) | WORK-T1, WORK-T2 | 0100 |
| 4 | PRO-2 | PRO | `storage-sqlite` reminder-repository (+test), `migrations.ts` (+test), `storage-sqlite/src/index.ts` | PRO-1, QUAL-3 (v12 first) | 0101 |
| 4 | PRO-3 | PRO | `reminders/` (reply-composer, conversation-service, dispatch-service, daily-brief; +tests, sub-barrel) | PRO-1, WORK-T2 | 0101 |
| 4 | PRO-4 | PRO | `packages/adapter-discord/src/notification.ts` (+test), `adapter-discord/src/index.ts` (small hunk; index.test.ts untouched) | PRO-1 | 0101 |
| 5 | QUAL-4 | QUAL | `platform-adapter.port.ts`, `conversation-runtime.ts` (+test), `orchestrator.ts` (+feedback test), `feedback/` (summary composer, summary turn handler; +tests), `adapter-discord/src/reactions.ts` (+test), `adapter-discord/src/index.ts` (+test), `app/features/feedback.providers.ts`, `app.module.ts`, `app/first-release-acceptance.test.ts`, `docs/uat/personal-v2-quality-uat-packet.md` | QUAL-3, PRO-4, OVR-4, SEAM-1 | 0098 |
| 5 | CODE-4 | CODE | `code-work/git-branch-command.ts` (+test, runtime integration test, sub-barrel), `response-composer.ts` (+test; protected-branch hint only) | CODE-2, CODE-3, SEAM-1 | 0099 |
| 5 | PRO-5 | PRO | `reminders/reminder-turn-handler.ts` (+test, sub-barrel), `app/features/reminders.providers.ts`, `app/reminders/reminder-tick-driver.ts` (+test), `app/reminders/reminder-acceptance.test.ts`, `app/main.ts`, `docs/uat/reminders-uat-packet.md` | PRO-1..4, SEAM-1, SEAM-2, DOC-A (ARCHITECTURE rows) | 0101 |
| 5 | DOC-A | DOC | `CURRENT_STATE.md`, `CHANGELOG.md`, `DECISIONS.md` (status of ratified ADRs only), `ARCHITECTURE.md` (§4/§10/§13 reminder rows), `ROADMAP.md`, first-release UAT result (QA-023 RESOLVED, multiline residual CLOSED), `docs/user/quickstart.md` | waves 1–4 merged | none |
| 6 | WORK-T4 | WORK | `conversation-turn-handler.port.ts` (`summarize` variant), `conversation-runtime.ts` (+work-chat test), `prompt-composer.ts` (+test), `work-chat/work-chat-turn-handler.ts` (+test, sub-barrel) | WORK-T3, QUAL-1, SEAM-1 | 0100 |
| 6 | QUAL-5 | QUAL | `ai-cli` ollama-embedding-provider (+test), `ai-cli/src/index.ts` (+test), `recall/` (embedding-envelope, semantic-recall-scorer; +tests, sub-barrel), `memory-retriever.ts` (+test), `packages/vector-local/src/index.ts` (+test), `app/context-builder-provider.ts` (+test), `app.module.ts` | QUAL-1, SEAM-2 | 0098 |
| 7 | CODE-5 | CODE | `code-work/push-target-resolution.ts` (+test, sub-barrel), `conversation-runtime.ts` (+test), `response-composer.ts` (+test), `app/personal-hosting-guard.ts` (+test), `app/personal-git-guard.ts` (+test), `app.module.ts`, `app/features/code-work.providers.ts`, `app/code-v2-remote-acceptance.test.ts`, `docs/uat/code-v2-github-chain-uat-packet.md` | CODE-2, CODE-4, SEAM-2 | 0099 |
| 7 | WORK-T5 | WORK | `app/features/work-chat.providers.ts`, `app/work-chat-acceptance.test.ts`, `docs/uat/work-chat-uat-packet.md` | WORK-T4, SEAM-2 | 0100 |
| 8 | INT-1 | INT | `app/personal-v2-acceptance.test.ts`, `golden/turn-handler-routing.v1.json` (+test), `golden/baseline.v1.json` | all tracks merged | all ratified ADRs |
| 8 | DOC-B | DOC | `CURRENT_STATE.md`, `CHANGELOG.md`, `DECISIONS.md` (implementation records), `ROADMAP.md`, `docs/user/quickstart.md`, `docs/uat/operator-guide.md` | all tracks merged | none |

Folded tasks: OVR-5 (docs) is absorbed into DOC-A. Track docs edits for CODE-5, WORK-T5 and PRO-5 move to DOC-A/DOC-B;
track-specific new UAT packets stay with their tasks.

Wave notes:

- **W1** SEAM-1 must keep behaviour byte-identical with an empty handler list (full `pnpm test` green) and moves the
  deps baseline assertion 32 → 33. SEAM-2 is inert (no consumer). OVR-1 keeps `containsCredentialMaterial`
  byte-unchanged. CODE-1 has no runtime change.
- **W2** QUAL-3 claims v12 first. QUAL-1 lands `prompt-composer.ts`/`ai-cli` early so WORK-T4 and QUAL-5 rebase on
  it. OVR-2's 5th parameter is optional. CODE-2 owns every `GitProvider` implementer and fake.
- **W3** CODE-3 is the only runtime/composer editor; it must not touch the `readCodeGenerationContextFiles` call or
  the refusal branch (OVR-4 owns them). PRO-1 grammar returns NOT_REMINDER for anchored to-do forms. WORK-T2 must not
  assert `LATEST_SCHEMA_VERSION === 11`.
- **W4** OVR-4 moves the deps baseline 33 → 34 and keeps `newFileTargets` on the grant re-run. WORK-T3 exposes
  `mode: 'mutation' | 'lookup'` and never claims time-bound `알려줘`. PRO-3 copy has no `⏰`.
- **W5** QUAL-4's `피드백 요약` is a control-stage handler; no `feedbackSummary` dep; `onFeedback` subscribed in the
  `QuokyCore` factory. CODE-4 and PRO-5 touch neither the runtime nor `app.module.ts`. PRO-5 merges after DOC-A
  writes the ARCHITECTURE reminder rows.
- **W6** WORK-T4 reconciles its untrusted-readout text with QUAL-1's rules; both prompt edits invalidate Stage 2A
  bindings. QUAL-5 removes `EMBEDDING` from `OllamaCliProvider` and updates routing assertions.
- **W7** CODE-5 registers CODE-4's branch handler; offline acceptance uses a local bare repo as `origin`.
- **W8** INT-1 asserts deps baseline 34, exactly five handlers in order, help lines present and bounded, zero
  provider calls on deterministic turns, a temp DB migrated to v13; then `pnpm test`, `pnpm typecheck`, `pnpm build`.

## 3. Lanes

**Migration lane (ADR-0096 D10).**

| Version | Task | Wave | Content |
|---|---|---|---|
| v12 | QUAL-3 | 2 | feedback capture tables: `conversation_turns`, `turn_platform_messages`, `feedback_signals` (no text columns) |
| v13 | PRO-2 | 4 | `reminders` table + `reminders_due`, `reminders_actor` indexes |

Both additive and idempotent; `migrations.test.ts` pinned to 12 then 13; the e2e literal switches to
`LATEST_SCHEMA_VERSION` in QUAL-3. Fallback: if QUAL-3 slips, PRO-2 takes v12 and QUAL-3 renumbers. OVR, CODE and
WORK add none. Applying any migration outside the delegated dev DB is Strict.

**Hot-file lane (one editor per wave, ADR-0096 D11).**

| File | W1 | W2 | W3 | W4 | W5 | W6 | W7 | W8 |
|---|---|---|---|---|---|---|---|---|
| `conversation-runtime.ts` | SEAM-1 | — | CODE-3 | OVR-4 | QUAL-4 | WORK-T4 | CODE-5 | — |
| `response-composer.ts` | SEAM-1 | — | CODE-3 | OVR-4 | CODE-4 | — | CODE-5 | — |
| `app.module.ts` | SEAM-1 | — | — | OVR-4 | QUAL-4 | QUAL-5 | CODE-5 | — |
| `adapter-discord/src/index.ts` | — | — | — | PRO-4 | QUAL-4 | — | — | — |
| `prompt-composer.ts` | — | QUAL-1 | — | — | — | WORK-T4 | — | — |
| `ai-cli/src/index.ts` | — | QUAL-1 | — | — | — | QUAL-5 | — | — |
| `storage-sqlite` `migrations.ts` / `index.ts` | — | QUAL-3 | — | PRO-2 | — | — | — | — |
| `config.ts`, `.env.example` | SEAM-2 | — | — | — | — | — | — | — |
| `main.ts` | — | — | — | — | PRO-5 | — | — | — |
| `DECISIONS.md` | GOV-1 | — | — | — | DOC-A | — | — | DOC-B |
| Root barrels, `tokens.ts`, `feature-tokens.ts` | SEAM-1 | — | — | — | — | — | — | — |

Base `HELP_TEXT` edits: CODE-3 (w3) and OVR-4 (w4) only; all other help lines are contributed by handlers.
`intent-classifier.ts`, `conversation-commands.ts` and `containsCredentialMaterial` are edited by no task.

**Deps baseline.** 32 (base) → 33 after SEAM-1 (`turnHandlers`) → 34 after OVR-4 (`credentialOverrideFlow`).
Every task asserts the baseline in force when it merges.

## 4. Strict gates per track

| Track | Strict gates (each needs exact-scope Product Owner approval) |
|---|---|
| All | ADR ratification before a track's code merges; push, PR and merge of every wave/track branch; independent Chief Architect review (reviewer ≠ implementer) before SEAM-1, CODE-3, OVR-4, QUAL-4, PRO-5, CODE-5 merge; no Production/shared DB access; dev-DB v12/v13 apply only under AUTONOMOUS_DEV_DB; every runtime start/stop follows the AGENTS.md temporary-environment rules |
| SEAM / GOV / DOC / INT | No live gates; offline only |
| OVR | Attended Live UAT on a disposable sandbox with synthetic credential-like fixtures (real file content to Claude); runtime start/stop; read-only dev-DB check of approval/anchor rows; deleting the superseded QA-023 branch/worktree (human) |
| QUAL | Attended Discord Live UAT for QUAL-1 and QUAL-4; each answer-quality harness `run` per run and per target (Ollama; Claude separately), bound to the plan digest; live embedding probe and QUAL-5 UAT with embeddings on; the owner's `ollama pull`; `.env.local` edits |
| CODE | Attended sandbox UAT U1–U10 on `quoky-uat-sandbox` via `quoky-dev` with remote on and merge off (App key access, Discord, Claude, apply/commit, first push U6 and PR U7); sandbox cleanup (human); any merge-flag enablement is out of scope |
| WORK | One read-only GET probe per connector on real tenants; switching `QUOKY_SLACK_TOKEN` to a user token; attended work-chat UAT with SUMMARIZATION on real connector content (egress decision); to-do rows only in the dev DB |
| PRO | Attended reminders UAT (channel + owner DM sends, restart catch-up, allowlist-removal fallback, flag on in `.env.local`); flipping the release default to `true` after UAT; any provider/connector/tool reminder action needs a new ADR |

Live UATs run as separate exact-scope Strict sessions after wave 8. DOC-A/DOC-B never claim live results; Live UAT
status stays Pending until those sessions run.

## 5. Owner decisions (summary)

Recorded with recommended defaults in each ADR's "Owner decisions requested": ratification order (ADR-0096);
override design, egress and OVR-1 timing (ADR-0097); feedback, language, eval and embedding policy (ADR-0098);
change-set bounds, branch commands and remote split (ADR-0099); WorkItem title, summary egress, Slack/Confluence auth
(ADR-0100); reminder semantics, limits and flag (ADR-0101). Flag defaults: `QUOKY_REMINDERS_ENABLED=false`,
`QUOKY_EMBEDDING_ENABLED=false`, `QUOKY_GIT_MERGE_ENABLED=false`, `QUOKY_WORK_SUMMARY_ENABLED=true`,
`QUOKY_TIMEZONE=Asia/Seoul`.

## 6. Risks

| Risk | Mitigation |
|---|---|
| SEAM-1 rewires `handleInner` at three points in a ~5,700-line hot file; a misplaced dispatch could pre-empt pending-approval capture or bypass ADR-0043 | Byte-identical empty-list behaviour; explicit ordering tests; architecture review |
| Six sequential runtime edits (w1–w7) cause rebase churn | Rebase on merged wave head; contiguous hunks; full `pnpm test` each time |
| Ratification bottleneck: six ADRs gate merges | Stubs stay inert; migration fallback (PRO-2 takes v12); re-verify numbers at each merge |
| Stub-and-fill barrels: dead stubs or `export *` collisions | Remove dropped stubs in INT-1/DOC-B; INT-1 typecheck |
| Grammar collisions across four handler families plus the classifier | Fixed stages/orders; negative corpora in PRO-1 and WORK-T3; INT-1 golden routing ratchet |
| Data egress grows (override files, connector text via SUMMARIZATION fallback, Claude eval runs) | Bounded, disclosed, flag-gated; explicit owner policy call |
| OVR-1 refuses more files for three waves before the override UX | Owner decision on OVR-1 timing |
| Reminders are the first non-reply outbound producer | ≤10 per 15 s tick, no provider/connector/tool deps, owner gate rechecked at delivery |
| Reaction intents add volume and a second inbound surface | Drop non-owner / non-bot-message / non-allowlisted reactions before any fetch or log |
| Live push → PR chain never completed (Gate 4B blocked) | Step-by-step Strict UAT, merge off |
| Live connector behaviour unverified (Jira `/search/jql`, Confluence auth, Slack token type) | Read-only probes; follow-ups per ADR-0100 |
| Prompt edits invalidate Stage 2A bindings; prompt growth vs Ollama `-c` (QA-019) | Re-run approved bindings; document context limits |
| Help text growth | Bounded to 12 × 120 chars; INT-1 truncation check |
| Removing `EMBEDDING` from `OllamaCliProvider` changes routing assertions | Updated in QUAL-5 |

## 7. Verification

Docs-only tasks (GOV-1, DOC-A, DOC-B) record the reason and skip product build/test; they run `git diff --check` and
check ADR number uniqueness with `grep '^## ADR-' DECISIONS.md`. Code tasks run `pnpm typecheck` plus the focused
tests named in their notes; tasks on hot files run the full `pnpm test`. INT-1 runs `pnpm test`, `pnpm typecheck`
and `pnpm build`.

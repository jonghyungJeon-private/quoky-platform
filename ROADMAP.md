# Quoky Platform — Roadmap

Lightweight, living roadmap: **direction and sequence only.** Rules live in
`ARCHITECTURE.md`, decisions in `DECISIONS.md`, present status in
`CURRENT_STATE.md`. This file does not duplicate them.

## Edition evolution

- **Personal Edition (now)** — local-first, single actor, Discord, CLI providers, SQLite.
- **Team Edition** — multi-actor; storage / queue / event transport swapped to networked implementations.
- **Hosted / SaaS Edition** — multi-tenant. Tenancy is a **v3** scope dimension layered onto Actor/Session; **not built now** and no multi-tenant abstractions are introduced early (YAGNI).

> An edition step changes **adapters / wiring / reserved seams — never Core contracts**
> (`ARCHITECTURE.md` §13). A forced Core-contract change requires an ADR first.

## Major milestones

- **M0 — Repository operating system** ✅ done (Sprint 0).
- **M1 — Walking skeleton:** one natural-language flow, end to end (Sprint 1a → 1b).
- **M2 — Memory & multi-provider:** ✅ done for the ratified scope — provider-neutral routing/Ollama,
  ContextBuilder ranking and bounded compression, durable memory, and read-only connectors. Codex remains deferred.
- **M3 — Personal Work OS foundations:** **active** — Resource identity, a read-only Work Surface, and the
  narrow CAP-011 Work Model follow the ratified M3 Architecture Rebaseline (ADR-0074/0075).

Current operational phase: **M3**. The `v1.0.0` source release is complete and closed at
`80bbc94de0493c24036197dabc2ff00dbcd20cbf`; tag creation/push is not an outstanding release task. M3 activation
does not claim Production Runtime readiness.

## Sprint roadmap

| Sprint | Goal | Notes |
|---|---|---|
| **0** ✅ | Bootstrap the repository operating system | docs + collaboration model |
| **1a** | Walking skeleton: Discord adapter + minimal Session + SQLite persistence + **echo** reply | validates I/O + persistence + boundaries; **no cognition** |
| **1b** | Intent classification + Planner + ContextBuilder + PromptComposer + capability routing + Claude CLI execution | natural language only, no slash commands; provider chosen by **router**, never hardcoded |
| **M3A-1** | `ResourceRef` + read-only Work Surface | no WorkItem persistence or migration |
| **M3A-2** | CAP-011 WorkItem repository + additive migration + persisted personal-work state | ADR-0075 |
| **M3B** ✅ | ToolProvider and bounded MCP adapter foundations | ADR-0076/0077; no autonomous execution |
| **M3C** ✅ | CAP-013 command execution receipts | ADR-0078 |
| **M3D** ✅ | Immutable AgentProfile registry and durable WorkHandoff | ADR-0079/0080; no agent runtime |
| **M3E-1/2** ✅ | Trigger provenance, decisions and idempotent handoff production | ADR-0081/0082 |
| **M3E-3** ✅ | Read-only handoff consumption eligibility | ADR-0083 Ratified; delivered |
| **M3E-4** ✅ | Continuation admission and TaskRun correlation | ADR-0084 Ratified; delivered through PR #59; no run creation/execution |
| **M3E-5** ✅ | Atomic TaskRun start and attempt allocation | Delivered through PR #60 at `bef459aaf3a77549dd44760a21ea839073b0cb46`; ADR-0085 Ratified; schema v11; no continuation execution/runtime |
| **Product identity** | Quoky Platform source rename | Locally complete; independently reviewed; ADR-0086 Ratified; not yet delivered |
| **M3E-6A** | Continuation Execution Admission architecture | ADR-0087 Ratified by Chief Architect; independent exact-HEAD review PASS_WITH_NON_BLOCKING_FINDINGS; Option B over existing owners, exact TaskRun.id and effect-time revalidation; no new aggregate/repository/schema |
| **M3E-6B** ✅ | Read-only admission evaluation | Delivered through PR #67 at `c0c91f341cb5f300628b86506c84e329d4f14eac`; ADR-0087 Ratified; canonical STARTED conflict predicate; zero run mutation; guarded atomic start and bypass closure architected in M3E-6C |
| **M3E-6C** | Effect-time guarded continuation start architecture | ADR-0088 Ratified; independent review PASS_WITH_NON_BLOCKING_FINDINGS; guarded-start implementation NOT STARTED; Option B guarded start on existing TaskRun port; commit is the linearization point; at-most-one concurrent winner; bypass closure preserves terminal updates; no new aggregate/repository/schema; continuation Task RUNNING wiring required before activation; approval acquisition and start-time revalidation are distinct gates; receiver invocation not implemented; activation disabled |
| **M3E-6D** ✅ | Continuation Task lifecycle wiring | DELIVERED through PR #69 at `bab2e197151f9682298697be0cf5b18cb8f1e79b`; exact-bound Application preparation via existing TaskManager and ApprovalManager; production DI entry; no TaskRun; guarded start NOT IMPLEMENTED; receiver invocation NOT IMPLEMENTED; activation DISABLED |
| **M3E-6E** ✅ | Guarded atomic TaskRun start | DELIVERED through PR #70 at `c603f0923d20b463907b471f127f5f870225a4ac`; ADR-0088 sibling guardedStart; exact evaluated snapshots; single IMMEDIATE commit; six-process one-winner validation; ordinary-start/save bypass closure; no schema change; production trigger, profile config surface and receiver NOT IMPLEMENTED; activation DISABLED |
| **M3E-6F** ✅ | Activation readiness architecture | ADR-0089 **Ratified** (independent review PASS_WITH_NON_BLOCKING_FINDINGS); docs-only, architecture DECIDED; CONTINUATION_ACTIVATION_READY_TODAY = NO; ratified bound-run delete prohibition (resolveRun provenance + MAX(attempt)+1 ordinal identity), explicit bounded busy wait + typed storage contention, static AgentProfile config (no repository), narrow ContinuationExecutionService as coordinator and receiver-invocation owner with TaskManager terminalization; trigger, authorized Actor/Project scope, receiver capability set, post-wait live-plan source and operation-scoped Approval proof all UNRESOLVED; no prerequisite implemented; activation DISABLED; automatic retry NO; exactly-once external effects NO CLAIM |
| **M3E-6G** ✅ | TaskRun persistence safety | DELIVERED through PR #72 at `80b28ea8fa9746cd970d37f982510ba5be4ada37`; bound TaskRun delete prohibition (all statuses incl. terminal history) from persisted task_id + canonical binding in one IMMEDIATE transaction; explicit SQLite lock wait (5000 ms default, validated); typed `TASK_RUN_STORAGE_BUSY` distinct from `UNRESOLVED_STARTED_RUN`; CANCELED/revival coverage; unbound delete and missing-id no-op preserved; no schema/migration/status/repository; automatic Application retry NO; raw-SQL immunity NOT claimed; activation DISABLED |
| **M3E-6H** ✅ | Static AgentProfile configuration | DELIVERED through PR #73 at `dfb473d882d58805270425657498caebc837c80c`; `QUOKY_AGENT_PROFILES` parsed only in the existing typed app config into one immutable composition-time `AgentProfileRegistry`; hardcoded empty registry removed; strict unknown-field/duplicate-id/bounded failure, absent or `[]` keeps the empty fail-closed registry; no repository, schema, durable state or dynamic registration; profiles select no Provider and grant no capability, Tool or execution authority; Product trigger UNSELECTED, Product Decision gate NOT REACHED, receiver invocation NOT IMPLEMENTED, activation DISABLED |
| **M3E-6I-a** ✅ | Shared structural live-plan predicate | CLOSED + DELIVERED at baseline `bd3ede3336b7727a4fb84760c9868eadf7cddb2c`; shared pure proof; gate-specific semantics unchanged; caller-owned live plan; general post-wait questions remain unresolved |
| **M3E-6I-b** ✅ | Initial no-wait continuation context / Product policy | CLOSED + DELIVERED through PR #75 at `56f20c9f24d3700f572f0882ea6accbfca228518`; Product Decision gate PASSED; ADR-0089 Family A; explicit trigger, exact actor/project authorization, seven-capability allowlist and no human wait; no plan persistence or Approval expansion; activation DISABLED |
| **M3E-6J** ✅ | Explicit continuation execution caller | CLOSED + DELIVERED through PR #76 at `cb46950927897092c3c5ff2c55b5ea7e4056fe60`; immutable canonical request → Product policy → prepare → fresh entry/guarded start → exact TaskRun; DI WIRED; no external caller; activation DISABLED |
| **M3E-6K** ✅ | Receiver seam + exact-run terminalization | CLOSED + DELIVERED through PR #77 at `0b0c3be7c5d8d592b0739b4e8436bfa61731c185`; canonical receiver preflight → existing 6J → fake-testable receiver port → TaskManager exact-run success/failure; no retry/rediscovery/Task terminalization; no real adapter or production receiver binding; activation DISABLED |
| **M3E-6L** | Offline activation/composition acceptance | IMPLEMENTED LOCALLY / AWAITING REVIEW; isolated Nest + real Core/SQLite + fake receiver acceptance PASS LOCALLY; 19 matrix rows (15 PASS / 4 bound to executed existing regressions); production receiver binding and external transport NOT IMPLEMENTED; activation DISABLED; general post-wait plan supply and operation-scoped Approval proof UNRESOLVED / DEFERRED; live activation requires separate strict approval |
| **PCR-R1** | Production Continuation Receiver — Core contract / lifecycle semantics | IMPLEMENTED LOCALLY / AWAITING REVIEW on base `c0e1f9d`; immutable receiver `supportedCapabilities` narrowing (fail-closed empty/dup/malformed); package-internal non-authoritative constraint driving early + effect-time capability rechecks; Family-A recheck constrained-only (allowlist unchanged, `isFamilyACapability` defined once); guarded-start-bound `boundTaskFacts { capability, intentType }`; three-state `ContinuationReceiverOutcome` (SUCCEEDED/FAILED/UNRESOLVED, no new TaskRunStatus); bounded provider-agnostic `ContinuationRoutingAudit` DTO in the port layer; escaped receiver exception → UNRESOLVED (STARTED retained, no retry/redispatch/replacement, no persisted UNRESOLVED audit); `DELIVERED_TEST_CONTRACT_CHANGE = YES`; ADR-0089 amended; activation DISABLED; R2/R3 NOT STARTED; live authorization separate |
| **PCR-R2** | Production Continuation Receiver — offline provider-backed receiver | IMPLEMENTED LOCALLY / AWAITING REVIEW on base `ccb1864` (R1 = CLOSED + DELIVERED via PR #79). Core `ContinuationProviderRoutingService` (sibling of `RuntimeProviderRoutingService`, reuses Stage2B primitives; not a wrapper/CapabilityRouter/AiProvider caller); Core `PromptComposer.composeContinuation` + separate bounded validation corpus (identifiers only; no conversation reframe; fail-closed bounds); app `ProviderBackedContinuationReceiver` (`supportedCapabilities = [GENERAL_CHAT]`, narrow deps, bounded FAILED preflight, platform-owned `MARKDOWN_REPORT`, provider artifact ids ignored, never terminalizes); routing policy `stage2b-continuation-general-chat-v1` (WORK/CHAT/AUTHORITY_SENSITIVE, `requiredRoutingClasses=[BALANCED]`) + chat policy hardened to CONVERSATIONAL; PRODUCTION config/digest change binding both validation profiles; PRIMARY_ONLY enforced in code; disposition mapping (pre-dispatch→FAILED, dispatched-uncertain→UNRESOLVED, returned→SUCCEEDED/FAILED); `QUOKY_CONTINUATION_RECEIVER_MODE = disabled|general-chat-v1` (default disabled, separate from routing mode, general-chat-v1 startup fail-closed until R3 containment); ADR-0089 cross-referenced; activation DISABLED / NOT LIVE-READY; R3 NOT STARTED; no live provider/network/containment/external trigger |
| **Personal v1** | First product release ("Quoky Personal v1") | Scope ratified by the Product Owner 2026-10-02; ADR-0091/0092/0093/0094 + ADR-0073 amendment; see "First product release" below; IMPLEMENTED LOCALLY on the integration branch with offline acceptance PASS; Live UAT (criterion 9) NOT EXECUTED |
| **Personal v2** | Personal v2 (owner reminders, work chat, answer quality, code-work expansion, credential override) | IMPLEMENTED (waves 1-8). ADR-0096..0101 + ADR-0098 amendment Ratified; plan `docs/plans/personal-v2-execution-plan.md`; waves 1-7 MERGED (PRs #105-#111); wave 8 = INT-1 offline acceptance + DOC-B docs (wave-8 PR); owner-attended live QA for waves 1-7 recorded in `docs/uat/personal-v2-qa-record.md`; Live UAT of connectors (real tenants), reminders channel delivery, the reminders release default and merge enablement NOT EXECUTED |
| **Personal v3** | Personal v3 (always-on runtime, deterministic answers, memory commands, owner-curated learning, calendar, files and images, connector writes, local operations UI) | IMPLEMENTED (waves 1-6). ADR-0102..0113 Ratified 2026-10-06 (+ ADR-0106 and ADR-0110 amendments); plan `docs/plans/personal-v3-plan.md`; waves 1-6 MERGED (PRs #116-#132); INT-2 + DOC-C close wave 6; live QA in `docs/uat/personal-v3-qa-record.md`; SUB-3, CODE-8, CODE-9 DEFERRED (P2); granite live re-test, UI approve/reject, attachments/images and learning live sessions NOT EXECUTED |
| **Future** | Memory improvements · Codex · additional connectors | per ADR sequence |

## First product release — Quoky Personal v1

Scope ratified by the Product Owner on 2026-10-02. Distinct from the closed `v1.0.0` source release above:
this is the first release intended for daily single-owner use. Live UAT and any runtime/Discord/provider
execution remain separately approved Strict gates.

**Acceptance criteria (summary)**

| # | Criterion | Decision |
|---|---|---|
| 1 | Only configured owners reach Quoky, in allowlisted channels (and their threads) or owner DMs; no mention needed; startup fails closed without owner ids | ADR-0091 |
| 2 | General chat is served by local Ollama when its daemon and configured model are ready, otherwise by Claude; code analysis/implementation/review stay on Claude | ADR-0092 |
| 3 | Claude runs with a configurable model (default `sonnet`) and an adapter-owned capability→effort mapping; no Core contract change | ADR-0092 |
| 4 | Durable memory recall follows the owner across channels, DMs and resets; writer and existing records unchanged | ADR-0073 amendment |
| 5 | `도움말`/`/help` and `새 대화`/`/reset` work in every state; a pending approval expires after 30 minutes and otherwise captures turns with a reminder | ADR-0093 |
| 6 | Local code flow works end to end: preview → approved apply → test/typecheck → optional approved local commit on a non-main branch | ADR-0040–0046, ADR-0094 |
| 7 | Remote git is off by default (`QUOKY_GIT_REMOTE_ENABLED=false`); commits on `main`/`master` are refused | ADR-0094 |
| 8 | Offline verification green (typecheck + tests) for every slice; independent review before merge | `AGENTS.md` |
| 9 | Attended Live UAT passes (`docs/uat/first-release-uat-packet.md`; called "AC12" in the packet); a separately approved Strict gate, NOT EXECUTED | `AGENTS.md` |

**Deferred from Personal v1**

- R3 / Stage 2B / continuation track (continuation activation, production trust, ADR-0090 work).
- Execution-time provider fallback (Ollama failure → Claude re-execution); difficulty-based Claude effort.
- Chat pass-through while an approval is pending.
- `TEST_EXECUTION` approval.
- GitHub push → PR → merge → cleanup chain. (Personal v2: push → PR delivered opt-in with merge off; merge enablement is not live-verified.)
- New-file and multi-file apply. (Delivered in Personal v2.)
- M3 connector expansion.
- Vector retrieval; Codex provider. (Personal v2: opt-in local embedding recall delivered; Codex still deferred.)
- MLX provider — 2nd-release candidate.

**Personal v2 — status (2026-10-03)**

The v1-era candidate list for v2 (answer quality A-E) and the v2 tracks that were ratified on 2026-10-02:

| Item | Status |
|---|---|
| A. Feedback capture (👍/👎 reactions, implicit signals, local store, `피드백 요약`) | DONE (ADR-0098; schema v12) |
| B. Golden evaluation set and accuracy ratchet | DONE offline (QUAL-2); INT-1 routing ratchet pending in the wave-8 PR |
| C. Local embedding retrieval | DONE, opt-in (`QUOKY_EMBEDDING_ENABLED=false` by default); live probe pending |
| D. Feedback-driven examples injected by `PromptComposer` | NOT DONE in v2; delivered in v3 as LRN-2 (owner-curated, `LOCAL` providers only, flag off by default) |
| E. Local fine-tuning (MLX LoRA) | NOT DONE (deferred until enough personal data exists) |
| Credential override (QA-023) | DONE and live-verified (ADR-0097) |
| Chat policy and policy-sensitive routing | DONE and live-verified; local-model quality items remain (QA-V2-003/008, W7-06) |
| Reminders (create, list, cancel, DM delivery, tick driver) | DONE and live-verified on DM delivery; channel-delivery UAT and the release-default flip PENDING |
| Work chat: to-dos and read-only connector lookups | DONE; live-verified for to-dos; connector lookups on real tenants PENDING (owner adding credentials) |
| Code work: multi-file and new-file previews, branch create/switch | DONE (new-file chain live-verified on the sandbox repo) |
| Code work: opt-in push to PR chain, merge off by default | DONE through PR creation, live-verified on the sandbox repo; merge-flag enablement PENDING and out of scope |

**Remaining before calling Personal v2 closed:** the separately approved live sessions above (connector lookups on real
Jira/Slack/Confluence/GitHub tenants, reminders channel delivery, then the release-default decision for reminders).
Update 2026-10-06/07: connector lookups on the real Jira, Confluence and GitHub tenants, reminders channel delivery, PR
status with checks and embedding recall ran live (`docs/uat/personal-v2-qa-record.md`), and the reminders release default
is now `true` (Personal v3). Slack read lookups (no user token) and merge enablement have still not run.

**Personal v3 — status (2026-10-07)**

Plan `docs/plans/personal-v3-plan.md`; ADR-0102..0113 Ratified 2026-10-06; waves 1-6 merged (PRs #116-#132); live QA
record `docs/uat/personal-v3-qa-record.md`. "Live" means recorded there; everything else is offline-tested only.

| Item | Status |
|---|---|
| SUB-1/2 always-on launchd service, single instance, identity check, verified backups, `OPS_NOTICE` (ADR-0102) | DONE; installed and live-verified on the owner's Mac (restart, reminder across restart, pre-migration backups); reboot, scheduled daily backup and restore drill PENDING |
| SUB-3 continuation activation under the Personal trust model (ADR-0103) | DEFERRED (P2, not implemented; continuation stays fail-closed) |
| DET-1 internal-action claim guard, code-chain status replies, fall-through corpus (ADR-0104) | DONE and live-verified on a sample; residual R5 accepted; to-do/reminder status phrases (D3) and the full edge-case sweep PENDING |
| LLM-1 chat hygiene and help-intent handler | DONE and live-verified |
| LLM-2 model choice by measurement (ADR-0105 D1) | DONE offline: helpfulness-aware harness picked `granite3.3:8b`, set on the owner's service 2026-10-07; live re-test on an idle host PENDING (first check confounded by host load) |
| LLM-3 MLX provider (ADR-0105 D2-D4) | NOT DONE (optional; no benchmark run) |
| MEM-1 memory commands, archive with restore, history purge (ADR-0106 + amendment) | DONE and live-verified |
| LRN-1 learning store v14, candidates and trend; LRN-3 offline report (ADR-0107) | DONE; only the empty `피드백 후보` state ran live |
| LRN-2 curated examples for `LOCAL` providers only | DONE offline; `QUOKY_LEARNING_EXAMPLES_ENABLED=false` (off) until measured; live PENDING |
| LRN-4 local fine-tuning | DEFERRED (needs ≥300 approved examples and a measured LRN-2 gain) |
| CODE-6 read-only PR status token; CODE-7 PR title/body bound by hash (ADR-0108) | DONE and live-verified on the sandbox repo; optional model-proposed title/body (D4) not wired |
| CODE-8 multi-repository allowlist (ADR-0109) | DEFERRED (P2, not implemented) |
| CODE-9 merge enablement | DEFERRED (P2; release default `QUOKY_GIT_MERGE_ENABLED=false`) |
| CAL-1/2 calendar read; calendar writes (ADR-0110 + amendment) | DONE and live-verified on the owner's company calendar (reads, create, move, delete) |
| MM-1/2 attachments and local image understanding (ADR-0111) | DONE offline; images need an operator-chosen local vision model in `QUOKY_OLLAMA_VISION_MODEL`; live PENDING |
| CWR-1/2 Jira comment/transition and Slack post behind exact-payload approvals, v15 receipts (ADR-0112) | DONE and live-verified on allowlisted test targets; mid-send failure (`UNCERTAIN`) PENDING |
| OPS-1/2/2b local operations UI: monitoring, reminder cancel, memory forget, approve/reject (ADR-0113) | DONE; sign-in live-verified after the Origin fix (PR #131); UI handling and approve/reject live PENDING |

Out of v3 by decision: the multi-agent runtime, Team/Hosted tenancy, deploy/release automation, Confluence and
GitHub-issue writes, and remote access to the operations UI (Tailscale or other tunnels, LAN binding) or a separate
mobile/desktop client (Team/Hosted, ADR-0113 D11).

**Post-v3 extensions (taken up only after all Personal v3 development completes)**

- **Telegram platform adapter.** Owner decision 2026-10-06: a post-v3 extension, not part of the v3 plan. ARCHITECTURE.md
  §13 already lists Telegram as a `PlatformAdapter` evolution. Prerequisites found while scoping it:
  - Core still has Discord-specific text escaping in the work-chat renderers (`escapeDiscordText` in
    `packages/core/src/application/work-chat/external-work-readout.ts`, used by `work-chat-renderer.ts`).
  - Rendering must become platform-neutral before a second platform is added: Core emits neutral text, and each
    platform adapter applies its own escaping and markup.
  - A new ADR is needed at that time for per-platform owner admission (ADR-0091 is Discord-shaped: owner ids, channel
    allowlist, DMs) and for identity mapping of a Telegram user to the owner `Actor` (ADR-0009 seam).

## Deferred capabilities (YAGNI)

Reserve a seam **only when expensive to retrofit.** Most of these already map onto
**existing ports / ADRs** and need **no action now**:

| Capability | Absorbed by | Action now |
|---|---|---|
| Further MCP execution/integration | bounded `ToolProvider` adapter foundation exists | separate authorization; no autonomous loop |
| Plugin ecosystem | ADR-0007 (bundle of existing ports) | none |
| Multi-agent runtime | ADR-0008 (`AgentProfile` seam) | immutable profile/registry implemented in M3D; runtime remains deferred |
| Remote workspace | `WorkspaceProvider` (`kind: 'remote'`) | none |
| Local model manager | `AiProvider` availability/health | none |
| Multimodal | keep `Artifact`/`Resource` from assuming text-only | note only |
| Search | future bounded resource retrieval + `VectorProvider` | deferred; `ResourceResolver` is not implemented |
| Feedback learning, Feature registry, Scheduler, Notification | future additive services | Scheduler/Notification: bounded Core seam for owner reminders only (ADR-0101); other items none |

## Non-goals (v1)

- Not a Discord bot framework — Discord is one adapter.
- No AI HTTP API (CLI only). No Postgres/Redis. No multi-tenancy.
- No slash-command UX. No autonomous agent loops, no dynamic plugin loading, no Workflow engine.

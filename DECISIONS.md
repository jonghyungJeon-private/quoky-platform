# Chunsik — Architecture Decision Records

Append-only log of architectural decisions. **Never edit or delete a past
entry**; supersede it with a new entry that references the old one. This file is
the "case law" companion to `ARCHITECTURE.md` (the "constitution"). AI agents and
humans MUST read both before writing code, and must not re-litigate a settled
decision without adding a new superseding ADR.

### Status vocabulary

| Status | Meaning | Build now? |
|---|---|---|
| ✅ **Accepted (v1)** | Adopted; implement when business logic begins | Yes, in v1 |
| 🟡 **Reserved seam (v1)** | Define the thin interface/field now; implement behavior later | Seam yes, behavior no |
| ⛔ **Deferred (v2+)** | Sound concept, intentionally postponed | No |
| ❌ **Rejected** | Not adopting in current form; alternative recorded | No |

> These ADRs record **direction**. They do not by themselves change code. The
> current scaffold remains as built; concepts marked Accepted/Reserved are
> introduced when their slice of work starts, per the decision here.

Seeded 2026-06-28 from the v3 Architecture Review.

---

## ADR-0001 — Conversation Session as a thin aggregate

- **Status:** ✅ Accepted (v1) — introduce early, minimal
- **Date:** 2026-06-28

### Context
Today `ConversationContext` is a value object (channel/thread/user ids) and
`Task` references it; there is no entity that owns a conversation's lifecycle or
groups its tasks. A Session is hard to retrofit because every Task, memory scope,
and context-file path is anchored to a conversation. The review proposal also
loaded Session with "active AI provider", context/memory snapshots, current plan,
artifacts, and task history — making it a god object.

### Decision
Introduce **Session** as the thin conversation aggregate root: `id`,
`conversationContext`, `actorId` (see ADR-0009), optional `projectId`, `status`
(ACTIVE/IDLE/CLOSED), `lastActivityAt`, optional `activeTaskId`. Add `sessionId`
to `MemoryScope`. **Reject** storing on Session: the active provider (violates
capabilities-above-models), and context/memory snapshots (staleness risk —
context is rebuilt per run). Plan/artifacts/history belong to Tasks; Session only
references them.

### Consequences
- + Clean anchor for memory scope and Team-Edition actor binding.
- + Cheap to add now, painful later.
- − One more entity to persist; orchestrator must resolve/open a Session per inbound message.

### V1 / V2
**V1:** thin entity + `sessionId` in `MemoryScope`. **V2:** richer lifecycle (idle/resume policies, team presence).

---

## ADR-0002 — ContextBuilder as a distinct seam

- **Status:** 🟡 Reserved seam (v1)
- **Date:** 2026-06-28

### Context
`MemoryManager.buildContextFiles` currently dumps every memory of each type into
markdown. That conflates the *system of record* (memory CRUD) with *assembling
context for one run* (retrieve → rank → compress → budget). As memory grows and
token budgets bite, those evolve independently; separating them later couples
many callers to MemoryManager's raw output.

### Decision
Define a **ContextBuilder** application service that returns a structured
**ContextBundle**. v1 implementation is trivial (delegate to MemoryManager, no
ranking/compression). ContextBuilder MUST NOT write files — context-file
materialization is a workspace concern. Ranking/compression are pluggable
strategies behind it later.

### Consequences
- + The expensive-to-retrofit seam exists; algorithms are swappable.
- + Restores single-responsibility to MemoryManager.
- − A pass-through layer with little behavior in v1 (acceptable: the interface is the value).

### V1 / V2
**V1:** interface + `ContextBundle` type + trivial impl. **V2:** semantic ranking, compression, token budgeting.

---

## ADR-0003 — PromptComposer and a provider-agnostic PromptSpec

- **Status:** ✅ Accepted (v1) — highest-value addition
- **Date:** 2026-06-28

### Context
The orchestrator currently passes `plan.summary` / raw message text as the
prompt. A long-lived AI platform needs deterministic, layered, testable prompt
assembly. Different CLIs want different shapes (Claude→`CLAUDE.md`,
Codex→`AGENTS.md`, Ollama→small context), which tensions with "Core knows no
provider".

### Decision
Introduce **PromptComposer** producing a **PromptSpec** layered as
`system + developer + context + task`, **provider-agnostic**. The **AiProvider
adapter** renders `PromptSpec` → concrete CLI args + context files. Per-capability
developer instructions live as runtime templates (the `prompts/` assets, ADR-0011),
consumed by the composer.

### Consequences
- + Prompts become reproducible and unit-testable; provider shaping stays in adapters.
- + Boundary preserved: Core emits a spec, never a CLI-specific string.
- − Requires the PromptSpec contract to be designed carefully up front.

### V1 / V2
**V1:** PromptComposer + PromptSpec contract + the prompt templates actually used. **V2:** richer layering, A/B prompt variants per AgentProfile.

---

## ADR-0004 — Workflow deferred; reserve a nullable field

- **Status:** ⛔ Deferred (v2+) — reserve `workflowId` only
- **Date:** 2026-06-28

### Context
A Workflow (multi-task DAG with dependencies, partial failure, resume) is real
over-engineering before single-task execution even works. It also collides
conceptually with `Plan`/`PlanStep`, risking two overlapping decomposition models.

### Decision
**Do not build a Workflow engine in v1.** Fix the boundary: **Plan/PlanStep =
intra-task decomposition; Workflow = inter-task orchestration.** Reserve a
nullable `workflowId?: Id` on `Task` (unused in v1) so the future retrofit is a
one-field change.

### Consequences
- + Avoids a premature orchestration layer and conceptual drift.
- + Cheap retrofit preserved.
- − Multi-task scenarios are unsupported in v1 (acceptable).

### V1 / V2
**V1:** reserve `workflowId` + document the Plan-vs-Workflow distinction. **V2:** Workflow aggregate + execution engine.

### Amendment (RC, 2026-06-29)
The nullable `workflowId` field is **not** reserved on `Task` after all. Under
ADR-0013 ("YAGNI on seams") and the JSON-blob storage model (entities serialize to
a `data` column; adding a field needs **no migration**), a late add is free — so the
reservation bought nothing. The **Plan-vs-Workflow conceptual boundary still holds**;
only the empty placeholder field is dropped. Surfaced by the V1 architecture audit
(drift W-2) and reconciled here.

---

## ADR-0005 — Resource abstraction, scoped to inputs

- **Status:** 🟡 Reserved seam (v1)
- **Date:** 2026-06-28

### Context
Input references are fragmented (`Project`, `Attachment`, `ConnectorItem`,
`WorkspaceRef`). ContextBuilder otherwise needs N special cases to pull in a PDF,
URL, ticket, or repo file. Risk: an "everything is a Resource" bag that merges
inputs and outputs.

### Decision
Introduce **`ResourceRef`** (`{id, kind, uri, source, metadata}`) + a
**`ResourceResolver`** port for **read-side inputs only**. Keep `Artifact`
(output) strictly separate. `Project` stays its own entity but may be *exposed
as* a Resource. **Connectors are ResourceResolvers** (read), which absorbs much
of the plugin question (ADR-0007).

### Consequences
- + Uniform context-input path; connectors unified under a known port.
- + Input/output lifecycles stay distinct (hard rule).
- − Slight upfront modeling of `kind`/`source` taxonomy.

### V1 / V2
**V1:** `ResourceRef` + `ResourceResolver` port (no concrete resolvers). **V2:** concrete resolvers (PDF, URL, repo, Jira read).

---

## ADR-0006 — Event types + EventBus port; no choreography

- **Status:** 🟡 Reserved seam (v1) — types + port now, heavy usage deferred
- **Date:** 2026-06-28

### Context
A domain event bus enables audit, decoupling, and plugin hooks, but in-core event
choreography becomes implicit, hard-to-trace control flow — a major long-term
debuggability tax. Audit history also cannot be backfilled if events are not
captured from the start.

### Decision
Define **domain event types** now (`TaskCreated`, `TaskStatusChanged`,
`RunCompleted`, `ApprovalRequested`, `ApprovalDecided`) and an **EventBus port**
with an in-process `LocalEventBus` adapter (transport swappable like
`QueueProvider`). Keep the orchestrator's **primary flow explicit and
synchronous**; use events only for side-channels (audit, memory updates, metrics,
plugin hooks).

### Consequences
- + Audit trail + extension hooks without event-soup control flow.
- + Transport can become Redis/Kafka in Team Edition with no Core change.
- − Discipline required to keep events off the critical path.

### V1 / V2
**V1:** event types + port + LocalEventBus + emit-for-audit. **V2:** distributed transport, plugin subscriptions, projections.

---

## ADR-0007 — Plugin system rejected for v1; a plugin is a bundle

- **Status:** ❌ Rejected (v1) for "replace connectors"; concept reserved for v2+
- **Date:** 2026-06-28

### Context
"Plugin" conflates four unrelated extension types (UI adapters, read connectors,
gated actions, AI providers); one `Plugin` interface becomes a god-interface.
Dynamic loading (manifests, sandboxing, versioning, permissions) is heavy
over-engineering for a local-first personal edition, where compile-time
registration in the composition root is safer.

### Decision
**Keep manual registration in the composition root for v1.** A future plugin is a
**packaging bundle that contributes implementations of existing narrow ports**
(`PlatformAdapter`, `ResourceResolver`, `ActionProvider`, `AiProvider`) plus a
capabilities/permissions manifest — never a new Core dependency. Shape for it now
only by: no god-interface, all external actions go through the approval gate, and
providers carry a uniform capability/permission descriptor.

### Consequences
- + Avoids premature plugin infrastructure; governance cannot be bypassed.
- + External writes are modeled as gated `ActionProvider`s, not ad-hoc connector methods.
- − No third-party/hot-loadable plugins in v1 (acceptable).

### V1 / V2
**V1:** manual registration; narrow ports only. **V2+:** plugin bundle model + loader + manifest/permissions.

---

## ADR-0008 — Agent layer deferred; reserve AgentProfile config

- **Status:** ⛔ Deferred runtime (v2+); 🟡 reserve `AgentProfile` config seam (v1)
- **Date:** 2026-06-28

### Context
"Agent" is ambiguous (persona vs autonomous loop vs sub-orchestrator) and most
likely to be redefined as understanding grows. But `capability + developer-prompt
+ provider-hint` is already a proto-agent.

### Decision
**No agent runtime in v1.** Reserve the seam as **configuration, not a service**:
`AgentProfile = {role, capability, promptTemplateRef, riskProfile,
allowedResources}`. Routing becomes **Planner → AgentProfile → Capability →
Provider**. Autonomous loops (plan-act-observe, tool use, sub-agents) are deferred
and MUST sit behind this seam without changing Capability/Provider contracts.

### Consequences
- + Keeps the agent concept from hardening prematurely.
- + Connects naturally to PromptComposer templates (ADR-0003).
- − Single-shot execution only in v1 (acceptable).

### V1 / V2
**V1:** `AgentProfile` config type, consulted by Planner/Router. **V2:** agent runtime / tool-using loops.

---

## ADR-0009 — Actor / Principal model (Personal → Team enabler)

- **Status:** ✅ Accepted (v1) — highest-priority missing concept
- **Date:** 2026-06-28

### Context
Everything currently keys off a raw platform `userId` string. Team Edition needs a
platform-independent identity that authorization hangs off. This touches *every*
entity, making it the **most expensive retrofit of all** — more urgent than
Session, Workflow, or Plugins for the "Personal → Team without changing Core" goal.

### Decision
Introduce a thin **`Actor`** (a.k.a. Principal): platform-independent identity,
optionally a team/org later. `Session` and `Task` reference an `actorId`. In v1
the single Discord user maps to one local Actor. Reserve a `PolicyProvider`
authorization seam (ADR notes; not implemented) tied to Actor for per-actor
permissions beyond risk levels.

### Consequences
- + Authz and multi-actor teams become additive, not a rewrite.
- + Risk levels gate *what's dangerous*; Policy/Actor gate *who may do/approve what* later.
- − Every new entity must carry/derive `actorId` from the start.

### V1 / V2
**V1:** thin `Actor` + `actorId` references; single mapped local actor. **V2:** multi-actor teams, `PolicyProvider`, approval authority rules.

---

## ADR-0010 — Usage / Cost tracking on TaskRun

- **Status:** 🟡 Reserved seam (v1)
- **Date:** 2026-06-28

### Context
For an AI platform, cost (which provider, wall-time, tokens) is **domain data**.
If not captured from run #1, historical cost/quality data is permanently lost.
`TaskRun` records `providerId` (audit) but no usage.

### Decision
Add a **`Usage`** value object to `TaskRun` (e.g. `provider`, `durationMs`,
optional `inputTokens`/`outputTokens`/`costEstimate`) and reserve a
**`TelemetryProvider`** port for tracing/metrics. CLI providers populate what
they can measure; unknown fields stay optional.

### Consequences
- + Cost/perf analysis and provider comparison become possible from day one.
- + Telemetry transport is swappable per edition.
- − CLIs may not expose token counts; fields remain optional/best-effort.

### V1 / V2
**V1:** `Usage` on `TaskRun` (duration + provider at minimum) + `TelemetryProvider` port. **V2:** dashboards, budgets, per-actor cost.

### Amendment (RC, 2026-06-29)
Realized **minimally**: `TaskRun` records `providerId`, `durationMs`, and `error`
(ADR-0015) — duration + provider, the stated v1 minimum. A structured `Usage` value
object and a `TelemetryProvider` port are **not** built (no token/cost capture yet,
and the CLIs don't expose token counts). Deferred to V2 under ADR-0013's YAGNI; the
JSON storage model makes adding `usage` later migration-free. Surfaced by the V1
architecture audit (drift W-3).

---

## ADR-0011 — AI-native documentation strategy

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-06-28

### Context
An AI-native repo needs agents to behave correctly without re-deriving intent.
The v3 proposal mixed three different file kinds (human docs, agent instructions,
runtime assets) and fragmented agent instructions across CLAUDE/CODEX/OLLAMA.md,
which guarantees drift. `PROMPTS/*.md` are runtime data, not documentation.

### Decision
- **Constitution + case law:** `ARCHITECTURE.md` (rules) + `DECISIONS.md` (why),
  both required reading before coding.
- **One agent manual:** `AGENTS.md` is canonical; `CLAUDE.md` is a thin pointer.
  **Do not create `CODEX.md`/`OLLAMA.md`** — provider behavior lives in adapters,
  provider notes live as a section in `AGENTS.md`.
- **Runtime templates ≠ docs:** prompt templates belong under a `prompts/` asset
  path owned by the PromptComposer (ADR-0003), not the doc root. Do not move them
  until they exist.
- **Minimum AI-native set before business logic:** `README.md` (exists),
  `ARCHITECTURE.md`, `DECISIONS.md`, `AGENTS.md`, `CLAUDE.md`. Everything else
  (ROADMAP detail, CONTRIBUTING, prompt templates) is added when its work starts —
  no placeholders.

### Consequences
- + Agents read one consistent source; settled decisions are not re-litigated.
- + No empty/placeholder docs to rot.
- − Requires discipline to record every decision here before dependent code merges.

### V1 / V2
**V1:** the four-file minimum set + this log. **V2:** ROADMAP detail, CONTRIBUTING, populated `prompts/`.

---

## ADR-0012 — Repository operating model & Charter reconciliation

- **Status:** ✅ Accepted (v1) — extends ADR-0011
- **Date:** 2026-06-28

### Context
The Project Charter v1 proposed a collaboration/governance model and a larger
documentation tree. A Principal-Architect review found three problems: (1) it
hard-coded a specific AI vendor (ChatGPT) as Chief Architect/decision-maker —
self-contradictory for a project whose first principle is "models are
implementation details"; (2) a full `docs/{architecture,adr,sprints,reviews,…}`
tree would create placeholders, violating ADR-0011; (3) ADRs were split across
`docs/adr/` and `DECISIONS.md`. The Product Owner reviewed and approved a
reconciled, minimal version.

### Decision
- **Collaboration model is role-based, not vendor-based** (in `AGENTS.md` §9):
  Product Owner (final decision), Chief Architect, Architecture Reviewer,
  Implementation Engineer, Review Engineer. No AI vendor is hard-coded into
  governance. **Reviewer ≠ implementer**; any role may propose an ADR; only the PO
  ratifies.
- **Documentation = single source of truth; prompts are temporary.** Architecture
  changes happen **only through an approved ADR**, never via an ad-hoc prompt or
  silently in code.
- **Add only immediately-useful docs** (no `docs/` subtree, no empty folders):
  `ROADMAP.md`, `CURRENT_STATE.md`, `CHANGELOG.md` (Keep a Changelog), and a single
  `docs/templates/ADR_TEMPLATE.md`. `DECISIONS.md` stays the canonical ADR log at
  root (migrate to `docs/adr/` only if it grows; not now).
- **Conventional Commits** is the repository commit standard.
- Vision gains **Hosted/SaaS Edition**; multi-tenancy is a **v3** scope dimension
  layered on Actor/Session — no multi-tenant abstractions now (YAGNI).

### Consequences
- + Governance is self-consistent with the product philosophy and tool-agnostic.
- + Doc set stays minimal and maintainable; no placeholder rot.
- + Clear change-control: docs win over prompts, ADR-gated changes.
- − Requires discipline: every sprint updates `CURRENT_STATE.md` + `CHANGELOG.md`,
  and architecture edits must carry an ADR.

### V1 / V2
**V1:** all of the above. **V2:** CONTRIBUTING.md, `docs/adr/` migration if volume warrants, populated `prompts/`.

---

## ADR-0013 — Sprint sequencing (split the first vertical slice) & YAGNI on seams

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-06-28

### Context
The Charter's Sprint 1 lit up six still-stubbed components at once (Discord,
Session, Intent, Planner, ContextBuilder, PromptComposer, Claude CLI, SQLite) — a
high-blast-radius first real sprint. The Charter also proposed reserving seams for
~11 future capabilities, most of which existing ports already absorb.

### Decision
- **Split Sprint 1** into thin slices:
  - **Sprint 1a — walking skeleton:** Discord adapter + minimal Session + SQLite
    persistence + **echo** reply. Validates I/O, persistence, and boundaries with
    **no cognition**.
  - **Sprint 1b — first cognitive flow:** Intent classification + Planner +
    ContextBuilder + PromptComposer + capability routing + Claude CLI execution.
    Natural language only; **provider chosen by the router, never hardcoded** even
    in the skeleton.
  - **Future sprint:** memory improvements, Codex, Ollama, connectors (read-only).
- **YAGNI on reserved seams:** reserve a seam only when retrofit is expensive.
  Future capabilities (MCP, plugins, multi-agent, remote workspace, local model
  manager, multimodal, search, scheduler, notification, feedback learning, feature
  registry) map onto **existing ports / prior ADRs** or require **no action now**
  (see `ROADMAP.md` → Deferred capabilities). No new Core seams are added for them.

### Consequences
- + Lower risk per sprint; the skeleton proves the architecture before cognition.
- + Avoids premature abstraction; existing ports carry future load.
- − Two sprints to reach a full NL flow instead of one (intended trade-off).

### V1 / V2
**V1:** Sprint 1a then 1b. **V2:** the future sprint and beyond, per `ROADMAP.md`.

---

## ADR-0014 — Prompt/Context contracts, AiProvider promptSpec, and Claude CLI invocation

- **Status:** ✅ Accepted (v1) — elaborates ADR-0002 / ADR-0003
- **Date:** 2026-06-29

### Context
Sprint 1b needs concrete shapes for context assembly and prompting, and a defined
way for the CLI provider to run. ADR-0002 (ContextBuilder) and ADR-0003
(PromptComposer/PromptSpec) decided the seams; this records the concrete v1 contracts.

### Decision
- **ContextBundle (minimal):** `{ taskId, summary, recentMessages: string[] }`.
  Ranking / compression / resources are deferred behind this shape.
- **PromptSpec (minimal, layered):** `{ system, developer, context, task }`,
  provider-agnostic. The PromptComposer (core) builds it; an AiProvider adapter
  RENDERS it. The core NEVER renders provider-specific text.
- **`AiExecutionRequest.promptSpec?` added** (additive, optional); `prompt?` becomes
  the optional pre-rendered fallback. Providers prefer `promptSpec`.
- **Claude CLI invocation contract** (implemented in Sprint 1b-2):
  - Use `claude -p` (non-interactive print).
  - Pass the prompt safely via **stdin** (never shell-interpolated into args).
  - **Do NOT use `--bare`** — it requires `ANTHROPIC_API_KEY` and ignores OAuth;
    we preserve authenticated-CLI usage.
  - Run in a **neutral cwd** so the repo's `CLAUDE.md`/`AGENTS.md` are not auto-ingested.
  - Apply a **timeout**; **capture stdout** as the response.
- **v1 is CLI-only — no AI HTTP API path** anywhere.

### Consequences
- + Concrete, testable prompt/context contracts; provider rendering stays in adapters.
- + The additive request field keeps existing call sites valid.
- + Claude invocation is deterministic, leaks no repo context, and needs no API key.
- − Both `prompt` and `promptSpec` optional means a caller must supply one (enforced by
  usage/convention, not the type).

### V1 / V2
**V1:** the above; ClaudeCliProvider implements the invocation in Sprint 1b-2.
**V2:** richer PromptSpec layers, ContextBuilder ranking/compression, per-provider
rendering refinements.

---

## ADR-0015 — Claude global-context acceptance & CLI failure taxonomy

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-06-29

### Context
`claude -p` with OAuth (no `--bare`) auto-loads the **global** `~/.claude/CLAUDE.md`
and auto-memory; the neutral cwd only prevents the **repo** CLAUDE.md from being
ingested. Separately, the product must fail gracefully when the CLI is missing,
unauthenticated, slow, or errors — not crash or go silent.

### Decision
- **Global context (Chief-Architect decision 1):** v1 **accepts** that `claude -p`
  loads global `~/.claude/CLAUDE.md` + auto-memory. We keep the **neutral cwd**
  (blocks the repo CLAUDE.md) and do **not** use `--bare` (it requires
  `ANTHROPIC_API_KEY` and breaks OAuth). A future **isolated mode** is left open
  (dedicated HOME/settings or a discovery-skip flag) for team/SaaS editions.
- **Failure taxonomy:** `AiFailureKind` = `UNAVAILABLE | AUTH_REQUIRED | TIMEOUT |
  EXECUTION_FAILED | EMPTY_OUTPUT`. The provider throws `AiProviderError(kind,
  masked technical message)`; the core maps the kind to a friendly Discord message
  (the **core owns the UX text**, not the provider) and stores `kind: summary` on
  the TaskRun.
- **TaskRun on failure:** status `FAILED`, `error` summary stored, `durationMs`
  recorded; no artifact. The user **always** gets a reply; the run is never lost.
- **Secrets:** the prompt is passed via **stdin** (never argv); stderr is
  **secret-masked** before being logged or stored; user messages never carry
  technical detail.
- **Output/usage:** text output retained; usage tracking is minimal (`providerId`
  + `durationMs`). `--output-format json` and token/cost tracking are deferred.

### Consequences
- + Product-grade, classified failure UX; auditable FAILED runs with timing.
- + No secret leakage into logs, storage, or user messages.
- − Global `~/.claude` context may inject unintended instructions/memory into
  user-facing answers in v1 (accepted risk; revisit for team/SaaS).
- − No Codex/Ollama fallback yet: when Claude is unavailable the user gets the
  UNAVAILABLE message rather than an alternate provider.

### V1 / V2
**V1:** the above. **V2/V3:** isolated Claude-context mode; multi-provider fallback;
`--output-format json` + token/cost usage.

---

## ADR-0016 — Discord response delivery policy

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-06-29

### Context
Discord caps a message at 2000 chars; Claude answers are often longer (a smoke
answer was 5351 chars). Sends can fail or be rate-limited, and the "is typing…"
indicator only lasts ~10s while runs take ~50–70s. Delivery is a Discord-specific
concern and must not leak into the core.

### Decision
- **Chunking (adapter):** split at `DISCORD_SAFE_LIMIT = 1900` (headroom under
  2000), preferring newline → space boundaries; an over-long token is hard-cut.
  Pure `chunkText` lives in the Discord adapter; the core stays Discord-free.
- **Sequential delivery:** chunks are sent in order, awaiting each before the next.
- **Send-failure handling:** on the first chunk failure, **stop** (partial delivery)
  and report/log (secret-masked). **No resend** → no duplicate messages. Rate-limit
  backoff is delegated to **discord.js's REST layer**. Task-level retry remains a
  future RetryPolicy ADR.
- **Typing indicator:** refresh every ~8s (under the ~10s TTL) while processing;
  cleared by the next `sendMessage` to that target, or a safety cap (~128s).
  Adapter-internal (the TTL is a Discord detail).
- **Response format:** `ResponseComposer` trims and supplies a non-empty fallback.
- **File attachment for very long responses:** **policy/seam only**
  (`FILE_ATTACHMENT_CHUNK_THRESHOLD`) — DEFERRED; v1 still sends chunks and logs
  when the threshold is exceeded.

### Consequences
- + Long responses are delivered reliably; the typing indicator stays continuous.
- + No duplicate messages; partial delivery on failure is reported, not retried.
- − On a mid-sequence send failure the user keeps the chunks already sent (logged;
  the AI run itself is unaffected and remains COMPLETED).
- − Very long responses produce many messages until the file-attachment seam is built.

### V1 / V2
**V1:** the above. **V2:** file-attachment delivery for long responses; optional
chunk numbering; bounded delivery resend under a RetryPolicy ADR.

---

## ADR-0017 — Conversation memory policy (short-term)

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-06-29

### Context
Within one session, a follow-up like "방금 답변 한 줄로 줄여줘" must see the previous
turn. We need the **minimum** continuity — no vector search, no long-term auto-save,
no summarization.

### Decision
- **Store both turns as SHORT_TERM memory:** the inbound USER message and the
  assistant RESPONSE, each scoped by `sessionId` (plus userId/channelId/threadId),
  with `role` (`user`/`assistant`) in `metadata`. **No provider id is stored in memory.**
- **ContextBuilder** includes the most recent **N = 10** SHORT_TERM turns for the
  **same session**, each **simply truncated** (`MAX_MEMORY_CHARS = 400`, no summarization).
  Under ADR-0063, `ContextBuilder` retains explicit turn number, role, provenance, and
  epistemic status until `PromptComposer` renders the numbered conversation/context layer.
- **Retrieval is session-scoped** (falls back to channel/thread only if a task has
  no session).
- **Out of scope:** vector search, long-term memory auto-save, summarization memory.
- **Masking:** reuse the existing policy (CLI stderr masking). Memory content is the
  user's own local conversation, stored raw in local SQLite and never logged.

### Consequences
- + Natural multi-turn continuity within a session (verified live: a follow-up
  shortened the prior answer).
- + Bounded prompt growth via the N cap + per-memory truncation.
- − Truncation can drop detail from very long prior turns (acceptable in v1).
- − The `memories` table grows unbounded (no pruning yet) — a future retention/cleanup
  concern; privacy is acceptable for a personal, local-first edition.

### V1 / V2
**V1:** the above. **V2/V3:** vector recall, long-term + summarized memory, retention
/ pruning policy, cross-session/project memory.

> Pruning addendum (Chief Architect): SHORT_TERM memory is capped at **30 per
> session** (oldest pruned). No TTL or total-size cap yet. Also: the current inbound
> user message is excluded from recent context (it already appears in the task layer).

---

## ADR-0018 — Local project registration policy

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-06-29

### Context
Before any coding agent, a user must be able to register a local project and have
its context flow into later answers — read-only, no deep indexing.

### Decision
- **Registration is a deterministic command, not an AI task.** A message like
  "이 프로젝트 등록해줘: /path" classifies as `REGISTER_PROJECT` (path extracted) and
  is handled by `ProjectManager` (risk ≤ MEDIUM, auto-run).
- **Read-only scan** via `WorkspaceProvider.scanProject(path)`: `exists`, `name`
  (basename), `gitBranch` ('unknown' when not a git repo), `packageManager` (lockfile
  detection), `fileTreeSummary` (top-level only; **excludes** node_modules, dist,
  build, .git, coverage). The scan never modifies anything.
- **Persistence:** a `Project` entity (SQLite `projects`); a PROJECT-type memory
  holding the rendered summary, scoped by `projectId` (+ sessionId); the session's
  `activeProjectId` is set.
- **Use in chat:** later tasks carry `projectId = session.activeProjectId`;
  `ContextBuilder` includes the PROJECT memory summary; `PromptComposer` renders it and
  instructs the model to answer from the provided context (not read files / use tools).
- **Failure UX:** a non-existent path → friendly failure, nothing persisted. Path must
  be a local directory.
- **Workspace gating:** only filesystem-touching capabilities (CODE_IMPLEMENTATION /
  TEST_EXECUTION) resolve a workspace; a chat about a project does NOT — its context
  comes from PROJECT memory, not a resolved working directory.

### Consequences
- + Project context is available in conversation, read-only, with a bounded summary.
- + Registration is auditable (project + PROJECT memory + session link) and safe.
- − The summary is top-level only (shallow); deep structure isn't known without
  reading files (deliberately out of scope — no deep indexing / coding agent yet).
- − The model could still attempt file access despite the instruction; mitigated by a
  neutral cwd + the system prompt. A hard tool-disable is a future option.

### V1 / V2
**V1:** the above. **V2:** deeper (gated) project indexing, multiple projects per
session, git-worktree workspaces, and tool-restricted execution.

---

## ADR-0019 — Gated Project Analysis

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-06-29
- **Scope boundary:** this ADR is **NOT** an approval of "Deep Project Indexing."
  It delivers a narrow, gated, read-only *analysis* of allow-listed project
  metadata files only. Repository-wide indexing remains deferred (see the explicit
  non-goals in Decision below). It does not widen ADR-0018's V2.

### Context
After registering a project (ADR-0018), the only context available in chat is a
**top-level file-tree summary** held as PROJECT memory. That is enough to name a
project but not to describe its architecture. A user asking "what's the structure
of this project?" gets a thin, often unhelpful answer because the model was never
shown any file contents — and (by ADR-0018) it must not read files itself.

### Decision

**What this ADR is (and explicitly is not):**
- This ADR introduces a gated read-only project analysis capability.
- Only an allow-list of project metadata files may be read.
- This ADR explicitly does **NOT** introduce repository indexing.
- This ADR does **NOT** introduce vector search.
- This ADR does **NOT** introduce semantic code search.
- Repository-wide indexing remains deferred.

The current implementation scope is **Project Analysis**, not **Deep Project
Indexing**. The mechanics below stay strictly inside that boundary.

**Mechanics:**
- **A new intent + capability `PROJECT_ANALYSIS`.** A message that asks to
  analyze/explain a project's structure classifies deterministically: an analysis
  verb (분석/설명/알려/analyze/explain/describe/overview) co-occurring with a
  project/structure noun (프로젝트/레포/패키지/구조/아키텍처/repo/project/structure/
  architecture), in either order — or "분석/analyze" alone — maps to
  `PROJECT_ANALYSIS` (risk LOW, `requiresWork: true` → runs as a Task). This is a
  minimal v1 heuristic; AI-driven classification is deferred.
- **Deterministic guard + gather, AI summarizes.** `ProjectAnalyzer.prepare(session)`
  guards an **active, resolvable project** exists (else a friendly "register first"
  message, nothing run). It then performs a **read-only, size-limited** read via
  `WorkspaceProvider.readProjectFiles(rootPath)`. The AI summarization runs in the
  normal task pipeline; the service does no AI work itself.
- **Allow-list, not crawl.** Only specific files may be read in full:
  `package.json`, `pnpm-workspace.yaml`, `README.md`, `ARCHITECTURE.md`,
  `DECISIONS.md`, and `tsconfig*.json`. Each is capped at **8 KB** (`truncated`
  flagged). A **2-level tree** (root + `apps/` + `packages/`, ≤60 entries/dir) is
  included. `node_modules`/`dist`/`build`/`.git`/`coverage` are excluded.
- **Never read secrets.** Any `.env*` or name matching
  `secret|token|key|credential|password` is skipped unconditionally — independent
  of the allow-list. No shell or git commands are run during analysis.
- **Prompt seam.** `PromptComposer.compose(task, bundle, readout?)` renders the
  readout as a clearly-delimited read-only section and instructs the model to
  summarize **only** from the shown files/tree and not invent files.
- **Reuse.** A completed analysis is persisted as a **TOOL-type** memory
  (`kind: 'analysis'`) scoped by `projectId` (+ sessionId) for later reuse.
- **No workspace resolution.** `PROJECT_ANALYSIS` is not filesystem-touching in the
  workspace sense (no clone/cwd); `needsWorkspace` stays limited to
  CODE_IMPLEMENTATION / TEST_EXECUTION (ADR-0018). The readout is the only file I/O.

### Consequences
- + Structural questions get a grounded answer from real files, still read-only and
  bounded — no deep indexing, no tool execution, no secret exposure.
- + The guard keeps the failure UX kind (no active project → ask to register).
- − The allow-list is intentionally narrow; a project that documents itself
  elsewhere (e.g. `docs/`) is summarized only from the listed files + tree. Widening
  the list is a deliberate, reviewable change.
- − 8 KB/file truncation can clip large manifests; acceptable for a summary, flagged
  as `truncated` so the model knows.

### V1 / V2
**V1:** the above (fixed allow-list, 2-level tree, single active project).
**Deferred (NOT approved by this ADR; each needs its own ADR):** repository-wide
indexing, vector search, semantic code search, configurable/auto-discovered read
sets, and tool-restricted live file reads under approval.

---

## ADR-0020 — SQLite schema versioning & a minimal migration runner

- **Status:** ✅ Accepted (v1, RC)
- **Date:** 2026-06-29

### Context
v1 applied schema at startup with `CREATE TABLE IF NOT EXISTS` plus defensive
`ALTER TABLE … ADD COLUMN` wrapped in try/catch. There was **no schema version**, so
the DB could not tell which changes it had seen, and the silent catch could mask a
real `ALTER` error. The V1 architecture audit flagged this (W-9) as a freeze-blocker
for safe future schema evolution.

### Decision
Introduce a **minimal, forward-only migration runner** in `@chunsik/storage-sqlite`
(`migrations.ts`), keyed on SQLite's native `PRAGMA user_version`:
- `MIGRATIONS` is an ordered list of `{ version, name, up(db) }`. **Version 1 is the
  current baseline** — identical DDL to the pre-RC inline schema — so existing
  databases are unchanged.
- `runMigrations(db)` reads `user_version`, applies each migration with a higher
  version **inside its own transaction**, advances `user_version`, and returns the
  `{from, to, applied}` transition.
- Each `up` MUST be **idempotent** (`IF NOT EXISTS`, column-existence-guarded
  `ADD COLUMN`). A legacy DB (`user_version = 0`) re-runs the baseline as a no-op and
  is stamped forward — **fully backward compatible**.

This is **not** a persistence redesign: tables, columns, the JSON-`data` row model,
and all queries are unchanged. It only changes *how* schema is applied and adds a
version stamp. No new application functionality.

### Consequences
- + Schema evolution is ordered, versioned, transactional, and auditable.
- + Backward compatible with every existing `chunsik.db`.
- − Migrations must stay idempotent and append-only (forward-only; no down-migrations
  in v1 — acceptable for a local, single-file DB).

### V1 / V2
**V1:** `user_version`-keyed runner + baseline migration. **V2:** indexed/FK
migrations, and a richer migration history table if multi-node storage arrives.

---

## ADR-0021 — Logger / observability port

- **Status:** ✅ Accepted (v1, RC)
- **Date:** 2026-06-29

### Context
A `Logger` port (`info/warn/error(message, fields?)`) and a `ConsoleLogger` adapter
were introduced during the Sprint 1a observability cleanup (structured logs, no
`console.log`, secrets masked) but never recorded as a decision. §11.7 requires every
architectural seam to have an ADR; the V1 audit flagged the gap (W-4).

### Decision
Record the existing seam: **`@chunsik/core` defines a `Logger` port**; core services
log through it and never touch `console`. The composition root constructs a concrete
`ConsoleLogger` and passes it in (core via `ChunsikCoreDeps.logger`; adapters receive
their own instance). Logging is **structured** (message + typed fields), secrets are
masked before they reach the logger (ADR-0015), and full prompts/tokens are never
logged. The logger is wired by **direct construction**, not a DI token — acceptable
for a leaf, always-present cross-cutting concern.

### Consequences
- + Observability is swappable (file/JSON/remote transport later) without touching core.
- + No platform/console types leak into core.
- − No `LOGGER` token yet; if a future provider needs token-based override, add one
  then (cheap).

### V1 / V2
**V1:** `Logger` port + `ConsoleLogger`, direct-wired. **V2:** structured/JSON sink,
correlation ids, and a `TelemetryProvider` (see ADR-0010) if metrics are added.

---

## ADR-0022 — Workspace Capability (Read / Diff foundation)

- **Status:** ✅ Accepted (v2, Sprint 2a)
- **Date:** 2026-06-29

### Context
Version 2 is the first **architecture-first** capability work, and the foundation for
all future coding capabilities is the **Workspace**. v1 left the filesystem surface
(`resolve`/`readFile`/`listFiles`/`writeFile`/`gitStatus`/`runCommand`) as stubs. The
target flow is `Read → Analyze → Plan → Diff → Approval → Write → Execute → Commit`;
this ADR delivers only the **read-only Read + Diff** foundation. (Chief Architect review:
APPROVED WITH CHANGES.)

### Decision

**Workspace Capability ≠ Git Capability.** The Workspace owns the **filesystem**
abstraction; a future, separate **Git Capability** will own the **repository**
abstraction. They stay independent. This ADR introduces **no git** at all.

- **Read-only surface only:** implement `resolve`, `readFile`, `listFiles`, and a new
  `diff` on `WorkspaceProvider`. `writeFile`, `writeContextFiles`, `runCommand`, and
  `gitStatus` remain unimplemented stubs (write/exec are gated behind future approval
  slices; `gitStatus` belongs to the future Git capability).
- **`resolve(ref: WorkspaceRef)`** — the **core** (`WorkspaceManager.open(project)`)
  builds the pure `WorkspaceRef` (id + projectId + rootPath + `kind` from the bound
  provider). The provider receives only the ref and **never queries storage / resolves
  project ids** (cross-adapter dependency stays forbidden). A worktree provider later
  implements the same contract.
- **No git, no `child_process`, no shell** in this capability. Read/list/diff use
  `node:fs` only. (`scanProject`'s pre-existing git-branch probe is v1 registration code,
  ADR-0018, and is out of this capability's scope.)
- **Diff source = current file → proposed content → unified diff.** `diff(ref, changes)`
  reads each current file (read-only) and emits a unified `WorkspaceDiff`. It does **not**
  compare against git, repository history, or any repo state. This seam exists to feed the
  **Approval** gate in a later slice.
- **Diff engine is a mature library in the adapter** (`diff`/jsdiff), kept out of
  `@chunsik/core` so the **core remains dependency-free** and the engine stays replaceable
  with no provider-specific assumptions.
- **Sandbox + guards:** every read/list/diff path is confined to the workspace root
  (reject absolute paths, `..` traversal, and symlink escapes); secret-named and ignored
  entries (`node_modules/dist/build/.git/coverage`, `.env*`, secret/token/key/...) are
  excluded; per-file size guard (256 KB) and a list cap protect against large/runaway
  inputs; binary files are flagged, not diffed.

### Consequences
- + A production-grade, read-only Workspace foundation; later capabilities (worktree,
  patch, approval-gated write, Codex/Ollama execution) build on the same port.
- + Core stays filesystem-agnostic and dependency-free; all fs work is in the adapter.
- + `WorkspaceDiff` is the explicit pre-approval representation, designed before any write.
- − `WorkspaceManager.prepare(task)` cannot build a ref (a `Task` carries no rootPath); it
  is deferred (throws `NotImplementedError`) until the task→workspace wiring slice — callers
  with a `Project` use `open(project)`. No live path depends on it.
- − The read surface refuses secret-named files; a later capability may refine this.

### V1 / V2
**This slice (2a):** read-only `resolve`/`readFile`/`listFiles`/`diff`.
**Later V2 slices (separate ADRs):** Git Capability (`gitStatus`/working-tree diff),
worktree provider, approval-gated `writeFile`, `runCommand` execution, patch application.

### Amendment (Sprint 2a review — APPROVED WITH MINOR CHANGES, 2026-06-29)
Applied the Chief Architect's minor improvements (no scope added):
- **`WorkspaceRef`** keeps its stable `id`; added optional `metadata` for future
  providers (docker/ssh/remote). `kind` is the provider discriminator.
- **`WorkspaceDiff.estimatedChangedLines`** — total added+removed lines, computed once
  by the provider so future **Approval** workflows can size a change (5 vs 5000 lines)
  without recomputation.
- **`WorkspacePolicy`** value object (adapter; `DEFAULT_WORKSPACE_POLICY`) consolidates
  readable/ignored/secret/maxFileBytes/binary rules in one place; per-project/core-level
  configurable policies are a deliberate future extension.
- **Capability independence** (must hold throughout V2): Workspace owns *filesystem*,
  Git owns *repository*, Approval owns *authorization*, Patch owns *code transformation*
  — kept independent. Capability doc: `docs/capabilities/workspace.md`.

---

## ADR-0023 — CAP-002 Git Capability (read-only repository inspection)

- **Status:** ✅ Accepted (v2, Sprint 2b)
- **Date:** 2026-06-29
- **Capability:** CAP-002 — Git.

### Context
ADR-0022 deliberately left `gitStatus` a stub on `WorkspaceProvider` "until a future
Git capability." Approval/Patch/Workspace-Write will need trustworthy repository state
(branch, clean/dirty). Git must be a **separate** capability — `WorkspaceProvider` must
not know git exists. (Chief Architect review: APPROVED WITH CHANGES.)

### Decision
- **Git Capability is separate from Workspace Capability.** New `GitProvider` port
  (CAP-002) + `GIT_PROVIDER` token + `@chunsik/git-local` adapter (`LocalGitProvider`) +
  `GitManager` core service. **Workspace ≠ Git.**
- **Read-only in Sprint 2b.** Exactly three operations: `isRepository(rootPath)`,
  `info(rootPath) → RepositoryInfo`, `status(rootPath) → GitStatus`. **No** commit,
  checkout, branch, merge, reset, stash, push, pull, fetch, tag, add.
- **Worktree is NOT part of Sprint 2b** — no WorktreeProvider, no worktree methods, no
  reserved worktree operations. Mentioned only as a future relationship.
- **Remote URLs are intentionally excluded.** `RepositoryInfo` carries no remote/url
  field (HTTPS remotes can embed `user:token@host` credentials). Surfacing remotes needs
  a future masking policy + its own ADR. Stderr is sanitized before it surfaces.
- **Write operations require the future Approval capability** (CAP-003). Nothing in
  CAP-002 mutates a repository.
- **Git execution is adapter-only and argument-array based.** `LocalGitProvider` runs git
  via `spawnSync` with an **argv array** (never a shell string, never `shell: true`), a
  timeout, and the repository root as cwd. **Core stays `child_process`-free** and
  provider-agnostic.
- **Compose via `rootPath`.** `GitProvider` takes a plain path and imports **no** Workspace
  type (`WorkspaceRef`/`WorkspaceProvider`). Composition happens above both capabilities.
- **Relocation:** the `gitStatus` stub is **removed** from `WorkspaceProvider`; `GitStatus`
  moves to `domain/git.ts`; `WorkspaceManager.ensureSafe/status` move to
  `GitManager.requireClean/status`.

### Consequences
- + Clean Git/Workspace separation; a trustworthy repository-state source for future
  gated writes; no secret/remote surface in v1.
- + Core remains dependency-free and `child_process`-free; git isolated in one adapter.
- − A port relocation (single implementer, **no live caller**) + a new package.
- − `scanProject`'s git-branch probe (CAP-001/ADR-0018) still runs git inside
  `workspace-local`; relocating it to `GitProvider` is flagged follow-up debt, not 2b scope.

### Capability / Relations
**CAP-002.** Relates: ADR-0022 (CAP-001 Workspace), ADR-0018 (`scanProject`),
ARCHITECTURE.md §9. Capability doc: `docs/capabilities/git.md`.

### V1 / V2
**This slice (2b):** read-only `isRepository`/`info`/`status`.
**Later (separate ADRs):** masked remotes / ahead-behind; worktree (read then,
behind Approval, write); git writes (commit/checkout/branch) under Approval (CAP-003).

### Layering (responsibility split — stable for all of V2)
```
GitRunner    → Infrastructure   (argv-array spawn; the only thing that touches git/child_process)
GitProvider  → Port             (read-only contract: isRepository / info / status)
GitManager   → Application Service (orchestration: isClean / requireClean; composes by rootPath)
```
This split is an architectural invariant: the Manager never spawns, the Port never knows
the concrete runner, and only the adapter's Runner runs git.

### Amendment (final review — APPROVED WITH MINOR CHANGES, 2026-06-29)
- **GitStatus reserved fields** added as optional (`ahead`, `behind`, `isDetached`,
  `hasUnmergedPaths`) — declared now, **not populated** in 2b, to avoid future domain
  ripple for Approval/Patch/Workspace-Write.
- **RepositoryRef (future, non-blocking):** 2b passes `rootPath: string` (accepted). A
  dedicated `RepositoryRef { id, rootPath, provider, metadata }` may be introduced later
  as the Git sibling of `WorkspaceRef`. **`RepositoryRef` and `WorkspaceRef` must never
  reference each other** — sibling domain references; capabilities compose through them.
  Considered for CAP-003+, not built here.

---

## ADR-0024 — CAP-003 Planning Capability (deterministic ExecutionPlan)

- **Status:** ✅ Accepted (v2, Sprint 2c)
- **Date:** 2026-06-29
- **Capability:** CAP-003 — Planning.
- **Roadmap:** revised — Planning now precedes Approval. CAP-001 Workspace ✅ → CAP-002
  Git ✅ → **CAP-003 Planning** → CAP-004 Approval → CAP-005 Patch → CAP-006 Workspace
  Write → CAP-007 Command Execution → CAP-008 Codex → CAP-009 Ollama.

### Context
Every future execution flow (Approval → Patch → Write) needs a single, reviewable,
deterministic blueprint produced *before* any approval or code change. (Chief Architect
review: APPROVED WITH CHANGES, 98/100 — "treat Planning with the same importance as
Workspace and Git.")

### Decision
- **`ExecutionPlan` is the cross-capability execution contract** — produced by Planning,
  consumed by Approval (CAP-004) and Patch (CAP-005). Pure data; no behavior. Reserved
  shape: `id, goal, summary, steps, requiredCapabilities, requiredResources,
  estimatedChanges, approvalRequired, overallRisk, expectedArtifacts, status` (+ optional
  `projectId`, `createdAt`). `ExecutionStep { id, title, description, capability, status }`
  carries per-step `status` (future per-step approval/execution). `ExecutionStatus`
  reserves the lifecycle (PENDING/APPROVED/REJECTED/EXECUTING/COMPLETED/FAILED).
- **Strategy behind a port (no God Object):**
  `PlanningManager → ExecutionPlanner (Port) → DeterministicPlanner`. The strategy is
  replaceable; v2 ships **only `DeterministicPlanner`**. `AIPlanner`/`HybridPlanner` are
  future implementations behind the same port.
- **Deterministic only (Q1).** Planning is deterministic and **AI-free** in CAP-003. AI
  may *assist* later but **must never be the source of truth** — Planning owns the plan.
- **Composition by request (Q2).** `PlanningManager` receives all read-only context via
  `PlanningRequest`; it **must not import** `WorkspaceManager`/`GitManager`/any capability
  manager. Composition happens above Planning.
- **Distinct from the v1 `Plan` (Q3).** The v1 `Plan`/`Planner` remain the intra-task
  decomposition for the chat pipeline; `ExecutionPlan` is the V2 code-change contract.
  Not merged.
- **No persistence (Q4).** `ExecutionPlan` is in-memory only in CAP-003; persistence
  begins with Approval (CAP-004).
- **No orchestrator integration (Q5).** CAP-003 delivers only the domain model, the
  planner strategy, and the contracts — no user-facing wiring.
- **Ref model.** `ExecutionPlanRef { id, goal }` is how downstream capabilities reference
  a plan (sibling of `WorkspaceRef`/`RepositoryRef`) — communicate via refs, not imports.
- **Reuses `RiskPolicy`** for `overallRisk` (max over required capabilities) and
  `approvalRequired` (`requiresApproval`). No new risk model.

### Layering (responsibility split — stable for V2)
```
PlanningManager   → Application Service (thin: validate + delegate; no manager imports)
ExecutionPlanner  → Port               (replaceable strategy)
DeterministicPlanner → Strategy        (pure, deterministic, AI-free; reuses RiskPolicy)
```

### Consequences
- + A single, deterministic, testable contract upstream of all execution; strategy is
  swappable without touching the Manager; core stays pure and dependency-free.
- + `ExecutionPlan` becomes a project-wide contract (see `docs/execution-plan.md`).
- − A second plan concept beside the v1 `Plan` (bounded: distinct lifecycle/consumers).
- − v1 deterministic plans are only as rich as their inputs; AI-assisted enrichment is a
  future strategy (never the source of truth).

### Capability / Relations
**CAP-003.** Relates: ADR-0004 (Plan vs Workflow), ADR-0022 (Workspace), ADR-0023 (Git).
Docs: `docs/capabilities/planning.md`, `docs/execution-plan.md`.

### V1 / V2
**This slice (2c):** `ExecutionPlan` contract + `DeterministicPlanner` + `PlanningManager`.
**Later (separate ADRs/capabilities):** AIPlanner/HybridPlanner; persistence (CAP-004);
per-step approval; orchestrator/Intent wiring.

---

## ADR-0025 — CAP-004 Approval Capability (+ Aggregate Ownership Rule)

- **Status:** ✅ Accepted (v2, Sprint 2d)
- **Date:** 2026-06-29
- **Capability:** CAP-004 — Approval. The governance gate between an `ExecutionPlan`
  (CAP-003) and any code-changing capability. **First persisted V2 aggregate.**

### Aggregate Ownership Rule (project-wide principle)
> Each capability owns exactly one aggregate.
> Only the owning capability may mutate that aggregate.
> Other capabilities may reference, read, or consume it, but must not modify it.

For CAP-004: Approval owns `ApprovalRequest`; Approval may reference `ExecutionPlanRef`;
Approval must **not** mutate `ExecutionPlan`. (Owners: Planning→ExecutionPlan,
Approval→ApprovalRequest, Patch→PatchSet, Workspace Write→WorkspaceChange, Command
Execution→CommandExecution.) An ARCHITECTURE.md write-up may follow in a doc-refinement
sprint; the rule is binding from now.

### Decision
- **`ApprovalRequest` aggregate (Approval-owned), ExecutionPlan-based.** References the plan
  via `executionPlanRef`; persists `id, executionPlanRef, status, riskLevel, reason,
  requestedBy, decision?, decidedBy?, decidedAt?, comment?, createdAt, updatedAt` (+ optional
  `taskId` for v1 compat — **not** task-first, Q2). `ApprovalStatus = PENDING | APPROVED |
  REJECTED`.
- **`ApprovalRef` is plan-scoped** (`{ id, status, executionPlanRef }`) — amended per the
  CAP-005 review. It carries the `ExecutionPlanRef` so a downstream capability can verify an
  approval belongs to the plan it is acting on (referential integrity) without loading the
  aggregate. CAP-004 and CAP-005 share this contract.
- **Approval never mutates `ExecutionPlan` (Q1).** `ExecutionPlan` is an immutable planning
  output after creation; **approval state lives only on `ApprovalRequest`**. No
  `PLANNED → APPROVED` mutation of the plan. A global execution-state projection, if ever
  needed, is a separate model.
- **Deterministic `ApprovalPolicy`** — reuses `RiskPolicy.requiresApproval` (HIGH/CRITICAL).
  Required output: `requiresApproval, reason, riskLevel, requestedBy`. Reserved (NOT
  implemented): `approverRole?, expiresAt?, policyVersion?` — no role-based authorization,
  no expiry enforcement (Q4).
- **`ApprovalManager`** owns the aggregate: `requestFor(plan, requestedBy)` (auto-APPROVED
  when policy needs none, else PENDING), `decide(id, decision)`, `get`, `isApproved(planId)`.
  Reads the plan; never mutates it. No imports of other capability managers.
- **Persistence (first V2 aggregate):** `ApprovalRepository` port (`findByExecutionPlan`) +
  `SqliteApprovalRepository`, created by **migration v2** (`approvals` table) via the
  ADR-0020 runner. The old generic `approvals` stub is removed.
- **No `ExecutionStatus` change (Q3)** — recorded as a follow-up doc/refinement task.
- **No UI / orchestrator wiring (Q5)** — domain + policy + manager + persistence only. The
  orchestrator's dead V1 approval branch is neutralized (un-wired) to compile, not rewired.

### Consequences
- + The governance backbone for all future writes; strict aggregate ownership prevents
  drift; first real persisted V2 aggregate exercising the migration runner.
- + ExecutionPlan stays a pure, immutable planning output.
- − Approval state and plan state live in separate aggregates (by design) — consumers read
  both. A unified execution-state projection is deferred.

### Capability / Relations
**CAP-004.** Relates: ADR-0024 (Planning/ExecutionPlan), ADR-0020 (migrations), ADR-0010.
Docs: `docs/capabilities/approval.md`, `docs/execution-plan.md`.

### V1 / V2
**This slice (2d):** `ApprovalRequest`/`ApprovalRef`/`ApprovalStatus`, `ApprovalPolicy`,
`ApprovalManager`, `ApprovalRepository` + SQLite + migration v2.
**Later:** Discord approval UI + orchestrator wiring; approver roles; expiry; per-step
approval; the Aggregate Ownership Rule in ARCHITECTURE.md.

---

## ADR-0026 — CAP-005 Patch Capability (generate, never apply)

- **Status:** ✅ Accepted (v2, Sprint 2e)
- **Date:** 2026-06-29
- **Capability:** CAP-005 — Patch. Turns an approved plan's proposed changes into a
  durable, reviewable, **immutable** `PatchSet`.

### Most important rule (permanent separation)
> **Patch represents modifications. Patch never applies modifications.
> Workspace Write (CAP-006) applies approved `PatchSet`s.**
These capabilities must never be merged.

### Decision
- **Patch owns `PatchSet`, `PatchOperation`, `PatchRef`.** It does **not** own filesystem,
  repository, execution, approval, or workspace mutation.
- **Generation only (Q1).** `PatchManager.generate` creates a `PatchSet`; it never applies it,
  never writes files, never touches git. The `PatchSet` is **immutable** after creation
  (no `updatedAt`).
- **`PatchStatus` is minimal: `GENERATED` only (Q2).** `APPLIED`/`FAILED`/`EXECUTED` belong to
  Workspace Write / Command Execution, never to Patch.
- **Approval enforced on the passed Ref (Q3).** `generate` requires
  `approvalRef.status === APPROVED` (deterministic check); `PatchManager` does **not** query
  `ApprovalManager`. Composition happens above Patch; capability managers stay independent.
- **Referential integrity (CAP-005 review).** `ApprovalRef` is **plan-scoped**
  (`{ id, status, executionPlanRef }`); `generate` additionally requires
  `approvalRef.executionPlanRef.id === input.executionPlanRef.id` and rejects an approval
  from a different plan. This guarantees the approval governs the plan being patched.
- **Explicit inputs (Q4).** `changes: ProposedChange[]` and `diff: WorkspaceDiff` are received
  **independently** (not pre-merged) so future generators can use them differently. v1 maps
  each change to its `FileDiff` to build a `PatchOperation` (path, operation, diff, metadata?).
- **`PatchOperation`** is a value object: `path`, `operation` (`add`/`update`/`delete`),
  `diff` (unified text), optional `metadata` — no filesystem mechanics, no raw `newContent`.
  CAP-001's `modify` maps to `update`.
- **Persistence (Q5):** `PatchSet` persists exactly `id (PatchRef)`, `executionPlanRef`,
  `approvalRef`, `operations[]`, `status`, `createdAt` — nothing more. `PatchRepository` +
  `SqlitePatchRepository` + **migration v3** (`patches` table).
- **Aggregate Ownership (ADR-0025):** Patch owns `PatchSet`; references `ExecutionPlanRef` /
  `ApprovalRef` (read-only); never mutates them. Ref-based communication only.
- **Immutability for downstream:** Workspace Write must consume the `PatchSet` exactly as
  produced — never regenerate or reinterpret it — preserving deterministic execution.

### Consequences
- + Clean Patch/Write separation; an immutable, reviewable, persisted change unit; reuses
  CAP-001's diff and the ADR-0020 migration runner.
- + Patch performs no I/O beyond persistence; cannot mutate the workspace.
- − A `PatchSet` carries unified diffs (not raw content); Workspace Write applies the diff.

### Capability / Relations
**CAP-005.** Relates: ADR-0022 (WorkspaceDiff), ADR-0024 (ExecutionPlan), ADR-0025
(Approval + Aggregate Ownership), ADR-0020 (migrations). Docs: `docs/capabilities/patch.md`.

### Out of Scope (deferred)
Patch application, file writing, git apply/commit, workspace mutation, execution, rollback,
AI provider integration, command execution — all later capabilities.

---

## ADR-0027 — CAP-006 Workspace Write Capability (apply, not generate)

- **Status:** ✅ Accepted (v2, Sprint 2f)
- **Date:** 2026-06-30
- **Capability:** CAP-006 — Workspace Write. **The first capability that mutates the
  filesystem.** Owns the `WorkspaceChange` **Execution History** aggregate.

### Most important rule
> **Patch generates. Workspace Write applies.** Workspace Write consumes an immutable
> `PatchSet` and applies its operations to the workspace; it never generates patches,
> never calls git, never runs commands.

### Decision
- **Owns `WorkspaceChange`** (+ `WorkspaceChangeRef`, `WorkspaceChangeStatus`,
  `FileChangeResult`). Mutates only this aggregate. **Never mutates** `PatchSet`/
  `ExecutionPlan`/`ApprovalRequest` (Aggregate Ownership Rule, ADR-0025) — references via Refs.
- **Apply flow:** `WorkspaceWriteManager.apply({ patchSet, approvalRef, workspaceRef })` →
  `WorkspaceChange` → `WorkspaceWriter` (port/adapter). The writer never generates patches.
- **Approval (Ref only):** requires `approvalRef.status === APPROVED` **and**
  `approvalRef.executionPlanRef.id === patchSet.executionPlanRef.id` (plan-scoped referential
  integrity, ADR-0025/0026). Does **not** query `ApprovalManager`.
- **Repository independence:** **no git, no commit, no repo mutation, no `child_process`** in
  Workspace Write. The `WorkspaceWriter` adapter uses `node:fs` only.
- **PatchSet is immutable**, consumed exactly as produced (no regenerate/reinterpret).
- **Patch revision contract (CAP-006 review).** `WorkspaceChange` persists `patchHash` — a
  deterministic content hash of the applied PatchSet's operations (pure `contentHash`, no
  `node:crypto`). The Execution History records EXACTLY which patch revision it applied
  (basis for conflict detection / resume / rollback / audit). Re-applying the **same**
  revision keeps status-based idempotency; a **different** revision for the same PatchSet id
  is **refused** (`WorkspaceChange` is not reused across revisions).

### CA Planning-review changes (Round 2)
- **Best-effort, not stop-on-first-failure.** Every operation is attempted; each yields a
  `FileChangeResult` (`applied`/`failed`/`skipped`). Final status is derived after all attempts.
- **`WorkspaceChangeStatus` = `PENDING | APPLYING | APPLIED | PARTIALLY_APPLIED | FAILED`**
  (Rollback-capability-stable).
- **Idempotency is status-based.** One `WorkspaceChange` per `PatchSet`: `APPLIED` → no-op;
  `FAILED`/`PARTIALLY_APPLIED`/`APPLYING` → re-attempt on the same aggregate.
- **Atomic unit = file** (temp-write + rename, or unlink). A PatchSet is not a transaction.
- **`FileChangeResult` = `{ path, operation, status, message, durationMs }`** — the
  Execution-History record.

### Consequences
- + A complete, auditable execution record (best-effort, per-file); clean apply/generate
  separation; reuses CAP-001 diff (jsdiff `applyPatch`) + the ADR-0020 migration runner (v4).
- + Repository-independent — git recovery/rollback handled by future capabilities, not here.
- − Multi-file apply is not atomic (file is the atomic unit); partial state is precisely
  recorded for a future Rollback capability.

### Out of Scope (deferred — Non-blocking, CA-confirmed)
**Rollback** (future capability, may use Git capability), **Resume** (CAP-006 records only,
no resume engine), git recovery, command execution, AI provider integration. Workspace Write
stays Repository-Independent. `WorkspaceChange` is the **Execution History** starting point
that CAP-007 Command Execution may later consume.

**Reserved (NOT implemented now — future candidates):** a `ROLLBACK_REQUIRED`
`WorkspaceChangeStatus` (added when the Rollback capability lands); `startedAt`/`finishedAt`
on `FileChangeResult` (the VO is kept open for this). Recorded here per the CAP-006 review;
no code added.

### Capability / Relations
**CAP-006.** Relates: ADR-0026(Patch), ADR-0025(Approval/Ownership), ADR-0022(Workspace diff),
ADR-0020(migrations). Docs: `docs/capabilities/workspace-write.md`.

## ADR-0028 — CAP-007 Command Execution Capability (run, gated)

- **Status:** ✅ Accepted (v2, Sprint 2g)
- **Date:** 2026-06-30
- **Capability:** CAP-007 — Command Execution. **The riskiest capability** (arbitrary
  process execution) and the **last aggregate of the Execution Ledger**. Owns the
  `CommandExecution` Execution-History aggregate.

### Most important rule
> **Workspace Write applies files. Command Execution runs commands.** Command Execution
> runs ONE command inside a workspace via an argv array (never a shell); it never edits
> files, generates patches, calls git, or calls AI. Every run passes three deterministic
> gates BEFORE the runner is invoked.

### Decision
- **Owns `CommandExecution`** (+ `CommandExecutionRef`, `CommandExecutionStatus`). Mutates
  only this aggregate. **Never mutates** `ExecutionPlan`/`ApprovalRequest`/`PatchSet`/
  `WorkspaceChange` (Aggregate Ownership Rule, ADR-0025) — references via Refs.
- **Run flow:** `CommandExecutionManager.run({ executionPlanRef, approvalRef?, workspaceRef,
  workspaceChangeRef?, command, args, timeoutMs? })` → three gates → `CommandRunner`
  (port/adapter) → record a `CommandExecution`.
- **Execution Ledger:** `ExecutionPlan → ApprovalRequest → PatchSet → WorkspaceChange →
  CommandExecution`. CommandExecution may reference the `WorkspaceChange` it follows.
- **Adapter isolation:** all process execution in `@chunsik/command-local`
  (`node:child_process`, **argv array, `shell:false`, required timeout, cwd = workspace
  root, minimal env by default, masked + size-capped output**). **Core stays `child_process`-free.**
- **Four-part execution-safety boundary** (CA Architecture Note): (1) command allow-list,
  (2) dangerous-arg blocking, (3) minimal child env, (4) output masking + size cap.
- **`runCommand` relocated off `WorkspaceProvider`** → the `CommandRunner` port (mirrors the
  CAP-002 `gitStatus` move). Workspace ≠ Command Execution.

### CA Planning-review — Merge-Blocking changes (Round 1)
- **MB-1 Command Identity.** `CommandExecution.commandHash` = a deterministic content hash
  of `command` + `args` (pure `contentHash`, no `node:crypto`). The Execution History
  identifies EXACTLY what ran — the basis for audit / duplicate detection / resume, and for
  a future Execution Orchestrator's retry. (Reuses the CAP-006 revision-contract pattern.)
- **MB-2 Approval policy (deterministic, Ref-only).** `RiskPolicy.assessCommand` classifies
  the command: **LOW/MEDIUM → no approval**; **HIGH → an APPROVED, plan-scoped `ApprovalRef`
  is required** (referential integrity: `approvalRef.executionPlanRef.id === executionPlanRef.id`,
  no `ApprovalManager` query); **CRITICAL (destructive pattern) → refused outright, regardless
  of approval.**
- **MB-3 Allow-list.** v2 permits only **`pnpm` / `npm` / `node`** (exact match, fails closed —
  e.g. `/usr/bin/node` and `git` are refused). Enforced in the manager BEFORE the runner runs.

### CA Implementation-review — Merge-Blocking changes (Round 2)
- **Minimal child env (not full `process.env`).** The runner must NOT pass the full parent
  environment to a child by default (an allow-listed `node` could read local secrets, e.g.
  `node -e "console.log(process.env)"`). `defaultRawRunner` passes a **minimal env (PATH/HOME)**
  when none is supplied; callers may override with an explicit allow-listed env. Contract:
  *Command Execution must not pass the full parent process environment to child processes by default.*
- **Allow-list is command + dangerous-arg aware (not command-name only).** A command-name-only
  allow-list is bypassable via eval-style flags (`node -e "…"` runs arbitrary JS). The manager
  refuses eval-style `node` args (`-e` / `--eval` / `-p` / `--print`, incl. `=value` and short
  clusters like `-pe`) BEFORE the runner. Contract: *Allow-list must be command + dangerous-arg
  aware, not command-name only.*

### Non-blocking (CA-confirmed; NOT implemented now)
ExitCode-as-Value-Object (kept a plain `number`, structure open); explicit Runner →
CommandResult → CommandExecution responsibility split (already separated); streaming output
(future ADR); **retry (Execution Orchestrator's responsibility, not CAP-007)**; background /
long-lived processes (out of scope); a higher Execution-History aggregate; externalizing the
command policy (allow-list / env) to config. (Round-2 review confirmed these stay deferred.)

### Consequences
- + A complete, auditable, identity-stamped execution record; the project's primary
  execution-safety boundary (no shell, allow-list, risk + approval gating, masked output).
- + Reuses `CommandResult` (CAP-001), `RiskPolicy.assessCommand`/`requiresApproval`, the
  ADR-0020 migration runner (v5 `command_executions`), and the secret-masking approach.
- − Allow-list + CRITICAL refusal are conservative by design; widening them is a future
  policy decision (config/per-project), not a code change to the gate.

### Capability / Relations
**CAP-007.** Relates: ADR-0027(Workspace Write), ADR-0026(Patch), ADR-0025(Approval/Ownership),
ADR-0023(Git relocation precedent), ADR-0020(migrations). Docs:
`docs/capabilities/command-execution.md`.

## ADR-0029 — CAP-008 AI Code Generation Capability (Codex; propose, never apply)

- **Status:** ✅ Accepted (v2, Sprint 2h)
- **Date:** 2026-06-30
- **Capability:** CAP-008 — AI Code Generation. **The first AI Layer capability.** "Codex" is
  the first *provider*; the capability is provider-agnostic. Owns the `CodeGeneration` (run) and
  `CodeProposal` (output) aggregates.

### Most important rule
> **The AI proposes; it does not decide, approve, apply, or execute.** AI Code Generation asks a
> code-capable provider to author a **proposal** (`ProposedChange[]`); Decision/Approval/Apply/
> Execution stay with the existing capabilities (Planning/Approval/Patch/Workspace Write/Command).
> The AI is never a source of truth.

### Decision
- **Owns `CodeGeneration` (run) + `CodeProposal` (output)** — the AI Layer owns BOTH (CA Round-1).
  `CodeGeneration` holds only a `CodeProposalRef`; the heavy data (`ProposedChange[]`, providerId,
  usage?, artifacts?) lives on `CodeProposal`. Mutates only these; references plan/workspace via Refs.
- **Generate flow:** `PromptComposer` (authorship) → `PromptSpec` → **`PromptRenderer`** (rendering)
  → **`AiRequest`** → (`ProviderSelector`) → `AiProvider.execute` → parse → `CodeGeneration`
  (+ `CodeProposal`). Exactly ONE generation per call (no retry — Orchestrator's concern).
- **Reuses the `AiProvider` port, input narrowed to `AiRequest` (CA Round-1 MB-2):** the provider
  no longer renders prompts or sees a `PromptSpec`; rendering moved from the CLI adapter
  (`renderPromptSpec`) to the core `PromptRenderer`.
- **Codex adapter execution is DEFERRED (implementation-review MB-1).** `CodexCliProvider.execute()`
  stays **NotImplemented**: the Codex CLI has no deterministic suggest-only / no-tool / no-exec mode
  (`codex exec --sandbox read-only` is read-only AGENT execution — a tool loop — not proposal-only),
  which would cross the CAP-008 boundary. Because `isAvailable()` also throws, the provider is
  treated as unavailable and never selected. Real Codex execution awaits a verified suggest-only
  contract (future PR / Agent Runtime). The capability is provider-agnostic and runs on any
  suggest-only `AiProvider` (proven via a fake provider in tests).
- **No workspace bypass (implementation-review MB-2).** The AI Code Generation `AiRequest` carries
  **no workspace cwd** — handing a provider the workspace root would let it read/traverse the repo
  itself, bypassing the Workspace Read capability (CAP-001). Read-only context flows only via
  `contextFiles`/`prompt`; the `workspaceRef` is recorded on the aggregate but never given to the
  provider. Direct workspace access is future Agent-Runtime scope.
- **`ProviderSelector` (CA Round-1 MB-3):** provider selection extracted from `CapabilityRouter`
  (now its implementation, method `select`); the capability depends on the selection contract.
- **Provider-agnostic proposal parsing** in core (`parseCodeProposal`): one fenced ```json
  envelope → `ProposedChange[]`; malformed output → FAILED. Identical for Codex and Ollama.
- **Adapter isolation:** the provider owns all external AI interaction (process/auth/timeout/
  transport-retry/masking/failure classification, ADR-0015). **Core stays HTTP/`child_process`-free.**
- **Persistence:** `CodeGenerationRepository` + `CodeProposalRepository` + Sqlite + **migration v6**
  (`code_generations`, `code_proposals`).

### AI-Layer Aggregate Ownership Rule (CA Round-1 MB-4)
> Planning owns ExecutionPlan · Approval owns ApprovalRequest · Patch owns PatchSet ·
> Workspace owns WorkspaceChange · Command owns CommandExecution ·
> **AI owns CodeGeneration (and CodeProposal)** · **AI never owns any downstream aggregate.**

### Non-blocking (CA-confirmed; NOT implemented now)
`generationHash` (the planned `promptHash` was dropped), `providerVersion`/`modelVersion`,
Proposal Lifecycle, Prompt Version; Provider Cost, Token Usage accounting (`CodeProposal.usage?`
is a reserved passthrough only), Provider Capability modelling, Failure-Taxonomy extension;
tool-calling/agentic loops, conversation state, generation-level retry, streaming.

### Consequences
- + A clean, provider-agnostic AI Code Generation seam (Codex now; Ollama adds only an adapter,
  CAP-009) with a strict propose-only boundary; reuses `AiProvider`/`ProviderSelector`/`PromptRenderer`,
  the ADR-0015 failure taxonomy, and the ADR-0020 migration runner (v6).
- − Narrowing `AiProvider` to `AiRequest` touched the existing Claude/chat path (rendering moved to
  `PromptRenderer`; orchestrator renders before `execute`); guarded by the regression suite.

### Capability / Relations
**CAP-008.** Relates: ADR-0014(CLI providers), ADR-0015(AI failure taxonomy), ADR-0003(prompt
layering), ADR-0024(Planning), ADR-0026(Patch), ADR-0025(Aggregate Ownership), ADR-0020(migrations).
Docs: `docs/capabilities/code-generation.md`.

## ADR-0030 — CAP-009 Ollama AI Code Generation Provider (second adapter; suggest-only)

- **Status:** ✅ Accepted (v2, Sprint 2i)
- **Date:** 2026-06-30
- **Scope:** CAP-009 is **not a new capability.** It is the **second `AiProvider` adapter** for the
  CAP-008 AI Code Generation capability (ADR-0029). It is the *proof* that the AI Layer contract is
  provider-agnostic: a different backend authors a `CodeProposal` with **no Core-contract change**.

### Most important rule
> **CAP-009 stays a Provider Adapter — never expand it into a new capability.** Ollama serves the
> existing AI Code Generation capability through the existing `AiProvider` port. No new aggregate,
> manager, port, repository, or migration. The AI still only *proposes*.

### Decision
- **Implement `OllamaCliProvider.execute(AiRequest)` + `isAvailable()`** in `@chunsik/ai-cli`,
  behind the **existing** `AiProvider` port (via `BaseCliAiProvider` + `CliRunner`). No Core change.
- **Suggest-only is honest for Ollama (the key distinction from Codex, ADR-0029).** `ollama run
  <model>` is **single-shot text generation** — no tools, no exec, no file access, no plan-act
  loop — so it cannot autonomously act and satisfies the propose-only boundary by construction.
  (Codex's CLI has no deterministic suggest-only mode → it stays NotImplemented/unavailable.)
- **Invocation:** `ollama run <model>` with the prompt on **stdin** (never an argv), in a
  **neutral cwd** (`tmpdir()`) — a local model never needs the repo and must not ingest it
  (defense in depth atop CAP-008's no-workspace `AiRequest`). Output masked (`maskSecrets`).
- **Failure taxonomy (ADR-0015):** `timedOut → TIMEOUT`; spawn failure (`code === null`) →
  `UNAVAILABLE`; non-zero exit → `EXECUTION_FAILED`; empty stdout → `EMPTY_OUTPUT`. **No
  `AUTH_REQUIRED`** — Ollama is local and auth-free.
- **Selection data:** Ollama advertises `CODE_IMPLEMENTATION` at **priority 40** — *below* Claude's
  50 — so Claude is preferred for code when available and Ollama is the local/offline fallback.
  (Codex advertises 100 but is unavailable, so it never competes.) Selection stays data-driven via
  `ProviderSelector`; Core never names `'ollama-cli'` or branches on `id`.
- **Wiring:** `OllamaCliProvider` is added to `AI_PROVIDERS` (`app.module.ts`), constructed from the
  existing `OLLAMA_CLI_BIN`/`OLLAMA_MODEL` config seam. **`isAvailable()`-gated:** an environment
  without `ollama` sees no runtime change (provider treated as unavailable, never selected).
- **`parseCodeProposal` is unchanged** — the provider-agnostic parser already handles Ollama output
  identically (CAP-008 parity).

### Runtime consequence (intentional, surfaced)
- Ollama already advertises `GENERAL_CHAT`/`SUMMARIZATION`/`EMBEDDING` at priority **100** (> Claude
  50, pre-existing data). Implementing `execute()` + wiring therefore means that **on a machine where
  `ollama` is available, the live chat/summarization path prefers Ollama** (local-first; Claude
  remains the fallback). These priorities are pre-existing and left unchanged (CA decision #5 keeps
  the `EMBEDDING` descriptor; the embedding *execution* path is out of scope). No environment without
  `ollama` is affected.

### Not implemented (CA-confirmed out of scope)
New capability/aggregate/manager/port/repository/migration; any Core-contract change; **any change to
Codex** (stays NotImplemented); tool calling, Agent Runtime, embedding/vector path, streaming, model-
pull UX, per-request model override, generation retry, orchestrator/Discord wiring of code generation.

### Consequences
- + A second, **local-first** code-generation provider behind the same contract — the
  provider-independence of CAP-008 is now demonstrated, not just asserted. Smallest capability
  increment in V2: one adapter method pair + one `capabilities[]` entry + one wiring line.
- − Where `ollama` is present, chat/summarization now route to it by priority (see Runtime
  consequence); guarded by the regression suite and `isAvailable()`.

### Capability / Relations
**CAP-009** (provider adapter for CAP-008). Relates: **ADR-0029**(CAP-008 AI Code Generation —
primary), ADR-0014(CLI providers), ADR-0015(AI failure taxonomy), ADR-0003(prompt layering).
Supersedes nothing. Docs: `docs/capabilities/code-generation.md`.

## ADR-0031 — Execution Orchestrator (Application-layer capability composition)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2j)
- **Date:** 2026-07-01
- **Scope:** The **first Application-layer composition** (Phase 2). Phase 1 (Capability Layer,
  CAP-001…009) is closed. This is **not a new capability** — it composes the completed
  capabilities into one safe execution flow: `Intent Resolver → Execution Orchestrator →
  Capability Managers`. Planning review approved over two rounds (Round-1 Merge-Blocking:
  Capability Selection, ExecutionContext, Cancellation Contract — all applied; Round-2 APPROVED).

### Most important rule
> **The Execution Orchestrator composes capabilities; it never does their work, and it owns no
> aggregate.** Capability managers stay **mutually unaware** — only the orchestrator composes them.
> Provider selection stays with `ProviderSelector` (orchestration-level **Capability Selection** is
> a different concern: *which capability stages run*). It is intra-task composition — **not** the
> `Workflow` engine and **not** the Agent Runtime.

### Decision
- **Capability Selection is the orchestrator's first responsibility** (Round-1 MB-1). `selectStages`
  maps a request's `requiredCapabilities` to an **ordered subset** of the canonical stages
  (`PLANNING → CODE_GENERATION → WORKSPACE_DIFF → APPROVAL → PATCH → WORKSPACE_WRITE →
  COMMAND_EXECUTION`); a given execution runs **only** the selected stages. The pipeline is
  **dynamic, not fixed** (analyze-only → `[PLANNING]`; run-tests → `[PLANNING, APPROVAL,
  COMMAND_EXECUTION]`; code-change → the full chain).
- **Stateless / aggregate-free** (CA-confirmed). No `ExecutionFlow` aggregate, no table, no
  repository. The `ExecutionPlan` is the **correlation root** (every downstream aggregate carries
  `executionPlanRef`); progress is derived from the capabilities' aggregates. The orchestrator
  returns a **transient `ExecutionOutcome`** read-model and persists nothing.
- **Ref-threading composition.** Each stage calls one existing manager and passes the Ref the next
  consumer needs (`ExecutionPlanRef`, plan-scoped `ApprovalRef`, `ProposedChange[]` + `WorkspaceDiff`,
  `PatchSet`, `WorkspaceChange`). The orchestrator depends on **narrow public method interfaces**, not
  concrete managers; managers never import each other.
- **ExecutionContext** (Round-1 MB-2): a transient, per-invocation Application-layer context
  (`executionPlanRef`, `workspaceRef`, `projectId`, `requestedBy`, `selectedStages`, `logger`,
  `cancelToken?`). **Not an aggregate, never persisted**, rebuilt on each `run`/`resume`.
- **Approval halt + resume** (CA-confirmed). When `ApprovalManager.requestFor` returns PENDING
  (HIGH/CRITICAL), the orchestrator returns `AWAITING_APPROVAL` and **halts** — it **never calls
  `decide`**. `resume(request, priorOutcome, cancelToken?)` re-reads the approval aggregate and, only
  if APPROVED, reconstructs the proposal/diff from refs and runs Patch→Write→Command; PENDING ⇒
  re-halt, REJECTED ⇒ `DENIED`. Resume **wiring** (who triggers it) is deferred (Conversation Runtime).
- **Cancellation Contract** (Round-1 MB-3). `RUNNING → CANCELLED → TERMINAL`: a cooperative
  `cancelToken` is checked at each **stage boundary** (and during the approval wait); on signal the
  orchestrator **stops without calling the next capability** and returns `CANCELLED`. **No
  compensation/rollback** — already-applied changes remain. `CANCELLED` lives on `ExecutionOutcome`
  only; **no capability aggregate** gains a cancelled status from the orchestrator.
- **Failure rule.** A failed stage (a FAILED/!success aggregate status, or a thrown manager error) ⇒
  `STOPPED_ON_FAILURE` naming the stage; the next capability is **not** called. **No retry** (the
  future Agent Runtime's concern).
- **Intent Resolver** (Application service): maps a classified `Intent` (execution capabilities only)
  to an `ExecutionRequest`, else `null`. It does not classify (`IntentClassifier`) or plan (Planning).

### Not implemented (CA-confirmed out of scope)
Workflow Engine · Conversation Runtime · Agent Runtime · Retry · Event Bus · Parallel Execution ·
Telemetry · Memory · Discord Integration. Also **not** wired into `ChunsikCore`/composition root yet
(standalone Application services; wiring is the future Conversation Runtime slice). **Non-blocking
(future):** Execution Hooks (`beforeCapability`/`afterCapability`); ExecutionOutcome-based pipeline
visualization (a Presentation-layer concern).

### Consequences
- + The Execution Ledger capabilities (CAP-003…009), previously unwired, now have a safe
  composition layer — the first step toward an end-to-end flow — with no Core-contract change and no
  new aggregate.
- − Resume/cancel are contracts without runtime wiring yet (no UI signals them); covered by
  fake-manager tests, exercised end-to-end only once the Conversation Runtime lands.

### Capability / Relations
**Sprint 2j** (Application Layer; not a capability). Relates: ADR-0024(Planning), ADR-0025(Approval +
Aggregate Ownership), ADR-0026(Patch), ADR-0027(Workspace Write), ADR-0028(Command Execution),
ADR-0029(AI Code Generation), ADR-0013(YAGNI on `Workflow`/seams). Supersedes nothing.
Plan: `docs/plans/sprint-2j-execution-orchestrator-plan.md`.

## ADR-0032 — Conversation Runtime (Application-Layer runtime entry; stateless composition)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2k — first **Product Construction** sprint)
- **Date:** 2026-07-01
- **Scope:** The **conversation entry point** of 춘식봇 — an Application-Layer Runtime that turns one
  user message into one natural assistant response by **composing** existing Application/Capability
  services. It is **not** a new execution engine, **not** a Capability, and **not** a new Aggregate.

### Invariants (must always hold)
> - **Conversation Runtime must not persist runtime state.**
> - **Approval-awaiting state is derived from existing Session / Task / ExecutionPlan / ApprovalRequest state.**
> - **Session must not store runtime snapshots.**

### Decision
- **Runtime entry / `ChunsikCore` relationship.** `ConversationRuntime` owns the full per-message
  flow; **`ChunsikCore` is a thin facade** that delegates to it and performs platform delivery:
  `Platform Adapter → ChunsikCore (facade) → ConversationRuntime.handle() → OutboundMessage → ChunsikCore delivers`.
  There is exactly ONE entry — no parallel `ChunsikCore`/`ConversationRuntime` paths.
- **Owns (flow + transient state only):** per-message flow; Session open/touch ordering; short-term
  memory record order; intent branching; **approval halt/resume routing**; outcome→response mapping;
  a **transient** `TurnResult`. **Does NOT own:** capability execution, approval policy, planning,
  patch, workspace mutation, command execution, provider selection, retry, autonomous loops, or any
  **persistent** runtime state. It is a **composer**, never a decider/executor.
- **Full conversational flow ownership.** One runtime branches internally across: chat ·
  project-analysis · register · execution · approval-resume · failure/cancel response. The user
  experiences a conversational assistant, not an "execution runtime".
- **Transient runtime model (NO new aggregate).** `RuntimeTurnStatus =
  RESPONDED | AWAITING_APPROVAL | DENIED | FAILED | CANCELLED`; `ConversationRuntime.handle(message:
  InboundMessage): Promise<TurnResult>`; `TurnResult` carries the status + the `OutboundMessage` +
  `sessionId` (+ optional `ExecutionOutcome`). **No `Turn`/`Conversation`/`Message` aggregate, no
  `RuntimeState` table, no `TurnRepository`, no migration.**
- **Stateless approval resume — fixed correlation source (the ONE source):**
  `Session.activeTaskId → Task.planId → approvals.findByExecutionPlan(planId) → PENDING ApprovalRequest`.
  An execution turn that halts anchors itself to the in-focus `Task` (existing `Task.planId` =
  the produced `ExecutionPlan` id; existing `Session.activeTaskId` = that task). The runtime
  **persists nothing itself** and stores **no snapshot on `Session`**; it re-derives the pending
  approval from these existing aggregates each turn (via the injected `ApprovalFlow` collaborator).
  Forbidden: `Session.runtimeState`, approval snapshot on `Session`, a `ConversationRuntimeState`
  repository, or recovering pending approval by parsing memory text.
- **`StatelessApprovalFlow` (production `ApprovalFlow`).** On a halt it **anchors** the in-flight
  `{request, prior}` on the in-focus **`Task.metadata`** (the Task capability's own field — not a
  Session snapshot, no new store) with `Task.planId` = the plan id, and points `Session.activeTaskId`
  at it. `reconstructResume` reads that back (validating `Task.planId === approval.executionPlanRef.id`)
  to supply the `{request, prior}` that `ExecutionOrchestrator.resume` requires — so resume is
  genuinely functional (no orchestrator-contract change). The approve path **reconstructs FIRST and
  only calls `ApprovalManager.decide` once reconstruction succeeds** — never record a decision that
  cannot be acted on; if reconstruction fails the runtime re-asks.
- **Approval-decision interpretation (only when pending).** The runtime interprets a user message as
  an approval decision **only** when a PENDING approval is derived for the session. Minimal,
  platform-agnostic contract: approve = {승인, 진행, 좋아, yes, y, ok}; deny = {거절, 아니, no, n};
  cancel = {취소, 중단, 그만}; otherwise **ambiguous** → re-send the approval notice, **no `resume`**.
  When pending, the decision interpretation takes priority over normal intent; with no pending
  approval, those same words are ordinary intent. The decision itself is owned by
  `ApprovalManager.decide`; resume goes through `ExecutionOrchestrator.resume` (its contract is
  **unchanged** — the runtime supplies `{request, prior}` via the injected `reconstructResume`
  collaborator). The runtime never judges approval policy; the orchestrator never parses the message.
- **Short-term memory only.** Reuse existing short-term conversation memory: record the user turn,
  record the assistant turn, read history, request context via `ContextBuilder`. **No** long-term /
  vector / working memory, no memory repository/schema/format change.
- **Platform delivery boundary.** The runtime's essential output is an **`OutboundMessage`**;
  platform-specific delivery stays **outside** the runtime (the `ChunsikCore` facade calls
  `PlatformAdapter.sendMessage`).
- **ResponseComposer boundary.** The runtime never builds natural-language text; it maps outcomes via
  `ResponseComposer` (`composeExecutionResult` + `composeApprovalRequired` added this sprint, alongside
  `composeApprovalNotice` / `composeError` / `compose`). A fresh execution that halts at
  `AWAITING_APPROVAL` (only a plan-scoped ref in hand) replies via `composeApprovalRequired`.

### Not implemented (CA-confirmed out of scope)
Agent Runtime; Tool Calling; Retry / loop / reflection; Workflow Engine; Background Task; Discord UI
(buttons/interaction-ids); Telemetry/Metrics; any new memory subsystem; **new aggregate / repository
/ migration / capability**; any Core-contract change; any change to a capability manager or to the
`ExecutionOrchestrator` contract.

### Consequences
- + 춘식봇 has a single coherent conversation entry that composes the whole stack (chat → execution →
  approval → resume → response) with **no new structure** — the first Product-Construction step.
- − Cross-turn resume reconstruction (`StatelessApprovalFlow`) anchors `{request, prior}` on
  `Task.metadata`; the platform UI (approval buttons) and richer failure recovery mature with later
  Product sprints.

### Relations
ADR-0001 (Session, thin), ADR-0017 (short-term memory), ADR-0031 (Execution Orchestrator),
ADR-0025 (Approval), ADR-0015 (failure taxonomy / kind replies), ADR-0003 (prompt/context layering).
Supersedes nothing. Plan: `docs/plans/sprint-2k-conversation-runtime-plan.md`.

## ADR-0033 — Live Test Execution (first reachable execution Product slice)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2l — Product Construction)
- **Date:** 2026-07-01
- **Scope:** Open the (already-built but unreachable) execution pipeline for the smallest, safest
  Product slice: a user asking to run tests. **Reuse only** — no new capability/aggregate/repository/
  migration, no Core or `ExecutionOrchestrator` contract change.

### Most important rule
> **Only two fixed, allow-listed commands are ever produced — `pnpm test` and `pnpm typecheck`.** The
> bot never runs a user-supplied command, a shell string, or a synthesized command; the classifier
> emits only an intent + a `raw.kind` tag, and the resolver maps that tag to one of the two commands.

### Decision
- **First reachable execution slice.** `IntentClassifier` gains deterministic **`RUN_TESTS`**
  recognition (same style as REGISTER_PROJECT / PROJECT_ANALYSIS) → `IntentType.RUN_TESTS` +
  `Capability.TEST_EXECUTION` (both **reused**, no new enum) + `raw.kind: 'test' | 'typecheck'`.
- **Command ownership.** The classifier emits **intent + `raw.kind` only**; the **`IntentResolver`
  owns the fixed command mapping**: `typecheck → ['pnpm','typecheck']`, else `['pnpm','test']`. No
  user text is ever concatenated into a command; the `CommandExecution` allow-list re-checks it.
- **Workspace.** An active project is **required**. `ConversationRuntime` reads
  `session.activeProjectId`, loads the `Project` (`storage.projects.get`), and resolves the
  `WorkspaceRef` via the **existing `WorkspaceManager.open`** (workspace ownership stays with the
  Workspace capability), passing it into the resolver context / `ExecutionRequest.workspaceRef`.
- **Risk (CA change #1).** `pnpm test`/`pnpm typecheck` are **bounded, allow-listed project commands.
  They are lower-risk than patch/write/deploy commands, but NOT guaranteed non-mutating** — a package
  script may execute arbitrary project-defined logic. **Risk level: MEDIUM; approval halt: not
  required** for Sprint 2l (user-requested local project command, allow-listed shape, active project
  required, no bot-generated arbitrary command). `RiskPolicy`/`ApprovalManager` unchanged.
- **Result framing (CA change #2 + Q5).** `ConversationRuntime` may frame TEST_EXECUTION output by
  reading the existing `CommandExecution` result **through an existing application read path**
  (`CommandExecutionManager.get(refs.commandExecutionId)`). It introduces **no new repository/port**
  and does **not** change the `ExecutionOrchestrator` contract or move `CommandExecution` ownership.
  - Command **ran** with a clean exit → a **product test result**: `SUCCEEDED` (exit 0) → tests
    passed; `FAILED` (exit ≠ 0) → tests failed — **reported as a result, not a bot/system error.**
  - Command **could not run** (`TIMED_OUT`, allow-list refusal, workspace-open failure, spawn/system
    error) → an **execution/system-failure** reply.
- **ResponseComposer boundary.** The runtime builds **no** user-facing text. Added (minimal):
  `composeTestResult`, `composeNeedsProject`, `composeWorkspaceUnavailable`, `composeCommandUnavailable`.

### Not implemented (out of scope)
Code change · patch · workspace write · AI code-generation live execution · Agent Runtime ·
tool-calling loop · retry/reflection · Discord UI · telemetry · new capability/aggregate/repository/
migration · Core-contract change · `ExecutionOrchestrator` contract change · free-form/AI-generated/
shell commands.

### Consequences
- + First time a user's message ("테스트 돌려줘") flows all the way through
  `Runtime → Orchestrator → CommandExecution` to a real action + natural result — the pipeline is now
  reachable, with the smallest safe slice.
- − Test execution runs project-defined scripts (bounded but not provably side-effect-free); mitigated
  by the fixed allow-listed command shape, MEDIUM risk, and active-project requirement.

### Relations
ADR-0032 (Conversation Runtime), ADR-0031 (Execution Orchestrator), ADR-0028 (Command Execution /
allow-list), ADR-0024 (Planning), ADR-0025 (Approval), ADR-0015 (failure taxonomy / kind replies),
ADR-0018 (project registration). Supersedes nothing. Plan:
`docs/plans/sprint-2l-live-test-execution-plan.md`.

## ADR-0034 — Test Result Detail UX (CommandExecution facts → useful reply)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2m — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES.
- **Date:** 2026-07-01
- **Scope:** Sprint 2m is **result-detail UX, not command expansion**. `CommandExecution` (Sprint 2l,
  ADR-0028/0033) already carries `command`, `args`, `exitCode`, `stdout`, `stderr`, `durationMs`,
  `status`; the user-facing reply only used `status` + `args`. This sprint spends the already-existing
  facts on a safer, more useful reply — no new read path, no command-surface change.

### Decision
- **`TestResultDetail` is an Application-layer DTO, not domain.** Defined in `response-composer.ts`
  alongside the existing `ExecutionReplyStatus` local type — not persisted, not an aggregate, no
  `CommandExecutionStatus` inside it (status stays a Runtime branch concern, never re-interpreted by
  the Composer).
- **Runtime frames raw facts only.** `ConversationRuntime.frameTestResult` decides which of three
  cases applies (`SUCCEEDED`/`FAILED` → ran; `TIMED_OUT` → killed; no `CommandExecution` → never ran)
  and assembles `TestResultDetail` from the aggregate it already reads. It performs **no** string
  truncation and writes **no** text.
- **`ResponseComposer` owns summarization and all wording**, including the excerpt cut, stream
  choice, duration formatting, and Korean phrasing — consistent with the ADR-0032 invariant that
  reply text is built only by `ResponseComposer`.
- **Output-stream choice:** prefer `stdout`; fall back to `stderr` only if `stdout` is empty — a
  single stream, never merged. **CA-required:** when `stdout` is chosen and `stderr` is also
  non-empty, the reply says so (`"stderr 출력도 있었지만, 여기서는 stdout 마지막 부분만 보여드려요."`)
  — stdout-preference must never make stderr's existence invisible.
- **Summary bound:** last `MAX_SUMMARY_LINES = 20` lines, then capped at `MAX_SUMMARY_CHARS = 1200`
  chars (tail preserved either way) — headroom under Discord's 2000-char message limit. The full
  rendered reply is additionally defended at `MAX_MESSAGE_CHARS = 1900`.
- **No second masking pass.** `packages/command-local`'s `maskCommandOutput` (ADR-0028) already
  redacts secret-shaped substrings and caps each stream at 100k chars **before** `CommandExecution`
  is ever populated. This sprint's summarization is a length transform only, over already-safe text.
  **CA-required constraint:** the reply must never assert a completeness/security guarantee (no
  "전체 로그는 안전합니다" / "민감정보는 완전히 제거됐습니다" wording) — we trust the boundary
  internally but do not claim it to the user.
- **Timeout is not a test failure.** `composeTestTimedOut` (new) never phrases a `TIMED_OUT` run as
  "테스트 실패", never shows an exit code (none exists — the process was killed, not evaluated), and
  never claims a "configured timeout" value (`TestResultDetail` carries only the actual elapsed
  `durationMs`, not the limit that was set).
- **`ResponseComposer` API change.** `composeTestResult(context, passed, kind)` →
  `composeTestResult(context, detail: TestResultDetail & { passed: boolean })` (single call site,
  changed directly, no back-compat shim). New: `composeTestTimedOut(context, detail)`.
  `composeCommandUnavailable` is unchanged — it remains the reply for the one case with no facts to
  show (command never ran at all).
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port.**

### Not implemented (out of scope)
Command-surface expansion · user-supplied command · shell string · arbitrary/AI-generated command or
summary · retry · patch/write/code modification · GitHub Actions integration · Discord rich UI · new
aggregate/repository/migration/capability/port · Core-contract change · `ExecutionOrchestrator`
contract change.

### Consequences
- + A user running tests/typecheck now sees command, exit code, duration, and a bounded, safe
  excerpt of the actual output — not just pass/fail — while a killed (`TIMED_OUT`) run is clearly
  distinguished from a failing test.
- − The reply is longer per turn; bounded by `MAX_MESSAGE_CHARS` to stay within the Discord limit.

### Relations
ADR-0033 (Live Test Execution), ADR-0032 (Conversation Runtime), ADR-0028 (Command Execution /
masking-and-capping). Supersedes nothing (extends ADR-0033's `composeTestResult`/`frameTestResult`).
Plan: `docs/plans/sprint-2m-test-result-detail-ux-plan.md`.

## ADR-0035 — Live Code Change Planning (code-change intent → Planning/Approval halt, no mutation)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2n — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (Round 1).
- **Date:** 2026-07-01
- **Scope:** Sprint 2n is **live code-change planning, not live code-change execution.** It opens the
  (already-built but unreachable) `CODE_IMPLEMENTATION` pipeline to a real user intent for the first
  time, and stops it at `Planning → Approval → AWAITING_APPROVAL` — no AI Code Generation, no
  `WorkspaceDiff`, no `Patch`, no `WorkspaceWrite`, no `CommandExecution`.

### Most important rule
> **A code-change request never mutates anything this sprint.** Not because it is denied at the last
> moment, but because `CODE_GENERATION`/`WORKSPACE_DIFF`/`PATCH`/`WORKSPACE_WRITE`/`COMMAND_EXECUTION`
> are never selected into the pipeline for this request in the first place — the no-mutation guarantee
> rests on **stage selection**, not on the risk/approval gate alone (which is a second, reinforcing
> layer, not the only one).

### Decision
- **Reused, no new enum.** `IntentType.IMPLEMENT_CODE` + `Capability.CODE_IMPLEMENTATION` — both
  pre-existing (Sprint 2j) and already load-bearing in `IntentResolver.EXECUTION_CAPABILITIES`,
  `ConversationRuntime.needsWorkspace`, and `ExecutionOrchestrator.selectStages`, but never reachable
  because `IntentClassifier` never emitted `IMPLEMENT_CODE`.
- **Classifier stays command/codegen-free.** `IntentClassifier` gains deterministic code-change
  detection (same style as `RUN_TESTS`/`REGISTER_PROJECT`) → `IntentType.IMPLEMENT_CODE` +
  `Capability.CODE_IMPLEMENTATION` + `raw.kind: 'fix' | 'change' | 'refactor'`. The classifier never
  produces an implementation instruction, a target-file guess, a patch hint, or a command — only a
  classification tag, same shape/spirit as ADR-0033's `raw.kind`.
- **`planningOnly` — a narrow, single-purpose execution mode, not a general stage-override system.**
  `ExecutionRequest` gains one optional field, `planningOnly?: boolean`. When set, `selectStages`
  selects `[PLANNING, APPROVAL]` only for a `CODE_IMPLEMENTATION` request — `CODE_GENERATION`,
  `WORKSPACE_DIFF`, `PATCH`, `WORKSPACE_WRITE`, `COMMAND_EXECUTION` are never included. When unset
  (every existing caller/test), behavior is byte-for-byte identical to the pre-Sprint-2n pipeline.
  **Constraint (binding on all future changes):** `planningOnly` may be set **only** by
  `IntentResolver`, and **only** when `intent.capability === Capability.CODE_IMPLEMENTATION` on this
  live code-change-planning path. It must never be set from user input, never by `IntentClassifier`,
  and must never be generalized into an arbitrary-capability or externally-controlled stage override.
  Any future change that widens its scope must revisit this ADR.
- **`RiskPolicy.CAPABILITY_RISK[CODE_IMPLEMENTATION]`: `MEDIUM → HIGH`.** This is a **global policy
  change** (`RiskPolicy` is shared/capability-agnostic, ADR-0024/0025), not a capability-ownership
  change. Rationale: `CODE_IMPLEMENTATION` is `HIGH` by default because even suggest-only or
  planning-stage code-change requests are precursors to mutation. `TEST_EXECUTION` remains `MEDIUM`
  (Sprint 2l, unaffected). This makes `ApprovalPolicy.evaluate` return `requiresApproval: true` for
  any `CODE_IMPLEMENTATION` plan, so `ApprovalManager.requestFor` creates a `PENDING` (not
  auto-`APPROVED`) request, and `ExecutionOrchestrator.run` halts and returns `AWAITING_APPROVAL`.
- **Three-layer no-mutation guarantee — Layer 1 is the proof, Layers 2-3 are reinforcement:**
  1. **Stage selection (primary).** `PATCH`/`WORKSPACE_WRITE`/`COMMAND_EXECUTION` are absent from
     `selectedStages` for a `planningOnly` request — `runMutatingStages`'s `if
     (selectedStages.includes(STAGE))` guards make those calls unreachable code, independent of
     approval status.
  2. **Risk/Approval gate.** `CODE_IMPLEMENTATION` → `HIGH` → `PENDING` approval → `AWAITING_APPROVAL`
     halt before any mutating stage would have run, had one been selected.
  3. **Aggregate-level guard.** `PatchManager.generate`/`WorkspaceWriteManager.apply` both throw
     synchronously without an `APPROVED` `ApprovalRef`, regardless of stage selection.
- **Workspace resolution reused unchanged (ADR-0033 pattern).** `ConversationRuntime` reads
  `session.activeProjectId`, loads the `Project`, resolves the `WorkspaceRef` via the existing
  `WorkspaceManager.open` (read-only). No new mechanism.
- **Approval prompt is code-change-specific.** New `ResponseComposer.composeCodeChangeApprovalRequired`
  states that approval is required, that this is a code-change request, and that this stage does not
  modify any file yet — selected by `ConversationRuntime` (facts only: `intent.capability`) instead of
  the generic `composeApprovalRequired` used by other capabilities.
- **Approval resume never claims completion.** New `ResponseComposer.composePlanningOnlyApproved`
  replies to "승인" on a `planningOnly` request without implying code was fixed/generated/written —
  selected by `ConversationRuntime` when the resumed request's `planningOnly` flag is set, instead of
  the generic `composeExecutionResult('COMPLETED')`, which would otherwise be misleading (nothing
  mutates on this path). "거절"/"취소" are unaffected — they never claimed completion.
- **`ConversationRuntime` frames facts only; `ResponseComposer` owns all text (ADR-0032 §10,
  unchanged invariant).** Both new Runtime branches only select which composer method applies, based
  on facts already on hand (`intent.capability`, `request.planningOnly`) — no inline text, no new
  persisted state, no new aggregate.
- **No Core/Orchestrator contract change beyond the one additive, non-breaking `planningOnly` field.
  No new aggregate/repository/migration/capability/port.**

### Not implemented (out of scope)
AI Code Generation call · `ProviderSelector`/Claude/Ollama/Codex invocation · `WorkspaceDiff` ·
`Patch` generation · `WorkspaceWrite` · `CommandExecution` · file mutation · command execution ·
retry · agent loop · autonomous coding · Discord button UI · new aggregate/repository/migration/
capability/port · Core-contract change · a general-purpose execution-stage override system.

### Consequences
- + A user's code-change request ("이 버그 고쳐줘") now flows through `Runtime → Orchestrator →
  Planning → Approval` for the first time and halts safely — no code is ever touched, but the product
  surface for code-change requests now exists, ready for a future sprint to turn `planningOnly` off.
- + The no-mutation guarantee is structural (stage selection), not merely policy-based — a future
  regression in `RiskPolicy` alone cannot, by itself, cause a mutation on this path.
- − "승인" on a `planningOnly` request does nothing observable yet (by design) — `composePlanningOnlyApproved`
  makes this explicit to the user rather than implying completion.
- − `CODE_IMPLEMENTATION`'s risk escalation to `HIGH` is global; any future non-`planningOnly` caller of
  `CODE_IMPLEMENTATION` will also require human approval (intentional — see rationale above).

### Relations
ADR-0033 (Live Test Execution — `raw.kind` classifier pattern, workspace resolution), ADR-0032
(Conversation Runtime — text-ownership invariant), ADR-0031 (Execution Orchestrator — stage
selection), ADR-0025 (Approval Capability), ADR-0024 (Planning Capability). Supersedes nothing.
Plan: `docs/plans/sprint-2n-live-code-change-planning-plan.md`.

## ADR-0036 — Code Change Scope Collection (validated target file before Planning/Approval)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2o — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (Round 1).
- **Date:** 2026-07-01
- **Scope:** Sprint 2o is **scope collection, not code generation.** It inserts one gate in front of
  Sprint 2n's `IMPLEMENT_CODE → planningOnly → Planning → Approval` path: a code-change request must
  name a real, Workspace-validated target file before it may reach `ExecutionOrchestrator.run` at all.
  Insufficient scope creates **no** `ExecutionPlan` and **no** `ApprovalRequest` — the gate runs before
  the orchestrator is ever invoked, not inside it.

### Most important rule
> **The Workspace boundary is the authoritative security check, not the extraction regex.** Candidate
> extraction (`target-scope.ts`) is a permissive, best-effort heuristic; it may over-accept. The only
> thing that may ever populate `ExecutionRequest.targetFiles` is a path `WorkspaceManager.list` (CAP-001,
> ADR-0022) actually returned for the active project's workspace, verified by exact-match comparison —
> never the raw candidate string, and never trusted on `hits.length > 0` alone.

### Decision
- **Reused, no new enum/capability/port.** `IntentClassifier` stays target-free — it still only emits
  `IntentType.IMPLEMENT_CODE` + `Capability.CODE_IMPLEMENTATION` + `raw.kind` (ADR-0035), never a
  target guess. `IntentResolver.resolve()` is **unchanged** — it already forwarded
  `context.targetFiles` into `ExecutionRequest.targetFiles` before this sprint existed.
- **`target-scope.ts` is a pure Application-layer parser helper — not a capability, not a domain
  service, not a port/adapter/repository.** No class, no DI, no Workspace access, no AI. It exports
  `extractTargetPathCandidates` (deterministic, requires a `/` in the candidate — rejects bare
  filenames, `Node.js`, `e.g.`, `v1.2.3` at zero Workspace-call cost) and `normalizeRelativePath` (used
  only to verify an exact match between a candidate and a Workspace-returned hit).
- **`ConversationRuntime` owns the pre-execution scope gate.** Gated strictly on
  `intent.capability === Capability.CODE_IMPLEMENTATION`, inserted after the existing
  workspace-resolution step and before `IntentResolver.resolve()`. For each of up to
  `MAX_TARGET_CANDIDATES = 5` extracted candidates, it calls the existing `WorkspaceManager.list(ref,
  candidate)` and accepts a hit **only if** `normalizeRelativePath(hit) === normalizeRelativePath
  (candidate)` — `list()`'s glob semantics are never assumed to be exact-match. `targetFiles` is
  populated from the **Workspace-returned hit**, never the raw candidate.
- **No new Workspace port or capability.** `ConversationRuntimeDeps.workspace`'s narrow structural
  interface widens to include `list`, a method the real `WorkspaceManager` (CAP-001) already
  implements — this is a structural interface widening, not a new port, and required no DI change.
- **Insufficient scope stops before any Execution-layer aggregate exists.** No target validated →
  `ConversationRuntime` replies with `ResponseComposer.composeTargetScopeClarification` and returns —
  `IntentResolver.resolve()`, `ExecutionOrchestrator.run`, `ExecutionPlan`, and `ApprovalRequest` are
  all skipped entirely. Stronger than Sprint 2n's in-orchestrator halt: this halts before the
  orchestrator is ever called.
- **Clarification wording (CA-required) asks for a file path as the sufficient ask, not natural-
  language module/area text.** It also instructs the user to re-send the **full** request together
  with the path (e.g. "packages/core/src/application/foo.ts 파일에서 이 버그 고쳐줘") — compensating for
  the sprint's deliberate absence of multi-turn memory.
- **No multi-turn clarification-answer correlation this sprint.** Building one would need a new,
  persisted, stateless-correlation mechanism analogous to `ApprovalFlow` — but `ApprovalFlow` derives
  its state from an existing aggregate (`Task`/`ExecutionPlan`/`ApprovalRequest`), and an
  insufficient-scope request creates none of those. Inventing a new aggregate/repository/migration
  just to remember "a clarification is pending" is explicitly out of scope; the clarification wording
  compensates by teaching the correct single-turn shape instead.
- **`planningOnly` and `CODE_IMPLEMENTATION`'s `HIGH` risk (ADR-0035) are untouched.** A code-change
  request with a validated `targetFiles` still stops at `PLANNING → APPROVAL` — this sprint decides
  only *whether* a request may reach that point, never *what happens once it does*. No AI Code
  Generation, `WorkspaceDiff`, `Patch`, `WorkspaceWrite`, or `CommandExecution` this sprint.
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port.**

### Not implemented (out of scope)
AI Code Generation · `ProviderSelector`/Claude/Ollama/Codex invocation · semantic search · repository
indexing · AI target-file guessing · directory scope · natural-language module/area text as sufficient
target · patch generation · `WorkspaceWrite` · command execution · retry · autonomous agent loop ·
Discord button UI · multi-turn clarification-answer persistence · new aggregate/repository/migration/
capability/port · Core-contract change · `ExecutionOrchestrator` contract change · a general-purpose
execution-stage override system.

### Consequences
- + A code-change request that names no real file now gets a specific, actionable clarification
  instead of silently reaching `AWAITING_APPROVAL` for an unknown target — closing a real Product gap
  Sprint 2n left open.
- + The no-mutation guarantee for an insufficient-scope request is even stronger than Sprint 2n's: the
  orchestrator is never invoked at all, not merely halted inside it.
- − No memory across turns: a bare follow-up reply naming only a path (no verb) is not recognized as
  answering the clarification — mitigated by wording that teaches the correct single-message shape,
  not by a new correlation mechanism.
- − Bare root-level filenames (e.g. `foo.ts`, `README.md`) are not accepted as sufficient scope this
  sprint — a deliberate, conservative exclusion, not a limitation of the underlying mechanism.

### Relations
ADR-0035 (Live Code Change Planning — `planningOnly`, `CODE_IMPLEMENTATION` risk, the halt this sprint
gates in front of), ADR-0032 (Conversation Runtime — text-ownership invariant), ADR-0022 (Workspace
Capability — the read-only sandbox this sprint's validation reuses entirely). Supersedes nothing.
Plan: `docs/plans/sprint-2o-code-change-scope-collection-plan.md`.

## ADR-0037 — Multi-turn Code Scope Clarification (Task reused as inert conversation anchor)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2p — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (Round 1).
- **Date:** 2026-07-01
- **Scope:** Sprint 2p is **multi-turn scope clarification, not code generation.** Sprint 2o already
  asks for a target file and stops when one is missing; this sprint makes the user's very next reply —
  even a bare file path with no verb — resume that same request, without inventing a new aggregate.

### Most important rule
> **The Task created by `ScopeClarificationFlow` is an inert conversation anchor, never an execution
> task.** It must never enter Planning, `ExecutionOrchestrator`, `Patch`, `WorkspaceWrite`, or
> `CommandExecution` by itself, and it is never transitioned past `TaskStatus.PENDING`. It exists
> solely to hold `PendingScopeClarification` facts across exactly one follow-up turn.

### Decision
- **No new aggregate/repository/migration/capability/port.** Four options were evaluated
  (`docs/plans/sprint-2p-multiturn-code-scope-clarification-plan.md` §2): a new Application-layer
  correlation model was rejected as needless duplication of an already-shipped pattern; short-term
  memory was rejected because recovering typed state by parsing free text is exactly what ADR-0032
  already forbade for the approval case; `Session.metadata` was rejected because ADR-0032 explicitly
  states *"Session must not store runtime snapshots."* `Task.metadata` was selected — `Task` is
  already the accepted pending-work anchor for `ConversationRuntime` (`StatelessApprovalFlow` already
  creates one purely to hold an anchor payload), and `Task.planId` is optional, so a Task can exist one
  step earlier than usual, before any `ExecutionPlan`.
- **Two independent signals distinguish the scope anchor from the approval anchor** — `planId`
  absence (structural) **and** an explicit metadata discriminator, `kind: 'code-scope-clarification'`
  (CA Round 1: `planId` absence alone was judged too implicit — a future feature could create an
  unrelated plan-less Task and be silently misread as a scope anchor). `findPending` and `clear` both
  require both signals before treating a Task as this flow's own.
- **`clear()` is safe by construction.** It routes through the same "is this our anchor?" check as
  `findPending` and is a no-op unless `session.activeTaskId` still points at a genuine
  scope-clarification anchor — it must never clear an approval anchor sharing the same pointer slot
  (CA Round 1).
- **Field naming avoids collision.** `PendingScopeClarification.kind` is the anchor discriminator;
  the classifier's intent tag is stored separately as `rawKind`. The two `kind`s are never the same
  field (CA Round 1).
- **`Session` stores only the `activeTaskId` pointer — never a snapshot.** Identical to the approval
  case (ADR-0032). `ConversationRuntime` never directly reads/writes `storage.tasks`/
  `storage.sessions` — `ScopeClarificationFlow` owns anchoring/derivation.
- **Ordering is load-bearing.** `ConversationRuntime.handle()` checks `approvalFlow.findPending` first,
  `scopeClarificationFlow.findPending` second, and only then classifies. An approval-pending session
  can never be routed into scope-clarification handling.
- **Anchoring is tightly scoped to one call site.** `scopeClarificationFlow.anchor` is called only from
  the existing Sprint 2o gate, only for a fresh `CODE_IMPLEMENTATION` request, only after an active
  project exists and the workspace opened successfully, and only when no candidate validated. It is
  never called for `TEST_EXECUTION`/`PROJECT_ANALYSIS`/`CHAT`, and never when there is no active
  project or the workspace failed to open.
- **Invalidation is next-turn-only — an explicit, documented Product trade-off, not an oversight.** The
  anchor is consumed unconditionally on the first follow-up check, regardless of outcome; an invalid
  reply does not re-anchor, so a third message is not recovered even if it is itself a valid bare path.
  Unbounded clarification retry would require a future plan. `createdAt` is stored for
  observability/future policy only — it is **not** used for expiration in Sprint 2p.
- **Project-change auto-clears the anchor.** If `session.activeProjectId` no longer matches the
  anchor's stored `projectId`, `findPending` clears it (via the same safe `clear()`) and returns
  `null` — the message is then handled as an ordinary fresh turn.
- **Recovery uses the original request's summary, never the follow-up's text.** The recovered
  `Intent.summary` is always `pending.summary` (the first message), so `ExecutionRequest.goal`/
  `instruction` reflect what the user originally asked for, not the file path they replied with.
- **A recovered, validated request enters the existing `planningOnly` flow unchanged** — reusing
  Sprint 2o's `extractTargetPathCandidates`/`WorkspaceManager.list`/`normalizeRelativePath` validation
  and the same shared `runResolvedExecution` tail a fresh sufficient-scope request already uses.
  `IntentResolver.resolve()`, `planningOnly` (ADR-0035), and `CODE_IMPLEMENTATION`'s `HIGH` risk
  (ADR-0036) are all unchanged.
- **New `ResponseComposer.composeScopeClarificationCancelled`.** Replaces reuse of the generic
  `composeExecutionResult('CANCELLED')`, whose "작업을 취소했어요" wording could be misread as
  cancelling an execution that never existed (CA Round 1). `ConversationRuntime` still builds no text
  of its own.
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port.**

### Not implemented (out of scope)
AI Code Generation · `ProviderSelector`/Claude/Ollama/Codex invocation · semantic search · repository
indexing · AI target-file guessing · directory scope · module/area text as sufficient target ·
multi-file target selection · patch generation · `WorkspaceWrite` · command execution · retry loop ·
autonomous agent loop · Discord button UI · unbounded/persisted multi-turn clarification retry beyond
one follow-up · new aggregate/repository/migration/capability/port · Core-contract change ·
`ExecutionOrchestrator` contract change.

### Consequences
- + A bare file-path reply ("packages/core/src/application/foo.ts") now correctly resumes a code-
  change request that Sprint 2o would otherwise have silently dropped as ordinary chat.
- + The recovery mechanism is a direct generalization of an already-shipped, CA-approved pattern
  (`StatelessApprovalFlow`) rather than new infrastructure — no new aggregate, no new store.
- − Only one follow-up attempt is recovered; a second failed attempt requires the user to restate the
  full request, verb included. This is an intentional Product trade-off, not a bug.
- − Scope-clarification anchor Tasks, like approval-anchor Tasks before them, accumulate as inert
  historical records rather than being cleaned up — an accepted, pre-existing pattern (ADR-0032), not
  a new concern this sprint introduces.

### Relations
ADR-0036 (Code Change Scope Collection — the single-turn gate this sprint extends to two turns),
ADR-0035 (Live Code Change Planning — `planningOnly`, `CODE_IMPLEMENTATION` risk, both unchanged),
ADR-0032 (Conversation Runtime — `StatelessApprovalFlow`'s Task-anchor pattern, generalized here).
Supersedes nothing. Plan: `docs/plans/sprint-2p-multiturn-code-scope-clarification-plan.md`.

## ADR-0038 — AI Code Generation Preview (proposal text only, no Patch/Write)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2q — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (Round 1).
- **Date:** 2026-07-01
- **Scope:** Sprint 2q is **AI CodeGeneration preview, not Patch/Write.** After a user approves a
  `planningOnly` `CODE_IMPLEMENTATION` request, `ConversationRuntime` runs the existing AI Code
  Generation capability (CAP-008) once, in preview mode, and shows the proposed change as bounded
  text. No `Patch`, no `WorkspaceWrite`, no `CommandExecution`, no file mutation.

### Most important rule
> **`targetFiles` is the only allowed scope source, and it is untrusted from the AI's side.**
> `CodeGenerationManager.generate()` is called only when `executionPlanRef`, `workspaceRef`, and a
> non-empty `targetFiles` are all present. Whatever the AI proposes is then filtered against that same
> `targetFiles` set (normalized exact-match, not raw string comparison) — anything outside it is
> dropped from the rendered content and surfaced only as a warning. If nothing survives filtering, the
> turn is reported as a failure, never as a successful proposal.

### Decision
- **`ConversationRuntime` composes `CodeGenerationManager` directly — `ExecutionOrchestrator` is not
  touched.** `ExecutionOrchestrator.run()`'s stage order has always meant "`CODE_GENERATION`, if
  selected, runs before `APPROVAL`" (pre-approval authoring). Sprint 2q's preview runs *after*
  approval, with nothing following it — forcing this into the Orchestrator's stage-selection model
  would give `selectedStages` two different meanings depending on whether `run()` or `resume()` is
  executing it. `ConversationRuntime` is already an Application-layer composer of capability managers
  outside the Orchestrator (it already reads `CommandExecutionManager` directly for
  `frameTestResult`) — calling `CodeGenerationManager.generate()`/`getProposal()` directly is the same
  shape of composition. No new `ExecutionStage`, no `ExecutionOrchestrator` contract change, no
  resume-only stage override.
- **`planningOnly`'s meaning is unchanged — no rename.** It remains scoped to the Orchestrator:
  `ExecutionOrchestrator` selects `PLANNING`+`APPROVAL` only for a `planningOnly` request, exactly as
  ADR-0035 defined. The new preview step is a `ConversationRuntime`-level addition entirely outside
  that flag's scope of meaning.
- **Every guard is explicit, before any `generate()` call.** `executionPlanRef` (from the resume
  outcome), `workspaceRef`, and a **non-empty** `targetFiles` (both from the reconstructed
  `ExecutionRequest` — already anchored/reconstructed by `StatelessApprovalFlow`, zero new plumbing)
  must all be present. Missing any one of them means `generate()` is never called at all.
- **AI-proposed paths are untrusted; `targetFiles` is authoritative.** The proposal is filtered using
  the same `normalizeRelativePath` exact-match discipline Sprint 2o/2p already established for
  user-supplied paths — never a raw string comparison. The rendered path is always the validated
  `targetFiles` value, never the AI's raw string. Anything outside `targetFiles` is dropped from
  rendered content and surfaced only as a bounded warning list. **If every proposed path is out of
  scope, the turn is not presented as a successful preview** — a distinct
  `composeCodeGenerationPreviewNoValidChange` reply is used instead.
- **Preview text is bounded and safe against Markdown breakage.** Per-file excerpts are capped; the
  full rendered message reuses the existing `MAX_MESSAGE_CHARS`/`clampToMessageBudget` guard (ADR-0034);
  code fences are rendered with a backtick run longer than any backtick sequence already present in
  the (untrusted) AI content.
- **Preview text repeats, not merely mentions once, that nothing was applied.** Forbidden wording:
  "적용했어요"/"수정했어요"/"반영했어요"/"변경 완료" — anything that could read as a completed mutation.
- **Failure — including the all-out-of-scope case — reports `RuntimeTurnStatus.FAILED`, never
  `RESPONDED`.** A genuinely failed attempt to produce a usable preview must not look like an ordinary
  successful reply at the Runtime-status level. A successful preview's `TurnResult` preserves
  `executionOutcome`, matching every other successful execution-outcome reply in this codebase.
- **`composePlanningOnlyApproved` (ADR-0035) is retained but no longer reached in production** for an
  approved `planningOnly` `CODE_IMPLEMENTATION` request — the non-`COMPLETED` resume-outcome branch now
  calls the existing generic `replyForOutcome`, not `composePlanningOnlyApproved`. It is not deleted;
  its own tests still pass; becoming unreachable in production is an accepted, explicit consequence of
  this sprint, not an oversight.
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port.**

### Not implemented (out of scope)
`Patch` generation · `PatchSet` application · `WorkspaceWrite` · file mutation · git mutation · command
execution · test execution after generation · retry loop · autonomous agent loop · directory scope ·
module scope as sufficient target · semantic repository search · repository indexing · AI target-file
guessing · multi-file selection · Discord button UI · `ExecutionOrchestrator` contract change ·
general-purpose execution-stage override system · `Core` contract change.

### Consequences
- + The AI Code Generation capability (CAP-008) is reachable from a live user turn for the first
  time, at the exact narrow boundary the product has been building toward since Sprint 2n — a
  proposal the user can read, never a mutation they didn't ask to apply.
- + The untrusted-output-vs-validated-scope pattern established in Sprint 2o/2p (regex extraction vs.
  Workspace) generalizes cleanly to AI output vs. `targetFiles`, reusing the same normalization
  primitive rather than inventing a second one.
- − `composePlanningOnlyApproved` becomes effectively dead code in production (still tested, not
  deleted) — an accepted, explicit trade-off rather than a cleanup left undone.
- − No unified-diff-style preview against current file content this sprint (would require a
  `WorkspaceManager.diff` read) — deferred as a low-risk future enhancement, not a limitation of the
  chosen design.

### Relations
ADR-0029 (AI Code Generation, CAP-008 — the capability this sprint finally activates), ADR-0035 (Live
Code Change Planning — `planningOnly`, unchanged), ADR-0036 (Code Change Scope Collection —
`normalizeRelativePath`, reused), ADR-0037 (Multi-turn Code Scope Clarification — `targetFiles`
preservation through approval resume, reused), ADR-0031 (Execution Orchestrator — the stage-selection
model this sprint deliberately does not extend), ADR-0034 (Test Result Detail UX —
`MAX_MESSAGE_CHARS`/`clampToMessageBudget`, reused). Supersedes nothing.
Plan: `docs/plans/sprint-2q-ai-code-generation-preview-plan.md`.

## ADR-0039 — Unified Diff Preview (current content vs. proposed content, still no Patch/Write)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2r — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (Round 1).
- **Date:** 2026-07-01
- **Scope:** Sprint 2r replaces Sprint 2q's plain-excerpt code-change preview with a **unified-diff-style**
  preview — current workspace file content vs. the AI's proposed content — for a successful in-scope
  proposal. Still preview only: no `Patch`, no `WorkspaceWrite`, no `CommandExecution`, no file mutation,
  no git mutation, no `ExecutionOrchestrator` change.

### Most important rule
> **The diff is computed deterministically from current workspace content and the AI's proposed
> content — never from AI- or provider-authored diff text — and only for paths already validated
> against `targetFiles`.** `ConversationRuntime` calls the existing `WorkspaceManager.diff()` (CAP-001,
> ADR-0022) directly with `filterInScopeChanges`'s in-scope subset only. Anything less than a clean,
> complete diff of every in-scope file — a missing current file (`changeKind: 'add'`), an empty result,
> or a read failure — is reported as a failed preview, never as a partial or degraded success.

### Decision
- **Reuses `WorkspaceManager.diff()`/`WorkspaceProvider.diff()` unchanged — no new capability, port, or
  provider.** This read already existed for `ExecutionOrchestrator`'s `WORKSPACE_DIFF` stage
  (pre-Approval, mutating flow); Sprint 2r is the first caller to reuse it for a post-approval,
  non-mutating preview. `ConversationRuntime` calls `workspace.diff()` directly, for the identical
  reason ADR-0038 gave for calling `CodeGenerationManager` directly: `planningOnly`'s `selectStages()`
  is `[PLANNING, APPROVAL]` only (ADR-0035) and never includes `WORKSPACE_DIFF`, so routing this through
  `ExecutionOrchestrator` would require a resume-only stage override — the same shape of problem
  ADR-0038 already rejected. No new `ExecutionStage`; `ExecutionOrchestrator` is not touched;
  `planningOnly` remains Orchestrator-scoped.
- **No `app.module.ts` change.** The `WorkspaceManager` instance already injected into
  `ConversationRuntimeDeps.workspace` already implements `.diff()` — widening the dependency's
  *declared* structural type in `conversation-runtime.ts` is the only code change at that seam.
- **`filterInScopeChanges` (extracted from Sprint 2q's `toCodeChangePreview`) is the single shared
  normalized-path filter** both the retained text-excerpt path and the new diff path use — comparison
  is `normalizeRelativePath` exact-match, never a raw string compare, and only the validated
  `targetFiles` value is ever passed to `workspace.diff()`. AI-proposed paths outside `targetFiles` are
  never read, never diffed, never rendered — surfaced only as a bounded warning, unchanged from
  ADR-0038. The extraction preserves each `ProposedChange`'s `delete`/`newContent` shape via object
  spread + a single overridden field, never a reconstruction that could default one differently from
  what the AI returned.
- **`changeKind: 'add'` is treated as a failure this sprint, not a successful "new file" diff (CA Round
  1).** `targetFiles` are Workspace-validated existing files (ADR-0036); a `WorkspaceDiff` entry
  reporting `'add'` for one of them means its current content could not be found/read at diff time —
  reported as `composeCodeGenerationPreviewFailed`, `RuntimeTurnStatus.FAILED`.
- **An empty `WorkspaceDiff.files` result is also a failure, never a vacuous success (CA Round 1).**
  Guarded explicitly before the success DTO is built.
- **Binary and size-skipped files render an explicit "diff를 표시할 수 없어요" notice (CA Round 1) —**
  never phrased as if a diff had been shown, and each such line reaffirms the file was not modified.
- **Diff rendering is budget-aware, not merely length-capped (CA Round 1).** The header, the
  out-of-scope warning (if any), and the closing "not applied" line are reserved budget computed
  *before* any file block is rendered; file blocks are dropped (with a bounded "N개 생략" notice) once
  that budget is exhausted, so the mandatory safety wording always survives — the pre-existing
  `clampToMessageBudget` call is now a defensive backstop, not the primary guarantee. The per-file cap
  is lowered (`MAX_DIFF_CHARS_PER_FILE` = 1000) to leave headroom for this reservation.
- **`composeCodeDiffPreview` supersedes `composeCodeGenerationPreview` for a successful in-scope
  proposal.** `composeCodeGenerationPreview`/`CodeChangePreview`/`toCodeChangePreview` (ADR-0038) are
  **retained, not deleted** — their own tests keep passing; they are simply no longer reached from
  `runCodeGenerationPreview`'s success branch. The same accepted "unreached in production, not deleted"
  status ADR-0038 already gave `composePlanningOnlyApproved`, applied a second time.
- **Failure — including `changeKind: 'add'`, an empty diff, and a `workspace.diff()` read error — reports
  `RuntimeTurnStatus.FAILED` via the existing `composeCodeGenerationPreviewFailed` reply.** No new
  failure-wording composer method; the required behavior is identical in shape to Sprint 2q's existing
  generation-failure handling.
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port.**

### Not implemented (out of scope)
Preview → Apply · `Patch` generation · `Patch` application · `WorkspaceWrite` · file mutation · git
mutation · command execution · test execution after generation · retry loop · autonomous agent loop ·
multi-file selection · directory scope · module scope as sufficient target · semantic repository search
· repository indexing · AI target-file guessing · provider-specific diff generation · a successful diff
preview for `changeKind: 'add'` · a new `PatchSet` type · `ExecutionOrchestrator` contract change ·
`Core` contract change.

### Consequences
- + The code-change preview now shows what actually changes in the real file, not just the proposed
  content in isolation — a materially more useful pre-Apply review, using a read the codebase already
  had (`WorkspaceManager.diff()`) for a purpose it was never wired into.
- + The untrusted-output-vs-validated-scope pattern (ADR-0036/0037/0038) generalizes a third time:
  `filterInScopeChanges` is the one shared gate both the retained text preview and the new diff preview
  pass through before touching the workspace or rendering anything.
- + Treating `changeKind: 'add'`/an empty diff/a read failure as failures (rather than degraded
  successes) keeps the "never look like an ordinary successful reply when something's actually wrong"
  discipline ADR-0038 established, extended to a new failure surface this sprint introduces.
- − `composeCodeGenerationPreview` becomes dead code in production a second way (already unreached via
  `composePlanningOnlyApproved`'s precedent) — still tested, not deleted, an accepted trade-off.
- − A validated target file that is genuinely a new addition (not yet created) cannot get a successful
  preview this sprint — deferred; Sprint 2o/2p's scope-collection flow currently assumes an existing
  file, so this is expected to be rare in practice, not a common-case regression.

### Relations
ADR-0038 (AI Code Generation Preview — the text-excerpt preview this sprint supersedes for the success
case, but does not delete), ADR-0022 (Workspace read-only diff — `WorkspaceManager.diff()`, reused
unchanged), ADR-0036 (Code Change Scope Collection — `normalizeRelativePath`, `targetFiles` validation,
reused), ADR-0037 (Multi-turn Code Scope Clarification — `targetFiles` preservation through approval
resume, reused), ADR-0035 (Live Code Change Planning — `planningOnly`, unchanged), ADR-0031 (Execution
Orchestrator — the stage-selection model this sprint deliberately does not extend), ADR-0034 (Test
Result Detail UX — `MAX_MESSAGE_CHARS`/`clampToMessageBudget`, reused). Supersedes nothing.
Plan: `docs/plans/sprint-2r-unified-diff-preview-plan.md`.

## ADR-0040 — Explicit Preview Apply Approval (second gate, still no mutation)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2s — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (Round 1).
- **Date:** 2026-07-02
- **Scope:** Sprint 2s separates **"approved a preview"** from **"approved modifying files."** After
  Sprint 2r's diff preview, an **explicit** apply phrase ("적용해줘"/"반영해줘"/"이대로 진행해") creates a
  *second*, HIGH-risk `ApprovalRequest` and halts at `AWAITING_APPROVAL`. Still no `Patch`, no
  `WorkspaceWrite`, no `CommandExecution`, no file/git mutation — actual apply is a future sprint's job,
  and this sprint's job is to preserve, not destroy, the context that sprint will need.

### Most important rule
> **Two things this sprint discovered by reading the existing code, not by assumption, before any design
> could be trusted: (1) a second `ApprovalRequest` referencing the same `executionPlanRef` would be
> silently swallowed by `StatelessApprovalFlow.findPending`'s plan-scoped lookup unless its anchoring
> Task is deliberately kept plan-less; and (2) `ExecutionPlan` is documented as in-memory-only — by the
> time a user says "적용해줘," the object `ApprovalManager.requestFor` needs no longer exists.** Both are
> resolved by construction, not by convention: a third, plan-less anchor flow (mirroring
> `StatelessScopeClarificationFlow` exactly), and one small additive method, `ApprovalManager.
> requestForRisk`, for approvals with a known risk and no live plan to re-evaluate.

### Decision
- **The apply-preview anchor Task never carries a `planId`.** `StatelessApprovalFlow.findPending`
  discovers the first approval solely via `Session.activeTaskId → Task.planId → approvals.
  findByExecutionPlan(planId) → PENDING`. If the second approval's anchor Task carried the same
  `planId` (the same `executionPlanRef.id` the new approval must still reference), that existing flow
  would discover it as if it were its own and misroute its `approve` branch into `reconstructResume`,
  which would fail (wrong anchor key) and loop into an unrelated re-ask prompt — the apply approval could
  never actually be decided. Keeping the anchor Task's `planId` `undefined` — exactly like
  `StatelessScopeClarificationFlow`'s anchor already is — makes `StatelessApprovalFlow.findPending`'s
  very first guard skip it unconditionally.
- **A new, plan-less third flow — `ApplyPreviewFlow`/`StatelessApplyPreviewFlow` — owns finding,
  anchoring, and clearing this anchor**, discriminated the same way scope-clarification is: `!task.
  planId` **and** an explicit `kind: 'code-preview-apply'` metadata discriminator. Structurally identical
  to `StatelessScopeClarificationFlow` (ADR-0037) — same store shape, same technique, applied a second
  time to a new problem of the same shape.
- **The anchor carries an explicit three-state lifecycle: `ELIGIBLE → AWAITING_APPROVAL → APPROVED`.**
  `ELIGIBLE` is written once, right after a successful diff preview (Sprint 2r), recording
  `{executionPlanRef, workspaceRef, targetFiles, codeGenerationRef, codeProposalRef, instruction}`. An
  explicit apply phrase moves it to `AWAITING_APPROVAL` (creating the second `ApprovalRequest`).
  **Approving moves it to `APPROVED` — it does NOT clear the anchor.** `ApprovalRequest` itself carries
  no `workspaceRef`/`targetFiles`/`codeProposalRef`; clearing the anchor on approve would have made the
  approved decision unrecoverable to a future Apply sprint. Denying or cancelling **does** clear it —
  there is nothing left worth preserving. This was a required correction in CA Round 1 review; the
  original draft cleared on every decision, including approve.
- **An explicit apply phrase with no eligible anchor (or a stale one) gets a direct, honest reply — it is
  never reinterpreted as a new, unscoped code-change request.** "적용해줘" is a different intent from "새
  코드 변경을 해줘," even though both might otherwise reach the same classifier keywords. This was a
  required correction in CA Round 1 review; the original draft's answer here ("falls through to normal
  classification") was rejected as conflating two distinct user intents.
- **Once `AWAITING_APPROVAL`, every turn is intercepted for a decision — not only messages matching an
  apply phrase** — exactly like the first approval's pending-decision behavior. `ELIGIBLE`/`APPROVED`
  anchors, by contrast, are a soft, optional follow-up opportunity: anything that isn't an explicit apply
  phrase falls through to ordinary conversation untouched, proven by a dedicated non-"좋아" ordinary-chat
  test case.
- **`ApprovalManager.requestForRisk` is additive, narrowly constrained, and does not replace `requestFor`
  for the normal planning-approval path.** It always creates `PENDING` (never auto-approves) and never
  calls `ApprovalPolicy` — it exists solely because `ExecutionPlan` (ADR-0024) is in-memory-only and does
  not survive to this later turn; the caller supplies the risk level directly because it already knows a
  mutation-step approval must require one. Because it bypasses policy evaluation it validates its own
  inputs (CA Round 1 implementation review): a non-empty `reason` and `requestedBy` are required, and
  **only `HIGH`/`CRITICAL` risk is accepted** — a mutation-step approval below `HIGH` would be a caller
  error, not something to persist silently. This sprint's only caller always passes `RiskLevel.HIGH`.
- **`APPLY_WORDS` (적용/반영/이대로 진행) is a dedicated word-set, deliberately never sharing anything
  with `APPROVE_WORDS`.** "좋아"/"오케이"/"확인"/"괜찮네" — already sufficient to decide the *first*
  approval — must never be sufficient to authorize file modification. The two word-sets are
  non-overlapping by construction: `APPROVE_WORDS`' bare "진행" is distinct from `APPLY_WORDS`' multi-word
  "이대로 진행."
- **Approval #2's `reason` carries `codeProposalRef.id`/`codeGenerationRef.id`, not just target file
  names**, for auditability — `ApprovalRequest` has no metadata field, so this machine-facing string is
  the only trace on the aggregate itself pointing back to which proposal was approved (the anchor remains
  the actual source of rich, structured context).
- **The diff itself is never persisted.** Source of truth remains the anchored refs
  (`workspaceRef`/`targetFiles`/`codeProposalRef`); a future Apply sprint recomputes the diff on demand
  (Sprint 2r's `workspace.diff`) and must revalidate against the latest file content before any mutation
  — this sprint's approval wording already tells the user that will happen.
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port.**

### Not implemented (out of scope)
Actual `WorkspaceWrite` apply · `PatchSet` generation/application · `CommandExecution` · test execution
after apply · git mutation · file mutation · retry loop · autonomous agent loop · multi-file selection ·
directory/module scope · semantic repository search · repository indexing · AI target-file guessing ·
new-file creation/`changeKind: 'add'` support · provider-specific apply behavior · treating the first
(preview) approval as permission to mutate files · `ExecutionOrchestrator` contract change · `Core`
contract change.

### Consequences
- + File modification now requires a second, explicit, HIGH-risk human decision — distinct from and
  strictly later than the decision that only authorized generating a preview. The two risks (seeing AI
  output vs. letting it touch a real file) are no longer conflated into one approval.
- + The plan-less-Task collision-avoidance pattern established for scope-clarification (ADR-0037)
  generalizes cleanly to a second, unrelated problem — the same technique, not a new one, each time a new
  kind of conversation-anchored fact set needs to coexist with the original approval flow.
- + Approving preserves exactly the context (`workspaceRef`/`targetFiles`/`codeProposalRef`) a future
  Apply sprint needs, rather than requiring that sprint to invent its own recovery mechanism from
  scratch.
- − `ApprovalManager` gains a second construction path (`requestForRisk`) alongside `requestFor` — an
  accepted, narrowly-scoped exception to the "zero Capability-layer changes" precedent Sprint 2q/2r held,
  forced by `ExecutionPlan`'s documented non-persistence (ADR-0024), not a design preference.
- − An approved-but-never-decided-by-a-future-sprint apply anchor persists indefinitely as an inert Task
  — the same accepted "historical record" trade-off already made for approval/scope-clarification anchors
  (ADR-0032/0037), now made a third time.

### Relations
ADR-0037 (Multi-turn Code Scope Clarification — the plan-less anchor + discriminator technique reused a
second time), ADR-0032 (Conversation Runtime — `StatelessApprovalFlow`'s Task-anchor pattern, the
collision this sprint had to design around), ADR-0025 (CAP-004 Approval Capability + Aggregate Ownership
Rule — `requestForRisk` stays inside `ApprovalManager`, the aggregate's sole owner), ADR-0024 (CAP-003
Planning Capability — `ExecutionPlan`'s in-memory-only nature, the reason `requestForRisk` exists),
ADR-0038/0039 (AI Code Generation Preview / Unified Diff Preview — the `codeGenerationRef`/
`codeProposalRef`/`workspaceRef`/`targetFiles` this sprint's anchor threads through, unchanged),
ADR-0035 (Live Code Change Planning — `planningOnly`, unchanged). Supersedes nothing.
Plan: `docs/plans/sprint-2s-explicit-apply-approval-plan.md`.

## ADR-0041 — Approved Apply Context → PatchSet Preview (representation only, still no mutation)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2t — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (Round 1).
- **Date:** 2026-07-02
- **Scope:** Sprint 2t turns an **APPROVED** apply anchor (Sprint 2s) into a `PatchSet` **representation**
  via the existing Patch capability (CAP-005), and shows a PatchSet **preview**. After an explicit patch
  command, the runtime recovers the approved context, re-validates against the latest workspace content,
  and calls `PatchManager.generate`. Still no `WorkspaceWrite`, no file mutation, no `CommandExecution`, no
  git mutation. Actual apply is Sprint 2u.

### Most important rule
> **PatchSet generation ≠ file apply. `PATCH_READY` means a PatchSet representation exists — patchRef
> available, no workspace file modified, no command run, no git operation — NOT "applied" or "ready to
> apply."** The Patch capability stays representation-only: `PatchManager` validates only the passed
> `ApprovalRef` (status + plan-scope) and never queries `ApprovalManager` or touches the
> filesystem/git/WorkspaceWrite/CommandExecution. The Application layer recovers the `ApprovalRef`
> (`anchor.approvalId → approvals.get → approvalRef(request)`) and injects it.

### Decision
- **Reuses `PatchManager`/`PatchSet` (CAP-005, ADR-0026) unchanged — representation-only, verified against
  source (CA Q1):** `PatchManager.generate` validates `input.approvalRef.status === APPROVED` and the
  plan-scope match, maps each in-scope `ProposedChange` to a `PatchOperation` using the matching
  `FileDiff`, and `storage.patches.save`s the set. It imports no other capability manager and never
  touches the filesystem/git — persisting a `PatchSet` is representation storage, not mutation.
- **`ConversationRuntime` composes it directly** (like `CodeGenerationManager`/`WorkspaceManager.diff`
  before it): on an explicit patch command with an `APPROVED` anchor, it loads the `CodeProposal` by
  `codeProposalRef.id` (`storage.codeProposals.get` — the source of truth, never rendered diff text or
  chat history), re-filters against the authoritative `targetFiles` (`filterInScopeChanges`), **re-runs
  `WorkspaceManager.diff` against the current content** (CA Q6 — staleness/add/binary/empty check), derives
  the `ApprovalRef` and calls `PatchManager.generate({executionPlanRef, approvalRef, changes: inScope,
  diff})`. No `ExecutionOrchestrator` call, no new `ExecutionStage`.
- **The Application layer recovers and injects the `ApprovalRef`; `PatchManager` never queries
  `ApprovalManager` (CA Q2).** `PatchManager.generate` independently re-validates the ref as a
  belt-and-suspenders check.
- **Latest content is re-validated before generation, and anything unrenderable rejects the whole set
  (CA Q7).** `workspace.diff` throwing, an empty `diff.files`, any `changeKind: 'add'`, any binary, or any
  empty `unified` (oversized/size-skipped) yields no PatchSet and a `composePatchGenerationFailed` reply —
  a `PatchOperation` carrying an unapplyable diff would be unsafe for a future `WorkspaceWrite`.
- **New anchor state `PATCH_READY` + `patchRef?: PatchRef`, narrowly defined (CA Round 1 Required Change
  #1).** After generation the apply anchor is re-anchored `PATCH_READY`, preserving `patchRef` plus every
  prior ref (`executionPlanRef`, `workspaceRef`, `targetFiles`, `codeProposalRef`, `approvalId`) as the
  Sprint 2u handoff (CA Q12). `PATCH_READY` asserts only that a PatchSet representation exists — **not**
  that anything was applied; the enum carries this in its doc comment and the preview wording reinforces
  it. A repeated patch command at `PATCH_READY` is idempotent (`composePatchAlreadyGenerated`, no
  regeneration). `StatelessApplyPreviewFlow` needs no logic change (its status→`TaskStatus` mapping only
  special-cases `AWAITING_APPROVAL`; `PATCH_READY` is an inert `PENDING` anchor).
- **Explicit patch trigger, narrowed (CA Round 1 Required Change #2).** A dedicated `PATCH_WORDS` set of
  explicit patch phrases (`'패치 만들어'`, `'패치 생성'`, `'패치로 만들어'`, `'patch 만들어'`, `'generate
  patch'`, `'patchset 만들어'`, `'다음 단계 진행'`) — the ambiguous standalone `'계속 진행'` is deliberately
  excluded, and `'좋아'`/`'오케이'`/`'확인'` never match. Non-overlapping with `APPROVE_WORDS`/`APPLY_WORDS`
  by construction. Generation only fires on an `APPROVED` anchor: explicit patch phrase + `APPROVED` ⇒
  generation; a bare "continue" ⇒ never generation.
- **User-facing wording uses "패치 미리보기" framing (CA Round 1 Required Change #3)** and repeats "아직
  실제 파일에는 적용하지 않았어요 / 파일은 수정되지 않았어요"; forbidden: "적용했어요"/"반영했어요"/
  "수정했어요"/"변경 완료"/"적용 완료".
- **Generation failures are logged, structured, without diff/file content (CA Round 1 Required Change
  #4)** — `logger.warn('PatchSet generation failed', {reason, sessionId, executionPlanId, approvalId,
  codeProposalId, targetFiles})` — so operators can trace failures while the user sees only a safe reply.
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port.**
  `PatchManager` is already a registered provider (reused, not newly registered).

### Not implemented (out of scope)
Actual `WorkspaceWrite` apply · filesystem mutation · git mutation · `CommandExecution` · test execution
after patch generation · autonomous agent loop · retry loop · multi-file selection · directory/module
scope · semantic repository search · repository indexing · AI target-file guessing · new-file creation/
`changeKind: 'add'` support · provider-specific patch behavior · treating PatchSet generation as file
application · `PatchManager` querying `ApprovalManager` · generating a PatchSet for binary/oversized/
unrenderable changes · `ExecutionOrchestrator` contract change · `Core` contract change.

### Consequences
- + The approved modification now has a concrete, deterministic, scope-filtered `PatchSet` representation —
  the last safe artifact before actual mutation — built from the existing Patch capability with zero
  changes to it.
- + The "recover refs from a plan-less anchor → compose a capability directly" pattern (Sprint 2q/2r/2s)
  extends once more; `PatchManager` stays representation-only because the Application layer, not the
  capability, recovers the `ApprovalRef`.
- + Re-running `WorkspaceManager.diff` immediately before generation makes staleness a first-class,
  tested rejection rather than a latent risk carried into a future apply.
- − A fourth anchor state (`PATCH_READY`) and a `patchRef` field are added to `ApplyPreviewAnchor` — a
  justified extension (Sprint 2u handoff + repeat-command idempotency), not scope creep.
- − A generated-but-never-applied `PatchSet` persists in `storage.patches` as representation history — the
  same accepted "inert record" trade-off as prior anchors; a future Rollback/GC concern, not this sprint's.

### Relations
ADR-0026 (CAP-005 Patch Capability — `PatchManager`/`PatchSet`/`PatchGenerationInput`/`patchRef`, reused
representation-only), ADR-0040 (Explicit Preview Apply Approval — the `APPROVED` apply anchor + `approvalId`
this sprint consumes and extends to `PATCH_READY`), ADR-0025 (CAP-004 Approval — `approvalRef` derivation,
`ApprovalManager.get`; the boundary `PatchManager` must not cross), ADR-0039 (Unified Diff Preview —
`WorkspaceManager.diff` re-run + bounded/backtick-safe rendering, reused), ADR-0036 (Code Change Scope
Collection — `filterInScopeChanges`/`targetFiles` authority, reused), ADR-0029 (AI Code Generation —
`CodeProposal` content source via `storage.codeProposals`), ADR-0031 (Execution Orchestrator — deliberately
not extended). Supersedes nothing.
Plan: `docs/plans/sprint-2t-approved-apply-to-patchset-preview-plan.md`.

## ADR-0042 — PatchRef → WorkspaceWrite Apply (first real file mutation, WorkspaceWrite only)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2u — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (Round 1).
- **Date:** 2026-07-02
- **Scope:** Sprint 2u performs the product's **first real workspace file mutation.** From a `PATCH_READY`
  apply anchor (Sprint 2t), an explicit final workspace-apply command recovers the `PatchSet` by
  `patchRef`, verifies its integrity, and applies **exactly one `update` operation** through the existing
  WorkspaceWrite capability (CAP-006). Still no git mutation, no `CommandExecution`, no test execution, no
  `ExecutionOrchestrator` change.

### Most important rule
> **WorkspaceWrite is the only thing that mutates files, and Sprint 2u applies exactly one `update`
> operation, in-scope, from an integrity-verified PatchSet.** The PatchSet (loaded by `patchRef`) is the
> applied artifact — never the AI `CodeProposal`, rendered diff, or chat memory. Its embedded `approvalRef`
> authorizes the write (no `ApprovalManager` on the apply path). `WORKSPACE_APPLIED` means workspace files
> were mutated — **not** committed, pushed, tested, deployed, or a clean working tree.

### Decision
- **Reuses `WorkspaceWriteManager`/`WorkspaceChange`/`LocalWorkspaceWriter` (CAP-006, ADR-0027) unchanged**
  — verified against source (CA Q1). `apply({patchSet, approvalRef, workspaceRef})` is Ref-gated (validates
  `approvalRef.status === APPROVED` + plan-scope, never queries `ApprovalManager`), delegates each op to the
  `WorkspaceWriter` port, and persists a `WorkspaceChange`. File writes are **atomic-per-file, best-effort,
  with no cross-file rollback**.
- **`ConversationRuntime` composes it directly** (like every capability since Sprint 2q): on an explicit
  final-apply command with a `PATCH_READY` anchor, it loads the `PatchSet` via `patch.get(anchor.patchRef.id)`,
  runs the integrity gate, calls `workspaceWrite.apply`, checks the result, and re-anchors. No
  `ExecutionOrchestrator` call, no new `ExecutionStage`.
- **`update`-only, single-op this sprint (CA Round 1 #1/Q9).** The pre-write gate rejects unless the
  PatchSet has exactly one operation whose `operation === 'update'`, non-binary, whose path is within the
  user-approved `targetFiles`. This rejects multi-op (no partial-apply ambiguity given no cross-file
  rollback), `add`/new-file, `delete`, and binary. **`delete` is specifically rejected because
  `LocalWorkspaceWriter`'s delete path does not diff-check against current content** — only `update`/`add`
  run `applyPatch(current, op.diff)`; add is out anyway, so `update` is the only op with a genuine
  latest-content check.
- **Pre-write identity + scope checks (CA Round 1 #2):** `patchSet.id === anchor.patchRef.id`, and the op's
  path normalizes (`normalizeRelativePath`) to one of `anchor.targetFiles`. Plus `status === GENERATED`,
  `approvalRef.status === APPROVED`, `approvalRef.id === anchor.approvalId`, `executionPlanRef.id` match.
- **Latest-content revalidation is WorkspaceWrite's own `applyPatch` (CA Round 1 #4/Q6), for `update`
  only.** A stale diff no longer applies cleanly → `FileChangeResult.failed`, file left unchanged. No
  separate Application-layer re-diff (it would need lossy `newContent` reconstruction). A stale update
  therefore means WorkspaceWrite *is* called, returns a non-clean/`FAILED` result, the file is unchanged,
  and no `WORKSPACE_APPLIED` is set — it is not a "revalidation failure before WorkspaceWrite."
- **Post-write result-integrity gate (CA Round 1 #3):** `WORKSPACE_APPLIED` is set only if the returned
  `WorkspaceChange` is `APPLIED` **and** fully matches the artifact/context — `patchRef.id`/`approvalRef.id`/
  `executionPlanRef.id`/`workspaceRef.id`, `results.length === 1`, `results[0].status === 'applied'`,
  `results[0].path === op.path`. Anything else → safe failure, no re-anchor.
- **New anchor state `WORKSPACE_APPLIED` + `workspaceChangeRef?` (CA Q8/Round 1 #6).** Preserves the
  `WorkspaceChange` record for a future git/test sprint. It means files were mutated **only** — not
  committed/pushed/tested/deployed, and not a clean working tree; the enum comment and the reply copy say so.
- **Explicit final trigger, distinct from all prior word-sets (CA Round 1 #7/Q3).** `FINAL_APPLY_WORDS`
  (`'최종 적용'`, `'파일에 적용'`, `'패치 적용'`, `'workspace에 적용'`, `'apply patch'`, `'apply to
  workspace'`) — qualified phrases only. A bare "적용"/"좋아"/"오케이"/"확인"/"다음 단계 진행" never triggers
  a file write. Checked **before** apply-intent so "패치 적용해줘" (which also contains the apply-word "적용")
  routes to the file-apply path, not Sprint 2s's apply-intent.
- **`WORKSPACE_APPLIED` never hides the applied state (CA Round 1 #8).** A final/patch/apply intent at
  `WORKSPACE_APPLIED` all route to `composeWorkspaceAlreadyApplied` — never `handlePatchAlreadyGeneratedTurn`
  ("preview generated") or `handleApplyAlreadyApprovedTurn` ("not yet applied"), which would understate the
  stronger state.
- **Precise git wording (CA Round 1 #5).** After a write the working tree holds the change, so the copy
  never says "git 변경 없음"; it says the file was modified, git **commands** were not run, commit/push were
  not performed, tests were not run, and the working tree may now show the change. Forbidden across all
  replies: "git 변경 없음"/committed/pushed/deployed/테스트 통과/검증 완료.
- **Structured, no-content failure log** for operability (mirrors Sprint 2t): sessionId, executionPlanId,
  approvalId, patchId, targetFiles — never diff/file content.
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port.**
  `WorkspaceWriteManager` is already a registered provider (reused). `PatchManager` gains no apply behavior.

### Not implemented (out of scope)
`git add`/`commit`/`push` (or any git call) · `CommandExecution` · test execution after apply · shell
commands · autonomous agent loop · retry loop · AI regeneration · AI target-file guessing · multi-file/
multi-op apply · directory/module scope · semantic repository search · repository indexing · `add`/
new-file/`changeKind:add` · `delete` operations · binary operations · applying an unapproved/out-of-scope
PatchSet · applying without a `PATCH_READY` anchor · `ExecutionOrchestrator` contract change · `Core`
contract change · `PatchManager` gaining apply behavior · treating apply success as git success.

### Consequences
- + The product can, for the first time, turn an approved, previewed, patch-represented change into a real
  edit of one existing file — behind five prior safety gates and one explicit final command — reusing the
  battle-tested WorkspaceWrite capability with zero changes to it.
- + Restricting to a single in-scope `update` op makes the first mutation sprint maximally safe: no
  partial-apply ambiguity, no unchecked delete, no new-file/binary surprises; staleness is caught by
  WorkspaceWrite's own clean-apply check.
- + The pre-write (identity/scope) and post-write (result-integrity) gates make the anchor→PatchSet→
  WorkspaceChange chain verifiable end-to-end before `WORKSPACE_APPLIED` is trusted.
- − A `WORKSPACE_APPLIED` anchor and a `workspaceChangeRef` field are added to `ApplyPreviewAnchor` — a
  justified extension (git/test-sprint handoff), not scope creep.
- − After a successful apply the working tree is dirty but git is untouched — an intentional, clearly-worded
  state; committing/testing is a separate future sprint.
- − `add`/`delete`/binary/multi-file apply are deferred; a future sprint must make delete's stale-content
  check explicit before allowing it.

### Relations
ADR-0027 (CAP-006 Workspace Write — `WorkspaceWriteManager`/`WorkspaceChange`/`LocalWorkspaceWriter`, reused
as the sole file mutator), ADR-0041 (Approved Apply Context → PatchSet Preview — the `PATCH_READY` anchor +
`patchRef` this sprint consumes and extends to `WORKSPACE_APPLIED`), ADR-0026 (CAP-005 Patch — `PatchSet`/
`PatchManager.get`, representation-only, gains no apply behavior), ADR-0025 (CAP-004 Approval — the embedded
`approvalRef` authorizes the write; `ApprovalManager` untouched on the apply path), ADR-0036 (Code Change
Scope Collection — `normalizeRelativePath`/`targetFiles` authority, reused for the op-path scope check),
ADR-0031 (Execution Orchestrator — deliberately not extended). Supersedes nothing.
Plan: `docs/plans/sprint-2u-patchref-to-workspacewrite-apply-plan.md`.

## ADR-0043 — Post-Apply Validation Command (WORKSPACE_APPLIED → explicit validation via CommandExecution)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2v — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (7 required changes applied) → PROCEED.
- **Date:** 2026-07-02
- **Scope:** After Sprint 2u leaves a `WORKSPACE_APPLIED` apply anchor (a real file mutation happened;
  git/tests were NOT run), a later turn with an **explicit validation command** runs **exactly one**
  pre-approved validation command (`pnpm test` or `pnpm typecheck`) through the existing **CommandExecution**
  capability (CAP-007), against the workspace the file was applied to, and shows the result. Still **no git,
  no commit/push, no additional file mutation, no rollback, no `ExecutionOrchestrator` change.**

### Most important rule
> **CommandExecution is the only thing that runs a command, and Sprint 2v runs exactly one derived,
> allow-listed validation command (`pnpm test`/`pnpm typecheck`) per turn, only on an explicit request, only
> on a `WORKSPACE_APPLIED` anchor, against `anchor.workspaceRef`.** The command + args are DERIVED from the
> detected validation intent — never copied from user text. `WORKSPACE_APPLIED` stays `WORKSPACE_APPLIED`; a
> passing validation is **point-in-time only** (no `WORKSPACE_VALIDATED` state).

### Decision
- **Reuses `CommandExecutionManager`/`CommandExecution`/`CommandExecutionRef` (CAP-007, ADR-0028) unchanged**
  — the sole command runner: allow-list (`{'pnpm','npm','node'}`) + dangerous-arg + risk + Ref-only approval
  gates before the `CommandRunner` port (argv array, no shell, cwd = workspace root, timeout). `pnpm test`/
  `pnpm typecheck` are MEDIUM risk (`RiskPolicy.assessCommand`) → **no approval** required. Reuses the Sprint
  2m/2n bounded-output rendering helpers.
- **`ConversationRuntime` composes it directly** (like every capability since Sprint 2q): on an explicit
  post-apply validation command with a `WORKSPACE_APPLIED` anchor, it calls `command.run({executionPlanRef:
  anchor.executionPlanRef, workspaceRef: anchor.workspaceRef, workspaceChangeRef: anchor.workspaceChangeRef,
  command:'pnpm', args:['test'|'typecheck']})`. **No `ExecutionOrchestrator` call, no new `ExecutionStage`.**
  Direct call (not the orchestrator) is required so the run reuses `anchor.executionPlanRef` and can carry
  `workspaceChangeRef` (the orchestrator's `COMMAND_EXECUTION` stage mints its own plan and omits
  `workspaceChangeRef`).
- **Validation is explicit; never automatic.** A `WORKSPACE_APPLIED` anchor being created (Sprint 2u apply
  success) runs zero commands. Validation only fires on a later turn with an explicit validation phrase.
- **Trigger (CA Round 1 #1/#2).** `interpretPostApplyValidationIntent`: `typecheck`/`타입체크`/`type check` →
  `pnpm typecheck`; (`테스트`|`test`)+action-verb or `pnpm test` → `pnpm test`; **both requested → clarify
  (never a silent pick)**; bare `검증`/`validate` → clarify; **a validation phrase carrying a dangerous/
  arbitrary command fragment → unsupported/reject (no run)** via a small deterministic denylist
  (`rm -rf`/git/curl/cat/grep/npm|pnpm install/pnpm build/node -e/`;`/`&&`/`||`/`|`/`>`); a message with no
  validation token → falls through. "좋아"/"오케이"/"확인"/"다음 단계 진행"/"계속 진행" never trigger. Command
  + args are DERIVED, never user text. **One command per turn.**
- **Post-apply flow is gated on `WORKSPACE_APPLIED` (CA Round 1 #7).** With no such anchor, the existing
  Sprint 2l general Live Test Execution flow (classifier → `IntentResolver` → orchestrator `TEST_EXECUTION`)
  is unchanged; the detector is consulted only inside the `WORKSPACE_APPLIED` routing guard.
- **Clarify/unsupported are NORMAL responses (CA Round 1 #3)** — `RESPONDED`, record the assistant reply,
  never `failComposed`; nothing runs, the anchor is not re-anchored, no ref is set.
- **`postApplyValidationRef` preserved only when a `CommandExecution` exists (CA Round 1 #4/#6).** On a
  terminal run (SUCCEEDED/FAILED/TIMED_OUT) the anchor is re-anchored with
  `postApplyValidationRef = commandExecutionRef(execution)` — **latest only** (replaces any prior; no history
  on the anchor — CommandExecution storage owns history). A throw before an aggregate exists → no re-anchor,
  no ref. `status` stays `WORKSPACE_APPLIED`. **No `WORKSPACE_VALIDATED`** — a pass can go stale; VALIDATED
  would overstate durability.
- **Failure/timeout do not rollback (CA Q10/Q11).** No WorkspaceWrite, no git; failure shows the project's
  result (not a bot error); timeout is distinct from a failure verdict (no exit code); the anchor is kept.
- **Precise wording on all terminal outcomes (CA Round 1 #5).** Passed/failed/timeout all state git commands
  were NOT run **and** commit/push were NOT performed; success is "이번 실행 기준으로 통과했어요"; failure adds
  that no rollback happened; timeout adds that validation did not complete. Forbidden across all replies:
  git 변경 없음 / clean tree / committed / pushed / deployed / 완전히 검증됐어요 / 배포 가능해요 / 영구적으로
  안전.
- **Validation may create tool/runtime artifacts, but the product makes no clean-tree claim (CA Constraint
  5).** `pnpm test`/`pnpm typecheck` may write tool caches / build info inside the workspace as a property of
  the existing CommandExecution environment; this is NOT source mutation — **WorkspaceWrite remains the only
  source mutator** — and the product never runs git, inspects the tree, or claims it is clean.
- **No Core/Orchestrator contract change; no new aggregate/repository/migration/capability/port/anchor
  status.** `CommandExecutionManager` is already a registered provider (reused, unchanged); `PatchManager`
  gains no behavior and is not called on this path.

### Not implemented (out of scope)
`git status`/`git diff`/`git add`/`git commit`/`git push` (or any git call) · deployment · `pnpm install`/
`npm install` · `pnpm build` · `rm`/`cat`/`grep`/`curl`/arbitrary shell · `node arbitrary.js` · any
user-supplied shell text · command composition/chaining · automatic validation after apply · AI deciding
which validation to run · running both test and typecheck in one turn · re-running CodeGeneration ·
regenerating PatchSet · `WorkspaceWrite`/any further file mutation · rollback · `ExecutionOrchestrator` stage
change or new stage · `Core` contract change · `CommandExecutionManager` behavior change · a
`WORKSPACE_VALIDATED` anchor state · claiming committed/pushed/tested-forever/verified/deployed/clean tree.

### Consequences
- + After applying a change, the user can, for the first time, run a bounded validation command (`pnpm
  test`/`pnpm typecheck`) against the exact workspace the file was modified in — reusing the built, gated
  CommandExecution capability with zero changes to it, behind an explicit-command gate.
- + One-command-per-turn + derived-args + a denylist keep the riskiest capability narrow: no arbitrary
  shell, no both-at-once ambiguity, no destructive fragment slipping through.
- + The run is tied to the applied change (`workspaceChangeRef`) and preserved as `postApplyValidationRef`,
  keeping the Execution Ledger chain (Plan → Approval → PatchSet → WorkspaceChange → CommandExecution)
  verifiable, without inventing a new aggregate or a durable "validated" state.
- − `ApplyPreviewAnchor` gains one optional field (`postApplyValidationRef?`) — a justified extension
  (validation-result handoff), latest-only, not a history store.
- − A validation pass is point-in-time; the product deliberately does not claim durable verification, a
  clean tree, or deploy-readiness. Git/commit and any test-automation-after-apply remain separate future
  sprints.

### Relations
ADR-0028 (CAP-007 Command Execution — `CommandExecutionManager`/`CommandExecution`/`CommandExecutionRef`,
reused as the sole command runner, unchanged), ADR-0033/0034 (Live Test Execution + Test Result Detail UX —
`TestResultDetail`, `composeTestResult`/`composeTestTimedOut`, bounded-output helpers reused; the Sprint 2l
general flow preserved when no `WORKSPACE_APPLIED` anchor exists), ADR-0042 (PatchRef → WorkspaceWrite Apply
— the `WORKSPACE_APPLIED` anchor + `workspaceRef`/`workspaceChangeRef` this sprint consumes and extends with
`postApplyValidationRef`), ADR-0025/0026 (Approval/Patch Refs — validation is MEDIUM, no approval; Patch
untouched), ADR-0031 (Execution Orchestrator — deliberately not extended or called on this path). Supersedes
nothing. Plan: `docs/plans/sprint-2v-post-apply-validation-command-plan.md`.

## ADR-0044 — Post-Validation Git Status Preview (WORKSPACE_APPLIED → read-only Git status/diff preview)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2w — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (10 required changes applied) → PROCEED.
- **Date:** 2026-07-02
- **Scope:** After Sprint 2u leaves a `WORKSPACE_APPLIED` anchor (real file mutation) and Sprint 2v optionally
  records a `postApplyValidationRef`, a later turn with an **explicit git-preview command** returns a
  **bounded, read-only** summary of the current working tree through the **Git** capability (CAP-002),
  against `anchor.workspaceRef`. Still **no git mutation, no CommandExecution, no WorkspaceWrite, no file
  mutation, no `ExecutionOrchestrator` change.**

### Most important rule
> **Sprint 2w is read-only. The Git capability is the only thing that touches git; the runtime never shells
> out; only `status` and a new read-only `diff` run — never add/commit/push/reset/checkout/stash/branch/tag/
> merge/rebase.** A git-MUTATION phrase is rejected with a read-only reminder. Nothing is persisted (no
> `GIT_PREVIEWED` state, no ref, no re-anchor). Output is bounded and truncation-labeled; the product never
> claims committed/pushed/deployed/safe-to-commit/verified/clean beyond what Git reports.

### Decision
- **Reuses `GitManager.status`/`GitProvider.status`/`GitStatus` (CAP-002, ADR-0023) unchanged** for the
  status/changed-files preview. Read-only; takes a plain `rootPath`; adapter runs read-only subcommands via
  argument-array `spawnSync`, timeout, masked stderr.
- **Adds the minimal read-only `diff` extension (CA #1, approved):** `GitDiff` domain type +
  `GitProvider.diff` + `GitManager.diff` + `LocalGitProvider.diff`. Read-only, **argument-array only**:
  `git --no-pager diff --no-ext-diff --no-color [--name-only] HEAD` (files from `--name-only`, unified from
  the plain form); unborn-HEAD fallback drops `HEAD`. Never a mutating subcommand, never a shell string,
  never user args/pathspec. Hard adapter cap (`MAX_DIFF_CHARS = 20 000`) sets `truncated`. No aggregate/Ref/
  storage; ADR-0023's mutation boundary is unchanged (extended read-only).
- **`ConversationRuntime` composes it directly** (like every capability since Sprint 2q): on an explicit
  git-preview command with a `WORKSPACE_APPLIED` anchor, it calls `git.status`/`git.diff` against
  `anchor.workspaceRef.rootPath`. **No `ExecutionOrchestrator` call, no new `ExecutionStage`.**
- **Preview is explicit; never automatic.** Neither apply success (2u) nor validation success (2v) runs git.
  Only a later turn with an explicit git-preview phrase does.
- **Trigger (CA #5/#6).** `interpretGitPreviewIntent`: **mutating git phrases checked FIRST** (precedence
  over diff/status) → reject; `diff`/`디프` → diff; `git 상태`/`깃 상태`/`변경 파일`/`변경사항`/`바뀐 파일`/
  `커밋 전` → status; else null. Korean "커밋 전에 변경사항 요약" is status (커밋 without an action verb);
  **English `commit` stays conservative** (any `commit` token → mutating). "좋아"/"오케이"/"확인"/"다음 단계
  진행"/"검증됐네" → null.
- **Gated on `WORKSPACE_APPLIED` (CA Q3).** With no such anchor, neither git detector is consulted and **no
  broad general git handling** is created; the message falls through unchanged.
- **Diff preview reads BOTH status and diff (CA #2).** `git diff HEAD` excludes untracked file *contents*, so
  a diff preview also reads `status` (branch/clean + untracked paths) and states "diff는 추적 중인 파일
  변경만 포함해요. untracked 파일은 상태 목록에만 표시돼요." Binary files show git's marker line only, never
  binary content (CA #3).
- **Layered, labeled bounds (CA #4).** changed files ≤ 30; diff files displayed ≤ 5; diff display ≤ 3000
  chars before the final `MAX_MESSAGE_CHARS` (1900) clamp; adapter hard cap upstream. Any truncation at any
  layer is user-facing-labeled.
- **Validation context is display-only and never fails the preview (CA Q8/#8).** If `postApplyValidationRef`
  resolves via the existing read-only `commandExecutions.get`, show "최근 검증 기록: {command} {status}
  (이번에 다시 실행하진 않았어요)"; a null/throwing lookup → "최근 검증 기록을 불러올 수 없어요." and the
  preview still proceeds; no ref → "검증 기록 없음". No validation is ever re-run; no CommandExecution.
- **No persistence / no re-anchor (CA #9).** No `GIT_PREVIEWED`, no `postApplyGitPreviewRef`, no
  `GitStatusRef`/`GitDiffRef`, no storage; the apply anchor is never re-anchored on this path.
- **Git read failure → safe failure, no fallback (CA #7/Q10).** A `git.status`/`git.diff` throw →
  `composeGitPreviewUnavailable`; **no CommandExecution, no shell, no workspace re-resolution**. On a diff
  preview, `git.status` is read first; if it throws, `git.diff` is not called. **(CA Implementation Review)**
  Because a read-only git subcommand *was* attempted on this path, the failure copy must **not** claim "git
  명령은 실행하지 않았어요"; it states no git add/commit/push, no file mutation, and no CommandExecution/shell
  fallback.
- **Read-only-vs-mutation wording (CA #10).** Every successful preview states "읽기 전용 Git 미리보기 / git
  add·commit·push 안 함 / 파일 수정 안 함 / 명령 실행 안 함." Forbidden: 커밋 준비 완료 / push 가능 / 배포
  가능 / 안전함 / 검증 완료 / committed / pushed / deployed / safe to commit / verified forever. "현재 Git
  기준 변경 파일이 없어요." only when Git reports clean; never infers tests passed.
- **No Core/Orchestrator contract change beyond the read-only `GitProvider` method; no new aggregate/
  repository/migration/capability/anchor state.** CommandExecution/WorkspaceWrite/Patch untouched and
  uncalled on this path.

### Not implemented (out of scope)
`git add`/`commit`/`push`/`reset`/`checkout`/`stash`/`branch`/`tag`/`merge`/`rebase` (any git mutation) ·
branch/PR creation · deployment · CommandExecution (or a shell git through it) · runtime shelling out to git
· WorkspaceWrite/file mutation · automatic git preview after apply or validation · AI deciding whether to
commit · commit-message generation · multi-command git workflow · broad general git handling outside the
`WORKSPACE_APPLIED` path · `ExecutionOrchestrator` change/new stage · a `GIT_PREVIEWED` state / git-preview
persistence / re-anchor · remote-URL exposure · clean-tree/deploy/commit overclaim.

### Consequences
- + After applying (and optionally validating) a change, the user can inspect the working tree ("무슨 파일이
  바뀌었지 / diff 보여줘") through the built, read-only Git capability — behind an explicit-command gate,
  against the exact workspace the file was modified in.
- + The diff extension is genuinely read-only (argv-only `git diff`, `--no-ext-diff`), following the existing
  adapter pattern; the ADR-0023 mutation boundary is unchanged.
- + Reading both status+diff makes untracked files honest (never silently omitted, never dumped as binary),
  and layered bounds keep the chat message safe.
- − Git capability gains a read-only `diff` method (+ `GitDiff` type) — a justified read-only extension, not
  a mutation surface.
- − A validation pass shown in context is record-only and point-in-time; the product deliberately does not
  claim durable validity, a clean tree, or deploy-readiness. Git mutation (add/commit/push) remains a
  separate future sprint.

### Relations
ADR-0023 (CAP-002 Git — `GitManager`/`GitProvider`/`GitStatus`/`LocalGitProvider`, reused read-only; extended
with a read-only `diff`), ADR-0042 (WorkspaceWrite Apply — the `WORKSPACE_APPLIED` anchor + `workspaceRef`
this sprint reads against), ADR-0043 (Post-Apply Validation — the `postApplyValidationRef` shown as read-only
context via the existing `commandExecutions.get`), ADR-0034 (Test Result Detail UX — message-budget/fence
helpers reused), ADR-0031 (Execution Orchestrator — deliberately not extended or called). Supersedes nothing.
Plan: `docs/plans/sprint-2w-post-validation-git-status-preview-plan.md`.

## ADR-0045 — Explicit Git Commit Approval (WORKSPACE_APPLIED → commit approval halt, NO git mutation)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2x — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (14 required changes applied) → PROCEED.
- **Date:** 2026-07-02
- **Scope:** After Sprint 2u leaves a `WORKSPACE_APPLIED` anchor (real file mutation) — optionally validated
  (2v) and previewed read-only (2w) — an explicit commit request **plans** a git commit: read-only
  `git.status` → in-scope candidate files → deterministic commit message → **HIGH `ApprovalRequest`** → halt
  at a commit-approval-pending state. **This sprint performs NO git mutation** — no `git add`/`commit`/`push`,
  not even after the user approves (execution is a future Sprint 2y). It only creates the approval gate.

### Most important rule
> **A git commit is a repository mutation, so Sprint 2x stops before it.** The runtime reads only
> `git.status` (never `git.diff`), creates a HIGH `ApprovalRequest`, and halts; nothing git-mutating runs —
> not on request, not on approval. `COMMIT_APPROVED` means the commit was **approved, not performed**; there
> is no `COMMITTED`/`GIT_COMMITTED` state and no overclaim (safe-to-commit / ready-to-push / deployed / committed).

### Decision
- **Reuses `ApprovalManager.requestForRisk`/`decide`/`get` (CAP-004)** and the Sprint 2s approval-#2 runtime
  pattern (`interpretDecision`/`decisionOf`/`APPROVE|DENY|CANCEL_WORDS`/`composeApprovalNotice`). `requestForRisk`
  creates a PENDING HIGH `ApprovalRequest` (never auto-approves). **`GitManager.status` (read-only, 2w `git`
  dep) is the only git call; `git.diff` is never called (CA #1).** No new capability/port/aggregate/dep.
- **`ConversationRuntime` composes it directly.** New anchor statuses `COMMIT_APPROVAL_PENDING` (a real HIGH
  approval pending — intercepts every turn) and `COMMIT_APPROVED` (approved; context preserved for Sprint 2y),
  plus fields `commitApprovalId`/`proposedCommitMessage`/`commitCandidateFiles`. **No `COMMITTED`/`GIT_COMMITTED`.**
- **Plan-less anchor ↔ `StatelessApprovalFlow`.** The apply/commit anchor Task carries no `planId`, so
  `findPending` (which needs `task.planId`) never returns the commit approval — it is handled solely via the
  `COMMIT_APPROVAL_PENDING` interception. `StatelessApplyPreviewFlow` maps that status to `WAITING_APPROVAL`
  (observability); the task stays plan-less.
- **Trigger (CA #3).** `interpretCommitIntent`: commit words → `'commit'`; a commit bundled with push/add/
  reset/… companion → `'commit-with-forbidden'` (rejected, priority over commit); push/add/reset-**only** (no
  commit word) → null (Sprint 2w mutating-reject handles it, unchanged); "커밋 전에 변경사항 요약" (no action
  verb) → 2w status. Bare 좋아/오케이/확인/다음 단계/진행해/이대로 해 → null.
- **Candidate files + defensive safety (CA #6/#14).** candidates = changed (`staged ∪ unstaged ∪ untracked`)
  ∩ `targetFiles`, each path through `safeRelativePath` (absolute/`..`/empty/non-normalizable → unsafe →
  out-of-scope). Clean tree → no approval; any out-of-scope/unsafe path OR empty in-scope set → bounded
  warning, no approval. Lists bounded (out-of-scope ≤10, candidates ≤30).
- **Commit message (CA #6/#7/#8).** Deterministic template (`chore: update <targetFiles>`), ≤120 chars, no
  AI; a user-provided message is accepted only if exactly one quoted segment, single-line, ≤120,
  control-char-free, trimmed (backticks/punctuation allowed within bounds) — else `composeCommitMessageInvalid`,
  no approval. No diff interpolation.
- **Approval reason (CA #4/#11).** operation "git commit approval planning" · workspaceRef id · bounded
  candidate files · commit message · validation context · risk HIGH · "no git add/commit/push has been
  performed" · "records permission only; actual commit deferred to a later step". **No raw diff / file content.**
- **Strict decision guards (CA #2/#3).** Before deciding: the pending context must be complete (status
  `COMMIT_APPROVAL_PENDING` + `commitApprovalId` + `proposedCommitMessage` + non-empty `commitCandidateFiles`
  + `workspaceRef` + `workspaceChangeRef` + `executionPlanRef`), and `approvals.get(commitApprovalId)` must
  exist, be PENDING, and match `anchor.executionPlanRef.id`. Any failure → safe failure, no `decide`, no git,
  no re-anchor. Ambiguous decision → re-prompt, preserving pending context (no decide/new approval).
- **After decision (CA #9/#10/#11/#12).** Approve → `decide` APPROVED, re-anchor `COMMIT_APPROVED`,
  `composeCommitApprovalRecorded` ("승인 기록; 아직 실제 커밋 안 함" — never "커밋 완료"/committed). Deny/cancel
  → `decide` REJECTED, **revert to `WORKSPACE_APPLIED` clearing only the commit fields** (preserving
  `workspaceRef`/`workspaceChangeRef`/`postApplyValidationRef`/`targetFiles`), with **commit-specific**
  replies ("이미 적용된 파일 변경은 그대로 있어요") — never the generic `composeExecutionResult`.
- **Read failure wording (CA #9/#12).** A `git.status` throw → `composeCommitStatusUnavailable` (a read was
  attempted; never "git 명령은 실행하지 않았어요"), no approval, no CommandExecution/shell fallback. Wrong
  state / incomplete pending context → the distinct `composeCommitUnavailable`.
- **Validation context (CA #10/Q10).** Displayed via the read-only `commandExecutions.get` (2w helper);
  a lookup failure never blocks the approval; validation is not required.
- **No Core/Orchestrator contract change; no `app.module.ts` change** (no new dep/provider). No `GitProvider`
  mutation method. No CommandExecution/shell git, no WorkspaceWrite/Patch/CodeGeneration/Orchestrator.

### Not implemented (out of scope)
`git add`/`commit`/`push`/`reset`/`checkout`/`stash`/`branch`/`tag`/`merge`/`rebase` · **actual commit
execution even after approval** (Sprint 2y) · automatic commit · AI commit messages · `GitProvider`
add/commit/push · `git.diff` on this path · CommandExecution-based git · runtime shell-out · WorkspaceWrite ·
Patch · CodeGeneration · ExecutionOrchestrator change · PR creation · deployment · a `COMMITTED`/`GIT_COMMITTED`
state · persisting raw diff · overclaim (safe-to-commit/ready-to-push/deploy/committed).

### Consequences
- + The user can, for the first time, request a git commit of the bot-applied change and get a bounded,
  read-only summary + a deterministic commit message + a HIGH approval gate — behind an explicit request,
  with zero git mutation.
- + Reusing the proven approval-halt pattern (2s) and the plan-less anchor keeps the design small and keeps
  `findPending` from hijacking the commit approval.
- − `ApplyPreviewAnchor` gains two statuses + three commit fields — a justified extension for the Sprint 2y
  executor, not scope creep; nothing is persisted beyond refs/message/candidate paths (no raw diff).
- − Approval is recorded but the commit is deliberately not performed; git mutation (add/commit/push) remains
  a separate, individually-reviewed future sprint.

### Relations
ADR-0025 (CAP-004 Approval — `ApprovalManager.requestForRisk`/`decide`/`get`, reused), ADR-0040 (Sprint 2s
explicit apply approval — the approval-#2 halt pattern + plan-less anchor reused), ADR-0044 (Post-Validation
Git Status Preview — read-only `git.status` reused; `git.diff` deliberately not used here), ADR-0043
(Post-Apply Validation — `postApplyValidationRef` shown as display-only context via `commandExecutions.get`),
ADR-0023 (CAP-002 Git — read-only; **no mutation method added**), ADR-0031 (Execution Orchestrator —
deliberately not extended or called). Supersedes nothing. Plan:
`docs/plans/sprint-2x-explicit-git-commit-approval-plan.md`.

## ADR-0046 — Approved Git Commit Execution (COMMIT_APPROVED → single exact-file `git commit`, first Git mutation)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2y — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (14 required changes applied) → PROCEED.
- **Date:** 2026-07-03
- **Scope:** After Sprint 2x leaves a `COMMIT_APPROVED` anchor (a HIGH commit approval was granted, but
  nothing was committed), an explicit commit-**execution** command ("승인된 커밋 실행해줘") re-reads git status,
  re-verifies the live approval + exact candidate scope against the fresh working tree, and performs **a
  single exact-file `git commit`** via the Git capability. This is the product's **FIRST real git mutation**.
  **NO `git add`, NO push, NO PR, NO deployment, NO rollback, NO CommandExecution/shell, NO
  WorkspaceWrite/Patch/CodeGeneration, NO ExecutionOrchestrator change.**

### Most important rule
> **The commit is executed only when the approved scope still exactly matches a freshly-read working tree.**
> The runtime re-reads `git.status`, re-verifies the live `ApprovalRequest` (exists, APPROVED, same plan) and
> that the in-scope tracked-changed set **equals** the approved candidate set, then commits exactly those
> tracked files through the Ref-gated `GitManager.commitFiles`. `GIT_COMMITTED` means **committed locally,
> never pushed/deployed** — every reply says so. Any scope drift, stale approval, untracked candidate, or
> result-integrity mismatch → **safe failure, no commit** (a new approval is required).

### Decision
- **First mutating Git API (Q1, CA #1/#6/#7/#8/#13).** `GitCommitResult {commitHash, committedFiles, message}`
  (domain) + `GitProvider.commitFiles(rootPath, files, message)` (the **first** mutating port method) +
  `GitManager.commitFiles({rootPath, files, message, approvalRef})`. The **manager** is Ref-gated
  (`approvalRef.status === APPROVED`, mirrors `WorkspaceWriteManager.apply`) **plus** defensive input
  validation (non-empty rootPath/files, safe relative paths, unique after trim, valid bounded single-line
  message); the **provider** independently validates + de-dups paths (absolute/`..`/empty rejected **before
  any git runs**) and is argv-only. **`ApprovalRef` goes to the manager, not the provider (CA #13).**
- **No pre-commit `git add`; tracked-file exact commit only (Q2, CA #1/#2).** The adapter runs a single
  `git commit --only -m <message> -- <files>` of the exact **tracked** pathspecs, then `rev-parse HEAD` for
  the sha. A separate `git add` was rejected: it would persist a partial stage if the commit then failed, and
  Sprint 2y has **no rollback**. **Untracked approved candidates are blocked** with a DISTINCT reply
  (`composeCommitExecutionUntrackedUnsupported`, CA #3) — a new-file commit needs a separate future step.
- **`ConversationRuntime` composes it directly.** New anchor status `GIT_COMMITTED` (a commit was executed) +
  fields `commitHash`/`committedFiles`. **No `GitCommit` aggregate** (Q9) — the hash + files live on the anchor.
- **Trigger + routing (§5.4, CA #4).** `interpretCommitExecutionIntent`: a push/reset/… phrase →
  `'push-unsupported'` (checked first); an explicit execution phrase ("승인된 커밋 실행"/"커밋 실행"/"이제 실제
  커밋"/"execute commit"/…) → `'execute'`; bare 좋아/오케이/확인/진행해/다음 단계 → null. Execution handling is
  **gated to commit-relevant states only** — inside `COMMIT_APPROVED` (execute → run) and `GIT_COMMITTED`
  (execute → already-committed) blocks, checked **before** the 2x commit-intent so "이제 실제 커밋해줘" executes
  rather than re-printing already-approved. An explicit `'execute'` phrase with no commit-relevant anchor →
  scoped `composeCommitExecutionUnavailable`. push-only outside commit states is left to existing 2w/2x handling.
- **Exact-scope re-validation against fresh status (§5.5, Q3/Q4/Q5/Q6, CA #2/#11).** Sets are normalized via
  `safeRelativePath` + de-duplicated (a candidate in BOTH staged and unstaged is still eligible). Block (→
  new approval required) on: an unsafe/out-of-`targetFiles` approved candidate; any unsafe changed path; a
  candidate no longer a tracked change (`missing`, Q5); an extra in-scope tracked change beyond the candidates
  (`extraInScope`, Q6); any changed file (tracked or untracked) outside `targetFiles` (`outOfScope`, Q4); any
  staged file outside the candidates (`stagedOutsideCandidates`, Q3). An untracked approved candidate → the
  DISTINCT untracked-unsupported reply. The approved message is re-checked with `isValidCommitMessage`;
  invalid → new approval required (Q7). Never regenerate, ask AI, or accept a new message at execution.
- **Result-integrity gate BEFORE trusting the commit (Q10, CA #8).** After `git.commitFiles`: `commitHash`
  non-empty + SHA-shaped (`/^[0-9a-f]{7,40}$/i`); `committedFiles` (normalized) **exactly equal** the approved
  candidates; `message` **equals** the approved message. Any mismatch → safe failure
  (`composeCommitExecutionFailed`), **`GIT_COMMITTED` not set**, do not claim committed.
- **On success (Q9/Q10, CA #9).** Re-anchor `GIT_COMMITTED` storing `commitHash` + `committedFiles`;
  **preserve `commitApprovalId`** (audit/threading) + `workspaceRef`/`workspaceChangeRef`/`targetFiles`/
  `executionPlanRef`/`postApplyValidationRef` (a future push sprint needs them); **clear**
  `proposedCommitMessage` + `commitCandidateFiles` (replaced by `committedFiles`/hash). Reply: short hash +
  bounded files + **no push**. Repeat execution at `GIT_COMMITTED` → `composeCommitAlreadyCommitted` (hash
  shown), **no new commit** (Q11).
- **Failure wording (Q8, CA #10).** A `git commit` throw or integrity mismatch → `composeCommitExecutionFailed`,
  which states **not committed + no push + rollback NOT performed + re-check git state**; it MUST NOT claim
  변경 없음 / 원상복구 완료 / index unchanged / 안전하게 되돌렸어요. Raw stderr never reaches the reply (adapter
  masks). A `git.status` read throw reuses `composeCommitStatusUnavailable` (2x).
- **No Core/Orchestrator contract change; no `app.module.ts` change** (the `git` runtime dep already carries
  the already-registered `GitManager`; `commitFiles` is a type-only widening). No CommandExecution/shell git,
  no WorkspaceWrite/Patch/CodeGeneration/Orchestrator, no runtime shell-out.

### Not implemented (out of scope)
`git add`/`push`/`reset`/`checkout`/`stash`/`branch`/`tag`/`merge`/`rebase` · untracked/new-file commit ·
automatic commit · AI commit messages · accepting a new message at execution · a `GitCommit` aggregate ·
CommandExecution-based git · runtime shell-out · WorkspaceWrite · Patch · CodeGeneration ·
ExecutionOrchestrator change · PR creation · deployment · rollback/revert · pushing/deploying the commit ·
overclaim (pushed/deployed/ready-to-push/safe-to-deploy).

### Consequences
- + The user can, for the first time, execute a git commit of the bot-applied change — behind an explicit
  execution command, gated by a still-valid HIGH approval and an exact-scope re-check against a freshly-read
  working tree, committing exactly the approved tracked files and nothing else.
- + Ref-gating the manager (mirroring `WorkspaceWriteManager`) plus independent provider path validation and a
  post-commit result-integrity gate keeps the first git mutation conservative and auditable; a mismatch never
  claims success.
- + Reusing the plan-less anchor + status interception keeps `findPending` from hijacking the flow and adds no
  new capability/port/aggregate/dep.
- − `ApplyPreviewAnchor` gains one status + two fields; `GitProvider`/`GitManager` gain one mutating method
  each — a justified, individually-reviewed extension, not scope creep. Nothing is persisted beyond the hash +
  committed paths on the anchor (no raw diff, no aggregate).
- − Only a commit is performed; **push/deploy remain a separate, individually-reviewed future sprint**, and
  untracked/new-file commits are deliberately deferred (no `git add` this sprint).

### Relations
ADR-0045 (Explicit Git Commit Approval — provides the `COMMIT_APPROVED` anchor + `commitApprovalId`/
`proposedCommitMessage`/`commitCandidateFiles` this sprint consumes; the plan-less anchor + status-interception
pattern reused), ADR-0042 (PatchRef → WorkspaceWrite Apply — the **Ref-gate model** `GitManager.commitFiles`
mirrors `WorkspaceWriteManager.apply`), ADR-0025 (CAP-004 Approval — `ApprovalManager.get`/`approvalRef`
reused), ADR-0044 (Post-Validation Git Status Preview — read-only `git.status` reused for the fresh re-read),
ADR-0023 (CAP-002 Git — **extended from read-only with its first mutating method**, argv-only, no push),
ADR-0031 (Execution Orchestrator — deliberately not extended or called). Supersedes nothing. Plan:
`docs/plans/sprint-2y-approved-git-commit-execution-plan.md`.

## ADR-0047 — Explicit Git Push Approval (GIT_COMMITTED → push approval halt, NO remote mutation)

- **Status:** ✅ Accepted (v2, Phase 2, Sprint 2z — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (14 required changes applied) → proceed.
- **Date:** 2026-07-03
- **Scope:** After Sprint 2y leaves a `GIT_COMMITTED` anchor (a local commit exists, nothing pushed), an
  explicit git-**push** request ("푸시해줘"/"원격에 올려줘"/"git push 해줘"/"push this commit") **plans** a
  push: re-verifies the committed context, performs the read-only Git inspection needed to prepare a push,
  creates a **CRITICAL `ApprovalRequest`**, and halts at `PUSH_APPROVAL_PENDING` → approve → `PUSH_APPROVED`.
  **This sprint performs NO remote mutation** — no `git push`, not even after approval (execution is a future
  Sprint 3a+). It only creates the approval gate.

### Most important rule
> **`git push` mutates a remote, shared repository, so Sprint 2z stops before it.** The runtime reads only
> `git.info` + `git.status` (read-only, **no network fetch**, no CommandExecution/shell), creates a CRITICAL
> `ApprovalRequest`, and halts. Nothing push-mutating runs — not on request, not on approval. `PUSH_APPROVED`
> means the push was **approved, not performed**, and is a **point-in-time snapshot** (future push execution
> must re-read HEAD/upstream/ahead/behind before mutating). There is **no `GIT_PUSHED`/`PUSHED` state** and no
> overclaim (pushed / ready-to-push / push-safe / deployed / PR-created).

### Decision
- **Push is a remote repository mutation; Sprint 2z creates the approval gate only.** Reuses
  `ApprovalManager.requestForRisk`/`decide`/`get` + `approvalRef()` (CAP-004) and the 2x/2y approval-halt
  pattern (plan-less anchor + status interception, `interpretDecision`/`decisionOf`/`composeApprovalNotice`).
  `requestForRisk` creates a PENDING **CRITICAL** request (never auto-approves; `RiskPolicy.requiresApproval`
  is true for CRITICAL). **Risk is CRITICAL** — remote shared-state mutation, a larger blast radius than a
  local commit (HIGH in 2x).
- **`GIT_COMMITTED` required; explicit push phrase required; NO global/no-anchor push handling (CA #1).**
  Push handling is anchored to `GIT_COMMITTED` (plan a push) / `PUSH_APPROVAL_PENDING` (intercept → decision)
  / `PUSH_APPROVED` (already approved) only. `WORKSPACE_APPLIED` (2w mutating reject), `COMMIT_APPROVED` (2y
  `composeCommitPushUnsupported`), `COMMIT_APPROVAL_PENDING` (2x decision), and **no anchor** (existing
  classification/fallback) are all UNCHANGED. No automatic push after a local commit or after approval.
- **New anchor statuses `PUSH_APPROVAL_PENDING` / `PUSH_APPROVED`.** No `GIT_PUSHED`/`PUSHED`. Push context is
  **distinct** from commit context (CA #3): `pushApprovalId`/`pushCommitHash`/`pushRemote`/`pushBranch`/
  `pushUpstreamRef` — **preserved at `PUSH_APPROVED` (CA #8)**; cleared only on deny/cancel (revert to
  `GIT_COMMITTED`); commit context preserved throughout.
- **Trigger detection (CA #2).** `interpretPushIntent`: a forbidden-companion is classified **only when a
  push word is present** — a bare "배포"/"branch"/"tag"/"reset" is NOT push handling. push + force/PR/deploy/
  tag/branch/reset/checkout/stash/merge/rebase → `composePushUnsupportedCompanion` (no approval); a plain
  push word → push approval; else null (→ existing fallback).
- **Read-only inspection (CA #1-Q1).** Reuses `GitManager.info` (branch/headSha/detached) + `GitManager.status`,
  with a read-only **parser extension**: `git status --porcelain=v1 -b` already fetches the
  `## <branch>...<remote>/<branch> [ahead N, behind M]` header, so the parser now populates the reserved
  `GitStatus.ahead`/`behind` **plus a new `GitStatus.upstream?`** — **no new git subcommand, no new spawn, no
  network fetch**. No `GitProvider`/`GitManager` push method (CA #14). The runtime `git` dep is widened with
  `info` (type-only). No upstream ⇒ `upstream`/`ahead`/`behind` all `undefined` (distinct from `0`, CA #12).
- **Pre-approval verification (Constraint 8, CA #5/#10/#11).** Block (no approval) on: incomplete committed
  context; commitHash not SHA-shaped; `git.info`/`git.status` read failure (`composePushStatusUnavailable`);
  **detached HEAD or HEAD ≠ committed hash** (`composePushHeadMovedUnavailable`); **dirty working tree**
  (`composePushDirtyWorkingTree`, CA #10); **no or unparseable upstream** (`composePushNoUpstream`; upstream
  must parse to `<remote>/<branch>` with non-empty parts, no control chars, bounded, remote whitespace-free —
  CA #5); branch not ahead (`composePushNothingToPush`); behind > 0 diverged (`composePushDiverged`, no force).
  Remote/branch are **derived from the upstream, never user-provided** (Constraint 7); split on the FIRST `/`
  (branch may contain `/`, e.g. `feature/x`). All facts are point-in-time.
- **Approval reason (CA #4/#6/#7/#13).** operation "git push approval planning" · commit sha · **bounded**
  remote/branch/upstream · ahead count · risk CRITICAL · "no git push has been performed" · "records
  permission only; actual git push is NOT executed in Sprint 2z — future execution requires a separate step" ·
  "point-in-time snapshot; re-read Git state before pushing". **No raw diff/file content; NO validation/test
  "push-ready" context (CA #13).**
- **Strict decision guards (CA #3/#9).** Before deciding: complete pending context (`PUSH_APPROVAL_PENDING` +
  `pushApprovalId` + `pushCommitHash` + `pushRemote` + `pushBranch` + `pushUpstreamRef` + `commitHash` +
  `workspaceRef` + `executionPlanRef`) and `approvals.get(pushApprovalId)` exists/PENDING/same-plan. Any
  failure → safe failure, no `decide`/git/re-anchor. **A push/force/deploy phrase while pending is ambiguous
  → re-prompt** (never routed to unsupported-companion; the pending approval stays primary). Approve →
  `PUSH_APPROVED` preserving all context; deny/cancel → `GIT_COMMITTED` clearing only push fields. NO git push.
- **No Core/Orchestrator contract change; no `app.module.ts` change.** No CommandExecution/shell git; runtime
  never shells out. No `GitProvider`/`GitManager` push method.

### Not implemented (out of scope)
Actual `git push` execution (Sprint 3a+) · `GitProvider.push`/`GitManager.push`/a push dep method · force
push (`--force`/`-f`/강제) · PR creation · deployment · automatic push · push from any state other than
`GIT_COMMITTED` · a global/no-anchor push handler · user-provided/arbitrary remote or branch · upstream
creation · tags · branch creation · `reset`/`checkout`/`stash`/`merge`/`rebase` · a `GIT_PUSHED`/`PUSHED`
state · durable push-ready/deploy-ready/clean-tree semantics · `GitCommit` aggregate · CommandExecution git ·
runtime shell-out · WorkspaceWrite/Patch/CodeGeneration · ExecutionOrchestrator change.

### Consequences
- + The user can, for the first time, request a git push of the local commit and get a bounded, read-only
  push-target summary + a CRITICAL approval gate — behind an explicit request, gated by a clean tree, an
  existing upstream, and an ahead-not-diverged branch, with zero remote mutation.
- + Reusing the read-only `-b` header data (already fetched) for upstream/ahead/behind keeps the surface
  minimal (no new git command, no network fetch); the CRITICAL gate matches push's blast radius.
- − `ApplyPreviewAnchor` gains two statuses + five push fields; `GitStatus` gains `upstream?`; a justified
  extension for the future push-execution sprint, not scope creep; nothing new is persisted.
- − Approval is recorded but the push is deliberately not performed and is not durable push-ready; actual
  `git push` remains a separate, individually-reviewed future sprint that must re-read Git state first.

### Relations
ADR-0046 (Approved Git Commit Execution — provides the `GIT_COMMITTED` anchor + `commitHash`/`committedFiles`
this sprint consumes), ADR-0045 (Explicit Git Commit Approval — the approval-halt + plan-less anchor +
status-interception pattern reused, and the distinct-approval-id discipline), ADR-0044 (Post-Validation Git
Status Preview — read-only `git.status` reused; the `-b` parser extended for upstream/ahead/behind), ADR-0025
(CAP-004 Approval — `ApprovalManager`/`approvalRef` reused, risk CRITICAL), ADR-0023 (CAP-002 Git — read-only
`info`/`status` reused, **no push mutation added**), ADR-0031 (Execution Orchestrator — deliberately not
extended or called). Supersedes nothing. Plan:
`docs/plans/sprint-2z-explicit-git-push-approval-plan.md`.

## ADR-0048 — Approved Git Push Execution (PUSH_APPROVED → exact approved `git push`, first remote mutation)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3a — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (16 required changes applied) → proceed.
- **Date:** 2026-07-03
- **Scope:** After Sprint 2z leaves a `PUSH_APPROVED` anchor (a CRITICAL push approval is recorded, nothing
  pushed), an explicit push-**execution** command ("승인된 push 실행해줘"/"push 실행해줘"/"이제 실제 push
  해줘"/"execute approved push"/"push approved commit") performs **the exact approved push**: re-verifies the
  live approval + the persisted approved target, **re-reads Git state**, re-validates HEAD/upstream/ahead/
  behind/clean-tree against the approved snapshot, then pushes exactly the approved commit to the exact
  approved upstream and re-anchors `GIT_PUSHED`. This is the product's **FIRST real remote mutation**.

### Most important rule
> **A push is only ever the exact approved commit to the exact approved upstream, and only after the approved
> Git snapshot is re-proven against a fresh read.** Any drift → **no push, safe failure**. `GIT_PUSHED` means
> pushed to the approved upstream — **never PR-created, never deployed, never ready-to-push/push-safe/
> deploy-ready.** Because a push mutates a remote that may already have changed by result-validation time,
> the wording never claims "remote unchanged" unless provable and **never rolls back**.

### Decision
- **Second mutating Git method; first REMOTE mutation (Q1/Q2, CA #1/#4/#15).** `GitPushResult
  {remote,branch,upstreamRef,commitHash}` (domain) + `GitProvider.pushApprovedCommit(rootPath,remote,branch,
  commitHash)` + `GitManager.pushApprovedCommit({rootPath,remote,branch,commitHash,approvalRef})`. Mirrors
  the 2y commit template: the **manager** is Ref-gated (`approvalRef.status === APPROVED`) + defensive
  validation (safe remote/branch, SHA-shaped commitHash); the **provider** independently validates the
  target and is argv-only. **`ApprovalRef` → manager, not provider.** **No generic `push` API** (CA #15).
  **`GitPushResult` is the provider-reported successful target after `git push` exited 0 — NOT an independent
  remote verification (CA #1);** the runtime uses it only for local result-integrity checking; replies never
  overclaim (verified-forever / push-safe / deploy-ready).
- **Exact command (Q3, CA #5).** `git --no-pager push <remote> HEAD:<branch>` — argv only, one refspec
  element. **Never** bare `git push`/`--all`/`--tags`/`--force`/`-f`/`-u`/`--set-upstream`, no arbitrary
  refspec, no user-provided remote/branch. `HEAD:<branch>` pushes the current HEAD (runtime-verified ==
  `commitHash`) to the approved branch on the approved remote.
- **Conservative git ref validation (Q4, CA #4).** A shared `push-target.ts` (`isSafePushRemote` /
  `isSafePushBranch`) reused by the runtime pre-mutation guard, the manager backstop, and the adapter's
  `assertSafePushTarget`. remote: non-empty, bounded, no leading `-`, no `/`/`:`/whitespace/control. branch:
  may contain single `/`; rejects leading `-`/`/`, whitespace, control, `:` `~` `^` `?` `*` `[` `\`, `..`,
  `@{`, `//`, trailing `/`, `.lock` suffix. An unsafe branch **never reaches argv** (adapter throws first,
  CA #5); shell escaping is not a substitute.
- **`ConversationRuntime` composes it directly.** New anchor status `GIT_PUSHED` + fields
  `pushedCommitHash`/`pushedRemote`/`pushedBranch`/`pushedUpstreamRef`. **No `GitPush` aggregate** (Q11).
  Runtime `git` dep widened with `pushApprovedCommit` (type-only).
- **Trigger + routing (CA #7/#8/#9).** `interpretPushExecutionIntent`: a forbidden-companion is classified
  only when a push/exec word is present (2z CA #2 lesson); an explicit execution phrase → `'execute'`; a
  bare push word (no exec word) → null (→ 2z already-approved). Execution handling is **gated to
  `PUSH_APPROVED` (execute) and `GIT_PUSHED` (already-pushed) only**. `GIT_COMMITTED` + a push-execution
  phrase stays the **2z push-APPROVAL** flow (both "이제 실제 push 해줘" and "execute approved push" contain
  a push word → CRITICAL approval, not execute — CA #8); `PUSH_APPROVAL_PENDING` stays the 2z decision flow
  (ambiguous → re-prompt — CA #9). `GIT_PUSHED` + execution/push phrase → already pushed (CA #7); + PR/deploy
  phrase → already-pushed + future-sprint (CA #13).
- **Re-validation before mutation (Constraint 3/4, Q5-Q9, CA #3/#6).** Block (no push) on: incomplete
  context; **unsafe/malformed persisted target** (CA #3); approval not APPROVED/plan-mismatched/missing;
  `git.info`/`git.status` read failure; detached HEAD or `HEAD !== pushCommitHash` or `commitHash !==
  pushCommitHash`; dirty working tree; `upstream` missing/`!== pushUpstreamRef` or parsed remote/branch `!==`
  the approved; ahead < 1; behind > 0. **The approved target is the upstream ref, not the local branch name;
  `info.branch` is used only for detached detection + logging — local branch is NOT required to equal
  `pushBranch` (CA #6).**
- **Result integrity + remote-mutation safety (Q10, CA #2/#10/#11/#16).** After a successful provider push,
  a result-integrity gate checks `remote`/`branch`/`upstreamRef`/`commitHash` == the approved; a mismatch →
  `composePushResultUnverified` ("push may have been attempted; result could not be verified; check the
  remote; no rollback"), **keep `PUSH_APPROVED`, no `GIT_PUSHED`**. A provider throw →
  `composePushExecutionFailed` ("push did not complete; check the remote if unsure; no rollback"; never
  "remote unchanged"), **keep `PUSH_APPROVED`, no `GIT_PUSHED`**. Pre-push failures may state git push was
  **not attempted**. **Remote rollback is not attempted in Sprint 3a; any remote correction requires a
  separate CA-gated plan.**
- **On success (Q12, CA #12/#14).** Re-anchor `GIT_PUSHED`, store the pushed target, **preserve the full
  audit context** (`pushApprovalId`/`pushCommitHash`/`pushRemote`/`pushBranch`/`pushUpstreamRef`/
  `commitApprovalId`/`commitHash`/`committedFiles`/`workspaceRef`/`workspaceChangeRef`/`targetFiles`/
  `executionPlanRef`/`postApplyValidationRef`). Reply: short hash + remote/branch + **no PR/deployment**, no
  readiness claims.
- **No Core/Orchestrator contract change; no `app.module.ts` change** (the `git` dep carries the
  already-registered GitManager). No CommandExecution/shell git; runtime never shells out and never builds
  low-level push argv (the capability owns it).

### Not implemented (out of scope)
force push (`--force`/`-f`/강제) · bare `git push`/`--all`/`--tags`/`-u`/`--set-upstream` · arbitrary
refspec/remote/branch · user-provided remote/branch · upstream/branch creation · tags · PR creation ·
deployment · automatic push · push from any state other than `PUSH_APPROVED` · a generic `push` API ·
CommandExecution-based git · runtime shell-out · reset/checkout/stash/merge/rebase · **remote-mutation
rollback** · a `GitPush` aggregate · ExecutionOrchestrator change · WorkspaceWrite/Patch/CodeGeneration.

### Consequences
- + The user can, for the first time, execute a git push of the approved local commit — behind an explicit
  execution command, gated by a still-valid CRITICAL approval and an exact-snapshot re-check against a
  freshly-read Git state, pushing exactly the approved commit to the exact approved upstream and nothing else.
- + Mirroring the 2y Ref-gate + provider-argv + result-integrity template, plus conservative ref validation
  and the "provider result is not independent remote verification" framing, keeps the first remote mutation
  conservative and honest under partial-failure uncertainty.
- − `ApplyPreviewAnchor` gains one status + four pushed fields; `GitProvider`/`GitManager` gain one mutating
  method each; a shared ref validator is added — a justified, individually-reviewed extension. Nothing is
  persisted beyond the pushed target on the anchor (no aggregate).
- − Only a push is performed; **PR creation and deployment remain separate, individually-reviewed future
  sprints**, and remote rollback is deliberately not attempted.

### Relations
ADR-0047 (Explicit Git Push Approval — provides the `PUSH_APPROVED` anchor + `pushApprovalId`/`pushCommitHash`/
`pushRemote`/`pushBranch`/`pushUpstreamRef` this sprint consumes), ADR-0046 (Approved Git Commit Execution —
the Ref-gate + provider-argv + result-integrity template mirrored), ADR-0044/ADR-0047 (read-only `info`/
`status` + upstream/ahead/behind parser + `parsePushUpstream` reused for the fresh re-validation), ADR-0025
(CAP-004 Approval — `ApprovalManager.get`/`approvalRef` reused, risk CRITICAL), ADR-0023 (CAP-002 Git —
**second mutating method, the first remote**, argv-only), ADR-0031 (Execution Orchestrator — deliberately not
extended or called). Supersedes nothing. Plan:
`docs/plans/sprint-3a-approved-git-push-execution-plan.md`.

## ADR-0049 — Explicit Pull Request Creation Approval (GIT_PUSHED → CRITICAL PR-creation approval halt, no PR creation)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3b — Product Construction), Chief Architect Review:
  APPROVED WITH CHANGES (16 required changes applied) → proceed.
- **Date:** 2026-07-03
- **Scope:** After Sprint 3a leaves a `GIT_PUSHED` anchor (the approved commit was pushed to the approved
  upstream), an explicit PR-creation phrase ("PR 만들어줘"/"pull request 만들어줘"/"GitHub PR 열어줘"/"깃허브 PR
  만들어줘"/"open a PR"/"create pull request"/"merge request 만들어줘") records a **CRITICAL Pull-Request-creation
  approval**: verify the persisted pushed context, derive a deterministic PR target (head = pushed branch,
  base = fixed policy `main`) + a bounded deterministic title/body, create one CRITICAL `ApprovalRequest`,
  re-anchor `PR_APPROVAL_PENDING`, and return `AWAITING_APPROVAL`. On "승인" the approval is **recorded only**
  → `PR_APPROVED`. **No Pull Request is created.**

### Most important rule
> **A Pull Request is a repository-hosting/platform mutation, not a local Git operation.** Sprint 3b adds an
> **approval gate only** — no PR creation, no GitHub API call, no provider/manager PR method. `PR_APPROVED`
> means the user granted permission to create a PR; it **never** means a PR was created, deployed, merged,
> released, or made production-ready. Approval is based on the pushed context currently recorded by ChunsikBot;
> it does **not** verify the branch on the hosting provider and does **not** guarantee a PR can be created.

### Decision
- **PR creation is NOT a Git capability responsibility (Q1, CA #1/#13).** No PR/hosting surface exists in the
  repo today. For approval-only 3b, **no provider is added** — no `GitHubProvider`/`RepositoryHosting`, no
  `GitManager.createPullRequest`/`GitProvider.createPullRequest`, no `createPullRequest` of any kind. The
  entire flow lives in `ConversationRuntime` + `ApprovalManager` (CAP-004) + `ResponseComposer` + the
  apply-preview anchor. Actual PR creation belongs to a **future Repository-Hosting/GitHub capability** (3c+).
- **Two new anchor states + distinct PR context (Q2/Q3, CA #3/#15/#16).** `PR_APPROVAL_PENDING` / `PR_APPROVED`
  (no `PR_CREATED`/`PULL_REQUEST_CREATED`). New fields **distinct** from push/commit/apply ids: `prApprovalId`,
  `prPushedCommitHash`, `prHeadBranch`, `prBaseBranch`, `prTitle`, `prBodyPreview`. Set at
  `PR_APPROVAL_PENDING`; **all** preserved at `PR_APPROVED`; on deny/cancel **only** these PR fields are
  cleared (pushed/commit/workspace context preserved) and the anchor reverts to `GIT_PUSHED`.
- **Trigger discipline (Q4/Q5, CA #1/#2/#3).** `interpretPrIntent`: a PR-ish noun (`PR`/`pull request`/`풀
  리퀘`/`merge request`/`MR`, incl. `깃허브 PR`) is **not** sufficient — an explicit create/open verb
  (`만들`/`생성`/`열`/`올려`/`open`/`create`) is **required**; a bare noun → null (no PR approval). A
  forbidden companion (deploy/배포, merge/머지/병합, release/릴리즈, auto-merge/자동 머지, force/강제, reset/
  checkout/stash/rebase/tag/branch-creation) is classified only when a PR word is present (2z CA #2 lesson) →
  `'pr-unsupported'`. `merge request` is a PR synonym (needs a verb), distinct from a bundled `merge`
  (`\bmerge\b(?!\s*request)`, rejected). Gated to `GIT_PUSHED` / `PR_APPROVAL_PENDING` / `PR_APPROVED` only;
  every other state keeps existing behavior and creates no PR approval.
- **Deterministic PR target (Q6/Q7/Q8, CA #6/#10/#11).** `prBaseBranch` = single named constant
  `PR_BASE_BRANCH_POLICY = "main"` — a **stated ChunsikBot V2 product policy**, since `RepositoryInfo` exposes
  no default branch and no configured default-branch source exists; never inferred, never user-provided.
  `prHeadBranch` = `anchor.pushedBranch`, re-validated with `isSafePushBranch`. If `head === base` → **no
  approval**, worded as a **product/base-policy limitation** (not a Git error, not a PR-creation attempt).
- **Deterministic bounded title/body (Q8, CA #4/#5).** `proposedCommitMessage` is cleared at `GIT_COMMITTED`,
  so the commit message is unavailable at `GIT_PUSHED`; `prTitle` = sanitized `instruction` (strip control
  chars, remove backticks + leading markdown heading markers, collapse whitespace, bound to `MAX_PR_TITLE`),
  fallback "Apply approved changes". `prBodyPreview` = generated-by-ChunsikBot + short hash + head→base +
  committed-file **count only (NO file paths)** + "no deployment"; **no** raw diff, **no** file content, **no**
  secrets. Nothing leaves the system in 3b (surfaced locally + stored on the anchor only).
- **CRITICAL approval + explicit reason (Constraint 4, CA #6).** `RiskLevel.CRITICAL` (PR creation mutates
  shared collaboration state: CI, notifications, reviews, branch protections, automations, deploy pipelines).
  `buildPrApprovalReason` explicitly states: no PR created, **no deployment performed, no merge performed**,
  permission only, not performed in Sprint 3b, **future execution requires a separate repository-hosting
  step**, includes pushedCommitHash + head/base, and the "not verified on hosting / not guaranteed creatable"
  discipline.
- **No fresh Git read (CA #12).** 3b uses the `GIT_PUSHED` anchor as the source of truth and re-validates the
  persisted target strings (SHA-shaped `pushedCommitHash == pushCommitHash == commitHash`; safe `pushedRemote`/
  `pushedBranch`; `pushedUpstreamRef` parses and its parsed remote/branch match) — it does **not** call
  `git.info`/`git.status`, because nothing is mutated. **Actual PR-creation execution (future) MUST re-validate
  hosting/branch state before mutating.**
- **Decision flow mirrors 2z (CA #7/#14).** `PR_APPROVAL_PENDING` intercepts every turn: a PR-creation /
  PR+forbidden / deploy-only phrase is a premature request → **ambiguous re-prompt** (no decide, no PR); a
  bare "승인"/"거절"/"취소" decides after verifying the referenced `ApprovalRequest` exists/PENDING/plan-matches.
  Approve → `PR_APPROVED` (record only); deny/cancel → `GIT_PUSHED` clearing only PR fields. NO PR creation on
  any path.
- **State-appropriate deploy-only wording (CA #8).** A bare deploy phrase (배포/deploy, no PR): at `GIT_PUSHED`
  → `composePushPrDeployUnsupported` (deploy-only, "이미 push된 상태예요"); at `PR_APPROVED` →
  `composePrApprovedDeployUnsupported` ("PR 승인은 기록됐지만 배포는 아직 지원 안 함; PR도 배포도 하지 않음").

### Consequences
- + The product gains an explicit, auditable, CRITICAL approval gate before any repository-hosting mutation,
  keeping remote-collaboration side effects behind human approval — consistent with the commit/push gates.
- + Reuses the 2z push-approval template (request → `*_APPROVAL_PENDING` → decision → `*_APPROVED`) and the 3a
  pushed context + ref validators; adds no capability and no provider.
- − `ApplyPreviewAnchor` gains two statuses + six PR fields; `ConversationRuntime`/`ResponseComposer` gain the
  PR-approval flow. Nothing is persisted beyond the PR context on the anchor; no external system is touched.
- − Only approval is recorded; **actual PR creation, deployment, and merge remain separate, individually-
  reviewed future sprints** owned by a future Repository-Hosting/GitHub capability.

### Relations
ADR-0048 (Approved Git Push Execution — provides the `GIT_PUSHED` anchor + `pushedCommitHash`/`pushedRemote`/
`pushedBranch`/`pushedUpstreamRef` this sprint consumes; **its `GIT_PUSHED` PR-phrase behavior is superseded**
— a PR-creation phrase now records an approval, while deploy-only phrases remain unsupported/future), ADR-0047
(Explicit Git Push Approval — the CRITICAL request → `*_APPROVAL_PENDING` → decision → `*_APPROVED` template
mirrored), ADR-0045 (Explicit Git Commit Approval — decision-flow structure), ADR-0025 (CAP-004 Approval —
`requestForRisk`/`get`/`decide`, risk CRITICAL), ADR-0023 (CAP-002 Git — read-only reuse only; **no** PR/
hosting method added), ADR-0031 (Execution Orchestrator — not extended or called). **Supersedes ADR-0048's
`GIT_PUSHED` PR-phrase behavior only.** Plan:
`docs/plans/sprint-3b-explicit-pr-creation-approval-plan.md`.

## ADR-0050 — Repository Hosting Capability (design-only; CAP-010; future PR creation execution boundary)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3c — Product Construction, **design-only / plan-only**), Chief
  Architect review: APPROVED WITH CHANGES (all applied) → CONFIRMED/ACCEPTED as the architecture direction. **No
  implementation** was produced by Sprint 3c; this ADR records the accepted design a future implementation
  sprint (3d-B/3d-C) will build against. Backfilled into `DECISIONS.md` in PR #25 (Sprint 3d-A) per CA
  Implementation Review, since ADR-0051 is a config-only subset of this design.
- **Date:** 2026-07-03
- **Scope:** The capability boundary for **actual Pull Request creation execution**. Sprint 3b (ADR-0049)
  settled that PR creation is a repository-hosting/platform mutation, not a Git operation; this ADR designs the
  independent capability that will own it. Sprint 3c is design-only — no code, no branch, no PR, no GitHub API.

### Most important rule
> **Pull Request creation is a repository-hosting/platform mutation, not a local Git operation.** It must never
> be added to `GitProvider`/`GitManager`/`CommandExecution`/runtime shell/`ExecutionOrchestrator`/
> `WorkspaceWrite`/`PatchManager`/`CodeGeneration`. A new independent **Repository Hosting** capability owns it —
> provider-agnostic at the domain/port level, GitHub (github.com only) as the first adapter. **Actual PR
> creation execution is blocked until a reviewed `RepositoryIdentity` configuration source exists** (delivered
> by Sprint 3d-A / ADR-0051); execution itself is a further sprint (3d-C).

### Decision (accepted design; not implemented in 3c)
- **RepositoryHosting is CAP-010.** Owns `RepositoryIdentity`, `RepositoryIdentityConfig`,
  `PullRequestCreationInput`, `PullRequestResult`, `PullRequestRef`, `RepositoryHostingProvider` (port),
  `RepositoryHostingManager` (application), `GitHubRepositoryHostingProvider` (adapter,
  `@chunsik/repository-hosting-github`). Does **not** own local git status/commit/push, workspace file
  mutation, code generation, deployment, merge, or release.
- **Provider-independent core (Q2).** core/domain/port carry no GitHub-specific shape; **GitHub is the first
  adapter only**, **github.com only** for the first implementation (GitHub Enterprise deferred to a later
  CA-approved sprint). Auth token, host, and URL rules live only inside the adapter package.
- **Git capability unchanged (Q4)** — no `GitManager.createPullRequest`, no `GitProvider.createPullRequest`.
  **`ExecutionOrchestrator` unchanged (Q5)** — the future flow stays `ConversationRuntime`-composed.
- **Repository identity (Q9).** Required from a **reviewed configuration source**; the codebase had **no** safe
  identity source before Sprint 3d-A (`RepositoryInfo` intentionally excludes remote URLs — ADR-0023). **No
  remote-URL parsing, no `RepositoryInfo.remoteUrl`, no raw pasted URL, no unbounded per-request owner/repo, no
  ChatGPT/GitHub connector in runtime product code, no `CommandExecution`/shell.** Actual PR creation is blocked
  until this identity config exists.
- **Approval consumed at the Manager (Q7/Q14, mirrors `GitManager`).** `RepositoryHostingManager` owns approval
  gating, input validation, **call ordering**, and result-integrity validation; the `ApprovalRef` is consumed
  at the Manager and **never** passed to the provider; the provider receives no `ApprovalRef` and no raw
  diff/file content, and owns **hosting API calls only**. No second approval when `PR_APPROVED` is live and the
  exact context (incl. `RepositoryIdentity`) matches, but an explicit PR-execution phrase is still required.
- **Mandatory future hosting-state checks (Q8).** `repositoryExists`, `branchExists(head)`, `branchExists(base)`,
  `findOpenPullRequest(head, base)` when the provider supports it, and `head != base`. **Existing-open-PR reuse
  is preferred (Q12)** — return it, validate its integrity like a new PR, anchor `PR_CREATED` with
  `pullRequestReused: true`; **no non-idempotent creation by default**. Commit reachability is deferred unless a
  provider method is added, and must not be overclaimed.
- **`PullRequestResult` is provider-reported, not independent truth (mirrors `GitPushResult`).** The Manager
  validates integrity against returned fields but must not overclaim. `PullRequestRef` includes
  `provider/owner/repo` (a PR number is repository-scoped).
- **`PR_CREATED` is a future state only (Q11).** Stores repository identity + `pullRequestRef`/number/url/head/
  base/`pullRequestCommitHash` (required) + `pullRequestReused`. **No merge/deploy/release semantics** —
  created/opened only. On failure: no fake success, no `PR_CREATED`, keep `PR_APPROVED`, no rollback, and an
  ambiguous provider response must not claim no PR was created.
- **Token/auth discipline.** Adapter-local only; never in domain types / `ApprovalRequest.reason` / the anchor /
  logs; provider errors sanitized. **Failure taxonomy** distinguishes not-configured / approval-invalid /
  hosting-unavailable / branch-missing / existing-PR-reused / creation-failed / creation-result-unverified.

### Consequences
- + Establishes the capability boundary and the hard identity prerequisite before any hosting mutation exists,
  keeping remote-collaboration side effects behind an explicit, reviewed, provider-agnostic surface.
- + Mirrors the CAP-002 Git Port/Manager/Adapter/Token pattern and the `GitPushResult` provider-reported
  discipline; adds no capability code in 3c.
- − This is design-only: no `RepositoryHostingProvider`/`Manager`/adapter, no `PR_CREATED`, no GitHub API, no
  PR creation exists yet; those are separate CA-gated implementation sprints (3d-B skeleton, 3d-C execution),
  each blocked until the reviewed `RepositoryIdentity` configuration (Sprint 3d-A / ADR-0051) is accepted.

### Relations
ADR-0049 (Sprint 3b — provides the `PR_APPROVED` anchor + PR context this design consumes; reaffirms "PR
creation is not Git capability responsibility"), ADR-0048 (Sprint 3a — `GIT_PUSHED` + the provider-reported
discipline mirrored by `PullRequestResult`), ADR-0047/ADR-0045 (approval-halt template lineage), ADR-0025
(CAP-004 Approval — reused unchanged), ADR-0023 (CAP-002 Git — the Port/Manager/Adapter pattern mirrored, and
the remote-URL-exclusion decision that grounds the identity problem). **Succeeded by ADR-0051** (Sprint 3d-A —
the config-only subset delivering the reviewed `RepositoryIdentity` source this design requires). Plan:
`docs/plans/sprint-3c-repository-hosting-capability-plan.md`.

## ADR-0051 — Repository Identity Configuration (safe reviewed `provider/owner/repo` source; no hosting mutation)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3d-A — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 10 required changes applied) → implemented.
- **Date:** 2026-07-03
- **Scope:** The **config-only subset of the future Repository Hosting capability** (ADR-0050, Sprint 3c accepted
  design): the safe, reviewed source of `provider/owner/repo` a **future** PR-creation execution sprint (3d-C)
  will consume. It adds the `RepositoryIdentity`/`RepositoryIdentityConfig` domain types, exact validators, a
  pure `RepositoryIdentityResolver` (the safe missing-identity **detection path**), and the single env-reading
  config-loading path in `apps/chunsik/src/config.ts`. It performs **no** hosting mutation.

### Most important rule
> **Repository identity is explicit reviewed configuration** — a validated `{ provider:'github', owner, repo }`.
> It is **never** parsed from a git remote, **never** carries a token, and **never** widens `RepositoryInfo`
> (ADR-0023 stands — remote URLs stay excluded). This Sprint does **not** by itself satisfy PR-execution
> readiness: it implements no `RepositoryHostingProvider`, no hosting-state verification, no GitHub auth, no
> GitHub API call, and no PR creation. **Actual PR creation remains blocked until later Repository Hosting
> implementation Sprints (3d-B/3d-C) are accepted.**

### Decision
- **Where identity lives (Q1).** `apps/chunsik/src/config.ts` (the single documented env-reading site) reads
  **only** `CHUNSIK_GITHUB_OWNER` / `CHUNSIK_GITHUB_REPO` into a raw `RepositoryIdentityConfig`; it reads
  **no** `CHUNSIK_GITHUB_PROVIDER` and **no** token env var (`provider` is fixed to `'github'`). Framework-
  agnostic types, validators, and the resolver live in `packages/core`. `loadConfig(env = process.env)` gains
  an injectable `env` param (default `process.env`) for narrow testability (CA change 8) — env reading stays
  in this one file.
- **Global, not per-project (Q2).** Global runtime config for the first-narrow implementation. Grounded:
  `Project`/`ProjectManager.register(path, session)` capture a local path only with no reviewed identity
  field, and `Project.metadata` is an untyped unbounded `Record` (an unsafe identity source). Per-project
  identity is deferred to a later Sprint that adds a **reviewed typed** identity field to project registration
  — never the untyped `metadata` bag.
- **Validation (Q3, CA changes 1/4/5/6).** `isSupportedHostingProvider` (`github` only; GHE deferred);
  `isSafeRepoOwner` (`/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/`, ≤39 — no leading/trailing/consecutive hyphen);
  `isSafeRepoName` (`[A-Za-z0-9._-]`, ≤100; not `.`/`..`; **no leading dot**; **no `.git` suffix**). A
  conservative `looksLikeSecret` (case-insensitive) additionally rejects GitHub token prefixes (`ghp_`,
  `github_pat_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and credential-like substrings (`token`, `secret`,
  `password`, `pat_`) — **false rejection is acceptable** for identity config. Whitespace/control/URL are
  rejected by the character classes.
- **Exposure (Q4).** Future Repository Hosting receives a validated **`RepositoryIdentity`** — not the raw
  `RepositoryIdentityConfig` (pre-validation) and not a `Ref` (no persisted aggregate exists or is needed for
  a tiny immutable value). The resolver returns `{ status:'resolved', identity }` or `{ status:'missing',
  reason }` where `reason ∈ { not-configured, unsupported-provider, invalid-owner, invalid-repo }` — a fixed
  enum, never an echoed input value.
- **No secrets (Q5, CA change 1).** `RepositoryIdentity`/`RepositoryIdentityConfig` have **no** token field
  and **no** remoteUrl field; the resolver copies **only** `provider`/`owner`/`repo` (never spreads config, so
  an incidental extra key cannot leak); the resolver never logs and never throws (constructor arity 0). The
  app config reads no token env var. Sprint 3d-A adds no anchor field and no approval-reason text, so a token
  cannot reach the anchor / `ApprovalRequest.reason` / logs.
- **Missing identity fails safely (Q8).** `RepositoryIdentityResolver.resolve` returns a safe `missing` result
  (both owner+repo absent → `not-configured`; one present → `invalid-owner`/`invalid-repo`), which a future
  execution sprint maps to a "PR 생성 대상 저장소가 설정되지 않았어요. PR은 만들지 않았어요." response. 3d-A provides
  only the detection path — it wires nothing into `ConversationRuntime`.
- **Git unchanged (Q6).** No `RepositoryInfo.remoteUrl`, no `GitProvider.info` remote-URL exposure, no git
  remote parsing.
- **Repository Hosting not implemented (Q7).** No `RepositoryHostingProvider`/`RepositoryHostingManager`/
  `GitHubRepositoryHostingProvider`, no `PR_CREATED` state, no GitHub API call, no PR creation, no merge/
  deploy/release, no reviewer/label/assignee mutation, no `CommandExecution`, no runtime shell-out, no
  ChatGPT/GitHub connector in product code.

### Consequences
- + The blocking prerequisite ADR-0050 identified (a reviewed `RepositoryIdentity` source) now exists, without
  any hosting mutation surface — a future 3d-B/3d-C can consume a validated identity or fail safely when absent.
- + Reuses the single env-reading config path and the framework-agnostic domain/validator/value-object
  conventions; adds no provider/adapter package and no runtime wiring.
- − `ChunsikConfig` gains an optional `repositoryHosting`; `vitest.config.ts` `test.include` gains
  `apps/**/src/**/*.test.ts` (narrowest change enabling the config-loader test, CA change 8). Nothing is wired
  into `ConversationRuntime`/`ResponseComposer`/the apply anchor/`ApprovalRequest`.
- − This Sprint does **not** satisfy PR-execution readiness; actual PR creation remains blocked until 3d-B/3d-C
  are accepted.

### Relations
ADR-0050 (Sprint 3c — Repository Hosting capability design; this is its accepted config-only subset,
satisfying the "blocked until a reviewed RepositoryIdentity configuration source exists" prerequisite),
ADR-0049 (Sprint 3b — `PR_APPROVED` anchor a future execution sprint consumes alongside this identity),
ADR-0023 (CAP-002 Git — the remote-URL-exclusion decision this Sprint upholds; `RepositoryInfo` unchanged),
ADR-0025 (CAP-004 Approval — the no-secret-in-reason discipline mirrored). Plan:
`docs/plans/sprint-3d-a-repository-identity-configuration-plan.md`.

## ADR-0052 — RepositoryHosting Skeleton (CAP-010 domain/port/manager/token; NO real provider, NO mutation)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3d-B — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 12 required changes applied) → implemented.
- **Date:** 2026-07-03
- **Scope:** The **non-mutating skeleton** of CAP-010 Repository Hosting (the design accepted in ADR-0050,
  reusing the identity source from ADR-0051): the provider-independent domain types +
  `RepositoryHostingProvider` port + `RepositoryHostingManager` + `REPOSITORY_HOSTING_PROVIDER` token,
  exercised only by **fake providers in unit tests**.

### Most important rule
> **RepositoryHosting is a hosting/platform capability. It is not Git.** No PR method is added to
> `GitProvider`/`GitManager`/`LocalGitProvider`/`CommandExecution`/runtime shell/`ExecutionOrchestrator`/
> `WorkspaceWrite`/`PatchManager`/`CodeGeneration`. `RepositoryHostingProvider.createPullRequest` exists as a
> **port shape only** — Sprint 3d-B ships **no real provider implementation**, no GitHub adapter, no DI
> binding, and **no product-runtime path can reach it**; only fake providers in unit tests may implement or
> call it. A successful `RepositoryHostingManager` unit test means the **manager boundary behaves correctly
> with a fake provider** — it does **not** mean product PR creation works. **Actual product PR creation
> remains blocked** until a real adapter + runtime flow are separately planned, implemented, reviewed, merged,
> and accepted.

### Decision
- **Types added** (`packages/core/src/domain/repository-hosting.ts`): `PullRequestCreationInput`,
  `PullRequestResult`, `PullRequestRef` (+ `pullRequestRef()`), `MAX_PR_TITLE`/`MAX_PR_BODY`,
  `normalizePrTitle`, `isSafeGitHubPullRequestUrl`. **Reuses** `RepositoryIdentity`/
  `RepositoryHostingProviderKind` from ADR-0051 — not duplicated.
- **`PullRequestCreationInput`** carries only `identity/headBranch/baseBranch/title/body/expectedCommitHash` —
  **no** `ApprovalRef` (Manager input only), token, raw diff, file content, GitHub SDK type, git remote URL, or
  `pushedRemote` (remote/upstream context belongs to the prior Git push anchor, not a hosting input).
- **`PullRequestResult`** is **provider-reported, not independent truth** (mirrors `GitPushResult`). The
  Manager validates it against the request and finalizes `reused` by the taken path.
- **`RepositoryHostingProvider` port**: `repositoryExists` / `branchExists` / `findOpenPullRequest` /
  `createPullRequest`; `readonly kind`; takes **no** `ApprovalRef`.
- **`RepositoryHostingManager`** owns approval gating (`ApprovalRef.status === APPROVED`), **`provider.kind ===
  identity.provider`** matching before any provider call, input validation, deterministic title normalization
  (collapse whitespace + trim; empty → reject; provider receives the normalized title), call ordering
  (`repositoryExists` → `branchExists(head)` → `branchExists(base)` → `findOpenPullRequest` → a **single**
  `createPullRequest` only if all pass and no existing PR), **manager-owned `reused`** (true via the
  existing-PR path, false via the create path — the provider-reported flag is not trusted), and result
  integrity — incl. `pullRequestCommitHash === expectedCommitHash` and `isSafeGitHubPullRequestUrl` (https /
  github.com / exact `/<owner>/<repo>/pull/<number>` / exact casing / no credentials / no query / no fragment /
  no percent-encoding / bounded). The `ApprovalRef` is consumed here and **never** passed to the provider; the
  provider receives only the bounded `PullRequestCreationInput`.
- **Non-idempotent creation blocked by default**: if `findOpenPullRequest` throws (unsupported), the Manager
  blocks and does not call `createPullRequest`. A valid existing open PR is returned with `reused: true` and no
  create; an invalid existing result fails safe (no fallback create).
- **Reused helpers**: `isSafePushBranch` (head/base) + the SHA-shape guard; identity validators (ADR-0051).
  **`isSafePushRemote` is NOT used** — RepositoryHosting works with identity + branch names, not git remotes.
- **Deterministic capability errors**: the Manager throws bounded internal messages; **raw provider errors are
  never forwarded or embedded**.
- **No token binding / no wiring**: `REPOSITORY_HOSTING_PROVIDER` token added, but `app.module.ts` binds **no**
  real or fake provider; an exported-but-unbound manager is acceptable. `ConversationRuntime`,
  `ApplyPreviewAnchor` (no `PR_CREATED`), `ResponseComposer` (no PR-created wording), `ExecutionOrchestrator`,
  and Git capability are unchanged.

### Consequences
- + Establishes the validated RepositoryHosting seam (domain/port/manager/token) a future GitHub adapter and
  PR-execution flow plug into, with all approval/validation/ordering/integrity discipline in place and proven
  by fake-provider unit tests.
- + Mirrors the CAP-002 Git Port/Manager/Token pattern and the `GitPushResult` provider-reported discipline;
  reuses ADR-0051 identity + ADR-0048 branch/SHA guards.
- − No real adapter, no GitHub API, no PR creation, no `PR_CREATED`, no runtime wiring exist yet; actual
  PR-creation execution remains a separate CA-gated sprint (3d-C+), and the product flow still stops at
  `PR_APPROVED`.

### Relations
ADR-0050 (Sprint 3c — the RepositoryHosting design this skeleton realizes), ADR-0051 (Sprint 3d-A —
`RepositoryIdentity`/validators reused), ADR-0048 (Sprint 3a — `isSafePushBranch` + SHA guard reused; the
provider-reported `GitPushResult` discipline mirrored by `PullRequestResult`), ADR-0046/ADR-0025 (the
`GitManager` Ref-gating template the manager mirrors; `ApprovalRef` consumed at the manager, never the
provider). Plan: `docs/plans/sprint-3d-b-repository-hosting-skeleton-plan.md`.

## ADR-0053 — GitHub RepositoryHosting Adapter (adapter-only; real GitHub REST via fetch; runtime execution deferred to 3d-D)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3d-C — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 18 required changes applied) → implemented.
- **Date:** 2026-07-03
- **Scope:** `GitHubRepositoryHostingProvider` in a new `@chunsik/repository-hosting-github` package — the real
  GitHub REST implementation of the CAP-010 `RepositoryHostingProvider` port (ADR-0052), via the Node 22
  built-in `fetch`. **Adapter-only:** it is **not wired into `app.module.ts`** and **no product-runtime path
  reaches it**; every unit test injects a fake `fetch` (no live network). Actual runtime PR-creation execution
  (`PR_CREATED`, execution intent, `ConversationRuntime`/`ResponseComposer`, DI wiring) is **deferred to Sprint
  3d-D**, so the product flow still stops at `PR_APPROVED`.

### Most important rule
> **`createPullRequest` now has a REAL GitHub-mutating implementation inside the adapter package** — but in
> Sprint 3d-C it is **not wired into runtime and is exercised only with a fake `fetch` in tests**, so no product
> path can create a Pull Request. This is the key difference from 3d-B (where the method was a port shape with
> no implementation). Actual product PR creation remains **deferred to 3d-D**.

### Decision
- **Q1 — adapter-only (3d-C1).** Split from runtime execution (3d-D), because bundling the first
  product-reachable remote mutation with the largest diff (a new package + `ConversationRuntime` state-machine
  changes + DI wiring) could not be proven narrow/guarded (`conversation-runtime.ts` is 3163 lines; its DI
  factory ~69 wiring lines). The unwired adapter keeps the mutation surface closed.
- **Transport (Q3):** Node 22 built-in **`fetch`** + `AbortSignal.timeout`; **no octokit/SDK**; no
  `gh`/`hub`/`curl`/`CommandExecution`/shell/`git request-pull`.
- **Auth (Q2):** token is **adapter-local constructor config only** (`GitHubHostingConfig.token`); **3d-C does
  NOT read `CHUNSIK_GITHUB_TOKEN` in `config.ts`** (no runtime binding → no secret surface before it is needed;
  3d-D decides the env read). The constructor **rejects a blank/whitespace token** (no fetch). The token is
  used only as an `Authorization: Bearer` header value and **never** enters core/domain/`RepositoryIdentity`/
  `ApprovalRequest.reason`/`ApplyPreviewAnchor`/`ResponseComposer`/logs/errors.
- **Fixed host (github.com only):** API base is fixed to `https://api.github.com` with **no override option**;
  GitHub Enterprise is deferred. Headers: `Authorization: Bearer <token>`, `Accept:
  application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: chunsik-bot`.
- **Endpoints (Q4):** `repositoryExists` → `GET /repos/{owner}/{repo}`; `branchExists` → `GET
  /repos/{owner}/{repo}/branches/{branch}`; `findOpenPullRequest` → `GET /repos/{owner}/{repo}/pulls?state=open&
  head={owner}:{headBranch}&base={baseBranch}`; `createPullRequest` → `POST /repos/{owner}/{repo}/pulls`. Path
  segments (incl. slash branches) are `encodeURIComponent`-encoded; the POST body carries **raw** branch
  strings, minimal keys ONLY `{ title, head, base, body }` (no draft/maintainer_can_modify/issue/labels/
  assignees/reviewers/milestone).
- **HTTP status handling (Q11):** exists checks `200 → true`, `404 → false`, `401/403 → sanitized "unavailable
  (auth)"`, other non-2xx → sanitized error; `findOpenPullRequest` `404 → throw` (not "no PR"); `createPullRequest`
  **201 only** (`200`/`4xx` → error). **One `fetch` per method — no retry** (mutation retry needs separate
  review).
- **Existing-PR reuse (Q5):** same-repository head only (`{owner}:{headBranch}`); forks unsupported (mapping
  requires `head.repo.owner.login === owner` and `head.repo.name === repo`, else rejected); `0 → null`, `1 →
  mapped`, **`>1 → deterministic ambiguous safe failure`** (never choose first).
- **Result mapping (Q6/Q7):** `pullRequestCommitHash` = provider-reported **`head.sha`** (missing/not-SHA-shaped
  → reject); `pullRequestNumber` = `number` (must be a positive safe integer); `pullRequestUrl` = `html_url`
  validated by `isSafeGitHubPullRequestUrl` (https/github.com/exact path/exact casing/no creds/no query/no
  fragment/no percent-encoding); `head.ref`/`base.ref` mapped; everything else ignored (no raw diff/file
  content/secrets fetched). `PullRequestResult` is **provider-reported, not independent truth**; `reused` is
  finalized by the Manager (unchanged from ADR-0052).
- **Sanitized errors (Q13 provider portion):** deterministic bounded messages (operation label + HTTP status)
  — **never** the token, the `Authorization` header, the raw response body, or the request body.
- **No wiring / no side effects (Q15/Q16):** no `app.module` import/binding; `REPOSITORY_HOSTING_PROVIDER`
  stays unbound; `ConversationRuntime`/`ApplyPreviewAnchor`/`ResponseComposer`/`ExecutionOrchestrator`/Git
  capability unchanged; no `PR_CREATED`; no merge/deploy/release/reviewer/label/assignee/branch-creation/force
  push.

### Consequences
- + The product now has a real, tested GitHub REST adapter behind the CAP-010 port, ready for 3d-D to wire — with
  full auth/host/encoding/status/reuse/mapping/sanitization discipline, validated by fake-`fetch` unit tests
  (no live network).
- + No new external dependency (built-in `fetch`); mirrors the `git-local` adapter package shape.
- − A real GitHub-mutating `createPullRequest` implementation now exists in the repo, but is unreachable in
  product runtime (unwired) and never invoked live in tests. Actual PR-creation execution + `PR_CREATED` +
  runtime/composer changes remain **deferred to 3d-D**; the product flow still stops at `PR_APPROVED`.

### Relations
ADR-0052 (Sprint 3d-B — the `RepositoryHostingProvider` port this adapter implements + `RepositoryHostingManager`
that will consume it in 3d-D; `isSafeGitHubPullRequestUrl`/`PullRequestResult` reused), ADR-0051 (`RepositoryIdentity`
consumed), ADR-0050 (RepositoryHosting design), ADR-0048 (provider-reported `GitPushResult` discipline mirrored;
`git-local` adapter template), ADR-0023 (Git stays local-only). **Runtime execution succeeds in Sprint 3d-D.**
Plan: `docs/plans/sprint-3d-c-github-pr-creation-execution-plan.md`.

## ADR-0054 — Actual PR Creation Execution (PR_APPROVED → wired GitHub adapter → PR_CREATED)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3d-D — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 15 required changes applied) → implemented. **The first product-reachable
  repository-hosting mutation.**
- **Date:** 2026-07-03
- **Scope:** Wire the GitHub adapter (ADR-0053) through `REPOSITORY_HOSTING_PROVIDER` →
  `RepositoryHostingManager` (ADR-0052) into `ConversationRuntime`, and add the `PR_CREATED` state + explicit
  execution trigger + safe-failure taxonomy, so a live `PR_APPROVED` anchor + an explicit PR create/open phrase
  creates an actual Pull Request (or connects an existing open one).

### Most important rule
> Actual PR creation is a high-risk remote platform mutation. It fires ONLY on: a live `PR_APPROVED` anchor, an
> explicit PR create/open phrase **at `PR_APPROVED`**, a resolved+validated `RepositoryIdentity` that **matches
> the identity approved at PR-approval time**, a live-verified `ApprovalRef` (via `ApprovalManager.get`,
> STRUCTURED fields only — `ApprovalRequest.reason` is NEVER parsed), and exact PR/pushed context match — then
> `RepositoryHostingManager.createPullRequest`. The runtime calls the **manager only, never the
> `GitHubRepositoryHostingProvider` directly**, and receives **no token**. It never fires on approval alone, a
> bare "PR" noun, "승인"/"진행해"/"좋아", or deploy/merge/release.

### Decision
- **`PR_CREATED` state (Q1).** Added after `PR_APPROVED`. Means a provider-reported PR was created — or an
  existing open PR was safely connected — **during this run**. NOT merged/deployed/released/reviewed/CI-passed/
  safe-forever/independently-re-verified. Anchor stores `repositoryIdentity` + `pullRequestRef`/`Number`/`Url`/
  `HeadBranch`/`BaseBranch`/`CommitHash`/`Reused` and preserves the full causal chain; NO token/raw response/
  raw diff/file content/remoteUrl (Q2/CA change 8), with `pullRequestCommitHash === prPushedCommitHash`,
  head/base == approved, `repositoryIdentity` == approved.
- **Identity bound at APPROVAL time (CA change 1/9).** `handlePrApprovalTurn` (from `GIT_PUSHED`) now REQUIRES a
  resolved `RepositoryIdentity` — if absent, it creates **no** `PR_APPROVAL_PENDING` and **no** `ApprovalRequest`
  (safe "not configured"). The identity is stored on the `PR_APPROVAL_PENDING`/`PR_APPROVED` anchor; at
  execution the runtime re-resolves it and requires an **exact match** with `anchor.repositoryIdentity`
  (mismatch/absent → safe failure, no manager/provider call). Old `PR_APPROVED` anchors without
  `repositoryIdentity` fail safe.
- **State-driven trigger (Q3).** Reuses `interpretPrIntent === 'create'` at `PR_APPROVED` (same grammar that
  requested approval at `GIT_PUSHED`; the state disambiguates). Bare noun/승인/진행해/좋아/deploy/merge/release do
  not execute. `PR_APPROVAL_PENDING` still intercepts decisions — execution never bypasses approval (Q13).
- **Token wiring (CA change 3/4/6).** `apps/chunsik/src/config.ts` reads `CHUNSIK_GITHUB_TOKEN` **only** to
  construct `GitHubRepositoryHostingProvider` at the composition root; the token is **adapter-local** and never
  enters `@chunsik/core`/`ConversationRuntime` deps/anchors/`ApprovalRequest.reason`/responses/logs. When the
  token is **absent/blank**, the composition root constructs **no** adapter and injects **no** manager
  (`ConversationRuntime` receives `RepositoryHostingManager | undefined`, never the token); PR creation then
  fails safe as "not configured" at runtime **without crashing unrelated non-PR flows** (no startup crash).
- **Ownership split (Q8/CA change 7).** Runtime owns conversation state, trigger, approval+context
  verification, identity resolution+match, response, anchor transition. The **manager** owns provider.kind
  match, input validation, `repositoryExists`/`branchExists(head)`/`branchExists(base)`/`findOpenPullRequest`,
  existing-PR reuse, the single `createPullRequest`, and result integrity — the runtime does **not** duplicate
  these and never calls/imports the provider.
- **Typed manager errors (CA change 6).** `RepositoryHostingBlockedError` (pre-mutation: approval/input/repo/
  branch/find/existing-invalid — definitively no PR → "PR은 만들지 않았어요") vs `RepositoryHostingUnverifiedError`
  (the `createPullRequest` call was attempted but failed/unverified — a PR may exist → "PR 생성 완료를 확인하지
  못했어요", must NOT claim no PR). Post-attempt ambiguity never overclaims.
- **Reuse (Q9).** `pullRequestReused: true` → "기존에 열려 있던 PR을 연결했어요" (never "새 PR을 만들었어요");
  `false` → "PR을 만들었어요". Body is re-derived deterministically (count only, no file paths/diff/token —
  CA change 11).
- **Unchanged.** Git capability (no `GitProvider`/`GitManager` PR method), `ExecutionOrchestrator`,
  `WorkspaceWrite`/`Patch`/`CodeGeneration`/`CommandExecution`. No merge/auto-merge/deploy/release/reviewer/
  label/assignee/draft/branch-creation/force-push. Tests use a fake manager / fake fetch — no live GitHub
  network, no `CHUNSIK_GITHUB_TOKEN` required (CA change 15).

### Consequences
- + The product flow can now move past `PR_APPROVED` to an actual PR — behind a live approval, exact
  identity/context match, an explicit execution phrase, and the manager's hosting-state + result-integrity
  checks, with a safe-failure taxonomy that never overclaims.
- + Reuses the accepted adapter/manager/identity unchanged in contract; the runtime touches the provider only
  through the manager.
- − `ConversationRuntime`/`ApplyPreviewAnchor`/`ResponseComposer` gained the `PR_CREATED` state + execution
  flow + composers; `app.module.ts` binds the adapter when a token is present; the manager gained a typed-error
  surface. Superseded prior-sprint absence guards (3d-A/3d-B/3d-C "not wired") were updated to their enduring
  invariants (runtime never imports the adapter; Git unchanged).
- − Actual GitHub side effects now occur when configured + explicitly requested; merge/deploy/release remain
  out of scope and forbidden.

### Relations
ADR-0053 (adapter wired via `REPOSITORY_HOSTING_PROVIDER`), ADR-0052 (`RepositoryHostingManager` consumed; typed
errors added), ADR-0051 (`RepositoryIdentity`/resolver reused), ADR-0049 (`PR_APPROVED` anchor + PR context
consumed; its "PR_APPROVED + create → already approved" behavior is **superseded** — that phrase now executes),
ADR-0048/0046/0025 (approval-halt + Ref-gating lineage), ADR-0023 (Git stays local-only). Plan:
`docs/plans/sprint-3d-d-pr-creation-execution-plan.md`.

## ADR-0055 — Pull Request Status Preview (read-only, point-in-time hosting status from PR_CREATED)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3e — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 10 required changes applied) → implemented.
- **Date:** 2026-07-03
- **Scope:** A **read-only** repository-hosting status preview on an existing `PR_CREATED` anchor — at
  `PR_CREATED`, an explicit PR/CI/check/review status phrase returns a bounded, point-in-time,
  provider-reported `PullRequestStatusPreview`. No mutation, no new anchor state.

### Most important rule
> A PR status preview is a **read-only, point-in-time hosting observation — never a durable guarantee.** It is
> **not** "PR verification" / "CI verification" / "safe-to-merge" / "merge readiness" (naming discipline), and
> performs **no** merge/auto-merge/deploy/release/CI-rerun/check-rerun/review-mutation/reviewer/label/assignee/
> metadata/PR-close-reopen/draft-convert. The runtime calls `RepositoryHostingManager` only (never the adapter),
> passes **no** token, requires **no** `ApprovalRef`, and **keeps `PR_CREATED`** (no re-anchor, no new state).

### Decision
- **No new state (Q2).** Keep `PR_CREATED`; no `PR_STATUS_PREVIEWED`/`PR_VERIFIED`/`READY_TO_MERGE`/`PR_MERGED`/
  `PR_CLOSED`. A provider-reported merged/closed state is *reported* but never re-anchors or infers deploy/release.
- **Domain (Q3/CA change 3).** `PullRequestStatusPreview { ref: PullRequestRef; state; headBranch; baseBranch;
  headCommitHash; isDraft?; checks{state,total/success/failure/pending}; reviews?{state,approved/changes}; observedAt }`
  — provider-independent, bounded; **`observedAt` is generated internally at read time (adapter clock), never
  caller/user-supplied**; no raw provider response / token / check logs / review body / file paths / diff /
  file content.
- **Method (Q4/Q5/CA change 1).** `getPullRequestStatus` added to `RepositoryHostingProvider` +
  `RepositoryHostingManager` — **read-only, no `ApprovalRef`**. Input carries a **`PullRequestRef`** (not a bare
  number); the manager validates `provider.kind`, identity, `ref` (provider/owner/repo == identity, safe
  positive number, canonical github.com URL), safe head/base, SHA-shaped commit **before** the provider read,
  then validates result integrity (ref/head/base/commit match the request; non-negative integer counts). A
  mismatch is a **stale/unattributable** read → the runtime words it "could not check current status", **never**
  "checks failed" (CA change 8).
- **Anchored PR only (Q1/CA change 2).** Triggered only at `PR_CREATED` by an explicit PR/CI/check/review status
  phrase (`interpretPrStatusIntent` — a status noun AND a query verb; a bare "상태" does not trigger; merge/
  deploy/release/reviewer/label route to the companion-unsupported reply). The query target is **always
  `anchor.pullRequestRef`** — a user-supplied PR number/URL is never parsed or used.
- **GitHub adapter (Q11/CA changes 4/5/9).** Read-only, github.com only: bounded `GET` pull /
  `GET commits/{sha}/check-runs?per_page=100` / `GET pulls/{n}/reviews?per_page=100` — **one call each, no
  pagination loop, no retry**. **check-runs only** (legacy commit statuses may be unrepresented — documented;
  the response says checks are provider-reported and may be partial). Empty check-runs → `unknown` (never
  rendered as success — CA change 10). Reviews summarized latest-per-reviewer (a current signal, **not** a merge
  approval gate — CA change 6; no review body text). Sanitized errors (no token/Authorization/raw body).
- **Token boundary (Q7)** identical to ADR-0054 — adapter-local only; missing token/identity → safe
  not-configured, no state change, no crash.
- **Unchanged (Q12/Q13).** `GitProvider`/`GitManager`/`LocalGitProvider`/`RepositoryInfo`,
  `ExecutionOrchestrator`, `WorkspaceWrite`/`Patch`/`CodeGeneration`/`CommandExecution`. No GitHub write verb.
- **Future (Q14).** 3e unlocks no mutation; merge-approval / merge-execution / deployment each remain separate
  future CA-gated sprints.

### Consequences
- + Users get useful post-creation feedback (state/checks/reviews) as a point-in-time preview, with no new
  mutation surface and no new state.
- + Reuses the port/manager/adapter/anchor/token boundary unchanged in contract; adds only read-only methods.
- − Adds a `PullRequestStatusPreview` type, a read-only `getPullRequestStatus` (port/manager/adapter), a
  `PR_CREATED` status route + handler + 4 composers. Nothing mutates; the anchor never changes.

### Relations
ADR-0054 (reads the `PR_CREATED` anchor; runtime-calls-manager-only + token boundary reused), ADR-0053 (adapter
gains a read-only `GET` method), ADR-0052 (port/manager gain a read-only method; `isSafeGitHubPullRequestUrl`
reused), ADR-0051 (`RepositoryIdentity`), ADR-0023 (Git stays local-only). Plan:
`docs/plans/sprint-3e-pr-status-preview-plan.md`.

## ADR-0056 — Explicit Pull Request Merge Approval (approval gate only; NO merge, NO GitHub write)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3f — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 7 required changes applied) → implemented.
- **Date:** 2026-07-03
- **Scope:** A `RiskLevel.CRITICAL` **merge-approval gate** on an existing `PR_CREATED` anchor — an explicit
  merge / merge-approval phrase records permission to merge a specific PR context and halts. Mirrors the
  Sprint 3b PR-creation-approval flow (ADR-0049), applied to merge. **No merge execution, no GitHub write API.**

### Most important rule
> **A merge approval is a permission record — not a merge.** `MERGE_APPROVED` means permission recorded only —
> **never** merged/deployed/released/safe-to-merge/CI-passed/reviews-approved/GitHub-mergeable/branch-deleted/
> production-ready. Sprint 3f adds **only** the approval states + decision flow: no merge, no GitHub write API,
> no `RepositoryHosting`/`GitProvider`/`GitManager` merge method, no `CommandExecution`/shell, no
> `ExecutionOrchestrator` change. Actual merge execution is a future, separate, CA-reviewed sprint.

### Decision
- **States (Q2).** Add `MERGE_APPROVAL_PENDING`, `MERGE_APPROVED` after `PR_CREATED` (no `PR_MERGED`/`MERGED`/
  `DEPLOY_APPROVAL_PENDING`/`DEPLOYED`/`RELEASED`). New fields: `mergeApprovalId`, `mergeApprovalRequestedAt`,
  `mergeApprovedAt`, and **`mergeApprovalDecisionBy` (required on `MERGE_APPROVED`** — CA change 2). Both states
  preserve the full `PR_CREATED` causal chain (identity/pullRequestRef/head/base/commit/push/commit/workspace).
  No token/raw response/diff/file content/check logs/review body/remoteUrl stored.
- **Trigger (Q1).** From `PR_CREATED`, `interpretMergeIntent` (checked after the 3e status intent) returns
  `'merge'` for a merge word + a request/approval/execution verb → `handleMergeApprovalTurn`. A merge
  safety/possibility **question** ("머지 가능해?/안전해?"), a bare "진행해"/"좋아"/"승인" (no merge word), a PR
  **status** phrase (→ 3e preview), and deploy/release phrases do **not** create a merge approval. An explicit
  merge-execution phrase ("머지해줘"/"merge this PR") records **approval only**, and the reply says it does not
  merge (CA-approved).
- **Approval reason.** Deterministic bounded `buildMergeApprovalReason`: `operation` + `repository: owner/repo`
  + `pull request: #n url` + head/base + short commit + **`pr source: created|connected-existing`** (renamed
  from "status" — CA change 6) + "no merge/deployment/release has been performed" + "merge is not guaranteed
  safe or mergeable by this approval; checks/reviews/hosting state are not verified" (CA change 6). Never says
  "merge creation" (CA change 1), never a positive checks-passed/reviews-approved/mergeable/safe-to-merge
  claim, no token/diff/file/check/review payload. **Never parsed later** — structured fields + `ApprovalRef`
  are authority (CA change 3).
- **Pending (Q7).** `MERGE_APPROVAL_PENDING` intercepts every turn (`handleMergeApprovalDecisionTurn`): a
  merge/deploy/status phrase → ambiguous re-prompt (no decide, no merge); **"진행해" approves only while
  pending** (CA change 4); approve requires `ApprovalManager.get` exists + PENDING + `executionPlanRef` match
  (structured only).
- **Deny/cancel (Q8) → `PR_CREATED`**, clearing **only** merge fields (`mergeApprovalId`/`RequestedAt`/
  `ApprovedAt`/`DecisionBy`); PR/push/commit/workspace preserved. **Approve (Q9) → `MERGE_APPROVED`** (+
  `mergeApprovedAt`, `mergeApprovalDecisionBy`); all context preserved; **still no merge.**
- **`MERGE_APPROVED` follow-up (Q10/Q11).** A merge phrase → already-approved (future execution only); deploy/
  release/reviewer/label/assignee → unsupported future step; a **status phrase → the 3e read-only status
  preview, keeping `MERGE_APPROVED`** (never re-anchored), with a reminder line "머지 승인은 기록되어 있지만,
  아직 머지는 하지 않았어요" so the preview never implies the approval was consumed/cleared (CA change 5). A
  merge phrase at `MERGE_APPROVED` performs no merge/provider/Git/command/shell call (CA change 7).
- **Fresh status not required (Q5).** Approval records permission without a fresh preview; the reason/response
  avoid implying checks/reviews/mergeability safety. **Future merge execution (Q14, deferred)** must
  re-validate: live `MERGE_APPROVED`, identity, pullRequestRef, head/base/commit, PR open + not-merged +
  not-closed, current head SHA, mergeability if exposed, checks/reviews per future CA policy — **none
  implemented in 3f.**
- **Unchanged (Q4/Q12/Q13).** `RepositoryHostingProvider`/`RepositoryHostingManager`/
  `GitHubRepositoryHostingProvider` (no merge method), Git capability, `ExecutionOrchestrator`, `WorkspaceWrite`/
  `Patch`/`CodeGeneration`/`CommandExecution`.

### Consequences
- + A CRITICAL, auditable merge-permission gate before any (future) merge mutation, consistent with the
  commit/push/PR-creation approval gates; reuses the accepted approval-halt template + CAP-004.
- − `ConversationRuntime`/`ApplyPreviewAnchor`/`ResponseComposer` gain the two states + merge flow + 7
  composers; the 3e status preview widens to also serve `MERGE_APPROVED` (read-only, no re-anchor). Nothing
  mutates GitHub; no merge occurs.

### Relations
ADR-0054 (reads/preserves the `PR_CREATED` chain), ADR-0055 (read-only status preview reused from
`MERGE_APPROVED`), ADR-0049 (CRITICAL request → `*_APPROVAL_PENDING` → decision → `*_APPROVED` template
mirrored), ADR-0025 (CAP-004 Approval — `requestForRisk`/`get`/`decide`, CRITICAL), ADR-0023 (Git local-only).
Plan: `docs/plans/sprint-3f-explicit-pr-merge-approval-plan.md`.

## ADR-0057 — Pull Request Merge Execution Preflight (actual merge from MERGE_APPROVED, live-preflight-guarded)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3g — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 5 required changes applied) → implemented.
- **Date:** 2026-07-03
- **Scope:** The first repository-hosting mutation AFTER PR creation — an explicit merge-execution command at a
  live `MERGE_APPROVED` anchor executes an actual PR merge on the hosting provider, but only after a full live
  preflight and only via a new `RepositoryHostingManager`/`RepositoryHostingProvider` merge method. Mirrors the
  Sprint 3d-D PR-creation-execution safety model (ADR-0054), applied to merge.

### Most important rule
> **A merge execution mutates exactly ONE approved PR — and nothing else.** `PR_MERGED` means only: the approved
> PR was merged on the hosting provider during this run, or the exact approved head was observed already merged
> during this run. It does **NOT** mean deployed / released / production-ready / branch-deleted / CI-permanently-
> verified / local-main-synced. No deploy/release/tag/branch-deletion/force-merge/auto-merge/PR-branch-update/
> PR-close-reopen/reviewer-label-assignee/check-rerun/workflow-dispatch, no local git mutation, no
> `CommandExecution`/shell, no `ExecutionOrchestrator`/`WorkspaceWrite`/`Patch`/`CodeGeneration` change. The
> hosting token stays adapter-local (never core/domain/anchor/reason/response/logs). Unknown post-attempt errors
> are **unverified**, never "not merged".

### Decision
- **State (Q1).** Add only `PR_MERGED` (terminal) after `MERGE_APPROVED` — no `MERGE_EXECUTION_PENDING` (the 3f
  `MERGE_APPROVED` gate is the approval; execution needs no second approval), no `DEPLOYED`/`RELEASED`/
  `BRANCH_DELETED`. New anchor fields: `mergedAt` (**runtime record/observe timestamp** — `now()`, not the
  provider's original merge time, CA change 3), `mergeExecutedBy`, `mergedHeadSha` (required on `PR_MERGED`),
  `mergeCommitHash?` (provider-reported, optional). `PR_MERGED` preserves the full chain + the 3f approval
  evidence.
- **Trigger (Q3, CA change 1).** Only at `MERGE_APPROVED`/`PR_MERGED`. `interpretMergeExecutionIntent` = a merge
  word + a request/execution verb (`해줘`/`실행`/`실제`/`지금`/`승인된`/`now`/`execute`/`merge this`/`approved`), with the
  MERGE_QUESTION status/check/possibility guard taking precedence. **`머지해줘`/`이 PR 머지해줘`/`merge this PR`
  EXECUTE** — the user already passed the 3f CRITICAL gate, so a direct merge imperative is a valid execution
  command; safety comes from state + approval revalidation + live preflight + expected head SHA + mergeability,
  not a magic wording. A bare `머지`/`merge` noun → `composeMergeAlreadyApproved` (ask to merge explicitly, CA
  change 4); `머지 상태 확인해줘`/`머지 체크해줘` → read-only 3e status path (`interpretMergeStatusIntent`); `PR_CREATED
  + 머지해줘` → approval (3f), `MERGE_APPROVAL_PENDING + 머지해줘` → re-prompt (3f), `MERGE_APPROVED + 배포/릴리즈` →
  unsupported companion.
- **Live preflight (16 checks).** Runtime re-validates the approval evidence (`mergeApprovalId` →
  `approvals.get` → `APPROVED` → `executionPlanRef.id` match) + the anchored context (identity matches resolved
  identity + ref; pullRequestRef/number/url/head/base/commit present); the Manager backstop-validates then reads
  the LIVE PR immediately before mutation via `getMergePreflight`, checking (integrity **always**, before the
  already-merged branch — CA change 2) ref/head/base/`headCommitHash == expectedHeadSha`, then state (open) +
  mergeability. Any pre-mutation failure → `RepositoryHostingBlockedError` ("not merged").
- **Mergeability (Q6).** Normalized provider-independent `PullRequestMergeability = MERGEABLE|BLOCKED|
  CONFLICTING|UNKNOWN|STALE_HEAD`; only `MERGEABLE` proceeds; everything else blocks (never merge on
  uncertainty). No force merge, no branch-protection bypass, no PR-branch auto-update. Raw→normalized mapping
  (e.g. GitHub `mergeable`/`mergeable_state`) lives adapter-side only; the core never sees the payload.
- **Already-merged idempotency (CA change 2).** Live state `merged` at the EXACT approved head (integrity passed)
  → `PR_MERGED`, `alreadyMerged=true`, no mutating call. Merged at a DIFFERENT head → Blocked/Stale, stays
  `MERGE_APPROVED` (never claims the approved head was merged when a different head may have been).
- **Capability (Q5).** New `RepositoryHostingManager.mergePullRequest` (consumes/validates the `ApprovalRef`,
  never forwarded) + `RepositoryHostingProvider.getMergePreflight` (read-only) + `.mergePullRequest` (the only
  new mutating method; receives hosting-safe refs + expected head SHA only, no `ApprovalRef`). `alreadyMerged` is
  Manager-owned (mirrors `reused`). Merge is a **hosting** mutation — `GitProvider`/`GitManager` gain no method
  (ADR-0023).
- **GitHub adapter.** `getMergePreflight` → read-only `GET /repos/{o}/{r}/pulls/{n}`; `mergePullRequest` → single
  `PUT /repos/{o}/{r}/pulls/{n}/merge` with `{ sha: expectedHeadSha, merge_method: 'merge' }` (the `sha` guard
  refuses a moved head). Built-in fetch, github.com only, sanitized errors, token adapter-local.
- **Failure semantics (Q7, extends ADR-0054).** Known pre-mutation block → Blocked ("not merged"); any throw or
  result-integrity failure at/after the mutating call → Unverified ("could not verify — check PR status", never
  "not merged"); live-already-merged at the exact head → idempotent `PR_MERGED`. Every failure keeps
  `MERGE_APPROVED`.
- **Unchanged.** `CommandExecution`/`ExecutionOrchestrator`/`WorkspaceWrite`/`Patch`/`CodeGeneration`, Git
  capability, deploy/release/tag/branch-deletion/auto-merge/reviewer-label-assignee/check-rerun/workflow-dispatch/
  local-post-merge-sync (all out of scope).

### Consequences
- + The product now owns a verified `PR_MERGED` state — the first remote mutation after PR creation — behind the
  existing CRITICAL 3f approval gate + a conservative live preflight, reusing the ADR-0054 Blocked-vs-Unverified
  safety rule and the ADR-0055 integrity-checked read shape.
- − `domain`/`port`/`RepositoryHostingManager`/`ConversationRuntime`/`ResponseComposer`/`GitHubRepositoryHosting
  Provider` each gain the merge preflight + execution surface (one new state, two provider methods, one manager
  method, one runtime handler, six composers). Nothing deploys/releases; merge occurs only on
  `MERGE_APPROVED` + an explicit execution command + all 16 preflight checks passing.

### Relations
ADR-0056 (consumes the `MERGE_APPROVED` anchor + `mergeApprovalId` approval evidence as the sole trigger source),
ADR-0054 (reads/preserves the `PR_CREATED` chain; extends the remote-mutation Blocked-vs-Unverified rule),
ADR-0055 (mirrors the integrity-checked point-in-time read; the read-only status preview also serves `PR_MERGED`),
ADR-0052/0053 (extends the `RepositoryHostingProvider` port + Manager + GitHub adapter), ADR-0025 (CAP-004
Approval — `get`/`APPROVED`/`ApprovalRef`), ADR-0023 (Git local-only; merge is a hosting mutation).
Plan: `docs/plans/sprint-3g-pr-merge-execution-preflight-plan.md`.

## ADR-0058 — Post-Merge Local Main Synchronization (fast-forward-only local main sync from PR_MERGED)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3h — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 6 required changes applied) → implemented.
- **Date:** 2026-07-04
- **Scope:** From a live `PR_MERGED` anchor, an explicit sync command synchronizes the **local** workspace
  repository's `main` ref to the expected post-merge remote `main` commit — **fast-forward only**, via the **Git**
  capability (CAP-002), never a shell. Closes the "remote main advanced but the local workspace is on an old head"
  gap. Mirrors the ADR-0054 remote-mutation safety model, applied to local Git.

### Most important rule
> **A local main sync is a fast-forward of the LOCAL `main` ref — and nothing else.** `MAIN_SYNCED` means local
> main reached the expected commit this run; it does **NOT** mean deployed / released / production-ready /
> branch-deleted / remote-branch-cleaned / CI-permanently-verified / current-feature-branch-merged, and it does
> **not** unlock deploy/release. No force/`--force`/`reset --hard` (no hard reset), no branch deletion (local/
> remote/GitHub), no remote push, no PR mutation, no `CommandExecution`/shell, no `ExecutionOrchestrator`/
> `WorkspaceWrite`/`Patch`/`CodeGeneration` change. If a fast-forward is not possible → **block, never force**.
> Unknown failure after the local ref-update attempt is **unverified**, never "not synced".

### Decision
- **State (Q1, CA change 1).** Add `MAIN_SYNCED` only (terminal). New anchor fields (required on `MAIN_SYNCED`):
  `syncedMainCommit`, `mainSyncedAt` (**runtime record timestamp**, `now()`), `mainSyncBranch` ('main'), `syncMode`
  (`checked-out-main` | `ref-only`), `workingTreeUpdated`, `previousMainCommit` (CAS base). Preserves the full
  `PR_MERGED` chain + merge evidence.
- **Trigger (Q3).** Only at `PR_MERGED`/`MAIN_SYNCED`. `interpretMainSyncIntent` = a sync verb (동기화/최신화/받아와/
  sync/pull/update main) AND a main target; a bare "sync"/"main" alone does not trigger. Checked BEFORE the 3g
  already-merged routing so "머지된 main 받아와줘" syncs (not read as a merge phrase). A sync phrase in any other
  state never syncs.
- **Ownership (Q2).** The **Git capability** owns the sync primitives; `ConversationRuntime` only composes. New:
  `GitProvider.getRemoteRefCommit` (read-only `ls-remote`), `GitProvider.getLocalRefCommit` (read-only
  `rev-parse`), `GitProvider.syncMainFastForward` (the single mutating primitive), `GitManager.syncMain`
  (orchestrates the preflight + the single mutation; **no ApprovalRef** — a local, non-destructive, ff-only ref
  move gated by PR_MERGED + explicit command + preflight). No new capability, no shell, no ExecutionOrchestrator.
- **Strategy (Q4, CA change 1) — mode split + CAS (CA change 3).** Fast-forward only; no hard reset, no force.
  `current==main` → **checked-out-main** ff (working tree/index moved by `git merge --ff-only`); `current!=main`
  → **ref-only** ff of `refs/heads/main` (`git update-ref <new> <old>` CAS; no checkout switch, no working-tree
  change); detached HEAD → Block; non-ff → Block. The local ref update is compare-and-swap against the observed
  `previousMainCommit`; moved-before → Block, moved-during/after → Unverified.
- **Expected remote tip (Q5, CA change 4).** The expected remote `main` tip is `PR_MERGED.mergeCommitHash`;
  **absent → Block, with NO fallback to `mergedHeadSha`** ("ChunsikBot cannot prove which remote main commit
  should be synchronized"). A future sprint may add a bounded ancestry policy.
- **Preflight (14 checks).** Runtime: `PR_MERGED` + identity match + base=='main' + `mergedHeadSha` +
  `mergeCommitHash` + rootPath. Manager: isRepository + clean/no-untracked/no-staged/no-unstaged/no-unmerged +
  not-detached + local main exists (CAS base) + remote main observed + remote tip == expected + bounded. All
  pre-ref-update failures → *Blocked*.
- **Failure semantics (Q5, CA change 2) — phase-aware.** KNOWN pre-ref-update failure → `GitMainSyncBlockedError`
  ("not synced"); any failure AT/AFTER the local ref-update attempt → `GitMainSyncUnverifiedError` (never "not
  synced"). The provider throws phase-aware typed errors; the Manager propagates Blocked as Blocked and
  Unverified/unknown as Unverified — it does **not** blanket-convert. Every failure keeps `PR_MERGED`.
- **Response wording (Q8, CA change 5).** Mode-aware: ref-only says "local main ref synchronized, current checkout
  unchanged, working tree remained clean"; checked-out-main says "checked-out main fast-forwarded, working tree
  updated, clean after sync". Never "workspace synced"/"working tree is now main". Every path states what was NOT
  done (deploy/release/branch deletion). Composers: `composeMainSyncSucceeded`/`Blocked`/`Unverified`/`Unavailable`.
- **Out of scope (Q6/Q7).** No branch deletion (local/remote/GitHub), no deploy/release/tag, no force/reset/push,
  no PR mutation, no RepositoryHosting change, no CommandExecution/shell, no ExecutionOrchestrator/WorkspaceWrite/
  Patch/CodeGeneration change. `MAIN_SYNCED` does not unlock deploy/release.

### Consequences
- + The product can now bring the local workspace's `main` to the merged commit safely (ff-only, mode-split,
  CAS-guarded, phase-aware), closing the post-merge local-state gap without any destructive Git operation.
- − `domain`/`GitProvider`/`GitManager`/`ConversationRuntime`/`ResponseComposer`/`git-local` gain the sync surface
  (one new terminal state, three provider methods, one manager method + two typed errors, one runtime handler,
  four composers). Nothing deploys/releases/deletes; `main` is never force-moved.

### Relations
ADR-0057 (consumes the `PR_MERGED` anchor + `mergeCommitHash`/`mergedHeadSha`/`pullRequestBaseBranch`/
`repositoryIdentity` as the sole trigger source + sync evidence), ADR-0054/0048/0046 (extends the remote-mutation
Blocked-vs-Unverified rule; the third Git mutation, single bounded argv, adapter-side, no shell), ADR-0055 (mirrors
the point-in-time read shape; the read-only status preview also serves `MAIN_SYNCED`), ADR-0023/0047 (Git =
local-only repository capability; `GitStatus` fields reused). Plan:
`docs/plans/sprint-3h-post-merge-local-main-sync-plan.md`.

## ADR-0059 — Post-Merge Branch Cleanup (safe LOCAL merged-branch delete from MAIN_SYNCED; remote deletion deferred)

- **Status:** ✅ Accepted (v2, Phase 3, Sprint 3i — Product Construction), Chief Architect plan review:
  APPROVED WITH CHANGES (all 6 required changes applied) → implemented.
- **Date:** 2026-07-04
- **Scope:** From a live `MAIN_SYNCED` anchor, an explicit **local** cleanup command deletes the already-merged
  feature branch (the anchored PR head branch) — via the **Git** capability (CAP-002), **CAS delete only**
  (`git update-ref -d refs/heads/<t> <expected>`, never `-D`/force), never a shell. **Remote branch deletion is
  DEFERRED** to a future, separately-gated sprint. Mirrors the ADR-0058 local-Git safety model, applied to deletion.

### Most important rule
> **A branch cleanup deletes exactly ONE already-merged LOCAL branch — the anchored PR head branch — and nothing
> else.** `BRANCH_CLEANED` means the completed feature branch's LOCAL ref was deleted (or was already absent) this
> run; it does **NOT** mean deployed / released / tagged / production-ready / remote-branch-deleted /
> all-branches-cleaned / repository-fully-cleaned. No remote deletion (deferred), no `-D`/force delete, no deleting
> `main`, no bulk/wildcard, no deleting an unmerged or checked-out branch, no `reset --hard`/force push, no PR
> mutation, no deploy/release/tag, no `CommandExecution`/shell, no `ExecutionOrchestrator`/`WorkspaceWrite`/`Patch`/
> `CodeGeneration` change. If not fully merged / checked out / `main` / unsafe → **block, never force**. Unknown
> failure after the ref-delete attempt is **unverified**, never "not deleted".

### Decision
- **State (Q1).** Add `BRANCH_CLEANED` only (terminal). Fields (required on `BRANCH_CLEANED`): `branchCleanupMode`
  (**'local' in 3i**; 'remote'/'local-and-remote' reserved for a future gated sprint), `cleanedBranch`,
  `branchCleanedAt` (runtime ts), `branchCleanedBy`, `cleanedLocalBranch`, `cleanedRemoteBranch` (**always false in
  3i**). Preserves the full `MAIN_SYNCED` chain + merge/sync evidence.
- **Trigger (Q3, CA change 1).** Only at `MAIN_SYNCED`/`BRANCH_CLEANED`. A REMOTE-cleanup phrase
  (`interpretRemoteBranchCleanupIntent`: cleanup verb + branch word + 원격/remote/origin/github) is checked FIRST →
  `composeRemoteBranchCleanupUnsupported` (NEVER a local delete side effect). A LOCAL phrase
  (`interpretBranchCleanupIntent`: cleanup verb + branch word; rejects bulk/wildcard, `main`-target, and any remote
  qualifier) → local cleanup. The deletion TARGET is always the **anchored PR head branch** — never a user-named
  branch. Bare `정리해줘`/`배포해줘`/`main 삭제해줘`/`브랜치 다 삭제해줘` never trigger.
- **Ownership (Q2) + strategy (CA change 3).** Local deletion → the Git capability via
  `git update-ref -d refs/heads/<target> <expectedBranchCommit>` — a git-native CAS delete that does **not** depend
  on the current `HEAD`/checkout (Sprint 3h ref-only mode may leave a non-main checkout); no `git branch -d`.
  **Remote deletion → DEFERRED** (a remote mutation needing its own explicit gate). New `GitProvider.isAncestor`
  (read) + `GitProvider.deleteMergedLocalBranch(rootPath, branch, expectedBranchCommit)` (CAS delete);
  `GitManager.deleteMergedLocalBranch` orchestrates the preflight + single delete; **no ApprovalRef** (local,
  recoverable, gated by `MAIN_SYNCED` + explicit command + preflight).
- **Preflight (Q4) + CAS (CA change 2/4).** Runtime: `MAIN_SYNCED` + `syncedMainCommit` + `mainSyncBranch=='main'`
  + target==`pullRequestHeadBranch`==`pushedBranch` + target!='main' + safe name + identity match. Manager:
  isRepository + status(no mid-op) + info(target not checked out) + **local main exists AND == `syncedMainCommit`
  (CA change 4)** + target branch exists (absent → idempotent) + `isAncestor(targetCommit, syncedMainCommit)`
  (fully merged). The provider CAS-deletes against the observed `targetCommit` (moved-before → Blocked).
- **Failure semantics (Q5, CA change 5).** Phase-aware: pre-ref-delete → `BranchCleanupBlockedError` ("not
  deleted"); at/after the ref-delete → `BranchCleanupUnverifiedError` (never "not deleted"); target already absent
  → idempotent `BRANCH_CLEANED` (cleanedLocalBranch=false, "already absent; nothing deleted; remote not deleted;
  main not changed"). Manager does not blanket-convert provider throws. Every failure keeps `MAIN_SYNCED`.
- **Approval (Q6).** Local cleanup: **no new CRITICAL approval**. Remote cleanup: **deferred** — a future sprint
  must add an explicit approval gate before any remote deletion.
- **Response (Q7).** Mode-aware: local-deleted vs already-absent; every path states main + remote were not touched;
  never implies deploy/release/tag/all-cleaned/repo-cleaned/remote-deleted. Composers:
  `composeBranchCleanupSucceeded`/`Blocked`/`Unverified`/`Unavailable` + `composeRemoteBranchCleanupUnsupported`.
- **Out of scope (Q8).** No remote deletion (deferred), no `-D`/force, no `main`/arbitrary/bulk/wildcard, no
  reset/force-push, no PR mutation, no deploy/release/tag, no shell, no `ExecutionOrchestrator`/`WorkspaceWrite`/
  `Patch`/`CodeGeneration`/`RepositoryHosting` change.

### Consequences
- + The product can now clean up the completed local feature branch safely (CAS delete, deterministic, tied to the
  exact synchronized main), completing the local post-merge lifecycle without any destructive/remote operation.
- − `domain`/`GitProvider`/`GitManager`/`ConversationRuntime`/`ResponseComposer`/`git-local` gain the cleanup
  surface (one new terminal state, two provider methods, one manager method + two typed errors, three runtime
  handlers, five composers). Nothing deploys/releases; remote branches are untouched; `main` is never deleted.

### Relations
ADR-0058 (consumes the `MAIN_SYNCED` anchor + `syncedMainCommit`/`mainSyncBranch` as the sole trigger source +
cleanup evidence), ADR-0057/0054 (the `pullRequestHeadBranch`/`pushedBranch` deletion target + the remote-mutation
Blocked-vs-Unverified rule, applied to local deletion), ADR-0046/0048/0023 (Git mutation discipline: single bounded
argv, adapter-side, no shell; Git = local repository capability). Plan:
`docs/plans/sprint-3i-post-merge-branch-cleanup-plan.md`.

## ADR-0060 — Remote Branch Cleanup (RepositoryHosting-owned, CRITICAL-approval-gated delete of exactly ONE merged PR head branch; split 3j-A approval / 3j-B execution)

- **Status:** ✅ Accepted (v2, Phase 3 — Product Construction), CA plan review: APPROVED WITH CHANGES → **split into
  two implementation sprints under this single ADR, both now implemented.** **Sprint 3j-A (approval gate)** and
  **Sprint 3j-B (execution/delete)** are both implemented (3j-B CA plan review: APPROVED WITH CHANGES → all 6 changes
  + tests 25–34 applied). The full chain `BRANCH_CLEANED → REMOTE_BRANCH_CLEANUP_PENDING → REMOTE_BRANCH_CLEANUP_
  APPROVED → (execute) → REMOTE_BRANCH_CLEANED` is now reachable.
- **Date:** 2026-07-04
- **Scope (whole design):** From a live `BRANCH_CLEANED` anchor, an explicit **remote** branch-cleanup command
  deletes the completed PR's **remote head branch** from the hosting provider — via the **RepositoryHosting**
  capability (CAP-010), through a **new CRITICAL ApprovalRequest**, **exactly ONE remote ref**, only after a strict
  live revalidation. **3j-A = the approval gate only (no deletion). 3j-B = the execution/delete.**

### Most important rule
> **A remote branch cleanup deletes exactly ONE remote branch — the anchored, already-merged PR head branch — and
> nothing else.** `REMOTE_BRANCH_CLEANED` (3j-B) means the completed PR's REMOTE head ref was deleted (or was already
> absent) this run; it does **NOT** mean deployed / released / tagged / production-ready / local-branch-deleted-this-
> run / all-branches-cleaned / repository-fully-cleaned. No deletion of the default/`main` branch, no bulk/wildcard/
> pattern, no force, no `git push --delete` (Git stays local-only, ADR-0023), no LOCAL deletion (that was 3i), no
> deploy/release/tag, no PR/reviewer/label/assignee mutation, no shell. **Deletion happens ONLY from a recorded
> CRITICAL approval + an explicit execute command + a full live preflight (3j-B).**

### Decision
- **State (Q1).** The full design adds `REMOTE_BRANCH_CLEANUP_PENDING` → `REMOTE_BRANCH_CLEANUP_APPROVED` →
  `REMOTE_BRANCH_CLEANED` (terminal). **3j-A adds ONLY the two approval states** + the four approval-tracking fields
  (`remoteBranchCleanupApprovalId`/`…RequestedAt`/`…ApprovedAt`/`…ApprovalDecisionBy`). **`REMOTE_BRANCH_CLEANED`,
  the descriptive remote fields (`remoteBranchCleanupMode`/`cleanedRemoteBranchName`/`remoteBranchCleanedAt`/`…By`/
  `remoteBranchCleanupProvider`/`remoteBranchDeletedCommit`), and `cleanedRemoteBranch=true` are 3j-B.** The
  `cleanedRemoteBranch` boolean is **reused** for "a remote branch was deleted this run" (stays `false` through 3j-A);
  distinct descriptive fields preserve the 3i LOCAL cleanup evidence unoverloaded. The chain is always preserved.
- **Ownership (Q2).** **RepositoryHosting** owns remote branch deletion (GitHub Git-refs REST, keyed by provider
  identity). **Git `push --delete` is REJECTED** — Git is a local-repository capability that must never handle a
  remote URL/credentials (ADR-0023); routing a remote mutation through it would smuggle blast radius behind a "local"
  capability. So local (Git, ADR-0059) and remote (RepositoryHosting, this ADR) deletion are different capabilities.
  *(The provider/manager delete methods are 3j-B; 3j-A adds no RepositoryHosting read/write method.)*
- **Approval (Q3).** A **new `RiskLevel.CRITICAL` ApprovalRequest**, tracked by a **distinct**
  `remoteBranchCleanupApprovalId` (never reusing commit/push/PR/merge ids). Approval happens **before** deletion,
  always; **two separate turns** (approval then execution), mirroring every prior gated mutation (2x/2y, 2z/3a,
  3f/3g). `BRANCH_CLEANED → (remote phrase) → REMOTE_BRANCH_CLEANUP_PENDING → (approve) → REMOTE_BRANCH_CLEANUP_
  APPROVED → (execute) → REMOTE_BRANCH_CLEANED`. The `ApprovalRef` is consumed by the Manager, never forwarded to the
  provider. **Approval reason (CA change 4)** states ONLY the permission target (repository/PR/anchored remote head
  branch/expected head commit) + risk + permission-only disclaimers; it must NOT claim the branch exists, its SHA is
  current, the PR is still merged, or that deletion is safe/will-succeed — those are live 3j-B checks.
- **Trigger (Q4, CA change 8).** `interpretRemoteBranchCleanupIntent` (cleanup verb + branch word + remote
  qualifier) is **hardened** to reject bulk/wildcard/all/`main`·default-branch phrases (load-bearing now that a
  remote phrase starts a real CRITICAL delete-approval, not the 3i no-op). Only at `BRANCH_CLEANED` (→ approval) /
  `REMOTE_BRANCH_CLEANUP_APPROVED` (→ already-approved). At `MAIN_SYNCED` a remote phrase → "clean local first" (no
  approval). The delete TARGET is always the **anchored PR head branch** — never a user-named branch.
- **Preflight + CAS (Q5/Q6, 3j-B).** 17-check live preflight (3j-B CA changes 2–4 added: `mergedHeadSha`-only
  expected commit with **no** `pullRequestCommitHash` fallback; the local-cleanup chain re-checked
  `branchCleanupMode==='local'` / `cleanedBranch===head` / `cleanedRemoteBranch===false` / `cleanedLocalBranch` boolean;
  complete 3j-A approval evidence). **GitHub has no atomic SHA-conditional ref delete**, so the mitigation is
  read-immediately-before-delete + explicit SHA verify + a single `DELETE /git/refs/heads/<branch>` (slash-preserving
  per-segment encoding, CA change 5), with an explicitly-accepted bounded residual race and Unverified-on-ambiguity.
  Already-absent → idempotent `REMOTE_BRANCH_CLEANED` (`cleanedRemoteBranch=false`, no DELETE).
- **Failure semantics (Q7, 3j-B).** Phase-aware: pre-delete → `RemoteBranchCleanupBlockedError` ("not deleted");
  at/after delete → `RemoteBranchCleanupUnverifiedError` (never "not deleted"); already-absent → idempotent. The typed
  errors live in `domain/repository-hosting.ts` (Option B, CA change 6) so adapter + manager + runtime share them; the
  manager does NOT blanket-convert a provider `Blocked` into `Unverified`.
- **3j-A behavior.** BRANCH_CLEANED + remote phrase → CRITICAL approval → PENDING (permission only, NO delete). PENDING
  intercepts every turn (approve → APPROVED; deny/cancel → BRANCH_CLEANED clearing ONLY the four approval fields, chain
  preserved; a remote/execute/status/deploy phrase → ambiguous re-prompt, never auto-approves/deletes). APPROVED is
  permission-only in 3j-A.
- **3j-B behavior (execution).** At REMOTE_BRANCH_CLEANUP_APPROVED an explicit **execution** command (checked FIRST,
  CA change 1; a re-request without an execute verb → already-approved) → `handleRemoteBranchCleanupExecutionTurn` →
  re-read the 3j-A approval (structured) + the 17-check preflight → `RepositoryHostingManager.deleteRemoteBranch`
  (live `getMergePreflight` merged-check + `getRemoteBranchCommit` + single provider `deleteRemoteBranch`) →
  `REMOTE_BRANCH_CLEANED` (mode 'remote', `cleanedRemoteBranchName`/`remoteBranchDeletedCommit`/`remoteBranchCleanedAt`/
  `…By`/`remoteBranchCleanupProvider`, `cleanedRemoteBranch=result.deleted`), preserving the full chain + approval
  evidence. Runtime calls the manager only, never the provider; token stays adapter-local.
- **Out of scope (Q8).** deploy · release · tag · delete default/`main` · arbitrary/user-named/bulk/wildcard delete ·
  force · `git push --delete` · LOCAL deletion · reset/force-push · PR/reviewer/label/assignee mutation · workflow
  dispatch · check rerun · shell/CommandExecution · ExecutionOrchestrator/WorkspaceWrite/Patch/CodeGeneration/Git
  changes. **3j-A additionally excludes** all remote deletion, the GitHub DELETE, the RepositoryHosting read/delete
  methods, and the `REMOTE_BRANCH_CLEANED` active state (all 3j-B).

### Consequences
- + The product now reaches the end of the development lifecycle: from a CRITICAL-gated approval (3j-A) an explicit
  execution command (3j-B) deletes the completed PR's remote branch via a single GitHub Git-refs DELETE — the final
  cleanup step — with the settled Blocked-vs-Unverified safety split and no atomic-CAS overclaim.
- − 3j-A: `ConversationRuntime` (+2 approval states, +4 approval fields, +2 classifiers, +1 reason builder, handlers)
  and `ResponseComposer` gain the approval surface. 3j-B: `domain` (RemoteBranchCleanupResult + 2 typed errors),
  `RepositoryHostingProvider`/`RepositoryHostingManager` (+`getRemoteBranchCommit`/`deleteRemoteBranch`), the GitHub
  adapter (git-refs GET + DELETE, slash-preserving ref path), `ConversationRuntime` (+`REMOTE_BRANCH_CLEANED` + the
  execution turn + 6 descriptive fields), and `ResponseComposer` (success/blocked/unverified/already-cleaned) gain the
  execution surface. No deploy/release/tag/default-branch/bulk/wildcard/force/`git push --delete`/local-delete/shell/
  `ExecutionOrchestrator`/`WorkspaceWrite`/`Patch`/`CodeGeneration`/Git-capability change.

### Relations
ADR-0059 (consumes the `BRANCH_CLEANED` anchor + the `interpretRemoteBranchCleanupIntent` classifier +
`cleanedRemoteBranch`; extends the local-vs-remote wording split), ADR-0057/0056 (the CRITICAL
merge-approval→execution two-turn pattern mirrored here + the RepositoryHosting Blocked-vs-Unverified rule for 3j-B),
ADR-0054/0053/0052/0051 (the RepositoryHosting capability: manager owns approval/ordering/integrity; provider owns
bounded GitHub REST, adapter-local token, no shell; `RepositoryIdentity`/`pullRequestRef` as the only target),
ADR-0023 (Git = local repository capability, never a remote URL — why remote deletion is RepositoryHosting-owned).
Plans: `docs/plans/sprint-3j-remote-branch-cleanup-plan.md` (3j-A approval),
`docs/plans/sprint-3j-b-remote-branch-cleanup-execution-plan.md` (3j-B execution).

## ADR-0061 — GitHub App Authentication (dev/PAT → GitHub App installation; adapter-local App key, short-lived installation tokens minted at execution; CAP-010 REST + CAP-002 push/clone; zero Core-contract change)

- **Status:** ✅ **Accepted** (v2 — GitHub App Authentication; Sprint 4a design ACCEPTED → this ADR gates Sprint 4b
  implementation). **Ratified by the Chief Architect / Product Owner on 2026-07-07** under the ratification
  conditions below (Sprint 4a/4b baseline; no new capability; `GitProvider` port + `LocalGitProvider` unchanged; no
  credential on `RepositoryInfo`/`RepositoryIdentity`; the secret boundary; one-shot `GIT_ASKPASS` only; HTTPS
  remote preflight required; SSH blocked for App-auth push; Discord credential-free; PAT dev-only; new artifacts use
  Quoky naming; no rename of existing identifiers; UAT + production secret creation NOT yet approved; no broad
  naming migration; Sprint 4c not started). Sprint 4b implementation is approved to proceed.
- **Date:** 2026-07-07
- **Scope:** Replace the developer/PAT repository-auth model with a **GitHub App installation** model for BOTH
  GitHub auth surfaces — **RepositoryHosting REST (CAP-010)** and **local `git push`/`clone` (CAP-002)**. The App
  private key is the only new durable secret and is **adapter-local**; a **short-lived installation access token**
  is minted **at execution time**, used as the Bearer for REST and as the git credential for push/clone, and never
  exposed. The change is **adapter-local + composition-root only** — **no `@chunsik/core` contract changes, no new
  capability.** Authoritative design: `docs/plans/sprint-4a-…-plan.md` (baseline, §11/§15/§18) and
  `docs/plans/sprint-4b-…-implementation-plan.md` (concrete implementation, both CA-accepted).

### Most important rule
> **The App private key and every minted installation token are adapter-local / composition-owned and NEVER appear
> in process argv, a git remote URL, `.git/config`, logs, anchors, an `ApprovalRequest.reason`, a Discord message,
> UAT evidence, or anywhere in `@chunsik/core`.** `LocalGitProvider` and the `GitProvider` **port are unchanged**;
> `RepositoryInfo`/`RepositoryIdentity` gain **no** credential field; there is **no new capability**. Authentication
> is orthogonal to governance — the existing HIGH/CRITICAL approval gates in front of push/PR/merge/cleanup are
> untouched. A pre-mutation auth/mint failure is **Blocked** ("did not happen"); a failure at/after a mutation is
> **Unverified** (never "did not happen").

### Decision
- **Q1 — New adapter-local auth component (`@quoky/github-app-auth`).** A new package (new `@quoky` npm scope,
  coexisting with `@chunsik/*`; directory `packages/github-app-auth/`) holds the App private key and mints tokens:
  `GitHubAppAuth.resolveInstallationId(owner,repo)` + `tokenForInstallation(installationId, scope?)`. App JWT is
  **RS256 via built-in `node:crypto`**; bounded single-request `fetch`; **no octokit/gh/curl/extra SDK** (ADR-0053
  preserved). It depends only on Node built-ins + `@chunsik/core` types. Function-neutral class names carry no
  product name and are kept as chosen.
- **Q2 — CAP-010 auth-source swap (the only RepositoryHosting-adapter edit).** `GitHubHostingConfig.token` becomes
  `auth: { kind:'github-app'; tokenSource: () => Promise<string> } | { kind:'pat'; token }`; `request()` reads the
  Bearer value from `await currentToken()`. **Everything else in `GitHubRepositoryHostingProvider` is unchanged**
  (fixed `https://api.github.com`, bounded fetch, sanitized `statusError` — no token/body echo, the exact
  POST-pulls / PUT-merge / DELETE-git-refs mutation set, reads, path-safety). The adapter never sees a JWT or
  installation — it receives an opaque bearer string.
- **Q3 — CAP-002 git credential (composition-root decorator + one-shot GIT_ASKPASS).** A composition-root
  `GitHubAppGitProvider` **decorator** implements the `GitProvider` port by wrapping an **unchanged**
  `LocalGitProvider`. Local ops delegate directly; the three remote-touching ops (`pushApprovedCommit` /
  `getRemoteRefCommit` (`ls-remote`) / `syncMainFastForward` (`fetch`)) **mint the token async first**, then build a
  **one-shot `GIT_ASKPASS`** runner: a unique per-invocation temp helper (`mkdtemp`, mode 0700, containing **no
  token literal** — it echoes `$GIT_APP_TOKEN` from the **child** process env), a fresh `childEnv`
  (`GIT_ASKPASS`, `GIT_APP_TOKEN`, `GIT_TERMINAL_PROMPT=0`) passed to a single `spawnSync`, with the temp helper
  removed in a `finally`. **PROHIBITED as defaults (RC1):** token in argv, `git -c http.extraHeader=…`,
  `https://x-access-token:<token>@…` remote URL, `.git/config` write, any persistent credential-helper write.
- **Q4 — Boundary (RC2).** The `GitProvider` port is **not** amended; `LocalGitProvider` is **byte-for-byte
  unchanged** (the async mint happens in the decorator before the sync spawn, so git-local never mints/reads/
  forwards a token or a remote URL); core never sees a credential; `RepositoryInfo`/`RepositoryIdentity` get no
  credential field.
- **Q5 — Concurrency + leakage (RC3).** Credential state is per-invocation: a fresh `childEnv` (the parent
  `process.env` is **never** mutated) + a unique temp helper dir → concurrent GitHub-mutating executions are
  isolated; cleanup is guaranteed in a `finally` on success, Blocked, and thrown exception; child-env/token are
  never logged (`sanitizeGitStderr` remains the stderr backstop). v1 need not block concurrency; if per-invocation
  isolation cannot be guaranteed on the target platform, v1 MAY serialize GitHub-mutating executions — stated
  explicitly, without overclaiming product-wide concurrency.
- **Q6 — installation_id resolution.** `GET /repos/{owner}/{repo}/installation` (App JWT); `200`→`id`, `404`→`null`
  ("not installed" fail-safe), else sanitized error. In-memory cache keyed by `owner/repo`; **no persisted mapping**
  (deferred to multi-project/team). `owner`/`repo` are the reviewed identity (ADR-0051), never a chat-supplied id.
- **Q7 — Token minting + in-memory cache.** `POST /app/installations/{installationId}/access_tokens` (App JWT);
  parse `token`+`expires_at` only; **short-lived (~1h)**; in-memory cache with a refresh buffer; minted **lazily at
  execution** (never eagerly at boot); **never persisted/logged/returned**. Per-execution **down-scoping**
  (`repository_ids` + minimal `permissions: contents:write, pull_requests:write`) where GitHub allows. One mint
  serves both surfaces (REST + git) within its life.
- **Q8 — Config + fail-safe + auth-mode selection.** New env (read only in `apps/chunsik/src/config.ts`):
  `QUOKY_GITHUB_APP_ID` / `QUOKY_GITHUB_APP_PRIVATE_KEY(_PATH)` / `QUOKY_GITHUB_APP_INSTALLATION_ID` (optional) /
  `QUOKY_GITHUB_OWNER` / `QUOKY_GITHUB_REPO` / `QUOKY_RUNTIME_ENV`. **prod:** App-only; **PAT-only rejected**;
  **App+PAT rejected as ambiguous** → not-configured (fail-safe, sanitized warning). **dev:** App precedence, PAT
  fallback. Not-configured / incomplete App config / not-installed / **pre-mutation mint failure → Blocked**; a
  mint/refresh failure at/after a call → **Unverified**. The private key enters only the App-auth config at the
  composition root — never core/runtime/anchor/logs. `ConversationRuntime` still receives `manager | undefined`,
  never a token.
- **Q9 — Naming boundary (CA correction).** New artifacts use **Quoky** (`@quoky/github-app-auth`,
  `QUOKY_GITHUB_APP_*`, `QUOKY_GITHUB_OWNER/REPO`, `QUOKY_RUNTIME_ENV`). Existing legacy identifiers are **kept**:
  `@chunsik/*` packages, `apps/chunsik`, `CHUNSIK_*` env (`CHUNSIK_GITHUB_OWNER/REPO` = legacy owner/repo fallback;
  **`CHUNSIK_GITHUB_TOKEN` = dev-only PAT fallback**), `ChunsikConfig`, class/type/state/CAP/ADR identifiers. No
  repo-wide `ChunsikBot → Quoky` doc substitution. **Bulk migration is deferred to Sprint 4c — Quoky Naming
  Migration Plan** (plan-only, not started).
- **Q10 — HTTPS precondition.** App-token git auth requires the target remote to resolve to an
  `https://github.com/…` URL (so git prompts via askpass); **SSH remotes are blocked for App-auth push** (they would
  use ambient keys). A required UAT preflight verifies HTTPS.
- **Q11 — Discord boundary.** Discord stays a **credential-free transport** — never receives/stores/logs the App
  private key, an installation token, a PAT, or an App JWT; never accepts a secret pasted into chat; never selects
  repositories as an API permission boundary. It may only carry intent, show approval / not-configured / not-
  installed messages, and optionally provide a GitHub App install link.
- **Q12 — UAT re-entry (gated; not executed).** UAT re-enters on the GitHub App model (Sprint 4a §14: `quoky-dev`
  App on `jonghyungJeon-private/quoky-uat-sandbox` only, least-privilege set, secret-free evidence, App-token git
  push preflight). It runs **only after** this ADR is ratified, Sprint 4b is implemented + typecheck-clean + green
  on Node 22 + PR'd + CA-implementation-reviewed + merged, **and** CA explicitly says "App-auth UAT approved,
  proceed." The PAT-based Sprint 3o smoke test does **not** resume as-is.

### Consequences
- **+** Product-representative auth: short-lived, per-repo-scoped installation tokens instead of a hand-injected,
  terminal-ambient PAT; both GitHub surfaces (REST + git) authenticate from one adapter-local minting source.
- **+** Tiny blast radius — the adapter-local credential boundary (ADR-0051/0053/0054) means the swap is invisible
  to `@chunsik/core`: the `GitProvider`/`RepositoryHostingProvider` ports, the managers, the runtime, the domain,
  and `LocalGitProvider` are all unchanged. Establishes the Team-Edition multi-installation seam.
- **−** One new durable secret (the App private key) to manage; a new adapter package + an adapter-local minting
  component (JWT sign + token exchange + in-memory cache) + a composition-root git-credential decorator; the UAT
  must re-provision on the App model; concurrency may be conservatively bounded in v1 if isolation is unattainable.
- **Out of scope:** no new capability; no `GitProvider`/`RepositoryHostingProvider` port change; no domain/manager/
  runtime contract change; no production GitHub App secret creation/configuration without explicit CA approval; no
  broad naming migration and no Sprint 4c start; no UAT execution; no deploy/release/tag; GitHub Enterprise deferred
  (github.com only, ADR-0053).

### Relations
Extends **ADR-0051** (reviewed `RepositoryIdentity`, no token/URL — kept pure; adds a non-secret installation
resolution alongside), **ADR-0053/0054** (adapter-local credential boundary + built-in `fetch`/sanitized errors —
the reason the swap needs no Core change), and reuses **ADR-0057/0060** (the REST mutations now Bearer'd by the
minted token). Documents the **ADR-0023/0048** git boundary (git push/clone credential supplied ephemerally
*outside* git-local; the port is **not** amended, `RepositoryInfo` still exposes no remote URL). Naming boundary per
the CA Sprint 4b correction; bulk rename deferred to a future **Sprint 4c**. Plans:
`docs/plans/sprint-4a-github-app-authentication-architecture-plan.md` (accepted baseline),
`docs/plans/sprint-4b-github-app-authentication-implementation-plan.md` (accepted implementation plan).

## ADR-0062 — Preview Intent Routing Fix (deterministic preview intent into the existing CodeChangePreview pipeline; negation-aware pre-classification gates)

- **Status:** ✅ **Accepted** (Sprint 4c-Follow-up). Ratified by the Chief Architect via the follow-up plan
  approval (APPROVED 2026-07-09) and the implementation-plan approval (APPROVED 2026-07-09) under the approved
  scope below; subject to the standard CA implementation-PR review before merge.
- **Date:** 2026-07-09
- **Scope:** Fix the product/runtime command-UX / intent-routing gap that BLOCKED Gate 4B Scenario C. It is **not** a
  GitHub App auth failure — the App happy path (installation resolution / token mint / push / PR) was never reached.
  Two confirmed root causes: (A) the pre-classification mutation gates matched commit/push/apply/PR/**test** tokens
  regardless of **negation**, so "do not commit / do not push / 테스트 실행하지 마" hijacked routing; (B) there was
  **no preview entry point** — a preview is only a byproduct of `IMPLEMENT_CODE`. Authoritative design:
  `docs/plans/sprint-4c-followup-preview-intent-routing-fix-plan.md` and `…-implementation-plan.md` (both CA-approved).

### Most important rule
> The fix changes **only** intent RECOGNITION/ROUTING. It **relaxes no approval boundary** and adds **no
> automation**: the shipped lifecycle `CodeChangePreview → WORKSPACE_APPLIED → COMMIT_APPROVAL → GIT_COMMITTED →
> PUSH_APPROVAL_PENDING → PUSH_APPROVED → GIT_PUSHED → PR_CREATED` is unchanged, each remote step still separately
> approved. A preview-only request KEEPS the existing HIGH-risk plan approval before AI patch generation (7a); it
> never applies/commits/pushes/PRs. **No GitHub App auth / token-flow code is touched (ADR-0061 preserved).**

### Decision
- **FIX-1 (deterministic PREVIEW intent).** `IntentClassifier` recognizes an explicit preview request (KO+EN
  `PREVIEW_WORDS` — "변경 미리보기", "코드 변경 미리보기", "patch/diff preview", "preview only", "파일 변경안", … —
  plus an explicit `/preview <request>` command) and routes it to `IntentType.IMPLEMENT_CODE` /
  `Capability.CODE_IMPLEMENTATION` with `raw.kind:'preview'`. This reuses the EXISTING `planningOnly` → HIGH-risk
  plan approval → `runCodeGenerationPreview` pipeline and stops at the read-only `ELIGIBLE` diff preview. No new
  anchor status, no new lifecycle state. **7a selected; 7b (AI generation without the plan approval) is DEFERRED /
  NOT APPROVED.**
- **FIX-2 (negation-aware gates).** A shared, deterministic, clause-scoped `isNegated()` / `unnegatedMatch()`
  (new module `packages/core/src/application/intent-negation.ts`) makes the pre-classification gates count a token
  only when it is NOT under an explicit negation in the same clause. Applied to `interpretCommitIntent`,
  `interpretCommitExecutionIntent`, `interpretPushIntent`, `interpretPushExecutionIntent`, `interpretApplyIntent`,
  `interpretPatchIntent`, `interpretFinalApplyIntent`, `interpretPrIntent`, `interpretPostApplyValidationIntent`,
  **and `IntentClassifier.detectTestRun`** (the last was directly implicated — the bot ran `pnpm test` despite
  "테스트 실행하지 마"). Negation only REMOVES a trigger; it never creates a positive intent. Non-negated behavior
  is unchanged (ADR-0033 test execution, the commit/push/apply/PR gates all behave exactly as before).
- **FIX-3 (anchor-independent commit-gate precedence).** OPTIONAL / constrained — not required after FIX-1+FIX-2;
  the full test matrix passes without it, so it was NOT implemented this slice. (Any future change here must not
  weaken a boundary or remove the safe "no applied change to commit" reply.)

### Consequences
- **+** A "patch/diff preview only" request now reaches preview generation; negated prohibitions no longer hijack
  routing; the exact Gate 4B failure is fixed at both root causes.
- **+** Tiny, contained blast radius: one new pure util module + recognition-only edits to `intent-classifier.ts`
  and the static matchers in `conversation-runtime.ts`. No port/domain/manager/lifecycle/App-auth change.
- **−** One more deterministic layer to maintain (KO/EN negation markers + clause splitting); it deliberately does
  NOT resolve contrastive "A 말고 B" forms (out of scope). Routing stays deterministic (no AI in routing).
- **Validation:** Node 22 `typecheck` exit 0; `pnpm test` 51 files / 1131 tests green (49/1098 baseline preserved +
  33 new covering preview routing, negated commit/push/apply/PR, negated TEST_EXECUTION, and unchanged genuine paths).

### Relations
Extends **ADR-0038** (AI Code Generation Preview) / **ADR-0040** (Explicit Preview Apply Approval); makes the
**ADR-0045** (commit) / **ADR-0047** (push) approval-word matchers and **ADR-0033** (Live Test Execution,
`detectTestRun`) / **ADR-0043** (Post-Apply Validation) negation-aware. Does **NOT** touch **ADR-0061** (GitHub App
Authentication) — no App-auth/token-flow change. Plans:
`docs/plans/sprint-4c-followup-preview-intent-routing-fix-plan.md` (investigation + approved scope),
`docs/plans/sprint-4c-followup-preview-intent-routing-fix-implementation-plan.md` (implementation design).

## ADR-0063 — Provider-Neutral Context Provenance and Current-Fact Precedence

- **Status:** ✅ **Accepted** — ratified by Product Owner and Chief Architect on 2026-07-19. Implementation requires
  separate approval.
- **Date:** 2026-07-19
- **Scope:** Supersedes only the relevant context-shaping portions of **ADR-0017** and **ADR-0018** as stated in
  Relations. It does not change memory persistence, project registration, intent/capability routing, provider
  selection, approvals, execution, storage, or mutation policy.

### Context

PR #52 removed Core-side keyword/regex connection-target interpretation and delegated natural-language meaning to
the selected `GENERAL_CHAT` provider. A Live UAT then received the ambiguous current-connection question through
Discord and produced the prior project-target answer from an `ollama-cli` run. The served artifact contained the
new Quoky prompt and no connection-target resolver.

The failed Session contained both an active-project summary and earlier Assistant-generated copies of the same
incorrect answer. Under ADR-0017, ContextBuilder flattens the most recent same-Session User and Assistant memories
to `role: text` strings. Under ADR-0018, the active project's memory summary is included in later chat. PromptComposer
currently places the platform fact, project background, and flattened transcript in one context layer. Role is
visible, but source provenance and epistemic authority are not preserved as separate concepts. Consequently, a
Provider can treat earlier generated Assistant text or project-memory content as current system evidence.

The required invariant is:

> AI decides meaning. Core decides authority, provenance, and facts.

Quoky remains an AI Assistant rather than a command bot. Core must provide a clear provider-neutral context contract
without deciding semantic targets from phrases, adding a second AI call, or deleting contaminated history.

### Decision

#### 1. Separate provenance from epistemic status

Context supplied to a Provider MUST preserve two independent axes. Implementations may refine type names, but MUST
NOT collapse these axes into one field.

**Source / provenance** identifies where content came from:

- **Core Runtime** — data established by the current application turn;
- **User** — User-authored message content;
- **Assistant** — earlier AI-generated response content;
- **Project Memory** — stored active-project summary/background.

**Epistemic status / authority** identifies how the Provider may rely on it:

- **authoritative current fact** — a fact Core can establish for the current turn;
- **user-provided claim or intent input** — authoritative as the User's request/claim, not as external truth;
- **assistant-generated non-authoritative content** — continuity material that may be inaccurate;
- **non-authoritative background** — contextual material that does not establish the current request target or
  external truth.

User input is never promoted to an authoritative system fact merely because the User stated it. Assistant output
never becomes authoritative merely because it was persisted as SHORT_TERM memory. Project memory never becomes
authoritative merely because its project is active.

Chunsik Memory remains the source of record for what was stored and for the provenance attached to each record.
That authority covers the record's existence and origin; it does not establish the external truth of a stored User
claim, Assistant output, or project summary. Record provenance and content-level epistemic truth remain distinct.

#### 2. Give current-turn facts one owner

`Session.activeProjectId` remains the source of the mutable active-project selection that persists across turns.
When a Task is created, `Task.projectId` captures that selection as the immutable project reference for the current
turn. The **Task** is the single source of current-turn facts used during prompt composition:

- `Task.context.platform` owns the inbound conversation-platform value;
- the existence of `Task.projectId` reflects the active-project selection captured for that Task;
- reaching PromptComposer through the normal Runtime path establishes that the inbound message was accepted by the
  Runtime for processing;
- response generation occurs before outbound delivery success can be established.

ContextBuilder MUST NOT duplicate these current-turn facts into ContextBundle. It owns only:

- bounded, ordered conversation history with preserved role/provenance;
- active-project memory rendered as non-authoritative background.

PromptComposer combines Task and ContextBundle. It derives and renders the current-facts section from Task, then
renders background and transcript sections from ContextBundle. Task and ContextBundle MUST NOT store parallel
copies of the same current-turn fact.

#### 3. Bound authoritative facts narrowly

Core MAY present the following as authoritative current-turn facts:

- the current request was received through the conversation platform named by `Task.context.platform`;
- the inbound message was accepted by the Runtime for the current turn;
- outbound response delivery success is not yet known at response-generation time;
- an active project id is selected for the Task when `Task.projectId` exists.

Core MUST NOT present the following as authoritative facts without separate verified evidence:

- overall Discord Gateway or transport health;
- the health or actual connection state of any external service;
- successful outbound response delivery before delivery occurs;
- the truth of project-memory summary content;
- the truth of any earlier Assistant response;
- a semantic target inferred from keywords, regexes, language-specific phrases, provider id, concrete platform
  value, or project name.

The platform fact proves how the current inbound request reached Quoky; it does not prove global transport health.
The active-project-id fact proves selection state; it does not prove project-summary correctness or make the project
the implicit target of the User's question.

#### 4. Keep active-project selection separate from project background

The active-project concepts are split as follows:

- **`Session.activeProjectId`** — mutable active-project selection owned by Session across turns;
- **`Task.projectId`** — immutable current-turn snapshot captured from `Session.activeProjectId` when the Task is
  created and used as the authoritative selection fact for prompt composition;
- **project memory/summary content** — Project Memory provenance with non-authoritative-background status, assembled
  by ContextBuilder;
- **request target** — natural-language meaning decided by the selected `GENERAL_CHAT` Provider.

ContextBundle does not duplicate `Task.projectId` or an equivalent current-turn selection fact. PromptComposer
combines the Task-owned snapshot with ContextBuilder's project background while preserving their distinct authority
and meaning.

Project background remains available for legitimate project-aware conversation. Core MUST NOT condition its
inclusion on phrase matching, and the existence of an active project MUST NOT by itself identify the current User
question's target.

#### 5. Preserve conversation history with role and provenance

ContextBuilder continues to retrieve the most recent same-Session SHORT_TERM records under ADR-0017's existing
bounds, ordering, truncation, current-inbound exclusion, and pruning policy. It MUST preserve User/Assistant role and
provenance in structured context until PromptComposer renders it.

Assistant turns remain available for continuity, including follow-ups that refer to the preceding answer. They are
rendered as Assistant-generated, non-authoritative transcript entries that may be inaccurate. They are not deleted,
rewritten, hidden through sentence matching, or moved to a special clean Session. Missing or malformed legacy role
metadata fails safe as non-authoritative transcript content, never as an authoritative current fact.

#### 6. Render explicit provider-neutral precedence

PromptComposer renders the following conceptual sections in this order:

1. **Current-turn facts supplied by Core** — derived from Task;
2. **Background resources** — including active-project memory, explicitly non-authoritative for target selection;
3. **Conversation transcript** — continuity material with User/Assistant provenance and epistemic labels;
4. **Current User task** — the existing final Task layer.

The `GENERAL_CHAT` developer contract instructs every provider that:

- the current User task is interpreted naturally using the whole conversation;
- current Core facts outrank contradictory Assistant-generated history;
- User messages are intent/claim input, not automatically verified external facts;
- Assistant history supports continuity but is not evidence of current state;
- active-project background is not an implicit target merely because it exists;
- a short clarification is requested only when meaning remains genuinely uncertain;
- external status absent from current Core facts is not invented.

These are provenance and precedence rules, not semantic resolution rules. No specific natural-language sentence,
language, provider, project name, or transport name is part of the decision logic.

#### 7. Keep one Provider call and existing governance

Natural-language interpretation and final response generation remain one selected `GENERAL_CHAT` provider call.
This ADR adds no semantic classifier, target enum/parser, confidence service, additional AI call, provider-id branch,
or concrete transport branch.

The decision does not change IntentClassifier, IntentResolver, CapabilityRouter, approval/risk policy, execution
requests, workspace access, storage schema, Session identity, memory contents, or Runtime mutation boundaries.

### Consequences

- **+** Current facts, User claims, Assistant output, and project background have explicit, independent provenance
  and epistemic status.
- **+** Contaminated Assistant history remains usable for continuity without being promoted to current evidence.
- **+** Active-project context remains available without becoming an implicit semantic target.
- **+** The contract is deterministic and provider-neutral while meaning interpretation stays with the selected AI.
- **+** No extra Provider call, memory cleanup, Session reset, storage migration, or routing change is required.
- **−** `ContextBundle` and related fixtures must evolve from flattened strings to structured conversation turns.
- **−** Prompt wording and structure affect all `GENERAL_CHAT` providers and require contract, regression, and Live
  UAT coverage.
- **−** A structurally stronger prompt still cannot guarantee that every model follows the contract; Provider
  behavior remains a separately verified UAT concern.
- **Risk:** Over-isolating Assistant history could degrade ordinary follow-ups. Tests must prove the content remains
  present, ordered, bounded, and usable.
- **Risk:** Treating `authoritative` too broadly could create false claims. Only the fact boundary above is allowed.

### V1 / V2

**V1 target — after ratification and separately approved implementation:**

- provider-neutral structured history entries with separate provenance and epistemic status;
- Task-owned current-turn facts;
- ContextBuilder-owned history and project background;
- PromptComposer-owned sectioning and precedence;
- one existing `GENERAL_CHAT` Provider call;
- deterministic contract/application-flow tests plus separately approved Live UAT.

**V2+ [LATER]:** semantic retrieval/ranking, summarized memory, confidence models, or richer factual verification.
None is introduced by this ADR. A future feature that changes routing or adds AI calls requires its own ADR.

### Supersession and Relations

- **ADR-0017 is superseded only in this respect:** recent conversation is no longer flattened to unqualified
  `role: text` strings before prompt composition. Existing same-Session retrieval, N=10 bound, oldest-to-newest
  ordering, 400-character truncation, current-inbound exclusion, storage, and pruning decisions remain in force.
- **ADR-0018 is superseded only in this respect:** `Session.activeProjectId` continues to own mutable selection across
  turns, while `Task.projectId` is the immutable current-turn snapshot used during prompt composition; PROJECT
  memory/summary is non-authoritative background, and active-project existence does not establish the current request
  target. Project registration, scanning, persistence, workspace gating, and read-only behavior remain in force.
- Extends **ADR-0002** (ContextBuilder assembles structured per-run context) and **ADR-0003** (PromptComposer owns
  provider-neutral layered prompt authorship).
- Preserves `ARCHITECTURE.md` provider rules: Core does not know Ollama/Discord as concrete implementations, does
  not branch on provider id, and does not pin providers to Session/Task/Actor.

### Approval Boundary

This Accepted ADR records the ratified Architecture decision only. Ratification does not authorize production/test
implementation, Build/Test, Merge, Runtime/Discord/AI execution, DB/session/memory mutation, Live UAT, Cleanup, or
Gate 6. Each requires separate explicit approval.

## ADR-0064 — Provider Routing Policy and Registry Ownership

- **Status:** ✅ Accepted — Stage 2B routing architecture and offline implementation are complete under Chief
  Architect direction. The later offline closeout checkpoint records the full accepted surface and blocked
  carryover; real app activation and actual external Provider execution still require later approval.
- **Date:** 2026-08-02
- **Scope:** Core Application routing contracts, immutable descriptor and executable-binding registries, typed
  policy evaluation, deterministic selection decisions, immutable executable-binding and validation-profile
  registries, pure response validation, explicit bounded branch planning, bounded two-attempt Gateway
  orchestration, bounded output/audit contracts, configuration identity, and the offline TaskRun-backed
  `GENERAL_CHAT` Runtime integration seam. No concrete Provider routing configuration, composition-root activation,
  or external Provider execution.

### Context

Stage 2A completed Provider Evaluation Infrastructure and established evidence-backed role candidates, but did not
ratify Production routing. The existing Runtime uses `CapabilityRouter.select(capability)`, filters by
`isAvailable()`, sorts provider-advertised numeric priorities, returns one `AiProvider`, and lets callers invoke it
directly. That contract cannot represent bounded request signals, separate eligibility from ranking, explain why a
policy matched, or later own explicit fallback/escalation without duplicating orchestration.

Stage 2B must remain provider-independent. It must not encode two current model candidates as an architecture
primitive, read Stage 2A scorecards at Runtime, add model-specific conditions to `CapabilityRouter`, or move policy
into infrastructure adapters.

### Decision

Provider Routing is a **Core Application policy service**, not a new Capability or Aggregate. Slice 1 implements the
pure calculation boundary:

```text
RoutingContext
+ immutable ProviderRegistrySnapshot
+ typed RoutingPolicyConfiguration
→ ProviderSelectionDecision
```

The initial policy model is bounded TypeScript enums, branded identifiers, and readonly declarative configuration.
There is no generic DSL/YAML loader, executable policy callback, weighted dynamic score, Runtime evidence lookup,
or concrete Provider/model branch.

### Routing Boundary

Intent classification continues to own `Intent` and `Capability`. Slice 5A constructs bounded `RoutingContext`
signals from existing Runtime facts for only TaskRun-backed `GENERAL_CHAT` and consumes the resulting decision
through the existing Planner and Gateway. Routing policy does not classify natural language, compose prompts,
invoke Providers, validate responses, mutate Task/Session state, or surface Provider identity to the user.

Slice 1 contains no `AiProvider` executable binding. Descriptor registration and selection computation are kept
separate so implementing the foundation cannot accidentally cross the invocation boundary.

### Provider Registry Ownership

Concrete adapter construction, model binding, and registry configuration belong to the composition root. Core
Application owns validation and the immutable descriptor snapshot. Provider adapters advertise execution behavior
but own no selection rule.

Registry construction fails fast on an empty registry, duplicate or malformed provider identity,
descriptor/registration mismatch, invalid adapter/model binding, invalid enum/profile version/evidence digest, and
duplicate capability/profile entries. Registrations and semantically unordered descriptor arrays are normalized to
stable order. Lookup and enabled-provider enumeration return frozen descriptors.

Runtime availability is a bounded snapshot signal (`AVAILABLE | UNAVAILABLE | UNKNOWN`). It affects eligibility but
is deliberately excluded from configuration identity. Availability is not probed in Slice 1.

### Eligibility / Ranking Separation

Evaluation order is fixed:

```text
predicate match → eligibility/exclusion → deterministic ranking → terminal decision
```

Disabled, unavailable/unknown, capability-incompatible, locality/tool/structured-output/context-incompatible,
below-minimum-reliability, required-class-missing, or excluded-class Providers are ineligible and never reach
ranking.

Ranking is lexicographic, never a combined weighted score. A policy may order these dimensions:

1. routing-class preference (configured list; lower index wins);
2. reliability tier (`HIGH > STANDARD > LOW > UNPROVEN`);
3. latency tier (`FAST < BALANCED < SLOW < UNKNOWN`);
4. cost tier (`LOW < STANDARD < HIGH < UNKNOWN`);
5. stable provider-id ascending tie-break, always applied last.

Policy precedence descending and policy-id ascending determine a matching policy deterministically. Identical
context, registry snapshot, and policy configuration must return an identical decision regardless of Provider
registration or object insertion order.

### Provider Descriptor and Capability Profile

`ProviderDescriptor` contains branded provider/adapter ids, an opaque audit/configuration `modelId`, bounded
Capability and Operational Profiles, enabled state, profile version, and optional SHA-256 evidence binding.

Capability Profiles use bounded tiers for semantic/authority/continuity reliability, tool use, structured output,
context capacity, streaming, execution locality, and routing class (`BALANCED | SEMANTIC_HIGH |
LATENCY_RESTRICTED | DEPRIORITIZED`). Operational Profiles use bounded latency, timeout, cost, concurrency, and
availability classes. Raw Stage 2A scores are not Runtime fields and do not participate in selection.

`modelId` remains opaque: Core validates its bounded representation and configuration identity but never interprets
or compares model-tag contents in policy logic.

### Configuration / Digest

Registry and policy identities are SHA-256 over explicit canonical JSON shapes. Semantically unordered arrays and
Provider/policy registration order are normalized; ranking order remains significant. Digests exclude timestamps,
environment, transient availability, prompts, responses, and executable state. The decision contains a combined
SHA-256 of the registry and policy digests plus the registry/policy versions.

The Core FNV `contentHash()` is not used for routing configuration identity.

### Retry / Fallback Ownership

The ratified ownership is:

```text
Adapter hidden retry = 0
Same-provider retry = 0
Fallback / escalation = future ProviderRoutingGateway policy
```

Slice 1 implements none of retry, fallback, escalation, attempt budgets, deadlines, or Provider loops. Any future
Gateway must make these behaviors explicit and bounded rather than hiding them inside adapters.

### Runtime Validation Boundary

Provider selection and response validation are separate responsibilities. Slice 1 stops at
`ProviderSelectionDecision` and has no response or invocation type. Stage 2A Evaluator v4 remains an offline
benchmark tool and is not imported as a Runtime gate. A future Runtime validator requires its own approved slice.

### Observability Boundary

The Slice 1 decision exposes only bounded facts: selected Provider id or null, sorted eligible ids, matched policy
id or null, bounded reason code, policy/registry versions, and combined configuration digest. It contains no prompt,
transcript, response, reasoning, fallback chain, attempt, latency, raw error, credential, or environment value.
Slice 5A persists a bounded wrapper plus Gateway audit under TaskRun metadata `routingAudit` for every terminal
outcome. Only an accepted output records its actual executable identity in `TaskRun.providerId`; no schema migration
or new persistence owner is introduced.

### Architecture Invariants

- Application policy source contains no concrete model tag, executable, or concrete Provider implementation.
- Provider adapters do not own selection policy.
- Provider Registry snapshots and returned decisions are immutable.
- Identical context, registry snapshot, and policy return the same selection result.
- An eligibility failure can never enter ranking.
- Registry and policy configuration fail fast at construction for invalid bounded configuration.
- Decisions are explainable through bounded reason codes and configuration identities, never free-form reasoning.
- Runtime routing never reads Stage 2A Benchmark scores or Golden Corpus evidence directly.
- Slice 1 never invokes an `AiProvider` and does not integrate with Runtime or Code Generation.

### Consequences

- **+** New Provider bindings can be added through adapter/composition configuration without changing policy-engine
  logic.
- **+** Eligibility, ranking, policy match, terminal absence, and configuration identity are deterministic and
  provider-free testable.
- **+** Static profiles preserve reviewed Stage 2A provenance without coupling Runtime to mutable evidence.
- **+** No Aggregate, database schema, persistence owner, prompt, Provider adapter, or Runtime flow changes.
- **−** Descriptor capability data and the legacy `AiProvider.capabilities` contract coexist until Runtime migration
  establishes one authoritative binding path.
- **−** Slice 1 computes decisions but does not yet improve Production invocation behavior.
- **Risk:** Static profile evidence can drift. Profile version and optional evidence-binding digest require explicit
  review when refreshed; evidence is never auto-imported.
- **Risk:** Misconfigured rules can produce no eligible Provider. Construction validation plus explicit
  `NO_ELIGIBLE_PROVIDER`/`POLICY_NOT_MATCHED` decisions make that state visible and fail closed.

### Rejected Alternatives

- **Static Primary + Fallback:** hard-codes the current two-candidate topology and does not scale by descriptors.
- **Dynamic Score-based Router:** introduces score drift, weak replayability, and opaque weighted decisions.
- **Runtime Benchmark Evidence Lookup:** couples Production to offline scorecards/Golden Corpus and mutable files.
- **Provider Adapter-owned Routing:** reverses ownership; infrastructure must not select itself.
- **Model-specific conditions in `CapabilityRouter`:** violate the Core provider-id/model independence invariant.
- **Generic DSL/YAML engine:** adds schema/parser/hot-reload complexity before an operational need exists.

### Implementation Slices

1. **Slice 1 — complete here:** routing contracts, immutable descriptor registry, typed policy validation,
   eligibility/exclusion, deterministic ranking, terminal decisions, SHA-256 identity, provider-free fixtures.
2. **Slice 2 — complete here:** immutable execution plan, executable binding registry, isolated single-attempt
   gateway, and bounded audit; no Runtime integration.
3. **Slice 3A — complete here:** validation/failure/profile contracts, pure response validator, bounded output,
   and explicit branch planning only; no fallback or escalation execution.
4. **Slice 3B — complete here:** two-attempt Gateway orchestration and ownership enforcement.
5. **Slice 3C — complete here:** private deterministic Planner/Gateway/Validator replay harness; no production
   dependency or external Provider execution.
6. **Slice 4 — complete here:** provider-free selection simulation and Golden routing decisions; stops before
   execution planning.
7. **Slice 5A — complete here:** offline Core Runtime integration seam for TaskRun-backed `GENERAL_CHAT`, fake
   configuration/Providers, existing lifecycle mapping, and bounded TaskRun audit; no app activation.
8. **Slice 5B+ — Strict approval:** real descriptor/policy/binding composition, Provider preflight/UAT, external
   Provider execution, and any Runtime/Discord action.

### Slice 2 — Selection / Execution Separation

Slice 2 extends the calculation boundary without wiring it into a product Runtime:

```text
ProviderSelectionDecision
→ ProviderExecutionPlan
→ ProviderRoutingGateway
→ AiProvider.execute() (one bound Provider, one attempt)
```

`ProviderExecutionPlanner` converts only a selected decision into an immutable plan. The plan records a
one-element execution order, fixed attempt budget `1`, capability, validation-profile identifier, matched-policy
and selection configuration identity plus an immutable executable-binding identity, while fixing overall deadline
to `null` and fallback/escalation eligibility to `false`. Plan creation requires the Decision, the validated
descriptor snapshot, and a binding registry validated against that same snapshot. Invalid decision identity,
capability/profile data, version, digest, snapshot identity, selected/eligible relationship, availability, or
binding provenance fails before execution.

`ProviderBindingRegistry` is an immutable Core Application binding boundary constructed from a
`ProviderRegistrySnapshot` plus executable bindings. It rejects unknown or disabled descriptors, duplicate
bindings, Provider-id mismatch, and adapter/model mismatch. Each accepted binding receives a canonical SHA-256
identity over Provider, adapter, model, binding-version, and descriptor-profile-version configuration. Availability,
timestamps, execution results, latency, environment, secrets, and raw errors are excluded. Concrete binding and
application wiring remain composition-root responsibilities; Slice 2 adds no Runtime binding.

`ProviderRoutingGateway` accepts an explicit plan and request, revalidates the single-attempt boundary, capability,
selection/registry identity, current binding identity, and executable Provider id, then calls
`AiProvider.execute()` once. Missing or mismatched provenance returns a bounded pre-invocation failure with attempt
count `0`. It performs no availability probe, retry, fallback, escalation, alternate-provider call,
timeout/deadline policy, or response validation.

The gateway returns a discriminated success/failure result and a bounded audit containing configuration identity,
selected Provider id, attempt count, status, and bounded failure kind only. It never copies a prompt, response,
transcript, raw error text, credential, reasoning, or environment value into the audit. Known `AiProviderError`
failure kinds are preserved; unknown failures become `EXECUTION_FAILED`. Tests use fake Providers only. There is no
ConversationRuntime, CodeGenerationManager, app, adapter, storage, or database integration, and no actual external
Provider execution. Multi-provider orchestration remains Slice 3+.

### Slice 2 Binding Provenance Remediation

The Execution Plan carries a frozen `{ providerId, bindingVersion, bindingDigest }` identity. The selection
Decision separately exposes registry, policy, and combined configuration digests so the Planner can recompute and
verify the combined selection identity without adding execution state to selection. Unknown, disabled,
unavailable/ineligible, missing, adapter/model-mismatched, executable-id-mismatched, stale-registry, and stale-binding
paths stop before invocation. Configuration failures use bounded codes and never copy rejected configuration or raw
Provider details into audit. Valid execution remains exactly one attempt.

### Slice 3A — Response Validation and Explicit Branch Planning

Slice 3A adopts Strategy B as a declarative plan only:

```text
Primary + optional Operational Fallback + optional Semantic Escalation
Maximum attempts = 2; maximum additional hops = 1
Primary → Fallback OR Primary → Escalation
```

`ValidationProfileRegistry` contains only `LOW_RISK_FAST_PATH`, `GENERAL_CHAT`, and `AUTHORITY_SENSITIVE`.
Definitions and rules are canonicalized, deep-frozen, and configuration-digested; an unknown profile fails closed
with `UNKNOWN_VALIDATION_PROFILE`. `RuntimeResponseValidator` is an independent Core Application, pure synchronous
service. It consumes the profile fixed upstream and returns only bounded disposition/reason/hash/size/version facts.
It performs no Provider/registry lookup, branch execution, I/O, clock/random access, logging, persistence, Runtime
response assembly, or Stage 2A import. `routing-response-rules-v1` is an independent Runtime contract and makes no
equivalence claim with the Stage 2A evaluator or binding.

The failure matrix distinguishes configuration, operational, validation, and safety failures. Safety and
configuration failures fail closed with no fallback or escalation; operational failures never escalate;
`EMPTY_OUTPUT` may use operational fallback while `OUTPUT_LIMIT_VIOLATION` may not; validation failures never
fallback and may escalate only when the fixed profile permits it. Producer ownership remains deferred:
`PROVIDER_SPAWN_FAILED` is adapter-producer-pending;
`CONTAINMENT_FAILURE` and `MODEL_DOWNLOAD_DETECTED` are
Runtime-producer-pending; `STRUCTURAL_VALIDATION_FAILED` is future-profile/validator-producer-pending; and
`SEMANTIC_VALIDATION_UNRESOLVED`, `STRUCTURAL_VALIDATION_UNRESOLVED`, and `DEADLINE_EXHAUSTED` are future-Gateway-
orchestration-producer-pending. These are contract reservations, not implemented defenses.

`ProviderExecutionPlan` pre-fixes candidates solely from the ordered `eligibleProviderIds` and the same descriptor
snapshot/binding registry. Target Provider ids are unique and provenance-bound. The escalation target must be
strictly stronger on the profile's existing reliability axis. For an escalation-enabled profile, the stronger
candidate is reserved first and fallback deterministically takes the first remaining executable eligible candidate;
this preserves mutually exclusive target identities without runtime policy reevaluation. Same-provider retry,
primary re-entry, adapter hidden retry, pre-execution escalation, and Provider-id branching remain prohibited.

The execution-configuration digest binds registry/policy/profile digests, failure-matrix version, attempt/hop bounds,
deadline class, capability/profile/policy, and every target purpose/provider/binding digest. It excludes clocks,
durations, concrete deadline milliseconds, request/prompt/response/raw output, environment/secrets, execution id,
and audit schema version. `decisionId` is deterministic selection identity; optional `executionId` is caller-owned.

Slice 3A did not implement the two-attempt Gateway state machine. High-risk pre-execution provider strength remains
Slice 1 selection responsibility through existing authority/risk/profile/reliability policy data.

### Slice 3B — Bounded Two-Attempt Gateway Orchestration

The Gateway is the sole execution owner for `Primary → Validation → Optional Single Hop → Terminal`. A separate
pure state reducer permits at most seven audited transitions and explicitly permits every READY state to terminate
at its zero-attempt deadline checkpoint. An invocation consumes its attempt immediately before provider dispatch;
maximum attempts remain `2`, maximum additional hops remain `1`, and fallback and escalation are mutually exclusive.
There is no retry, same-provider retry, provider availability re-probe, or runtime policy reevaluation.

The Gateway applies a versioned deadline policy using an injected monotonic clock. One absolute deadline covers
Provider execution and validation and is never reset for the optional hop. The effective cooperative Provider
timeout is the smaller of the caller timeout, when supplied, and the remaining Provider budget. Validation success
completed after the overall deadline is retained in bounded audit but never returned as accepted output. Hard
cancellation and `AbortSignal` changes remain outside this slice.

Operational failure may use only the pre-fixed fallback allowed by the failure matrix. Semantic validation may use
only the pre-fixed stronger escalation target when the selected validation profile permits it. Safety takes
precedence, fails closed, and permits neither branch. The v4 failure matrix marks deadline attempt consumption as
contextual because exhaustion can occur before dispatch or after a consumed attempt. The Gateway-produced
`SEMANTIC_VALIDATION_UNRESOLVED` is active; `STRUCTURAL_VALIDATION_UNRESOLVED` remains producer-pending.

Terminal results preserve explicit accepted, rejected, human-review, execution-failure, safety-blocked, and
configuration-failure statuses. `humanReviewRequired` is first-class. Accepted results expose only bounded output;
audit v2 records bounded configuration identities, attempt/transition facts, response identity and size, the
deadline-policy version, and one terminal summary without prompt, raw output/error, credentials, or environment.
`executionId` is mandatory caller-supplied input and remains excluded from deterministic execution digests.

### Slice 4 — Deterministic Routing Selection Simulation

Slice 4 is an independent subtree of the private validation package. Strict, statically registered JSON fixtures
compile bounded `RoutingContext`, Provider descriptors and availability, and typed policy configuration, then run
the real `ProviderRegistry` and `RoutingPolicyEngine`. Replay stops at `ProviderSelectionDecision`; it never creates
an Execution Plan, binding registry, Gateway, validator, Runtime, or Provider executable.

The Harness-owned canonical selection projection contains the bounded decision plus only the configured ranking
dimension and direction vector. It records `matchedPolicyId` but no score, prompt, execution, response, clock, or
Provider-call facts. Fixture schema, fixture compiler, and selection digest versions are independent from the
Slice 3C execution Harness contracts. Golden fixtures pin policy match/absence, eligibility, disabled and
unavailable filtering, no-eligible termination, configured preference and ranking, and a combined authority,
safety-sensitive, and ranking decision. Fresh replay and one fixed order permutation must produce the same exact
decision and digest; stable provider-id ordering remains a Core implementation detail rather than a fixture API.

### Slice 5A — Offline Runtime Integration Seam

`RuntimeProviderRoutingService` is a narrow Core Application collaborator. It accepts only bounded Runtime facts,
an already-rendered provider-agnostic `AiRequest`, and caller-owned TaskRun execution identity, then composes:

```text
static GENERAL_CHAT RoutingContext
→ one immutable availability snapshot
→ ProviderRegistrySnapshot
→ RoutingPolicyEngine
→ ProviderExecutionPlanner
→ ProviderRoutingGateway
→ one bounded terminal result
```

The mapping supports only `Capability.GENERAL_CHAT + IntentType.CHAT + requiresWork=true`, fixes the
`GENERAL_CHAT` validation profile and `STANDARD` deadline class, and performs no natural-language analysis,
Provider/model branching, evidence lookup, clock/random access, or I/O. Each configured executable binding's
`isAvailable()` is called at most once per request; a thrown probe becomes `UNAVAILABLE`, and the Gateway never
re-probes. Construction validates registry/binding/profile identity without invoking a Provider.

`ConversationRuntime` uses the collaborator only when it is explicitly injected and the request is a TaskRun-backed
`GENERAL_CHAT` work turn. After this branch is selected, selection, configuration, validation, safety, or execution
failure is terminal and never falls back to `CapabilityRouter`; no shadow selection or comparison is performed.
Project Analysis, Code Generation, no-work chat, and every other Capability retain their legacy path.

Accepted bounded output persists artifacts, completes the TaskRun with the actual accepted executable id, and then
completes the Task. Human-review-required reuses `TaskStatus.NEEDS_REVIEW`; rejected, safety-blocked,
configuration-failed, and execution-failed reuse the existing failed lifecycle. Every terminal result stores bounded
`routingAudit` metadata; non-accepted runs receive no representative `providerId`. `ResponseComposer` maps only the
terminal category and receives no Provider/model identity, prompt, raw output/error, reasoning, or configuration
digest.

Slice 5A defines only typed configuration boundaries and fake integration tests. It adds no concrete Claude/Ollama
descriptor, policy, binding, or composition-root wiring and performs no Runtime, Discord, network, database, secret,
or external Provider execution. The private validation package remains outside the production import/reference
graph.

### Relations

Extends `ARCHITECTURE.md` Provider Rule 2 and ADR-0029's `ProviderSelector` seam. It does not change ADR-0015
Provider failure handling, ADR-0031 orchestration, ADR-0032 Conversation Runtime, ADR-0063 context provenance,
Stage 2A evidence, or existing concrete Provider execution. Slice 5A adds the optional offline seam while leaving
the production composition root and all legacy out-of-scope paths unchanged; real activation remains separately
approved work.

### Slice 5B-1 — Provider Identity and Static Routing Configuration

Slice 5B-1 makes executable identity instance-specific: `providerId` names one configured executable Provider,
`adapterId` names the adapter family, and opaque `modelId` names its exact model binding. The Ollama adapter accepts
an additive caller-supplied instance id while retaining `ollama-cli` for every legacy constructor call. Production
construction fails closed on duplicate ids or any descriptor/binding/executable identity mismatch.

The composition root owns a typed static, unwired configuration containing only balanced-primary
`ollama-cli:llama3.1:8b` and semantic-candidate `ollama-cli:granite3.3:8b`. Its GENERAL_CHAT policy ranks only the
ordered `BALANCED → SEMANTIC_HIGH` routing class and semantic reliability, followed by the existing stable
provider-id tie-break. Unratified latency, cost, concurrency, and availability profile dimensions remain equal
conservative values and cannot create a ranking advantage.

Each descriptor binds immutable Stage 2A provenance under `stage2b-provider-provenance-v1`. The canonical SHA-256
payload includes the instance/adapter/model/role and the ratified campaign, checker, corpus, digest, counts, and
prompt-root-cause status. It excludes executable path, availability, environment, clock, secrets, and installed
model state; Runtime imports no Stage 2A scorecard, harness, or Golden Corpus data.

The factory performs only pure construction validation. `app.module.ts`, the legacy `AI_PROVIDERS` path, Slice 5A
Runtime integration, Gateway/Planner/Registry/Validator behavior, and persistence remain unchanged. Actual Provider
readiness/model installation are **NOT VERIFIED**. Provider execution requires separately approved Slice 5B-2;
Runtime activation and Runtime/Discord/DB UAT remain Slice 5C approval boundaries.

### Slice 5B-2A-I — Ollama Preflight Contracts and Runner Implementation

Slice 5B-2A-I owns an app-private, unwired, non-persistent preflight boundary. Independent v1 contracts define
absolute-realpath executable identity, exact `--version` and `list` commands, strict loopback-only environment,
fatal UTF-8 version/inventory parsing, exact required model tags, bounded timeout/output/row limits, download-marker
observation, and immutable terminal results. Only VERSION then INVENTORY may run, each at most once; retry and every
generation/mutation argv are structurally prohibited, and `providerExecutionCount` is always zero.

The process runner, not its caller, exclusively constructs and validates the exact child environment. Egress
approval is governed by the explicit Slice 5B-2A-E0 controls below, while the public network class remains null
until loopback endpoint and environment validation succeed.
Every spawned command has a hard promise-settlement deadline beyond timeout and kill grace, including the
exit-without-close case.
Detached process groups, negative-pid termination, and OS-specific process-tree containment remain an explicit
Slice 5B-2A-E review note and are not introduced by this remediation.

Filesystem and process ownership remain injectable app-private seams. Tests use fake implementations only; the
production module is not imported by `app.module.ts`, Runtime, Core, Stage 2A, or the private validation package.
Actual executable/version and installed inventory are **NOT VERIFIED**. Ollama process, local daemon, external
network, inventory access, and Provider generation were **NOT EXECUTED**. Actual version/list execution requires
separately approved Slice 5B-2A-E; generation remains Slice 5B-2B and Runtime/Discord/DB UAT remains Slice 5C.

### Slice 5B-2A-E0 — Honest Egress Contract and Concrete Execution Composition

The boolean external-egress attestation is removed. `OS_DENIED_VERIFIED` is executable only when an injected
independent verifier confirms OS/sandbox denial and therefore projects `externalEgressIsolationVerified=true`.
`CONFIG_RESTRICTED_RISK_ACCEPTED` projects false and records Chief Architect acceptance of exact
binary/digest/size, read-only argv, isolated environment, loopback endpoint, two-command maximum, zero retry, and
zero raw-output persistence; it does not technically deny or prove denial of external egress. This egress control
is independent of `networkClass`, which continues to classify validated endpoint/environment configuration only.

An app-private tools entrypoint requires every executable identity, endpoint, and egress input explicitly, performs
no PATH lookup, composes concrete read-only filesystem, runner-owned sandbox, and injected spawn adapters, and emits
one bounded projection with exit codes PASS=0, FAIL=2, BLOCKED=3, `ENTRYPOINT_CONFIGURATION_ERROR`=4, and
`ENTRYPOINT_UNEXPECTED_FAILURE`=5. Invocation parsing/validation failures use `INVALID_INVOCATION`; unexpected
failures after a valid invocation use `UNEXPECTED_ENTRYPOINT_FAILURE` and do not expose raw error details.

Each invocation makes at most one structured-projection emission attempt. If that write fails, the entrypoint exits
through the unexpected-failure path with code 5 and emits no fallback projection; in particular, it never
misreports a stdout failure as an invalid configuration. The entrypoint is not imported by the composition root.
Actual executable/version/inventory, daemon/network communication, Provider generation, persistence, and DB work
remain unexecuted and require separately approved Slice 5B-2A-E.

For the exact read-only VERSION/INVENTORY scope, the Chief Architect accepts bounded hash-to-spawn TOCTOU,
descendant/process-tree containment, network-class run-level monotonicity, the final-settlement defensive terminate
branch, and loss of detailed environment-rejection failure codes. This acceptance relies on explicit executable
identity, exact non-generation argv, shell disabled, no prompt/secret, loopback configuration, isolated parent-free
environment, at most two commands, and zero retry. A future execution packet must revalidate executable identity
immediately before VERSION, again before INVENTORY, and after terminal completion; any mismatch is terminal and
must not trigger recovery, download, or generation.

### Slice 5B-2B-I — Bounded Primary-Only Provider Generation Harness

The app-private validation composition registers exactly one descriptor and executable binding for
`ollama-cli:llama3.1:8b`, then uses the existing `ProviderRegistry → RoutingPolicyEngine →
ProviderExecutionPlanner → ProviderRoutingGateway` chain. The resulting immutable plan has only its primary;
fallback, escalation, retry, direct adapter invocation, plan mutation, Runtime wiring, and persistence are absent.

The exact fixed probe is identified by SHA-256 rather than projected in full. The validation Ollama instance uses
an approved absolute executable and explicit `127.0.0.1` HTTP endpoint with a runner-owned HOME/TMPDIR and exact
locale/color/cloud environment. Its bounded stream detector requests termination on case-insensitive Ollama pull
markers and retains no marker output. This observes but does not technically prevent bytes transferred before a
marker. `DENIED_VERIFIED` requires an independent successful verifier; the current executable mode is
`PRECHECK_OBSERVE_POSTCHECK_RISK_ACCEPTED`, which requires exact preflight model presence, no observed download,
and an unchanged postflight inventory fingerprint while projecting prevention as false.

Slice 5B-2B-I is implementation and fake validation only. Actual Provider generation, localhost communication,
model inventory execution, model acquisition, external-egress denial, Runtime, Discord, and DB work were not
executed and remain independent approval boundaries.

Targeted review hardening makes validation observations monotonic across every terminal path. Provider invocation
count increments per request to the runner; the first may delegate and every later request fails closed without a
second child execution. Retry count derives from the observed invocation count, while fallback/escalation derive
from the immutable Planner output. Download, timeout, and structured overflow observations survive later audit or
orchestration failure, with download then overflow taking precedence over generic failure.

The strict runner independently accepts only `http://127.0.0.1:<valid-port>` and rejects missing, aliased, IPv6,
remote, HTTPS, credentialed, or path/query/fragment hosts before spawn. Its opt-in result uses structured
`outputOverflowed`; legacy result shape remains unchanged. Arbitrary model text is never projected: only an exact
expected token may populate `normalizedOutput`, while bounded mismatches expose only byte count and lowercase
SHA-256. Invalid acquisition-control input projects null rather than echoing rejected data.
### Slice 5B-2B-E1 — Executable Rebinding and Entrypoint Contract

The first execution attempt was blocked before preflight and generation because the executable identity differed
from the approved identity and no concrete entrypoint existed. Current identity is
`REBOUND_CANDIDATE_NOT_APPROVED`; the observed SHA is evidence only and approval is not granted. E1 supplies an
app-private fixed projection/lifecycle composition. Model-download prevention and external-egress denial remain
**NOT VERIFIED**. Actual preflight, inventory, Provider generation, and Push remain zero/not approved.

### Slice 5B-2B-E — Re-entry Gate Close-Out

The E1 source contract is accepted. The separately approved bounded preflight/inventory attempt passed with Ollama
`0.32.5`, and both required model tags (`llama3.1:8b`, `granite3.3:8b`) were present. Provider generation was
intentionally not executed: independently verified, attempt-scoped external-egress denial was unavailable, so the
gate closed as `CLOSED_WITH_GENERATION_BLOCKED` with Provider execution and model pull counts both zero.

Client-process environment restriction, loopback binding, isolated directories, proxy-variable removal, and
post-execution observation are not technical denial because the existing Ollama daemon remains outside the child
process restriction. PF, a dedicated daemon, a container, or a VM would introduce separate host-policy,
privileged-mutation, daemon-lifecycle, model-storage, rollback, and evidence ownership. That work is not remediation
inside Slice 5B-2B-E; future egress enforcement requires its own architecture boundary and approval. The executable
identity approved for the consumed preflight attempt remains evidence only, not a permanent production default.

### Slice 5C-I — Dormant Production Activation Boundary

The application composition root owns an app-private typed activation boundary. It reads only
`QUOKY_PROVIDER_ROUTING_MODE`: missing and exact `legacy` select the unchanged legacy path, exact
`stage2b-general-chat-v1` begins admission, and every other case-sensitive value fails startup. Legacy admission
returns `undefined` before enforcement, production routing configuration, Provider construction, availability
probing, or execution.

Enabled admission requires an app-private 5C-EG dependency to verify the exact versioned Ollama executable,
loopback endpoint, Provider/model identities, non-loopback IPv4/IPv6 denial, and DNS denial scope. Missing,
unavailable, unverified, or mismatched enforcement fails before
`createProductionProviderRoutingConfiguration(...)`. Only a verified exact scope may construct the existing
configuration and `RuntimeProviderRoutingService`, which the composition root supplies as the optional
`ConversationRuntime` collaborator. There is no fallback to the legacy selector after enabled admission begins.

Slice 5C-I adds no Core change and no concrete egress enforcement, PF/firewall/sandbox, daemon, container, or VM
implementation. The default remains legacy; production routing is not operational, and no live Provider,
Runtime, Discord, network, or database activation was performed. Concrete enforcement remains Slice 5C-EG and
live activation/UAT remains Slice 5C-E.

## ADR-0065 — XR Bounded Child-Process Containment

- **Status:** ✅ Accepted (Stage 2B Slice 5C-EG-F0-XR-FC)
- **Date:** 2026-08-10
- **Decision authority:** Chief Architect

### Context

The accepted XR exact-host-read design requires bounded termination before a provisional metadata observation can
become evidence. Node's `lstat`, `readlink`, `realpath`, and `stat` do not prove physical cancellation after their
libuv filesystem work has started. Direct adapter quarantine bounds the caller's wait but leaves an outstanding
request in the application process; worker isolation does not establish reclamation of process-shared native
resources. A killed and reaped child provides a stronger userspace and authority boundary, but still cannot prove
the exact instant at which kernel, filesystem, provider, automount, network, or daemon work stops.

F0-XR-FC therefore proposed an explicit architecture choice: retain an unprovable exact physical-cancellation
requirement and block indefinitely, or accept a precisely bounded child-process containment invariant without
misrepresenting it as kernel cancellation. The Chief Architect accepts the latter residual-risk model.

```text
ADR_REQUIRED = YES
CA_BOUNDED_CONTAINMENT_DECISION = ACCEPTED
EXACT_PHYSICAL_FILESYSTEM_CANCELLATION = NOT_PROVEN
XR_BOUNDED_PROCESS_CONTAINMENT = ACCEPTED_BY_CHIEF_ARCHITECT
EXACT_BOUNDED_FILESYSTEM_CANCELLATION = REFRAMED_TO_BOUNDED_PROCESS_CONTAINMENT
```

This is a risk/invariant decision, not technical proof of physical filesystem cancellation and not execution
approval.

### Decision

#### Accepted invariant

`XR_BOUNDED_PROCESS_CONTAINMENT_INVARIANT` requires all of the following:

1. One isolated child process owns exactly one XR record: the bounded observation of one approved executable
   identity. A record is not an arbitrary path set.
2. The parent exclusively owns `ApprovedPathToken`, `XR_LIMITS`, the single `XrReadAccounting` instance, PRE/POST
   sequencing, record authority, evidence construction, and execution eligibility.
3. The child receives only a closed protocol version, record identity/nonce, sequence/pass, closed operation enum,
   and the exact approved path for the one outstanding request.
4. The child owns no token minting, path discovery, arbitrary command, arbitrary operation enum, evidence
   eligibility, retry, fallback, or replacement authority.
5. Any deadline, protocol, output, or safety failure discards provisional observation and transitions through
   `SIGTERM → bounded grace → SIGKILL → exit observation → reap proof → stream/channel closure → cleanup proof`.
   Signal delivery, process exit, reap, channel closure, and cleanup are distinct facts.
6. Success requires `CLEAN_TERMINAL`: complete validated PRE/POST record, child exit observed, child reaped, every
   channel closed, cleanup proven, no pending request, and parent consistency validation complete.
7. Any uncertain termination, reap, descriptor/channel closure, or cleanup yields `UNCERTAIN_TERMINAL`. The whole
   XR attempt fails closed with no replacement child, retry, successful evidence, or execution eligibility.
8. No new XR record may begin until the prior child terminal and reap state is proven. One unreaped child halts the
   whole attempt, bounding cumulative child/libuv exhaustion to one unresolved observer process per attempt.

#### Proven or required after successful terminal verification

```text
child process exit observed
child reaped
child userspace address space gone
child-owned libuv/threadpool resource domain gone
parent evidence channel closed
late child result cannot enter evidence
parent XR authority consumed/revoked
no partial record accepted
```

#### Explicitly not proven

```text
physical kernel/filesystem operation cancelled exactly at deadline
maximum universal SIGKILL-to-reap interval
provider/automount/network/daemon side effect cannot finish later
kernel/driver did zero work after child stopped producing evidence
```

The Chief Architect accepts only these unproven kernel-level residuals and only under the complete containment
invariant above. The acceptance does not authorize network filesystems, provider-backed filesystems, daemon
mediation, unknown provenance, or any actual XR host read.

#### Capability ownership and dependency direction

```text
XR_PROCESS_ISOLATION_OWNER = NEW_STRICT_CAPABILITY_REQUIRED
XR_OBSERVER_PROCESS_LIFETIME = ONE_CHILD_PER_XR_RECORD

XR orchestration
  → XR process isolation capability
      → injected low-level lifecycle adapter
```

Process isolation never owns XR policy. CAP-007 `CommandExecution` and `@chunsik/command-local` retain generic
workspace-command semantics: their argv/history persistence conflicts with private XR paths, their current
`spawnSync` lifecycle has no XR request/response protocol or staged reap proof, and widening them would alter CAP-007
ownership. The Ollama preflight runner remains provider-specific; its terminal timer may settle containment failure
without proving reap and is not a generic lifecycle capability.

Low-level policy-neutral primitives may later be extracted or reused: a bounded/capped pipe reader, TERM→KILL
escalation primitive, and runner-owned sandbox cleanup primitive. Such primitives contain no Ollama policy,
workspace-command policy, XR token/path policy, or Provider policy. Capability ownership remains separate.

One child per primitive is rejected because it multiplies spawn/lifecycle failure surface. One child for the full
multi-record sequence is rejected because it holds every path and creates an excessive failure blast radius. One
child per XR record aligns process lifetime with the evidence and failure boundary.

### XR-FCI required follow-ups

Before implementation can be accepted, XR-FCI must define and fake-test parent-exit-before-reap/orphan disposition,
uid/gid handling, umask, resource limits where available or required, exact inherited-FD policy, cwd/environment,
bounded protocol encoding, stdout/stderr limits, TERM/KILL/reap deadlines, idempotent exact-root sandbox cleanup,
and deterministic failure precedence. It must preserve:

```text
one unreaped child
→ halt whole XR attempt
→ never spawn a replacement
```

XR-FCI implementation, process execution, signals, filesystem reads, and XR-AX each require their own later
approval. This ADR alone authorizes none of them.

### Consequences and gates

- **+** XR no longer depends on a physical-cancellation claim that the selected APIs cannot prove.
- **+** Parent policy, token authority, accounting, sequencing, and evidence eligibility remain outside the child.
- **+** Proven reap contains child userspace, libuv/threadpool, descriptors, and late evidence to one record.
- **−** Kernel/provider activity after the logical deadline remains an explicitly accepted residual risk.
- **−** A new private Strict process capability and independent implementation/review slices are required.
- **Risk:** missing reap or cleanup proof halts the entire attempt; availability is sacrificed for fail-closed safety.

Filesystem provenance remains independently unresolved, so the ADR does not make XR-AX eligible:

```text
LOCAL_FILESYSTEM_PROVENANCE_PREFLIGHT = BLOCKED_FEASIBILITY_GAP
XR_AX_ELIGIBLE = NO
PROCESS_EXECUTION_APPROVED = NO
SIGNAL_EXECUTION_APPROVED = NO
NETWORK_APPROVED = NO
LOCAL_DAEMON_CONTACT_APPROVED = NO
CODE_SIGN_READ_APPROVED = NO
XR_ACTUAL_HOST_READ_APPROVED = NO
XR_METADATA_EVIDENCE_EXECUTION_ELIGIBLE = NO
CODE_SIGN_GATE = BLOCKS_XG_XF_XA_E
CANONICAL_DIGEST_FREEZE_APPROVED = NO
PUSH_APPROVED = NO
```

## ADR-0066 — Darwin XR Self-Watchdog and Orphan Residual Acceptance

- **Status:** ✅ Accepted (Stage 2B Slice 5C-EG-F0-XR-FCI-SW)
- **Date:** 2026-08-11
- **Decision authority:** Chief Architect
- **Extends:** ADR-0065 — XR Bounded Child-Process Containment

### Context

ADR-0065 remains unchanged and authoritative. It accepted bounded child-process containment for one XR record per
observer while explicitly declining to claim exact physical filesystem cancellation or a universal maximum
SIGKILL-to-reap interval. The accepted F0-XR-FCI plan subsequently identified Darwin parent-loss/orphan disposition
as an unresolved feasibility gap.

The F0-XR-FCI-SW feasibility review found that a uniquely owned parent-to-child stdin pipe plus a child-local hard
lifetime materially narrows ordinary parent-loss exposure when the child runtime can progress. It also found that
no child-internal watchdog proves bounded termination when the child cannot execute userspace logic or remains in
an uninterruptible kernel/filesystem wait. This ADR records the Chief Architect's explicit acceptance of that
narrowed residual. It does not convert practical defense-in-depth into technical proof.

```text
CA_ORPHAN_RESIDUAL_RISK_DECISION = ACCEPTED
ORPHAN_DISPOSITION = REDUCED_RESIDUAL_ACCEPTED_BY_CHIEF_ARCHITECT
SELF_WATCHDOG_COMBINED_MODEL = REQUIRED_DEFENSE_IN_DEPTH
SELF_WATCHDOG_PROVES_FULL_ADR_CONTAINMENT = NO
UNINTERRUPTIBLE_WAIT_RESIDUAL = REAL
```

### Decision

#### Required minimal self-watchdog

Every future XR-FCI observer must use the smallest accepted model:

```text
unique parent-owned observer stdin writer
+ child read endpoint
+ child-local fixed hard lifetime
```

Heartbeat, `getppid` polling, `kqueue`, an external supervisor, and process-group parent-death logic are not default
parts of the architecture. The feasibility review did not show that their added authority and complexity produce
the missing full proof. Reconsidering any of them requires a new Architecture decision.

#### Process-wide writer correctness invariant

`XR_OBSERVER_STDIN_WRITER_INVARIANT` is load-bearing and process-wide, not merely capability-local:

1. The parent holds the only write descriptor for the observer stdin pipe.
2. The child holds no writer for its own stdin pipe.
3. No sibling, helper, or descendant retains a writer.
4. No descriptor duplication or transfer retains a writer.
5. Every unrelated spawn while the observer pipe is alive preserves close-on-exec and no-writer-inheritance.
6. The child creates no descendants.

Failure to prove the complete invariant stops before observer readiness. A duplicate or inherited writer is a
preflight failure and cannot be repaired by waiting for EOF. Under this invariant, stdin EOF is a reliable
parent-loss indication, but only after lifecycle context classifies it:

```text
STDIN_EOF_PARENT_DEATH_DETECTION = RELIABLE_UNDER_FD_INVARIANT
STDIN_EOF_PROVES_CHILD_TERMINATION = NO
```

#### Closed EOF classification

Any EOF is not automatically watchdog failure. The observer lifecycle must distinguish exactly these semantic
conditions or an equivalent closed state model:

```text
NORMAL_CLOSE_EOF
PARENT_CONTAINMENT_EOF
UNEXPECTED_PARENT_LOSS_EOF
```

- `NORMAL_CLOSE_EOF` follows the completed normal close handshake and remains eligible to reach `CLEAN_TERMINAL`
  after every ADR-0065 exit, reap, stream, cleanup, and consistency proof succeeds.
- `PARENT_CONTAINMENT_EOF` occurs after the parent has already entered its failure-containment lifecycle. It does
  not reclassify the failure as orphan watchdog activation and cannot manufacture terminal success.
- `UNEXPECTED_PARENT_LOSS_EOF` is EOF outside both completed normal close and parent-initiated containment. Only
  this condition activates parent-loss watchdog failure semantics.

The classification is monotonic. Callback order cannot turn unexpected parent loss into normal close or erase a
previous containment decision.

#### Child-local hard lifetime

```text
CHILD_SELF_DEADLINE = REQUIRED_PARTIAL_DEFENSE
CHILD_SELF_DEADLINE_PROVES_BOUNDED_EXIT = NO
```

The deadline is fixed, monotonic, armed before readiness and the first XR request, not caller-configurable, and
independent of the parent timer. Expiration atomically invalidates every provisional observation, stops new work,
and initiates child self-termination. It creates no retry or replacement authority and can never manufacture
`CLEAN_TERMINAL`.

#### Parent-loss safety transition

When `UNEXPECTED_PARENT_LOSS_EOF` is observed while userspace can still progress, the child must perform one
absorbing fail-closed transition:

```text
parent-loss indication
→ atomically invalidate every provisional observation
→ stop accepting new work
→ initiate child self-termination
```

No observation may become valid after the first parent-loss indication. A late result cannot restore eligibility.
The child never retries and the architecture never starts a replacement child for that attempt.

#### Explicitly accepted residual

The Chief Architect accepts that all of the following remain unproven after the mandatory watchdog defense:

```text
child cannot execute userspace watchdog logic
uninterruptible kernel/filesystem wait
watchdog requests termination but bounded exit is not proven
bounded parent-death-to-orphan-exit interval
bounded orphan reap interval once the original parent no longer exists
physical filesystem cancellation
```

This is residual-risk acceptance, not proof. Missing terminal knowledge remains missing; the watchdog, a timer, EOF,
or self-termination intent cannot synthesize exit, reap, stream-close, cleanup, or physical-cancellation evidence.

#### Feasibility conclusions retained

```text
KQUEUE_PARENT_DEATH_DETECTION = PARTIAL_ONLY
KQUEUE_NEW_AUTHORITY_REQUIRED = YES
HEARTBEAT_MODEL = REDUNDANT
EXTERNAL_SUPERVISION_ADDS_PROOF = PARTIAL_ONLY
PROCESS_GROUP_PARENT_DEATH_SOLUTION = NO
```

None is mandatory architecture at this stage.

### Relation to ADR-0065

ADR-0065 is neither rewritten nor replaced. It established:

```text
EXACT_PHYSICAL_FILESYSTEM_CANCELLATION = NOT_PROVEN
XR_BOUNDED_PROCESS_CONTAINMENT = ACCEPTED_AND_RATIFIED
XR_OBSERVER_PROCESS_LIFETIME = ONE_CHILD_PER_XR_RECORD
```

ADR-0066 adds only the required Darwin parent-loss defense-in-depth and explicit acceptance of the remaining orphan
residual. It does not retroactively prove any property that ADR-0065 listed as unproven.

### XR-FCI implementation acceptance requirements

Before an XR-FCI implementation can be accepted, fake/static validation must prove:

- unique process-wide writer ownership and duplicate-writer preflight failure;
- normal close handshake EOF does not trigger watchdog failure;
- parent-initiated containment EOF does not trigger orphan-watchdog classification;
- unexpected parent-loss EOF does trigger the fail-closed watchdog state;
- parent disappearance while idle, with a request outstanding, and after a provisional result;
- child self-deadline expiration;
- EOF/deadline races in both orders and parent-loss/result races;
- late results after watchdog activation never restore eligibility;
- watchdog activation with terminal completion uncertain never becomes `CLEAN_TERMINAL`;
- simulated inability to progress preserves unavailable proof and never manufactures terminal success;
- no retry and no replacement child.

These are future fake/static requirements, not implementation authorization.

### What this ADR does not accept

This ADR does not accept or authorize:

```text
network filesystem access
provider-backed filesystem access
daemon mediation
unknown filesystem provenance
actual XR host read
partial or late evidence
retry or replacement child
XR-AX execution
```

### Consequences and gates

- **+** Ordinary Darwin parent loss gains a required child-owned fail-closed response under the complete FD
  invariant.
- **+** A parent that remains alive but stops driving the protocol is bounded by an independent child-local
  deadline when the child runtime can progress.
- **+** Normal close, parent containment, and unexpected parent loss remain distinguishable and testable.
- **−** Process-wide descriptor discipline becomes a load-bearing proof obligation for every concurrent spawn.
- **−** Uninterruptible/non-runnable child states still have no proven bounded orphan-exit or reap interval.
- **Risk:** acceptance is conditional on defense-in-depth and fail-closed evidence rules; it is not a claim that
  orphan disposition is technically resolved.

After ratification, Architecture status is:

```text
ORPHAN_DISPOSITION = RESIDUAL_ACCEPTED_WITH_REQUIRED_SELF_WATCHDOG
SELF_WATCHDOG = REQUIRED_FOR_XR_FCI
UNINTERRUPTIBLE_WAIT_RESIDUAL = ACCEPTED_BY_CHIEF_ARCHITECT
EXACT_PHYSICAL_FILESYSTEM_CANCELLATION = NOT_PROVEN
```

Independent downstream gates remain closed:

```text
XR_FCI_IMPLEMENTATION_APPROVED = NO
PROCESS_EXECUTION_APPROVED = NO
SIGNAL_EXECUTION_APPROVED = NO
XR_ACTUAL_HOST_READ_APPROVED = NO
NETWORK_APPROVED = NO
LOCAL_DAEMON_CONTACT_APPROVED = NO
LOCAL_FILESYSTEM_PROVENANCE_PREFLIGHT = BLOCKED_FEASIBILITY_GAP
XR_AX_ELIGIBLE = NO
CODE_SIGN_READ_APPROVED = NO
XR_METADATA_EVIDENCE_EXECUTION_ELIGIBLE = NO
CODE_SIGN_GATE = BLOCKS_XG_XF_XA_E
CANONICAL_DIGEST_FREEZE_APPROVED = NO
PUSH_APPROVED = NO
```

## Stage 2B Offline Completion Checkpoint

- **Status:** ✅ Accepted
- **Date:** 2026-08-11
- **Authority:** Chief Architect accepted the offline completion readiness and 5C-EG-F′ result.

The completed offline surface is Slices 1–4, 5A, 5B, 5C-I, ratified ADR-0065 and ADR-0066, accepted F0-XR-FCI,
F0-XR-FP completed with carryover, and accepted 5C-EG-F′. The latter closed the feasibility loop without selecting
an enforcement architecture.

```text
STAGE_2B_OFFLINE_COMPLETION = COMPLETE_AND_ACCEPTED
STAGE_2B_OFFLINE_BLOCKERS = NONE
XR_AX_STAGE_2B_NECESSITY = OPTIONAL
XR_AX = BLOCKED_CARRYOVER
XR_FILESYSTEM_PROVENANCE = STABLE_BLOCKER
F0_XR_FCI = COMPLETE_AND_ACCEPTED
F0_XR_FP = COMPLETE_AND_ACCEPTED_WITH_CARRYOVER
5C_EG_F_PRIME = ACCEPTED
5C_EG_FEASIBILITY_LOOP = CLOSED
5C_EG = BLOCKED_CARRYOVER
5C_EG_I1_I2_V_E = NOT_ELIGIBLE
LIVE_PROVIDER_ACTIVATION = BLOCKED
LIVE_RUNTIME_DISCORD_DB_UAT = BLOCKED
```

Offline completion is not live-activation readiness, proof of external-egress denial, proof of filesystem
provenance, or production readiness. Concrete 5C-EG or equivalently strong enforcement remains required for live
activation and still requires separate Strict approval. `CLEAN_TERMINAL` remains containment proof rather than operation success.
`XrIsolationAttemptGate.completeRecord()` remains a containment-release gate; a future XR consumer/orchestration
success decision must require both `state === CLEAN_TERMINAL` and `outcome === SUCCESS`.

## Stage 2C Suitability Contract Review Decisions

- **Status:** ✅ Accepted as pass with changes
- **Date:** 2026-08-11
- **Authority:** Chief Architect

Commit `ff1a356` is ratified as the Stage 2C Slice 1 remediation and a fail-closed correction within
`stage2c-suitability-projection-v1` and `stage2c-candidate-provider-profile-v1`. It preserves observed hard-safety
disqualifications as `INELIGIBLE` when scorecard evidence is missing. This narrows eligibility; it does not add a
profile schema or broaden eligibility semantics, so no version bump is required.

```text
FF1A356_CLASSIFICATION_CHANGE = RATIFIED_V1_FAIL_CLOSED_CORRECTION
SUITABILITY_RATIFICATION_BINDING = INDEPENDENTLY_SUPPLIED_OFFLINE_BINDING
AUTHENTICATED_APPROVAL_AUTHORITY = NO
APPROVAL_MANAGER_VERIFIED = NO
REVOCATION_VERIFIED = NO
UNIQUENESS_VERIFIED = NO
EXPIRY_VERIFIED = NO
STAGE_2C_PROFILE_APPLICATION_ARCHITECTURE = CLOSED_BY_ADR_0067
STAGE_2C_PROFILE_APPLICATION_IMPLEMENTATION = NOT_YET_ELIGIBLE
REASON = IMPLEMENTATION_NOT_APPROVED
```

Slice 2 `APPROVED` means only that candidate identity and the supplied approval binding passed deterministic offline
ratification checks. It is not authenticated operator authority, a proven ApprovalManager decision, Runtime
activation approval, or production authorization. ADR-0067 subsequently closes the v1 application architecture by
keeping authority on a real configuration-change `ExecutionPlan`/Patch under existing plan-scoped Approval,
requiring exact subject binding and bounded expiry, and deferring separate authorization persistence/revocation.
It does not approve application implementation or mutation.

Candidate self-consistency is verified, but its unkeyed candidate/evidence digests do not cryptographically prove
benchmark provenance. If future Runtime or audit architecture treats an approved profile as authoritative evidence,
persisted evidence artifacts or authenticated/signature-backed provenance require separate review. This is a
carryover, not a Slice 2 correctness blocker.

## ADR-0067 — Stage 2C Profile Configuration Application Model

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-08-12
- **Authority:** Chief Architect
- **Extends:** ADR-0064 — Provider Routing Policy and Registry Ownership

### Context

Stage 2C Slice 2 can deterministically ratify an eligible suitability candidate into an immutable approved static
profile, but ratification is not authorization to change configuration. V1 needs an exact, fail-closed bridge from
that offline result to a future configuration change without weakening existing `ExecutionPlan`-scoped Approval,
expanding Stage 2B egress scope, or introducing live ProviderRegistry mutation.

### Decision

V1 selects **M1 build/configuration-time application**. M2 live Runtime Registry mutation is deferred. V1 adds no
Core authorization aggregate, approval database, ApprovalRef meaning, or ApprovalManager behavior.

A future app-private `ProfileConfigurationApplicationGate` owns admission before creation of a real
configuration-change `ExecutionPlan` or Patch. It validates the ratified profile, exact current configuration
identity, expected-result derivation, application-contract version, bounded expiry, projection fields, and egress
compatibility. It does not decide or persist Approval, mutate a Workspace or Registry, execute a Provider, or own
retry, backoff, and partial-failure behavior.

The canonical subject is:

```text
ProfileConfigurationApplicationSubject {
  approvedProfileDigest
  targetConfigurationIdentity
  expectedResultConfigurationDigest
  runtimeApplicationContractVersion
}

applicationSubjectDigest = SHA256(canonical subject)
```

Any audit projection of Provider, model, descriptor-configuration digest, or ratification-contract version must be
re-derived from the ratified profile and match exactly. The target identity is the exact before-state; the expected
result digest is the exact after-state.

### Approval Boundary

Authority remains attached only to the real configuration-change `ExecutionPlan`/Patch through the existing
plan-scoped `ApprovalRequest`/`ApprovalRef` boundary:

```text
profile ratification != configuration change approval
valid application subject != execution approval
approved execution plan != mutation already performed
```

A profile digest must never be converted into a synthetic execution-plan reference. The existing mutation owner
must freshly verify plan approval, the application subject, and current configuration immediately before execution.
Rejected, withdrawn, or non-approved plans remain non-executable under existing Approval semantics.

### Egress, Replay, and Expiry

Profile application must not expand the protected Stage 2B egress scope. A Provider/model outside that scope is
ineligible. Any necessary egress change is a separate architecture slice, not profile application.

An exact repeat is idempotent only when approved profile, target identity, expected-result digest, and application
contract all match. If the expected result is already present, the application path may return verified no-op
success. No authorization or plan may be reused for a different subject.

Expiry is mandatory and fail-closed. The app-private gate contract owns an immutable maximum-lifetime policy; the
caller and ratified profile cannot loosen it, and a deployment may choose only an equal or shorter lifetime.
Missing clock capability, malformed timestamps, non-positive or above-policy lifetimes, and expired subjects reject.
V1 adds no authorization persistence, revocation lifecycle, or replay-record store.

### Provenance and Failure Policy

V1 provenance assurance is `SELF_CONSISTENT_UNSIGNED`: candidate/profile digest consistency is verified, while
cryptographic authenticity of benchmark provenance is not proven. PKI/signing is deferred.

The gate fails closed for malformed or stale profiles; digest recomputation failure; approved-profile, target,
expected-result, contract-version, or projection mismatch; invalid expiry; egress incompatibility; and current
configuration read or derivation failure.

### Consequences

- **+** Profile application is exactly bound to one before-to-after configuration transition.
- **+** Existing Approval meaning and mutation ownership remain intact.
- **+** Egress scope cannot silently grow through model/profile selection.
- **−** Application requires a real configuration-change plan/Patch and fresh pre-execution validation.
- **−** V1 proves self-consistency, not authenticated benchmark provenance.

### V1 / V2

- **V1 `[RESERVE]`:** app-private application gate and canonical subject; implementation requires a later approved
  slice.
- **V1 `[NOW]`:** immutable ProviderRegistry, build/configuration-time composition, existing plan-scoped Approval,
  and Stage 2B protected egress boundary remain authoritative.
- **V2 `[LATER]`:** live Registry/profile mutation, dedicated authorization persistence and revocation, replay
  records, and authenticated/signature-backed provenance.

This ADR does not authorize profile application implementation, Workspace/Patch apply, Core or ApprovalManager
changes, DB migration, Runtime/ProviderRegistry mutation, Provider execution, or live activation.

## ADR-0068 — Stage 2C ExecutionPlan Typed Integrity Binding

- **Status:** ✅ Accepted (v1 architecture; Stage 2C Slice 3C implementation not started)
- **Date:** 2026-08-14
- **Authority:** Chief Architect ratified
- **Extends:** ADR-0024 (Planning), ADR-0025 (Approval), ADR-0026 (Patch), ADR-0027 (Workspace Write), and ADR-0067
  (Stage 2C Profile Configuration Application Model)

### Context

ADR-0067 requires a real configuration-change `ExecutionPlan`/Patch under the existing plan-scoped Approval
boundary. `applicationSubjectDigest` alone does not bind the exact source/config edit. Existing `ExecutionPlan`
retention is in-memory, while `ApprovalRequest`/`ApprovalRef` may survive process or session loss carrying only an
`ExecutionPlanRef`; exact application-subject and proposed-change integrity would therefore be lost after approval.

Making `ExecutionPlan.id` content-addressed is rejected. The id is a per-plan-instance approval-correlation identity;
identical plans created for distinct approval attempts must not share it or weaken `ApprovalManager` semantics.

### Decision

```text
STAGE_2C_PLAN_BINDING_ARCHITECTURE = EXECUTION_PLAN_REF_TYPED_INTEGRITY_EXTENSION
STAGE_2C_SLICE_3C_ARCHITECTURE = RATIFIED
STAGE_2C_SLICE_3C_IMPLEMENTATION = NOT_STARTED
```

Add conceptually a generic opaque integrity value:

```text
ExecutionPlanIntegrityRef {
  kind
  contractVersion
  digest
}
```

It may propagate additively and optionally as `PlanningRequest.integrity? → ExecutionPlan.integrity? →
ExecutionPlanRef.integrity?`. It identifies the integrity of this exact `ExecutionPlan`. It is not an
`ApprovalSubject`, Stage 2C domain object, suitability profile, or Runtime authorization. Approval remains strictly
`ExecutionPlan`-scoped; Approval API meaning is unchanged. This decision introduces no persistence, DB migration,
capability, or aggregate.

### Referential Integrity

Patch and Workspace boundaries compare the full plan integrity identity:

```text
executionPlanRef.id
+ integrity.kind
+ integrity.contractVersion
+ integrity.digest
```

- Same id with different integrity rejects.
- Same digest with different kind or contract version rejects.
- Integrity present on only one side rejects.
- Integrity omitted on both sides preserves existing legacy behavior.

`PatchManager` remains generic and only strengthens reference-equality checks. `WorkspaceWriteManager` remains the
sole filesystem mutation owner and likewise only strengthens reference-equality checks. Neither manager derives or
interprets Stage 2C application semantics.

### Stage 2C Application-Plan Binding

The exact proposed source/config change must exist before the real plan is created. `applicationSubjectDigest` alone
is insufficient. The Stage 2C app layer derives a cryptographic `proposedChangeDigest`, then:

```text
planIntegrityDigest = SHA256(canonical {
  kind,
  contractVersion,
  applicationSubjectDigest,
  proposedChangeDigest
})
```

This security boundary uses SHA-256 and must not use the existing FNV/non-cryptographic `contentHash` helpers. The
required ordering is:

```text
ProfileConfigurationApplicationCandidate
→ exact ProposedChange / WorkspaceDiff
→ proposedChangeDigest
→ planIntegrityDigest
→ real ExecutionPlan
→ existing ApprovalManager.requestFor(plan)
→ APPROVED ApprovalRef
→ fresh Stage 2C revalidation
→ PatchManager.generate()
→ WorkspaceWriteManager.apply()
```

The Stage 2C app layer owns application-subject derivation/revalidation, `proposedChangeDigest`,
`planIntegrityDigest`, and fresh post-approval revalidation. `ApprovalManager` remains generic and plan-scoped.

### No-op, M1, and Egress Boundaries

Before application-plan wiring, `target === expected` must classify as `VERIFIED_NOOP`, not `APPLY_REQUIRED`.
`VERIFIED_NOOP` creates no `ExecutionPlan`, `ApprovalRequest`, `PatchSet`, or `WorkspaceWrite`.

`APPLICATION_MODEL = M1_BUILD_CONFIG_TIME`; M2 live Runtime mutation remains deferred. Profile application must not
expand protected egress scope. A proposed plan/patch must not change the egress allowlist, routing policy, Runtime
wiring, or unrelated providers. An out-of-scope Provider/model is not plan-eligible.

### Consequences and Implementation Boundary

- **+** Exact plan content survives approval hand-off as typed opaque integrity without changing plan identity.
- **+** Existing aggregate ownership and plan-scoped Approval semantics remain intact.
- **+** Legacy flows remain compatible only when both compared refs omit integrity.
- **−** Every integrity-aware boundary must reject partial propagation or any kind/version/digest mismatch.
- **−** Stage 2C must construct the exact proposed change before requesting approval.

This ADR synchronizes an already-ratified architecture decision only. It does not implement
`ExecutionPlanIntegrityRef`, alter Core/Patch/Workspace code, create persistence or a migration, authorize application
or Runtime mutation, execute a Provider, or approve Push/PR/Merge/Live UAT.

## ADR-0069 — Autonomous Local Development Standing Delegation

- **Status:** ✅ Accepted (governance)
- **Date:** 2026-08-14
- **Authority:** Product Owner
- **Canonical execution policy:** `docs/governance/DEVELOPMENT-MODE.md`

### Decision

```text
AUTONOMOUS_DEV_MODE = ENABLED
ACTIVE_MILESTONE = QUIRKYBOT_DEV_V1
ARCHITECT_ROLE = DELEGATED_CHIEF_ARCHITECT
BUILDER_ROLE = CODEX
INDEPENDENT_REVIEWER_ROLE = CLAUDE
```

Product Owner grants the Architect AI standing authority to inspect canonical state, identify milestone gaps, create
bounded LOW/MEDIUM-risk local tasks, approve their implementation, send them to Codex, consume independent Claude
review, route blocking `FIX` findings through at most two remediation rounds, accept `PASS`, and continue until the
active milestone is reached. An Architect-generated task inside this delegation is an approved local implementation
scope; no pre-existing human-authored Sprint or additional one-off approval is required.

FAST DELIVERY remains authoritative. A coherent delegated task may bundle implementation, scope-local refactoring,
unit/focused/regression tests, lint/format, typecheck, build, required documentation, local commit, and up to two
Builder/Reviewer remediation rounds. Ordinary local development creates no approval packet or evidence-only document.

Ratified architecture may be implemented under this delegation when the task stays within the ratified boundary, is
needed for `QUIRKYBOT_DEV_V1`, is bounded and verifiable, and crosses no High/Critical boundary. Architecture
ratification is not permission for unbounded or unrelated implementation.

### Human-only Boundary

Standing delegation excludes Push, PR, Merge, Runtime start/stop/restart, Chunsik application Provider or network
execution, Discord connection/action, secret reads, DB/SQLite mutation or migration apply, Runtime data mutation,
actual product Patch/Workspace Apply, Live UAT, production/release gates, destructive operations, and unrelated
cleanup. Each requires explicit Human approval. Product ambiguity, competing valid product directions, architecture
invariant changes, unratified architecture, material milestone expansion, data-loss/security risk, or unverifiable
success also requires `HUMAN_REQUIRED`.

Trusted Kiro/Codex/Claude development control-plane turns are authorized only to execute the delegated local workflow;
they do not authorize Chunsik application Runtime/Provider/network execution. This governance decision does not add
an agent runtime to the Chunsik product and does not change `ARCHITECTURE.md` product-runtime invariants.

### Milestone and Current Eligibility

Every proposed task must be necessary for `QUIRKYBOT_DEV_V1`; otherwise it is deferred. Once DEV_V1 acceptance
criteria are met, Architect returns `MILESTONE_REACHED` and yields to Product Owner UAT/debugging rather than
continuing feature or hardening work.

```text
STAGE_2C_SLICE_3C_ARCHITECTURE = RATIFIED
STAGE_2C_SLICE_3C_IMPLEMENTATION = ELIGIBLE_FOR_AUTONOMOUS_IMPLEMENTATION
STAGE_2C_SLICE_3C_IMPLEMENTATION_AUTHORITY = DELEGATED_TO_ARCHITECT_AI
```

This ADR changes development governance only. It does not implement Slice 3C, modify product code, or authorize any
Human-only operation.

## ADR-0070 — Autonomous Local Development Database Delegation

- **Status:** ✅ Accepted (governance)
- **Date:** 2026-08-16
- **Authority:** Product Owner
- **Canonical execution policy:** `docs/governance/DEVELOPMENT-MODE.md`

### Decision

```text
AUTONOMOUS_DEV_DB = APPROVED
PRODUCTION_DB = HUMAN_APPROVAL_REQUIRED
```

Active-milestone local/development SQLite create/open, WAL/journal initialization, schema design, migration
implementation and apply, schema/`user_version` updates, development seed/fixture operations, normal bounded
development/UAT persistence, DB tests, disposable/test reset/recreate, and bounded local data migration join the
autonomous development standing delegation.

This ADR supersedes only ADR-0069's blanket exclusion of DB/SQLite mutation, migration apply, and DB Runtime data
mutation. Every non-DB Human-only boundary in ADR-0069 remains unchanged.

For current Quoky DEV_V1, repository `data/chunsik.db` is delegated only when `QUOKY_RUNTIME_ENV=dev`, the configured
database resolves exactly to that path, and no Production/shared target is selected. Under those proven conditions,
create/open, WAL initialization, migrations v1-v6, `PRAGMA user_version`, and bounded normal UAT persistence must not
produce `DB_MUTATION_NOT_AUTHORIZED`.

Production/shared/live mutation, Production migration apply, irreversible or non-disposable destructive data loss,
drop/truncate/bulk destructive mutation on non-disposable data, shared/live backup or restore, and database
credential/secret mutation remain exact-scope Human approval boundaries. Unknown or mismatched environment/target
classification fails closed.

Schema contract, persistence ownership, migration strategy, and aggregate-boundary changes continue to require
ratified architecture and independent Architecture Review. Once ratified, local/dev implementation and migration
execution require no additional Human approval. This decision changes development governance and trusted UAT
prevalidation only; it does not authorize Runtime Start, Provider/network execution, Discord action, Live UAT,
Production work, or destructive non-disposable DB operations.

## ADR-0071 — DEV_V1 Config-Restricted Live UAT Risk Acceptance

- **Status:** ✅ Accepted (bounded Product Owner risk decision)
- **Date:** 2026-08-16
- **Authority:** Product Owner
- **Decision basis revision:** `9596283187be9e2513da28f9705e0f85b6c38abd`

### Decision

```text
CONFIG_RESTRICTED_RISK_ACCEPTED = APPROVED_FOR_DEV_V1_UAT_ONLY
PRODUCTION_GRADE_5C_EG = BLOCKED_CARRYOVER
DEV_V1_UAT_EXCEPTION = CONFIG_RESTRICTED_RISK_ACCEPTED
```

The Product Owner accepts configuration-restricted operation for bounded `QUIRKYBOT_DEV_V1` Live UAT because
concrete per-process OS-level 5C-EG enforcement is unavailable on the current local Darwin development host. The
exception is effective only when every condition below is proven together:

- development/non-production and `QUOKY_RUNTIME_ENV=dev`;
- current local Darwin host;
- valid exact-current-revision UAT authorization;
- primary Provider binding `ollama-cli` / `llama3.1`;
- exact approved development Discord bot, guild, and channel;
- existing routing, egress, and configuration restrictions remain enabled;
- bounded DEV_V1 UAT scenarios only.

Any revision, environment, host, Provider, Discord-target, restriction, or UAT-authorization drift fails closed with
`HUMAN_REQUIRED`. The decision does not solve 5C-EG, make configuration restriction Production-safe, remove
`NO_FEASIBLE_ARCHITECTURE_YET / BLOCKED_CARRYOVER`, authorize Production/Release, carry to another SHA/host/environment,
or authorize arbitrary network/Provider execution. The governance commit recording this decision creates a new HEAD;
therefore the previous UAT authorization remains invalid and the final exact SHA requires explicit authorization
before prevalidation or Live UAT can proceed.

## ADR-0072 — Canonical V1 Read-Only Connector Seam

- **Status:** ✅ Accepted (v1)
- **Date:** 2026-08-21
- **Authority:** Chief Architect

### Context

ADR-0005 decided that “Connectors are ResourceResolvers” and scoped V1 to a `ResourceRef` plus
`ResourceResolver` port with no concrete resolvers. The implemented connector seam instead consists of
`ConnectorProvider`, `ConnectorManager`, and `ConnectorItem`; `ResourceRef` and `ResourceResolver` have not been
introduced. Read-only Jira, Slack, and Confluence connectors are the next M2 connector direction, so their V1 port
must be settled before adding a concrete adapter.

### Decision

Ratify **`ConnectorProvider` as the canonical V1 read-only connector port**. Jira, Slack, and Confluence read
adapters implement that port and expose `ConnectorItem` values through `ConnectorManager`. V1 does not introduce
`ResourceRef` or `ResourceResolver`, and does not unify or replace `ConnectorProvider` with `ResourceResolver`.

Introduction of `ResourceRef`/`ResourceResolver` and any `ConnectorProvider` → `ResourceResolver` unification are
deferred to V2+. Such unification is a future architecture decision, not an implicit requirement of a V1 connector
adapter.

ADR-0005's V1 scope is superseded only for its connector-as-`ResourceResolver` direction. Its strict separation of
read-side input Resources from output Artifacts, and its read-only-input principles, remain in force.

### Consequences

- **+** V1 connector adapters build on the existing Core seam without parallel read contracts.
- **+** Jira, Slack, and Confluence share one provider-independent, read-only connector boundary.
- **−** Uniform resource references and resolver-based connector composition remain unavailable until V2+.

### Relations

ADR-0005 (partially supersedes only the connector-as-`ResourceResolver` aspect; preserves Resource/Artifact
separation and read-only-input principles).

## ADR-0073 — M2 Long-term and Agentic Memory Architecture

- **Status:** ✅ Accepted (M2)
- **Date recorded:** 2026-08-24
- **Authority:** Product Owner ratification after independent Chief Architect architecture review (`PASS`)
- **Decision basis:** `docs/plans/m2-long-term-memory-architecture-plan.md` as reviewed at
  `3c94a8db5de2dba3b8350ee0bdfb6d6d1e712fdb`

### Context

The M2 long-term and agentic memory proposal completed independent architecture review and explicit Product Owner
ratification, but its historical plan still identified itself as proposed and requiring review. Because this file is
the append-only canonical decision log, that stale status left the accepted architecture unavailable as repository
authority and blocked the first implementation slice.

### Decision

Ratify the complete architecture in the decision-basis plan exactly as reviewed. The plan remains the historical
architecture input; this ADR is the canonical accepted decision. The ratified boundary includes:

- distinct Working, Episodic, Semantic Long-Term, and Canonical Structured State tiers;
- `immediatelyPreviousUserTurn` as a deterministic Working-Memory projection over exact current-session
  `SHORT_TERM` transcript, never Tier 4 Canonical Structured State;
- durable recall remaining outside `conversationTranscript`, with durable-memory deduplication forbidden from
  replacing, removing, or displacing exact `SHORT_TERM` transcript;
- bounded hybrid retrieval with `ContextBuilder` as the single final provider-context budget owner;
- storage-neutral Core contracts and separate persistence ownership;
- no selected vector product;
- bounded retention and forgetting; and
- probabilistic memory never overriding canonical approval, security, or project state.

All other scope, ownership, authority, retrieval, deduplication, retention, non-goal, and approval-boundary details
are accepted exactly as written in the decision-basis plan. This canonicalization introduces no architectural
semantic beyond that reviewed revision.

### Consequences

- The M2 memory architecture is accepted repository authority and may govern separately approved bounded
  implementation slices.
- The plan remains historical input and points to this canonical ADR rather than acting as a competing authority.
- Any public Core contract, persistence/schema/migration design, or vector-adapter selection still requires the
  applicable bounded implementation or later architecture decision described by the accepted plan.
- Ratification does not authorize source implementation, dependency changes, DB/schema mutation, Runtime,
  Provider/network execution, Discord, secrets, Live UAT, Push, PR, or Merge.

### Relations

Extends ADR-0002 (ContextBuilder), ADR-0003 (PromptComposer), ADR-0017 (bounded exact `SHORT_TERM` transcript),
ADR-0018 (exact active-project background), and ADR-0063 (provider-neutral provenance and current-fact precedence).
Preserves the fixed `MemoryType` values and the provider-independent, local-first boundaries in `ARCHITECTURE.md`.

## ADR-0074 — Resource / Work Surface Foundation

- **Status:** ✅ Accepted (M3 Architecture Rebaseline, `RATIFIED_WITH_CHANGES`)
- **Date recorded:** 2026-08-31
- **Authority:** Product Owner ratification of the Chief Architect verdict
- **Decision basis:** `docs/plans/m3-architecture-rebaseline.md`, with the changes recorded here

### Context

The M3 rebaseline identified two missing foundations for a personal work surface: a stable identity for external
inputs and a bounded way to present work from several authoritative systems. The proposal also showed that treating
this need as a universal Work Graph would duplicate existing aggregate ownership and invite a graph engine, graph
database, workflow engine, or event-sourcing architecture without a demonstrated requirement.

### Decision

`ResourceRef` is the stable, provider-independent identity of an external input. It identifies what the system
reads or correlates; it is not the input payload, connector DTO, cached content, or an output. The existing hard
boundary remains unchanged: **Resource is input and Artifact is output; Resource and Artifact never merge.**

The M3 Work Model is deliberately narrow:

- `WorkItem` is the durable work aggregate defined by ADR-0075.
- Work Surface is a non-authoritative read model composed from authoritative work and external-resource sources.
- Work Surface data is rebuildable and does not become a new system of record.
- A universal Work Graph, graph database, graph engine, generic graph abstraction, universal event sourcing, and a
  Workflow engine are explicitly rejected for this foundation.

Ratification establishes the architecture contract but does not claim implementation. `ResourceRef` remains
`[RESERVE]` until a separately approved implementation slice lands.

### M3A-1 sequencing

M3A-1 contains only `ResourceRef` and the read-only Work Surface needed for the first bounded personal-work view.
It introduces no `WorkItem` persistence, repository, schema, or database migration. It also introduces no write
path, MCP, agent, handoff, trigger, receipt, or workflow behavior. `WorkItem` persistence begins only in M3A-2 under
ADR-0075.

### Consequences

- External inputs can gain stable identity without becoming Artifacts or leaking connector-specific types into Core.
- The first Work Surface remains a read-only projection rather than a competing source of truth.
- M3A-1 can deliver a bounded surface before durable personal-work state is introduced.
- Product source, persistence, migration, connector extensions, and Runtime wiring require separate bounded tasks.

### Relations

Extends ADR-0005's Resource/Artifact separation and partially supersedes ADR-0072 only where ADR-0072 deferred
`ResourceRef` beyond v1. Preserves `ConnectorProvider` as the implemented canonical read-only connector seam; it
does not introduce `ResourceResolver` or replace `ConnectorProvider`. Paired with ADR-0075.

## ADR-0075 — CAP-011 Work Model

- **Status:** ✅ Accepted (M3 Architecture Rebaseline, `RATIFIED_WITH_CHANGES`)
- **Date recorded:** 2026-08-31
- **Authority:** Product Owner ratification of the Chief Architect verdict
- **Decision basis:** `docs/plans/m3-architecture-rebaseline.md`, with the changes recorded here

### Context

M3 needs durable personal-work identity that can outlive a conversation and correlate several external resources.
Existing `Session`, `Task`, and execution-ledger aggregates retain their established ownership; CAP-011 must not
absorb them or become a generic workflow-state container.

### Decision

Introduce CAP-011 Work Model with `WorkItem` as a narrow aggregate. `WorkItem` owns only:

- durable work identity;
- actor ownership;
- an optional project reference;
- resource correlation;
- high-level lifecycle/status; and
- origin.

`WorkItem` explicitly does **not** own `Task`, `TaskRun`, `ExecutionPlan`, `ApprovalRequest`, provider routing,
arbitrary conversation state, apply-preview flow state, scope-clarification blobs, or generic workflow state.
Those concepts remain with their current aggregates and capability owners. A reference from a `WorkItem` does not
transfer ownership, mutation authority, or approval scope.

The Work Model consists of this narrow durable aggregate plus ADR-0074's non-authoritative Work Surface read model.
It is not a Workflow, agent runtime, universal graph, or event-sourced centre.

### M3A-2 sequencing

M3A-2 may introduce the `WorkItem` repository, a forward-only additive migration, and persisted personal-work
state. M3A-1 must not introduce any of them. The M3A-2 schema and implementation still require a separately
approved bounded task and the applicable independent architecture review; this ADR does not apply a migration.

### Consequences

- Durable work can span conversations without expanding `Session` or turning `Task.metadata` into a universal store.
- Existing execution, approval, routing, and conversation ownership remains intact.
- Persistence begins additively in M3A-2, after the read-only M3A-1 foundation.
- No M3 product source, repository, schema, or migration is implemented by this ratification.

### Relations

Builds on ADR-0074. Preserves ADR-0024 Planning ownership, ADR-0025 plan-scoped Approval ownership, and the existing
`Task`/`TaskRun` meanings. ADR-0032 is amended below to keep persistent work state outside Conversation Runtime.

### ADR-0032 Amendment — M3 ConversationRuntime boundary

- **Status:** ✅ Accepted amendment (`RATIFIED_WITH_CHANGES`)
- **Date recorded:** 2026-08-31
- **Authority:** Product Owner ratification of Chief Architect decision D12

This amendment is append-only; the original ADR-0032 entry remains historical authority for its accepted slices.
For M3 and later slices, `ConversationRuntime` remains the conversation/application entry point for inbound-message
handling and turn-level presentation. It must not own global or persistent work state. M3 must reduce its work-flow
responsibility by moving durable work ownership to the capability that owns that state.

For every completed M3 slice, `ConversationRuntimeDeps` must not grow beyond the previous accepted baseline for that
slice. Adding a dependency requires removing or moving enough responsibility that the completed slice does not
increase the accepted dependency surface. This constraint is an architecture acceptance condition, not a request
to hide dependencies behind a new god-interface.

`ConversationRuntime` gains no ownership of M3 work state, agent or handoff state, trigger or scheduler state,
receipt/provenance state, connector or MCP protocol state, or generic workflow state. It may present bounded Work
Surface results and conversationally collect decisions while the owning capability retains state and mutation
authority. Existing `Task`, execution, Planning, Approval, Provider, and Workspace ownership remains unchanged.

## ADR-0076 — CAP-012 ToolProvider and MCP Adapter Architecture

- **Status:** ✅ Accepted (M3B-1, `APPROVED_WITH_CHANGES`)
- **Date recorded:** 2026-09-02
- **Authority:** Chief Architect

### Context

M3 requires a provider-independent tool boundary before any concrete MCP infrastructure can be introduced. Extending
`ConnectorProvider`, leaking MCP protocol types into Core, or creating a second approval system would violate the
existing capability and governance boundaries. M3B-1 therefore establishes only the protocol-neutral foundation.

### Ratified decisions D1–D15

1. **D1:** Core introduces a protocol-neutral `ToolProvider` boundary. Core imports no MCP type or SDK.
2. **D2:** Tool structural identity is exactly provider `source` plus provider-local tool `name`; there is no separate
   operation-id hierarchy or `ToolOperationDescriptor`.
3. **D3:** `ToolSchema` is bounded to JSON null, boolean, number, string, object properties and required fields, and
   arrays/items. It has no metadata or arbitrary schema-extension escape hatch.
4. **D4:** Every descriptor has a QuirkyBot-owned `READ_ONLY` or `MUTATING` effect classification.
5. **D5:** Any future provider-supplied risk metadata is advisory only. QuirkyBot effect and risk policy is authoritative.
6. **D6:** A provider owns provider-local discovery, availability, descriptor projection, one invocation by tool name,
   and containment of provider failures behind the bounded result contract.
7. **D7:** The M3B-1 failure taxonomy is `TOOL_NOT_FOUND`, `TOOL_UNAVAILABLE`, `INVALID_INPUT`,
   `MUTATION_NOT_AUTHORIZED`, `EXECUTION_FAILED`, and `OUTPUT_INVALID`. It contains no parallel approval result.
8. **D8:** M3B-1 delegates only `READ_ONLY` invocations. `MUTATING` invocations fail closed with
   `MUTATION_NOT_AUTHORIZED` before the provider is invoked.
9. **D9:** Future mutation authorization must reuse the existing governed execution and plan-scoped approval lineage;
   CAP-012 does not create a parallel Tool approval path.
10. **D10:** `ToolManager` owns an immutable composition-time registry. Runtime register/unregister, dynamic plugin
    loading, and registry mutation are prohibited.
11. **D11:** `ToolManager` owns deterministic duplicate-source and composite-identity rejection, discovery, bounded
    input/output validation, READ_ONLY delegation, failure classification, and raw-error containment. It owns no
    WorkItem, conversation, routing, persistence, execution-history, risk-policy, approval, or MCP state.
12. **D12:** `ToolManager` has no `ApprovalManager` dependency and exposes no public registry-entry domain type.
13. **D13:** `ToolInvocation` reuses canonical `Actor.id` and optional `ResourceRef` correlation and introduces no
    parallel actor or resource identity.
14. **D14:** `ConnectorProvider` remains the canonical read-only connector seam and is neither replaced nor extended by
    `ToolProvider`.
15. **D15:** A concrete infrastructure-only MCP adapter is deferred to M3B-2 or later. M3B-1 adds no MCP SDK, live
    provider, ConversationRuntime tool path, ExecutionOrchestrator stage, persistence, or migration.

### Consequences

M3B-1 can compose an empty immutable tool-provider set and validate the complete Core boundary offline. Concrete MCP
transport, governed mutation execution, Runtime exposure, external provider calls, and live UAT remain separately
bounded later work.

### Relations

Extends ADR-0074's provider-neutral `ResourceRef` correlation and preserves ADR-0072's `ConnectorProvider` boundary,
ADR-0025's plan-scoped Approval ownership, and the ADR-0032 M3 ConversationRuntime dependency freeze.

## ADR-0077 — MCP Adapter Initialization and Trust Boundary

- **Status:** ✅ Accepted (M3B-2A)
- **Date recorded:** 2026-09-02
- **Authority:** Chief Architect

### Context

ADR-0076 ratified the protocol-neutral CAP-012 Core boundary while deferring concrete MCP infrastructure. M3B-2A
introduces one infrastructure-only MCP client adapter without changing that Core contract or activating a production
transport. MCP discovery data and annotations originate outside QuirkyBot's trust boundary and therefore cannot grant
read-only authority, broaden schemas, expose protocol failures, or create a second approval path.

### Ratified decisions

1. The adapter owns an explicit asynchronous `initialize()` lifecycle. Initialization performs one bounded MCP
   `listTools` discovery, validates and maps the entire result, and only then atomically publishes the snapshot.
2. `ToolProvider.listTools()` remains a pure synchronous read of one immutable post-initialization snapshot. There is
   no lazy discovery, runtime rediscovery, refresh loop, reconnect/retry, or list-changed subscription.
3. Provider identity is trusted composition configuration `mcp:<serverId>`. Server-reported name, title, and version
   are diagnostic/display data only. Tool identity retains the exact discovered MCP tool name used by `callTool`;
   duplicate or unrepresentable identities fail initialization closed.
4. MCP annotations are advisory only. A tool is `READ_ONLY` only when its exact name is explicitly allow-listed by
   trusted adapter configuration and MCP metadata does not contradict that classification. Unknown, absent,
   ambiguous, contradictory, or unconfigured effect information maps fail-closed to `MUTATING` or rejects discovery;
   `readOnlyHint` alone never grants read-only authority.
5. MCP schemas map only into the bounded ratified `ToolSchema` subset. Any enum, union, constraint, arbitrary metadata,
   or other semantic that cannot be represented without loss rejects initialization deterministically. Core gains no
   JSON-Schema escape hatch.
6. Invocation translates the exact `ToolInvocation.toolName` and JSON object input to MCP `callTool({ name,
   arguments })`. `ToolManager` remains ahead of the adapter for existence, input validation, the `MUTATING` gate,
   availability, and output-schema validation. The adapter owns no product authorization and has no `ApprovalManager`.
7. Representable structured MCP output is preferred. Text-only content uses one small deterministic adapter-owned
   projection. Binary, image, audio, resource, embedded, malformed, or oversized content fails boundedly and is never
   dumped or coerced. Raw SDK/JSON-RPC errors, stacks, server internals, environment, credentials, and transport details
   never cross `ToolResult`.
8. The adapter uses exactly the six ADR-0076 failure codes. It adds no `TIMEOUT`; adapter timeout or protocol failure
   maps to `EXECUTION_FAILED`, while malformed or unsupported successful output maps to `OUTPUT_INVALID`.
9. The adapter owns an idempotent close/teardown lifecycle behind an injected client-session seam. The official MCP v2
   dependency is adapter-local and exact-pinned as `@modelcontextprotocol/client@2.0.0` (not
   `@modelcontextprotocol/sdk`). Core retains zero MCP dependencies.
10. Production transport activation is deferred. This slice adds no `StdioClientTransport`, child process,
    Streamable HTTP, SSE, network connection, MCP handshake, startup auto-connect, or environment-triggered activation;
    production `TOOL_PROVIDERS` remains empty.
11. `ConnectorProvider` and existing connector implementations remain unchanged; `ConnectorToolBridge` is deferred.
    There is no ConversationRuntime tool integration, ExecutionOrchestrator tool stage, Tool persistence,
    `ToolInvocation` aggregate, `ExecutionReceipt`, schema migration, or parallel approval path in this slice.

### Consequences

M3B-2A can validate real Core/Application/composition behavior offline while faking only the external MCP client-session
boundary. A later separately ratified and authorized slice is required to choose and production-activate any live MCP
transport or expose Tool invocation through ConversationRuntime.

### Implementation compatibility finding — Chief Architect decision required

The exact `@modelcontextprotocol/client@2.0.0` package declares Node `>=20`, while the repository currently permits
Node `>=18.18` and this slice was validated on Node `v18.20.5`. TypeScript compilation and every fake-session offline
test pass because the production-unwired adapter imports the official Client only as a type. A direct offline load of
the official Client on the current Node process fails before construction because `TransformStream` is not globally
defined. Injecting Node 18's `node:stream/web` `TransformStream` makes offline Client construction and close succeed,
but adopting that process-global compatibility shim or raising the repository Node baseline is an Architecture choice,
not a Builder decision. The Chief Architect must ratify one of those directions before any real official-Client runtime
activation. Until then, production transport activation remains blocked and this slice stays fake-session/offline only.

### Relations

Extends ADR-0076 without changing its Core contract. Preserves ADR-0025 plan-scoped Approval ownership, ADR-0032's M3
ConversationRuntime dependency freeze, and ADR-0072's independent ConnectorProvider boundary.

## ADR-0078 — CAP-013 Execution Receipt and Provenance Ownership

- **Status:** ✅ Accepted (M3C-1)
- **Date recorded:** 2026-09-02
- **Authority:** Chief Architect

### Context

The execution ledger records producer-owned operational detail, but consumers need a small durable provenance fact
that does not copy raw execution payload or take ownership from the producing aggregate. M3C-1 introduces CAP-013 for
actual terminal CommandExecution producers while preserving the existing execution and approval boundaries.

### Ratified decisions

1. **D1:** An `ExecutionReceipt` is immutable, durable, and insert-once.
2. **D2:** CAP-013 owns receipt identity, derivation, and persistence; the producer retains ownership of execution.
3. **D3:** Receipts represent only actual terminal executions.
4. **D4:** M3C-1 records no `BLOCKED` receipt and introduces no non-terminal receipt outcome.
5. **D5:** `CommandExecution` is the first and only M3C-1 producer.
6. **D6:** Source identity is the pair `executionKind` plus the canonical producer aggregate id (`sourceId`).
7. **D7:** CAP-013 introduces no generic `executionId`; receipt id remains distinct from source id.
8. **D8:** Authorization records only `NOT_REQUIRED` or `APPROVAL` plus `approvalId`; approval status, approver,
   reason, and decision remain Approval-owned.
9. **D9:** Receipt derivation reloads the canonical producer directly from `StorageProvider`.
10. **D10:** `ExecutionReceiptRepository` is a dedicated insert-once port and does not extend `Repository<T>`.
11. **D11:** SQLite persistence is the forward-only additive migration v8 with uniqueness on producer identity and
    the single execution-plan lookup index.
12. **D12:** Receipt recording composes above capabilities after terminal `CommandExecution` persistence; CAP-007
    and CAP-013 managers do not depend on each other.
13. **D13:** Receipt-recording failure does not roll back or rerun the command and is not a transaction spanning the
    producer and receipt stores. The canonical `CommandExecution.id` is retained for reconciliation.
14. **D14:** A receipt contains no raw execution payload, including command, args, command hash, output, exit code,
    duration, prompt, response, environment, secret, or arbitrary metadata.
15. **D15:** CAP-013 owns no receipt digest and does not treat a producer digest or command hash as receipt identity.
16. **D16:** Actor, WorkItem, ResourceRef, Artifact, Provider, Tool, and other speculative correlation fields are
    excluded.
17. **D17:** `ConversationRuntime` gains no dependency and its dependency count does not increase.
18. **D18:** `ExecutionOrchestrator` may consume the composed command runner but stays aggregate-free and does not own
    receipt state or policy.
19. **D19:** Tool and MCP receipt production is deferred; existing ToolProvider and MCP contracts are unchanged.
20. **D20:** Idempotency is keyed by `(executionKind, sourceId)`; a uniqueness race reloads the existing canonical
    receipt and never updates or upserts it.

### Consequences

M3C-1 adds a minimal queryable provenance record for terminal commands without duplicating their execution payload.
A terminal command remains canonical and reconcilable if receipt persistence fails. Additional producer kinds,
correlation fields, receipt outcomes, retries, event sourcing, and Tool/MCP integration require later ratified slices.

### Relations

Extends ADR-0028's CommandExecution ownership and ADR-0025's plan-scoped approval lineage. Preserves ADR-0031's
aggregate-free ExecutionOrchestrator, ADR-0032's ConversationRuntime dependency freeze, and ADR-0076/ADR-0077 Tool/MCP
deferral.

## ADR-0079 — AgentProfile Identity and Immutable Registry

- **Status:** ✅ Accepted (M3D-1)
- **Date recorded:** 2026-09-02
- **Authority:** Chief Architect

### Context

M3D needs a stable, provider-independent identity for source-controlled agent configuration without turning an agent
persona into an Actor, Provider, execution owner, authority grant, runtime, or persistence aggregate. The first slice
therefore establishes only the configuration value and immutable composition-time lookup boundary.

### Ratified decisions

1. **D1:** `AgentProfile` is a configuration value, not an aggregate or service. Its fields are exactly `id`,
   `displayName`, `role`, `purpose`, and `instructions`.
2. **D2:** `AgentProfileId` is a stable QuirkyBot-owned nominal string identity. It does not reuse `Actor.id`, Provider
   id, Tool source, Session id, Task id, or WorkItem id.
3. **D3:** Agent configuration is config-first and source-controlled. M3D-1 adds no database persistence, repository,
   schema change, migration, refresh, plugin loading, network source, or runtime mutation path; SQLite remains v8.
4. **D4:** The identity grammar is 1–128 characters: an ASCII alphanumeric first character followed only by ASCII
   alphanumerics, `.`, `_`, `:`, or `-`. Text fields must be non-empty after trimming, retain their configured value,
   reject disallowed control characters, and are bounded at 128 characters for `displayName`, 128 for `role`, 1,024
   for `purpose`, and 16,384 for `instructions`.
5. **D5:** `AgentProfileRegistry` validates the complete configured set at construction, defensively copies and freezes
   returned profiles, sorts them lexicographically by id, accepts an empty set, rejects duplicate ids, and fails an
   unknown lookup closed with a bounded deterministic error. It exposes only `get(id)` and `list()`.
6. **D6:** Composition configures an empty registry until profiles are explicitly supplied. There is no default or
   fallback agent.
7. **D7:** Agent is not Actor. WorkItem ownership remains its canonical `actorId` (`Actor.id`); AgentProfile grants no
   identity, permission, approval, risk, or execution authority and owns no WorkItem.
8. **D8:** Agent is not Provider. M3D-1 adds no `providerId`, `modelId`, preferred or allowed Providers, capability or
   required-capability field, routing hint, or Provider selection behavior.
9. **D9:** Agent is not Tool. M3D-1 adds no Tool source or name, `ToolEffect`, tool allow-list, authority setting,
   memory scope, runtime setting, arbitrary metadata, or arbitrary JSON.
10. **D10:** `ConversationRuntime` owns no Agent state, gains no `AgentProfileRegistry` dependency, and retains its
    existing dependency count. `ExecutionOrchestrator`, ToolProvider, ExecutionReceipt, and StorageProvider are
    unchanged.
11. **D11:** M3D-1 introduces no TriggerSource, proactive execution, autonomous loop, sub-agent runtime, or other Agent
    runtime behavior. The registry is configuration lookup only.
12. **D12:** WorkHandoff, WorkHandoffManager, WorkHandoffRepository, any StorageProvider handoff seam, and migration v9
    are deferred to M3D-2 / CAP-014 and require their own architecture decision; this ADR does not predraft it.
13. **D13:** M3E Trigger behavior is deferred and is not implied by the AgentProfile seam.

### Consequences

M3D-1 can identify and retrieve validated agent persona configuration deterministically without changing work
ownership, provider routing, tool authority, persistence, or runtime execution. Any future connection from a profile to
capabilities, prompts, Providers, Tools, memory, authority, handoff, or triggers requires separately bounded architecture
and implementation work.

### Relations

Supersedes ADR-0008's speculative AgentProfile field shape while preserving its configuration-only and no-agent-runtime
principles. Preserves ADR-0031's aggregate-free ExecutionOrchestrator, ADR-0032's ConversationRuntime dependency freeze,
ADR-0075's Actor-owned WorkItem, ADR-0076's Tool boundary, and ADR-0078's ExecutionReceipt ownership.

## ADR-0080 — CAP-014 Work Handoff Durable Provenance

- **Status:** ✅ Accepted (M3D-2)
- **Date recorded:** 2026-09-02
- **Authority:** Chief Architect, Product Decision D18

### Context

M3D needs a durable record that one configured AgentProfile handed bounded work context to another without turning
that record into agent dispatch, receiving-agent execution, workflow state, authority, or WorkItem ownership. The
handoff must correlate existing inputs and outputs by their canonical identities while preserving the owners of those
aggregates.

### Ratified decisions

1. `WorkHandoff` is immutable, durable, and insert-once. Its fields are exactly `id`, required `workItemId`, required
   distinct `fromAgentProfileId` and `toAgentProfileId`, bounded `objective`, `resourceRefs`, `artifactIds`,
   `executionReceiptIds`, and `createdAt`.
2. The objective is trimmed, non-empty, and at most 2,000 characters. Reference collections are defensively copied,
   immutable, deduplicated by existing stable identity, and retain first-input order.
3. A handoff is AgentProfile-to-AgentProfile only. Both configured profiles and the canonical WorkItem must exist;
   source and destination must differ.
4. Artifact and ExecutionReceipt correlations are ids only and must resolve through their existing canonical
   repositories before insertion. ResourceRef remains the provider-independent external-input value of ADR-0074.
5. Correlation transfers no aggregate ownership, permission, approval, execution authority, provider selection,
   Tool authority, lifecycle, or mutation right.
6. `WorkHandoffManager` is the sole narrow creation owner. It does not mutate WorkItem, dispatch an agent, execute a
   Tool or Provider, transition Task, request Approval, manage AgentProfile lifecycle, or own Runtime state. It has no
   ApprovalManager or RiskPolicy dependency.
7. `WorkHandoffRepository` is a dedicated insert-once port with only `insert`, `get`, `listByWorkItem`,
   `listByFromAgent`, and `listByToAgent`. It does not extend the generic repository and exposes no update, save,
   delete, upsert, or generic query.
8. SQLite persistence is the forward-only additive migration v9 with the bounded `work_handoffs` columns and lookup
   indexes for WorkItem, source profile, and destination profile. AgentProfile remains source-controlled configuration
   and gains no persistence table.
9. Composition may inject `AgentProfileRegistry` into `WorkHandoffManager`. `ConversationRuntime` gains no dependency,
   retains its accepted dependency count of 31, and owns no handoff behavior.
10. `ExecutionOrchestrator`, ToolProvider, Provider routing, Approval, ExecutionReceipt production, and existing
    WorkItem lifecycle remain unchanged. TriggerSource, proactive/background execution, autonomous loops, agent
    dispatch, and receiving-agent execution are deferred.

### Consequences

Consumers can query durable, bounded handoff provenance without creating a workflow engine or granting an AgentProfile
runtime authority. A later separately ratified slice is required to act on a handoff, dispatch or execute an agent, or
connect handoffs to ConversationRuntime or triggers.

### Relations

Extends ADR-0079's configuration-only AgentProfile identity and ADR-0075's Actor-owned WorkItem. Preserves ADR-0074's
Resource/Artifact separation, ADR-0078's ExecutionReceipt ownership, ADR-0031's aggregate-free ExecutionOrchestrator,
and ADR-0032's ConversationRuntime dependency freeze.

## ADR-0081 — Trigger Provenance and Proactive Work Decision Foundation

- **Status:** ✅ Accepted (M3E-1)
- **Date recorded:** 2026-09-03
- **Authority:** Product Owner ratification of Chief Architect decisions D1–D15

### Context

M3E needs a bounded way to record why existing work was considered for proactive continuation before any scheduler,
background runtime, agent dispatch, or execution behavior is introduced. A trigger observation must not itself become
authority, approval, execution permission, durable workflow state, or a second owner of WorkItem lifecycle.

### Ratified decisions D1–D15

1. **D1:** `TriggerSource` is an immutable Core domain value describing application-level trigger provenance. It is
   not a port, provider, aggregate, event, scheduler, queue message, or durable record.
2. **D2:** The only M3E-1 kind is `INTERNAL_CONTINUATION`. Unsupported, absent, or malformed kinds fail closed.
3. **D3:** Its fields are exactly `kind`, bounded `provenanceId`, and supplied `observedAt`. `provenanceId` is the
   stable correlation identity of the observation and does not become WorkItem, Actor, AgentProfile, Provider, Tool,
   Session, Task, Approval, or Execution identity.
4. **D4:** `provenanceId` uses the deterministic 1–128 character QuirkyBot-owned identity grammar: an ASCII
   alphanumeric first character followed only by ASCII alphanumerics, `.`, `_`, `:`, or `-`.
5. **D5:** `observedAt` is explicit caller input and must be a canonical UTC ISO-8601 timestamp with millisecond
   precision. Evaluation uses no clock, randomness, implicit current time, or generated identity.
6. **D6:** Trigger provenance grants no identity, authority, permission, approval, execution, dispatch, Provider,
   Tool, WorkItem mutation, handoff creation, or scheduling right; each remains `NONE` in M3E-1.
7. **D7:** `ProactiveWorkDecision` is an immutable, non-durable value with exactly `workItemId`, `agentProfileId`,
   `trigger`, `disposition`, and `reason`. It is not an aggregate, receipt, handoff, approval, execution plan, or event.
8. **D8:** Dispositions are exactly `CONTINUE` and `NO_ACTION`. Reasons are exactly `ACTIVE_WORK_ITEM`,
   `WORK_ITEM_COMPLETED`, and `WORK_ITEM_CANCELED`; only their lifecycle-consistent pairings are valid.
9. **D9:** `ProactiveWorkService` is the sole M3E-1 evaluation owner. It canonical-loads an existing WorkItem by id
   through `StorageProvider.workItems.get` and resolves the explicitly supplied `AgentProfileId` through the immutable
   `AgentProfileRegistry`.
10. **D10:** A valid trigger, known profile, and canonical `ACTIVE` WorkItem deterministically produce
    `CONTINUE / ACTIVE_WORK_ITEM`. `COMPLETED` and `CANCELED` produce `NO_ACTION` with their corresponding bounded
    reason.
11. **D11:** Unknown WorkItem, unknown AgentProfile, malformed request, and malformed TriggerSource fail closed with
    bounded deterministic Core errors. No default or fallback WorkItem, AgentProfile, trigger, or outcome exists.
12. **D12:** Evaluation is read-only and side-effect-free. It does not mutate WorkItem, create WorkHandoff, request or
    inspect Approval, execute or dispatch work, invoke Tool or Provider, route a Provider, or persist the decision.
13. **D13:** The service depends only on the existing smallest WorkItem read seam and AgentProfileRegistry. It has no
    dependency on `ApprovalManager`, `ExecutionOrchestrator`, `AiProvider`, `ToolProvider`, provider routing, queue,
    scheduler, clock, id generator, or concrete adapter.
14. **D14:** M3E-1 introduces no TriggerProvider port, adapter, caller, runtime entry point, ConversationRuntime or
    ExecutionOrchestrator change, autonomous loop, background runtime, schema, migration, SQLite fixture, or durable
    write path. The accepted ConversationRuntime dependency baseline remains exactly 31.
15. **D15:** Future scheduling, trigger ingestion, agent dispatch/execution, handoff continuation, persistence, and
    runtime exposure require separately ratified and bounded slices. M3E-1 authorizes only this decision foundation.

### Validation boundary

`E2E = NOT_APPLICABLE` — M3E-1 is a pure read-only application decision foundation with no runtime entry point or
durable write path.

### Consequences

Core can make one deterministic, inspectable decision about whether already-active work is eligible for continuation
without implying that continuation has been approved or executed. Later M3E slices can introduce concrete trigger or
runtime behavior only behind a separately ratified boundary, while this value remains provider- and platform-neutral.

### Relations

Implements the M3E decision foundation anticipated by ADR-0079 and ADR-0080 while preserving ADR-0075 WorkItem
ownership, ADR-0025 Approval ownership, ADR-0031's aggregate-free ExecutionOrchestrator, and ADR-0032's exact
ConversationRuntime dependency baseline. It supersedes the earlier rebaseline placeholder that described ADR-0081 as
a definition-only `TriggerSource` port: M3E-1 defines a domain provenance value and no trigger-provider port.

## ADR-0082 — Proactive Delegation and WorkHandoff Application Integration

- **Status:** ✅ Accepted (M3E-2)
- **Date recorded:** 2026-09-04
- **Authority:** Chief Architect / Product Owner verified gate resolution

### Context

M3E needs one bounded application path that can decide whether an existing active WorkItem is eligible for an explicit
AgentProfile-to-AgentProfile delegation and, in a separate durable stage, record CAP-014 provenance. The path must not
turn eligibility into authority, mutate the WorkItem, dispatch the destination agent, or widen Runtime, Approval,
execution, Provider, Tool, or persistence ownership.

### Ratified decisions D1–D16

1. **D1:** `ProactiveDelegationDecision` is a public immutable, non-durable Core value distinct from
   `ProactiveWorkDecision`; the latter remains unchanged and gains no `DELEGATE` disposition.
2. **D2:** Delegation dispositions are exactly `DELEGATE` and `NO_ACTION`. Reasons are exactly
   `DELEGATABLE_ACTIVE_WORK_ITEM`, `WORK_ITEM_COMPLETED`, and `WORK_ITEM_CANCELED`, with only lifecycle-consistent
   pairings accepted.
3. **D3:** One bounded request carries `trigger`, `workItemId`, `fromAgentProfileId`, `toAgentProfileId`, `objective`,
   caller-supplied `handoffId`, caller-supplied `createdAt`, and optional `resourceRefs`, `artifactIds`, and
   `executionReceiptIds`. It does not duplicate the `WorkHandoff` aggregate.
4. **D4:** `ProactiveDelegationService.evaluate` is pure and read-only. It validates the request and TriggerSource,
   canonical-loads the WorkItem, resolves both profiles, and returns only an eligibility decision.
5. **D5:** Only canonical `ACTIVE` work is delegatable. `COMPLETED` and `CANCELED` return `NO_ACTION`; unknown or
   malformed input, unknown profiles, and identical source/destination profiles fail closed.
6. **D6:** `record` is a separate durable-effect stage. It revalidates canonical eligibility immediately before
   invoking CAP-014 and treats no earlier decision as an authority token.
7. **D7:** Record-time stale `ACTIVE` to `COMPLETED` or `CANCELED` state fails closed with zero WorkHandoff writes.
8. **D8:** `WorkHandoffManager` remains the canonical CAP-014 validation and persistence owner. The proactive service
   depends on it directly and does not depend on `ProactiveWorkService`.
9. **D9:** CAP-014 adds the bounded `recordIdempotent` operation while preserving existing `create` insert-once
   behavior. No UPDATE, overwrite, generic UPSERT, table, schema, migration, or persistence owner is added.
10. **D10:** A missing `handoffId` inserts once; an existing id with exactly equal canonical durable payload returns
    the persisted value with zero write; an existing id with differing payload fails closed with
    `WORK_HANDOFF_IDEMPOTENCY_CONFLICT`.
11. **D11:** Exact semantic equality includes id, WorkItem, both AgentProfiles, objective, all three reference
    collections, and `createdAt`. It is neither partial nor fuzzy.
12. **D12:** A concurrent uniqueness collision is reconciled by re-reading the canonical handoff: exact equality
    returns it and any difference fails closed. Domain semantic comparison remains in `WorkHandoffManager`.
13. **D13:** Different `handoffId` values remain legitimate distinct delegation records; no uniqueness is introduced
    on WorkItem or AgentProfile correlations.
14. **D14:** WorkItem mutation, ApprovalManager, ExecutionOrchestrator, Provider, Tool, agent dispatch, and destination
    Agent execution remain zero. A handoff grants no authority or execution permission.
15. **D15:** `ConversationRuntime` and its accepted dependency count of 31 remain unchanged. There is no production
    caller, new capability, TriggerRecord, scheduler, queue, background runtime, or runtime wiring.
16. **D16:** SQLite remains schema v9. Local E2E uses only isolated ephemeral SQLite and exercises real migrations,
    repositories, registries, managers, evaluate/record separation, durable reload, and bounded correlation queries;
    executing that DB-mutating test remains a separate Human gate.

### Consequences

Core can distinguish read-only delegation eligibility from an idempotent durable provenance effect without creating an
agent runtime or widening authority. A later separately ratified slice is required to dispatch or execute the receiving
agent, create a production caller, or integrate this behavior into ConversationRuntime.

### Relations

Extends ADR-0081's trigger and read-only decision foundation and ADR-0080's CAP-014 provenance aggregate. Preserves
ADR-0075 WorkItem ownership, ADR-0025 Approval ownership, ADR-0031's aggregate-free ExecutionOrchestrator, and
ADR-0032's exact ConversationRuntime dependency baseline.


## ADR-0083 — WorkHandoff Consumption Eligibility Decision

- **Status:** Ratified
- **Ratification:** Chief Architect ratification applies to the independently reviewed M3E-3 implementation at
  `5ef1c26d065b20bb14684d1f272264af13fabc26` (Claude review: PASS, no blocking findings), as confirmed by the
  Product Owner's Direct CLI close-out Sprint instruction. The substantive architecture contract is unchanged.
- **Date:** 2026-09-20

### Context

ADR-0082 produces durable handoff provenance but does not interpret it for continuation eligibility.
M3E-3 authorizes a read-only consumption decision while preserving ARCHITECTURE.md sections 3 and 8,
ADR-0080 creation ownership, and the execution boundary.

### Decision

`WorkHandoffConsumptionService.evaluate(handoffId)` canonical-loads the durable handoff, its referenced
WorkItem, and both configured AgentProfiles through existing read seams. The request supplies only the
handoff identity; callers cannot supply a stale aggregate or substitute a receiving profile.

The immutable, non-durable result contains exactly `handoffId`, `workItemId`, `fromAgentProfileId`,
`toAgentProfileId`, `disposition`, and `reason`. ACTIVE maps to CONTINUE / ACTIVE_WORK_ITEM;
COMPLETED and CANCELED map to NO_ACTION / WORK_ITEM_COMPLETED and WORK_ITEM_CANCELED respectively.
Unknown lifecycle values fail closed rather than being treated as cancellation.

Identity validation preserves the existing durable handoff contract of canonical non-empty text;
it does not retroactively impose the proactive producer's narrower caller-supplied ID grammar.
Malformed requests or handoff payloads, absent handoffs or WorkItems, unresolved source/destination
profiles, and mismatched repository lookup identities fail with bounded `WorkHandoffConsumptionError`
codes. Infrastructure exceptions propagate without a decision. Existing domain handoff validation
checks profile separation and reference shape. Artifact and receipt correlation ownership stays with
the creation owner; consumption does not re-resolve those correlations or interpret them as authority.

The result is a snapshot of observed canonical state, not an atomic lease or an authority token.
Repeated calls reread current state and perform zero writes. WorkHandoffManager remains the sole
creation/idempotency owner and gains no consumption behavior. No schema or migration is added: SQLite
stays at v9. Production wiring, capabilities, ExecutionOrchestrator, and ConversationRuntime remain
unchanged; the accepted Runtime dependency baseline is 31.

### Consequences

Eligibility can be inspected deterministically without executing continuation. CONTINUE grants no
agent dispatch, receiving-agent execution, Provider or tool execution, WorkItem mutation, approval,
ConversationRuntime execution, or user-facing continuation. Claim/lease/acknowledgement, retry engines,
schedulers/triggers, autonomous loops, and production callers remain outside this slice.

Offline validation composes real Core application services, registry, managers, repositories, and
migrations against mkdtemp SQLite, including durable produce/reopen/consume and terminal NO_ACTION.
No external boundary is constructed. Ephemeral test DB execution is authorized by this task handoff.

### V1 / V2

[NOW] Bounded unwired eligibility service. [LATER] Dispatch, execution, scheduling and runtime integration
require a separately authorized architectural slice. The next delivery boundary is independent Claude
exact-HEAD review of the documentation close-out commit; publication, PR and merge remain separately
authorized steps.


## ADR-0084 — WorkHandoff Continuation Admission and TaskRun Binding

- **Status:** Ratified
- **Date:** 2026-09-21
- **Ratified implementation HEAD:** `825e97e89745eb5942090299ab3cafe5612edc5d`
- **Independent Review:** PASS_WITH_NON_BLOCKING_FINDINGS; **Blocking Findings:** 0
- **Independent Architecture Review:** ADR_0084_READY_FOR_CHIEF_ARCHITECT_RATIFICATION
- **Chief Architect Ratification:** APPROVED, as confirmed by the Product Owner's M3E-4 ratification
  close-out instruction. The substantive architecture contract is unchanged.

### Context

M3E-3 is delivered through PR #58 at main `618b5afcc6079be956d3756f9281506907571dde`.
TaskRun already denotes one execution attempt, and TaskManager.startRun records STARTED with startedAt.
Creating a run merely to reserve an identity would misrepresent execution. Task is conversation-anchored;
WorkItem is durable personal work and must not acquire execution ownership. CAP-013 already owns receipts.

### Decision

Use an immutable continuation binding (Option B) plus existing TaskRun.taskId (Option C). Admission accepts
only handoffId and an EXISTING Task id, never a prior CONTINUE decision. It creates no Task and no TaskRun.
One handoff binds to exactly one Task, and one Task to exactly one handoff. The binding has only handoffId,
taskId and recordedAt; WorkItem and destination AgentProfile are resolved from immutable WorkHandoff.
TaskRun.id remains the sole attempt identity. resolveRun(handoffId, taskRunId) is a read-only exact-id
provenance lookup that verifies the run belongs to the bound Task. It never chooses a latest run, starts,
claims or authorizes one. Multiple legitimate future attempts belong to the same continuation through
TaskRun.taskId; there is no second attempt identifier or mutable run pointer in the binding.

WorkHandoffContinuationService owns admission and read-only correlation. It re-evaluates M3E-3 eligibility,
loads canonical handoff, WorkItem and Task, validates both profiles, and requires ACTIVE work, a PENDING
Task with matching Actor and optional Project, and no existing TaskRuns for initial admission. It never
fabricates conversation context. A terminal WorkItem returns NO_ACTION without writes, including replay.
Missing, malformed, unknown or inconsistent state fails closed. Existing bindings can be read for historical
provenance after completion, but replay admission still requires current eligible/PENDING state.

A dedicated ContinuationBindingRepository port performs atomic compare-and-insert: under the storage
transaction it rechecks exact handoff/WorkItem/Task snapshots and absence of runs for initial admission.
Concurrent changed state is STALE_STATE. Matching handoff/task replay returns the original immutable record;
a different task for the same handoff or a different handoff for the same task is CONFLICT. Unique keys enforce
both directions. A rejected operation leaves no partial write. Snapshot comparison covers complete persisted
values, not only updatedAt; timestamps alone are not treated as revision tokens. Profiles are immutable
composition-time configuration. No old decision object can create a binding or attach a newer run.

SQLite v10 is additive: one continuation_bindings table with handoff primary key, unique task id and timestamp.
There is no generic save/update/delete port and no workflow, worker, lease, receipt or execution state.
The dedicated port is injected explicitly; StorageProvider and runtime composition remain unchanged.

### TaskRun concurrency

M3E-4 creates zero TaskRuns, so it does not expose concurrent attempt allocation. Existing startRun uses
listByTask.length + 1 and is NOT safe for future concurrent/autonomous execution. Before enabling that path,
TaskManager/repository must gain atomic attempt allocation or storage-enforced uniqueness with fail-closed
handling. This slice adds no speculative TaskRun lifecycle or migration. Future execution must separately
validate current work/task state and existing Approval requirements; a binding or resolved run is never authority.

### Canonical status synchronization

ARCHITECTURE concept labels reflect already accepted ADR-0075 (WorkItem), ADR-0078 (ExecutionReceipt),
ADR-0079 (configuration-only AgentProfile), ADR-0080 (WorkHandoff), ADR-0081/0082 (bounded trigger/delegation)
and Ratified ADR-0083 (read-only consumption). The old AgentProfile speculative fields are superseded by
ADR-0079's exact id/displayName/role/purpose/instructions configuration. No runtime/agent-loop status is promoted.
ROADMAP and CURRENT_STATE reflect delivered M3D/M3E foundations and PR #58, not retroactive new architecture.

### Consequences

Restart-safe handoff → Task → exact TaskRun provenance is possible with no attempt or receipt duplication.
Callers must provide a canonically created Task with real conversation context; this slice does not synthesize
one from a WorkItem. The cost is one narrow durable relation and an atomic persistence contract. Admission is
not dispatch, a lease, acknowledgement, receipt, approval or permission. WorkHandoffManager, WorkItem ownership,
CAP-013 producer kinds/COMMAND, AgentProfile configuration, ConversationRuntime and ExecutionOrchestrator stay
unchanged. Ephemeral SQLite tests cover persistence, races, stale state and exact replay; no live DB is used.

### V1 / V2

[NOW] Locally complete, independently reviewed admission/binding implementation with ratified architecture.
M3E-4 was delivered through PR #59 at main `285f3663beff5334419e8ddf967855b440df8a5e`.
[LATER] Actual receiving-agent execution, TaskRun creation for continuations, concurrency hardening,
runtime wiring, retries, schedulers and loops require separate approval. No execution authority is introduced by M3E-4.


## ADR-0085 — Atomic TaskRun Start and Attempt Allocation

- **Status:** Ratified
- **Date:** 2026-09-21
- **Ratified implementation HEAD:** `ff12ffa73e68ffc810b4a7d9698c219a378cc382`
- **Independent Review:** PASS_WITH_NON_BLOCKING_FINDINGS; **Blocking Findings:** 0
- **Independent Architecture Review:** ADR_0085_READY_FOR_CHIEF_ARCHITECT_RATIFICATION
- **Chief Architect Ratification:** APPROVED, as confirmed by the Product Owner's M3E-5 ratification
  close-out instruction. The substantive architecture contract is unchanged.

### Context

M3E-4 is delivered through PR #59. TaskRun is already the canonical attempt identity. The only Product
startRun caller, ConversationRuntime, persists PENDING → PLANNING → RUNNING before starting a run.
TaskManager currently allocates listByTask.length + 1 outside storage, allowing collisions and reuse of gaps.

### Decision

Keep TaskManager.startRun(task, capability) and TaskRun unchanged. Strengthen TaskRunRepository with
start(task, capability): atomic canonical Task snapshot validation, attempt allocation and insert. Only a
canonical RUNNING Task may cross this boundary, preserving the existing Product caller's lifecycle. A missing,
stale, invented or non-RUNNING Task fails closed. Capability must be a known Capability; no new routing policy
or approval is inferred. Each invocation is a distinct attempt, not request idempotency.

SQLite uses a bounded-wait IMMEDIATE transaction. It compares the complete persisted Task with the supplied
snapshot, computes MAX(attempt) + 1 (or 1), generates TaskRun.id using shared newId and startedAt using shared
now inside the transaction, and inserts STARTED. Commit establishes the canonical attempt start fact, not
Provider dispatch or external-effect authority. There is no reservation, retry loop, task transition or run reuse.
An exhausted safe-integer ordinal fails closed with no write.

Additive v11 validates existing task_runs JSON identity and positive safe-integer attempts before installing a
unique expression index on (task_id, json_extract(data, '$.attempt')). No columns or historical values are rewritten.
Malformed identities/ordinals and duplicate historical ordinals abort migration transactionally at v10 without
renumbering. Insert/update triggers enforce the same identity/ordinal validity; update additionally protects
id/taskId/attempt/startedAt/capability against mutation. Existing save remains compatible for explicit valid
historical inserts and completeRun/failRun updates; it cannot change an existing start identity. No destructive
rebuild or parallel attempt aggregate is introduced. Terminal update conflict/version policy is unchanged.

### Consequences

Independent SQLite connections/processes allocate distinct ordinals without lost inserts; the DB uniqueness
invariant also applies to ordinary repository saves. The run's id is canonical identity; its ordinal is local to
its Task. A failed transaction leaves no partial run. Allocation uses the greatest persisted ordinal rather than
row count. Existing generic deletion semantics are unchanged; deleted history is not reconstructed, and callers
must retain run history if lifetime ordinal monotonicity across deletions is required.

Core has no SQLite dependency. ContinuationBinding remains provenance only and gains no run-start caller.
CAP-013, WorkItem, WorkHandoff, Approval and Provider/Tool authority are unchanged. No runtime integration,
scheduler, leases, worker ownership, retries, receipt producer extension or autonomous execution is added.
Real disposable SQLite worker concurrency and migration rollback tests are required, alongside completion/failure
and M3E-4 regression coverage. No shared/live DB is migrated in this Sprint.

### V1 / V2

[NOW] Ratified atomic start foundation, locally complete and independently reviewed at
`ff12ffa73e68ffc810b4a7d9698c219a378cc382`; no Push/PR/Merge is claimed. [LATER] Run-scoped execution authority,
continuation execution, idempotent start-request keys and autonomous runtimes require separate decisions.


**ADR-0085 delivery update (2026-09-21):** M3E-5 was delivered through PR #60 at main
`bef459aaf3a77549dd44760a21ea839073b0cb46`. ADR-0085 remains Ratified; schema is v11.
The local-only V1/V2 statement above records the pre-delivery checkpoint. This update supersedes
that delivery status only; continuation execution and runtime authority remain deferred.

---

## ADR-0086 — Quoky Platform Product Identity and Namespace Migration

- **Status:** Ratified
- **Date:** 2026-09-21
- **Ratified implementation HEAD:** `34f911174429385ca3b954df2cc0ddc7888a3230`
- **Independent Review:** PASS_WITH_NON_BLOCKING_FINDINGS
- **Blocking Findings:** 0
- **Chief Architect Ratification:** APPROVED (confirmed by the Product Owner's close-out instruction)
- **Remediation required before delivery:** NO

### Context

The Product Owner authorized this bounded local implementation following the architecture/naming audit.
The Product spans Conversation, Memory, WorkItem, WorkHandoff, Task/TaskRun, Approval, Workspace/Git,
Command execution, Tool/MCP, Resource/Connectors, Provider routing and execution provenance, with
receiving-agent execution still deferred. Discord and concrete AI providers are replaceable adapters
(ARCHITECTURE.md §§1–3), so bot/model-serving branding understates its scope.
ADR-0061 Q9 already introduced @quoky/github-app-auth and QUOKY configuration while deferring legacy migration.
Workspace import identities require independent review and Chief Architect acceptance before delivery.
Implementation authorization does not ratify this ADR.

### Decision

Use **Quoky Platform** as the canonical Product name, **Quoky** as the short name, `@quoky/*` as
workspace scope, `apps/quoky` as composition root, and `quoky-platform` as the private root package.
The descriptive tagline is “Local-first Personal AI & Work Automation Platform”. Keep the existing
@quoky/github-app-auth identity. Rename current Product symbols and active imports/build/test references.
Do not add package aliases for the old private workspace scope; all in-repository consumers migrate together.

For GITHUB_OWNER/REPO/TOKEN, DB_PATH, VECTOR_PATH, WORKSPACE_ROOT, JIRA_BASE_URL/EMAIL/TOKEN,
SLACK_TOKEN and CONFLUENCE_BASE_URL/TOKEN, prefer QUOKY_* over the corresponding CHUNSIK_* alias.
Use nullish precedence: an explicitly empty canonical value wins, and omitting both preserves existing defaults.
Keep existing QUOKY-only settings. GitHub App versus dev-only PAT selection and production rejection rules
remain unchanged; resolving an alias grants no authentication or execution authority.

Preserve `./data/chunsik.db`, `.chunsik/context.md`, `.chunsik/task.md`, `.chunsik-tmp`, existing
persisted identifiers/metadata/receipts, and security-sensitive temporary-path contracts. No schema or data migration.
Preserve historical ADR Context, Sprint/review/checkpoint/release evidence. Use migration notes for old names
inside historical inventories. The physical `chunsik-bot-2` directory, GitHub `chunsik-bot` repository, remotes
and absolute external paths remain unchanged. Historical Quoky development control-plane remains FROZEN;
it is distinct from Quoky Platform and is not used by this migration.

### Consequences

- One active namespace makes new implementation and the Product entry document consistent.
- Private workspace imports and the application path change together; external consumers require follow-up.
- README describes implemented, partial, foundation and deferred capabilities and links canonical authorities.
- Offline lockfile/link validation, focused alias/wiring tests, typecheck and build are required.
- Historical references and compatibility paths intentionally retain older names; global replacement is invalid.
- Governance ACTIVE_MILESTONE=M2 versus current M3 is left for its semantic owner in a separate correction.
- Local folder/GitHub renames require a separate external-boundary step after source delivery.

### V1 / V2

[NOW] Bounded local source identity migration and README modernization are complete locally at the
ratified implementation HEAD above, independently reviewed and accepted by the Chief Architect.
Delivery is NOT YET PUSHED / PR'D / MERGED. Hexagonal dependencies, domain/approval/execution/TaskRun
semantics, Provider authority and runtime activation are unchanged. M3E-5 delivery is synchronized without changing ADR-0085.
[LATER] Execution Admission requires a subsequent ADR number (0087 if still next available); this ADR
neither designs nor approves it. Receiving-agent dispatch, runtime agents and autonomous loops remain deferred.

### Non-blocking review dispositions

- Blank canonical connector variables in `.env.example` can shadow populated legacy aliases under nullish
  precedence: **SEPARATE_POST_DELIVERY_MAINTENANCE**; no configuration remediation in this close-out.
- Outbound User-Agent `chunsik-bot` → `quoky-platform`: **ACCEPTED_INTENTIONAL_BRANDING_CHANGE**.
- User-visible PR/approval copy uses Quoky Platform: **ACCEPTED_INTENTIONAL_BRANDING_CHANGE**.
- Governance milestone M2 versus current M3: **SEPARATE_GOVERNANCE_FOLLOWUP**; unchanged here.


---

## ADR-0087 — Continuation Execution Admission

- **Status:** Ratified
- **Reviewed architecture HEAD:** `90a67de840df71db2872b2a15e49c0efd117e93f`
- **Independent exact-HEAD Architecture Review:** PASS_WITH_NON_BLOCKING_FINDINGS
- **ADR_0087_READY_FOR_CA_RATIFICATION:** YES
- **Chief Architect Ratification:** APPROVED, as confirmed by the Product Owner's ratification closeout
  instruction. The substantive architecture contract is unchanged.
- **Date:** 2026-09-21
- **Audit base:** `8dd6251da676bf33032a273d9044284d98bf1489`
- **Sprint:** M3E-6A, architecture/ADR only. M3E-6 implementation: **NOT STARTED**.

### Context

ADR-0083 separates continuation eligibility from authority; ADR-0084 records immutable handoff/Task
correlation; ADR-0085 makes TaskRun start and ordinal allocation atomic. None authorizes a receiving agent.
ARCHITECTURE.md §§2–4, 10–12 require inward dependencies, existing capability ownership and approval at
external-effect boundaries. ADR-0086 changes identity only. This decision does not amend those invariants.

#### Codebase audit and provenance versus authority

Paths below are relative to the repository; these are implementation observations at the audit base.

| Concept / inspected source | Existing ownership and meaning |
|---|---|
| `packages/core/src/domain/work-item.ts`, `application/work-manager.ts` | `WorkManager` owns Actor-owned durable work lifecycle: ACTIVE → COMPLETED/CANCELED. Not Task lifecycle or permission. |
| `packages/core/src/domain/work-handoff.ts`, `application/work-handoff-manager.ts` | `WorkHandoffManager` validates and inserts immutable profile-to-profile provenance. No revocation/current-handoff pointer or execution grant exists. |
| `packages/core/src/application/work-handoff-consumption-service.ts` | `WorkHandoffConsumptionService.evaluate` returns ephemeral `WorkHandoffConsumptionDecision`: CONTINUE or terminal NO_ACTION. It reads work and both profiles; no state or authority is acquired. |
| `packages/core/src/domain/continuation-binding.ts`, `application/work-handoff-continuation-service.ts`, `ports/continuation-binding.port.ts` | `WorkHandoffContinuationService.admit` binds an existing PENDING Task; `resolveRun` proves exact-id historical correlation only. `ContinuationBindingRepository.admit` is atomic provenance insertion, not execution admission. |
| `packages/core/src/domain/task.ts`, `application/task-manager.ts` | `TaskManager` owns Task and TaskRun lifecycle. Task is conversation-anchored; TaskRun.id identifies one actual attempt. `transition` checks its supplied Task then saves; it is not a canonical compare-and-set. `completeRun`/`failRun` likewise do not implement conflict arbitration. |
| `packages/core/src/ports/storage-provider.port.ts`, `packages/storage-sqlite/src/index.ts` (`SqliteTaskRunRepository.start`) | `TaskManager.startRun` delegates to `TaskRunRepository.start`: exact canonical RUNNING Task comparison, ordinal allocation and STARTED insertion in one transaction. It does not check WorkItem, binding, Approval, outstanding runs or request replay. Two starts with the same Task can create two valid runs. |
| `packages/storage-sqlite/src/continuation-binding-repository.ts` | Atomic full-snapshot comparison of handoff/work/Task plus one-to-one binding uniqueness. Initial insertion requires no runs. This PENDING-only boundary cannot be reused to start a RUNNING Task. |
| `packages/core/src/domain/approval.ts`, `application/approval-manager.ts`, `application/approval-policy.ts`, `ports/storage-provider.port.ts` | `ApprovalManager` alone mutates persisted `ApprovalRequest`, via `ApprovalRepository`; `ApprovalPolicy` uses RiskPolicy. Authority is scoped to `ExecutionPlanRef`, not a profile or TaskRun. `isApproved(planId)` means any approved request and is insufficient for exact approval selection. |
| `packages/core/src/domain/execution-plan.ts`, `domain/enums.ts` | ExecutionPlan is in-memory; its Ref may carry integrity. Approval statuses are PENDING/APPROVED/REJECTED. There is no persisted expiry or revocation lifecycle; policy `expiresAt` is reserved and not enforced. Task.planId is not proof of an exact CAP-003 plan's contents. |
| `packages/core/src/domain/agent-profile.ts`, `application/agent-profile-registry.ts` | `AgentProfileRegistry` freezes composition-time configuration. Profile identity/instructions confer neither Actor authority nor runtime permission. |
| `packages/core/src/domain/execution-receipt.ts`, `application/execution-receipt-manager.ts` | `ExecutionReceiptManager` derives CAP-013 terminal COMMAND provenance; `CommandExecutionReceiptRunner` composes command then receipt. A receipt is not approval or a generic run acknowledgement. |
| `packages/core/src/application/execution-orchestrator.ts` | `ExecutionOrchestrator` is stateless intra-task capability sequencing, threading plan/approval refs and stopping on denial/failure. It owns no aggregate, TaskRun or cross-task runtime. It is a composition precedent, not the continuation authority owner. |
| `packages/core/src/application/conversation-runtime.ts` (`handleWorkTurn`) | Current work path makes legal PENDING → PLANNING → RUNNING transitions, starts a run, then prepares context/workspace and calls a provider. Thus STARTED precedes provider invocation but already denotes an actual attempt. It is not receiving-agent execution. |
| `apps/quoky/src/app.module.ts` | Composition root wires managers/orchestrator. Consumption/continuation execution is not wired. Wiring is not Product policy. |

### Decision

Select **Option B — Core Application Admission Service**, with **Option A — a small pure policy** where
useful. Admission owner: `ContinuationExecutionAdmissionService` in `packages/core/src/application`
(implemented as the read-only evaluator described in the M3E-6B update below). Compose narrow views of existing repositories/managers;
retain WorkManager, TaskManager, ApprovalManager and CAP-013 ownership. Add **no aggregate, repository,
schema, durable admission state machine or receipt**.

This is sufficient for a bounded admission assessment with fail-closed restart semantics. It is **not**
evidence that today's unchanged repository methods provide an atomic execution-authorization boundary.
The concrete start/check race below requires strengthening the existing owner contract before future
receiving-agent activation. Adding an admission row would not repair that race.

#### What admission authorizes

| Boundary | Meaning and authority |
|---|---|
| 1. Continuation eligibility | ACTIVE canonical work and valid handoff/profile relationships permit further consideration. Old CONTINUE values grant nothing. |
| 2. Task lifecycle eligibility | The bound Task has valid Actor/Project/conversation relationships and a legal lifecycle path. Only TaskManager performs transitions. PENDING is not executable; RUNNING alone is not a permission. |
| 3. TaskRun creation/start | Only TaskManager through the canonical atomic start contract may begin an actual attempt. Admission assessment neither creates a run nor reserves an id. |
| 4. Receiving-agent entry | A fresh exact-run assessment is a necessary continuation-specific gate for one immediate entry within the owning live attempt. It is not a transferable invocation token. The future execution owner must prove it started this exact run in this invocation and satisfy the atomicity/pre-effect conditions below. M3E-6 does not expose or invoke that path. |
| 5. Provider/tool/command | Admission conveys no capability permission, standing tool permission or provider selection. Existing capability policies and Approval still apply to each requested operation. |
| 6. External effects | Workspace/Git/network/Discord and other effects retain their own exact-scope approval and effect-time gates. Admission never replaces them. |

The composition contributes canonical relationship validation, current lifecycle/approval evaluation,
explicit denial reasons, and an exact TaskRun correlation for the current attempt. It owns no lifecycle.
Do not return a generic `executeAllowed` boolean. Conceptual outcomes distinguish NO_ACTION (terminal work),
BLOCKED (missing, inconsistent, stale or unsupported authority), pre-start eligibility (no run authority),
and exact-run admission assessment. A positive assessment carries at least handoffId, workItemId, taskId,
taskRunId, destinationAgentProfileId, capability and the exact plan/approval references where applicable.
It is an ephemeral read result, not a bearer credential, claim, receipt or restart checkpoint.

Inputs identify canonical entities; they do not accept prior decisions as authority. A caller-supplied
TaskRun.id is only a lookup key. An exact-run result uses `taskRuns.get(taskRunId)` and requires returned
id equality, `run.taskId === binding.taskId`, valid immutable start identity and STARTED status. An
externally supplied STARTED id cannot establish ownership of a live invocation. Terminal runs support
historical correlation only. `resolveRun` alone is not admission.

Never select the latest run, highest attempt, inferred current run, most recent STARTED run or MAX(attempt)
as authority. ADR-0085's MAX(attempt) allocation is an ordinal implementation detail, never run selection.
Future downstream entry receives the exact id returned by its own TaskManager.startRun, threaded unchanged
through the live call chain and checked against the canonical row. It never rediscovers an id from Task.

#### Effect-time revalidation

Rebuild facts immediately before authoritative attempt start, then recheck before receiving-agent entry
and before each separately governed effect. Any wait, asynchronous gap, plan change, restart or retry
invalidates prior assessments. An assessment is valid only as a point-in-time observation, with no TTL
or promise that later effects remain authorized.

- Reload and validate the exact WorkHandoff and its WorkItem relation. “Current” means this canonical
  immutable record is valid and actionable through current work/profile relationships; no latest-handoff,
  consumed flag or invented revocation field exists. Missing/corrupt/inconsistent records fail closed.
- Reload ContinuationBinding and require the exact handoff/Task pair. Do not rebind or create a replacement.
- Require canonical WorkItem ACTIVE, matching Task Actor and optional Project, valid conversation context,
  and the same intended continuation. Binding proves identity, not unchanged Task content. Changes to
  intent, capability, context, workspace or plan require fresh evaluation; do not compare against an
  invented historical Task snapshot in ContinuationBinding.
- Require the canonical Task to permit the current phase. Use TaskManager's legal transitions, including
  FAILED → PLANNING for a separately requested new attempt. RUNNING is required at start and immediate entry.
  Compare full persisted snapshots for in-flight stale detection, not updatedAt alone.
- Resolve both profiles from the current immutable registry, especially the destination; do not transfer
  an old process's configuration assumptions across restart or infer runtime availability from a profile.
- Determine approval requirements through existing policy/owners for the exact intended operation/plan.
  Where required, load the selected ApprovalRequest by exact id and require APPROVED with matching
  ExecutionPlanRef (including integrity where that contract requires it). Neither any-approved-for-plan
  lookup, a cached ApprovalRef, Task.planId, nor a handoff's receipt references substitutes for this check.
  Reconstructed scope must be verifiable; a lost in-memory plan is not reconstructed from its id alone.
- An explicit expiry requirement cannot currently be proved by ApprovalManager. Deny unsupported/expired
  authority rather than invent an expiry field or assume indefinite validity for that requirement. Future
  expiry/revocation behavior belongs to Approval under its own approved change, never to admission.
- After actual start, validate the exact returned TaskRun and capability, its relationship to Task and
  binding, and the owning live invocation. Missing, terminal, conflicting or ambiguous runs cannot invoke.

A prior eligibility decision can become stale through work completion, Task mutation, plan/approval change
or configuration replacement; persistence of provenance does not preserve execution authority.

#### Ordering and the meaning of STARTED

1. Read/evaluate pre-start facts without writes, run creation or reservation. Planning and required approval
   preparation stay with existing owners. Pre-start evaluation has no exact run id and cannot authorize entry.
2. A separately authorized future execution owner enters an actual synchronous attempt path, resolves
   prerequisites and uses TaskManager for legal lifecycle transitions to RUNNING. Assessment alone must not
   move a Task to RUNNING. There is no queue/wait-for-worker after starting a run.
3. At the real attempt boundary, TaskManager performs guarded atomic start as specified below. The canonical
   commit begins the attempt and returns its exact TaskRun.id. No run is created merely to obtain an id for
   an assessment. M3E-6 admission evaluation can inspect an existing run but cannot manufacture one.
4. Within that same owning invocation, revalidate for the exact run and, only if every gate holds, enter
   the future receiving-agent path once. A returned assessment is not an instruction to another caller to
   dispatch later. Provider/tool/command/external effects retain independent gates.
5. TaskManager records success/failure for that exact attempt and legal Task transitions. A local failure
   or timeout after start but before provider invocation is a real failed attempt, not a reserved run or
   proof that a provider executed. If start never committed, there is no run to complete/fail. Do not roll
   back or erase committed attempt history. CAP-013 records only actual terminal command producers, when
   present; do not create an admission/TaskRun receipt.

M3E-6 implements none of the receiving-agent execution path. A later activation must satisfy this ordering;
it cannot call start merely to make an unwired admission demonstration return an exact id.

#### Atomicity and concurrency: evidence and minimum boundary

There is a concrete race: read ACTIVE work and APPROVED approval → another writer completes work or changes
relevant authority → today's `start(task, capability)` still succeeds because it compares only Task.
A second concurrent start also succeeds with another ordinal. Sequential re-reads or an in-memory decision
cannot close this gap. TaskManager.transition's unchecked save can additionally overwrite a changed Task.

Keep policy in Core and atomic comparison/insertion in the existing persistence owner. Before enabling a
continuation start caller, strengthen the **existing TaskManager / TaskRunRepository start boundary** with
storage-neutral expected canonical facts for the exact handoff, binding, work, RUNNING Task and selected
approval/plan reference when required. Atomically compare the full persisted values, require the Core
eligibility predicates, reject any unresolved STARTED run for this bound Task, and insert the new run with
ADR-0085's allocation in the same transaction. A mismatch returns a bounded stale/conflict failure with no
partial run. This is a required extension of an existing contract, not a new repository or implemented API.
Registry configuration is immutable within the process; it is resolved in Core, not stored in that transaction.
Plan facts must be validated by their owner; storage cannot manufacture a lost plan or interpret policy.

Task lifecycle changes needed by that future caller must likewise compare canonical expected Task through
the existing Task owner/persistence contract, rather than overwriting stale state. This does not create a
second lifecycle owner. Existing M3E-5 start behavior for other callers is not silently changed by this ADR.
A historical assessment needs no write transaction; it must advertise that it is not a dispatch authority.

The start commit is the linearization point for attempt admission. Work/approval changes ordered before
it reject the start; changes after it do not erase history, but must block subsequent entry/effects when
observed by their respective gates. No local transaction can atomically commit a remote invocation. This
decision makes no exactly-once external-effect or instantaneous distributed revocation claim. Any future
requirement for stronger delivery guarantees needs its own architecture before activation.

Another start detected before entry invalidates the continuation assessment; no winner is inferred from
attempt order. All participating continuation writers must use the guarded owner path; generic saves or
legacy start callers must not be able to bypass that activation contract for bound Tasks. Until that is
proved, concurrent receiving-agent execution remains disabled. No lease, heartbeat, worker claim, global
stateVersion, distributed lock, reservation repository or retry engine is required for this bounded design.
The ratified existing-owner contract hardening requires later authorized implementation and concurrency
verification; it is not part of this documentation-only Sprint.

#### Implementation carry-forward — non-blocking review findings

These are M3E-6 implementation requirements, not ADR ratification blockers. Implementation remains
**NOT STARTED**; this closeout neither defines new Product behavior nor activates continuation execution.

1. **Unresolved STARTED predicate:** before activating continuation execution, the implementation slice
   must define the exact canonical predicate for an `unresolved STARTED TaskRun`. It must not remain a
   fuzzy runtime convention; the guarded start conflict check must use that explicit predicate.
2. **Start-contract bypass closure:** bound continuation Tasks must not bypass the guarded activation
   contract through generic `taskRuns.save()`, legacy start callers or another insertion path. Keep the
   existing canonical TaskManager / TaskRun start owner; do not add a second TaskRun repository or an
   Admission state machine.

Preserve the effect-time sequence: ephemeral pre-admission → canonical persisted validation → guarded
atomic TaskRun start → exact TaskRun.id returned → exact-run revalidation/authority within the same owning
invocation → one downstream execution entry. The existing start boundary must close the known race across
exact WorkHandoff, ContinuationBinding, WorkItem lifecycle, canonical Task state, selected Approval /
ExecutionPlan authority and unresolved STARTED conflicts, with no new Admission persistence.

Where approval is required, authority remains exact `ApprovalRequest.id` → APPROVED → matching
`ExecutionPlanRef` → `ExecutionPlanIntegrityRef` where required. If canonical facts cannot prove authority,
**DENY / FAIL CLOSED**; never reconstruct an in-memory ExecutionPlan from its id alone.

#### Stale, replay, timeout and restart behavior

These are deterministic semantic outcomes, not new persisted statuses or finalized API error names.

| Case | Required behavior |
|---|---|
| WorkItem terminal after earlier eligibility | NO_ACTION; no new start or entry. If an attempt already began, its owner stops and records its actual outcome, without deleting history. |
| Handoff invalid/missing or no longer actionable | Invalid/missing/inconsistent → BLOCKED; terminal parent → NO_ACTION. No unsupported revocation/current-pointer model is inferred. |
| ContinuationBinding mismatch | BLOCKED conflict; never repair by rebinding or substituting a Task. |
| Task changed after binding | Re-evaluate current canonical Task and exact scope. Legal planned evolution is allowed; relationship/scope mismatch blocks. Change after in-flight evaluation fails the guarded snapshot comparison. |
| Task no longer executable | BLOCKED; no bypass of TaskManager transitions and no run start from terminal state. |
| AgentProfile missing | BLOCKED configuration failure; no fallback profile or provider. |
| Approval denied or pending | BLOCKED; no run start for an operation requiring that approval and no invocation/effect. |
| Approval expired | BLOCKED if validity is expired or cannot be proved under a required expiry rule; expiry enforcement is not implemented today. |
| Approval changed | Discard assessment, reload exact approval/scope; snapshot conflict blocks. Do not switch to another approved request implicitly. |
| Duplicate admission request | Read-only re-evaluation may return the same assessment if facts match; creates zero runs and dispatches zero times. No durable idempotency key is claimed. |
| Same TaskRun presented twice | Repeated reads are permitted; presentation alone never authorizes either invocation. Only the original live owner may enter once; repeat dispatch or ownership reconstruction is refused. |
| Another TaskRun started | BLOCKED conflicting/ambiguous attempt; do not select latest or supersede the supplied exact id. Guarded start prevents competing unresolved continuation attempts. |
| Process restart between checks, before start | Lose all ephemeral results and reload facts. If no attempt began, a fresh authorized attempt may be evaluated; no cached authority survives. |
| Restart after start, before/after uncertain invocation | STARTED proves an attempt began, not whether a receiver was invoked. Fail closed: no automatic redispatch, resume, failure fabrication or replacement run. Preserve unresolved history for separately authorized reconciliation. |
| Timeout before actual invocation | Before start: discard assessment, no run. After start with known local non-invocation: owner fails that exact real attempt. Unknown delivery: block/reconcile; timeout is not proof of non-execution. |
| Retry of admission request | Re-evaluate only; never translate request retry into startRun. Lost response with uncertain start is ambiguous, not permission to create another run. |
| New execution attempt after prior failure | Separate explicit attempt intent, prior exact outcome known and no unresolved run; TaskManager legally replans and fresh scope/approval checks precede a newly allocated TaskRun.id. Old run/result is never reused. |

**Durable admission state is not required** for these semantics: handoff/binding/work/Task/run/Approval
facts support fresh checks and historical correlation; missing scope and unknown outcomes fail closed.
This chooses safety over automatic restart progress. Existing facts cannot reconstruct whether a remote
invocation happened between start and crash. We explicitly do not promise that reconstruction, durable
request deduplication, restart resumption or exactly-once delivery. Persisting an “admitted” fact would not
resolve the invocation/commit ambiguity. If such progress guarantees become a requirement, reconsider the
specific missing fact under a separate ADR rather than adding generic admission persistence now.

#### Options considered

| Option | Benefits | Costs / decision |
|---|---|---|
| A — Pure admission policy | Deterministic, easy to test, no I/O or state; useful for canonical-fact predicates. | Cannot load current facts, prove live ownership or enforce atomic start; insufficient alone. Use only as B's internal helper. |
| B — Core Application composition | Matches existing orchestrator precedent; composes canonical owners, exact-run reads and explicit authority boundaries without duplicate persistence. | Requires honest point-in-time results, fail-closed ambiguity and existing-owner atomic contract hardening before activation. **Selected within these limits**, not a claim that current reads alone authorize effects. |
| C — Durable exact-TaskRun admission fact | Could record a separately required decision/audit fact or support a future explicitly designed deduplication protocol. | No present requirement needs that fact; would add table/schema, lifecycle/retention and ownership questions. Does not itself prove dispatch, freshness, approval validity or close the external-effect gap. Not selected. |
| D — New ExecutionAdmission aggregate/repository/state machine | Could own a genuinely new lifecycle if one were demonstrated. | No such lifecycle is required. Duplicates Task lifecycle, TaskRun attempt/terminal state, Approval authority and ExecutionReceipt provenance; invites reservation/worker/retry machinery. Rejected. |

### Consequences

- Admission policy lives in Core Application, never the storage/Discord/Provider adapter, composition root,
  SQLite repository or new infrastructure service. Adapters enforce atomic contracts; they do not decide
  Product policy. `apps → adapters → core` remains intact. Contracts contain Core ids/facts/refs only,
  with no Discord, SQLite, Claude, Codex, Ollama, HTTP or NestJS concrete types.
- No new persistence is justified. Exact run identity and fail-closed handling prevent provenance from
  being promoted to a transferable execution credential. There is no second approval or receipt system.
- Today's canonical facts are sufficient for assessment and conservative restart behavior; today's
  unchanged atomic start API is insufficient for concurrent authoritative continuation activation.
- Follow-up implementation must verify stale snapshots, competing starts, exact identity, repeated reads,
  approval-scope failures and crash ambiguity against the existing owners. A passing assessment test must
  not be reported as executed receiving-agent behavior. This Sprint runs documentation validation only.

### V1 / V2

[NOW] ADR-0087 is **Ratified** by the Chief Architect following independent exact-HEAD Architecture Review
**PASS_WITH_NON_BLOCKING_FINDINGS** at the reviewed architecture HEAD above. **M3E-6 implementation NOT
STARTED**; existing Product code, schema v11 and runtime wiring are unchanged. This documentation closeout
records the supplied decision and awaits independent review; it does not activate runtime or claim delivery.

[LATER] A bounded authorized admission implementation may compose read-only existing owners and an optional
pure policy. Existing-owner concurrency hardening must precede any authoritative continuation start path.
Actual receiving-agent integration requires a separately authorized execution slice and cannot be smuggled
into admission evaluation. No production readiness or implementation review PASS is claimed here.

**Explicit M3E-6 non-goals:** actual receiving-agent execution; Agent runtime; Provider invocation; Tool
invocation; Command execution; Workspace mutation; Git mutation; network execution; Discord execution;
scheduler; queue; worker; lease; heartbeat; retry/fallback engine; Workflow/DAG; standing tool permissions;
generic execution receipt; Production activation; Live UAT. Quoky development control-plane remains FROZEN.


### ADR-0087 implementation update — M3E-6B corrected read-only scope

The Chief Architect narrowed M3E-6B to **Continuation Execution Admission Evaluation**, consistent with
this ratified ADR. The ratification-checkpoint NOT STARTED statements above describe that earlier checkpoint.
M3E-6B evaluation is now **implemented locally, awaiting independent review and delivery**. Continuation
attempt start and receiving-agent activation remain **NOT IMPLEMENTED**. ADR-0087 remains Ratified.

`ContinuationExecutionAdmissionService` in Core Application composes only existing read operations:
WorkHandoff/WorkItem/Task/Approval `get`, ContinuationBinding `get` and TaskRun `listByTask`, plus the immutable
AgentProfileRegistry. It returns frozen `ELIGIBLE_TO_START_ATTEMPT` or bounded `DENY(reason)` values. Success
contains handoffId/taskId only, no run identity or executable authority. No admission aggregate, repository,
schema, durable state, receipt, manager ownership or runtime wiring is added.

- The evaluator requires the exact bound canonical Task already **RUNNING**, matching Actor/Project and
  valid conversation context; it does not plan or perform a lifecycle transition. A non-RUNNING Task is
  denied at this immediate-start prerequisite evaluation, without declaring its future lifecycle terminal.
- **Unresolved STARTED predicate:** a canonical persisted run for the bound Task whose `status` equals
  `TaskRunStatus.STARTED`. SUCCEEDED, FAILED and CANCELED are terminal and do not conflict. Age, startedAt,
  finishedAt and attempt ordering never resolve STARTED. Invalid run history fails closed. Listing detects
  conflicts only; no run is selected as authority, including when a higher terminal attempt exists.
- For unplanned, low-risk Tasks, canonical Task risk and RiskPolicy capability baseline determine whether
  approval can be omitted. A planned Task, selected approval or approval-requiring risk needs the original
  live ExecutionPlan from its trusted Application owner; Task.planId alone cannot reconstruct it. The plan
  must correlate with Task.planId, Project and capability. ApprovalPolicy, Task risk and capability baseline
  are composed conservatively; the exact persisted ApprovalRequest must be APPROVED and match the plan's
  id, goal and integrity fields when present. Cached refs and any-approved-for-plan searches are not used.
  This API is an internal fact evaluator, not an untrusted plan-submission or scope-authentication endpoint.
  Required integrity must be retained by the original plan owner. No expiry enforcement or broader authority
  is claimed; any execution class requiring currently unsupported expiry remains outside activation scope.
- Canonical reads are point-in-time and not an atomic snapshot. Success is ephemeral, must not be persisted
  or reused as effect-time proof, and grants no reservation, TaskRun authority or standing permission.
  Restart simply constructs a new evaluator and rereads facts; an existing STARTED run denies without
  redispatch, replacement, automatic completion/failure or other writes.

**Activation prerequisites remain deferred:** effect-time atomic guarded start and single-winner concurrent
activation through the existing TaskManager / TaskRunRepository owner; exact-run revalidation in the same
owning invocation; and closure of every bound-Task insertion/start bypass. Current caller audit found:

- `TaskManager.startRun` delegates to `TaskRunRepository.start`; the current Product caller is
  `ConversationRuntime.handleWorkTurn`, not a continuation caller.
- `SqliteTaskRunRepository.start` and `save` are the two adapter TaskRun insertion paths. `save` also serves
  TaskManager.completeRun/failRun, so globally blocking it would break existing terminal updates.
- TaskRun repository/start and continuation-binding tests use direct saves or raw SQL for historical/test
  fixtures. Such insertion paths must be considered by activation hardening; no fixture or trusted existing
  insertion/start semantics is changed by this read-only slice.

M3E-6B introduces no continuation start caller. Neither TaskManager nor a write/start/save port is available
to the evaluator. Focused tests exercise bounded denials, exact approval scope, terminal/STARTED history,
recreated evaluator behavior, deterministic concurrent reads and zero mutation. Existing consumption,
binding and TaskManager regression tests remain required. No full start-time TOCTOU closure is claimed.


## ADR-0088 — Effect-Time Guarded Continuation Start and Execution Entry

- **Status:** Ratified
- **Reviewed architecture HEAD:** `d43c0b51fc5f869aa70a516c61df1d6ff017f330`
- **Independent Architecture Review:** PASS_WITH_NON_BLOCKING_FINDINGS
- **ADR_0088_READY_FOR_CA_RATIFICATION:** YES
- **Chief Architect Ratification:** APPROVED, as confirmed by the Product Owner's ratification closeout
  instruction. The architecture decision is preserved; activation prerequisites remain outstanding.
- **Date:** 2026-09-21
- **Audit base:** `c0c91f341cb5f300628b86506c84e329d4f14eac`
- **Sprint:** M3E-6C, architecture/ADR only. Guarded start implementation: **NOT STARTED**.
- **Authority:** Chief Architect ratification recorded; guarded-start implementation is not authorized by this closeout.

### Context

ADR-0085 made TaskRun start atomic for ordinal allocation. ADR-0087 is Ratified and M3E-6B delivered the
read-only `ContinuationExecutionAdmissionService`, which deliberately returns a non-authoritative
point-in-time result and does not close the start-time race. ADR-0087 recorded effect-time atomic start and
start-contract bypass closure as deferred activation prerequisites. This decision defines exactly where
creating a STARTED TaskRun becomes truthful as "a real execution attempt has begun", and nothing further:
receiver invocation is not designed, exposed or wired here.

#### Codebase audit at the audit base

| Inspected source | Observation |
|---|---|
| `packages/core/src/application/task-manager.ts` | `startRun(task, capability)` delegates unchanged to `storage.taskRuns.start`. `completeRun`/`failRun` build a terminal run and call `taskRuns.save`. `TRANSITIONS` forbids PENDING → RUNNING directly; RUNNING is reachable only via PLANNING or WAITING_APPROVAL. `transition` validates its supplied Task then saves; it is not a canonical compare-and-set. |
| `packages/storage-sqlite/src/index.ts` (`SqliteTaskRunRepository`) | `start` opens an `IMMEDIATE` transaction, deep-compares the persisted Task against the supplied snapshot, requires RUNNING, allocates `MAX(attempt) + 1` and inserts STARTED. **It does not examine WorkHandoff, ContinuationBinding, WorkItem, Approval or existing unresolved STARTED runs.** Two concurrent starts on the same Task therefore both commit, as attempts N+1 and N+2. `save` is `INSERT … ON CONFLICT(id) DO UPDATE`, so it can also insert a brand-new row. |
| `packages/storage-sqlite/src/migrations.ts` v11 | Enforces `UNIQUE(task_id, attempt)` and immutability of `id`/`taskId`/`attempt`/`startedAt`/`capability` on update. Uniqueness is per ordinal, so it does **not** constrain how many runs may be STARTED for one Task. |
| `packages/storage-sqlite/src/continuation-binding-repository.ts`, `packages/core/src/ports/continuation-binding.port.ts` | `admit(expected: Readonly<{ handoff; workItem; task }>)` is the ratified expected-facts guard shape: Core supplies bounded canonical snapshots, the adapter deep-compares each against its persisted row inside one `IMMEDIATE` transaction, re-checks cross-aggregate consistency and uniqueness, and fails closed with the bounded `ContinuationAdmissionError` (`STALE_STATE`, `INCONSISTENT_STATE`, `CONFLICT`). It requires Task PENDING and zero runs, so this boundary cannot be reused to start a RUNNING Task. |
| `packages/core/src/application/continuation-execution-admission-service.ts` | Read-only evaluator; dependency type exposes only `get` on handoffs/work items/tasks/approvals and `listByTask` on runs, so writes are excluded at the type level. Requires canonical RUNNING Task. Unresolved conflict predicate is exactly `run.taskId === boundTaskId && run.status === STARTED`. `ELIGIBLE_TO_START_ATTEMPT` carries only `handoffId` and `taskId` — no `TaskRun.id`. |
| `packages/core/src/ports/storage-provider.port.ts` | Repositories exist for tasks, taskRuns, workItems, workHandoffs, approvals and receipts. **There is no ExecutionPlan repository**: `ExecutionPlan` is caller-owned in-memory data, while `ApprovalRequest` is persisted and carries `executionPlanRef` including optional `integrity`. |
| `packages/core/src/application/agent-profile-registry.ts` | `AgentProfileRegistry` freezes composition-time configuration. Profiles are not persisted storage rows and cannot participate in a persistence transaction. |
| Production callers | The only production callers of `startRun` are `TaskManager.startRun` and `ConversationRuntime.handleWorkTurn`; the only `taskRuns.save` callers are `completeRun`/`failRun`. **No production caller of either continuation service exists, and neither is wired in `apps/quoky/src/app.module.ts`.** |

#### Load-bearing lifecycle gap surfaced, not invented

`WorkHandoffContinuationService.admit` binds at Task **PENDING** with zero runs. The M3E-6B evaluator requires
Task **RUNNING**. `TRANSITIONS` requires an intermediate PLANNING (or WAITING_APPROVAL) step, and **no
production owner currently moves a continuation-bound Task from PENDING to RUNNING**. `ConversationRuntime`
performs that walk only for ordinary conversation work turns, not for continuations. This ADR does not invent
that transition. `CONTINUATION_TASK_RUNNING_OWNER = UNSPECIFIED` is recorded as a named activation
prerequisite that must be decided by its own slice before any guarded start can be reached in production.

### Decision

Select **Option B — a sibling guarded-start operation on the existing `TaskRunRepository` port**.

`TaskManager` and `TaskRunRepository` remain the canonical TaskRun lifecycle and start owners. A narrow Core
Application continuation execution-entry service composes policy around that owner; it owns no aggregate and
no lifecycle. Add **no aggregate, no repository, no schema, no table, no durable state, no queue, no worker,
no lease, no heartbeat and no distributed lock**.

Options A, C and D are rejected on ownership correctness, not diff size. **Option A** (optional guard
arguments on `start`) leaves the guard opt-in, so a continuation-bound Task remains startable through the
ordinary two-argument call and the bypass stays open; it also overloads one method with two contracts.
**Option C** (application read-check then ordinary start) cannot close the race at all, because the check and
the insert are not in one transaction — exactly the gap M3E-6B left open. **Option D** (new
aggregate/repository/state machine) is unnecessary: ContinuationBinding, Task, TaskRun and ApprovalRequest
already carry every fact the guard needs, so no evidence compels it.

#### Execution entry and linearization

```text
fresh admission evaluation
  → guarded start with bounded expected canonical facts
  → single transaction commit                      ← LINEARIZATION POINT
  → exact TaskRun STARTED, exact TaskRun.id returned in-memory
  → same owning invocation proceeds toward future receiver invocation
```

`LINEARIZATION_POINT` is the single commit of the guarded start transaction inside the TaskRun repository.
Before that commit no valid attempt exists; after it, exactly one STARTED TaskRun exists and STARTED is
truthful. The prior read-only evaluation is a necessary precondition and never authority: its result is not
re-supplied to the guard as proof.

The invocation that successfully commits the guarded start **is** the invocation that must proceed toward
receiver invocation. Persisting the returned `TaskRun.id` into a queue or table for a later unrelated worker
to claim is prohibited unless a future ADR explicitly introduces that architecture.

#### Effect-time fact classification

| Class | Facts | Why |
|---|---|---|
| **A — must participate in the atomic persisted guard** | exact `WorkHandoff`, exact `ContinuationBinding`, `WorkItem` lifecycle, `Task` lifecycle and Actor/Project relationship, exact `ApprovalRequest` id/status/`executionPlanRef`/integrity, absence of an unresolved STARTED run for the bound Task | All are persisted rows readable in the same transaction, and each can change between evaluation and start. Snapshot equality plus the STARTED-absence check must be verified at the linearization point. |
| **B — may be freshly read immediately before start** | `AgentProfile` existence and configuration for both handoff endpoints | Composition-time configuration, not storage rows; it cannot join a persistence transaction. A fresh registry read immediately before the guard is sufficient, and profiles remain configuration rather than authority. |
| **C — immutable provenance where identity comparison suffices** | `WorkHandoff` identity fields and `ContinuationBinding` `{handoffId, taskId, recordedAt}` | Both are insert-once and never mutated, so comparing identity is equivalent to comparing content. They are still verified in class A because their *presence* must hold at commit time. |
| **D — caller-owned non-persisted facts that must be supplied and compared** | live `ExecutionPlan` and its derived `ExecutionPlanRef`/`ExecutionPlanIntegrityRef` | There is no ExecutionPlan repository, so the plan cannot be re-read canonically. The caller must supply the original live plan and derive the expected refs; the guard compares those refs against the persisted `ApprovalRequest.executionPlanRef` including integrity. The live plan itself is neither persisted nor transactionally reread. |

Not every fact can or should live in one persistence transaction: AgentProfile is configuration and
ExecutionPlan is non-persisted. Claiming "revalidate everything atomically" would be false, so the guard
covers class A atomically and states the class B/D boundary explicitly.

#### Concurrency, unresolved STARTED and failure taxonomy

Inside the guard's `IMMEDIATE` transaction, the adapter rejects the start when any run for the bound Task has
persisted status STARTED. `IMMEDIATE` acquires the write lock at transaction start, so concurrent guarded
starts serialize and the later one observes the committed STARTED row. Therefore
`CONCURRENT_START_WINNERS = at most 1`, with all others failing closed on a bounded conflict result. This
needs no new table, column, lease or `stateVersion`; a partial unique index on STARTED runs would be a
stronger belt-and-braces backstop but requires a migration and is deliberately **not** adopted, so
`NEW_SCHEMA = NO` holds.

Bounded failure reasons follow existing convention (a typed error with a closed reason set, as with
`ContinuationAdmissionError`) and must not become a second domain lifecycle: `STALE_HANDOFF`,
`BINDING_MISMATCH`, `WORK_ITEM_NOT_CONTINUABLE`, `TASK_NOT_EXECUTABLE`, `APPROVAL_STALE`,
`UNRESOLVED_STARTED_RUN`, `CONCURRENT_START_CONFLICT`. They describe why one start attempt failed; they carry
no state and no authority.

#### Bypass closure

A continuation-bound Task must not reach STARTED except through the guarded path. Closure distinguishes
*creating a new STARTED run* from *updating an existing run to a terminal state*:

- ordinary `start(task, capability)` must refuse when a `ContinuationBinding` exists for that Task — a read of
  the existing `continuation_bindings.task_id` inside its current transaction, requiring no schema change.
  This decision is based on canonical persistence, never an optional caller flag;
- `save` must remain available for terminal updates and must refuse to **insert a new row** for a
  continuation-bound Task, while continuing to update an existing row. `completeRun`/`failRun` always update
  an existing run, so they are unaffected;
- `save` is not globally prohibited, and the v11 immutability trigger already prevents rewriting a committed
  start identity.

Test fixtures and helpers that insert runs directly are acknowledged: closure is enforced at the adapter
contract, so direct raw-SQL fixtures remain outside it. That residual is recorded honestly rather than
claimed closed.

#### Approval and the STARTED failure window

Approval requirements are unchanged and not weakened: the exact `ApprovalRequest.id`, `APPROVED` status,
matching `ExecutionPlanRef` and matching integrity where present. No `isApproved(planId)` fallback, no
reconstruction from `Task.planId`, no cached `ApprovalRef`, no handoff receipt, no new expiry semantics and no
new Approval model. Because the plan is caller-owned, the approval comparison is a class A persisted check
against a class D supplied value.

If the guarded start commits and the local process then fails before receiver invocation, the committed
STARTED TaskRun records a real attempt with an ambiguous outcome — never a reservation, lease, claim or future intent. Automatic redispatch, automatic
replacement runs and fabricated success or failure are all prohibited, and this slice adds no recovery
semantics.

#### Task RUNNING versus TaskRun STARTED

`Task.status = RUNNING` is a Task-level lifecycle assertion, owned solely by `TaskManager.transition`, that
the Task is admitted to execute. `TaskRun.status = STARTED` asserts that one concrete execution attempt has
begun, identified by exactly one `TaskRun.id`. They are not duplicate representations: a RUNNING Task with
zero TaskRuns **is valid** and is precisely the legitimate pre-first-attempt window — M3E-4 admission itself
requires zero runs — and a RUNNING Task may accumulate several terminal runs across attempts.

The exact returned `TaskRun.id` is the only execution-attempt identity and must be propagated in-memory to
the future receiver execution path. Rediscovery by latest run, highest attempt, `MAX(attempt)` or most-recent
STARTED is prohibited.

#### Ratification carry-forward — Task RUNNING owner and approval ordering

`CONTINUATION_TASK_RUNNING_OWNER = UNSPECIFIED` at the caller/wiring level; Task lifecycle remains owned by
`TaskManager.transition`. The legal initial path is PENDING → PLANNING → RUNNING, or, where approval policy
requires it, PENDING → PLANNING → WAITING_APPROVAL → RUNNING. No new Task state or lifecycle owner is added.
`CONTINUATION_TASK_RUNNING_OWNER_WIRING = REQUIRED_ACTIVATION_PREREQUISITE`; until that wiring is implemented
and reviewed, `CONTINUATION_EXECUTION_ACTIVATION = DISABLED`.

The independent review's approval-ordering finding is carried forward explicitly: **approval acquisition
and guarded-start Approval revalidation are distinct gates**. Where required, acquire approval before the
Task may become RUNNING; guarded start later revalidates the exact persisted Approval authority against the
expected plan refs. Future lifecycle wiring must not collapse these gates. This closeout implements neither.

The expanded repository read surface across handoffs, bindings, work items, tasks, approvals and runs is an
accepted persistence-level CAS/expected-facts comparison, not Application policy inside SQLite. Direct SQL
and test fixture insertion remain outside adapter-contract bypass closure; no stronger protection is claimed.
No new aggregate, repository, schema, table, durable state or migration is introduced.

### Consequences

The public `TaskRunRepository` port gains one narrowly named guarded-start method; Core supplies bounded
expected canonical facts and remains storage-neutral, with no SQLite type, SQL or transaction mechanic
imported. Personal Edition SQLite implements the guard concretely, mirroring the ratified `admit` shape, so
Team Edition replaceability is preserved. Ordinary `start` keeps its ADR-0085 semantics for non-continuation
Tasks and additionally refuses continuation-bound Tasks.

Activation remains blocked on prerequisites that this ADR names rather than solves: the unspecified owner of
the continuation Task's PENDING → RUNNING transition, and receiver invocation itself. No receiving-agent
dispatch, Provider, Tool or command execution, runtime wiring, scheduler, autonomous loop, CAP-013 producer
change or Approval model change is introduced. Schema stays at v11.

### V1 / V2

[NOW] ADR-0088 is **Ratified** following independent Architecture Review **PASS_WITH_NON_BLOCKING_FINDINGS**
at the reviewed architecture HEAD above. M3E-6C guarded-start architecture is **decided**: a single
linearization point, bypass closure and at-most-one concurrent winner. Guarded-start implementation is
**NOT STARTED**; continuation Task RUNNING wiring and receiving-agent invocation are **NOT IMPLEMENTED**.
This local documentation closeout awaits independent review and does not claim delivery or activation.
[LATER] Receiver invocation, the continuation Task RUNNING transition owner, attempt recovery/redispatch
semantics, and any queue, worker, lease or heartbeat architecture each require separate decisions.


#### M3E-6D local implementation follow-through (2026-09-22)

The lifecycle caller prerequisite described above is now **IMPLEMENTED LOCALLY / AWAITING REVIEW**,
not delivered: `WorkHandoffContinuationService.prepare` orchestrates the existing TaskManager legal
transitions after exact binding admission, with ApprovalManager owning request acquisition/decisions.
The composition root wires this explicit Application entry using the existing binding repository token;
no new aggregate, repository, persistence owner, Task status, edge, Approval model or schema is added.
Configured AgentProfile endpoints are required; the empty default registry remains fail-closed.
The caller supplies the original live plan and exact approval ID on reentry; no plan reconstruction or
`isApproved(planId)` fallback. Inconsistent plan policy/risk facts are denied, not repaired by synthetic plans.

Approval acquisition and guarded-start revalidation remain distinct. Task RUNNING with zero TaskRuns is
only lifecycle preparation. These reads and TaskManager transitions are not an atomic snapshot/CAS and
convey no effect-time authority; the existing TaskRun start and save bypasses remain outstanding ADR-0088
work. Guarded start **NOT IMPLEMENTED**, receiver invocation **NOT IMPLEMENTED**, continuation execution
activation **DISABLED**. ADR-0088's ratified decision is unchanged. Independent implementation review pending.


#### M3E-6E delivered implementation follow-through (2026-09-22)

M3E-6D lifecycle wiring was delivered through PR #69 at
`bab2e197151f9682298697be0cf5b18cb8f1e79b`. The historical local status above is superseded.
M3E-6E guarded start is **DELIVERED** through **PR #70**, merge commit
`c603f0923d20b463907b471f127f5f870225a4ac` (implementation
`7197cee89e25ba9c8d1e943152aa12f95f6b60de`); the ADR remains **Ratified**. `ContinuationExecutionEntryService.start` composes fresh admission over canonical reads
and retains those exact evaluated snapshots for `TaskManager.guardedStartRun` → `TaskRunRepository.guardedStart`.
The expected-facts contract includes a Core policy assertion of no approval required, or the exact
ApprovalRequest plus live-plan-derived ref/integrity. SQLite does not evaluate ApprovalPolicy: it mechanically
compares Core expectations to persisted facts, their required lifecycle/relationships and approved authority.
No prior eligibility result is accepted as authority and no second reads substitute unevaluated snapshots.

SQLite's single IMMEDIATE transaction commit is the linearization point. It compares all class-A facts,
checks bound-task STARTED absence, allocates the next ordinal and inserts the exact returned run. Six
simultaneously released child processes yielded one winner and five UNRESOLVED_STARTED_RUN failures,
without a new index/schema. Ordinary start rejects bound Tasks; save rejects all novel bound rows and
terminal → STARTED revival, while existing terminal updates remain valid. Arbitrary raw SQL is not covered.

No Task lifecycle transitions or Approval acquisition occur at start. AgentProfile configuration is read
freshly in Core, not within SQLite. The live plan is neither persisted nor reconstructed. The committed
STARTED run is a real attempt and a post-commit caller failure leaves an ambiguous outcome; no automatic
replacement, success, failure, receiver invocation, queue or recovery semantics are added.

Production continuation caller/trigger **NOT IMPLEMENTED**; AgentProfile configuration surface
**NOT IMPLEMENTED**; receiver invocation **NOT IMPLEMENTED**; continuation execution activation **DISABLED**.
The Application execution-entry service is callable in composition/tests but is not production-activated.
Live-plan predicate deduplication remains **TRACKED**; the duplicate pending-Approval acquisition window
remains **TRACKED / NON_BLOCKING** and independent of effect-time Approval revalidation.

## ADR-0089 — Continuation Activation Readiness and Same-Invocation Ownership

- **Status:** Ratified
- **Date:** 2026-09-22
- **Sprint:** M3E-6F, architecture/documentation only; no implementation or activation authorization.
- **Audit / review base:** `c603f0923d20b463907b471f127f5f870225a4ac`
- **Authority:** Ratified by Chief Architect decision following independent Architecture Review
  **PASS_WITH_NON_BLOCKING_FINDINGS** at `1e2b25bc8c20d70ffc0dc2c28f5d0b3d15cce5b3`. The selections below
  are decided architecture; they authorize no implementation, activation or execution by themselves.
  ADR-0087/0088 remain Ratified and are not reopened. See the ratification closeout section below for
  strengthened delete rationale, the corrected slice order and the unresolved post-wait context contract.

### Context

M3E-6D lifecycle preparation was delivered in PR #69. M3E-6E guarded atomic start was delivered in
**PR #70**, merge commit **`c603f0923d20b463907b471f127f5f870225a4ac`**, implementation
`7197cee89e25ba9c8d1e943152aa12f95f6b60de`. Its earlier local/awaiting-review statements are historical.
The guard compares expected persisted facts and exact Approval authority in one IMMEDIATE transaction,
returns the inserted STARTED run, and closes ordinary-start and save insertion bypasses. None of that
provides a production trigger, executable AgentProfile, receiver invocation or remote atomicity.

**CONTINUATION_ACTIVATION_READY_TODAY = NO.** This ADR defines minimum remaining boundaries under
ARCHITECTURE.md §§3, 7–10 and ADR-0079/0080/0083/0084/0087/0088. No worker runtime is necessary for the
proposed single-call design. The actual Product trigger is unselected and remains an explicit activation
blocker; this proposal does not invent a user intent or treat handoff creation as permission to execute.

#### Code-first audit at the review base

| Source | Observed fact and consequence |
|---|---|
| `packages/core/src/ports/storage-provider.port.ts` | TaskRunRepository extends generic Repository, including delete. GuardedTaskRunStartFacts.approval.kind is an expectation discriminator, **not an ApprovalRequest kind**. |
| `packages/storage-sqlite/src/index.ts`, JsonRepository / SqliteTaskRunRepository | TaskRun inherits unconditional DELETE by id. No TaskRun delete override. Removing STARTED removes the guard's conflict evidence. The repository guards start/save but not deletion. Production taskRuns.delete callers: **0**; the M3E-5 test deletes an ordinary run to test ordinal gaps. |
| Same file, SqliteConfig / init | Config contains dbPath only; `new Database(dbPath)` supplies no timeout. Installed better-sqlite3 `lib/database.js` uses 5000 ms when timeout is absent. No busy translation exists. This is a local dependency-source observation, not a live DB probe. |
| `application/continuation-execution-entry-service.ts` | Retains fresh evaluated snapshots, rechecks configured profiles and delegates to TaskManager.guardedStartRun. Returns exact TaskRun; no receiver seam. |
| `application/continuation-execution-admission-service.ts` | Read-only point-in-time checks; RUNNING, exact plan/ref/approval and unresolved STARTED. No acquisition or execution. |
| `application/work-handoff-continuation-service.ts` | Exact binding and canonical relationships, lifecycle preparation via TaskManager. Original live plan required. Approval acquisition precedes WAITING transition, leaving a duplicate-request window. Structural plan checks overlap admission; lifecycle also requires requestedBy and rejects inconsistent policy/risk facts. |
| `domain/agent-profile.ts`, `application/agent-profile-registry.ts` | Five fields: id, displayName, role, purpose, instructions. Branded id, bounded text, duplicate rejection, frozen composition-time registry. No executable/capability/provider/credential/authority binding. |
| `apps/quoky/src/agent-profile-registry-provider.ts`, `app.module.ts`, `continuation-lifecycle-provider.ts` | Registry is hardcoded empty. Lifecycle service is DI-registered; no Product caller invokes preparation or execution entry. DI availability is not activation. |
| `apps/quoky/src/config.ts` | Single environment-reading boundary returns typed config; non-secret JSON actorIdentityMappings is a precedent. No AgentProfile config field. Credential resolution is separate. No secret/environment value was read for this audit. |
| `domain/work-item.ts`, `domain/work-handoff.ts`, `domain/continuation-binding.ts`, `application/work-handoff-manager.ts` | WorkItem owns ACTIVE/COMPLETED/CANCELED work, handoff is immutable provenance, binding exact correlation. Manager validates and records handoffs; none is an execution driver or authority. |
| `domain/trigger-source.ts`, `application/proactive-delegation-service.ts` | INTERNAL_CONTINUATION describes provenance. Evaluation and idempotent recording do not authorize execution or install a scheduler. |
| `application/orchestrator.ts` (QuokyCore), `application/conversation-runtime.ts` | Existing inbound path is platform → thin facade → ConversationRuntime. Ordinary handleWorkTurn creates its own Task/run and invokes a capability Provider. It is not a safe way to resume a bound Task, and invoking it would create an unrelated attempt. |
| `application/execution-orchestrator.ts` | Stateless intra-task Planning/Approval/CodeGeneration/Patch/Write/Command composition. It creates plans and may halt for approval; it has no handoff/receiver/exact TaskRun ownership contract. |
| `domain/approval.ts`, `application/approval-manager.ts`, ConversationRuntime apply/commit flows | ApprovalRequest has **no kind/purpose/operation field**. requestFor and requestForRisk create the same aggregate shape. Apply and commit may reuse the same executionPlanRef/requester; separate application anchors carry exact approval IDs and operation scope. Reason text is descriptive, not enforceable scope. |
| `application/task-manager.ts`, `application/ai-failure.ts`, `domain/enums.ts` | completeRun/failRun update the supplied exact run to SUCCEEDED/FAILED. CANCELED exists, but TaskManager has no cancelRun. AiFailureKind classifies UNAVAILABLE/AUTH_REQUIRED/TIMEOUT/EXECUTION_FAILED/EMPTY_OUTPUT; it does not prove external effects stopped. |

### Decision (proposed)

#### 1. TaskRun deletion and execution history

**TASKRUN_DELETE_ACTIVATION_PREREQUISITE = YES. SELECTED_DELETE_POLICY = Option A: forbid repository
 deletion of every continuation-bound TaskRun, including terminal history.** The future adapter must
resolve the stored run's taskId and check persisted binding in the same transaction as the attempted delete;
checking a caller-supplied flag or hiding a method in one TypeScript dependency is insufficient.
Missing-id deletion can retain existing no-op semantics. A bounded refusal must be part of the Core port
contract and implemented by every adapter, including a future Team Edition adapter.

| Option | Assessment |
|---|---|
| A — forbid all bound-run deletion | Selected: protects ambiguous STARTED evidence and exact historical identity, while preserving ordinary repository compatibility. |
| B — forbid all STARTED deletion | Protects live evidence more broadly, but changes ordinary Task cleanup behavior and still permits loss of bound terminal history. Not the smallest continuation slice. |
| C — hide generic delete from Application surfaces | Useful least-privilege typing, not enforcement: base Repository/storage access can bypass it. Insufficient alone. |
| D — accept unchanged deletion | Rejected: absence of current callers cannot protect a future in-flight attempt from deletion/replacement. |

TaskRun is execution history with immutable start identity and owner-controlled terminalization, not
arbitrary disposable Product state. Current save permits some other updates; do not falsely describe all
JSON fields or terminal records as already immutable. This proposal closes deletion, not every historical
mutation. For bound runs, arbitrary deletion has no Product use case and must be prohibited even if the
inherited signature is retained for compatibility. Removing generic deletion from **all** TaskRun types
or designing retention/export/purge is a separate future contract decision. Disposable test DB teardown
remains test-owned infrastructure; ordinary ordinal-gap fixtures can remain, and raw fixture SQL is not a
Product cleanup API. No cleanup or data removal occurs in M3E-6F.

#### 2. SQLite contention contract

**SQLITE_BUSY_ACTIVATION_PREREQUISITE = YES. SELECTED_BUSY_POLICY = Option A: explicit timeout plus
 typed infrastructure-contention mapping.** Make the existing 5000 ms wait explicit as the adapter default;
if configurable, validate a bounded nonnegative integer at the application configuration boundary.
SQLite-specific settings stay in the SQLite adapter/composition root, never Core policy.

Map recognized lock/busy failures of the guarded transaction to a bounded storage-contention error
(proposed code `TASK_RUN_STORAGE_BUSY`), distinct from `UNRESOLVED_STARTED_RUN`, stale-fact denial and
unknown infrastructure failure. No winner is inferred from SQLITE_BUSY. Transaction failure returns no
new run/attempt identity. Preserve causes in sanitized adapter diagnostics, not driver types in Core.
A Team adapter maps its equivalent contention only when it can make the same rollback/no-new-attempt
claim; unknown commit outcomes are infrastructure ambiguity, never a safe-to-retry result.

Option B (explicit timeout, raw infra error) is fail-closed but leaves the activation caller contract
adapter-specific. Option C (implicit default) is also fail-closed today but leaves wait behavior dependent
on dependency defaults. Both are acceptable descriptions of today's disabled baseline, not the selected
activation contract. **Automatic retry = NO**: bounded driver lock waiting within one transaction call
is not an Application reinvocation. No retry-on-busy, queue, rescheduling, replacement or new TaskRun ID.
A future explicit invocation must revalidate everything; it is not authorized by the busy result.

#### 3. AgentProfile configuration

**AGENT_PROFILE_CONFIG_SELECTED_OPTION = B: extend existing typed application config with static
composition-time AgentProfiles. NEW_AGENT_PROFILE_REPOSITORY_REQUIRED = NO.** Proposed input:
non-secret `QUOKY_AGENT_PROFILES` JSON array parsed only in config.ts, following its existing JSON config
convention, passed through AppModule to AgentProfileRegistry. Missing/empty array keeps the registry empty
and continuation disabled. Malformed JSON, unknown fields, invalid/duplicate IDs or invalid bounded text
fail configuration; no invented fallback agent. Use existing field limits and bound collection size in the
config slice. Freeze once; a change requires a new composition, not runtime registration/hot reload.

A separate static file/module (A) preserves immutability but creates a second configuration path without
an established need. Persistence (C) would invent an aggregate/repository. Dynamic registration (D) would
change freshness/lifetime semantics and require runtime management. Neither is justified.

Only id, displayName, role, purpose and instructions belong in this config. Instructions are non-secret
persona data subordinate to platform governance, not permission grants. No Provider id pin, API key,
credential payload/reference, executable path, Tool allowlist or standing execution authority is accepted
as a profile field. Any future routing reference belongs to a separately validated composition concern;
none is required in v1. Provider credentials stay in existing adapter-owned config. Unknown-field rejection
cannot detect arbitrary secrets pasted into prose; operators must keep prose non-secret and config errors
must not echo raw instruction text. No secret read is needed for this design or this Sprint.

#### 4. Production caller and trigger

**PRODUCTION_CONTINUATION_CALLER_OWNER = Option A: a narrow Core Application coordinator**, proposed
name `ContinuationExecutionService`. It composes existing owners for one explicit handoff-bound operation;
it owns no aggregate and no durable progression state. An eventual chosen inbound flow may delegate to it,
without relocating continuation ownership into ConversationRuntime or creating a second conversation entry.

| Option | Assessment |
|---|---|
| A — explicit Application coordinator | Selected: exact context and one invocation, reusable without platform coupling. |
| B — ConversationRuntime as owner | Rejected: ordinary turn execution creates another Task/run and conflates session routing with continuation identity. A thin future delegate is possible only after trigger selection. |
| C — WorkHandoffContinuationService as driver | Retain admission/provenance/preparation responsibility; do not grow it into receiver execution and outcome handling. |
| D — scheduler/worker/queue | Rejected: no Product requirement, and violates same-invocation scope without a separate architecture. |

**CONTINUATION_TRIGGER = UNSELECTED / PRODUCT_DECISION_REQUIRED.** Existing requirements do not select
an authenticated user turn, operator action or another explicit Product/Application call. Handoff creation,
acceptance-by-inference, TriggerSource, WorkItem ACTIVE, DI registration and approval alone are **not**
triggers. No polling or autonomous scheduling is proposed. Product must select the actual event, actor
permission check, capability scope, exact handoff/task input and error/approval presentation before wiring.
Architecture work can finish while activation remains blocked on that Product decision.

The coordinator must receive an exact admitted handoff/task binding, never infer latest Task. If the chosen
flow needs Task creation, use TaskManager.createTask followed by existing admit while PENDING; define that
explicit entry contract in the caller slice rather than auto-creating another Task on reentry. Revalidate
Actor/Project and selected receiver scope; prepare lifecycle; return a bounded wait/denial before start.
Approval-pending return carries the exact request ID. Reentry requires the original caller-owned live plan
and exact request ID: define how the selected caller can supply them without persisting/reconstructing a
lost plan. A normal later user turn cannot presently prove this. Lost plan or missing scope proof blocks
start; no Task.planId reconstruction, indefinite background continuation or new plan repository.

#### 5. Receiver resolution and same-invocation owner

**RECEIVER_RESOLUTION = exact WorkHandoff.toAgentProfileId → immutable configured persona, combined with
exact bound Task capability → supported capability execution path.** AgentProfile is not executable.
Resolve supported capability and persona-aware prompt/context mapping before guarded start; reject an
unsupported combination before creating an attempt. Existing PromptComposer has no AgentProfile input:
its bounded integration is required, not an already-supported feature. Persona never selects a Provider
by id or authorizes a Tool/command. Capability routing and existing Provider ports remain authoritative.
The initial allowed receiver capabilities must be explicitly selected with the Product trigger; arbitrary
capability dispatch is not implied by this ADR.

**RECEIVER_INVOCATION_OWNER = Option B: the same new narrow ContinuationExecutionService** that owns
one coordinator invocation. This is one component, not an additional workflow layer. It composes
existing entry.start, one bounded receiver call and existing TaskManager terminalization:

```text
selected explicit trigger (not yet defined)
  → exact binding + lifecycle prepare (or return WAITING / DENY)
  → receiver/capability/prompt and operation-scope preflight with original live plan
  → ContinuationExecutionEntryService.start
      → fresh admission → guardedStart commit → exact TaskRun returned
  → invoke resolved receiver once with that exact run identity
  → persist resulting artifacts through existing owner
  → TaskManager.completeRun / failRun on that exact returned run
```

Option A (expand execution-entry) would mix its fresh-proof/start responsibility with receiver and result
handling. Option C (generic ExecutionOrchestrator) is not selected: it is stateless intra-task capability
composition, creates its own plan and may request Approval, and cannot be treated as an approved receiver
runner by forwarding an existing ref. If a later receiver capability reuses it, its stage-specific authority
must remain intact and it must not become the handoff driver. Option D adds an unneeded worker runtime.
The proposed receiver seam is an Application dependency, not a new aggregate, repository or agent runtime.

Guarded start and receiver invocation stay in the same owning call. Pass the returned run object/id directly;
no latest/MAX/timestamp lookup, run-id queue, receipt substitute, lease or worker claim. An operator cannot
resume an already persisted STARTED row merely by presenting its ID. No automatic retry, fallback invocation
or redispatch is granted; an existing routing mechanism with extra attempts cannot be enabled implicitly.

**TERMINALIZATION_OWNER = TaskManager.completeRun / TaskManager.failRun.** Known receiver success with
persisted artifacts completes the exact run; a settled classified failure fails that run. Task-level status
changes, if the capability contract requires them, go only through TaskManager.transition and existing
edges; never infer WorkItem completion from one run. The coordinator must not catch a completeRun/persistence
failure and fabricate a different receiver outcome via failRun. A process death after commit, lost result,
unknown persistence outcome or possibly still-running receiver leaves ambiguous STARTED. No synthetic
FAILED/SUCCEEDED, replacement or restart recovery. Terminal write failure is surfaced as such.

Existing AiFailureKind/describeAiFailure is sufficient for naming known Provider failures; keep Provider
semantics unchanged. It is **not** sufficient to prove remote execution has stopped: TIMEOUT, cancellation
or an unknown thrown error can be ambiguous. Before activation, the receiver seam must distinguish a
settled result from an unconfirmed in-flight outcome and map non-Provider ExecutionOutcome values
explicitly; AWAITING_APPROVAL/DENIED/CANCELLED are not successes. Such preflight halts should occur before
start. Never blindly apply ConversationRuntime's catch-all failure terminalization to a possibly live
receiver. This is a receiver result-contract gap, not a request to redesign Provider error enums.

**EXACTLY_ONCE_EXTERNAL_EFFECT = NO CLAIM.** The local guard serializes start admission. It cannot commit
an external receiver action atomically with SQLite; a returned result or FAILED attempt does not prove
absence of partial external effects. Strict execution approval and capability-specific effect guards remain.

#### 6. Plan, Approval and cancellation prerequisites

**LIVE_PLAN_PREDICATE_DEDUP_BEFORE_ACTIVATION = YES.** Extract only the shared pure structural
plan/ref/integrity proof into an internal helper. Gate-specific semantics stay separate: lifecycle
acquisition/policy-consistency/requester checks versus start-time exact authority. Add paired tests proving
both gates reject malformed/mismatched plans without weakening stricter checks. Current duplication is
not a demonstrated bypass, but extending a third caller/receiver interpretation makes drift safety-relevant.
No new public Approval model, persisted plan or generic policy framework is required for this refactor.

**DUPLICATE_PENDING_APPROVAL_ACTIVATION_PREREQUISITE = NO**, conditional on the explicit caller retaining
and presenting the selected exact approval ID, never choosing latest/any approved request or silently
creating a replacement on resume. Each duplicate is independently decided and cannot bypass the exact
start guard. Operator confusion and stale outstanding requests remain TRACKED / NON_BLOCKING; show exact
identity and scope, fail closed when selection/live plan is lost. No automatic cancellation, merge or
idempotent acquisition claim is made. If the chosen Product interaction cannot maintain exact selection,
that caller is blocked; this does not justify changing acquisition ownership casually.

**APPROVAL_KIND_ACTIVATION_PREREQUISITE = YES (operation-scope proof, not a nonexistent kind field).**
The audit disproves a typed ApprovalRequest kind today. Same requester + plan ref may describe preview,
apply, commit or other requestForRisk approvals. Exact ID/ref checks alone cannot distinguish those
purposes if an arbitrary ID is supplied. The receiver boundary must prove the selected request is for the
exact receiver operation, using trusted acquisition/caller context and a scope-specific live plan/ref or
existing operation-specific anchor contract. Unrelated apply/commit/preview requests must be rejected;
reason-text parsing and guarded expectation.kind are not scope evidence. If the selected flow cannot
prove this with existing contracts, keep it disabled and seek a separately reviewed Approval-scope
contract amendment; do not invent ApprovalRequest.kind, persist a new authority flag or assume all
plan-scoped approvals are interchangeable in this docs Sprint. This prerequisite is independent of the
existing ADR-0088 mechanical revalidation guarantee, which remains unchanged.

Explicit **STARTED → CANCELED** persistence and **CANCELED → STARTED denied** tests are a pre-activation
quality requirement, not optional hygiene: CANCELED is terminal for the unresolved predicate, so misuse
can permit a later run while an old receiver is still active. No cancellation API is added here. Existing
TaskManager has no cancelRun; until an owner can prove receiver termination, do not expose receiver
cancellation or directly save CANCELED from the coordinator. Schema/enum presence is not cancellation
semantics. Repository coverage must protect the status already accepted at its public boundary.

#### 7. Activation precondition matrix

All next-slice labels below are ratified sequencing, not execution approval. Rows depending on the Product
Decision gate are marked; none of them may be pulled into pre-gate work.

| Item | Current status | Required before activation? | Owner | Next slice |
|---|---|---|---|---|
| Task lifecycle wiring | M3E-6D delivered; DI service, no trigger | Yes; existing + integration regression | TaskManager / preparation service | M3E-6J caller slice |
| Guarded atomic start | M3E-6E delivered, insertion bypasses closed | Yes; preserve | TaskManager / TaskRunRepository | M3E-6G (regression only) |
| TaskRun delete safety | Generic inherited delete can erase a bound run; `resolveRun` provenance and `MAX(attempt)+1` ordinal identity both depend on retention | **Yes** | TaskRun port + adapter | M3E-6G (implemented locally) |
| SQLITE_BUSY contract | Implicit 5000 ms driver default, raw infra failure | **Yes**, explicit bounded wait + typed contention | SQLite adapter / config | M3E-6G (implemented locally) |
| AgentProfile config surface | Empty hardcoded registry | **Yes** | apps config / registry | M3E-6H |
| Live-plan structural predicate | Similar structural checks in two gates | **Yes**, extract pure proof only; keep gate semantics distinct | Core pure validation | M3E-6I-a (pre-gate) |
| Product trigger | Not specified | **Yes; Product decision** | Product Owner / inbound boundary | Product Decision gate |
| Authorized Actor/Project scope | Only relational consistency exists; that is not authorization | **Yes; Product decision** | Product Owner | Product Decision gate |
| Supported receiver capability set | Unselected | **Yes; Product decision** | Product Owner | Product Decision gate |
| Live plan across Approval wait | No supply contract; no authoritative post-wait source today | **Yes**, no reconstruction | Selected caller / plan owner | M3E-6I-b (**post-gate**) |
| Approval operation-scope proof | No kind/purpose field; scopes live in existing anchors | **Yes**, prove scope or stay disabled | Approval + receiver/caller owners | M3E-6I-b (**post-gate**) |
| Production continuation caller | None | **Yes** | ContinuationExecutionService | M3E-6J (after 6I-b) |
| Receiver resolution | Persona/config exists, executable mapping absent; PromptComposer has no AgentProfile input | **Yes**, within selected capability set | Application capability/prompt composition | M3E-6K |
| Receiver invocation | None | **Yes**, one same-call invocation | ContinuationExecutionService | M3E-6K |
| Terminalization | completeRun/failRun exist, receiver result mapping absent | **Yes**, settled vs ambiguous handling | Same coordinator + TaskManager | M3E-6K |
| Duplicate ApprovalRequest window | Non-atomic acquisition | No, conditional on exact selected approvalId retention | ApprovalManager / caller UX | Tracked follow-up |
| CANCELED semantics + revival denial | No explicit guarded-path coverage; no cancelRun | **Yes**, and no CANCELED write without proven receiver termination | TaskRun adapter tests / receiver contract | M3E-6G + M3E-6K |
| Raw SQL carve-out | Outside port protection | Yes, preserve explicit trusted-admin boundary; **raw-SQL immunity NOT claimed** | Storage operations / governance | M3E-6L audit |
| Strict execution authorization | Not granted by ratification, merge, config or offline acceptance | **Yes**, separately approved exact scope | Product Owner | After offline M3E-6L |

#### 8. Ratified ordered follow-up slices

1. **M3E-6G — TaskRun persistence safety:** bound-run deletion protection across the existing
   port/adapter, explicit bounded busy wait, typed storage contention, and CANCELED/revival coverage.
   One persistence boundary; no schema, no recovery behavior. **Independently actionable.**
2. **M3E-6H — static AgentProfile configuration:** typed config parsing and frozen registry composition,
   malformed/empty/unknown-field tests, non-secret diagnostics. No activation. **Independently actionable.**
3. **M3E-6I-a — shared pure structural live-plan predicate:** extract only the shared structural
   plan/ref/integrity proof plus paired tests proving both existing gates still reject malformed and
   mismatched plans. Gate-specific semantics are not collapsed. **Independently actionable.**

   ────────────────── PRODUCT DECISION GATE ──────────────────
   Product must select the continuation trigger, the authorized Actor/Project scope, and the initial
   supported receiver capability set. Nothing below may begin before this gate.

4. **M3E-6I-b — post-wait context contract (post-gate):** define the exact live-plan supply and the
   operation-scoped Approval proof as one shared caller-context problem. If existing contracts cannot
   establish a safe source, obtain a separately reviewed amendment; activation stays disabled meanwhile.
5. **M3E-6J — explicit continuation caller preparation:** implement the narrow coordinator's exact
   admission/lifecycle/wait/reentry path, ending before guarded start until the receiver seam exists.
   **MUST NOT precede M3E-6I-b.** No dead-end Product STARTED creation, scheduler or second facade.
6. **M3E-6K — receiver seam and exact-run terminalization:** complete the same coordinator with existing
   entry.start + capability receiver + TaskManager terminalization, using offline fakes to test settled
   versus ambiguous outcomes, exact run identity and zero retries. Production activation remains off.
7. **M3E-6L — offline activation acceptance:** integrate the selected trigger/config and a fake receiver
   in isolated test composition; verify every matrix gate, ordinary conversation regression, denied paths,
   lost plan, wrong-operation approval, contention, deletion, process-death ambiguity and the raw-SQL
   boundary. Review the exact activation revision. No Runtime start and no Live UAT in this slice.

Runtime Start/Stop/Restart, Provider invocation, Product network execution, Live UAT and Production
activation each remain separate strict approval boundaries with exact target/scope/revision. ADR
ratification does not authorize them; neither does an implementation merge, a configured AgentProfile, nor
an offline acceptance result. Development control-plane remains FROZEN. M3E-6F changes only the four
canonical docs; no Product code, DB, configuration or cleanup.

### Consequences

- **+** Preserves existing aggregate, TaskRun and Approval ownership and Team Edition replaceability;
  fills the deletion/operational-contract gaps without reopening ADR-0088's start design.
- **+** Defines one bounded same-invocation receiver owner without introducing a workflow, scheduler,
  queue, durable claim or agent runtime, and makes unknown Product choices visible rather than guessed.
- **−** Activation waits for operation-scope proof, live-plan supply, a Product trigger and receiver outcome
  semantics in addition to configuration and persistence hardening. No end-to-end readiness is claimed.
- **−** Terminal bound-run retention is intentional; storage-retention tooling requires its own decision.
- **NEW_ADR_REQUIRED = YES:** ADR-0087/0088 deliberately deferred caller/receiver ownership and did not
  define profile input, trigger selection, delete policy or contention mapping. **ADR_NUMBER = ADR-0089;
  ADR_STATUS = Ratified** (Chief Architect decision after independent review
  PASS_WITH_NON_BLOCKING_FINDINGS). Dependent implementation is now sequenced, not authorized to activate.

### V1 / V2

[NOW] M3E-6D and M3E-6E are delivered; ADR-0089 is **Ratified** and continuation activation remains
**DISABLED**. **CONTINUATION_ACTIVATION_READY_TODAY = NO.** The trigger, authorized Actor/Project scope,
supported receiver capability set, post-wait live-plan source and operation-scoped Approval proof are all
unresolved. No prerequisite is implemented.
[LATER] The ratified bounded slices M3E-6G → M3E-6L may implement the matrix prerequisites in order; live
activation needs separate strict authorization. Dynamic AgentProfiles, persistent profile repository,
workers/queues, automatic retry/recovery, generalized workflow orchestration and exactly-once external
effects remain out of scope.


#### ADR-0089 ratification closeout (2026-09-22)

ADR-0089 is **Ratified** by Chief Architect decision following independent Architecture Review
**PASS_WITH_NON_BLOCKING_FINDINGS** at `1e2b25bc8c20d70ffc0dc2c28f5d0b3d15cce5b3` over review base
`c603f0923d20b463907b471f127f5f870225a4ac`. The status header, activation matrix and slice order above are
updated in place. ADR-0087/0088 are not reopened. This closeout is documentation only: no Product code, no
prerequisite implementation, no Product trigger selection, no Approval field, no ExecutionPlan persistence.

**Ratified with the trigger unselected.** `CAN_ADR_0089_BE_RATIFIED_WITH_TRIGGER_UNSELECTED = YES`, because
every remaining acceptable trigger choice invokes the same coordinator contract. Trigger selection decides
who invokes, when and under what Product authority; it does not change coordinator ownership.
`CONTINUATION_TRIGGER = UNSELECTED / PRODUCT_DECISION_REQUIRED` and
`ACTIVATION_BLOCKED_UNTIL_TRIGGER_SELECTED = YES`. Execution permission must never be inferred from handoff
creation, binding existence, WorkItem ACTIVE, TriggerSource, approval existence or DI registration.

**Actor/Project.** Canonical relational consistency is **not** authorization; the existing relationship
checks do not satisfy the future Product authorization requirement.
`AUTHORIZED_ACTOR_PROJECT_SCOPE = PRODUCT_DECISION_REQUIRED`. No new authorization model is created here.

**Delete policy — strengthened rationale.** `TASKRUN_DELETE_ACTIVATION_PREREQUISITE = YES` and the ratified
policy forbids repository deletion of every continuation-bound TaskRun, including terminal history. Beyond
protecting unresolved STARTED evidence, two independently verified dependencies require retention:

1. `WorkHandoffContinuationService.resolveRun(handoffId, taskRunId)` loads the exact historical bound run by
   id and revalidates `run.taskId` against the canonical binding; deleting that row destroys the provenance
   it returns and degrades to `INCONSISTENT_STATE`.
2. Ordinal allocation is `MAX(json_extract(data, '$.attempt')) + 1` over `task_runs` for the Task. Deleting
   the highest historical attempt lets the next guarded start reuse that ordinal, breaking monotonic
   execution identity.

`arbitrary raw SQL immunity = NOT CLAIMED`; the carve-out stays an explicit trusted-admin boundary.
Test-owned cleanup for **unbound** Tasks is not prohibited by this Product invariant.

**Contention.** `SQLITE_BUSY_ACTIVATION_PREREQUISITE = YES`. Ratified policy is an explicit bounded lock
wait plus a typed storage-contention outcome, with `automatic Application retry = NO`. Storage contention
is **not** `UNRESOLVED_STARTED_RUN`: one is infrastructure, the other a policy conflict. The SQLite adapter
owns driver-error translation; Core must not depend on `SQLITE_BUSY` strings or driver types.

**AgentProfile configuration.** Extend existing typed application configuration;
`NEW_AGENT_PROFILE_REPOSITORY_REQUIRED = NO`. Configuration stays composition-time, immutable, non-secret
and non-authoritative. AgentProfile is not an Actor, not a Provider, not Tool authority and not standing
execution permission. No Provider pinning, credentials, executable paths or Tool allowlists.

**Coordinator and receiver.** `ContinuationExecutionService` is the ratified narrow Core Application
coordinator and the ratified `RECEIVER_INVOCATION_OWNER`: preparation → admission → guarded start → one
receiver invocation → exact TaskRun terminalization, with no aggregate, durable progression state, worker,
queue or lease/claim. `WorkHandoffContinuationService` remains preparation; `ExecutionOrchestrator` remains
stateless intra-task capability composition; `ConversationRuntime` is not the continuation execution owner.
Receiver identity stays exact `WorkHandoff.toAgentProfileId` → configured immutable persona, combined with
the exact bound Task capability → a Product-supported executable capability path; the initial supported
receiver capability set is `PRODUCT_DECISION_REQUIRED`. Guarded start and the receiver call stay in one
invocation on the exact returned TaskRun: no latest-run lookup, queue, worker, lease, claim or dispatch table.

**Terminalization.** `TaskManager.completeRun` / `TaskManager.failRun` remain the owners. Settled success →
SUCCEEDED; settled classified failure → FAILED; process death or unknown remote outcome leaves the exact
TaskRun STARTED and ambiguous. No fabricated terminal outcome, automatic replacement run or restart
recovery. `cancelRun` is not invented. **EXACTLY_ONCE_EXTERNAL_EFFECT = NO CLAIM:** local guarded-start
serialization cannot atomically commit a remote receiver side effect, and a terminal failure does not prove
absence of partial external effects.

**Post-wait context — the shared root cause.** Both the live `ExecutionPlan` and the exact
operation-scoped Approval provenance must survive or reappear after a human wait. That is **one shared
caller-context problem**, owned by M3E-6I-b; solving one does not automatically solve the other.

```text
WHO_OWNS_LIVE_PLAN_BEFORE_WAIT       = invoking caller / in-memory
WHO_SUPPLIES_LIVE_PLAN_AFTER_WAIT    = UNRESOLVED
PLAN_SUPPLY_CONTRACT_CURRENTLY_DEFINED = NO
EXECUTION_PLAN_PERSISTENCE_REQUIRED  = NOT PROVEN
AUTHORITATIVE_POST_WAIT_PLAN_SOURCE  = NONE TODAY
```

Prohibited: reconstructing a plan from `Task.planId`, reconstructing from `ExecutionPlanRef`, or pretending
an `ApprovalRequest` contains the full plan. Three accepted future resolution families, none selected here:
**A.** initial activation only where no human wait must be spanned because the exact approved plan context
is already present; **B.** a separately reviewed scoped persistence amendment; **C.** re-plan and re-approve,
producing a fresh exact live plan. If a future slice cannot establish a safe source, activation remains
disabled.

**Plan predicate.** `LIVE_PLAN_PREDICATE_DEDUP_BEFORE_ACTIVATION = YES`, extracting only the shared pure
structural proof. Gate-specific semantics must not be collapsed between
`WorkHandoffContinuationService.prepare`, `ContinuationExecutionAdmissionService.evaluate` and the future
receiver boundary.

**Approval operation scope.** `ApprovalRequest` currently has no kind/purpose/operation field, and none is
invented here. Ratified requirement: receiver activation must prove the exact selected `ApprovalRequest`
authorizes the exact continuation receiver operation. Architecture preference is to reuse existing Approval
authority plus caller-held acquisition provenance / anchor-style exact `approvalId`. `NEW_APPROVAL_MODEL =
NO`, `NEW_APPROVAL_FIELD = NOT SELECTED`, `NEW_SCHEMA = NOT SELECTED`. If existing contracts cannot prove
scope, activation remains disabled pending a separately reviewed Approval-scope amendment; such an
amendment must not be hidden inside an implementation slice.
`DUPLICATE_PENDING_APPROVAL_ACTIVATION_PREREQUISITE = NO`, conditional on the exact selected `approvalId`
being retained and presented; exactly-once Approval acquisition is not claimed and operator ambiguity is
tracked separately.

**CANCELED.** Before activation: `STARTED → CANCELED` semantics must be explicitly covered,
`CANCELED → STARTED` revival explicitly denied, and no receiver cancellation path may write CANCELED unless
receiver termination is actually proven. This is an activation requirement, not mere test hygiene. No
`cancelRun` is implemented in this closeout.

Implementation state after this closeout: ADR-0089 **Ratified**; M3E-6F architecture **DECIDED**; TaskRun
delete protection **NOT IMPLEMENTED**; explicit busy contract **NOT IMPLEMENTED**; AgentProfile config
surface **NOT IMPLEMENTED**; production trigger **UNSELECTED**; post-wait live-plan contract
**UNRESOLVED**; operation-scoped Approval proof **UNRESOLVED**; receiver invocation **NOT IMPLEMENTED**;
continuation execution activation **DISABLED**. M3E-6G, M3E-6H and M3E-6I-a are independently actionable;
M3E-6I-b must follow the Product Decision gate; M3E-6J must not precede the post-wait context contract.


#### M3E-6G local implementation follow-through (2026-09-22)

ADR-0089's first two persistence prerequisites are now **IMPLEMENTED LOCALLY / AWAITING REVIEW** on base
`cf32815234608d9a46972e2186f35b3d5bcf48eb`, not delivered. The ratified decisions above are unchanged; this
record only reports what exists in code.

`SqliteTaskRunRepository` overrides the inherited generic `delete`. It loads the persisted row, derives the
decision from that row's own `task_id` and the canonical `continuation_bindings` entry inside one
`IMMEDIATE` transaction, and refuses every continuation-bound run — STARTED, SUCCEEDED, FAILED, CANCELED and
historical terminal rows — with the bounded `GuardedTaskRunStartError` code
`CONTINUATION_RUN_DELETE_FORBIDDEN`. No caller flag, argument, convention or run status participates. The
`TaskRunRepository` port documents the invariant so every adapter, including a future Team Edition adapter,
must implement it; the generic `Repository<T>` contract for unrelated aggregates is untouched, so no
public-contract amendment beyond ADR-0089 was required. Unbound TaskRun deletion and missing-id no-op
semantics are preserved. `REPOSITORY_PORT_DELETE_BYPASS = CLOSED`; `RAW_SQL_DELETE_IMMUNITY_CLAIMED = NO`.
Re-parenting a bound run to an unbound Task cannot evade the guard because the existing v11
`task_runs_immutable_start` trigger rejects `task_id`/`attempt`/`startedAt`/`capability` changes; that
database invariant is asserted, not duplicated in application code.

The lock wait is explicit adapter configuration: `DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000` preserves the
previously implicit better-sqlite3 default, and optional `SqliteConfig.busyTimeoutMs` is validated as a
bounded non-negative safe integer at `init()`. Ownership stays in the SQLite adapter/storage configuration;
no SQLite-specific type reaches Core, Core policy, `ContinuationExecutionService` or `TaskManager`.
Recognized driver lock contention before any successful commit is translated by the adapter into the typed
`TASK_RUN_STORAGE_BUSY` outcome, deliberately distinct from the canonical `UNRESOLVED_STARTED_RUN`
live-attempt conflict. Unknown infrastructure failures keep existing repository conventions and are not
swallowed. `AUTOMATIC_APPLICATION_RETRY = NO`: the driver's bounded wait inside one call is not Application
retry, and no retry loop, sleep, replacement `guardedStart` or fabricated attempt identity was added. A
typed busy outcome commits zero TaskRuns and yields no `TaskRun.id`, which future receiver orchestration
depends on.

Eighteen focused real-SQLite tests cover bound delete refusal per status, unbound and missing-id
preservation, re-parenting evasion, ordinal monotonicity across bound terminal history, the explicit
raw-SQL carve-out, a six-child-process delete-versus-`guardedStart` race in which every delete is refused
and no replacement attempt starts, real lock contention mapped to the typed outcome with zero rows, the
contention-versus-live-attempt distinction, and `STARTED → CANCELED` persistence with `CANCELED → STARTED`
revival denied. No `cancelRun` was invented and no production receiver cancellation path exists; the ratified
requirement that a receiver may write CANCELED only when termination is actually proven still stands
unimplemented. M3E-6E guarded-start properties (one winner across six processes, ordinary-start and novel
save rejection, exact inserted run) and ordinary unbound TaskRun start/terminal-update/delete behavior were
re-verified.

No new aggregate, repository, schema, migration, durable state or TaskRun status; dependency direction and
TaskRun repository ownership are preserved. AgentProfile configuration **NOT IMPLEMENTED**; Product Decision
gate **NOT REACHED**; post-wait live-plan contract and operation-scoped Approval proof **UNRESOLVED**;
production continuation caller and receiver invocation **NOT IMPLEMENTED**; continuation execution
activation **DISABLED**. Independent implementation review pending.


#### M3E-6H local implementation follow-through (2026-09-22)

M3E-6G was delivered through **PR #72**, merge commit `80b28ea8fa9746cd970d37f982510ba5be4ada37`
(implementation `9cbe1b1eab39b55a93b582f668698a8c463bc904`), after independent implementation review
**PASS_WITH_NON_BLOCKING_FINDINGS** with 0 blocking findings; the local status above is superseded. Its
carry-forward items — `GuardedTaskRunStartError` naming debt, SQLite timeout upper-bound validation,
`SQLITE_LOCKED` typed mapping and delete/start concurrency-test robustness — remain **TRACKED /
NON_BLOCKING** and were deliberately not remediated here.

ADR-0089's AgentProfile configuration decision is now **IMPLEMENTED LOCALLY / AWAITING REVIEW** on base
`80b28ea8fa9746cd970d37f982510ba5be4ada37`, not delivered. The ratified selection is unchanged: existing typed
application configuration, `NEW_AGENT_PROFILE_REPOSITORY_REQUIRED = NO`.

The hardcoded production `new AgentProfileRegistry([])` is gone. `QUOKY_AGENT_PROFILES` is parsed **only** in
`apps/quoky/src/config.ts`, reusing the established `QUOKY_ACTOR_IDENTITY_MAPPINGS` JSON convention
(`requireRecord`, `requireOnlyKeys`, bounded indexed error codes, no payload echo), and
`createAgentProfileRegistryProvider(config.agentProfiles)` freezes the validated list into one immutable
composition-time `AgentProfileRegistry`. No environment variable is read in Core, the SQLite adapter,
`WorkHandoffContinuationService` or `ContinuationExecutionEntryService`, and no second configuration system
was introduced.

Source truth confirmed the profile as exactly five fields — `id`, `displayName`, `role`, `purpose`,
`instructions` — matching the ADR-0089 review; none was added. Parsing fails closed on invalid JSON, a
non-array root, a non-object or null entry, a missing or non-string field, an invalid id shape, a duplicate id,
any unknown key, blank or oversized text, more than 64 entries and a payload above 1 MiB. Strict unknown-key
rejection is the mechanism that keeps authority out of configuration: `providerId`, `apiKey`, credential and
secret references, `executablePath`, `command`, `tools`, `capabilities`, `permissions` and approval flags are
refused rather than ignored, so a configuration typo cannot silently become policy-looking data. Canonical
bounded-text, control-character, identity and duplicate rules stay owned by `AgentProfileRegistry`; the config
layer contributes structure, ordering-independent duplicate detection and size bounds and then surfaces the
canonical failure at the configuration boundary. `CONFIG_ERROR_ECHOES_RAW_INSTRUCTIONS = NO`: errors report a
bounded code with the entry index, and a sentinel test proves that neither `instructions` text, secret-shaped
values nor the raw payload appears in the message or stack. No secret store, Provider credential, API key or
runtime token is read.

Identity is not silently normalized: ids are never trimmed, lowercased or case-folded, so `Receiver` does not
resolve `receiver`. `WorkHandoff.toAgentProfileId` still resolves through the single existing
`AgentProfileRegistry.get` path — no secondary alias, no fuzzy matching.

Startup compatibility is preserved exactly: absent or blank configuration yields `AgentProfileRegistry([])`,
an explicit `[]` is valid, and an unknown profile lookup still fails closed, so continuation remains
fail-closed and empty configuration is not activation. No default or fallback executable profile was invented.
The registry already copied and froze its input, and that is now asserted rather than changed: mutating the
source array or its member objects after composition cannot alter the active snapshot, resolved profiles and
the registry itself are frozen, and no register/replace/remove/reload/add/set/clear API exists.
`DYNAMIC_PROFILE_REGISTRATION = NO`; no durable persistence was created.

The public contract is documented in `.env.example` with a non-secret example using domain fields only and no
internal implementation class names. Configuration availability is the only behavior change:
`PROFILE_IS_RUNTIME_AUTHORITY = NO`, `PROFILE_SELECTS_PROVIDER = NO`, `PROFILE_GRANTS_CAPABILITY = NO`,
`PROFILE_GRANTS_TOOL_AUTHORITY = NO`, and a structural test proves a resolved profile carries exactly the five
persona keys. A configured profile is neither an execution request nor an execution authorization; the
supported receiver capability set remains Product Decision work and is not encoded in profile configuration.

Coverage: focused configuration parsing cases (absent, blank, explicit empty, one profile, multiple profiles,
invalid JSON, non-array root, entry type, missing field, wrong field type, blank field, invalid id, duplicate
id, six authority-shaped unknown fields, oversized instructions, entry-count and payload bounds, error-echo
sentinel, indexed failure code) plus composition-level tests that resolve the registry through a real Nest
application context offline — empty-configuration fail-closed, configured lookup, snapshot immutability, frozen
structures with no mutation API, and the no-authority structural assertion. No Runtime start, Provider or
network use. M3E-6D/6E/6G continuation regression, ordinary TaskRun behavior and the activation-disabled state
were re-verified.

No new aggregate, repository, schema, durable state or runtime registration API; dependency direction is
preserved and AgentProfile remains configuration-only. Product trigger **UNSELECTED**; Product Decision gate
**NOT REACHED**; post-wait live-plan contract and operation-scoped Approval proof **UNRESOLVED**; production
continuation caller and receiver invocation **NOT IMPLEMENTED**; continuation execution activation
**DISABLED**. Independent implementation review pending.


#### M3E-6I-a local implementation follow-through (2026-09-22)

M3E-6H was delivered through **PR #73**, merge commit `dfb473d882d58805270425657498caebc837c80c`
(implementation `a94ecd765bfb7366581f541376b2afb2295154f4`), after independent implementation review
**PASS_WITH_NON_BLOCKING_FINDINGS** with 0 blocking findings; the local status above is superseded. Its
carry-forward items — error cause-chain redaction test, direct source-object mutation test, duplicate-id error
echo over already bounded input, and readonly config typing — remain **TRACKED / NON_BLOCKING** and were
deliberately not remediated here, as were the earlier M3E-6G persistence carry-forwards.

ADR-0089's `LIVE_PLAN_PREDICATE_DEDUP_BEFORE_ACTIVATION = YES` prerequisite is now **IMPLEMENTED LOCALLY /
AWAITING REVIEW** on base `dfb473d882d58805270425657498caebc837c80c`, not delivered. The ratified boundary is
unchanged: extract only the shared pure structural proof and keep gate-specific semantics separate.

A source audit produced the duplication matrix before any change. Exactly three items were genuinely
identical and structural: (1) the live-plan structural validation block in
`WorkHandoffContinuationService.prepare` and `ContinuationExecutionAdmissionService.evaluate`, differing only
in the locally renamed `canonicalText`/`text` helpers; (2) the plan-reference plus integrity comparison nested
inside `prepare`'s `matchesApproval` and admission's `samePlanRef`; and (3) the `text`/`timestamp`
micro-helpers themselves. Items explicitly judged **not** shareable, matching the ratified wording that
policy-consistency and requester checks stay separate: the `taskRequiresApproval` /
`plan.approvalRequired` / `ApprovalPolicy.evaluate` / capability-risk approval derivation, `prepare`'s
`requestedBy` requirement and exact `ApprovalRequest.id` check, each gate's lifecycle status expectations, and
each gate's failure taxonomy.

The shared module is `packages/core/src/application/continuation-live-plan-proof.ts`, exporting
`isCanonicalText`, `isTimestampText`, `matchesExecutionPlanIntegrity`, `matchesExecutionPlanRef` and
`matchesLiveExecutionPlanStructure`. Its structural dimensions are exactly those both callers already proved:
canonical plan id and goal, `Task.planId` ↔ plan id consistency, plan/Task project consistency, `overallRisk`,
`approvalRequired` type, `status`, `requiredCapabilities` shape with Task-capability inclusion and per-entry
validity, `steps`, `requiredResources`, `estimatedChanges`, `expectedArtifacts`, `createdAt` timestamp, and
the canonical integrity triple when integrity is present. No new proof dimension was introduced.

The helper is pure Core logic: no storage, `ApprovalManager`, `TaskManager`, `AgentProfileRegistry`, Provider,
environment, configuration, clock, I/O or mutable state, and no persistence or cache. It returns booleans
rather than a new decision object, so no failure taxonomy, authority value or durable failure state was
created and both callers keep their existing bounded reason codes. `prepare` keeps `matchesApproval` as its own
gate-specific method, now composed of the shared structural reference comparison plus its exclusive
`requestedBy` and exact-id requirements; requiring canonical text on the persisted side is implied by equality
with a canonically proven expected ref, so behavior is identical.

The helper validates a live plan the caller already owns. It never obtains, persists, caches or reconstructs
one — not from `Task.planId`, not from an `ExecutionPlanRef`, and not from an `ApprovalRequest` — so
`WHO_SUPPLIES_LIVE_PLAN_AFTER_WAIT` and `AUTHORITATIVE_POST_WAIT_PLAN_SOURCE` remain unresolved and M3E-6I-b
is untouched. `Task.planId` participates only as structural consistency and is never execution authority.
Exact approval semantics are intact: exact `ApprovalRequest.id`, APPROVED status, matching `ExecutionPlanRef`
and matching integrity, with no `isApproved(planId)`, any-approved fallback or `Task.planId` authority.
`OPERATION_SCOPED_APPROVAL_PROOF` remains **UNRESOLVED**; `ApprovalRequest` still has no
kind/purpose/operation field and no Approval model or schema changed. AgentProfile/persona semantics were
kept out of the plan proof, no Provider is selected, no Tool authority or receiver capability is granted, and
relational Actor/Project consistency was preserved without becoming an authorization model.

Lifecycle behavior is unchanged. `prepare` still walks `PENDING → PLANNING → RUNNING`,
`PENDING → PLANNING → WAITING_APPROVAL` and exact-authority `WAITING_APPROVAL → RUNNING` through
`TaskManager` alone, creates no TaskRun, performs no guarded start and invokes no receiver. `evaluate` remains
read-only, ephemeral and non-authoritative; the M3E-6E guarded SQLite transaction remains the sole effect-time
authority. `ContinuationExecutionEntryService` was not broadened.

Coverage: 52 focused tests. Direct proof tests cover each structural dimension through a table-driven
one-field-at-a-time mutation matrix, plus integrity/plan-ref comparison cases, non-object inputs,
order-and-history independence with argument-mutation checks, and purity assertions over the module boundary
rather than fragile source-string matching. Cross-consumer tests run both real services over one fixture —
with per-gate Task variants, because their lifecycle expectations legitimately differ — and prove that no
structural mismatch can be accepted by one consumer while rejected by the other, that reason codes may still
differ, that no lifecycle transition or write occurs on structural rejection, that `prepare` alone enforces
`requestedBy`, and that neither consumer proceeds without the caller-supplied live plan. Behavioral parity
evidence is the pre-existing prepare, admission, entry, guarded-start, persistence-safety and configuration
suites passing unchanged.

No new aggregate, repository, schema, migration, durable state, Approval model or ExecutionPlan repository;
dependency direction preserved, the shared predicate is pure, and gate-specific semantics are preserved. This
is the final ratified implementation slice before the **Product Decision gate**, which is **NEXT / NOT
REACHED**: `CONTINUATION_TRIGGER` remains **UNSELECTED**, and `AUTHORIZED_ACTOR_PROJECT_SCOPE` and
`SUPPORTED_RECEIVER_CAPABILITIES` remain **PRODUCT_DECISION_REQUIRED**; none was chosen on the Product Owner's
behalf and M3E-6I-b was not begun. Receiver invocation **NOT IMPLEMENTED**; continuation execution activation
**DISABLED**. Independent implementation review pending.


#### ADR-0089 continuation / M3E-6I-b — Initial no-wait continuation context (2026-09-22)

**IMPLEMENTED LOCALLY / AWAITING REVIEW**, based on
`bd3ede3336b7727a4fb84760c9868eadf7cddb2c`. Product Owner has approved the Product Decision gate;
ADR-0089 remains **Ratified**, with **Family A / NO HUMAN WAIT** selected for initial activation.
M3E-6G, M3E-6H and M3E-6I-a are CLOSED + DELIVERED at this baseline (older local entries below
record their implementation-time status).

- `CONTINUATION_TRIGGER = EXPLICIT_CONTINUATION_EXECUTION_REQUEST` only. Handoff/binding existence,
  lifecycle status, approved requests, profiles and DI registration never infer a trigger.
- `AUTHORIZED_ACTOR_PROJECT_SCOPE = EXACT_WORKITEM_OWNER_AND_EXACT_PROJECT_ONLY`: the explicit request
  actor must equal both canonical WorkItem and Task actors; project must equal both canonical projects,
  including all-three-undefined for projectless work. No session/workspace/current-project fallback.
- Supported receiver capabilities: `GENERAL_CHAT`, `SUMMARIZATION`, `DOCUMENT_ANALYSIS`, `CODE_REVIEW`,
  `ARCHITECTURE_PLANNING`, `READONLY_LOOKUP`, `PROJECT_ANALYSIS`. `CODE_IMPLEMENTATION`, `TEST_EXECUTION`
  and `EMBEDDING` are denied. The Task and every plan required capability must be allowed; executable
  step capabilities must also be allowed and declared. No structural-only capability exception was found.
- `ContinuationExecutionRequestContext` contains only trigger, handoffId, taskId, actorId, optional projectId,
  and the supplied live ExecutionPlan. Its factory defensively copies and recursively freezes that value.
  This is an in-memory copy of the supplied live plan, never persistence or reconstruction from an id/ref.
- `ContinuationExecutionProductPolicy.evaluate` is pure, stateless and synchronous. It reuses the shared
  structural live-plan proof and canonical RiskPolicy/ApprovalPolicy; actual Task risk, Task capability risk,
  plan risk, plan approvalRequired, required capability risk or ApprovalPolicy requiring approval denies
  initial eligibility. An existing APPROVED request or externally supplied approvalId cannot override denial.
- Results are frozen `ELIGIBLE_NO_WAIT` or `DENY(reason)` values, never execution authority, a reservation,
  lease or claim. The future caller must supply exact canonical related facts using existing owners;
  policy does not resolve or replace handoff/binding admission. `prepare` still owns lifecycle/approval
  preparation; admission owns read-only eligibility; M3E-6E guardedStart owns effect-time persisted authority.

```text
PRODUCT_DECISION_GATE = PASSED
REQUEST_AUTHORIZATION_EXPLICIT = YES
INITIAL_ACTIVATION_RESOLUTION = FAMILY A / NO HUMAN WAIT
POST_WAIT_CONTINUATION_SUPPORTED = NO
LIVE_PLAN_CALLER_OWNED = YES
LIVE_PLAN_PERSISTED = NO
LIVE_PLAN_RECONSTRUCTED = NO
OPERATION_SCOPED_APPROVAL_PROOF_FAMILY_A = NOT_REQUIRED
OPERATION_SCOPED_APPROVAL_PROOF_FOR_POST_WAIT = UNRESOLVED / DEFERRED
POST_WAIT_LIVE_PLAN_SOURCE_FOR_INITIAL_FAMILY_A = NOT_APPLICABLE
GENERAL_POST_WAIT_PLAN_SOURCE = UNRESOLVED / DEFERRED
GENERAL_OPERATION_SCOPED_APPROVAL_PROOF = UNRESOLVED / DEFERRED
FAMILY_B_IMPLEMENTED = NO
FAMILY_C_IMPLEMENTED = NO
M3E-6J = NOT STARTED
RECEIVER_INVOCATION = NOT IMPLEMENTED
PROVIDER_SELECTED = NO
PROVIDER_INVOKED = NO
CONTINUATION_EXECUTION_ACTIVATION = DISABLED
```

No new aggregate, repository, schema, migration, durable state, Approval field/model, ExecutionPlan
repository, runtime state or workflow engine. No approval acquisition/decision/latest lookup, wait resume,
post-wait cache, re-plan or re-approve path. AgentProfile configuration and WorkHandoff domain are unchanged.
This selects an already-ratified ADR-0089 resolution family; it does not solve general operation-scoped
Approval proof or post-wait plan supply, and does not reopen ADR-0087/0088.

#### ADR-0089 implementation follow-through / M3E-6J — Explicit continuation execution caller (2026-09-22)

**IMPLEMENTED LOCALLY / AWAITING REVIEW** on delivered main
`56f20c9f24d3700f572f0882ea6accbfca228518`. M3E-6I-b is **CLOSED + DELIVERED** through PR #75
(reviewed HEAD `c8b93291b787bf2a92c79028498b35229da0f03a`, independent review
PASS_WITH_NON_BLOCKING_FINDINGS / zero blocking findings). ADR-0089 Family A remains ratified.
Older slice entries below describe their implementation-time state.

`ContinuationExecutionService.startExplicitContinuation(ContinuationExecutionRequestContext)` now composes:

```text
explicit request → canonical immutable context factory (before first await)
→ WorkHandoffConsumptionService.CONTINUE (canonical handoff/work/profile provenance)
→ exact handoff binding → handoff-derived ACTIVE WorkItem → exact bound Task
→ existing Family-A Product policy → existing lifecycle prepare
→ existing entry (fresh admission + guarded atomic start) → exact returned TaskRun → STOP
```

The service accepts identities and a live plan only; unknown request fields, including caller WorkItem,
Task, binding, handoff, approvalId or Provider, fail closed. Consumption already verifies handoff shape,
work identity/lifecycle and both profiles. Its canonical workItemId is reused for the additional WorkItem
value read needed by Product policy; binding is loaded only by the exact handoff and must match the
requested Task. No current/latest fallback, binding admission/rebinding or duplicated consumption policy.

Product policy runs before any lifecycle mutation. Only RUNNING_READY or ALREADY_RUNNING preparation
can reach entry; prepare denial stops, and WAITING_FOR_APPROVAL becomes bounded HUMAN_WAIT_REQUIRED
without an approval token or resume path. Prepare and entry receive the same snapshotted plan and exact
ids, without approvalId. Entry runs at most once per invocation; its typed admission/guarded-start errors
(including unresolved STARTED, expectation mismatch and storage busy) propagate unchanged, without retry.
The returned TaskRun is the exact entry return, with no post-start lookup or ordinal rediscovery.

```text
CONTINUATION_EXECUTION_SERVICE = IMPLEMENTED LOCALLY
CANONICAL_RELATIONSHIP_RESOLUTION = IMPLEMENTED LOCALLY
CONTEXT_FACTORY_USAGE = ENFORCED BY CALLER
M3E6J_CANONICAL_RELATIONSHIP_RESOLUTION = CLOSED
M3E6J_CONTEXT_FACTORY_USAGE = CLOSED
PRODUCTION_COMPOSITION = WIRED
EXTERNAL_TRIGGER_TRANSPORT = NOT IMPLEMENTED
RECEIVER_INVOCATION = NOT IMPLEMENTED
TASKRUN_COMPLETION_BY_RECEIVER = NOT IMPLEMENTED
PROVIDER_INVOCATION = NO
M3E-6K = NOT STARTED
CONTINUATION_EXECUTION_ACTIVATION = DISABLED
GENERAL_POST_WAIT_PLAN_SOURCE = UNRESOLVED / DEFERRED
GENERAL_OPERATION_SCOPED_APPROVAL_PROOF = UNRESOLVED / DEFERRED
NO_WAIT_DEFENSE_IN_DEPTH_TERMS = INTENTIONAL
STEP_CAPABILITY_DECLARATION_RULE = SUPPORTED_AND_DECLARED_REQUIRED
```

Production composition uses explicit factories for both ContinuationExecutionService and the existing
ContinuationExecutionEntryService. DI availability is not activation: no ConversationRuntime, Discord,
Connector, HTTP, queue or scheduler caller. The offline Nest test uses these production factories with
real Core owners and test-only in-memory SQLite, never AppModule/runtime bootstrap or external Providers.

Policy, prepare, admission and the ephemeral service result are not execution authority; guardedStart
remains the effect-time persisted authority. M3E-6J leaves the concrete run STARTED and does not fabricate
receiver outcomes. M3E-6K must own same-invocation receiver execution and exact-run terminalization.
No new aggregate, repository, schema, migration, durable state, Approval model/field, ExecutionPlan
repository or workflow engine. Existing M3E-6G/6H/6I-a carry-forwards remain unchanged.

#### ADR-0089 implementation follow-through / M3E-6K — Receiver seam and exact-run terminalization (2026-09-22)

**IMPLEMENTED LOCALLY / AWAITING REVIEW** on `cb46950927897092c3c5ff2c55b5ea7e4056fe60`.
M3E-6J is **CLOSED + DELIVERED** through PR #76 (reviewed HEAD
`99f3354d469b06c17a1c073e570e68742276c179`, PASS_WITH_NON_BLOCKING_FINDINGS / zero blockers).
ADR-0089 / Family A remains ratified. Earlier slice entries below are implementation-time history.

The Core `ContinuationReceiver` port accepts immutable canonical handoff, destinationAgentProfile,
live plan and exact started taskRun. Capability comes only from taskRun.capability. It exposes no
storage, approval, Provider routing or workflow authority. The smallest outcome is SUCCEEDED with
artifactIds, or FAILED with the fixed `CONTINUATION_RECEIVER_FAILED` code; optional Provider audit
fields/metadata are not introduced. No real receiver adapter or production receiver binding exists.

`ContinuationReceiverExecutionService.executeExplicitContinuation` accepts only the existing request
context. It shares 6J's strict key check (extracted without changing its behavior), calls the canonical
snapshot factory before the first await, and preflights receiver availability, canonical handoff
consumption/actionability and the exact destination profile before invoking 6J. The retained handoff is
an immutable value from that same preflight read; existing consumption still validates canonical
provenance and profiles. The registry profile is selected only by handoff.toAgentProfileId.

Only `ContinuationExecutionService.startExplicitContinuation` starts attempts. Its DENY is returned
unchanged; existing typed canonical/entry errors propagate. On ATTEMPT_STARTED, the exact returned
run is frozen in place, including nested values, and passed to the receiver by identity. The receiver
observes the same semantic plan snapshot supplied to 6J. No run lookup, capability override, direct
admission/guardedStart or repository save is added.

Receiver success calls TaskManager.completeRun with that exact started object; controlled failure,
unexpected receiver throw or malformed output calls TaskManager.failRun with that same object and
only the fixed bounded failure code. Raw exception details are never persisted. The service returns
the exact terminal TaskRun produced by its owner. Terminalization is outside the receiver catch:
storage failure propagates with no fallback save, receiver retry, terminalization retry or fabricated
terminal state. Task status is not terminalized.

```text
CONTINUATION_RECEIVER_SEAM = IMPLEMENTED LOCALLY
EXACT_RUN_TERMINALIZATION = IMPLEMENTED LOCALLY
REAL_RECEIVER_ADAPTER = NOT IMPLEMENTED
PRODUCTION_RECEIVER_BINDING = NOT IMPLEMENTED
PROVIDER_INVOCATION = NO
EXTERNAL_TRIGGER_TRANSPORT = NOT IMPLEMENTED
M3E-6L = NOT STARTED
CONTINUATION_EXECUTION_ACTIVATION = DISABLED
GENERAL_POST_WAIT_PLAN_SOURCE = UNRESOLVED / DEFERRED
GENERAL_OPERATION_SCOPED_APPROVAL_PROOF = UNRESOLVED / DEFERRED
CONTINUATION_CANONICAL_FAILURE_RESULT_SPLIT = TRACKED
CONTINUATION_WORKITEM_DOUBLE_READ = TRACKED / INTENTIONAL
CONTINUATION_COMPOSITION_TEST_HARNESS = TRACKED / NON_BLOCKING
NO_WAIT_DEFENSE_IN_DEPTH_TERMS = INTENTIONAL
STEP_CAPABILITY_DECLARATION_RULE = SUPPORTED_AND_DECLARED_REQUIRED
```

Post-start process crash may leave an unresolved STARTED attempt. There is no automatic redispatch,
replacement TaskRun or recovery; operator/future recovery policy is required. Exactly-once external
receiver effects are not claimed. Results are same-invocation outcomes, never reusable authority.
No new aggregate, repository, schema, migration, durable state, Approval model, ExecutionPlan repository,
workflow engine or Provider policy. AgentProfile and existing TaskRun insertion/revival/delete safety
are unchanged. Fake receiver plus real 6J/guarded-start/TaskManager/test-only SQLite integration is
focused 6K verification, not M3E-6L activation acceptance. AppModule is unchanged.

#### ADR-0089 implementation follow-through / M3E-6L (2026-09-23)

**IMPLEMENTED LOCALLY / AWAITING REVIEW** on `0b0c3be7c5d8d592b0739b4e8436bfa61731c185`.
M3E-6K is **CLOSED + DELIVERED** through PR #77 (merge `0b0c3be7c5d8d592b0739b4e8436bfa61731c185`,
reviewed HEAD `91834bb144b4d9f581bafcceb3fa1c810c421a8c`, independent review
PASS_WITH_NON_BLOCKING_FINDINGS / zero blockers). M3E-6G/H/I-a/I-b/J remain CLOSED + DELIVERED.
ADR-0089 / Family A is unchanged. Earlier slice entries are implementation-time history.

An isolated Nest application context reuses the production lifecycle, entry, execution and static
AgentProfile registry factories with real Core owners and test-owned in-memory SQLite. The new
`continuationReceiverExecutionProvider` is an unregistered composition candidate: only the acceptance
module binds `CONTINUATION_RECEIVER` to a fake. AppModule, Runtime and Discord are unchanged.
No AiProviderManager, CapabilityRouter/ProviderSelector implementation, AI_PROVIDERS or real CLI adapter
is available in that isolated module. No Product Runtime bootstrap or Provider/network call occurs.

The real acceptance chain is `admit → explicit request → 6K preflight → 6J canonical resolution →
Family-A policy → prepare → fresh admission → guardedStart → fake receiver → completeRun/failRun`.
Success, controlled failure and throw retain exact started-run identity, attempt 1, Task and capability;
TaskManager terminalizes the frozen run and persisted failure contains only CONTINUATION_RECEIVER_FAILED.
Cross-actor/project (including projectless mismatch), unsupported capabilities, HIGH-risk wait, lost live
plan, existing APPROVED requests and approvalId injection fail closed. Configuration, DI, provenance,
ACTIVE/RUNNING state and approval existence grant no implicit trigger or execution authority.

The [19-row acceptance matrix](DECISIONS.md#m3e6l-offline-acceptance-matrix) records 15 PASS and 4
BOUND_TO_EXISTING_REGRESSION, with no FAIL. Same-revision executed regressions cover actual SQLite busy
contention, no Application retry, CANCELED revival denial, ordinary conversation and the raw-SQL carve-out.
Simulated process death after real 6J start retains STARTED; subsequent 6K invocation raises typed
UNRESOLVED_STARTED_RUN without redispatch or attempt 2. Public-port deletion of each exact terminal run
is rejected. Raw SQL remains a trusted-admin boundary: **raw-SQL immunity is NOT CLAIMED**.

```text
OFFLINE_ACTIVATION_ACCEPTANCE = PASS LOCALLY
OFFLINE_ACTIVATION_PREREQUISITES_ACCEPTED = YES (Family A / offline only; awaiting independent review)
FAKE_RECEIVER_COMPOSITION = VERIFIED
RECEIVER_EXECUTION_FACTORY_AVAILABLE = YES
APP_MODULE_RECEIVER_EXECUTION_REGISTERED = NO
CONTINUATION_RECEIVER_DI_TOKEN = TEST_ONLY_BOUND / PRODUCTION_UNBOUND
CONTINUATION_PRESTART_FAILURE_CONTRACT_SPLIT = PINNED / DOCUMENTED / TRANSPORT_NORMALIZATION_DEFERRED
PRE_START_FAILURE_SHAPES = BOUNDED_DENY | TYPED_ERROR
CONTINUATION_CANONICAL_FAILURE_RESULT_SPLIT = TRACKED
CONTINUATION_WORKITEM_DOUBLE_READ = TRACKED / INTENTIONAL
CONTINUATION_COMPOSITION_TEST_HARNESS = VERIFIED (isolated 6L composition)
STARTED_RUN_IN_PLACE_FREEZE = TRACKED / CURRENTLY SAFE
REQUEST_KEY_VALIDATION_OWN_ENUMERABLE_ONLY = TRACKED / PRE_EXISTING / INERT
NO_WAIT_DEFENSE_IN_DEPTH_TERMS = INTENTIONAL
STEP_CAPABILITY_DECLARATION_RULE = SUPPORTED_AND_DECLARED_REQUIRED
REAL_RECEIVER_ADAPTER = NOT IMPLEMENTED
PRODUCTION_RECEIVER_BINDING = NOT IMPLEMENTED
EXTERNAL_TRIGGER_TRANSPORT = NOT IMPLEMENTED
PROVIDER_INVOCATION = NO
RUNTIME_EXECUTION = NO
LIVE_UAT = NO
LIVE_ACTIVATION_AUTHORIZED = NO
STRICT_EXECUTION_AUTHORIZATION = NOT GRANTED
CONTINUATION_EXECUTION_ACTIVATION = DISABLED
GENERAL_POST_WAIT_PLAN_SOURCE = UNRESOLVED / DEFERRED
GENERAL_OPERATION_SCOPED_APPROVAL_PROOF = UNRESOLVED / DEFERRED
```

No new execution semantics, authority, Approval fields/model, plan persistence, schema, migration,
aggregate, repository, durable state, workflow, Provider routing, cancellation API or transport.
No retry, automatic recovery/redispatch, replacement run or exactly-once external-effect claim.
Offline acceptance/ADR ratification/configuration/merge do not authorize live execution.

<a id="m3e6l-offline-acceptance-matrix"></a>

##### M3E-6L offline acceptance matrix

Every BOUND_TO_EXISTING_REGRESSION row below refers to tests actually executed at this local revision,
not inherited pass claims. These are offline prerequisites only, not a completed live-activation gate.
`A` = `apps/quoky/src/continuation-offline-acceptance.test.ts` (20 tests).
`S` = `packages/storage-sqlite/src/task-run-persistence-safety.local-e2e.test.ts` (18 tests).
`J` = `packages/core/src/application/continuation-execution-service.test.ts` (45 tests).
`P` = `packages/core/src/application/continuation-execution-product-policy.test.ts` (53 tests).

| Boundary | Result | Executed evidence / accepted contract |
|---|---|---|
| Explicit trigger | PASS | A: configuration/DI/provenance/ACTIVE/RUNNING alone start no attempt; non-explicit trigger denied; full explicit chain succeeds. |
| Exact Actor | PASS | A: cross-actor denied before prepare/transition/start/receiver/terminalization. |
| Exact Project | PASS | A: cross-project denied; exact projectless request succeeds and added project denies. |
| Supported capability | PASS | A: GENERAL_CHAT full chain; CODE_IMPLEMENTATION, TEST_EXECUTION, EMBEDDING deny before effects. P retains all seven allowlist and step-declaration cases. |
| Human-wait denial | PASS | A: HIGH-risk plan denies HUMAN_WAIT_REQUIRED without approval acquisition. |
| Lost live plan | PASS | A: Task.planId remains set, absent plan or reference-only object rejects INVALID_REQUEST; no reconstruction. |
| Wrong-operation/unrelated approval | PASS | A: persisted APPROVED same/unrelated-plan records still cannot bypass HIGH-risk denial; runtime approvalId injection rejects at strict context boundary. General post-wait scope proof remains deferred. |
| Destination profile | PASS | A: exact handoff.toAgentProfileId selects immutable five-field configured persona; missing destination fails before start; profile adds no capability/Provider/authority. |
| Receiver unavailable | PASS | A: unavailable test binding denies RECEIVER_UNAVAILABLE before 6J. |
| Receiver success | PASS | A: real prepare/admission/guardedStart and completeRun persist SUCCEEDED with artifact ids. |
| Receiver controlled failure | PASS | A: real start and failRun persist bounded FAILED, once. |
| Receiver throw | PASS | A: raw sentinel exception becomes CONTINUATION_RECEIVER_FAILED; raw text absent from persisted run; no retry. |
| Exact TaskRun identity | PASS | A: guarded return === receiver input === TaskManager input; frozen run terminalizes; exact id/task/attempt/capability retained; no post-start get. |
| Storage contention | BOUND_TO_EXISTING_REGRESSION | S: real SQLite write lock maps to TASK_RUN_STORAGE_BUSY with no committed run; J: typed busy error propagates with one entry call and no retry. Bounded driver wait is not Application retry. |
| Unresolved STARTED ambiguity | PASS | A: stop after real ATTEMPT_STARTED, subsequent 6K call yields UNRESOLVED_STARTED_RUN, retains same STARTED row, no receiver/replacement/attempt 2. |
| Terminal-run deletion | PASS | A: public repository delete rejects each SUCCEEDED/FAILED exact run and preserves it. |
| CANCELED revival boundary | BOUND_TO_EXISTING_REGRESSION | S: STARTED→CANCELED persistence, CANCELED→STARTED denied. No new cancelRun or coordinator CANCELED write; this is not proof of receiver cancellation. |
| Ordinary conversation regression | BOUND_TO_EXISTING_REGRESSION | conversation-runtime.test.ts (480), conversation-runtime-negation.test.ts (12), intent-resolver.test.ts (6), all under packages/core/src/application. Production-source audit finds no Runtime/Discord continuation call or automatic handoff trigger. |
| Raw-SQL carve-out | BOUND_TO_EXISTING_REGRESSION | S: public delete rejects but direct SQL in disposable DB deletes. Source audit: storage-sqlite/src/index.ts delete checks canonical binding transactionally; trusted-admin raw SQL stays outside port protection; immunity NOT CLAIMED. |

Totals: **19 rows / 15 PASS / 4 BOUND_TO_EXISTING_REGRESSION / 0 FAIL**.

The accepted pre-start split is pinned by A with the same whitespace-invalid handoff id:
6J returns `DENY / CONTEXT / INVALID_REQUEST`; 6K preflight throws typed
`WorkHandoffConsumptionError(INVALID_HANDOFF_ID)`. Both leave Task PENDING with zero runs,
receiver calls or terminalization. Future transport must handle **both** shapes; normalization is not
implemented. Own-enumerable key semantics remain pre-existing/inert; no generic object-hardening change.
The exact in-place-frozen STARTED run is accepted by current spread-copy completeRun/failRun; revisit
before any in-place TaskRun mutator is introduced.

Production-source audit: the receiver factory is absent from AppModule; CONTINUATION_RECEIVER is bound
only in the isolated test composition. The only production startExplicitContinuation call remains the
existing 6K coordinator. Neither ConversationRuntime nor adapter-discord references these execution
operations. The new factory only constructs existing Core services, with no Provider or transport.

Validation (Node 18.20.5): focused 15 files / 881 tests passed; final full suite 161 files /
3,292 tests passed, including all 20 new acceptance cases. `pnpm typecheck`, `pnpm build`, direct strict
new-test typecheck and `git diff --check` passed. Full suite used `env -u GIT_ASKPASS pnpm test` to avoid
the known inherited askpass sensitivity; no credential value was read. Two test-authoring corrections
were made before final validation: admission errors use `reason`, and Approval fixtures use the existing
`executionPlanRef` helper including required goal. No production execution semantics were changed.


#### ADR-0089 amendment — Production Continuation Receiver R1 (Core contract / lifecycle semantics)

**Status: Implemented locally / awaiting review.** This amendment ratifies the R1 slice of the production
continuation receiver. It changes the Core continuation execution contract only; it does not implement
provider routing, prompt composition, artifact persistence, production receiver binding or any live
execution. Independent Architecture Review returned `PASS_WITH_NON_BLOCKING_FINDINGS`;
`R1_CORE_CONTRACT_READY_TO_START = YES`. `DELIVERED_TEST_CONTRACT_CHANGE = YES`.

**Receiver-supported capability narrowing.** The Core `ContinuationReceiver` port gains an immutable
`readonly supportedCapabilities: readonly Capability[]`. A support declaration can only *narrow*
eligibility; it never grants authority, and the canonical Task remains the capability source. The 6K
coordinator snapshots/copies/freezes the receiver declaration before the first await
(`snapshotReceiverConstraint`). Empty, duplicate, non-`Capability` or otherwise malformed declarations
**fail closed** before any start (bounded `DENY / RECEIVER_PREFLIGHT / RECEIVER_UNAVAILABLE`). The public
caller cannot supply a support list; the later R2 production declaration `supportedCapabilities =
[GENERAL_CHAT]` is supported by the contract but is **not** hard-coded into generic Core behavior.

**Internal constraint is non-authoritative.** The smallest per-invocation
`ContinuationExecutionConstraint { readonly supportedCapabilities }` is package-internal only. It is
absent from `ContinuationExecutionRequestContext`, never accepted from transport/caller input, and never
exposed through the public transport-facing surface. `PUBLIC_REQUEST_CAPABILITY_OVERRIDE = NO`. The
constrained cooperation path (`constrainedContinuation` / `constrainedEntry`, keyed by module-private
symbols) is used only by 6K; the public `startExplicitContinuation(request)` shape and result semantics
are unchanged.

**Early + effect-time capability recheck.** On the constrained path the receiver support snapshot →
internal constraint → 6J canonical Task read → `Task.intent.capability ∈ supportedCapabilities` check
occurs **before lifecycle prepare**. On an unsupported capability: prepare = 0, entry = 0, guardedStart =
0, receiver = 0, TaskRun created = 0. Because Entry fresh admission resolves a later canonical Task
snapshot, the same check is repeated at effect time over `facts.task` — the exact object that becomes the
guarded-start expected Task — with no Task rediscovery after the check. The existing SQLite transactional
deep-equality invariant (`stored Task deep-equals expected.task` and `guarded-start capability ==
expected.task.intent.capability`) closes the effect-time capability TOCTOU; `NEW_GUARDED_START_EXPECTED_
FIELD = NO` (the reviewed invariant held during implementation).

**Family-A recheck only on the constrained path.** The Family-A seven-capability allowlist is defined
once as a pure predicate (`isFamilyACapability`; contents unchanged:
`GENERAL_CHAT, SUMMARIZATION, DOCUMENT_ANALYSIS, CODE_REVIEW, ARCHITECTURE_PLANNING, READONLY_LOOKUP,
PROJECT_ANALYSIS`). `ContinuationExecutionProductPolicy` and the constrained Entry revalidation both call
that predicate; Entry does **not** import or own the Product policy. With the internal constraint absent,
generic `ContinuationExecutionEntryService` semantics are unchanged (no global Family-A specialization);
with the constraint present, the Family-A capability recheck applies at effect time.
`FAMILY_A_ALLOWLIST_CHANGED = NO`; `PRODUCT_POLICY_AUTHORITY_CHANGED = NO`.

**Guarded-start-bound canonical intent facts.** The constrained Entry returns
`{ taskRun, boundTaskFacts: { capability, intentType } }` where `boundTaskFacts` is immutable and derived
from the same `facts.task` snapshot that becomes the guarded-start expected Task.
`CANONICAL_INTENT_SOURCE = GUARDED_START_BOUND_TASK_SNAPSHOT`. Intent is never taken from a 6J
pre-prepare Task, hard-coded CHAT, a post-start Task re-read, the receiver, an AgentProfile or the caller.
The receiver input carries `boundTaskFacts`; `boundTaskFacts.capability == taskRun.capability` and a
mismatch fails closed to unresolved before any future Provider dispatch.

**Three-state receiver outcome.** `ContinuationReceiverOutcome` becomes
`SUCCEEDED { artifactIds; acceptedProviderId?; routingAudit? }` |
`FAILED { error; routingAudit? }` | `UNRESOLVED { reason; routingAudit? }`. There is **no**
`TaskRunStatus.UNRESOLVED` and no new domain lifecycle status. `acceptedProviderId` is allowed only on
`SUCCEEDED`, must be bounded/valid, and (where the audit provides identity) must equal the audit's final
accepted Provider identity. A bounded, provider-agnostic `ContinuationRoutingAudit` DTO lives in the Core
port layer with no Application implementation imports and no coupling to `RuntimeProviderRoutingAudit`;
it is validated/frozen with bounded attempt/transition/string/array lengths and finite non-negative
numerics, uses explicit unknown/null representation (never a fabricated `attemptCount = 0`), and never
contains raw prompt, raw Provider output, raw error, filesystem paths, secrets, credentials, environment,
`descriptor.modelId` or unbounded metadata.

**UNRESOLVED semantics and escaped exceptions.** `receiver UNRESOLVED → completeRun = 0, failRun = 0,
TaskRun remains STARTED, return ATTEMPT_UNRESOLVED` with the exact started TaskRun and same-invocation
bounded evidence only. Any exception escaping `ContinuationReceiver.receive(...)` becomes UNRESOLVED
always — 6K does not inspect the exception type to guess dispatch phase.
`ESCAPED_RECEIVER_EXCEPTION = UNRESOLVED`; `failRun calls = 0`. This is an intentional change from the
delivered M3E-6K behavior. Structurally malformed post-start receiver data that cannot prove termination
also resolves to ATTEMPT_UNRESOLVED; a pre-start contract/config failure remains definite and occurs
before TaskRun start. `UNRESOLVED_AUDIT_PERSISTENCE = NO` — R1 does not persist UNRESOLVED routing audit
onto the STARTED TaskRun and never calls repository `.save()` to update STARTED metadata; UNRESOLVED
audit is same-invocation return only. TaskRun metadata audit is written only for terminalized (SUCCEEDED/
FAILED) runs by `TaskManager`.

**No automatic retry/replacement.** An UNRESOLVED STARTED TaskRun stays STARTED; a subsequent continuation
execution is blocked by the existing unresolved-STARTED protection (no new run).
`AUTO_RETRY = NO`, `AUTO_REDISPATCH = NO`, `REPLACEMENT_RUN = NO`. No cancel/recovery API is added in R1;
operator resolution remains out of scope.

**Delivered test contract change.** Existing tests that pinned `6K receiver throw → failRun` and
`6L acceptance receiver throw → persisted FAILED` are intentionally updated to the ratified semantics
(`receiver throw → ATTEMPT_UNRESOLVED`, TaskRun remains STARTED, failRun = 0, completeRun = 0). This is an
intentional lifecycle contract change, not a weakened assertion. Existing `SUCCEEDED → exact run
SUCCEEDED` and `FAILED → exact run FAILED` behavior is preserved; only escaped/explicit-UNRESOLVED
outcomes change terminalization.

**R1/R2/R3 sequence.** R1 (this amendment) is implemented locally and awaiting review. R2 (provider
routing, prompt composition, artifact persistence, production receiver binding, `QUOKY_CONTINUATION_
RECEIVER_MODE`, uncertainty classification over the audit) is **NOT STARTED**. R3 is **NOT STARTED**. B4
containment is still required before any live UAT, and strict live authorization remains a separate gate:
`LIVE_CONTAINMENT_READY = NO`, `LIVE_PROVIDER_EXECUTION_AUTHORIZED = NO`,
`CONTINUATION_EXECUTION_ACTIVATION = DISABLED`. No production readiness is claimed.


#### ADR-0089 amendment — Production Continuation Receiver R2 (offline provider-backed receiver) (2026-09-26)

**Status: Implemented locally / awaiting review.** This amendment records the R2 slice of the production
continuation receiver: the offline, provider-backed continuation path. It cross-references ADR-0089 and
the Stage2B provider-routing architecture; no new decision family was created. R2 changes the production
routing policy configuration and its configuration digest, adds a Core `composeContinuation` prompt API
and a Core `ContinuationProviderRoutingService`, an app-layer `ProviderBackedContinuationReceiver`, and a
separate `QUOKY_CONTINUATION_RECEIVER_MODE` activation mode. It does **not** implement live provider
execution, real containment enforcement (R3), or any external trigger. `R1 = CLOSED + DELIVERED` (PR #79,
merge `ccb1864d98257ee844723f78155fbb2c2433cb73`). `R3 = NOT STARTED`.

**Sibling routing service.** `ContinuationProviderRoutingService` is a Core Application **sibling** of
`RuntimeProviderRoutingService` — not a wrapper, import dependency, `CapabilityRouter`, or direct
`AiProvider` caller. It reuses the existing Stage2B primitives (`ProviderRegistry`,
`ProviderBindingRegistry`, `RoutingPolicyEngine`, `ProviderExecutionPlanner`, `ProviderRoutingGateway`,
`ValidationProfileRegistry`, deadline policy) and owns only continuation-specific orchestration. It never
treats `handoff.objective` as `currentUserTurn` and inherits no ConversationRuntime semantics.
`RUNTIME_ROUTING_DIRECT_REUSE = NO`; `DIRECT_AI_PROVIDER = NO`.

**Continuation routing policy + chat policy hardening.** Added the ratified production policy
`stage2b-continuation-general-chat-v1` (v1, `when` = capabilities `[GENERAL_CHAT]`, requestTypes
`[WORK]`, intentTypes `[CHAT]`, validationProfiles `[AUTHORITY_SENSITIVE]`; eligibility
`requiredRoutingClasses = [BALANCED]`). The existing `stage2b-general-chat-v1` chat policy is hardened to
require `requestTypes = [CONVERSATIONAL]`, preserving ConversationRuntime behavior. Policy separation is
by **predicate**, not precedence: a CONVERSATIONAL context matches only the chat policy, a WORK/CHAT/
AUTHORITY_SENSITIVE context matches only the continuation policy. `ROUTING_POLICY_CONFIGURATION_CHANGE =
YES`; `CONFIGURATION_DIGEST_CHANGE = YES` (the production digest now deterministically binds both
validation-profile configuration digests, canonically ordered). Pre-R2 digest equality is **not** claimed.

**Fixed routing context + primary-only.** The continuation routing context is fixed: capability
GENERAL_CHAT, requestType WORK, intentType CHAT, semanticRisk STANDARD, latency BALANCED, tool/authority/
continuity NOT_REQUIRED, output MEDIUM, validationProfile AUTHORITY_SENSITIVE. capability/intent are
asserted against the R1 bound Task facts and fail closed otherwise; no caller-supplied overrides.
Primary-only is **enforced in code**: after the planner produces a plan, `operationalFallback === null &&
semanticEscalation === null` must hold, else the result is a definite `PRE_DISPATCH_FAILED` and the
Gateway is never invoked (0 executions). This does not rely on the current provider inventory.

**Prompt ownership + reframe guard.** `PromptComposer.composeContinuation(input)` returns a `PromptSpec`
plus a **separate** bounded validation corpus (never merged into PromptSpec/AiRequest/RoutingContext).
Refs are identifiers only (no Artifact/ExecutionReceipt/resource resolution). AgentProfile persona,
objective and plan are subordinate data, never authority. Bounds fail closed (16 refs/category, 48 total,
256 B/ref, 16 plan steps, 32 KiB rendered prompt, corpus ≤ 8 entries / 4 KiB each / 16 KiB total); an
over-limit corpus entry is excluded by an explicit rule, never truncated; persona echo detection may
omit that oversized directive entry. The continuation prompt uses
distinct section headings and does **not** emit the ConversationRuntime transcript layout
(`## 3. Conversation transcript`) or a `--- Current user message ---` task, so the Ollama adapter passes
it through without a conversation reframe (proven with the real adapter + a fake `CliRunner`).

**Provider-backed receiver.** `ProviderBackedContinuationReceiver` (app layer) implements the Core
`ContinuationReceiver` port with `supportedCapabilities = [GENERAL_CHAT]`. Narrow deps only:
PromptComposer, PromptRenderer, the routing seam, and a narrow Artifact sink — no StorageProvider,
TaskManager, ApprovalManager, or concrete Provider adapter. Preflight failures (unsupported capability/
intent, prompt-bound violations) return **bounded FAILED** (never thrown, so 6K does not convert them to
UNRESOLVED); a non-`ContinuationPromptError` pre-composition escape is re-thrown so 6K maps it to
UNRESOLVED. Post-dispatch exceptions are not caught into FAILED. On ACCEPTED it persists exactly one
platform-owned `MARKDOWN_REPORT` (`text/markdown`, taskId/taskRunId = exact run); Provider-supplied
artifact/task/run ids and URIs are ignored. A definite Artifact save failure → FAILED (no fabricated
success, no retry, possible orphan Artifact documented). The receiver never terminalizes the TaskRun.

**Audit / uncertainty mapping.** The service maps the Stage2B `ProviderExecutionAudit` into the bounded
R1 `ContinuationRoutingAudit` (executionId = exact TaskRun id). Classification uses per-attempt/dispatch
evidence, not final status alone: definite pre-dispatch failure (config invalid, policy not matched, no
eligible provider, primary-only rejected, unsupported facts) → FAILED / NOT_DISPATCHED / attemptCount 0;
dispatched-but-uncertain (post-dispatch TIMEOUT / EXECUTION_FAILED / UNAVAILABLE / SPAWN_FAILED /
DEADLINE) → UNRESOLVED / DISPATCHED; provider returned + terminal validation → ACCEPTED (SUCCEEDED) or
FAILED. Produced outcomes are accepted by the R1 `snapshotReceiverOutcome` validator.

**Activation mode.** `QUOKY_CONTINUATION_RECEIVER_MODE = disabled | general-chat-v1` (default `disabled`),
kept separate from `QUOKY_PROVIDER_ROUTING_MODE`. `disabled` → receiver binding absent, no composition, no
external caller (AppModule unchanged; the R1 acceptance test that asserts AppModule has no
`CONTINUATION_RECEIVER` still holds). Production `loadConfig` explicitly rejects `general-chat-v1` with
`CONTINUATION_RECEIVER_CONTAINMENT_UNAVAILABLE` until R3 containment is delivered. The activation factory
is NOT wired into production AppModule. The isolated offline factory can compose with fake verified
containment, fake providers, and a configured destination AgentProfile snapshot. It checks every profile's
minimal legal continuation envelope using the real composer/renderer and UTF-8 byte bound, rejecting an
infeasible fixed persona with `CONTINUATION_RECEIVER_PROFILE_PROMPT_INFEASIBLE`, without truncation.
Larger request envelopes remain subject to request-time bounds. R2 is offline implementation only; R3
remains required.

```text
CONTINUATION_ROUTING_SERVICE = ContinuationProviderRoutingService (Core sibling)
CONTINUATION_POLICY = stage2b-continuation-general-chat-v1
CHAT_POLICY_NARROWED = YES (requestTypes = [CONVERSATIONAL])
REQUEST_TYPE = WORK ; INTENT_SOURCE = R1 bound Task facts ; VALIDATION_PROFILE = AUTHORITY_SENSITIVE
PRIMARY_ONLY_ENFORCED = YES (in code)
PROMPT_OWNER = PromptComposer.composeContinuation ; CONVERSATION_REFRAME = NOT TRIGGERED
RESOURCE/ARTIFACT/RECEIPT_REF_RESOLUTION = NONE (identifiers only)
OUTPUT_OWNER = platform ArtifactManager ; ARTIFACT_KIND = MARKDOWN_REPORT ; PROVIDER_ARTIFACT_IDS_TRUSTED = NO
TASKRUN_TERMINALIZATION_IN_RECEIVER = NO ; EXECUTION_ID_EXACT_RUN = YES
CONTINUATION_MODE = disabled | general-chat-v1 ; DEFAULT_MODE = disabled ; PROVIDER_ROUTING_MODE_COUPLED = NO
ENABLED_WITHOUT_CONTAINMENT = STARTUP_FAIL_CLOSED ; PRODUCTION_LIVE_READY = NO
PRODUCTION_PROVIDER_BACKED_RECEIVER = IMPLEMENTED OFFLINE
CONTINUATION_EXECUTION_ACTIVATION = DISABLED / NOT LIVE-READY
LIVE_CONTAINMENT_READY = NO ; LIVE_PROVIDER_EXECUTION_AUTHORIZED = NO ; RUNTIME_EXECUTION_AUTHORIZED = NO
R3 = NOT STARTED ; DISCORD_LIVE_UAT_AUTHORIZED = NO
```

No new aggregate, repository, schema, migration, durable workflow state, Approval model, ExecutionPlan
persistence, post-wait plan source, live provider execution, containment enforcement, external runtime
trigger, direct AiProvider bypass, or CapabilityRouter bypass. R2 production enabled mode remains fail-
closed until R3 containment exists.

**R2 review remediation (B-1–B-4).** Earlier reviewed R2 code parsed enabled production mode without
calling the offline factory; the startup claim above is now enforced in the real `loadConfig` path.
Gateway invocation is explicitly tracked: any escape after invocation, including after Provider return,
becomes UNRESOLVED / UNKNOWN / attemptCountKnown=false / attemptCount=null, without fabricated attempts.
The corpus is passed only through Application `ProviderRoutingValidationFacts.contextCorpus`; continuation
AiRequest has no corpus contextFiles. Persona/directive material still authors the intended prompt; the
validator corpus is not separately injected as Provider context. Explicit contextCorpus (including [])
overrides validation input; absent contextCorpus preserves Runtime contextFiles fallback and the original
Provider-facing Runtime request. This extends the Gateway Application API, not the Core AiRequest port.

`PROVIDER_AUTH_REQUIRED` remains a definite FAILED outcome: the typed adapter result denotes a completed
authentication refusal, not a timeout or ambiguous termination. It does not claim NOT_DISPATCHED or no
side effects: dispatch evidence remains DISPATCHED. An untyped escape or uncertain operational failure
remains UNRESOLVED. This relies on adapters honoring the AUTH_REQUIRED failure contract.


#### ADR-0089 amendment — R3 Architecture v3 RATIFIED WITH FEASIBILITY GATE + R3-A implemented (2026-09-26)

**Status: R3 Architecture v3 = RATIFIED WITH FEASIBILITY GATE. R3-A implemented locally / awaiting
independent review.** This amendment records the independently reviewed and ratified R3 containment
architecture (v3) and the R3-A runtime-family-independent foundations. It cross-references ADR-0089 and
the Stage2B provider-routing architecture; no new decision family was created. Independent reviewer:
`BLOCKING_FINDINGS = 0`; `R3_A_B_IMPLEMENTATION_ARCHITECTURALLY_SEPARABLE = YES`;
`R3_IMPLEMENTATION_AUTHORIZED_BY_REVIEW = NO`. Chief Architect authorized **R3-A ONLY**; R3-B/C/D/E are
NOT authorized.

**Ratified architecture (v3).**
```text
R3 Architecture v3        = RATIFIED WITH FEASIBILITY GATE
runtime selection         = PENDING
production host           = UNDEFINED (PRODUCTION_HOST_DECISION_REQUIRED)
R3-C+                     = BLOCKED pending Strict R3_CONTAINMENT_FEASIBILITY_UAT
Option A                  = no-network contained execution family (ephemeral container per exact attempt;
                            private in-container Ollama daemon + one-shot client; RO digest-pinned model
                            volume). Shared-VM kernel-escape residual is explicitly documented (Option A
                            does not protect against a container kernel escape into the shared runtime VM).
Option C                  = no-NIC VM comparison family (intentional vsock/virtiofs/stdin-stdout I/O in
                            threat model). Stronger vs shared-VM network escape; higher startup/memory/ops.
startup guard             = UNCHANGED (general-chat-v1 → CONTINUATION_RECEIVER_CONTAINMENT_UNAVAILABLE)
Live Provider             = NOT AUTHORIZED
```

**R3-A scope delivered (runtime-family-independent; ZERO runtime/container/VM/Ollama/network/production
activation).**
- Separate bounded Core containment audit contract `ContinuationContainmentAudit`
  (`continuation-containment-audit-v1`), independent of and never merged into
  `continuation-routing-audit-v1`. Core-visible bounded semantic facts only; NO raw container ID,
  OrbStack/Docker path, inspect JSON, CLI argv, host filesystem/socket/mount path, environment dump, or
  raw runtime error. Adapter/runtime identity contributes to a digest without being surfaced raw.
- Strict fail-closed projection `snapshotContainmentAudit` (inert descriptor-safe: reads each field once
  from its own data descriptor; rejects accessors, symbol keys, unknown keys, prototype pollution,
  malformed digests/enums, and cross-run identity mismatches).
- TaskRun-owned atomic containment evidence persistence (no new repository, no new table, no schema
  migration): `recordContainmentBindingIfAbsent` (insert-once CAS), `recordContainmentPostEvidenceIfAbsent`
  (append-once), `terminalizePreservingSecurityEvidence` (current-row terminal merge). All run inside the
  repository's existing exclusive `db.transaction(...).immediate()` (BEGIN IMMEDIATE).
- Narrow Application seam `ContinuationContainmentEvidenceSink` (record-binding / record-post-evidence);
  TaskManager implements it and remains the sole lifecycle/mutation owner
  (`PERSISTENCE_OWNERSHIP_CHANGE = NO`). The receiver never injects TaskManager and gains no generic
  metadata-mutation capability.
- Bounded typed failure `ContainmentEvidenceConflictError` (single `code =
  CONTAINMENT_EVIDENCE_CONFLICT`, bounded `reason`).
- Failure/uncertainty mapping amendment: `CONTAINMENT_FAILURE` and `MODEL_DOWNLOAD_DETECTED` become
  UNRESOLVED once an attempt is dispatched (added to
  `ContinuationProviderRoutingService.isPostDispatchUncertain`), remaining definite FAILED pre-attempt.
  Pure phase-sensitive classifier (`classifyContainmentFailure`, `classifyProviderSpawnFailed`):
  PRE_ATTEMPT definite failure → FAILED; ATTEMPT_STARTED/POST_ATTEMPT uncertainty → UNRESOLVED;
  `PROVIDER_SPAWN_FAILED` is phase/evidence-sensitive, never globally classified. No new TaskRunStatus.

**Mandatory amendments.**
- **A-1 (generic-save evidence immutability).** For continuation-bound runs the generic
  `taskRuns.save(fullRun)` now rejects, inside the existing bound-run IMMEDIATE transaction, any write
  that removes or mutates durable containment evidence (binding-digest change, evidence removal, or a
  different append-once post-attempt value); identical preservation is allowed. No migration.
- **A-2 (prepared-execution structural substitution + digest naming).** RECORDED for R3-B (no runtime
  code now): future continuation contained execution must use a `PreparedContainmentExecution`
  (Application capability whose identity includes `executionId`, `providerId`, `containmentBindingDigest`,
  and whose `execute` is closed over the verified runtime instance); the raw host Ollama provider must be
  ABSENT or sentinel-refusing so the Gateway cannot fall through to it. NO containment fields are added to
  `AiRequest`. Digest naming ambiguity is closed: the Stage2B provider binding digest (over
  providerId/adapterId/modelId/bindingVersion/profileVersion) is `providerBindingDigest`; the R3
  containment binding digest is `containmentBindingDigest`. They are never conflated in new APIs.
- **A-3 (scoped model identity + post-attempt revalidation).** The audit MUST NOT claim the exact model
  bytes were immutable throughout execution against a privileged host/runtime actor. `modelIntegrityStatus`
  supports `VERIFIED_AT_BIND` at bind and a bounded post-attempt disposition
  (`MATCHED | MISMATCH | NOT_REVERIFIED | UNAVAILABLE`). Post-attempt `MISMATCH` → integrity flag →
  UNRESOLVED. Privileged host/runtime mutation is explicitly out of scope for the Provider-egress invariant.
- **A-4 (private daemon readiness is strictly non-inference).** Semantic policy only in R3-A (no daemon
  implemented): allowed pre-dispatch readiness = non-inference operations (version/tags/source-equivalent);
  FORBIDDEN before Gateway dispatch = pull, create, generate, model inference, cloud routing. Cloud
  capability = disabled; model storage = read-only. Any future model pre-warm needs explicit semantic
  classification and separate review; inference is never quietly interpreted as readiness.

**Static eligibility contract (Architecture v3 §23 / R3-A §28).** Continuation preparation must derive
primary-only STATIC eligible candidates BEFORE expensive containment preparation, reusing
`RoutingPolicyEngine` + `ProviderExecutionPlanner`/ranking semantics with no fabricated "all AVAILABLE"
availability evidence and no duplicate ranking algorithm; anything other than exactly one acceptable
candidate → pre-dispatch FAILED with no runtime instance created. The cleanest implementation belongs in
R3-B (it interacts with the prepared-execution substitution); R3-A records this contract and defers the
code. No host `isAvailable()` may serve as continuation availability evidence
(`HOST_PROVIDER_AVAILABILITY_REUSED = NO`); ordinary Runtime paths are unchanged.

**Persistence mechanics (grounded).** `task_runs.data` is a JSON document already carrying arbitrary
`metadata`; the v11 `task_runs_immutable_start` trigger freezes only `id/task_id/attempt/startedAt/
capability` (not `status`/`metadata`), so a STARTED→STARTED metadata write and current-row terminal merge
are mechanically allowed. Insert-once/append-once is enforced by repository compare-and-set inside BEGIN
IMMEDIATE, not by a v12 trigger. `SCHEMA_MIGRATION = NO`, `NEW_REPOSITORY = NO`, `NEW_SCHEMA = NO`.

**Gates.**
```text
R3_B_AUTHORIZED = NO ; R3_C_PLUS_AUTHORIZED = NO
PRODUCTION_HOST_DECISION = PENDING ; R3_CONTAINMENT_FEASIBILITY_UAT = NOT AUTHORIZED
FINAL_RUNTIME_SELECTION = PENDING ; LIVE_PROVIDER = NOT AUTHORIZED
```

No R3 implementation is claimed complete. No container/VM/Ollama/network/runtime activation and no
production startup-guard removal were performed in R3-A.


#### ADR-0089 amendment — R3-A containment-evidence ownership remediation (2026-09-26)

**Status: Remediation implemented locally / awaiting review.** Independent exact-HEAD review of the R3-A
implementation commit (`cb141e2e41599f6a42108ffec3d9172cd30b8b86`) returned `CHANGES_REQUIRED` with three
blocking implementation defects (no new architecture decision required). This remediation adds exactly one
additional local commit that closes them; the reviewed R3-A commit is preserved unamended. Still ZERO
runtime/container/VM/Ollama/network/production activation; no R3-B/C/D/E.

**B-1 — generic save must never create/mutate/remove containment evidence.** The A-1 comparator
`containmentEvidencePreserved` intentionally permits a *semantic CAS* to create binding evidence or add
post-attempt evidence, so it was too permissive for a *generic* `taskRuns.save()`: `current absent +
incoming present` was allowed, letting a generic save CREATE evidence. A new strict comparator
`containmentEvidenceIdentical(current, incoming)` — `both absent OR both present and semantically
identical (binding identical AND post-attempt both-absent-or-identical)` — now gates generic save on a
continuation-bound run inside the IMMEDIATE transaction. Rules (§2/§3/§4): both absent → ALLOW; both
present & identical → ALLOW; create/remove/change → REJECT, regardless of STARTED/SUCCEEDED/FAILED.
Evidence creation/mutation is reserved for the semantic CAS APIs only. Reason mapping: create attempt →
`MALFORMED_EVIDENCE`, removal → `EVIDENCE_REMOVED`, change → `BINDING_DIGEST_CONFLICT`.

**B-2 — terminalize must never accept caller-supplied evidence.** `terminalizePreservingSecurityEvidence`
now rejects (does not silently strip) any `request.metadata` carrying `CONTAINMENT_AUDIT_METADATA_KEY`
with a bounded `ContainmentEvidenceConflictError('CALLER_SUPPLIED_EVIDENCE')` — surfacing the caller
contract violation. The ONLY source of containment evidence is the CURRENT persisted row; caller metadata,
caller startedRun snapshot, and caller terminal payload can never create or replace it. Unrelated caller
metadata is still merged; the current-row containment evidence is always preserved exactly.

**B-3 — evidence operations require a continuation-bound run.** `recordContainmentBindingIfAbsent`,
`recordContainmentPostEvidenceIfAbsent`, and `terminalizePreservingSecurityEvidence` now require the exact
run to be continuation-bound, checked via the canonical continuation-binding source of truth
(`isBound(run.taskId)`) INSIDE each op's IMMEDIATE transaction (no check-outside-then-mutate race). An
ordinary/unbound run is rejected with `ContainmentEvidenceConflictError('RUN_NOT_CONTINUATION_BOUND')`; no
containment audit can ever be written to an ordinary TaskRun. Ordinary/unbound `save`/`completeRun`/
`failRun` are unchanged (no continuation-specific restriction is applied globally).

**Preserved / unchanged.** `continuation-routing-audit-v1` is untouched. CAS atomicity (all semantic ops
inside `transaction(...).immediate()`) is unchanged. The failure mapping (`CONTAINMENT_FAILURE`/
`MODEL_DOWNLOAD_DETECTED` after attempt → UNRESOLVED; `PROVIDER_SPAWN_FAILED` phase-sensitive) is not
regressed. SQLite verification is `:memory:` only.

**Mandatory future-integration carry-forward (R3-B/C).** These are recorded here as required future work,
NOT implemented now:
1. `ContinuationReceiverExecutionService` still terminalizes via `completeRun`/`failRun` using the old
   `startedRun` snapshot. Today that fails closed when containment evidence exists (the B-1 guard rejects
   the stale terminal write). **Before contained continuation execution can become reachable,
   `ContinuationReceiverExecutionService` terminalization MUST route through
   `terminalizePreservingSecurityEvidence`** (current-row terminal merge). This is mandatory R3-B/C
   integration work; expanding it now would be R3-B/C runtime restructuring and is out of R3-A scope.
2. `postAttemptModelIntegrity = MISMATCH → UNRESOLVED` remains a contract only (no runtime producer exists
   yet). Runtime mapping is deferred to R3-B/C integration; R3-A adds no producer.

```text
GENERIC_SAVE_CAN_CREATE_BINDING = NO
GENERIC_SAVE_CAN_CREATE_POST_EVIDENCE = NO
GENERIC_SAVE_CAN_REMOVE_EVIDENCE = NO
GENERIC_SAVE_CAN_CHANGE_EVIDENCE = NO
GENERIC_SAVE_IDENTICAL_EVIDENCE_ALLOWED = YES
CALLER_CAN_SUPPLY_CONTAINMENT_AUDIT = NO
TERMINALIZE_EVIDENCE_SOURCE = CURRENT_PERSISTED_ROW
BINDING_CAS_REQUIRES_CONTINUATION_BOUND = YES
POST_CAS_REQUIRES_CONTINUATION_BOUND = YES
SECURITY_TERMINALIZE_REQUIRES_CONTINUATION_BOUND = YES
ROUTING_AUDIT_V1_CHANGED = NO
R3_B_AUTHORIZED = NO ; R3_C_PLUS_AUTHORIZED = NO ; LIVE_PROVIDER = NOT AUTHORIZED
```


#### ADR-0089 amendment — R3-B3 Production Containment Trust Closure (2026-09-27)

**Status: Implemented locally / awaiting independent exact-HEAD review.** R3-B3 closes the remaining
runtime-independent production trust boundaries before any R3-C runtime/feasibility work. It implements NO
real container/VM runtime, NO real Ollama/Provider execution, NO network verification, and NO Live UAT.
It is runtime-family-independent and introduces no new aggregate/repository/TaskRunStatus/approval model
and no DB schema/migration.

**Item 1 — Channel A/B production provenance trust model.** `ContainmentChannelResult` now carries durable,
SERIALIZABLE trust facts: `trustDomain ∈ {TEST, PRODUCTION}` and a `verifierProvenanceId`. `TEST` is the
only domain any code in this slice can legitimately produce (no real verifier runtime exists). Channel A
and Channel B must present DISTINCT `verifierProvenanceId`s (independence), enforced both in
`prepareVerifiedContainmentBinding` and in the new `requireProductionTrustedVerification`, which fails
closed unless BOTH results are `PRODUCTION` with independent provenance — so no production issuer exists,
it always fails closed today. Arbitrary caller code cannot make a result production-trusted merely because
`status=VERIFIED` and digests/versions are well-formed.

**Item 2 — fake vs production contained capability separation.** `ContainedExecutionCapability` gains a
`capabilityKind ∈ {FAKE, PRODUCTION}`. The module-issued deterministic fake is stamped `FAKE`. The new
`requireProductionContainedCapability` requires a genuinely issued capability AND `capabilityKind ===
'PRODUCTION'`; a FAKE (or a forged/unissued object) is rejected. No production capability issuer exists
in R3-B3, so the requirement always fails closed now; it is the exact seam a future R3-C runtime issuer
will satisfy without changing R3-B1/B2 non-forgeability guarantees. The fake remains usable by tests.

**Item 3 — continuation-bound generic terminalization guard (evidence-independent).** The storage
`SqliteTaskRunRepository.save` now rejects ANY generic terminal transition (STARTED → SUCCEEDED/FAILED)
on a CONTINUATION-BOUND persisted STARTED row, regardless of whether containment evidence is attached —
closing the R3-B2 carry-forward gap where a bound STARTED run with no evidence could still be generically
terminalized. The decision is derived from the CURRENT persisted row + the canonical continuation binding
inside the IMMEDIATE transaction (never caller state), with a dedicated bounded reason
`CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH`. Only `terminalizePreservingSecurityEvidence` may
terminalize a bound run. Ordinary/non-continuation `completeRun`/`failRun`/`save` are unchanged.

**Item 4 — durable prepared-evidence provenance boundary.** `VerifiedContainmentBinding` now carries a
durable, SERIALIZABLE `provenance` record (`provenanceSchema`, `trustDomain`, independent channel
provenance ids, domain-separated `provenanceDigest`). Integrity ("canonical fields + correct
`containmentBindingDigest`") is now explicitly SEPARATED from production trust: the new
`requireProductionPreparedProvenance` requires the binding to be module-issued, its provenance digest to
recompute, AND `trustDomain === 'PRODUCTION'` — so a legitimately-produced (TEST) binding fails closed,
and a legacy R3-A structural audit (which has no such provenance) can never masquerade as prepared
production evidence. This is durable across persistence/restart (a serializable field, not a process-local
WeakSet); the WeakSets remain the in-process non-forgeability mechanism for B-1/B-2.

**Legacy R3-A audit boundary (§5).** Legacy R3-A audit provenance is NOT broadly redesigned. The stronger
trust boundary is limited to the prepared/R3-B production form; legacy evidence cannot satisfy
`requireProductionPreparedProvenance` (no prepared provenance), and the future R3-C production path will
require the stronger prepared form. Documented + tested.

```text
CHANNEL_TRUST_DOMAIN = TEST | PRODUCTION (durable/serializable)
PRODUCTION_TRUSTED_VERIFICATION = FAILS CLOSED (no production issuer)
CHANNEL_A_B_PROVENANCE_INDEPENDENT = REQUIRED
CONTAINED_CAPABILITY_KIND = FAKE | PRODUCTION ; FAKE_PRODUCTION_ELIGIBLE = NO ; PRODUCTION_ISSUER_EXISTS = NO
BOUND_STARTED_GENERIC_TERMINALIZATION = REJECTED (with or without evidence)
SECURE_TERMINALIZATION = SOLE TERMINAL PATH FOR BOUND RUNS
PREPARED_EVIDENCE_PRODUCTION_TRUST = DURABLE PROVENANCE (hash integrity ≠ production trust)
LEGACY_R3A_MASQUERADE_AS_PREPARED = IMPOSSIBLE
PROVIDER_BINDING_DIGEST_VS_CONTAINMENT_BINDING_DIGEST = DISTINCT (unchanged)
EXACT_RUN_CONTEXT_DIGEST_BINDING = INTACT (R3-B2 unchanged)
R3B1_NON_FORGEABILITY_AND_FAKE_PACKAGE_ISOLATION = INTACT
REAL_RUNTIME/PROVIDER/NETWORK_REACHABLE = NO
NEW_AGGREGATE/REPOSITORY/STATUS/APPROVAL/DB_SCHEMA = NO
```

Mandatory carry-forward (unchanged): no production contained-continuation execution path may become
reachable until secure terminalization is integrated through `terminalizePreservingSecurityEvidence`
(already the sole terminal path for bound runs). Intentionally deferred: selection-token single-use
semantics; broad channel exception taxonomy; NOT_REVERIFIED/UNAVAILABLE policy; real Docker/OrbStack/VM
runtime; real Channel A/B verification; real contained execution capability issuer; Ollama/Provider
execution; network; R3 containment feasibility UAT; final runtime-family selection; R3-C/R3-D/R3-E; Live
UAT. Ollaya / provider-routing direction remains future-only context and is NOT in this scope.

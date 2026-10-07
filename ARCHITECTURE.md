# Quoky Platform — Architecture Constitution

> This document is the **permanent architectural authority** for Quoky.
> All implementation MUST conform to it. Changing this document requires a
> recorded decision in `DECISIONS.md` (ADR). Code that violates this document is
> a defect, regardless of whether it works.

**Status legend** — every concept below is tagged:
`[NOW]` exists in the codebase · `[RESERVE]` a cheap seam to add before business logic ·
`[LATER]` deliberately deferred (do not build yet).

---

## 1. Vision

Quoky is a **local-first, long-lived personal AI platform** whose first
interface happens to be Discord. It is not a Discord bot. The user converses
naturally; the system decides *what capability* is needed and *which AI engine*
serves it. Models are interchangeable implementation details. The same Core must
power a future **Team Edition** without being rewritten.

We optimize for **longevity and replaceability over short-term convenience.**

---

## 2. Core Principles

1. **Capabilities are above models.** The user asks for an outcome; the system
   maps it to a `Capability`; a router picks an available provider. Users never
   pick a model per request: the system maps each request to a Capability and the
   router selects a provider automatically. The owner may, however, select which
   providers are installed for a capability tier through installation
   configuration, the operations UI, or an owner chat command (session-scoped)
   (Claude / Codex / Ollama, OpenClaw-style; ADR-0092 and ADR-0111 amendments).
   The provider that answered is recorded for audit only.
2. **The Core knows nothing concrete.** No Discord, SQLite, Claude, Codex,
   Ollama, HTTP, or NestJS type may appear in `@quoky/core`. Core depends only
   on its own ports and domain.
3. **Every infrastructure component is replaceable** behind a port.
4. **Dependencies point inward:** `apps → adapters → core`. Core depends on
   nothing in the workspace.
5. **Quoky Memory is the source of truth** — never a model's internal memory.
6. **Governance is explicit.** External-impact and destructive actions pass a
   risk-based approval gate. Nothing dangerous runs implicitly.
7. **Personal → Team without Core changes.** Identity, storage, queue, and
   transport are abstracted so the edition is a wiring choice, not a rewrite.
8. **Reserve seams early, build features late.** Concepts that are expensive to
   retrofit are introduced as thin seams before business logic; their behavior
   is implemented later.

---

## 3. Layer Responsibilities

```
Platform (Discord, …)  ─▶  Composition Root (NestJS app)  ─▶  Core
                                                              ├─ Domain (entities, value objects, enums, events)
                                                              ├─ Ports (interfaces + DI tokens)
                                                              └─ Application services (orchestration)
Adapters (one package per concrete provider) implement Ports.
```

- **Domain** — pure data + invariants. No I/O, no framework. `[NOW]`
- **Ports** — the only contracts the outside world implements. `[NOW]`
- **Application services** — orchestration & policy. Deterministic plumbing is
  implemented; model-driven cognition is explicit and isolated. `[NOW]`
- **Composition Root (`apps/quoky`)** — the ONLY place that imports concrete
  classes and binds them to port tokens. Swapping an implementation is a
  one-line change here. `[NOW]`
- **Adapters** — translate between the outside world and the domain. All
  platform/storage/CLI specifics live here and never leak inward. `[NOW]`

---

## 4. Domain Concept Map

Authoritative list of domain concepts and their status. The relationships are
fixed; the implementations are not.

| Concept | Role | Status |
|---|---|---|
| `Actor` / `Principal` | Platform-independent identity authz hangs off | `[NOW]` |
| `Session` | Conversation aggregate root (thin: identity, lifecycle, pointers) | `[NOW]` |
| `Task` | A unit of work within a session | `[NOW]` |
| `WorkItem` | Actor-owned durable work, high-level lifecycle only (ADR-0075) | `[NOW]` |
| `WorkHandoff` | Immutable AgentProfile-to-AgentProfile provenance (ADR-0080) | `[NOW]` |
| `ContinuationBinding` | Immutable WorkHandoff ↔ Task provenance/correlation (ADR-0084); not execution state, runtime authority, TaskRun, receipt or workflow | `[NOW]` |
| `ExecutionReceipt` | Immutable CAP-013 command execution provenance (ADR-0078) | `[NOW]` |
| `TriggerSource` | Bounded provenance and read-only decisions (ADR-0081/0082/0083), no scheduler | `[NOW]` (execution `[LATER]`) |
| `TaskRun` | One execution attempt of a Task (+ `Usage`/cost) | `[NOW]` (Usage `[RESERVE]`) |
| `Intent` | Classified meaning of a message → a `Capability` | `[NOW]` |
| `Plan` / `PlanStep` | **Intra-task** decomposition | `[NOW]` |
| `Workflow` | **Inter-task** orchestration (≠ Plan) | `[LATER]` (field not reserved — YAGNI per ADR-0013; JSON storage makes late-add free) |
| `Capability` | The routing key from need → provider | `[NOW]` |
| `AgentProfile` | Immutable persona configuration: id, displayName, role, purpose, instructions (ADR-0079) | `[NOW]` (runtime `[LATER]`) |
| `MemoryRecord` (6 types) | Source-of-truth memory | `[NOW]` |
| `ContextBundle` | Assembled, budgeted context for one run | `[NOW]` |
| `PromptSpec` | Layered, provider-agnostic prompt | `[NOW]` |
| `ResourceRef` | Uniform **input** reference (PDF, URL, ticket, repo file) | `[NOW]` (M3A-1, ADR-0074) |
| `Artifact` (8 kinds) | First-class **output** | `[NOW]` |
| Domain `Event`s | `TaskCreated`, `TaskStatusChanged`, `RunCompleted`, `Approval*` | `[RESERVE]` |
| `WorkspaceRef` | Resolved working directory | `[NOW]` |
| `Approval*` | Governance records | `[NOW]` |
| `Reminder` | Owner-created, actor-owned durable record whose only effect is bounded plain text to that owner at a computed time (ADR-0101); not a Task, TaskRun, WorkItem or trigger; no general scheduler | `[NOW]` (delivery wiring lands with PRO-5) |

**Hard rule:** `Resource` is an **input** the system reads; `Artifact` is an
**output** the system produces. They never merge.

---

## 5. Provider Rules

1. Core depends only on the `AiProvider` interface. It MUST NOT import a concrete
   provider, branch on a provider `id`, or assume a specific CLI exists.
2. **Selection is data-driven.** Routing is a Core Application policy service,
   not a Capability or Provider concern. A bounded `RoutingContext`, immutable
   Provider Registry snapshot, and typed declarative policy produce an
   explainable `ProviderSelectionDecision`: eligibility is evaluated before a
   deterministic lexicographic ranking, and ineligible Providers never enter
   ranking. Concrete model tags, executables, Runtime benchmark lookup, and
   provider-id conditionals never appear in Application policy source. The
   existing `CapabilityRouter` priority path remains the legacy invocation path.
   Stage 2B Slice 5A adds an optional Core Application integration seam only for
   TaskRun-backed `GENERAL_CHAT` work turns. Slice 5C-I adds a default-off app-private
   admission boundary; enabled admission fails before Provider construction until a
   concrete 5C-EG verifier exists. Project Analysis, Code Generation, no-work chat,
   and every other Capability remain on their existing paths (ADR-0064).
3. The selected provider `id` is **audit-only** (on `TaskRun`). It MUST NOT be
   surfaced to the user by default.
4. **Provider-specific prompt shaping happens in the adapter.** Core emits a
   provider-agnostic `PromptSpec`; the adapter renders it to CLI args + context
   files (`CLAUDE.md`, `AGENTS.md`, …).
5. v1 is **CLI-only**; no AI HTTP API. New engines are new adapters, not Core
   changes.
6. Transports (queue, event bus, vector store, storage) follow the same rule:
   abstraction in Core, transport in a provider (in-process now, distributed in
   Team Edition).
7. Provider Registry configuration is supplied by the composition root and
   validated as an immutable Core Application snapshot. Provider adapters do
   not own selection policy. Approved bounded Capability Profiles may cite a
   Stage 2A evidence binding, but Runtime routing never reads raw benchmark
   scores or Golden Corpus evidence directly (ADR-0064).
8. **Selection and execution remain separate.** A selected decision must become
   an immutable `ProviderExecutionPlan` before `ProviderRoutingGateway` may
   invoke the selected `AiProvider`. The Plan freezes a canonical SHA-256
   executable-binding identity validated against the same immutable descriptor
   snapshot and selection configuration. The Gateway rechecks the current
   registry and binding identity before invocation. Stage 2B Slice 3A adds an
   immutable validation-profile registry, a pure synchronous Runtime response
   validator, a bounded output projection, and an explicit declarative branch
   plan. A plan may pre-fix one operational fallback and one stronger semantic
   escalation candidate from the ranked eligible set, but an execution may use
   at most one additional hop (`Primary → Fallback` or `Primary → Escalation`).
   Same-provider retry, runtime policy reevaluation, safety-failure branching,
   and pre-execution escalation are prohibited. Slice 3B makes the Gateway the
   sole owner of a validation-gated, deadline-bounded execution state machine:
   primary plus at most one mutually exclusive fallback or escalation attempt,
   followed by exactly one bounded terminal result. Slice 5A composes the approved
   selection/plan/Gateway chain behind the optional Runtime seam, snapshots each
   configured executable's availability at most once per request, maps terminal
   results onto existing Task/TaskRun lifecycles, and persists bounded
   `routingAudit` metadata without a schema migration. It never falls back to the
   legacy selector after the seam is chosen. Actual descriptor/policy/binding
   configuration, composition-root activation, and external Provider execution
   remain separate approval boundaries (ADR-0064). Slice 3C validates the Gateway
   boundary through a private test-only
   workspace package with strict static JSON fixtures, scripted Providers and
   monotonic time, and a Harness-owned canonical audit projection. Its dependency
   is one-way into Core; production packages and apps must never import it.
   Slice 4 adds a separate provider-free selection-simulation subtree in that
   private package. It replays only `RoutingPolicyEngine → ProviderSelectionDecision`
   from self-contained fixtures and must not construct an execution plan, Gateway,
   validator, Provider binding, or Runtime object.
9. Production executable identity is instance-specific: `providerId` identifies one
   configured executable Provider instance, `adapterId` identifies its adapter family,
   and opaque `modelId` identifies the exact model binding. Stage 2B Slice 5B-1 owns a
   typed static composition-root configuration for only the ratified balanced and
   semantic Ollama candidates. It binds bounded Stage 2A provenance by canonical
   SHA-256 without importing benchmark evidence at Runtime. Slice 5C-I permits its
   construction only after exact-scope 5C-EG verification; no concrete verifier exists,
   so readiness, execution, Runtime activation, and UAT remain later approval boundaries
   (ADR-0064).
10. Ollama readiness preflight is an app-private, non-persistent boundary. Slice
    5B-2A-I implements typed executable identity, exact `--version`/`list` policy,
    isolated environment, bounded parsers/process lifecycle, and immutable results
    behind injectable filesystem/process seams. It is unwired and fake-tested only;
    Slice 5B-2A-E0 adds an app-private strict execution composition and replaces the
    boolean egress attestation with either independently verified OS denial or explicitly
    approved configuration-restricted risk. The latter does not technically deny external
    egress. The runner exclusively constructs and validates the exact child environment.
    Actual executable/version/inventory, daemon/network access, and Provider generation
    require later independent gates (ADR-0064).
11. Provider generation validation remains app-private and non-persistent. Slice 5B-2B-I composes a validation-only
    one-descriptor Registry and one executable binding through the existing Policy → Decision → Planner → Gateway
    chain, producing a naturally primary-only plan for exact `ollama-cli:llama3.1:8b`; it never calls the adapter
    directly or changes Core planning semantics. Its strict adapter-local profile uses an absolute executable,
    explicit loopback host, runner-owned HOME/TMPDIR, bounded locale/color/cloud controls, no inherited PATH or
    parent HOME, and bounded pull-marker observation. `PRECHECK_OBSERVE_POSTCHECK_RISK_ACCEPTED` is explicitly not
    technical model-download prevention: success additionally requires exact preflight presence, no observed
    marker, and an unchanged postflight inventory fingerprint. Actual generation and risk acceptance remain a
    separate Strict gate (ADR-0064).
    Validation evidence is monotonic across terminal handling: observed invocation/download/timeout/overflow facts
    are never reset by a later failure. The shared runner independently validates the exact IPv4 loopback host and
    exposes opt-in structured overflow evidence; a second invocation is counted but never delegated. Only the exact
    expected token may appear in the projection—every mismatch is represented by bounded byte count and SHA-256.
12. The app-private 5B-2B-E1 entrypoint uses strict explicit invocation parsing, an executable identity gate before
    preflight or harness invocation, the existing PRE/POST preflight, exactly one existing generation-harness call,
    one bounded projection, and uniform writer-failure exit handling. It remains unwired from bootstrap, Runtime,
    Discord, DB, package scripts, and public Core APIs.
13. Stage 2C profile application uses an M1 build/configuration-time model. An app-private
    `ProfileConfigurationApplicationGate` validates a ratified profile against the exact current configuration and
    derives an immutable before-to-after application subject before any real configuration-change `ExecutionPlan`
    or Patch is created. The subject binds the approved profile digest, target configuration identity,
    expected-result configuration digest, and application-contract version by canonical SHA-256. It must not
    expand the Stage 2B protected egress scope. Existing plan-scoped Approval semantics remain unchanged: profile
    ratification and subject validity grant no execution or mutation authority. Live ProviderRegistry mutation, a
    profile-authorization aggregate, approval persistence/revocation, and authenticated benchmark provenance are
    deferred (ADR-0067).
14. **Execution locality is provider-declared data** (ADR-0107 D6). `AiProvider` has an optional readonly
    `executionLocality: 'LOCAL' | 'REMOTE'`; absent means `REMOTE` (fail closed). It is declared data like
    `capabilities`, never a provider-id branch. Ollama providers declare `LOCAL` only when the configured model name
    and tag contain no `cloud` (mirrors ADR-0098 D8); Claude and Codex declare `REMOTE`. Every future provider must
    declare it or is treated as `REMOTE`. Data whose egress is `LOCAL_ONLY` (the owner-curated learning examples of
    ADR-0107 D5) is composed into a request only after the provider for that execution is resolved and declares
    `LOCAL`; otherwise the request is composed without it, and there is no re-execution on another provider
    (ADR-0092). The Stage 2B routed seam gets no examples in v3. ADR-0110 and ADR-0111 reuse this attribute.

---

## 6. Memory Principles

1. **Quoky Memory is authoritative.** Never rely on a model's internal memory.
2. Memory reaches stateless CLIs **only** through generated context files.
3. Memory types are fixed: `SHORT_TERM`, `WORKING`, `LONG_TERM`, `PROJECT`,
   `TOOL`, `CONNECTOR`. Scope includes `sessionId` once Session lands.
4. **Separation of duties** (do not conflate):
   - `MemoryManager` = system of record (CRUD, scope). `[NOW]`
   - `ContextBuilder` = retrieve → (rank/compress/budget `[LATER]`) → `ContextBundle`. `[NOW]`
   - `PromptComposer` = layer (system + developer + context + task) → `PromptSpec`. `[NOW]`
   - Context-file **materialization** belongs to the workspace layer, not the
     memory or context layer.
5. Embedding **generation** is an `AiProvider` capability (e.g. Ollama), not a
   property of the vector store. The `VectorProvider` only stores/queries.

---

## 7. Capability Principles

1. A `Capability` is the stable contract between *intent* and *engine*. Adding a
   model never adds a capability; adding a skill might.
2. Risk is a function of capability + concrete operation (see Workspace Rules).
3. Routing order: **Intent → Capability → (AgentProfile) → Provider.** Capability
   is the routing key. The current `AgentProfile` is configuration-only (ADR-0079);
   integration above capability/provider routing remains `[LATER]`.

---

## 8. Agent Principles

1. v1 has **no agent runtime.** Execution is single-shot: PromptComposer →
   Provider → Artifact.
2. The agent seam is **configuration, not a runtime**: an `AgentProfile` contains
   `{id, displayName, role, purpose, instructions}` (ADR-0079). The immutable registry is lookup only;
   capability, Provider, Tool and authority bindings are not profile fields.
3. Autonomous loops (plan-act-observe, tool use, sub-agents) are `[LATER]` and
   MUST sit behind the `AgentProfile` seam without changing Capability/Provider
   contracts.

---

## 9. Workspace Rules

1. v1 uses `LocalCloneWorkspaceProvider` on an existing local clone.
2. **Check git status before modifying code.** A dirty tree blocks automated
   edits unless explicitly overridden by approval.
3. **Never auto-commit, auto-push, auto-delete, or force-push.** These are
   HIGH/CRITICAL and run only after an approval decision.
4. `GitWorktreeWorkspaceProvider` will implement the **same port** later; Core is
   unaffected. `[LATER]`
5. All command execution is risk-assessed (`RiskPolicy.assessCommand`) before it
   runs.
6. **Workspace ≠ Git (ADR-0022).** The Workspace owns the **filesystem** abstraction;
   a future **Git Capability** owns the **repository** abstraction — they stay
   independent. The v2 read-only Workspace slice (`resolve`/`readFile`/`listFiles`/
   `diff`) uses `node:fs` only — no git, no `child_process`. `diff` compares
   **current file → proposed content** (never repo history); it is the pre-approval
   seam for the future Write slice. `[NOW]` (read-only)

---

## 10. Risk & Approval

| Level | Examples | Default |
|---|---|---|
| LOW | chat, summary, explanation, read-only lookup | auto |
| MEDIUM | local code modification, local test/file generation | auto (local only) |
| HIGH | git commit/push/PR, connector writes (Jira/Slack/Confluence) | **approval** |
| CRITICAL | deploy, DB migration, destructive shell, force push, secret access | **approval** |

Reminder create/list/cancel is LOW (ADR-0101): an owner-instructed local write whose only effect is text addressed to
that owner (owner DM by default). The one-time credential-guard override (ADR-0097) is a CRITICAL approval.

The approval gate wraps the **external write / destructive action**, not the
planning. Approval requests and decisions are persisted as governance records.

---

## 11. Coding Rules

1. TypeScript `strict` (+ `noUncheckedIndexedAccess`, `noImplicitOverride`).
2. **Core is pure**: no NestJS decorators, no Node-framework deps; injection is
   explicit (constructor + DI tokens in the composition root).
3. **One concrete provider concern per adapter package.** Adapter packages depend
   only on `@quoky/core`.
4. Cross-boundary types are domain types only — no Discord.js/SQL/CLI types in
   port signatures.
5. Deterministic plumbing may be implemented; model-driven cognition is isolated
   and explicitly stubbed until built (`NotImplementedError`), never faked.
6. Time and ids come from the shared `clock`/`id` utilities (swappable for tests).
7. Every architectural decision is recorded in `DECISIONS.md` before the code
   that depends on it merges.

---

## 12. Forbidden Rules (hard "never")

- ❌ Importing a concrete provider, Discord, SQLite, or a CLI from `@quoky/core`.
- ❌ Branching on a provider `id` anywhere in Core.
- ❌ Letting any platform/storage/driver type cross a port boundary.
- ❌ Pinning an AI provider to a Session/Task/Actor.
- ❌ Surfacing the selected provider to the user as a normal behavior.
- ❌ Storing context/memory **snapshots** on Session (rebuild per run).
- ❌ Merging `Resource` (input) and `Artifact` (output).
- ❌ Auto-commit / auto-push / auto-delete / force-push / external write without
  an approval decision.
- ❌ Relying on a model's internal memory as a substitute for Quoky Memory.
- ❌ Adding a god-interface (`Plugin`, mega-`Session`) instead of narrow ports.
- ❌ Turning the main execution flow into implicit event choreography.

---

## 13. Future Expansion Strategy

| Axis | v1 (Personal, local) | Evolution | Mechanism |
|---|---|---|---|
| Identity | one local Actor ↔ Discord user | multi-actor teams | `Actor` seam `[RESERVE]` |
| Storage | SQLite | Postgres | `StorageProvider` swap |
| Queue / Events | in-process | Redis / Kafka | `QueueProvider` / `EventBus` port |
| Platform | Discord | + Telegram, web | `PlatformAdapter` |
| Workspace | local clone | git worktrees, sandboxes | `WorkspaceProvider` |
| Connectors | Jira/Slack/Confluence read adapters (config-gated) | additional read/write systems | `ConnectorProvider` (ADR-0072); writes use separately approved narrow ports |
| Extensibility | manual registration | plugin bundles + manifest | bundle of existing ports `[LATER]` |
| Orchestration | single task | workflows | `workflowId` reserve → engine `[LATER]` |
| Execution | single-shot | agentic loops | `AgentProfile` seam → runtime `[LATER]` |
| Scheduling / notification | in-process, composition-root tick for owner reminders; owner-only `NotificationSink` (ADR-0101) | distributed scheduler / queue, multi-recipient notifications | `ReminderRepository` + `NotificationSink` ports; swap the tick driver and sink adapter, never the Core contracts |

**Rule of evolution:** an evolution step is valid only if it changes adapters,
wiring, or `[RESERVE]`/`[LATER]` seams — **never the Core contracts above.** If a
desired feature forces a Core-contract change, that is an architectural event and
requires a `DECISIONS.md` entry amending this constitution first.
```

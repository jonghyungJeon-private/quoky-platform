# Quoky Platform

**Local-first Personal AI & Work Automation Platform**

## What is Quoky?

Quoky is a personal AI and work platform with conversation, memory, bounded execution,
and explicit approval. Its first interface is Discord. AI models and providers are
replaceable implementations; users request outcomes rather than selecting engines.

## Getting started (Quoky Personal v1)

Quoky Personal v1 is the first product release for daily **single-owner** use: a Discord bot (owner-only, in
allowlisted channels and owner DMs) with conversation, durable memory, local Ollama for everyday chat when ready
(Claude otherwise), approval-gated local code changes, and remote git disabled by default. Setup (Discord bot,
Claude CLI, optional Ollama, `.env.local`, first messages, troubleshooting) is in the
[Quickstart](docs/user/quickstart.md). The attended Live UAT procedure is
[docs/uat/first-release-uat-packet.md](docs/uat/first-release-uat-packet.md); it is not executed and requires
separate Strict Product Owner approval.

## Product Vision

Keep personal context and work locally, connect useful external systems through narrow
interfaces, and preserve a reusable Core as the Product evolves from Personal to Team
and eventually Hosted editions. Those later editions are roadmap direction, not current
multi-user or hosted functionality.

## Current Capabilities

These categories describe source implementation, not Production readiness or authorization
to activate a runtime.

| Maturity | Capabilities |
|---|---|
| Implemented | Conversation runtime; memory and bounded context construction; intent and bounded planning; Task/TaskRun lifecycle; plan-scoped Approval; bounded Workspace and Git/repository-hosting flows; policy-gated Command execution; command ExecutionReceipt; atomic TaskRun start |
| Partial | Provider abstraction/routing; Resource references and read-only connectors |
| Foundation | Tool/MCP adapter; durable WorkItem; AgentProfile registry; WorkHandoff; trigger/proactive decisions; ContinuationBinding |
| Deferred | Receiving-agent execution, runtime agents, autonomous multi-agent execution |

Claude and Ollama have concrete CLI implementations. Codex execution remains incomplete.
The legacy capability/availability/priority path remains available; advanced Stage 2B routing
has separate configuration and activation gates. Enabled routing admission requires a future
concrete verifier and must not be treated as ready merely because policy code exists.

Jira, Slack, Confluence and GitHub provide bounded read-only connector surfaces. Connector
writes and general resource resolution are not implied. Git repository-hosting operations
are a separate capability with their own approval and authentication boundaries.

## Development Status

**Quoky Personal v1** (first release: owner-only Discord entry, provider readiness with Ollama/Claude, actor-scoped
memory recall, `도움말`/`새 대화`, 30-minute approval expiry, remote-git-off-by-default; ADR-0091..0094) is
implemented locally with offline acceptance passing; the attended Live UAT (AC12 in the packet; ROADMAP criterion 9) has not been executed. See
[CURRENT_STATE.md](CURRENT_STATE.md).

M3 Personal Work OS foundations are active. M3E-5 Atomic TaskRun Start was delivered through
PR #60 at `bef459aaf3a77549dd44760a21ea839073b0cb46`, with Ratified ADR-0085 and schema v11.
It provides atomic attempt allocation, not receiving-agent dispatch or execution authority.

This source identity migration implements the Product Owner's bounded Sprint under
**Proposed ADR-0086**, pending independent review and Chief Architect acceptance. The
historical Quoky development control-plane is distinct from this Product and remains FROZEN.
See [Current State](CURRENT_STATE.md) for exact implementation and delivery status.

## Architecture

```text
External Interface → Inbound Adapter → Core Application → Domain + Ports
                                                            ↑
                                               Infrastructure Adapters
```

Compile-time dependencies point inward: **apps → adapters → core**. Core owns domain
models, policies and port contracts. Infrastructure adapters implement those contracts.
`apps/quoky` is the NestJS composition root that binds concrete implementations to ports.
Core has no concrete Discord, SQLite, NestJS or AI-provider dependencies.

## Why Ports & Adapters?

Controller–Service–Repository describes useful responsibilities, but Quoky also needs
separate boundaries for AI CLIs, Git, commands, workspace files, MCP/tools and connectors.
Discord and SQLite can be replaced independently. Keeping these details outside Core
supports Personal → Team evolution without tying business rules to one transport or store.
See the [Architecture Constitution](ARCHITECTURE.md) for invariants and
[Decisions](DECISIONS.md) for their rationale.

## Core Concepts

| Concept | Responsibility |
|---|---|
| Actor | Platform-independent identity and ownership |
| Session | Conversation lifecycle and pointers; no memory/context snapshot |
| WorkItem | Durable Actor-owned work and high-level lifecycle; distinct from an execution Task |
| WorkHandoff | Immutable profile-to-profile context/provenance; grants no execution authority |
| ContinuationBinding | Immutable handoff↔Task correlation; does not execute work |
| Task | A unit of work tied to conversation context |
| TaskRun | Exact identity of one execution attempt; not an approval |
| AgentProfile | Immutable persona configuration; not a runtime agent or permission grant |
| Approval | Governance state for a specific ExecutionPlan |
| ExecutionReceipt | Current COMMAND terminal provenance; not a generic TaskRun receipt |

## Repository Structure

The tree uses the canonical source identity. The local checkout and the GitHub repository are
now named `quoky-platform` as well, so source and external identity are aligned.

```text
quoky-platform/
├─ apps/quoky/                 # @quoky/app — composition root
├─ packages/
│  ├─ core/                   # @quoky/core — domain, application, ports
│  ├─ adapter-discord/
│  ├─ storage-sqlite/
│  ├─ ai-cli/
│  ├─ command-local/
│  ├─ git-local/
│  ├─ repository-hosting-github/
│  ├─ github-app-auth/
│  ├─ workspace-local/
│  ├─ tool-mcp/
│  ├─ connector-*/
│  ├─ connectors/             # legacy extension placeholder
│  ├─ queue-local/            # reserved implementation seam
│  ├─ vector-local/           # reserved implementation seam
│  └─ provider-routing-validation/ # private offline validation harness
├─ tools/                     # bounded development/validation tooling
└─ docs/
```

## Work & Execution Model

WorkItem is referenced by WorkHandoff. ContinuationBinding connects a handoff to an existing
Task, and TaskRun references its Task. These relations are provenance and correlation,
not an automatic sequential workflow.

Eligibility decisions are transient evaluations, not durable workflow states. Binding
admission validates canonical state but grants no execution permission. Atomic TaskRun
start requires the canonical Task to be RUNNING and allocates a distinct attempt per call;
it does not provide start-request idempotency, automatic retry or dispatch. Receiving-agent
execution remains deferred. Command receipts independently identify terminal command results.

## Safety & Approval

Planning and execution authority remain separate. Plan-scoped approval guards operations
that require it; each capability enforces its bounded checks. Provider selection, a handoff,
a profile or a TaskRun does not grant additional authority. Secrets stay at infrastructure
boundaries and must not enter Core objects, responses or logs.

Development authorization and runtime/external-operation gates are defined in
[Development Mode](docs/governance/DEVELOPMENT-MODE.md). That document's M2 standing-delegation
wording and Current State's active M3 require a separate governance correction; this rename
does not broaden standing authority.

## Current Limitations

- No autonomous agent loops, scheduler, workflow engine or dynamic plugin loader.
- Tool/MCP and handoff foundations do not imply live autonomous execution.
- Codex execution, local queue enqueue and local vector operations remain incomplete.
- Some legacy facade/workspace/Discord approval methods remain explicit stubs; current
  bounded flows use the implemented application paths.
- Advanced routing activation, runtime/UAT and external actions require their own gates.
- No AI HTTP API, current Team tenancy, Postgres or Redis implementation.

## What's Next

**Next architecture target: Execution Admission.** Expected responsibility is Core Application
composition using existing canonical objects; no new aggregate/repository is currently justified.
Detailed architecture belongs to the next Sprint and is not approved by ADR-0086 or this README.

Further roadmap directions include receiving-agent/runtime work, Codex, additional connectors,
memory improvements and later networked infrastructure for Team/Hosted editions. See
[Roadmap](ROADMAP.md); these are not current capability claims.

## Development

The workspace declares Node **≥18.18** and **pnpm 10.32.1**. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Use `pnpm install --offline --frozen-lockfile --ignore-scripts` only with a populated local
store and required native dependencies already available. Tests can be selected with
`pnpm exec vitest run <test-path>`; some suites use disposable files, Git or SQLite, so
select tests appropriate to the authorized scope.

For a separately authorized local runtime, prepare `.env.local` using `.env.example` without
overwriting an existing configuration. The loader reads repository-root `.env.local` with
`override: false`; inherited process values win. `.env` is not loaded. Before startup,
compare variable **names** and remove inherited runtime-owned duplicates in that invocation
with `env -u NAME`, including DISCORD_BOT_TOKEN and DISCORD_GUILD_ID. Never display secret values.
`pnpm start` runs `apps/quoky/dist/main.js` and is a runtime action, not a build check.
After startup, verify bot/guild/channel identity before readiness or Discord actions, as required
by [AGENTS.md](AGENTS.md).

For the migrated settings in `.env.example`, QUOKY_* takes precedence over CHUNSIK_* aliases,
including empty canonical values. Omit the canonical variable to use its legacy alias.
GitHub App versus dev-only PAT authentication rules are unchanged. No configuration step should
silently redirect existing local state: the default remains `./data/chunsik.db`, generated
contexts remain `.chunsik/context.md` and `.chunsik/task.md`, and `.chunsik-tmp` remains unchanged.

## Canonical Documentation

| Document | Authority |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture constitution and invariants |
| [DECISIONS.md](DECISIONS.md) | ADRs and decision rationale |
| [CURRENT_STATE.md](CURRENT_STATE.md) | Exact current implementation status |
| [ROADMAP.md](ROADMAP.md) | Future sequence and edition direction |
| [AGENTS.md](AGENTS.md) | Implementation-agent rules |
| [Development Mode](docs/governance/DEVELOPMENT-MODE.md) | Development authorization and execution gates |

README is the Product introduction and navigation layer; it does not supersede these authorities.
Historical records retain the names used when they were written.

# ARCHITECTURE.md amendment draft: bounded agent with information-flow control (ADR-0121)

- **Status:** **Proposed — draft text only.** `ARCHITECTURE.md` is **not** edited by this change. When the Product
  Owner ratifies ADR-0121, a separate docs change applies the text below verbatim and records the ratification. Until
  then, ARCHITECTURE.md §8.1 ("v1 has no agent runtime") remains in force and no agent runtime code may merge.
- **Date:** 2026-10-13
- **Source:** ADR-0121 (`DECISIONS.md`); design and threat model in `docs/plans/agent-security-design-2026-10-13.md`.

## 1. §8 Agent Principles: replacement text

> ## 8. Agent Principles
>
> 1. Execution is single-shot (PromptComposer → Provider → Artifact) **except** for one bounded agent runtime defined by
>    ADR-0121. It plans first and then executes. It is not a plan-act-observe loop:
>    - A privileged planner call turns the owner's own words into a closed, typed plan over the capability catalog of
>      ADR-0120.
>    - Deterministic Core code validates and executes the plan.
>    - The plan may be revised at most once, and only from structural observations: counts, closed-format ids, types
>      and error codes.
> 2. The agent seam stays **configuration**: an `AgentProfile` contains `{id, displayName, role, purpose,
>    instructions}` (ADR-0079). The bounded runtime is selected through an `AgentProfile` id. Tools, providers and
>    authority are **not** profile fields:
>    - the tools are the closed catalog entries;
>    - the providers come from capability routing;
>    - the authority comes from the risk table (§10) and the approval gates.
> 3. **Information-flow control is mandatory for any agent.** Every value carries a label. The label has four parts:
>    - trust: `TRUSTED`, `STRUCTURE` or `UNTRUSTED`;
>    - egress: `REMOTE_OK`, `REMOTE_ON_SUMMARY_REQUEST`, `LOCAL_MODEL_ONLY` or `HOST_ONLY`;
>    - scope: `WORK_CHANNEL_OK` or `OWNER_DM_ONLY`;
>    - its sources.
>
>    Labels join to the most restrictive value. Labels are domain data, never a provider id. The rules are:
>    - The planner receives only `TRUSTED` and `STRUCTURE` values.
>    - Raw external content is read only by a **quarantined** model call. That call has no tools, uses a schema-bound
>      output, and its output goes only to the owner's reply.
>    - Content can never choose a step, and never becomes a free-text argument.
>    - A closed-format id projected deterministically from a read result may feed only a later read of the same source
>      and destination origin. It never feeds another connector, another origin or a write.
>    - Every argument carries a provenance label.
>    - A model call's provider must satisfy the strictest egress label of its inputs (§5.14).
> 4. An agent has **no** shell, code execution, arbitrary URL fetch, MCP or plugin tool, memory write or connector
>    write. A write is only ever a proposal that creates an existing exact-payload, one-time approval (§10). Steps,
>    model calls, connector calls, wall time and cost are capped. A kill switch stops runs without a restart.
> 5. Further autonomy beyond the following needs its own ADR amending this section:
>    - sub-agents;
>    - more than one re-plan;
>    - content-conditioned control flow;
>    - new tool classes.

## 2. §10 Risk & Approval: additions

Add rows to the table:

> | LOW | bounded agent **read** run over READ catalog entries (ADR-0121) | auto, within caps |
> | HIGH | agent **write proposal**; any flow of data read from one source to a different destination | **approval** (exact payload + provenance banner) |

Add after the paragraph on reminders:

> An agent proposal never executes a write. The approval card shows the exact payload, the destination (taken only from
> the owner's own words) and the label sources of the data in it. Approval is one-time, hash-bound and at-most-once,
> with no automatic retry (ADR-0112).

## 3. §12 Forbidden Rules: additions

> - ❌ Letting external content (connector results, quoted or pasted text, attachments, or any model output derived from
>   them) reach a planning model, choose a step, or become a free-text argument of a tool call.
> - ❌ Giving any agent or model a shell, code execution, arbitrary URL fetch, MCP/plugin tools, memory writes or
>   connector writes.
> - ❌ Egress to a destination that is not on the egress allowlist, or to an internal, metadata or CGNAT address after
>   resolution. In-process enforcement covers the runtime's own HTTP paths. Child processes are covered by the
>   OS-level control chosen under ADR-0121.
> - ❌ Any inbound listener other than loopback, and any remote-access tunnel or P2P overlay in the runtime.

## 4. §13 Future Expansion Strategy: row change

> | Execution | single-shot + one bounded plan-then-execute read agent (ADR-0121) | write proposals, then further autonomy only by ADR | `AgentProfile` seam → bounded runtime `[NOW]` behind flags; broader runtime `[LATER]` |

Add one row:

> | Network posture | outbound-only to an allowlist, loopback listener only, traffic/volume ledger (ADR-0121) | same in Team Edition, enforced at the network layer | egress guard in the composition root; Core unaware |

## 5. Companion changes (same ratification, not ARCHITECTURE.md)

- **AGENTS.md** Engineering Rules: "God-interface와 deferred Workflow/agent runtime/dynamic plugin loader를 조기 구현하지
  않는다" becomes "… deferred Workflow/dynamic plugin loader를 조기 구현하지 않는다. Agent runtime은 ADR-0121의 bounded
  plan-then-execute 범위만 허용한다."
- **ROADMAP.md** Non-goals: "No autonomous agent loops" becomes "No autonomous agent loops beyond the bounded
  plan-then-execute agent of ADR-0121".

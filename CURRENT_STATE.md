# Quoky Platform — Current State

A snapshot of where the repository is **right now**. Updated as part of every
sprint's definition-of-done. It deliberately avoids duplicating `ARCHITECTURE.md`
(rules) or `ROADMAP.md` (direction); for the status of individual concepts see the
`[NOW]/[RESERVE]/[LATER]` labels in `ARCHITECTURE.md`.

### R3-C2C — Local Continuity Consumption / Exact Effect Binding (architecture / task definition) (2026-09-28)

**ARCHITECTURE / TASK-DEFINITION ONLY — NOT STARTED / IMPLEMENTATION NOT AUTHORIZED.** Branch
`kiro/r3c2c-local-continuity-consumption-architecture` from canonical main
`4e040913405585596b0a1f0c399a20a8b592a85a`. `DECISIONS.md` carries the ADR-0090 amendment "R3-C2C
architecture / task definition (Local Continuity Consumption / Exact Effect Binding)" defining the canonical
consumption boundary that turns an issued `BoundLocalContinuitySelection` into EXACTLY ONE authorized
local-continuity Provider effect, with the security order **validate C2A → commit `DISPATCH_COMMITTED` →
exact bound Provider effect** (closes I2-1 NB-1). Source-verified: today
`ContinuationReceiverExecutionService` commits dispatch BEFORE `receiver.receive`, so the later C2A validate
sees `DISPATCH_COMMITTED` → `INVALID_RUN` (fail-closed but wrong order for C2C). **Selected Option B:** a NEW
narrow `LocalContinuityConsumptionCoordinator` owns validate→(Kind B expiry re-check)→commit→effect,
consuming the canonical `LocalContinuityAdmissionCoordinator` admitted outcome + bound authority; rejected A
(overload `ContinuationProviderRoutingService`, risks inheriting Stage2B fallback) and C (receiver
restructuring entangles non-C2 families). Ownership stays distinct: C2A = issuer/validator;
`ProviderDispatchCommitCoordinator` = sole durable dispatch CAS owner; `TaskRunRepository` = durable state;
`ProviderRoutingGateway` = generic execution (NOT used for the local-continuity single-attempt effect unless a
one-binding/zero-fallback plan is proven). TOCTOU closed by the guarded CAS on `PRE_DISPATCH` as the
linearization point adjacent to C2A validate (no standalone token). Kind B `continuityEvidenceExpiresAtMonoMs`
re-checked on the shared `MonotonicClock` immediately before commit (expired → no commit/effect; no rollback
after commit). Exact provider binding from the issued `SoleProviderSelection`; containment via
`PreparedContainmentExecution`/`VerifiedContainmentBinding` bound to the same provider/execution/capability/
config — and because **R3-B3 stays FAIL CLOSED (anchor/verifier/capability issuer NOT IMPLEMENTED), no real
production local-Provider effect can execute.** Exactly one provider / one attempt / no fallback / no
cloud-before-or-after; commit failure → definite pre-dispatch failure, no effect; crash-after-commit or
provider failure → `DISPATCH_COMMITTED`, no normal retry (R3-C-Rz only); concurrent consumers → one CAS winner
→ ≤1 effect. Early continuation commit MUST move to the C2C effect boundary while preserving write-before-
effect on every INCLUDED path. NB-4 generic `save()` insert: not a hard C2C prerequisite (C2C derives the run
from canonical storage) but carried forward as recommended repository hardening before production Kind B
reachability. Non-C2 conversation/code-generation/tools paths unchanged. Recommended future slice R3-C2C-1.
Docs-only: no source/test/schema/runtime/provider/network/secret/DB changes. ADR-0090 remains Proposed;
production Kind B remains DENY (C2B-2 NOT AUTHORIZED); C2C implementation, C2B-2, and R3-C-Rz remain NOT
AUTHORIZED; R3-B3 production trust stays FAIL CLOSED.

### R3-C2B-I2-1 — Canonical Prior-Dispatch Attempt Boundary (2026-09-28)

**IMPLEMENTED LOCALLY; INDEPENDENT EXACT-HEAD REVIEW PENDING.** New `TaskRun` rows from both
`taskRuns.start` and `guardedStart` persist `ProviderDispatchState.PRE_DISPATCH`. The SQLite JSON decoder
maps missing historical state to `LEGACY_UNKNOWN`, or `DISPATCH_COMMITTED` when a historical provider ID
proves association; it never infers `PRE_DISPATCH` from absence. The guarded repository operation uses an
IMMEDIATE transaction and exact TaskRun/execution identity to commit `PRE_DISPATCH → DISPATCH_COMMITTED`
once. `ProviderDispatchCommitCoordinator` is the sole application write point. Conversation work turns
commit before either routed or direct Provider execution; continuation commits before receiver invocation.
The routed and direct work-turn branches remain exclusive, and Stage2B's bounded fallback inside one gateway
execution needs no second marker. A failed or duplicate commit prevents a new Provider effect. Crash or
Provider failure after commit leaves the marker committed; normal retry/re-entry remains denied.

Kind A, Kind B, C2A issue, and C2A validation require current `PRE_DISPATCH`; C2A authority minted before
the commit cannot be replayed afterward. The TaskRun-free conversation fast path, CodeGeneration aggregate,
and non-TaskRun tools/harness paths remain outside this boundary. Production Kind B is still **DENY** pending
C2B-2. C2B-2, C2C, and R3-C-Rz remain **NOT AUTHORIZED**. R3-B3 production trust remains **FAIL CLOSED**.
The earlier R3-C2B-I2 architecture and remediation paragraphs below are historical snapshots.

### R3-C2B-I2 — Canonical Prior-Dispatch Attempt Boundary (architecture / task definition) (2026-09-28)

**ARCHITECTURE / TASK-DEFINITION ONLY — NOT STARTED / IMPLEMENTATION NOT AUTHORIZED.** Branch
`kiro/r3c2b-i2-prior-dispatch-boundary-architecture` from canonical main
`790a1e769a0fa637e44cce11921e6c2762bc0e7c`. `DECISIONS.md` carries the ADR-0090 amendment "R3-C2B-I2
architecture / task definition (Canonical Prior-Dispatch Attempt Boundary)" closing the I1 NB-1 (and
unifying NB-5) carry-forward: ONE canonical, durable, fail-closed answer to "has any Provider dispatch
already been committed for this TaskRun?" Source-verified: the real dispatch path
(`ContinuationReceiverExecutionService` → `receiver.receive(...)`) writes `TaskRun.providerId`/status only
AFTER the Provider effect (via `terminalizePreservingSecurityEvidence`), so **providerId is post-effect and
insufficient**; `ProviderExecutionAudit` is in-memory and `ContinuationRoutingAudit` is best-effort
post-dispatch metadata; `ExecutionReceipt` is COMMAND-only/terminal. **Selected Option C:** an explicit
durable `TaskRun` dispatch-commitment field (owned by `TaskRunRepository`), transitioned exactly once
(`absent → DISPATCH_COMMITTED`) in a guarded transaction **before** the Provider effect, monotonic,
restart-durable, storage-derived (never caller-asserted). Rejected A (post-effect providerId), B (in-memory/
best-effort audit), D (new aggregate duplicates TaskRun ownership), E (containment post-evidence is
post-dispatch / local-only). **Common Kind A + Kind B pre-dispatch invariant:** normal R3-C2 local continuity
is available ONLY while the marker is ABSENT; PRESENT → Kind A (`STATIC_INELIGIBILITY`) DENY and Kind B
(`TRUSTED_CURRENT_UNAVAILABILITY`) DENY (valid C2B evidence does not override). Write-before-effect: validate
→ persist marker → only then Provider effect; marker write failure → no dispatch. C2A issue/validate (and
future C2C consumption) re-check the marker ABSENT, making `BoundLocalContinuitySelection` effectively
one-shot and preventing the mint→dispatch→reuse replay (no separate consumed flag). Crash after marker write →
still dispatch-committed (recovery = R3-C-Rz). Marker MUST survive restart (not WeakMap/in-process). Requires
a future `TaskRun` schema/migration (Option C) — documented as architecture-reviewed implementation scope,
NOT implemented now. Decomposition: **I2A** (durable marker + guarded write) then **I2B** (admission/C2A
read-side enforcement); both mandatory before Kind B reachability. C2B-2/C2C must not make Kind B
production-reachable until the marker invariant is implemented, reviewed, and delivered. Docs-only: no source/
schema/test/runtime/provider/network/secret/DB changes. ADR-0090 remains Proposed; Kind B remains DENY;
R3-C2B-I2, C2B-2, C2C, and R3-C-Rz remain NOT AUTHORIZED; R3-B3 production trust stays FAIL CLOSED.

**REMEDIATION (2026-09-28, Claude CHANGES_REQUIRED B-1..B-3).** One additional docs-only remediation commit
(parent `5a904ddd…`; reviewed commit not amended) appends "ADR-0090 amendment (remediation) — R3-C2B-I2
corrected …" to `DECISIONS.md`, retaining Option C. **B-1:** the single canonical write owner is a narrow
application-layer `ProviderDispatchCommitCoordinator` (persistence source of truth stays `TaskRunRepository`/
`task_runs`; `ProviderRoutingGateway` is NOT the owner and keeps no storage dependency); commit occurs
immediately before the FIRST `binding.provider.execute(...)` of the TaskRun-bound execution, with the DB
transaction ending before the Provider call; ONE commit per TaskRun (bounded in-plan Stage2B fallback within
the same gateway execution takes no second write; any re-entry/new invocation/restart sees committed → DENY →
R3-C-Rz). A source-inspected dispatch-path inventory classifies each direct effect path (continuation-receiver
= required; gateway = required only on the TaskRun-bound path via the coordinator; conversation-runtime and
code-generation-manager = classify at implementation; tools/harness non-TaskRun = excluded). **B-2:** one
state model `ProviderDispatchState` = `PRE_DISPATCH | DISPATCH_COMMITTED | LEGACY_UNKNOWN`; new `guardedStart`
runs persist explicit `PRE_DISPATCH`; MISSING legacy field → `LEGACY_UNKNOWN` (never `PRE_DISPATCH`) → Kind A/
Kind B/C2A all DENY; historical providerId/terminal-executed rows normalize/backfill to `DISPATCH_COMMITTED`,
ambiguous STARTED → `LEGACY_UNKNOWN`; corrected migration note — `task_runs` stores JSON so no new SQL column
is necessarily required (domain-shape + decoder + backfill + version step per repo convention). **B-3:** a
guarded `commitProviderDispatchIfPreDispatch(...)` SQLite IMMEDIATE CAS (same `.immediate()` style as
`guardedStart`) transitions `PRE_DISPATCH → DISPATCH_COMMITTED` with exactly-one-winner concurrency (loser
does not execute); duplicate commit → `ALREADY_DISPATCH_COMMITTED` fail-closed; `LEGACY_UNKNOWN` never
normal-commits. Common Kind A + Kind B precondition (`PRE_DISPATCH` required); coordinator + C2A issue + C2A
validate all re-read `dispatchState` (replay prevention; marker presence = authority consumption, no second
flag). Preferred single combined slice R3-C2B-I2-1 (else I2A+I2B with reachability CLOSED between). Still
docs-only; Kind B remains DENY; R3-C2B-I2, C2B-2, C2C, R3-C-Rz remain NOT AUTHORIZED.

**REMEDIATION 2 (2026-09-28, final B-1 closure; B-2/B-3 remain CLOSED).** A further docs-only commit (parent
`2c2c2fe…`; prior commits not amended) appends "ADR-0090 amendment (remediation 2 — R3-C2B-I2 final B-1
closure)" to `DECISIONS.md`, finalizing every current Provider-effect path (no "classify later"): **INCLUDED**
= `ContinuationReceiverExecutionService`, `RuntimeProviderRoutingService`→`ProviderRoutingGateway`
(`executionId = run.id`), and conversation-runtime work-turn Provider execution (both the routed path and the
TaskRun-bound direct fallback at ≈L5207); **EXCLUDED (structural)** = code-generation-manager (`CodeGeneration`
aggregate, no TaskRun), tools/validation-harness/diagnostics (non-TaskRun executionId), and the
conversation-runtime "(E) Fast path" direct `provider.execute` (≈L2035, `!intent.requiresWork`, no Task/no
TaskRun). Source-verified control flow: within one work turn (after `startRun`), the routed and direct paths
are MUTUALLY EXCLUSIVE (routed returns on ACCEPTED/FAILED; direct fallback runs only when routing is
absent/non-GENERAL_CHAT), so exactly one Provider-effect path is reached and commits the marker once.
`ProviderDispatchCommitCoordinator` remains the single write owner; `ProviderRoutingGateway` is generic and
NOT the persistence owner. TaskRun initialization rule finalized: both `guardedStart` AND `taskRuns.start`
persist explicit `PRE_DISPATCH`. The reachability gate now enumerates all INCLUDED paths (continuation +
conversation-runtime routed + conversation-runtime work-turn direct). B-2 (`ProviderDispatchState` model) and
B-3 (SQLite IMMEDIATE exactly-one-winner CAS) remain CLOSED and unchanged. Still docs-only; Kind B remains
DENY; R3-C2B-I2, C2B-2, C2C, R3-C-Rz remain NOT AUTHORIZED.

### R3-C2B-I1 — Kind B Admission Integration (2026-09-28)

**IMPLEMENTED LOCALLY; INDEPENDENT EXACT-HEAD REVIEW PENDING.** Architecture was ratified and delivered
through PR #92. `LocalContinuityAdmissionCoordinator` is the canonical application admission entry;
`LocalContinuityAdmission` owns the pure Kind B policy candidate and existing Kind A policy. The C2B issuer
batch derives and issues the exact canonical NETWORK provider set and validates on the same instance.
`VALIDATED` carries taskRunId, RoutingContextDigest, Stage2B composite configurationDigest, and the minimum
expiry. C2A consumes the coordinator outcome without another await before minting. Kind A bound authority
explicitly carries `STATIC_INELIGIBILITY` with no dynamic expiry; Kind B carries
`TRUSTED_CURRENT_UNAVAILABILITY` and the C2B minimum monotonic expiry, checked at mint and validation.
Composition rejects different C2A/C2B monotonic clock instances.
Missing or failed C2B evidence denies Kind B with bounded policy/C2B/infrastructure classifications; Kind A
remains independent. A STARTED run already carrying a provider audit ID is conservatively rejected from
Kind B. Production has no C2B producer, so production Kind B remains **DENY**. C2B-2, C2C,
and R3-C-Rz remain **NOT AUTHORIZED**; R3-B3 production trust remains **FAIL CLOSED**. The architecture
snapshot below is retained as historical context.

**Historical architecture/task-definition snapshot (superseded by the implementation status above).** Branch
`kiro/r3c2b-kindb-admission-integration-architecture` from canonical main
`0c7b4a8762b0a9ad892d3e5407e33e5300e01a1e`. `DECISIONS.md` carries the ADR-0090 amendment "R3-C2B-I
architecture / task definition (Kind B Admission Integration)" defining the canonical path by which C2B-1
trusted current-unavailability evidence may eventually affect local-continuity admission WITHOUT caller
forgeability. **Selected Option B (application coordinator):** `LocalContinuityAdmission` remains the SINGLE
semantic policy owner (Kind A vs Kind B vs DENY); a new narrow application-layer
`LocalContinuityAdmissionCoordinator` (orchestration only — no new aggregate/schema/repository/registry/
ranking/retry/lifecycle/approval owner) is the ONE application admission entry that invokes
`LocalContinuityAdmission.admit(...)` and, only when Kind-B-eligible, the SAME
`TrustedCurrentUnavailabilityObservationIssuer` instance's `validate(...)`. Rejected: A (drags storage/issuer
into the pure lower-layer policy), C (duplicate WeakMap authority with no added safety), D (makes C2A a second
policy owner + forgeability). Non-forgeability: the coordinator itself invokes validation; a plain
`{status:'VALIDATED'}`/boolean/evidenceKind/observation array/provider IDs/snapshot is inert as authority.
Kind A A1/A2 still admit WITHOUT C2B. C2A still consumes only the canonical combined outcome and retains ALL
its bindings (attempt==1, no prior TaskRun, exact taskRunId/executionId, RoutingContextDigest, Stage2B
composite configurationDigest, canonical workload, exact SoleProviderSelection, PRIMARY_ONLY, zero hops) —
Kind B changes only WHY admission is allowed. Validation→admission→issuance is synchronous and expiry-safe (5s
window revalidated at decision; expired/config-change/provider-set/WRONG_ISSUER → DENY); decision is
non-durable and consumed immediately; restart invalidates all authority. Raw observation authorities never
leave the coordinator. Production stays Kind B DENY/unreachable before C2B-2 (no `TEST_FAKE` in production
composition; `CANONICAL_PROVIDER_REACHABILITY_PROBE` unimplemented). Implementation slice **R3-C2B-I1** is
network-free (TEST_FAKE in tests only). Docs-only: no source/test/schema/runtime/provider/network/secret/DB
changes. ADR-0090 remains Proposed; **Kind B remains DENY**; integration, C2B-2, C2C, and R3-C-Rz remain NOT
AUTHORIZED; R3-B3 production trust stays FAIL CLOSED.

**REMEDIATION (2026-09-28, Claude CHANGES_REQUIRED B-1..B-3).** One additional docs-only remediation commit
(parent `22f4e6f0…`; reviewed commit not amended) appends "ADR-0090 amendment (remediation) — R3-C2B-I
corrected …" to `DECISIONS.md`. Ownership clarified: `LocalContinuityAdmissionCoordinator` is the canonical
application admission authority owner (one entry: "may this execution receive local-continuity admission
now?"); `LocalContinuityAdmission` owns deterministic policy semantics. **B-1:** define a PURE Kind B policy
path on `LocalContinuityAdmission` (e.g. `evaluateTrustedCurrentUnavailabilityPolicy(input)`) that accepts NO
trust signal (no VALIDATED result / boolean / evidenceKind / authorities / caller provider set / token),
re-runs deterministic prerequisites, reuses the exact local-selection semantics (PRIMARY_ONLY +
`assertExactSoleProviderSelection`), and returns a pure policy candidate or DENY — never authority. **B-2:**
the coordinator accepts no provider list/authorities/validation result; it invokes the SAME canonical
`TrustedCurrentUnavailabilityObservationIssuer` instance via a new batch API
`issueCanonicalEligibleNetworkSet(taskRunId)` (issuer derives `eligibleNetworkProviderIds` from its own
facts/registry/engine, issues per provider, then `validate(...)`); `TrustedCurrentUnavailabilityValidationResult`
VALIDATED now exposes `expiresAtMonoMs = MIN(validated set)`. **B-3:** documents the actual async/await
sequence with a final currentness check as the last security step, an invariant of NO `await` between the
coordinator's admitted outcome and C2A minting, and a NEW Kind-B-only C2A expiry binding —
`BoundLocalContinuitySelection` gains `continuityEvidenceKind = TRUSTED_CURRENT_UNAVAILABILITY` +
`continuityEvidenceExpiresAtMonoMs` (= validated min expiry), enforced by C2A `validate` (`now < expiry` else
invalid); Kind A A1/A2 authority is unchanged (no expiry); a shared canonical `MonotonicClock` domain is used.
Option C stays REJECTED because Option B structurally removes any need for a trust token. Provenance reuses
existing `LOCAL_CONTINUITY_EVIDENCE_KINDS`; no duplicate `STATIC_ADMIN_UNAVAILABILITY`. Doc cleanup: R3-C2B-1
corrected to CLOSED + DELIVERED (PR #91 merged, main `0c7b4a8762b0a9ad892d3e5407e33e5300e01a1e`). Still
docs-only; Kind B remains DENY; integration (R3-C2B-I1), C2B-2, C2C, and R3-C-Rz remain NOT AUTHORIZED.

### R3-C2B-1 — Trusted Current-Unavailability Observation Authority (2026-09-28)

**CLOSED + DELIVERED — PR #91 merged** (main merge `0c7b4a8762b0a9ad892d3e5407e33e5300e01a1e`). R3-C2B
architecture was ratified and delivered via PR #90. C2B-1 adds a process-local,
issuer-instance-local immutable observation authority, an injected producer port, and a test-local
deterministic `TEST_FAKE` producer seam. The issuer brackets producer observation with monotonic-ms clock
reads, rejects timestamps outside that interval, limits the validity window to 5,000 ms and
observation-to-issuance delay to 1,000 ms, and rejects a backward clock against its last observed value.
Aggregate validation re-reads canonical Task/STARTED first TaskRun, context digest, and Stage2B composite
configuration digest, then requires exactly one authority per
`staticEligibility(...).eligibleNetworkProviderIds`. The positive result is the `VALIDATED` variant of
`TrustedCurrentUnavailabilityValidationResult`; the architecture phrase `VALIDATED_KIND_B_EVIDENCE`
refers to that variant. There is no production `TEST_FAKE` wiring. Actual Kind B local-continuity
admission remains **DENY**. C2B-2, C2C, and R3-C-Rz remain **NOT AUTHORIZED**; R3-B3 production trust
remains **FAIL CLOSED**. The following architecture record is retained as historical context.

**B-1 implementation remediation (local, re-review pending):** `validate(...)` no longer accepts
caller-supplied registry or policy engine. Its controlling provider set and current Stage2B composite
configuration digest come only from the issuer-owned registry and engine. A caller cannot shrink the
canonical `{a,b}` set to `{a}` by passing a fake engine or registry. Issuer-owned configuration changes
invalidate previously issued authority. The producer's self-declared source remains an NB-1 carry-forward
for C2B-2; backward-clock failure remains intentionally fail closed.

**Historical architecture/task-definition snapshot (superseded by the implementation status above).** Branch
`codex/r3c2b-trusted-unavailability-observation-architecture` from canonical main
`be9ba95853a1cfc47d33009a70d06b002ba80828` (after R3-C2A delivery PR #89 merged). `DECISIONS.md` carries the
ADR-0090 amendment "R3-C2B architecture / task definition" defining a **Trusted Current-Unavailability
Observation Authority**: how the system may prove, at one exact execution/routing/configuration context, that
the canonical cloud path is CURRENTLY unavailable via an observation source the caller/model cannot
self-declare. Key decisions (source-verified): the only existing observation data is adapter-owned
`AiProvider.isAvailable()` / the `ProviderRegistrySnapshot` availability field — **audit/selection data, NOT
Kind B authority**; C2B adds a NEW canonical process-local issuer minting an immutable, issuer-instance-local
`TrustedCurrentUnavailabilityObservation` (WeakMap pattern, distinct from C2A's selection authority) binding
`providerId`, `executionId===taskRunId`, `routingContextDigest`, composite `configurationDigest`,
`capability`, bounded `observationSource`, a monotonic-clock validity window (`validFrom`/`expiresAt`;
`MonotonicClock` authoritative, wall-clock audit-only), and a bounded pre-dispatch `TrustedUnavailabilityReason`
(no new `RoutingFailureCode`, not reusing the post-dispatch `PROVIDER_UNAVAILABLE`/`PROVIDER_AUTH_REQUIRED`).
The canonical cloud set is derived from `RoutingPolicyEngine.staticEligibility(...)`
(policy-compatible/enabled NETWORK set) — never caller-selected IDs; multi-cloud requires trusted
current-unavailability for **every** relevant candidate (one available cloud → DENY). Stage2B stays the sole
router (C2B provides trusted facts, not ranking); Kind B requires C2A's first-run/no-prior-history binding and
remains pre-dispatch (no prior provider attempt); Kind A precedence preserved. C2A carry-forwards: **NB-1
closed** (shared canonical issuer instance), **NB-2 closed** (authority valid only on minting instance),
**NB-3 partial** (canonical static provider-set binding defined here; actual canonical planner/effect-plan
binding still belongs to C2C — NOT closed), **NB-4 closed for C2B validation semantics** (explicit
VALIDATED/INVALID(reason) result; C2C still decides effect-boundary consumption).
Process restart invalidates authority; no persisted/rehydrated Kind B; R3-B3 production trust stays FAIL
CLOSED and separate. Decomposition: **C2B-1** (authority + issuer + validator + currentness/window +
canonical provider-set binding + reason enum + validation outcome + fake/test producer contract; zero network
by default) then **C2B-2** (actual network/secret observation producer; separate STRICT approval). Docs-only:
no runtime, provider, network, secret, DB/schema, aggregate/repository, approval/security owner, or new
`RoutingFailureCode`. ADR-0090 remains Proposed; **Kind B remains DENY**; C2B implementation, C2B-2, C2C, and
R3-C-Rz remain NOT AUTHORIZED.

**REMEDIATION (2026-09-28, Claude CHANGES_REQUIRED B-1..B-4).** One additional docs-only remediation commit
(parent `941194d39f…`; reviewed commit not amended) appends "ADR-0090 amendment (remediation) — R3-C2B
corrected …" to `DECISIONS.md`. **B-1:** the only controlling Kind B set is
`staticEligibility(...).eligibleNetworkProviderIds` (enabled + policy-compatible + NETWORK); disabled/
incompatible providers never enter it; exact provider-ID set equality (no missing/extra/duplicate) at
validation; Kind A/B case matrix A–E documented. **B-2:** monotonic-ms currentness (`observedAtMonoMs`/
`validFromMonoMs`/`expiresAtMonoMs`, rule `validFrom <= now < expiresAt`), fixed
`MAX_TRUSTED_UNAVAILABILITY_WINDOW_MS=5000` and `MAX_OBSERVATION_TO_ISSUANCE_DELAY_MS=1000`, fail-closed on
non-finite/negative/backward clock; wall-clock audit-only. **B-3:** issuer-owned injected
`CurrentUnavailabilityObservationProducer`; callers pass no observation/flag/timestamp; C2B-1 uses only a
deterministic `TEST_FAKE` producer (no real `isAvailable()`, no process spawn/network/secret);
`CANONICAL_PROVIDER_REACHABILITY_PROBE` reserved for C2B-2; bounded `TrustedUnavailabilityReason`
(ENDPOINT_UNREACHABLE / AUTHENTICATION_UNAVAILABLE / PROVIDER_HEALTH_UNAVAILABLE). **B-4:** C2B-1 is
VALIDATOR-ONLY — it does NOT modify `LocalContinuityAdmission.admit(...)` or the C2A issuer, so Kind B
local-continuity admission STILL = DENY; a fully VALIDATED C2B authority set is only sufficient evidence for a
future separately reviewed Kind B integration slice. Adds `TrustedCurrentUnavailabilityValidationResult`
(VALIDATED/INVALID(reason)), five-step precedence ending at VALIDATED_KIND_B_EVIDENCE, and the
`isAvailable()`-is-not-production-evidence note. Binding uses the Stage2B composite `configurationDigest` (not
`ContinuationProviderRoutingConfiguration.configurationDigest`) plus `taskId`. Still docs-only; Kind B DENY;
C2B/C2B-2/C2C/R3-C-Rz NOT AUTHORIZED.

### R3-C2A — Bound Local Continuity Authority (2026-09-28)

**CLOSED + DELIVERED — PR #89 merged** (main merge `be9ba95853a1cfc47d33009a70d06b002ba80828`). Authorized by
the R3-C2A implementation sprint on canonical main `9addb5875fd5c9e05e6a726ef52e8885896e76f3` (architecture
delivery PR #88). This entry supersedes historical C2A "not authorized/proposed" delivery wording below; the
ratified contract is ADR-0090 remediation 2 (§R23–R43), not a new architecture decision.

- `BoundLocalContinuitySelectionIssuer.issue(taskRunId, localProviderId)` loads canonical STARTED
  TaskRun/RUNNING Task facts, derives the existing GENERAL_CHAT/CHAT continuation context, invokes R3-C1
  admission itself, and binds its actual decision and exact `SoleProviderSelection`. A module-private
  WeakMap scopes frozen authority to the issuing instance/process. Copies, admission literals, bare
  selections, and another issuer's authority are rejected; there is no persistence/rehydration authority.
- Both `attempt === 1` and `listByTask` containing only the exact current STARTED run are required at
  issuance and consumption. The existing guarded start remains the lifecycle/concurrency owner.
  Execution identity, provider, canonical capability, routing-context digest, and current Stage2B
  composite configuration must agree. Fallback/escalation and extra attempts/hops are rejected.
- `routingContextDigest` uses `quoky:r3-c2:routing-context:v1` and the exact ten-field order in §R33.
  **NB-R1:** the existing domain-separated hash construction is extracted to internal `canonical-digest`;
  containment digests reuse it without changing their bytes. No second algorithm or context owner.
- **NB-R2:** real SQLite Task creation → continuation preparation → admission → guarded start reaches
  attempt 1 with no prior history and issues authority. A same-Task rerun after FAILED/SUCCEEDED starts
  attempt 2 through the existing generic lifecycle but is rejected by C2A.
- **NB-R3:** history is read while STARTED and status is checked again afterward. A focused real-SQLite
  test attempts guarded start during the history read and observes `UNRESOLVED_STARTED_RUN`.
  This is a point-in-time validation under existing lifecycle guarantees, not a new transaction/lock.
- `ContinuationProviderRoutingService.execute` accepts an optional C2A `localContinuity` selection/plan
  for validation with a configured canonical issuer. It validates before availability probes, then
  returns `PRE_DISPATCH_FAILED` / `NOT_DISPATCHED` even for valid authority because C2C preparation is
  unavailable. The supplied plan is comparison material only, never dispatched by this entry. No app
  activation/wiring, provider execution, network action, containment preparation, or production trust.

R3-B3 production trust anchor/verifier/capability issuer remain NOT IMPLEMENTED; production trust stays
FAIL CLOSED. Historical R3-B1 APIs and global Stage2B attempt/hop constants are unchanged. C2B/C2C are
NOT STARTED; Kind B remains unsupported/DENY; Kind C and R3-C-Rz remain NOT AUTHORIZED. Carry forward the
upstream IntentClassifier unmatched-text GENERAL_CHAT default as a pre-production risk; C2A neither
reclassifies text nor changes taxonomy. No production readiness or runtime feasibility is claimed.

### R3-C — task definition (superseded by the R3-C1 implementation entry below) (2026-09-27)

The R3-C bounded task definition and its blocking remediation are recorded in `DECISIONS.md`. Current
implementation status for the authorized R3-C1 slice is the **R3-C1 — Local Continuity Eligibility &
Static Trusted Admission** entry below. R3-C2 and R3-C-Rz remain NOT AUTHORIZED.

### R3-C2 — architecture / entry definition (docs only) (2026-09-27)

**ARCHITECTURE / TASK-DEFINITION ONLY — NOT STARTED / NOT AUTHORIZED (implementation).** Branch
`codex/r3c2-architecture-definition` from main `347c03202014003e114fc2cdb3e1f2ff3866f4f0`. The descriptive
paragraph immediately below (original entry wording) is **SUPERSEDED BY THE R3-C2 ARCHITECTURE REMEDIATION**
and is retained only as history; for the current architecture see the **REMEDIATION** paragraph further
below and the DECISIONS.md "ADR-0090 amendment (remediation)" and "…(remediation 2 — BR-1 final)" sections.
In particular the "bind issuance to the admitted path via the existing R3-B1 WeakSet issuer" wording is
superseded: the corrected contract mints a NEW process-local `BoundLocalContinuitySelection` only after the
issuer invokes canonical `LocalContinuityAdmission.admit(...)`, and adds a first-`TaskRun`-only history gate.

_Superseded original entry (history):_ `DECISIONS.md`
carries the ADR-0090 amendment "R3-C2 architecture / entry definition" defining the security/trust bridge
between the R3-C1 admission decision and any future containment/runtime preparation, and closing the R3-C1
carry-forwards as ratifiable contracts: **CF-1** sole-selection issuance hardening (bind issuance to the
admitted path via the existing R3-B1 WeakSet issuer; process-local, explicitly NOT restart-valid); **CF-2**
exact identity binding reusing `TaskRun` / `executionId === taskRunId` + composite (registry+policy)
`configurationDigest` + routing context (no new identity system, no schema change); **CF-3** attempt-1 /
zero-hop enforcement owned by the existing Stage2B/continuation orchestration boundary (not R3-C2, no
duplicate retry); **CF-4** authoritative workload owner = deterministic `IntentClassifier`/policy (not
model/caller). Kind B trusted current-unavailability issuer placed in its own sub-slice **C2B** (rejects
`isAvailable()`/caller-declared/model/probe/stale; no durable authenticity yet → remains DENY). Runtime
family (Option A vs C) NOT selected — a feasibility comparison contract is defined and deferred to **C2C**.
R3-B3 production-trust elements remain fail-closed and are a separate future production-trust slice.
Proposed split: **C2A** (admission→execution identity & issuance hardening, smallest first), **C2B**, **C2C**.
R3-C-Rz (post-dispatch re-resolution) remains excluded with no hidden bridge. Docs-only: no runtime,
provider, network, DB/schema, approval/security owner, or new `RoutingFailureCode`. ADR-0090 remains
Proposed; implementation gated on independent Architecture Review + ratification.

**REMEDIATION (2026-09-28, CHANGES_REQUIRED B-1..B-5, N-1..N-7).** One additional remediation commit on
`codex/r3c2-architecture-definition` (parent `c55ff623…`, reviewed commit NOT amended) appends the
"ADR-0090 amendment (remediation)" to `DECISIONS.md`, correcting the architecture to ACTUAL code ownership
(confirmed by reading source): **B-1** the existing `SoleProviderSelection` (public
`assertExactSoleProviderSelection`, binds only `providerId`) is NOT sufficient — C2A defines a NEW
process-local issued `BoundLocalContinuitySelection` binding admitted `providerId` + R3-C1 admission
provenance + Stage2B composite `configurationDigest` + `taskRunId/executionId` + `RoutingContextDigest` +
canonical `capability`, minted only after the issuer INVOKES canonical `LocalContinuityAdmission.admit(...)`
(process-local, not restart-valid). **B-2** no `routingContextRef` exists → define `RoutingContextDigest` =
domain-separated `sha256Canonical` over ALL ten `RoutingContext` fields, issuer-re-derived from
`continuationRoutingContext(...)`. **B-3** `TaskRun` exists only after
`ContinuationExecutionAdmissionService`/`TaskManager.guardedStartRun`; `executionId === taskRunId ===
TaskRun.id`; exact START-first ordering. **B-4** enforcement owners named — `ContinuationProviderRoutingService.execute`
(pre-dispatch fallback/escalation rejection), `ProviderRoutingGateway.execute` (global attempt loop,
`MAX_PROVIDER_ATTEMPTS=2`/`MAX_ADDITIONAL_PROVIDER_HOPS=1`), `ContinuationExecutionAdmissionService`/`guardedStartRun`
(guarded one-run start); C2A IMPLEMENTS attempt-1/zero-hop/PRIMARY_ONLY at these owners (circular rule
removed). **B-5** authoritative workload = stored `Task.intent.capability` → boundTaskFacts →
`TaskRun.capability` (no `IntentResolver` step); caller/model labels ignored. **N-2** bound config identity =
Stage2B composite `ProviderSelectionDecision.configurationDigest`, NOT
`ContinuationProviderRoutingConfiguration.configurationDigest`. **N-7** `IntentClassifier` default
`GENERAL_CHAT` recorded as a pre-production gate; C2A only consumes capability from a persisted `Task`/`TaskRun`.
Still docs-only; ADR-0090 remains Proposed; implementation gated on independent Claude Architecture Review.

**REMEDIATION 2 (2026-09-28, BR-1 final).** A second remediation commit (parent `04c98671…`; neither
reviewed commit amended) appends "ADR-0090 amendment (remediation 2 — BR-1 final)" to `DECISIONS.md`.
Accepts **BR-1**: the codebase does NOT enforce one `TaskRun` per `Task` — storage `guardedStart` /
`TaskManager.guardedStartRun` / `ContinuationExecutionAdmissionService` reject only a concurrent unresolved
STARTED run and allocate `attempt = MAX(attempt)+1`, so after a terminal run a new `TaskRun` (attempt ≥ 2)
may start. Owner-3 wording is corrected: those components own concurrent-STARTED exclusion + canonical
`TaskRun` start + attempt ordinal, NOT one-run-per-Task. C2A adds a conservative first-`TaskRun`-only gate:
issue `BoundLocalContinuitySelection` only when `TaskRun.attempt === 1` AND `taskRuns.listByTask(taskId)`
proves NO prior `TaskRun` exists (both R3-C1 declarative `attemptNumber===1` and stored `TaskRun.attempt===1`
required; both ordinal and history must agree). A same-`Task` re-run after a terminal run is retry/re-run
semantics outside R3-C2A (belongs to R3-C-Rz, NOT AUTHORIZED); a genuinely new local-continuity request
enters via a NEW canonical `Task`. Also closes NB-1 (`RoutingContextDigest` domain tag
`quoky:r3-c2:routing-context:v1` over the ten `RoutingContext` fields; domain-separated hash, not the plain
JSON digest helper), NB-2 (locality/routing-class covered by the Stage2B composite `configurationDigest`,
not `RoutingContextDigest`), NB-3 (`IntentResolver` exists but is not on the GENERAL_CHAT path), NB-4
(`createContainmentCandidateBinding` still accepts a bare `SoleProviderSelection`, non-production under R3-B3;
future C2 preparation accepts only `BoundLocalContinuitySelection`), NB-7 (continuation path is
GENERAL_CHAT/CHAT only; SUMMARIZATION etc. not auto-wired). Still docs-only; ADR-0090 remains Proposed;
R3-C2 and R3-C-Rz remain NOT AUTHORIZED.

### R3-C1 — Local Continuity Eligibility & Static Trusted Admission (2026-09-27)

**CLOSED + DELIVERED — PR #87 merged (base `347c03202014003e114fc2cdb3e1f2ff3866f4f0`).** R3-C1 is
delivered as a PURE, runtime-independent admission contract in Core Application. The paragraph below is
retained as HISTORY of the implementation/review path (feature branch, remediation commits, exact-HEAD
review) and no longer describes the current status.

_History:_ Feature branch `codex/r3c1-local-continuity-admission`; remediation commits on top of reviewed
`ab0db3a0…` → `1a613542…` (none amended); canonical base `9bd94b45…`. R3-A / R3-B1 / R3-B2 / R3-B3 are
CLOSED + DELIVERED. R3-C1 is a PURE, runtime-independent admission contract in Core Application
(`local-continuity-admission.ts`): a deterministic versioned `WorkloadLocalFallbackPolicy` keyed on
`Capability` (coding/architecture/document-comparison ineligible by default). **Kind A is limited to closed
administrative conditions only**: A1 no NETWORK/cloud Provider configured (and policy not LOCAL-only), or
A2 every POLICY-COMPATIBLE cloud is administratively disabled. Kind A is NEVER a quality-floor, capability,
tool, routing-class, ranking, LOCAL-locality, or availability outcome — those DENY as normal routing
(`CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY`, `NORMAL_CLOUD_PATH_STATICALLY_EXISTS`,
`POLICY_REQUIRES_LOCAL_NORMAL_ROUTING`). It is derived via the Stage2B-owned read-only
`RoutingPolicyEngine.staticEligibility(...)` projection, which now separates POLICY-COMPATIBILITY (ignoring
`enabled`) from ENABLED eligibility and never reads availability/`isAvailable()`/`availabilityClass`/
snapshot. Admission binds to the composite (registry + policy) `configurationDigest` identical to `select`;
the local provider must independently be statically eligible under the same policy/config (no duplicated
floor logic). **Kind B DENY (no issuer)** and **Kind C DENY (unsupported → R3-C-Rz)** via `assert*Unsupported`.
Exact PRIMARY_ONLY sole-selection handoff through the pre-existing R3-B1 `assertExactSoleProviderSelection`
assertion; `attemptNumber = 1`, `additionalProviderHops = 0` (declarative). DENY means
local-continuity-not-admitted, never a whole-request STOP. Zero containment/runtime preparation; zero
production trust; R3-B3 fail-closed boundary unchanged. **R3-C2** and **R3-C-Rz** remain NOT AUTHORIZED; no
runtime family chosen. No new `RoutingFailureCode`, schema, aggregate, approval/security owner, or
runtime/provider/network/DB path. Validation: `local-continuity-admission.test.ts` (37, incl. N1/N2/N3 +
Kind A Cases 0–4) + `routing-policy-engine.test.ts` (33, incl. new projection-field tests) + Stage2B/R3-B
regressions (328) pass; `pnpm typecheck` passes; the only full-suite failure is the unrelated
env-sensitive `github-app-git-provider.test.ts` (`GIT_ASKPASS` set), not modified. Local commit only;
Push/PR/Merge require independent exact-HEAD review PASS.

### R3-B2 — secure terminalization and containment evidence (2026-09-26)

**CLOSED + DELIVERED.** R3-A, R3-B1, R3-B2 and R3-B3 are all CLOSED + DELIVERED as of current main
`eefd2709980866f88e1d5076914e3223b668794d`. R3-B3 was delivered on top of R3-B2 (production containment
trust closure + non-self-declarable remediation). This current-state projection supersedes the earlier
"implemented locally / awaiting review" wording; the historical audit detail below is retained unchanged.

R3-B2 blocking remediation of reviewed `3bb5c165efeac4b3661ea30ef3dc1d4d2dc5a693` is implemented
locally, awaiting a NEW independent exact-HEAD review. Prepared evidence validation now recomputes the
same canonical v1 binding digest used at issuance, rejecting rewritten run IDs or binding facts while
preserving JSON/restart compatibility. Generic save rejects every STARTED → terminal transition when
the current persisted row carries containment evidence, including completeRun/failRun with identical
or stale evidence. Only secure terminalization may perform that transition. Production provenance is
still a separate mandatory gate; no broader provenance redesign is included.

Continuation receiver completion/failure now uses TaskManager's current-row secure terminalization.
All runs admitted at this seam are continuation-bound; ordinary completeRun/failRun callers are unchanged.
Current durable post-attempt integrity mismatch or containment failure keeps STARTED / UNRESOLVED,
including when a stale receiver outcome requests success or failure. No status or persistence owner added.

Prepared candidates bind executionId = taskRunId (the canonical exact attempt identity), policy id/version/
digest, runtime family/version and model-mount digest before both verification channels. The containment
binding digest includes that context. A pure prepared-object projection reuses R3-A audit evidence and
retains the distinct provider digest, profile/instance identity and both channel verifier versions/results.
Legacy R3-A evidence remains readable; prepared identity fields are an all-or-none validated extension.
Profile/instance copies are rejected by module issuance registries; these public bounded identity factories
are NOT production runtime attestation. Trusted production issuance remains a mandatory future gate.

Fake-only in-memory tests cover current-row evidence preservation, stale snapshots, cross-attempt rejection,
model mismatch, containment/download uncertainty and phase-sensitive PROVIDER_SPAWN_FAILED.
No runtime family chosen, no real Provider/runtime/network/feasibility UAT, no production capability issuer,
no activation/config guard change. R3-C+ remains unauthorized. Local commit only; Push/PR/Merge require
separate approval after independent exact-HEAD review.

### Production Continuation Receiver R2 — offline provider-backed receiver (2026-09-26)

**IMPLEMENTED LOCALLY / AWAITING REVIEW** on review base
`ccb1864d98257ee844723f78155fbb2c2433cb73` (R1 = CLOSED + DELIVERED via PR #79). R2 implements the offline,
production-shaped provider-backed continuation path and remains fully testable offline with no real
Provider execution. R3 is NOT STARTED and live activation is not authorized.

A Core `ContinuationProviderRoutingService` — a **sibling** of `RuntimeProviderRoutingService`, not a
wrapper/import dependency, `CapabilityRouter`, or direct `AiProvider` caller — reuses the existing Stage2B
primitives, builds a fixed WORK/CHAT/AUTHORITY_SENSITIVE routing context from the R1 bound Task facts, and
enforces primary-only in code (any planned fallback/escalation → `PRE_DISPATCH_FAILED`, Gateway not
invoked). It maps the Stage2B execution audit into the bounded R1 `ContinuationRoutingAudit` using
per-attempt/dispatch evidence: definite pre-dispatch failure → FAILED; dispatched-but-uncertain
(post-dispatch timeout/execution-failure/unavailable) → UNRESOLVED; provider returned + terminal
validation → SUCCEEDED/FAILED. `PromptComposer.composeContinuation` owns continuation prompt authorship and
returns a PromptSpec plus a separate bounded validation corpus (identifiers only, fail-closed bounds, no
`## 3. Conversation transcript` layout so the Ollama adapter never reframes it). The app-layer
`ProviderBackedContinuationReceiver` implements the Core port with `supportedCapabilities = [GENERAL_CHAT]`
and narrow deps only; known pre-dispatch failures return bounded FAILED, it persists exactly one
platform-owned `MARKDOWN_REPORT` (ignoring provider-supplied artifact ownership), treats an Artifact save
failure as FAILED, and never terminalizes the TaskRun.

The production routing policy configuration adds `stage2b-continuation-general-chat-v1` and hardens the
chat policy to `requestTypes = [CONVERSATIONAL]`; separation is by predicate. The production configuration
digest changed to deterministically bind both validation-profile configuration digests.
`QUOKY_CONTINUATION_RECEIVER_MODE = disabled | general-chat-v1` (default `disabled`) is separate from
`QUOKY_PROVIDER_ROUTING_MODE`; `disabled` leaves the receiver binding absent (AppModule unchanged), and
`general-chat-v1` is explicitly rejected by production `loadConfig` with typed
`CONTINUATION_RECEIVER_CONTAINMENT_UNAVAILABLE` until R3 containment is delivered. The offline activation
factory is not production-wired; tests may compose it with fake containment. R2 is offline only.

R2 review remediation B-1–B-4: Gateway invocation escapes now produce UNRESOLVED/UNKNOWN with unknown
attempt count; corpus travels in Application validation facts, absent from Provider contextFiles, while
Runtime contextFiles behavior is preserved. The offline activation factory requires destination profiles
and rejects those whose minimal real composer/renderer prompt exceeds 32 KiB, without truncation.
Oversized (>4 KiB) corpus directives are excluded, so persona echo detection may omit those entries.
AUTH_REQUIRED remains a definite authentication refusal (FAILED, still DISPATCHED), not uncertain
termination; arbitrary Gateway escapes remain UNRESOLVED. R3 remains required and has not started.

```text
CONTINUATION_ROUTING_SERVICE = ContinuationProviderRoutingService (Core sibling)
RUNTIME_ROUTING_DIRECT_REUSE = NO / DIRECT_AI_PROVIDER = NO
CONTINUATION_POLICY = stage2b-continuation-general-chat-v1 / CHAT_POLICY_NARROWED = CONVERSATIONAL
REQUEST_TYPE = WORK / VALIDATION_PROFILE = AUTHORITY_SENSITIVE / PRIMARY_ONLY_ENFORCED = YES
PROMPT_OWNER = PromptComposer.composeContinuation / CONVERSATION_REFRAME = NOT TRIGGERED
REF_RESOLUTION = NONE (identifiers only)
OUTPUT_OWNER = platform ArtifactManager / ARTIFACT_KIND = MARKDOWN_REPORT / PROVIDER_ARTIFACT_IDS_TRUSTED = NO
TASKRUN_TERMINALIZATION_IN_RECEIVER = NO / EXECUTION_ID_EXACT_RUN = YES
CONTINUATION_MODE = disabled | general-chat-v1 / DEFAULT_MODE = disabled / PROVIDER_ROUTING_MODE_COUPLED = NO
ENABLED_WITHOUT_CONTAINMENT = STARTUP_FAIL_CLOSED / PRODUCTION_LIVE_READY = NO
ROUTING_POLICY_CONFIGURATION_CHANGE = YES / CONFIGURATION_DIGEST_CHANGE = YES
PRODUCTION_PROVIDER_BACKED_RECEIVER = IMPLEMENTED OFFLINE
CONTINUATION_EXECUTION_ACTIVATION = DISABLED / NOT LIVE-READY
LIVE_CONTAINMENT_READY = NO / LIVE_PROVIDER_EXECUTION_AUTHORIZED = NO / RUNTIME_EXECUTION_AUTHORIZED = NO
R3_STARTED = NO / DISCORD_LIVE_UAT_AUTHORIZED = NO
```

No new aggregate, repository, schema, migration, durable state, Approval model, plan persistence, live
provider execution, containment enforcement, external trigger, AiProvider bypass or CapabilityRouter
bypass. No Provider/Runtime/Discord/network/live UAT occurred.

### Production Continuation Receiver R1 — Core contract / lifecycle semantics (2026-09-23)

**IMPLEMENTED LOCALLY / AWAITING REVIEW** on review base
`c0e1f9d41f9d120e78cc5dcd12c89dc4c18d7300`. R1 changes only the Core continuation execution contract so a
future real receiver can distinguish definite success, definite failure and execution uncertainty, and
binds receiver capability support to the exact canonical Task that actually starts. No provider routing,
prompt composition, artifact persistence, production receiver binding or live execution is implemented;
R2/R3 are NOT STARTED.

The `ContinuationReceiver` port gains an immutable `supportedCapabilities` list that can only narrow
eligibility (never grant authority); the canonical Task remains the capability source. 6K snapshots and
freezes that declaration before the first await; empty/duplicate/malformed declarations fail closed
(`DENY / RECEIVER_PREFLIGHT / RECEIVER_UNAVAILABLE`) before any start. A package-internal, non-authoritative
`ContinuationExecutionConstraint` (absent from the public request DTO and transport surface) drives an
early capability check before `prepare` and an effect-time recheck over the Entry fresh `facts.task`
snapshot — the same object that becomes the guarded-start expected Task — closing the receiver-support
TOCTOU at the existing SQLite transactional deep-equality boundary with no new expected field. The
Family-A seven-capability allowlist is unchanged and now defined once as `isFamilyACapability`, applied on
the constrained path only; generic `Entry.start` semantics are unchanged. The constrained Entry returns
immutable `boundTaskFacts { capability, intentType }` from that same snapshot, so the receiver observes
canonical intent without any post-start Task re-read.

`ContinuationReceiverOutcome` is now three-state (`SUCCEEDED` / `FAILED` / `UNRESOLVED`) with no new
`TaskRunStatus`. A bounded provider-agnostic `ContinuationRoutingAudit` DTO lives in the Core port layer
(no raw prompt/output/error, path, secret, credential, environment, modelId or unbounded metadata; no
fabricated `attemptCount = 0`). `receiver UNRESOLVED` and any escaped `receiver.receive(...)` exception both
resolve to `ATTEMPT_UNRESOLVED` with the exact run left STARTED, `completeRun = 0`, `failRun = 0`, no
persisted UNRESOLVED audit and no retry/redispatch/replacement. This is an intentional
`DELIVERED_TEST_CONTRACT_CHANGE`: the delivered `receiver throw → failRun` / `6L throw → persisted FAILED`
tests were updated to `throw → ATTEMPT_UNRESOLVED`.

```text
RECEIVER_SUPPORTED_CAPABILITIES = YES / IMMUTABLE
PUBLIC_REQUEST_CAPABILITY_OVERRIDE = NO
OUTCOME_STATES = SUCCEEDED | FAILED | UNRESOLVED
TASKRUN_STATUS_UNRESOLVED_ADDED = NO
INTERNAL_CONSTRAINT = NON_AUTHORITATIVE / PACKAGE_INTERNAL
EARLY_6J_CHECK = YES (before prepare)
ENTRY_FRESH_CHECK = YES (over guarded-start-bound facts.task)
FAMILY_A_RECHECK_CONSTRAINED_ONLY = YES
FAMILY_A_ALLOWLIST_CHANGED = NO
TOCTOU_CLOSED_AT_GUARDED_START = YES
CANONICAL_INTENT_SOURCE = GUARDED_START_BOUND_TASK_SNAPSHOT
POST_START_TASK_REDISCOVERY = NO
ESCAPED_RECEIVER_EXCEPTION = UNRESOLVED
AUTO_RETRY = NO / AUTO_REDISPATCH = NO / REPLACEMENT_RUN = NO
UNRESOLVED_AUDIT_PERSISTENCE = NO (same-invocation return only)
CONTINUATION_ROUTING_AUDIT = PORT_LAYER / BOUNDED / PROVIDER_AGNOSTIC
DELIVERED_TEST_CONTRACT_CHANGE = YES
R2_STARTED = NO / R3_STARTED = NO
LIVE_CONTAINMENT_READY = NO
LIVE_PROVIDER_EXECUTION_AUTHORIZED = NO
CONTINUATION_EXECUTION_ACTIVATION = DISABLED
```

Validation (Node 18.20.5): focused continuation suite 14 files / 359 tests passed (44 new R1 tests);
`pnpm typecheck`, `pnpm build` and `git diff --check` passed with `GIT_ASKPASS` unset for the test run.
No production readiness is claimed; no Provider/Runtime/Discord/network/live UAT occurred.

### M3E-6L — Offline activation/composition acceptance (2026-09-23)

**IMPLEMENTED LOCALLY / AWAITING REVIEW** on `0b0c3be7c5d8d592b0739b4e8436bfa61731c185`.
M3E-6K is **CLOSED + DELIVERED** through PR #77 (merge `0b0c3be7c5d8d592b0739b4e8436bfa61731c185`,
reviewed HEAD `91834bb144b4d9f581bafcceb3fa1c810c421a8c`, independent review
PASS_WITH_NON_BLOCKING_FINDINGS / zero blockers). M3E-6G/H/I-a/I-b/J remain CLOSED + DELIVERED.
ADR-0089 / Family A is unchanged. Earlier entries below are implementation-time history.

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

Validation (Node 18.20.5): focused 15 files / 881 tests passed; final full suite 161 files /
3,292 tests passed, including all 20 new acceptance cases. `pnpm typecheck`, `pnpm build`, direct strict
new-test typecheck and `git diff --check` passed. Full suite used `env -u GIT_ASKPASS pnpm test` to avoid
the known inherited askpass sensitivity; no credential value was read. Two test-authoring corrections
were made before final validation: admission errors use `reason`, and Approval fixtures use the existing
`executionPlanRef` helper including required goal. No production execution semantics were changed.

### M3E-6K — Receiver seam and exact-run terminalization (2026-09-22)

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

### M3E-6J — Explicit continuation execution caller (2026-09-22)

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

### M3E-6I-b — Initial no-wait continuation context (2026-09-22)

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

- **Product identity migration:** Quoky Platform (`Quoky`), workspace `@quoky/*`, application
  `apps/quoky`, root package `quoky-platform`. Source rename is **DELIVERED** through **PR #61**
  (merge commit `9014a6190a167a1414197faeae2ad21164d930df`), from implementation HEAD
  `34f911174429385ca3b954df2cc0ddc7888a3230`. Independent exact-HEAD review:
  **PASS_WITH_NON_BLOCKING_FINDINGS**, **0 blocking findings**. ADR-0086 is **Ratified**;
  Chief Architect ratification is **APPROVED**. Non-blocking dispositions are recorded in ADR-0086.
  Historical names and paths in older implementation entries below describe their original Sprint.
  Current source imports and application paths use the new namespace. Legacy environment aliases,
  `./data/chunsik.db`, `.chunsik/context.md`, `.chunsik/task.md`, and `.chunsik-tmp` are preserved.
  The physical repository directory and GitHub repository are now both named `quoky-platform`,
  completing the external identity migration under separate strict approval; `origin` points at
  `jonghyungJeon-private/quoky-platform` with history and PR continuity preserved.
  Execution Admission is the next architecture target, not implemented or approved by ADR-0086.

- **M3E-6A:** ADR-0087 is **Ratified** by the Chief Architect following independent exact-HEAD Architecture
  Review **PASS_WITH_NON_BLOCKING_FINDINGS** at `90a67de840df71db2872b2a15e49c0efd117e93f`;
  **ADR_0087_READY_FOR_CA_RATIFICATION = YES**. Delivered through PR #66 at
  `51c28940357dbf792fdc8a287e54910abab9db3c`; M3E-6B evaluation status follows below.
  Selects Core Application admission composition (Option B, optional pure
  policy) over existing owners, exact TaskRun.id correlation, effect-time revalidation and fail-closed
  restart/replay. No new aggregate/repository/schema. Audit found current atomic start compares only Task;
  existing-owner atomic guard hardening is required before future continuation execution activation.
  Admission assessment is ephemeral and cannot authorize redispatch of a persisted STARTED run. Approval
  expiry is not currently enforced. Non-blocking implementation carry-forward: define the exact canonical
  unresolved STARTED predicate and close guarded-start bypass through generic taskRuns.save(), legacy start
  callers and any other insertion path, using the existing TaskRun owner. These are not ADR blockers;
  the predicate is implemented in M3E-6B below, while bypass closure remains deferred until activation.
  Actual receiving-agent execution and runtime wiring remain deferred.

- **M3E-6B:** Read-only `ContinuationExecutionAdmissionService` **delivered** through **PR #67** (merge commit
  `c0c91f341cb5f300628b86506c84e329d4f14eac`), following independent exact-HEAD review
  **PASS_WITH_NON_BLOCKING_FINDINGS** (0 blocking findings) at `df9a899083486f8051e4a4b73b55472b6ba41b42`.
  It returns ephemeral eligibility or bounded denial using canonical facts; zero Task,
  TaskRun, Approval, WorkItem or binding writes and no runtime wiring. Requires canonical RUNNING Task;
  unresolved conflict is exactly a run for the bound Task with persisted status STARTED, regardless of age
  or finishedAt. Terminal history grants no authority. Required approval uses the exact persisted request
  and original live plan/ref/integrity, never a reconstructed plan or cached approval. Effect-time atomic
  start and insertion/start bypass closure remain **DEFERRED ACTIVATION PREREQUISITES**, now architected in
  M3E-6C below. Continuation
  TaskRun start and actual receiving-agent execution remain **NOT IMPLEMENTED**; schema v11 is unchanged.

- **M3E-6C:** Effect-time guarded continuation start **architecture decided**; ADR-0088 is **Ratified** by
  the Chief Architect following independent Architecture Review **PASS_WITH_NON_BLOCKING_FINDINGS** at
  `d43c0b51fc5f869aa70a516c61df1d6ff017f330`; **ADR_0088_READY_FOR_CA_RATIFICATION = YES**.
  Guarded-start implementation is **NOT STARTED**. No Product code, schema or migration change.
  Selects **Option B** — a sibling guarded-start operation on the existing `TaskRunRepository` port — so
  `TaskManager`/`TaskRunRepository` remain the canonical TaskRun start owner while a narrow Core Application
  execution-entry service composes policy. The **linearization point** is the single commit of that guarded
  start transaction: before it no valid attempt exists, after it exactly one STARTED TaskRun exists and
  STARTED is truthful. Core supplies bounded expected canonical facts and the adapter verifies them
  atomically, mirroring the ratified `ContinuationBindingRepository.admit` shape; no SQLite policy enters
  Core. Effect-time facts are classified as atomically guarded, freshly read (AgentProfile configuration),
  immutable provenance, or caller-owned non-persisted (`ExecutionPlan`, which has no repository).
  `CONCURRENT_START_WINNERS = at most 1` via the existing `IMMEDIATE` write lock plus an unresolved-STARTED
  check — no lease, heartbeat, worker claim, distributed lock or `stateVersion`. Bypass closure refuses
  ordinary start and new-row insertion for continuation-bound Tasks while preserving `save` for terminal
  complete/fail updates. Audit surfaced a load-bearing gap: binding admits at PENDING, the evaluator requires
  RUNNING, and **no production owner transitions a continuation-bound Task to RUNNING**
  (`CONTINUATION_TASK_RUNNING_OWNER = UNSPECIFIED`) — recorded as an activation prerequisite, not invented
  here. **CONTINUATION_TASK_RUNNING_OWNER_WIRING = REQUIRED_ACTIVATION_PREREQUISITE**;
  **CONTINUATION_EXECUTION_ACTIVATION = DISABLED** until wiring is implemented and reviewed. Approval
  acquisition before RUNNING (where required) and exact Approval revalidation at guarded start are distinct
  gates; future lifecycle wiring must preserve both. Continuation Task RUNNING wiring, receiver invocation,
  redispatch/recovery and queue/worker architectures remain **NOT IMPLEMENTED**.

- **M3E-6D:** Continuation Task lifecycle wiring **DELIVERED** through PR #69 at
  `bab2e197151f9682298697be0cf5b18cb8f1e79b` (implementation `5a6b0c4de69127ed73390ca205f03a8b98495bb1`). This supersedes M3E-6C's historical
  unspecified-caller status above. Production composition now provides `WorkHandoffContinuationService`
  through the existing binding port token and existing Task/Approval owners. Its explicit `prepare` entry
  takes exact handoff/task IDs after `admit`, revalidates binding, ACTIVE work, profiles and Actor/Project
  relationships, and calls only `TaskManager.transition`: PENDING → PLANNING → RUNNING, or
  PLANNING → WAITING_APPROVAL → RUNNING through `ApprovalManager` acquisition/decision reads.
  A caller-owned live plan and exact approval ID are required where applicable; lost plan fails closed,
  waiting without the exact request ID cannot create a replacement, and no latest lookup is used.
  Already RUNNING is a no-op; terminal/incompatible state is denied. Inconsistent task/capability risk versus
  plan policy fails closed instead of changing ApprovalPolicy or manufacturing a higher-risk plan.
  Readiness is ephemeral, not execution authority; lifecycle reads/transitions are not atomic/CAS.
  The explicit Application entry is production-wired and tested through Nest composition and disposable
  SQLite. The default profile registry remains empty (no invented agents); valid configured endpoints are
  required. No transport trigger, automatic dispatch or receiver invocation is added.
  ADR-0088 remains **Ratified**. Guarded start/bypass closure **NOT IMPLEMENTED**, continuation execution
  activation **DISABLED**, receiver invocation **NOT IMPLEMENTED**. No TaskRun start/create/save calls,
  graph/status changes, new aggregate/repository/schema or runtime execution in M3E-6D. Guarded-start status
  is superseded by M3E-6E below.

- **M3E-6E:** ADR-0088 guarded atomic start **DELIVERED** through **PR #70**, merge commit
  `c603f0923d20b463907b471f127f5f870225a4ac` (implementation `7197cee89e25ba9c8d1e943152aa12f95f6b60de`). The narrow Core
  `ContinuationExecutionEntryService.start` performs fresh read-only admission, retains the exact evaluated
  domain snapshots, freshly reads profile configuration, and calls `TaskManager.guardedStartRun` → existing
  `TaskRunRepository.guardedStart`. No Task transition or Approval acquisition occurs here. Core derives
  plan refs from the original live plan, never from Task.planId; Approval policy remains in Core.
  The adapter mechanically compares expected handoff/binding/work/task/Actor/Project/Approval facts inside
  one SQLite IMMEDIATE transaction, checks absence of any bound-task STARTED run, allocates the ordinal,
  and inserts exactly one STARTED run. That single commit is the linearization point and begins a real
  attempt; the exact returned TaskRun/id is neither a reservation nor a redispatch token.
  Ordinary start refuses persisted continuation bindings. save refuses all new bound rows and terminal
  → STARTED revival, preserving existing completeRun/failRun terminal updates. Application/port insertion
  bypasses are closed; arbitrary raw SQL is outside this claim. v11 schema is unchanged; no new partial
  index, aggregate, repository, durable state, queue, worker, lease or recovery behavior.
  Validation: 33 focused tests including six simultaneously released child processes over real SQLite
  (one STARTED winner, five UNRESOLVED_STARTED_RUN losers), plus 646 related regression tests and typecheck.
  Production continuation caller/trigger **NOT IMPLEMENTED**, AgentProfile configuration surface
  **NOT IMPLEMENTED**, receiver invocation **NOT IMPLEMENTED**, continuation execution activation **DISABLED**.
  The execution-entry service is not added to production DI/transport activation. A post-commit caller
  failure leaves the exact STARTED run ambiguous; no automatic fail/success/replacement.
  Carry-forward: duplicated live-plan predicates **TRACKED**, duplicate pending Approval acquisition
  window **TRACKED / NON_BLOCKING** (M3E-6D acquisition semantics unchanged). ADR-0088 remains **Ratified**.

- **M3E-6F:** Activation-readiness architecture **DECIDED**; **ADR-0089 is Ratified** by Chief Architect
  decision after independent Architecture Review **PASS_WITH_NON_BLOCKING_FINDINGS**;
  **CONTINUATION_ACTIVATION_READY_TODAY = NO**. M3E-6D/6E are delivered, but insertion safety alone is
  insufficient: generic inherited TaskRun deletion can erase a bound run, and retention is additionally
  load-bearing because `WorkHandoffContinuationService.resolveRun` returns exact historical bound-run
  provenance and ordinal identity is `MAX(attempt)+1`, so deleting the highest attempt permits ordinal
  reuse. Ratified prerequisites: deny deletion of all bound runs including terminal history; explicit
  bounded SQLite lock wait plus typed storage contention (distinct from `UNRESOLVED_STARTED_RUN`, adapter
  owns driver translation, automatic Application retry NO); static AgentProfile input through existing typed
  app config (composition-time, immutable, non-secret, non-authoritative; not an Actor/Provider/Tool
  authority); shared pure structural live-plan proof; operation-scoped Approval proof; CANCELED coverage
  with revival denial and no unproven cancellation write. Ratified owner is the narrow Core
  `ContinuationExecutionService` for both coordination and receiver invocation, same invocation on the exact
  returned TaskRun, terminalized only by `TaskManager.completeRun`/`failRun`; ambiguous STARTED is left
  ambiguous and no `cancelRun` is invented. `ConversationRuntime` and `ExecutionOrchestrator` do not become
  handoff runtimes; `WorkHandoffContinuationService` stays preparation.
  Unresolved activation gates: **CONTINUATION_TRIGGER = UNSELECTED / PRODUCT_DECISION_REQUIRED**
  (`ACTIVATION_BLOCKED_UNTIL_TRIGGER_SELECTED = YES`; ratifiable unselected because every acceptable trigger
  invokes the same coordinator contract), **AUTHORIZED_ACTOR_PROJECT_SCOPE = PRODUCT_DECISION_REQUIRED**
  (relational consistency is not authorization), supported receiver capability set, and the shared post-wait
  caller-context problem — `AUTHORITATIVE_POST_WAIT_PLAN_SOURCE = NONE TODAY`, no supply contract defined,
  persistence NOT PROVEN, with reconstruction from `Task.planId`/`ExecutionPlanRef`/`ApprovalRequest`
  prohibited and three unselected resolution families recorded. `ApprovalRequest` has no kind field and none
  is invented: receiver scope must be proven or activation stays disabled pending a separately reviewed
  amendment. Duplicate pending approvals remain **TRACKED / NON_BLOCKING** conditional on exact
  `approvalId` retention. Raw SQL remains an explicit carve-out with **no immunity claim**. Ratified slice
  order: M3E-6G, M3E-6H, M3E-6I-a (independently actionable) → Product Decision gate → M3E-6I-b → M3E-6J →
  M3E-6K → M3E-6L. Activation DISABLED; automatic retry NO; exactly-once external effects NO CLAIM. Runtime,
  Provider, network, Live UAT and Production activation remain separate strict approvals not granted by
  ratification, merge, configured profiles or offline acceptance. Documentation only; no Product/DB/runtime
  mutation.

- **M3E-6G:** TaskRun persistence safety **DELIVERED** through **PR #72**, merge commit
  `80b28ea8fa9746cd970d37f982510ba5be4ada37` (implementation `9cbe1b1eab39b55a93b582f668698a8c463bc904`); on base
  `cf32815234608d9a46972e2186f35b3d5bcf48eb`. Implements the first ADR-0089 activation
  prerequisites and nothing else. `SqliteTaskRunRepository.delete` now overrides the inherited generic
  delete: it loads the persisted row, derives the decision from that row's own `task_id` and the canonical
  `continuation_bindings` entry inside one `IMMEDIATE` transaction, and refuses every continuation-bound
  run — STARTED, SUCCEEDED, FAILED, CANCELED and historical terminal rows — with the bounded
  `GuardedTaskRunStartError` code `CONTINUATION_RUN_DELETE_FORBIDDEN`. No caller flag, argument, convention
  or run status participates. Retention is load-bearing because `WorkHandoffContinuationService.resolveRun`
  returns exact historical bound-run provenance and ordinal allocation is `MAX(attempt)+1`, so removing the
  highest attempt would permit ordinal reuse. Re-parenting a bound run to an unbound Task cannot evade the
  guard: the existing v11 `task_runs_immutable_start` trigger already rejects `task_id`/`attempt`/
  `startedAt`/`capability` changes, and that invariant is asserted rather than duplicated.
  `UNBOUND_TASKRUN_DELETE = PRESERVED` and missing-id deletion remains a no-op.
  `REPOSITORY_PORT_DELETE_BYPASS = CLOSED`; `RAW_SQL_DELETE_IMMUNITY_CLAIMED = NO` — direct SQL remains an
  explicit trusted-admin carve-out and is asserted as such in tests.
  The SQLite lock wait is now explicit adapter configuration: `DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000`
  preserves the previously implicit better-sqlite3 default, optional `SqliteConfig.busyTimeoutMs` is
  validated as a bounded non-negative safe integer, and the timeout stays storage-owned with no
  SQLite-specific type reaching Core. Recognized driver lock contention before any successful commit is
  translated by the adapter into the typed `TASK_RUN_STORAGE_BUSY` outcome, deliberately distinct from the
  canonical `UNRESOLVED_STARTED_RUN` live-attempt conflict; unknown infrastructure failures keep existing
  repository conventions and are never swallowed. Core inspects no driver code, class or string.
  `AUTOMATIC_APPLICATION_RETRY = NO`: the driver's bounded wait inside one call is not Application retry,
  and no retry loop, sleep, replacement `guardedStart` or fabricated attempt identity was added — a typed
  busy outcome commits zero TaskRuns and yields no `TaskRun.id`.
  Coverage added in `task-run-persistence-safety.local-e2e.test.ts` (18 focused real-SQLite tests): bound
  delete refusal per status, unbound and missing-id preservation, re-parenting evasion, ordinal
  monotonicity across bound terminal history, the raw-SQL carve-out, a six-child-process delete-versus-
  guardedStart race in which every delete is refused and no replacement attempt starts, real lock
  contention mapped to the typed outcome with zero rows, contention-versus-live-attempt distinction, and
  `STARTED → CANCELED` persistence with `CANCELED → STARTED` revival denied. No `cancelRun` was invented and
  no production receiver cancellation path exists. No new aggregate, repository, schema, migration, durable
  state or TaskRun status; dependency direction and TaskRun repository ownership are unchanged.
  AgentProfile configuration **NOT IMPLEMENTED**; Product Decision gate **NOT REACHED**; production
  continuation caller and receiver invocation **NOT IMPLEMENTED**; continuation execution activation
  **DISABLED**. Independent implementation review **PASS_WITH_NON_BLOCKING_FINDINGS** (0 blocking) preceded
  delivery. Carry-forward: `GuardedTaskRunStartError` naming debt, SQLite timeout upper-bound validation,
  `SQLITE_LOCKED` typed mapping and delete/start concurrency-test robustness all remain **TRACKED /
  NON_BLOCKING**.

- **M3E-6H:** Static AgentProfile configuration **DELIVERED** through **PR #73**, merge commit
  `dfb473d882d58805270425657498caebc837c80c` (implementation `a94ecd765bfb7366581f541376b2afb2295154f4`); on base
  `80b28ea8fa9746cd970d37f982510ba5be4ada37`. The hardcoded production
  `new AgentProfileRegistry([])` is removed. `QUOKY_AGENT_PROFILES` is parsed **only** in
  `apps/quoky/src/config.ts`, following the existing `QUOKY_ACTOR_IDENTITY_MAPPINGS` JSON convention
  (`requireRecord`/`requireOnlyKeys`, bounded indexed error codes, no payload echo), and the composition root
  freezes the validated list into one immutable `AgentProfileRegistry` snapshot through
  `createAgentProfileRegistryProvider(config.agentProfiles)`. No env var is read in Core, the SQLite adapter,
  `WorkHandoffContinuationService` or `ContinuationExecutionEntryService`.
  The surface accepts exactly the five existing domain fields — `id`, `displayName`, `role`, `purpose`,
  `instructions` — matching source truth in `domain/agent-profile.ts`; no field was added. Parsing is strict
  and fails closed on invalid JSON, a non-array root, a non-object or null entry, a missing or non-string
  field, an invalid id shape, a duplicate id, any unknown key, blank or oversized text, more than 64 entries
  and a payload above 1 MiB. Unknown-key rejection is what blocks authority-shaped configuration:
  `providerId`, `apiKey`, credential or secret references, `executablePath`, `command`, `tools`,
  `capabilities`, `permissions` and approval flags are all refused rather than ignored, so a typo cannot
  silently become policy-looking data. Canonical bounded-text, control-character, identity and duplicate
  rules stay owned by `AgentProfileRegistry`; the config layer adds structure, ordering-independent duplicate
  detection and size bounds, then surfaces failures at the configuration boundary.
  `CONFIG_ERROR_ECHOES_RAW_INSTRUCTIONS = NO`: errors carry a bounded code with the entry index, and a
  sentinel test proves neither `instructions` text, secret-shaped values nor the raw payload appear in the
  message or stack. Identity is never trimmed, lowercased or case-folded, so `Receiver` does not resolve
  `receiver`; lookup still goes through the single existing `AgentProfileRegistry.get` path with no alias and
  no fuzzy matching.
  Absent or blank configuration yields `AgentProfileRegistry([])`, and an explicit `[]` is valid, so
  continuation remains fail-closed exactly as before — an unknown profile lookup still throws. The registry
  copies and freezes its input, which is asserted: mutating the source array or its objects after composition
  cannot change the active snapshot, resolved profiles and the registry itself are frozen, and no
  register/replace/remove/reload/add/set/clear API exists. `DYNAMIC_PROFILE_REGISTRATION = NO`.
  The public contract is documented in `.env.example` with a non-secret example using domain fields only and
  no internal class names. Configuration availability is the only change: `PROFILE_SELECTS_PROVIDER = NO`,
  `PROFILE_GRANTS_CAPABILITY = NO`, `PROFILE_GRANTS_TOOL_AUTHORITY = NO`, and a structural test proves a
  resolved profile carries exactly the five persona keys. A configured profile is not an execution request and
  not an execution authorization. No new aggregate, repository, schema, durable state or runtime registration
  API; dependency direction is preserved and AgentProfile remains configuration-only.
  Product trigger **UNSELECTED**; Product Decision gate **NOT REACHED**; post-wait live-plan contract and
  operation-scoped Approval proof **UNRESOLVED**; production continuation caller and receiver invocation
  **NOT IMPLEMENTED**; continuation execution activation **DISABLED**. Independent implementation review
  **PASS_WITH_NON_BLOCKING_FINDINGS** (0 blocking) preceded delivery. Carry-forward: error cause-chain
  redaction test, direct source-object mutation test, duplicate-id error echo (safe bounded input) and
  readonly config typing all remain **TRACKED / NON_BLOCKING**.

- **M3E-6I-a:** Shared structural live-plan predicate **IMPLEMENTED LOCALLY / AWAITING REVIEW** on base
  `dfb473d882d58805270425657498caebc837c80c`; not delivered. A source audit confirmed exactly three
  duplications between `WorkHandoffContinuationService.prepare` and
  `ContinuationExecutionAdmissionService.evaluate`: the live-plan structural validation block (identical
  apart from locally renamed helpers), the plan-reference/integrity comparison nested inside two
  differently-scoped approval checks, and the `text`/`timestamp` micro-helpers. All three now live in one
  pure Core module, `application/continuation-live-plan-proof.ts`, exporting `isCanonicalText`,
  `isTimestampText`, `matchesExecutionPlanIntegrity`, `matchesExecutionPlanRef` and
  `matchesLiveExecutionPlanStructure`.
  The structural dimensions the shared proof owns are exactly those already proven by both callers: plan id
  and goal canonical text, `Task.planId` ↔ plan id consistency, plan/Task project consistency, `overallRisk`,
  `approvalRequired` type, `status`, `requiredCapabilities` shape plus inclusion of the Task capability and
  validity of every entry, `steps`, `requiredResources`, `estimatedChanges`, `expectedArtifacts`, `createdAt`
  timestamp, and the canonical integrity triple when integrity is present. No proof dimension was added.
  The helper is pure: no storage, `ApprovalManager`, `TaskManager`, `AgentProfileRegistry`, Provider,
  environment, configuration, clock, I/O or mutable state, and it returns booleans so no new failure taxonomy,
  decision object or authority value is introduced. Callers map a `false` result into their existing bounded
  reason, so both keep their own error codes.
  Gate semantics were deliberately **not** flattened. Approval-policy consistency derivation
  (`taskRequiresApproval`, `plan.approvalRequired`, `ApprovalPolicy.evaluate`, capability-risk escalation) is
  a ratified policy-consistency check and stays in each caller. `prepare` still owns the `requestedBy`
  requester requirement and the exact `ApprovalRequest.id` check inside `matchesApproval`; read-only
  admission still does not require `requestedBy`. Lifecycle expectations still differ by design — admission
  requires `RUNNING` while preparation accepts `PENDING`/`PLANNING`/`WAITING_APPROVAL` — and the
  `PENDING → PLANNING → RUNNING`, `PENDING → PLANNING → WAITING_APPROVAL` and exact-authority
  `WAITING_APPROVAL → RUNNING` paths are unchanged, with no TaskRun creation, guarded start or receiver call.
  Admission remains read-only, ephemeral and non-authoritative; the M3E-6E guarded SQLite transaction remains
  the only effect-time authority. `ContinuationExecutionEntryService` was not broadened.
  The live plan remains caller-owned: nothing is persisted, cached, or reconstructed from `Task.planId`, an
  `ExecutionPlanRef` or an `ApprovalRequest`, and a regression proves both consumers still refuse to proceed
  without the supplied plan even when a persisted `planId` and an APPROVED request exist. `Task.planId`
  participates only as a structural consistency check and is never authority.
  Coverage: 52 focused tests — direct proof tests for every structural dimension via a table-driven
  one-field-at-a-time mutation matrix, integrity and plan-ref comparison cases, order/history independence
  with argument-mutation checks, purity assertions over the module boundary, and cross-consumer consistency
  proving that no structural mismatch can be accepted by one consumer while rejected by the other (reason
  codes intentionally may differ) with no lifecycle transition or write on rejection. The pre-existing
  prepare, admission, entry, guarded-start, persistence-safety and config suites pass unchanged, which is the
  behavioral parity evidence.
  No new aggregate, repository, schema, migration, durable state, Approval model or ExecutionPlan repository;
  dependency direction preserved. `POST_WAIT_LIVE_PLAN_SOURCE` and `OPERATION_SCOPED_APPROVAL_PROOF` remain
  **UNRESOLVED**; `ApprovalRequest` still has no kind/purpose/operation field. This is the final ratified
  implementation slice before the **Product Decision gate**, which is **NEXT / NOT REACHED**: the
  continuation trigger, authorized Actor/Project scope and supported receiver capability set remain
  Product Owner decisions and were not chosen here. Receiver invocation **NOT IMPLEMENTED**; continuation
  execution activation **DISABLED**. Independent implementation review pending; delivery is not claimed.

- **M3E-3:** Delivered through PR #58 (merge commit `618b5afcc6079be956d3756f9281506907571dde`).
  ADR-0083 is Ratified; independent implementation review PASS and documentation close-out review
  PASS_WITH_NON_BLOCKING_FINDINGS preceded delivery. Consumption remains read-only and grants no authority.
- **M3E-4:** Delivered through PR #59 (merge commit `285f3663beff5334419e8ddf967855b440df8a5e`);
  independent Claude review PASS_WITH_NON_BLOCKING_FINDINGS (0 blocking findings), and ADR-0084 Ratified by
  the Chief Architect. ContinuationBinding is immutable handoff↔Task provenance
  only; TaskRun remains the canonical execution-attempt identity, with exact TaskRun lookup
  through existing TaskRun.taskId. No Task/TaskRun creation, execution, dispatch or runtime wiring. SQLite v10
  adds only the binding relation; existing CAP-013/014 ownership and Runtime dependency baseline 31 are unchanged.
  Initial admission revalidates canonical ACTIVE work/PENDING task and no prior runs atomically; exact replay
  is idempotent and conflicting/stale state fails closed. Actual receiving-agent execution remains later.
  M3E-5 removes the concurrent-attempt allocation precondition by hardening the canonical TaskRun start boundary.
- **M3E-5:** Implementation COMPLETE at `ff12ffa73e68ffc810b4a7d9698c219a378cc382`; independent review
  PASS_WITH_NON_BLOCKING_FINDINGS (0 blocking findings); ADR-0085 Ratified by the Chief Architect; schema `v11`.
  TaskRun remains the canonical execution-attempt identity and `attempt` an ordinal within one Task; no
  ExecutionAttempt aggregate, Receipt kind, retry engine, lease, scheduler or Agent runtime is introduced.
  Atomic `TaskRunRepository.start()` replaces the former `listByTask().length + 1` allocation, so storage —
  not the application layer — owns concurrent ordinal allocation, while Core stays storage-neutral. SQLite
  enforces `(taskId, attempt)` uniqueness and immutable start identity; a canonical Task must already be
  RUNNING and stale/missing/non-RUNNING Task snapshots fail closed with no partial write. Existing
  `completeRun`/`failRun` update semantics are preserved. Actual continuation execution, receiving-agent
  dispatch and Agent runtime remain later and gain no authority here. Delivered through PR #60 at merge commit
  `bef459aaf3a77549dd44760a21ea839073b0cb46`.
- **Phase:** `M2 = COMPLETE_AND_ACCEPTED / CLOSED`; `QUIRKYBOT_DEV_V1 = MILESTONE_REACHED / CLOSED` with
  `QUIRKYBOT_DEV_V1_ACCEPTANCE_CRITERIA = MET`. Stage 2C Slice 3C was implemented in commit `683297f`, independently
  reviewed `PASS`, and closed the prior delegated offline implementation gap. Bounded Live UAT was `EXECUTED` and
  `PASS` at exact verified HEAD `715c407a52eee36a7717d1b4b6695b1469bb0a76`.
- **Active milestone:** `M3`. The M3 Architecture Rebaseline is `RATIFIED_WITH_CHANGES` through ADR-0074,
  ADR-0075, and the appended ADR-0032 amendment. M3A-1 implements `ResourceRef` plus the first read-only Jira/GitHub
  Personal Work Surface. M3A-1.1 adds app-boundary Actor identity provisioning. M3A-2 implements the bounded
  CAP-011 WorkItem persistence foundation; accepted M3B–M3E-3 foundations are delivered, M3E-4 is delivered
  through PR #59 with ratified architecture (ADR-0084), and M3E-5 is delivered through PR #60
  with ADR-0085 Ratified (schema v11).
- **Version 1 source release:** `v1.0.0 = COMPLETE / CLOSED` at
  `80bbc94de0493c24036197dabc2ff00dbcd20cbf` (`origin/main` and `v1.0.0^{}`). Tag creation or push is not an
  outstanding release task. This source-release fact does not claim Production Runtime readiness.
- **Current Product delivery mode:** Quoky orchestration is FROZEN for current Product delivery per the
  Product Owner's M3E-4 instruction. Use Direct CLI FAST DELIVERY; Quoky execution
  and control-state mutation are outside scope.
- **Development governance:** `AUTONOMOUS_DEV_MODE = ENABLED`; Product Owner retains
  product/UAT/debug/high-risk authority; Architect AI owns task-level delegated local approval within an active
  milestone, Codex builds, and Claude independently reviews. Strict external/destructive/Runtime/application-Provider
  gates remain Human-only.
- **Development DB governance:** `AUTONOMOUS_DEV_DB = APPROVED`. When `QUOKY_RUNTIME_ENV=dev`, the configured target
  resolves exactly to repository `data/chunsik.db`, and no Production/shared DB is selected, create/open, WAL,
  migrations v1-v7, `PRAGMA user_version`, and bounded normal UAT persistence are delegated. The former
  `DB_MUTATION_NOT_AUTHORIZED` blocker is resolved for that exact development target only.
- **Offline checkpoint:** `STAGE_2B_OFFLINE_COMPLETION = COMPLETE_AND_ACCEPTED` and
  `STAGE_2B_OFFLINE_BLOCKERS = NONE`.
- **Blocked carryover:** XR-AX is optional for Stage 2B offline completion and is `BLOCKED_CARRYOVER`; XR
  filesystem provenance is a `STABLE_BLOCKER`;
  concrete 5C-EG enforcement is `BLOCKED_CARRYOVER`; 5C-EG-I1/I2/V/E are `NOT_ELIGIBLE`.
- **Accepted closeout surface:** ADR-0065 and ADR-0066 are ratified; F0-XR-FCI is
  `COMPLETE_AND_ACCEPTED`; F0-XR-FP is `COMPLETE_AND_ACCEPTED_WITH_CARRYOVER`; 5C-EG-F′ is `ACCEPTED`,
  its feasibility loop is `CLOSED`, and its result remains `NO_FEASIBLE_ARCHITECTURE_YET`.
- **DEV_V1 UAT risk decision:** `CONFIG_RESTRICTED_RISK_ACCEPTED = APPROVED_FOR_DEV_V1_UAT_ONLY` for the current local
  Darwin development host. The exception applies only with exact current-revision UAT authorization,
  `QUOKY_RUNTIME_ENV=dev`, primary `ollama-cli` / `llama3.1`, the approved development Discord bot/guild/channel,
  existing routing/egress/config restrictions, and bounded UAT scenarios. It is not Production-safe 5C-EG and does
  not authorize arbitrary Provider/network execution.
- **5B-2B-E close-out:** `CLOSED_WITH_GENERATION_BLOCKED`. Bounded preflight/inventory is `PASS_ACCEPTED`;
  generation remained unexecuted in that historical close-out, Provider execution count was `0`, and model pull
  count was `0`.
- **Composition:** `QUOKY_PROVIDER_ROUTING_MODE` is parsed exactly and defaults to `legacy`. The composition root
  injects the optional result of an app-private activation factory; legacy mode constructs no new routing Provider.
  Enabled mode remains startup-blocked before Provider construction because no 5C-EG enforcement exists.
- **UAT acceptance:** `QUIRKYBOT_DEV_V1_UAT = PASS_EXECUTED` at exact verified HEAD
  `715c407a52eee36a7717d1b4b6695b1469bb0a76`. The immediately-previous-user-turn recency grounding defect is
  `RESOLVED_ACCEPTED`; current-turn response behavior is `PASS`; Korean response behavior is `PASS`. No
  transcript/meta-analysis leakage and no internal provenance/epistemic metadata leakage were observed.
- **Nested-reference feedback `786b50ad`:** focused provider-boundary coverage confirms the prior User choice request,
  the Assistant selection `파스타가 좋을 것 같아`, and the final User subtype question reach the Ollama CLI input
  in that role-correct chronological order. The observation is classified as provider/model semantic quality, not
  a ContextBuilder or history-loss defect; no phrase-specific handling was introduced.
- **Bounded Provider diagnostics:** under explicit Product Owner approval, the provider recall comparison diagnostic
  executed generation through `ollama-cli` for `llama3.1` and `granite3.3`, and the `llama3.1` stochastic reliability
  diagnostic also executed in its explicitly approved bounded diagnostic scope. These executions were diagnostics
  only; they were not application Runtime execution, Discord connection/action, or Discord Live UAT, and the
  completed diagnostic tasks are not reopened.
- **Remaining Human-only boundaries:** Production/shared DB mutation or migration apply, non-disposable destructive
  DB work, Push, PR, Merge, Production/Release, destructive/unrelated cleanup, and any further Runtime
  start/stop/restart, Discord, or application Provider/network execution remain unapproved.
- **Historical Live UAT evidence:** bounded application Runtime / Discord Live UAT was `PASS_EXECUTED` at exact
  verified HEAD `715c407a52eee36a7717d1b4b6695b1469bb0a76`. ADR-0070 resolved the delegated development DB condition and ADR-0071
  resolved the DEV_V1 UAT live-activation architecture blocker through the bounded configuration-restricted risk
  exception. Production-grade 5C-EG remains `NO_FEASIBLE_ARCHITECTURE_YET / BLOCKED_CARRYOVER`, and
  Production/shared DB mutation remains a separate unapproved Strict boundary.
- **Execution facts:** the accepted Live UAT exercised the approved bounded application Runtime, Provider/network,
  and designated development Discord scope at HEAD `715c407`. The earlier diagnostic scopes also executed
  `llama3.1` and `granite3.3` generation through `ollama-cli`; those diagnostics remain separate from Live UAT.
- **Milestone transition:** `QUIRKYBOT_DEV_V1 = MILESTONE_REACHED / CLOSED` and
  `M2 = COMPLETE_AND_ACCEPTED / CLOSED`. M3 is active under the ratified rebaseline and normal delegated
  development governance; all Strict gates remain intact.

## Version 1 Source Release — Closed

- **Source identity:** `v1.0.0` resolves to `80bbc94de0493c24036197dabc2ff00dbcd20cbf`; the source release and its
  acceptance are complete and closed. Package metadata remains independently versioned at `0.1.0`.
- **No outstanding tag task:** creating, moving, deleting, or pushing a tag is neither pending nor part of M3. The
  existing tag must remain unchanged.
- **Historical acceptance:** the accepted Live UAT evidence remains the bounded `PASS_EXECUTED` run at
  `715c407a52eee36a7717d1b4b6695b1469bb0a76`. It is historical evidence and is not reopened by M3.
- **Carryovers:** Production-grade 5C-EG and other recorded blocked carryovers remain fail-closed where applicable;
  they do not reopen the completed source release and do not authorize Production activation.
- **Strict exclusions:** Push, PR, Merge, tag mutation/push, GitHub Release publication, Production activation,
  Runtime or Provider/network execution, Discord, Live UAT, secrets, destructive work, and Production/shared DB
  mutation each remain outside normal delegated local development.

## M3 Architecture Rebaseline

- **Status:** `RATIFIED_WITH_CHANGES` in ADR-0074, ADR-0075, and the appended ADR-0032 amendment.
- **M3A-1 boundary:** `ResourceRef` stable identity plus a read-only, non-authoritative Work Surface only. No
  `WorkItem` repository, persistence, schema, or migration belongs to M3A-1.
- **M3A-1 implementation:** `WorkSurfaceQuery` resolves explicit Jira/GitHub identities from the current `Actor`,
  queries only read-only `ConnectorProvider` seams, normalizes connector items to `ResourceRef`-backed projection
  items, applies deterministic ordering, and reports complete/partial/unavailable source status. The natural
  personal-work intent is presented without AI execution. `ConversationRuntimeDeps` remains at its starting
  baseline of 31 by replacing the pre-existing unused `risk` dependency with the Work Surface service.
- **M3A-1.1 identity provisioning:** optional non-secret `QUOKY_ACTOR_IDENTITY_MAPPINGS` configuration locates an
  existing Actor by its Discord `ExternalIdentity` and app-private startup provisioning additively saves explicit
  Jira/GitHub identities through the existing repository. Missing Actors and all ownership/platform conflicts fail
  closed; omission removes nothing; exact repetition is a no-op. No Actor creation, inference, credential storage,
  Core contract, schema, or migration was added.
- **M3A-1.1 reachability evidence:** offline fake-repository/fake-connector coverage proves Jira-only, GitHub-only,
  merged, preservation, idempotence, conflict, absent-Actor, and connector-unavailability behavior without a live
  network call. Conversation Runtime remains uninvolved and stays at the accepted dependency baseline of 31.
- **M3A-2 boundary:** narrow CAP-011 `WorkItem`, repository, forward-only additive migration, and persisted personal
  work state. `WorkItem` does not absorb Task, execution, Approval, Provider, arbitrary conversation, or workflow
  state.
- **M3A-2 implementation:** `WorkItem` persists only durable identity, canonical `Actor.id` ownership, optional
  `Project.id`, `ResourceRef` correlations, the closed `ACTIVE`/`COMPLETED`/`CANCELED` lifecycle, and the narrowed
  `conversation`/`connector` origin. `WorkManager` transitions by id from the canonical persisted aggregate so only
  status and `updatedAt` change; SQLite migration v7 adds only
  `work_items`, and repository reload coverage proves durable round-trip. `ConversationRuntime` owns no WorkItem
  state and `ConversationRuntimeDeps` remains 31.
- **Later ratified foundations:** ADR-0076/0077 supply bounded ToolProvider/MCP foundations; ADR-0078 owns
  receipts; ADR-0079/0080 supply AgentProfile and handoff; ADR-0081/0082/0083 supply trigger provenance, delegation
  and read-only consumption. Workflow, autonomous execution, graph engines and universal event sourcing remain deferred.
- **Conversation boundary:** `ConversationRuntime` remains an entry point, owns no global/persistent work state, and
  its dependency surface must not grow beyond the previous accepted baseline for each completed M3 slice.

## Stage 2C — Slice 3C ExecutionPlan Integrity Binding Architecture

- **Status:** `STAGE_2C_PLAN_BINDING_ARCHITECTURE = EXECUTION_PLAN_REF_TYPED_INTEGRITY_EXTENSION` is `RATIFIED`;
  implementation is `COMPLETE_AND_REVIEWED` at commit `683297f`; Claude independent review is `PASS`. Slices 1, 2,
  and 3B are `COMPLETE_AND_ACCEPTED`; Slice 3A architecture is `RATIFIED`.
- **Core contract:** ADR-0068 defines a generic opaque `ExecutionPlanIntegrityRef { kind, contractVersion, digest }`
  for optional propagation through `PlanningRequest → ExecutionPlan → ExecutionPlanRef`. It identifies the exact
  plan's integrity; it is not an Approval subject, Stage 2C domain object, suitability profile, or Runtime authority.
- **Approval and persistence:** Approval remains strictly plan-scoped and its semantics are unchanged. The design
  adds no persistence, migration, capability, or aggregate. Content-addressing `ExecutionPlan.id` is rejected, and
  in-memory plan retention alone is insufficient across process/session loss.
- **Referential integrity:** Patch and Workspace boundaries must compare plan id plus integrity kind, contract
  version, and digest. Presence mismatch and any typed-integrity mismatch reject; two legacy refs that both omit
  integrity retain existing behavior.
- **Stage 2C binding:** the exact proposed source/config change must exist before plan creation. SHA-256 binds
  `applicationSubjectDigest` and `proposedChangeDigest` into `planIntegrityDigest`; existing non-cryptographic
  `contentHash` helpers are not eligible for this security boundary.
- **No-op and ownership:** `target === expected` is `VERIFIED_NOOP` and creates no plan, approval, patch, or write.
  The app layer derives and freshly revalidates binding facts; ApprovalManager stays generic, PatchManager only
  strengthens ref equality, and WorkspaceWriteManager remains the sole filesystem mutation owner.
- **Safety:** the M1 build/configuration-time model remains authoritative, M2 live Runtime mutation remains deferred,
  and the proposed change cannot expand egress scope or alter routing policy, Runtime wiring, or unrelated providers.

## Stage 2C — Slice 3B Profile Configuration Application Gate

- **Boundary:** pure app-private admission and deterministic projection only. It creates an application candidate,
  not an `ExecutionPlan`, `ApprovalRef`, Patch, mutation authorization, or Runtime object.
- **Configuration identity:** the gate recomputes the exact existing production Registry/policy/configuration
  identity from declarations. The expected result replaces only the ratified provider/model profile while retaining
  unrelated descriptors, policy, ordering semantics, enabled state, validation, and deadline configuration.
- **Safety:** the ratified profile is independently revalidated; the exact Stage 2B provider/model egress scope
  cannot expand; expiry is bounded to 24 hours and uses explicit canonical UTC inputs; malformed, expired,
  unsupported, mismatched, or stale third-state input fails closed.
- **Idempotency:** exact before-state yields `APPLY_REQUIRED`; exact derived after-state yields `VERIFIED_NOOP`;
  every other valid configuration identity is stale and rejected.
- **Provenance/mutation:** candidates bind `SELF_CONSISTENT_UNSIGNED` and `executionMutation = NONE`. No filesystem,
  Registry, policy, Runtime, Provider, process, network, persistence, or Approval mutation is performed.

## Stage 2C — Slice 3A Profile Configuration Application Architecture

- **Decision:** ADR-0067 selects M1 build/configuration-time application. M2 live Runtime Registry mutation is
  deferred; no new Core authorization aggregate, approval database, ApprovalRef, or ApprovalManager behavior is
  introduced.
- **Application gate:** the Slice 3B app-private `ProfileConfigurationApplicationGate` validates the ratified profile,
  exact current configuration identity, expected-result digest, application-contract version, bounded expiry, and
  Stage 2B egress compatibility before producing a deterministic application subject or real change plan/Patch.
- **Authority:** profile ratification and application-subject validity do not approve a configuration change. A
  real configuration-change `ExecutionPlan`/Patch must use the existing plan-scoped Approval boundary before its
  existing mutation owner may act.
- **Safety:** application cannot expand protected egress scope. Exact idempotent repetition may verify as a no-op;
  all mismatched, malformed, expired, unsupported, or unreadable state fails closed.
- **Provenance:** assurance is `SELF_CONSISTENT_UNSIGNED`; digest consistency is checked, but benchmark provenance
  authenticity is not cryptographically proven.
- **Implementation:** the Slice 3B application gate now implements admission and deterministic subject derivation.
  Plan/Patch creation, Workspace apply, Core/Approval changes, Runtime or ProviderRegistry mutation, and live
  activation remain outside the implemented boundary.

## Stage 2C — Slice 2 Static Suitability Profile Ratification

- **Boundary:** app-private offline tooling validates one Slice 1 candidate and one explicit approval binding; it
  does not query `ApprovalManager`, add a Core approval type, or update Registry, policy, production configuration,
  persistence, Runtime composition, or Provider activation.
- **Eligibility:** only an internally valid `ELIGIBLE` candidate with `RATIFICATION_REQUIRED`, `runtimeMutation =
  NONE`, and a disabled descriptor can be ratified. `INELIGIBLE`, `UNPROVEN`, malformed, stale, mismatched, or
  unsupported-version inputs reject fail-closed.
- **Binding:** ratification binds approval identity and authority to the exact candidate, benchmark evidence,
  descriptor configuration, Provider/model identity, and projection/ratification contract versions.
- **Output:** the approved static profile and nested descriptor are immutable and carry a deterministic approved
  profile digest. Ratification remains offline evidence processing; the approved descriptor stays disabled and is
  not a live activation or production-configuration mutation.
- **Approval authority constraint:** `SuitabilityRatificationApprovalBinding` is an independently supplied offline
  binding. `APPROVED` means that candidate identity and the supplied binding passed deterministic checks; operator
  authority, ApprovalManager decision, uniqueness, expiry, revocation, Runtime activation, and production
  authorization are not proven.
- **Application architecture:** ADR-0067 closes the v1 architecture question without treating the profile as
  execution authority: M1 application must create a real configuration-change plan/Patch that uses the existing
  plan-scoped Approval boundary. Slice 3B implements only the pre-plan application gate; ADR-0068 ratifies the Slice
  3C plan-integrity architecture, whose implementation remains not started.
- **Evidence authenticity:** candidate self-consistency is verified, but unkeyed candidate/evidence digests do not
  cryptographically prove benchmark provenance. Authoritative Runtime/audit use requires separate consideration of
  persisted evidence artifacts or authenticated/signature-backed provenance; this is not a Slice 2 blocker.

## Stage 2C — Slice 1 Model Suitability Evidence Projection

- **Boundary:** app-private offline tooling consumes bounded Stage 2A campaign/decision evidence and produces an
  existing-Core-compatible `ProviderDescriptor` candidate. It does not update a Registry, policy, production
  configuration, Runtime collaborator, persistence, or Provider binding.
- **Suitability:** exact `ELIGIBLE | INELIGIBLE | UNPROVEN`; hard safety/containment/download failures cannot be
  offset by scores, while malformed, identity-mismatched, digest-mismatched, and stale bindings reject fail-closed.
- **Binding:** campaign/configuration/fingerprint, decision policy, Provider/adapter/model, descriptor configuration,
  prompt/scenario/evaluator versions, projection version, evidence digest, and candidate profile digest.
- **Ratification:** output is always `RATIFICATION_REQUIRED` with `runtimeMutation = NONE`. Evidence changes create
  another candidate and never alter routing automatically; its descriptor remains disabled until a separately
  approved composition profile is created.
- **V1 correction:** commit `ff1a356` is the accepted Slice 1 remediation within projection/profile v1. It narrows
  eligibility by preserving observed hard-safety disqualifications as `INELIGIBLE` when scorecard evidence is
  missing; it is neither a new profile schema nor a broader eligibility semantic, so no version bump is required.

## Stage 2A — Completed

- **Status:** **Completed** (`STAGE_2A = PASS`). Stage 2A established trustworthy Provider Evaluation
  Infrastructure; Provider routing and operational policy are explicitly deferred to Stage 2B.
- **Deliverables:** Evaluator v4, immutable Golden Corpus, post-push Binding ratification,
  deterministic Replay, pool-decoupled Benchmark Framework, Decision Engine, and Provider Ranking.
- **Evaluator:** `stage2a-semantic-checker-v4` is the production default. Historical Golden Corpus
  replay remains pinned to `stage2a-semantic-checker-v3`.
- **Golden Corpus:** Stable A1+A3 corpus — 224 records / 896 checks; combined digest
  `add786d6ebef4cb0158119783b2329f30a6c030ed37682c95d1071df7801e3b4`.
- **Provider Ranking:** Balanced Primary Candidate — `llama3.1:8b`; Semantic Candidate —
  `granite3.3:8b`; latency-only evidence — `llama3.2:3b`; `mistral:7b` deprioritized.
- **Prompt Root Cause:** **NOT ESTABLISHED**.
- **Stage 2B:** Architecture and Option B typed policy foundation are ratified in ADR-0064. Slices 1–4 implement
  deterministic selection, immutable planning/binding, bounded two-attempt Gateway orchestration, response
  validation, audit, and private simulation. Slice 5A adds the offline Core Runtime integration seam for only
  TaskRun-backed `GENERAL_CHAT`; real app composition and external Provider execution remain deferred.

## Stage 2B — Slice 4 Deterministic Routing Selection Simulation

- **Boundary:** independent `selection/` subtree in the existing private validation package. Replay stops at
  `RoutingPolicyEngine → ProviderSelectionDecision`; execution planning, Gateway, validation, bindings, Runtime,
  adapters, and production dependency wiring are absent.
- **Fixtures:** five strict, statically registered JSON scenarios with independent schema/compiler/digest versions
  and immutable fixture/corpus SHA-256 identities.
- **Projection:** exact decision facts plus `matchedPolicyId` and the configured ranking dimension/direction vector;
  no scores or execution facts.
- **Determinism:** every fixture replays twice. The current multi-provider Golden fixtures exercise Provider
  registration-order permutation. Policy declaration-order permutation remains implemented but is not independently
  exercised by the single-policy corpus; policy-order independence is owned by Core normalization and regression.
  Coverage includes policy match/absence, eligibility/no-eligible, disabled/unavailable filtering,
  preference/ranking, stable ordering, and one Authority × Safety × Ranking cross-scenario. Provider invocations
  remain zero.

## Stage 2B — Slice 5A Offline Runtime Integration Seam

- **Boundary:** optional Core Application collaborator plus `ConversationRuntime` integration for only
  TaskRun-backed `GENERAL_CHAT` work turns. The app composition root is intentionally unchanged.
- **Context/profile:** exact static enum mapping from existing Runtime facts; `GENERAL_CHAT` validation profile is
  fixed upstream. There is no message reclassification, Provider/model branch, evidence lookup, clock/random use,
  or I/O in the mapping.
- **Availability/execution:** each configured executable Provider is probed at most once per request, producing one
  immutable snapshot consumed by Registry → Policy → Planner → Gateway. Gateway never re-probes availability.
- **Lifecycle/audit:** accepted bounded output persists artifacts and completes TaskRun/Task. Human review reuses
  `NEEDS_REVIEW`; rejected, safety, configuration, and execution failures reuse `FAILED`. Every outcome persists
  bounded `routingAudit`; only accepted output records its actual Provider on `TaskRun.providerId`.
- **Rollout:** once this seam handles a request, no legacy selection fallback or shadow comparison occurs.
  Project Analysis, Code Generation, no-work chat, and other Capabilities remain legacy. Tests use fake Providers;
  Slice 5B-1 now supplies unwired production descriptors/policies/bindings; app activation, Runtime/Discord, and
  external execution remain deferred.

## Stage 2B — Slice 5B-1 Provider Identity and Static Routing Configuration

- **Identity:** `providerId` identifies a configured executable instance, `adapterId` the adapter family, and
  `modelId` the exact opaque model binding. Ollama accepts an additive explicit instance id while its legacy
  constructor still yields `ollama-cli`.
- **Configuration:** the unwired composition-root factory contains exactly `ollama-cli:llama3.1:8b` and
  `ollama-cli:granite3.3:8b`, GENERAL_CHAT-only BALANCED → SEMANTIC_HIGH routing, existing GENERAL_CHAT validation,
  and the existing STANDARD deadline. Unratified operational dimensions are equal conservative values.
- **Provenance:** each descriptor carries an immutable canonical SHA-256 binding over the ratified Stage 2A
  campaign, checker, corpus, model, instance, and candidate-role facts under `stage2b-provider-provenance-v1`.
- **Boundary:** the factory performs construction validation without availability probes or execution and is not
  imported by `app.module.ts`. Readiness/model installation are **NOT VERIFIED**; 5B-2 execution and 5C activation/UAT
  remain separately approved work.

## Stage 2B — Slice 5B-2A-I Ollama Preflight Contracts and Runner

- **Boundary:** composition-root-private and unwired; no Core API, Capability, Aggregate, Runtime, app-module, or
  persistence change.
- **Contracts:** independent v1 identities for preflight result, executable identity, command policy, and inventory
  parser; exact required tags are `llama3.1:8b` and `granite3.3:8b`.
- **Containment:** absolute realpath/digest revalidation, exact `--version`/`list` argv, loopback-only endpoint,
  runner-owned exact isolated environment, hard promise-settlement deadline, bounded timeout/output/rows, zero
  retry, download-marker observation, and maximum two non-generation commands.
- **Execution:** actual executable/version/inventory are **NOT VERIFIED**; Ollama process, daemon/network access,
  inventory read, and Provider generation were **NOT EXECUTED** and remain 5B-2A-E/5B-2B gates.

## Stage 2B — Slice 5B-2A-E0 Honest Egress and Execution Composition

- **Egress:** `OS_DENIED_VERIFIED` requires an independently successful verifier and projects isolation true.
  `CONFIG_RESTRICTED_RISK_ACCEPTED` projects isolation false and does not technically deny external egress.
- **Current OS-denial mode:** the verified-mode contract exists, but no concrete OS-denial verifier is composed in
  the current entrypoint. Therefore `OS_DENIED_VERIFIED` currently blocks and is not executable, while
  `CONFIG_RESTRICTED_RISK_ACCEPTED` is the currently executable mode and neither technically denies nor proves
  denial of external egress.
- **Composition:** strict explicit inputs, concrete bounded filesystem/sandbox/spawn adapters, existing preflight,
  one bounded console projection, and exit codes 0/2/3/4/5 remain app-private and absent from `app.module.ts`.
- **Projection write failure:** each invocation attempts structured projection emission at most once. If the first
  write fails, no projection is successfully emitted, no fallback projection is attempted, and the entrypoint
  terminates through the unexpected-failure exit path (5), never the configuration-error path.
- **Boundary:** actual executable/version/inventory are **NOT VERIFIED**; Ollama process, daemon/network access,
  inventory read, Provider generation, persistence, and DB work were **NOT EXECUTED**.

## Stage 2B — Slice 5B-2B-I Primary-Only Provider Generation Harness

- **Composition:** exact `ollama-cli:llama3.1:8b` validation-only descriptor/binding through the real Registry →
  Policy → Decision → Planner → Gateway chain; immutable primary count 1, fallback/escalation/retry 0.
- **Environment:** caller-approved absolute executable and explicit `127.0.0.1` endpoint; runner-owned HOME/TMPDIR,
  bounded locale/color/cloud variables, no inherited PATH, parent HOME, proxy, credential, or loader variables.
- **Acquisition:** `DENIED_VERIFIED` requires an independent verifier. The risk-accepted mode projects technical
  prevention false and requires exact preflight presence, bounded case-insensitive pull-marker observation, and an
  unchanged postflight inventory fingerprint. Observation is not proof that no earlier bytes were transferred.
- **Evidence hardening:** invocation count is observed per runner request; a second request is recorded but never
  delegated. Download, timeout, and structured overflow facts survive later terminal failures. Both adapter and
  runner independently require exact IPv4 loopback, while invalid acquisition input projects null.
- **Output disclosure:** only the exact success token may be projected. Case/punctuation/prose mismatches expose
  bounded byte count and SHA-256 only; overflow exposes neither literal output nor a digest.
- **Boundary:** fake seams only. Actual generation, Ollama/process/network/inventory execution, external-egress
  denial, Runtime, Discord, persistence, and DB work were **NOT EXECUTED**.

## Stage 2B — Slice 5B-2B-E Re-entry Gate Close-Out

- **Gate:** `CLOSED_WITH_GENERATION_BLOCKED`. E1 implementation was accepted and pushed. The bounded preflight and
  inventory attempt passed with Ollama `0.32.5`; exact required tags `llama3.1:8b` and `granite3.3:8b` were present.
- **Execution facts:** only the authorized `--version` and `list` child commands ran (count `2`). Provider execution,
  generation-harness invocation, retry, fallback, escalation, model pull, and daemon lifecycle mutation were all `0`.
- **Generation block:** actual generation was intentionally not executed because independently verified,
  attempt-scoped external-egress denial was unavailable. Client-only restrictions do not constrain the already
  running Ollama daemon; configuration and observation are not technical denial.
- **Identity boundary:** the consumed executable identity approval is retained as attempt evidence only, never as a
  standing execution approval or production default.
- **Next boundary:** production activation remains default-off and unwired. External-egress enforcement is separate
  architecture work and must precede any successful live activation or Provider execution approval.

## Stage 2B — Slice 3C Deterministic Validation Harness

- **Boundary:** private test-only workspace package depending one-way on Core; it is absent from the production
  TypeScript reference graph and must never be imported by apps, Runtime, adapters, or production packages.
- **Fixtures:** strict JSON schema, explicit static registry, immutable fixture versions, and retained per-fixture
  plus corpus SHA-256 identities under an independent Harness digest version. There is no filesystem discovery or
  evidence lookup.
- **Replay:** real Core planner, validator, and Gateway contracts run against scripted in-memory Providers and an
  injected monotonic clock. Selection policy is not simulated or reevaluated. External Provider execution is zero.
- **Golden contract:** exact comparisons use the Harness-owned `CanonicalAuditProjection`, so unrelated future
  product-audit fields do not silently redefine the corpus. Every fixture is replayed twice from a fresh graph.
- **Coverage:** primary acceptance, operational fallback, semantic escalation, safety fail-closed, post-validation
  deadline failure, maximum-transition fallback, binding provenance, attempt bounds, and failure-matrix accounting.
  Slice 3C remediation explicitly partitions every failure code into active golden coverage, bounded active waiver,
  or producer-pending status and adds terminal `SEMANTIC_VALIDATION_UNRESOLVED` golden replay coverage.

## Stage 2B — Slice 1 Provider Selection Foundation

- **Boundary:** Core Application policy service, not a Capability, Aggregate, Provider adapter, or Runtime path.
- **Input/output:** `RoutingContext + ProviderRegistrySnapshot + RoutingPolicyConfiguration →
  ProviderSelectionDecision`.
- **Registry:** descriptor-only, validated, immutable, stable provider ordering; transient availability is part
  of a snapshot but excluded from the registry configuration digest.
- **Policy:** bounded TypeScript enums/read-only configuration; predicate match → eligibility/exclusion →
  configured lexicographic ranking → stable provider-id tie-break. No weighted runtime score.
- **Evidence:** Stage 2A raw scores and Golden Corpus remain offline; Runtime profiles use bounded reliability,
  support, capacity, locality, latency, cost, concurrency, and availability classes only.
- **Execution:** zero Provider calls and zero ConversationRuntime/CodeGenerationManager integration in Slice 1.

## Stage 2B — Slice 2 Single-Attempt Provider Gateway

- **Boundary:** Core Application orchestration only; selection remains separate from execution through
  `ProviderSelectionDecision → ProviderExecutionPlan → ProviderRoutingGateway → AiProvider.execute()`.
- **Execution plan:** immutable one-provider order and attempt budget `1`, with bounded capability,
  validation-profile, policy/registry/combined configuration identities, and a deep-frozen executable-binding
  identity. Deadline is `null`; fallback and escalation eligibility are `false`.
- **Binding:** descriptor-snapshot-bound immutable executable registry; unknown/disabled descriptors, duplicate
  bindings, executable-id mismatch, and adapter/model mismatch fail before invocation. Canonical SHA-256 identity
  includes Provider, adapter, model, binding version, and descriptor profile version only.
- **Gateway:** validates the plan/request, registry, current binding digest, and executable identity boundaries,
  resolves only the selected binding, and invokes it exactly once. Provenance mismatch returns a bounded failure
  with attempt count `0`. No availability probe, retry, fallback, escalation, alternate Provider, timeout policy,
  or response validation.
- **Audit:** bounded success/failure facts only; no prompt, response, transcript, raw error, reasoning, credential,
  or environment values. Known Provider failure kinds are preserved; unknown failures are `EXECUTION_FAILED`.
- **Integration:** fake-Provider tests only. Zero ConversationRuntime/CodeGenerationManager/app/adapter/storage/DB
  integration and zero actual external Provider execution.

## Stage 2B — Slice 3A Validation and Branch Planning

- **Validation:** immutable three-profile registry and independent pure synchronous validator; prompt/context are
  input-only, while result contracts contain bounded reason codes, digest, byte count, and contract versions.
- **Failure policy:** versioned configuration/operational/validation/safety matrix. Safety is fail-closed;
  `EMPTY_OUTPUT` alone is an approved output-related fallback candidate. Producer-pending ownership remains
  explicit: Provider spawn belongs to a future adapter producer; containment/model-download detection to Runtime;
  structural-validation failure to a future validation profile/validator; and unresolved semantic/structural
  validation plus deadline exhaustion to future Gateway orchestration. None is an implemented defense in Slice 3A.
- **Plan:** primary plus optional pre-fixed operational fallback and stronger semantic escalation targets, all bound
  to eligible-set and executable-binding provenance. Maximum attempts `2`, maximum additional hops `1`, mutually
  exclusive execution branch, no same-provider retry, and no runtime policy reevaluation.
- **Execution boundary:** declarative only. The Slice 2 Gateway still calls only the primary once; it does not call
  the validator, fallback, or escalation. No state machine, Runtime/app/adapter/port/storage integration, actual
  Provider execution, network, or database work was added.

## Stage 2B — Slice 3B Bounded Two-Attempt Gateway

- **State ownership:** the Gateway orchestrates a separate pure state reducer with an explicit seven-transition
  upper bound and READY-to-terminal zero-attempt deadline checkpoints.
- **Execution:** primary followed by at most one pre-fixed operational fallback or stronger semantic escalation;
  maximum attempts `2`, additional hops `1`, retry and same-provider retry prohibited.
- **Deadline:** versioned policy plus injected monotonic clock; execution and validation share one non-resetting
  deadline, and caller timeout is capped by remaining Provider budget.
- **Terminal/audit:** six explicit terminal statuses, first-class `humanReviewRequired`, bounded accepted output,
  and audit v2 with at most two attempts, seven transitions, deadline-policy identity, and no raw content.
- **Review remediation:** failure matrix v4 makes semantic-unresolved production active while structural-unresolved
  remains pending; restored provenance/error regression contracts and rechecks binding identity before attempt 2.
- **Boundary:** fake-Provider tests only. No ConversationRuntime, CodeGenerationManager, app, adapter, port,
  persistence, Discord, network, database, or actual external Provider execution integration.

## Implemented

- **Stage 2B Slice 5A offline Runtime integration (ADR-0064)** — added deterministic bounded Runtime-context
  mapping, one-probe immutable availability snapshots, the existing selection/plan/Gateway composition, existing
  lifecycle terminal mapping, bounded TaskRun `routingAudit`, safe terminal replies, and fail-closed no-legacy
  fallback behavior. Production Provider/app activation remains absent.
- **Stage 2B Slice 3A validation/planning contracts (ADR-0064)** — added validation profiles, deterministic Runtime
  response validation, bounded output projection, a versioned failure matrix, deadline class, target-purpose and
  branch contracts, candidate pre-fixation, and execution configuration/decision/plan identities while preserving
  the Gateway's one-invocation Slice 2 behavior.
- **Stage 2B Single-Attempt Provider Gateway (ADR-0064 Slice 2)** — added immutable execution planning,
  descriptor-bound executable bindings, canonical binding identity, selection/binding provenance validation, one
  selected Provider/one attempt gateway orchestration, discriminated outcomes, and bounded execution audit.
  Multi-provider fallback/escalation and all Runtime integration remain deferred.
- **Stage 2B Provider Selection Foundation (ADR-0064)** — added bounded routing signals and branded configuration
  identifiers; immutable, descriptor-only Provider Registry snapshots; static Capability/Operational Profiles;
  fail-fast typed policy validation; eligibility/exclusion; deterministic routing-class/reliability/latency/cost
  ranking; explicit selected/no-eligible/no-policy decisions; and canonical SHA-256 registry/policy/combined
  configuration identities. Concrete adapters/models appear only in future composition configuration, never Core
  policy logic. No AiProvider binding/invocation, fallback, escalation, retry, deadline, response validation,
  Runtime integration, TaskRun audit, storage, or DB change.
- **Stage 2A semantic checker v4 promotion** — the independently ratified Candidate v4 is now the
  default evaluator for new `provider:semantic` and Provider Benchmark invocations under the explicit
  contract `stage2a-semantic-checker-v4`. Historical Golden Corpus replay remains explicitly pinned to
  `stage2a-semantic-checker-v3`; the immutable v4-candidate transition identity is retained only for the
  approved 25/25 transition overlay. Frozen A1+A3 replay remains deterministic with 224 records / 896 check
  instances, Critical Recall 5/5 (100%), and zero confirmed FP/FN. The new default execution path binds the
  evaluator router and v4 implementation source/dist modules. Post-push v4 bindings at the synchronized main
  revision are ratified; prior v3, pre-push v4, and earlier-HEAD execution bindings remain historical.
- **Stage 2A Provider Benchmark framework (Plan v2.1 + pool decoupling)** — the offline planner and evidence
  aggregator consume strict repository-owned or absolute-path Pool Configuration instead of owning a fixed
  model count. The immutable legacy 10-model pool remains the default; a production 18GiB four-model pool is
  available explicitly. Deterministic configuration digests and full campaign fingerprints prevent evidence
  mixing; exact model/scenario coverage controls completion; objective Engine reporting is separated from
  advancement/Champion publication policy. Existing `provider:semantic` remains the sole bound Provider
  execution harness. Prompt, Evaluator, Scenario, Binding, Failure Taxonomy, Scorecard weights, Winner Rule,
  and A1/A2 schedules are unchanged; legacy evidence remains readable but unidentified/provisional.
- **GitHub App Authentication (Sprint 4b, ADR-0061)** — repository auth for RepositoryHosting REST (CAP-010) and
  local `git push`/`clone` (CAP-002) uses short-lived GitHub App installation tokens minted at execution from an
  adapter-local App private key. New `@quoky/github-app-auth` (App JWT via `node:crypto`, installation resolution,
  token mint + in-memory cache); the RepositoryHosting adapter takes an `auth` source (github-app | dev-only PAT);
  a composition-root `GitHubAppGitProvider` decorator feeds the token to git via a one-shot `GIT_ASKPASS` (token
  only in the child env; never in argv/URL/.git/config/logs/anchors/Discord). `LocalGitProvider` + the `GitProvider`
  port are unchanged; no new capability. New env `QUOKY_GITHUB_APP_*` / `QUOKY_GITHUB_OWNER` / `QUOKY_GITHUB_REPO` /
  `QUOKY_RUNTIME_ENV`; legacy `CHUNSIK_GITHUB_OWNER`/`_REPO` fallback; `CHUNSIK_GITHUB_TOKEN` dev-only PAT. Awaiting
  CA implementation review (PR).
- **Discord** — gateway adapter (`PlatformAdapter`): receive, typing indicator,
  chunked delivery of long replies (ADR-0016).
- **Claude CLI** — `ClaudeCliProvider` via `claude -p` (non-interactive, neutral cwd,
  timeout; ADR-0014), routed by Capability; product-grade failure handling (ADR-0015).
- **Session** — actor + session resolution; tasks/runs anchored to actor/session.
- **Short-term Memory** — SHORT_TERM conversation memory per session (cap 30, oldest
  pruned; current message excluded from recall; ADR-0017).
- **Project Registration** — "이 프로젝트 등록해줘: /path" → read-only scan → `Project`
  + PROJECT memory + bound `session.activeProjectId`; idempotent re-registration (ADR-0018).
- **UAT workspace binding** — command execution derives `cwd` from the `rootPath` of the Project referenced by the
  current channel/thread Session's `activeProjectId`; runtime bootstrap does not replace that durable binding with
  its process cwd. Before a UAT command scenario, send `이 프로젝트 등록해줘: <repository-root>` in the same
  channel/thread and require the registration response to report the intended repository. This idempotent
  re-registration clears a stale session binding by rebinding it to the Project for that path; do not edit/delete
  SQLite rows manually. A registered path that no longer exists fails closed as workspace unavailable.
- **Project Analysis** — gated, read-only analysis of allow-listed project metadata
  files → grounded structural answer, persisted as TOOL memory (ADR-0019).
- **CAP-001 Workspace (read-only)** — `resolve`/`readFile`/`listFiles`/`diff` on the
  workspace-local adapter; sandboxed `node:fs` (no git/child_process); diff = current
  file → proposed content (pre-approval seam). Not yet wired to a user-facing flow (ADR-0022).
- **CAP-002 Git (read-only)** — `isRepository`/`info`/`status` on the new `git-local`
  adapter via argument-array `spawn` (timeout, cwd=repo root, sanitized stderr); no writes,
  no worktree, no remote-URL exposure. Composes with Workspace via `rootPath` (ADR-0023).
- **CAP-003 Planning** — deterministic `ExecutionPlan` via `ExecutionPlanner` port +
  `DeterministicPlanner` + thin `PlanningManager` (reuses `RiskPolicy`). AI-free, no I/O,
  no persistence, not orchestrator-wired; the cross-capability execution contract (ADR-0024).
- **CAP-004 Approval** — `ApprovalRequest` aggregate + `ApprovalPolicy` + `ApprovalManager`
  + `SqliteApprovalRepository` (migration v2). Deterministic; references `ExecutionPlanRef`,
  never mutates `ExecutionPlan` (Aggregate Ownership Rule); first persisted V2 aggregate.
  Not UI/orchestrator-wired (ADR-0025).
- **CAP-005 Patch** — `PatchSet` aggregate (immutable) + `PatchManager.generate` (requires
  APPROVED approval) + `SqlitePatchRepository` (migration v3). **Generates, never applies**;
  `PatchOperation` carries unified diffs; references `ExecutionPlanRef`/`ApprovalRef` only.
  Workspace Write (CAP-006) will apply (ADR-0026).
- **CAP-006 Workspace Write** — `WorkspaceChange` (Execution History) aggregate +
  `WorkspaceWriteManager.apply` + `WorkspaceWriter`/`LocalWorkspaceWriter` (node:fs + jsdiff)
  + `SqliteWorkspaceChangeRepository` (migration v4). **Applies** an approved PatchSet
  (best-effort, atomic-per-file); approval Ref + plan-scope checked; no git; owns only
  `WorkspaceChange` (ADR-0027). First filesystem-mutating capability.
- **CAP-007 Command Execution** — `CommandExecution` (Execution History) aggregate +
  `CommandExecutionManager.run` + `CommandRunner`/`LocalCommandRunner` (new `command-local`;
  argv-array `spawnSync`, no shell, timeout, **minimal child env**, masked+capped output) +
  `SqliteCommandExecutionRepository` (migration v5). **Runs** a command behind four gates —
  **allow-list** (`pnpm`/`npm`/`node`), **dangerous-arg** (eval-style `node` flags refused),
  **risk** (CRITICAL/destructive refused), **approval** (HIGH → APPROVED + plan-scope; LOW/MEDIUM
  → none); persists `commandHash` identity. `runCommand` relocated off Workspace; core stays
  child_process-free; owns only `CommandExecution` (ADR-0028). Riskiest capability; the last
  Execution-Ledger aggregate.
- **CAP-008 AI Code Generation** — `CodeGeneration` (run) + `CodeProposal` (output) aggregates +
  `CodeGenerationManager.generate` (compose → `PromptRenderer` → `AiRequest` → `ProviderSelector`
  → `AiProvider.execute` → `parseCodeProposal`) + `CodexCliProvider` **suggest-only** + repos +
  migration v6. First AI Layer capability: **AI proposes only** (no decide/approve/apply/execute);
  reuses `AiProvider` (narrowed to `AiRequest`); core HTTP/child_process-free; owns `CodeGeneration`
  + `CodeProposal`, never downstream (ADR-0029). Not orchestrator-wired.
- **CAP-009 Ollama AI Code Generation Provider** — the **second `AiProvider` adapter** for CAP-008
  (not a new capability). `OllamaCliProvider.execute`/`isAvailable` implemented **suggest-only**
  (`ollama run <model>`, prompt on stdin, neutral cwd; single-shot text gen — no tools/exec/file
  access), advertises `CODE_IMPLEMENTATION` at priority 40 (below Claude 50, a local/offline
  fallback for code), wired into `AI_PROVIDERS` (`isAvailable()`-gated). Failure taxonomy reused
  (ADR-0015; no AUTH path). **No Core change**: no new aggregate/manager/port/repository/migration;
  `parseCodeProposal`/aggregates/`PromptRenderer`/`ProviderSelector` unchanged; Codex still
  NotImplemented. Demonstrates CAP-008 provider-independence (ADR-0030).
- **Phase 2 · Execution Orchestrator (Application Layer)** — `ExecutionOrchestrator`
  (`run`/`resume`) + `IntentResolver`: the first composition of CAP-001…009. **Capability
  Selection** → ordered stage subset (Planning → AI Code Gen → Workspace diff → Approval → Patch →
  Workspace Write → Command); **stateless** (no aggregate; `executionPlanRef` correlation root;
  transient `ExecutionOutcome`); **Ref-threaded**; **Approval halt + resume** (never `decide`);
  **Cancellation** (no rollback, Application-state only); **stop-on-failure, no retry**. Managers stay
  mutually unaware; provider selection stays with `ProviderSelector`. No Core change (ADR-0031).
- **Phase 2 · Conversation Runtime (Application Layer)** — `ConversationRuntime.handle(message) →
  TurnResult`: 춘식봇's conversation entry; **composes** the existing services into the full flow
  (chat · project-analysis · register · execution · approval-resume · failure/cancel). `ChunsikCore`
  is a **thin facade** delegating to it (one entry, no parallel paths). **Transient** `TurnResult`/
  `RuntimeTurnStatus` (no aggregate/table); **stateless approval halt→resume** with awaiting state
  derived from existing aggregates (`Session.activeTaskId → Task.planId → approvals.findByExecutionPlan
  → PENDING`); persists nothing; **no `Session` snapshot**. Decision interpreted only when pending
  (approve→decide+resume · deny→DENIED · cancel→CANCELLED · ambiguous→re-ask). Short-term memory only;
  `ResponseComposer.composeExecutionResult` added; orchestrator/intent-resolver now wired into the
  composition root. No Core change (ADR-0032).
- **Phase 2 · Live Test Execution (Product slice)** — the first execution reachable from a real user
  message. "테스트 돌려줘" / "typecheck 돌려줘" → deterministic `RUN_TESTS` intent (+`raw.kind`,
  reusing `IntentType.RUN_TESTS`/`Capability.TEST_EXECUTION`) → resolver's **fixed** command mapping
  (only `pnpm test`/`pnpm typecheck`) → runtime resolves the active-project workspace via existing
  `WorkspaceManager.open` → `ExecutionOrchestrator` → `CommandExecution` → natural result. A command
  that **ran** with exit≠0 is a **test-failure result** (not a system error); couldn't-run
  (timeout/refusal/open-failure) is a system-failure reply. `ResponseComposer` gains
  `composeTestResult`/`composeNeedsProject`/`composeWorkspaceUnavailable`/`composeCommandUnavailable`.
  Risk MEDIUM, no approval halt. Reuse only — no new capability/aggregate/repository/migration, no
  Core/Orchestrator contract change (ADR-0033).

## M2 closure

- **Durable Memory Write Activation: COMPLETE_AND_ACCEPTED.** The Product Owner ratified the explicit-command-only
  architecture at HEAD `c6d89e02ae80b0b202a6646263baabf83437c8d8`; implementation commit
  `2fa59b713177bab22631b40e932fcd04ceff0aa0` received independent review `PASS`. The required `MemoryWriter`
  activation recognizes only `기억해:` / `기억해줘:` / case-insensitive `remember:` after pending-flow interception
  and before ordinary classification. `GENERAL_CHAT` success, Assistant `SHORT_TERM` recording, and Provider/LLM
  extraction remain non-triggers; ADR-0073 and existing persistence ownership remain unchanged.
- **Slice 5: COMPLETE_AND_ACCEPTED.** ADR-0073 durable recall now has its bounded Core retrieval and lifecycle
  plumbing, and the production composition root wires `DefaultMemoryRetriever` to the existing SQLite-owned memory
  repository through `ContextBuilder`. Durable recall remains separate from the exact `SHORT_TERM` transcript and
  degrades to empty on repository/retrieval failure without displacing transcript or active-project background.
  Together with the accepted explicit-command write activation, both durable recall (Slice 5) and durable write are
  complete. Vector/schema/index work remains deferred and is not part of the ratified M2 scope.
- **Acceptance:** the completed M2 gap assessment and ContextBuilder deterministic ranking slice at commit `8fb8e4b`
  are `COMPLETE / REVIEW PASS` and accepted as the first M2 implementation slice. ContextBuilder token estimation at
  commit `9ef5e7c` is also `COMPLETE / REVIEW PASS`.
- **Overall M2: COMPLETE_AND_ACCEPTED / CLOSED.** Existing provider-neutral seams, multi-provider routing,
  ContextBuilder, PromptComposer, durable recall and explicit-command durable writes, and the Jira, Slack, and
  Confluence read-only connectors are complete for the currently ratified M2 scope. The connector adapters are
  configuration-gated in the composition root.
- **ContextBuilder: COMPLETE for the ratified M2 scope.** It has optional deterministic relevance selection with configurable
  character/token budgets, recency scoring, role weights, bounded keyword-overlap semantic relevance, configurable
  normalized recency/relevance blending, opt-in deterministic lowest-score-first tail compression with a configurable
  per-entry character floor, active-project-first background allocation, and preserved ADR-0063
  provenance/epistemic labels. Selected transcript entries are rendered in their original chronological order to
  preserve PromptComposer's continuity contract. The composition root now supplies explicit GENERAL_CHAT ranking,
  relevance, token-budget, and compression configuration to ConversationRuntime's ContextBuilder. Omitting all Core
  configuration preserves flat N=10 retrieval.
- **PromptComposer: COMPLETE for the ratified M2 scope.** Structured Task/context layering and ADR-0063 authority,
  provenance, and epistemic rendering are implemented; this slice requires no provider-specific prompt shaping.
- **Provider routing: COMPLETE for the ratified M2 scope.** Capability/policy/availability-driven routing and stable
  provider selection exist without Core branching on provider ids.
- **Ollama adapter: COMPLETE; Codex adapter: MISSING.** Ollama implements suggest-only execution and availability;
  Codex remains an explicitly unavailable `NotImplementedError` stub.
- **Jira, Slack, and Confluence connector adapters: COMPLETE (wired).**
  `@chunsik/connector-jira`, `@chunsik/connector-slack`, and `@chunsik/connector-confluence` implement the ADR-0072
  read-only `ConnectorProvider` boundary and are registered by the composition root when their required environment
  configuration is complete. Missing or partial configuration leaves the corresponding connector unregistered.
- **Read-only connector seam: COMPLETE for the ratified M2 scope.** `ConnectorProvider`, `ConnectorManager`, concrete adapter
  packages, and configuration-gated composition-root injection are wired. The registered connector list contains the
  configured Jira, Slack, and Confluence adapters.

## Deferred

- **Codex** — `CodexCliProvider` not implemented (stub; no deterministic suggest-only mode).
- **Workflow** — multi-step planning/execution beyond a single Task is not built.
- **Agent Runtime** — no autonomous tool-using / coding agent.
- **Vector Search** — `VectorProvider` is a local stub; no embeddings/retrieval/semantic search.

## What exists (detail)

- pnpm monorepo; **framework-agnostic core** (domain, ports, application services).
- NestJS composition root wiring ports → providers via injection tokens.
- **Pipeline:** Discord inbound → `ChunsikCore` → resolve Actor → open Session →
  `IntentClassifier` → (REGISTER_PROJECT | PROJECT_ANALYSIS | CHAT) → Task →
  `Planner` → `ContextBuilder` → `PromptComposer` → `CapabilityRouter` → AiProvider →
  Artifact → reply.
- **SQLite (better-sqlite3):** `actors`, `sessions`, `tasks`, `taskRuns`, `artifacts`,
  `memories`, `projects` repositories implemented. Schema applied by a versioned,
  forward-only migration runner keyed on `PRAGMA user_version` (ADR-0020); WAL mode.
- **Project analysis (ADR-0019):** `ProjectAnalyzer.prepare` guards an active project,
  then `WorkspaceProvider.readProjectFiles` reads an allow-list (package.json,
  pnpm-workspace.yaml, README.md, ARCHITECTURE.md, DECISIONS.md, tsconfig*.json),
  8 KB/file cap, 2-level tree, excludes node_modules/dist/build/.git/coverage, and
  unconditionally skips `.env*`/secret-named files. `PromptComposer` renders it as a
  read-only section; the result is stored as a TOOL memory (`kind: 'analysis'`).
- **Observability:** `Logger` seam + `ConsoleLogger` (`[discord]`/`[chunsik]`).

## What is NOT implemented yet

- **AI execution:** only `CodexCliProvider` `execute`/`isAvailable` remain stubbed (no
  deterministic suggest-only mode → treated as unavailable). Claude + Ollama are implemented.
- **Storage:** all repositories implemented (`approvals` landed in CAP-004 / migration v2).
- **Platform:** `DiscordPlatformAdapter.requestApproval` (no approval UI yet); resume
  after approval is deferred (no current capability reaches the HIGH/CRITICAL path).
- **Deferred:** repository-wide indexing, vector/semantic search, Workflow engine,
  agent runtime, AI HTTP API, PolicyProvider,
  PROJECT/TOOL memory retention.

## Validation

- Current release validation on Node `v22.22.1`: `pnpm typecheck` — PASS (exit 0); `pnpm test` — PASS,
  `119` files / `2653` tests.
- Boundary enforced — Core cannot resolve adapter packages.
- **Live (Sprint 1g):** real `node dist/main.js` Discord round-trip — register a
  project, then a structure question routed to PROJECT_ANALYSIS, read real files,
  returned a grounded answer (7 ports, package→port map, tech stack), persisted as
  TOOL memory; secrets never read. Requires `DISCORD_BOT_TOKEN` + Message Content Intent.

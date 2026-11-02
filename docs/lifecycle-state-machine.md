# Product Lifecycle — State Machine Map (ApplyPreviewAnchorStatus)

> Consolidated, single-page map of the end-to-end development lifecycle the bot drives across turns
> (Sprint 3k / G1, docs-only). Authority: `ARCHITECTURE.md`, `DECISIONS.md` (ADR-0040 … ADR-0060), and the
> `ApplyPreviewAnchorStatus` union + handlers in `packages/core/src/application/conversation-runtime.ts` and `packages/core/src/application/conversation-runtime/`.
> This document is descriptive: the code is the source of truth. It adds **no** state and changes **no** behavior.

## What this is

The bot is **stateless per turn**. Cross-turn progress is carried by one **apply-preview anchor** whose `status`
(`ApplyPreviewAnchorStatus`) moves forward through the lifecycle below. The anchor **never regresses** on success;
**deny/cancel** on an approval clears only that approval's fields and returns to the prior durable state (it does not
introduce a "rejected" state). Each mutation is gated by an explicit user command **and** (for the risky ones) an
explicit `ApprovalRequest`; the runtime re-validates structured fields every turn and calls capability **managers**
only — never a provider/adapter, never a shell.

## The one true rule (no-overclaim)

**No state implies `deployed`, `released`, `tagged`, `production-ready`, or `CI permanently verified`** — and none
will, unless a future ADR introduces such a state. Every terminal/mutation reply states, in Korean, what it did and
explicitly what it did **not** do (e.g. "배포/릴리즈/태그도 하지 않았어요"). Read-only observations are **point-in-time**
only. Any external-mutation outcome that cannot be confirmed is reported **Unverified**, never "did not happen".

## Category legend

| Category | Meaning |
|---|---|
| **approval-pending** | a CRITICAL/HIGH `ApprovalRequest` is pending; intercepts EVERY turn (decide-only); no mutation, none even on approve |
| **approval-recorded** | permission recorded only; the mutation runs in a later, explicit execution turn |
| **local-mutation** | changed the local workspace/repo (recoverable) |
| **remote-mutation** | changed an external system (hosting provider / remote) |
| **read-only** | point-in-time observation; never re-anchors, never mutates |
| **terminal** | end of a chain for this run (no forward mutation from here except the next explicitly-gated step) |

## Failure-semantics vocabulary (applies to every mutation)

```text
Before the mutating call (known preflight failure)  → Blocked    → safe to say "did not happen"
At/after the mutating call (unknown/ambiguous/    )  → Unverified → NEVER say "did not happen"; ask the user to check
Idempotent no-op (already in the desired state)      → success with an "already …" wording; no new mutation
Not configured (missing identity/token/manager)      → unavailable; no state change
```

Typed error pairs: `RepositoryHosting{Blocked,Unverified}Error` (PR create/merge), `RemoteBranchCleanup{Blocked,
Unverified}Error` (remote branch delete), `GitMainSync{Blocked,Unverified}Error` (local main sync),
`BranchCleanup{Blocked,Unverified}Error` (local branch delete). Push (ADR-0048) expresses the same split via the
`composePushExecutionUnavailable` (pre-push = not pushed) vs `composePushExecutionFailed`/`composePushResultUnverified`
(at/after = never "unchanged") composer idiom.

---

## The chain (durable states, in order)

```text
(diff preview)
ELIGIBLE
  → AWAITING_APPROVAL ──approve──▶ APPROVED
                       └─deny/cancel─▶ (anchor cleared)
APPROVED ──▶ PATCH_READY ──▶ WORKSPACE_APPLIED
  (validation = point-in-time; NO durable "validated" state)
WORKSPACE_APPLIED
  → COMMIT_APPROVAL_PENDING ─approve─▶ COMMIT_APPROVED ──execute──▶ GIT_COMMITTED   [local]
  → PUSH_APPROVAL_PENDING   ─approve─▶ PUSH_APPROVED   ──execute──▶ GIT_PUSHED      [remote]
  → PR_APPROVAL_PENDING     ─approve─▶ PR_APPROVED     ──execute──▶ PR_CREATED      [remote]
  → MERGE_APPROVAL_PENDING  ─approve─▶ MERGE_APPROVED  ──execute──▶ PR_MERGED       [remote]
  → MAIN_SYNCED   (local main fast-forward)                                          [local]
  → BRANCH_CLEANED (local merged-branch delete)                                      [local, terminal-local]
  → REMOTE_BRANCH_CLEANUP_PENDING ─approve─▶ REMOTE_BRANCH_CLEANUP_APPROVED ──execute──▶ REMOTE_BRANCH_CLEANED [remote, terminal]
```

`PR_CREATED` / `PR_MERGED` / `MAIN_SYNCED` / `BRANCH_CLEANED` / `REMOTE_BRANCH_CLEANUP_APPROVED` also accept a
**read-only PR status preview** phrase, which keeps the current state (never re-anchors).

---

## State reference

Legend for "Evidence": the anchor fields REQUIRED to have been set by the time the state is reached.

### ELIGIBLE — *read-only/eligible* (Sprint 2s, ADR-0040)
- **Means:** a diff preview was shown; the user may explicitly ask to apply it.
- **Evidence:** the proposed changes / preview context.
- **Next intents:** an explicit apply phrase → `AWAITING_APPROVAL`. (A bare "좋아/오케이/확인" never authorizes apply.)
- **Not:** applied / committed / anything mutated.

### AWAITING_APPROVAL — *approval-pending* (Sprint 2s, ADR-0040)
- **Means:** an apply `ApprovalRequest` is pending; intercepts every turn.
- **Evidence:** `approvalId`, `executionPlanRef`.
- **Next:** approve → `APPROVED`; deny/cancel → anchor cleared.
- **Not:** applied — nothing mutated even here.

### APPROVED — *approval-recorded* (Sprint 2s/2t)
- **Means:** apply is approved; patch generation may follow.
- **Evidence:** `approvalId` (APPROVED), `executionPlanRef`.
- **Next:** patch generation → `PATCH_READY`.
- **Not:** applied / committed.

### PATCH_READY — *local (representation only)* (Sprint 2t, ADR-0041)
- **Means:** a PatchSet **representation** was generated + stored (`patchRef`).
- **Evidence:** `patchRef`.
- **Next:** apply to workspace → `WORKSPACE_APPLIED`.
- **Not:** applied — no workspace file modified, no command/git ran.

### WORKSPACE_APPLIED — *local-mutation* (Sprint 2u, ADR-0042)
- **Means:** WorkspaceWrite mutated the workspace file(s) (`workspaceChangeRef`); the working tree now holds the change.
- **Evidence:** `workspaceChangeRef`, `workspaceRef`.
- **Next:** post-apply validation (point-in-time `pnpm test`/`typecheck`; NO durable "validated" state — ADR-0043) →
  read-only git status preview (ADR-0044) → `COMMIT_APPROVAL_PENDING`.
- **Not:** committed / pushed / deployed / tests-verified-durably / clean tree.

### COMMIT_APPROVAL_PENDING — *approval-pending, HIGH* (Sprint 2x, ADR-0045)
- **Means:** a HIGH-risk git-commit approval is pending; intercepts every turn.
- **Evidence:** `commitApprovalId`, `executionPlanRef`, candidate files + message.
- **Next:** approve → `COMMIT_APPROVED`; deny/cancel → back to `WORKSPACE_APPLIED` (clears only commit-approval fields).
- **Not:** committed — no `git add`/`commit` ran.

### COMMIT_APPROVED — *approval-recorded* (Sprint 2x, ADR-0045)
- **Means:** commit permission recorded.
- **Evidence:** `commitApprovalId` (APPROVED), approved files + message.
- **Next:** explicit execute → `GIT_COMMITTED`.
- **Not:** committed yet.

### GIT_COMMITTED — *local-mutation* (Sprint 2y, ADR-0046)
- **Means:** the approved exact files were committed locally (`commitHash`, `committedFiles`). First "committed" state.
- **Evidence:** `commitHash`, `committedFiles`.
- **Next:** `PUSH_APPROVAL_PENDING`.
- **Not:** pushed / deployed — `git push` did not run. Failure model: local; pre-commit validation throws are "not
  committed".

### PUSH_APPROVAL_PENDING — *approval-pending, CRITICAL* (Sprint 2z, ADR-0047)
- **Means:** a CRITICAL git-push approval is pending; intercepts every turn.
- **Evidence:** `pushApprovalId`, `executionPlanRef`, push target snapshot (remote/branch/upstream/commit).
- **Next:** approve → `PUSH_APPROVED`; deny/cancel → back to `GIT_COMMITTED` (clears only push-approval fields).
- **Not:** pushed — none even on approve.

### PUSH_APPROVED — *approval-recorded* (Sprint 2z, ADR-0047)
- **Means:** push permission recorded (point-in-time target snapshot).
- **Evidence:** `pushApprovalId` (APPROVED), `pushRemote`/`pushBranch`/`pushUpstreamRef`/`pushCommitHash`.
- **Next:** explicit execute → live preflight → `GIT_PUSHED`.
- **Not:** pushed.

### GIT_PUSHED — *remote-mutation* (Sprint 3a, ADR-0048)
- **Means:** the approved commit was pushed to the approved upstream (`pushedRemote`/`pushedBranch`/
  `pushedUpstreamRef`/`pushedCommitHash`). First "pushed to a remote" state.
- **Evidence:** `pushed{Remote,Branch,UpstreamRef,CommitHash}`.
- **Next:** `PR_APPROVAL_PENDING`.
- **Not:** PR-created / deployed. **Failure (remote):** pre-push (context/HEAD-drift/dirty/upstream-drift) →
  "not pushed"; the single push call throw → "could not complete, check the remote" (never "unchanged");
  result-integrity mismatch → Unverified. Keeps `PUSH_APPROVED` on failure.

### PR_APPROVAL_PENDING — *approval-pending, CRITICAL* (Sprint 3b, ADR-0049)
- **Means:** a CRITICAL PR-creation approval is pending; intercepts every turn.
- **Evidence:** `prApprovalId`, `executionPlanRef`.
- **Next:** approve → `PR_APPROVED`; deny/cancel → back to `GIT_PUSHED`.
- **Not:** PR created — none even on approve.

### PR_APPROVED — *approval-recorded* (Sprint 3b/3d-D, ADR-0049/0054)
- **Means:** PR-creation permission recorded; carries `repositoryIdentity` (the approved target).
- **Evidence:** `prApprovalId` (APPROVED), `repositoryIdentity`.
- **Next:** explicit create/open phrase → EXECUTES creation → `PR_CREATED`.
- **Not:** PR-created / merged / deployed / released.

### PR_CREATED — *remote-mutation* (Sprint 3d-D, ADR-0054)
- **Means:** a PR was created — or an existing open PR safely connected — this run. First "a PR exists" state.
- **Evidence:** `pullRequestRef`, `pullRequestNumber`, `pullRequestUrl`, `pullRequestHeadBranch`,
  `pullRequestBaseBranch`, `pullRequestCommitHash`, `pullRequestReused`, `executionPlanRef`.
- **Next:** read-only status preview (keeps state); merge approval → `MERGE_APPROVAL_PENDING`.
- **Not:** merged / deployed / released / reviewed / CI-passed / re-verified after creation. **Failure (remote):**
  Blocked (no PR) vs Unverified (PR may exist).

### MERGE_APPROVAL_PENDING — *approval-pending, CRITICAL* (Sprint 3f, ADR-0056)
- **Means:** a CRITICAL merge approval is pending; intercepts every turn.
- **Evidence:** `mergeApprovalId`, `executionPlanRef`, full `PR_CREATED` context.
- **Next:** approve → `MERGE_APPROVED`; deny/cancel → back to `PR_CREATED` (clears only merge-approval fields). A
  merge/deploy/status phrase while pending → ambiguous re-prompt (never decides/merges).
- **Not:** merged — none even on approve.

### MERGE_APPROVED — *approval-recorded* (Sprint 3f, ADR-0056)
- **Means:** merge permission recorded for this PR context only.
- **Evidence:** `mergeApprovalId` (APPROVED), `mergeApprovedAt`, `mergeApprovalDecisionBy`.
- **Next:** explicit merge-execution command → live preflight → `PR_MERGED` (read-only status keeps state).
- **Not:** merged / deployed / released / safe-to-merge / mergeable-verified.

### PR_MERGED — *remote-mutation* (Sprint 3g, ADR-0057)
- **Means:** the approved PR was merged this run — or the exact approved head was observed already merged in the live
  preflight (`alreadyMerged`).
- **Evidence:** `mergedAt`, `mergeExecutedBy`, `mergedHeadSha`, `mergeCommitHash?`.
- **Next:** explicit local main sync command → `MAIN_SYNCED`; read-only status keeps state.
- **Not:** deployed / released / production-ready / branch-deleted / CI-permanently-verified / local-main-synced.
  **Failure (remote):** Blocked ("not merged") vs Unverified ("could not verify"). Idempotent already-merged is a
  no-mutation success.

### MAIN_SYNCED — *local-mutation* (Sprint 3h, ADR-0058)
- **Means:** the LOCAL `main` ref was fast-forwarded to the expected post-merge remote `main` commit this run
  (fast-forward only; never force/reset).
- **Evidence:** `syncedMainCommit`, `mainSyncedAt`, `mainSyncBranch` (='main'), `syncMode`
  ('checked-out-main'|'ref-only'), `workingTreeUpdated`, `previousMainCommit`.
- **Next:** explicit LOCAL branch cleanup command → `BRANCH_CLEANED`; read-only status keeps state.
- **Not:** deployed / released / branch-deleted / remote-branch-cleaned. **Failure (local):** Blocked ("not synced")
  vs Unverified; idempotent already-up-to-date.

### BRANCH_CLEANED — *local-mutation, terminal-local* (Sprint 3i, ADR-0059)
- **Means:** the completed feature branch's LOCAL ref was deleted — or was already absent — this run (safe CAS delete;
  never `-D`/force, never `main`).
- **Evidence:** `branchCleanupMode` ('local'), `cleanedBranch` (== PR head branch), `branchCleanedAt`,
  `branchCleanedBy`, `cleanedLocalBranch`, `cleanedRemoteBranch` (=false).
- **Next:** explicit REMOTE branch cleanup phrase → `REMOTE_BRANCH_CLEANUP_PENDING` (CRITICAL approval); a LOCAL
  cleanup phrase → already-cleaned; read-only status keeps state.
- **Not:** deployed / released / tagged / remote-branch-deleted / all-branches-cleaned / repository-fully-cleaned.
  **Failure (local):** Blocked ("not deleted") vs Unverified; idempotent already-absent.

### REMOTE_BRANCH_CLEANUP_PENDING — *approval-pending, CRITICAL* (Sprint 3j-A, ADR-0060)
- **Means:** a CRITICAL remote-branch-cleanup approval is pending; intercepts every turn.
- **Evidence:** `remoteBranchCleanupApprovalId`, `remoteBranchCleanupApprovalRequestedAt`, `executionPlanRef`, full
  `BRANCH_CLEANED` chain.
- **Next:** approve → `REMOTE_BRANCH_CLEANUP_APPROVED`; deny/cancel → back to `BRANCH_CLEANED` (clears only the four
  `remoteBranchCleanupApproval*` fields). A remote/execute/status/deploy phrase while pending → ambiguous re-prompt
  (never decides/deletes/auto-approves).
- **Not:** deleted — none even on approve.

### REMOTE_BRANCH_CLEANUP_APPROVED — *approval-recorded* (Sprint 3j-A, ADR-0060)
- **Means:** permission recorded to delete the anchored PR's REMOTE head branch, for this PR context only.
- **Evidence:** `remoteBranchCleanupApprovalId` (APPROVED), `remoteBranchCleanupApprovalRequestedAt`,
  `remoteBranchCleanupApprovedAt`, `remoteBranchCleanupApprovalDecisionBy`.
- **Next:** explicit execution command → live preflight + read-immediately-before-delete SHA verify → single GitHub
  refs DELETE → `REMOTE_BRANCH_CLEANED`. A re-request (no execute verb) → already-approved; read-only status keeps
  state.
- **Not:** deleted / deployed / released / tagged / safe-to-delete-verified. Does NOT assert the remote branch still
  exists / its SHA is current / the PR is still merged / deletion is safe now — those are verified live at execution.

### REMOTE_BRANCH_CLEANED — *remote-mutation, terminal* (Sprint 3j-B, ADR-0060)
- **Means:** the completed PR's REMOTE head branch was deleted — or was already absent — this run (exactly one branch,
  RepositoryHosting-owned; GitHub refs DELETE with read-immediately-before-delete SHA verification).
- **Evidence:** `remoteBranchCleanupMode` ('remote'), `cleanedRemoteBranchName` (== PR head branch),
  `remoteBranchCleanedAt`, `remoteBranchCleanedBy`, `remoteBranchCleanupProvider` ('github'),
  `remoteBranchDeletedCommit?`, `cleanedRemoteBranch` (=true when deleted this run; false when already absent).
- **Next:** a remote cleanup / execute phrase → already-cleaned (no second DELETE); read-only status keeps state.
- **Not:** deployed / released / tagged / production-ready / local-branch-deleted-this-run / all-branches-cleaned /
  repository-fully-cleaned / default-branch-deleted / arbitrary-branch-deleted / bulk-cleanup. **Failure (remote):**
  Blocked ("not deleted") vs Unverified ("could not verify"); idempotent already-absent (`cleanedRemoteBranch=false`,
  no DELETE); GitHub has **no atomic SHA-conditional delete** — mitigation = GET-ref → verify SHA === expected →
  single DELETE → ambiguity after DELETE = Unverified.

---

## Cross-cutting invariants (true for every state)

- **Approval ids are distinct and structured-field-checked.** `approvalId` / `commitApprovalId` / `pushApprovalId` /
  `prApprovalId` / `mergeApprovalId` / `remoteBranchCleanupApprovalId` never overlap; every decision/execution turn
  re-reads the referenced `ApprovalRequest` and checks `status` + `executionPlanRef.id` (structured only, **never**
  parses `reason`).
- **Target is always the anchored ref**, never a freshly user-supplied id (PR head branch, PR ref, upstream). A
  user-named branch is never deletable/pushable.
- **The runtime calls managers only** — never a provider/adapter directly — and receives no token. Git runs
  argv-array (no shell); RepositoryHosting uses bounded `fetch` (no gh/octokit/curl/shell). `CommandExecution` is the
  sole command runner (allow-listed to `pnpm test`/`pnpm typecheck`).
- **Secrets never enter** anchors, approval reasons, logs, or responses (the GitHub token is adapter-local only).
- **Deny/cancel never regresses evidence** — it clears only its own approval fields and preserves the full causal
  chain.

## Related ADRs

ADR-0040 (apply preview) · 0041 (patch) · 0042 (workspace write) · 0043 (post-apply validation) · 0044 (git status
preview) · 0045/0046 (commit approval/execution) · 0047/0048 (push approval/execution) · 0049/0054 (PR creation
approval/execution) · 0055 (PR status preview) · 0056/0057 (merge approval/execution) · 0058 (local main sync) ·
0059 (local branch cleanup) · 0060 (remote branch cleanup approval + execution). Capability docs:
`docs/capabilities/*` (incl. `repository-hosting.md`).

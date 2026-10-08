import type { GitBranchCleanupResult, GitBranchResult, GitCommitResult, GitDiff, GitMainSyncResult, GitPushResult, GitStatus, RepositoryIdentity, RepositoryInfo } from '../domain';

/**
 * PORT: read-only git **repository** inspection (CAP-002, ADR-0023).
 *
 * Git ≠ Workspace. This port owns the *repository* abstraction; `WorkspaceProvider`
 * owns the *filesystem* abstraction. Capabilities compose **through `rootPath`** —
 * this port takes a plain path and does NOT depend on `WorkspaceRef` or any
 * Workspace type.
 *
 * Sprint 2b is **read-only**: no commit/checkout/branch/merge/reset/stash/push/
 * pull/fetch/tag/worktree. Implementations run git **adapter-side only**, via
 * argument-array spawn (never a shell string), with a timeout and the repository
 * root as cwd. Core never touches `child_process`. Write operations are a future
 * capability gated by Approval.
 */
export interface GitProvider {
  readonly kind: string;

  /** True when `rootPath` is inside a git work tree. */
  isRepository(rootPath: string): Promise<boolean>;

  /** Minimal repository metadata (branch / HEAD / detached). No remote URLs. */
  info(rootPath: string): Promise<RepositoryInfo>;

  /** Working-tree status (clean/branch + staged/unstaged/untracked summaries). */
  status(rootPath: string): Promise<GitStatus>;

  /**
   * Read-only unified diff of TRACKED staged/unstaged changes vs HEAD (ADR-0044). Still read-only — runs
   * only `git diff` (never a mutating subcommand), argument-array spawn (never a shell string), with the
   * same timeout discipline. Untracked file contents are excluded (surfaced via {@link status}); binary
   * files appear as a marker only. Size-bounded by the implementation.
   */
  diff(rootPath: string): Promise<GitDiff>;

  /**
   * The FIRST mutating method on this port (CAP-002, ADR-0046; new-file support ADR-0099 D3) — commits EXACTLY
   * `files` with `message` and returns the new commit's hash. READ-ONLY-elsewhere discipline is preserved
   * everywhere else. Runs a single `git commit --only -- <files>` of the exact pathspecs, argument-array only
   * (never a shell string), timeout, masked stderr. The message is a single argv element.
   *
   * `options.newFiles` (ADR-0099) lists the UNTRACKED paths among `files` that the owner approved as new files
   * (`newFiles ⊆ files`). The adapter first runs `git add -- <newFiles>` (exact pathspecs, never `-A`/`.`), then
   * the unchanged commit, and on commit failure compensates with `git rm --cached --quiet -- <newFiles>` so the
   * new files are untracked again. Without `newFiles` the call behaves exactly as before (no `git add`;
   * untracked files are blocked upstream). Commits no other path; **never pushes** (no push/reset/checkout/
   * stash/branch/tag/merge/rebase). Validates its path args defensively (absolute/traversal/empty rejected
   * before any git call). Approval gating is done by `GitManager.commitFiles`; this port takes no ApprovalRef.
   */
  commitFiles(rootPath: string, files: string[], message: string, options?: { newFiles?: string[] }): Promise<GitCommitResult>;

  /**
   * Owner LOCAL branch creation (CAP-002, ADR-0099 D4): `git switch -c <branch>` from the current HEAD, carrying
   * the working tree (a dirty tree is allowed). Compare-and-swap guarded: HEAD must equal `expectedHeadSha`, HEAD
   * must be attached, no merge/rebase/cherry-pick may be in progress, and the branch must not already exist. The
   * result is verified (`info().branch === branch`). NEVER force, NEVER a remote ref, NEVER a push. The name and
   * SHA are validated defensively before any git call. Takes no ApprovalRef (explicit owner command, reversible).
   */
  createBranch(rootPath: string, branch: string, expectedHeadSha: string): Promise<GitBranchResult>;

  /**
   * Owner LOCAL branch switch (CAP-002, ADR-0099 D4): `git switch --no-guess <branch>` to an EXISTING local
   * branch only (never creates a remote-tracking branch), allowed only with a completely clean tree (no staged,
   * unstaged or untracked path). The result is verified (`info().branch === branch`). NEVER force/discard.
   * Takes no ApprovalRef.
   */
  switchBranch(rootPath: string, branch: string): Promise<GitBranchResult>;

  /**
   * The SECOND mutating method (CAP-002, ADR-0048) — the first REMOTE mutation. Pushes EXACTLY the current
   * HEAD to `<remote> HEAD:<branch>` and returns the provider-reported target (NOT an independent remote
   * verification). A single `git --no-pager push <remote> HEAD:refs/heads/<branch>` (ADR-0099: a fully qualified destination so a new remote branch is created without ambiguity), argument-array only (never a shell
   * string), timeout, masked stderr. NEVER `--force`/`-f`/`--tags`/`--all`/`-u`/`--set-upstream`/bare `git
   * push`, no arbitrary refspec, no user-provided remote/branch. Validates remote/branch with conservative
   * git ref rules BEFORE any git call (unsafe target never reaches argv). Approval gating is done by
   * `GitManager.pushApprovedCommit`; this port takes no ApprovalRef.
   *
   * `approvedRepository` (ADR-0109, optional): the repository identity the push approval bound. A provider that
   * resolves remotes to repositories must push to exactly that repository and refuse (Blocked, `TARGET_CHANGED`)
   * when the workspace now resolves elsewhere; a provider without that notion ignores it.
   */
  pushApprovedCommit(
    rootPath: string,
    remote: string,
    branch: string,
    commitHash: string,
    approvedRepository?: RepositoryIdentity,
  ): Promise<GitPushResult>;

  /**
   * READ-ONLY (CAP-002, ADR-0058 — Sprint 3h): observe the remote branch tip WITHOUT updating any local ref or the
   * working tree (`git ls-remote`-style). Single bounded argv call, timeout, masked stderr, NO remote URL exposed.
   * Throws on failure (the Manager maps it to a pre-mutation *Blocked*). Validates remote/branch defensively first.
   */
  getRemoteRefCommit(
    rootPath: string,
    remote: string,
    branch: string,
    approvedRepository?: RepositoryIdentity,
  ): Promise<{ commitHash: string }>;

  /**
   * READ-ONLY (CAP-002, ADR-0058 — Sprint 3h): the LOCAL branch tip (`git rev-parse refs/heads/<branch>`), or `null`
   * when the branch does not exist. Used for the local-main-exists check + the compare-and-swap base
   * (`previousMainCommit`). No mutation. Argument-array spawn only.
   */
  getLocalRefCommit(rootPath: string, branch: string): Promise<{ commitHash: string } | null>;

  /**
   * The THIRD mutating method (CAP-002, ADR-0058 — Sprint 3h) — a **fast-forward-only** local `main` sync, mode-split
   * by the current checkout and compare-and-swap guarded against `expectedPreviousCommit`. Fetches the remote branch,
   * then either fast-forwards the checked-out `main` (working tree/index moves) or, when another branch is checked
   * out, fast-forwards ONLY `refs/heads/main` (no checkout switch, no working-tree change). NEVER `--force`/`-f`,
   * NEVER `reset --hard`, NEVER a push, NEVER a branch deletion, NEVER a checkout switch. Detached HEAD, a non-
   * fast-forward, a fetched-tip mismatch, or a moved local main BEFORE the ref update are **pre-ref-update** failures
   * and throw `GitMainSyncBlockedError` ("not synced"); any failure AT/AFTER the ref-update attempt throws
   * `GitMainSyncUnverifiedError` ("never say not synced"). Approval gating (if any) is the Manager's job; this port
   * takes no ApprovalRef (mirrors commitFiles/pushApprovedCommit).
   */
  syncMainFastForward(
    rootPath: string,
    remote: string,
    branch: string,
    expectedRemoteCommit: string,
    expectedPreviousCommit: string,
    approvedRepository?: RepositoryIdentity,
  ): Promise<GitMainSyncResult>;

  /** READ-ONLY (CAP-002, ADR-0059 — Sprint 3i): is `ancestor` an ancestor of `descendant`? (`git merge-base
   *  --is-ancestor`). Used by the Manager for the "fully merged into main" check. No mutation. Argv-only. */
  isAncestor(rootPath: string, ancestor: string, descendant: string): Promise<boolean>;

  /**
   * The FOURTH mutating method (CAP-002, ADR-0059 — Sprint 3i) — a compare-and-swap delete of a fully-merged LOCAL
   * branch via `git update-ref -d refs/heads/<branch> <expectedBranchCommit>` (deterministic; NOT `git branch -d`,
   * so it does not depend on the current `HEAD`/checkout — CA change 3). NEVER `-D`/`--force`, NEVER 'main', NEVER a
   * remote ref, NEVER a wildcard/pattern, NEVER a checkout switch. Validates the branch name + SHA defensively
   * first. PHASE-AWARE: a pre-ref-delete failure (branch moved/absent vs `expectedBranchCommit`) throws
   * `BranchCleanupBlockedError`; a failure AT/AFTER the ref-delete attempt throws `BranchCleanupUnverifiedError`.
   * Takes no ApprovalRef (mirrors commitFiles/pushApprovedCommit/syncMainFastForward).
   */
  deleteMergedLocalBranch(rootPath: string, branch: string, expectedBranchCommit: string): Promise<GitBranchCleanupResult>;
}

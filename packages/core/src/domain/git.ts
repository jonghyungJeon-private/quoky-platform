/**
 * Git domain types (CAP-002, ADR-0023). Owned by the **Git** capability, not
 * Workspace — Workspace ≠ Git. Read-only in Sprint 2b.
 */

/** Git working-tree state, surfaced generically so callers can gate on cleanliness. */
export interface GitStatus {
  clean: boolean;
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  // `ahead`/`behind` are NOW populated (Sprint 2z, ADR-0047) from the `git status -b` branch header —
  // relative to the LOCAL remote-tracking ref (no network fetch). Both are `undefined` when there is no
  // upstream (distinct from `0` = in sync). The other reserved fields (ADR-0023) stay unpopulated.
  /** Commits ahead of the upstream tracking ref; `undefined` when there is no upstream. */
  ahead?: number;
  /** Commits behind the upstream tracking ref; `undefined` when there is no upstream. */
  behind?: number;
  /** Upstream tracking ref (e.g. "origin/main"), parsed from the `-b` header; `undefined` when the branch
   *  has no upstream (Sprint 2z, ADR-0047). Read-only; no network fetch. */
  upstream?: string;
  /** True when HEAD is detached. */
  isDetached?: boolean;
  /** True when the index has unmerged/conflicted paths. */
  hasUnmergedPaths?: boolean;
}

/**
 * Read-only working-tree diff view (CAP-002, ADR-0044 — read-only extension). Surfaces the unified diff of
 * **tracked** staged/unstaged changes vs HEAD. NOT persisted, no Ref, no storage. Untracked file *contents*
 * are NOT included (`git diff HEAD` excludes them) — untracked paths are surfaced via {@link GitStatus};
 * binary files appear as a marker line only, never binary content. The producing adapter applies a hard
 * size cap and sets `truncated`.
 */
export interface GitDiff {
  /** Changed tracked file paths (derived from a bounded-safe `--name-only` read, not parsed from raw diff). */
  files: string[];
  /** Unified diff of tracked staged/unstaged changes; binary files show a marker only; adapter-size-bounded. */
  unified: string;
  /** True when the adapter dropped diff content to fit its hard cap. */
  truncated: boolean;
}

/**
 * Result of an approved exact-file git commit (CAP-002, ADR-0046 — the first Git mutation). Returned by
 * `GitProvider.commitFiles`/`GitManager.commitFiles`. NOT persisted as an aggregate; the runtime stores the
 * hash + files on the apply anchor. `GIT_COMMITTED` means committed locally — never pushed/deployed.
 */
export interface GitCommitResult {
  /** The new commit's full sha (as read back by the adapter). */
  commitHash: string;
  /** The exact files included in the commit (the approved candidate set). */
  committedFiles: string[];
  /** The commit message used (the approved message). */
  message: string;
}

/**
 * The provider-reported successful push target after `git push` exited 0 (CAP-002, ADR-0048 — the first
 * REMOTE mutation). Returned by `GitProvider.pushApprovedCommit`/`GitManager.pushApprovedCommit`. This is
 * **NOT an independent remote verification** — only the target the provider pushed to once the command
 * exited 0. NOT persisted as an aggregate; the runtime uses it for local result-integrity checking and
 * stores the pushed target on the apply anchor. `GIT_PUSHED` means pushed to the approved upstream — never
 * PR-created/deployed/push-safe-forever.
 */
export interface GitPushResult {
  /** The remote pushed to (the approved remote). */
  remote: string;
  /** The branch pushed to (the approved branch; may contain '/'). */
  branch: string;
  /** The upstream tracking ref pushed to, e.g. "origin/main" (the approved upstream). */
  upstreamRef: string;
  /** The commit sha pushed (the approved pushCommitHash; HEAD at push time). */
  commitHash: string;
}

/**
 * Result of a post-merge local `main` synchronization (CAP-002, ADR-0058 — Sprint 3h). Returned by
 * `GitProvider.syncMainFastForward`/`GitManager.syncMain`. **Fast-forward only** — never a force/hard-reset. NOT an
 * independent verification of the remote; it reports what the LOCAL sync did this run. `syncMode` distinguishes a
 * checked-out-main fast-forward (working tree/index moved) from a ref-only fast-forward (only `refs/heads/main`
 * moved; the current checkout/working tree untouched). `MAIN_SYNCED` means local main reached `syncedCommitHash` —
 * never deployed/released/branch-deleted.
 */
export interface GitMainSyncResult {
  /** The local ref synchronized (always 'main' per policy). */
  branch: string;
  /** Which strategy ran (ADR-0058, CA change 1). `checked-out-main` = the current checkout WAS main; `ref-only` =
   *  the current checkout was another branch, so only `refs/heads/main` was fast-forwarded. */
  syncMode: 'checked-out-main' | 'ref-only';
  /** True only in `checked-out-main` mode when the fast-forward moved the working tree/index (false when
   *  already up to date, and always false in `ref-only` mode). */
  workingTreeUpdated: boolean;
  /** The local main commit after the fast-forward (equals the expected remote main tip). */
  syncedCommitHash: string;
  /** The local main commit BEFORE the fast-forward (the CAS base; for the response/audit — ADR-0058, CA change 3). */
  previousMainCommit: string;
  /** True when local main already equalled the expected commit (no ref move happened). */
  alreadyUpToDate: boolean;
}

/**
 * Result of a post-merge LOCAL branch cleanup (CAP-002, ADR-0059 — Sprint 3i). Returned by
 * `GitProvider.deleteMergedLocalBranch`/`GitManager.deleteMergedLocalBranch`. **Safe CAS delete only** — never a
 * force delete, never a remote deletion. NOT an independent verification; it reports what the LOCAL delete did this
 * run. `BRANCH_CLEANED` means the completed feature branch's LOCAL ref was deleted (or was already absent) — never
 * deployed/released/tagged/remote-deleted.
 */
export interface GitBranchCleanupResult {
  /** The local branch targeted (== the anchored PR head branch). */
  branch: string;
  /** True when this run deleted a local ref; false when it was already absent. */
  deleted: boolean;
  /** True when the local branch did not exist (idempotent no-op). */
  alreadyAbsent: boolean;
  /** The commit the deleted branch pointed at (for the response/audit), when a delete happened. */
  deletedCommitHash?: string;
}

/**
 * Result of an owner local branch create or switch (CAP-002, ADR-0099 D4). Returned by
 * `GitProvider.createBranch`/`switchBranch` and the `GitManager` wrappers. Purely local: no remote ref is created
 * or touched. NOT persisted as an aggregate; it reports what the LOCAL operation did this run.
 */
export interface GitBranchResult {
  /** The branch now checked out (verified by the adapter after the operation). */
  branch: string;
  /** HEAD commit sha after the operation (full sha as read back by the adapter). */
  headSha: string;
  /** True when this run created the branch (`createBranch`); false for a switch to an existing branch. */
  created: boolean;
}

/**
 * Minimal, read-only repository metadata (CAP-002). Intentionally **excludes
 * remote URLs** — HTTPS remotes can embed credentials; exposing them needs a
 * future masking policy + ADR (ADR-0023).
 */
export interface RepositoryInfo {
  /** Whether `rootPath` is inside a git work tree. */
  isRepository: boolean;
  /** Resolved repository top-level path (the input path when not a repo). */
  rootPath: string;
  /** Current branch name; '' when detached or not a repository. */
  branch: string;
  /** HEAD commit sha, if any (absent on an unborn repository). */
  headSha?: string;
  /** True when HEAD is detached. */
  detached: boolean;
}

import { BranchCleanupBlockedError, GitMainSyncBlockedError, GitPushBlockedError, isProtectedBranch } from '@quoky/core';
import type {
  GitBranchCleanupResult,
  GitBranchResult,
  GitCommitResult,
  GitDiff,
  GitMainSyncResult,
  GitProvider,
  GitPushResult,
  GitStatus,
  RepositoryInfo,
} from '@quoky/core';

export type PersonalGitPolicyErrorCode = 'PERSONAL_GIT_PROTECTED_BRANCH_COMMIT' | 'PERSONAL_GIT_PROTECTED_BRANCH_CREATE';

/**
 * Personal-edition git policy refusal (ADR-0094 commit, ADR-0099 branch create). Narrow, value-free app-level error: the message is the code only
 * (no branch name, path or remote). The runtime's commit-failure path already turns any throw from
 * `GitManager.commitFiles` into exactly one sanitized "not committed" reply.
 */
export class PersonalGitPolicyError extends Error {
  constructor(readonly code: PersonalGitPolicyErrorCode) {
    super(code);
    this.name = 'PersonalGitPolicyError';
  }
}

export interface PersonalGitGuardOptions {
  /** `QUOKY_GIT_REMOTE_ENABLED`. When false, remote-touching operations are refused before reaching `inner`. */
  remoteEnabled: boolean;
  /**
   * `QUOKY_GIT_MERGE_ENABLED` (ADR-0099 D5; default false — omitted means false). Gates the post-merge chain: the
   * local `main` sync and the merged-branch cleanup run only when remote AND merge are both on.
   */
  mergeEnabled?: boolean;
}

/**
 * Composition-root `GitProvider` decorator for Quoky Personal v1 (ADR-0094). Defense in depth beside, not instead
 * of, the approval gates; wrapped OUTERMOST so a refusal happens before any git process or the GitHub App
 * decorator could mint a credential.
 *
 * - Remote off: `pushApprovedCommit`, `getRemoteRefCommit`, `syncMainFastForward` (and the post-merge
 *   `deleteMergedLocalBranch` cleanup) throw the existing typed pre-mutation "Blocked" errors, so the runtime
 *   replies with its sanitized "not performed" message and never claims a git change happened.
 * - `commitFiles` is refused when the current branch is `main`/`master` (case-insensitive), detached, or cannot be
 *   determined. The branch is read through `info()` immediately before delegating. The ADR-0099 `newFiles` option
 *   is forwarded unchanged to the inner provider (never inspected here).
 * - `createBranch` (ADR-0099) refuses a protected name (`main`/`master`, case-insensitive) before any git process;
 *   `switchBranch` delegates (the adapter owns the name policy and the clean-tree rule). Both are local-only and
 *   work with remote off.
 * - `pushApprovedCommit` additionally refuses a protected TARGET branch (`main`/`master`) even when remote is on
 *   (`GitPushBlockedError`, ADR-0099 D5): the personal flow pushes feature branches only. Never a force push (the
 *   port has no force option).
 * - Merge chain (ADR-0099 D5): `syncMainFastForward` and `deleteMergedLocalBranch` are refused unless remote AND
 *   `mergeEnabled` are both on (`QUOKY_GIT_MERGE_ENABLED`, default false), with the same typed pre-mutation errors.
 *   The read-only `getRemoteRefCommit` needs only remote on.
 * - Everything else delegates unchanged.
 */
export class PersonalGitGuard implements GitProvider {
  constructor(
    private readonly inner: GitProvider,
    private readonly options: PersonalGitGuardOptions,
  ) {}

  get kind(): string {
    return this.inner.kind;
  }

  isRepository(rootPath: string): Promise<boolean> {
    return this.inner.isRepository(rootPath);
  }

  info(rootPath: string): Promise<RepositoryInfo> {
    return this.inner.info(rootPath);
  }

  status(rootPath: string): Promise<GitStatus> {
    return this.inner.status(rootPath);
  }

  diff(rootPath: string): Promise<GitDiff> {
    return this.inner.diff(rootPath);
  }

  getLocalRefCommit(rootPath: string, branch: string): Promise<{ commitHash: string } | null> {
    return this.inner.getLocalRefCommit(rootPath, branch);
  }

  isAncestor(rootPath: string, ancestor: string, descendant: string): Promise<boolean> {
    return this.inner.isAncestor(rootPath, ancestor, descendant);
  }

  async commitFiles(
    rootPath: string,
    files: string[],
    message: string,
    options?: { newFiles?: string[] },
  ): Promise<GitCommitResult> {
    let branch: string;
    try {
      const info = await this.inner.info(rootPath);
      branch = info.detached ? '' : info.branch.trim();
    } catch {
      throw new PersonalGitPolicyError('PERSONAL_GIT_PROTECTED_BRANCH_COMMIT');
    }
    if (branch.length === 0 || isProtectedBranch(branch)) {
      throw new PersonalGitPolicyError('PERSONAL_GIT_PROTECTED_BRANCH_COMMIT');
    }
    return options === undefined
      ? this.inner.commitFiles(rootPath, files, message)
      : this.inner.commitFiles(rootPath, files, message, options);
  }

  async createBranch(rootPath: string, branch: string, expectedHeadSha: string): Promise<GitBranchResult> {
    if (isProtectedBranch(branch)) throw new PersonalGitPolicyError('PERSONAL_GIT_PROTECTED_BRANCH_CREATE');
    return this.inner.createBranch(rootPath, branch, expectedHeadSha);
  }

  switchBranch(rootPath: string, branch: string): Promise<GitBranchResult> {
    return this.inner.switchBranch(rootPath, branch);
  }

  async pushApprovedCommit(
    rootPath: string,
    remote: string,
    branch: string,
    commitHash: string,
  ): Promise<GitPushResult> {
    if (!this.options.remoteEnabled) throw new GitPushBlockedError('git remote operations are disabled');
    if (isProtectedBranch(branch)) throw new GitPushBlockedError('git push to a protected branch is not allowed');
    return this.inner.pushApprovedCommit(rootPath, remote, branch, commitHash);
  }

  async getRemoteRefCommit(rootPath: string, remote: string, branch: string): Promise<{ commitHash: string }> {
    if (!this.options.remoteEnabled) throw new GitMainSyncBlockedError('git remote operations are disabled');
    return this.inner.getRemoteRefCommit(rootPath, remote, branch);
  }

  async syncMainFastForward(
    rootPath: string,
    remote: string,
    branch: string,
    expectedRemoteCommit: string,
    expectedPreviousCommit: string,
  ): Promise<GitMainSyncResult> {
    if (!this.options.remoteEnabled) throw new GitMainSyncBlockedError('git remote operations are disabled');
    if (this.options.mergeEnabled !== true) throw new GitMainSyncBlockedError('git merge chain operations are disabled');
    return this.inner.syncMainFastForward(rootPath, remote, branch, expectedRemoteCommit, expectedPreviousCommit);
  }

  async deleteMergedLocalBranch(
    rootPath: string,
    branch: string,
    expectedBranchCommit: string,
  ): Promise<GitBranchCleanupResult> {
    if (!this.options.remoteEnabled) throw new BranchCleanupBlockedError('git remote operations are disabled');
    if (this.options.mergeEnabled !== true) throw new BranchCleanupBlockedError('git merge chain operations are disabled');
    return this.inner.deleteMergedLocalBranch(rootPath, branch, expectedBranchCommit);
  }
}

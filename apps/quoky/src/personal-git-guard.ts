import { BranchCleanupBlockedError, GitMainSyncBlockedError, GitPushBlockedError } from '@quoky/core';
import type {
  GitBranchCleanupResult,
  GitCommitResult,
  GitDiff,
  GitMainSyncResult,
  GitProvider,
  GitPushResult,
  GitStatus,
  RepositoryInfo,
} from '@quoky/core';

export type PersonalGitPolicyErrorCode = 'PERSONAL_GIT_PROTECTED_BRANCH_COMMIT';

/**
 * Personal-edition commit refusal (ADR-0094). Narrow, value-free app-level error: the message is the code only
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
}

const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

/**
 * Composition-root `GitProvider` decorator for Quoky Personal v1 (ADR-0094). Defense in depth beside, not instead
 * of, the approval gates; wrapped OUTERMOST so a refusal happens before any git process or the GitHub App
 * decorator could mint a credential.
 *
 * - Remote off: `pushApprovedCommit`, `getRemoteRefCommit`, `syncMainFastForward` (and the post-merge
 *   `deleteMergedLocalBranch` cleanup) throw the existing typed pre-mutation "Blocked" errors, so the runtime
 *   replies with its sanitized "not performed" message and never claims a git change happened.
 * - `commitFiles` is refused when the current branch is `main`/`master` (case-insensitive), detached, or cannot be
 *   determined. The branch is read through `info()` immediately before delegating.
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

  async commitFiles(rootPath: string, files: string[], message: string): Promise<GitCommitResult> {
    let branch: string;
    try {
      const info = await this.inner.info(rootPath);
      branch = info.detached ? '' : info.branch.trim();
    } catch {
      throw new PersonalGitPolicyError('PERSONAL_GIT_PROTECTED_BRANCH_COMMIT');
    }
    if (branch.length === 0 || PROTECTED_BRANCHES.has(branch.toLowerCase())) {
      throw new PersonalGitPolicyError('PERSONAL_GIT_PROTECTED_BRANCH_COMMIT');
    }
    return this.inner.commitFiles(rootPath, files, message);
  }

  async pushApprovedCommit(
    rootPath: string,
    remote: string,
    branch: string,
    commitHash: string,
  ): Promise<GitPushResult> {
    if (!this.options.remoteEnabled) throw new GitPushBlockedError('git remote operations are disabled');
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
    return this.inner.syncMainFastForward(rootPath, remote, branch, expectedRemoteCommit, expectedPreviousCommit);
  }

  async deleteMergedLocalBranch(
    rootPath: string,
    branch: string,
    expectedBranchCommit: string,
  ): Promise<GitBranchCleanupResult> {
    if (!this.options.remoteEnabled) throw new BranchCleanupBlockedError('git remote operations are disabled');
    return this.inner.deleteMergedLocalBranch(rootPath, branch, expectedBranchCommit);
  }
}

import { RemoteBranchCleanupBlockedError, RepositoryHostingBlockedError } from '@quoky/core';
import type {
  PullRequestMergeResult,
  PullRequestResult,
  PullRequestStatusPreview,
  RemoteBranchCleanupResult,
  RepositoryHostingManager,
} from '@quoky/core';

/** The repository-hosting surface the conversation runtime calls (a `RepositoryHostingManager` satisfies it). */
export type RepositoryHostingSurface = Pick<
  RepositoryHostingManager,
  'createPullRequest' | 'getPullRequestStatus' | 'mergePullRequest' | 'deleteRemoteBranch'
>;

export interface PersonalHostingGuardOptions {
  /** `QUOKY_GIT_MERGE_ENABLED` (SEAM-2 parsed; default false; true requires remote on). */
  mergeEnabled: boolean;
}

/**
 * Composition-root repository-hosting decorator for Quoky Personal v2 (ADR-0099 D5). Defense in depth beside, not
 * instead of, the CRITICAL approval gates and the runtime's display-only merge-disabled reply.
 *
 * It is composed only when `QUOKY_GIT_REMOTE_ENABLED=true` (with remote off the composition root withholds the
 * manager entirely, ADR-0094). Then:
 * - `createPullRequest` and the read-only `getPullRequestStatus` delegate unchanged;
 * - with `QUOKY_GIT_MERGE_ENABLED=false`, `mergePullRequest` throws `RepositoryHostingBlockedError` and
 *   `deleteRemoteBranch` throws `RemoteBranchCleanupBlockedError` BEFORE the inner manager is reached — the typed
 *   pre-mutation errors the runtime already words as "not merged" / "not deleted" — so no REST call is made and no
 *   installation token is minted.
 *
 * The messages carry the policy only (no repository, branch, PR number or token).
 */
export class PersonalHostingGuard implements RepositoryHostingSurface {
  constructor(
    private readonly inner: RepositoryHostingSurface,
    private readonly options: PersonalHostingGuardOptions,
  ) {}

  createPullRequest(input: Parameters<RepositoryHostingManager['createPullRequest']>[0]): Promise<PullRequestResult> {
    return this.inner.createPullRequest(input);
  }

  getPullRequestStatus(
    input: Parameters<RepositoryHostingManager['getPullRequestStatus']>[0],
  ): Promise<PullRequestStatusPreview> {
    return this.inner.getPullRequestStatus(input);
  }

  async mergePullRequest(
    input: Parameters<RepositoryHostingManager['mergePullRequest']>[0],
  ): Promise<PullRequestMergeResult> {
    if (!this.options.mergeEnabled) {
      throw new RepositoryHostingBlockedError('repository hosting: PR merge is disabled (QUOKY_GIT_MERGE_ENABLED=false)');
    }
    return this.inner.mergePullRequest(input);
  }

  async deleteRemoteBranch(
    input: Parameters<RepositoryHostingManager['deleteRemoteBranch']>[0],
  ): Promise<RemoteBranchCleanupResult> {
    if (!this.options.mergeEnabled) {
      throw new RemoteBranchCleanupBlockedError(
        'repository hosting: remote branch cleanup is disabled (QUOKY_GIT_MERGE_ENABLED=false)',
      );
    }
    return this.inner.deleteRemoteBranch(input);
  }
}

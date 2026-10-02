import { describe, expect, it } from 'vitest';
import { ApprovalStatus, RemoteBranchCleanupBlockedError, RepositoryHostingBlockedError } from '@quoky/core';
import type { ApprovalRef, PullRequestRef, RepositoryIdentity } from '@quoky/core';
import { PersonalHostingGuard } from './personal-hosting-guard';
import type { RepositoryHostingSurface } from './personal-hosting-guard';

const SHA = 'a'.repeat(40);
const identity = { provider: 'github', owner: 'acme', repo: 'sandbox' } as RepositoryIdentity;
const approvalRef = { id: 'appr-1', status: ApprovalStatus.APPROVED } as ApprovalRef;
const pullRequestRef = { provider: 'github', owner: 'acme', repo: 'sandbox', number: 7, url: 'https://github.com/acme/sandbox/pull/7' } as unknown as PullRequestRef;

/** Fake inner hosting surface recording every invoked operation; no network. */
function harness() {
  const invoked: string[] = [];
  const inner: RepositoryHostingSurface = {
    async createPullRequest(input) {
      invoked.push('createPullRequest');
      return { headBranch: input.headBranch, baseBranch: input.baseBranch } as never;
    },
    async getPullRequestStatus() {
      invoked.push('getPullRequestStatus');
      return { state: 'open' } as never;
    },
    async mergePullRequest() {
      invoked.push('mergePullRequest');
      return { merged: true } as never;
    },
    async deleteRemoteBranch() {
      invoked.push('deleteRemoteBranch');
      return { deleted: true } as never;
    },
  };
  return { inner, invoked };
}

const createInput = {
  identity,
  headBranch: 'feature/x',
  baseBranch: 'main',
  title: 't',
  body: 'b',
  expectedCommitHash: SHA,
  approvalRef,
};
const statusInput = { identity, pullRequestRef, expectedHeadBranch: 'feature/x', expectedBaseBranch: 'main', expectedCommitHash: SHA };
const mergeInput = { identity, pullRequestRef, expectedHeadBranch: 'feature/x', expectedBaseBranch: 'main', expectedHeadSha: SHA, approvalRef };
const deleteInput = {
  identity,
  pullRequestRef,
  expectedHeadBranch: 'feature/x',
  expectedBaseBranch: 'main',
  branch: 'feature/x',
  expectedCommitHash: SHA,
  approvalRef,
};

describe('PersonalHostingGuard (ADR-0099 D5)', () => {
  it('merge off: PR create and the read-only PR status delegate unchanged', async () => {
    const { inner, invoked } = harness();
    const guard = new PersonalHostingGuard(inner, { mergeEnabled: false });
    await expect(guard.createPullRequest(createInput)).resolves.toMatchObject({ headBranch: 'feature/x', baseBranch: 'main' });
    await expect(guard.getPullRequestStatus(statusInput)).resolves.toMatchObject({ state: 'open' });
    expect(invoked).toEqual(['createPullRequest', 'getPullRequestStatus']);
  });

  it('merge off: PR merge and remote branch delete are refused pre-mutation with the typed Blocked errors', async () => {
    const { inner, invoked } = harness();
    const guard = new PersonalHostingGuard(inner, { mergeEnabled: false });
    await expect(guard.mergePullRequest(mergeInput)).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
    await expect(guard.deleteRemoteBranch(deleteInput)).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
    expect(invoked).toEqual([]);
  });

  it('merge off: the refusal messages carry the policy only (no repo, branch, PR or URL)', async () => {
    const { inner } = harness();
    const guard = new PersonalHostingGuard(inner, { mergeEnabled: false });
    const merge = await guard.mergePullRequest(mergeInput).catch((e: Error) => e);
    const del = await guard.deleteRemoteBranch(deleteInput).catch((e: Error) => e);
    for (const err of [merge, del]) {
      expect((err as Error).message).toContain('QUOKY_GIT_MERGE_ENABLED=false');
      expect((err as Error).message).not.toMatch(/acme|sandbox|feature|github\.com|\/pull\//);
    }
  });

  it('merge on: every operation delegates', async () => {
    const { inner, invoked } = harness();
    const guard = new PersonalHostingGuard(inner, { mergeEnabled: true });
    await guard.createPullRequest(createInput);
    await guard.getPullRequestStatus(statusInput);
    await guard.mergePullRequest(mergeInput);
    await guard.deleteRemoteBranch(deleteInput);
    expect(invoked).toEqual(['createPullRequest', 'getPullRequestStatus', 'mergePullRequest', 'deleteRemoteBranch']);
  });
});

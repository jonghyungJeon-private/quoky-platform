import { describe, expect, it } from 'vitest';
import {
  RepositoryHostingBlockedError,
  RepositoryHostingManager,
  RepositoryHostingUnverifiedError,
} from './repository-hosting-manager';
import { ApprovalStatus, RemoteBranchCleanupBlockedError, RemoteBranchCleanupUnverifiedError } from '../domain';
import type {
  ApprovalRef,
  PullRequestCreationInput,
  PullRequestMergePreflight,
  PullRequestMergeResult,
  PullRequestRef,
  PullRequestResult,
  PullRequestStatusPreview,
  RemoteBranchCleanupResult,
  RepositoryIdentity,
} from '../domain';
import type { RepositoryHostingProvider } from '../ports';

const PR_REF: PullRequestRef = { provider: 'github', owner: 'acme', repo: 'widgets', pullRequestNumber: 42, pullRequestUrl: 'https://github.com/acme/widgets/pull/42' };
function validStatus(over: Partial<PullRequestStatusPreview> = {}): PullRequestStatusPreview {
  return {
    ref: PR_REF,
    state: 'open',
    headBranch: 'feature/x',
    baseBranch: 'main',
    headCommitHash: 'abc1234',
    isDraft: false,
    checks: { state: 'success', totalCount: 1, successCount: 1, failureCount: 0, pendingCount: 0 },
    reviews: { state: 'approved', approvedCount: 1, changesRequestedCount: 0 },
    observedAt: '2026-07-03T00:00:00.000Z',
    ...over,
  };
}

const IDENTITY: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'widgets' };
const HEAD = 'feature/x';
const BASE = 'main';
const COMMIT = 'abc1234';

function approved(): ApprovalRef {
  return { id: 'a1', status: ApprovalStatus.APPROVED, executionPlanRef: { id: 'p1', goal: 'g' } };
}

function validResult(over: Partial<PullRequestResult> = {}): PullRequestResult {
  return {
    provider: 'github',
    owner: 'acme',
    repo: 'widgets',
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/acme/widgets/pull/42',
    pullRequestHeadBranch: HEAD,
    pullRequestBaseBranch: BASE,
    pullRequestCommitHash: COMMIT,
    reused: false,
    ...over,
  };
}

/** Configurable fake provider with a call log — the ONLY thing that implements the port in 3d-B. */
class FakeProvider implements RepositoryHostingProvider {
  kind = 'github';
  calls: string[] = [];
  createInputs: PullRequestCreationInput[] = [];
  repoExists = true;
  branches: Record<string, boolean> = { [HEAD]: true, [BASE]: true };
  openPr: PullRequestResult | null = null;
  findThrows = false;
  createResult: PullRequestResult = validResult();
  createThrows = false;

  async repositoryExists(): Promise<boolean> {
    this.calls.push('repositoryExists');
    return this.repoExists;
  }
  async branchExists(_id: RepositoryIdentity, branch: string): Promise<boolean> {
    this.calls.push(`branchExists:${branch}`);
    return this.branches[branch] ?? false;
  }
  async findOpenPullRequest(): Promise<PullRequestResult | null> {
    this.calls.push('findOpenPullRequest');
    if (this.findThrows) throw new Error('RAW-PROVIDER-SECRET-abc');
    return this.openPr;
  }
  async createPullRequest(input: PullRequestCreationInput): Promise<PullRequestResult> {
    this.calls.push('createPullRequest');
    this.createInputs.push(input);
    if (this.createThrows) throw new Error('RAW-PROVIDER-SECRET-xyz');
    return this.createResult;
  }
  // Sprint 3e: read-only status. Configurable result/throw.
  statusResult: PullRequestStatusPreview = validStatus();
  statusThrows = false;
  async getPullRequestStatus(): Promise<PullRequestStatusPreview> {
    this.calls.push('getPullRequestStatus');
    if (this.statusThrows) throw new Error('RAW-PROVIDER-SECRET-status');
    return this.statusResult;
  }
  // Sprint 3g: merge preflight + execution. Configurable result/throw. mergeInputs captures what the provider
  // received — used to prove the provider never sees an ApprovalRef.
  preflightResult: PullRequestMergePreflight = validPreflight();
  preflightThrows = false;
  mergeResult: PullRequestMergeResult = validMergeResult();
  mergeThrows = false;
  mergeInputs: Array<{ identity: RepositoryIdentity; pullRequestRef: PullRequestRef; expectedHeadSha: string }> = [];
  async getMergePreflight(): Promise<PullRequestMergePreflight> {
    this.calls.push('getMergePreflight');
    if (this.preflightThrows) throw new Error('RAW-PROVIDER-SECRET-preflight');
    return this.preflightResult;
  }
  async mergePullRequest(input: { identity: RepositoryIdentity; pullRequestRef: PullRequestRef; expectedHeadSha: string }): Promise<PullRequestMergeResult> {
    this.calls.push('mergePullRequest');
    this.mergeInputs.push(input);
    if (this.mergeThrows) throw new Error('RAW-PROVIDER-SECRET-merge');
    return this.mergeResult;
  }
  // Sprint 3j-B: remote branch cleanup read + delete. Configurable result/throw. deleteInputs captures what the
  // provider received — used to prove the provider never sees an ApprovalRef.
  remoteBranchCommit: { commitHash: string } | null = { commitHash: COMMIT };
  getRemoteThrows = false;
  deleteResult: RemoteBranchCleanupResult = validRemoteCleanup();
  deleteThrowsBlocked = false;
  deleteThrowsUnverified = false;
  deleteThrowsGeneric = false;
  deleteInputs: Array<{ identity: RepositoryIdentity; branch: string; expectedCommitHash: string }> = [];
  async getRemoteBranchCommit(_id: RepositoryIdentity, branch: string): Promise<{ commitHash: string } | null> {
    this.calls.push(`getRemoteBranchCommit:${branch}`);
    if (this.getRemoteThrows) throw new Error('RAW-PROVIDER-SECRET-getref');
    return this.remoteBranchCommit;
  }
  async deleteRemoteBranch(input: { identity: RepositoryIdentity; branch: string; expectedCommitHash: string }): Promise<RemoteBranchCleanupResult> {
    this.calls.push('deleteRemoteBranch');
    this.deleteInputs.push(input);
    if (this.deleteThrowsBlocked) throw new RemoteBranchCleanupBlockedError('blocked');
    if (this.deleteThrowsUnverified) throw new RemoteBranchCleanupUnverifiedError('unverified');
    if (this.deleteThrowsGeneric) throw new Error('RAW-PROVIDER-SECRET-del');
    return this.deleteResult;
  }
}

function validRemoteCleanup(over: Partial<RemoteBranchCleanupResult> = {}): RemoteBranchCleanupResult {
  return { provider: 'github', owner: 'acme', repo: 'widgets', branch: HEAD, deleted: true, alreadyAbsent: false, deletedCommitHash: COMMIT, ...over };
}

/** Standard input for RepositoryHostingManager.deleteRemoteBranch (Sprint 3j-B). */
function deleteInput(over: Partial<Parameters<RepositoryHostingManager['deleteRemoteBranch']>[0]> = {}) {
  return {
    identity: IDENTITY,
    pullRequestRef: PR_REF,
    expectedHeadBranch: HEAD,
    expectedBaseBranch: BASE,
    branch: HEAD,
    expectedCommitHash: COMMIT,
    approvalRef: approved(),
    ...over,
  };
}

function validPreflight(over: Partial<PullRequestMergePreflight> = {}): PullRequestMergePreflight {
  return {
    ref: PR_REF,
    state: 'open',
    headBranch: HEAD,
    baseBranch: BASE,
    headCommitHash: COMMIT,
    mergeability: 'MERGEABLE',
    observedAt: '2026-07-03T00:00:00.000Z',
    ...over,
  };
}

function validMergeResult(over: Partial<PullRequestMergeResult> = {}): PullRequestMergeResult {
  return {
    provider: 'github',
    owner: 'acme',
    repo: 'widgets',
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/acme/widgets/pull/42',
    merged: true,
    mergedHeadSha: COMMIT,
    mergeCommitHash: 'def4567',
    alreadyMerged: false,
    ...over,
  };
}

function runMerge(p: FakeProvider, over: Record<string, unknown> = {}) {
  return new RepositoryHostingManager(p).mergePullRequest({
    identity: IDENTITY,
    pullRequestRef: PR_REF,
    expectedHeadBranch: HEAD,
    expectedBaseBranch: BASE,
    expectedHeadSha: COMMIT,
    approvalRef: approved(),
    ...over,
  } as Parameters<RepositoryHostingManager['mergePullRequest']>[0]);
}

function runStatus(p: FakeProvider, over: Record<string, unknown> = {}) {
  return new RepositoryHostingManager(p).getPullRequestStatus({
    identity: IDENTITY,
    pullRequestRef: PR_REF,
    expectedHeadBranch: HEAD,
    expectedBaseBranch: BASE,
    expectedCommitHash: COMMIT,
    ...over,
  } as Parameters<RepositoryHostingManager['getPullRequestStatus']>[0]);
}

function run(p: FakeProvider, over: Record<string, unknown> = {}) {
  const mgr = new RepositoryHostingManager(p);
  return mgr.createPullRequest({
    identity: IDENTITY,
    headBranch: HEAD,
    baseBranch: BASE,
    title: 'Add widget',
    body: 'body',
    expectedCommitHash: COMMIT,
    approvalRef: approved(),
    ...over,
  } as Parameters<RepositoryHostingManager['createPullRequest']>[0]);
}

describe('RepositoryHostingManager (CAP-010 skeleton, ADR-0052, Sprint 3d-B)', () => {
  describe('port shape (tests 6–9)', () => {
    it('a conformant provider has repositoryExists/branchExists/findOpenPullRequest/createPullRequest', () => {
      const p = new FakeProvider();
      for (const m of ['repositoryExists', 'branchExists', 'findOpenPullRequest', 'createPullRequest']) {
        expect(typeof (p as unknown as Record<string, unknown>)[m]).toBe('function');
      }
    });
  });

  describe('approval + input validation (tests 10–18, 61, 65)', () => {
    it('rejects a non-APPROVED ApprovalRef before any provider call (test 10)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { approvalRef: { ...approved(), status: ApprovalStatus.PENDING } })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects provider.kind mismatch before any provider call (test 61)', async () => {
      const p = new FakeProvider();
      p.kind = 'gitlab';
      await expect(run(p)).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects an unsafe identity (test 11)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { identity: { provider: 'github', owner: 'bad owner', repo: 'widgets' } })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects an unsafe head branch (test 12)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { headBranch: 'bad branch' })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects an unsafe base branch (test 13)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { baseBranch: 'bad:base' })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects head == base (test 14)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { headBranch: 'main', baseBranch: 'main' })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects an empty (or whitespace-only) title (tests 15, 65)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { title: '   ' })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects a too-long title (test 16)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { title: 'a'.repeat(201) })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects a too-long body (test 17)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { body: 'a'.repeat(8001) })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
    it('rejects an invalid expectedCommitHash (test 18)', async () => {
      const p = new FakeProvider();
      await expect(run(p, { expectedCommitHash: 'nothex!' })).rejects.toThrow();
      expect(p.calls).toEqual([]);
    });
  });

  describe('title normalization (tests 62/63/64/66)', () => {
    it('normalizes surrounding + repeated whitespace and passes the normalized title to the provider', async () => {
      const p = new FakeProvider();
      await run(p, { title: '  Add    widget\n\ttitle  ' });
      expect(p.createInputs[0]?.title).toBe('Add widget title');
    });
    it('success path requires provider.kind === identity.provider (test 62)', async () => {
      const p = new FakeProvider(); // kind 'github' === identity.provider
      const r = await run(p);
      expect(r.reused).toBe(false);
      expect(p.calls).toContain('createPullRequest');
    });
  });

  describe('call ordering & no-mutation-on-failure (tests 19–25, 30)', () => {
    it('calls repositoryExists → branchExists(head) → branchExists(base) → findOpenPullRequest → createPullRequest (tests 19/21/23/25/30)', async () => {
      const p = new FakeProvider();
      await run(p);
      expect(p.calls).toEqual([
        'repositoryExists',
        `branchExists:${HEAD}`,
        `branchExists:${BASE}`,
        'findOpenPullRequest',
        'createPullRequest',
      ]);
      expect(p.calls.filter((c) => c === 'createPullRequest')).toHaveLength(1);
    });
    it('does not create when repositoryExists is false (test 20)', async () => {
      const p = new FakeProvider();
      p.repoExists = false;
      await expect(run(p)).rejects.toThrow();
      expect(p.calls).toEqual(['repositoryExists']);
    });
    it('does not create when the head branch is missing (test 22)', async () => {
      const p = new FakeProvider();
      p.branches[HEAD] = false;
      await expect(run(p)).rejects.toThrow();
      expect(p.calls).not.toContain('createPullRequest');
      expect(p.calls).not.toContain('findOpenPullRequest');
    });
    it('does not create when the base branch is missing (test 24)', async () => {
      const p = new FakeProvider();
      p.branches[BASE] = false;
      await expect(run(p)).rejects.toThrow();
      expect(p.calls).not.toContain('createPullRequest');
    });
  });

  describe('existing-PR reuse & non-idempotent block (tests 26–29, 67)', () => {
    it('existing open PR skips createPullRequest and returns reused: true (tests 26/28)', async () => {
      const p = new FakeProvider();
      p.openPr = validResult({ reused: false });
      const r = await run(p);
      expect(r.reused).toBe(true);
      expect(p.calls).not.toContain('createPullRequest');
    });
    it('returns reused: true even if the provider result says reused: false (test 67)', async () => {
      const p = new FakeProvider();
      p.openPr = validResult({ reused: false });
      const r = await run(p);
      expect(r.reused).toBe(true);
    });
    it('existing open PR with integrity mismatch fails safe and does not create (test 27)', async () => {
      const p = new FakeProvider();
      p.openPr = validResult({ pullRequestHeadBranch: 'other' });
      await expect(run(p)).rejects.toThrow();
      expect(p.calls).not.toContain('createPullRequest');
    });
    it('blocks by default when findOpenPullRequest throws (unsupported) — no create (test 29)', async () => {
      const p = new FakeProvider();
      p.findThrows = true;
      await expect(run(p)).rejects.toThrow();
      expect(p.calls).not.toContain('createPullRequest');
    });
  });

  describe('manager-owned reused on create path (test 68)', () => {
    it('returns reused: false even if the provider create result says reused: true', async () => {
      const p = new FakeProvider();
      p.createResult = validResult({ reused: true });
      const r = await run(p);
      expect(r.reused).toBe(false);
    });
  });

  describe('result integrity (tests 35–41, 69, 70)', () => {
    it('head mismatch fails safe (test 35)', async () => {
      const p = new FakeProvider();
      p.createResult = validResult({ pullRequestHeadBranch: 'nope' });
      await expect(run(p)).rejects.toThrow();
    });
    it('base mismatch fails safe (test 36)', async () => {
      const p = new FakeProvider();
      p.createResult = validResult({ pullRequestBaseBranch: 'nope' });
      await expect(run(p)).rejects.toThrow();
    });
    it('owner/repo mismatch fails safe (test 37)', async () => {
      const p = new FakeProvider();
      p.createResult = validResult({ owner: 'evil' });
      await expect(run(p)).rejects.toThrow();
    });
    it('invalid URL fails safe (test 38)', async () => {
      const p = new FakeProvider();
      p.createResult = validResult({ pullRequestUrl: 'https://github.com/acme/widgets/pull/42?x=1' });
      await expect(run(p)).rejects.toThrow();
    });
    it('invalid PR number fails safe (test 39)', async () => {
      const p = new FakeProvider();
      p.createResult = validResult({ pullRequestNumber: 0 });
      await expect(run(p)).rejects.toThrow();
    });
    it('invalid commit hash fails safe (test 40)', async () => {
      const p = new FakeProvider();
      p.createResult = validResult({ pullRequestCommitHash: 'zzz' });
      await expect(run(p)).rejects.toThrow();
    });
    it('commit hash not matching expectedCommitHash fails safe — create path (test 70)', async () => {
      const p = new FakeProvider();
      p.createResult = validResult({ pullRequestCommitHash: 'def5678' });
      await expect(run(p)).rejects.toThrow();
    });
    it('commit hash not matching expectedCommitHash fails safe — existing-PR path, no create (test 69)', async () => {
      const p = new FakeProvider();
      p.openPr = validResult({ pullRequestCommitHash: 'def5678' });
      await expect(run(p)).rejects.toThrow();
      expect(p.calls).not.toContain('createPullRequest');
    });
    it('returns the provider-reported result on success (test 41)', async () => {
      const p = new FakeProvider();
      const r = await run(p);
      expect(r).toMatchObject({
        provider: 'github',
        owner: 'acme',
        repo: 'widgets',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/acme/widgets/pull/42',
        pullRequestHeadBranch: HEAD,
        pullRequestBaseBranch: BASE,
        pullRequestCommitHash: COMMIT,
        reused: false,
      });
    });
  });

  describe('provider input hygiene (tests 31–34)', () => {
    it('provider never receives an ApprovalRef / token / raw diff / file content', async () => {
      const p = new FakeProvider();
      await run(p);
      const inp = p.createInputs[0]!;
      expect(Object.keys(inp).sort()).toEqual([
        'baseBranch',
        'body',
        'expectedCommitHash',
        'headBranch',
        'identity',
        'title',
      ]);
      const keys = Object.keys(inp);
      expect(keys).not.toContain('approvalRef');
      expect(keys).not.toContain('token');
      expect(keys).not.toContain('diff');
      expect(keys).not.toContain('fileContent');
      expect(keys).not.toContain('pushedRemote');
    });
  });

  describe('error wrapping (test 71)', () => {
    it('does not forward a raw provider error message from findOpenPullRequest', async () => {
      const p = new FakeProvider();
      p.findThrows = true;
      await expect(run(p)).rejects.toThrow(/repository hosting/);
      await run(p).catch((e: unknown) => {
        expect(String((e as Error).message)).not.toContain('RAW-PROVIDER-SECRET');
      });
    });
    it('does not forward a raw provider error message from createPullRequest', async () => {
      const p = new FakeProvider();
      p.createThrows = true;
      await run(p).catch((e: unknown) => {
        expect(String((e as Error).message)).not.toContain('RAW-PROVIDER-SECRET');
      });
    });
  });

  describe('getPullRequestStatus (read-only, Sprint 3e, ADR-0055)', () => {
    it('validates PullRequestRef before the provider call (tests 61–63)', async () => {
      const mismatchRef = new FakeProvider();
      await expect(runStatus(mismatchRef, { pullRequestRef: { ...PR_REF, owner: 'evil' } })).rejects.toThrow();
      expect(mismatchRef.calls).not.toContain('getPullRequestStatus');
      const badUrl = new FakeProvider();
      await expect(runStatus(badUrl, { pullRequestRef: { ...PR_REF, pullRequestUrl: 'https://evil.com/x/y/pull/42' } })).rejects.toThrow();
      expect(badUrl.calls).not.toContain('getPullRequestStatus');
      const badNum = new FakeProvider();
      await expect(runStatus(badNum, { pullRequestRef: { ...PR_REF, pullRequestNumber: 0 } })).rejects.toThrow();
      expect(badNum.calls).not.toContain('getPullRequestStatus');
    });
    it('rejects provider.kind mismatch before the provider call', async () => {
      const p = new FakeProvider();
      p.kind = 'gitlab';
      await expect(runStatus(p)).rejects.toThrow();
      expect(p.calls).not.toContain('getPullRequestStatus');
    });
    it('returns the provider-reported status on a matching result', async () => {
      const p = new FakeProvider();
      const s = await runStatus(p);
      expect(p.calls).toContain('getPullRequestStatus');
      expect(s.state).toBe('open');
      expect(s.checks.successCount).toBe(1);
      expect(s.observedAt).toBe('2026-07-03T00:00:00.000Z');
    });
    it('fails safe on result ref/head/base/commit mismatch (tests 16–19/81–84)', async () => {
      for (const bad of [
        validStatus({ ref: { ...PR_REF, pullRequestNumber: 43, pullRequestUrl: 'https://github.com/acme/widgets/pull/43' } }),
        validStatus({ headBranch: 'other' }),
        validStatus({ baseBranch: 'develop' }),
        validStatus({ headCommitHash: 'def5678' }),
      ]) {
        const p = new FakeProvider();
        p.statusResult = bad;
        await expect(runStatus(p)).rejects.toThrow();
      }
    });
    it('rejects negative/non-integer check counts', async () => {
      const p = new FakeProvider();
      p.statusResult = validStatus({ checks: { state: 'unknown', totalCount: -1, successCount: 0, failureCount: 0, pendingCount: 0 } });
      await expect(runStatus(p)).rejects.toThrow();
    });
    it('passes a PARTIAL status with unavailable checks through; rejects unavailable checks with non-zero counts', async () => {
      const ok = new FakeProvider();
      ok.statusResult = validStatus({ checks: { state: 'unavailable', totalCount: 0, successCount: 0, failureCount: 0, pendingCount: 0 } });
      await expect(runStatus(ok)).resolves.toMatchObject({ state: 'open', checks: { state: 'unavailable', totalCount: 0 } });
      const bad = new FakeProvider();
      bad.statusResult = validStatus({ checks: { state: 'unavailable', totalCount: 1, successCount: 1, failureCount: 0, pendingCount: 0 } });
      await expect(runStatus(bad)).rejects.toThrow('invalid status check counts');
    });
    it('does not forward a raw provider error message on read failure', async () => {
      const p = new FakeProvider();
      p.statusThrows = true;
      await runStatus(p).catch((e: unknown) => {
        expect(String((e as Error).message)).toMatch(/repository hosting/);
        expect(String((e as Error).message)).not.toContain('RAW-PROVIDER-SECRET');
      });
    });
    it('never mutates — no create/commit/push style calls during a status read', async () => {
      const p = new FakeProvider();
      await runStatus(p);
      expect(p.calls).toEqual(['getPullRequestStatus']);
    });
  });

  describe('mergePullRequest — live preflight + execution (Sprint 3g, ADR-0057)', () => {
    it('happy path: preflight (open, MERGEABLE, exact head) → single mergePullRequest call → merged, alreadyMerged=false', async () => {
      const p = new FakeProvider();
      const r = await runMerge(p);
      expect(p.calls).toEqual(['getMergePreflight', 'mergePullRequest']);
      expect(r.merged).toBe(true);
      expect(r.alreadyMerged).toBe(false);
      expect(r.mergedHeadSha).toBe(COMMIT);
    });

    it('the provider merge call receives NO ApprovalRef — only hosting-safe refs + expected head SHA', async () => {
      const p = new FakeProvider();
      await runMerge(p);
      const received = p.mergeInputs[0] as Record<string, unknown>;
      expect(received).toBeTruthy();
      expect('approvalRef' in received).toBe(false);
      expect('approvalRequest' in received).toBe(false);
      expect(received.expectedHeadSha).toBe(COMMIT);
    });

    it('approval not APPROVED → Blocked before any provider call (no preflight, no merge)', async () => {
      const p = new FakeProvider();
      await expect(runMerge(p, { approvalRef: { ...approved(), status: ApprovalStatus.PENDING } })).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
      expect(p.calls).toEqual([]);
    });

    it('provider.getMergePreflight throws → Blocked, no mergePullRequest call, sanitized (no raw secret)', async () => {
      const p = new FakeProvider();
      p.preflightThrows = true;
      await expect(runMerge(p)).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
      await expect(runMerge(p)).rejects.not.toThrow(/RAW-PROVIDER-SECRET/);
      expect(p.calls).not.toContain('mergePullRequest');
    });

    it('preflight ref/head/base/commit mismatch → Blocked (stale), no mergePullRequest call', async () => {
      for (const over of [
        { ref: { ...PR_REF, pullRequestNumber: 99, pullRequestUrl: 'https://github.com/acme/widgets/pull/99' } },
        { headBranch: 'other' },
        { baseBranch: 'develop' },
        { headCommitHash: 'feedbee' },
      ]) {
        const p = new FakeProvider();
        p.preflightResult = validPreflight(over as Partial<PullRequestMergePreflight>);
        await expect(runMerge(p)).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
        expect(p.calls).not.toContain('mergePullRequest');
      }
    });

    it('live PR closed / unknown → Blocked, no mergePullRequest call (CA 11)', async () => {
      for (const state of ['closed', 'unknown'] as const) {
        const p = new FakeProvider();
        p.preflightResult = validPreflight({ state });
        await expect(runMerge(p)).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
        expect(p.calls).not.toContain('mergePullRequest');
      }
    });

    it('live already merged at the EXACT approved head → alreadyMerged=true, NO mutating call (CA 33)', async () => {
      const p = new FakeProvider();
      p.preflightResult = validPreflight({ state: 'merged' });
      const r = await runMerge(p);
      expect(r.merged).toBe(true);
      expect(r.alreadyMerged).toBe(true);
      expect(r.mergedHeadSha).toBe(COMMIT);
      expect(p.calls).toEqual(['getMergePreflight']); // no mergePullRequest
    });

    it('live already merged at a DIFFERENT head SHA → Blocked/Stale, no PR_MERGED, no mutating call (CA 34)', async () => {
      const p = new FakeProvider();
      p.preflightResult = validPreflight({ state: 'merged', headCommitHash: 'differ7' });
      await expect(runMerge(p)).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
      expect(p.calls).toEqual(['getMergePreflight']);
    });

    it('live already merged at a DIFFERENT base/head branch → Blocked, no mutating call (CA 35)', async () => {
      for (const over of [{ state: 'merged' as const, headBranch: 'other' }, { state: 'merged' as const, baseBranch: 'develop' }]) {
        const p = new FakeProvider();
        p.preflightResult = validPreflight(over);
        await expect(runMerge(p)).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
        expect(p.calls).toEqual(['getMergePreflight']);
      }
    });

    it('mergeability != MERGEABLE (UNKNOWN/CONFLICTING/BLOCKED/STALE_HEAD) → Blocked, no mutating call (CA 15/16/17)', async () => {
      for (const mergeability of ['UNKNOWN', 'CONFLICTING', 'BLOCKED', 'STALE_HEAD'] as const) {
        const p = new FakeProvider();
        p.preflightResult = validPreflight({ mergeability });
        await expect(runMerge(p)).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
        expect(p.calls).not.toContain('mergePullRequest');
      }
    });

    it('provider.mergePullRequest throws AFTER attempt → Unverified (never "not merged"), sanitized (CA 21)', async () => {
      const p = new FakeProvider();
      p.mergeThrows = true;
      await expect(runMerge(p)).rejects.toBeInstanceOf(RepositoryHostingUnverifiedError);
      await expect(runMerge(p)).rejects.not.toThrow(/RAW-PROVIDER-SECRET/);
      expect(p.calls).toContain('mergePullRequest');
    });

    it('merge-result integrity failure (mergedHeadSha != expected / wrong ref) → Unverified', async () => {
      for (const over of [{ mergedHeadSha: 'wrong99' }, { pullRequestNumber: 7 }, { owner: 'evil' }]) {
        const p = new FakeProvider();
        p.mergeResult = validMergeResult(over as Partial<PullRequestMergeResult>);
        await expect(runMerge(p)).rejects.toBeInstanceOf(RepositoryHostingUnverifiedError);
      }
    });

    it('unsafe identity / branch / SHA / ref mismatch → Blocked before any provider call', async () => {
      const bad: Array<Record<string, unknown>> = [
        { identity: { provider: 'github', owner: 'has token', repo: 'widgets' } },
        { expectedHeadBranch: 'bad branch' },
        { expectedHeadSha: 'not-a-sha!' },
        { expectedHeadBranch: BASE }, // head === base
        { pullRequestRef: { ...PR_REF, owner: 'someone-else' } },
      ];
      for (const over of bad) {
        const p = new FakeProvider();
        await expect(runMerge(p, over)).rejects.toBeInstanceOf(RepositoryHostingBlockedError);
        expect(p.calls).toEqual([]);
      }
    });
  });

  // ── Sprint 3j-B (ADR-0060): remote branch cleanup EXECUTION — preflight + single DELETE, phase-aware. ──
  describe('deleteRemoteBranch (Sprint 3j-B, tests 10–17)', () => {
    /** A provider set up so the merged-PR + remote-branch preflight passes (state 'merged', remote SHA == COMMIT). */
    function mergedProvider(): FakeProvider {
      const p = new FakeProvider();
      p.preflightResult = validPreflight({ state: 'merged' });
      p.remoteBranchCommit = { commitHash: COMMIT };
      return p;
    }

    it('non-APPROVED approval → Blocked before any provider call (backstop)', async () => {
      const p = new FakeProvider();
      await expect(
        new RepositoryHostingManager(p).deleteRemoteBranch(deleteInput({ approvalRef: { id: 'a1', status: ApprovalStatus.PENDING, executionPlanRef: { id: 'p1', goal: 'g' } } })),
      ).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
      expect(p.calls).toEqual([]);
    });

    it('backstop blocks: target != head, target main/base, unsafe name, bad SHA, ref mismatch (no provider call)', async () => {
      const bad: Array<Partial<Parameters<RepositoryHostingManager['deleteRemoteBranch']>[0]>> = [
        { branch: 'other' }, // != expectedHeadBranch
        { branch: 'main', expectedHeadBranch: 'main' }, // base/default
        { branch: 'bad branch', expectedHeadBranch: 'bad branch' }, // unsafe
        { expectedCommitHash: 'nope' }, // not SHA-shaped
        { pullRequestRef: { ...PR_REF, owner: 'evil' } }, // ref identity mismatch
      ];
      for (const over of bad) {
        const p = mergedProvider();
        await expect(new RepositoryHostingManager(p).deleteRemoteBranch(deleteInput(over))).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
        expect(p.calls, JSON.stringify(over)).toEqual([]);
      }
    });

    it('test 10: PR not confirmably merged (state != merged / mismatch) → Blocked, no delete', async () => {
      for (const pf of [validPreflight({ state: 'open' }), validPreflight({ state: 'merged', headBranch: 'other' }), validPreflight({ state: 'merged', headCommitHash: 'fff0000' })]) {
        const p = new FakeProvider();
        p.preflightResult = pf;
        await expect(new RepositoryHostingManager(p).deleteRemoteBranch(deleteInput())).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
        expect(p.calls).not.toContain('deleteRemoteBranch');
      }
    });

    it('test 11: remote branch absent (404) → idempotent alreadyAbsent, NO delete call', async () => {
      const p = mergedProvider();
      p.remoteBranchCommit = null;
      const r = await new RepositoryHostingManager(p).deleteRemoteBranch(deleteInput());
      expect(r).toEqual({ provider: 'github', owner: 'acme', repo: 'widgets', branch: HEAD, deleted: false, alreadyAbsent: true });
      expect(p.calls).not.toContain('deleteRemoteBranch');
    });

    it('test 12: remote branch SHA mismatch → Blocked, no delete', async () => {
      const p = mergedProvider();
      p.remoteBranchCommit = { commitHash: 'deadbeef' };
      await expect(new RepositoryHostingManager(p).deleteRemoteBranch(deleteInput())).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
      expect(p.calls).not.toContain('deleteRemoteBranch');
    });

    it('test 13: SHA match → exactly ONE delete; provider never sees the ApprovalRef', async () => {
      const p = mergedProvider();
      const r = await new RepositoryHostingManager(p).deleteRemoteBranch(deleteInput());
      expect(r.deleted).toBe(true);
      expect(r.deletedCommitHash).toBe(COMMIT);
      expect(p.calls.filter((c) => c === 'deleteRemoteBranch')).toHaveLength(1);
      expect(p.deleteInputs).toEqual([{ identity: IDENTITY, branch: HEAD, expectedCommitHash: COMMIT }]); // NO approvalRef
    });

    it('test 14: provider Blocked stays Blocked (no blanket-convert)', async () => {
      const p = mergedProvider();
      p.deleteThrowsBlocked = true;
      await expect(new RepositoryHostingManager(p).deleteRemoteBranch(deleteInput())).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
    });

    it('test 15/16: provider Unverified — and an unknown throw — become Unverified', async () => {
      const unv = mergedProvider();
      unv.deleteThrowsUnverified = true;
      await expect(new RepositoryHostingManager(unv).deleteRemoteBranch(deleteInput())).rejects.toBeInstanceOf(RemoteBranchCleanupUnverifiedError);
      const gen = mergedProvider();
      gen.deleteThrowsGeneric = true;
      await expect(new RepositoryHostingManager(gen).deleteRemoteBranch(deleteInput())).rejects.toBeInstanceOf(RemoteBranchCleanupUnverifiedError);
    });

    it('test 17: result-integrity mismatch → Unverified', async () => {
      for (const bad of [validRemoteCleanup({ branch: 'other' }), validRemoteCleanup({ deleted: true, deletedCommitHash: 'fff0000' }), validRemoteCleanup({ deleted: false, alreadyAbsent: false }), validRemoteCleanup({ owner: 'evil' })]) {
        const p = mergedProvider();
        p.deleteResult = bad;
        await expect(new RepositoryHostingManager(p).deleteRemoteBranch(deleteInput())).rejects.toBeInstanceOf(RemoteBranchCleanupUnverifiedError);
      }
    });

    it('a live read failure (preflight / getRemoteBranchCommit throws) → Blocked (never Unverified)', async () => {
      const pf = mergedProvider();
      pf.preflightThrows = true;
      await expect(new RepositoryHostingManager(pf).deleteRemoteBranch(deleteInput())).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
      const gr = mergedProvider();
      gr.getRemoteThrows = true;
      await expect(new RepositoryHostingManager(gr).deleteRemoteBranch(deleteInput())).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
    });
  });
});

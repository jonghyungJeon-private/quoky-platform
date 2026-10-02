import { describe, expect, it } from 'vitest';
import type { GitStatus, RepositoryInfo } from '../../domain';
import {
  NEW_REMOTE_BRANCH_PUSH_REMOTE,
  checkPushHead,
  newRemoteBranchUpstreamRef,
  parsePushUpstreamRef,
  pushModeOf,
  resolvePushTarget,
  verifyApprovedPushTarget,
} from './push-target-resolution';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const infoOf = (o: Partial<RepositoryInfo> = {}): RepositoryInfo => ({
  isRepository: true,
  rootPath: '/repo',
  branch: 'feature/x',
  headSha: SHA,
  detached: false,
  ...o,
});
const statusOf = (o: Partial<GitStatus> = {}): GitStatus => ({
  clean: true,
  branch: 'feature/x',
  staged: [],
  unstaged: [],
  untracked: [],
  ...o,
});
const tracking = (o: Partial<GitStatus> = {}): GitStatus => statusOf({ upstream: 'origin/feature/x', ahead: 1, behind: 0, ...o });

describe('parsePushUpstreamRef / helpers', () => {
  it('parses <remote>/<branch> with slashes in the branch; rejects malformed refs', () => {
    expect(parsePushUpstreamRef('origin/feature/x')).toEqual({ remote: 'origin', branch: 'feature/x' });
    for (const bad of ['', 'originmain', '/main', 'origin/', 'or igin/main', 'origin/ma\u0001in', `origin/${'a'.repeat(300)}`]) {
      expect(parsePushUpstreamRef(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('a new remote branch always targets origin/<branch>; a missing mode is upstream', () => {
    expect(NEW_REMOTE_BRANCH_PUSH_REMOTE).toBe('origin');
    expect(newRemoteBranchUpstreamRef('feature/x')).toBe('origin/feature/x');
    expect(pushModeOf(undefined)).toBe('upstream');
    expect(pushModeOf('upstream')).toBe('upstream');
    expect(pushModeOf('new-remote-branch')).toBe('new-remote-branch');
  });

  it('checkPushHead: detached / unborn / moved HEAD', () => {
    expect(checkPushHead(infoOf(), SHA)).toEqual({ ok: true });
    expect(checkPushHead(infoOf({ detached: true }), SHA)).toEqual({ ok: false, reason: 'detached' });
    expect(checkPushHead(infoOf({ headSha: undefined }), SHA)).toEqual({ ok: false, reason: 'detached' });
    expect(checkPushHead(infoOf({ headSha: 'f'.repeat(40) }), SHA)).toEqual({ ok: false, reason: 'head-moved' });
  });
});

describe('resolvePushTarget (approval planning, ADR-0099 D5)', () => {
  const resolve = (info: RepositoryInfo, status: GitStatus) => resolvePushTarget({ info, status, committedHash: SHA });

  it('upstream mode is unchanged: the parsed upstream with its ahead count', () => {
    expect(resolve(infoOf(), tracking({ ahead: 2 }))).toEqual({
      ok: true,
      target: { mode: 'upstream', remote: 'origin', branch: 'feature/x', upstreamRef: 'origin/feature/x', ahead: 2 },
    });
    // legacy: an upstream on main stays upstream mode here (the composition-root guard refuses the push itself)
    expect(resolve(infoOf({ branch: 'main' }), tracking({ upstream: 'origin/main' }))).toMatchObject({
      ok: true,
      target: { mode: 'upstream', branch: 'main' },
    });
  });

  it('upstream mode: unparseable upstream, nothing to push, diverged', () => {
    expect(resolve(infoOf(), tracking({ upstream: 'originmain' }))).toEqual({ ok: false, reason: 'no-upstream' });
    expect(resolve(infoOf(), tracking({ ahead: 0 }))).toEqual({ ok: false, reason: 'nothing-to-push' });
    expect(resolve(infoOf(), tracking({ ahead: undefined }))).toEqual({ ok: false, reason: 'nothing-to-push' });
    expect(resolve(infoOf(), tracking({ ahead: 1, behind: 3 }))).toEqual({ ok: false, reason: 'diverged' });
  });

  it('no upstream on feature/x → new-remote-branch origin/feature/x (no ahead count)', () => {
    expect(resolve(infoOf(), statusOf())).toEqual({
      ok: true,
      target: { mode: 'new-remote-branch', remote: 'origin', branch: 'feature/x', upstreamRef: 'origin/feature/x' },
    });
  });

  it('no upstream on main / master (any case) → protected-branch', () => {
    for (const branch of ['main', 'master', 'Main', 'MASTER']) {
      expect(resolve(infoOf({ branch }), statusOf()), branch).toEqual({ ok: false, reason: 'protected-branch' });
    }
  });

  it('no upstream on an unsafe branch name → unsafe-name; an empty / padded name → detached', () => {
    for (const branch of ['feature..x', 'feat:x', 'x.lock', '-x', 'a//b']) {
      expect(resolve(infoOf({ branch }), statusOf()), branch).toEqual({ ok: false, reason: 'unsafe-name' });
    }
    expect(resolve(infoOf({ branch: '' }), statusOf())).toEqual({ ok: false, reason: 'detached' });
    expect(resolve(infoOf({ branch: ' feature/x' }), statusOf())).toEqual({ ok: false, reason: 'detached' });
  });

  it('HEAD and a clean tree are checked first in both modes', () => {
    expect(resolve(infoOf({ detached: true, branch: '' }), statusOf())).toEqual({ ok: false, reason: 'detached' });
    expect(resolve(infoOf({ headSha: 'f'.repeat(40) }), statusOf())).toEqual({ ok: false, reason: 'head-moved' });
    for (const dirty of [{ staged: ['a'] }, { unstaged: ['a'] }, { untracked: ['a'] }]) {
      expect(resolve(infoOf(), statusOf({ clean: false, ...dirty }))).toEqual({ ok: false, reason: 'dirty' });
      expect(resolve(infoOf(), tracking({ clean: false, ...dirty }))).toEqual({ ok: false, reason: 'dirty' });
    }
  });
});

describe('verifyApprovedPushTarget (execution drift checks, ADR-0099 D5)', () => {
  const upstreamApproved = { mode: 'upstream' as const, remote: 'origin', branch: 'feature/x', upstreamRef: 'origin/feature/x', commitHash: SHA };
  const newApproved = { mode: 'new-remote-branch' as const, remote: 'origin', branch: 'feature/x', upstreamRef: 'origin/feature/x', commitHash: SHA };

  it('upstream mode (and a legacy anchor without mode): the live upstream must equal the approved one', () => {
    for (const approved of [upstreamApproved, { ...upstreamApproved, mode: undefined }]) {
      expect(verifyApprovedPushTarget({ info: infoOf(), status: tracking(), approved })).toEqual({
        ok: true,
        target: { mode: 'upstream', remote: 'origin', branch: 'feature/x', upstreamRef: 'origin/feature/x', ahead: 1 },
      });
      expect(verifyApprovedPushTarget({ info: infoOf(), status: statusOf(), approved })).toEqual({ ok: false, reason: 'drift' });
      expect(verifyApprovedPushTarget({ info: infoOf(), status: tracking({ upstream: 'origin/other' }), approved })).toEqual({
        ok: false,
        reason: 'drift',
      });
      expect(verifyApprovedPushTarget({ info: infoOf(), status: tracking({ ahead: 0 }), approved })).toEqual({ ok: false, reason: 'nothing-to-push' });
      expect(verifyApprovedPushTarget({ info: infoOf(), status: tracking({ behind: 1 }), approved })).toEqual({ ok: false, reason: 'diverged' });
    }
  });

  it('new-remote-branch: still on the approved branch with no upstream → the approved target', () => {
    expect(verifyApprovedPushTarget({ info: infoOf(), status: statusOf(), approved: newApproved })).toEqual({
      ok: true,
      target: { mode: 'new-remote-branch', remote: 'origin', branch: 'feature/x', upstreamRef: 'origin/feature/x' },
    });
  });

  it('new-remote-branch: an upstream equal to the synthesized ref is accepted with ahead/behind checks', () => {
    expect(verifyApprovedPushTarget({ info: infoOf(), status: tracking(), approved: newApproved })).toMatchObject({
      ok: true,
      target: { mode: 'new-remote-branch', ahead: 1 },
    });
    expect(verifyApprovedPushTarget({ info: infoOf(), status: tracking({ ahead: 0 }), approved: newApproved })).toEqual({
      ok: false,
      reason: 'nothing-to-push',
    });
    expect(verifyApprovedPushTarget({ info: infoOf(), status: tracking({ behind: 2 }), approved: newApproved })).toEqual({
      ok: false,
      reason: 'diverged',
    });
  });

  it('new-remote-branch drift: branch switched, other upstream appeared, HEAD moved, dirty', () => {
    expect(verifyApprovedPushTarget({ info: infoOf({ branch: 'feature/y' }), status: statusOf(), approved: newApproved })).toEqual({
      ok: false,
      reason: 'drift',
    });
    expect(verifyApprovedPushTarget({ info: infoOf(), status: tracking({ upstream: 'origin/other' }), approved: newApproved })).toEqual({
      ok: false,
      reason: 'drift',
    });
    expect(verifyApprovedPushTarget({ info: infoOf({ headSha: 'f'.repeat(40) }), status: statusOf(), approved: newApproved })).toEqual({
      ok: false,
      reason: 'head-moved',
    });
    expect(verifyApprovedPushTarget({ info: infoOf(), status: statusOf({ untracked: ['n.ts'] }), approved: newApproved })).toEqual({
      ok: false,
      reason: 'dirty',
    });
  });

  it('new-remote-branch: a tampered persisted target (other remote, mismatched ref, protected or unsafe branch) is refused', () => {
    const cases = [
      { ...newApproved, remote: 'upstream', upstreamRef: 'upstream/feature/x' },
      { ...newApproved, upstreamRef: 'origin/other' },
      { ...newApproved, branch: 'feature..x', upstreamRef: 'origin/feature..x' },
    ];
    for (const approved of cases) {
      expect(verifyApprovedPushTarget({ info: infoOf({ branch: approved.branch }), status: statusOf(), approved })).toEqual({
        ok: false,
        reason: 'drift',
      });
    }
    const protectedTarget = { ...newApproved, branch: 'main', upstreamRef: 'origin/main' };
    expect(verifyApprovedPushTarget({ info: infoOf({ branch: 'main' }), status: statusOf(), approved: protectedTarget })).toEqual({
      ok: false,
      reason: 'protected-branch',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { BranchCleanupBlockedError, GitMainSyncBlockedError, GitPushBlockedError } from '@quoky/core';
import type { GitProvider, RepositoryInfo } from '@quoky/core';
import { PersonalGitGuard, PersonalGitPolicyError } from './personal-git-guard';

const SHA = 'a'.repeat(40);

/** Fake inner provider recording every invoked operation; nothing spawns real git. */
function harness(info: Partial<RepositoryInfo> | Error = { branch: 'feature/x', detached: false }) {
  const invoked: string[] = [];
  const inner: GitProvider = {
    kind: 'fake-git',
    async isRepository() { invoked.push('isRepository'); return true; },
    async info(rootPath) {
      invoked.push('info');
      if (info instanceof Error) throw info;
      return { isRepository: true, rootPath, branch: 'feature/x', detached: false, ...info };
    },
    async status() {
      invoked.push('status');
      return { clean: true } as never;
    },
    async diff() { invoked.push('diff'); return { diff: '' } as never; },
    async commitFiles(_root, files, message) {
      invoked.push('commitFiles');
      return { commitHash: SHA, committedFiles: files, message };
    },
    async pushApprovedCommit(_root, remote, branch, commitHash) {
      invoked.push('pushApprovedCommit');
      return { remote, branch, upstreamRef: `${remote}/${branch}`, commitHash };
    },
    async getRemoteRefCommit() { invoked.push('getRemoteRefCommit'); return { commitHash: SHA }; },
    async getLocalRefCommit() { invoked.push('getLocalRefCommit'); return { commitHash: SHA }; },
    async syncMainFastForward(_root, _remote, branch) {
      invoked.push('syncMainFastForward');
      return {
        branch, syncMode: 'ref-only', workingTreeUpdated: false, syncedCommitHash: SHA, previousMainCommit: SHA,
      };
    },
    async isAncestor() { invoked.push('isAncestor'); return true; },
    async deleteMergedLocalBranch(_root, branch) {
      invoked.push('deleteMergedLocalBranch');
      return { branch, deleted: true, alreadyAbsent: false };
    },
  };
  return { inner, invoked };
}

describe('PersonalGitGuard — remote disabled (ADR-0094)', () => {
  it('refuses push with the typed pre-mutation error before reaching the inner provider', async () => {
    const { inner, invoked } = harness();
    const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
    await expect(guard.pushApprovedCommit('/r', 'origin', 'feature/x', SHA)).rejects.toBeInstanceOf(GitPushBlockedError);
    expect(invoked).toEqual([]);
  });

  it('refuses remote ref reads and main sync with GitMainSyncBlockedError', async () => {
    const { inner, invoked } = harness();
    const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
    await expect(guard.getRemoteRefCommit('/r', 'origin', 'main')).rejects.toBeInstanceOf(GitMainSyncBlockedError);
    await expect(guard.syncMainFastForward('/r', 'origin', 'main', SHA, SHA)).rejects.toBeInstanceOf(GitMainSyncBlockedError);
    expect(invoked).toEqual([]);
  });

  it('refuses post-merge local branch cleanup with BranchCleanupBlockedError', async () => {
    const { inner, invoked } = harness();
    const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
    await expect(guard.deleteMergedLocalBranch('/r', 'feature/x', SHA)).rejects.toBeInstanceOf(BranchCleanupBlockedError);
    expect(invoked).toEqual([]);
  });

  it('keeps the refusal messages free of paths, remotes and branch names', async () => {
    const { inner } = harness();
    const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
    const err = await guard.pushApprovedCommit('/secret/root', 'origin', 'feature/secret', SHA).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/secret|origin/);
  });
});

describe('PersonalGitGuard — remote enabled', () => {
  it('delegates push, remote ref read, sync and cleanup', async () => {
    const { inner, invoked } = harness();
    const guard = new PersonalGitGuard(inner, { remoteEnabled: true });
    await guard.pushApprovedCommit('/r', 'origin', 'feature/x', SHA);
    await guard.getRemoteRefCommit('/r', 'origin', 'main');
    await guard.syncMainFastForward('/r', 'origin', 'main', SHA, SHA);
    await guard.deleteMergedLocalBranch('/r', 'feature/x', SHA);
    expect(invoked).toEqual(['pushApprovedCommit', 'getRemoteRefCommit', 'syncMainFastForward', 'deleteMergedLocalBranch']);
  });

  it('still refuses commits on main', async () => {
    const { inner, invoked } = harness({ branch: 'main' });
    const guard = new PersonalGitGuard(inner, { remoteEnabled: true });
    await expect(guard.commitFiles('/r', ['a.ts'], 'msg')).rejects.toBeInstanceOf(PersonalGitPolicyError);
    expect(invoked).toEqual(['info']);
  });
});

describe('PersonalGitGuard — commitFiles branch policy', () => {
  it.each(['main', 'master', 'Main', 'MASTER'])('refuses a commit on %s before git commit runs', async (branch) => {
    const { inner, invoked } = harness({ branch });
    const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
    await expect(guard.commitFiles('/r', ['a.ts'], 'msg')).rejects.toMatchObject({
      name: 'PersonalGitPolicyError',
      message: 'PERSONAL_GIT_PROTECTED_BRANCH_COMMIT',
    });
    expect(invoked).not.toContain('commitFiles');
  });

  it('refuses a detached HEAD, an empty branch, and an undeterminable branch', async () => {
    for (const info of [{ branch: '', detached: true }, { branch: 'feature/x', detached: true }, { branch: '' }, new Error('git failed')]) {
      const { inner, invoked } = harness(info);
      const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
      await expect(guard.commitFiles('/r', ['a.ts'], 'msg')).rejects.toBeInstanceOf(PersonalGitPolicyError);
      expect(invoked).not.toContain('commitFiles');
    }
  });

  it('delegates a commit on a feature branch and returns the inner result', async () => {
    const { inner, invoked } = harness({ branch: 'feature/x' });
    const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
    await expect(guard.commitFiles('/r', ['a.ts'], 'msg')).resolves.toEqual({
      commitHash: SHA, committedFiles: ['a.ts'], message: 'msg',
    });
    expect(invoked).toEqual(['info', 'commitFiles']);
  });

  it('does not treat branch names that merely contain main as protected', async () => {
    const { inner } = harness({ branch: 'maintenance' });
    const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
    await expect(guard.commitFiles('/r', ['a.ts'], 'msg')).resolves.toMatchObject({ commitHash: SHA });
  });
});

describe('PersonalGitGuard — read-only delegation', () => {
  it('delegates read-only methods regardless of the remote flag and exposes the inner kind', async () => {
    const { inner, invoked } = harness();
    const guard = new PersonalGitGuard(inner, { remoteEnabled: false });
    expect(guard.kind).toBe('fake-git');
    await guard.isRepository('/r');
    await guard.info('/r');
    await guard.status('/r');
    await guard.diff('/r');
    await guard.getLocalRefCommit('/r', 'main');
    await guard.isAncestor('/r', SHA, SHA);
    expect(invoked).toEqual(['isRepository', 'info', 'status', 'diff', 'getLocalRefCommit', 'isAncestor']);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitMainSyncBlockedError, GitMainSyncUnverifiedError, GitPushBlockedError } from '@quoky/core';
import type { GitProvider } from '@quoky/core';
import type { GitRunner } from '@quoky/git-local';
import { assertHttpsGithubRemote, GitHubAppGitProvider } from './github-app-git-provider';
import type { CredentialedSpawn } from './github-app-git-provider';

const SHA40 = 'a'.repeat(40);
const SHA40B = 'b'.repeat(40);

function tmpAskpassCount(): number {
  return readdirSync(tmpdir()).filter((n) => n.startsWith('quoky-askpass-')).length;
}

/**
 * Build a decorator over a fake inner GitProvider that (a) records which inner ops were invoked and (b) actually
 * CALLS the injected runner for remote ops (as LocalGitProvider would), so a recording `spawn` can verify the argv,
 * child env, and askpass file. Nothing spawns real git.
 */
function harness(
  over: {
    tokenSource?: () => Promise<string>;
    readRemoteUrl?: (rootPath: string, remote: string, env: NodeJS.ProcessEnv) => string | readonly string[];
    /** Use the provider's real default remote read (local `git remote get-url`, no network). */
    realRemoteRead?: boolean;
    inner?: Partial<GitProvider>;
  } = {},
) {
  const invoked: string[] = [];
  const commitOptions: Array<{ newFiles?: string[] } | undefined> = [];
  const branchCalls: string[][] = [];
  const spawns: Array<{ args: string[]; env: NodeJS.ProcessEnv; askpass: string }> = [];
  const spawn: CredentialedSpawn = (args, _opts, env) => {
    let askpass = '';
    const p = env.GIT_ASKPASS;
    if (typeof p === 'string') {
      try {
        askpass = readFileSync(p, 'utf8');
      } catch {
        askpass = '';
      }
    }
    spawns.push({ args, env, askpass });
    return { code: 0, stdout: '', stderr: '', timedOut: false, failed: false };
  };
  const makeLocalGit = (runner?: GitRunner): GitProvider =>
    ({
      kind: 'local-git',
      isRepository: async () => {
        invoked.push('isRepository');
        return true;
      },
      info: async (rootPath: string) => {
        invoked.push('info');
        return { isRepository: true, rootPath, branch: 'main', detached: false };
      },
      status: async () => {
        invoked.push('status');
        return { clean: true, branch: 'main', staged: [], unstaged: [], untracked: [] };
      },
      diff: async () => {
        invoked.push('diff');
        return { files: [], unified: '', truncated: false };
      },
      commitFiles: async (_rootPath: string, files: string[], message: string, options?: { newFiles?: string[] }) => {
        invoked.push('commitFiles');
        commitOptions.push(options);
        return { commitHash: 'abc1234', committedFiles: files, message };
      },
      createBranch: async (_rootPath: string, branch: string, expectedHeadSha: string) => {
        invoked.push('createBranch');
        branchCalls.push(['createBranch', branch, expectedHeadSha]);
        return { branch, headSha: 'abc1234', created: true };
      },
      switchBranch: async (_rootPath: string, branch: string) => {
        invoked.push('switchBranch');
        branchCalls.push(['switchBranch', branch]);
        return { branch, headSha: 'abc1234', created: false };
      },
      pushApprovedCommit: async (rootPath: string, remote: string, branch: string, commitHash: string) => {
        invoked.push('pushApprovedCommit');
        runner?.(['--no-pager', 'push', remote, `HEAD:refs/heads/${branch}`], { cwd: rootPath, timeoutMs: 5000 });
        return { remote, branch, upstreamRef: `${remote}/${branch}`, commitHash };
      },
      getRemoteRefCommit: async (rootPath: string, remote: string, branch: string) => {
        invoked.push('getRemoteRefCommit');
        runner?.(['--no-pager', 'ls-remote', '--exit-code', remote, `refs/heads/${branch}`], { cwd: rootPath, timeoutMs: 5000 });
        return { commitHash: 'abc1234' };
      },
      getLocalRefCommit: async () => {
        invoked.push('getLocalRefCommit');
        return { commitHash: 'abc1234' };
      },
      syncMainFastForward: async (rootPath: string, remote: string, branch: string) => {
        invoked.push('syncMainFastForward');
        runner?.(['--no-pager', 'fetch', '--no-tags', remote, branch], { cwd: rootPath, timeoutMs: 5000 });
        return {
          branch,
          syncMode: 'ref-only' as const,
          workingTreeUpdated: false,
          syncedCommitHash: 'abc1234',
          previousMainCommit: 'def5678',
          alreadyUpToDate: false,
        };
      },
      isAncestor: async () => {
        invoked.push('isAncestor');
        return true;
      },
      deleteMergedLocalBranch: async (_rootPath: string, branch: string) => {
        invoked.push('deleteMergedLocalBranch');
        return { branch, deleted: true, alreadyAbsent: false, deletedCommitHash: 'abc1234' };
      },
      ...over.inner,
    }) satisfies GitProvider;
  const provider = new GitHubAppGitProvider({
    makeLocalGit,
    tokenSource: over.tokenSource ?? (async () => 'ghs_SENTINEL'),
    ...(over.realRemoteRead ? {} : { readRemoteUrl: over.readRemoteUrl ?? (() => 'https://github.com/acme/widgets.git') }),
    spawn,
  });
  return { provider, invoked, spawns, commitOptions, branchCalls };
}

describe('GitHubAppGitProvider (Sprint 4b, ADR-0061 + review RC1/RC3/RC4)', () => {
  it('HTTPS github.com remote → push proceeds; token ONLY in child env, never in argv; askpass has no token literal', async () => {
    const { provider, invoked, spawns } = harness({ tokenSource: async () => 'ghs_SENTINEL' });
    const res = await provider.pushApprovedCommit('/repo', 'origin', 'uat/x', 'abc1234');
    expect(res.branch).toBe('uat/x');
    expect(invoked).toContain('pushApprovedCommit');
    expect(spawns.length).toBe(1);
    const s = spawns[0]!;
    expect(s.env.GIT_APP_TOKEN).toBe('ghs_SENTINEL');
    expect(s.env.GIT_ASKPASS).toBeTruthy();
    // token is NOT in argv
    expect(s.args).not.toContain('ghs_SENTINEL');
    expect(JSON.stringify(s.args)).not.toContain('ghs_SENTINEL');
    // askpass helper references the env var, contains NO token literal
    expect(s.askpass).toContain('$GIT_APP_TOKEN');
    expect(s.askpass).not.toContain('ghs_SENTINEL');
  });

  it('resets ambient credential helpers (e.g. osxkeychain) so they cannot shadow or persist the App token', async () => {
    process.env.GIT_CONFIG_COUNT = '2';
    process.env.GIT_CONFIG_KEY_0 = 'credential.helper';
    process.env.GIT_CONFIG_VALUE_0 = 'osxkeychain';
    process.env.GIT_CONFIG_KEY_1 = 'user.name';
    process.env.GIT_CONFIG_VALUE_1 = 'x';
    try {
      const { provider, spawns } = harness({ tokenSource: async () => 'ghs_SENTINEL' });
      await provider.pushApprovedCommit('/repo', 'origin', 'uat/x', 'abc1234');
      const env = spawns[0]!.env;
      expect(env.GIT_CONFIG_COUNT).toBe('1');
      expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
      expect(env.GIT_CONFIG_VALUE_0).toBe('');
      expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
      expect(env.GIT_CONFIG_VALUE_1).toBeUndefined();
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1']) {
        delete process.env[k];
      }
    }
  });

  it('drops inherited GIT_CONFIG_PARAMETERS (applied after GIT_CONFIG_COUNT) and preflights under the same env', async () => {
    process.env.GIT_CONFIG_PARAMETERS = "'credential.helper'='osxkeychain'";
    try {
      const seen: NodeJS.ProcessEnv[] = [];
      const { provider, spawns } = harness({
        readRemoteUrl: (_root, _remote, env) => {
          seen.push(env);
          return 'https://github.com/acme/widgets.git';
        },
      });
      await provider.pushApprovedCommit('/repo', 'origin', 'uat/x', 'abc1234');
      expect(spawns[0]!.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(seen[0]!.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(seen[0]!.GIT_CONFIG_KEY_0).toBe('credential.helper');
      expect(seen[0]!.GIT_CONFIG_VALUE_0).toBe('');
      expect(seen[0]!.GIT_APP_TOKEN).toBeUndefined();
    } finally {
      delete process.env.GIT_CONFIG_PARAMETERS;
    }
  });

  it('checks every returned remote URL — an SSH push URL among HTTPS fetch URLs is blocked before any spawn', async () => {
    const { provider, spawns } = harness({
      readRemoteUrl: () => ['https://github.com/acme/widgets.git', 'git@github.com:acme/widgets.git'],
    });
    await expect(provider.pushApprovedCommit('/repo', 'origin', 'uat/x', 'abc1234')).rejects.toBeInstanceOf(
      GitPushBlockedError,
    );
    expect(spawns.length).toBe(0);
  });

  describe('default remote read (real local git, no network)', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const withRepo = async (setup: (dir: string) => void, body: (dir: string) => Promise<void>) => {
      const dir = mkdtempSync(join(tmpdir(), 'quoky-remote-read-'));
      try {
        git(dir, 'init', '-q');
        setup(dir);
        await body(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('HTTPS fetch + push URLs → push proceeds', async () => {
      await withRepo(
        (dir) => git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'),
        async (dir) => {
          const { provider, spawns } = harness({ realRemoteRead: true });
          await provider.pushApprovedCommit(dir, 'origin', 'uat/x', 'abc1234');
          expect(spawns.length).toBe(1);
        },
      );
    });

    it('an SSH pushurl behind an HTTPS url is blocked (push would otherwise use ambient SSH credentials)', async () => {
      await withRepo(
        (dir) => {
          git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
          git(dir, 'config', 'remote.origin.pushurl', 'git@github.com:acme/widgets.git');
        },
        async (dir) => {
          const { provider, spawns } = harness({ realRemoteRead: true });
          await expect(provider.pushApprovedCommit(dir, 'origin', 'uat/x', 'abc1234')).rejects.toBeInstanceOf(
            GitPushBlockedError,
          );
          expect(spawns.length).toBe(0);
        },
      );
    });

    it('an SSH pushurl does not block fetch-only ops (ls-remote, main sync) — they use only the fetch URL', async () => {
      await withRepo(
        (dir) => {
          git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
          git(dir, 'config', 'remote.origin.pushurl', 'git@github.com:acme/widgets.git');
        },
        async (dir) => {
          const { provider, invoked } = harness({ realRemoteRead: true });
          await provider.getRemoteRefCommit(dir, 'origin', 'main');
          await provider.syncMainFastForward(dir, 'origin', 'main', SHA40, SHA40B);
          expect(invoked).toEqual(expect.arrayContaining(['getRemoteRefCommit', 'syncMainFastForward']));
        },
      );
    });

    it('an SSH fetch URL still blocks fetch-only ops', async () => {
      await withRepo(
        (dir) => git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'),
        async (dir) => {
          const { provider, invoked } = harness({ realRemoteRead: true });
          await expect(provider.getRemoteRefCommit(dir, 'origin', 'main')).rejects.toThrow();
          await expect(provider.syncMainFastForward(dir, 'origin', 'main', SHA40, SHA40B)).rejects.toBeInstanceOf(
            GitMainSyncBlockedError,
          );
          expect(invoked).not.toContain('getRemoteRefCommit');
          expect(invoked).not.toContain('syncMainFastForward');
        },
      );
    });

    it('an inherited env insteadOf rewrite (SSH → HTTPS) does not make an SSH origin pass the preflight', async () => {
      process.env.GIT_CONFIG_PARAMETERS = "'url.https://github.com/.insteadof'='git@github.com:'";
      try {
        await withRepo(
          (dir) => git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'),
          async (dir) => {
            const { provider, spawns } = harness({ realRemoteRead: true });
            await expect(provider.pushApprovedCommit(dir, 'origin', 'uat/x', 'abc1234')).rejects.toBeInstanceOf(
              GitPushBlockedError,
            );
            expect(spawns.length).toBe(0);
          },
        );
      } finally {
        delete process.env.GIT_CONFIG_PARAMETERS;
      }
    });
  });

  it('does not mutate process.env and leaves no temp askpass dir after a remote op', async () => {
    const before = JSON.stringify(process.env);
    const dirsBefore = tmpAskpassCount();
    const { provider } = harness();
    await provider.pushApprovedCommit('/repo', 'origin', 'uat/x', 'abc1234');
    expect(JSON.stringify(process.env)).toBe(before);
    expect(process.env.GIT_APP_TOKEN).toBeUndefined();
    expect(process.env.GIT_ASKPASS).toBeUndefined();
    expect(tmpAskpassCount()).toBe(dirsBefore);
  });

  const blockedRemotes: Array<[string, string]> = [
    ['scp-like SSH', 'git@github.com:acme/widgets.git'],
    ['ssh:// URL', 'ssh://git@github.com/acme/widgets.git'],
    ['non-GitHub HTTPS', 'https://gitlab.com/acme/widgets.git'],
    ['credential-embedding HTTPS', 'https://x-access-token:tok@github.com/acme/widgets.git'],
  ];
  for (const [label, url] of blockedRemotes) {
    it(`blocks a ${label} remote before any git spawn (push → GitPushBlockedError; not attempted)`, async () => {
      const { provider, invoked, spawns } = harness({ readRemoteUrl: () => url });
      await expect(provider.pushApprovedCommit('/repo', 'origin', 'uat/x', 'abc1234')).rejects.toBeInstanceOf(
        GitPushBlockedError,
      );
      expect(invoked).not.toContain('pushApprovedCommit');
      expect(spawns.length).toBe(0);
    });
  }

  it('blocks an unreadable remote (readRemoteUrl throws) before any git spawn (push → GitPushBlockedError)', async () => {
    const { provider, invoked, spawns } = harness({
      readRemoteUrl: () => {
        throw new Error('remote unreadable');
      },
    });
    await expect(provider.pushApprovedCommit('/repo', 'origin', 'uat/x', 'abc1234')).rejects.toBeInstanceOf(
      GitPushBlockedError,
    );
    expect(invoked).not.toContain('pushApprovedCommit');
    expect(spawns.length).toBe(0);
  });

  it('getRemoteRefCommit blocked on an SSH remote → throws (read throw the manager maps to Blocked); not attempted', async () => {
    const { provider, invoked, spawns } = harness({ readRemoteUrl: () => 'git@github.com:acme/widgets.git' });
    await expect(provider.getRemoteRefCommit('/repo', 'origin', 'main')).rejects.toThrow();
    expect(invoked).not.toContain('getRemoteRefCommit');
    expect(spawns.length).toBe(0);
  });

  it('syncMainFastForward blocked on an SSH remote → GitMainSyncBlockedError (not synchronized); not attempted', async () => {
    const { provider, invoked, spawns } = harness({ readRemoteUrl: () => 'ssh://git@github.com/acme/widgets.git' });
    await expect(provider.syncMainFastForward('/repo', 'origin', 'main', SHA40, SHA40B)).rejects.toBeInstanceOf(
      GitMainSyncBlockedError,
    );
    expect(invoked).not.toContain('syncMainFastForward');
    expect(spawns.length).toBe(0);
  });

  it('preserves a typed GitMainSyncUnverifiedError raised by the inner provider (at/after mutation stays Unverified)', async () => {
    const { provider } = harness({
      inner: {
        syncMainFastForward: async () => {
          throw new GitMainSyncUnverifiedError('boom');
        },
      },
    });
    await expect(provider.syncMainFastForward('/repo', 'origin', 'main', SHA40, SHA40B)).rejects.toBeInstanceOf(
      GitMainSyncUnverifiedError,
    );
  });

  it('token mint failure → push GitPushBlockedError; inner push not attempted; no spawn', async () => {
    const { provider, invoked, spawns } = harness({
      tokenSource: async () => {
        throw new Error('mint failed');
      },
    });
    await expect(provider.pushApprovedCommit('/repo', 'origin', 'uat/x', 'abc1234')).rejects.toBeInstanceOf(
      GitPushBlockedError,
    );
    expect(invoked).not.toContain('pushApprovedCommit');
    expect(spawns.length).toBe(0);
  });

  it('LOCAL ops delegate without minting a token, reading the remote, or spawning', async () => {
    let minted = 0;
    let readUrl = 0;
    const { provider, spawns } = harness({
      tokenSource: async () => {
        minted += 1;
        return 'ghs_x';
      },
      readRemoteUrl: () => {
        readUrl += 1;
        return 'https://github.com/acme/widgets.git';
      },
    });
    await provider.status('/repo');
    await provider.commitFiles('/repo', ['a.ts'], 'msg');
    await provider.deleteMergedLocalBranch('/repo', 'feature/x', SHA40);
    expect(minted).toBe(0);
    expect(readUrl).toBe(0);
    expect(spawns.length).toBe(0);
  });

  describe('assertHttpsGithubRemote', () => {
    it('accepts an HTTPS github.com remote (with or without .git)', () => {
      expect(() => assertHttpsGithubRemote('https://github.com/acme/widgets.git')).not.toThrow();
      expect(() => assertHttpsGithubRemote('https://github.com/acme/widgets')).not.toThrow();
    });
    it('blocks scp-like SSH, ssh://, non-github host, non-https scheme, and credential-embedding URLs', () => {
      expect(() => assertHttpsGithubRemote('git@github.com:acme/widgets.git')).toThrow();
      expect(() => assertHttpsGithubRemote('ssh://git@github.com/acme/widgets.git')).toThrow();
      expect(() => assertHttpsGithubRemote('https://gitlab.com/acme/widgets.git')).toThrow();
      expect(() => assertHttpsGithubRemote('http://github.com/acme/widgets.git')).toThrow();
      expect(() => assertHttpsGithubRemote('https://x-access-token:tok@github.com/acme/widgets.git')).toThrow();
    });
  });
});

describe('GitHubAppGitProvider — local commit/branch forwarding (ADR-0099)', () => {
  it('forwards commitFiles newFiles to the local provider with no token mint, spawn or remote read', async () => {
    const tokenSource = vi.fn(async () => 'ghs_SENTINEL');
    const readRemoteUrl = vi.fn(() => 'https://github.com/acme/widgets.git');
    const { provider, invoked, spawns, commitOptions } = harness({ tokenSource, readRemoteUrl });
    await provider.commitFiles('/repo', ['a.ts', 'n.ts'], 'msg', { newFiles: ['n.ts'] });
    expect(invoked).toEqual(['commitFiles']);
    expect(commitOptions).toEqual([{ newFiles: ['n.ts'] }]);
    expect(tokenSource).not.toHaveBeenCalled();
    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(spawns).toEqual([]);
  });

  it('calls the local commitFiles without options when none were given', async () => {
    const spy = vi.fn(async (_r: string, files: string[], message: string) => ({
      commitHash: 'abc1234', committedFiles: files, message,
    }));
    const { provider } = harness({ inner: { commitFiles: spy as unknown as GitProvider['commitFiles'] } });
    await provider.commitFiles('/repo', ['a.ts'], 'msg');
    expect(spy).toHaveBeenCalledWith('/repo', ['a.ts'], 'msg');
  });

  it('createBranch and switchBranch delegate locally and never mint a token, read the remote or spawn', async () => {
    const tokenSource = vi.fn(async () => 'ghs_SENTINEL');
    const readRemoteUrl = vi.fn(() => 'https://github.com/acme/widgets.git');
    const { provider, invoked, spawns, branchCalls } = harness({ tokenSource, readRemoteUrl });
    await expect(provider.createBranch('/repo', 'feature/x', SHA40)).resolves.toMatchObject({ branch: 'feature/x', created: true });
    await expect(provider.switchBranch('/repo', 'feature/y')).resolves.toMatchObject({ branch: 'feature/y', created: false });
    expect(invoked).toEqual(['createBranch', 'switchBranch']);
    expect(branchCalls).toEqual([['createBranch', 'feature/x', SHA40], ['switchBranch', 'feature/y']]);
    expect(tokenSource).not.toHaveBeenCalled();
    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(spawns).toEqual([]);
  });

  it('branch operations still work when the token source would fail (no credential path at all)', async () => {
    const { provider } = harness({
      tokenSource: async () => { throw new Error('mint failed'); },
      readRemoteUrl: () => { throw new Error('no remote'); },
    });
    await expect(provider.createBranch('/repo', 'feature/x', SHA40)).resolves.toMatchObject({ created: true });
    await expect(provider.switchBranch('/repo', 'feature/x')).resolves.toMatchObject({ created: false });
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitMainSyncBlockedError, GitMainSyncUnverifiedError, GitPushBlockedError } from '@quoky/core';
import type { GitProvider, RepositoryIdentity } from '@quoky/core';
import type { GitRunner } from '@quoky/git-local';
import { assertHttpsGithubRemote, GitHubAppGitProvider } from './github-app-git-provider';
import type { CredentialedSpawn } from './github-app-git-provider';
import { RepositoryAllowlist } from './repository-allowlist';

/** The default allowlist of the harness: the repository every pre-ADR-0109 test remote names. */
const ACME_WIDGETS: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'widgets' };

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
    tokenSource?: (identity: RepositoryIdentity) => Promise<string>;
    readRemoteUrl?: (rootPath: string, remote: string, env: NodeJS.ProcessEnv) => string | readonly string[];
    /** ADR-0109: the repository allowlist (default: acme/widgets only). */
    allowlist?: readonly RepositoryIdentity[];
    /** ADR-0109 review P2: the visible insteadOf/pushInsteadOf values (default none; real git when realRemoteRead). */
    readUrlRewrites?: (rootPath: string, env: NodeJS.ProcessEnv) => readonly string[];
    /** Ambient-credential mode (no token source at all). */
    ambient?: boolean;
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
  const trackingUpdates: string[] = [];
  const provider = new GitHubAppGitProvider({
    makeLocalGit,
    ...(over.ambient ? {} : { tokenSource: over.tokenSource ?? (async () => 'ghs_SENTINEL') }),
    allowlist: new RepositoryAllowlist(over.allowlist ?? [ACME_WIDGETS]),
    ...(over.readUrlRewrites ? { readUrlRewrites: over.readUrlRewrites } : over.realRemoteRead ? {} : { readUrlRewrites: () => [] }),
    updateTrackingRef: (_root, remote, branch) => {
      trackingUpdates.push(`${remote}/${branch}`);
    },
    ...(over.realRemoteRead ? {} : { readRemoteUrl: over.readRemoteUrl ?? (() => 'https://github.com/acme/widgets.git') }),
    spawn,
  });
  return { provider, invoked, spawns, commitOptions, branchCalls, trackingUpdates };
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

describe('GitHubAppGitProvider — multi-repository allowlist (ADR-0109 D2/D3)', () => {
  const GADGETS: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'gadgets' };
  const recordingSource = () => {
    const minted: RepositoryIdentity[] = [];
    const tokenSource = vi.fn(async (identity: RepositoryIdentity) => {
      minted.push(identity);
      return `minted-for-${identity.repo}`;
    });
    return { minted, tokenSource };
  };

  it('mints exactly for the repository the remote names — two allowlisted repositories, one token each', async () => {
    const { minted, tokenSource } = recordingSource();
    const urls: Record<string, string> = {
      '/work/widgets': 'https://github.com/acme/widgets.git',
      '/work/gadgets': 'https://github.com/acme/gadgets',
    };
    const { provider, spawns } = harness({
      tokenSource,
      allowlist: [ACME_WIDGETS, GADGETS],
      readRemoteUrl: (root) => urls[root] ?? '',
    });
    await provider.pushApprovedCommit('/work/widgets', 'origin', 'feature/a', 'abc1234');
    await provider.pushApprovedCommit('/work/gadgets', 'origin', 'feature/b', 'abc1234');
    expect(minted).toEqual([ACME_WIDGETS, GADGETS]);
    expect(spawns.map((s) => s.env.GIT_APP_TOKEN)).toEqual(['minted-for-widgets', 'minted-for-gadgets']);
  });

  it('two remotes naming the same allowlisted repository in another case resolve to the allowlist spelling', async () => {
    const { minted, tokenSource } = recordingSource();
    const { provider } = harness({ tokenSource, readRemoteUrl: () => 'https://github.com/ACME/Widgets.git' });
    await provider.getRemoteRefCommit('/repo', 'origin', 'main');
    expect(minted).toEqual([ACME_WIDGETS]);
  });

  it('a non-allowlisted HTTPS github.com remote is blocked before any mint or spawn', async () => {
    const { tokenSource } = recordingSource();
    const { provider, invoked, spawns } = harness({ tokenSource, readRemoteUrl: () => 'https://github.com/acme/other-repo.git' });
    await expect(provider.pushApprovedCommit('/repo', 'origin', 'feature/a', 'abc1234')).rejects.toBeInstanceOf(GitPushBlockedError);
    await expect(provider.getRemoteRefCommit('/repo', 'origin', 'main')).rejects.toThrow(/not on the allowlist/);
    await expect(provider.syncMainFastForward('/repo', 'origin', 'main', SHA40, SHA40B)).rejects.toBeInstanceOf(GitMainSyncBlockedError);
    expect(tokenSource).not.toHaveBeenCalled();
    expect(spawns).toEqual([]);
    expect(invoked).toEqual([]);
  });

  it('fetch and push URLs naming two repositories (even both allowlisted) are blocked before any mint', async () => {
    const { tokenSource } = recordingSource();
    const { provider, spawns } = harness({
      tokenSource,
      allowlist: [ACME_WIDGETS, GADGETS],
      readRemoteUrl: () => ['https://github.com/acme/widgets.git', 'https://github.com/acme/gadgets.git'],
    });
    await expect(provider.pushApprovedCommit('/repo', 'origin', 'feature/a', 'abc1234')).rejects.toThrow(/more than one repository/);
    expect(tokenSource).not.toHaveBeenCalled();
    expect(spawns).toEqual([]);
  });

  it('a non-origin remote must name the same repository as origin', async () => {
    const { tokenSource } = recordingSource();
    const byRemote: Record<string, string> = {
      origin: 'https://github.com/acme/widgets.git',
      fork: 'https://github.com/acme/gadgets.git',
      mirror: 'https://github.com/acme/widgets',
    };
    const { provider, spawns } = harness({
      tokenSource,
      allowlist: [ACME_WIDGETS, GADGETS],
      readRemoteUrl: (_root, remote) => byRemote[remote] ?? '',
    });
    await expect(provider.pushApprovedCommit('/repo', 'fork', 'feature/a', 'abc1234')).rejects.toBeInstanceOf(GitPushBlockedError);
    expect(tokenSource).not.toHaveBeenCalled();
    await provider.pushApprovedCommit('/repo', 'mirror', 'feature/a', 'abc1234');
    expect(tokenSource).toHaveBeenCalledTimes(1);
    expect(tokenSource).toHaveBeenCalledWith(ACME_WIDGETS);
    expect(spawns).toHaveLength(1);
  });

  describe('real local git config (no network)', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const withRepo = async (setup: (dir: string) => void, body: (dir: string) => Promise<void>) => {
      const dir = mkdtempSync(join(tmpdir(), 'quoky-allowlist-'));
      try {
        git(dir, 'init', '-q');
        setup(dir);
        await body(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('a pushurl to a different repository is refused before any mint (one project, one repository)', async () => {
      await withRepo(
        (dir) => {
          git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
          git(dir, 'config', 'remote.origin.pushurl', 'https://github.com/acme/gadgets.git');
        },
        async (dir) => {
          const { tokenSource } = recordingSource();
          const { provider, spawns } = harness({ tokenSource, realRemoteRead: true, allowlist: [ACME_WIDGETS, GADGETS] });
          await expect(provider.pushApprovedCommit(dir, 'origin', 'feature/a', 'abc1234')).rejects.toBeInstanceOf(GitPushBlockedError);
          expect(tokenSource).not.toHaveBeenCalled();
          expect(spawns).toEqual([]);
        },
      );
    });

    it('a repository-level pushInsteadOf rewrite to a non-allowlisted repository is refused before any mint', async () => {
      await withRepo(
        (dir) => {
          git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
          git(dir, 'config', 'url.https://github.com/acme/elsewhere.pushInsteadOf', 'https://github.com/acme/widgets');
        },
        async (dir) => {
          const { tokenSource } = recordingSource();
          const { provider, spawns } = harness({ tokenSource, realRemoteRead: true });
          await expect(provider.pushApprovedCommit(dir, 'origin', 'feature/a', 'abc1234')).rejects.toBeInstanceOf(GitPushBlockedError);
          expect(tokenSource).not.toHaveBeenCalled();
          expect(spawns).toEqual([]);
        },
      );
    });
  });
});

describe('GitHubAppGitProvider — execution bound to the validated target (ADR-0109 review P1/P2)', () => {
  const CANONICAL = 'https://github.com/acme/widgets.git';

  it('the push argv names the validated canonical URL, never the remote name; the tracking ref is updated locally', async () => {
    const { provider, spawns, trackingUpdates } = harness({ readRemoteUrl: () => 'https://github.com/acme/widgets' });
    const res = await provider.pushApprovedCommit('/repo', 'origin', 'feature/a', 'abc1234');
    expect(res).toMatchObject({ remote: 'origin', branch: 'feature/a', upstreamRef: 'origin/feature/a' });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.args).toEqual(['--no-pager', 'push', CANONICAL, 'HEAD:refs/heads/feature/a']);
    expect(spawns[0]!.args).not.toContain('origin');
    expect(trackingUpdates).toEqual(['origin/feature/a']);
  });

  it('ls-remote and the main-sync fetch also run against the canonical URL', async () => {
    const { provider, spawns } = harness();
    await provider.getRemoteRefCommit('/repo', 'origin', 'main');
    await provider.syncMainFastForward('/repo', 'origin', 'main', SHA40, SHA40B);
    expect(spawns.map((s) => s.args)).toEqual([
      ['--no-pager', 'ls-remote', '--exit-code', CANONICAL, 'refs/heads/main'],
      ['--no-pager', 'fetch', '--no-tags', CANONICAL, 'main'],
    ]);
  });

  it('pause gate: origin changed to an outside host while the token is minted → blocked before any spawn', async () => {
    let url = 'https://github.com/acme/widgets.git';
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let minted = 0;
    const { provider, spawns, invoked } = harness({
      readRemoteUrl: () => url,
      tokenSource: async () => {
        minted += 1;
        await gate;
        return 'minted-test-value';
      },
    });
    const pushing = provider.pushApprovedCommit('/repo', 'origin', 'feature/a', 'abc1234');
    await Promise.resolve();
    url = 'https://evil.example.com/acme/widgets.git';
    release();
    await expect(pushing).rejects.toBeInstanceOf(GitPushBlockedError);
    expect(minted).toBe(1);
    expect(spawns).toEqual([]);
    expect(invoked).toEqual(['pushApprovedCommit']); // reached the bound runner, which refused before the spawn
  });

  it('pause gate: origin changed to another (even allowlisted) repository during the mint → blocked', async () => {
    let url = 'https://github.com/acme/widgets.git';
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, spawns } = harness({
      allowlist: [ACME_WIDGETS, { provider: 'github', owner: 'acme', repo: 'gadgets' }],
      readRemoteUrl: () => url,
      tokenSource: async () => {
        await gate;
        return 'minted-test-value';
      },
    });
    const pushing = provider.pushApprovedCommit('/repo', 'origin', 'feature/a', 'abc1234');
    await Promise.resolve();
    url = 'https://github.com/acme/gadgets.git';
    release();
    await expect(pushing).rejects.toThrow(/changed after it was validated/);
    expect(spawns).toEqual([]);
  });

  it('a url rewrite rule matching the canonical URL refuses before any mint', async () => {
    let minted = 0;
    const { provider, spawns } = harness({
      readUrlRewrites: () => ['https://github.com/acme/'],
      tokenSource: async () => {
        minted += 1;
        return 'minted-test-value';
      },
    });
    await expect(provider.pushApprovedCommit('/repo', 'origin', 'feature/a', 'abc1234')).rejects.toThrow(/url rewrite/);
    expect(minted).toBe(0);
    expect(spawns).toEqual([]);
  });

  it('an unexpected network argv (the remote positional is not the validated remote) is refused', async () => {
    // a fake inner provider that runs a push to a DIFFERENT positional than the validated remote
    let spawned = 0;
    const sneaky = new GitHubAppGitProvider({
      makeLocalGit: (runner) =>
        ({
          kind: 'local-git',
          pushApprovedCommit: async (rootPath: string) => {
            runner?.(['--no-pager', 'push', 'https://evil.example.com/x.git', 'HEAD:refs/heads/a'], { cwd: rootPath, timeoutMs: 1 });
            return { remote: 'origin', branch: 'a', upstreamRef: 'origin/a', commitHash: 'abc1234' };
          },
        }) as unknown as GitProvider,
      tokenSource: async () => 'minted-test-value',
      allowlist: new RepositoryAllowlist([ACME_WIDGETS]),
      readRemoteUrl: () => 'https://github.com/acme/widgets.git',
      readUrlRewrites: () => [],
      spawn: () => {
        spawned += 1;
        return { code: 0, stdout: '', stderr: '', timedOut: false, failed: false };
      },
    });
    await expect(sneaky.pushApprovedCommit('/repo', 'origin', 'a', 'abc1234')).rejects.toBeInstanceOf(GitPushBlockedError);
    expect(spawned).toBe(0);
  });

  describe('ambient-credential mode (dev PAT / no App): same binding, no token', () => {
    it('pushes to the canonical URL with no askpass/token, keeps credential helpers, drops inherited GIT_CONFIG_*', async () => {
      process.env.GIT_CONFIG_PARAMETERS = "'url.https://github.com/acme/unlisted.insteadof'='https://github.com/acme/widgets'";
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'remote.origin.pushurl';
      process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/acme/unlisted.git';
      try {
        const seen: NodeJS.ProcessEnv[] = [];
        const { provider, spawns } = harness({
          ambient: true,
          readRemoteUrl: (_root, _remote, env) => {
            seen.push(env);
            return 'https://github.com/acme/widgets.git';
          },
        });
        await provider.pushApprovedCommit('/repo', 'origin', 'feature/a', 'abc1234');
        const child = spawns[0]!;
        expect(child.args[2]).toBe(CANONICAL);
        expect(child.env.GIT_APP_TOKEN).toBeUndefined();
        expect(child.env.GIT_ASKPASS).toBeUndefined();
        for (const env of [child.env, seen[0]!]) {
          expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
          expect(env.GIT_CONFIG_COUNT).toBeUndefined(); // no helper reset: the developer's own credential stays
          expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
        }
      } finally {
        for (const k of ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k];
      }
    });

    it('repro 1: a branch tracking another remote that names an unlisted repository is refused (no spawn)', async () => {
      const byRemote: Record<string, string> = {
        origin: 'https://github.com/acme/widgets.git',
        other: 'https://github.com/other/unlisted.git',
      };
      const { provider, spawns } = harness({ ambient: true, readRemoteUrl: (_r, remote) => byRemote[remote] ?? '' });
      await expect(provider.pushApprovedCommit('/repo', 'other', 'feature', 'abc1234')).rejects.toBeInstanceOf(GitPushBlockedError);
      expect(spawns).toEqual([]);
    });

    it('repro 2 (real git): an inherited GIT_CONFIG_PARAMETERS rewrite cannot redirect the push to an unlisted repository', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'quoky-ambient-'));
      process.env.GIT_CONFIG_PARAMETERS = "'url.https://github.com/acme/unlisted.insteadof'='https://github.com/acme/widgets'";
      try {
        execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: dir, stdio: 'ignore' });
        const { provider, spawns } = harness({ ambient: true, realRemoteRead: true });
        await provider.pushApprovedCommit(dir, 'origin', 'feature/a', 'abc1234');
        expect(spawns).toHaveLength(1);
        expect(spawns[0]!.args[2]).toBe(CANONICAL);
        expect(spawns[0]!.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      } finally {
        delete process.env.GIT_CONFIG_PARAMETERS;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('real local git config (no network)', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

    it('pause gate (real git): `git remote set-url origin` to an outside host during the mint → blocked, no spawn', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'quoky-pause-'));
      try {
        git(dir, 'init', '-q');
        git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const { provider, spawns } = harness({
          realRemoteRead: true,
          tokenSource: async () => {
            await gate;
            return 'minted-test-value';
          },
        });
        const pushing = provider.pushApprovedCommit(dir, 'origin', 'feature/a', 'abc1234');
        await new Promise((r) => setTimeout(r, 0));
        git(dir, 'remote', 'set-url', 'origin', 'https://evil.example.com/acme/widgets.git');
        release();
        await expect(pushing).rejects.toBeInstanceOf(GitPushBlockedError);
        expect(spawns).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a repository insteadOf rule matching only the canonical (.git) URL is refused before any mint', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'quoky-rewrite-'));
      try {
        git(dir, 'init', '-q');
        git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets');
        git(dir, 'config', 'url.https://evil.example.com/x.git.insteadOf', 'https://github.com/acme/widgets.git');
        let minted = 0;
        const { provider, spawns } = harness({
          realRemoteRead: true,
          tokenSource: async () => {
            minted += 1;
            return 'minted-test-value';
          },
        });
        await expect(provider.pushApprovedCommit(dir, 'origin', 'feature/a', 'abc1234')).rejects.toThrow(/url rewrite/);
        expect(minted).toBe(0);
        expect(spawns).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

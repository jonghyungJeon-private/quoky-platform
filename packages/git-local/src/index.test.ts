import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_LS_REMOTE_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  LocalGitProvider,
  assertSafeNewFiles,
  gitTimeoutMsForArgs,
  parsePorcelain,
  sanitizeGitStderr,
  type GitRunner,
  type GitRunResult,
} from './index';
import { BranchCleanupBlockedError, GitMainSyncBlockedError } from '@quoky/core';

const created: string[] = [];
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A temp git repo on branch `main` with one optional commit. */
function makeRepo(withCommit = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-git-'));
  created.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'); // deterministic branch name
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Tester');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (withCommit) {
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'quoky-nogit-'));
  created.push(d);
  return d;
}

/** Records argv for the argument-array assertion. */
function recordingRunner(result: GitRunResult): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = (args) => {
    calls.push(args);
    return result;
  };
  return { runner, calls };
}

const provider = new LocalGitProvider();

describe('LocalGitProvider — read-only git inspection (CAP-002, ADR-0023)', () => {
  it('isRepository: true inside a repo, false for a plain dir', async () => {
    expect(await provider.isRepository(makeRepo())).toBe(true);
    expect(await provider.isRepository(tempDir())).toBe(false);
    expect(await provider.isRepository('/definitely/not/here/xyz')).toBe(false);
  });

  it('info: returns not-a-repository for a plain dir', async () => {
    const info = await provider.info(tempDir());
    expect(info.isRepository).toBe(false);
    expect(info.branch).toBe('');
    expect(info.detached).toBe(false);
  });

  it('info: branch + headSha for a normal repo', async () => {
    const dir = makeRepo();
    const info = await provider.info(dir);
    expect(info.isRepository).toBe(true);
    expect(info.branch).toBe('main');
    expect(info.detached).toBe(false);
    expect(info.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('info: detached HEAD is reported (detached=true, branch empty)', async () => {
    const dir = makeRepo();
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-q', sha);
    const info = await provider.info(dir);
    expect(info.detached).toBe(true);
    expect(info.branch).toBe('');
    expect(info.headSha).toBe(sha);
  });

  it('status: clean repo', async () => {
    const status = await provider.status(makeRepo());
    expect(status.clean).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.untracked).toEqual([]);
  });

  it('status: untracked + unstaged + staged files', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'new.txt'), 'x'); // untracked
    writeFileSync(join(dir, 'README.md'), '# changed\n'); // unstaged modification
    writeFileSync(join(dir, 'staged.txt'), 'y');
    git(dir, 'add', 'staged.txt'); // staged add
    const status = await provider.status(dir);
    expect(status.clean).toBe(false);
    expect(status.untracked).toContain('new.txt');
    expect(status.unstaged).toContain('README.md');
    expect(status.staged).toContain('staged.txt');
  });

  it('does NOT expose remote URLs / credentials in info', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://user:secrettoken@github.com/x/y.git');
    const info = await provider.info(dir);
    const blob = JSON.stringify(info);
    expect(blob).not.toContain('secrettoken');
    expect(blob).not.toContain('github.com');
    expect(Object.keys(info)).not.toContain('remote');
    expect(Object.keys(info)).not.toContain('url');
  });

  it('uses argument-array spawn (never a shell string)', async () => {
    const { runner, calls } = recordingRunner({
      code: 0,
      stdout: 'true',
      stderr: '',
      timedOut: false,
      failed: false,
    });
    // isDir guard would short-circuit a fake path, so use a real repo dir.
    await new LocalGitProvider(runner).isRepository(makeRepo());
    expect(calls.length).toBeGreaterThan(0);
    expect(Array.isArray(calls[0])).toBe(true);
    expect(calls[0]).toEqual(['rev-parse', '--is-inside-work-tree']);
  });

  it('status: surfaces a sanitized error on timeout and on spawn failure', async () => {
    const timeout = new LocalGitProvider(() => ({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      failed: false,
    }));
    await expect(timeout.status(makeRepo())).rejects.toThrow(/timed out/);

    const broken = new LocalGitProvider(() => ({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      failed: true,
    }));
    await expect(broken.status(makeRepo())).rejects.toThrow(/could not run/);

    const failed = new LocalGitProvider(() => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
      timedOut: false,
      failed: false,
    }));
    await expect(failed.status(makeRepo())).rejects.toThrow(/exit 128/);
  });
});

describe('LocalGitProvider.diff — read-only diff extension (CAP-002, ADR-0044)', () => {
  const okRun = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, failed: false });

  it('unified shows a tracked modification; files lists the path; not truncated', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), '# changed content here\n');
    const diff = await provider.diff(dir);
    expect(diff.files).toContain('README.md');
    expect(diff.unified).toContain('README.md');
    expect(diff.unified).toContain('changed content here');
    expect(diff.truncated).toBe(false);
  });

  it('untracked file is NOT in the unified diff (tracked changes only); status surfaces it', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'brand-new.txt'), 'UNTRACKED_SECRET_CONTENT\n'); // untracked
    const diff = await provider.diff(dir);
    expect(diff.unified).not.toContain('UNTRACKED_SECRET_CONTENT');
    expect(diff.files).not.toContain('brand-new.txt');
    const status = await provider.status(dir);
    expect(status.untracked).toContain('brand-new.txt');
  });

  it('binary file change shows git’s marker only, never binary content', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 5]));
    git(dir, 'add', 'blob.bin');
    git(dir, 'commit', '-q', '-m', 'add binary');
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([255, 254, 253, 0, 9, 8, 7]));
    const diff = await provider.diff(dir);
    expect(diff.unified).toMatch(/Binary files/);
    expect(diff.files).toContain('blob.bin');
  });

  it('oversized unified output is hard-capped and flagged truncated', async () => {
    const huge = 'x'.repeat(25_000);
    const runner: GitRunner = (args) => {
      if (args.includes('--verify')) return okRun(''); // HEAD exists
      if (args.includes('--name-only')) return okRun('big.ts\n');
      return okRun(huge);
    };
    const diff = await new LocalGitProvider(runner).diff(makeRepo());
    expect(diff.truncated).toBe(true);
    expect(diff.unified.length).toBeLessThanOrEqual(20_000);
    expect(diff.files).toEqual(['big.ts']);
  });

  it('uses argument-array read-only flags with HEAD; never a mutating subcommand', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      return okRun(''); // rev-parse --verify HEAD → code 0 (HEAD exists)
    };
    await new LocalGitProvider(runner).diff(makeRepo());
    expect(calls).toContainEqual(['--no-pager', 'diff', '--no-ext-diff', '--no-color', '--name-only', 'HEAD']);
    expect(calls).toContainEqual(['--no-pager', 'diff', '--no-ext-diff', '--no-color', 'HEAD']);
    for (const c of calls) {
      for (const forbidden of ['add', 'commit', 'push', 'reset', 'checkout', 'stash', 'branch', 'merge', 'rebase', 'tag']) {
        expect(c).not.toContain(forbidden);
      }
    }
  });

  it('unborn repository (no HEAD) drops the HEAD arg', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      if (args.includes('--verify')) return { code: 1, stdout: '', stderr: '', timedOut: false, failed: false }; // no HEAD
      return okRun('');
    };
    await new LocalGitProvider(runner).diff(tempDir());
    expect(calls).toContainEqual(['--no-pager', 'diff', '--no-ext-diff', '--no-color', '--name-only']);
    expect(calls).toContainEqual(['--no-pager', 'diff', '--no-ext-diff', '--no-color']);
  });

  it('surfaces a sanitized error when the diff command fails', async () => {
    const failed = new LocalGitProvider((args) =>
      args.includes('--verify')
        ? okRun('')
        : { code: 128, stdout: '', stderr: 'fatal: bad revision', timedOut: false, failed: false },
    );
    await expect(failed.diff(makeRepo())).rejects.toThrow(/exit 128/);
  });
});

describe('LocalGitProvider.commitFiles — the first git mutation (CAP-002, ADR-0046)', () => {
  /** A runner that returns code 0 for everything and a fixed sha for `rev-parse HEAD`. */
  const commitRunner = (headSha = 'a'.repeat(40)): { runner: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      if (args.includes('rev-parse')) return { code: 0, stdout: headSha + '\n', stderr: '', timedOut: false, failed: false };
      return { code: 0, stdout: '', stderr: '', timedOut: false, failed: false };
    };
    return { runner, calls };
  };

  it('commits EXACTLY the given tracked file, leaving other changes uncommitted; returns the HEAD sha (CA 44)', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'other.txt'), 'z');
    git(dir, 'add', 'other.txt');
    git(dir, 'commit', '-q', '-m', 'add other');
    writeFileSync(join(dir, 'README.md'), '# changed\n'); // tracked modification — the candidate
    writeFileSync(join(dir, 'other.txt'), 'zz'); // a DIFFERENT tracked modification — must NOT be committed
    const res = await provider.commitFiles(dir, ['README.md'], 'chore: update readme');
    expect(res.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(res.committedFiles).toEqual(['README.md']);
    expect(res.message).toBe('chore: update readme');
    const changed = git(dir, 'show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n').filter(Boolean);
    expect(changed).toEqual(['README.md']); // the new commit touched only README.md
    expect(git(dir, 'status', '--porcelain=v1', '--', 'other.txt')).toContain('other.txt'); // other.txt still pending
  });

  it('runs argv `commit --only -m <msg> -- <files>` then `rev-parse HEAD`; msg is one argv element; `--` precedes paths; NO git add; NO push/reset/checkout/stash/branch/tag/merge/rebase (CA 45–49, 75–82)', async () => {
    const { runner, calls } = commitRunner();
    await new LocalGitProvider(runner).commitFiles('/repo', ['a.ts', 'b.ts'], 'fix: thing with spaces');
    expect(calls[0]).toEqual(['--no-pager', 'commit', '--only', '-m', 'fix: thing with spaces', '--', 'a.ts', 'b.ts']);
    expect(calls[1]).toEqual(['--no-pager', 'rev-parse', 'HEAD']);
    expect(calls[0]?.filter((a) => a === 'fix: thing with spaces')).toHaveLength(1); // message is a single argv element
    const dd = calls[0]?.indexOf('--') ?? -1;
    expect(dd).toBeGreaterThan(-1);
    expect(calls[0]?.slice(dd + 1)).toEqual(['a.ts', 'b.ts']); // pathspecs after `--`
    for (const c of calls) {
      for (const forbidden of ['add', 'push', 'reset', 'checkout', 'stash', 'branch', 'merge', 'rebase', 'tag', 'pull', 'fetch']) {
        expect(c).not.toContain(forbidden);
      }
    }
  });

  it('rejects an unsafe path (absolute / traversal / empty) BEFORE any git command runs (CA 50)', async () => {
    for (const files of [['/etc/passwd'], ['../secret'], ['a/../../x'], ['']]) {
      const { runner, calls } = commitRunner();
      await expect(new LocalGitProvider(runner).commitFiles('/repo', files, 'msg')).rejects.toThrow();
      expect(calls.length, files.join()).toBe(0); // no git ran
    }
  });

  it('de-duplicates repeated pathspecs (CA #7)', async () => {
    const { runner, calls } = commitRunner();
    await new LocalGitProvider(runner).commitFiles('/repo', ['a.ts', 'a.ts'], 'msg');
    const dd = calls[0]?.indexOf('--') ?? -1;
    expect(calls[0]?.slice(dd + 1)).toEqual(['a.ts']);
  });

  it('surfaces a sanitized failure when the commit fails — no fake success', async () => {
    const failing: GitRunner = (args) =>
      args.includes('commit')
        ? { code: 1, stdout: '', stderr: 'nothing to commit', timedOut: false, failed: false }
        : { code: 0, stdout: 'sha', stderr: '', timedOut: false, failed: false };
    await expect(new LocalGitProvider(failing).commitFiles('/repo', ['a.ts'], 'msg')).rejects.toThrow(/exit 1/);
  });
});

describe('LocalGitProvider.pushApprovedCommit — the first REMOTE mutation (CAP-002, ADR-0048)', () => {
  /** A recording runner that succeeds (code 0) for the single push call. */
  const pushRunner = (): { runner: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '', timedOut: false, failed: false };
    };
    return { runner, calls };
  };

  it('runs exactly `push <remote> HEAD:refs/heads/<branch>` (one refspec argv element), argument-array only; NEVER --force/-f/--tags/--all/-u/--set-upstream/bare-push or any other mutating subcommand; returns the provider-reported approved target (CA 59–64, 79–82, 114–125)', async () => {
    const { runner, calls } = pushRunner();
    const sha = 'a'.repeat(40);
    const res = await new LocalGitProvider(runner).pushApprovedCommit('/repo', 'origin', 'main', sha);
    expect(calls).toHaveLength(1); // exactly one git command
    expect(Array.isArray(calls[0])).toBe(true); // argument-array, never a shell string
    expect(calls[0]).toEqual(['--no-pager', 'push', 'origin', 'HEAD:refs/heads/main']); // the current HEAD → approved branch (fully qualified, ADR-0099)
    expect(calls[0]?.filter((a) => a.startsWith('HEAD:'))).toEqual(['HEAD:refs/heads/main']); // exactly one refspec element
    for (const forbidden of [
      '--force', '-f', '--force-with-lease', '--tags', '--all', '-u', '--set-upstream', '--mirror', '--delete',
      'add', 'commit', 'reset', 'checkout', 'stash', 'branch', 'merge', 'rebase', 'tag', 'pull', 'fetch',
    ]) {
      expect(calls[0], forbidden).not.toContain(forbidden);
    }
    expect(res).toEqual({ remote: 'origin', branch: 'main', upstreamRef: 'origin/main', commitHash: sha }); // provider-reported target
  });

  it('rejects an unsafe remote / branch / commitHash BEFORE any git command runs — an unsafe branch never reaches argv as HEAD:<branch> (CA 65–67)', async () => {
    const bad: Array<[string, string, string]> = [
      ['--upload-pack=evil', 'main', 'a'.repeat(40)], // unsafe remote (leading-dash option injection)
      ['origin', 'evil:ref', 'a'.repeat(40)], // unsafe branch (extra refspec colon)
      ['origin', 'main', 'not-a-sha'], // invalid (non-SHA) commitHash
    ];
    for (const [remote, branch, hash] of bad) {
      const { runner, calls } = pushRunner();
      await expect(new LocalGitProvider(runner).pushApprovedCommit('/repo', remote, branch, hash)).rejects.toThrow();
      expect(calls.length, `${remote}|${branch}|${hash}`).toBe(0); // NO git command ran
      expect(calls.flat(), branch).not.toContain(`HEAD:refs/heads/${branch}`); // the unsafe branch never reached argv
    }
  });

  it('allows a slashed branch → argv `push origin HEAD:refs/heads/feature/x`, upstream origin/feature/x (CA 68)', async () => {
    const { runner, calls } = pushRunner();
    const res = await new LocalGitProvider(runner).pushApprovedCommit('/repo', 'origin', 'feature/x', 'b'.repeat(40));
    expect(calls[0]).toEqual(['--no-pager', 'push', 'origin', 'HEAD:refs/heads/feature/x']);
    expect(res.branch).toBe('feature/x');
    expect(res.upstreamRef).toBe('origin/feature/x');
  });

  it('rejects an unsafe branch (colon / whitespace / control / leading-dash / leading-slash / ".." / "@{" / ".lock" / trailing-slash / "//" / ~^?*[\\) — no git runs (CA 69–74)', async () => {
    for (const branch of ['a:b', 'a b', 'a\tb', '-lead', '/lead', 'a..b', 'a@{0}', 'feat.lock', 'trail/', 'a//b', 'a~b', 'a^b', 'a?b', 'a*b', 'a[b', 'a\\b', '']) {
      const { runner, calls } = pushRunner();
      await expect(new LocalGitProvider(runner).pushApprovedCommit('/repo', 'origin', branch, 'c'.repeat(40))).rejects.toThrow(/unsafe branch/);
      expect(calls.length, JSON.stringify(branch)).toBe(0);
    }
  });

  it('rejects an unsafe remote (leading-dash / colon / slash / whitespace / control / empty) — no git runs (CA 75–78)', async () => {
    for (const remote of ['-force', 'ori:gin', 'ori/gin', 'ori gin', 'ori\tgin', '']) {
      const { runner, calls } = pushRunner();
      await expect(new LocalGitProvider(runner).pushApprovedCommit('/repo', remote, 'main', 'd'.repeat(40))).rejects.toThrow(/unsafe remote/);
      expect(calls.length, JSON.stringify(remote)).toBe(0);
    }
  });

  it('surfaces a sanitized failure when the push fails — no fake success, credentials masked', async () => {
    const failing: GitRunner = (args) =>
      args.includes('push')
        ? { code: 1, stdout: '', stderr: 'fatal: unable to access https://user:sekrettoken@github.com/x/y.git', timedOut: false, failed: false }
        : { code: 0, stdout: '', stderr: '', timedOut: false, failed: false };
    const err: Error = await new LocalGitProvider(failing)
      .pushApprovedCommit('/repo', 'origin', 'main', 'e'.repeat(40))
      .then(() => { throw new Error('expected push to reject'); }, (e: Error) => e);
    expect(err.message).toMatch(/git push failed \(exit 1\)/);
    expect(err.message).not.toContain('sekrettoken');
  });
});

describe('parsePorcelain', () => {
  it('parses branch, staged, unstaged, untracked', () => {
    const out = parsePorcelain(['## main...origin/main [ahead 1]', 'M  a.ts', ' M b.ts', '?? c.ts'].join('\n'));
    expect(out.branch).toBe('main');
    expect(out.staged).toEqual(['a.ts']);
    expect(out.unstaged).toEqual(['b.ts']);
    expect(out.untracked).toEqual(['c.ts']);
    expect(out.clean).toBe(false);
  });

  it('reports detached "(no branch)" and clean trees', () => {
    expect(parsePorcelain('## HEAD (no branch)').branch).toBe('HEAD');
    expect(parsePorcelain('## main').clean).toBe(true);
  });

  // ── Sprint 2z (ADR-0047): upstream / ahead / behind from the `-b` header (read-only, no fetch) ──
  it('parses upstream + ahead + behind from "## main...origin/main [ahead 2, behind 1]"', () => {
    const out = parsePorcelain('## main...origin/main [ahead 2, behind 1]');
    expect(out.upstream).toBe('origin/main');
    expect(out.ahead).toBe(2);
    expect(out.behind).toBe(1);
  });

  it('in-sync upstream "## main...origin/main" → upstream set, ahead 0, behind 0', () => {
    const out = parsePorcelain('## main...origin/main');
    expect(out.upstream).toBe('origin/main');
    expect(out.ahead).toBe(0);
    expect(out.behind).toBe(0);
  });

  it('ahead-only "## main...origin/main [ahead 3]" → ahead 3, behind 0', () => {
    const out = parsePorcelain('## main...origin/main [ahead 3]');
    expect(out.ahead).toBe(3);
    expect(out.behind).toBe(0);
  });

  it('no upstream "## main" → upstream/ahead/behind all undefined (NOT 0) (CA 12)', () => {
    const out = parsePorcelain('## main');
    expect(out.upstream).toBeUndefined();
    expect(out.ahead).toBeUndefined();
    expect(out.behind).toBeUndefined();
  });

  it('detached / unborn have no upstream', () => {
    expect(parsePorcelain('## HEAD (no branch)').upstream).toBeUndefined();
    expect(parsePorcelain('## No commits yet on main').upstream).toBeUndefined();
  });

  it('a slashed upstream branch "## wip...origin/feature/x [ahead 1]" keeps the full upstream', () => {
    const out = parsePorcelain('## wip...origin/feature/x [ahead 1]');
    expect(out.upstream).toBe('origin/feature/x');
    expect(out.ahead).toBe(1);
    expect(out.behind).toBe(0);
  });
});

describe('LocalGitProvider.status argv stays read-only (Sprint 2z, ADR-0047, CA 82)', () => {
  it('status uses exactly `status --porcelain=v1 -b --untracked-files=all`; no mutating subcommand', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      return { code: 0, stdout: '## main...origin/main [ahead 1]\n', stderr: '', timedOut: false, failed: false };
    };
    const status = await new LocalGitProvider(runner).status('/repo');
    expect(calls).toContainEqual(['status', '--porcelain=v1', '-b', '--untracked-files=all']);
    expect(status.upstream).toBe('origin/main');
    for (const c of calls) {
      for (const forbidden of ['push', 'commit', 'add', 'reset', 'checkout', 'stash', 'branch', 'merge', 'rebase', 'tag']) {
        expect(c).not.toContain(forbidden);
      }
    }
  });
});

describe('sanitizeGitStderr', () => {
  it('masks embedded URL credentials and truncates', () => {
    const masked = sanitizeGitStderr('fatal: https://user:abcd1234token@github.com/x/y.git not found');
    expect(masked).not.toContain('abcd1234token');
    expect(masked).toContain('***@');
  });
});

describe('LocalGitProvider — post-merge local main sync (CAP-002, ADR-0058, Sprint 3h)', () => {
  /** A remote repo (on main, one commit A) + a clone; returns paths and commit A. */
  function makeRemoteAndClone(): { remote: string; local: string; A: string } {
    const remote = makeRepo(); // main @ A ("init")
    const A = git(remote, 'rev-parse', 'HEAD').trim();
    const parent = mkdtempSync(join(tmpdir(), 'quoky-clone-'));
    created.push(parent);
    const local = join(parent, 'local');
    git(parent, 'clone', '-q', remote, 'local');
    git(local, 'config', 'user.email', 't@example.com');
    git(local, 'config', 'user.name', 'Tester');
    git(local, 'config', 'commit.gpgsign', 'false');
    return { remote, local, A };
  }
  /** Add commit B to the remote's main; returns B. */
  function commitOnRemoteMain(remote: string): string {
    writeFileSync(join(remote, 'f2.txt'), 'x\n');
    git(remote, 'add', 'f2.txt');
    git(remote, 'commit', '-q', '-m', 'B');
    return git(remote, 'rev-parse', 'HEAD').trim();
  }

  it('getRemoteRefCommit reads the remote main tip and does NOT move local main', async () => {
    const { remote, local, A } = makeRemoteAndClone();
    const B = commitOnRemoteMain(remote);
    const observed = await provider.getRemoteRefCommit(local, 'origin', 'main');
    expect(observed.commitHash).toBe(B);
    expect(git(local, 'rev-parse', 'refs/heads/main').trim()).toBe(A); // unchanged (read-only)
  });

  it('getLocalRefCommit returns the local main tip, or null for a nonexistent branch', async () => {
    const { local, A } = makeRemoteAndClone();
    expect((await provider.getLocalRefCommit(local, 'main'))?.commitHash).toBe(A);
    expect(await provider.getLocalRefCommit(local, 'nope-branch')).toBeNull();
  });

  it('checked-out-main mode: fast-forwards the checked-out main + working tree (workingTreeUpdated true)', async () => {
    const { remote, local, A } = makeRemoteAndClone();
    const B = commitOnRemoteMain(remote);
    const r = await provider.syncMainFastForward(local, 'origin', 'main', B, A);
    expect(r.syncMode).toBe('checked-out-main');
    expect(r.workingTreeUpdated).toBe(true);
    expect(r.alreadyUpToDate).toBe(false);
    expect(r.syncedCommitHash).toBe(B);
    expect(r.previousMainCommit).toBe(A);
    expect(git(local, 'rev-parse', 'refs/heads/main').trim()).toBe(B); // local main moved to B
  });

  it('ref-only mode: fast-forwards refs/heads/main only, leaving the current checkout untouched (workingTreeUpdated false)', async () => {
    const { remote, local, A } = makeRemoteAndClone();
    const B = commitOnRemoteMain(remote);
    git(local, 'checkout', '-q', '-b', 'feature'); // current branch != main
    const r = await provider.syncMainFastForward(local, 'origin', 'main', B, A);
    expect(r.syncMode).toBe('ref-only');
    expect(r.workingTreeUpdated).toBe(false);
    expect(r.syncedCommitHash).toBe(B);
    expect(git(local, 'rev-parse', 'refs/heads/main').trim()).toBe(B); // local main ref moved
    expect(git(local, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('feature'); // checkout unchanged
  });

  it('non-fast-forward → GitMainSyncBlockedError (no force/reset), local main untouched', async () => {
    const { remote, local, A } = makeRemoteAndClone();
    const B = commitOnRemoteMain(remote);
    // diverge local main to C (a child of A that is not an ancestor of B)
    writeFileSync(join(local, 'local-only.txt'), 'y\n');
    git(local, 'add', 'local-only.txt');
    git(local, 'commit', '-q', '-m', 'C');
    const C = git(local, 'rev-parse', 'refs/heads/main').trim();
    await expect(provider.syncMainFastForward(local, 'origin', 'main', B, C)).rejects.toBeInstanceOf(GitMainSyncBlockedError);
    expect(git(local, 'rev-parse', 'refs/heads/main').trim()).toBe(C); // unchanged
  });

  it('fetched-tip mismatch (expected != actual remote) → GitMainSyncBlockedError before any ref move', async () => {
    const { remote, local, A } = makeRemoteAndClone();
    commitOnRemoteMain(remote);
    const wrong = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await expect(provider.syncMainFastForward(local, 'origin', 'main', wrong, A)).rejects.toBeInstanceOf(GitMainSyncBlockedError);
    expect(git(local, 'rev-parse', 'refs/heads/main').trim()).toBe(A);
  });

  it('CAS mismatch (local main != expectedPreviousCommit) → GitMainSyncBlockedError', async () => {
    const { remote, local } = makeRemoteAndClone();
    const B = commitOnRemoteMain(remote);
    const wrongPrev = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await expect(provider.syncMainFastForward(local, 'origin', 'main', B, wrongPrev)).rejects.toBeInstanceOf(GitMainSyncBlockedError);
  });

  it('already up to date (no new remote commit) → alreadyUpToDate, no ref move', async () => {
    const { local, A } = makeRemoteAndClone();
    const r = await provider.syncMainFastForward(local, 'origin', 'main', A, A);
    expect(r.alreadyUpToDate).toBe(true);
    expect(r.workingTreeUpdated).toBe(false);
    expect(r.syncedCommitHash).toBe(A);
    expect(git(local, 'rev-parse', 'refs/heads/main').trim()).toBe(A);
  });

  it('argv guard: sync uses ls-remote / fetch / merge --ff-only|update-ref only — NEVER --force/-f/reset --hard/push/branch delete', async () => {
    const { remote, local, A } = makeRemoteAndClone();
    const B = commitOnRemoteMain(remote);
    // Wrap the real runner to capture every argv the sync emits.
    const seen: string[][] = [];
    const recording: GitRunner = (args, opts) => {
      seen.push(args);
      // delegate to a real spawn so behavior is real
      const r = spawnSync('git', args, { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8' });
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false, failed: !!r.error };
    };
    await new LocalGitProvider(recording).getRemoteRefCommit(local, 'origin', 'main');
    await new LocalGitProvider(recording).syncMainFastForward(local, 'origin', 'main', B, A);
    const flat = seen.map((a) => a.join(' '));
    for (const bad of ['--force', ' -f', 'reset --hard', 'reset', 'push', 'branch -d', 'branch -D', '--hard']) {
      expect(flat.some((c) => c.includes(bad)), bad).toBe(false);
    }
    expect(flat.some((c) => c.includes('ls-remote'))).toBe(true);
    expect(flat.some((c) => c.startsWith('--no-pager fetch') || c.includes(' fetch '))).toBe(true);
    expect(flat.some((c) => c.includes('merge --ff-only') || c.includes('update-ref'))).toBe(true);
  });
});

describe('LocalGitProvider — post-merge local branch cleanup (CAP-002, ADR-0059, Sprint 3i)', () => {
  /** A repo with main @ M (merge commit) and a merged feature branch @ F (F ancestor of M). */
  function makeRepoWithMergedFeature(): { dir: string; main: string; feature: string; F: string } {
    const dir = makeRepo(); // main @ A
    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'feat.txt'), 'x\n');
    git(dir, 'add', 'feat.txt');
    git(dir, 'commit', '-q', '-m', 'F');
    const F = git(dir, 'rev-parse', 'refs/heads/feature').trim();
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '--no-ff', '-m', 'merge feature', 'feature');
    const main = git(dir, 'rev-parse', 'refs/heads/main').trim();
    return { dir, main, feature: F, F };
  }

  it('isAncestor: merged feature tip is an ancestor of main; main is not an ancestor of the feature', async () => {
    const { dir, main, F } = makeRepoWithMergedFeature();
    expect(await provider.isAncestor(dir, F, main)).toBe(true);
    expect(await provider.isAncestor(dir, main, F)).toBe(false);
  });

  it('deleteMergedLocalBranch: CAS-deletes the local feature ref (update-ref -d), leaving main + checkout untouched', async () => {
    const { dir, main, F } = makeRepoWithMergedFeature(); // currently on main
    const r = await provider.deleteMergedLocalBranch(dir, 'feature', F);
    expect(r.deleted).toBe(true);
    expect(r.alreadyAbsent).toBe(false);
    expect(r.deletedCommitHash).toBe(F);
    const gone = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feature'], { cwd: dir, encoding: 'utf8' });
    expect(gone.status).not.toBe(0); // feature deleted
    expect(git(dir, 'rev-parse', 'refs/heads/main').trim()).toBe(main); // main untouched
  });

  it('does NOT require HEAD==main and does not switch checkout (CA 25/26)', async () => {
    const { dir, F } = makeRepoWithMergedFeature();
    git(dir, 'checkout', '-q', '-b', 'other'); // current branch != main, != feature
    await provider.deleteMergedLocalBranch(dir, 'feature', F);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('other'); // checkout unchanged
    const check = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feature'], { cwd: dir, encoding: 'utf8' });
    expect(check.status).not.toBe(0); // feature deleted
  });

  it('CAS mismatch (expectedBranchCommit != actual tip) → GitMainSync? no — BranchCleanupBlockedError, branch NOT deleted', async () => {
    const { dir, F } = makeRepoWithMergedFeature();
    // add another commit to feature so its tip != F
    git(dir, 'checkout', '-q', 'feature');
    writeFileSync(join(dir, 'feat2.txt'), 'y\n');
    git(dir, 'add', 'feat2.txt');
    git(dir, 'commit', '-q', '-m', 'F2');
    git(dir, 'checkout', '-q', 'main');
    await expect(provider.deleteMergedLocalBranch(dir, 'feature', F)).rejects.toBeInstanceOf(BranchCleanupBlockedError);
    expect(git(dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature').trim()).not.toBe(''); // still present
  });

  it('absent target branch → BranchCleanupBlockedError (pre-delete; manager handles absent as idempotent upstream)', async () => {
    const { dir, F } = makeRepoWithMergedFeature();
    await expect(provider.deleteMergedLocalBranch(dir, 'no-such-branch', F)).rejects.toBeInstanceOf(BranchCleanupBlockedError);
  });

  it('rejects main / unsafe branch defensively (never deletes main)', async () => {
    const { dir, main } = makeRepoWithMergedFeature();
    await expect(provider.deleteMergedLocalBranch(dir, 'main', main)).rejects.toBeInstanceOf(BranchCleanupBlockedError);
    await expect(provider.deleteMergedLocalBranch(dir, 'bad branch', main)).rejects.toBeInstanceOf(BranchCleanupBlockedError);
    expect(git(dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/main').trim()).toBe(main); // main intact
  });

  it('argv guard: cleanup uses update-ref -d only — NEVER branch -d/-D/--force/push', async () => {
    const { dir, F } = makeRepoWithMergedFeature();
    const seen: string[][] = [];
    const recording: GitRunner = (args, opts) => {
      seen.push(args);
      const r = spawnSync('git', args, { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8' });
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false, failed: !!r.error };
    };
    await new LocalGitProvider(recording).deleteMergedLocalBranch(dir, 'feature', F);
    const flat = seen.map((a) => a.join(' '));
    for (const bad of ['branch -d', 'branch -D', '--force', ' -f', 'push', 'reset --hard']) {
      expect(flat.some((c) => c.includes(bad)), bad).toBe(false);
    }
    expect(flat.some((c) => c.includes('update-ref -d'))).toBe(true);
  });
});

// ── ADR-0099 (CODE-2): new-file commit, owner branch create/switch, exact-ref push — real temp git repos ─────────

/** Same as `makeRepo`, plus `a.txt` committed so tests have a tracked file to modify. */
function makeRepoWithTracked(): string {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'add a');
  return dir;
}

function head(dir: string): string {
  return git(dir, 'rev-parse', 'HEAD').trim();
}

function ok(stdout = ''): GitRunResult {
  return { code: 0, stdout, stderr: '', timedOut: false, failed: false };
}

describe('LocalGitProvider.status — untracked files are listed individually (ADR-0099 D3)', { timeout: 30_000 }, () => {
  it('lists a new file in a brand-new directory by its own path, not the directory', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'src/new/deep'), { recursive: true });
    writeFileSync(join(dir, 'src/new/deep/helper.ts'), 'export {};\n');
    writeFileSync(join(dir, 'src/new/other.ts'), 'export {};\n');
    const status = await provider.status(dir);
    expect([...status.untracked].sort()).toEqual(['src/new/deep/helper.ts', 'src/new/other.ts']);
    expect(status.untracked).not.toContain('src/');
    expect(status.untracked).not.toContain('src/new/');
  });
});

describe('LocalGitProvider.commitFiles — new-file support (ADR-0099 D3)', { timeout: 30_000 }, () => {
  it('commits exactly the approved new file plus a modified tracked file; other untracked and staged files remain', async () => {
    const dir = makeRepoWithTracked();
    writeFileSync(join(dir, 'a.txt'), 'a changed\n'); // tracked modification (approved)
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib/new.ts'), 'export const n = 1;\n'); // approved new file in a new dir
    writeFileSync(join(dir, 'stray.txt'), 'stray\n'); // other untracked — must stay untracked
    writeFileSync(join(dir, 'staged.txt'), 'staged\n');
    git(dir, 'add', 'staged.txt'); // other staged — must stay staged, uncommitted

    const res = await provider.commitFiles(dir, ['a.txt', 'lib/new.ts'], 'feat: add new', { newFiles: ['lib/new.ts'] });
    expect(res.commitHash).toBe(head(dir));
    expect(res.committedFiles).toEqual(['a.txt', 'lib/new.ts']);

    const changed = git(dir, 'show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n').filter(Boolean).sort();
    expect(changed).toEqual(['a.txt', 'lib/new.ts']);
    const status = await provider.status(dir);
    expect(status.untracked).toEqual(['stray.txt']);
    expect(status.staged).toEqual(['staged.txt']);
    expect(status.unstaged).toEqual([]);
  });

  it('commits a new file alone (no tracked modification)', async () => {
    const dir = makeRepoWithTracked();
    writeFileSync(join(dir, 'solo.ts'), 'x\n');
    await provider.commitFiles(dir, ['solo.ts'], 'feat: solo', { newFiles: ['solo.ts'] });
    expect(git(dir, 'show', '--name-only', '--pretty=format:', 'HEAD').trim()).toBe('solo.ts');
    expect((await provider.status(dir)).clean).toBe(true);
  });

  it('a forced commit failure (pre-commit hook exits 1) leaves the new file untracked again and the tracked change intact', async () => {
    const dir = makeRepoWithTracked();
    const hook = join(dir, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const before = head(dir);
    writeFileSync(join(dir, 'a.txt'), 'a changed\n');
    writeFileSync(join(dir, 'fresh.ts'), 'fresh\n');

    await expect(provider.commitFiles(dir, ['a.txt', 'fresh.ts'], 'feat: x', { newFiles: ['fresh.ts'] })).rejects.toThrow(/git commit failed/);

    expect(head(dir)).toBe(before);
    const status = await provider.status(dir);
    expect(status.untracked).toEqual(['fresh.ts']); // un-added by the compensation
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual(['a.txt']); // tracked modification untouched, not committed
    expect(git(dir, 'show', 'HEAD:a.txt')).toBe('a\n');
  });

  it('never adds anything when newFiles is absent: an untracked path in `files` makes the plain commit fail and stays untracked', async () => {
    const dir = makeRepoWithTracked();
    writeFileSync(join(dir, 'fresh.ts'), 'fresh\n');
    await expect(provider.commitFiles(dir, ['fresh.ts'], 'feat: x')).rejects.toThrow(/git commit failed/);
    expect((await provider.status(dir)).untracked).toEqual(['fresh.ts']);
  });

  it('rejects a "new" file that is already tracked before any add, so the compensation can never un-track real files', async () => {
    const dir = makeRepoWithTracked();
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    await expect(provider.commitFiles(dir, ['a.txt'], 'msg', { newFiles: ['a.txt'] })).rejects.toThrow(/already tracked/);
    expect(git(dir, 'ls-files', 'a.txt').trim()).toBe('a.txt');
  });

  it('runs argv `ls-files`, `add -- <newFiles>`, the unchanged `commit --only`, then `rev-parse HEAD`', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      return ok(args.includes('rev-parse') ? 'a'.repeat(40) + '\n' : '');
    };
    await new LocalGitProvider(runner).commitFiles('/repo', ['a.ts', 'n/new.ts'], 'feat: x', { newFiles: ['n/new.ts'] });
    expect(calls).toEqual([
      ['--no-pager', 'ls-files', '--', 'n/new.ts'],
      ['--no-pager', 'add', '--', 'n/new.ts'],
      ['--no-pager', 'commit', '--only', '-m', 'feat: x', '--', 'a.ts', 'n/new.ts'],
      ['--no-pager', 'rev-parse', 'HEAD'],
    ]);
  });

  it('compensates with `git rm --cached --quiet -- <newFiles>` exactly once when the commit fails, then rethrows the commit error', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      if (args.includes('commit')) return { code: 1, stdout: '', stderr: 'hook failed', timedOut: false, failed: false };
      return ok();
    };
    await expect(
      new LocalGitProvider(runner).commitFiles('/repo', ['a.ts', 'n.ts'], 'msg', { newFiles: ['n.ts'] }),
    ).rejects.toThrow(/git commit failed \(exit 1\)/);
    expect(calls.at(-1)).toEqual(['--no-pager', 'rm', '--cached', '--quiet', '--', 'n.ts']);
    expect(calls.filter((c) => c.includes('rm'))).toHaveLength(1);
  });

  it('a failing compensation never masks the commit error', async () => {
    const runner: GitRunner = (args) => {
      if (args.includes('commit')) return { code: 1, stdout: '', stderr: 'hook failed', timedOut: false, failed: false };
      if (args.includes('rm')) throw new Error('rm exploded');
      return ok();
    };
    await expect(new LocalGitProvider(runner).commitFiles('/repo', ['n.ts'], 'msg', { newFiles: ['n.ts'] })).rejects.toThrow(/git commit failed/);
  });

  it('does not compensate when `git add` itself fails (nothing was staged by this call) and surfaces the add failure', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      if (args.includes('add')) return { code: 128, stdout: '', stderr: 'pathspec did not match', timedOut: false, failed: false };
      return ok();
    };
    await expect(new LocalGitProvider(runner).commitFiles('/repo', ['n.ts'], 'msg', { newFiles: ['n.ts'] })).rejects.toThrow(/git add failed/);
    expect(calls.some((c) => c.includes('commit'))).toBe(false);
  });

  it('rejects unsafe or non-subset new files BEFORE any git command runs (including pathspec magic)', async () => {
    const cases: Array<{ files: string[]; newFiles: string[] }> = [
      { files: ['a.ts'], newFiles: ['b.ts'] }, // not a subset
      { files: ['../x.ts'], newFiles: ['../x.ts'] },
      { files: ['/abs.ts'], newFiles: ['/abs.ts'] },
      { files: ['n.ts'], newFiles: [''] },
      { files: ['*.ts'], newFiles: ['*.ts'] }, // glob would stage other untracked files
      { files: ['a?.ts'], newFiles: ['a?.ts'] },
      { files: ['[id].ts'], newFiles: ['[id].ts'] },
      { files: [':(top)n.ts'], newFiles: [':(top)n.ts'] }, // pathspec magic
      { files: ['a\\b.ts'], newFiles: ['a\\b.ts'] },
    ];
    for (const c of cases) {
      const calls: string[][] = [];
      const runner: GitRunner = (args) => { calls.push(args); return ok(); };
      await expect(new LocalGitProvider(runner).commitFiles('/repo', c.files, 'msg', { newFiles: c.newFiles }), JSON.stringify(c)).rejects.toThrow();
      expect(calls.length, JSON.stringify(c)).toBe(0);
    }
  });

  it('treats an empty newFiles array like no option (no add, no ls-files)', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => { calls.push(args); return ok(args.includes('rev-parse') ? 'a'.repeat(40) : ''); };
    await new LocalGitProvider(runner).commitFiles('/repo', ['a.ts'], 'msg', { newFiles: [] });
    expect(calls.map((c) => c[1])).toEqual(['commit', 'rev-parse']);
  });

  it('assertSafeNewFiles de-duplicates and returns the validated subset', () => {
    expect(assertSafeNewFiles(['n.ts', 'n.ts'], ['a.ts', 'n.ts'])).toEqual(['n.ts']);
  });
});

describe('LocalGitProvider.createBranch (ADR-0099 D4)', { timeout: 30_000 }, () => {
  it('creates and switches to a new branch from HEAD, carrying a dirty tree (staged, unstaged, untracked)', async () => {
    const dir = makeRepoWithTracked();
    const sha = head(dir);
    writeFileSync(join(dir, 'a.txt'), 'dirty\n');
    writeFileSync(join(dir, 'staged.txt'), 's\n');
    git(dir, 'add', 'staged.txt');
    writeFileSync(join(dir, 'untracked.txt'), 'u\n');

    const res = await provider.createBranch(dir, 'feature/x', sha);
    expect(res).toEqual({ branch: 'feature/x', headSha: sha, created: true });
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('feature/x');
    expect(head(dir)).toBe(sha);
    const status = await provider.status(dir);
    expect(status.unstaged).toEqual(['a.txt']);
    expect(status.staged).toEqual(['staged.txt']);
    expect(status.untracked).toEqual(['untracked.txt']);
  });

  it('accepts a short sha prefix as the compare-and-swap value', async () => {
    const dir = makeRepoWithTracked();
    const res = await provider.createBranch(dir, 'feature/short', head(dir).slice(0, 9));
    expect(res.created).toBe(true);
  });

  it('refuses an existing branch name and leaves HEAD where it was', async () => {
    const dir = makeRepoWithTracked();
    git(dir, 'branch', 'feature/exists');
    await expect(provider.createBranch(dir, 'feature/exists', head(dir))).rejects.toThrow(/already exists/);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
  });

  it('refuses a detached HEAD', async () => {
    const dir = makeRepoWithTracked();
    const sha = head(dir);
    git(dir, 'checkout', '-q', '--detach');
    await expect(provider.createBranch(dir, 'feature/x', sha)).rejects.toThrow(/detached/);
    expect(git(dir, 'branch', '--list', 'feature/x').trim()).toBe('');
  });

  it('refuses an unborn repository (no HEAD commit)', async () => {
    const dir = makeRepo(false);
    await expect(provider.createBranch(dir, 'feature/x', 'a'.repeat(40))).rejects.toThrow(/HEAD does not match/);
  });

  it('refuses when HEAD does not match the expected sha (compare-and-swap)', async () => {
    const dir = makeRepoWithTracked();
    const stale = head(dir);
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-q', '-m', 'advance');
    await expect(provider.createBranch(dir, 'feature/x', stale)).rejects.toThrow(/HEAD does not match/);
    expect(git(dir, 'branch', '--list', 'feature/x').trim()).toBe('');
  });

  it('refuses during an in-progress merge', async () => {
    const dir = makeRepoWithTracked();
    git(dir, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(dir, 'a.txt'), 'other side\n');
    git(dir, 'commit', '-q', '-am', 'other change');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'a.txt'), 'main side\n');
    git(dir, 'commit', '-q', '-am', 'main change');
    expect(spawnSync('git', ['merge', 'other'], { cwd: dir }).status).not.toBe(0); // conflict → MERGE_HEAD present
    await expect(provider.createBranch(dir, 'feature/x', head(dir))).rejects.toThrow(/in progress/);
    expect(git(dir, 'branch', '--list', 'feature/x').trim()).toBe('');
  });

  it('refuses during an in-progress cherry-pick', async () => {
    const dir = makeRepoWithTracked();
    git(dir, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(dir, 'a.txt'), 'other side\n');
    git(dir, 'commit', '-q', '-am', 'other change');
    const pick = head(dir);
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'a.txt'), 'main side\n');
    git(dir, 'commit', '-q', '-am', 'main change');
    expect(spawnSync('git', ['cherry-pick', pick], { cwd: dir }).status).not.toBe(0);
    await expect(provider.createBranch(dir, 'feature/x', head(dir))).rejects.toThrow(/in progress/);
  });

  it('refuses main/master/Main/HEAD/refs names with NO git command run', async () => {
    for (const name of ['main', 'master', 'Main', 'MASTER', 'HEAD', 'refs/heads/x', 'a b', '-x', 'a..b', '기능']) {
      const calls: string[][] = [];
      const runner: GitRunner = (args) => { calls.push(args); return ok(); };
      await expect(new LocalGitProvider(runner).createBranch('/repo', name, 'a'.repeat(40)), name).rejects.toThrow(/branch name/);
      expect(calls.length, name).toBe(0);
    }
  });

  it('refuses a malformed expected sha with NO git command run', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => { calls.push(args); return ok(); };
    await expect(new LocalGitProvider(runner).createBranch('/repo', 'feature/x', 'nope')).rejects.toThrow(/expected HEAD/);
    expect(calls.length).toBe(0);
  });

  it('runs exactly one mutating command, `switch -c <branch>`, after the read-only preflight', async () => {
    const sha = 'c'.repeat(40);
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      const sub = args.filter((a) => a !== '--no-pager');
      if (sub[0] === 'rev-parse' && sub[1] === '--git-path') return ok(`/nonexistent-quoky-gitdir/${sub[2]}\n`);
      if (sub[0] === 'symbolic-ref') return ok(calls.some((c) => c.includes('switch')) ? 'feature/x\n' : 'main\n');
      if (sub[0] === 'rev-parse' && sub[1] === '--verify') return { code: 1, stdout: '', stderr: '', timedOut: false, failed: false };
      if (sub[0] === 'rev-parse' && sub[1] === '--is-inside-work-tree') return ok('true\n');
      if (sub[0] === 'rev-parse' && sub[1] === '--show-toplevel') return ok('/repo\n');
      if (sub[0] === 'rev-parse') return ok(`${sha}\n`);
      return ok();
    };
    const root = tempDir(); // info() requires an existing directory
    const res = await new LocalGitProvider(runner).createBranch(root, 'feature/x', sha);
    expect(res).toEqual({ branch: 'feature/x', headSha: sha, created: true });
    const mutating = calls.filter((c) => c.includes('switch'));
    expect(mutating).toEqual([['--no-pager', 'switch', '-c', 'feature/x']]);
    for (const c of calls) {
      for (const forbidden of ['push', 'commit', 'add', 'reset', 'checkout', 'stash', 'merge', 'rebase', 'tag', 'fetch', '--force', '-f', '-C', '--discard-changes']) {
        expect(c, forbidden).not.toContain(forbidden);
      }
    }
  });

  it('surfaces a failing `switch -c` as an error', async () => {
    const sha = 'c'.repeat(40);
    const runner: GitRunner = (args) => {
      const sub = args.filter((a) => a !== '--no-pager');
      if (sub[0] === 'switch') return { code: 128, stdout: '', stderr: 'fatal: boom', timedOut: false, failed: false };
      if (sub[0] === 'rev-parse' && sub[1] === '--git-path') return ok('/nonexistent-quoky-gitdir/x\n');
      if (sub[0] === 'symbolic-ref') return ok('main\n');
      if (sub[0] === 'rev-parse' && sub[1] === '--verify') return { code: 1, stdout: '', stderr: '', timedOut: false, failed: false };
      return ok(`${sha}\n`);
    };
    await expect(new LocalGitProvider(runner).createBranch('/repo', 'feature/x', sha)).rejects.toThrow(/git switch failed/);
  });
});

describe('LocalGitProvider.switchBranch (ADR-0099 D4)', { timeout: 30_000 }, () => {
  it('switches to an existing local branch on a clean tree', async () => {
    const dir = makeRepoWithTracked();
    git(dir, 'branch', 'feature/y');
    const res = await provider.switchBranch(dir, 'feature/y');
    expect(res).toEqual({ branch: 'feature/y', headSha: head(dir), created: false });
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('feature/y');
  });

  it('refuses a dirty tree: unstaged, staged, or untracked each block the switch', async () => {
    const dir = makeRepoWithTracked();
    git(dir, 'branch', 'feature/y');

    writeFileSync(join(dir, 'a.txt'), 'dirty\n');
    await expect(provider.switchBranch(dir, 'feature/y')).rejects.toThrow(/not clean/);
    git(dir, 'checkout', '-q', '--', 'a.txt');

    writeFileSync(join(dir, 'staged.txt'), 's\n');
    git(dir, 'add', 'staged.txt');
    await expect(provider.switchBranch(dir, 'feature/y')).rejects.toThrow(/not clean/);
    git(dir, 'rm', '-q', '--cached', 'staged.txt');
    rmSync(join(dir, 'staged.txt'));

    mkdirSync(join(dir, 'new'), { recursive: true });
    writeFileSync(join(dir, 'new/untracked.txt'), 'u\n');
    await expect(provider.switchBranch(dir, 'feature/y')).rejects.toThrow(/not clean/);

    expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main'); // never moved
  });

  it('refuses a branch that does not exist locally', async () => {
    const dir = makeRepoWithTracked();
    await expect(provider.switchBranch(dir, 'feature/missing')).rejects.toThrow(/no such local branch/);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
  });

  it('never creates a local branch from a remote-tracking branch (--no-guess)', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'quoky-bare-'));
    created.push(bare);
    git(bare, 'init', '-q', '--bare');
    const dir = makeRepoWithTracked();
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'main:refs/heads/main', 'main:refs/heads/feature/remote-only');
    git(dir, 'fetch', '-q', 'origin');
    expect(git(dir, 'branch', '-r', '--list', 'origin/feature/remote-only').trim()).not.toBe(''); // tracking ref exists

    await expect(provider.switchBranch(dir, 'feature/remote-only')).rejects.toThrow(/no such local branch/);
    expect(git(dir, 'branch', '--list', 'feature/remote-only').trim()).toBe(''); // no local branch was guessed into existence
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
  });

  it('refuses during an in-progress merge and on a detached HEAD', async () => {
    const dir = makeRepoWithTracked();
    git(dir, 'branch', 'feature/y');
    git(dir, 'checkout', '-q', '--detach');
    await expect(provider.switchBranch(dir, 'feature/y')).rejects.toThrow(/detached/);

    const dir2 = makeRepoWithTracked();
    git(dir2, 'branch', 'feature/y');
    git(dir2, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(dir2, 'a.txt'), 'other side\n');
    git(dir2, 'commit', '-q', '-am', 'other change');
    git(dir2, 'checkout', '-q', 'main');
    writeFileSync(join(dir2, 'a.txt'), 'main side\n');
    git(dir2, 'commit', '-q', '-am', 'main change');
    expect(spawnSync('git', ['merge', 'other'], { cwd: dir2 }).status).not.toBe(0);
    await expect(provider.switchBranch(dir2, 'feature/y')).rejects.toThrow(/in progress/);
  });

  it('refuses main/master/HEAD/refs names with NO git command run', async () => {
    for (const name of ['main', 'master', 'Main', 'HEAD', 'refs/heads/x', '']) {
      const calls: string[][] = [];
      const runner: GitRunner = (args) => { calls.push(args); return ok(); };
      await expect(new LocalGitProvider(runner).switchBranch('/repo', name), name).rejects.toThrow(/branch name/);
      expect(calls.length, name).toBe(0);
    }
  });

  it('runs exactly one mutating command, `switch --no-guess <branch>`', async () => {
    const sha = 'd'.repeat(40);
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      const sub = args.filter((a) => a !== '--no-pager');
      const switched = calls.some((c) => c.includes('switch'));
      if (sub[0] === 'rev-parse' && sub[1] === '--git-path') return ok('/nonexistent-quoky-gitdir/x\n');
      if (sub[0] === 'symbolic-ref') return ok(switched ? 'feature/y\n' : 'main\n');
      if (sub[0] === 'status') return ok('## main\n');
      if (sub[0] === 'rev-parse' && sub[1] === '--is-inside-work-tree') return ok('true\n');
      if (sub[0] === 'rev-parse' && sub[1] === '--show-toplevel') return ok('/repo\n');
      return ok(`${sha}\n`);
    };
    const root = tempDir(); // info() requires an existing directory
    const res = await new LocalGitProvider(runner).switchBranch(root, 'feature/y');
    expect(res).toEqual({ branch: 'feature/y', headSha: sha, created: false });
    expect(calls.filter((c) => c.includes('switch'))).toEqual([['--no-pager', 'switch', '--no-guess', 'feature/y']]);
    expect(calls).toContainEqual(['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  });

  it('fails verification when the checkout is not the requested branch afterwards', async () => {
    const sha = 'd'.repeat(40);
    const runner: GitRunner = (args) => {
      const sub = args.filter((a) => a !== '--no-pager');
      if (sub[0] === 'rev-parse' && sub[1] === '--git-path') return ok('/nonexistent-quoky-gitdir/x\n');
      if (sub[0] === 'symbolic-ref') return ok('main\n'); // still on main after the "switch"
      if (sub[0] === 'status') return ok('## main\n');
      if (sub[0] === 'rev-parse' && sub[1] === '--is-inside-work-tree') return ok('true\n');
      if (sub[0] === 'rev-parse' && sub[1] === '--show-toplevel') return ok('/repo\n');
      return ok(`${sha}\n`);
    };
    await expect(new LocalGitProvider(runner).switchBranch(tempDir(), 'feature/y')).rejects.toThrow(/could not be verified/);
  });
});

describe('LocalGitProvider.pushApprovedCommit — real push to a LOCAL bare repo as origin (ADR-0099 D5)', { timeout: 30_000 }, () => {
  it('creates refs/heads/feature/x on the remote with the exact sha, without -u and without touching main', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'quoky-bare-'));
    created.push(bare);
    git(bare, 'init', '-q', '--bare');
    const dir = makeRepoWithTracked();
    git(dir, 'remote', 'add', 'origin', bare);

    const mainSha = head(dir);
    await provider.createBranch(dir, 'feature/x', mainSha);
    writeFileSync(join(dir, 'a.txt'), 'feature change\n');
    const commit = await provider.commitFiles(dir, ['a.txt'], 'feat: change a');

    const res = await provider.pushApprovedCommit(dir, 'origin', 'feature/x', commit.commitHash);
    expect(res).toEqual({ remote: 'origin', branch: 'feature/x', upstreamRef: 'origin/feature/x', commitHash: commit.commitHash });
    expect(git(bare, 'rev-parse', 'refs/heads/feature/x').trim()).toBe(commit.commitHash);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { cwd: bare }).status).not.toBe(0); // main never pushed
    // no upstream configured (no -u)
    expect(spawnSync('git', ['config', '--get', 'branch.feature/x.remote'], { cwd: dir }).status).not.toBe(0);
  });

  it('creates a remote branch whose name differs from the checked-out local branch (fully qualified refspec)', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'quoky-bare-'));
    created.push(bare);
    git(bare, 'init', '-q', '--bare');
    const dir = makeRepoWithTracked();
    git(dir, 'remote', 'add', 'origin', bare);
    const sha = head(dir);
    const res = await provider.pushApprovedCommit(dir, 'origin', 'feature/from-main', sha);
    expect(res.upstreamRef).toBe('origin/feature/from-main');
    expect(git(bare, 'rev-parse', 'refs/heads/feature/from-main').trim()).toBe(sha);
  });
});

describe('git timeouts by command type (W2-L02)', () => {
  const run = (calls: Array<{ args: string[]; timeoutMs: number }>, timedOutFor?: string): GitRunner => (args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    const timedOut = timedOutFor !== undefined && args.includes(timedOutFor);
    return { code: timedOut ? null : 0, stdout: args.includes('ls-remote') ? 'a'.repeat(40) + '\trefs/heads/x\n' : '', stderr: '', timedOut, failed: false };
  };

  it('classifies network commands with longer bounded timeouts and local commands with the short one', () => {
    expect(gitTimeoutMsForArgs(['--no-pager', 'push', 'origin', 'HEAD:refs/heads/x'])).toBe(GIT_PUSH_TIMEOUT_MS);
    expect(gitTimeoutMsForArgs(['--no-pager', 'fetch', '--no-tags', 'origin', 'main'])).toBe(GIT_FETCH_TIMEOUT_MS);
    // Codex P2: values of global options (-c / -C / --git-dir) are not the subcommand.
    expect(gitTimeoutMsForArgs(['-c', 'credential.helper=', 'push', 'origin'])).toBe(GIT_PUSH_TIMEOUT_MS);
    expect(gitTimeoutMsForArgs(['-C', '/repo', '--no-pager', 'ls-remote', 'origin'])).toBe(GIT_LS_REMOTE_TIMEOUT_MS);
    expect(gitTimeoutMsForArgs(['--git-dir', '/repo/.git', 'fetch', 'origin'])).toBe(GIT_FETCH_TIMEOUT_MS);
    expect(gitTimeoutMsForArgs(['-c', 'push.default=simple', 'status'])).toBe(GIT_TIMEOUT_MS);
    expect(gitTimeoutMsForArgs(['--no-pager', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'])).toBe(GIT_LS_REMOTE_TIMEOUT_MS);
    for (const local of [['status'], ['--no-pager', 'commit', '-m', 'push'], ['rev-parse', 'HEAD'], ['--no-pager', 'diff']]) {
      expect(gitTimeoutMsForArgs(local)).toBe(GIT_TIMEOUT_MS);
    }
    expect(GIT_PUSH_TIMEOUT_MS).toBeGreaterThan(GIT_TIMEOUT_MS);
    expect(GIT_LS_REMOTE_TIMEOUT_MS).toBeGreaterThan(GIT_TIMEOUT_MS);
  });

  it('push / ls-remote are spawned with their network timeout', async () => {
    const calls: Array<{ args: string[]; timeoutMs: number }> = [];
    const git = new LocalGitProvider(run(calls));
    await git.pushApprovedCommit('/r', 'origin', 'feat-x', 'a'.repeat(40));
    await git.getRemoteRefCommit('/r', 'origin', 'main');
    expect(calls.find((c) => c.args.includes('push'))?.timeoutMs).toBe(GIT_PUSH_TIMEOUT_MS);
    expect(calls.find((c) => c.args.includes('ls-remote'))?.timeoutMs).toBe(GIT_LS_REMOTE_TIMEOUT_MS);
  });

  it('a timed-out push throws a plain timeout Error (at/after-mutation: never a Blocked/"not pushed" error)', async () => {
    const git = new LocalGitProvider(run([], 'push'));
    const err = await git.pushApprovedCommit('/r', 'origin', 'feat-x', 'a'.repeat(40)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`git push timed out after ${GIT_PUSH_TIMEOUT_MS}ms`);
    expect((err as Error).name).toBe('Error');
  });
});

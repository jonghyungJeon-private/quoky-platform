import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GitBranchCleanupResult, GitBranchResult, GitCommitResult, GitDiff, GitMainSyncResult, GitProvider, GitPushResult, GitStatus, RepositoryInfo } from '@quoky/core';
import {
  BranchCleanupBlockedError,
  BranchCleanupUnverifiedError,
  GitMainSyncBlockedError,
  GitMainSyncUnverifiedError,
  isCreatableOwnerBranch,
  isSafePushBranch,
  isSafePushRemote,
} from '@quoky/core';

/** SHA-shape guard for the sync commits. */
const SYNC_SHA_SHAPED = /^[0-9a-f]{7,40}$/i;

/** Per-call timeout (ms) for LOCAL-only git commands. */
export const GIT_TIMEOUT_MS = 5000;
/** Bounded timeout (ms) for `git push` — a network round-trip (W2-L02: cold network + token mint exceeded 5 s). */
export const GIT_PUSH_TIMEOUT_MS = 60_000;
/** Bounded timeout (ms) for `git fetch` (main sync). */
export const GIT_FETCH_TIMEOUT_MS = 60_000;
/** Bounded timeout (ms) for `git ls-remote`. */
export const GIT_LS_REMOTE_TIMEOUT_MS = 30_000;

/** The git subcommand of an argv (skipping leading global flags such as `--no-pager`). */
function gitSubcommand(args: readonly string[]): string {
  return args.find((a) => !a.startsWith('-')) ?? '';
}

/** Timeout for a git subcommand: network operations get a longer bounded timeout, local commands stay short. */
export function gitTimeoutMsForSubcommand(subcommand: string): number {
  switch (subcommand) {
    case 'push':
      return GIT_PUSH_TIMEOUT_MS;
    case 'fetch':
      return GIT_FETCH_TIMEOUT_MS;
    case 'ls-remote':
      return GIT_LS_REMOTE_TIMEOUT_MS;
    default:
      return GIT_TIMEOUT_MS;
  }
}

/** Timeout for a full git argv (see {@link gitTimeoutMsForSubcommand}). */
export function gitTimeoutMsForArgs(args: readonly string[]): number {
  return gitTimeoutMsForSubcommand(gitSubcommand(args));
}

/** Hard safety cap on the raw unified diff the adapter returns to core (ADR-0044) — a backstop above the
 *  ResponseComposer's display bounds so an enormous diff never reaches the Application layer. */
const MAX_DIFF_CHARS = 20_000;

/** Result of one read-only git invocation. */
export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the call exceeded the timeout. */
  timedOut: boolean;
  /** Spawn-level failure (e.g. git not installed). */
  failed: boolean;
}

/**
 * Runs git with an ARGUMENT ARRAY (never a shell string, never `shell: true`).
 * Injectable so tests can assert the exact argv and simulate timeouts/errors.
 */
export type GitRunner = (args: string[], opts: { cwd: string; timeoutMs: number }) => GitRunResult;

/** Mask token-like substrings / embedded URL credentials, then truncate stderr. */
export function sanitizeGitStderr(stderr: string): string {
  return stderr
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, '***')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, '***')
    .replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@')
    .slice(0, 300)
    .trim();
}

/** Default runner: argument-array `spawnSync`, no shell, cwd = repo root, timeout. */
export const defaultGitRunner: GitRunner = (args, { cwd, timeoutMs }) => {
  const res = spawnSync('git', args, { cwd, timeout: timeoutMs, encoding: 'utf8' });
  const timedOut = !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
    failed: !!res.error && !timedOut,
  };
};

/**
 * Defensively validate + dedup commit pathspecs (ADR-0046, CA #7) — the provider does not trust caller path
 * strings blindly. Rejects absolute / `..` traversal / empty paths BEFORE any git command runs; deduplicates.
 */
export function assertSafeCommitPaths(files: string[]): string[] {
  if (files.length === 0) throw new Error('git commit requires at least one file');
  const seen = new Set<string>();
  const safe: string[] = [];
  for (const raw of files) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (p.length === 0) throw new Error('git commit rejects an empty file path');
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) throw new Error(`git commit rejects an absolute file path: ${p}`);
    if (p === '..' || p.split(/[\\/]/).includes('..')) throw new Error(`git commit rejects a traversal file path: ${p}`);
    if (!seen.has(p)) {
      seen.add(p);
      safe.push(p);
    }
  }
  return safe;
}

/**
 * Defensively validate the approved NEW-file subset of a commit (ADR-0099 D3): every entry must be a safe relative
 * path (same rules as {@link assertSafeCommitPaths}), unique, a member of `safeFiles`, and free of git pathspec
 * magic (`*`, `?`, `[`, `\\`, a leading `:`), so `git add -- <newFiles>` can only ever stage the exact approved
 * files and never glob onto another untracked path. Throws BEFORE any git command runs.
 */
export function assertSafeNewFiles(newFiles: string[], safeFiles: string[]): string[] {
  const safe = assertSafeCommitPaths(newFiles);
  const approved = new Set(safeFiles);
  for (const p of safe) {
    if (!approved.has(p)) throw new Error(`git commit rejects a new file that is not in the commit set: ${p}`);
    if (/[*?[\\]/.test(p) || p.startsWith(':')) throw new Error(`git commit rejects a new file path with pathspec magic: ${p}`);
  }
  return safe;
}

/**
 * Defensively validate a push target (ADR-0048, CA #4/#5) — conservative git ref rules (reusing core
 * `isSafePushRemote`/`isSafePushBranch`) + a SHA-shaped commitHash. Throws BEFORE any git command runs on
 * an unsafe target, so an unsafe branch never reaches argv as `HEAD:<branch>`.
 */
export function assertSafePushTarget(remote: string, branch: string, commitHash: string): void {
  if (!isSafePushRemote(remote)) throw new Error(`git push rejects an unsafe remote: ${remote}`);
  if (!isSafePushBranch(branch)) throw new Error(`git push rejects an unsafe branch: ${branch}`);
  if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) throw new Error('git push rejects an invalid commitHash');
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Parse `git status --porcelain=v1 -b --untracked-files=all` output into a GitStatus. */
export function parsePorcelain(stdout: string): GitStatus {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let branch = '';
  let tracking: { upstream?: string; ahead?: number; behind?: number } = {};
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    if (line.startsWith('## ')) {
      branch = parseBranchLine(line);
      tracking = parseBranchTracking(line);
      continue;
    }
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const path = rest.includes(' -> ') ? (rest.split(' -> ')[1] ?? rest) : rest;
    if (code === '??') {
      untracked.push(path);
      continue;
    }
    const x = code.charAt(0);
    const y = code.charAt(1);
    if (x !== ' ' && x !== '?') staged.push(path);
    if (y !== ' ' && y !== '?') unstaged.push(path);
  }
  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  return {
    clean,
    branch,
    staged,
    unstaged,
    untracked,
    ...(tracking.upstream !== undefined ? { upstream: tracking.upstream } : {}),
    ...(tracking.ahead !== undefined ? { ahead: tracking.ahead } : {}),
    ...(tracking.behind !== undefined ? { behind: tracking.behind } : {}),
  };
}

/** Extract the branch name from a porcelain `## ...` header line. */
function parseBranchLine(line: string): string {
  let b = line.slice(3).trim();
  b = b.replace(/^No commits yet on /, '').replace(/^Initial commit on /, '');
  if (b.startsWith('HEAD (no branch)')) return 'HEAD';
  b = b.split('...')[0] ?? b;
  b = b.split(' ')[0] ?? b;
  return b;
}

/**
 * Parse the upstream tracking ref + ahead/behind from a porcelain `## <branch>...<remote>/<branch>
 * [ahead N, behind M]` header (Sprint 2z, ADR-0047). READ-ONLY: this data is ALREADY fetched by
 * `git status --porcelain=v1 -b` — no network fetch, no new git command. When the branch has no
 * `...upstream`, all three are `undefined` (distinct from `0` = in sync). Detached / unborn branches
 * have no upstream.
 */
function parseBranchTracking(line: string): { upstream?: string; ahead?: number; behind?: number } {
  const body = line.slice(3).trim();
  if (body.startsWith('HEAD (no branch)') || body.startsWith('No commits yet on ')) return {};
  const sep = body.indexOf('...');
  if (sep === -1) return {}; // no upstream
  const afterSep = body.slice(sep + 3);
  const bracket = afterSep.indexOf(' [');
  const upstream = (bracket === -1 ? afterSep : afterSep.slice(0, bracket)).trim();
  if (upstream.length === 0) return {};
  let ahead = 0;
  let behind = 0;
  if (bracket !== -1) {
    const track = afterSep.slice(bracket); // " [ahead N, behind M]" / " [ahead N]" / " [behind M]"
    const a = track.match(/ahead (\d+)/);
    const b = track.match(/behind (\d+)/);
    if (a?.[1]) ahead = Number(a[1]);
    if (b?.[1]) behind = Number(b[1]);
  }
  return { upstream, ahead, behind };
}

/**
 * Local git repository inspection over a local path (CAP-002, ADR-0023; mutations per ADR-0046/0048/0058/0059/0099).
 * Git ≠ Workspace: operates purely on `rootPath`, imports no Workspace type, and
 * runs only read-only subcommands via argument-array spawn. No writes, no
 * worktree, no remote-URL exposure.
 */
export class LocalGitProvider implements GitProvider {
  readonly kind = 'local-git';

  constructor(private readonly run: GitRunner = defaultGitRunner) {}

  private exec(rootPath: string, args: string[]): GitRunResult {
    return this.run(args, { cwd: rootPath, timeoutMs: gitTimeoutMsForArgs(args) });
  }

  private failure(label: string, res: GitRunResult): Error {
    if (res.timedOut) return new Error(`git ${label} timed out after ${gitTimeoutMsForSubcommand(label)}ms`);
    if (res.failed) return new Error(`git ${label} could not run (is git installed?)`);
    return new Error(`git ${label} failed (exit ${res.code}): ${sanitizeGitStderr(res.stderr)}`);
  }

  async isRepository(rootPath: string): Promise<boolean> {
    if (!isDir(rootPath)) return false;
    const res = this.exec(rootPath, ['rev-parse', '--is-inside-work-tree']);
    return res.code === 0 && res.stdout.trim() === 'true';
  }

  async info(rootPath: string): Promise<RepositoryInfo> {
    if (!(await this.isRepository(rootPath))) {
      return { isRepository: false, rootPath, branch: '', detached: false };
    }
    const top = this.exec(rootPath, ['rev-parse', '--show-toplevel']);
    const resolvedRoot = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : rootPath;

    // symbolic-ref resolves an attached branch even when unborn; failure ⇒ detached.
    const sym = this.exec(rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const attached = sym.code === 0 && sym.stdout.trim() !== '';
    const branch = attached ? sym.stdout.trim() : '';

    const head = this.exec(rootPath, ['rev-parse', 'HEAD']);
    const headSha = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : undefined;

    return {
      isRepository: true,
      rootPath: resolvedRoot,
      branch,
      ...(headSha ? { headSha } : {}),
      detached: !attached,
    };
  }

  async status(rootPath: string): Promise<GitStatus> {
    const res = this.exec(rootPath, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
    if (res.code !== 0) throw this.failure('status', res);
    return parsePorcelain(res.stdout);
  }

  /**
   * Read-only unified diff of TRACKED staged/unstaged changes vs HEAD (ADR-0044). READ-ONLY: runs only
   * `git diff` variants — never a mutating subcommand — via argument-array spawn (no shell, no user args,
   * no pathspec), `--no-ext-diff`/`--no-color`/`--no-pager`. For an unborn repository (no HEAD) it drops the
   * `HEAD` arg. `files` come from a bounded-safe `--name-only` read; `unified` is hard-capped at
   * MAX_DIFF_CHARS (a backstop above the composer's display bounds). Binary files appear as git's own marker
   * line ("Binary files … differ"), never binary content — no special dumping.
   */
  async diff(rootPath: string): Promise<GitDiff> {
    const base = ['--no-pager', 'diff', '--no-ext-diff', '--no-color'];
    // Unborn repository (no commits yet) has no HEAD → diff against the empty tree by dropping `HEAD`.
    const hasHead = this.exec(rootPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).code === 0;
    const rev = hasHead ? ['HEAD'] : [];

    const nameRes = this.exec(rootPath, [...base, '--name-only', ...rev]);
    if (nameRes.code !== 0) throw this.failure('diff', nameRes);
    const files = nameRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const unifiedRes = this.exec(rootPath, [...base, ...rev]);
    if (unifiedRes.code !== 0) throw this.failure('diff', unifiedRes);
    const raw = unifiedRes.stdout;
    const truncated = raw.length > MAX_DIFF_CHARS;
    const unified = truncated ? raw.slice(0, MAX_DIFF_CHARS) : raw;
    return { files, unified, truncated };
  }

  /**
   * The first mutating git operation (CAP-002, ADR-0046; new-file support ADR-0099 D3) — commit EXACTLY the given
   * files with `message`. Argument-array only (no shell). Without `options.newFiles` this is unchanged: NO
   * separate `git add` (CA #1 — a partial-stage side effect would persist on commit failure), a single
   * `git commit --only -m <message> -- <files>` of the exact pathspecs, then `rev-parse HEAD` for the sha.
   *
   * With `options.newFiles` (the approved UNTRACKED subset of `files`): each must be untracked (`git ls-files`),
   * then `git add -- <newFiles>` (exact pathspecs) runs, then the same `commit --only`. If the commit fails the
   * adapter compensates with `git rm --cached --quiet -- <newFiles>` (the new files are untracked again; the
   * working-tree content is never touched) and rethrows the commit failure. Paths are validated + de-duped first
   * (CA #7) → throws with NO git command run on an unsafe path. Never runs push/reset/checkout/stash/branch/tag/
   * merge/rebase. Approval gating is the manager's job.
   */
  async commitFiles(rootPath: string, files: string[], message: string, options?: { newFiles?: string[] }): Promise<GitCommitResult> {
    const safeFiles = assertSafeCommitPaths(files); // throws (no git run) on absolute/traversal/empty
    const newFiles =
      options?.newFiles !== undefined && options.newFiles.length > 0 ? assertSafeNewFiles(options.newFiles, safeFiles) : [];

    if (newFiles.length > 0) {
      // A "new" file that is already tracked must never reach `git add`/`git rm --cached` (the compensation would
      // otherwise stage a deletion of a tracked file).
      const tracked = this.exec(rootPath, ['--no-pager', 'ls-files', '--', ...newFiles]);
      if (tracked.code !== 0) throw this.failure('ls-files', tracked);
      if (tracked.stdout.trim().length > 0) throw new Error('git commit rejects a new file that is already tracked');
      const addRes = this.exec(rootPath, ['--no-pager', 'add', '--', ...newFiles]);
      if (addRes.code !== 0) throw this.failure('add', addRes);
    }

    // `--only` commits exactly these pathspecs from the working tree, ignoring other index entries; the
    // message is a single argv element (never shell-interpolated); `--` separates the pathspecs.
    const commitRes = this.exec(rootPath, ['--no-pager', 'commit', '--only', '-m', message, '--', ...safeFiles]);
    if (commitRes.code !== 0) {
      if (newFiles.length > 0) this.unstageNewFiles(rootPath, newFiles);
      throw this.failure('commit', commitRes);
    }
    const headRes = this.exec(rootPath, ['--no-pager', 'rev-parse', 'HEAD']);
    if (headRes.code !== 0) throw this.failure('commit', headRes);
    return { commitHash: headRes.stdout.trim(), committedFiles: safeFiles, message };
  }

  /** Best-effort compensation after a failed new-file commit: drop the index entries `git add` created. */
  private unstageNewFiles(rootPath: string, newFiles: string[]): void {
    try {
      this.exec(rootPath, ['--no-pager', 'rm', '--cached', '--quiet', '--', ...newFiles]);
    } catch {
      // best-effort: the original commit failure is the error the caller must see
    }
  }

  /** True while a merge / rebase / cherry-pick / revert is in progress (state files via `rev-parse --git-path`). */
  private hasOperationInProgress(rootPath: string): boolean {
    for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const res = this.exec(rootPath, ['--no-pager', 'rev-parse', '--git-path', name]);
      if (res.code !== 0) throw this.failure('rev-parse', res); // cannot prove "no operation" → fail closed
      const p = res.stdout.trim();
      if (p.length > 0 && existsSync(resolve(rootPath, p))) return true;
    }
    return false;
  }

  /**
   * Owner LOCAL branch creation (CAP-002, ADR-0099 D4). Every refusal happens BEFORE `git switch -c`:
   * unsafe/protected name or malformed SHA (no git run), a merge/rebase/cherry-pick in progress, a detached or
   * unborn HEAD, HEAD != `expectedHeadSha` (compare-and-swap; a 7+ char prefix of the full sha is accepted), or
   * an existing `refs/heads/<branch>`. Then ONE `git switch -c <branch>` (carries a dirty tree; never forces,
   * never touches a remote) and a read-back (`info().branch === branch`, HEAD unchanged).
   */
  async createBranch(rootPath: string, branch: string, expectedHeadSha: string): Promise<GitBranchResult> {
    if (!isCreatableOwnerBranch(branch)) throw new Error('git branch create rejects an unsafe or protected branch name');
    if (!SYNC_SHA_SHAPED.test(expectedHeadSha)) throw new Error('git branch create rejects an invalid expected HEAD');
    if (this.hasOperationInProgress(rootPath)) throw new Error('git branch create refused: a merge, rebase or cherry-pick is in progress');
    const sym = this.exec(rootPath, ['--no-pager', 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (sym.code !== 0 || sym.stdout.trim() === '') throw new Error('git branch create refused: HEAD is detached');
    const head = this.exec(rootPath, ['--no-pager', 'rev-parse', 'HEAD']);
    const headSha = head.code === 0 ? head.stdout.trim().toLowerCase() : '';
    if (!SYNC_SHA_SHAPED.test(headSha) || !headSha.startsWith(expectedHeadSha.toLowerCase())) {
      throw new Error('git branch create refused: HEAD does not match the expected commit');
    }
    const exists = this.exec(rootPath, ['--no-pager', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.code === 0) throw new Error('git branch create refused: the branch already exists');

    const res = this.exec(rootPath, ['--no-pager', 'switch', '-c', branch]);
    if (res.code !== 0) throw this.failure('switch', res);
    return this.verifyBranchState(rootPath, branch, true, headSha);
  }

  /**
   * Owner LOCAL branch switch (CAP-002, ADR-0099 D4). Refuses BEFORE any switch: unsafe/protected name (no git
   * run), a merge/rebase/cherry-pick in progress, a detached HEAD, a missing LOCAL branch (never creates a
   * remote-tracking branch), or any non-clean tree (staged, unstaged or untracked). Then ONE
   * `git switch --no-guess <branch>` and a read-back.
   */
  async switchBranch(rootPath: string, branch: string): Promise<GitBranchResult> {
    if (!isCreatableOwnerBranch(branch)) throw new Error('git branch switch rejects an unsafe or protected branch name');
    if (this.hasOperationInProgress(rootPath)) throw new Error('git branch switch refused: a merge, rebase or cherry-pick is in progress');
    const sym = this.exec(rootPath, ['--no-pager', 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (sym.code !== 0 || sym.stdout.trim() === '') throw new Error('git branch switch refused: HEAD is detached');
    const exists = this.exec(rootPath, ['--no-pager', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.code !== 0) throw new Error('git branch switch refused: no such local branch');
    const status = await this.status(rootPath);
    if (!status.clean || status.hasUnmergedPaths) throw new Error('git branch switch refused: the working tree is not clean');

    const res = this.exec(rootPath, ['--no-pager', 'switch', '--no-guess', branch]);
    if (res.code !== 0) throw this.failure('switch', res);
    return this.verifyBranchState(rootPath, branch, false);
  }

  /** Read back the checkout after a branch operation; throws when it is not the requested branch. */
  private async verifyBranchState(rootPath: string, branch: string, created: boolean, expectedHeadSha?: string): Promise<GitBranchResult> {
    const info = await this.info(rootPath);
    const headSha = info.headSha ?? '';
    if (info.detached || info.branch !== branch || !SYNC_SHA_SHAPED.test(headSha)) {
      throw new Error('git branch operation could not be verified: the checkout is not the requested branch');
    }
    if (expectedHeadSha !== undefined && headSha.toLowerCase() !== expectedHeadSha) {
      throw new Error('git branch operation could not be verified: HEAD moved');
    }
    return { branch, headSha, created };
  }

  /**
   * The SECOND mutating git operation (CAP-002, ADR-0048) — the first REMOTE mutation. Pushes EXACTLY the
   * current HEAD to `<remote> HEAD:refs/heads/<branch>`. Argument-array only (no shell); a single `git --no-pager push
   * <remote> HEAD:refs/heads/<branch>` — NEVER `--force`/`-f`/`--tags`/`--all`/`-u`/`--set-upstream`/bare `git push`/an
   * arbitrary refspec. The target is conservatively validated first (CA #4/#5) → throws with NO git command
   * run on an unsafe remote/branch/hash. Returns the provider-reported target (NOT independent remote
   * verification). Approval gating is the manager's job.
   */
  async pushApprovedCommit(rootPath: string, remote: string, branch: string, commitHash: string): Promise<GitPushResult> {
    assertSafePushTarget(remote, branch, commitHash); // throws (no git run) on an unsafe target
    // exactly one refspec argv element `HEAD:refs/heads/<branch>` (fully qualified, ADR-0099 — so a branch that
    // does not exist on the remote yet is created unambiguously; never a shell string); pushes the current HEAD.
    const res = this.exec(rootPath, ['--no-pager', 'push', remote, `HEAD:refs/heads/${branch}`]);
    if (res.code !== 0) throw this.failure('push', res);
    return { remote, branch, upstreamRef: `${remote}/${branch}`, commitHash };
  }

  /** READ-ONLY (ADR-0058): the remote branch tip via `git ls-remote` — no local ref/working-tree change. */
  async getRemoteRefCommit(rootPath: string, remote: string, branch: string): Promise<{ commitHash: string }> {
    if (!isSafePushRemote(remote) || !isSafePushBranch(branch)) throw new Error('git ls-remote rejects an unsafe target');
    const res = this.exec(rootPath, ['--no-pager', 'ls-remote', '--exit-code', remote, `refs/heads/${branch}`]);
    if (res.code !== 0) throw this.failure('ls-remote', res);
    const sha = res.stdout.trim().split(/\s+/)[0] ?? '';
    if (!SYNC_SHA_SHAPED.test(sha)) throw new Error('git ls-remote returned an invalid commit');
    return { commitHash: sha };
  }

  /** READ-ONLY (ADR-0058): the local branch tip, or null when the branch does not exist. */
  async getLocalRefCommit(rootPath: string, branch: string): Promise<{ commitHash: string } | null> {
    if (!isSafePushBranch(branch)) throw new Error('git rev-parse rejects an unsafe branch');
    const res = this.exec(rootPath, ['--no-pager', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (res.code !== 0) return null; // branch does not exist
    const sha = res.stdout.trim();
    if (!SYNC_SHA_SHAPED.test(sha)) throw new Error('git rev-parse returned an invalid commit');
    return { commitHash: sha };
  }

  /**
   * The THIRD mutating git operation (CAP-002, ADR-0058) — a FAST-FORWARD-ONLY local `main` sync, mode-split by the
   * current checkout, compare-and-swap guarded on `expectedPreviousCommit`. Argument-array only (no shell). NEVER
   * `--force`/`-f`, NEVER `reset --hard`, NEVER a push, NEVER a checkout switch (ref-only), NEVER a branch deletion.
   * PHASE-AWARE errors (CA change 2/3): fetch / fetched-tip mismatch / non-fast-forward / detached / CAS-precheck
   * failures are PRE-ref-update → GitMainSyncBlockedError; the ff-only merge / update-ref and the read-back are the
   * ref-update phase → GitMainSyncUnverifiedError on failure.
   */
  async syncMainFastForward(
    rootPath: string,
    remote: string,
    branch: string,
    expectedRemoteCommit: string,
    expectedPreviousCommit: string,
  ): Promise<GitMainSyncResult> {
    // Defensive (throws plain Error → Manager treats as pre-mutation; but these are backstops — the Manager pre-validated).
    if (!isSafePushRemote(remote)) throw new GitMainSyncBlockedError('git main sync rejects an unsafe remote');
    if (!isSafePushBranch(branch)) throw new GitMainSyncBlockedError('git main sync rejects an unsafe branch');
    if (!SYNC_SHA_SHAPED.test(expectedRemoteCommit) || !SYNC_SHA_SHAPED.test(expectedPreviousCommit)) {
      throw new GitMainSyncBlockedError('git main sync rejects an invalid commit');
    }

    // ── PRE-ref-update phase → GitMainSyncBlockedError on any failure (nothing local moved). ────────────────
    // 1. bounded fetch of the remote branch (updates FETCH_HEAD / remote-tracking ref; no working-tree change).
    const fetchRes = this.exec(rootPath, ['--no-pager', 'fetch', '--no-tags', remote, branch]);
    if (fetchRes.code !== 0) {
      const why = fetchRes.timedOut ? `timed out after ${GIT_FETCH_TIMEOUT_MS}ms` : sanitizeGitStderr(fetchRes.stderr);
      throw new GitMainSyncBlockedError(`git main sync: fetch failed: ${why}`);
    }
    // 2. verify the fetched tip equals the expected remote commit (else stale).
    const fetched = this.exec(rootPath, ['--no-pager', 'rev-parse', '--verify', '--quiet', 'FETCH_HEAD']);
    if (fetched.code !== 0 || fetched.stdout.trim() !== expectedRemoteCommit) {
      throw new GitMainSyncBlockedError('git main sync: fetched remote tip does not match the expected commit; not synchronized');
    }
    // 3. verify fast-forward is possible: previous main is an ancestor of the expected commit.
    const anc = this.exec(rootPath, ['--no-pager', 'merge-base', '--is-ancestor', expectedPreviousCommit, expectedRemoteCommit]);
    if (anc.code === 1) throw new GitMainSyncBlockedError('git main sync: not a fast-forward (local main is not an ancestor); not synchronized');
    if (anc.code !== 0) throw new GitMainSyncBlockedError('git main sync: could not determine fast-forward safety; not synchronized');
    // 4. current checkout → mode; detached HEAD → Blocked.
    const sym = this.exec(rootPath, ['--no-pager', 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const attached = sym.code === 0 && sym.stdout.trim() !== '';
    if (!attached) throw new GitMainSyncBlockedError('git main sync: HEAD is detached; not synchronized');
    const currentBranch = sym.stdout.trim();
    const syncMode: GitMainSyncResult['syncMode'] = currentBranch === branch ? 'checked-out-main' : 'ref-only';
    // 5. CAS precheck: local main is still the observed previous commit (else it moved before the update).
    const localNow = this.exec(rootPath, ['--no-pager', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (localNow.code !== 0 || localNow.stdout.trim() !== expectedPreviousCommit) {
      throw new GitMainSyncBlockedError('git main sync: local main moved before the update; not synchronized');
    }

    // Already up to date → no ref move (still a success; no working-tree change).
    if (expectedPreviousCommit === expectedRemoteCommit) {
      return { branch, syncMode, workingTreeUpdated: false, syncedCommitHash: expectedRemoteCommit, previousMainCommit: expectedPreviousCommit, alreadyUpToDate: true };
    }

    // ── REF-UPDATE phase (+ read-back) → GitMainSyncUnverifiedError on any failure (the ref may have moved). ─
    let workingTreeUpdated: boolean;
    if (syncMode === 'checked-out-main') {
      // ff-only merge moves the checked-out main + working tree/index (never a merge commit, never a reset).
      const ff = this.exec(rootPath, ['--no-pager', 'merge', '--ff-only', expectedRemoteCommit]);
      if (ff.code !== 0) throw new GitMainSyncUnverifiedError(`git main sync: fast-forward merge could not be verified: ${sanitizeGitStderr(ff.stderr)}`);
      workingTreeUpdated = true;
    } else {
      // ref-only: git-native CAS update of refs/heads/main; the current checkout/working tree are untouched.
      const upd = this.exec(rootPath, ['--no-pager', 'update-ref', `refs/heads/${branch}`, expectedRemoteCommit, expectedPreviousCommit]);
      if (upd.code !== 0) throw new GitMainSyncUnverifiedError(`git main sync: ref update could not be verified: ${sanitizeGitStderr(upd.stderr)}`);
      workingTreeUpdated = false;
    }
    // read back the local main commit and verify it reached the expected commit.
    const after = this.exec(rootPath, ['--no-pager', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (after.code !== 0 || after.stdout.trim() !== expectedRemoteCommit) {
      throw new GitMainSyncUnverifiedError('git main sync: local main did not reach the expected commit');
    }
    return { branch, syncMode, workingTreeUpdated, syncedCommitHash: expectedRemoteCommit, previousMainCommit: expectedPreviousCommit, alreadyUpToDate: false };
  }

  /** READ-ONLY (ADR-0059): is `ancestor` an ancestor of `descendant`? `git merge-base --is-ancestor` (exit 0 = yes,
   *  1 = no; other = error → throw). No mutation. */
  async isAncestor(rootPath: string, ancestor: string, descendant: string): Promise<boolean> {
    if (!SYNC_SHA_SHAPED.test(ancestor) || !SYNC_SHA_SHAPED.test(descendant)) throw new Error('git merge-base rejects an invalid commit');
    const res = this.exec(rootPath, ['--no-pager', 'merge-base', '--is-ancestor', ancestor, descendant]);
    if (res.code === 0) return true;
    if (res.code === 1) return false;
    throw this.failure('merge-base', res);
  }

  /**
   * The FOURTH mutating git operation (CAP-002, ADR-0059) — a CAS delete of a fully-merged LOCAL branch via
   * `git update-ref -d refs/heads/<branch> <expectedBranchCommit>` (deterministic; NOT `git branch -d`, so it does
   * not depend on the current HEAD/checkout — CA change 3). Argument-array only. NEVER `-D`/`--force`, NEVER 'main',
   * NEVER a remote ref, NEVER a wildcard/pattern, NEVER a checkout switch. PHASE-AWARE (CA change 2): a pre-ref-delete
   * mismatch/absence (the branch moved or is gone vs `expectedBranchCommit`) throws BranchCleanupBlockedError; a
   * failure AT/AFTER the `update-ref -d` attempt (incl. a read-back that still sees the ref) throws
   * BranchCleanupUnverifiedError.
   */
  async deleteMergedLocalBranch(rootPath: string, branch: string, expectedBranchCommit: string): Promise<GitBranchCleanupResult> {
    if (!isSafePushBranch(branch)) throw new BranchCleanupBlockedError('git branch cleanup rejects an unsafe branch');
    if (branch === 'main') throw new BranchCleanupBlockedError('git branch cleanup never deletes main');
    if (!SYNC_SHA_SHAPED.test(expectedBranchCommit)) throw new BranchCleanupBlockedError('git branch cleanup rejects an invalid commit');

    // ── PRE-ref-delete phase → BranchCleanupBlockedError (nothing deleted). CAS precheck: the branch still points
    //    at expectedBranchCommit. Absent or moved → Blocked. ──────────────────────────────────────────────────
    const current = this.exec(rootPath, ['--no-pager', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (current.code !== 0 || current.stdout.trim() !== expectedBranchCommit) {
      throw new BranchCleanupBlockedError('git branch cleanup: target branch moved or is absent; not deleted');
    }

    // ── REF-DELETE phase (+ read-back) → BranchCleanupUnverifiedError on any failure (the ref MAY be gone). CAS
    //    delete: update-ref -d removes the ref ONLY if it still equals expectedBranchCommit. No `git branch -d`. ─
    const del = this.exec(rootPath, ['--no-pager', 'update-ref', '-d', `refs/heads/${branch}`, expectedBranchCommit]);
    if (del.code !== 0) {
      throw new BranchCleanupUnverifiedError(`git branch cleanup: branch delete could not be verified: ${sanitizeGitStderr(del.stderr)}`);
    }
    const readBack = this.exec(rootPath, ['--no-pager', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (readBack.code === 0) {
      throw new BranchCleanupUnverifiedError('git branch cleanup: branch still exists after delete');
    }
    return { branch, deleted: true, alreadyAbsent: false, deletedCommitHash: expectedBranchCommit };
  }
}

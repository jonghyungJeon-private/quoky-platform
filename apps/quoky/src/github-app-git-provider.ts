import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitMainSyncBlockedError, GitPushBlockedError } from '@quoky/core';
import type {
  GitBranchCleanupResult,
  GitBranchResult,
  GitCommitResult,
  GitDiff,
  GitMainSyncResult,
  GitProvider,
  GitPushResult,
  GitStatus,
  RepositoryInfo,
} from '@quoky/core';
import type { GitRunResult, GitRunner } from '@quoky/git-local';

/**
 * One-shot `GIT_ASKPASS` script (ADR-0061 Q3 / RC1). git invokes it when it needs HTTPS credentials: it returns the
 * username `x-access-token` and, for the password prompt, the token from the **child** process env `$GIT_APP_TOKEN`.
 * The script contains **no token literal** — the secret lives only in the child env, never in this file.
 */
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s' 'x-access-token' ;;
  *) printf '%s' "$GIT_APP_TOKEN" ;;
esac
`;

/** Timeout for the local `git remote get-url` read used by the HTTPS preflight. */
const REMOTE_URL_READ_TIMEOUT_MS = 5000;

/** Which remote URLs an operation uses: `'fetch'` → fetch URLs only; `'push'` → fetch and push URLs. */
export type RemoteDirection = 'fetch' | 'push';

/** A git spawn that mirrors git-local's `defaultGitRunner` but takes an explicit child env (carries the credential). */
export type CredentialedSpawn = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
  env: NodeJS.ProcessEnv,
) => GitRunResult;

export interface GitHubAppGitProviderDeps {
  /**
   * Build a `LocalGitProvider` bound to a specific `GitRunner`. The composition root supplies
   * `(runner) => new LocalGitProvider(runner)`; injected so this decorator carries no dependency on the git-local
   * package's class and stays unit-testable.
   */
  makeLocalGit: (runner?: GitRunner) => GitProvider;
  /** Mint (or return a cached) short-lived installation token for the target repo. Adapter-local; never stored here. */
  tokenSource: () => Promise<string>;
  /**
   * Read the configured remote URL(s) for the HTTPS-github.com preflight (RC1). Injectable for tests; the default
   * runs credential-free local `git remote get-url --all` and `--push --all` reads (no network, no askpass) under
   * `env` — the same sanitized git-config env the credentialed child runs with, so an `insteadOf`/`pushurl`
   * rewrite cannot differ between preflight and execution. `direction` scopes the read: `'fetch'` (ls-remote /
   * main sync) reads the fetch URLs; `'push'` also reads every push URL. Every returned URL is checked. Throws when
   * unreadable.
   */
  readRemoteUrl?: (
    rootPath: string,
    remote: string,
    env: NodeJS.ProcessEnv,
    direction: RemoteDirection,
  ) => string | readonly string[];
  /** Spawn git with an explicit child env. Injectable for tests; the default mirrors git-local's `defaultGitRunner`. */
  spawn?: CredentialedSpawn;
}

/**
 * **Composition-root `GitProvider` decorator (CAP-002 App-auth git credentialing; ADR-0061 Q3/Q4/Q5 + Sprint 4b
 * review RC1/RC3).**
 *
 * Wraps an **unchanged** `LocalGitProvider`. Local operations delegate directly. The three remote-touching
 * operations (`pushApprovedCommit` / `getRemoteRefCommit` / `syncMainFastForward`) run a strict **pre-mutation**
 * sequence BEFORE any git spawn:
 *   1. read the configured remote URL and require an **HTTPS github.com** remote — SSH (scp-like or `ssh://`),
 *      non-GitHub HTTPS, credential-embedding, and unreadable remotes are **Blocked** (RC1); this prevents any
 *      ambient SSH/keychain/OAuth/PAT fallback;
 *   2. mint a short-lived installation token;
 *   3. materialize a **one-shot `GIT_ASKPASS`** whose token lives ONLY in the child env.
 * Any pre-mutation failure is mapped to the operation's **typed Blocked error** ("did not happen"). The inner git
 * op runs at the mutation boundary; its throw (including a typed `GitMainSync{Blocked,Unverified}Error`) propagates
 * unchanged, so an at/after-mutation ambiguity stays **Unverified**. The token never enters argv, a remote URL,
 * `.git/config`, logs, anchors, approval reasons, Discord, or evidence; the per-invocation temp helper is removed
 * in a `finally`; `process.env` is never mutated (concurrency-safe).
 */
export class GitHubAppGitProvider implements GitProvider {
  private readonly localGit: GitProvider;
  private readonly readRemoteUrl: NonNullable<GitHubAppGitProviderDeps['readRemoteUrl']>;
  private readonly spawn: CredentialedSpawn;

  constructor(private readonly deps: GitHubAppGitProviderDeps) {
    this.localGit = deps.makeLocalGit();
    this.readRemoteUrl = deps.readRemoteUrl ?? defaultReadRemoteUrl;
    this.spawn = deps.spawn ?? defaultCredentialedSpawn;
  }

  get kind(): string {
    return this.localGit.kind;
  }

  // ── Local operations — delegated unchanged (no credential, no remote) ─────────────────────────────────────
  isRepository(rootPath: string): Promise<boolean> {
    return this.localGit.isRepository(rootPath);
  }

  info(rootPath: string): Promise<RepositoryInfo> {
    return this.localGit.info(rootPath);
  }

  status(rootPath: string): Promise<GitStatus> {
    return this.localGit.status(rootPath);
  }

  diff(rootPath: string): Promise<GitDiff> {
    return this.localGit.diff(rootPath);
  }

  commitFiles(
    rootPath: string,
    files: string[],
    message: string,
    options?: { newFiles?: string[] },
  ): Promise<GitCommitResult> {
    return options === undefined
      ? this.localGit.commitFiles(rootPath, files, message)
      : this.localGit.commitFiles(rootPath, files, message, options);
  }

  // ADR-0099: owner local branch create/switch — purely local ref operations, so no remote preflight, no token mint.
  createBranch(rootPath: string, branch: string, expectedHeadSha: string): Promise<GitBranchResult> {
    return this.localGit.createBranch(rootPath, branch, expectedHeadSha);
  }

  switchBranch(rootPath: string, branch: string): Promise<GitBranchResult> {
    return this.localGit.switchBranch(rootPath, branch);
  }

  getLocalRefCommit(rootPath: string, branch: string): Promise<{ commitHash: string } | null> {
    return this.localGit.getLocalRefCommit(rootPath, branch);
  }

  isAncestor(rootPath: string, ancestor: string, descendant: string): Promise<boolean> {
    return this.localGit.isAncestor(rootPath, ancestor, descendant);
  }

  deleteMergedLocalBranch(
    rootPath: string,
    branch: string,
    expectedBranchCommit: string,
  ): Promise<GitBranchCleanupResult> {
    return this.localGit.deleteMergedLocalBranch(rootPath, branch, expectedBranchCommit);
  }

  // ── Remote-touching operations — HTTPS preflight + App token via one-shot GIT_ASKPASS ────────────────────
  pushApprovedCommit(rootPath: string, remote: string, branch: string, commitHash: string): Promise<GitPushResult> {
    // Pre-mutation credential/preflight failure → GitPushBlockedError ("not pushed"); the runtime maps it to the
    // Blocked "not attempted" reply. An inner push throw (at/after the attempt) propagates → Unverified upstream.
    return this.withRemoteCredential(
      rootPath,
      remote,
      'push',
      (err) => new GitPushBlockedError(preMutationMessage('git push', err)),
      (git) => git.pushApprovedCommit(rootPath, remote, branch, commitHash),
    );
  }

  getRemoteRefCommit(rootPath: string, remote: string, branch: string): Promise<{ commitHash: string }> {
    // getRemoteRefCommit's contract is to throw on failure; the GitManager maps a read throw to a pre-mutation
    // Blocked. A pre-mutation credential/preflight failure therefore stays a (sanitized) throw — consistent taxonomy.
    return this.withRemoteCredential(
      rootPath,
      remote,
      'fetch',
      (err) =>
        err instanceof Error
          ? err
          : new Error('git ls-remote: could not obtain App credentials or the remote is not HTTPS github.com'),
      (git) => git.getRemoteRefCommit(rootPath, remote, branch),
    );
  }

  syncMainFastForward(
    rootPath: string,
    remote: string,
    branch: string,
    expectedRemoteCommit: string,
    expectedPreviousCommit: string,
  ): Promise<GitMainSyncResult> {
    // Pre-mutation credential/preflight failure → GitMainSyncBlockedError ("not synchronized"). An inner typed
    // GitMainSync{Blocked,Unverified}Error propagates unchanged (Blocked/Unverified preserved).
    return this.withRemoteCredential(
      rootPath,
      remote,
      'fetch',
      (err) => new GitMainSyncBlockedError(`${preMutationMessage('git main sync', err)}; not synchronized`),
      (git) => git.syncMainFastForward(rootPath, remote, branch, expectedRemoteCommit, expectedPreviousCommit),
    );
  }

  /**
   * PRE-MUTATION: HTTPS-github.com remote preflight → token mint → one-shot `GIT_ASKPASS`. Any failure here is
   * mapped by `mapPreMutationError` to the operation's typed Blocked error (the remote git op was never attempted).
   * MUTATION BOUNDARY: the inner `op` runs git through a runner whose token lives only in the child env; its throw
   * (including typed Blocked/Unverified) propagates unchanged. The temp helper is removed in a `finally`.
   */
  private async withRemoteCredential<T>(
    rootPath: string,
    remote: string,
    direction: RemoteDirection,
    mapPreMutationError: (err: unknown) => Error,
    op: (git: GitProvider) => Promise<T>,
  ): Promise<T> {
    let dir: string | undefined;
    let runner: GitRunner;
    try {
      // Preflight and execution share ONE sanitized git-config env: inherited env-injected config is dropped and every
      // credential helper (system/global/repo, e.g. macOS `osxkeychain`) is reset. An ambient helper is consulted
      // BEFORE GIT_ASKPASS, so it would shadow the App token with another identity's credential, and on success git
      // would `approve` (persist) the App token into that helper. An empty value clears the helper list.
      const gitConfigEnv: NodeJS.ProcessEnv = {
        ...withoutInheritedGitConfigEnv(process.env),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
      };
      const remoteUrls = this.readRemoteUrl(rootPath, remote, gitConfigEnv, direction); // unreadable → throws
      const urls = typeof remoteUrls === 'string' ? [remoteUrls] : remoteUrls;
      if (urls.length === 0) throw new Error('git remote url could not be read');
      for (const url of urls) assertHttpsGithubRemote(url); // ssh / non-github / embedded-credential → throws
      const token = await this.deps.tokenSource(); // mint failure → throws
      dir = mkdtempSync(join(tmpdir(), 'quoky-askpass-'));
      const askpassPath = join(dir, 'askpass.sh');
      writeFileSync(askpassPath, ASKPASS_SCRIPT, { mode: 0o700 });
      const childEnv: NodeJS.ProcessEnv = {
        ...gitConfigEnv,
        GIT_ASKPASS: askpassPath,
        GIT_APP_TOKEN: token,
        GIT_TERMINAL_PROMPT: '0',
      };
      const spawn = this.spawn;
      runner = (args, opts) => spawn(args, opts, childEnv);
    } catch (err) {
      safeRemove(dir);
      throw mapPreMutationError(err); // PRE-MUTATION → op-specific typed Blocked
    }
    try {
      return await op(this.deps.makeLocalGit(runner)); // MUTATION BOUNDARY — inner throw propagates unchanged
    } finally {
      safeRemove(dir);
    }
  }
}

/**
 * Require an **HTTPS github.com** remote (ADR-0061 RC1). Blocks scp-like SSH (`git@github.com:owner/repo.git`),
 * `ssh://`, any non-HTTPS scheme, non-github.com hosts, and credential-embedding URLs. Throws (→ pre-mutation
 * Blocked) so an App-auth remote git op never silently falls back to an ambient SSH/keychain/OAuth/PAT credential.
 * Exported for direct unit testing.
 */
export function assertHttpsGithubRemote(url: string): void {
  const u = url.trim();
  // scp-like SSH ([user@]host:path with NO scheme) → block.
  if (/^[^\s/@]+@[^\s/:]+:/.test(u) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
    throw new Error('App-auth requires an HTTPS github.com remote; an SSH (scp-like) remote is blocked');
  }
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error('App-auth remote URL is unreadable/unparseable');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`App-auth requires an HTTPS remote; "${parsed.protocol}" is blocked`);
  }
  if (parsed.hostname !== 'github.com') {
    throw new Error(`App-auth requires a github.com remote; "${parsed.hostname}" is blocked`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('App-auth remote URL must not embed credentials');
  }
}

/** Sanitized pre-mutation message. The pre-mutation errors (remote preflight / AppAuthError) never carry a token. */
function preMutationMessage(op: string, err: unknown): string {
  const detail = err instanceof Error && err.message ? err.message : 'credential/remote preflight failed';
  return `${op}: ${detail}`;
}

/** Best-effort removal of the one-shot askpass dir; never masks the operation's result/error. */
/**
 * Drop inherited env-injected git config — `GIT_CONFIG_PARAMETERS` (`git -c`, applied AFTER `GIT_CONFIG_COUNT`) and
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` — so the preflight read and the credentialed
 * child see exactly the credential-helper reset set by `withRemoteCredential` (an inherited entry could otherwise
 * re-add a helper, rewrite the remote URL, or be silently truncated by our count).
 */
function withoutInheritedGitConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'GIT_CONFIG_PARAMETERS' || key === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function safeRemove(dir: string | undefined): void {
  if (dir === undefined) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Default HTTPS-preflight remote read: credential-free local `git remote get-url --all <remote>` and, for a push,
 * `git remote get-url --push --all <remote>` (no network), so every URL the operation can use (incl. a `pushurl`
 * and `insteadOf`/`pushInsteadOf` rewrites, as resolved under `env`) is checked.
 */
function defaultReadRemoteUrl(
  rootPath: string,
  remote: string,
  env: NodeJS.ProcessEnv,
  direction: RemoteDirection,
): readonly string[] {
  const reads = [['remote', 'get-url', '--all', remote]];
  if (direction === 'push') reads.push(['remote', 'get-url', '--push', '--all', remote]);
  const urls: string[] = [];
  for (const args of reads) {
    const res = spawnSync('git', args, { cwd: rootPath, timeout: REMOTE_URL_READ_TIMEOUT_MS, encoding: 'utf8', env });
    const lines = typeof res.stdout === 'string' ? res.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    if (res.status !== 0 || lines.length === 0) throw new Error('git remote url could not be read');
    urls.push(...lines);
  }
  return urls;
}

/** Default credentialed spawn: mirrors git-local's `defaultGitRunner` but with an explicit child env. */
function defaultCredentialedSpawn(
  args: string[],
  opts: { cwd: string; timeoutMs: number },
  env: NodeJS.ProcessEnv,
): GitRunResult {
  const res = spawnSync('git', args, { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8', env });
  const timedOut = !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
    failed: !!res.error && !timedOut,
  };
}

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
  RepositoryIdentity,
  RepositoryInfo,
} from '@quoky/core';
import { gitSubcommand } from '@quoky/git-local';
import type { GitRunResult, GitRunner } from '@quoky/git-local';
import { canonicalGithubUrl, isSafeRemoteName, resolveRepositoryFromRemoteUrls } from './repository-allowlist';
import type { RepositoryAllowlist } from './repository-allowlist';

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
  /**
   * Mint (or return a cached) short-lived installation token for exactly `identity` — the one repository the
   * operation's remote URLs resolved to (ADR-0109 D3). Adapter-local; never stored here.
   *
   * ABSENT = the ambient-credential mode (dev PAT REST auth, or no hosting auth): no token and no askpass, and the
   * developer's own credential helpers are kept, but everything else is identical — the inherited env-injected git
   * config is dropped, the target is resolved and allowlist-checked, and the operation runs against the validated
   * canonical URL (ADR-0109 review P1).
   */
  tokenSource?: (identity: RepositoryIdentity) => Promise<string>;
  /**
   * The validated repository allowlist (ADR-0109 D1/D2). Every URL an operation uses must name the same allowlisted
   * repository — and, for a remote other than `origin`, the same repository as `origin` — before any token is minted.
   */
  allowlist: RepositoryAllowlist;
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
  /**
   * The values of every `url.<base>.insteadOf` / `url.<base>.pushInsteadOf` rule visible under `env` (ADR-0109 review
   * P2): git applies them to an explicit URL argument too, so a rule matching the validated canonical URL refuses the
   * operation. Injectable for tests; the default is a credential-free local `git config --get-regexp`. Throws when
   * unreadable.
   */
  readUrlRewrites?: (rootPath: string, env: NodeJS.ProcessEnv) => readonly string[];
  /**
   * After a successful push to the canonical URL, move the local remote-tracking ref `refs/remotes/<remote>/<branch>`
   * to the pushed commit when it already exists (what a push by remote name would have done). Local only, best effort,
   * never a network call. Injectable for tests.
   */
  updateTrackingRef?: (rootPath: string, remote: string, branch: string, env: NodeJS.ProcessEnv) => void;
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
  private readonly readUrlRewrites: NonNullable<GitHubAppGitProviderDeps['readUrlRewrites']>;
  private readonly updateTrackingRef: NonNullable<GitHubAppGitProviderDeps['updateTrackingRef']>;

  constructor(private readonly deps: GitHubAppGitProviderDeps) {
    this.localGit = deps.makeLocalGit();
    this.readRemoteUrl = deps.readRemoteUrl ?? defaultReadRemoteUrl;
    this.spawn = deps.spawn ?? defaultCredentialedSpawn;
    this.readUrlRewrites = deps.readUrlRewrites ?? defaultReadUrlRewrites;
    this.updateTrackingRef = deps.updateTrackingRef ?? defaultUpdateTrackingRef;
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
   * PRE-MUTATION: resolve the operation's target → (App mode) token mint → one-shot `GIT_ASKPASS` → a runner BOUND to
   * the validated target. Any failure here is mapped by `mapPreMutationError` to the operation's typed Blocked error
   * (the remote git op was never attempted).
   *
   * Target resolution (ADR-0109 D2 + review P1/P2): every URL of the operation's remote (fetch, plus push URLs for a
   * push, after git's `insteadOf`/`pushInsteadOf` expansion) must be HTTPS github.com, and — together with `origin`'s
   * URLs when the remote is another one — name ONE allowlisted repository; no URL-rewrite rule may match that
   * repository's canonical URL. The token (App mode) is minted for exactly that repository.
   *
   * Binding: the bound runner never lets git resolve the remote by name. The single remote positional of the network
   * subcommand (`push` / `fetch` / `ls-remote`) is replaced by the validated canonical URL, and the whole resolution is
   * re-run synchronously right before that spawn (so a config change during the token await is caught); a difference
   * throws the op's Blocked error before any network process starts. Local subcommands run unchanged.
   *
   * MUTATION BOUNDARY: the inner `op` runs git through that runner; its throw (including typed Blocked/Unverified)
   * propagates unchanged. The temp helper is removed in a `finally`.
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
      // Preflight and execution share ONE git-config env: inherited env-injected config (`GIT_CONFIG_PARAMETERS`,
      // `GIT_CONFIG_COUNT/KEY/VALUE`) is always dropped. In App mode every credential helper (system/global/repo, e.g.
      // macOS `osxkeychain`) is also reset: an ambient helper is consulted BEFORE GIT_ASKPASS, so it would shadow the
      // App token with another identity's credential, and on success git would `approve` (persist) the App token into
      // that helper. In ambient mode the developer's own helpers are the credential, so they stay.
      const appMode = this.deps.tokenSource !== undefined;
      const gitConfigEnv = appMode ? sanitizedGitConfigEnv(process.env) : withoutInheritedGitConfigEnv(process.env);
      const target = this.resolveTarget(rootPath, remote, gitConfigEnv, direction); // refused → throws
      let childEnv: NodeJS.ProcessEnv = { ...gitConfigEnv, GIT_TERMINAL_PROMPT: '0' };
      if (this.deps.tokenSource) {
        const token = await this.deps.tokenSource(target.identity); // mint failure → throws
        dir = mkdtempSync(join(tmpdir(), 'quoky-askpass-'));
        const askpassPath = join(dir, 'askpass.sh');
        writeFileSync(askpassPath, ASKPASS_SCRIPT, { mode: 0o700 });
        childEnv = { ...childEnv, GIT_ASKPASS: askpassPath, GIT_APP_TOKEN: token };
      }
      runner = this.boundRunner(rootPath, remote, direction, gitConfigEnv, childEnv, target, mapPreMutationError);
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

  /** Resolve and validate the operation's target (see {@link withRemoteCredential}). Synchronous; throws when refused. */
  private resolveTarget(
    rootPath: string,
    remote: string,
    env: NodeJS.ProcessEnv,
    direction: RemoteDirection,
  ): { identity: RepositoryIdentity; url: string } {
    if (!isSafeRemoteName(remote)) throw new Error('the remote name is not a plain remote name; not attempted');
    const urls = [...toUrlList(this.readRemoteUrl(rootPath, remote, env, direction))]; // unreadable → throws
    if (urls.length === 0) throw new Error('git remote url could not be read');
    if (remote !== 'origin') urls.push(...toUrlList(this.readRemoteUrl(rootPath, 'origin', env, direction)));
    for (const url of urls) assertHttpsGithubRemote(url); // ssh / non-github / embedded-credential → throws
    // ADR-0109 D2: the URLs must name ONE allowlisted repository (a non-origin remote: origin's repository too).
    const resolution = resolveRepositoryFromRemoteUrls(urls, this.deps.allowlist);
    if (resolution.status !== 'resolved') throw new Error(repositoryRefusalMessage(resolution.reason));
    const url = canonicalGithubUrl(resolution.identity);
    // git rewrites an explicit URL argument too: no insteadOf / pushInsteadOf rule may match the canonical URL.
    const rewrites = this.readUrlRewrites(rootPath, env);
    if (rewrites.some((prefix) => prefix.trim().length === 0 || url.toLowerCase().startsWith(prefix.trim().toLowerCase()))) {
      throw new Error('a git url rewrite (insteadOf/pushInsteadOf) matches the repository url; not attempted');
    }
    return { identity: resolution.identity, url };
  }

  /**
   * A runner bound to the validated target: network subcommands run against the canonical URL (never the remote
   * name), after a synchronous re-resolution that must yield the same repository; local subcommands pass through.
   */
  private boundRunner(
    rootPath: string,
    remote: string,
    direction: RemoteDirection,
    gitConfigEnv: NodeJS.ProcessEnv,
    childEnv: NodeJS.ProcessEnv,
    target: { identity: RepositoryIdentity; url: string },
    mapPreMutationError: (err: unknown) => Error,
  ): GitRunner {
    const spawn = this.spawn;
    return (args, opts) => {
      const subcommand = gitSubcommand(args);
      if (!NETWORK_SUBCOMMANDS.has(subcommand)) return spawn(args, opts, childEnv);
      const at = remotePositionalIndex(args, subcommand);
      if (at < 0 || args[at] !== remote) {
        throw mapPreMutationError(new Error('unexpected remote argument for a bound git operation; not attempted'));
      }
      // Re-check right before the spawn (synchronous: nothing can interleave between this check and the spawn).
      let again: { identity: RepositoryIdentity; url: string };
      try {
        again = this.resolveTarget(rootPath, remote, gitConfigEnv, direction);
      } catch (err) {
        throw mapPreMutationError(err);
      }
      if (again.url !== target.url) {
        throw mapPreMutationError(new Error('the remote changed after it was validated; not attempted'));
      }
      const bound = [...args];
      bound[at] = target.url;
      const result = spawn(bound, opts, childEnv);
      if (subcommand === 'push' && result.code === 0) {
        const branch = pushedBranchOf(args[at + 1]);
        if (branch) {
          try {
            this.updateTrackingRef(rootPath, remote, branch, gitConfigEnv);
          } catch {
            // best effort: the push itself succeeded; a stale local tracking ref is harmless
          }
        }
      }
      return result;
    };
  }
}

/** The git subcommands that reach a remote; only these are bound to the validated URL. */
const NETWORK_SUBCOMMANDS = new Set(['push', 'fetch', 'ls-remote']);

/** Index of the remote positional (the first non-option argument after the subcommand), or -1. */
function remotePositionalIndex(args: readonly string[], subcommand: string): number {
  const sub = args.indexOf(subcommand);
  if (sub < 0) return -1;
  for (let i = sub + 1; i < args.length; i += 1) {
    if (!(args[i] ?? '').startsWith('-')) return i;
  }
  return -1;
}

/** `HEAD:refs/heads/<branch>` → `<branch>` (the only refspec shape git-local pushes), else undefined. */
function pushedBranchOf(refspec: string | undefined): string | undefined {
  const m = typeof refspec === 'string' ? /^HEAD:refs\/heads\/(.+)$/.exec(refspec) : null;
  return m?.[1];
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

function toUrlList(urls: string | readonly string[]): readonly string[] {
  return typeof urls === 'string' ? [urls] : urls;
}

/** Fixed pre-mutation refusal text per ADR-0109 reason — never a URL. */
function repositoryRefusalMessage(reason: 'not-allowlisted' | 'ambiguous' | 'unsupported-remote'): string {
  if (reason === 'not-allowlisted') return 'the remote repository is not on the allowlist (QUOKY_GITHUB_REPOS); no token minted';
  if (reason === 'ambiguous') return 'the remote URLs name more than one repository; no token minted';
  return 'the remote is not a plain HTTPS github.com repository URL; no token minted';
}

/**
 * The ONE sanitized git-config environment every credential-free remote read and every credentialed child runs with
 * (ADR-0061): inherited env-injected config is dropped and every credential helper is reset (an empty value clears
 * the helper list). Exported so the workspace repository resolver (ADR-0109 D2) reads `origin` exactly as the push
 * would see it.
 */
export function sanitizedGitConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...withoutInheritedGitConfigEnv(env),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
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
export function defaultReadRemoteUrl(
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

/**
 * Default URL-rewrite read: the values of every `url.<base>.insteadOf` / `pushInsteadOf` rule visible under `env`
 * (credential-free local `git config --get-regexp`, no network). Exit 1 = no rule. Anything else throws.
 */
export function defaultReadUrlRewrites(rootPath: string, env: NodeJS.ProcessEnv): readonly string[] {
  const res = spawnSync('git', ['config', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], {
    cwd: rootPath,
    timeout: REMOTE_URL_READ_TIMEOUT_MS,
    encoding: 'utf8',
    env,
  });
  if (res.status === 1 && !res.error) return [];
  if (res.status !== 0 || typeof res.stdout !== 'string') throw new Error('git url rewrite rules could not be read');
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return space < 0 ? '' : line.slice(space + 1);
    });
}

/** Default local tracking-ref update after a bound push: only an EXISTING `refs/remotes/<remote>/<branch>`, CAS. */
function defaultUpdateTrackingRef(rootPath: string, remote: string, branch: string, env: NodeJS.ProcessEnv): void {
  const run = (args: string[]) => spawnSync('git', args, { cwd: rootPath, timeout: REMOTE_URL_READ_TIMEOUT_MS, encoding: 'utf8', env });
  const ref = `refs/remotes/${remote}/${branch}`;
  const old = run(['rev-parse', '--verify', '--quiet', ref]);
  const head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const oldSha = typeof old.stdout === 'string' ? old.stdout.trim() : '';
  const headSha = typeof head.stdout === 'string' ? head.stdout.trim() : '';
  if (old.status !== 0 || head.status !== 0 || !/^[0-9a-f]{40}$/.test(oldSha) || !/^[0-9a-f]{40}$/.test(headSha)) return;
  run(['update-ref', ref, headSha, oldSha]);
}

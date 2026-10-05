import { RemoteBranchCleanupBlockedError, RemoteBranchCleanupUnverifiedError, isSafeGitHubPullRequestUrl } from '@quoky/core';
import type {
  PullRequestChecksState,
  PullRequestCreationInput,
  PullRequestMergeability,
  PullRequestMergePreflight,
  PullRequestMergeResult,
  PullRequestRef,
  PullRequestResult,
  PullRequestReviewState,
  PullRequestState,
  PullRequestStatusPreview,
  RemoteBranchCleanupResult,
  RepositoryHostingProvider,
  RepositoryIdentity,
} from '@quoky/core';

/**
 * GitHub RepositoryHosting adapter (CAP-010, ADR-0053 — Sprint 3d-C, **adapter-only**).
 *
 * Implements the `RepositoryHostingProvider` port against the **github.com** GitHub REST API using the Node 22
 * built-in `fetch` (no octokit; no gh/hub/curl/CommandExecution/shell). GitHub Enterprise is deferred — the API
 * base is FIXED to `https://api.github.com` with no override.
 *
 * **Not wired into product runtime in 3d-C** (no `app.module` binding); `createPullRequest` is a real GitHub
 * mutation *if called*, but no product path reaches it and every unit test injects a fake `fetch` (no live
 * network). Actual runtime PR-creation execution is deferred to Sprint 3d-D. The token is **adapter-local**
 * (constructor config only) and never appears in errors/logs.
 */

/** Fixed GitHub API base (github.com only; Enterprise deferred — no override). */
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'quoky-platform';
const SHA_SHAPED = /^[0-9a-f]{7,40}$/i;

/**
 * Auth source for the RepositoryHosting adapter (Sprint 4b, ADR-0061). Either a GitHub App installation-token
 * source (minted adapter-local by `@quoky/github-app-auth`) or a dev-only PAT. The resolved token value is used
 * ONLY as an `Authorization: Bearer` header — never logged, returned, or placed in an error.
 */
export type GitHubHostingAuth =
  | {
      kind: 'github-app';
      tokenSource: () => Promise<string>;
      /**
       * Optional READ-ONLY token source for the PR status read path (see `createPullRequestStatusTokenSource`).
       * When absent the status path uses `tokenSource` and assumes check runs are readable.
       */
      statusTokenSource?: () => Promise<GitHubStatusReadToken>;
    }
  | { kind: 'pat'; token: string };

/**
 * A read-only token for the PR status path plus whether it was minted WITH check-run read access. The token value is
 * adapter-local (Bearer header only); `checksReadable` is a non-secret flag.
 */
export interface GitHubStatusReadToken {
  token: string;
  checksReadable: boolean;
}

type InstallationPermissions = Record<string, 'read' | 'write'>;

/** Read-only permissions for the PR status preview: the PR + reviews, its head commit's check runs, contents. */
export const PULL_REQUEST_STATUS_PERMISSIONS: Readonly<InstallationPermissions> = Object.freeze({
  pull_requests: 'read',
  checks: 'read',
  contents: 'read',
});

/** Fallback when the App has not been granted the Checks permission: everything above except `checks`. */
export const PULL_REQUEST_STATUS_PERMISSIONS_WITHOUT_CHECKS: Readonly<InstallationPermissions> = Object.freeze({
  pull_requests: 'read',
  contents: 'read',
});

/**
 * Build the PR-status token source for GitHub App auth. It first mints with {@link PULL_REQUEST_STATUS_PERMISSIONS};
 * when that mint is refused because a requested permission is not granted to the App (`isPermissionNotGranted`,
 * GitHub 422), it mints once more without `checks` and reports `checksReadable: false`, so the status preview can
 * still show the PR state and reviews with the checks marked unavailable. Any other mint failure propagates. The
 * push / PR-creation token source is separate and unchanged.
 */
export function createPullRequestStatusTokenSource(
  mint: (permissions: InstallationPermissions) => Promise<string>,
  isPermissionNotGranted: (error: unknown) => boolean,
): () => Promise<GitHubStatusReadToken> {
  return async () => {
    try {
      return { token: await mint({ ...PULL_REQUEST_STATUS_PERMISSIONS }), checksReadable: true };
    } catch (error) {
      if (!isPermissionNotGranted(error)) throw error;
    }
    return { token: await mint({ ...PULL_REQUEST_STATUS_PERMISSIONS_WITHOUT_CHECKS }), checksReadable: false };
  };
}

export interface GitHubHostingConfig {
  /** Auth source (ADR-0061). Adapter-local — the token value never leaves the adapter except as a Bearer header. */
  auth: GitHubHostingAuth;
  /** Injectable `fetch` for testability (default: global `fetch`). Unit tests pass a fake — no live network. */
  fetchImpl?: typeof fetch;
  /** Optional per-request timeout (ms) via `AbortSignal.timeout`. Omitted in tests so they never wait. */
  timeoutMs?: number;
}

/** GitHub REST shapes the adapter reads — everything else is ignored (no raw diff / file content / secrets). */
interface GitHubPull {
  number?: unknown;
  html_url?: unknown;
  head?: { ref?: unknown; sha?: unknown; repo?: { name?: unknown; owner?: { login?: unknown } } };
  base?: { ref?: unknown };
}

export class GitHubRepositoryHostingProvider implements RepositoryHostingProvider {
  readonly kind = 'github';
  private readonly auth: GitHubHostingAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(config: GitHubHostingConfig) {
    const auth = config?.auth;
    if (!auth || (auth.kind !== 'github-app' && auth.kind !== 'pat')) {
      throw new Error('github hosting: a valid auth config is required');
    }
    if (auth.kind === 'pat') {
      const token = typeof auth.token === 'string' ? auth.token.trim() : '';
      if (token.length === 0) throw new Error('github hosting: a non-empty token is required');
      this.auth = { kind: 'pat', token };
    } else {
      if (typeof auth.tokenSource !== 'function') {
        throw new Error('github hosting: a github-app token source is required');
      }
      this.auth = auth;
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Resolve the current Bearer value: the static dev PAT, or a freshly-minted/cached installation access token
   * from the App token source. The value is used ONLY for the `Authorization` header — never logged, returned, or
   * placed in an error. A mint failure here surfaces during the manager's read-first phase → pre-mutation Blocked.
   */
  private async currentToken(): Promise<string> {
    if (this.auth.kind === 'pat') return this.auth.token;
    const token = await this.auth.tokenSource();
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('github hosting: the app token source returned an empty token');
    }
    return token;
  }

  /**
   * The Bearer value for the read-only PR status path: the App's dedicated status token source when configured,
   * otherwise the regular token (assumed able to read check runs). Same handling rules as `currentToken`.
   */
  private async statusReadToken(): Promise<GitHubStatusReadToken> {
    if (this.auth.kind === 'pat' || this.auth.statusTokenSource === undefined) {
      return { token: await this.currentToken(), checksReadable: true };
    }
    const result = await this.auth.statusTokenSource();
    if (typeof result?.token !== 'string' || result.token.length === 0) {
      throw new Error('github hosting: the app status token source returned an empty token');
    }
    return { token: result.token, checksReadable: result.checksReadable === true };
  }

  async repositoryExists(identity: RepositoryIdentity): Promise<boolean> {
    const res = await this.request('repositoryExists', 'GET', `/repos/${enc(identity.owner)}/${enc(identity.repo)}`);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw this.statusError('repositoryExists', res.status);
  }

  async branchExists(identity: RepositoryIdentity, branch: string): Promise<boolean> {
    // The whole branch name is a single path segment; slashes are encoded (CA change 5). branchExists proves
    // only that the branch endpoint returned 200 — it does NOT verify commit reachability, and the branch
    // commit SHA is intentionally not read/exposed here (CA change 8).
    const res = await this.request(
      'branchExists',
      'GET',
      `/repos/${enc(identity.owner)}/${enc(identity.repo)}/branches/${enc(branch)}`,
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw this.statusError('branchExists', res.status);
  }

  async findOpenPullRequest(
    identity: RepositoryIdentity,
    headBranch: string,
    baseBranch: string,
  ): Promise<PullRequestResult | null> {
    // Same-repository head only (forks unsupported): head = "<owner>:<headBranch>", encoded for the query.
    const head = `${identity.owner}:${headBranch}`;
    const query = `state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(baseBranch)}`;
    const res = await this.request(
      'findOpenPullRequest',
      'GET',
      `/repos/${enc(identity.owner)}/${enc(identity.repo)}/pulls?${query}`,
    );
    if (res.status !== 200) throw this.statusError('findOpenPullRequest', res.status); // 404 → throw, NOT "no PR"
    const arr = await this.json(res, 'findOpenPullRequest');
    if (!Array.isArray(arr)) throw this.parseError('findOpenPullRequest');
    if (arr.length === 0) return null;
    if (arr.length > 1) throw new Error('github hosting: multiple open pull requests match head/base (ambiguous)');
    return this.mapPull(arr[0] as GitHubPull, identity, 'findOpenPullRequest');
  }

  async createPullRequest(input: PullRequestCreationInput): Promise<PullRequestResult> {
    // Minimal, explicit body ONLY — no draft/maintainer_can_modify/issue/labels/assignees/reviewers/milestone
    // (CA change 12). Raw branch strings go in the JSON body (never URL-concatenated).
    const body = { title: input.title, head: input.headBranch, base: input.baseBranch, body: input.body };
    const res = await this.request(
      'createPullRequest',
      'POST',
      `/repos/${enc(input.identity.owner)}/${enc(input.identity.repo)}/pulls`,
      body,
    );
    if (res.status !== 201) throw this.statusError('createPullRequest', res.status); // 201 only (CA change 11)
    const obj = await this.json(res, 'createPullRequest');
    return this.mapPull(obj as GitHubPull, input.identity, 'createPullRequest');
  }

  async getPullRequestStatus(input: {
    identity: RepositoryIdentity;
    pullRequestRef: PullRequestRef;
    expectedHeadBranch: string;
    expectedBaseBranch: string;
    expectedCommitHash: string;
  }): Promise<PullRequestStatusPreview> {
    // READ-ONLY, bounded GETs (CA changes 4/11): one GET per resource, fixed per_page, NO pagination/retry.
    const { identity, pullRequestRef } = input;
    const owner = enc(identity.owner);
    const repo = enc(identity.repo);
    const number = pullRequestRef.pullRequestNumber;
    // One read-only token for all three GETs (never the write token when a status source is configured).
    const read = await this.statusReadToken();

    // 1. GET the pull request.
    const pullRes = await this.request(
      'getPullRequestStatus',
      'GET',
      `/repos/${owner}/${repo}/pulls/${number}`,
      undefined,
      read.token,
    );
    if (pullRes.status !== 200) throw this.statusError('getPullRequestStatus', pullRes.status);
    const pull = (await this.json(pullRes, 'getPullRequestStatus')) as GitHubPull & {
      state?: unknown;
      merged?: unknown;
      draft?: unknown;
      mergeable?: unknown;
      mergeable_state?: unknown;
    };
    const headRef = pull?.head?.ref;
    const baseRef = pull?.base?.ref;
    const headSha = pull?.head?.sha;
    if (typeof headRef !== 'string' || typeof baseRef !== 'string' || typeof headSha !== 'string') {
      throw new Error('github hosting: getPullRequestStatus returned invalid pull fields');
    }
    const state: PullRequestState =
      pull?.merged === true ? 'merged' : pull?.state === 'open' ? 'open' : pull?.state === 'closed' ? 'closed' : 'unknown';

    // 2. GET check-runs for the head sha (check-runs only for 3e; legacy commit statuses may be unrepresented).
    //    PARTIAL status: when the token was minted without check access, or GitHub answers 403 (not a rate limit)
    //    for check runs, the checks are reported `unavailable` (zero counts) — never success, never a failure.
    const checks = read.checksReadable
      ? await this.readCheckRuns(`/repos/${owner}/${repo}/commits/${enc(headSha)}/check-runs?per_page=100`, read.token)
      : UNAVAILABLE_CHECKS;

    // 3. GET reviews (latest signal per reviewer).
    const reviewRes = await this.request(
      'getPullRequestStatus',
      'GET',
      `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
      undefined,
      read.token,
    );
    if (reviewRes.status !== 200) throw this.statusError('getPullRequestStatus', reviewRes.status);
    const reviewArr = (await this.json(reviewRes, 'getPullRequestStatus')) as Array<{
      state?: unknown;
      user?: { login?: unknown };
    }>;
    const latestByUser = new Map<string, string>();
    for (const rv of Array.isArray(reviewArr) ? reviewArr : []) {
      const login = typeof rv?.user?.login === 'string' ? rv.user.login : '';
      const s = typeof rv?.state === 'string' ? rv.state : '';
      if (s === 'APPROVED' || s === 'CHANGES_REQUESTED' || s === 'COMMENTED') latestByUser.set(login, s); // ignore DISMISSED/PENDING
    }
    let approvedCount = 0;
    let changesRequestedCount = 0;
    let commented = 0;
    for (const s of latestByUser.values()) {
      if (s === 'APPROVED') approvedCount += 1;
      else if (s === 'CHANGES_REQUESTED') changesRequestedCount += 1;
      else if (s === 'COMMENTED') commented += 1;
    }
    const reviewsState: PullRequestReviewState =
      changesRequestedCount > 0 ? 'changes_requested' : approvedCount > 0 ? 'approved' : commented > 0 ? 'commented' : 'none';

    return {
      ref: pullRequestRef,
      state,
      headBranch: headRef,
      baseBranch: baseRef,
      headCommitHash: headSha,
      isDraft: pull?.draft === true,
      mergeability: mapMergeability(pull?.merged, pull?.mergeable, pull?.mergeable_state),
      checks,
      reviews: { state: reviewsState, approvedCount, changesRequestedCount },
      // observedAt is generated internally at read time — never caller/user-supplied (CA change 3).
      observedAt: new Date().toISOString(),
    };
  }

  /** Check-run summary for the status preview; 403 (permission, not a rate limit) → unavailable checks. */
  private async readCheckRuns(path: string, token: string): Promise<PullRequestStatusPreview['checks']> {
    const checkRes = await this.request('getPullRequestStatus', 'GET', path, undefined, token);
    if (checkRes.status === 403 && !isRateLimited(checkRes)) return UNAVAILABLE_CHECKS;
    if (checkRes.status !== 200) throw this.statusError('getPullRequestStatus', checkRes.status);
    const checkBody = (await this.json(checkRes, 'getPullRequestStatus')) as {
      total_count?: unknown;
      check_runs?: Array<{ status?: unknown; conclusion?: unknown }>;
    };
    const runs = Array.isArray(checkBody?.check_runs) ? checkBody.check_runs : [];
    let successCount = 0;
    let failureCount = 0;
    let pendingCount = 0;
    for (const r of runs) {
      if (r?.status !== 'completed') pendingCount += 1;
      else if (r?.conclusion === 'success') successCount += 1;
      else if (r?.conclusion === 'failure' || r?.conclusion === 'timed_out' || r?.conclusion === 'cancelled' || r?.conclusion === 'action_required')
        failureCount += 1;
      // neutral/skipped contribute to totalCount but neither success nor failure.
    }
    const totalCount = runs.length;
    const state: PullRequestChecksState =
      totalCount === 0 ? 'unknown' : failureCount > 0 ? 'failure' : pendingCount > 0 ? 'pending' : successCount > 0 ? 'success' : 'neutral';
    return { state, totalCount, successCount, failureCount, pendingCount };
  }

  async getMergePreflight(input: {
    identity: RepositoryIdentity;
    pullRequestRef: PullRequestRef;
    expectedHeadBranch: string;
    expectedBaseBranch: string;
    expectedCommitHash: string;
  }): Promise<PullRequestMergePreflight> {
    // READ-ONLY, single bounded GET (no pagination/retry). Maps GitHub `state`/`merged`/`mergeable`/
    // `mergeable_state` → normalized state + mergeability; core never sees the raw payload (ADR-0057).
    const { identity, pullRequestRef } = input;
    const owner = enc(identity.owner);
    const repo = enc(identity.repo);
    const res = await this.request('getMergePreflight', 'GET', `/repos/${owner}/${repo}/pulls/${pullRequestRef.pullRequestNumber}`);
    if (res.status !== 200) throw this.statusError('getMergePreflight', res.status);
    const pull = (await this.json(res, 'getMergePreflight')) as GitHubPull & {
      state?: unknown;
      merged?: unknown;
      mergeable?: unknown;
      mergeable_state?: unknown;
    };
    const headRef = pull?.head?.ref;
    const baseRef = pull?.base?.ref;
    const headSha = pull?.head?.sha;
    if (typeof headRef !== 'string' || typeof baseRef !== 'string' || typeof headSha !== 'string') {
      throw new Error('github hosting: getMergePreflight returned invalid pull fields');
    }
    const state: PullRequestState =
      pull?.merged === true ? 'merged' : pull?.state === 'open' ? 'open' : pull?.state === 'closed' ? 'closed' : 'unknown';
    return {
      ref: pullRequestRef,
      state,
      headBranch: headRef,
      baseBranch: baseRef,
      headCommitHash: headSha,
      mergeability: mapMergeability(pull?.merged, pull?.mergeable, pull?.mergeable_state),
      // observedAt is generated internally at read time — never caller/user-supplied.
      observedAt: new Date().toISOString(),
    };
  }

  async mergePullRequest(input: {
    identity: RepositoryIdentity;
    pullRequestRef: PullRequestRef;
    expectedHeadSha: string;
  }): Promise<PullRequestMergeResult> {
    // Single mutating PUT. `sha` = the expected head — GitHub refuses (409) if the PR head has moved, so a moved
    // head never merges. merge_method 'merge' only (no squash/rebase). No force, no branch deletion, no
    // auto-merge, no reviewer/label/assignee mutation. Any non-200 throws (manager → Unverified).
    const { identity, pullRequestRef, expectedHeadSha } = input;
    const owner = enc(identity.owner);
    const repo = enc(identity.repo);
    const res = await this.request(
      'mergePullRequest',
      'PUT',
      `/repos/${owner}/${repo}/pulls/${pullRequestRef.pullRequestNumber}/merge`,
      { sha: expectedHeadSha, merge_method: 'merge' },
    );
    if (res.status !== 200) throw this.statusError('mergePullRequest', res.status); // 200 only; else Unverified upstream
    const body = (await this.json(res, 'mergePullRequest')) as { merged?: unknown; sha?: unknown };
    if (body?.merged !== true) throw new Error('github hosting: mergePullRequest did not confirm merged');
    const mergeCommitHash = typeof body?.sha === 'string' && SHA_SHAPED.test(body.sha) ? body.sha : undefined;
    return {
      provider: 'github',
      owner: identity.owner,
      repo: identity.repo,
      pullRequestNumber: pullRequestRef.pullRequestNumber,
      pullRequestUrl: pullRequestRef.pullRequestUrl,
      merged: true,
      mergedHeadSha: expectedHeadSha, // GitHub merged the requested head (sha param); response carries only the merge commit
      mergeCommitHash,
      alreadyMerged: false, // manager finalizes the path-derived flag
    };
  }

  async getRemoteBranchCommit(identity: RepositoryIdentity, branch: string): Promise<{ commitHash: string } | null> {
    // READ-ONLY single GET. The ref is addressed as heads/<branch> where <branch> is a PATH (slashes preserved,
    // per-segment encoded — CA change 5); NEVER a single %2F-escaped segment (that would address the wrong ref).
    const res = await this.request(
      'getRemoteBranchCommit',
      'GET',
      `/repos/${enc(identity.owner)}/${enc(identity.repo)}/git/ref/${encRefPath(branch)}`,
    );
    if (res.status === 404) return null;
    if (res.status !== 200) throw this.statusError('getRemoteBranchCommit', res.status);
    const body = (await this.json(res, 'getRemoteBranchCommit')) as { object?: { sha?: unknown; type?: unknown } };
    const sha = body?.object?.sha;
    if (typeof sha !== 'string' || !SHA_SHAPED.test(sha)) throw new Error('github hosting: getRemoteBranchCommit returned an invalid ref object');
    if (body?.object?.type !== undefined && body.object.type !== 'commit') {
      throw new Error('github hosting: getRemoteBranchCommit ref does not point at a commit');
    }
    return { commitHash: sha };
  }

  async deleteRemoteBranch(input: {
    identity: RepositoryIdentity;
    branch: string;
    expectedCommitHash: string;
  }): Promise<RemoteBranchCleanupResult> {
    // Read-IMMEDIATELY-before-delete (GitHub refs DELETE has NO atomic SHA-conditional delete — ADR-0060). GET the ref,
    // verify object.sha === expectedCommitHash, then a SINGLE DELETE of the exact refs/heads/<branch> path. NEVER the
    // default branch / a wildcard-pattern / a force flag / git push. Phase-aware: pre-DELETE mismatch → Blocked;
    // a failure AT/AFTER the DELETE → Unverified.
    const { identity, branch, expectedCommitHash } = input;
    const current = await this.getRemoteBranchCommit(identity, branch); // 404 → null (pre-DELETE read)
    if (!current) {
      return { provider: 'github', owner: identity.owner, repo: identity.repo, branch, deleted: false, alreadyAbsent: true };
    }
    if (current.commitHash !== expectedCommitHash) {
      throw new RemoteBranchCleanupBlockedError('github hosting: remote branch moved off the expected commit; not deleted');
    }
    let res: Response;
    try {
      res = await this.request(
        'deleteRemoteBranch',
        'DELETE',
        `/repos/${enc(identity.owner)}/${enc(identity.repo)}/git/refs/${encRefPath(branch)}`,
      );
    } catch {
      // The DELETE may have reached GitHub — never claim "not deleted".
      throw new RemoteBranchCleanupUnverifiedError('github hosting: remote branch deletion could not be completed/verified');
    }
    if (res.status !== 204) {
      // Ambiguous at/after the mutation attempt — the ref may be gone.
      throw new RemoteBranchCleanupUnverifiedError(`github hosting: remote branch deletion could not be verified (status ${res.status})`);
    }
    return { provider: 'github', owner: identity.owner, repo: identity.repo, branch, deleted: true, alreadyAbsent: false, deletedCommitHash: expectedCommitHash };
  }

  /** Map a GitHub PR object to a provider-reported PullRequestResult, rejecting fork/invalid results. */
  private mapPull(item: GitHubPull, identity: RepositoryIdentity, op: string): PullRequestResult {
    // Same-repository only — fork PRs rejected (CA change 7).
    if (item?.head?.repo?.owner?.login !== identity.owner || item?.head?.repo?.name !== identity.repo) {
      throw new Error(`github hosting: ${op} rejected a cross-repository (fork) pull request`);
    }
    const number = item?.number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`github hosting: ${op} returned an invalid PR number`);
    }
    const headSha = item?.head?.sha;
    if (typeof headSha !== 'string' || !SHA_SHAPED.test(headSha)) {
      throw new Error(`github hosting: ${op} returned an invalid head.sha`);
    }
    const url = item?.html_url;
    if (typeof url !== 'string' || !isSafeGitHubPullRequestUrl(url, identity, number)) {
      throw new Error(`github hosting: ${op} returned an invalid PR URL`);
    }
    const headRef = item?.head?.ref;
    const baseRef = item?.base?.ref;
    if (typeof headRef !== 'string' || typeof baseRef !== 'string') {
      throw new Error(`github hosting: ${op} returned invalid head/base refs`);
    }
    return {
      provider: 'github',
      owner: identity.owner,
      repo: identity.repo,
      pullRequestNumber: number,
      pullRequestUrl: url,
      pullRequestHeadBranch: headRef,
      pullRequestBaseBranch: baseRef,
      pullRequestCommitHash: headSha,
      reused: false, // manager finalizes the path-derived flag
    };
  }

  /** Single `fetch` per call (no retry — CA change 13). Sanitized failures (no token/body/headers). */
  private async request(
    op: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    jsonBody?: unknown,
    readToken?: string,
  ): Promise<Response> {
    const token = readToken ?? (await this.currentToken());
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': USER_AGENT,
    };
    const init: RequestInit = { method, headers };
    if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(jsonBody);
    }
    if (this.timeoutMs !== undefined) init.signal = AbortSignal.timeout(this.timeoutMs);
    try {
      return await this.fetchImpl(`${GITHUB_API_BASE}${path}`, init);
    } catch {
      // Never echo the request/body/token or the raw cause.
      throw new Error(`github hosting: ${op} request failed`);
    }
  }

  /** Bounded, deterministic status error — never includes the token or the raw response body (CA change 15). */
  private statusError(op: string, status: number): Error {
    if (status === 401 || status === 403) return new Error(`github hosting: ${op} unavailable (authorization failed)`);
    return new Error(`github hosting: ${op} failed with status ${status}`);
  }

  private parseError(op: string): Error {
    return new Error(`github hosting: ${op} returned an unexpected response`);
  }

  private async json(res: Response, op: string): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw this.parseError(op);
    }
  }
}

/** Checks the status read could not see (no permission) — zero counts, never rendered as success or failure. */
const UNAVAILABLE_CHECKS: PullRequestStatusPreview['checks'] = Object.freeze({
  state: 'unavailable',
  totalCount: 0,
  successCount: 0,
  failureCount: 0,
  pendingCount: 0,
}) as PullRequestStatusPreview['checks'];

/** A 403 that is a primary/secondary rate limit, not a missing permission (those stay a whole-read failure). */
function isRateLimited(res: Response): boolean {
  const headers = res.headers as Headers | undefined;
  if (typeof headers?.get !== 'function') return false;
  return headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null;
}

/** Encode a single REST path segment (owner/repo/branch as one segment); encodes `/` too. */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Encode a Git-refs PATH `heads/<branch>` (Sprint 3j-B, ADR-0060, CA change 5). The GitHub refs endpoints address the
 * ref as a PATH, not a single segment: `refs/heads/feature/login`. So each slash-segment is percent-encoded and the
 * `/` separators are PRESERVED — `heads/feature/login` → "heads/feature/login" (never "heads%2Ffeature%2Flogin",
 * which would address the wrong ref). Do NOT use `enc()` (single-segment) on a slash-containing branch here.
 */
function encRefPath(branch: string): string {
  return `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Map GitHub `merged`/`mergeable`/`mergeable_state` → the normalized, provider-independent
 * {@link PullRequestMergeability} (ADR-0057, Sprint 3g). Conservative: only definitively-mergeable states become
 * `MERGEABLE`; anything the API cannot determine (`mergeable === null`, `mergeable_state` `unknown`/`unstable`/
 * other) becomes `UNKNOWN` so the Manager blocks (never merge on uncertainty). The core never sees this raw
 * payload — the mapping lives adapter-side only.
 */
function mapMergeability(merged: unknown, mergeable: unknown, mergeableState: unknown): PullRequestMergeability {
  if (merged === true) return 'MERGEABLE'; // already merged — state is checked first by the manager; not used to merge
  if (mergeable === false) return 'CONFLICTING';
  if (mergeable !== true) return 'UNKNOWN'; // null/undefined → GitHub still computing → block
  switch (mergeableState) {
    case 'clean':
    case 'has_hooks':
      return 'MERGEABLE';
    case 'dirty':
      return 'CONFLICTING';
    case 'blocked':
    case 'draft':
      return 'BLOCKED';
    case 'behind':
      return 'STALE_HEAD';
    default:
      return 'UNKNOWN'; // 'unstable'/'unknown'/anything else → block conservatively
  }
}

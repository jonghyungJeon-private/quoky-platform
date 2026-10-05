import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GitHubRepositoryHostingProvider,
  PULL_REQUEST_STATUS_PERMISSIONS,
  PULL_REQUEST_STATUS_PERMISSIONS_WITHOUT_CHECKS,
  createPullRequestStatusTokenSource,
} from './index';
import type { GitHubHostingAuth, GitHubHostingConfig } from './index';
import { RemoteBranchCleanupBlockedError, RemoteBranchCleanupUnverifiedError } from '@quoky/core';
import type { PullRequestCreationInput, PullRequestRef, RepositoryIdentity } from '@quoky/core';

const IDENTITY: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'widgets' };
const TOKEN = 'ghp_superSecretTokenValue';

interface Call {
  url: string;
  init: RequestInit;
}

/** Fake `fetch` that records calls and returns a canned `{ status, body }` — NO live network (CA change 16). */
function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as RequestInit;
    calls.push({ url: u, init: i });
    const { status, body } = handler(u, i);
    return { status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function ghPull(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    html_url: 'https://github.com/acme/widgets/pull/42',
    head: { ref: 'feature/x', sha: 'abc1234', repo: { name: 'widgets', owner: { login: 'acme' } } },
    base: { ref: 'main' },
    ...over,
  };
}

function provider(fn: typeof fetch, extra: Partial<GitHubHostingConfig> = {}) {
  return new GitHubRepositoryHostingProvider({ auth: { kind: 'pat', token: TOKEN }, fetchImpl: fn, ...extra });
}

const createInput: PullRequestCreationInput = {
  identity: IDENTITY,
  headBranch: 'feature/x',
  baseBranch: 'main',
  title: 'Add widget',
  body: 'body text',
  expectedCommitHash: 'abc1234',
};

describe('GitHubRepositoryHostingProvider (CAP-010 adapter, ADR-0053, Sprint 3d-C)', () => {
  describe('construction (tests 1/2 + Sprint 4b auth swap, ADR-0061)', () => {
    it('rejects a blank/whitespace PAT (no fetch)', () => {
      const { fn } = fakeFetch(() => ({ status: 200 }));
      expect(() => new GitHubRepositoryHostingProvider({ auth: { kind: 'pat', token: '' }, fetchImpl: fn })).toThrow();
      expect(() => new GitHubRepositoryHostingProvider({ auth: { kind: 'pat', token: '   ' }, fetchImpl: fn })).toThrow();
    });
    it('rejects a github-app auth without a token source (no fetch)', () => {
      const { fn } = fakeFetch(() => ({ status: 200 }));
      expect(
        () =>
          new GitHubRepositoryHostingProvider({
            auth: { kind: 'github-app' } as unknown as GitHubHostingAuth,
            fetchImpl: fn,
          }),
      ).toThrow();
    });
    it('accepts a non-blank PAT', () => {
      const { fn } = fakeFetch(() => ({ status: 200 }));
      expect(() => provider(fn)).not.toThrow();
    });
    it('uses the minted installation token from a github-app token source as the Bearer header', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200 }));
      const p = new GitHubRepositoryHostingProvider({
        auth: { kind: 'github-app', tokenSource: async () => 'ghs_installationToken' },
        fetchImpl: fn,
      });
      await p.repositoryExists(IDENTITY);
      const h = calls[0]!.init.headers as Record<string, string>;
      expect(h.Authorization).toBe('Bearer ghs_installationToken');
    });
    it('throws when the github-app token source returns an empty token', async () => {
      const { fn } = fakeFetch(() => ({ status: 200 }));
      const p = new GitHubRepositoryHostingProvider({
        auth: { kind: 'github-app', tokenSource: async () => '' },
        fetchImpl: fn,
      });
      await expect(p.repositoryExists(IDENTITY)).rejects.toThrow();
    });
  });

  describe('request headers & base URL (tests 3–8)', () => {
    it('sends exact auth/accept/version/user-agent headers and uses https://api.github.com only', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200 }));
      await provider(fn).repositoryExists(IDENTITY);
      const h = calls[0]!.init.headers as Record<string, string>;
      expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(h.Accept).toBe('application/vnd.github+json');
      expect(h['X-GitHub-Api-Version']).toBe('2022-11-28');
      expect(h['User-Agent']).toBe('quoky-platform');
      expect(calls[0]!.url.startsWith('https://api.github.com/')).toBe(true);
    });
    it('ignores any custom apiBaseUrl (no override option) — always api.github.com', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200 }));
      await provider(fn, { apiBaseUrl: 'https://evil.example.com' } as unknown as Partial<GitHubHostingConfig>).repositoryExists(
        IDENTITY,
      );
      expect(calls[0]!.url.startsWith('https://api.github.com/')).toBe(true);
      expect(calls[0]!.url).not.toContain('evil');
    });
  });

  describe('repositoryExists (tests 9–12)', () => {
    it('GET /repos/{owner}/{repo}; 200 → true', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200 }));
      expect(await provider(fn).repositoryExists(IDENTITY)).toBe(true);
      expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widgets');
      expect(calls[0]!.init.method).toBe('GET');
    });
    it('404 → false', async () => {
      const { fn } = fakeFetch(() => ({ status: 404 }));
      expect(await provider(fn).repositoryExists(IDENTITY)).toBe(false);
    });
    it('401/403 → throws sanitized (no token)', async () => {
      for (const status of [401, 403]) {
        const { fn } = fakeFetch(() => ({ status }));
        await expect(provider(fn).repositoryExists(IDENTITY)).rejects.toThrow(/github hosting/);
      }
    });
  });

  describe('branchExists (tests 13–17)', () => {
    it('GET branches path; encodes a slash branch', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200 }));
      expect(await provider(fn).branchExists(IDENTITY, 'feature/x')).toBe(true);
      expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widgets/branches/feature%2Fx');
    });
    it('404 → false', async () => {
      const { fn } = fakeFetch(() => ({ status: 404 }));
      expect(await provider(fn).branchExists(IDENTITY, 'main')).toBe(false);
    });
    it('401/403 → throws sanitized', async () => {
      const { fn } = fakeFetch(() => ({ status: 403 }));
      await expect(provider(fn).branchExists(IDENTITY, 'main')).rejects.toThrow(/github hosting/);
    });
  });

  describe('findOpenPullRequest (tests 18–25)', () => {
    it('GET pulls with encoded same-repo head + base query', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200, body: [] }));
      await provider(fn).findOpenPullRequest(IDENTITY, 'feature/x', 'main');
      expect(calls[0]!.url).toBe(
        'https://api.github.com/repos/acme/widgets/pulls?state=open&head=acme%3Afeature%2Fx&base=main',
      );
    });
    it('404 → throws (not null)', async () => {
      const { fn } = fakeFetch(() => ({ status: 404 }));
      await expect(provider(fn).findOpenPullRequest(IDENTITY, 'feature/x', 'main')).rejects.toThrow();
    });
    it('empty array → null', async () => {
      const { fn } = fakeFetch(() => ({ status: 200, body: [] }));
      expect(await provider(fn).findOpenPullRequest(IDENTITY, 'feature/x', 'main')).toBeNull();
    });
    it('one valid same-repo PR → mapped result', async () => {
      const { fn } = fakeFetch(() => ({ status: 200, body: [ghPull()] }));
      const r = await provider(fn).findOpenPullRequest(IDENTITY, 'feature/x', 'main');
      expect(r).toMatchObject({
        provider: 'github',
        owner: 'acme',
        repo: 'widgets',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/acme/widgets/pull/42',
        pullRequestHeadBranch: 'feature/x',
        pullRequestBaseBranch: 'main',
        pullRequestCommitHash: 'abc1234',
      });
    });
    it('multiple open PRs → throws ambiguous safe failure', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200, body: [ghPull(), ghPull({ number: 43 })] }));
      await expect(provider(fn).findOpenPullRequest(IDENTITY, 'feature/x', 'main')).rejects.toThrow(/ambiguous/);
      expect(calls).toHaveLength(1);
    });
    it('fork PR (cross-repo head) → rejected', async () => {
      const forked = ghPull({ head: { ref: 'feature/x', sha: 'abc1234', repo: { name: 'widgets', owner: { login: 'attacker' } } } });
      const { fn } = fakeFetch(() => ({ status: 200, body: [forked] }));
      await expect(provider(fn).findOpenPullRequest(IDENTITY, 'feature/x', 'main')).rejects.toThrow(/fork/);
    });
    it('missing head.sha → rejected', async () => {
      const bad = ghPull({ head: { ref: 'feature/x', repo: { name: 'widgets', owner: { login: 'acme' } } } });
      const { fn } = fakeFetch(() => ({ status: 200, body: [bad] }));
      await expect(provider(fn).findOpenPullRequest(IDENTITY, 'feature/x', 'main')).rejects.toThrow(/head\.sha/);
    });
  });

  describe('createPullRequest (tests 26–35, 39)', () => {
    it('POST pulls; body contains ONLY title/head/base/body (raw branches)', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 201, body: ghPull() }));
      await provider(fn).createPullRequest(createInput);
      expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widgets/pulls');
      expect(calls[0]!.init.method).toBe('POST');
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(Object.keys(body).sort()).toEqual(['base', 'body', 'head', 'title']);
      expect(body.head).toBe('feature/x'); // raw branch, not URL-encoded
      expect(body.base).toBe('main');
      for (const forbidden of ['draft', 'maintainer_can_modify', 'issue', 'labels', 'assignees', 'reviewers', 'milestone']) {
        expect(body).not.toHaveProperty(forbidden);
      }
    });
    it('201 → mapped result', async () => {
      const { fn } = fakeFetch(() => ({ status: 201, body: ghPull() }));
      const r = await provider(fn).createPullRequest(createInput);
      expect(r.pullRequestNumber).toBe(42);
      expect(r.pullRequestCommitHash).toBe('abc1234');
    });
    it('200 → rejected (201 only)', async () => {
      const { fn } = fakeFetch(() => ({ status: 200, body: ghPull() }));
      await expect(provider(fn).createPullRequest(createInput)).rejects.toThrow();
    });
    it('401/403/404/422 → throws sanitized', async () => {
      for (const status of [401, 403, 404, 422]) {
        const { fn } = fakeFetch(() => ({ status }));
        await expect(provider(fn).createPullRequest(createInput)).rejects.toThrow(/github hosting/);
      }
    });
    it('missing/invalid head.sha → rejected', async () => {
      const { fn } = fakeFetch(() => ({ status: 201, body: ghPull({ head: { ref: 'feature/x', sha: 'zzz', repo: { name: 'widgets', owner: { login: 'acme' } } } }) }));
      await expect(provider(fn).createPullRequest(createInput)).rejects.toThrow(/head\.sha/);
    });
    it('PR number 0 / negative / non-integer → rejected (test 32)', async () => {
      for (const number of [0, -1, 4.5]) {
        const { fn } = fakeFetch(() => ({ status: 201, body: ghPull({ number }) }));
        await expect(provider(fn).createPullRequest(createInput)).rejects.toThrow(/PR number/);
      }
    });
    it('invalid html_url / query / fragment / casing → rejected (tests 33–35)', async () => {
      for (const html_url of [
        'https://evil.com/acme/widgets/pull/42',
        'http://github.com/acme/widgets/pull/42',
        'https://github.com/acme/widgets/pull/42?x=1',
        'https://github.com/acme/widgets/pull/42#c',
        'https://github.com/Acme/widgets/pull/42',
      ]) {
        const { fn } = fakeFetch(() => ({ status: 201, body: ghPull({ html_url }) }));
        await expect(provider(fn).createPullRequest(createInput)).rejects.toThrow(/PR URL/);
      }
    });
    it('makes exactly one fetch call per method, even on failure (test 39, no retry)', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 500 }));
      await expect(provider(fn).createPullRequest(createInput)).rejects.toThrow();
      expect(calls).toHaveLength(1);
    });
  });

  describe('error sanitization (tests 36–38)', () => {
    it('token is never present in a thrown error', async () => {
      const { fn } = fakeFetch(() => ({ status: 403, body: { message: TOKEN } }));
      await provider(fn)
        .repositoryExists(IDENTITY)
        .catch((e: unknown) => expect(String((e as Error).message)).not.toContain(TOKEN));
    });
    it('raw response body is not echoed in the error', async () => {
      const { fn } = fakeFetch(() => ({ status: 500, body: { secret: 'RESP-BODY-SECRET' } }));
      await provider(fn)
        .repositoryExists(IDENTITY)
        .catch((e: unknown) => expect(String((e as Error).message)).not.toContain('RESP-BODY-SECRET'));
    });
    it('request body (title/body) is not echoed in the error', async () => {
      const { fn } = fakeFetch(() => ({ status: 422 }));
      const input = { ...createInput, title: 'REQ-TITLE-SECRET', body: 'REQ-BODY-SECRET' };
      await provider(fn)
        .createPullRequest(input)
        .catch((e: unknown) => {
          const m = String((e as Error).message);
          expect(m).not.toContain('REQ-TITLE-SECRET');
          expect(m).not.toContain('REQ-BODY-SECRET');
        });
    });
  });

  describe('getPullRequestStatus — read-only (Sprint 3e, ADR-0055)', () => {
    const PR_REF: PullRequestRef = { provider: 'github', owner: 'acme', repo: 'widgets', pullRequestNumber: 42, pullRequestUrl: 'https://github.com/acme/widgets/pull/42' };
    const statusInput = { identity: IDENTITY, pullRequestRef: PR_REF, expectedHeadBranch: 'feature/x', expectedBaseBranch: 'main', expectedCommitHash: 'abc1234' };
    /** Route the 3 read-only GETs (pull / check-runs / reviews) by URL. */
    function statusFetch(over: { pull?: unknown; checks?: unknown; reviews?: unknown; pullStatus?: number } = {}) {
      return fakeFetch((url) => {
        if (url.includes('/check-runs')) return { status: 200, body: over.checks ?? { total_count: 2, check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }] } };
        if (url.endsWith('/reviews?per_page=100')) return { status: 200, body: over.reviews ?? [{ state: 'APPROVED', user: { login: 'r1' } }] };
        return { status: over.pullStatus ?? 200, body: over.pull ?? { state: 'open', merged: false, draft: false, head: { ref: 'feature/x', sha: 'abc1234' }, base: { ref: 'main' } } };
      });
    }

    it('performs bounded read-only GETs: pull, check-runs (per_page), reviews (per_page) — one each, no pagination/retry', async () => {
      const { fn, calls } = statusFetch();
      await provider(fn).getPullRequestStatus(statusInput);
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.init.method === 'GET' || c.init.method === undefined)).toBe(true);
      expect(calls.some((c) => c.url === 'https://api.github.com/repos/acme/widgets/pulls/42')).toBe(true);
      expect(calls.some((c) => c.url === 'https://api.github.com/repos/acme/widgets/commits/abc1234/check-runs?per_page=100')).toBe(true);
      expect(calls.some((c) => c.url === 'https://api.github.com/repos/acme/widgets/pulls/42/reviews?per_page=100')).toBe(true);
    });

    it('maps pull/checks/reviews to a bounded preview with internally-generated observedAt', async () => {
      const { fn } = statusFetch();
      const s = await provider(fn).getPullRequestStatus(statusInput);
      expect(s.state).toBe('open');
      expect(s.headBranch).toBe('feature/x');
      expect(s.baseBranch).toBe('main');
      expect(s.headCommitHash).toBe('abc1234');
      expect(s.checks).toEqual({ state: 'success', totalCount: 2, successCount: 2, failureCount: 0, pendingCount: 0 });
      expect(s.reviews).toEqual({ state: 'approved', approvedCount: 1, changesRequestedCount: 0 });
      expect(s.mergeability).toBe('UNKNOWN');
      const clean = await provider(statusFetch({ pull: { state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean', head: { ref: 'feature/x', sha: 'abc1234' }, base: { ref: 'main' } } }).fn).getPullRequestStatus(statusInput);
      expect(clean.mergeability).toBe('MERGEABLE');
      expect(typeof s.observedAt).toBe('string');
      expect(s.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-like, internally generated
      expect(s.ref).toEqual(PR_REF);
    });

    it('empty check-runs → unknown (not success)', async () => {
      const { fn } = statusFetch({ checks: { total_count: 0, check_runs: [] } });
      const s = await provider(fn).getPullRequestStatus(statusInput);
      expect(s.checks).toEqual({ state: 'unknown', totalCount: 0, successCount: 0, failureCount: 0, pendingCount: 0 });
    });

    it('maps merged / failing checks / changes-requested', async () => {
      const merged = await provider(statusFetch({ pull: { state: 'closed', merged: true, draft: false, head: { ref: 'feature/x', sha: 'abc1234' }, base: { ref: 'main' } } }).fn).getPullRequestStatus(statusInput);
      expect(merged.state).toBe('merged');
      const failing = await provider(statusFetch({ checks: { total_count: 2, check_runs: [{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress' }] } }).fn).getPullRequestStatus(statusInput);
      expect(failing.checks).toEqual({ state: 'failure', totalCount: 2, successCount: 0, failureCount: 1, pendingCount: 1 });
      const cr = await provider(statusFetch({ reviews: [{ state: 'CHANGES_REQUESTED', user: { login: 'r1' } }, { state: 'APPROVED', user: { login: 'r2' } }] }).fn).getPullRequestStatus(statusInput);
      expect(cr.reviews).toEqual({ state: 'changes_requested', approvedCount: 1, changesRequestedCount: 1 });
    });

    it('non-200 on any read throws a sanitized error (no token/raw body)', async () => {
      const p = provider(statusFetch({ pullStatus: 403, pull: { message: TOKEN } }).fn);
      await p.getPullRequestStatus(statusInput).catch((e: unknown) => {
        expect(String((e as Error).message)).toMatch(/github hosting/);
        expect(String((e as Error).message)).not.toContain(TOKEN);
      });
    });

    describe('dedicated read-only status token + partial status without check access', () => {
      const WRITE = 'ghs_writeTokenForContentsAndPulls';
      const READ_WITH_CHECKS = 'ghs_statusReadWithChecks';
      const READ_NO_CHECKS = 'ghs_statusReadWithoutChecks';
      const UNAVAILABLE = { state: 'unavailable', totalCount: 0, successCount: 0, failureCount: 0, pendingCount: 0 };
      function bearerOf(c: Call): string | undefined {
        return (c.init.headers as Record<string, string>).Authorization;
      }
      /** Route GETs; the check-runs answer is configurable (status + optional headers). */
      function routedFetch(check: { status: number; headers?: Record<string, string>; body?: unknown }) {
        const calls: Call[] = [];
        const fn = (async (url: unknown, init?: unknown) => {
          const u = String(url);
          calls.push({ url: u, init: (init ?? {}) as RequestInit });
          if (u.includes('/check-runs')) {
            return {
              status: check.status,
              headers: new Headers(check.headers ?? {}),
              json: async () => check.body ?? { check_runs: [{ status: 'completed', conclusion: 'success' }] },
            } as unknown as Response;
          }
          if (u.endsWith('/reviews?per_page=100')) {
            return { status: 200, json: async () => [{ state: 'APPROVED', user: { login: 'r1' } }] } as unknown as Response;
          }
          return {
            status: 200,
            json: async () => ({ state: 'open', merged: false, draft: false, head: { ref: 'feature/x', sha: 'abc1234' }, base: { ref: 'main' } }),
          } as unknown as Response;
        }) as unknown as typeof fetch;
        return { fn, calls };
      }
      function appProvider(fn: typeof fetch, statusTokenSource: () => Promise<{ token: string; checksReadable: boolean }>) {
        return new GitHubRepositoryHostingProvider({
          auth: { kind: 'github-app', tokenSource: async () => WRITE, statusTokenSource },
          fetchImpl: fn,
        });
      }
      /** A fake App mint that records requested permission sets and optionally refuses `checks` with "422". */
      function fakeMint(opts: { checksGranted: boolean; failWith?: Error }) {
        const requested: Array<Record<string, string>> = [];
        const notGranted = new Error('github app: tokenForInstallation failed with status 422');
        const mint = async (permissions: Record<string, 'read' | 'write'>) => {
          requested.push({ ...permissions });
          if (opts.failWith) throw opts.failWith;
          if ('checks' in permissions && !opts.checksGranted) throw notGranted;
          return 'checks' in permissions ? READ_WITH_CHECKS : READ_NO_CHECKS;
        };
        return { requested, source: createPullRequestStatusTokenSource(mint, (e) => e === notGranted) };
      }

      it('mints {pull_requests, checks, contents}: read and uses it for all three GETs — never the write token', async () => {
        const mint = fakeMint({ checksGranted: true });
        const { fn, calls } = routedFetch({ status: 200 });
        const s = await appProvider(fn, mint.source).getPullRequestStatus(statusInput);
        expect(mint.requested).toEqual([{ pull_requests: 'read', checks: 'read', contents: 'read' }]);
        expect(PULL_REQUEST_STATUS_PERMISSIONS).toEqual({ pull_requests: 'read', checks: 'read', contents: 'read' });
        expect(calls).toHaveLength(3);
        expect(calls.every((c) => bearerOf(c) === `Bearer ${READ_WITH_CHECKS}`)).toBe(true);
        expect(s.checks).toEqual({ state: 'success', totalCount: 1, successCount: 1, failureCount: 0, pendingCount: 0 });
      });

      it('422 on the checks mint → re-mints without checks and returns a PARTIAL status (no check-runs call)', async () => {
        const mint = fakeMint({ checksGranted: false });
        const { fn, calls } = routedFetch({ status: 200 });
        const s = await appProvider(fn, mint.source).getPullRequestStatus(statusInput);
        expect(mint.requested).toEqual([{ ...PULL_REQUEST_STATUS_PERMISSIONS }, { ...PULL_REQUEST_STATUS_PERMISSIONS_WITHOUT_CHECKS }]);
        expect(PULL_REQUEST_STATUS_PERMISSIONS_WITHOUT_CHECKS).toEqual({ pull_requests: 'read', contents: 'read' });
        expect(calls.some((c) => c.url.includes('/check-runs'))).toBe(false);
        expect(calls.every((c) => bearerOf(c) === `Bearer ${READ_NO_CHECKS}`)).toBe(true);
        expect(s.state).toBe('open');
        expect(s.reviews).toEqual({ state: 'approved', approvedCount: 1, changesRequestedCount: 0 });
        expect(s.mergeability).toBe('UNKNOWN'); // fixture omits mergeable → conservative UNKNOWN
        expect(s.checks).toEqual(UNAVAILABLE);
      });

      it('any other mint failure propagates (no silent fallback)', async () => {
        const mint = fakeMint({ checksGranted: true, failWith: new Error('github app: tokenForInstallation authorization failed') });
        const { fn, calls } = routedFetch({ status: 200 });
        await expect(appProvider(fn, mint.source).getPullRequestStatus(statusInput)).rejects.toThrow(/authorization failed/);
        expect(mint.requested).toHaveLength(1);
        expect(calls).toHaveLength(0);
      });

      it('403 on check-runs → PARTIAL status with unavailable checks (App and PAT alike)', async () => {
        const app = routedFetch({ status: 403, body: { message: 'Resource not accessible by integration' } });
        const s = await appProvider(app.fn, fakeMint({ checksGranted: true }).source).getPullRequestStatus(statusInput);
        expect(s.checks).toEqual(UNAVAILABLE);
        expect(s.state).toBe('open');
        expect(s.reviews?.state).toBe('approved');
        const pat = routedFetch({ status: 403 });
        await expect(provider(pat.fn).getPullRequestStatus(statusInput)).resolves.toMatchObject({ checks: UNAVAILABLE });
      });

      it('a rate-limited 403 or a 5xx on check-runs stays a whole-read failure (not reported as a missing permission)', async () => {
        for (const headers of [{ 'x-ratelimit-remaining': '0' }, { 'retry-after': '60' }]) {
          const { fn } = routedFetch({ status: 403, headers });
          await expect(provider(fn).getPullRequestStatus(statusInput)).rejects.toThrow(/authorization failed/);
        }
        const { fn } = routedFetch({ status: 500 });
        await expect(provider(fn).getPullRequestStatus(statusInput)).rejects.toThrow(/status 500/);
      });

      it('an empty status token is refused before any request', async () => {
        const { fn, calls } = routedFetch({ status: 200 });
        await expect(
          appProvider(fn, async () => ({ token: '', checksReadable: true })).getPullRequestStatus(statusInput),
        ).rejects.toThrow(/empty token/);
        expect(calls).toHaveLength(0);
      });

      it('no regression: PR create and merge preflight keep the write token source; the status source is never used', async () => {
        let statusMints = 0;
        const statusTokenSource = async () => {
          statusMints += 1;
          return { token: READ_WITH_CHECKS, checksReadable: true };
        };
        const create = fakeFetch(() => ({ status: 201, body: ghPull() }));
        await appProvider(create.fn, statusTokenSource).createPullRequest(createInput);
        expect(bearerOf(create.calls[0]!)).toBe(`Bearer ${WRITE}`);
        const pre = fakeFetch(() => ({ status: 200, body: { ...ghPull(), state: 'open', merged: false, mergeable: true, mergeable_state: 'clean' } }));
        await appProvider(pre.fn, statusTokenSource).getMergePreflight(statusInput);
        expect(pre.calls.every((c) => bearerOf(c) === `Bearer ${WRITE}`)).toBe(true);
        expect(pre.calls.some((c) => c.url.includes('/check-runs'))).toBe(false);
        expect(statusMints).toBe(0);
      });
    });
  });
});

// ── Source-level absence guards (tests 40–51) ──────────────────────────────────────────────────────────────
function src(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}
/** Strip comments so guards match real CODE, not explanatory prose (e.g. a comment naming forbidden fields). */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const adapterSrc = codeOf(src('./index.ts'));
const pkgJson = src('../package.json');
const appModuleSrc = src('../../../apps/quoky/src/app.module.ts');
const runtimeSrc = src('../../core/src/application/conversation-runtime.ts');
const composerSrc = src('../../core/src/application/response-composer.ts');
const gitProviderPortSrc = src('../../core/src/ports/git-provider.port.ts');
const gitManagerSrc = src('../../core/src/application/git-manager.ts');

describe('Sprint 3d-C absence guards (adapter-only; no octokit / shell / wiring / mutation)', () => {
  it('package has no octokit dependency (tests 41)', () => {
    expect(pkgJson.includes('octokit')).toBe(false);
    expect(pkgJson.includes('@octokit')).toBe(false);
  });
  it('adapter uses no child_process / CommandExecution / shell (tests 42/43)', () => {
    for (const forbidden of ['child_process', 'CommandExecution', 'CommandRunner', 'spawn(', 'execSync', 'require(']) {
      expect(adapterSrc.includes(forbidden)).toBe(false);
    }
  });
  it('adapter reads no env token (token is constructor-local only — CA change 1)', () => {
    expect(adapterSrc.includes('process.env')).toBe(false);
    expect(adapterSrc.includes('CHUNSIK_GITHUB_TOKEN')).toBe(false);
  });
  // (Sprint 3g, ADR-0057 + Sprint 3j-B, ADR-0060 supersede) The adapter now uses the PR `/merge` endpoint (PUT) and
  // the Git-refs `DELETE` endpoint (remote branch cleanup) by CA-approved design.
  // ENDURING invariant: still NO deploy/release/reviewer/label/assignee surface, and DELETE is scoped to git/refs.
  it('adapter adds only /merge (PUT) + git-refs DELETE — no deploy/release/reviewer/label/assignee (test 51; 3g/3j-B)', () => {
    for (const forbidden of ['requested_reviewers', 'labels', 'assignees', '/deployments', '/releases', 'reviewer']) {
      expect(adapterSrc.includes(forbidden)).toBe(false);
    }
    // the merge endpoint IS present, and merge_method is 'merge' only (no squash/rebase, no force).
    expect(adapterSrc.includes('/merge')).toBe(true);
    expect(adapterSrc.includes("merge_method: 'merge'")).toBe(true);
    expect(adapterSrc.includes('squash')).toBe(false);
    expect(adapterSrc.includes('rebase')).toBe(false);
    // Sprint 3j-B: DELETE is present and scoped to git/refs/heads (remote branch cleanup) — never push/force/wildcard.
    expect(adapterSrc.includes("'DELETE'")).toBe(true);
    expect(adapterSrc.includes('git/refs/')).toBe(true);
    expect(adapterSrc.includes('push')).toBe(false);
    expect(adapterSrc.includes('--delete')).toBe(false);
    expect(adapterSrc.includes('--force')).toBe(false);
  });
  // (Sprint 3d-D, ADR-0054 supersedes) The adapter is now wired into app.module and the runtime has PR
  // creation execution + PR_CREATED. The ENDURING invariant kept here: the runtime/composer never IMPORT the
  // adapter package directly — the runtime reaches it only via RepositoryHostingManager (CA change 7).
  it('ConversationRuntime / ResponseComposer never import the GitHub adapter package directly', () => {
    expect(runtimeSrc.includes('repository-hosting-github')).toBe(false);
    expect(runtimeSrc.includes('GitHubRepositoryHostingProvider')).toBe(false);
    expect(composerSrc.includes('repository-hosting-github')).toBe(false);
    expect(composerSrc.includes('GitHubRepositoryHostingProvider')).toBe(false);
  });
  it('Git capability has no PR method (tests 49/50)', () => {
    expect(gitProviderPortSrc.includes('createPullRequest')).toBe(false);
    expect(gitManagerSrc.includes('createPullRequest')).toBe(false);
  });
});

describe('GitHubRepositoryHostingProvider — merge preflight + execution (CAP-010 adapter, ADR-0057, Sprint 3g)', () => {
  const PR_REF: PullRequestRef = { provider: 'github', owner: 'acme', repo: 'widgets', pullRequestNumber: 42, pullRequestUrl: 'https://github.com/acme/widgets/pull/42' };
  const preflightInput = { identity: IDENTITY, pullRequestRef: PR_REF, expectedHeadBranch: 'feature/x', expectedBaseBranch: 'main', expectedCommitHash: 'abc1234' };
  const mergeInput = { identity: IDENTITY, pullRequestRef: PR_REF, expectedHeadSha: 'abc1234' };

  function ghPreflightPull(over: Record<string, unknown> = {}) {
    return { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', head: { ref: 'feature/x', sha: 'abc1234' }, base: { ref: 'main' }, ...over };
  }

  describe('getMergePreflight (read-only)', () => {
    it('GETs the PR once and maps open + clean → MERGEABLE, echoing the input ref + head/base/commit', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200, body: ghPreflightPull() }));
      const pf = await provider(fn).getMergePreflight(preflightInput);
      expect(calls).toHaveLength(1);
      expect(calls[0].init.method).toBe('GET');
      expect(calls[0].url).toBe('https://api.github.com/repos/acme/widgets/pulls/42');
      expect(pf.state).toBe('open');
      expect(pf.mergeability).toBe('MERGEABLE');
      expect(pf.ref).toEqual(PR_REF);
      expect(pf.headBranch).toBe('feature/x');
      expect(pf.baseBranch).toBe('main');
      expect(pf.headCommitHash).toBe('abc1234');
      expect(typeof pf.observedAt).toBe('string');
    });

    it('maps mergeable_state → normalized mergeability conservatively', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ mergeable_state: 'clean' }, 'MERGEABLE'],
        [{ mergeable_state: 'has_hooks' }, 'MERGEABLE'],
        [{ mergeable_state: 'dirty' }, 'CONFLICTING'],
        [{ mergeable_state: 'blocked' }, 'BLOCKED'],
        [{ mergeable_state: 'draft' }, 'BLOCKED'],
        [{ mergeable_state: 'behind' }, 'STALE_HEAD'],
        [{ mergeable_state: 'unstable' }, 'UNKNOWN'],
        [{ mergeable_state: 'weird' }, 'UNKNOWN'],
        [{ mergeable: false }, 'CONFLICTING'],
        [{ mergeable: null }, 'UNKNOWN'],
      ];
      for (const [over, expected] of cases) {
        const { fn } = fakeFetch(() => ({ status: 200, body: ghPreflightPull(over) }));
        const pf = await provider(fn).getMergePreflight(preflightInput);
        expect(pf.mergeability, JSON.stringify(over)).toBe(expected);
      }
    });

    it('merged=true → state "merged"', async () => {
      const { fn } = fakeFetch(() => ({ status: 200, body: ghPreflightPull({ state: 'closed', merged: true }) }));
      const pf = await provider(fn).getMergePreflight(preflightInput);
      expect(pf.state).toBe('merged');
    });

    it('non-200 → sanitized throw (no token), and 403 does not leak the token', async () => {
      const { fn } = fakeFetch(() => ({ status: 404 }));
      await expect(provider(fn).getMergePreflight(preflightInput)).rejects.toThrow(/getMergePreflight/);
      const p = provider(fakeFetch(() => ({ status: 403 })).fn);
      await p.getMergePreflight(preflightInput).catch((e: unknown) => {
        expect(String((e as Error).message)).not.toContain(TOKEN);
      });
    });
  });

  describe('mergePullRequest (single mutating PUT)', () => {
    it('PUTs /pulls/{n}/merge with sha + merge_method "merge"; 200 + merged → merged result', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200, body: { merged: true, sha: 'def4567aa' } }));
      const r = await provider(fn).mergePullRequest(mergeInput);
      expect(calls).toHaveLength(1);
      expect(calls[0].init.method).toBe('PUT');
      expect(calls[0].url).toBe('https://api.github.com/repos/acme/widgets/pulls/42/merge');
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.sha).toBe('abc1234');
      expect(body.merge_method).toBe('merge');
      expect(body.merge_method).not.toBe('squash');
      expect(body.merge_method).not.toBe('rebase');
      expect(r.merged).toBe(true);
      expect(r.mergedHeadSha).toBe('abc1234'); // the head we asked to merge
      expect(r.mergeCommitHash).toBe('def4567aa');
      expect(r.alreadyMerged).toBe(false);
    });

    it('non-200 → sanitized throw (no token leak)', async () => {
      const { fn } = fakeFetch(() => ({ status: 409 }));
      await expect(provider(fn).mergePullRequest(mergeInput)).rejects.toThrow(/mergePullRequest/);
      const p = provider(fakeFetch(() => ({ status: 403 })).fn);
      await p.mergePullRequest(mergeInput).catch((e: unknown) => {
        expect(String((e as Error).message)).not.toContain(TOKEN);
      });
    });

    it('200 but merged=false → throws (does not claim merged)', async () => {
      const { fn } = fakeFetch(() => ({ status: 200, body: { merged: false, message: 'not mergeable' } }));
      await expect(provider(fn).mergePullRequest(mergeInput)).rejects.toThrow();
    });
  });

  // ── Sprint 3j-B (ADR-0060): remote branch cleanup — getRemoteBranchCommit + deleteRemoteBranch (read-before-delete). ──
  describe('getRemoteBranchCommit (Sprint 3j-B)', () => {
    it('200 → returns the ref object sha; exact GET url /git/ref/heads/<branch>', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200, body: { object: { sha: 'abc1234def', type: 'commit' } } }));
      const r = await provider(fn).getRemoteBranchCommit(IDENTITY, 'feature/x');
      expect(r).toEqual({ commitHash: 'abc1234def' });
      expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widgets/git/ref/heads/feature/x');
      expect(calls[0]!.init.method).toBe('GET');
    });

    it('404 → null (branch absent)', async () => {
      const { fn } = fakeFetch(() => ({ status: 404 }));
      expect(await provider(fn).getRemoteBranchCommit(IDENTITY, 'feature/x')).toBeNull();
    });

    it('a non-commit ref object → throws', async () => {
      const { fn } = fakeFetch(() => ({ status: 200, body: { object: { sha: 'abc1234def', type: 'tag' } } }));
      await expect(provider(fn).getRemoteBranchCommit(IDENTITY, 'feature/x')).rejects.toThrow();
    });

    it('an auth-error status is sanitized (never leaks the token)', async () => {
      const { fn } = fakeFetch(() => ({ status: 403 }));
      await expect(provider(fn).getRemoteBranchCommit(IDENTITY, 'feature/x')).rejects.toThrow(/authorization failed/);
      await provider(fn).getRemoteBranchCommit(IDENTITY, 'feature/x').catch((e: Error) => {
        expect(e.message).not.toContain(TOKEN);
      });
    });
  });

  describe('deleteRemoteBranch (Sprint 3j-B, tests 21/22/24/32/33)', () => {
    // A fetch that answers the pre-delete GET with the expected sha, and the DELETE with 204.
    function readThenDelete(sha: string) {
      return fakeFetch((url, init) => {
        if (init.method === 'DELETE') return { status: 204 };
        return { status: 200, body: { object: { sha, type: 'commit' } } }; // the GET
      });
    }

    it('SHA match → GET-then-DELETE (exactly one DELETE); exact refs url; returns deleted result', async () => {
      const { fn, calls } = readThenDelete('abc1234');
      const r = await provider(fn).deleteRemoteBranch({ identity: IDENTITY, branch: 'feature/x', expectedCommitHash: 'abc1234' });
      expect(r).toEqual({ provider: 'github', owner: 'acme', repo: 'widgets', branch: 'feature/x', deleted: true, alreadyAbsent: false, deletedCommitHash: 'abc1234' });
      expect(calls.map((c) => c.init.method)).toEqual(['GET', 'DELETE']);
      expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widgets/git/ref/heads/feature/x');
      expect(calls[1]!.url).toBe('https://api.github.com/repos/acme/widgets/git/refs/heads/feature/x');
    });

    it('test 32: slash-containing branch names produce the EXACT refs URL (slashes preserved, not %2F), one ref only', async () => {
      for (const branch of ['feature/login', 'v2/remote-branch-cleanup-approval']) {
        const { fn, calls } = readThenDelete('abc1234');
        await provider(fn).deleteRemoteBranch({ identity: IDENTITY, branch, expectedCommitHash: 'abc1234' });
        expect(calls[0]!.url).toBe(`https://api.github.com/repos/acme/widgets/git/ref/heads/${branch}`);
        expect(calls[1]!.url).toBe(`https://api.github.com/repos/acme/widgets/git/refs/heads/${branch}`);
        expect(calls[1]!.url).not.toContain('%2F'); // slashes preserved
        expect(calls.every((c) => !c.url.includes('*') && !c.url.includes('...') && !/\/branches\b/.test(c.url))).toBe(true); // no wildcard/bulk/branches-list endpoint
      }
    });

    it('test 21/22: uses fetch only — never git/push/--delete/-r/shell (no such argv in the adapter)', async () => {
      const { fn, calls } = readThenDelete('abc1234');
      await provider(fn).deleteRemoteBranch({ identity: IDENTITY, branch: 'feature/x', expectedCommitHash: 'abc1234' });
      for (const c of calls) {
        expect(c.url).not.toMatch(/push|--delete|\s-r\b/);
        expect(['GET', 'DELETE']).toContain(c.init.method);
      }
    });

    it('remote SHA mismatch → Blocked BEFORE any DELETE (read-immediately-before-delete)', async () => {
      const { fn, calls } = fakeFetch((_u, init) => {
        if (init.method === 'DELETE') return { status: 204 };
        return { status: 200, body: { object: { sha: 'deadbeef', type: 'commit' } } };
      });
      await expect(provider(fn).deleteRemoteBranch({ identity: IDENTITY, branch: 'feature/x', expectedCommitHash: 'abc1234' })).rejects.toBeInstanceOf(RemoteBranchCleanupBlockedError);
      expect(calls.map((c) => c.init.method)).toEqual(['GET']); // no DELETE was issued
    });

    it('test 33: pre-delete GET 404 (absent) → alreadyAbsent, no DELETE', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 404 }));
      const r = await provider(fn).deleteRemoteBranch({ identity: IDENTITY, branch: 'feature/x', expectedCommitHash: 'abc1234' });
      expect(r).toMatchObject({ deleted: false, alreadyAbsent: true, branch: 'feature/x' });
      expect(calls.map((c) => c.init.method)).toEqual(['GET']);
    });

    it('DELETE non-204 → Unverified (never "not deleted")', async () => {
      const { fn } = fakeFetch((_u, init) => {
        if (init.method === 'DELETE') return { status: 422 };
        return { status: 200, body: { object: { sha: 'abc1234', type: 'commit' } } };
      });
      await expect(provider(fn).deleteRemoteBranch({ identity: IDENTITY, branch: 'feature/x', expectedCommitHash: 'abc1234' })).rejects.toBeInstanceOf(RemoteBranchCleanupUnverifiedError);
    });

    it('test 24: a DELETE network throw → Unverified; token never leaks in the message', async () => {
      const fn = (async (url: unknown, init?: unknown) => {
        const i = (init ?? {}) as RequestInit;
        if (i.method === 'DELETE') throw new Error('network down');
        return { status: 200, json: async () => ({ object: { sha: 'abc1234', type: 'commit' } }) } as unknown as Response;
      }) as unknown as typeof fetch;
      await provider(fn).deleteRemoteBranch({ identity: IDENTITY, branch: 'feature/x', expectedCommitHash: 'abc1234' }).catch((e: Error) => {
        expect(e).toBeInstanceOf(RemoteBranchCleanupUnverifiedError);
        expect(e.message).not.toContain(TOKEN);
      });
    });
  });
});

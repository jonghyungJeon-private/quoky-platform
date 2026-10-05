import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppAuthError, GitHubAppAuth, isPermissionNotGrantedError } from './index';

// A real RSA key so signAppJwt() exercises built-in RS256 signing deterministically — no network, no fixed secret.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface Call {
  url: string;
  init: RequestInit;
}

/** Fake `fetch` that records calls and returns a canned `{ status, body }` — NO live network. */
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

function auth(fn: typeof fetch, now: () => number = () => 1_000_000) {
  return new GitHubAppAuth({ appId: '12345', privateKeyPem: PEM, fetchImpl: fn, now });
}

describe('GitHubAppAuth (Sprint 4b, ADR-0061)', () => {
  describe('construction', () => {
    it('rejects a blank appId or a blank private key', () => {
      const { fn } = fakeFetch(() => ({ status: 200 }));
      expect(() => new GitHubAppAuth({ appId: '', privateKeyPem: PEM, fetchImpl: fn })).toThrow();
      expect(() => new GitHubAppAuth({ appId: '123', privateKeyPem: '   ', fetchImpl: fn })).toThrow();
    });
  });

  describe('resolveInstallationId', () => {
    it('signs an App JWT (Bearer) and returns the installation id on 200', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200, body: { id: 987 } }));
      expect(await auth(fn).resolveInstallationId('acme', 'widgets')).toBe(987);
      expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widgets/installation');
      const h = calls[0]!.init.headers as Record<string, string>;
      expect(h.Authorization.startsWith('Bearer ')).toBe(true);
      // The App JWT is a signed token, not the private key.
      expect(h.Authorization).not.toContain('PRIVATE KEY');
    });

    it('returns null when the App is not installed on the repo (404)', async () => {
      const { fn } = fakeFetch(() => ({ status: 404 }));
      expect(await auth(fn).resolveInstallationId('acme', 'widgets')).toBeNull();
    });

    it('throws a sanitized AppAuthError on 401 (authorization failed)', async () => {
      const { fn } = fakeFetch(() => ({ status: 401 }));
      await expect(auth(fn).resolveInstallationId('acme', 'widgets')).rejects.toThrow(/authorization failed/);
    });

    it('caches a resolved installation id (no second fetch)', async () => {
      const { fn, calls } = fakeFetch(() => ({ status: 200, body: { id: 987 } }));
      const a = auth(fn);
      await a.resolveInstallationId('acme', 'widgets');
      await a.resolveInstallationId('acme', 'widgets');
      expect(calls.length).toBe(1);
    });
  });

  describe('tokenForInstallation', () => {
    it('mints a token on 201 and sends down-scoping (repository_ids + permissions) in the POST body', async () => {
      const { fn, calls } = fakeFetch(() => ({
        status: 201,
        body: { token: 'ghs_mintedToken', expires_at: new Date(2_000_000).toISOString() },
      }));
      const t = await auth(fn).tokenForInstallation(987, {
        permissions: { contents: 'write', pull_requests: 'write' },
        repositoryIds: [7],
      });
      expect(t).toBe('ghs_mintedToken');
      expect(calls[0]!.url).toBe('https://api.github.com/app/installations/987/access_tokens');
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.permissions).toEqual({ contents: 'write', pull_requests: 'write' });
      expect(body.repository_ids).toEqual([7]);
    });

    it('caches within the refresh buffer (no second mint)', async () => {
      const now = 1_000_000;
      const { fn, calls } = fakeFetch(() => ({
        status: 201,
        body: { token: 'ghs_mintedToken', expires_at: new Date(now + 60 * 60_000).toISOString() },
      }));
      const a = new GitHubAppAuth({ appId: '1', privateKeyPem: PEM, fetchImpl: fn, now: () => now });
      await a.tokenForInstallation(987);
      await a.tokenForInstallation(987);
      expect(calls.length).toBe(1);
    });

    it('re-mints when the cached token is within the refresh buffer of expiry', async () => {
      const now = 1_000_000;
      const { fn, calls } = fakeFetch(() => ({
        status: 201,
        body: { token: 'ghs_mintedToken', expires_at: new Date(now + 60_000).toISOString() },
      }));
      const a = new GitHubAppAuth({ appId: '1', privateKeyPem: PEM, fetchImpl: fn, now: () => now });
      await a.tokenForInstallation(987);
      await a.tokenForInstallation(987);
      expect(calls.length).toBe(2);
    });

    it('throws a sanitized error on 401 (no token echoed)', async () => {
      const { fn } = fakeFetch(() => ({ status: 401 }));
      const err = await auth(fn)
        .tokenForInstallation(987)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppAuthError);
      expect(String((err as Error).message)).toMatch(/authorization failed/);
      expect(String((err as Error).message)).not.toMatch(/ghs_/);
    });

    it('marks a 422 mint (permission not granted to the App) as retryable with narrower permissions', async () => {
      const { fn } = fakeFetch(() => ({ status: 422, body: { message: 'The permissions requested are not granted to this app.' } }));
      const err = await auth(fn)
        .tokenForInstallation(987, { permissions: { checks: 'read' } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppAuthError);
      expect((err as AppAuthError).status).toBe(422);
      expect(isPermissionNotGrantedError(err)).toBe(true);
      expect(String((err as Error).message)).toBe('github app: tokenForInstallation failed with status 422');
    });

    it('does not treat other failures as a missing permission', async () => {
      const { fn } = fakeFetch(() => ({ status: 401 }));
      const err = await auth(fn).tokenForInstallation(987).catch((e: unknown) => e);
      expect(isPermissionNotGrantedError(err)).toBe(false);
      expect(isPermissionNotGrantedError(new Error('github app: x failed with status 422'))).toBe(false);
      expect(isPermissionNotGrantedError(undefined)).toBe(false);
    });
  });

  describe('resolveRepositoryId + tokenForRepository — numeric repository_ids down-scoping (Sprint 4b review, RC2)', () => {
    // Fake: POST /access_tokens returns a token (final iff repository_ids present); GET /repos/{o}/{r} returns {id}.
    function repoAwareFetch(repoStatus: number, repoId = 555) {
      return fakeFetch((url, init) => {
        const method = init.method ?? 'GET';
        if (url.endsWith('/access_tokens') && method === 'POST') {
          const body = init.body ? (JSON.parse(String(init.body)) as { repository_ids?: number[] }) : {};
          return {
            status: 201,
            body: {
              token: body.repository_ids ? 'ghs_final' : 'ghs_bootstrap',
              expires_at: new Date(9_000_000).toISOString(),
            },
          };
        }
        if (/\/repos\/acme\/widgets$/.test(url) && method === 'GET') return { status: repoStatus, body: { id: repoId } };
        return { status: 500 };
      });
    }

    it('resolveRepositoryId reads the repo id via a repository-NAME-scoped bootstrap token (200 → id, cached)', async () => {
      const { fn, calls } = repoAwareFetch(200, 777);
      const a = auth(fn);
      expect(await a.resolveRepositoryId(123, 'acme', 'widgets')).toBe(777);
      // the bootstrap access_tokens POST scoped by repository NAME (never an installation-wide broad token)
      const boot = calls.find((c) => c.url.endsWith('/access_tokens'));
      expect((JSON.parse(String(boot!.init.body)) as { repositories?: string[] }).repositories).toEqual(['widgets']);
      // cached — no second repo GET
      await a.resolveRepositoryId(123, 'acme', 'widgets');
      expect(calls.filter((c) => /\/repos\/acme\/widgets$/.test(c.url)).length).toBe(1);
    });

    it('resolveRepositoryId returns null when the repo is not accessible (404)', async () => {
      const { fn } = repoAwareFetch(404);
      expect(await auth(fn).resolveRepositoryId(123, 'acme', 'widgets')).toBeNull();
    });

    it('tokenForRepository mints the final token with numeric repository_ids + minimal permissions', async () => {
      const { fn, calls } = repoAwareFetch(200, 555);
      const t = await auth(fn).tokenForRepository(123, 'acme', 'widgets', { contents: 'write', pull_requests: 'write' });
      expect(t).toBe('ghs_final');
      const finalPost = calls.find(
        (c) =>
          c.url.endsWith('/access_tokens') &&
          !!(JSON.parse(String(c.init.body)) as { repository_ids?: number[] }).repository_ids,
      );
      const body = JSON.parse(String(finalPost!.init.body)) as { repository_ids: number[]; permissions: unknown };
      expect(body.repository_ids).toEqual([555]);
      expect(body.permissions).toEqual({ contents: 'write', pull_requests: 'write' });
    });

    it('tokenForRepository throws (AppAuthError) and does NOT mint a repository_ids token when the repo lookup 404s', async () => {
      const { fn, calls } = repoAwareFetch(404);
      await expect(auth(fn).tokenForRepository(123, 'acme', 'widgets')).rejects.toBeInstanceOf(AppAuthError);
      const finalMint = calls.find(
        (c) =>
          c.url.endsWith('/access_tokens') &&
          !!c.init.body &&
          !!(JSON.parse(String(c.init.body)) as { repository_ids?: number[] }).repository_ids,
      );
      expect(finalMint).toBeUndefined();
    });
  });
});

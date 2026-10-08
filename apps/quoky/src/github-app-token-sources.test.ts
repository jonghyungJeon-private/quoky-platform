import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RepositoryIdentity } from '@quoky/core';
import { GitHubAppAuth } from '@quoky/github-app-auth';
import { createPullRequestStatusTokenSource } from '@quoky/repository-hosting-github';
import { EXPLICIT_INSTALLATION_MISMATCH, NOT_ALLOWLISTED_MINT_REFUSAL, createGitHubAppTokenSources } from './github-app-token-sources';
import type { GitHubAppTokenMinter } from './github-app-token-sources';
import { RepositoryAllowlist } from './repository-allowlist';

/** ADR-0109 D3: per-repository down-scoping; a non-allowlisted identity never reaches a mint. */
const WIDGETS: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'widgets' };
const GADGETS: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'gadgets' };
const OTHER: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'other' };

function fakeMinter(opts: { installationOf?: (repo: string) => number | null; accountOf?: (id: number) => string | null } = {}) {
  const calls: string[] = [];
  const minter: GitHubAppTokenMinter = {
    async resolveInstallationId(owner, repo) {
      calls.push(`installation ${owner}/${repo}`);
      return opts.installationOf ? opts.installationOf(repo) : repo === 'gadgets' ? 22 : 11;
    },
    async getInstallationAccountLogin(id) {
      calls.push(`account ${id}`);
      return opts.accountOf ? opts.accountOf(id) : 'acme';
    },
    async tokenForRepository(installationId, owner, repo, permissions) {
      calls.push(`repo ${installationId} ${owner}/${repo} ${JSON.stringify(permissions)}`);
      return `scoped-${repo}`;
    },
    async tokenForInstallation(installationId, scope) {
      calls.push(`installation-token ${installationId} ${JSON.stringify(scope)}`);
      return 'connector-read';
    },
  };
  return { calls, minter };
}

function sourcesWith(minter: GitHubAppTokenMinter, installationId?: number) {
  return createGitHubAppTokenSources({
    minter,
    allowlist: new RepositoryAllowlist([WIDGETS, GADGETS]),
    ...(installationId !== undefined ? { installationId } : {}),
    createStatusTokenSource: (mint) => createPullRequestStatusTokenSource(mint, () => false),
  });
}

describe('createGitHubAppTokenSources (ADR-0109 D3)', () => {
  it('a non-allowlisted identity is refused before any installation lookup or mint (write and status sources)', async () => {
    const { calls, minter } = fakeMinter();
    const sources = sourcesWith(minter);
    await expect(sources.tokenSource(OTHER)).rejects.toThrow(NOT_ALLOWLISTED_MINT_REFUSAL);
    await expect(sources.statusTokenSource(OTHER)).rejects.toThrow(NOT_ALLOWLISTED_MINT_REFUSAL);
    expect(calls).toEqual([]);
  });

  it('each token is minted by tokenForRepository for exactly the one repository the call names', async () => {
    const { calls, minter } = fakeMinter();
    const sources = sourcesWith(minter);
    await expect(sources.tokenSource(WIDGETS)).resolves.toBe('scoped-widgets');
    await expect(sources.tokenSource({ ...GADGETS, owner: 'ACME' })).resolves.toBe('scoped-gadgets');
    await expect(sources.statusTokenSource(GADGETS)).resolves.toEqual({ token: 'scoped-gadgets', checksReadable: true });
    expect(calls).toEqual([
      'installation acme/widgets',
      'repo 11 acme/widgets {"contents":"write","pull_requests":"write"}',
      'installation acme/gadgets',
      'repo 22 acme/gadgets {"contents":"write","pull_requests":"write"}',
      'repo 22 acme/gadgets {"pull_requests":"read","checks":"read","contents":"read"}',
    ]);
  });

  it('an explicit installation id is used only after the App-JWT lookups confirm it is this owner\'s installation', async () => {
    const { calls, minter } = fakeMinter({ installationOf: () => 99 });
    const sources = sourcesWith(minter, 99);
    await sources.tokenSource(WIDGETS);
    await sources.tokenSource(WIDGETS); // verified once per repository
    await sources.tokenSource(GADGETS);
    expect(calls).toEqual([
      'installation acme/widgets',
      'account 99',
      'repo 99 acme/widgets {"contents":"write","pull_requests":"write"}',
      'repo 99 acme/widgets {"contents":"write","pull_requests":"write"}',
      'installation acme/gadgets',
      'account 99',
      'repo 99 acme/gadgets {"contents":"write","pull_requests":"write"}',
    ]);
  });

  it('an explicit installation id that is not the repository\'s installation → refused before any token mint', async () => {
    const { calls, minter } = fakeMinter({ installationOf: () => 11 });
    await expect(sourcesWith(minter, 99).tokenSource(WIDGETS)).rejects.toThrow(EXPLICIT_INSTALLATION_MISMATCH);
    await expect(sourcesWith(minter, 99).statusTokenSource(WIDGETS)).rejects.toThrow(EXPLICIT_INSTALLATION_MISMATCH);
    expect(calls.filter((c) => c.startsWith('repo ') || c.startsWith('installation-token'))).toEqual([]);
  });

  it('an explicit installation id whose account is another owner → refused before any token mint', async () => {
    for (const account of ['someone-else', null]) {
      const { calls, minter } = fakeMinter({ installationOf: () => 99, accountOf: () => account });
      await expect(sourcesWith(minter, 99).tokenSource(WIDGETS)).rejects.toThrow(EXPLICIT_INSTALLATION_MISMATCH);
      expect(calls.filter((c) => c.startsWith('repo ') || c.startsWith('installation-token'))).toEqual([]);
    }
  });

  it('an App not installed on the repository throws (no broad-token fallback)', async () => {
    const minter: GitHubAppTokenMinter = {
      resolveInstallationId: async () => null,
      getInstallationAccountLogin: async () => 'acme',
      tokenForRepository: async () => { throw new Error('must not mint'); },
      tokenForInstallation: async () => { throw new Error('must not mint'); },
    };
    await expect(sourcesWith(minter).tokenSource(WIDGETS)).rejects.toThrow(/not installed/);
  });

  it('the connector read source keeps the read-only installation token of the first allowlisted repository', async () => {
    const { calls, minter } = fakeMinter();
    await expect(sourcesWith(minter).readTokenSource()).resolves.toBe('connector-read');
    expect(calls).toEqual([
      'installation acme/widgets',
      'installation-token 11 {"permissions":{"issues":"read","pull_requests":"read"}}',
    ]);
  });

  it('with the REAL GitHubAppAuth (fake fetch, no network) every minted token names exactly one repository id', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const mintBodies: unknown[] = [];
    const repoIds: Record<string, number> = { widgets: 501, gadgets: 502 };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const json = (status: number, body: unknown) => ({ status, json: async () => body }) as unknown as Response;
      if (u.endsWith('/installation')) return json(200, { id: 7 });
      if (u.endsWith('/access_tokens')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        mintBodies.push(body);
        const label = Array.isArray(body.repository_ids) ? `ids-${(body.repository_ids as number[]).join('-')}` : 'bootstrap';
        return json(201, { token: `test-${label}`, expires_at: '2099-01-01T00:00:00Z' });
      }
      const repo = u.split('/').pop() ?? '';
      return json(200, { id: repoIds[repo] });
    }) as unknown as typeof fetch;
    const appAuth = new GitHubAppAuth({
      appId: '12345',
      privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      fetchImpl,
    });
    const sources = sourcesWith(appAuth);
    await expect(sources.tokenSource(WIDGETS)).resolves.toBe('test-ids-501');
    await expect(sources.tokenSource(GADGETS)).resolves.toBe('test-ids-502');
    await expect(sources.tokenSource(OTHER)).rejects.toThrow(NOT_ALLOWLISTED_MINT_REFUSAL);
    const scoped = mintBodies.filter((b) => Array.isArray((b as { repository_ids?: unknown }).repository_ids));
    expect(scoped).toEqual([
      { repository_ids: [501], permissions: { contents: 'write', pull_requests: 'write' } },
      { repository_ids: [502], permissions: { contents: 'write', pull_requests: 'write' } },
    ]);
    // the bootstrap tokens that resolve a numeric id are repository-NAME scoped to that one repository, too
    const bootstrap = mintBodies.filter((b) => !Array.isArray((b as { repository_ids?: unknown }).repository_ids));
    expect(bootstrap).toEqual([{ repositories: ['widgets'] }, { repositories: ['gadgets'] }]);
  });

  it('explicit installation id with the REAL GitHubAppAuth over fake HTTP: wrong owner or wrong installation → no token POST', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const run = async (repoInstallation: number, account: string) => {
      const requests: string[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const u = String(url);
        requests.push(`${init?.method ?? 'GET'} ${u.replace('https://api.github.com', '')}`);
        const json = (status: number, body: unknown) => ({ status, json: async () => body }) as unknown as Response;
        if (u.endsWith('/repos/acme/widgets/installation')) return json(200, { id: repoInstallation });
        if (u.endsWith('/app/installations/99')) return json(200, { id: 99, account: { login: account } });
        if (u.endsWith('/access_tokens')) return json(201, { token: 'test-scoped', expires_at: '2099-01-01T00:00:00Z' });
        if (u.endsWith('/repos/acme/widgets')) return json(200, { id: 501 });
        return json(404, {});
      }) as unknown as typeof fetch;
      const auth = new GitHubAppAuth({ appId: '12345', privateKeyPem: pem, fetchImpl });
      const outcome = await sourcesWith(auth, 99).tokenSource(WIDGETS).then(
        (token) => token,
        (error: Error) => error.message,
      );
      return { outcome, requests };
    };
    const otherOwner = await run(99, 'someone-else');
    expect(otherOwner.outcome).toBe(EXPLICIT_INSTALLATION_MISMATCH);
    expect(otherOwner.requests).toEqual(['GET /repos/acme/widgets/installation', 'GET /app/installations/99']);
    const otherInstallation = await run(7, 'acme');
    expect(otherInstallation.outcome).toBe(EXPLICIT_INSTALLATION_MISMATCH);
    expect(otherInstallation.requests).toEqual(['GET /repos/acme/widgets/installation']);
    const ok = await run(99, 'ACME');
    expect(ok.outcome).toBe('test-scoped');
    expect(ok.requests.slice(0, 2)).toEqual(['GET /repos/acme/widgets/installation', 'GET /app/installations/99']);
    expect(ok.requests.filter((r) => r.startsWith('POST /app/installations/99/access_tokens'))).toHaveLength(2); // bootstrap + scoped
  });
});

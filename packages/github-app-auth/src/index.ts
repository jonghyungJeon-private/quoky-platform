import { createSign } from 'node:crypto';

/**
 * GitHub App authentication (CAP-010/CAP-002; ADR-0061). **Adapter-local** minting of short-lived GitHub App
 * **installation access tokens** from the App private key — used as the `Authorization: Bearer` value for
 * RepositoryHosting REST (CAP-010) and, via the composition-root git decorator, as the ephemeral git credential
 * for push/clone (CAP-002).
 *
 * **Secret boundary (ADR-0061 most-important rule).** The App private key and every minted token are adapter-local:
 * the key is read once at construction and held in a private field; a minted token lives only in the in-memory
 * cache; **neither is ever returned in an error, logged, or persisted**. `AppAuthError` messages are sanitized
 * (401/403 → "authorization failed"; never the token/JWT/key/raw payload).
 *
 * **Constraints (ADR-0053 preserved).** github.com only; **built-in `crypto` (RS256) + `fetch` only** — no octokit /
 * gh / curl / extra SDK; one bounded request per call (no pagination/retry loops).
 */

/** Fixed GitHub API base (github.com only; Enterprise deferred — no override). */
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'quoky-github-app-auth';
/** Refresh a cached installation token when fewer than this many ms remain before expiry. */
const REFRESH_BUFFER_MS = 5 * 60_000;
/** Fallback token lifetime when GitHub omits/does-not-parse `expires_at` (GitHub issues ~1h tokens). */
const DEFAULT_TOKEN_TTL_MS = 55 * 60_000;

export interface AppAuthConfig {
  /** GitHub App id (non-secret). */
  appId: string;
  /** App private key PEM (SECRET) — adapter-local ONLY; never logged/returned/persisted. */
  privateKeyPem: string;
  /** Injectable `fetch` for testability (default: global `fetch`). Unit tests pass a fake — no live network. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for deterministic JWT iat/exp + cache expiry in tests (default: `Date.now`). */
  now?: () => number;
  /** Optional per-request timeout (ms) via `AbortSignal.timeout`. */
  timeoutMs?: number;
}

/** Optional per-execution down-scoping of a minted installation token (ADR-0061 Q7 / §17.4). */
export interface TokenScope {
  /** Restrict the token to these repository ids (numeric) — the down-scoped mint (ADR-0061 §8.4). */
  repositoryIds?: number[];
  /** Restrict the token to these repository NAMES — used by the bootstrap token that resolves a numeric repo id. */
  repositories?: string[];
  /** Restrict the token to a permission subset, e.g. `{ contents: 'write', pull_requests: 'write' }`. */
  permissions?: Record<string, 'read' | 'write'>;
}

/** Sanitized App-auth failure — NEVER carries the token, App JWT, private key, or a raw payload (ADR-0061). */
export class AppAuthError extends Error {
  /** The GitHub HTTP status of a sanitized status failure (a bare number; never a body/header/token). */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AppAuthError';
    if (status !== undefined) this.status = status;
  }
}

/**
 * True when an installation-token mint was refused with 422 — GitHub's answer when the requested `permissions`
 * include one the App was not granted (for example `checks: read` before the owner approves the Checks permission).
 * Lets a caller retry with a narrower permission set instead of failing outright.
 */
export function isPermissionNotGrantedError(error: unknown): boolean {
  return error instanceof AppAuthError && error.status === 422;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class GitHubAppAuth {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs?: number;
  /** installationId+scope → cached token (in-memory only; never persisted). */
  private readonly tokenCache = new Map<string, CachedToken>();
  /** "owner/repo" → resolved installation id (stable; cached for the process lifetime). */
  private readonly installationCache = new Map<string, number>();
  /** "owner/repo" → resolved numeric repository id (stable; cached for the process lifetime). */
  private readonly repoIdCache = new Map<string, number>();

  constructor(config: AppAuthConfig) {
    const appId = typeof config?.appId === 'string' ? config.appId.trim() : '';
    const keyPresent = typeof config?.privateKeyPem === 'string' && config.privateKeyPem.trim().length > 0;
    if (appId.length === 0) throw new Error('github app: a non-empty appId is required');
    if (!keyPresent) throw new Error('github app: a non-empty private key is required');
    this.appId = appId;
    // Keep the PEM exactly as supplied (trailing newline can matter for some keys); never trim the key body.
    this.privateKeyPem = config.privateKeyPem;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Resolve the installation id for `owner/repo` from the reviewed identity, or `null` when the App is not installed
   * there (404 → the "not installed" fail-safe). Successful resolutions are cached; a 404 is not cached (a later
   * install is picked up without a restart). Never a chat-supplied id — the caller passes the reviewed identity.
   */
  async resolveInstallationId(owner: string, repo: string): Promise<number | null> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.installationCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const res = await this.request(
      'resolveInstallationId',
      'GET',
      `/repos/${enc(owner)}/${enc(repo)}/installation`,
      this.signAppJwt(),
    );
    if (res.status === 404) return null;
    if (res.status !== 200) throw this.statusError('resolveInstallationId', res.status);
    const body = (await this.json(res, 'resolveInstallationId')) as { id?: unknown };
    const id = body?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new AppAuthError('github app: resolveInstallationId returned an invalid installation id');
    }
    this.installationCache.set(cacheKey, id);
    return id;
  }

  /**
   * Resolve the **numeric** repository id for `owner/repo` (ADR-0061 §8.4 down-scoping), or `null` when the repo is
   * not accessible to the installation (404). An App JWT cannot read repo metadata, so this uses a repository-NAME-
   * scoped installation token to read `GET /repos/{owner}/{repo}` — no installation-wide token is minted. Cached.
   */
  async resolveRepositoryId(installationId: number, owner: string, repo: string): Promise<number | null> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new AppAuthError('github app: resolveRepositoryId requires a valid installation id');
    }
    const cacheKey = `${owner}/${repo}`;
    const cached = this.repoIdCache.get(cacheKey);
    if (cached !== undefined) return cached;
    // A repository-NAME-scoped token authorizes the single metadata read without an installation-wide token.
    const bootstrapToken = await this.tokenForInstallation(installationId, { repositories: [repo] });
    const res = await this.request('resolveRepositoryId', 'GET', `/repos/${enc(owner)}/${enc(repo)}`, bootstrapToken);
    if (res.status === 404) return null;
    if (res.status !== 200) throw this.statusError('resolveRepositoryId', res.status);
    const body = (await this.json(res, 'resolveRepositoryId')) as { id?: unknown };
    const id = body?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new AppAuthError('github app: resolveRepositoryId returned an invalid repository id');
    }
    this.repoIdCache.set(cacheKey, id);
    return id;
  }

  /**
   * Mint a short-lived installation token **down-scoped to the single target repository** (ADR-0061 §8.4): resolve
   * the numeric repo id (cached), then mint with `repository_ids: [id]` + `permissions`. A repo not accessible to
   * the installation (id → null) throws — the caller (a pre-mutation step) surfaces it as Blocked / not configured;
   * there is **no** broad-token fallback.
   */
  async tokenForRepository(
    installationId: number,
    owner: string,
    repo: string,
    permissions?: Record<string, 'read' | 'write'>,
  ): Promise<string> {
    const repoId = await this.resolveRepositoryId(installationId, owner, repo);
    if (repoId === null) throw new AppAuthError('github app: repository is not accessible to the installation');
    return this.tokenForInstallation(installationId, {
      repositoryIds: [repoId],
      ...(permissions ? { permissions } : {}),
    });
  }

  /**
   * Return a valid short-lived installation access token — a cached one while it is comfortably before expiry
   * (refresh buffer), otherwise a freshly minted one. Minted lazily at call time; held in memory only; NEVER
   * persisted/logged/returned in an error. Optionally down-scoped to `scope` (repository ids + permissions).
   */
  async tokenForInstallation(installationId: number, scope?: TokenScope): Promise<string> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new AppAuthError('github app: tokenForInstallation requires a valid installation id');
    }
    const cacheKey = `${installationId}:${scopeKey(scope)}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - this.now() > REFRESH_BUFFER_MS) return cached.token;

    const body: Record<string, unknown> = {};
    if (scope?.repositoryIds && scope.repositoryIds.length > 0) body.repository_ids = scope.repositoryIds;
    if (scope?.repositories && scope.repositories.length > 0) body.repositories = scope.repositories;
    if (scope?.permissions && Object.keys(scope.permissions).length > 0) body.permissions = scope.permissions;
    const hasBody = Object.keys(body).length > 0;

    const res = await this.request(
      'tokenForInstallation',
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      this.signAppJwt(),
      hasBody ? body : undefined,
    );
    if (res.status !== 201) throw this.statusError('tokenForInstallation', res.status);
    const parsed = (await this.json(res, 'tokenForInstallation')) as { token?: unknown; expires_at?: unknown };
    const token = parsed?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new AppAuthError('github app: tokenForInstallation returned an empty token');
    }
    const parsedExpiry = typeof parsed?.expires_at === 'string' ? Date.parse(parsed.expires_at) : Number.NaN;
    const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : this.now() + DEFAULT_TOKEN_TTL_MS;
    this.tokenCache.set(cacheKey, { token, expiresAtMs });
    return token;
  }

  /**
   * Sign a short-lived App JWT (RS256; `exp` ≤ 10 min, 30s skew guard) with the adapter-local private key, using
   * built-in `node:crypto` only (no SDK). Never persisted; regenerated on demand. The signing input carries no
   * secret; a signing failure is sanitized (never echoes the key or the raw cause).
   */
  private signAppJwt(): string {
    const nowSec = Math.floor(this.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iat: nowSec - 30, exp: nowSec + 540, iss: this.appId };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      signer.end();
      const signature = signer.sign(this.privateKeyPem);
      return `${signingInput}.${signature.toString('base64url')}`;
    } catch {
      throw new AppAuthError('github app: could not sign the app token (invalid private key?)');
    }
  }

  /** Single `fetch` per call (no retry). Sanitized failures — never the App JWT/key/body/headers. */
  private async request(
    op: string,
    method: 'GET' | 'POST',
    path: string,
    bearer: string,
    jsonBody?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
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
      throw new AppAuthError(`github app: ${op} request failed`);
    }
  }

  /** Bounded, deterministic status error — never the token/App JWT/key or the raw response body. */
  private statusError(op: string, status: number): AppAuthError {
    if (status === 401 || status === 403) return new AppAuthError(`github app: ${op} authorization failed`, status);
    return new AppAuthError(`github app: ${op} failed with status ${status}`, status);
  }

  private async json(res: Response, op: string): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new AppAuthError(`github app: ${op} returned an unexpected response`);
    }
  }
}

/** URL-safe base64 (JWT segments). */
function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** Encode a single REST path segment (owner/repo). */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Stable cache-key fragment for a scope so differently-scoped tokens do not collide in the cache. */
function scopeKey(scope?: TokenScope): string {
  if (!scope) return '';
  const ids = scope.repositoryIds ? [...scope.repositoryIds].sort((a, b) => a - b).join(',') : '';
  const names = scope.repositories ? [...scope.repositories].sort((a, b) => a.localeCompare(b)).join(',') : '';
  const perms = scope.permissions
    ? Object.entries(scope.permissions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  return `${ids}|${names}|${perms}`;
}

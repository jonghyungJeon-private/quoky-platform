import {
  ConnectorQueryError,
  ConnectorQueryName,
  connectorQueryErrorReasonForStatus,
  parsePersonalWorkParams,
  resolveConnectorQueryTimeoutMs,
  toConnectorTimestamp,
  type ConnectorItem,
  type ConnectorProvider,
  type ConnectorQuery,
  type ConnectorResult,
  type PersonalWorkFilter,
} from '@quoky/core';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const SUMMARY_LIMIT = 500;
const REPOSITORY_URL_PATTERN = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export type GitHubConnectorAuth =
  | { kind: 'github-app'; tokenSource: () => Promise<string> }
  | { kind: 'pat'; token: string };

export interface GitHubConnectorConfig {
  auth: GitHubConnectorAuth;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
}

export type GitHubConnectorHttpErrorKind =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'HTTP_ERROR';

/** A sanitized GitHub HTTP failure. It never contains response content, credentials, or request headers. */
export class GitHubConnectorHttpError extends ConnectorQueryError {
  constructor(
    readonly kind: GitHubConnectorHttpErrorKind,
    readonly status: number,
  ) {
    super(
      kind === 'RATE_LIMITED' ? 'RATE_LIMITED' : connectorQueryErrorReasonForStatus(status),
      `github connector: query failed (${kind.toLowerCase()})`,
    );
    this.name = 'GitHubConnectorHttpError';
  }
}

/** A sanitized transport or timeout failure. The underlying fetch error is deliberately not retained. */
export class GitHubConnectorRequestError extends ConnectorQueryError {
  constructor() {
    super('UNAVAILABLE', 'github connector: query request failed');
    this.name = 'GitHubConnectorRequestError';
  }
}

/** A sanitized response-shape failure. Raw response content is deliberately not retained. */
export class GitHubConnectorResponseError extends ConnectorQueryError {
  constructor() {
    super('INVALID_RESPONSE', 'github connector: query returned an unexpected response');
    this.name = 'GitHubConnectorResponseError';
  }
}

export class GitHubConnectorProvider implements ConnectorProvider {
  readonly source = 'github';
  readonly readOnly = true;

  private readonly auth: GitHubConnectorAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: GitHubConnectorConfig) {
    if (config?.auth?.kind === 'pat') {
      const token = config.auth.token.trim();
      if (!token) throw new Error('github connector: a non-empty token is required');
      this.auth = { kind: 'pat', token };
    } else if (config?.auth?.kind === 'github-app' && typeof config.auth.tokenSource === 'function') {
      this.auth = config.auth;
    } else {
      throw new Error('github connector: a valid auth config is required');
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'github connector');
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async query(input: ConnectorQuery): Promise<ConnectorResult> {
    if (input?.query !== ConnectorQueryName.PERSONAL_WORK) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'github connector: unsupported query');
    }
    const { actorExternalId, filter, limit } = parsePersonalWorkParams(input.params, 'github connector');
    const q = personalWorkSearch(githubQualifier(actorExternalId), filter);
    const token = await this.currentToken();
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'quoky-platform',
    };
    const init: RequestInit = { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs) };
    const url = `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${limit}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      throw new GitHubConnectorRequestError();
    }
    if (!response.ok) throw mapHttpError(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GitHubConnectorResponseError();
    }
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw new GitHubConnectorResponseError();
    }
    return { source: this.source, items: payload.items.slice(0, limit).map((item) => mapItem(item, token)) };
  }

  private async currentToken(): Promise<string> {
    let token: string | undefined;
    try {
      token = this.auth.kind === 'pat' ? this.auth.token : await this.auth.tokenSource();
    } catch {
      throw new ConnectorQueryError('UNAVAILABLE', 'github connector: auth source failed');
    }
    if (typeof token !== 'string' || !token) {
      throw new ConnectorQueryError('UNAUTHORIZED', 'github connector: auth source returned an empty token');
    }
    return token;
  }
}

/** The adapter owns GitHub search qualifier rendering; the login is validated before it reaches a qualifier. */
function personalWorkSearch(login: string, filter: PersonalWorkFilter): string {
  if (filter === 'all') return `involves:${login} is:open archived:false`;
  if (filter === 'review-requested') return `is:pr is:open archived:false review-requested:${login}`;
  throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'github connector: unsupported personal-work filter');
}

function mapItem(value: unknown, token: string): ConnectorItem {
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    !Number.isInteger(value.number) ||
    typeof value.title !== 'string' ||
    typeof value.html_url !== 'string' ||
    typeof value.repository_url !== 'string'
  ) {
    throw new GitHubConnectorResponseError();
  }
  const repository = REPOSITORY_URL_PATTERN.exec(value.repository_url);
  if (!repository) throw new GitHubConnectorResponseError();
  const container = `${repository[1]}/${repository[2]}`;

  const item: ConnectorItem = {
    id: `${container}#${value.number}`,
    title: redactToken(value.title, token),
    url: value.html_url,
    container,
  };
  if (typeof value.body === 'string' && value.body.trim()) {
    item.summary = redactToken(value.body, token).slice(0, SUMMARY_LIMIT);
  }
  const status = value.draft === true ? 'draft' : value.state === 'open' || value.state === 'closed' ? value.state : undefined;
  if (status) item.status = status;
  const updatedAt = toConnectorTimestamp(value.updated_at);
  if (updatedAt) item.updatedAt = updatedAt;
  return item;
}

function mapHttpError(response: Response): GitHubConnectorHttpError {
  const status = response.status;
  if (status === 401) return new GitHubConnectorHttpError('UNAUTHORIZED', status);
  if (status === 403) {
    const exhausted = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');
    return new GitHubConnectorHttpError(exhausted ? 'RATE_LIMITED' : 'FORBIDDEN', status);
  }
  if (status === 404) return new GitHubConnectorHttpError('NOT_FOUND', status);
  if (status === 429) return new GitHubConnectorHttpError('RATE_LIMITED', status);
  if (status >= 500) return new GitHubConnectorHttpError('SERVER_ERROR', status);
  return new GitHubConnectorHttpError('HTTP_ERROR', status);
}

function githubQualifier(value: string): string {
  const identity = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(identity)) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'github connector: actor identity is invalid');
  }
  return identity;
}

function redactToken(value: string, token: string): string {
  return value.split(token).join('[redacted]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

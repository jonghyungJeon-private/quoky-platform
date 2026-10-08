import {
  ConnectorQueryError,
  classifyConnectorWriteTransportFailure,
  connectorQueryErrorReasonForStatus,
  connectorWriteNotSent,
  connectorWriteSent,
  connectorWriteUncertain,
  installConnectorWriteTransportDiagnostics,
  isValidConnectorWriteText,
  resolveConnectorQueryTimeoutMs,
  type ConnectorWriteNotSentReason,
  type ConnectorWriteOutcome,
  type IssueCommentRequest,
  type IssueCommentWriter,
  type IssueTransitionOption,
  type IssueTransitionRequest,
  type IssueTransitionWriter,
} from '@quoky/core';

/**
 * Jira Cloud WRITE adapters (ADR-0112 D1/D2/D4): add a comment, and perform one approved transition. Separate classes
 * from the read-only `JiraConnectorProvider`. The Atlassian API token already permits writes, so the gate is
 * Quoky-side: only issues of allowlisted projects are written, checked before any network call. Every write is a
 * single request with a timeout and redirects refused; there is no retry. Nothing is logged, and no outcome or error
 * carries the token, a header, the payload or a response body.
 *
 * Drift (ADR-0112: the executed payload must equal the approved payload): before the write, each writer re-reads the
 * issue and refuses (`NOT_SENT('TARGET_CHANGED')`) when the approved key now resolves to a moved issue (Jira keeps an
 * old key as an alias of the moved issue, which may be outside the allowlist). The transition writer performs only the
 * approved transition id, and only while it still leads to the approved destination status id — never a name match.
 */

const ISSUE_KEY = /^([A-Z][A-Z0-9_]{0,63})-[1-9][0-9]{0,9}$/;
const NUMERIC_ID = /^[0-9]{1,20}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const NAME_MAX_LENGTH = 100;
const MAX_TRANSITIONS = 100;

export interface JiraIssueWriterConfig {
  /** Jira Cloud host, with or without an https:// prefix (the same site as the read connector). */
  readonly host: string;
  readonly email: string;
  readonly apiToken: string;
  /** Project keys whose issues may be written (`QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS`). Must not be empty. */
  readonly allowedProjects: readonly string[];
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10000). */
  readonly timeoutMs?: number;
}

/** The shared transport and allowlist of the two Jira writers. */
class JiraWriteClient {
  readonly baseUrl: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allowedProjects: ReadonlySet<string>;

  constructor(config: JiraIssueWriterConfig) {
    const host = requireNonEmpty(config?.host, 'host');
    const email = requireNonEmpty(config?.email, 'email');
    const apiToken = requireNonEmpty(config?.apiToken, 'api token');
    this.baseUrl = normalizeHost(host);
    this.authorization = `Basic ${Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64')}`;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'jira writer');
    installConnectorWriteTransportDiagnostics();
    const projects = Array.isArray(config.allowedProjects) ? config.allowedProjects : [];
    if (projects.length === 0 || projects.some((key) => typeof key !== 'string' || !PROJECT_KEY.test(key))) {
      throw new Error('jira writer: a non-empty list of valid project keys is required');
    }
    this.allowedProjects = new Set(projects);
  }

  allowsIssue(issueKey: string): boolean {
    if (typeof issueKey !== 'string') return false;
    const project = ISSUE_KEY.exec(issueKey)?.[1];
    return project !== undefined && this.allowedProjects.has(project);
  }

  issueUrl(issueKey: string, suffix = ''): URL {
    return new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}${suffix}`, this.baseUrl);
  }

  browseUrl(issueKey: string): string {
    return `${this.baseUrl}/browse/${encodeURIComponent(issueKey)}`;
  }

  /** One request. Throws only for a transport failure (the caller decides what that means). */
  async request(url: URL, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: this.authorization,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /** The read used by the transition writer and the CWR-2 preview. Throws a value-free `ConnectorQueryError`. */
  async listTransitions(issueKey: string): Promise<IssueTransitionOption[]> {
    if (!this.allowsIssue(issueKey)) {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira writer: the issue is not in an allowlisted project');
    }
    let response: Response;
    try {
      response = await this.request(this.issueUrl(issueKey, '/transitions'), 'GET');
    } catch {
      throw new ConnectorQueryError('UNAVAILABLE', 'jira writer: transitions request failed');
    }
    if (!response.ok) {
      await discardBody(response);
      throw new ConnectorQueryError(connectorQueryErrorReasonForStatus(response.status), 'jira writer: transitions request failed');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ConnectorQueryError('INVALID_RESPONSE', 'jira writer: transitions response was unexpected');
    }
    if (!isRecord(payload) || !Array.isArray(payload.transitions)) {
      throw new ConnectorQueryError('INVALID_RESPONSE', 'jira writer: transitions response was unexpected');
    }
    const options: IssueTransitionOption[] = [];
    for (const entry of payload.transitions.slice(0, MAX_TRANSITIONS)) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !NUMERIC_ID.test(entry.id)) {
        throw new ConnectorQueryError('INVALID_RESPONSE', 'jira writer: transitions response was unexpected');
      }
      const name = boundName(entry.name);
      const toStatus = isRecord(entry.to) ? boundName(entry.to.name) : '';
      const toStatusId = isRecord(entry.to) && typeof entry.to.id === 'string' && NUMERIC_ID.test(entry.to.id) ? entry.to.id : '';
      options.push({ id: entry.id, name, toStatus, toStatusId });
    }
    return options;
  }

  /**
   * The pre-write identity check: the issue still answers to exactly the approved key. A moved issue answers its old
   * key with its new one; that (and any read failure) is NOT_SENT, since nothing has been written yet. Undefined = go.
   */
  async confirmIssueKey(issueKey: string): Promise<ConnectorWriteOutcome | undefined> {
    const url = this.issueUrl(issueKey);
    url.searchParams.set('fields', 'project');
    let response: Response;
    try {
      response = await this.request(url, 'GET');
    } catch {
      return connectorWriteNotSent('UNAVAILABLE');
    }
    if (!response.ok) {
      await discardBody(response);
      return connectorWriteNotSent(precheckReason(response.status));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return connectorWriteNotSent('UNAVAILABLE');
    }
    if (!isRecord(payload) || typeof payload.key !== 'string') return connectorWriteNotSent('UNAVAILABLE');
    return payload.key === issueKey ? undefined : connectorWriteNotSent('TARGET_CHANGED');
  }
}

/** Jira comment writer (`IssueCommentWriter`): the owner's text verbatim as plain ADF paragraphs. */
export class JiraIssueCommentWriter implements IssueCommentWriter {
  readonly source = 'jira';
  private readonly client: JiraWriteClient;

  constructor(config: JiraIssueWriterConfig) {
    this.client = new JiraWriteClient(config);
  }

  allowsIssue(issueKey: string): boolean {
    return this.client.allowsIssue(issueKey);
  }

  async addComment(request: IssueCommentRequest): Promise<ConnectorWriteOutcome> {
    if (!this.client.allowsIssue(request?.issueKey)) return connectorWriteNotSent('TARGET_NOT_ALLOWED');
    if (!isValidConnectorWriteText(request.text)) return connectorWriteNotSent('INVALID_REQUEST');
    const drifted = await this.client.confirmIssueKey(request.issueKey);
    if (drifted !== undefined) return drifted;

    let response: Response;
    try {
      response = await this.client.request(this.client.issueUrl(request.issueKey, '/comment'), 'POST', {
        body: plainTextDocument(request.text),
      });
    } catch (error) {
      // NOT_SENT only when the request provably never reached Jira (UNC-1); otherwise UNCERTAIN.
      return classifyConnectorWriteTransportFailure(error);
    }
    if (!response.ok) return failedWrite(response);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return connectorWriteUncertain('INVALID_RESPONSE');
    }
    const id = isRecord(payload) ? payload.id : undefined;
    if (typeof id !== 'string' || !NUMERIC_ID.test(id)) return connectorWriteUncertain('INVALID_RESPONSE');
    return connectorWriteSent(id, `${this.client.browseUrl(request.issueKey)}?focusedCommentId=${id}`);
  }
}

/** Jira transition writer (`IssueTransitionWriter`): performs exactly the approved transition id, nothing else. */
export class JiraIssueTransitionWriter implements IssueTransitionWriter {
  readonly source = 'jira';
  private readonly client: JiraWriteClient;

  constructor(config: JiraIssueWriterConfig) {
    this.client = new JiraWriteClient(config);
  }

  allowsIssue(issueKey: string): boolean {
    return this.client.allowsIssue(issueKey);
  }

  listTransitions(issueKey: string): Promise<readonly IssueTransitionOption[]> {
    return this.client.listTransitions(issueKey);
  }

  async transition(request: IssueTransitionRequest): Promise<ConnectorWriteOutcome> {
    if (!this.client.allowsIssue(request?.issueKey)) return connectorWriteNotSent('TARGET_NOT_ALLOWED');
    if (!isNumericId(request.transitionId) || !isNumericId(request.toStatusId)) return connectorWriteNotSent('INVALID_REQUEST');
    const drifted = await this.client.confirmIssueKey(request.issueKey);
    if (drifted !== undefined) return drifted;

    let options: IssueTransitionOption[];
    try {
      options = await this.client.listTransitions(request.issueKey);
    } catch (error) {
      // The pre-check read failed: the transition itself was never sent.
      return connectorWriteNotSent(notSentReasonOf(error));
    }
    const chosen = findApprovedTransition(options, request.transitionId, request.toStatusId);
    if (chosen === undefined) return connectorWriteNotSent('TARGET_CHANGED');

    let response: Response;
    try {
      response = await this.client.request(this.client.issueUrl(request.issueKey, '/transitions'), 'POST', {
        transition: { id: chosen.id },
      });
    } catch (error) {
      // NOT_SENT only when the request provably never reached Jira (UNC-1); otherwise UNCERTAIN.
      return classifyConnectorWriteTransportFailure(error);
    }
    if (!response.ok) return failedWrite(response);
    await discardBody(response);
    return connectorWriteSent(`${request.issueKey}:${chosen.id}`, this.client.browseUrl(request.issueKey));
  }
}

/**
 * The approved transition, only if the live list still has a transition with exactly `transitionId` and it still
 * leads to exactly `toStatusId`. Ids only: a name that now means another transition or status is never followed.
 */
export function findApprovedTransition(
  options: readonly IssueTransitionOption[],
  transitionId: string,
  toStatusId: string,
): IssueTransitionOption | undefined {
  const matches = options.filter((option) => option.id === transitionId);
  if (matches.length !== 1) return undefined;
  const chosen = matches[0] as IssueTransitionOption;
  return chosen.toStatusId.length > 0 && chosen.toStatusId === toStatusId ? chosen : undefined;
}

function isNumericId(value: unknown): value is string {
  return typeof value === 'string' && NUMERIC_ID.test(value);
}

/** The owner's text verbatim as an Atlassian Document: one plain paragraph per line, no markup interpreted. */
export function plainTextDocument(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\r\n|\r|\n/).map((line) =>
    line.length === 0 ? { type: 'paragraph', content: [] } : { type: 'paragraph', content: [{ type: 'text', text: line }] },
  );
  return { type: 'doc', version: 1, content: paragraphs };
}

/** A non-2xx answer to a write: 5xx (and anything unexpected) may have been applied; a 4xx certainly was not. */
async function failedWrite(response: Response): Promise<ConnectorWriteOutcome> {
  await discardBody(response);
  const status = response.status;
  if (status >= 500 || status < 400) return connectorWriteUncertain('SERVER_ERROR');
  if (status === 401) return connectorWriteNotSent('UNAUTHORIZED');
  if (status === 403) return connectorWriteNotSent('FORBIDDEN');
  if (status === 404) return connectorWriteNotSent('NOT_FOUND');
  if (status === 429) return connectorWriteNotSent('RATE_LIMITED');
  return connectorWriteNotSent('REJECTED');
}

/** A failed pre-write read (the write never left). */
function precheckReason(status: number): ConnectorWriteNotSentReason {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'UNAVAILABLE';
}

function notSentReasonOf(error: unknown): ConnectorWriteNotSentReason {
  if (!(error instanceof ConnectorQueryError)) return 'UNAVAILABLE';
  switch (error.reason) {
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
    case 'INSUFFICIENT_SCOPE':
    case 'NOT_FOUND':
    case 'RATE_LIMITED':
      return error.reason;
    case 'UNSUPPORTED_QUERY':
      return 'TARGET_NOT_ALLOWED';
    default:
      return 'UNAVAILABLE';
  }
}

/** Untrusted names (ADR-0100 D8): control characters removed, whitespace collapsed, bounded. */
function boundName(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, NAME_MAX_LENGTH).join('');
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore: the body is never read
  }
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`jira writer: a non-empty ${label} is required`);
  }
  return value.trim();
}

function normalizeHost(host: string): string {
  const candidate = host.startsWith('https://') ? host : `https://${host}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('jira writer: host must be a valid Jira Cloud host');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('jira writer: host must be an https host without credentials, port, path, query, or fragment');
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

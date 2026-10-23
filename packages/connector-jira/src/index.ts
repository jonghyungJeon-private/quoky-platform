import {
  ConnectorQueryError,
  ConnectorQueryName,
  connectorQueryErrorReasonForStatus,
  CONNECTOR_CATALOG_MAX_ITEMS,
  CONNECTOR_CONTAINER_KEY,
  CONNECTOR_ITEM_KEY,
  CONNECTOR_ITEM_RESPONSE_MAX_BYTES,
  CONNECTOR_RELEASE_ID,
  parseItemParams,
  parseItemsByKeyParams,
  parsePersonalWorkParams,
  parseReleaseItemsParams,
  parseReleasesParams,
  resolveConnectorQueryTimeoutMs,
  toConnectorDueDate,
  toConnectorTimestamp,
  type ConnectorItem,
  type ConnectorItemDetail,
  type ConnectorItemSection,
  type ConnectorProvider,
  type ConnectorQuery,
  type ConnectorResult,
  type Metadata,
  type ParsedPersonalWorkParams,
  type ParsedReleaseItemsParams,
  type PersonalWorkSort,
  type PersonalWorkWindowField,
} from '@quoky/core';

const DESCRIPTION_LIMIT = 500;
const RAW_JSON_LIMIT = 20_000;
const STATUS_LIMIT = 100;
const SEARCH_FIELDS = 'summary,status,duedate,updated,description';
/** ADR-0120 A8: the fields of a release listing (no description: a release report shows key, summary, assignee, status). */
const RELEASE_ITEM_FIELDS = 'summary,status,assignee';
/** One page of the project / version listings; at most CONNECTOR_CATALOG_MAX_ITEMS items in all. */
const CATALOG_PAGE_SIZE = 50;
const NAME_LIMIT = 200;

export interface JiraConnectorConfig {
  /** Jira Cloud host, with or without an https:// prefix (for example, example.atlassian.net). */
  host: string;
  email: string;
  apiToken: string;
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
  /** Injectable clock (epoch ms) for the relative window boundaries; default `Date.now`. */
  now?: () => number;
  /**
   * A6 R2 owner decision D12 (default false): allow ONE bounded second GET for an `item` read (a newest-comments page
   * after a partial embedded page, or a description-only retry after an oversize response). Never more than 2 requests.
   */
  itemSecondRequest?: boolean;
}

export type JiraConnectorHttpErrorKind =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'HTTP_ERROR';

/** A sanitized Jira HTTP failure. It never contains response content, credentials, or request headers. */
export class JiraConnectorHttpError extends ConnectorQueryError {
  constructor(
    readonly kind: JiraConnectorHttpErrorKind,
    readonly status: number,
  ) {
    super(connectorQueryErrorReasonForStatus(status), `jira connector: query failed (${kind.toLowerCase()})`);
    this.name = 'JiraConnectorHttpError';
  }
}

/** A sanitized transport or timeout failure. The underlying fetch error is deliberately not retained. */
export class JiraConnectorRequestError extends ConnectorQueryError {
  constructor() {
    super('UNAVAILABLE', 'jira connector: query request failed');
    this.name = 'JiraConnectorRequestError';
  }
}

/** A sanitized response-shape failure. Raw response content is deliberately not retained. */
export class JiraConnectorResponseError extends ConnectorQueryError {
  constructor() {
    super('INVALID_RESPONSE', 'jira connector: query returned an unexpected response');
    this.name = 'JiraConnectorResponseError';
  }
}

/** A6 R2: a response over CONNECTOR_ITEM_RESPONSE_MAX_BYTES, aborted while streaming. Distinguishable by `tooLarge`. */
export class JiraConnectorItemTooLargeError extends ConnectorQueryError {
  readonly tooLarge = true;
  constructor(readonly bytes: number = CONNECTOR_ITEM_RESPONSE_MAX_BYTES) {
    // CA P3: its own neutral reason, apart from a malformed answer (INVALID_RESPONSE).
    super('TOO_LARGE', 'jira connector: item response too large');
    this.name = 'JiraConnectorItemTooLargeError';
  }
}

/** The issue key and numeric id shapes an item reference may carry (A6 R2). */
const JIRA_ITEM_REF = /^([A-Z][A-Z0-9_]{1,19}-[1-9]\d{0,9}):([1-9]\d{0,17})$/;
const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/;
const JIRA_NUMERIC_ID = /^[1-9][0-9]{0,17}$/;
const ITEM_FIELDS = 'summary,status,issuetype,description,comment,updated,assignee,reporter';
const ITEM_FIELDS_NO_COMMENT = 'summary,status,issuetype,description,updated,assignee,reporter';
const ITEM_COMMENTS_KEPT = 10;
const ATTACHMENT_PLACEHOLDER = '[첨부]';

interface JiraIssue {
  key?: unknown;
  fields?: {
    summary?: unknown;
    description?: unknown;
    status?: unknown;
    duedate?: unknown;
    updated?: unknown;
    project?: unknown;
  };
}

export class JiraConnectorProvider implements ConnectorProvider {
  readonly source = 'jira';
  readonly readOnly = true;

  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly itemSecondRequest: boolean;

  constructor(config: JiraConnectorConfig) {
    const host = requireNonEmpty(config?.host, 'host');
    const email = requireNonEmpty(config?.email, 'email');
    const apiToken = requireNonEmpty(config?.apiToken, 'api token');

    this.baseUrl = normalizeHost(host);
    this.authorization = `Basic ${Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64')}`;
    this.apiToken = apiToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'jira connector');
    this.now = config.now ?? Date.now;
    this.itemSecondRequest = config.itemSecondRequest === true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async query(input: ConnectorQuery): Promise<ConnectorResult> {
    // Named queries only: Jira never receives caller-supplied JQL (ADR-0100 D7, ADR-0120 A8).
    switch (input?.query) {
      case ConnectorQueryName.PERSONAL_WORK:
        return this.personalWork(input.params);
      case ConnectorQueryName.CONTAINERS:
        return this.containers();
      case ConnectorQueryName.RELEASES:
        return this.releases(input.params);
      case ConnectorQueryName.RELEASE_ITEMS:
        return this.releaseItems(input.params);
      case ConnectorQueryName.ITEM:
        return this.item(input.params);
      case ConnectorQueryName.ITEMS_BY_KEY:
        return this.itemsByKey(input.params);
      default:
        throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira connector: unsupported query');
    }
  }

  private async personalWork(params: Metadata | undefined): Promise<ConnectorResult> {
    const parsed = parsePersonalWorkParams(params, 'jira connector');
    // The GitHub item type (owner review 2026-10-21) has no Jira meaning: refused, never ignored.
    if (parsed.itemType !== undefined) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira connector: unsupported personal-work option');
    const { limit } = parsed;
    const url = new URL('/rest/api/3/search/jql', this.baseUrl);
    url.searchParams.set('jql', personalWorkJql(parsed, this.now()));
    url.searchParams.set('fields', SEARCH_FIELDS);
    url.searchParams.set('maxResults', String(limit));
    const payload = await this.getJson(url);
    if (!isRecord(payload) || !Array.isArray(payload.issues)) {
      throw new JiraConnectorResponseError();
    }
    const items = payload.issues.slice(0, limit).map((issue) => this.mapIssue(issue));
    return { source: this.source, items };
  }

  /**
   * ADR-0120 A8: the projects this account can see (`/rest/api/3/project/search`, read-only), as key and name only, at
   * most CONNECTOR_CATALOG_MAX_ITEMS. No owner text is sent: Core matches a project name against this list.
   */
  private async containers(): Promise<ConnectorResult> {
    const items: ConnectorItem[] = [];
    let truncated = false;
    for (let startAt = 0; ; startAt += CATALOG_PAGE_SIZE) {
      const url = new URL('/rest/api/3/project/search', this.baseUrl);
      url.searchParams.set('startAt', String(startAt));
      url.searchParams.set('maxResults', String(CATALOG_PAGE_SIZE));
      url.searchParams.set('orderBy', 'key');
      const page = pageOf(await this.getJson(url));
      for (const value of page.values) {
        if (!isRecord(value) || typeof value.key !== 'string' || !CONNECTOR_CONTAINER_KEY.test(value.key)) continue;
        const name = typeof value.name === 'string' && value.name.trim().length > 0 ? value.name : value.key;
        items.push({ id: value.key, title: this.redactToken(name).slice(0, NAME_LIMIT), container: value.key });
      }
      if (page.last || page.values.length === 0) break;
      if (items.length >= CONNECTOR_CATALOG_MAX_ITEMS || startAt + CATALOG_PAGE_SIZE >= CONNECTOR_CATALOG_MAX_ITEMS) {
        truncated = true;
        break;
      }
    }
    return { source: this.source, items: items.slice(0, CONNECTOR_CATALOG_MAX_ITEMS), ...(truncated ? { truncated } : {}) };
  }

  /**
   * ADR-0120 A8: the released and unreleased (not archived) versions of one project, newest first
   * (`/rest/api/3/project/{key}/version`, read-only), at most CONNECTOR_CATALOG_MAX_ITEMS.
   */
  private async releases(params: Metadata | undefined): Promise<ConnectorResult> {
    const { container, limit } = parseReleasesParams(params, 'jira connector');
    const items: ConnectorItem[] = [];
    let truncated = false;
    for (let startAt = 0; ; startAt += CATALOG_PAGE_SIZE) {
      const url = new URL(`/rest/api/3/project/${encodeURIComponent(container)}/version`, this.baseUrl);
      url.searchParams.set('startAt', String(startAt));
      url.searchParams.set('maxResults', String(Math.min(CATALOG_PAGE_SIZE, limit)));
      url.searchParams.set('orderBy', '-sequence');
      url.searchParams.set('status', 'released,unreleased');
      const page = pageOf(await this.getJson(url));
      for (const value of page.values) {
        if (!isRecord(value) || typeof value.id !== 'string' || !CONNECTOR_RELEASE_ID.test(value.id) || typeof value.name !== 'string') continue;
        if (value.archived === true) continue;
        const item: ConnectorItem = {
          id: value.id,
          title: this.redactToken(value.name).slice(0, NAME_LIMIT),
          status: value.released === true ? 'released' : 'unreleased',
          container,
          url: `${this.baseUrl}/projects/${encodeURIComponent(container)}/versions/${value.id}/tab/release-report-all-issues`,
        };
        const releaseDate = toConnectorDueDate(value.releaseDate);
        if (releaseDate) item.dueDate = releaseDate;
        items.push(item);
      }
      if (page.last || page.values.length === 0) break;
      if (items.length >= limit || startAt + CATALOG_PAGE_SIZE >= limit) {
        truncated = true;
        break;
      }
    }
    return { source: this.source, items: items.slice(0, limit), ...(truncated ? { truncated } : {}) };
  }

  /**
   * ADR-0120 A8: the issues of one release (fix version), any assignee unless `assignee` is set. The JQL is built from
   * a validated project key, a numeric version id or a quoted, escaped version name, and a quoted identity; nothing else.
   * A 400 whose error names the fix version (the value does not exist or is not visible to this account) is
   * `NOT_FOUND`; any other 400 is `INVALID_RESPONSE`. The error text is inspected, never kept or returned.
   */
  private async releaseItems(params: Metadata | undefined): Promise<ConnectorResult> {
    const parsed = parseReleaseItemsParams(params, 'jira connector');
    const url = new URL('/rest/api/3/search/jql', this.baseUrl);
    url.searchParams.set('jql', releaseItemsJql(parsed));
    url.searchParams.set('fields', RELEASE_ITEM_FIELDS);
    url.searchParams.set('maxResults', String(parsed.limit));
    const payload = await this.getJson(url, (status, body) =>
      status === 400 ? (namesFixVersion(body) ? new ConnectorQueryError('NOT_FOUND', 'jira connector: release not found') : new JiraConnectorResponseError()) : undefined,
    );
    if (!isRecord(payload) || !Array.isArray(payload.issues)) throw new JiraConnectorResponseError();
    const items = payload.issues.slice(0, parsed.limit).map((issue) => this.mapReleaseIssue(issue));
    const more =
      payload.issues.length > parsed.limit ||
      payload.isLast === false ||
      (typeof payload.nextPageToken === 'string' && payload.nextPageToken.length > 0);
    return { source: this.source, items, ...(more ? { truncated: true } : {}) };
  }

  /**
   * ADR-0121 S2 P3 `items-by-key` (the "same-source detail reads" implementation note): the details of up to 10 issues in
   * ONE request, `key in (…)`, built only from keys the port parser re-validated against the closed key shape and quoted
   * as JQL string literals; the order is constant. One page always holds them all (`maxResults` = the number of keys), so
   * exactly one HTTP request is made. Only issues whose key was asked for are returned (a moved issue answering under
   * another key is dropped, never substituted); an unseen key is simply absent. A 400 whose error names an issue key (a
   * key that no longer exists or is not visible) is `NOT_FOUND`; any other 400 is `INVALID_RESPONSE`. The error text is
   * inspected, never kept or returned.
   */
  private async itemsByKey(params: Metadata | undefined): Promise<ConnectorResult> {
    const { keys } = parseItemsByKeyParams(params, 'jira connector');
    const url = new URL('/rest/api/3/search/jql', this.baseUrl);
    url.searchParams.set('jql', itemsByKeyJql(keys));
    url.searchParams.set('fields', SEARCH_FIELDS);
    url.searchParams.set('maxResults', String(keys.length));
    const payload = await this.getJson(url, (status, body) =>
      status === 400 ? (namesIssueKey(body) ? new ConnectorQueryError('NOT_FOUND', 'jira connector: item not found') : new JiraConnectorResponseError()) : undefined,
    );
    if (!isRecord(payload) || !Array.isArray(payload.issues)) throw new JiraConnectorResponseError();
    const asked = new Set(keys);
    const items = payload.issues
      .filter((issue) => isRecord(issue) && typeof issue.key === 'string' && asked.has(issue.key))
      .slice(0, keys.length)
      .map((issue) => this.mapIssue(issue));
    return { source: this.source, items };
  }

  /**
   * A6 R2 `item`: ONE issue read by its opaque reference `KEY:numericId`, GET only, by the NUMERIC id (never the key).
   * One request by default; with `itemSecondRequest` (D12) at most one more, in one of two exclusive branches.
   */
  private async item(params: Metadata | undefined): Promise<ConnectorResult> {
    const parsed = parseItemParams(params, 'jira connector');
    const ref = JIRA_ITEM_REF.exec(parsed.id);
    if (!ref || parsed.scope !== 'item') {
      throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira connector: unsupported item reference');
    }
    const slotKey = ref[1]!;
    const numericId = ref[2]!;
    const issueUrl = (fields: string): URL => {
      const url = new URL(`/rest/api/3/issue/${numericId}`, this.baseUrl);
      url.searchParams.set('fields', fields);
      return url;
    };

    let requests = 1;
    let bytes = 0;
    let descriptionOnly = false;
    let payload: unknown;
    try {
      const first = await this.getItemJson(issueUrl(ITEM_FIELDS));
      payload = first.json;
      bytes += first.bytes;
    } catch (error) {
      if (!(error instanceof JiraConnectorItemTooLargeError) || !this.itemSecondRequest) throw error;
      // Branch B: request 1 aborted at the cap. One description-only retry; never a branch A after it, never a third.
      requests = 2;
      bytes += error.bytes;
      const retry = await this.getItemJson(issueUrl(ITEM_FIELDS_NO_COMMENT));
      payload = retry.json;
      bytes += retry.bytes;
      descriptionOnly = true;
    }

    if (!isRecord(payload)) throw new JiraConnectorResponseError();
    const responseId = typeof payload.id === 'number' ? String(payload.id) : payload.id;
    // The numeric id must match: another issue never stands in (a stale slot is NOT_FOUND, not a substitution).
    if (responseId !== numericId) throw new ConnectorQueryError('NOT_FOUND', 'jira connector: item not found');
    if (typeof payload.key !== 'string' || !JIRA_ISSUE_KEY.test(payload.key)) throw new JiraConnectorResponseError();
    const key = payload.key;
    const fields = isRecord(payload.fields) ? payload.fields : undefined;

    const description = this.adf(fields?.description);
    let comments: ReadonlyArray<ItemComment> = [];
    let total = 0;
    let returned = 0;
    let newest = false;
    if (!descriptionOnly) {
      const container = isRecord(fields?.comment) ? fields.comment : undefined;
      const list = Array.isArray(container?.comments) ? container.comments : [];
      returned = list.length;
      total = typeof container?.total === 'number' && Number.isInteger(container.total) && container.total >= returned ? container.total : returned;
      comments = list.slice(-ITEM_COMMENTS_KEPT).map((comment) => this.itemComment(comment));
      // Branch A (D12): the embedded page is partial, so the newest comments are missing; one bounded GET for them.
      if (this.itemSecondRequest && total > returned) {
        requests = 2;
        const url = new URL(`/rest/api/3/issue/${numericId}/comment`, this.baseUrl);
        url.searchParams.set('orderBy', '-created');
        url.searchParams.set('maxResults', String(ITEM_COMMENTS_KEPT));
        try {
          const second = await this.getItemJson(url);
          bytes += second.bytes;
          const page = validNewestComments(second.json);
          if (page !== undefined) {
            comments = page.slice().reverse().map((comment) => this.itemComment(comment));
            returned = page.length;
            if (isRecord(second.json) && typeof second.json.total === 'number' && Number.isInteger(second.json.total) && second.json.total >= page.length) {
              total = second.json.total;
            }
            newest = true;
          }
        } catch (error) {
          // Request 2 failed, was oversize or invalid: keep request 1's content (an aborted body still counts bytes).
          if (error instanceof JiraConnectorItemTooLargeError) bytes += error.bytes;
        }
      }
    }
    comments = comments.filter((comment) => comment.text.length > 0);

    const sections: ConnectorItemSection[] = [];
    const people = new OrderedSet();
    if (description.text.length > 0) {
      sections.push({ kind: 'description', text: description.text });
      description.mentions.forEach((name) => people.add(name));
    }
    for (const comment of comments) {
      const section: ConnectorItemSection = { kind: 'comment', text: comment.text };
      if (comment.author !== undefined) {
        section.author = comment.author;
        people.add(comment.author);
      }
      if (comment.at !== undefined) section.at = comment.at;
      comment.mentions.forEach((name) => people.add(name));
      sections.push(section);
    }

    // A6 R2 (D5, live test 3): the assignee and reporter are participants too. Their display names are never shown or
    // sent; Core uses them only to pseudonymise every written form of their names in the text ("혜정님에게 전달").
    for (const role of ['assignee', 'reporter'] as const) {
      const person = fields?.[role];
      if (isRecord(person) && typeof person.displayName === 'string' && person.displayName.trim().length > 0) people.add(this.redactToken(person.displayName.trim()));
    }

    const kept = comments.length;
    const detail: ConnectorItemDetail = {
      sections,
      // Codex P2: comments dropped here (older than the last ITEM_COMMENTS_KEPT of the page) make the read partial too.
      partial: descriptionOnly || total > returned || kept < returned,
      people: people.values(),
      requests,
      bytes,
    };
    if (!descriptionOnly) detail.comments = { total, returned, kept, ...(newest ? { newest: true } : {}) };
    if (descriptionOnly) detail.descriptionOnly = true;
    if (key !== slotKey) detail.movedTo = key;

    const rawTitle = typeof fields?.summary === 'string' && fields.summary.trim().length > 0 ? fields.summary : key;
    const item: ConnectorItem = {
      id: key,
      title: this.redactToken(rawTitle).slice(0, NAME_LIMIT),
      url: `${this.baseUrl}/browse/${encodeURIComponent(key)}`,
      itemRef: parsed.id,
      detail,
    };
    const status = isRecord(fields?.status) && typeof fields.status.name === 'string' ? this.redactToken(fields.status.name.trim()) : '';
    if (status.length > 0) item.status = status.slice(0, STATUS_LIMIT);
    const updatedAt = toConnectorTimestamp(fields?.updated);
    if (updatedAt) item.updatedAt = updatedAt;
    return { source: this.source, items: [item] };
  }

  private adf(value: unknown): { text: string; mentions: string[] } {
    const flat = adfText(value);
    return { text: this.redactToken(flat.text), mentions: flat.mentions.map((name) => this.redactToken(name)) };
  }

  private itemComment(value: unknown): ItemComment {
    const record = isRecord(value) ? value : {};
    const flat = this.adf(record.body);
    const name = isRecord(record.author) && typeof record.author.displayName === 'string' ? this.redactToken(record.author.displayName.trim()) : '';
    const at = toConnectorTimestamp(record.created);
    return { text: flat.text, mentions: flat.mentions, ...(name.length > 0 ? { author: name } : {}), ...(at !== undefined ? { at } : {}) };
  }

  /**
   * GET one item document. The egress guard of this runtime does not enforce `redirect: 'error'`, so the adapter sets
   * `redirect: 'manual'` itself and maps any 3xx (or an opaque redirect) to `MOVED`: nothing is ever followed. The body
   * is read as a stream and counted; above CONNECTOR_ITEM_RESPONSE_MAX_BYTES the reader is cancelled.
   */
  private async getItemJson(url: URL): Promise<{ json: unknown; bytes: number }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: this.authorization },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
      });
    } catch {
      throw new JiraConnectorRequestError();
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399)) {
      void response.body?.cancel().catch(() => undefined);
      throw new ConnectorQueryError('MOVED', 'jira connector: item moved');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw mapHttpError(response.status);
    }
    const { text, bytes } = await readCappedText(response);
    try {
      return { json: JSON.parse(text) as unknown, bytes };
    } catch {
      throw new JiraConnectorResponseError();
    }
  }

  /**
   * GET one JSON document. `onError` may map a failed status (and its parsed error body, read only then) to a specific
   * error; otherwise the status maps as usual. The body is never retained.
   */
  private async getJson(url: URL, onError?: (status: number, body: unknown) => Error | undefined): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new JiraConnectorRequestError();
    }

    if (!response.ok) {
      if (onError !== undefined) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        const mapped = onError(response.status, body);
        if (mapped !== undefined) throw mapped;
      }
      throw mapHttpError(response.status);
    }

    try {
      return await response.json();
    } catch {
      throw new JiraConnectorResponseError();
    }
  }

  private mapReleaseIssue(value: unknown): ConnectorItem {
    if (!isRecord(value) || typeof value.key !== 'string' || value.key.trim().length === 0) {
      throw new JiraConnectorResponseError();
    }
    const key = value.key;
    const fields = isRecord(value.fields) ? value.fields : undefined;
    const rawTitle = typeof fields?.summary === 'string' && fields.summary.trim().length > 0 ? fields.summary : key;
    const item: ConnectorItem = {
      id: key,
      title: this.redactToken(rawTitle),
      url: `${this.baseUrl}/browse/${encodeURIComponent(key)}`,
    };
    const status = isRecord(fields?.status) ? fields.status : undefined;
    if (status !== undefined && typeof status.name === 'string' && status.name.trim().length > 0) {
      item.status = this.redactToken(status.name.trim()).slice(0, STATUS_LIMIT);
    }
    const category = isRecord(status?.statusCategory) ? status.statusCategory.key : undefined;
    const group = typeof category === 'string' ? STATUS_CATEGORY_GROUP[category] : undefined;
    if (group !== undefined) item.statusCategory = group;
    const assignee = isRecord(fields?.assignee) && typeof fields.assignee.displayName === 'string' ? fields.assignee.displayName.trim() : '';
    if (assignee.length > 0) item.assignee = this.redactToken(assignee).slice(0, NAME_LIMIT);
    const container = projectKey(key, undefined);
    if (container) item.container = container;
    const itemRef = jiraItemRef(key, value.id);
    if (itemRef) item.itemRef = itemRef;
    return item;
  }

  private mapIssue(value: unknown): ConnectorItem {
    if (!isRecord(value) || typeof value.key !== 'string' || value.key.trim().length === 0) {
      throw new JiraConnectorResponseError();
    }

    const issue = value as JiraIssue;
    const key = issue.key as string;
    const fields = isRecord(issue.fields) ? issue.fields : undefined;
    const rawTitle = typeof fields?.summary === 'string' && fields.summary.trim().length > 0 ? fields.summary : key;
    const title = this.redactToken(rawTitle);
    const description = this.redactToken(extractDescription(fields?.description));
    const item: ConnectorItem = {
      id: key,
      title,
      url: `${this.baseUrl}/browse/${encodeURIComponent(key)}`,
      raw: this.serializeRaw(value),
    };
    if (description.length > 0) item.summary = description.slice(0, DESCRIPTION_LIMIT);

    const status = isRecord(fields?.status) && typeof fields.status.name === 'string'
      ? this.redactToken(fields.status.name.trim())
      : '';
    if (status.length > 0) item.status = status.slice(0, STATUS_LIMIT);
    const dueDate = toConnectorDueDate(fields?.duedate);
    if (dueDate) item.dueDate = dueDate;
    const updatedAt = toConnectorTimestamp(fields?.updated);
    if (updatedAt) item.updatedAt = updatedAt;
    const container = projectKey(key, fields?.project);
    if (container) item.container = container;
    const itemRef = jiraItemRef(key, value.id);
    if (itemRef) item.itemRef = itemRef;
    return item;
  }

  private serializeRaw(issue: unknown): Metadata {
    let json: string;
    try {
      json = JSON.stringify(issue) ?? '{}';
    } catch {
      json = '{}';
    }
    json = this.redactToken(json);
    if (json.length > RAW_JSON_LIMIT) json = `${json.slice(0, RAW_JSON_LIMIT)}[truncated]`;
    return { json };
  }

  private redactToken(value: string): string {
    return value.split(this.apiToken).join('[redacted]');
  }
}

/**
 * The adapter owns JQL rendering and escaping; the identity is always a quoted, escaped string literal. Open work is
 * `resolution = Unresolved AND statusCategory != Done`: some workflows move an issue to a done-category status
 * (e.g. "완료"/"취소") without setting a resolution, and those must not appear as open items (live QA, 50 of 193).
 */
function personalWorkJql(params: ParsedPersonalWorkParams, nowMs: number): string {
  const { actorExternalId: identity, filter, window, role, status, sort } = params;
  const literal = jqlString(identity);
  // ADR-0120 D13: without window/role/status this is byte-identical to the ADR-0100 query.
  const who = role === 'reporter' ? `reporter = ${literal}` : role === 'either' ? `(assignee = ${literal} OR reporter = ${literal})` : `assignee = ${literal}`;
  // `in-progress` is the status category `indeterminate` (the locale-independent key of "In Progress"; a closed literal, never owner text); it excludes done work itself.
  const open =
    status === 'all' ? '' : status === 'in-progress' ? ' AND statusCategory = indeterminate' : ' AND resolution = Unresolved AND statusCategory != Done';
  const base = `${who}${open}`;
  if (window !== undefined) {
    if (filter !== 'all') throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira connector: a window needs the all filter');
    const field = JQL_WINDOW_FIELD[window.field];
    const order = sort !== undefined ? JQL_SORT_ORDER[sort] : window.field === 'due' ? 'duedate ASC' : `${field} DESC`;
    // JQL reads a date literal in the Jira user's profile time zone, which need not be QUOKY_TIMEZONE. A timestamp field
    // (created, updated) is therefore bounded by minutes relative to now, which no zone shifts. The due date is a
    // calendar date without a zone: the owner's local dates are exact for it.
    const [from, to] =
      window.field !== 'due' && window.fromInstant !== undefined && window.toInstant !== undefined
        ? [relativeMinutes(window.fromInstant, nowMs, 'from'), relativeMinutes(window.toInstant, nowMs, 'to')]
        : [window.from, window.to];
    return `${base} AND ${field} >= ${jqlString(from)} AND ${field} < ${jqlString(to)} ORDER BY ${order}`;
  }
  if (filter === 'all') return `${base} ORDER BY ${sort !== undefined ? JQL_SORT_ORDER[sort] : 'updated DESC'}`;
  if (filter === 'due-this-week') return `${base} AND duedate <= endOfWeek() ORDER BY ${sort !== undefined ? JQL_SORT_ORDER[sort] : 'duedate ASC'}`;
  throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira connector: unsupported personal-work filter');
}

/**
 * A JQL relative date ("-1440m", "30m") for `instant` seen from `nowMs`. Rounded so the window never shrinks: a lower
 * bound moves at most one minute earlier, an upper bound at most one minute later.
 */
function relativeMinutes(instant: string, nowMs: number, bound: 'from' | 'to'): string {
  const deltaMinutes = (Date.parse(instant) - nowMs) / 60_000;
  const minutes = bound === 'from' ? Math.floor(deltaMinutes) : Math.ceil(deltaMinutes);
  return minutes < 0 ? `-${-minutes}m` : `${minutes}m`;
}

/**
 * ADR-0120 A8: the JQL of a release listing. Every value is either a closed shape re-validated by the port parser (a
 * project key, a numeric version id) or a quoted, escaped string literal (a version name, an identity); owner text never
 * reaches JQL unquoted. The order is constant.
 */
export function releaseItemsJql(params: ParsedReleaseItemsParams): string {
  const parts: string[] = [];
  if (params.container !== undefined) {
    if (!CONNECTOR_CONTAINER_KEY.test(params.container)) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira connector: invalid container key');
    parts.push(`project = ${jqlString(params.container)}`);
  }
  if ('id' in params.release) {
    if (!CONNECTOR_RELEASE_ID.test(params.release.id)) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira connector: invalid release id');
    parts.push(`fixVersion = ${params.release.id}`);
  } else {
    parts.push(`fixVersion = ${jqlString(params.release.name)}`);
  }
  if (params.assignee !== undefined) parts.push(`assignee = ${jqlString(params.assignee)}`);
  return `${parts.join(' AND ')} ORDER BY key ASC`;
}

/**
 * ADR-0121 S2 P3: the JQL of a bulk detail read. Every key is re-validated against the closed item-key shape and quoted
 * as a string literal; owner text never reaches it. The order is constant.
 */
export function itemsByKeyJql(keys: readonly string[]): string {
  if (keys.length === 0 || !keys.every((key) => CONNECTOR_ITEM_KEY.test(key))) throw new ConnectorQueryError('UNSUPPORTED_QUERY', 'jira connector: invalid item keys');
  return `key in (${keys.map((key) => jqlString(key)).join(', ')}) ORDER BY key ASC`;
}

/** Whether a Jira 400 error body is about an issue key value (`errorMessages` / `errors` naming the key or issue). */
function namesIssueKey(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const messages = Array.isArray(body.errorMessages) ? body.errorMessages.filter((value): value is string => typeof value === 'string') : [];
  const errors = isRecord(body.errors) ? Object.entries(body.errors).flatMap(([key, value]) => [key, typeof value === 'string' ? value : '']) : [];
  return [...messages, ...errors].some((text) => /\b(?:issue\s*)?key\b|\bissue\b/i.test(text));
}

/** Jira's status category keys as the neutral groups (a closed lookup, own properties only). */
const STATUS_CATEGORY_GROUP: Readonly<Record<string, 'todo' | 'in-progress' | 'done'>> = Object.assign(Object.create(null) as Record<string, 'todo' | 'in-progress' | 'done'>, {
  new: 'todo',
  indeterminate: 'in-progress',
  done: 'done',
});

/** Whether a Jira 400 error body is about the fix version value (`errorMessages` / `errors` naming fixVersion). */
function namesFixVersion(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const messages = Array.isArray(body.errorMessages) ? body.errorMessages.filter((value): value is string => typeof value === 'string') : [];
  const errors = isRecord(body.errors) ? Object.entries(body.errors).flatMap(([key, value]) => [key, typeof value === 'string' ? value : '']) : [];
  return [...messages, ...errors].some((text) => /fix\s*version/i.test(text));
}

/** One page of a Jira paginated listing (`values`, `isLast`); anything else is an unexpected response. */
function pageOf(payload: unknown): { readonly values: readonly unknown[]; readonly last: boolean } {
  if (!isRecord(payload) || !Array.isArray(payload.values)) throw new JiraConnectorResponseError();
  return { values: payload.values, last: payload.isLast !== false };
}

/** The closed sort names as constant ORDER BY clauses (live UAT R8): owner text is never interpolated into them. */
const JQL_SORT_ORDER: Readonly<Record<PersonalWorkSort, string>> = {
  oldest: 'created ASC',
  newest: 'created DESC',
  'recently-updated': 'updated DESC',
};

/** The closed window fields as JQL field names (Core never sends JQL). */
const JQL_WINDOW_FIELD: Readonly<Record<PersonalWorkWindowField, string>> = {
  created: 'created',
  updated: 'updated',
  due: 'duedate',
};

/** A quoted, escaped JQL string literal. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function projectKey(issueKey: string, project: unknown): string | undefined {
  const fromKey = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(issueKey)?.[1];
  if (fromKey) return fromKey;
  return isRecord(project) && typeof project.key === 'string' && project.key.trim().length > 0
    ? project.key.trim()
    : undefined;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`jira connector: a non-empty ${label} is required`);
  }
  return value.trim();
}

function normalizeHost(host: string): string {
  const candidate = host.startsWith('https://') ? host : `https://${host}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('jira connector: host must be a valid Jira Cloud host');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('jira connector: host must be an https host without credentials, port, path, query, or fragment');
  }
  return url.origin;
}

function mapHttpError(status: number): JiraConnectorHttpError {
  if (status === 401) return new JiraConnectorHttpError('UNAUTHORIZED', status);
  if (status === 403) return new JiraConnectorHttpError('FORBIDDEN', status);
  if (status === 404) return new JiraConnectorHttpError('NOT_FOUND', status);
  if (status === 429) return new JiraConnectorHttpError('RATE_LIMITED', status);
  if (status >= 500) return new JiraConnectorHttpError('SERVER_ERROR', status);
  return new JiraConnectorHttpError('HTTP_ERROR', status);
}

function extractDescription(value: unknown): string {
  if (typeof value === 'string') return value;
  const parts: string[] = [];
  collectText(value, parts);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function collectText(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectText(child, parts);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.text === 'string') parts.push(value.text);
  if (Array.isArray(value.content)) collectText(value.content, parts);
}

interface ItemComment {
  readonly text: string;
  readonly mentions: string[];
  readonly author?: string;
  readonly at?: string;
}

class OrderedSet {
  private readonly seen = new Set<string>();
  add(value: string): void {
    if (value.length > 0) this.seen.add(value);
  }
  values(): string[] {
    return [...this.seen];
  }
}

/** `KEY:numericId` when both the key and the response's string numeric id have the closed shapes; else undefined. */
function jiraItemRef(key: string, id: unknown): string | undefined {
  return typeof id === 'string' && JIRA_NUMERIC_ID.test(id) && JIRA_ISSUE_KEY.test(key) ? `${key}:${id}` : undefined;
}

/**
 * The /comment page of D12 branch A, or undefined when it fails validation: an object with an array `comments`,
 * `startAt === 0`, `comments.length <= maxResults <= 10`, each comment with a string `id` and `created`, and `created`
 * strictly non-increasing (descending, as requested).
 */
function validNewestComments(payload: unknown): unknown[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.comments) || payload.startAt !== 0) return undefined;
  const max = payload.maxResults;
  if (typeof max !== 'number' || !Number.isInteger(max) || max > ITEM_COMMENTS_KEPT || payload.comments.length > max) return undefined;
  let previous = Number.POSITIVE_INFINITY;
  for (const comment of payload.comments) {
    if (!isRecord(comment) || typeof comment.id !== 'string' || typeof comment.created !== 'string') return undefined;
    const created = Date.parse(comment.created);
    if (!Number.isFinite(created) || created > previous) return undefined;
    previous = created;
  }
  return payload.comments;
}

/** Reads a response body as a stream, counting bytes; above the item cap the reader is cancelled. */
async function readCappedText(response: Response): Promise<{ text: string; bytes: number }> {
  const max = CONNECTOR_ITEM_RESPONSE_MAX_BYTES;
  const reader = response.body?.getReader();
  if (reader === undefined) {
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch {
      throw new JiraConnectorRequestError();
    }
    if (buffer.byteLength > max) throw new JiraConnectorItemTooLargeError(buffer.byteLength);
    return { text: decodeUtf8(new Uint8Array(buffer)), bytes: buffer.byteLength };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    let result: { done: boolean; value?: Uint8Array };
    try {
      result = await reader.read();
    } catch {
      throw new JiraConnectorRequestError();
    }
    if (result.done) break;
    const value = result.value ?? new Uint8Array(0);
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => undefined);
      throw new JiraConnectorItemTooLargeError(bytes);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: decodeUtf8(all), bytes };
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new JiraConnectorResponseError();
  }
}

const ADF_BLOCK_NODES = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'tableRow']);

/**
 * A6 R2: flattens an ADF tree to plain text for a readout. Unlike the listing's `extractDescription`, every node is
 * included, hidden or collapsed ones (`expand`, `nestedExpand`, `panel`) too, because the readout is untrusted text.
 * `mentions` lists the mentioned names in order of appearance.
 */
export function adfText(value: unknown): { text: string; mentions: string[] } {
  if (typeof value === 'string') return { text: value.replace(/\n{3,}/g, '\n\n').trim(), mentions: [] };
  const mentions: string[] = [];
  const text = adfNodeText(value, mentions).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, mentions };
}

function adfNodeText(node: unknown, mentions: string[]): string {
  if (Array.isArray(node)) return node.map((child) => adfNodeText(child, mentions)).join('');
  if (!isRecord(node)) return '';
  const attrs = isRecord(node.attrs) ? node.attrs : {};
  switch (node.type) {
    case 'mention': {
      const text = typeof attrs.text === 'string' ? attrs.text.trim().replace(/^@/, '') : '';
      const name = text.length > 0 ? text : typeof attrs.id === 'string' ? attrs.id.trim() : '';
      if (name.length === 0) return '';
      mentions.push(name);
      return `@${name}`;
    }
    case 'inlineCard':
    case 'blockCard':
      return typeof attrs.url === 'string' ? attrs.url : '';
    case 'status':
      return typeof attrs.text === 'string' ? attrs.text : '';
    case 'emoji':
      return typeof attrs.shortName === 'string' ? attrs.shortName : '';
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
    case 'mediaInline':
      return ATTACHMENT_PLACEHOLDER;
    case 'hardBreak':
      return '\n';
    default:
      break;
  }
  let out = typeof node.text === 'string' ? node.text : '';
  if (Array.isArray(node.content)) out += adfNodeText(node.content, mentions);
  return typeof node.type === 'string' && ADF_BLOCK_NODES.has(node.type) ? `${out}\n` : out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ADR-0112 D2 (CWR-1): the separate, allowlisted write adapters. The read-only provider above is unchanged.
export {
  JiraIssueCommentWriter,
  JiraIssueTransitionWriter,
  findApprovedTransition,
  plainTextDocument,
  type JiraIssueWriterConfig,
} from './jira-issue-writer';

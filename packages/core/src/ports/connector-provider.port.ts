import type { Metadata } from '../domain';

export interface ConnectorQuery {
  /** A provider-neutral query NAME (see connector-query.ts), never a vendor query string (ADR-0100 D7). */
  query: string;
  params?: Metadata;
}

export interface ConnectorItem {
  id: string;
  title: string;
  url?: string;
  summary?: string;
  /** Provider-neutral status label (for example "In Progress", "open", "draft"). Optional (ADR-0100 D7). */
  status?: string;
  /** Due date as YYYY-MM-DD, when the source exposes one. */
  dueDate?: string;
  /** Last update as an ISO-8601 timestamp. */
  updatedAt?: string;
  /** Owning container (Jira project key, GitHub owner/repo, Slack #channel, Confluence space title). */
  container?: string;
  /** ADR-0120 amendment A8: the assignee's display name (`release-items`); absent when unassigned or not exposed. */
  assignee?: string;
  /**
   * ADR-0120 amendment A8: the provider-neutral status group of a work item (`release-items` only): to do, in progress
   * or done. Absent when the source does not say. (A `releases` item carries `released` / `unreleased` in `status`.)
   */
  statusCategory?: 'todo' | 'in-progress' | 'done';
  /**
   * ADR-0120 amendment A6 R2: the opaque single-item reference the `item` query accepts for this listed item (Jira
   * `KEY:numericId`, Slack `channelId:ts` or `channelId:ts:threadTs` for a thread reply). Structural and content-free;
   * Core stores it in the listing slot and never shows it or sends it to a model.
   */
  itemRef?: string;
  /** ADR-0120 amendment A6 R2: the text of ONE item read by the `item` query (absent on every listing). */
  detail?: ConnectorItemDetail;
  raw?: Metadata;
}

/**
 * A6 R2: one text section of an item, in reading order. `kind` and `author` are structural; Core titles every section
 * with its own copy ("설명", "댓글 3"), never with content. `author` is an opaque person handle (a display name for Jira, a
 * user id for Slack) that Core pseudonymises before any model sees the text (owner decision D5).
 */
export interface ConnectorItemSection {
  kind: 'description' | 'comment' | 'message';
  author?: string;
  text: string;
  /** ISO-8601, when the source gives one. */
  at?: string;
}

/** A6 R2: the item read by `item`, with what was left out stated as counts (never guessed). */
export interface ConnectorItemDetail {
  sections: ConnectorItemSection[];
  /** True when the source holds more than was read (a partial comment page, `has_more`, a description-only retry). */
  partial: boolean;
  /**
   * Every person handle that appears as an author or a mention, in order of first appearance, then the item's assignee and
   * reporter (Jira) (Core pseudonymises every written form of each one in `summary` mode). Never shown as a list.
   */
  people: string[];
  /** Jira: the comment container's `total` and how many comments the readout holds from the returned page. */
  comments?: { total: number; returned: number; kept: number; newest?: boolean };
  /** Slack top-level message: its `reply_count` (0 when none). */
  replyCount?: number;
  /** Slack thread: the page was cut (`has_more`). */
  hasMore?: boolean;
  /** Jira validated move (same numeric id, another key): the current key. */
  movedTo?: string;
  /** Slack: the message was deleted (`tombstone`). */
  deleted?: boolean;
  /** D12 branch B: comments were skipped after an oversize response. */
  descriptionOnly?: boolean;
  /** How many connector requests this read made (1, or 2 with D12), counting an aborted one. */
  requests: number;
  /** The response bytes read (for the content-free audit bucket). */
  bytes: number;
}

export interface ConnectorResult {
  source: string;
  items: ConnectorItem[];
  /** ADR-0120 amendment A8: true when the source has more items than were returned (the list is partial). */
  truncated?: boolean;
}

/**
 * PORT: external systems (Jira / Slack / Confluence).
 *
 * ADR-0072 ratifies ConnectorProvider as the canonical v1 READ-ONLY connector
 * boundary. Concrete Jira, Slack, and Confluence adapters live in separate
 * packages and are registered by the composition root only when their required
 * configuration is complete. Write methods are intentionally absent from this
 * interface; any future write seam remains approval-gated and never auto-invoked.
 */
export interface ConnectorProvider {
  /** e.g. "jira" | "slack" | "confluence". */
  readonly source: string;
  /** v1: always true. Write support is a deliberate later decision. */
  readonly readOnly: boolean;

  isAvailable(): Promise<boolean>;
  query(query: ConnectorQuery): Promise<ConnectorResult>;
}

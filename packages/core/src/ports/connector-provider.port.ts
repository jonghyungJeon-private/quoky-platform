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
  raw?: Metadata;
}

export interface ConnectorResult {
  source: string;
  items: ConnectorItem[];
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

/**
 * OPS-1 view model (ADR-0113 D5/D8): the only data `http/*` ever renders.
 *
 * `snapshot/*` builds it and runs the ADR-0097 strict credential guard over every string it puts in; `http/*` only
 * escapes and lays it out. The shape is deliberately generic (panels of label/value fields and small tables) so the
 * renderer has no knowledge of reminders, approvals or providers, and so one pass can guard every string.
 *
 * This file is part of `http/*`: it imports nothing.
 */

export type OpsPanelState = 'OK' | 'UNAVAILABLE';

export interface OpsField {
  readonly label: string;
  readonly value: string;
}

/**
 * OPS-2: a same-origin link (a GET that changes nothing, e.g. to a confirmation page). The renderer drops any `href`
 * that is not a local absolute path.
 */
export interface OpsLink {
  readonly label: string;
  readonly href: string;
}

export interface OpsTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Shown instead of the table when `rows` is empty. */
  readonly emptyText: string;
  /** OPS-2: one optional action link per row (same order as `rows`), rendered as a last column. */
  readonly rowLinks?: readonly (OpsLink | null)[];
}

export interface OpsPanelView {
  /** Stable slug (`runtime`, `providers`, ...); used as the section id. */
  readonly id: string;
  readonly title: string;
  readonly state: OpsPanelState;
  /** With `UNAVAILABLE`: an error code (never exception text). */
  readonly errorCode?: string;
  readonly fields: readonly OpsField[];
  readonly table?: OpsTable;
  readonly notes: readonly string[];
  /** OPS-2: panel-level links (e.g. to the memory handling page). */
  readonly links?: readonly OpsLink[];
}

export interface OpsViewModel {
  readonly generatedAt: string;
  readonly panels: readonly OpsPanelView[];
}

/** Where the view model comes from; `http/*` calls it once per dashboard request. */
export type OpsViewModelSource = () => Promise<OpsViewModel>;

/** Minimal event log seam for `http/*` (events and codes only; never a token, cookie or request body). */
export interface OpsUiEventLog {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

/**
 * OPS-2 / OPS-2b (ADR-0113 D7): owner handling — reminder cancel and memory forget (OPS-2), approve and reject (OPS-2b).
 *
 * `http/*` owns the request side (session, Origin, CSRF, the one-time action nonce, double-submit); the
 * implementation lives outside `http/*` and calls the same Core application services as chat, with the owner Actor,
 * and guards every string it returns. Every method resolves (never rejects) with fixed, guarded copy.
 */
export interface OpsActionOutcome {
  /** A stable outcome code (`CANCELED`, `NOT_FOUND`, `FORGOTTEN`, `ACTIONS_DISABLED`, ...). */
  readonly code: string;
  /** Fixed owner copy for the outcome; never a reply body. */
  readonly message: string;
  /** True when the requested change happened. */
  readonly ok: boolean;
}

export type OpsReminderCancelPreview =
  | {
      readonly status: 'FOUND';
      readonly displayNo: number;
      /** The reminder label exactly as `알림 목록` shows it (guarded). */
      readonly label: string;
      readonly nextAt: string;
    }
  | { readonly status: 'REFUSED'; readonly outcome: OpsActionOutcome };

export interface OpsMemoryRow {
  readonly number: number;
  /** The `기억 목록` preview (ADR-0106 D3: 120 characters, credential-guarded). */
  readonly preview: string;
}

export type OpsMemoryList =
  | { readonly status: 'OK'; readonly rows: readonly OpsMemoryRow[]; readonly total: number }
  | { readonly status: 'REFUSED'; readonly outcome: OpsActionOutcome };

export type OpsForgetRequest =
  | {
      readonly status: 'CONFIRMATION';
      readonly number: number;
      /** The chat confirmation preview (guarded). */
      readonly preview: string;
      /** The ADR-0106 D4 one-time code chat shows; the owner types it back to confirm. */
      readonly code: string;
    }
  | { readonly status: 'REFUSED'; readonly outcome: OpsActionOutcome };

/**
 * OPS-2b: what the approve/reject confirmation page shows for one pending approval — metadata only (ADR-0113 D5): never
 * the preview, payload, reason, reply text or the confirmation reference.
 */
export type OpsApprovalPreview =
  | {
      readonly status: 'FOUND';
      readonly approvalId: string;
      readonly shortId: string;
      /** A fixed label for the approval kind (커밋, 푸시, PR, ...). */
      readonly kindLabel: string;
      readonly riskLevel: string;
      readonly createdAt: string;
      readonly expiresAt: string;
      /** Whether the UI may approve it (the UI may always reject it). */
      readonly approvable: boolean;
      /** Where the chat preview was shown (`DM` or `채널`). */
      readonly chatPlace: string;
      /** A link back to the originating chat conversation, when the platform has one (ids only). */
      readonly chatLink?: string;
    }
  | { readonly status: 'REFUSED'; readonly outcome: OpsActionOutcome };

export type OpsApprovalDecision = 'approve' | 'reject';

export interface OpsActions {
  /** Read-only: what a cancel confirmation page shows for `알림 N`. */
  reminderCancelPreview(displayNo: number): Promise<OpsReminderCancelPreview>;
  /** The chat `알림 N 취소` path (typed entry). */
  cancelReminder(displayNo: number): Promise<OpsActionOutcome>;
  /** Read-only: the owner's `기억 목록` previews. */
  listMemories(): Promise<OpsMemoryList>;
  /** The chat `기억 N 잊어줘` path: issues the content-bound one-time code. */
  requestForget(number: number): Promise<OpsForgetRequest>;
  /** The chat `기억 확인 <code>` path, restricted to a pending forget code. */
  confirmForget(code: string): Promise<OpsActionOutcome>;
  /** OPS-2b, read-only: the confirmation page facts for one pending approval. Absent = no approval handling. */
  approvalPreview?(approvalId: string): Promise<OpsApprovalPreview>;
  /**
   * OPS-2b: the shared approval decision path (the same one chat runs), as the owner. Approve needs the chat preview's
   * confirmation reference; it records the approval only. The outcome is a category and fixed copy, never the reply.
   */
  decideApproval?(approvalId: string, decision: OpsApprovalDecision, reference: string): Promise<OpsActionOutcome>;
}

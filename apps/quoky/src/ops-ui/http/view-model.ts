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
 * OPS-2 (ADR-0113 D7): owner handling — reminder cancel and memory forget only (approve and reject are OPS-2b, W6).
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
}

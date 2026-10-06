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

export interface OpsTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Shown instead of the table when `rows` is empty. */
  readonly emptyText: string;
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

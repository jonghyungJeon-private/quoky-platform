import type { NlResolvedRange } from './symbolic-time';

/**
 * The closed capability catalog of natural-language selection (ADR-0120 D1). Entries are defined once, in
 * `wave1-entries.ts`, and contributed to a turn by the handler that owns them (`ConversationTurnHandler.catalog`), only
 * while their source is registered and configured. Adding, removing or widening an entry needs an amendment of ADR-0120
 * plus corpus cases (`golden/nl-intent.v1.json`).
 *
 * Nothing here is a provider or platform name: an entry carries a closed id, its risk, its DM-only flag, a typed argument
 * schema checked by hand-written validators, and bounded KO/EN description lines the selection prompt shows.
 */

/** The wave-1 entry ids (ADR-0120 D1): reads only. */
export const NL_CATALOG_ENTRY_IDS = [
  'jira.issues',
  'github.items',
  'slack.search',
  'confluence.search',
  'calendar.events',
  'mail.list',
  'drive.files',
  'todo.list',
  'reminder.list',
  'brief.today',
  'help.topic',
] as const;
export type NlCatalogEntryId = (typeof NL_CATALOG_ENTRY_IDS)[number];

export function isNlCatalogEntryId(value: unknown): value is NlCatalogEntryId {
  return typeof value === 'string' && (NL_CATALOG_ENTRY_IDS as readonly string[]).includes(value);
}

/** ADR-0120 D1/D5: wave 1 offers `READ` entries only. */
export type NlCatalogRisk = 'READ' | 'LOCAL_WRITE' | 'EXTERNAL_WRITE';

/**
 * One argument of an entry:
 *  - `enum`: one of `values`;
 *  - `keyword`: owner text, 1..100 characters, grounded verbatim in the owner's non-quoted text (ADR-0120 D4 step 5);
 *  - `range`: a symbolic period (`symbolic-time.ts`), at most 31 days;
 *  - `flag`: a boolean;
 *  - `limit`: an integer 1..10 (ADR-0120 D4 step 3).
 */
export type NlArgKind = 'enum' | 'keyword' | 'range' | 'flag' | 'limit';

export interface NlArgSpec {
  readonly name: string;
  readonly kind: NlArgKind;
  readonly values?: readonly string[];
  /** `range` only: whether `upcoming` (from now to the lookahead end) is accepted; every other symbol always is. */
  readonly allowUpcoming?: boolean;
  readonly required?: boolean;
  /** The value the entry uses when the argument is absent; canonical args omit an argument equal to it. */
  readonly default?: string | boolean;
  /** One provider-facing line (English, bounded). */
  readonly description: string;
}

/** A canonical argument value. A resolved range is carried beside the args, never inside them. */
export type NlArgValue = string | number | boolean;
export type NlArgs = Readonly<Record<string, NlArgValue>>;

export interface NlText {
  readonly ko: string;
  readonly en: string;
}

/** One closed value of an interpretation question (ADR-0120 D7). */
export interface NlAmbiguityValue {
  readonly value: string;
  readonly label: NlText;
  /** Words that pick this value in a reply to the question ("담당", "보고"); compared after normalization. */
  readonly aliases: readonly string[];
}

/**
 * An interpretation preference key (ADR-0120 D7, e.g. `jira.created-scope`): when `openWhen(args)` holds and the owner
 * did not state `arg`, the answer depends on the owner's interpretation, which is asked once and then kept per actor.
 */
export interface NlAmbiguityKey {
  readonly key: string;
  readonly arg: string;
  readonly values: readonly NlAmbiguityValue[];
  readonly question: NlText;
  openWhen(args: NlArgs): boolean;
}

export interface NlCatalogEntry {
  readonly id: NlCatalogEntryId;
  readonly risk: NlCatalogRisk;
  /** The owning handler enforces it (ADR-0120 D4 step 2): outside a DM the handler answers that it is DM-only. */
  readonly dmOnly: boolean;
  /** Clarification option text ("Jira 이슈 조회"). */
  readonly label: NlText;
  /** Words that pick this entry in a reply to a clarification ("지라", "jira"); compared after normalization. */
  readonly aliases: readonly string[];
  /** One line each, shown to the selector (bounded by the prompt builder). */
  readonly description: NlText;
  readonly args: readonly NlArgSpec[];
  readonly ambiguity?: readonly NlAmbiguityKey[];
  /** An exact command the owner can send instead (clarification fallback, honest-chat fact). */
  readonly usage: NlText;
  /**
   * The names the owner and a chat reply use for this entry's external source ("jira", "캘린더"); the honest-chat guard
   * (ADR-0120 D9) recognizes a false "cannot access" claim about the source by them. Absent for Quoky's own data.
   */
  readonly sourceNames?: readonly string[];
  /** Entry-specific normalization after the type checks (e.g. a Jira period without a date field). */
  normalize?(args: Record<string, NlArgValue>): void;
  /** The basis line text (without the `기준:` prefix) for these canonical args. */
  describe?(args: NlArgs, range: NlResolvedRange | undefined, language: 'ko' | 'en'): string | undefined;
}

/** A validated selection the runtime hands to the owning handler's `handleSelected` (ADR-0120 interfaces). */
export interface NlSelectedCommand {
  readonly entryId: NlCatalogEntryId;
  /** Canonical args: closed values, grounded keywords, defaults omitted. */
  readonly args: NlArgs;
  /** The `range` arg placed by Core's clock and `QUOKY_TIMEZONE`; absent without a range. */
  readonly range?: NlResolvedRange;
  readonly language: 'ko' | 'en';
}

/** Typed readers for canonical args (handlers never cast). */
export function nlStringArg(args: NlArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

export function nlFlagArg(args: NlArgs, name: string): boolean {
  return args[name] === true;
}

export function nlLimitArg(args: NlArgs, name = 'limit'): number | undefined {
  const value = args[name];
  return typeof value === 'number' ? value : undefined;
}

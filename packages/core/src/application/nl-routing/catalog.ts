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
/** A wave-1 READ entry id: the only ids `lastSelection` and a numbered entry question ever hold. */
export type NlWave1EntryId = (typeof NL_CATALOG_ENTRY_IDS)[number];

/**
 * ADR-0120 amendment A6-D1: the closed action ids. `slack.post` and `calendar.create` are reserved for R3 (never offered
 * before their stage); every other id is offered only while `QUOKY_NL_ACTIONS` allows it (`action-entries.ts`).
 */
export const NL_ACTION_ENTRY_IDS = [
  'todo.add',
  'todo.complete',
  'todo.cancel',
  'reminder.create',
  'reminder.cancel',
  'action.undo',
  'item.summarize',
  'slack.post',
  'calendar.create',
] as const;
export type NlActionEntryId = (typeof NL_ACTION_ENTRY_IDS)[number];

/** Every closed catalog id: the wave-1 reads plus the A6 action ids. */
export type NlCatalogEntryId = NlWave1EntryId | NlActionEntryId;

export function isNlCatalogEntryId(value: unknown): value is NlCatalogEntryId {
  return isNlWave1EntryId(value) || isNlActionEntryId(value);
}

export function isNlWave1EntryId(value: unknown): value is NlWave1EntryId {
  return typeof value === 'string' && (NL_CATALOG_ENTRY_IDS as readonly string[]).includes(value);
}

export function isNlActionEntryId(value: unknown): value is NlActionEntryId {
  return typeof value === 'string' && (NL_ACTION_ENTRY_IDS as readonly string[]).includes(value);
}

/**
 * ADR-0120 D1/D5: wave 1 offers `READ` entries only. A6-D1 adds `ITEM_READ` (one item's text to the chat-tier provider on
 * the owner's explicit request) and selectable `LOCAL_WRITE` / `EXTERNAL_WRITE` action entries.
 */
export type NlCatalogRisk = 'READ' | 'ITEM_READ' | 'LOCAL_WRITE' | 'EXTERNAL_WRITE';

/**
 * One argument of an entry:
 *  - `enum`: one of `values`;
 *  - `keyword`: owner text, 1..100 characters, grounded verbatim in the owner's non-quoted text (ADR-0120 D4 step 5);
 *  - `range`: a symbolic period (`symbolic-time.ts`), at most 31 days;
 *  - `flag`: a boolean;
 *  - `limit`: an integer 1..10 (ADR-0120 D4 step 3);
 *  - `span` (A6-D1): the owner's words, verbatim, from the CURRENT turn's grounding text only (a payload);
 *  - `ref` (A6-D1): a closed item reference, `#1`..`#50`, `recent`, `this` or `last`, resolved by Core, never by the model.
 */
export type NlArgKind = 'enum' | 'keyword' | 'range' | 'flag' | 'limit' | 'span' | 'ref';

export interface NlArgSpec {
  readonly name: string;
  readonly kind: NlArgKind;
  readonly values?: readonly string[];
  /** `range` only: whether `upcoming` (from now to the lookahead end) is accepted; every other symbol always is. */
  readonly allowUpcoming?: boolean;
  /**
   * `keyword`: a value made of time words is legitimate here (a sender named "Sun"); the time-keyword rule skips it.
   * `span` (A6): the span IS a time (`when`), so the payload rule (not only deictic/time words) does not apply.
   */
  readonly allowsTimeWords?: boolean;
  /** `range` only: the period must have started already (mail received in a future period is meaningless). */
  readonly pastOnly?: boolean;
  readonly required?: boolean;
  /**
   * `enum` only: words that show the owner asked for a value (a value listed here counts only when one of its words is in
   * the owner's own text or the value carries over from the previous selection; a value not listed needs none).
   */
  readonly valueGrounding?: Readonly<Record<string, readonly string[]>>;
  /**
   * `flag` only: words that show the owner asked for the filter. A `true` counts only when one of them is in the owner's
   * own text or the flag carries over from the previous selection (the flag twin of `valueGrounding`).
   */
  readonly flagGrounding?: readonly string[];
  /**
   * An argument kept only to read older stored selections: accepted, never shown to the selector, and rewritten by the
   * entry's `normalize` into its replacement (e.g. `mail.list` `today` -> `range` `today`).
   */
  readonly deprecated?: boolean;
  /**
   * The argument belongs to this one answer only (e.g. which listed mail was asked about): it is never stored in
   * `lastSelection`, so a follow-up ("안 읽은 것만") refines the listing, not the pick.
   */
  readonly transient?: boolean;
  /** The value the entry uses when the argument is absent; canonical args omit an argument equal to it. */
  readonly default?: string | boolean;
  /** `span` only: the maximum length in code points (A6-D1: a title or body 1..200). */
  readonly maxChars?: number;
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
  /**
   * Words that show the owner stated this value in a request (ADR-0120 D7): a value the selector returns counts only
   * when one of them appears in the owner's own words. Stricter than `aliases` (no one-syllable words).
   */
  readonly grounding?: readonly string[];
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
  /** Rewrites a stored (`lastSelection`) args record of an older shape into the current one; pure, defaults untouched. */
  migrateArgs?(args: NlArgs): NlArgs;
  /** Entry-specific normalization after the type checks (e.g. a Jira period without a date field). */
  normalize?(args: Record<string, NlArgValue>): void;
  /** The basis line text (without the `기준:` prefix) for these canonical args. */
  describe?(args: NlArgs, range: NlResolvedRange | undefined, language: 'ko' | 'en'): string | undefined;
  /**
   * A6 entries only: an entry-level check after the per-arg checks (e.g. exactly one of `ref` / `match`, a time word in a
   * to-do title). Pure; `groundingText` is the owner's own non-quoted words of this turn. A failure names a reason.
   */
  check?(args: NlArgs, groundingText: string): NlEntryCheckFailure | undefined;
  /**
   * A6-D6 (D9 stale-command guard): output patterns of this family's own fixed command phrases. A chat reply that quotes
   * one while the family is offered is replaced. Never used for routing.
   */
  readonly staleCommands?: readonly RegExp[];
}

/** An entry-level validation failure (A6): the reason and, when one arg is at fault, its name (never a value). */
export interface NlEntryCheckFailure {
  readonly reason: 'invalid-arg' | 'missing-arg' | 'ungrounded' | 'deictic-payload' | 'time-in-title' | 'time-outside-when' | 'bulk';
  readonly arg?: string;
}

/** Where an A6 target lives (A6-D2): Quoky's own to-dos and reminders, or a listed mail / Drive item. */
export type NlItemSource = 'todo' | 'reminder' | 'mail' | 'drive';

/**
 * A6-D2: the item a validated action acts on, resolved by Core from the owner's reference and the content-free listing
 * records (never chosen by the model). `id` is the local UUID or the provider's opaque id; `label` is the number the owner
 * saw (a to-do or list number, or a reminder's `#N`). `id` is absent only for a reminder named by its stable display
 * number with no fresh reminder listing: the handler resolves `#label` through the repository (owner-scoped).
 */
export interface NlItemTarget {
  readonly source: NlItemSource;
  readonly id?: string;
  readonly label?: number;
  /** The listing's timestamp, for a provider item (the audit target reference: source, label, listing at). */
  readonly listingAt?: string;
}

/**
 * A6-D2/D3: what a handler reports after an action it ran (an A6 selection or an anchored Class A command), so the
 * runtime can record `quoky.lastAction`, the echo label and the audit line. Content-free: ids, labels, a version stamp,
 * closed values. Ignored while `QUOKY_NL_ACTIONS` is `off`.
 */
export interface NlActionReceipt {
  readonly entryId: NlActionEntryId;
  /**
   * `executed`: the action ran; `undone`: an inverse ran; `asked`: the handler asked which item (candidates below);
   * `refused`: nothing ran (already final, not found, a limit); `reschedule`: undoing the cancel of a past one-shot asks
   * for a new time (the reminder id is kept as the pending question).
   */
  readonly result: 'executed' | 'undone' | 'asked' | 'refused' | 'reschedule';
  readonly source: NlItemSource;
  readonly itemId?: string;
  readonly label?: number;
  readonly version?: string;
  /** Whether "되돌려줘" may undo this execution (false for an undo itself). */
  readonly undoable?: boolean;
  /** `undone` only: the entry whose action was undone. */
  readonly undoOf?: NlActionEntryId;
  /** `asked` only: the candidates under their shown labels (ids only). */
  readonly candidates?: readonly { readonly label: number; readonly id: string }[];
  /** A closed reason for `refused` / `asked` (never a value). */
  readonly reason?: string;
}

/** A6-D2: a to-do or reminder listing a handler showed (the labels the owner saw and the ids), content-free. */
export interface NlListingReceipt {
  readonly source: 'todo' | 'reminder';
  readonly items: readonly { readonly label: number; readonly id: string }[];
}

/** A6 undo: what the inverse undoes (the `lastAction` record's entry and the item version it left behind). */
export interface NlUndoSpec {
  readonly entryId: NlActionEntryId;
  /** The item's `updatedAt` right after the action (an inverse of a completion or cancel needs it unchanged). */
  readonly version?: string;
}

/** A validated selection the runtime hands to the owning handler's `handleSelected` (ADR-0120 interfaces). */
export interface NlSelectedCommand {
  readonly entryId: NlCatalogEntryId;
  /** Canonical args: closed values, grounded keywords, defaults omitted. */
  readonly args: NlArgs;
  /** The `range` arg placed by Core's clock and `QUOKY_TIMEZONE`; absent without a range. */
  readonly range?: NlResolvedRange;
  readonly language: 'ko' | 'en';
  /** A6-D2: the resolved item (an action with a `ref` or `match`, `item.summarize`, `action.undo`). */
  readonly target?: NlItemTarget;
  /** A6 `action.undo` only: the action the inverse undoes. */
  readonly undo?: NlUndoSpec;
}

/**
 * The structural catalog equivalent of a listing a handler answered through its own deterministic grammar (ADR-0120
 * follow-up): an entry id and canonical args (defaults omitted), content-free like `lastSelection`. The runtime stores it
 * as `lastSelection` so a later "그 중에 …" refines the listing the owner actually saw.
 */
export interface NlGrammarSelection {
  readonly entryId: NlWave1EntryId;
  readonly args: NlArgs;
}

/**
 * ADR-0120 D6 Phase C (S1): what a frozen Class B grammar WOULD answer for this message, computed without reading
 * anything (`ConversationTurnHandler.classBProbe`). `grammarId` is a closed, content-free id of the grammar (for the D10
 * agreement log); `selection` is the grammar's own catalog equivalent (the `nlSelection` its listing would record), absent
 * when the grammar's answer has none (an invalid date, several help topics).
 */
export interface NlClassBProbe {
  readonly grammarId: string;
  readonly selection?: NlGrammarSelection;
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

import type { Actor, Id, IsoTimestamp, Metadata, Session } from '../../domain';
import { isNlCatalogEntryId, type NlArgs, type NlArgValue, type NlCatalogEntryId } from './catalog';
import { isTimeExpression } from './symbolic-time';
import { nlWave1Entry } from './wave1-entries';

/**
 * The content-free state of natural-language selection (ADR-0120 D7), all plain data, no storage migration (a stored
 * `lastSelection` of an older args shape is rewritten when it is read, `migrateStoredSelection`: amendment A5):
 *
 *  - `Session.metadata['quoky.lastSelection']` = `{ actorId, entryId, args, at }`, 30 minutes — the previous selection a
 *    follow-up refines ("그 중에 위클리카만"). Structure only: an entry id and canonical args, never an item, title,
 *    subject or event text.
 *  - `Session.metadata['quoky.nlPending']` = `{ actorId, at, kind, … }`, 5 minutes — the open numbered question
 *    (which entry, or which interpretation) a reply such as `1` or `지라` resolves deterministically.
 *  - `Actor.metadata['quoky.interpretationPreferences']` = `{ [key]: { value, at } }`, 30 days, at most 16 keys — the
 *    owner's answer to an interpretation question (`jira.created-scope`), kept per actor so both platforms share it and
 *    `새 대화` does not erase it. Values come from the closed sets only.
 *
 * Anything expired, malformed or written for another actor counts as absent.
 */

export const LAST_SELECTION_METADATA_KEY = 'quoky.lastSelection';
export const NL_PENDING_METADATA_KEY = 'quoky.nlPending';
export const INTERPRETATION_PREFERENCES_METADATA_KEY = 'quoky.interpretationPreferences';

export const LAST_SELECTION_TTL_MS = 30 * 60_000;
export const NL_PENDING_TTL_MS = 5 * 60_000;
export const INTERPRETATION_PREFERENCE_TTL_MS = 30 * 24 * 60 * 60_000;
export const INTERPRETATION_PREFERENCES_MAX_KEYS = 16;

const MAX_ARGS = 12;
const MAX_STRING = 200;
const MAX_GROUNDING = 1000;

export interface StoredSelection {
  readonly entryId: NlCatalogEntryId;
  readonly args: NlArgs;
}

export interface LastSelection extends StoredSelection {
  readonly at: IsoTimestamp;
}

export type PendingQuestion =
  | {
      readonly kind: 'entry';
      readonly at: IsoTimestamp;
      /** The language the question was asked in (a bare "1" carries none). */
      readonly language: 'ko' | 'en';
      /** The numbered options, in order (validated selections). */
      readonly options: readonly StoredSelection[];
      /** The original turn's quote-stripped grounding text (bounded), so the picked option keeps an explicit role. */
      readonly groundingText?: string;
    }
  | {
      readonly kind: 'preference';
      readonly at: IsoTimestamp;
      readonly language: 'ko' | 'en';
      readonly key: string;
      /** The closed values, in option order. */
      readonly values: readonly string[];
      /** The selection the answer completes. */
      readonly selection: StoredSelection;
    };

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function fresh(at: unknown, now: IsoTimestamp, ttlMs: number): at is IsoTimestamp {
  if (typeof at !== 'string') return false;
  const age = Date.parse(now) - Date.parse(at);
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

function argsOf(value: unknown): NlArgs | undefined {
  const record = recordOf(value);
  const entries = Object.entries(record);
  if (entries.length > MAX_ARGS) return undefined;
  const args: Record<string, NlArgValue> = {};
  for (const [name, arg] of entries) {
    if (typeof arg === 'string' && arg.length <= MAX_STRING) args[name] = arg;
    else if (typeof arg === 'boolean' || (typeof arg === 'number' && Number.isFinite(arg))) args[name] = arg;
    else return undefined;
  }
  return args;
}

function selectionOf(value: unknown): StoredSelection | undefined {
  const record = recordOf(value);
  if (!isNlCatalogEntryId(record.entryId)) return undefined;
  const args = argsOf(record.args);
  return args === undefined ? undefined : { entryId: record.entryId, args };
}

/** A handler-supplied structural selection kept only when it is a closed entry with bounded plain args (else `undefined`). */
export function sanitizeStoredSelection(selection: { readonly entryId: unknown; readonly args: unknown }): StoredSelection | undefined {
  return selectionOf(selection);
}

/** The previous selection of this actor in this session, within 30 minutes. */
export function readLastSelection(session: Pick<Session, 'metadata'>, actorId: Id, now: IsoTimestamp): LastSelection | undefined {
  const record = recordOf(session.metadata?.[LAST_SELECTION_METADATA_KEY]);
  if (record.actorId !== actorId || !fresh(record.at, now, LAST_SELECTION_TTL_MS)) return undefined;
  const selection = selectionOf(record);
  return selection === undefined ? undefined : { ...migrateStoredSelection(selection), at: record.at as IsoTimestamp };
}

/**
 * A stored selection of an older shape, read as the current one: the entry's own `migrateArgs` (e.g. `mail.list`
 * `today` -> `range`), and a keyword that is only a time expression is dropped on an entry with a period ("목요일" stuck as
 * a title keyword by an earlier turn must not follow the owner to the next period; live UAT R4). Real keywords stay.
 */
export function migrateStoredSelection(selection: StoredSelection): StoredSelection {
  const entry = nlWave1Entry(selection.entryId);
  let args = entry.migrateArgs?.(selection.args) ?? selection.args;
  // A transient arg (a pick of one listed item) is never a follow-up's base, whatever wrote the record.
  if (entry.args.some((spec) => spec.transient === true && spec.name in args)) {
    args = Object.fromEntries(Object.entries(args).filter(([name]) => entry.args.find((spec) => spec.name === name)?.transient !== true));
  }
  if (entry.args.some((spec) => spec.kind === 'range')) {
    const kept: Record<string, NlArgValue> = {};
    for (const [name, value] of Object.entries(args)) {
      const spec = entry.args.find((candidate) => candidate.name === name);
      // Title keywords only: a sender (`from`) named like a weekday or month stays.
      if (spec?.kind === 'keyword' && spec.name !== 'from' && typeof value === 'string' && isTimeExpression(value)) continue;
      kept[name] = value;
    }
    args = kept;
  }
  return args === selection.args ? selection : { entryId: selection.entryId, args };
}

export function lastSelectionRecord(actorId: Id, selection: StoredSelection, now: IsoTimestamp): Metadata {
  return { actorId, entryId: selection.entryId, args: { ...selection.args }, at: now };
}

/** The open question of this actor in this session, within 5 minutes. */
export function readPendingQuestion(session: Pick<Session, 'metadata'>, actorId: Id, now: IsoTimestamp): PendingQuestion | undefined {
  const record = recordOf(session.metadata?.[NL_PENDING_METADATA_KEY]);
  if (record.actorId !== actorId || !fresh(record.at, now, NL_PENDING_TTL_MS)) return undefined;
  const at = record.at as IsoTimestamp;
  const language = record.language === 'en' ? 'en' : 'ko';
  if (record.kind === 'entry' && Array.isArray(record.options)) {
    const options = record.options.map(selectionOf);
    if (options.length === 0 || options.length > 4 || options.some((option) => option === undefined)) return undefined;
    const groundingText = typeof record.groundingText === 'string' && record.groundingText.length <= MAX_GROUNDING ? record.groundingText : undefined;
    return { kind: 'entry', at, language, options: options as StoredSelection[], ...(groundingText !== undefined ? { groundingText } : {}) };
  }
  if (record.kind === 'preference' && typeof record.key === 'string' && Array.isArray(record.values)) {
    const values = record.values.filter((value): value is string => typeof value === 'string' && value.length <= 40);
    const selection = selectionOf(record.selection);
    if (values.length === 0 || values.length !== record.values.length || selection === undefined) return undefined;
    return { kind: 'preference', at, language, key: record.key, values, selection };
  }
  return undefined;
}

export function pendingQuestionRecord(actorId: Id, question: PendingQuestion): Metadata {
  return question.kind === 'entry'
    ? {
        actorId,
        kind: 'entry',
        at: question.at,
        language: question.language,
        options: question.options.map((option) => ({ entryId: option.entryId, args: { ...option.args } })),
        ...(question.groundingText !== undefined ? { groundingText: question.groundingText.slice(0, MAX_GROUNDING) } : {}),
      }
    : {
        actorId,
        kind: 'preference',
        at: question.at,
        language: question.language,
        key: question.key,
        values: [...question.values],
        selection: { entryId: question.selection.entryId, args: { ...question.selection.args } },
      };
}

/** The owner's stored interpretation for `key`, when it is one of `allowed` and set within 30 days. */
export function readInterpretationPreference(
  actor: Pick<Actor, 'metadata'>,
  key: string,
  allowed: readonly string[],
  now: IsoTimestamp,
): string | undefined {
  const entry = recordOf(recordOf(actor.metadata?.[INTERPRETATION_PREFERENCES_METADATA_KEY])[key]);
  if (typeof entry.value !== 'string' || !allowed.includes(entry.value)) return undefined;
  return fresh(entry.at, now, INTERPRETATION_PREFERENCE_TTL_MS) ? entry.value : undefined;
}

/**
 * The next `quoky.interpretationPreferences` value with `key` set: every other still-valid key is kept (expired and
 * malformed ones are dropped), and the oldest keys go first beyond {@link INTERPRETATION_PREFERENCES_MAX_KEYS}.
 */
export function withInterpretationPreference(current: unknown, key: string, value: string, now: IsoTimestamp): Metadata {
  const kept: Array<[string, { value: string; at: string }]> = [];
  for (const [other, raw] of Object.entries(recordOf(current))) {
    if (other === key) continue;
    const entry = recordOf(raw);
    if (typeof entry.value === 'string' && entry.value.length <= 40 && fresh(entry.at, now, INTERPRETATION_PREFERENCE_TTL_MS)) {
      kept.push([other, { value: entry.value, at: entry.at }]);
    }
  }
  kept.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
  while (kept.length >= INTERPRETATION_PREFERENCES_MAX_KEYS) kept.shift();
  return Object.fromEntries([...kept, [key, { value, at: now }]]);
}

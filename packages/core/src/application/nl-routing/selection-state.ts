import type { Actor, Id, IsoTimestamp, Metadata, Session } from '../../domain';
import {
  isNlActionEntryId,
  isNlWave1EntryId,
  type NlActionEntryId,
  type NlArgs,
  type NlArgValue,
  type NlItemSource,
  type NlItemTarget,
  type NlWave1EntryId,
} from './catalog';
import { isTimeExpression } from './symbolic-time';
import { NL_HELP_SCOPE_MAX_SOURCES } from './help-scope';
import { NL_CATALOG_SOURCE_NAMES, nlWave1Entry } from './wave1-entries';

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

/** A stored selection is always a wave-1 READ entry: an A6 action id is never `lastSelection` nor a numbered option. */
export interface StoredSelection {
  readonly entryId: NlWave1EntryId;
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
      /**
       * Owner decision B (2026-10-22): a one-option confirmation ("'… (KEY)' 프로젝트가 맞나요?"), answered like the A6
       * elliptical-continuation confirmation: a yes picks the option, a no ends the question, a number still answers it.
       */
      readonly confirm?: true;
      /**
       * Owner decision A (2026-10-22): a help question that names a source; the option is Quoky's help, and one more
       * numbered option (after the stored ones) is the source app itself. Holds the catalog source name the owner wrote.
       */
      readonly appSource?: string;
      /** Owner decision of 2026-10-26: several sources named (2..3 catalog source names, the owner's order). */
      readonly appSources?: readonly string[];
      /** More sources were named than `appSources` holds (the question says "등" / "and others"; Codex P2). */
      readonly appSourcesMore?: true;
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
    }
  /**
   * ADR-0120 amendment A6-D2: which item did the owner mean? Candidate ids under their shown labels ONLY (never a span);
   * only target entries resume from it (`todo.complete`/`todo.cancel`, `reminder.cancel`, `item.summarize`,
   * `action.undo`). `args` keeps the closed enum args (`source`, `scope`, `mode`) of `item.summarize`, nothing else.
   */
  | {
      readonly kind: 'action-target';
      readonly at: IsoTimestamp;
      readonly language: 'ko' | 'en';
      readonly entryId: NlActionEntryId;
      readonly source: NlItemSource;
      readonly candidates: readonly { readonly label: number; readonly id: string }[];
      readonly args: NlArgs;
      readonly listingAt?: IsoTimestamp;
      /**
       * A6-D3a amendment 1, elliptical continuation: a one-candidate confirmation ("할 일 3번도 완료할까요?"), where a yes
       * ("응") picks the candidate and a no ends the question.
       */
      readonly confirm?: true;
      /**
       * The platform ids the confirmation question itself was delivered as (bound on delivery), so a platform reply to the
       * question is positively told apart from a reply to any other message (Codex P1).
       */
      readonly questionReplyIds?: readonly string[];
    }
  /** Ratification record C: summary or full? The resolved item id only; the answer is kept as the D7 preference. */
  | {
      readonly kind: 'action-mode';
      readonly at: IsoTimestamp;
      readonly language: 'ko' | 'en';
      readonly target: NlItemTarget;
      readonly scope?: 'item' | 'thread';
    }
  /** Ratification record A: undoing the cancel of a one-shot whose time passed asks for a new time (the reminder id only). */
  | {
      readonly kind: 'action-reschedule';
      readonly at: IsoTimestamp;
      readonly language: 'ko' | 'en';
      readonly target: NlItemTarget;
      /** The canceled reminder's version (`updatedAt`): the reactivation is a compare-and-set against it. */
      readonly version: string;
    }
  /**
   * A6-D3a amendment 1, undo confirmation rule: "방금 한 '할 일 2번 완료'를 되돌릴까요?". The undone item and the action it
   * undoes, so the confirmation runs only if the last action is still exactly that one.
   */
  | {
      readonly kind: 'action-undo-confirm';
      readonly at: IsoTimestamp;
      readonly language: 'ko' | 'en';
      readonly target: NlItemTarget;
      readonly undoEntryId: NlActionEntryId;
      /** The `at` of the lastAction record the question named (the binding a reply is checked against). */
      readonly actionAt?: IsoTimestamp;
    };

/** A source name of the wave-1 catalog (its entries' `sourceNames`, case aside): the only `appSource` a record may hold. */
function isCatalogSourceName(value: string): boolean {
  const lower = value.normalize('NFC').toLowerCase();
  return lower.length > 0 && lower.length <= 40 && NL_CATALOG_SOURCE_NAMES.includes(lower);
}

/** Whether a pending question belongs to A6 (answered before any grammar, only while actions are live). */
export function isActionPendingQuestion(question: PendingQuestion | null | undefined): question is Extract<PendingQuestion, { kind: `action-${string}` }> {
  return question?.kind === 'action-target' || question?.kind === 'action-mode' || question?.kind === 'action-reschedule' || question?.kind === 'action-undo-confirm';
}

const ITEM_SOURCES: readonly NlItemSource[] = ['todo', 'reminder', 'mail', 'drive'];
const ACTION_ENUM_ARGS: Readonly<Record<string, readonly string[]>> = { source: ['mail', 'drive'], scope: ['item', 'thread'], mode: ['summary', 'full'] };
const MAX_CANDIDATES = 10;
const MAX_REPLY_IDS = 10;

/** Bounded opaque platform ids, or `undefined`. */
function replyIdsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REPLY_IDS) return undefined;
  return value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256) ? (value as string[]) : undefined;
}

/**
 * Elliptical continuation (Codex P1): bind the delivered platform ids of the confirmation question to the open
 * `action-target` confirmation it asked, only when the stored record is still that question (same actor, same `at`).
 * Anything else is returned unchanged.
 */
export function withPendingQuestionReplies(current: unknown, actorId: Id, at: IsoTimestamp, ids: readonly string[]): unknown {
  const record = recordOf(current);
  const bounded = replyIdsOf([...ids].slice(0, MAX_REPLY_IDS));
  if (record.actorId !== actorId || record.at !== at || record.kind !== 'action-target' || record.confirm !== true || bounded === undefined) return current;
  return { ...record, questionReplyIds: bounded };
}

function targetOf(value: unknown): NlItemTarget | undefined {
  const record = recordOf(value);
  if (!(ITEM_SOURCES as readonly unknown[]).includes(record.source)) return undefined;
  const id = typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 512 ? record.id : undefined;
  const label = Number.isSafeInteger(record.label) && (record.label as number) >= 1 ? (record.label as number) : undefined;
  // Only a reminder may be named by its display number alone.
  if (id === undefined && (record.source !== 'reminder' || label === undefined)) return undefined;
  const listingAt = typeof record.listingAt === 'string' && Number.isFinite(Date.parse(record.listingAt)) ? record.listingAt : undefined;
  return {
    source: record.source as NlItemSource,
    ...(id !== undefined ? { id } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(listingAt !== undefined ? { listingAt } : {}),
  };
}

function actionArgsOf(value: unknown): NlArgs {
  const args: Record<string, NlArgValue> = {};
  for (const [name, arg] of Object.entries(recordOf(value))) {
    if (typeof arg === 'string' && (ACTION_ENUM_ARGS[name] ?? []).includes(arg)) args[name] = arg;
  }
  return args;
}

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
  if (!isNlWave1EntryId(record.entryId)) return undefined;
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
      if (spec?.kind === 'keyword' && spec.allowsTimeWords !== true && typeof value === 'string' && isTimeExpression(value)) continue;
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
    const confirm = record.confirm === true && options.length === 1;
    const appSource = typeof record.appSource === 'string' && isCatalogSourceName(record.appSource) ? record.appSource : undefined;
    if (record.appSource !== undefined && appSource === undefined) return undefined;
    const rawSources: unknown = record.appSources;
    const appSources =
      Array.isArray(rawSources) && rawSources.length >= 2 && rawSources.length <= NL_HELP_SCOPE_MAX_SOURCES && rawSources.every((name) => typeof name === 'string' && isCatalogSourceName(name))
        ? (rawSources as string[])
        : undefined;
    if (rawSources !== undefined && (appSources === undefined || appSource !== undefined)) return undefined;
    if (record.appSourcesMore !== undefined && (record.appSourcesMore !== true || appSources === undefined || appSources.length !== NL_HELP_SCOPE_MAX_SOURCES)) return undefined;
    return {
      kind: 'entry',
      at,
      language,
      options: options as StoredSelection[],
      ...(groundingText !== undefined ? { groundingText } : {}),
      ...(confirm ? { confirm: true as const } : {}),
      ...(appSource !== undefined ? { appSource } : {}),
      ...(appSources !== undefined ? { appSources: [...appSources] } : {}),
      ...(record.appSourcesMore === true ? { appSourcesMore: true as const } : {}),
    };
  }
  if (record.kind === 'action-target' && isNlActionEntryId(record.entryId) && (ITEM_SOURCES as readonly unknown[]).includes(record.source) && Array.isArray(record.candidates)) {
    const candidates = record.candidates
      .map((candidate) => recordOf(candidate))
      .filter((candidate) => Number.isSafeInteger(candidate.label) && (candidate.label as number) >= 1 && typeof candidate.id === 'string' && candidate.id.length > 0 && candidate.id.length <= 512)
      .map((candidate) => ({ label: candidate.label as number, id: candidate.id as string }));
    if (candidates.length === 0 || candidates.length !== record.candidates.length || candidates.length > MAX_CANDIDATES) return undefined;
    const listingAt = typeof record.listingAt === 'string' && Number.isFinite(Date.parse(record.listingAt)) ? (record.listingAt as IsoTimestamp) : undefined;
    return {
      kind: 'action-target',
      at,
      language,
      entryId: record.entryId,
      source: record.source as NlItemSource,
      candidates,
      args: actionArgsOf(record.args),
      ...(listingAt !== undefined ? { listingAt } : {}),
      ...(record.confirm === true && candidates.length === 1 ? { confirm: true as const } : {}),
      ...(record.confirm === true && candidates.length === 1 && replyIdsOf(record.questionReplyIds) !== undefined ? { questionReplyIds: replyIdsOf(record.questionReplyIds) as string[] } : {}),
    };
  }
  if (record.kind === 'action-mode') {
    const target = targetOf(record.target);
    if (target === undefined) return undefined;
    const scope = record.scope === 'thread' || record.scope === 'item' ? record.scope : undefined;
    return { kind: 'action-mode', at, language, target, ...(scope !== undefined ? { scope } : {}) };
  }
  if (record.kind === 'action-reschedule') {
    const target = targetOf(record.target);
    const version = typeof record.version === 'string' && record.version.length > 0 && record.version.length <= 64 ? record.version : undefined;
    return target === undefined || target.source !== 'reminder' || version === undefined ? undefined : { kind: 'action-reschedule', at, language, target, version };
  }
  if (record.kind === 'action-undo-confirm') {
    const target = targetOf(record.target);
    if (target === undefined || (target.source !== 'todo' && target.source !== 'reminder') || !isNlActionEntryId(record.undoEntryId)) return undefined;
    const actionAt = typeof record.actionAt === 'string' && Number.isFinite(Date.parse(record.actionAt)) ? (record.actionAt as IsoTimestamp) : undefined;
    return { kind: 'action-undo-confirm', at, language, target, undoEntryId: record.undoEntryId, ...(actionAt !== undefined ? { actionAt } : {}) };
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
  switch (question.kind) {
    case 'action-target':
      return {
        actorId,
        kind: question.kind,
        at: question.at,
        language: question.language,
        entryId: question.entryId,
        source: question.source,
        candidates: question.candidates.slice(0, MAX_CANDIDATES).map((candidate) => ({ label: candidate.label, id: candidate.id })),
        args: actionArgsOf(question.args),
        ...(question.listingAt !== undefined ? { listingAt: question.listingAt } : {}),
        ...(question.confirm === true ? { confirm: true } : {}),
        ...(question.confirm === true && question.questionReplyIds !== undefined ? { questionReplyIds: [...question.questionReplyIds].slice(0, MAX_REPLY_IDS) } : {}),
      };
    case 'action-mode':
      return { actorId, kind: question.kind, at: question.at, language: question.language, target: { ...question.target }, ...(question.scope !== undefined ? { scope: question.scope } : {}) };
    case 'action-reschedule':
      return { actorId, kind: question.kind, at: question.at, language: question.language, target: { ...question.target }, version: question.version };
    case 'action-undo-confirm':
      return { actorId, kind: question.kind, at: question.at, language: question.language, target: { ...question.target }, undoEntryId: question.undoEntryId, ...(question.actionAt !== undefined ? { actionAt: question.actionAt } : {}) };
    default:
      break;
  }
  return question.kind === 'entry'
    ? {
        actorId,
        kind: 'entry',
        at: question.at,
        language: question.language,
        options: question.options.map((option) => ({ entryId: option.entryId, args: { ...option.args } })),
        ...(question.groundingText !== undefined ? { groundingText: question.groundingText.slice(0, MAX_GROUNDING) } : {}),
        ...(question.confirm === true && question.options.length === 1 ? { confirm: true } : {}),
        ...(question.appSource !== undefined ? { appSource: question.appSource } : {}),
        ...(question.appSources !== undefined ? { appSources: [...question.appSources] } : {}),
        ...(question.appSourcesMore === true ? { appSourcesMore: true } : {}),
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

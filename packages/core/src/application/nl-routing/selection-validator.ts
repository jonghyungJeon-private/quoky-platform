import type { IsoTimestamp } from '../../domain';
import { containsCredentialMaterial } from '../credential-guard';
import {
  isNlCatalogEntryId,
  type NlAmbiguityKey,
  type NlArgs,
  type NlArgSpec,
  type NlArgValue,
  type NlCatalogEntry,
  type NlCatalogEntryId,
} from './catalog';
import {
  formatNlRef,
  isNlDeicticOnlyPayload,
  withoutStructures,
  isNlRefGrounded,
  isNlSpanGrounded,
  normalizeNlSpan,
  parseNlRef,
} from './action-entries';
import { NL_FENCED_PLACEHOLDER, NL_QUOTED_PLACEHOLDER, isGroundedIn, normalizeForMatch } from './selection-input';
import type { NlSelectionCandidate } from './selection-output';
import {
  isNlRangeSymbol,
  isWeekdayOrTimeKeyword,
  nlRangeKeepsWeekday,
  nlSingleWeekday,
  nlWeekdayMentions,
  normalizeNlRangeSymbol,
  resolveNlRange,
  type NlResolvedRange,
  type NlWeekdayMention,
} from './symbolic-time';
import { canonicalNlKeyword } from './keyword-canonical';

export { canonicalNlKeyword } from './keyword-canonical';

/**
 * Deterministic validation of a selector candidate (ADR-0120 D4, the ADR-0090 L2 policy), in order:
 *  (1) closed ids and the argument schema (unknown args rejected, closed values only);
 *  (2) the entry is offered in this turn's catalog (registered and configured) and is a READ entry (D5);
 *  (3) bounds: limit 1..10, keyword 1..100 characters;
 *  (4) a range is a symbol Core resolves with the turn's clock and `QUOKY_TIMEZONE` (at most 31 days), and keeps the one
 *      weekday the owner's words name (A5 implementation note 2: "다음 주 수" is never next Monday nor the whole week);
 *  (5) grounding: a keyword appears verbatim in the owner's non-quoted text or in the previous selection's args, and an
 *      entry with a `range` never takes a time expression as a keyword; a grounded flag / enum value needs an owner word;
 *  (6) the credential guard runs on every string arg.
 * ADR-0120 amendment A6 adds, only when the context allows action entries (`actions`):
 *  - step (2) accepts an offered `ITEM_READ`, `LOCAL_WRITE` or `EXTERNAL_WRITE` entry;
 *  - a `span` is the owner's words verbatim from THIS turn's grounding text (never the previous selection, never a
 *    placeholder), not made only of deictic, ordinal or time words, and credential-guarded (A6-D3 payload rules);
 *  - a `ref` is a closed form grounded by a numeral, ordinal or deictic in the owner's words (A6-D2);
 *  - the entry's own check (exactly one target, a time word in a title, the whole-message time check, bulk requests).
 * A failure names the reason and the argument, never a value. Pure: `now` is an input.
 */

export const NL_LIMIT_MIN = 1;
export const NL_LIMIT_MAX = 10;
export const NL_KEYWORD_MAX_CHARS = 100;

export type NlValidationFailureReason =
  | 'unknown-entry'
  | 'not-offered'
  | 'not-read'
  | 'unknown-arg'
  | 'invalid-arg'
  | 'missing-arg'
  | 'range'
  | 'ungrounded'
  /** A keyword that is only a time expression ("목요일", "내일 오후"): a period belongs in `range` / `partOfDay`. */
  | 'time-keyword'
  /**
   * The period drops or changes the one weekday the owner named ("다음 주 수" read as next Monday or the whole week). Like
   * `time-keyword`, never repaired by dropping the range: the owner is asked.
   */
  | 'weekday'
  | 'credential'
  /** A6-D3: a payload span made only of deictic, ordinal or time words ("그거", "첫 번째 거"). */
  | 'deictic-payload'
  /** A6-D1: a to-do title with a time expression (to-do or reminder?). */
  | 'time-in-title'
  /** A6-D1: a reminder message with a time expression outside `when`. */
  | 'time-outside-when'
  /** A6-D1: one action per message ("다 완료해줘"). */
  | 'bulk';

export interface NlValidatedSelection {
  readonly entry: NlCatalogEntry;
  /** Canonical: closed values, defaults omitted (except an open ambiguity's own arg, which is absent by definition). */
  readonly args: NlArgs;
  readonly range?: NlResolvedRange;
  /** An interpretation key whose arg the owner did not state (ADR-0120 D7). */
  readonly openAmbiguity?: NlAmbiguityKey;
}

export type NlValidationResult =
  | { readonly ok: true; readonly value: NlValidatedSelection }
  | {
      readonly ok: false;
      readonly reason: NlValidationFailureReason;
      readonly entryId?: NlCatalogEntryId;
      /** The failing argument's name (never its value). */
      readonly arg?: string;
    };

export interface NlValidationContext {
  /** The entries offered this turn (registered and configured). */
  readonly offered: ReadonlyMap<string, NlCatalogEntry>;
  /** The owner's non-quoted text (`prepareSelectionInput().groundingText`). */
  readonly groundingText: string;
  /** The previous selection's args (structure only), which may also ground a keyword (a refinement). */
  readonly previousArgs?: NlArgs;
  readonly now: IsoTimestamp;
  readonly timeZone: string;
  /**
   * ADR-0120 amendment A6: action entries may validate (the flag allows them and they are offered). Absent or false:
   * step (2) refuses every entry that is not `READ`, exactly as before A6.
   */
  readonly actions?: boolean;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function validateSelection(candidate: NlSelectionCandidate, ctx: NlValidationContext): NlValidationResult {
  // (1) closed ids
  if (!isNlCatalogEntryId(candidate.entryId)) return { ok: false, reason: 'unknown-entry' };
  const entryId = candidate.entryId;
  // (2) offered (registered + configured) and READ only (wave 1), or an offered A6 entry while actions are allowed
  const entry = ctx.offered.get(entryId);
  if (entry === undefined) return { ok: false, reason: 'not-offered', entryId };
  if (entry.risk !== 'READ' && ctx.actions !== true) return { ok: false, reason: 'not-read', entryId };
  const specs = new Map(entry.args.map((spec) => [spec.name, spec] as const));
  const args: Record<string, NlArgValue> = {};
  for (const [name, value] of Object.entries(candidate.args)) {
    const spec = specs.get(name);
    if (spec === undefined) return { ok: false, reason: 'unknown-arg', entryId, arg: name };
    const checked = checkArg(spec, value);
    if (checked === undefined) return { ok: false, reason: 'invalid-arg', entryId, arg: name };
    args[name] = checked;
  }
  entry.normalize?.(args);
  for (const spec of entry.args) {
    if (spec.required === true && args[spec.name] === undefined) return { ok: false, reason: 'missing-arg', entryId, arg: spec.name };
  }
  // (4) symbolic time
  let range: NlResolvedRange | undefined;
  const rangeSpec = entry.args.find((spec) => spec.kind === 'range');
  if (rangeSpec !== undefined) {
    const symbol = typeof args[rangeSpec.name] === 'string' ? (args[rangeSpec.name] as string) : typeof rangeSpec.default === 'string' ? rangeSpec.default : undefined;
    if (symbol !== undefined) {
      if (symbol === 'upcoming' && rangeSpec.allowUpcoming !== true) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
      range = resolveNlRange(symbol, ctx.now, ctx.timeZone);
      if (range === undefined) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
      if (rangeSpec.pastOnly === true && Date.parse(range.from) > Date.parse(ctx.now)) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
    }
  }
  // The weekdays the owner's words name, outside a value that may legitimately be one (a sender called "월요일").
  const mentions: readonly NlWeekdayMention[] = rangeSpec !== undefined ? nlWeekdayMentions(withoutNameValues(entry, args, ctx.groundingText), entry.aliases) : [];
  // (5) grounding and (6) the credential guard, on every string arg. A6: the previous selection never grounds an action,
  // and every action argument (span, ref, enum and flag words, the entry check) is grounded only in the owner's prose:
  // a pasted structure (JSON, data) grounds nothing (Codex review P1).
  const previousArgs = entry.risk === 'READ' ? ctx.previousArgs : undefined;
  const groundingText = entry.risk === 'READ' ? ctx.groundingText : withoutStructures(ctx.groundingText);
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (spec.kind === 'flag' && value === true && spec.flagGrounding !== undefined) {
      const text = normalizeForMatch(groundingText);
      const stated = spec.flagGrounding.some((word) => groundingWordIn(text, normalizeForMatch(word)));
      if (!stated && previousArgs?.[spec.name] !== true) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (typeof value !== 'string') continue;
    if (spec.kind === 'enum' && spec.valueGrounding?.[value] !== undefined) {
      const text = normalizeForMatch(groundingText);
      const stated = (spec.valueGrounding[value] ?? []).some((word) => groundingWordIn(text, normalizeForMatch(word)));
      if (!stated && previousArgs?.[spec.name] !== value) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (spec.kind === 'keyword') {
      if (rangeSpec !== undefined && spec.allowsTimeWords !== true && isWeekdayOrTimeKeyword(value, mentions.length > 0)) return { ok: false, reason: 'time-keyword', entryId, arg: spec.name };
      const previous = previousArgs?.[spec.name];
      const fromPrevious = typeof previous === 'string' && previous === value;
      if (!fromPrevious && !isGroundedIn(value, groundingText)) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    // A6-D3: a span is grounded ONLY in this turn's own words (never the previous selection), and is never only deictic.
    if (spec.kind === 'span') {
      if (!isNlSpanGrounded(value, groundingText)) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
      if (spec.allowsTimeWords !== true && isNlDeicticOnlyPayload(value)) return { ok: false, reason: 'deictic-payload', entryId, arg: spec.name };
    }
    // A6-D2: a ref needs a numeral, ordinal or deictic in this turn's own words.
    if (spec.kind === 'ref') {
      const ref = parseNlRef(value);
      if (ref === undefined || !isNlRefGrounded(ref, groundingText)) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (containsCredentialMaterial(value)) return { ok: false, reason: 'credential', entryId, arg: spec.name };
  }
  // (4b) the owner's weekday is a fact about the period: a period that drops or changes it never validates (after the
  // per-arg checks, so a weekday keyword still fails as `time-keyword`).
  const weekday = nlSingleWeekday(mentions);
  if (rangeSpec !== undefined && weekday !== undefined) {
    // A weekday inside a grounded title keyword with other words ("수요일 스터디", "sunday school") may be part of the
    // title (A5 rule 6: real title keywords stay), so it is uncertain: another single day is still refused.
    const titled = entry.args.some((spec) => {
      const value = args[spec.name];
      return spec.kind === 'keyword' && typeof value === 'string' && nlWeekdayMentions(value).some((mention) => mention.weekday === weekday.weekday);
    });
    if (!nlRangeKeepsWeekday(range, titled ? { ...weekday, certain: false } : weekday, ctx.now, ctx.timeZone)) {
      return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
    }
  }
  // A6: the entry's own check after the per-arg checks.
  if (entry.check !== undefined) {
    const failure = entry.check(args, groundingText);
    if (failure !== undefined) return { ok: false, reason: failure.reason, entryId, ...(failure.arg !== undefined ? { arg: failure.arg } : {}) };
  }
  const openAmbiguity = (entry.ambiguity ?? []).find((key) => key.openWhen(args) && args[key.arg] === undefined);
  return {
    ok: true,
    value: {
      entry,
      args: Object.freeze(canonicalArgs(entry, args)),
      ...(range !== undefined ? { range } : {}),
      ...(openAmbiguity !== undefined ? { openAmbiguity } : {}),
    },
  };
}

/** A closed particle glued after a name ("월요일이 보낸", "Sun한테서"). */
const NAME_PARTICLE = '(?:에게서|한테서|에게|한테|께서|이랑|랑|하고|이|가|은|는|의|도|만|께)?';

/**
 * The owner's text without the values of args that may be made of time words (a sender named "월요일"). Only a whole
 * word is removed (optionally with one particle), so a sender "Sun" never erases the weekday in "Sunday".
 */
function withoutNameValues(entry: NlCatalogEntry, args: Readonly<Record<string, NlArgValue>>, text: string): string {
  let rest = text.normalize('NFC');
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (spec.allowsTimeWords !== true || typeof value !== 'string' || value.trim().length === 0) continue;
    const escaped = value.normalize('NFC').trim().replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
    rest = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${NAME_PARTICLE}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  return rest;
}

/** The args with every value equal to its spec default removed, except an ambiguity arg whose key is in force. */
export function canonicalArgs(entry: NlCatalogEntry, args: Readonly<Record<string, NlArgValue>>): Record<string, NlArgValue> {
  const kept: Record<string, NlArgValue> = {};
  const protectedArgs = new Set((entry.ambiguity ?? []).filter((key) => key.openWhen(args)).map((key) => key.arg));
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (value === undefined) continue;
    if (spec.default !== undefined && value === spec.default && !protectedArgs.has(spec.name)) continue;
    kept[spec.name] = value;
  }
  return kept;
}

/** Type check of one argument (D4 steps 1 and 3); the normalized value or `undefined`. */
function checkArg(spec: NlArgSpec, value: NlArgValue): NlArgValue | undefined {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && (spec.values ?? []).includes(value) ? value : undefined;
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'limit':
      return typeof value === 'number' && Number.isInteger(value) && value >= NL_LIMIT_MIN && value <= NL_LIMIT_MAX ? value : undefined;
    case 'range': {
      if (typeof value !== 'string') return undefined;
      const symbol = normalizeNlRangeSymbol(value);
      return isNlRangeSymbol(symbol) ? symbol : undefined;
    }
    case 'keyword': {
      if (typeof value !== 'string') return undefined;
      const keyword = canonicalNlKeyword(value);
      const length = Array.from(keyword).length;
      if (length === 0 || length > NL_KEYWORD_MAX_CHARS || CONTROL.test(keyword)) return undefined;
      return keyword;
    }
    case 'span': {
      // A6-D1: verbatim, NFC and whitespace only, one pair of enclosing quotes trimmed; never a placeholder, never repaired.
      if (typeof value !== 'string' || CONTROL.test(value.replace(/[\t\n\r]/g, ' '))) return undefined;
      const span = normalizeNlSpan(value);
      const length = Array.from(span).length;
      if (length === 0 || length > (spec.maxChars ?? NL_KEYWORD_MAX_CHARS)) return undefined;
      if (span.includes(NL_QUOTED_PLACEHOLDER) || span.includes(NL_FENCED_PLACEHOLDER) || /\[files:/u.test(span)) return undefined;
      return span;
    }
    case 'ref': {
      const ref = parseNlRef(value);
      return ref === undefined ? undefined : formatNlRef(ref);
    }
  }
}

/**
 * A grounding word in normalized text. A word made of ASCII letters and digits only must start a word and may end it or
 * take a plural `s` ("docs" is not in "docker", "sheet" is in "sheets"); a Korean word is a plain substring.
 */
export function groundingWordIn(text: string, word: string): boolean {
  if (!/^[a-z0-9][a-z0-9 -]*$/.test(word)) return text.includes(word);
  const escaped = word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}s?(?![a-z0-9])`).test(text);
}

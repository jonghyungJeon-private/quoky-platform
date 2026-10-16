import type { IsoTimestamp } from '../../domain';
import { containsCredentialMaterial } from '../credential-guard';
import {
  isNlActionEntryId,
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
  NL_ACTION_WORDS,
  nlFrameExpressesAction,
  withoutSpan,
  withoutStructures,
  isNlRefGrounded,
  isNlSpanGrounded,
  nlActionSourceOf,
  normalizeNlSpan,
  parseNlRef,
} from './action-entries';
import { NL_FENCED_PLACEHOLDER, NL_QUOTED_PLACEHOLDER, isGroundedIn, normalizeForMatch } from './selection-input';
import type { NlSelectionCandidate } from './selection-output';
import { nlRequestEndsBefore, nlRequestVeto, type NlRequestVeto } from './request-shape';
import {
  isNlRangeSymbol,
  isWeekdayOrTimeKeyword,
  nlCanonicalWeekdaySymbol,
  nlRangeKeepsWeekday,
  nlKeywordIsTitle,
  nlSingleWeekday,
  nlMultiWeekdayBound,
  nlUntilBound,
  nlUntilSymbolWeekday,
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
 *      an `until-*` period is grounded by the owner's inclusive end bound on that weekday, and a period holding such a
 *      bounded day without ending on it is spelled as the `until-*` symbol ending on that day (A7);
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
  | 'bulk'
  /**
   * A6-D3a amendment 1: the owner's own sentence is not a request (a question, a negation, a retraction, reported speech, a
   * hypothetical, a past statement or first-person volition); `arg` names the class ({@link NlRequestVeto}). The turn is chat.
   */
  | 'not-request';

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
      /** ADR-0120 A8: the entry whose usage question the clarification uses instead (an entry check's hint). */
      readonly askEntryId?: NlCatalogEntryId;
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
  /**
   * A6-D3a amendment 1, the R5a seam: strips the caller's own phrases (an origin phrase such as "내가 말한 거") from the
   * owner's prose before the request-shape vetoes read it. Spans are still grounded in the whole prose.
   */
  readonly requestFrame?: (prose: string) => string;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The content spans of a LOCAL_WRITE: the owner's content, never the request around it (a `when` stays in the frame). */
const CONTENT_SPAN_ARGS = ['title', 'body', 'match'] as const;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [["'", "'"], ['"', '"'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']];
/** A dative recipient ("친구한테", "팀장님께"): something is given to someone, never Quoky's own undo. */
const DATIVE = /(?:한테|에게|께)(?=$|\s|[.,!?~])/u;

/**
 * A quote character without its pair inside a span ("우유' 사기 추가하지 마" runs past a closing quote). An apostrophe
 * between letters ("Kim's") is not a quote.
 */
export function nlSpanHasUnbalancedQuote(span: string): boolean {
  const text = span.replace(/(?<=\p{L})['’](?=\p{L})/gu, '');
  return QUOTE_PAIRS.some(([open, close]) => {
    const opens = text.split(open).length - 1;
    if (open === close) return opens % 2 !== 0;
    return opens !== text.split(close).length - 1;
  });
}

/**
 * Whether the owner's prose fully encloses the span as content: a matching quote pair right around it, or a colon form
 * ("할 일 추가: …", "알림: …") whose span runs to the end of the message.
 */
function spanEnclosure(prose: string, span: string): 'quote' | 'colon' | 'after-request' | undefined {
  const at = prose.indexOf(span);
  if (at < 0) return undefined;
  const before = prose.slice(0, at).replace(/\s+$/u, '');
  const after = prose.slice(at + span.length);
  const opened = before.at(-1);
  const closed = after.replace(/^\s+/u, '').at(0);
  if (QUOTE_PAIRS.some(([open, close]) => opened === open && closed === close)) return 'quote';
  const toEnd = /^[\s.!?~^ㅋㅎ]*$/u.test(after);
  if (/[:：]$/u.test(before) && toEnd) return 'colon';
  // Content that ends the message after the request verb ("할 일 추가해줘 운동 끝나고 샤워하기", "remind me at 5pm to
  // stretch after lunch"): the request is already said, the rest is the content (CA round 3).
  return toEnd && nlRequestEndsBefore(before, NL_ACTION_WORDS) ? 'after-request' : undefined;
}

/** A6-D3a amendment 1: the request shape of a LOCAL_WRITE (see {@link requestShapeOf}). */
export interface NlRequestShape {
  readonly veto?: NlRequestVeto;
  readonly expressesAction: boolean;
  /** A content span with an unpaired quote: refused as `invalid-arg`. */
  readonly unbalancedSpan?: string;
}

/**
 * A6-D3a amendment 1: the request shape of a LOCAL_WRITE. The vetoes read the owner's prose (pasted structures removed)
 * without the content spans that a quote pair or a colon form running to the end fully encloses; an undelimited span stays
 * in the frame, so "할 일에 우유 사기 추가하지 마, 그냥 메모야" stays vetoed whatever span the selector returns. Every span's
 * own negated action always counts. `stripFrame` is the R5a seam: a caller may remove its own phrases ("내가 말한 거",
 * "아까 보냈던 거") from the prose before the vetoes run. An arg-less entry (`action.undo`) also needs its own action word
 * (an undo word) in the frame and no dative recipient ("친구한테 책 돌려줘").
 */
export function requestShapeOf(entry: NlCatalogEntry, args: NlArgs, groundingText: string, stripFrame?: (prose: string) => string): NlRequestShape {
  const base = withoutStructures(groundingText).normalize('NFC').replace(/\s+/g, ' ');
  const prose = stripFrame === undefined ? base : stripFrame(base).normalize('NFC').replace(/\s+/g, ' ');
  let vetoFrame = prose;
  let contentFrame = prose;
  const content: string[] = [];
  const quoted: string[] = [];
  const trailing: string[] = [];
  for (const name of CONTENT_SPAN_ARGS) {
    const span = args[name];
    if (typeof span !== 'string' || span.length === 0) continue;
    if (nlSpanHasUnbalancedQuote(span)) return { expressesAction: false, unbalancedSpan: name };
    content.push(span);
    const enclosure = spanEnclosure(prose, span);
    if (enclosure !== undefined) vetoFrame = withoutSpan(vetoFrame, span);
    if (enclosure === 'quote') quoted.push(span);
    // Only quote- or colon-enclosed content is fully exempt; trailing content after the request keeps its retraction,
    // negation and joke checks (Codex P1).
    if (enclosure === 'after-request') trailing.push(span);
    contentFrame = withoutSpan(contentFrame, span);
  }
  const words = entry.actionGrounding ?? [];
  const when = typeof args.when === 'string' ? args.when : undefined;
  const veto = nlRequestVeto(vetoFrame, words, NL_ACTION_WORDS, { content, quoted, trailing, ...(when !== undefined ? { when } : {}) });
  // For a target entry an item-source noun is part of the reference; a payload entry has no reference.
  const payload = entry.args.some((spec) => spec.kind === 'span' && spec.required === true);
  let expressesAction = nlFrameExpressesAction(contentFrame, !payload);
  if (entry.args.length === 0 && words.length > 0) {
    // A6-D3a amendment 1, undo confirmation rule: the undo needs one of its own words (a bare 돌려 is "give back": "돈 좀
    // 돌려줘") and no dative recipient ("친구한테 책 돌려줘"). Whether it executes directly or asks a confirmation is decided
    // at the message level by `nlUndoIsDirect` (undo-confirm.ts); no token heuristics here.
    const frameText = normalizeForMatch(contentFrame);
    const anchored = words.some((raw) => {
      const word = normalizeForMatch(raw);
      if (word === '돌려') return /되돌려/u.test(frameText);
      return /^[a-z ]+$/u.test(word) ? new RegExp(`(?<![a-z])${word.replace(/ /g, '\\s+')}(?![a-z])`, 'u').test(frameText) : frameText.includes(word);
    });
    expressesAction &&= anchored && !DATIVE.test(contentFrame);
  }
  return { ...(veto !== undefined ? { veto } : {}), expressesAction };
}

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
  // A6-D3a amendment 1 (owner-approved direction 2026-10-16): a LOCAL_WRITE the selector chose runs unless the owner's own
  // sentence is not a request. No request verb or closed request form is needed; the structural vetoes decide (chat), and
  // a frame with nothing but references ("2번도", "그걸로요", "13번 알림") or nothing but content ("내일 9시 우유")
  // expresses no action.
  if (entry.risk === 'LOCAL_WRITE') {
    const shape = requestShapeOf(entry, args, ctx.groundingText, ctx.requestFrame);
    if (shape.unbalancedSpan !== undefined) return { ok: false, reason: 'invalid-arg', entryId, arg: shape.unbalancedSpan };
    if (shape.veto !== undefined) return { ok: false, reason: 'not-request', entryId, arg: shape.veto };
    if (!shape.expressesAction) return { ok: false, reason: 'ungrounded', entryId, arg: 'action' };
  }
  // A6-D3 (A6 R1 fix): a payload made only of deictic, ordinal or time words gets its fixed reply ("내용을 직접 적어
  // 주세요") before any missing argument is named: "그거 알림으로 만들어줘" has no time either, and the content is the problem.
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (spec.kind === 'span' && spec.allowsTimeWords !== true && typeof value === 'string' && isNlDeicticOnlyPayload(value)) return { ok: false, reason: 'deictic-payload', entryId, arg: spec.name };
  }
  for (const spec of entry.args) {
    if (spec.required === true && args[spec.name] === undefined) return { ok: false, reason: 'missing-arg', entryId, arg: spec.name };
  }
  // (4) symbolic time
  let range: NlResolvedRange | undefined;
  const rangeSpec = entry.args.find((spec) => spec.kind === 'range');
  // The weekdays the owner's words name, outside a value that may legitimately be one (a sender called "월요일").
  const mentions: readonly NlWeekdayMention[] = rangeSpec !== undefined ? nlWeekdayMentions(withoutNameValues(entry, args, ctx.groundingText), entry.aliases) : [];
  if (rangeSpec !== undefined) {
    // A weekday symbol that names the same day as the owner's own week word is spelled the owner's way ("금요일" = fri,
    // never this-fri when both are this Friday): a canonical form, never another day (calendar-accuracy note).
    const given = args[rangeSpec.name];
    if (typeof given === 'string') {
      const previousRange = ctx.previousArgs?.[rangeSpec.name];
      args[rangeSpec.name] = nlCanonicalWeekdaySymbol(given, nlSingleWeekday(mentions), typeof previousRange === 'string' ? previousRange : undefined, ctx.now, ctx.timeZone);
    }
    const symbol = typeof args[rangeSpec.name] === 'string' ? (args[rangeSpec.name] as string) : typeof rangeSpec.default === 'string' ? rangeSpec.default : undefined;
    if (symbol !== undefined) {
      if (symbol === 'upcoming' && rangeSpec.allowUpcoming !== true) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
      range = resolveNlRange(symbol, ctx.now, ctx.timeZone);
      if (range === undefined) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
      if (rangeSpec.pastOnly === true && Date.parse(range.from) > Date.parse(ctx.now)) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
    }
  }
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
    // A6-D2: a ref needs a numeral, ordinal or deictic in this turn's own words (a determiner + noun only for the entry's
    // own source, and 저 only for a read).
    if (spec.kind === 'ref') {
      const ref = parseNlRef(value);
      const target = isNlActionEntryId(entryId) ? { entryId, source: nlActionSourceOf(entryId, args) } : undefined;
      if (ref === undefined || !isNlRefGrounded(ref, groundingText, target)) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (containsCredentialMaterial(value)) return { ok: false, reason: 'credential', entryId, arg: spec.name };
  }
  // (4b) the owner's weekday is a fact about the period: a period that drops or changes it never validates (after the
  // per-arg checks, so a weekday keyword still fails as `time-keyword`).
  const weekday = nlSingleWeekday(mentions);
  // (4b, A7) an `until-*` period needs the owner's inclusive end bound on that weekday and ends on that day; a
  // period that holds such a bounded day but does not end on it ("금요일까지" read as `fri` or `this-week`) is spelled as
  // the grounded `until-*` symbol ending on that day, else refused. Several weekdays with an end bound ("목요일부터
  // 토요일까지") need a period from the start-bounded day to the end-bounded day. A period that looks back (mail, Jira
  // created / updated) never takes an `until-*` symbol and keeps the A5 rule unchanged.
  const rangeValue = rangeSpec !== undefined ? args[rangeSpec.name] : undefined;
  if (rangeSpec !== undefined) {
    const lookingBack = rangeSpec.pastOnly === true || rangeSpec.pastWindow?.(args) === true;
    if (lookingBack) {
      if (typeof rangeValue === 'string' && nlUntilSymbolWeekday(rangeValue) !== undefined) return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
    } else if (weekday?.boundConflict === true) {
      // The mentions disagree on the bound or, with a bound, on the week: no reading is inferred, every period asks.
      return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
    } else if (weekday === undefined && mentions.length > 0) {
      // Several weekdays: the exact span, or (both bounds explicit) the one allowed span inside the selected period.
      const multi = nlMultiWeekdayBound(range, mentions, ctx.now, ctx.timeZone);
      if (multi === 'refuse') return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
      if (typeof multi === 'object') {
        args[rangeSpec.name] = multi.canonical;
        range = resolveNlRange(multi.canonical, ctx.now, ctx.timeZone);
      } else if (multi === 'n/a' && typeof rangeValue === 'string' && nlUntilSymbolWeekday(rangeValue) !== undefined) {
        // Several weekdays without one end-bounded span: an `until-*` symbol has nothing to stand on.
        return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
      }
    } else if (typeof rangeValue === 'string') {
      const previousRange = ctx.previousArgs?.[rangeSpec.name];
      const until = nlUntilBound(rangeValue, range, weekday, typeof previousRange === 'string' ? previousRange : undefined, ctx.now, ctx.timeZone);
      if (until === 'refuse') return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
      if (until !== 'keep') {
        args[rangeSpec.name] = until.canonical;
        range = resolveNlRange(until.canonical, ctx.now, ctx.timeZone);
      }
    }
  }
  if (rangeSpec !== undefined && weekday !== undefined) {
    // A weekday inside a grounded title keyword with other words ("수요일 스터디", "sunday school") may be part of the
    // title (A5 rule 6: real title keywords stay), so it is uncertain: another single day is still refused.
    // A keyword that only hides the period ("수요일 회의" with the whole next week) is not a title and stays refused.
    const titled = entry.args.some((spec) => {
      const value = args[spec.name];
      return spec.kind === 'keyword' && typeof value === 'string' && nlKeywordIsTitle(value, weekday.weekday, entry.aliases);
    });
    if (!nlRangeKeepsWeekday(range, titled ? { ...weekday, certain: false } : weekday, ctx.now, ctx.timeZone)) {
      return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
    }
  }
  // A6: the entry's own check after the per-arg checks.
  if (entry.check !== undefined) {
    const failure = entry.check(args, groundingText);
    if (failure !== undefined) {
      return {
        ok: false,
        reason: failure.reason,
        entryId,
        ...(failure.arg !== undefined ? { arg: failure.arg } : {}),
        ...(failure.askEntryId !== undefined ? { askEntryId: failure.askEntryId } : {}),
      };
    }
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

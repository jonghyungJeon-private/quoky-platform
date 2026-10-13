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
import { isGroundedIn, normalizeForMatch } from './selection-input';
import type { NlSelectionCandidate } from './selection-output';
import { isNlRangeSymbol, normalizeNlRangeSymbol, resolveNlRange, type NlResolvedRange } from './symbolic-time';

/**
 * Deterministic validation of a selector candidate (ADR-0120 D4, the ADR-0090 L2 policy), in order:
 *  (1) closed ids and the argument schema (unknown args rejected, closed values only);
 *  (2) the entry is offered in this turn's catalog (registered and configured) and is a READ entry (D5);
 *  (3) bounds: limit 1..10, keyword 1..100 characters;
 *  (4) a range is a symbol Core resolves with the turn's clock and `QUOKY_TIMEZONE` (at most 31 days);
 *  (5) grounding: a keyword appears verbatim in the owner's non-quoted text or in the previous selection's args;
 *  (6) the credential guard runs on every string arg.
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
  | 'credential';

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
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function validateSelection(candidate: NlSelectionCandidate, ctx: NlValidationContext): NlValidationResult {
  // (1) closed ids
  if (!isNlCatalogEntryId(candidate.entryId)) return { ok: false, reason: 'unknown-entry' };
  const entryId = candidate.entryId;
  // (2) offered (registered + configured) and READ only (wave 1)
  const entry = ctx.offered.get(entryId);
  if (entry === undefined) return { ok: false, reason: 'not-offered', entryId };
  if (entry.risk !== 'READ') return { ok: false, reason: 'not-read', entryId };
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
    }
  }
  // (5) grounding and (6) the credential guard, on every string arg
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (typeof value !== 'string') continue;
    if (spec.kind === 'enum' && spec.valueGrounding?.[value] !== undefined) {
      const text = normalizeForMatch(ctx.groundingText);
      const stated = (spec.valueGrounding[value] ?? []).some((word) => groundingWordIn(text, normalizeForMatch(word)));
      if (!stated && ctx.previousArgs?.[spec.name] !== value) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (spec.kind === 'keyword') {
      const previous = ctx.previousArgs?.[spec.name];
      const fromPrevious = typeof previous === 'string' && previous === value;
      if (!fromPrevious && !isGroundedIn(value, ctx.groundingText)) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (containsCredentialMaterial(value)) return { ok: false, reason: 'credential', entryId, arg: spec.name };
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

/**
 * Search-term canonicalization (not routing): a trailing generic noun the selector sometimes keeps ("온보딩 문서" →
 * "온보딩", "정책 자료" → "정책") is dropped when words remain. The closed list names kinds of content, never a source or
 * a capability, so it cannot change which entry runs — only the search words.
 */
const GENERIC_TAIL = new Set(['문서', '문서들', '자료', '페이지', '파일', '관련', '얘기', '내용', '메시지', '건', '거', '것']);

function withoutGenericTail(keyword: string): string {
  const words = keyword.split(' ');
  while (words.length > 1 && GENERIC_TAIL.has(words[words.length - 1] as string)) words.pop();
  return words.join(' ');
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
      const keyword = withoutGenericTail(value.normalize('NFC').replace(/\s+/g, ' ').trim());
      const length = Array.from(keyword).length;
      if (length === 0 || length > NL_KEYWORD_MAX_CHARS || CONTROL.test(keyword)) return undefined;
      return keyword;
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

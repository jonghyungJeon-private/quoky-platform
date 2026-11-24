import type { NlCatalogEntry, NlWave1EntryId } from '../nl-routing/catalog';
import { NL_MODE_SUMMARY_WORDS, withoutStructures } from '../nl-routing/action-entries';
import { nlClauseNamesEntry, nlClauses, type NlClause } from '../nl-routing/clause-flags';
import { nlHasExclusionOrNegation } from '../nl-routing/request-shape';
import { NL_FENCED_PLACEHOLDER, NL_QUOTED_PLACEHOLDER, nlPreparedWithoutFilesLine, normalizeForMatch, type PreparedSelectionInput } from '../nl-routing/selection-input';
import { groundingWordIn, nlItemReadVeto } from '../nl-routing/selection-validator';
import { AGENT_READ_SOURCES, summaryReadoutLabel } from './flow-policy';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';

/**
 * ADR-0121 S2 wiring slice: the summary grant PRODUCER (P3-3b owner answer 2 of 2026-11-03, "Summary grant derivation").
 *
 * Core derives, per `summarize` step and per covered source whose content is `REMOTE_ON_SUMMARY_REQUEST` (mail, Drive;
 * ADR-0118 D7; and, since A5-S3, the five work sources calendar, Jira, Slack, Confluence and GitHub through
 * `summaryReadoutLabel`), whether the OWNER'S OWN WORDS ask for a summary of that source. The result is an opaque
 * {@link SummaryGrantBasis} bound to one validated plan; the executor hands it to `summaryGrantFor`, which mints the actual
 * `SummaryEgressGrant` through the module-private `mintGrant`, keyed to the run token of that one `execute` call.
 *
 * - **Never a caller flag, never the planner's step.** There is no boolean to pass: the only input is the owner's prepared
 *   text (`prepareSelectionInput`: quoted lines, fenced blocks and platform quote ranges are placeholders, attachments a
 *   count line) and the validated plan, whose `summarize` step only says WHICH summary exists, never that it was asked for. A
 *   forged or foreign basis is not in the module-private store and grants nothing.
 * - **No untrusted span at all (review round 2, fail closed).** When the owner's text holds ANY untrusted-span marker
 *   ({@link hasUntrustedSpanMarker}: a quote-like glyph or apostrophe, a backtick, a quoted or fenced placeholder, a URL-like
 *   token, a divider run, a header shape), no grant is minted for the message: every summary is listing-only. Nothing is
 *   stripped and re-read: there is no span boundary to get wrong. Pasted structures ({@link withoutStructures}) are still set
 *   aside, and a relayed request ("팀장이 3번 요약해달래", {@link nlItemReadVeto}) grants nothing.
 * - **The existing approved vocabulary.** The summary words are {@link NL_MODE_SUMMARY_WORDS} (A6 R2 ratification record C,
 *   the words that state `item.summarize`'s `summary` mode); no word list of its own.
 * - **Per source, by clause (fail closed).** The prose is cut into the S2 conjuncts with the verb connective
 *   ({@link nlClauses}); a conjunct that ends in a glued coordinating particle joins the next one, because coordinated nouns
 *   share one predicate ("메일이랑 드라이브 요약해줘"; "-하고" only on a source name, "메일하고", since "확인하고" is a verb). A source is granted when a group that holds an
 *   unnegated summary word (no exclusion or negation marker in the group, {@link nlHasExclusionOrNegation}) names it
 *   ({@link nlClauseNamesEntry}); or when that group names no source of the plan at all ("메일 3개 보여주고 요약해줘") and every
 *   source the owner named anywhere is covered by this summary step. Anything else (another source's clause, a comma or
 *   "and" between a noun and the summary verb in English word order) grants nothing: the summary is listing-only, never a
 *   wrong egress.
 */

/** The owner's text as `prepareSelectionInput` prepared it: `text` (line breaks and placeholders kept) and `groundingText`. */
export type OwnerText = Pick<PreparedSelectionInput, 'text' | 'groundingText'>;

/**
 * Review rounds 2 and 3 (fail closed): the closed structural classes that mark a span the owner may not have written as a
 * request. No vocabulary: Unicode categories, glyph classes and shapes only. The text is the prepared text with its line
 * breaks kept (`[files: N]` line removed), so the line-start rules read real lines. Every rule is tested on four forms: as
 * written, NFKC (fullwidth and compatibility forms fold), with every format character (`\p{Cf}`: zero-width and direction
 * marks) removed, and both.
 */
/** Colon-like characters: ASCII, fullwidth, ratio, modifier-letter colons, Hebrew sof pasuq, small/vertical/presentation forms, two-dot punctuation, Syriac and Mongolian colons, the Z-notation type colon and the IPA length mark. */
const COLON = '[:：∶꞉˸׃﹕︓︰⁚܃܄᠄⦂ː]';
const DOT = '[.。｡．]';
const SLASH = '[/／⁄∕]';
const CLOCK = `\\d{1,2}${COLON}\\d{2}`;
/**
 * A quote-like glyph: every initial and final quote (`\p{Pi}`, `\p{Pf}`), every opening and closing bracket (`\p{Ps}`,
 * `\p{Pe}`) except ASCII ( ) [ ] { } (ordinary in owner prose; a bracketed chat speaker or time is the chat-frame rule), ASCII
 * quotes and apostrophe, backtick and acute, primes, the modifier-letter quotes and accents, Hebrew geresh and gershayim,
 * dingbat and ornamental quotes.
 */
const QUOTE_GLYPH = /[\p{Pi}\p{Pf}"'`´′″‴‵‶‷ʹʺʻʼʽˊˋˮ˝׳״❛❜❝❞❟❠\u{1F676}-\u{1F678}]|(?![()[\]{}])[\p{Ps}\p{Pe}]/u;
const PLACEHOLDER = new RegExp(`${escapeRegExp(NL_FENCED_PLACEHOLDER)}|${escapeRegExp(NL_QUOTED_PLACEHOLDER)}`, 'u');
/**
 * A URL or host shape: a scheme separator or `www.` anywhere; a whitespace-free token with a dot or a colon before a slash
 * (`x.io/…`, `127.0.0.1:8080/…`, `localhost:8080/…`); a dotted IPv4; a dotted host whose TLD is any two or more letters (any
 * script).
 */
const URL_SHAPES: readonly RegExp[] = [
  new RegExp(`${COLON}${SLASH}{2}|www${DOT}`, 'iu'),
  new RegExp(`(?:${DOT}|${COLON})\\S*?${SLASH}`, 'u'),
  new RegExp(`\\d{1,3}(?:${DOT}\\d{1,3}){3}`, 'u'),
  new RegExp(`[\\p{L}\\p{N}-]${DOT}\\p{L}{2,}`, 'u'),
];
/**
 * Header shapes: at a line start, a label (an optional leading `@`: a mention-prefixed speaker, review round 4) of up to three tokens whose last token holds a letter and is IMMEDIATELY followed by
 * a colon-like character (`Subject:`, `Original-Message:`, `보낸 사람:`; a time `3:30` holds no letter); anywhere, a token of
 * one to three Latin, Cyrillic or Greek letters immediately followed by one (`Fwd:`, `RE:`; `ok :)` has a space first).
 */
const HEADER_SHAPES: readonly RegExp[] = [
  new RegExp(`^[ \\t]*@?(?:[\\p{L}\\p{N}_-]+[ \\t]){0,2}(?=[\\p{L}\\p{N}_-]*\\p{L})[\\p{L}\\p{N}_-]{1,30}${COLON}`, 'mu'),
  new RegExp(`(?<![\\p{L}\\p{N}])[\\p{sc=Latin}\\p{sc=Cyrillic}\\p{sc=Greek}]{1,3}${COLON}`, 'u'),
];
/**
 * Chat-copy framing at a line start: a bracketed speaker followed by another bracket (`[name] [time] …`), a bracketed time,
 * `name — time` (an em dash, en dash or horizontal bar with a clock within the next words), and `name, [time]`.
 */
const CHAT_FRAMES: readonly RegExp[] = [
  /^[ \t]*\[[^\]\n]{1,30}\][ \t]*\[/mu,
  new RegExp(`^[ \\t]*\\[[^\\]\\n]*${CLOCK}[^\\]\\n]*\\]`, 'mu'),
  new RegExp(`^[^\\n]{1,40}?[ \\t][—–―][ \\t][^\\n]{0,24}?${CLOCK}`, 'mu'),
  new RegExp(`^[^\\n]{1,40}?,[ \\t]*\\[[^\\]\\n]*${CLOCK}[^\\]\\n]*\\]`, 'mu'),
];
/** A divider run: three or more of the same punctuation or symbol character, at most one space apart. */
const DIVIDER_RUN = /([\p{P}\p{S}])(?:[ \t]?\1){2,}/gu;
/** Run characters of ordinary emphasis (. ~ 〜 … ! ? and emoji): a divider only when the line holds nothing else. */
const SOFT_RUN_CHAR = /^[.~〜…!?\p{Extended_Pictographic}]$/u;
const SOFT_LINE = /^[.~〜…!?\p{Extended_Pictographic}\s]*$/u;

function hasDividerLine(text: string): boolean {
  for (const line of text.split('\n')) {
    for (const run of line.matchAll(DIVIDER_RUN)) {
      if (!SOFT_RUN_CHAR.test(run[1] ?? '') || SOFT_LINE.test(line)) return true;
    }
  }
  return false;
}

function hasMarkerIn(text: string): boolean {
  return (
    QUOTE_GLYPH.test(text) ||
    PLACEHOLDER.test(text) ||
    URL_SHAPES.some((shape) => shape.test(text)) ||
    HEADER_SHAPES.some((shape) => shape.test(text)) ||
    CHAT_FRAMES.some((shape) => shape.test(text)) ||
    hasDividerLine(text)
  );
}

/**
 * Whether the owner's prepared text holds any untrusted-span marker, in any of its four forms (as written, NFKC, without
 * format characters, both). The `[files: N]` line the preparation appends is not the owner's and is removed first. Pure.
 */
export function hasUntrustedSpanMarker(text: string): boolean {
  const own = nlPreparedWithoutFilesLine(text);
  const bare = own.replace(/\p{Cf}/gu, '');
  return [own, own.normalize('NFKC'), bare, bare.normalize('NFKC')].some((form) => hasMarkerIn(form));
}

/** Any line break the preparation may leave: LF, CR, the Unicode line and paragraph separators, NEL, VT and FF. */
const LINE_BREAK = /[\n\r\u2028\u2029\u0085\v\f]/u;

/**
 * Review round 4: whether the owner's prepared text, without the appended `[files: N]` line and trimmed, holds exactly one
 * non-empty line. A multi-line message never mints a summary grant (fail closed). Pure.
 */
export function isSingleLineOwnerText(text: string): boolean {
  return nlPreparedWithoutFilesLine(text).trim().split(LINE_BREAK).filter((line) => line.trim().length > 0).length === 1;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

declare const BASIS_BRAND: unique symbol;
/** The owner's summary requests for ONE validated plan. Opaque: only {@link summaryGrantBasis} makes one. */
export interface SummaryGrantBasis {
  readonly [BASIS_BRAND]: true;
}

/** One granted (summarize step, source entry) pair. */
export interface OwnerSummaryRequest {
  /** The 1-based number of the `summarize` step. */
  readonly step: number;
  readonly entryId: NlWave1EntryId;
}

type StepsPlan = Extract<ValidatedAgentPlan, { readonly steps: readonly ValidatedAgentStep[] }>;

const BASES = new WeakMap<object, { readonly plan: object; readonly asked: ReadonlySet<string> }>();

const keyOf = (step: number, entryId: string): string => `${step}:${entryId}`;

/**
 * The (summarize step, source) pairs the owner's own words ask a summary of, for the sources that need a grant
 * (`REMOTE_ON_SUMMARY_REQUEST` under {@link summaryReadoutLabel}: mail, Drive and, since A5-S3, the five work sources). Pure and total; `[]` for anything but a validated `run` plan.
 */
export function ownerSummaryRequests(plan: ValidatedAgentPlan, prepared: OwnerText): readonly OwnerSummaryRequest[] {
  if (plan.kind !== 'run') return [];
  let owner: string;
  try {
    // Review round 4: a multi-line message never grants (the whole multi-line paste family, structurally); review round 2:
    // any untrusted-span marker anywhere in a single-line message, and it grants nothing either (fail closed).
    if (!isSingleLineOwnerText(prepared.text) || hasUntrustedSpanMarker(prepared.text)) return [];
    const groundingText = prepared.groundingText;
    // A relayed request is never the owner's own (the existing A6 R2 veto of a reported summary request).
    if (nlItemReadVeto(groundingText) !== undefined) return [];
    owner = withoutStructures(groundingText);
  } catch {
    return [];
  }
  if (owner.length === 0) return [];
  const readEntries = new Map<number, NlCatalogEntry>();
  for (const [index, step] of plan.steps.entries()) if (step.kind === 'read') readEntries.set(index + 1, step.entry);
  const planEntries = [...new Map([...readEntries.values()].map((entry) => [entry.id, entry] as const)).values()];
  const names = new Set(planEntries.flatMap((entry) => [...entry.aliases, ...(entry.sourceNames ?? [])].map((name) => normalizeForMatch(name))));
  const groups = predicateGroups(nlClauses(owner), names);
  const asking = groups.filter((group) => asksSummary(group));
  if (asking.length === 0) return [];
  const named = new Set(planEntries.filter((entry) => groups.some((group) => nlClauseNamesEntry(group, entry))).map((entry) => entry.id));

  const out: OwnerSummaryRequest[] = [];
  for (const [index, step] of plan.steps.entries()) {
    if (step.kind !== 'summarize') continue;
    const number = index + 1;
    const covered = new Set(step.from.flatMap((from) => {
      const entry = readEntries.get(from);
      return entry === undefined ? [] : [entry.id];
    }));
    for (const entryId of covered) {
      const entry = planEntries.find((candidate) => candidate.id === entryId);
      if (entry === undefined || !needsGrant(entryId)) continue;
      const direct = asking.some((group) => nlClauseNamesEntry(group, entry));
      // A summary clause that names no source of the plan points back at what the owner named, only when every source the
      // owner named is one this summary covers (otherwise it is ambiguous which one: no grant).
      const backReference =
        named.has(entryId) &&
        [...named].every((id) => covered.has(id)) &&
        asking.some((group) => planEntries.every((candidate) => !nlClauseNamesEntry(group, candidate)));
      if (direct || backReference) out.push({ step: number, entryId: entryId as NlWave1EntryId });
    }
  }
  return out;
}

/** The opaque basis for one validated plan (see {@link ownerSummaryRequests}); it grants only for that very plan object. */
export function summaryGrantBasis(plan: ValidatedAgentPlan, prepared: OwnerText): SummaryGrantBasis {
  const basis = Object.freeze({}) as SummaryGrantBasis;
  const asked = new Set(ownerSummaryRequests(plan, prepared).map((request) => keyOf(request.step, request.entryId)));
  BASES.set(basis, { plan, asked });
  return basis;
}

/**
 * Whether `basis` (made by {@link summaryGrantBasis} for exactly `plan`) holds the owner's summary request for this step and
 * source. A forged object, a basis of another plan or an absent one answers `false`.
 */
export function ownerAskedSummary(basis: SummaryGrantBasis | undefined, plan: object | undefined, step: number, entryId: NlWave1EntryId): boolean {
  if (basis === undefined || plan === undefined || typeof basis !== 'object' || basis === null) return false;
  const known = BASES.get(basis);
  return known !== undefined && known.plan === plan && known.asked.has(keyOf(step, entryId));
}

function needsGrant(entryId: string): boolean {
  try {
    return summaryReadoutLabel(entryId as NlWave1EntryId).egress === 'REMOTE_ON_SUMMARY_REQUEST';
  } catch {
    return false;
  }
}

/**
 * Conjuncts joined across a glued coordinating particle: coordinated nouns share the next predicate. "-랑" always coordinates
 * nouns; "-하고" is also the verb connective ("확인하고", "정리하고"), so it joins only when the rest of the word is exactly a
 * name of one of the plan's sources ("메일하고"). Anything else stays its own group (fail closed: never a wider grant).
 */
function predicateGroups(clauses: readonly NlClause[], sourceNames: ReadonlySet<string>): NlClause[] {
  const groups: NlClause[] = [];
  let pending: NlClause | undefined;
  for (const clause of clauses) {
    const merged: NlClause =
      pending === undefined
        ? clause
        : { text: `${pending.text} ${clause.text}`, normalized: `${pending.normalized} ${clause.normalized}`, words: [...pending.words, ...clause.words] };
    const last = merged.words[merged.words.length - 1];
    if (last?.ends === 'particle' && coordinatesNouns(last.word, sourceNames)) {
      pending = merged;
      continue;
    }
    groups.push(merged);
    pending = undefined;
  }
  if (pending !== undefined) groups.push(pending);
  return groups;
}

function coordinatesNouns(word: string, sourceNames: ReadonlySet<string>): boolean {
  const bare = word.replace(/[,،]$/u, '');
  if (/랑$/u.test(bare)) return true;
  return /하고$/u.test(bare) && sourceNames.has(bare.slice(0, -2));
}

/** A group asks for a summary: one of the approved summary words, and no exclusion or negation marker in it (fail-safe). */
function asksSummary(group: NlClause): boolean {
  if (nlHasExclusionOrNegation(group.text)) return false;
  return NL_MODE_SUMMARY_WORDS.some((word) => {
    const normalized = normalizeForMatch(word);
    return groundingWordIn(group.normalized, normalized) || splitParticleIn(group, normalized);
  });
}

/** The most words a separated phrasal verb may hold between its verb and its particle ("sum all of them up"). */
const SEPARABLE_OBJECT_WORDS = 3;

/**
 * ADR-0121 A5-S3, the separable particle of an existing summary word (a clause-structure rule, no new vocabulary): a summary
 * word of exactly two ASCII words, a verb and its particle ("sum up"), also counts when the clause holds the verb and ends in
 * the particle with one to {@link SEPARABLE_OBJECT_WORDS} words between them (its object: "sum them up", "sum it up"). The
 * particle must be the LAST word of the clause (an object after the particle is the contiguous form, already matched), and the
 * clause's own exclusion and negation check has run before this. Fail closed: any other shape is not a request.
 */
function splitParticleIn(group: NlClause, word: string): boolean {
  const parts = word.split(' ');
  if (parts.length !== 2 || !parts.every((part) => /^[a-z]+$/u.test(part))) return false;
  const [verb, particle] = parts as [string, string];
  const words = group.words.map((token) => token.word.replace(/[,،.!?]+$/u, ''));
  if (words[words.length - 1] !== particle) return false;
  const last = words.length - 1;
  return words.some((token, index) => token === verb && last - index - 1 >= 1 && last - index - 1 <= SEPARABLE_OBJECT_WORDS);
}

/** The gated source names of one summarize step, for the one consent question (W5 as amended by A5): each once, sorted. */
export interface OwnerSummaryConsentSources {
  readonly step: number;
  readonly sources: readonly string[];
}

/**
 * ADR-0121 A5.4 (W5 amended): per summarize step, the source names the owner's words granted (the five work sources
 * included), derived only from {@link ownerSummaryRequests}; the data of the ONE rule-① question of that step. Pure.
 */
export function ownerSummaryConsentSources(plan: ValidatedAgentPlan, prepared: OwnerText): readonly OwnerSummaryConsentSources[] {
  const byStep = new Map<number, Set<string>>();
  for (const request of ownerSummaryRequests(plan, prepared)) {
    const source = AGENT_READ_SOURCES[request.entryId]?.source;
    if (source === undefined) continue;
    byStep.set(request.step, (byStep.get(request.step) ?? new Set<string>()).add(source));
  }
  return [...byStep].map(([step, sources]) => ({ step, sources: [...sources].sort() }));
}

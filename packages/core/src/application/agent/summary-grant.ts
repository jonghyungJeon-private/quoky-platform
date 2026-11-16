import type { NlCatalogEntry, NlWave1EntryId } from '../nl-routing/catalog';
import { NL_MODE_SUMMARY_WORDS, withoutStructures } from '../nl-routing/action-entries';
import { nlClauseNamesEntry, nlClauses, type NlClause } from '../nl-routing/clause-flags';
import { nlHasExclusionOrNegation } from '../nl-routing/request-shape';
import { NL_FENCED_PLACEHOLDER, NL_QUOTED_PLACEHOLDER, normalizeForMatch, type PreparedSelectionInput } from '../nl-routing/selection-input';
import { groundingWordIn, nlItemReadVeto } from '../nl-routing/selection-validator';
import { readOutputLabel } from './flow-policy';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';

/**
 * ADR-0121 S2 wiring slice: the summary grant PRODUCER (P3-3b owner answer 2 of 2026-11-03, "Summary grant derivation").
 *
 * Core derives, per `summarize` step and per covered source whose content is `REMOTE_ON_SUMMARY_REQUEST` (mail, Drive;
 * ADR-0118 D7), whether the OWNER'S OWN WORDS ask for a summary of that source. The result is an opaque
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
 * Review round 2 (fail closed): the closed structural classes that mark a span the owner may not have written as a request.
 * No vocabulary: glyph classes and shapes only. Each is tested on the text as written and on its NFKC form (fullwidth and
 * compatibility forms fold onto the ASCII ones).
 */
const UNTRUSTED_SPAN_MARKERS: readonly RegExp[] = [
  // Any quote-like glyph: initial/final quote punctuation (“ ” ‘ ’ « » ‹ ›), the low-9 quotes, ASCII and fullwidth quotes and
  // apostrophes, backticks and the acute accent, primes, the modifier-letter apostrophes, dingbat quotes, and the CJK and
  // angle brackets used as quotes. ASCII ( ) [ ] { } are not quotes (pasted structures are set aside separately).
  /[\p{Pi}\p{Pf}"'`´＂＇｀‚„′″‴‵‶‷ʹʺʻʼʽˮ❛❜❝❞「」『』｢｣《》〈〉【】〔〕〖〗〘〙〚〛〝〞〟⟨⟩]/u,
  // The input preparation's own placeholders: a fenced block or a quoted line / platform quote range was in the message.
  new RegExp(`${escapeRegExp(NL_FENCED_PLACEHOLDER)}|${escapeRegExp(NL_QUOTED_PLACEHOLDER)}`, 'u'),
  // A URL-like token: any scheme separator, `www.`, a dotted host with a letter TLD (path or not: a label can carry a word),
  // or a host with a port and a path.
  /:\/\/|www\.|[\p{L}\p{N}-][.。｡][A-Za-z]{2,}(?![A-Za-z])|[A-Za-z]:\d{1,5}\//iu,
  // A divider run: three or more of - _ = ~ * or a Unicode dash, optionally one space apart ("-----", "- - -").
  /(?:[-_=~*\u2010-\u2015\u2212\u2500\u2501][ \t]?){2,}[-_=~*\u2010-\u2015\u2212\u2500\u2501]/u,
  // A header shape: a Latin token of at most 3 letters and a colon anywhere (Fwd:, Fw:, RE:, AW:, WG:) ...
  /(?<![\p{L}\p{N}])[A-Za-z]{1,3}[ \t]*:/u,
  // ... or, at the start of the text or of a line, a short label holding a letter and a colon ("Subject:", "보낸 사람:"); a time
  // ("3:30") is no label.
  /(?:^|\n)[ \t]*(?=[\p{N}_ \t]*\p{L})[\p{L}\p{N}_][\p{L}\p{N}_ \t]{0,30}:/u,
];

/** Whether the owner's prepared text holds any untrusted-span marker (as written or in its NFKC form). Pure. */
export function hasUntrustedSpanMarker(text: string): boolean {
  const folded = text.normalize('NFKC');
  return UNTRUSTED_SPAN_MARKERS.some((marker) => marker.test(text) || marker.test(folded));
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
 * (`REMOTE_ON_SUMMARY_REQUEST`). Pure and total; `[]` for anything but a validated `run` plan.
 */
export function ownerSummaryRequests(plan: ValidatedAgentPlan, prepared: OwnerText): readonly OwnerSummaryRequest[] {
  if (plan.kind !== 'run') return [];
  let owner: string;
  try {
    // Review round 2: any untrusted-span marker anywhere in the owner's text, and the message grants nothing (fail closed).
    if (hasUntrustedSpanMarker(prepared.text)) return [];
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
    return readOutputLabel(entryId as NlWave1EntryId).egress === 'REMOTE_ON_SUMMARY_REQUEST';
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
  return NL_MODE_SUMMARY_WORDS.some((word) => groundingWordIn(group.normalized, normalizeForMatch(word)));
}

import type { NlCatalogEntry, NlWave1EntryId } from '../nl-routing/catalog';
import { NL_MODE_SUMMARY_WORDS, withoutStructures } from '../nl-routing/action-entries';
import { nlClauseNamesEntry, nlClauseStringValues, nlClauses, type NlClause } from '../nl-routing/clause-flags';
import { unexpressedContentWords } from '../nl-routing/grammar-residual';
import { nlHasExclusionOrNegation } from '../nl-routing/request-shape';
import { NL_FENCED_PLACEHOLDER, NL_QUOTED_PLACEHOLDER, nlPreparedWithoutFilesLine, normalizeForMatch, prepareSelectionInput, type PreparedSelectionInput } from '../nl-routing/selection-input';
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
export type OwnerText = Pick<PreparedSelectionInput, 'text' | 'groundingText'> & {
  /**
   * ADR-0121 A6.5 (A6-S3): the owner's RAW message text, before `prepareSelectionInput`. Only the two-line rule reads it (its
   * separator and format-character check must see what the preparation's whitespace collapse would absorb). Absent: the
   * two-line form is never recognised (fail closed), a single-line message is unaffected.
   */
  readonly rawText?: string;
};

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

/**
 * ADR-0121 A6.5 (A6-S3, ratified 2026-11-23 with AM-1 and AM-3): only a bare LF separates the two lines of an owner request.
 * Any other line or paragraph separator ANYWHERE in the RAW text (CR, so CRLF too; U+2028; U+2029; NEL U+0085; VT; FF) and any
 * format character (`\p{Cf}`: zero-width, bidi override, soft hyphen, BOM) means it is not the two-line form. It is checked on
 * the raw text because the preparation's whitespace collapse around an LF would absorb all of them but NEL.
 */
const NON_LF_SEPARATOR = /[\r\u2028\u2029\u0085\v\f\p{Cf}]/u;

/**
 * A6.5 (review round 3, P3 c): the A6.5-LOCAL closed-class completion. The shared residue guard (`grammar-residual.ts`, also used
 * by calendar-question.ts and work-chat-command.ts) is NOT changed; its English function class holds the singular deictic
 * pronouns but not the plural ones, which the producer's back-reference ("please summarize them") needs. No request word, no
 * source, no topic.
 */
const PLURAL_DEICTIC_COMPLETION: readonly string[] = ['them', 'these', 'those'];

/** The two non-empty lines of the RAW owner text, or `undefined` when it is not the two-line form (A6.5 item 1). Pure. */
function rawTwoLines(raw: string): readonly string[] | undefined {
  if (NON_LF_SEPARATOR.test(raw)) return undefined;
  // A6.5 item 1: "blank lines between them do not count". Only an empty or ASCII space/tab line is blank; a line of any other
  // whitespace (NBSP, U+3000, ...) is invisible content A6.5 does not name as blank, so it counts as a line and fails closed.
  const lines = raw.split('\n').filter((line) => !/^[ \t]*$/u.test(line));
  return lines.length === 2 ? lines : undefined;
}

/** A unit as the residue guard removes it: a Latin unit as a whole word (plural or possessive allowed), a Korean one inside a token. */
const unitPattern = (unit: string): RegExp =>
  /^[a-z0-9 ;.-]+$/u.test(unit) ? new RegExp(`(?<![a-z0-9])${escapeRegExp(unit)}(?:s|['’]s)?(?![a-z0-9])`, 'u') : new RegExp(escapeRegExp(unit), 'u');

/**
 * A6.5 item 3: the spans the producer RECOGNISES as the request for one validated plan, and nothing else: the names of its read
 * sources (`aliases`, `sourceNames`, as `nlClauseNamesEntry` reads them); the scope of each validated read step (Core's own label,
 * `entry.describe` of its validated args in both languages, matched as ONE WHOLE PHRASE with only a recognised source name allowed
 * between its words, plus the label's head noun, plus the step's validated string values); the validated count of a read step
 * (AM-3); and the approved summary words (`NL_MODE_SUMMARY_WORDS`). Listing verbs, particles, politeness endings and function
 * words are NOT units: they are the closed classes of the residue guard.
 */
function recognisedUnits(plan: StepsPlan): RegExp[] {
  const reads = plan.steps.flatMap((step) => (step.kind === 'read' ? [step] : []));
  const units = new Set<string>(NL_MODE_SUMMARY_WORDS.map((word) => normalizeForMatch(word)));
  const names = new Set<string>();
  const labels = new Set<string>();
  for (const step of reads) {
    for (const name of [...step.entry.aliases, ...(step.entry.sourceNames ?? [])]) {
      units.add(normalizeForMatch(name));
      names.add(normalizeForMatch(name));
    }
    for (const language of ['ko', 'en'] as const) labels.add(normalizeForMatch(step.entry.describe?.(step.args, step.range, language) ?? '').trim());
    // Fix round 1 (P2): a validated string value that itself holds an approved summary word is NOT a unit (a pasted line "김대리가
    // 요약해달라고" the selector kept as a keyword must not consume the line); string values are set aside before the summary-word
    // check, the same rule as `withClauseGroundedFlags` in plan-validator.ts. The single-line form is unchanged (recorded residual).
    for (const value of nlClauseStringValues(step.args)) if (!NL_MODE_SUMMARY_WORDS.some((word) => groundingWordIn(value, normalizeForMatch(word)))) units.add(value);
  }
  // A `describe` label is a WHOLE PHRASE, never split word by word: "안 읽은 메일" must not make "안" and "읽은" units.
  const gap = names.size === 0 ? '' : `(?:\\s+(?:${[...names].filter((n) => n.length > 0).sort((x, y) => y.length - x.length).map(escapeRegExp).join('|')}))*`;
  const phrase = (label: string): RegExp => {
    const words = label.split(/\s+/u).filter((w) => w.length > 0).map(escapeRegExp);
    const latin = /^[a-z0-9 ;.-]+$/u.test(label);
    return new RegExp(latin ? `(?<![a-z0-9])${words.join(`${gap}\\s+`)}(?:s|['’]s)?(?![a-z0-9])` : words.join(`${gap}\\s+`), 'u');
  };
  // The label's HEAD NOUN (its last word) is a unit of its own; its modifiers are not.
  for (const label of labels) {
    const head = label.split(/\s+/u).filter((w) => w.length > 0).at(-1);
    if (head !== undefined && label.includes(' ')) units.add(head);
  }
  const all = [...units].filter((unit) => unit.length > 0).map((unit) => [unit, unitPattern(unit)] as const);
  for (const label of labels) if (label.length > 0) all.push([label, phrase(label)] as const);
  for (const step of reads) all.push(...countUnits(step, names));
  return all.sort((a, b) => b[0].length - a[0].length).map(([, pattern]) => pattern);
}

/** The AM-3 count patterns: a line may carry at most one count token (`3개 3개` is two counts). */
const COUNT_UNITS = new WeakSet<RegExp>();

/**
 * AM-3 (ratified 2026-11-23): a validated numeric count of a read step is a recognised unit, written with its count word: the
 * numeral with a Korean counter (`개`, `건`) or, in English, the numeral directly before a recognised source name ("3 mails").
 * Only a value the VALIDATED plan carries counts: an arg of kind `limit` that is not transient (the "at most N results" bound,
 * never the `item` ordinal of `mail.list`). A numeral the plan does not carry stays residue. Which entries carry such an arg is
 * the catalog's own business (this adds none).
 */
function countUnits(step: Extract<ValidatedAgentStep, { readonly kind: 'read' }>, names: ReadonlySet<string>): (readonly [string, RegExp])[] {
  const sourceNames = [...names].filter((name) => /^[a-z0-9 .-]+$/u.test(name)).sort((x, y) => y.length - x.length).map(escapeRegExp);
  return step.entry.args.flatMap((spec) => {
    const value = step.args[spec.name];
    if (spec.kind !== 'limit' || spec.transient === true || typeof value !== 'number' || !Number.isInteger(value)) return [];
    // Review round 3 (structural, replaces the round-2 prefix list): a count is recognised only as a WHOLE whitespace-delimited token,
    // preceded by start-of-line or whitespace and followed by end-of-line or whitespace. Anything else is not a unit, so its digits stay
    // as `\p{N}` residue and the line is not consumed. Fail-closed residual: "메일3개", "3개," and "3개를" no longer count.
    const counted: (readonly [string, RegExp])[] = [[`${value}개`, new RegExp(`(?<=^|\\s)${value}\\s*(?:개|건)(?=$|\\s)`, 'u')]];
    if (sourceNames.length > 0) counted.push([`${value} ${sourceNames[0]} (count)`, new RegExp(`(?<=^|\\s)${value}\\s+(?:${sourceNames.join('|')})(?:s|['’]s)?(?=$|\\s)`, 'u')]);
    for (const [, pattern] of counted) COUNT_UNITS.add(pattern);
    return counted;
  });
}

/**
 * A6.5 items 2 and 3: a line is CONSUMED by the producer only when it passes every single-line marker check on its own, holds at
 * least one recognised unit, and after every recognised unit is removed the RESIDUE is empty or closed-class only
 * (`unexpressedContentWords`, plus the A6.5-local plural deictics). Any unexplained residue leaves the line unconsumed.
 */
function isConsumedLine(line: string, units: readonly RegExp[]): boolean {
  const prepared = prepareSelectionInput(line);
  if ('skip' in prepared || hasUntrustedSpanMarker(prepared.text)) return false;
  const text = normalizeForMatch(prepared.groundingText);
  if (!units.some((unit) => unit.test(text))) return false;
  if (!unexpressedContentWords(text, units).every((word) => PLURAL_DEICTIC_COMPLETION.includes(word))) return false;
  // Fix round 1 (P1): the shared guard treats a bare numeral as grammar. In the two-line form a digit that no recognised unit
  // removed (the plan's own validated count with its counter is the only numeric unit, AM-3) is a number the plan does not carry.
  for (const unit of units) if (COUNT_UNITS.has(unit) && (text.match(new RegExp(unit.source, `${unit.flags.replace(/[gy]/gu, '')}g`))?.length ?? 0) > 1) return false;
  let rest = text;
  for (const unit of units) rest = rest.replace(new RegExp(unit.source, `${unit.flags.replace(/[gy]/gu, '')}g`), ' ');
  // Review round 2: any numeral (`\p{N}`: circled, superscript, roman, fullwidth) left over fails; a signed count (`-3개`) is not a unit.
  return !/\p{N}/u.test(rest);
}

/**
 * ADR-0121 A6.5 (A6-S3): whether the owner's message is the two-line form and BOTH lines are consumed by this producer for this
 * validated plan. The raw text must be exactly two non-empty LF lines with no other separator and no format character; the
 * prepared text must agree (two lines). Every other multi-line shape is not (fail closed). Pure.
 */
function isConsumedTwoLineRequest(plan: StepsPlan, prepared: OwnerText): boolean {
  if (prepared.rawText === undefined) return false;
  const lines = rawTwoLines(prepared.rawText);
  if (lines === undefined) return false;
  if (nlPreparedWithoutFilesLine(prepared.text).trim().split(LINE_BREAK).filter((line) => line.trim().length > 0).length !== 2) return false;
  const units = recognisedUnits(plan);
  return lines.every((line) => isConsumedLine(line, units));
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
    // Review round 4: a multi-line message never grants (the whole multi-line paste family, structurally), except the A6.5
    // two-line form below; review round 2: any untrusted-span marker anywhere in the message, and it grants nothing (fail closed).
    if (hasUntrustedSpanMarker(prepared.text)) return [];
    // A6.5 (A6-S3, AM-1): the one narrowed multi-line shape, exactly two LF lines each consumed by this producer. Anything else
    // that is not a single line keeps the whole message fail-closed.
    if (!isSingleLineOwnerText(prepared.text) && !isConsumedTwoLineRequest(plan, prepared)) return [];
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

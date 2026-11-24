import type { NlCatalogEntry } from '../nl-routing/catalog';
import { NL_MODE_SUMMARY_WORDS } from '../nl-routing/action-entries';
import { nlClauses } from '../nl-routing/clause-flags';
import { aliasStarts } from './conjuncts';
import { nlIsExactConnectorWrite, nlWriteClausePointsBack } from '../nl-routing/write-clause';
import { normalizeForMatch } from '../nl-routing/selection-input';
import { groundingWordIn } from '../nl-routing/selection-validator';

/**
 * ADR-0121 amendment A7 (S3 cross-source actions), slice A7-S1 "plan-form": the CLOSED tables and the PURE structural rules of
 * the plan form. Nothing here reads, drafts, cards or sends anything, and nothing here is reachable from a running agent: a
 * validated A7 plan is not runnable (like the A4-S1 handoff), the flags are off, and the agent mode is unchanged.
 *
 * What this file holds:
 * - the closed propose targets, the operations they map to and the A7 sources ({@link AGENT_A7_TARGETS},
 *   {@link AGENT_A7_SOURCES});
 * - the literal analysis of the owner's non-quoted words and the A7.4a role rule ({@link analyseCrossWriteLiterals}): which
 *   destination-eligible literal is MARKED as the destination, by the closed locative particle (에, 에다, 에다가, with an
 *   optional 도 or 는) or the English `to` / `into`, with only closed-class words and the destination entry's own catalog
 *   noun between, and only the write request unit after it. `에서`, `로`, `으로` and English `on` / `in` never mark. No
 *   phrase is added to any vocabulary: the pieces are the ADR-0112 grammar's own destination nouns and write verbs
 *   (pinned equal to that grammar by `cross-write.test.ts`), the catalog's own names and the existing summary words;
 * - the destination span (the destination literal plus the catalog names that touch it with only closed-class words between),
 *   which the source-name check skips (A7.4, review round 1);
 * - the routing precedence of A7.5 step 0 ({@link routeCrossWrite}): the ADR-0112 grammar first, then R2a / R2b only while A7
 *   is active for the destination's kind, otherwise A6 exactly as today ("ordinary");
 * - the pre-read destination check ({@link checkCrossWriteDestination}), over an injected port.
 *
 * Owner rule (no word lists, no phrase hacks): every decision here is positional and structural over closed sets. A miss is
 * never fixed by adding a phrase. The English closed class below is the grammatical determiner class (articles and
 * pronouns), like `nlHasDistributiveMarker`.
 */

/** The three closed propose targets (A7.5 step 1) and what each one is. */
export const AGENT_A7_TARGETS = {
  'jira.comment.propose': { kind: 'jira', operation: 'ISSUE_COMMENT' },
  'slack.post.propose': { kind: 'slack', operation: 'CHANNEL_POST' },
  'calendar.create.propose': { kind: 'calendar', operation: 'CALENDAR_EVENT_CREATE' },
} as const;
export type AgentA7Target = keyof typeof AGENT_A7_TARGETS;
export type AgentA7Kind = (typeof AGENT_A7_TARGETS)[AgentA7Target]['kind'];
export type AgentA7Operation = (typeof AGENT_A7_TARGETS)[AgentA7Target]['operation'];

export function isAgentA7Target(value: string): value is AgentA7Target {
  return Object.prototype.hasOwnProperty.call(AGENT_A7_TARGETS, value);
}

/** A7.3: the READ entries that may be a source of a cross-source write in the first slices (mail, Drive, calendar come later). */
export const AGENT_A7_SOURCES = ['slack.search', 'jira.issues', 'jira.release'] as const;
/** The closed output schema of the draft step (A7.5 step 5). The drafter itself is A7-S3. */
export const AGENT_A7_DRAFT_SCHEMA = 'payload-draft.v1';

/** The closed argument names of each propose step: destination args only, never a payload (A7.5 step 1). */
export const AGENT_A7_TARGET_ARGS: Readonly<Record<AgentA7Target, readonly string[]>> = {
  'jira.comment.propose': ['issueKey', 'project'],
  'slack.post.propose': ['channel'],
  'calendar.create.propose': ['title', 'when'],
};

/** The content-free held receipt as far as the plan form needs it (A7.4; built by A7-S2): never any text. */
export interface AgentCrossWriteReceipt {
  /** The next owner turn, in the same DM conversation, within 10 minutes (A7.4). */
  readonly fresh: boolean;
  readonly sourceEntryId: string;
  /** 1..10 items. */
  readonly items: number;
  readonly hostOnly: boolean;
  /** Built with a handoff value or an `OWNER_CONFIRMED` argument (A7.4 "never held": inapplicable). */
  readonly handoffBuilt: boolean;
}

/** What the validator and the router need to know about the deployment, by closed values. Absent: A7 is off. */
export interface AgentCrossWriteContext {
  /** `QUOKY_AGENT_WRITE_PROPOSALS` for that destination kind is `active` (A7.5 pipeline precondition). */
  readonly active: Readonly<Record<AgentA7Kind, boolean>>;
  /** The kind's ADR-0112 / ADR-0110 writer is enabled. */
  readonly writers: Readonly<Record<AgentA7Kind, boolean>>;
  /** `QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS`, upper-case keys. */
  readonly jiraProjects: readonly string[];
  /** `QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS`, names without the `#`. */
  readonly slackChannels: readonly string[];
  /** The A7 sources switched on (a subset of {@link AGENT_A7_SOURCES}). */
  readonly sources: readonly string[];
  /** The fresh content-free receipt bound to this owner and DM conversation, when one exists (form b). */
  readonly receipt?: AgentCrossWriteReceipt;
}

// ── closed word classes ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The destination nouns of the ADR-0112 grammar (`ISSUE_NOUN`, `CHANNEL_NOUN` in `work-chat-command.ts`) and their English
 * forms. `cross-write.test.ts` pins the Korean ones to that grammar (it must accept each between the literal and its particle).
 */
const KIND_NOUNS: Readonly<Record<'jira' | 'slack', readonly string[]>> = {
  jira: ['이슈', '티켓', 'issue', 'ticket'],
  slack: ['채널', 'channel'],
};
/** The English determiner and pronoun class, plus the English request leads: closed grammatical words, never topic words. */
const EN_CLOSED = new Set(['the', 'a', 'an', 'it', 'that', 'this', 'them', 'these', 'those', 'my', 'our', 'its', 'please', 'pls', 'plz', 'kindly']);
/** Conjunction words and the A6 closed yes token that may open a message ("응 그리고 BE-123에 달아줘"). */
const LEADING_CLOSED = new Set(['그리고', 'and', '응', 'also']);
/** The Korean closed-class filler of an object ("좀", "다"). */
const KO_CLOSED = new Set(['좀', '다']);

/**
 * The closed locative particle set of A7.4a: 에, 에다, 에다가, optionally followed by 도 or 는, ending at the word. `에서`,
 * `에게서`, `로`, `으로` and every other particle are not markers.
 */
const MARKER_PARTICLE = '(?:에다가|에다|에)(?:도|는)?';
const MARKER_TAIL = new RegExp(`^(?<stem>.*?)(?<particle>${MARKER_PARTICLE})[.,!?~]*$`, 'u');
/** Any particle that may follow a literal: marker or not. A literal followed by anything else is not a literal token. */
const ANY_PARTICLE = /^(?:(?:에다가|에다|에)(?:도|는)?|에서(?:는|도)?|에게서|으로(?:는|도)?|로(?:는|도)?|의|을|를|은|는|이|가|도|만|와|과)?[.,!?~]*$/u;
/**
 * The write request unit, from the ADR-0112 grammar's own verbs (`COMMENT_VERB`, `POST_VERB`, `REQUEST_ENDING`): an optional
 * noun, an optional object particle, the verb, the request ending. Pinned to the grammar by `cross-write.test.ts`.
 */
const WRITE_UNIT_KO: Readonly<Record<'jira' | 'slack', RegExp>> = {
  jira: /^(?:(?:댓글|코멘트)\s*(?:을|를)?\s*)?(?:(?:달아|남겨|써|작성해|추가해|등록해)(?:줘|주세요|줄래(?:요)?|줘요)?)?[.!~]*$/u,
  slack: /^(?:(?:메시지|글)\s*(?:을|를)?\s*)?(?:(?:게시|올려|보내|포스트|전송)(?:\s*해)?(?:줘|주세요|줄래(?:요)?|줘요)?)[.!~]*$/u,
};
/** A single word that is a write request unit (the verb with its request ending, the noun optionally glued): counts the writes of a message. */
const WRITE_VERB_TOKEN = /^(?:(?:댓글|코멘트|메시지|글)(?:을|를)?)?(?:달아|남겨|써|작성해|추가해|등록해|게시|올려|보내|포스트|전송)(?:해)?(?:줘|주세요|줄래(?:요)?|줘요)[.!~]*$/u;
/** The English words that count a write request in a message (`comment` is also a noun, so it does not count). */
const WRITE_COUNT_EN = new Set(['add', 'post', 'send']);
/** English write verbs of the ADR-0112 grammar (`COMMENT_EN`, `POST_EN`): add, comment, post, send. */
const WRITE_VERBS_EN = new Set(['add', 'comment', 'post', 'send']);

const JIRA_LITERAL = /^(?<key>[A-Za-z][A-Za-z0-9_]{0,63}-[1-9]\d{0,8})(?<rest>.*)$/u;
const CHANNEL_LITERAL = /^#(?<name>[\p{L}\p{N}][\p{L}\p{N}._-]{0,79})$/u;

export interface CrossWriteLiteral {
  readonly kind: 'jira' | 'slack';
  /** Canonical: the upper-case issue key, or the lower-case channel name without `#`. */
  readonly value: string;
  /** Token index in the owner's whitespace-split words. */
  readonly index: number;
  /** The project key (Jira) or `undefined`. */
  readonly project?: string;
  readonly allowed: boolean;
  /** What follows the literal in its own word: nothing, or a closed particle (never any other text). */
  readonly rest: string;
}

export interface CrossWriteNouns {
  /** The destination entries' own catalog names (aliases and source names), normalized. */
  readonly jira: readonly string[];
  readonly slack: readonly string[];
}

export function crossWriteNouns(offered: ReadonlyMap<string, NlCatalogEntry>): CrossWriteNouns {
  const of = (id: string, extra: readonly string[]): string[] => [
    ...new Set([...(offered.get(id)?.aliases ?? []), ...(offered.get(id)?.sourceNames ?? []), ...extra].map((word) => normalizeForMatch(word)).filter((word) => word.length > 0 && !word.includes(' '))),
  ];
  return { jira: of('jira.issues', KIND_NOUNS.jira), slack: of('slack.search', KIND_NOUNS.slack) };
}

interface Token {
  readonly text: string;
  readonly word: string;
}

function tokensOf(text: string): Token[] {
  return text
    .normalize('NFC')
    .split(/\s+/u)
    .filter((raw) => raw.length > 0)
    .map((raw) => ({ text: raw, word: normalizeForMatch(raw) }));
}

function allowedProject(projects: readonly string[], key: string): boolean {
  const project = key.slice(0, key.lastIndexOf('-')).toUpperCase();
  return projects.some((listed) => listed.toUpperCase() === project);
}

/** The destination-eligible literals (by shape) of the owner's words. `allowed` is the allowlist check, kept apart. */
function literalsOf(tokens: readonly Token[], context: Pick<AgentCrossWriteContext, 'jiraProjects' | 'slackChannels'>): CrossWriteLiteral[] {
  const out: CrossWriteLiteral[] = [];
  for (const [index, token] of tokens.entries()) {
    const jira = JIRA_LITERAL.exec(token.text);
    if (jira?.groups !== undefined && ANY_PARTICLE.test(jira.groups.rest ?? '')) {
      const key = (jira.groups.key as string).toUpperCase();
      const project = key.slice(0, key.lastIndexOf('-'));
      out.push({ kind: 'jira', value: key, index, project, allowed: allowedProject(context.jiraProjects, key), rest: normalizeForMatch(jira.groups.rest ?? '') });
      continue;
    }
    if (token.text.startsWith('#')) {
      const channel = channelOf(token.text, context.slackChannels);
      if (channel !== undefined) out.push({ kind: 'slack', value: channel.name, index, allowed: channel.allowed, rest: channel.rest });
    }
  }
  return out;
}

/** The channel a `#name` token names, with a trailing particle removed; an allowlisted name wins over a shorter reading. */
function channelOf(raw: string, allowlist: readonly string[]): { readonly name: string; readonly allowed: boolean; readonly rest: string } | undefined {
  const bare = raw.slice(1).replace(/[.,!?~]+$/u, '');
  if (bare.length === 0) return undefined;
  const lower = bare.toLowerCase();
  for (const name of allowlist) {
    const listed = name.toLowerCase();
    if (lower === listed) return { name: listed, allowed: true, rest: '' };
    if (lower.startsWith(listed) && lower.length > listed.length && ANY_PARTICLE.test(lower.slice(listed.length))) return { name: listed, allowed: true, rest: lower.slice(listed.length) };
  }
  // A closed particle glued on the name is taken off first (the longest reading); a name with none is itself.
  for (let cut = 4; cut >= 0; cut -= 1) {
    if (cut >= bare.length) continue;
    const stem = bare.slice(0, bare.length - cut);
    const rest = bare.slice(bare.length - cut);
    if (CHANNEL_LITERAL.test(`#${stem}`) && (cut === 0 || ANY_PARTICLE.test(rest))) return { name: stem.toLowerCase(), allowed: false, rest: rest.toLowerCase() };
  }
  return undefined;
}

/** A token's glued marker particle and the stem before it, or `undefined`. */
function markerOf(word: string): { readonly stem: string; readonly particle: string } | undefined {
  const match = MARKER_TAIL.exec(word);
  return match?.groups === undefined ? undefined : { stem: match.groups.stem ?? '', particle: match.groups.particle ?? '' };
}

function isKoreanWord(word: string): boolean {
  return /[가-힣]/u.test(word);
}

export interface CrossWriteAnalysis {
  readonly literals: readonly CrossWriteLiteral[];
  /** The literals the A7.4a rule marked: all conditions of rule 2 hold. */
  readonly marked: readonly CrossWriteLiteral[];
  /** The destination span of each marked literal, by token index (inclusive). */
  readonly spans: ReadonlyMap<number, { readonly start: number; readonly end: number }>;
  /**
   * The kind is named as the destination with no instance (a7-09: "지라 티켓에 달아줘", "BE에 달아줘", "슬랙 채널에 올려줘"): the
   * destination entry's own catalog noun, or an allowlisted project key, is marked exactly as a literal is.
   */
  readonly kindMarked: Readonly<Record<'jira' | 'slack', boolean>>;
  /** The allowlisted project key the owner's words name as the destination (Jira kind-only), exact case. */
  readonly namedProject?: string;
  /** The write request unit appears twice or more: more than one write (A7.3 "never covered"). */
  readonly writeUnits: number;
  readonly tokens: readonly Token[];
}

/**
 * A7.4a rule 2, structurally. A literal of the target's own kind is marked when: (Korean) a closed locative particle ends it,
 * or ends a later word reached through only closed-class words and the destination entry's own catalog noun, and after that
 * word only the write request unit and closed-class words stand; (English) the word `to` or `into` stands before it with only
 * closed-class words and the catalog noun between, a write verb stands before that `to` with only closed-class words and the
 * summary words between, and only closed-class words and the catalog noun follow the literal.
 */
export function analyseCrossWriteLiterals(groundingText: string, context: AgentCrossWriteContext, nouns: CrossWriteNouns, accepts?: 'jira' | 'slack'): CrossWriteAnalysis {
  const tokens = tokensOf(groundingText);
  const literals = literalsOf(tokens, context);
  const kindNouns = (kind: 'jira' | 'slack'): ReadonlySet<string> => new Set(nouns[kind]);
  const closedWord = (word: string, kind: 'jira' | 'slack'): boolean => {
    const bare = word.replace(/[.,!?~]+$/u, '');
    return EN_CLOSED.has(bare) || KO_CLOSED.has(bare) || kindNouns(kind).has(bare);
  };
  const summaryWord = (word: string): boolean => NL_MODE_SUMMARY_WORDS.some((summary) => groundingWordIn(word, normalizeForMatch(summary)));
  const writeUnitKo = (kind: 'jira' | 'slack', tail: readonly Token[]): boolean => {
    const rest = tail.filter((token) => !closedWord(token.word, kind)).map((token) => token.word).join(' ');
    return rest.length > 0 && WRITE_UNIT_KO[kind].test(rest);
  };
  /** The span of the destination reading at `index` (a literal or a kind noun, with its glued `rest`), or `undefined`. */
  const markAt = (index: number, rest: string, kind: 'jira' | 'slack'): { start: number; end: number } | undefined => {
    let end: number | undefined;
    if (MARKER_TAIL.test(rest) && markerOf(rest)?.stem === '') end = index;
    else if (rest === '') {
      for (let next = index + 1; next < tokens.length; next += 1) {
        const word = (tokens[next] as Token).word;
        const marker = markerOf(word);
        if (marker !== undefined && isKoreanWord(word)) {
          if (marker.stem === '' || closedWord(marker.stem, kind)) end = next;
          break;
        }
        if (!closedWord(word, kind) || !isKoreanWord(word)) break;
      }
    }
    if (end !== undefined && writeUnitKo(kind, tokens.slice(end + 1))) return { start: spanStart(tokens, index, kind, closedWord), end };
    // English: `to` / `into` before it, a write verb before that, only closed words after.
    let at = index - 1;
    while (at >= 0 && closedWord((tokens[at] as Token).word, kind)) at -= 1;
    const preposition = at >= 0 ? (tokens[at] as Token).word : '';
    if (preposition !== 'to' && preposition !== 'into') return undefined;
    let verb = at - 1;
    while (verb >= 0 && !WRITE_VERBS_EN.has((tokens[verb] as Token).word) && (closedWord((tokens[verb] as Token).word, kind) || summaryWord((tokens[verb] as Token).word))) verb -= 1;
    const after = tokens.slice(index + 1);
    if (verb >= 0 && WRITE_VERBS_EN.has((tokens[verb] as Token).word) && after.every((token) => closedWord(token.word, kind))) return { start: at, end: index + after.length };
    return undefined;
  };
  const marked: CrossWriteLiteral[] = [];
  const spans = new Map<number, { start: number; end: number }>();
  for (const literal of literals) {
    // The kind check (rule 2, last condition): the operation's kind accepts the literal.
    if (accepts !== undefined && literal.kind !== accepts) continue;
    const span = markAt(literal.index, literal.rest, literal.kind);
    if (span !== undefined) {
      marked.push(literal);
      spans.set(literal.index, span);
    }
  }
  // The kind named with no instance: the catalog noun (or an allowlisted project key, exact case) in the literal's place.
  const kindMarked = { jira: false, slack: false };
  let namedProject: string | undefined;
  for (const [index, token] of tokens.entries()) {
    if (literals.some((literal) => literal.index === index)) continue;
    const marker = markerOf(token.word);
    const stem = marker !== undefined && isKoreanWord(token.word) ? marker.stem : token.word.replace(/[.,!?~]+$/u, '');
    const rest = marker !== undefined && isKoreanWord(token.word) && marker.stem.length > 0 ? marker.particle : '';
    const rawStem = marker !== undefined && isKoreanWord(token.word) ? token.text.slice(0, token.text.length - (token.word.length - marker.stem.length)) : token.text.replace(/[.,!?~]+$/u, '');
    for (const kind of ['jira', 'slack'] as const) {
      const project = kind === 'jira' && context.jiraProjects.includes(rawStem) ? rawStem : undefined;
      if (!kindNouns(kind).has(stem) && project === undefined) continue;
      // A glued-particle noun is its own reading; a bare noun looks forward like a literal.
      if (markAt(index, rest, kind) !== undefined) {
        kindMarked[kind] = true;
        if (project !== undefined) namedProject = project;
      }
    }
  }
  const writeUnits = tokens.filter((token) => WRITE_VERB_TOKEN.test(token.word) || WRITE_COUNT_EN.has(token.word)).length;
  return { literals, marked, spans, kindMarked, ...(namedProject !== undefined ? { namedProject } : {}), writeUnits, tokens };
}

function spanStart(tokens: readonly Token[], literalIndex: number, kind: 'jira' | 'slack', closed: (word: string, kind: 'jira' | 'slack') => boolean): number {
  let start = literalIndex;
  while (start > 0 && closed((tokens[start - 1] as Token).word, kind)) start -= 1;
  return start;
}

/** The owner's words with the destination span removed (A7.4, review round 1: the source-name check skips it). */
export function crossWriteTextOutsideSpan(analysis: CrossWriteAnalysis, destination: CrossWriteLiteral | undefined): string {
  const span = destination === undefined ? undefined : analysis.spans.get(destination.index);
  return analysis.tokens
    .filter((_, index) => span === undefined || index < span.start || index > span.end)
    .map((token) => token.text)
    .join(' ');
}

/**
 * The A7 source entries (offered READ entries of {@link AGENT_A7_SOURCES}) the text names by the catalog's own SOURCE names
 * (`sourceNames`: 슬랙, slack, 지라, jira), never by an entry's topic aliases: "배포" is a word of the release entry, but "BE-123에
 * 짧게 배포 완료 달아줘" names no source (A7.9: it stays an A6 literal post).
 */
export function crossWriteNamedSources(text: string, offered: ReadonlyMap<string, NlCatalogEntry>): string[] {
  const clauses = nlClauses(text);
  return AGENT_A7_SOURCES.filter((id) => {
    const entry = offered.get(id);
    if (entry === undefined || entry.risk !== 'READ') return false;
    const names = (entry.sourceNames ?? []).map((name) => normalizeForMatch(name)).filter((name) => name.length > 0);
    return clauses.some((clause) => clause.words.some((token) => names.some((name) => !name.includes(' ') && aliasStarts(token.word, name))) || names.some((name) => name.includes(' ') && ` ${clause.normalized} `.includes(` ${name}`)));
  });
}

// ── routing precedence (A7.5 step 0) ──────────────────────────────────────────────────────────────────────────────

export type CrossWriteRoute =
  /** Item 1: the ADR-0112 grammar with the owner's verbatim payload (or a Class A anchored command, which this module never sees). */
  | { readonly route: 'grammar' }
  /** Items 2 and 3 with A7 inactive for every kind, or a clause no R2 trigger holds: A6 and W1 exactly as today. */
  | { readonly route: 'ordinary' }
  | { readonly route: 'a7'; readonly trigger: 'cross-source' | 'receipt-followup' };

export interface CrossWriteRoutingInput {
  readonly groundingText: string;
  readonly context: AgentCrossWriteContext | undefined;
  readonly offered: ReadonlyMap<string, NlCatalogEntry>;
}

/**
 * A7.5 step 0, in this order: (1) the ADR-0112 grammar with the owner's payload, unchanged and first; (2) only while A7 is
 * `active` for a destination kind, R2a (the write clause's payload span holds a structural object: a read source name outside
 * the destination span, a second destination-eligible literal, or a summary word acting on such an object or on the W1
 * point-back form) and R2b (a receipt-bound bare follow-up: a fresh receipt, a marked destination, only closed-class words
 * besides the write unit); (3) every other write clause is ordinary (A6 as today). With A7 off for every kind the answer is
 * `ordinary` or `grammar` and nothing else, so routing is byte-identical to today (`routing-changed-when-off`). Pure.
 */
export function routeCrossWrite(input: CrossWriteRoutingInput): CrossWriteRoute {
  if (nlIsExactConnectorWrite(input.groundingText)) return { route: 'grammar' };
  const context = input.context;
  if (context === undefined || (!context.active.jira && !context.active.slack)) return { route: 'ordinary' };
  const nouns = crossWriteNouns(input.offered);
  const analysis = analyseCrossWriteLiterals(input.groundingText, context, nouns);
  // R2a / R2b need a write clause: the write request unit of a covered destination kind.
  if (analysis.writeUnits === 0 || analysis.writeUnits > 1) return { route: 'ordinary' };
  const destination = analysis.marked.length === 1 ? (analysis.marked[0] as CrossWriteLiteral) : undefined;
  if (destination !== undefined && !context.active[destination.kind]) return { route: 'ordinary' };
  const outside = crossWriteTextOutsideSpan(analysis, destination);
  // A second literal of the destination shape (the allowlist decides later whether it can be a destination; a source need not be on it).
  const secondLiteral = analysis.literals.length >= 2;
  const namesSource = crossWriteNamedSources(outside, input.offered).length > 0;
  const summaryOnObject = summaryActsOnObject(outside, input.offered, analysis);
  if (namesSource || secondLiteral || summaryOnObject) return { route: 'a7', trigger: 'cross-source' };
  // R2b: no summary word, no source name; a fresh receipt, a marked destination, the rest closed-class only.
  if (destination !== undefined && context.receipt?.fresh === true && onlyClosedBesidesWrite(outside, destination.kind, nouns)) return { route: 'a7', trigger: 'receipt-followup' };
  return { route: 'ordinary' };
}

/** A summary word whose object noun phrase (only closed-class words between) is a source name, a literal or the W1 point-back form. */
function summaryActsOnObject(outside: string, offered: ReadonlyMap<string, NlCatalogEntry>, analysis: CrossWriteAnalysis): boolean {
  const tokens = tokensOf(outside);
  const isSummary = (word: string): boolean => NL_MODE_SUMMARY_WORDS.some((summary) => groundingWordIn(word, normalizeForMatch(summary)));
  // A literal is the object of a summary word only when no locative or other case particle is glued on it (an object takes none, or 을 / 를 / 의).
  const literalTokens = new Set(analysis.literals.filter((literal) => ['', '을', '를', '의', '은', '는'].includes(literal.rest.replace(/[.,!?~]+$/u, ''))).map((literal) => (analysis.tokens[literal.index] as Token).word));
  const textOf = (parts: readonly Token[]): string => parts.map((token) => token.text).join(' ');
  const isObject = (parts: readonly Token[]): boolean => parts.length > 0 && (parts.some((token) => literalTokens.has(token.word)) || crossWriteNamedSources(textOf(parts), offered).length > 0);
  // The W1 point-back form ("그 내용", "해당 내용"): the existing determiner grammar, over the phrase and as a payload span.
  // A7 supplement: the determiner 해당 ("해당 내용") is named by A7.5 step 0 as a point-back form but is not in the A6 determiner set;
  // it is added here only, so A6 and W1 stay byte-identical.
  const pointsBack = (parts: readonly Token[]): boolean => parts.length > 0 && (nlWriteClausePointsBack(textOf(parts), [textOf(parts)]) || parts[0]?.word === '해당');
  for (const [index, token] of tokens.entries()) {
    if (!isSummary(token.word)) continue;
    const latin = /^[a-z0-9 .;-]+$/u.test(token.word);
    if (latin) {
      const after: Token[] = [];
      for (let next = index + 1; next < tokens.length; next += 1) {
        const word = (tokens[next] as Token).word;
        after.push(tokens[next] as Token);
        if (!EN_CLOSED.has(word)) break;
      }
      if (isObject(after) || pointsBack(after)) return true;
    } else {
      const before: Token[] = [];
      for (let prev = index - 1; prev >= 0; prev -= 1) {
        before.unshift(tokens[prev] as Token);
        if (!KO_CLOSED.has((tokens[prev] as Token).word)) break;
      }
      // The object noun phrase is the nearest content word and a determiner glued before it ("그 내용", "해당 내용").
      const wider = tokens.slice(Math.max(0, index - 2), index);
      if (isObject(before) || pointsBack(wider)) return true;
    }
  }
  return false;
}

/** The text holds only the write request unit, leading conjunction words and closed-class words (the R2b payload condition). */
function onlyClosedBesidesWrite(outside: string, kind: 'jira' | 'slack', nouns: CrossWriteNouns): boolean {
  const tokens = tokensOf(outside).filter((token) => !LEADING_CLOSED.has(token.word) && !EN_CLOSED.has(token.word) && !nouns[kind].includes(token.word));
  const rest = tokens.map((token) => token.word).join(' ');
  return rest.length > 0 ? WRITE_UNIT_KO[kind].test(rest) || tokens.every((token) => WRITE_VERBS_EN.has(token.word)) : true;
}

// ── the pre-read destination check (A7.5 step 2) ──────────────────────────────────────────────────────────────────

export type CrossWriteDestinationRef =
  | { readonly kind: 'jira'; readonly issueKey: string; readonly project: string }
  | { readonly kind: 'slack'; readonly channel: string };

/**
 * The narrow port of the pre-read check (A7.5 step 2): ONE read-only call each, injected from outside the agent module (the
 * composition root wires it; A7-S4). `jiraIssueExists`: the issue exists in an allowlisted project (the ADR-0112 D5 transition
 * check's GET). `slackChannelIsPublic`: the allowlisted channel resolves and is public (A7.3: private channels never).
 */
export interface CrossWriteDestinationPort {
  jiraIssueExists(issueKey: string): Promise<boolean>;
  slackChannelIsPublic(channel: string): Promise<boolean>;
}

export type CrossWriteDestinationCheck =
  | { readonly ok: true }
  /** `unreachable`: the port failed or timed out (fail closed, never a guess). */
  | { readonly ok: false; readonly reason: 'not-found' | 'not-public' | 'unreachable' };

/**
 * The pre-read destination check: one read-only call before any source read or model call, so no content moves for a write
 * that cannot happen. Fail closed: a throw is `unreachable`. Pure over the port; no content in, none out.
 */
export async function checkCrossWriteDestination(destination: CrossWriteDestinationRef, port: CrossWriteDestinationPort): Promise<CrossWriteDestinationCheck> {
  try {
    if (destination.kind === 'jira') return (await port.jiraIssueExists(destination.issueKey)) ? { ok: true } : { ok: false, reason: 'not-found' };
    return (await port.slackChannelIsPublic(destination.channel)) ? { ok: true } : { ok: false, reason: 'not-public' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

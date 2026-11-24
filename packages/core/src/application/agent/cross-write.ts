import type { NlCatalogEntry } from '../nl-routing/catalog';
import { NL_MODE_SUMMARY_WORDS, containsNlTimeExpression } from '../nl-routing/action-entries';
import { nlClauseNamesEntry, nlClauses } from '../nl-routing/clause-flags';
import {
  WORK_CHAT_CHANNEL_NOUNS,
  WORK_CHAT_COMMENT_NOUNS,
  WORK_CHAT_COMMENT_VERBS,
  WORK_CHAT_ISSUE_NOUNS,
  WORK_CHAT_POST_NOUNS,
  WORK_CHAT_POST_VERBS,
  RECENCY_KO,
  WORK_CHAT_REQUEST_ENDING_FORMS,
  nlIsExactConnectorWrite,
  nlWriteClausePointsBack,
} from '../nl-routing/write-clause';
import { aliasStarts } from './conjuncts';
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
 *   phrase is added to any vocabulary: the pieces are the ADR-0112 grammar's own destination nouns, write verbs and request
 *   ending (exported by `work-chat-command.ts`, re-exported by `nl-routing/write-clause.ts`, never copied), the catalog's own
 *   names and aliases and the existing summary, time and slot grammars;
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
 * The destination nouns of the ADR-0112 grammar (imported from `work-chat-command.ts`, never copied) and their English forms.
 * `cross-write.test.ts` pins the Korean ones to that grammar (it must accept each between the literal and its particle).
 */
const KIND_NOUNS: Readonly<Record<'jira' | 'slack', readonly string[]>> = {
  jira: [...WORK_CHAT_ISSUE_NOUNS, 'issue', 'ticket'],
  slack: [...WORK_CHAT_CHANNEL_NOUNS, 'channel'],
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
const alt = (words: readonly string[]): string => `(?:${words.join('|')})`;
/**
 * The write request unit, from the ADR-0112 grammar's own nouns, verbs and request ending (imported from `work-chat-command.ts`,
 * never copied): an optional noun, an optional object particle, the verb, the request ending.
 */
const WRITE_UNIT_KO: Readonly<Record<'jira' | 'slack', RegExp>> = {
  jira: new RegExp(String.raw`^(?:${alt(WORK_CHAT_COMMENT_NOUNS)}\s*(?:을|를)?\s*)?(?:${alt(WORK_CHAT_COMMENT_VERBS)}${WORK_CHAT_REQUEST_ENDING_FORMS}?)?[.!~]*$`, 'u'),
  slack: new RegExp(String.raw`^(?:${alt(WORK_CHAT_POST_NOUNS)}\s*(?:을|를)?\s*)?(?:${alt(WORK_CHAT_POST_VERBS)}(?:\s*해)?${WORK_CHAT_REQUEST_ENDING_FORMS}?)[.!~]*$`, 'u'),
};
/**
 * The verb stems that count a write (review round 1, P2): the grammar's comment and post verbs, plus the 하 stem of each
 * 해-form verb (작성해 → 작성하, 게시 + 해 → 게시하), so a connective form counts as well as a request form.
 */
const WRITE_STEMS: readonly string[] = [...WORK_CHAT_COMMENT_VERBS, ...WORK_CHAT_POST_VERBS].flatMap((verb) => (verb.endsWith('해') ? [verb, verb.slice(0, -1)] : [verb]));
/**
 * The closed verbal endings a counted write verb may carry (review round 1, P2: any ending, connectives included): the request
 * ending, the connective forms of the same request auxiliary (주고, 주면서, 주시고, 줘서), the bare connectives 고 and 서, and the
 * 해 / 하 forms of a 해-verb (게시해, 게시해서, 게시하고, 작성하면서). A grammatical class, never a topic word.
 */
const WRITE_ENDING = String.raw`(?:(?:해)?(?:${WORK_CHAT_REQUEST_ENDING_FORMS}|주고|주면서|주시고|줘서|서|고)|해|하(?:고|면서))`;
/** One word that is a write verb (the grammar noun optionally glued): counts the writes of a message, whatever the ending. */
const WRITE_VERB_TOKEN = new RegExp(String.raw`^(?:${alt([...WORK_CHAT_COMMENT_NOUNS, ...WORK_CHAT_POST_NOUNS])}(?:을|를)?)?${alt(WRITE_STEMS)}${WRITE_ENDING}[.,!~]*$`, 'u');
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

/** A destination span by token index of the owner's words (inclusive). */
export interface CrossWriteSpan {
  readonly start: number;
  readonly end: number;
}

/** One locatively marked Jira or Slack destination phrase (review round 2, P2-a), by the token index of its marked word. */
export interface CrossWriteDestinationMark {
  readonly kind: 'jira' | 'slack';
  readonly index: number;
}

export interface CrossWriteAnalysis {
  readonly literals: readonly CrossWriteLiteral[];
  /** The literals the A7.4a rule marked: all conditions of rule 2 hold. */
  readonly marked: readonly CrossWriteLiteral[];
  /** The destination span of each marked literal, by token index (inclusive). */
  readonly spans: ReadonlyMap<number, CrossWriteSpan>;
  /**
   * The kind is named as the destination with no instance (a7-09: "지라 티켓에 달아줘", "BE에 달아줘", "슬랙 채널에 올려줘"): the
   * destination entry's own catalog noun, or an allowlisted project key, is marked exactly as a literal is.
   */
  readonly kindMarked: Readonly<Record<'jira' | 'slack', boolean>>;
  /**
   * The destination span of a kind-only destination (review round 1, P2): the marked kind noun or project key plus the closed-class
   * words and catalog names that touch it, by token index (inclusive). The source-name check skips it, as it skips a literal's span.
   */
  readonly kindSpans: Readonly<Partial<Record<'jira' | 'slack', CrossWriteSpan>>>;
  /** The allowlisted project key the owner's words name as the destination (Jira kind-only), upper case (matched without case). */
  readonly namedProject?: string;
  /**
   * The write verbs of the grammar in the message, by any closed ending. Used for "a write clause exists" (the router needs one)
   * and as an additional fail-closed signal only; the count of record for "more than one write" is {@link destinations}
   * (review round 2, P2-a: a verb count depends on the verb's ending and spacing).
   */
  readonly writeUnits: number;
  /**
   * Review round 2, P2-a: every Jira or Slack destination the owner's words mark LOCATIVELY, whatever verb follows: a destination
   * literal, or a destination kind noun (the destination entries' own catalog nouns) or an allowlisted project key, that carries the
   * closed locative particle of A7.4a (에, 에다, 에다가; `에서`, `로`, `으로` never), or (English) stands after `to` / `into` with
   * only closed-class words between. A noun phrase counts once (only its last word carries the particle: "BE-123 이슈에"). Two or
   * more is two writes (A7.3 "never covered"); one beside a calendar event is a second write.
   */
  readonly destinations: readonly CrossWriteDestinationMark[];
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
  const kindSpans: Partial<Record<'jira' | 'slack', CrossWriteSpan>> = {};
  let namedProject: string | undefined;
  for (const [index, token] of tokens.entries()) {
    if (literals.some((literal) => literal.index === index)) continue;
    const marker = markerOf(token.word);
    const stem = marker !== undefined && isKoreanWord(token.word) ? marker.stem : token.word.replace(/[.,!?~]+$/u, '');
    const rest = marker !== undefined && isKoreanWord(token.word) && marker.stem.length > 0 ? marker.particle : '';
    const rawStem = marker !== undefined && isKoreanWord(token.word) ? token.text.slice(0, token.text.length - (token.word.length - marker.stem.length)) : token.text.replace(/[.,!?~]+$/u, '');
    for (const kind of ['jira', 'slack'] as const) {
      // The allowlist match ignores case, like `allowedProject` (review round 1, P3); the named project is upper case.
      const project = kind === 'jira' && context.jiraProjects.some((listed) => listed.toUpperCase() === rawStem.toUpperCase()) ? rawStem.toUpperCase() : undefined;
      if (!kindNouns(kind).has(stem) && project === undefined) continue;
      // A glued-particle noun is its own reading; a bare noun looks forward like a literal.
      const span = markAt(index, rest, kind);
      if (span !== undefined) {
        kindMarked[kind] = true;
        // The widest reading of the kind's span (a project key and a noun after it: "FE 티켓에").
        const held = kindSpans[kind];
        kindSpans[kind] = held === undefined ? span : { start: Math.min(held.start, span.start), end: Math.max(held.end, span.end) };
        if (project !== undefined) namedProject = project;
      }
    }
  }
  const writeUnits = tokens.filter((token) => WRITE_VERB_TOKEN.test(token.word) || WRITE_COUNT_EN.has(token.word)).length;
  const destinations = markedDestinationsOf(tokens, literals, context, nouns);
  return { literals, marked, spans, kindMarked, kindSpans, ...(namedProject !== undefined ? { namedProject } : {}), writeUnits, destinations, tokens };
}

/**
 * Review round 2, P2-a: the locatively marked destination phrases of the owner's words (see {@link CrossWriteAnalysis.destinations}).
 * Destination counting replaces verb counting: the particle and the destination's shape decide, never the verb, its ending or its
 * spacing ("BE-1에 달고 #quoky-test에 올려줘", "BE-123에 댓글 달아 주고 …"). Fail closed by design: a source phrase that carries the
 * locative particle ("BE-12에 달린 댓글 …", "슬랙에 있는 대화 …") counts as well; `에서` or `의` there never counts. Pure.
 */
function markedDestinationsOf(
  tokens: readonly Token[],
  literals: readonly CrossWriteLiteral[],
  context: Pick<AgentCrossWriteContext, 'jiraProjects'>,
  nouns: CrossWriteNouns,
): CrossWriteDestinationMark[] {
  const out: CrossWriteDestinationMark[] = [];
  const kindOfNoun = (word: string, raw: string): 'jira' | 'slack' | undefined =>
    nouns.jira.includes(word) || context.jiraProjects.some((listed) => listed.toUpperCase() === raw.toUpperCase()) ? 'jira' : nouns.slack.includes(word) ? 'slack' : undefined;
  for (const [index, token] of tokens.entries()) {
    const literal = literals.find((each) => each.index === index);
    if (literal !== undefined) {
      if (markerOf(literal.rest)?.stem === '') out.push({ kind: literal.kind, index });
      continue;
    }
    const marker = markerOf(token.word);
    if (marker === undefined || marker.stem.length === 0 || !isKoreanWord(token.word)) continue;
    const rawStem = token.text.slice(0, token.text.length - (token.word.length - marker.stem.length));
    const kind = kindOfNoun(marker.stem, rawStem);
    if (kind !== undefined) out.push({ kind, index });
  }
  // English: one phrase per `to` / `into` whose object (closed-class words skipped) is a literal or a destination kind noun.
  for (const [index, token] of tokens.entries()) {
    if (token.word !== 'to' && token.word !== 'into') continue;
    let next = index + 1;
    while (next < tokens.length && EN_CLOSED.has((tokens[next] as Token).word)) next += 1;
    const object = tokens[next];
    if (object === undefined) continue;
    const literal = literals.find((each) => each.index === next);
    const bare = object.word.replace(/[.,!?~]+$/u, '');
    const kind = literal?.kind ?? kindOfNoun(bare, object.text.replace(/[.,!?~]+$/u, ''));
    if (kind !== undefined) out.push({ kind, index: next });
  }
  return out;
}

/**
 * A calendar target only (review round 1, P2): the calendar's own request verb is not a comment or post verb, so a second write
 * beside a calendar event can count as one unit ("… BE-123에 달아주고 내일 3시에 점검 일정 만들어줘"). Such a comment or post verb
 * stands in a clause (the S2 conjuncts, the verb connective included) that also holds a Jira key or a `#channel` literal, or a
 * destination noun of the grammar with the locative particle: that is a second destination, so a second write. Pure.
 */
export function crossWriteSecondWriteBesideCalendar(groundingText: string): boolean {
  const destinationNouns = new Set([...KIND_NOUNS.jira, ...KIND_NOUNS.slack]);
  return nlClauses(groundingText).some((clause) => {
    const words = clause.words.map((token) => token.word);
    if (!words.some((word) => WRITE_VERB_TOKEN.test(word))) return false;
    return words.some((word) => {
      const jira = JIRA_LITERAL.exec(word);
      if ((jira?.groups !== undefined && ANY_PARTICLE.test(jira.groups.rest ?? '')) || CHANNEL_LITERAL.test(word.replace(/[.,!?~]+$/u, '')) || word.startsWith('#')) return true;
      const marker = markerOf(word);
      return marker !== undefined && destinationNouns.has(marker.stem);
    });
  });
}

function spanStart(tokens: readonly Token[], literalIndex: number, kind: 'jira' | 'slack', closed: (word: string, kind: 'jira' | 'slack') => boolean): number {
  let start = literalIndex;
  while (start > 0 && closed((tokens[start - 1] as Token).word, kind)) start -= 1;
  return start;
}

/**
 * The destination span of the analysis for one destination kind (or any kind): the span of the one marked literal, else the
 * span of the marked kind noun or project key (a kind-only destination, a7-09). `undefined` when no destination is marked.
 */
export function crossWriteDestinationSpan(analysis: CrossWriteAnalysis, kind?: 'jira' | 'slack'): CrossWriteSpan | undefined {
  const marked = analysis.marked.filter((literal) => kind === undefined || literal.kind === kind);
  if (marked.length === 1) return analysis.spans.get((marked[0] as CrossWriteLiteral).index);
  if (marked.length > 1) return undefined;
  if (kind !== undefined) return analysis.kindSpans[kind];
  const kinds = (['jira', 'slack'] as const).filter((each) => analysis.kindSpans[each] !== undefined);
  return kinds.length === 1 ? analysis.kindSpans[kinds[0] as 'jira' | 'slack'] : undefined;
}

/** The owner's words with the destination span removed (A7.4, review round 1: the source-name check skips it). */
export function crossWriteTextOutsideSpan(analysis: CrossWriteAnalysis, destination: CrossWriteLiteral | CrossWriteSpan | undefined): string {
  const span = destination === undefined ? undefined : 'start' in destination ? destination : analysis.spans.get(destination.index);
  return analysis.tokens
    .filter((_, index) => span === undefined || index < span.start || index > span.end)
    .map((token) => token.text)
    .join(' ');
}

/** The catalog entry whose names and aliases are a calendar destination's own nouns ("일정" in "점검 일정 만들어줘"). */
const CALENDAR_DESTINATION_ENTRY = 'calendar.events';
const SPAN_MARK = '\u0001';

/**
 * A calendar target (A7.3, review round 1): the owner's words outside the destination span, which for a calendar event is the
 * verbatim title and time spans plus the names and aliases of the calendar entry that touch them with only a particle between
 * ("배포 점검 일정 만들어줘": "일정" is the event's own noun, never a source). Pure.
 */
export function crossWriteCalendarOutside(text: string, spans: readonly (string | undefined)[], offered: ReadonlyMap<string, NlCatalogEntry>): string {
  let marked = text.normalize('NFC').replace(/\s+/gu, ' ');
  for (const span of spans) {
    if (span === undefined || span.length === 0) continue;
    // Review round 2, P3: the span is anchored on its LAST occurrence (the event's title and time stand by the create verb at the end
    // of the request), so a same word earlier in the source part ("슬랙 점검 대화 …") is never the one removed.
    const at = marked.lastIndexOf(span);
    if (at >= 0) marked = `${marked.slice(0, at)} ${SPAN_MARK} ${marked.slice(at + span.length)}`;
  }
  const entry = offered.get(CALENDAR_DESTINATION_ENTRY);
  const names = [...(entry?.aliases ?? []), ...(entry?.sourceNames ?? [])].map((name) => normalizeForMatch(name)).filter((name) => name.length > 0 && !name.includes(' '));
  const tokens = marked.split(' ').filter((token) => token.length > 0);
  const particleOnly = (token: string | undefined): boolean => token !== undefined && token !== SPAN_MARK && ANY_PARTICLE.test(token) && token.length > 0;
  const touches = (index: number, step: 1 | -1): boolean => {
    const next = tokens[index + step];
    return next === SPAN_MARK || (particleOnly(next) && tokens[index + 2 * step] === SPAN_MARK);
  };
  return tokens
    .filter((token, index) => {
      if (token === SPAN_MARK) return false;
      const word = normalizeForMatch(token);
      const own = names.some((name) => aliasStarts(word, name));
      return !(own && (touches(index, 1) || touches(index, -1)));
    })
    .join(' ');
}

/** The offered READ entries of the catalog (every read source, not only the A7 ones). */
function readEntries(offered: ReadonlyMap<string, NlCatalogEntry>): NlCatalogEntry[] {
  return [...offered.values()].filter((entry) => entry.risk === 'READ');
}

/**
 * The READ entries (EVERY catalog read source, review round 1) the text names by the catalog's own SOURCE names (`sourceNames`:
 * 슬랙, slack, 지라, jira, 메일, 드라이브 …), never by an entry's topic aliases. This is the R2a routing trigger, names only (a
 * recorded residual of review round 1): "배포" is a word of the release entry, but "BE-123에 짧게 배포 완료 달아줘" names no source
 * (A7.9: it stays an A6 literal post).
 */
export function crossWriteNamedSources(text: string, offered: ReadonlyMap<string, NlCatalogEntry>): string[] {
  const clauses = nlClauses(text);
  return readEntries(offered)
    .filter((entry) => {
      const names = (entry.sourceNames ?? []).map((name) => normalizeForMatch(name)).filter((name) => name.length > 0);
      return clauses.some((clause) => clause.words.some((token) => names.some((name) => !name.includes(' ') && aliasStarts(token.word, name))) || names.some((name) => name.includes(' ') && ` ${clause.normalized} `.includes(` ${name}`)));
    })
    .map((entry) => entry.id);
}

/**
 * The READ entries the text names by the catalog's names AND aliases (A7.4: "the source names and aliases are the catalog's
 * own"), every catalog read source. Used by the form-b source check and by the source-read grounding. Pure.
 */
export function crossWriteNamedEntries(text: string, offered: ReadonlyMap<string, NlCatalogEntry>): string[] {
  const clauses = nlClauses(text);
  return readEntries(offered)
    .filter((entry) => clauses.some((clause) => nlClauseNamesEntry(clause, entry)))
    .map((entry) => entry.id);
}

/**
 * Form b (A7.4, review round 1, P2): whether the text (the owner's words outside the destination span) names a source other
 * than the held one. Judged per word, by the catalog's names and aliases of every READ entry: a word that names at least one
 * entry and not the held entry is a new source ("메일", "릴리즈", "이슈" after a Slack receipt). A word that names the held entry
 * (also when it names another entry too: "지라" names both Jira entries) is the owner saying where the content came from. Pure.
 */
export function crossWriteNamesNewSource(text: string, offered: ReadonlyMap<string, NlCatalogEntry>, heldEntryId: string): boolean {
  const entries = readEntries(offered).map((entry) => ({
    id: entry.id,
    names: [...entry.aliases, ...(entry.sourceNames ?? [])].map((name) => normalizeForMatch(name)).filter((name) => name.length > 0),
  }));
  for (const clause of nlClauses(text)) {
    const padded = ` ${clause.normalized} `;
    const units: (readonly string[])[] = [
      ...clause.words.map((token) => entries.filter((entry) => entry.names.some((name) => !name.includes(' ') && aliasStarts(token.word, name))).map((entry) => entry.id)),
      // A multi-word name ("구글 캘린더", "할 일") is one unit.
      ...entries.flatMap((entry) => entry.names.filter((name) => name.includes(' ') && padded.includes(` ${name}`)).map((name) => entries.filter((other) => other.names.includes(name)).map((other) => other.id))),
    ];
    if (units.some((ids) => ids.length > 0 && !ids.includes(heldEntryId))) return true;
  }
  return false;
}

/**
 * Form b (A7.4, review round 1, P2): whether the text carries a read condition of its own, by the existing grammars only: a
 * time expression (the A6 time grammar, `containsNlTimeExpression`), or a filter slot of the held entry recognised by the
 * catalog's own slot grammar (an enum's `valueGrounding` words, a flag's `flagGrounding` words). Such a turn asks for a new read,
 * so it is not form b. An unquoted free keyword is not recognised by any slot grammar (a recorded residual): the bind still
 * re-reads only the held items, so no other content moves. Pure.
 */
export function crossWriteHasReadCondition(text: string, heldEntry: NlCatalogEntry | undefined): boolean {
  if (containsNlTimeExpression(text)) return true;
  if (heldEntry === undefined) return false;
  const normalized = normalizeForMatch(text);
  const words = heldEntry.args.flatMap((spec) => [...Object.values(spec.valueGrounding ?? {}).flat(), ...(spec.kind === 'flag' ? (spec.flagGrounding ?? []) : [])]);
  return words.some((word) => groundingWordIn(normalized, normalizeForMatch(word)));
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
  // More than one write (review round 2, P2-a: two or more locatively marked destinations; the verb count only as an extra signal).
  if (analysis.writeUnits === 0 || analysis.writeUnits > 1 || analysis.destinations.length > 1) return { route: 'ordinary' };
  const destination = analysis.marked.length === 1 ? (analysis.marked[0] as CrossWriteLiteral) : undefined;
  // Review round 1, P2: A7 must be active for EVERY destination kind the words can resolve to: the marked literal's kind; with
  // none marked, every literal's kind (any of them may be the destination) and every marked kind noun's kind.
  if (crossWriteResolvableKinds(analysis).some((kind) => !context.active[kind])) return { route: 'ordinary' };
  const outside = crossWriteTextOutsideSpan(analysis, crossWriteDestinationSpan(analysis));
  if (crossWriteCrossSourceTrigger(outside, input.offered, analysis)) return { route: 'a7', trigger: 'cross-source' };
  // R2b: no summary word, no source name; a fresh receipt, a marked destination, the rest closed-class only.
  if (destination !== undefined && context.receipt?.fresh === true && onlyClosedBesidesWrite(outside, destination.kind, nouns)) return { route: 'a7', trigger: 'receipt-followup' };
  return { route: 'ordinary' };
}

/**
 * The destination kinds the owner's words can resolve to (review round 1, P2): the one marked literal's kind; with none marked,
 * the kind of every literal and of every marked kind noun or project key. Pure.
 */
export function crossWriteResolvableKinds(analysis: CrossWriteAnalysis): ('jira' | 'slack')[] {
  if (analysis.marked.length === 1) return [(analysis.marked[0] as CrossWriteLiteral).kind];
  const kinds = new Set<'jira' | 'slack'>(analysis.literals.map((literal) => literal.kind));
  for (const kind of ['jira', 'slack'] as const) if (analysis.kindMarked[kind]) kinds.add(kind);
  return [...kinds];
}

/**
 * The R2a cross-source trigger over the owner's words outside the destination span: a read source name (names only), a second
 * destination-eligible literal, or a summary word acting on an object (a source name, a literal or the point-back form). Pure.
 */
export function crossWriteCrossSourceTrigger(outside: string, offered: ReadonlyMap<string, NlCatalogEntry>, analysis: CrossWriteAnalysis): boolean {
  // A second literal of the destination shape (the allowlist decides later whether it can be a destination; a source need not be on it).
  const secondLiteral = analysis.literals.length >= 2;
  return secondLiteral || crossWriteNamedSources(outside, offered).length > 0 || summaryActsOnObject(outside, offered, analysis);
}

/**
 * The determiner 해당 ("해당 내용"): A7.5 step 0 names "해당 내용" as a W1 point-back form, but 해당 is not in the A6 determiner set
 * (이, 그, 저). A closed constant of the A7 router ONLY (review round 1, P3): the A6 set is not widened, so A6 and W1 stay
 * byte-identical. A recorded residual (the owner may confirm it or widen both sets).
 */
export const A7_POINT_BACK_DETERMINERS: readonly string[] = ['해당'];

/**
 * ADR-0121 A7.5 step 0 (owner amendment 2026-11-24, "인정"): a recency word of the closed A6-D2 set ({@link RECENCY_KO}) followed
 * by ONE content noun ("방금 내용", "아까 대화") is a point-back form exactly like "그 내용" / "해당 내용". The noun is any content
 * word, the same openness as the determiner form's (which takes any word after 그 / 해당); a closed-class word or another
 * recency word is not a noun, so "방금 요약해서 …" (no noun) stays ordinary. A7 router ONLY: A6 and W1 are untouched.
 */
function recencyPointsBack(parts: readonly Token[]): boolean {
  const [recency, noun] = parts;
  if (parts.length !== 2 || recency === undefined || noun === undefined) return false;
  const isRecency = (word: string): boolean => (RECENCY_KO as readonly string[]).includes(word);
  return isRecency(recency.word) && !isRecency(noun.word) && !KO_CLOSED.has(noun.word);
}

/** A summary word whose object noun phrase (only closed-class words between) is a source name, a literal or the W1 point-back form. */
function summaryActsOnObject(outside: string, offered: ReadonlyMap<string, NlCatalogEntry>, analysis: CrossWriteAnalysis): boolean {
  const tokens = tokensOf(outside);
  const isSummary = (word: string): boolean => NL_MODE_SUMMARY_WORDS.some((summary) => groundingWordIn(word, normalizeForMatch(summary)));
  // A literal is the object of a summary word only when no locative or other case particle is glued on it (an object takes none, or 을 / 를 / 의).
  const literalTokens = new Set(analysis.literals.filter((literal) => ['', '을', '를', '의', '은', '는'].includes(literal.rest.replace(/[.,!?~]+$/u, ''))).map((literal) => (analysis.tokens[literal.index] as Token).word));
  const textOf = (parts: readonly Token[]): string => parts.map((token) => token.text).join(' ');
  const isObject = (parts: readonly Token[]): boolean => parts.length > 0 && (parts.some((token) => literalTokens.has(token.word)) || crossWriteNamedSources(textOf(parts), offered).length > 0);
  // The W1 point-back form ("그 내용", "해당 내용"): the existing determiner grammar, over the phrase and as a payload span, plus
  // the A7-only determiner {@link A7_POINT_BACK_DETERMINERS}.
  const pointsBack = (parts: readonly Token[]): boolean => parts.length > 0 && (nlWriteClausePointsBack(textOf(parts), [textOf(parts)]) || A7_POINT_BACK_DETERMINERS.includes(parts[0]?.word ?? ''));
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
      // The object may be a closed pronoun alone ("summarize that and …"): the point-back grammar then judges the closed words.
      const closedOnly = after.filter((part) => EN_CLOSED.has(part.word));
      if (isObject(after) || pointsBack(after) || (closedOnly.length > 0 && closedOnly.length < after.length && pointsBack(closedOnly))) return true;
    } else {
      const before: Token[] = [];
      for (let prev = index - 1; prev >= 0; prev -= 1) {
        before.unshift(tokens[prev] as Token);
        if (!KO_CLOSED.has((tokens[prev] as Token).word)) break;
      }
      // The object noun phrase is the nearest content word and a determiner glued before it ("그 내용", "해당 내용").
      const wider = tokens.slice(Math.max(0, index - 2), index);
      if (isObject(before) || pointsBack(wider) || recencyPointsBack(wider)) return true;
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

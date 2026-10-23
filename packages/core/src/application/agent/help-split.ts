import { detectHelpCommand, detectHelpIntent, isHelpGuideCloser, isHelpTopicParticle } from '../help-intent/help-intent';
import type { NlCatalogEntry } from '../nl-routing/catalog';
import { normalizeForMatch } from '../nl-routing/selection-input';
import { aliasStarts, conjunctTokens, type ConjunctToken } from './conjuncts';

/**
 * ADR-0121 A1-E1 (decision (e), amends S2 Q6): the deterministic help split. In the owner DM where the agent runs, after
 * the Class A checks and before planning, a help clause asked together with other reads is split off: the help is
 * answered with the existing fixed ADR-0104 help text as its own section, first, and only the rest of the owner's words
 * (still `TRUSTED`) reach the planner. `help.topic` therefore never becomes a plan step (a planner that still emits it in a
 * multi-step plan is refused `single-step-only`, as before; ratification answer 3).
 *
 * Structural only, with the existing closed vocabulary and no phrase added (ADR-0120 D10 grammar freeze; the owner's
 * no-hardcoding rule):
 * - **conjuncts** (`conjuncts.ts`): the P1 boundaries plus the Korean verb connective "-고" (owner decision Q2,
 *   2026-10-23: "사용법 알려주고 내 지라 이슈도 보여줘");
 * - **the help clause** (CA review of P3 part 1, finding 1): either
 *   - the alias form: the clause's HEAD word is a `help.topic` alias, alone or with one of the help grammar's own topic
 *     particles ("도움말이랑", "사용법", "help"), and every other word is a function word of that grammar (a guide closer:
 *     "좀", "알려줘") or the clause's predicate (the word that ends it with the verb connective, or the last word of the
 *     message, which is the predicate the clauses share); or
 *   - the grammar form: the frozen ADR-0104 help grammar recognises the clause as a command how-to (`detectHelpCommand`:
 *     the grammar's own action and conjugation forms, polite -요 and English included; Codex P2 on part 2), never its
 *     become / state form, so a status question in how-to form ("일정 어떻게 돼") is never help;
 *   and, for the alias form, no word of the clause names another offered entry (fail closed);
 * - exactly one help clause and at least one other conjunct, and the message is not one help question as a whole (the
 *   grammar matching the whole message, an address included: "Quoky야, 할 일 어떻게 취소해?"), or no split;
 * - the topic is the grammar's one `NL_HELP_TOPICS` topic when it names exactly one, else `all`;
 * - **the rest** is the message without the help clause and the boundary word that joined it; when the help clause is
 *   the last one, its shared predicate stays with the rest ("지라 이슈랑 도움말 보여줘" → "지라 이슈 보여줘") and the
 *   dangling "-랑" / "-이랑" / "-하고" / comma of the new last word is trimmed (CA finding 2).
 *
 * Only plain owner text is split: a message whose prepared text holds a placeholder (quoted, fenced or attached
 * material) is never split, so the rest is always the owner's own words. Outside the agent path (agent `off`, a channel)
 * nothing calls it. Pure.
 *
 * Residuals (A1 RA-8, measured in shadow by A1-E5): an English help request whose head word is not the alias ("show the
 * help page and my github PRs") is not split (the planner refuses as before); a last-position help clause's final word is
 * taken as the shared predicate whatever it is ("메일이랑 도움말 페이지" keeps "페이지" with the rest).
 */

export interface AgentHelpSplit {
  /** A `NL_HELP_TOPICS` value (`all` unless the help grammar named exactly one topic). */
  readonly topic: string;
  /** The owner's words without the help clause (sent to the planner, grounding the rest plan). */
  readonly rest: string;
}

/** The help topics `help.topic` accepts (the entry's own enum values; never a list of this module). */
function helpTopicsOf(help: NlCatalogEntry): readonly string[] {
  const spec = help.args.find((arg) => arg.name === 'topic');
  return spec?.kind === 'enum' ? (spec.values ?? []) : [];
}

/** Single-word names of an entry (aliases and source names), normalized. */
function namesOf(entry: NlCatalogEntry): string[] {
  return [...entry.aliases, ...(entry.sourceNames ?? [])].map((alias) => normalizeForMatch(alias)).filter((name) => name.length > 0 && !name.includes(' '));
}

/** The word without a trailing comma. */
const bare = (word: string): string => word.replace(/[,،]$/u, '');

/** The head word is a help alias, alone or with one of the help grammar's topic particles (an English alias: alone). */
function isAliasHead(word: string, helpNames: readonly string[]): boolean {
  const head = bare(word);
  return helpNames.some((name) => (/^[a-z0-9]+$/u.test(name) ? head === name : head.startsWith(name) && isHelpTopicParticle(head.slice(name.length))));
}

interface Clause {
  readonly conjunct: number;
  readonly topic: string;
  /** The index (into the tokens) of a shared predicate that stays with the rest. */
  readonly sharedPredicate?: number;
}

/**
 * The help split of the owner's prepared text, or `undefined` (no help clause, several, a clause that also names a
 * source, nothing else asked, or material that is not the owner's own words).
 */
export function splitHelpClause(prepared: { readonly text: string; readonly groundingText: string }, offered: readonly NlCatalogEntry[]): AgentHelpSplit | undefined {
  // Plain owner text only: a placeholder means quoted, fenced or attached material (never split).
  if (prepared.text.replace(/\s+/gu, ' ').trim() !== prepared.groundingText) return undefined;
  const help = offered.find((entry) => entry.id === 'help.topic');
  if (help === undefined) return undefined;
  // A message the help grammar matches as a whole is one help question (today's one-step help), never a split: an
  // address before it ("Quoky야, 할 일 어떻게 취소해?") is not a second request.
  if (detectHelpIntent(prepared.groundingText) !== null) return undefined;
  const helpNames = namesOf(help);
  const otherNames = offered.filter((entry) => entry.id !== 'help.topic').flatMap(namesOf);
  const tokens = conjunctTokens(prepared.groundingText, { verbConnective: true });
  const conjuncts = [...new Set(tokens.filter((token) => !token.boundary).map((token) => token.conjunct))];
  if (conjuncts.length < 2) return undefined;
  const lastConjunct = conjuncts[conjuncts.length - 1];
  const topics = helpTopicsOf(help);
  const clauses: Clause[] = [];
  for (const conjunct of conjuncts) {
    const indexes = tokens.flatMap((token, index) => (token.conjunct === conjunct ? [index] : []));
    const words = indexes.map((index) => tokens[index] as ConjunctToken);
    // The alias form fails closed on a clause that also names another entry; the grammar form names its own topic, which
    // is often a read entry's noun ("알림 어떻게 지워?"), so it is judged by the grammar alone.
    const namesOther = words.some((token) => otherNames.some((name) => aliasStarts(bare(token.word), name)));
    const clause = (namesOther ? undefined : aliasClause(words, indexes, conjunct === lastConjunct, helpNames)) ?? grammarClause(words, topics);
    if (clause !== undefined) clauses.push({ conjunct, ...clause });
  }
  if (clauses.length !== 1) return undefined;
  const clause = clauses[0] as Clause;
  const first = tokens.findIndex((token) => token.conjunct === clause.conjunct);
  let last = first;
  while (last + 1 < tokens.length && tokens[last + 1]?.conjunct === clause.conjunct) last += 1;
  // The boundary word that joined the clause: the one before it, else the one after it.
  let from = first;
  let to = last;
  if (tokens[first - 1]?.boundary === true) from -= 1;
  else if (tokens[last + 1]?.boundary === true) to += 1;
  const kept = tokens.flatMap((token, index) => (index < from || index > to ? [token.text] : []));
  if (kept.length === 0 || tokens.every((token, index) => (index >= from && index <= to) || token.boundary)) return undefined;
  if (clause.conjunct === lastConjunct) {
    // CA finding 2: after a last-position help clause the new last word drops its dangling conjunction, and the clause's
    // shared predicate goes back to the rest ("지라 이슈랑 도움말 보여줘" → "지라 이슈 보여줘").
    kept[kept.length - 1] = (kept[kept.length - 1] as string).replace(/(?:이랑|랑|하고|[,،])$/u, '');
    if (clause.sharedPredicate !== undefined) kept.push((tokens[clause.sharedPredicate] as ConjunctToken).text);
  }
  const rest = kept.filter((word) => word.length > 0).join(' ');
  if (rest.length === 0) return undefined;
  return { topic: topics.includes(clause.topic) ? clause.topic : 'all', rest };
}

/**
 * The alias form: the head word is a help alias (with a topic particle), every other word a guide closer of the help
 * grammar or the clause's predicate (its connective word, or the message's last word, then shared with the rest).
 */
function aliasClause(words: readonly ConjunctToken[], indexes: readonly number[], lastClause: boolean, helpNames: readonly string[]): Omit<Clause, 'conjunct'> | undefined {
  const [head, ...others] = words;
  if (head === undefined || !isAliasHead(head.word, helpNames)) return undefined;
  const final = others[others.length - 1];
  const finalIsPredicate = final !== undefined && (final.ends === 'connective' || (lastClause && final.ends === undefined));
  const middle = finalIsPredicate ? others.slice(0, -1) : others;
  if (!middle.every((token) => isHelpGuideCloser(bare(token.word)))) return undefined;
  const shared = finalIsPredicate && final.ends !== 'connective' ? indexes[indexes.length - 1] : undefined;
  return { topic: 'all', ...(shared !== undefined ? { sharedPredicate: shared } : {}) };
}

/**
 * The grammar form: the frozen help grammar recognises the clause as a command how-to (`detectHelpCommand`: its own
 * action and conjugation forms, polite and English ones included), never its become / state form ("일정 어떻게 돼").
 */
function grammarClause(words: readonly ConjunctToken[], topics: readonly string[]): Omit<Clause, 'conjunct'> | undefined {
  const text = words.map((token) => token.text).join(' ').replace(/[,،]$/u, '');
  const grammar = detectHelpCommand(text);
  if (grammar === null) return undefined;
  const named = grammar.topicIds.filter((topic) => topics.includes(topic));
  return { topic: named.length === 1 ? (named[0] as string) : 'all' };
}

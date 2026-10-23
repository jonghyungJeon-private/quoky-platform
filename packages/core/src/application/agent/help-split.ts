import { detectHelpIntent } from '../help-intent/help-intent';
import type { NlCatalogEntry } from '../nl-routing/catalog';
import { normalizeForMatch } from '../nl-routing/selection-input';

/**
 * ADR-0121 A1-E1 (decision (e), amends S2 Q6): the deterministic help split. In the owner DM where the agent runs, after
 * the Class A checks and before planning, a help clause asked together with other reads is split off: the help is
 * answered with the existing fixed ADR-0104 help text as its own section, first, and only the rest of the owner's words
 * (still `TRUSTED`) reach the planner. `help.topic` therefore never becomes a plan step (a planner that still emits it in a
 * multi-step plan is refused `single-step-only`, as before; ratification answer 3).
 *
 * Structural only, with the existing closed vocabulary and no phrase added (ADR-0120 D10 grammar freeze; the owner's
 * no-hardcoding rule):
 * - **conjuncts** at the boundaries the P1 validator already uses: the words "and" / "그리고", a token ending in a comma,
 *   and a token with a glued "-랑" / "-하고";
 * - a conjunct is the **help clause** when the frozen ADR-0104 help grammar matches it as a whole (`detectHelpIntent`:
 *   "알림 어떻게 지워?", "도움말 할 일"), or when one of its words starts with a `help.topic` alias (도움말, 사용법, help, 기능)
 *   and none of its words names another offered entry (an alias or source name): a clause that also names a source is
 *   not split (fail closed: the whole message is planned as before);
 * - exactly one help clause and at least one other conjunct, or no split;
 * - the topic is the grammar's one `NL_HELP_TOPICS` topic when it names exactly one, else `all`;
 * - the rest is the message without the help clause and the boundary word that joined it.
 *
 * Only plain owner text is split: a message whose prepared text holds a placeholder (quoted, fenced or attached
 * material) is never split, so the rest is always the owner's own words. Outside the agent path (agent `off`, a channel)
 * nothing calls it. Pure.
 *
 * Residuals (A1 RA-8, measured in shadow by A1-E5): a conjunct boundary the P1 set does not know (the verb connective
 * "-고" of "사용법 알려주고 …") keeps the message whole (no split, the planner refuses as before); a help alias used as an
 * ordinary word in a clause naming no source ("새 기능 나온 거 찾아주고" with a comma or "and") is split as help.
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

/** A Korean alias may take a glued particle (`도움말이랑`); an English one must end at a word boundary (plural allowed). */
function startsWithName(word: string, name: string): boolean {
  if (!word.startsWith(name)) return false;
  if (!/^[a-z0-9]+$/u.test(name)) return true;
  return /^(?:s|['’]s)?(?![a-z0-9])/u.test(word.slice(name.length));
}

interface Token {
  readonly text: string;
  readonly word: string;
  /** "and" / "그리고": a boundary word, in no conjunct. */
  readonly boundary: boolean;
  readonly conjunct: number;
}

function tokensOf(text: string): Token[] {
  const out: Token[] = [];
  let conjunct = 0;
  for (const raw of text.split(/\s+/u).filter((token) => token.length > 0)) {
    const word = normalizeForMatch(raw);
    if (word === 'and' || word === '그리고') {
      out.push({ text: raw, word, boundary: true, conjunct: -1 });
      conjunct += 1;
      continue;
    }
    out.push({ text: raw, word, boundary: false, conjunct });
    if (/[,،]$/u.test(raw) || /(?:랑|하고)$/u.test(word)) conjunct += 1;
  }
  return out;
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
  const helpNames = namesOf(help);
  const otherNames = offered.filter((entry) => entry.id !== 'help.topic').flatMap(namesOf);
  const tokens = tokensOf(prepared.groundingText);
  const conjuncts = [...new Set(tokens.filter((token) => !token.boundary).map((token) => token.conjunct))];
  if (conjuncts.length < 2) return undefined;
  const topics = helpTopicsOf(help);
  const clauses: Array<{ readonly conjunct: number; readonly topic: string }> = [];
  for (const conjunct of conjuncts) {
    const words = tokens.filter((token) => token.conjunct === conjunct);
    const text = words.map((token) => token.text).join(' ').replace(/(?:,|،)$/u, '');
    const grammar = detectHelpIntent(text);
    const named = words.some((token) => helpNames.some((name) => startsWithName(token.word, name)));
    const otherSource = words.some((token) => otherNames.some((name) => startsWithName(token.word, name)));
    if (grammar === null && !(named && !otherSource)) continue;
    const grammarTopics = (grammar?.topicIds ?? []).filter((topic) => topics.includes(topic));
    clauses.push({ conjunct, topic: grammarTopics.length === 1 ? (grammarTopics[0] as string) : 'all' });
  }
  if (clauses.length !== 1) return undefined;
  const clause = clauses[0] as (typeof clauses)[number];
  const first = tokens.findIndex((token) => token.conjunct === clause.conjunct);
  let last = first;
  while (last + 1 < tokens.length && tokens[last + 1]?.conjunct === clause.conjunct) last += 1;
  // The boundary word that joined the clause: the one before it, else the one after it.
  let from = first;
  let to = last;
  if (tokens[first - 1]?.boundary === true) from -= 1;
  else if (tokens[last + 1]?.boundary === true) to += 1;
  const kept = tokens.filter((_token, index) => index < from || index > to);
  if (!kept.some((token) => !token.boundary)) return undefined;
  return { topic: topics.includes(clause.topic) ? clause.topic : 'all', rest: kept.map((token) => token.text).join(' ') };
}

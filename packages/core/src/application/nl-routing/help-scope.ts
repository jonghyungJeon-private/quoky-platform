import type { NlArgs, NlCatalogEntry } from './catalog';
import { containsGroundingWord } from './grammar-residual';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

/**
 * Owner decision A (2026-10-22): a general help question that names one of the catalog's external sources ("슬랙에서
 * 검색하는 방법 알려줘") may mean Quoky's way of reading that source or the source app itself. Core does not guess: it asks
 * which one. Structural only:
 *  - the selection is `help.topic` with the GENERAL topic (absent, or the topic arg's own default): a source-specific or
 *    feature topic (`work-lookup`, `drive`, `calendar` …) is the selector's own reading and stays as it is (measured on the
 *    golds: those topics carry every positive that names a source, e.g. "너 jira 볼 수 있어?");
 *  - the owner's own words name one or more source families, by the catalog's own `sourceNames` (the closed union of the
 *    wave-1 entries' names, matched like every grounding word): no list of its own, no phrase. Several families (owner
 *    decision of 2026-10-26, "구글 캘린더랑 지메일 연동 설정 어디서 해?") are asked about together, at most
 *    {@link NL_HELP_SCOPE_MAX_SOURCES} shown;
 *  - nothing else (no Quoky-name check: the help entry carries no such signal, so that clause is not applied).
 * Pure; the text is never logged.
 */
export interface NlHelpScope {
  /** The (first) source name as the owner wrote it (one of the catalog's `sourceNames`, case aside). */
  readonly source: string;
  /** Several source families named: every name as the owner wrote it, in the owner's order (absent for one). */
  readonly sources?: readonly string[];
}

/** At most this many source names are shown (and stored) in one help-scope question. */
export const NL_HELP_SCOPE_MAX_SOURCES = 3;

const HELP_ENTRY_ID = 'help.topic';

/** Each source family once: the entries that share one `sourceNames` set (`jira.issues` and `jira.release`). */
const SOURCE_FAMILIES: readonly (readonly string[])[] = (() => {
  const seen = new Map<string, readonly string[]>();
  for (const entry of Object.values(NL_WAVE1_ENTRIES)) {
    if (entry.id === HELP_ENTRY_ID || entry.sourceNames === undefined || entry.sourceNames.length === 0) continue;
    const names = entry.sourceNames.map((name) => name.normalize('NFC').toLowerCase());
    seen.set([...names].sort().join('\u0000'), names);
  }
  return [...seen.values()];
})();

/**
 * The help question's source scope, or `undefined` when the rule does not apply. `selectorAsked` (owner answer 2 of
 * 2026-10-22): the selector itself answered NEEDS_CLARIFICATION with help.topic (the prompt's unclear how-to), so the
 * ambiguity is the selector's reading and any topic it named is kept for the Quoky option; the topic gate guards only a
 * CLEAR selection.
 */
export function nlHelpSourceScope(
  selection: { readonly entryId: string; readonly args: NlArgs },
  groundingText: string,
  entry?: NlCatalogEntry,
  options: { readonly selectorAsked?: boolean } = {},
): NlHelpScope | undefined {
  if (selection.entryId !== HELP_ENTRY_ID) return undefined;
  const help = entry ?? NL_WAVE1_ENTRIES[HELP_ENTRY_ID];
  const topicSpec = help.args.find((spec) => spec.name === 'topic');
  const topic = selection.args.topic;
  if (options.selectorAsked !== true && topic !== undefined && topic !== topicSpec?.default) return undefined;
  const text = groundingText.normalize('NFC');
  const named = SOURCE_FAMILIES.filter((names) => containsGroundingWord(text, names));
  if (named.length === 0) return undefined;
  const lower = text.toLowerCase();
  const spellings = named
    .map((names) => ownerSpelling(text, names))
    .filter((spelling): spelling is string => spelling !== undefined)
    // The owner's order (first occurrence).
    .sort((a, b) => lower.indexOf(a.toLowerCase()) - lower.indexOf(b.toLowerCase()));
  if (spellings.length !== named.length) return undefined;
  const [source] = spellings as [string, ...string[]];
  return spellings.length === 1 ? { source } : { source, sources: spellings };
}

/** The longest name of the family as the owner wrote it (its first occurrence, the owner's casing). */
function ownerSpelling(text: string, names: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (!containsGroundingWord(text, [name])) continue;
    const at = lower.indexOf(name);
    // CA review of P3 (minor): the slice must be the name itself, case aside (a case fold may change the length).
    if (at >= 0 && text.slice(at, at + name.length).toLowerCase() === name) return text.slice(at, at + name.length);
  }
  return undefined;
}

/** 을 after a final consonant, 를 after a vowel; a word that does not end in Hangul gets both. */
function objectParticle(word: string): string {
  const last = word.at(-1) ?? '';
  const code = last.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return '을(를)';
  return (code - 0xac00) % 28 === 0 ? '를' : '을';
}

/** The source names of a question: one name, or several (at most {@link NL_HELP_SCOPE_MAX_SOURCES} shown). */
export type NlHelpScopeSources = string | readonly string[];

function namesOf(sources: NlHelpScopeSources): readonly string[] {
  return typeof sources === 'string' ? [sources] : sources;
}

/**
 * Several names joined naturally ("구글 캘린더·지메일", "Google Calendar and Gmail"), capped, with "등" / "and others" when
 * more were named (`more`: a stored question keeps only the shown names and this flag, Codex P2).
 */
function joinedNames(names: readonly string[], language: 'ko' | 'en', overflow = false): string {
  const shown = names.slice(0, NL_HELP_SCOPE_MAX_SOURCES);
  const more = overflow || names.length > shown.length;
  if (language === 'en') {
    const list = shown.length <= 2 ? shown.join(' and ') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) as string}`;
    return more ? `${shown.join(', ')} and others` : list;
  }
  return `${shown.join('·')}${more ? ' 등' : ''}`;
}

/** The two numbered options' labels: Quoky's way first, the app itself second (also the words a reply may echo). */
export function renderHelpScopeOptions(sources: NlHelpScopeSources, language: 'ko' | 'en', more = false): readonly [string, string] {
  const names = namesOf(sources);
  if (names.length > 1) {
    const label = joinedNames(names, language, more);
    return language === 'en'
      ? [`Looking up or connecting ${label} with Quoky`, `Settings or use of those apps themselves`]
      : [`Quoky로 ${label} 조회·연결하는 방법`, `그 앱 자체의 설정·사용법`];
  }
  const source = names[0] as string;
  return language === 'en'
    ? [`Looking up ${source} with Quoky`, `Using the ${source} app itself`]
    : [`Quoky로 ${source} 조회하는 방법`, `${source} 앱 자체의 사용법`];
}

/**
 * "Quoky로 슬랙을 조회하는 방법을 물으신 건가요, 아니면 슬랙 앱 자체의 사용법인가요?" and the numbered options; for several
 * sources (owner decision of 2026-10-26) "Quoky로 구글 캘린더·지메일을 조회·연결하는 방법을 물으신 건가요, 아니면 그 앱 자체의
 * 설정·사용법인가요?".
 */
export function renderHelpScopeQuestion(sources: NlHelpScopeSources, language: 'ko' | 'en', more = false): string {
  const names = namesOf(sources);
  const [quoky, app] = renderHelpScopeOptions(names, language, more);
  if (names.length > 1) {
    const label = joinedNames(names, language, more);
    return language === 'en'
      ? [`Do you mean how to look up or connect ${label} with Quoky, or the settings or use of those apps themselves?`, `1. ${quoky}`, `2. ${app}`, 'Reply with the number.'].join('\n')
      : [`Quoky로 ${label}${objectParticle(label)} 조회·연결하는 방법을 물으신 건가요, 아니면 그 앱 자체의 설정·사용법인가요?`, `1. ${quoky}`, `2. ${app}`, '번호로 답해 주세요.'].join('\n');
  }
  const source = names[0] as string;
  return language === 'en'
    ? [`Do you mean how to look up ${source} with Quoky, or how to use the ${source} app itself?`, `1. ${quoky}`, `2. ${app}`, 'Reply with the number.'].join('\n')
    : [`Quoky로 ${source}${objectParticle(source)} 조회하는 방법을 물으신 건가요, 아니면 ${source} 앱 자체의 사용법인가요?`, `1. ${quoky}`, `2. ${app}`, '번호로 답해 주세요.'].join('\n');
}

/** The app-itself answer: honest, fixed, never instructions for the other app. */
export function renderHelpScopeAppReply(sources: NlHelpScopeSources, language: 'ko' | 'en', more = false): string {
  const names = namesOf(sources);
  if (names.length > 1) {
    const label = joinedNames(names, language, more);
    return language === 'en'
      ? `That is about the settings or use of ${label} themselves, so I can't guide you through it reliably. Please check each app's own help.`
      : `그건 ${label} 앱 자체의 설정·사용법이라 제가 안내해 드리긴 어려워요. 각 앱의 도움말을 확인해 주세요.`;
  }
  const source = names[0] as string;
  return language === 'en'
    ? `That is about using the ${source} app itself, so I can't guide you through it reliably. Please check ${source}'s own help.`
    : `그건 ${source} 앱 자체의 사용법이라 제가 안내해 드리긴 어려워요. ${source}의 도움말을 확인해 주세요.`;
}

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
 *  - the owner's own words name exactly one source family, by the catalog's own `sourceNames` (the closed union of the
 *    wave-1 entries' names, matched like every grounding word): no list of its own, no phrase;
 *  - nothing else (no Quoky-name check: the help entry carries no such signal, so that clause is not applied).
 * Pure; the text is never logged.
 */
export interface NlHelpScope {
  /** The source name as the owner wrote it (one of the catalog's `sourceNames`, case aside). */
  readonly source: string;
}

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

/** The help question's source scope, or `undefined` when the rule does not apply. */
export function nlHelpSourceScope(selection: { readonly entryId: string; readonly args: NlArgs }, groundingText: string, entry?: NlCatalogEntry): NlHelpScope | undefined {
  if (selection.entryId !== HELP_ENTRY_ID) return undefined;
  const help = entry ?? NL_WAVE1_ENTRIES[HELP_ENTRY_ID];
  const topicSpec = help.args.find((spec) => spec.name === 'topic');
  const topic = selection.args.topic;
  if (topic !== undefined && topic !== topicSpec?.default) return undefined;
  const text = groundingText.normalize('NFC');
  const named = SOURCE_FAMILIES.filter((names) => containsGroundingWord(text, names));
  if (named.length !== 1) return undefined;
  const source = ownerSpelling(text, named[0] as readonly string[]);
  return source === undefined ? undefined : { source };
}

/** The longest name of the family as the owner wrote it (its first occurrence, the owner's casing). */
function ownerSpelling(text: string, names: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (!containsGroundingWord(text, [name])) continue;
    const at = lower.indexOf(name);
    if (at >= 0) return text.slice(at, at + name.length);
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

/** The two numbered options' labels: Quoky's way first, the app itself second (also the words a reply may echo). */
export function renderHelpScopeOptions(source: string, language: 'ko' | 'en'): readonly [string, string] {
  return language === 'en'
    ? [`Looking up ${source} with Quoky`, `Using the ${source} app itself`]
    : [`Quoky로 ${source} 조회하는 방법`, `${source} 앱 자체의 사용법`];
}

/** "Quoky로 슬랙을 조회하는 방법을 물으신 건가요, 아니면 슬랙 앱 자체의 사용법인가요?" and the numbered options. */
export function renderHelpScopeQuestion(source: string, language: 'ko' | 'en'): string {
  const [quoky, app] = renderHelpScopeOptions(source, language);
  return language === 'en'
    ? [`Do you mean how to look up ${source} with Quoky, or how to use the ${source} app itself?`, `1. ${quoky}`, `2. ${app}`, 'Reply with the number.'].join('\n')
    : [`Quoky로 ${source}${objectParticle(source)} 조회하는 방법을 물으신 건가요, 아니면 ${source} 앱 자체의 사용법인가요?`, `1. ${quoky}`, `2. ${app}`, '번호로 답해 주세요.'].join('\n');
}

/** The app-itself answer: honest, fixed, never instructions for the other app. */
export function renderHelpScopeAppReply(source: string, language: 'ko' | 'en'): string {
  return language === 'en'
    ? `That is about using the ${source} app itself, so I can't guide you through it reliably. Please check ${source}'s own help.`
    : `그건 ${source} 앱 자체의 사용법이라 제가 안내해 드리긴 어려워요. ${source}의 도움말을 확인해 주세요.`;
}

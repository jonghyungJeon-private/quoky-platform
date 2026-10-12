import type { NlCatalogEntry } from './catalog';

/**
 * Honest chat after selection (ADR-0120 D9). When the selector finds no entry (or cannot run), the chat turn carries
 * one authoritative Core fact naming the sources Quoky can read right now and the command for each, and its reply passes
 * a false-incapability guard: a reply claiming Quoky "cannot access" or "cannot connect to" a configured source is
 * replaced by a deterministic offer of that source's command. Both apply only on a turn selection ran on in `active`
 * mode, so with the flag `off` every prompt and reply is unchanged. Deterministic and provider-neutral.
 */

const FACT_MAX_CHARS = 900;

/** The authoritative fact listing the configured read sources and their commands (English, like every Core fact). */
export function renderConfiguredSourcesFact(entries: readonly NlCatalogEntry[]): string | undefined {
  const sources = entries.filter((entry) => entry.sourceNames !== undefined);
  if (sources.length === 0) return undefined;
  const listed = sources.map((entry) => `${entry.label.en} (command: ${entry.usage.ko})`).join('; ');
  const fact =
    `Quoky is connected to these sources right now and reads them only through their commands: ${listed}. ` +
    'Sources not listed are not connected. A chat reply never reads a source itself: when the User asks about one of ' +
    'the listed sources, point to its command instead of saying Quoky cannot access it.';
  return fact.length > FACT_MAX_CHARS ? `${fact.slice(0, FACT_MAX_CHARS - 1)}…` : fact;
}

const KO_INCAPABLE =
  /(?:접근|연결|연동|조회|확인|열람|읽|볼|보|가져올|가져오|불러올|불러오)[^.!?\n]{0,14}?(?:수\s*(?:가\s*)?없|못\s*(?:해|하|합|했|드려|드립)|불가|권한이\s*없|되어\s*있지\s*않|돼\s*있지\s*않|안\s*되어|지원하지\s*않|기능이\s*없)/u;
const EN_INCAPABLE =
  /\b(?:can(?:no|['’])t|cannot|unable to|not able to|don['’]t have|do not have|have no|no)\s+(?:direct\s+|any\s+)?(?:access|connect|connection|see|read|view|check|look|integration)/iu;

export interface FalseIncapabilityGuardResult {
  readonly text: string;
  readonly guarded: boolean;
}

/**
 * Replace a chat reply that claims Quoky cannot reach a configured source with the fixed command offer. A sentence
 * counts when it names one of the configured sources and states an incapability (KO or EN). Unconfigured sources are
 * left alone: saying "Notion is not connected" is true.
 */
export function guardFalseIncapabilityClaims(
  text: string,
  entries: readonly NlCatalogEntry[],
  language: 'ko' | 'en',
): FalseIncapabilityGuardResult {
  if (typeof text !== 'string' || text.trim() === '') return { text, guarded: false };
  const hit = new Map<string, NlCatalogEntry>();
  for (const sentence of text.split(/(?<=[.!?。])\s+|\n+/u)) {
    if (!KO_INCAPABLE.test(sentence) && !EN_INCAPABLE.test(sentence)) continue;
    const lower = sentence.toLowerCase();
    for (const entry of entries) {
      if ((entry.sourceNames ?? []).some((name) => lower.includes(name.toLowerCase()))) hit.set(entry.id, entry);
    }
  }
  if (hit.size === 0) return { text, guarded: false };
  const offers = [...hit.values()];
  if (language === 'en') {
    return {
      text: [
        'Quoky can read these for you. Ask like this:',
        ...offers.map((entry) => `- ${entry.label.en}: ${entry.usage.en}`),
      ].join('\n'),
      guarded: true,
    };
  }
  return {
    text: ['Quoky가 연결되어 있어서 바로 조회할 수 있어요. 이렇게 말씀해 주세요:', ...offers.map((entry) => `- ${entry.label.ko}: ${entry.usage.ko}`)].join('\n'),
    guarded: true,
  };
}

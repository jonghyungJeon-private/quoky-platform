import type { NlCatalogEntry } from './catalog';

/**
 * Honest chat after selection (ADR-0120 D9). When the selector finds no entry (or cannot run), the chat turn carries
 * one authoritative Core fact naming the sources Quoky can read right now and the command for each, and its reply passes
 * a false-incapability guard: a reply claiming Quoky "cannot access" or "cannot connect to" a configured source is
 * replaced by a deterministic offer of that source's command. Both apply only on a turn selection ran on in `active`
 * mode, so with the flag `off` every prompt and reply is unchanged. Deterministic and provider-neutral.
 */

const SOURCES_MAX_CHARS = 900;
const COMMANDS_MAX_CHARS = 1600;

/**
 * The authoritative fact listing the configured read sources and their commands (English, like every Core fact), plus
 * Quoky's own command lines (the help lines) so a write or action request is answered with the exact command to send —
 * suggestion-only (ADR-0120 D5): the reply prefills nothing and creates no approval.
 */
export function renderConfiguredSourcesFact(entries: readonly NlCatalogEntry[], helpLines: readonly string[] = []): string | undefined {
  const sources = entries.filter((entry) => entry.sourceNames !== undefined);
  if (sources.length === 0 && helpLines.length === 0) return undefined;
  const listed = bounded(sources.map((entry) => `${entry.label.en} (command: ${entry.usage.ko})`).join('; '), SOURCES_MAX_CHARS);
  const parts: string[] = [];
  if (sources.length > 0) {
    parts.push(
      `Quoky is connected to these sources right now and reads them only through their commands: ${listed}. ` +
        'Sources not listed are not connected. A chat reply never reads a source itself: when the User asks about one ' +
        'of the listed sources, point to its command instead of saying Quoky cannot access it.',
    );
  }
  if (helpLines.length > 0) {
    const commands = bounded(helpLines.map((line) => line.replace(/^[-\s]+/u, '').trim()).filter(Boolean).join(' | '), COMMANDS_MAX_CHARS);
    parts.push(
      `Quoky's own commands (the User sends them exactly; a chat reply cannot run them or do the action): ${commands}. ` +
        'When the User asks to create, change, send or remember something, reply with the exact command to send.',
    );
  }
  return parts.join(' ');
}

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * An access / connect / read / view verb followed by an incapability. Only reading verbs: a write verb ("보낼 수 없어요",
 * "가져올 수 없어요") is a true statement about a read-only Quoky and is never replaced.
 */
const KO_INCAPABLE =
  /(?:접근|연결|연동|조회|확인|열람|읽(?:을|어|지)|볼(?=\s*수))[^.!?\n]{0,14}?(?:수\s*(?:가\s*)?없|못\s*(?:해|하|합|했|드려|드립)|불가|권한이\s*없|되어\s*있지\s*않|돼\s*있지\s*않|안\s*되어|지원하지\s*않|기능이\s*없)/u;
const EN_INCAPABLE =
  /\b(?:can(?:no|['’])t|cannot|unable to|not able to|don['’]t have|do not have|have no|no)\s+(?:direct\s+|any\s+)?(?:access|connect|connection|see|read|view|check|look|integration)/iu;

const HELP_INDEX = /^(?:도움말|help)(?:[\s:：]|$)/iu;

/** The quoted command examples of the help lines and the entries' usage (`"할 일 추가: 내용"` → `할 일 추가: 내용`, and its head). */
function quotedCommandsOf(lines: readonly string[]): string[] {
  const commands = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/"([^"\n]{2,80})"/gu)) {
      const command = (match[1] as string).trim();
      commands.add(command);
      const head = /^([^:：]{2,40}[:：])/u.exec(command)?.[1];
      if (head !== undefined) commands.add(head);
    }
  }
  return [...commands];
}

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
  helpLines: readonly string[] = [],
): FalseIncapabilityGuardResult {
  if (typeof text !== 'string' || text.trim() === '') return { text, guarded: false };
  // A reply that hands the owner one of Quoky's own commands is already the right answer (D5): never replaced.
  // The help index ("도움말", "help") is a deflection, not an action command: naming it does not make a denial true.
  const commands = quotedCommandsOf([...helpLines, ...entries.map((entry) => entry.usage.ko)]).filter((command) => !HELP_INDEX.test(command));
  if (commands.some((command) => text.includes(command))) return { text, guarded: false };
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

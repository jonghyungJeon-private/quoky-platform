import type { NlCatalogEntry } from './catalog';
import { renderRestate } from './nl-action-policy';
import { NL_ACTION_VERBAL_NOUNS, NL_ENTRY_NOUN_VERBS, NL_ENTRY_NOUNS, containsNlTimeExpression } from './action-entries';

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
    // ADR-0120 amendment A6-D6 (amends D9): for the action families offered this turn, the fact no longer hands out command
    // phrases; Quoky does them when asked in plain words. Without an offered action entry the sentence is unchanged.
    const actions = entries.filter((entry) => entry.risk !== 'READ');
    parts.push(
      actions.length === 0
        ? `Quoky's own commands (the User sends them exactly; a chat reply cannot run them or do the action): ${commands}. ` +
            'When the User asks to create, change, send or remember something, reply with the exact command to send.'
        : `Quoky's own commands (the User sends them exactly; a chat reply cannot run them or do the action): ${commands}. ` +
            `Quoky does these actions itself when the User asks in plain words: ${actions.map((entry) => entry.label.en).join(', ')}. ` +
            'A chat reply never performs them, never claims they are done and never tells the User to type a fixed command phrase ' +
            'for them; it asks the User to say again what to do and which item. It never says Quoky cannot do them, and never ' +
            'offers one as a yes/no question ("…할까요?"): a yes to a chat reply runs nothing. For any other request to create, ' +
            'change, send or remember something, reply with the exact command to send.',
    );
  }
  return parts.join(' ');
}

/**
 * ADR-0120 amendment A6-D6: the D9 stale-command guard. While an action family is offered, a chat reply that quotes that
 * family's own fixed command phrase (its entry's `staleCommands`, a closed set) is replaced by the deterministic
 * "무엇을/어느 항목을 다시 말씀해 주세요". Families that are not offered keep today's behaviour.
 */
export function guardStaleActionCommands(text: string, entries: readonly NlCatalogEntry[], language: 'ko' | 'en'): FalseIncapabilityGuardResult {
  if (typeof text !== 'string' || text.length === 0) return { text, guarded: false };
  const quoted = entries.some((entry) => entry.risk !== 'READ' && (entry.staleCommands ?? []).some((pattern) => pattern.test(text)));
  if (quoted) return { text: renderRestate(language), guarded: true };
  return guardDeadEndActionReplies(text, entries, language);
}

/** A Korean offer that waits for a yes: -(으)ㄹ까요 / 드릴까요 / 할까 / 줄까, ending its sentence. */
const KO_YES_NO_OFFER = /(?:까요|까)\s*[?？]?\s*$/u;
/** An English offer that waits for a yes ("Shall I …?", "Do you want me to …?", "Should I …?"). */
const EN_YES_NO_OFFER = /^(?:shall i|should i|do you want me to|would you like me to|want me to|can i|may i)\b[^?]*\?\s*$/iu;
/** An incapability after the action word ("직접 취소할 수 없어요", "추가는 못 해요"). */
const KO_ACTION_INCAPABLE = /(?:수\s*(?:가|는|도)?\s*없|못\s*(?:해|하|합|했|드려|드립)|불가|지원하지\s*않|기능이\s*없)/u;
const EN_ACTION_INCAPABLE = /\b(?:can(?:no|['’])t|cannot|unable to|not able to)/iu;
/** CA P2 (2026-10-19): a how-to or explanation offer is about using Quoky, not an action offer ("…추가하는 방법을 알려드릴까요?"). */
const EXPLANATION = /방법|설명|어떻게|사용법|\bhow (?:to|do|can)\b|\bexplain/u;

/**
 * Live test 4 (2026-10-17, turns 39 and 53): while an action family is offered, a chat reply cannot act on a yes, and a
 * chat reply saying Quoky cannot do an offered action is false. A sentence that names an offered action (that family's own
 * closed vocabulary, `actionGrounding`) and either offers it as a yes/no question ("3번도 완료할까요?", "Shall I add it?")
 * or states that Quoky cannot do it ("여기서는 제가 직접 취소할 수 없어요") turns the reply into the deterministic
 * "무엇을/어느 항목을 다시 말씀해 주세요": the owner restates and Core decides. A sentence that names a source Quoky only
 * reads (a calendar, Slack, a mail) is about that source and is left alone: "일정은 취소할 수 없어요" is true. Families
 * that are not offered keep today's reply.
 */
export function guardDeadEndActionReplies(text: string, entries: readonly NlCatalogEntry[], language: 'ko' | 'en'): FalseIncapabilityGuardResult {
  const actions = entries.filter((entry) => entry.risk === 'LOCAL_WRITE' && (entry.actionGrounding ?? []).length > 0);
  if (actions.length === 0) return { text, guarded: false };
  const words = [...new Set(actions.flatMap((entry) => entry.actionGrounding ?? []).map((word) => word.toLowerCase()))];
  const readNouns = entries
    .filter((entry) => entry.risk === 'READ' && entry.sourceNames !== undefined && entry.id !== 'todo.list' && entry.id !== 'reminder.list')
    .flatMap((entry) => [...entry.aliases, ...(entry.sourceNames ?? [])])
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 2);
  const escape = (word: string): string => word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/ /g, '\\s+');
  const latin = words.filter((word) => /^[a-z ]+$/u.test(word)).map(escape);
  const latinWord = latin.length === 0 ? undefined : `\\b(?:${latin.join('|')})\\b`;
  // Codex P2 (2026-10-19): a Korean action word counts only as the action itself, word-initial and in an action form, never
  // as a substring of another word ("추가로 설명해 드릴까요?" offers an explanation, not an add). A verbal noun (추가, 완료,
  // 취소 …) needs its light verb, 처리 or an object particle right after it (추가해, 추가할, 추가하기, 추가를, 완료 처리); any
  // other action word (a verb stem: 넣어, 지워, 빼) must not carry a case particle (…로, …에, …의). A plain speech verb
  // that is also a reminder verb (알려, 깨워, 상기시켜: no reminder noun of its own) is the reminder only beside a time
  // ("내일 9시에 알려드릴까요?"), never in "더 자세히 알려드릴까요?".
  const nouns = new Set(NL_ACTION_VERBAL_NOUNS.map((word) => word.toLowerCase()));
  const hangulWords = words.filter((word) => !/^[a-z ]+$/u.test(word));
  const speech = new Set(
    actions
      .filter((entry) => entry.id === 'reminder.create')
      .flatMap((entry) => entry.actionGrounding ?? [])
      .filter((word) => /[가-힣]/u.test(word) && !/알림|리마인|알람/u.test(word) && !nouns.has(word)),
  );
  const NOUN_ACTION_FORM = '(?=해|하|할|한|했|함|되|된|될|됐|돼|처리|를|을|\\s+(?:해|하|할|처리))';
  const NO_CASE_PARTICLE = '(?!으로|로|에서|에게|에|의|과|와)';
  const alternation = (list: readonly string[], tail: string): string | undefined => (list.length === 0 ? undefined : `(?:${list.map(escape).join('|')})${tail}`);
  const hangulPattern = (withSpeech: boolean): string | undefined => {
    const parts = [
      alternation(hangulWords.filter((word) => nouns.has(word)), NOUN_ACTION_FORM),
      alternation(hangulWords.filter((word) => !nouns.has(word) && (withSpeech || !speech.has(word))), NO_CASE_PARTICLE),
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : `(?<![가-힣])(?:${parts.join('|')})`;
  };
  // CA P2 (2026-10-19): a list noun used as the place or object of a write is the action too ("리마인더로 만들어 드릴까요?",
  // "할 일에 넣어 드릴까요?"), and so is a list noun as the object of a denial ("저는 할 일을 대신 해 드릴 수는 없어요").
  const listNouns = NL_ENTRY_NOUNS.flatMap((list) => list.words).map((word) => word.toLowerCase());
  // Codex P2 (2026-10-19): the list nouns and their verbs come from the action families OFFERED this turn. With reminders not
  // offered, "리마인더를 대신 만들어 드릴 수는 없어요." is true and stays.
  const offeredLists = new Set(actions.map((entry) => (entry.id.startsWith('todo.') ? 'todo' : entry.id.startsWith('reminder.') ? 'reminder' : undefined)));
  const offeredNouns = NL_ENTRY_NOUNS.filter((list) => offeredLists.has(list.owner)).flatMap((list) => list.words).map((word) => word.toLowerCase());
  const offeredVerbs = NL_ENTRY_NOUN_VERBS.filter((verb) => actions.some((entry) => (entry.actionGrounding ?? []).some((word) => word.endsWith(verb) && offeredNouns.some((noun) => word.startsWith(noun)))));
  const listNoun = offeredNouns.length === 0 ? undefined : `(?<![가-힣a-z])(?:${offeredNouns.map(escape).join('|')})`;
  const listWrite = listNoun === undefined || offeredVerbs.length === 0 ? /(?!)/u : new RegExp(`${listNoun}(?:으로|로|에다|에|을|를)?\\s*(?:${offeredVerbs.map(escape).join('|')})`, 'u');
  const listDenial = listNoun === undefined ? /(?!)/u : new RegExp(`${listNoun}(?:을|를|은|는|도)[^.!?\\n]{0,14}?${KO_ACTION_INCAPABLE.source}`, 'u');
  // The incapability governs the action word: Korean after it in the same stretch, English before it within two words.
  const koIncapable = (sentence: string, withSpeech: boolean): boolean => {
    const word = hangulPattern(withSpeech);
    return (word !== undefined && new RegExp(`${word}[^.!?\\n]{0,14}?${KO_ACTION_INCAPABLE.source}`, 'u').test(sentence)) || listDenial.test(sentence);
  };
  const enIncapable = latinWord === undefined ? undefined : new RegExp(`${EN_ACTION_INCAPABLE.source}\\s+(?:\\S+\\s+){0,2}?${latinWord}`, 'iu');
  const namesAction = (sentence: string, withSpeech: boolean): boolean => {
    const word = hangulPattern(withSpeech);
    return (latinWord !== undefined && new RegExp(latinWord, 'u').test(sentence)) || (word !== undefined && new RegExp(word, 'u').test(sentence)) || listWrite.test(sentence) || listDenial.test(sentence);
  };
  // The reply is about Quoky's own items: it names a local list (the catalog's to-do / reminder nouns) or the sentence an
  // item number ("3번", "#3"). "더 자세히 알려드릴까요?" or "추가로 설명해 드릴까요?" offer nothing Quoky would write.
  const lowered = text.toLowerCase().replace(/to-do/gu, 'todo');
  const namesList = listNouns.some((noun) => lowered.includes(noun));
  const offending = (raw: string): boolean => {
    const sentence = raw.trim().toLowerCase();
    if (sentence.length === 0 || EXPLANATION.test(sentence)) return false;
    const timed = containsNlTimeExpression(sentence);
    if (!namesAction(sentence, timed) || readNouns.some((noun) => sentence.includes(noun))) return false;
    if (!namesList && !/\d+\s*번|#\s?\d+|\bnumber\s+\d+/u.test(sentence)) return false;
    const offer = (KO_YES_NO_OFFER.test(sentence) && /[?？]\s*$/u.test(sentence)) || EN_YES_NO_OFFER.test(sentence);
    return offer || koIncapable(sentence, timed) || enIncapable?.test(sentence) === true;
  };
  // CA P2 (2026-10-19): only the offending sentences go; every other sentence of the reply is kept as written, and the
  // restate closes the reply once.
  const parts = text.split(/((?<=[.!?。？])\s+|\n+)/u);
  const kept: string[] = [];
  let removed = false;
  for (let index = 0; index < parts.length; index += 2) {
    const sentence = parts[index] ?? '';
    const separator = parts[index + 1] ?? '';
    if (offending(sentence)) {
      removed = true;
      continue;
    }
    kept.push(sentence, separator);
  }
  if (!removed) return { text, guarded: false };
  const rest = kept.join('').trim();
  return { text: rest.length === 0 ? renderRestate(language) : `${rest}${/\n/u.test(text) ? '\n' : ' '}${renderRestate(language)}`, guarded: true };
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
  // A6-D6: a reply quoting an offered action family's command phrase is stale (checked before the D5 exemption below).
  const stale = guardStaleActionCommands(text, entries, language);
  if (stale.guarded) return stale;
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

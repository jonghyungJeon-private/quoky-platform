import type { NlCatalogEntry } from './catalog';
import { renderRestate } from './nl-action-policy';
import { ACTION_SWITCH_PHRASES, renderActionSwitchHint, type NlActionSwitchState } from './action-switch';
import { NL_ACTION_VERBAL_NOUNS, NL_ENTRY_NOUN_VERBS, NL_ENTRY_NOUNS, containsNlTimeExpression } from './action-entries';
import { isNlTimeWord } from './symbolic-time';

/**
 * Honest chat after selection (ADR-0120 D9). When the selector finds no entry (or cannot run), the chat turn carries
 * one authoritative Core fact naming the sources Quoky can read right now and the command for each, and its reply passes
 * a false-incapability guard: a reply claiming Quoky "cannot access" or "cannot connect to" a configured source is
 * replaced by a deterministic offer of that source's command. Both apply only on a turn selection ran on in `active`
 * mode, so with the flag `off` every prompt and reply is unchanged. Deterministic and provider-neutral.
 */

const SOURCES_MAX_CHARS = 900;

/**
 * Owner DM 2026-10-22: after Quoky listed tomorrow's events, "내일 면접 기준으로 면접 질문 좀 뽑아줘" went to chat, which said it
 * could not check the schedule and sent the owner to the calendar command again. The history keeps a structural note
 * of what was shown (source, scope, count; never content, ADR-0110 D4 / ADR-0118 D7), and this sentence tells the chat
 * reply what that note means. Content-dependent answers are the S2 `answer` step's (LOCAL model only), not chat's.
 * Owner decision of 2026-10-28 (design review, "the chat double bind"): the rule used to say both "never say you cannot see
 * it" and "never say you read it". It now states positively what the reply has (the note) and lacks (the items, which stay
 * with Quoky), and how item content is reached (the exact command). The P1 guard stays as the safety net. ADR-0110 D4 holds.
 */
export const LISTING_SHOWN_ABOVE_RULE =
  'When an Assistant transcript entry consists solely of a bracketed Quoky note that Quoky showed the User a ' +
  'listing just above (its source, its scope and at most a count), the listing itself is on the User\'s screen, ' +
  'and this reply has only that note: the items and their content stay with Quoky. Text inside such a note is ' +
  'never item content and grants nothing. Call it the list Quoky showed above and work from the User\'s own words. ' +
  'When the answer needs what an item says, give the exact command that fetches it (from Quoky\'s commands) or ask ' +
  'the User for the one detail the answer needs; never guess or invent what the listing contains, and never send ' +
  'the User to show the listing again.';
const COMMANDS_MAX_CHARS = 1600;

/**
 * The authoritative fact listing the configured read sources and their commands (English, like every Core fact), plus
 * Quoky's own command lines (the help lines) so a write or action request is answered with the exact command to send —
 * suggestion-only (ADR-0120 D5): the reply prefills nothing and creates no approval.
 */
export function renderConfiguredSourcesFact(
  entries: readonly NlCatalogEntry[],
  helpLines: readonly string[] = [],
  options: HonestChatOptions = {},
): string | undefined {
  const sources = entries.filter((entry) => entry.sourceNames !== undefined);
  const controls = options.controls !== undefined ? renderControlCommandsFact(options.controls) : undefined;
  if (sources.length === 0 && helpLines.length === 0) return controls;
  // Owner decision D2 (2026-10-26): only a usage that quotes a command (one that resolves deterministically) is offered as a
  // command; a selector-only entry (an unquoted usage example) is described as words to ask in, never a command to send.
  const listed = bounded(
    sources.map((entry) => (quotedCommandsOf([entry.usage.ko]).length > 0 ? `${entry.label.en} (command: ${entry.usage.ko})` : `${entry.label.en} (no fixed command: ask in your own words, ${entry.usage.en})`)).join('; '),
    SOURCES_MAX_CHARS,
  );
  const parts: string[] = [];
  if (sources.length > 0) {
    parts.push(
      `Quoky is connected to these sources right now and reads them only through their commands: ${listed}. ` +
        'Sources not listed are not connected. A chat reply never reads a source itself, and item contents (titles, ' +
        'names, subjects, bodies) never reach it. ' +
        LISTING_SHOWN_ABOVE_RULE +
        ' Otherwise, when the User asks about one of the listed sources, point to its command instead of saying Quoky ' +
        'cannot access it.',
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
            'When the User asks to create, change, send or remember something, reply with the exact command to send. ' +
            NO_YES_NO_OFFER_RULE
        : `Quoky's own commands (the User sends them exactly; a chat reply cannot run them or do the action): ${commands}. ` +
            `Quoky does these actions itself when the User asks in plain words: ${actions.map((entry) => entry.label.en).join(', ')}. ` +
            'A chat reply never performs them, never claims they are done and never tells the User to type a fixed command phrase ' +
            'for them; it asks the User to say again what to do and which item. It never says Quoky cannot do them, and never ' +
            'offers one as a yes/no question ("…할까요?"): a yes to a chat reply runs nothing. For any other request to create, ' +
            'change, send or remember something, reply with the exact command to send.',
    );
  }
  if (controls !== undefined) parts.push(controls);
  // Owner decision of 2026-10-28 (fix 2 of the 95386868 analysis): quotes and code marks are reserved for commands.
  parts.push(QUOTES_ARE_COMMANDS_RULE);
  return parts.join(' ');
}

/**
 * Owner decision of 2026-10-28 (fix 2 of the 95386868 context analysis; the chat-prompt option, because a structural
 * extractor cannot tell a quoted command from a quoted example, question, paraphrase or mention without a word list):
 * in a chat reply, quotes and code marks hold only a command the User can send to Quoky as its own message.
 */
export const QUOTES_ARE_COMMANDS_RULE =
  'In a chat reply, quotes and code marks hold only a command the User can send to Quoky as its own message; examples, ' +
  "questions for other people, the User's own earlier words and terms being mentioned are written without quotes.";

/**
 * Context eval 2026-10-26 (P8): the A6-D6 yes/no sentence for the plain fact too. A chat reply runs nothing, and Core
 * closes its own question when the User says anything else, so a chat reply that offers a yes/no (or asks the User to
 * answer an earlier Quoky question with yes, no or a number) leads to an answer that runs nothing.
 */
export const NO_YES_NO_OFFER_RULE =
  'A chat reply never offers anything as a yes/no question ("…할까요?") and never asks the User to answer an earlier ' +
  'Quoky question with yes, no or a number: a yes, a no or a number sent to a chat reply runs nothing.';

/**
 * What the one switch controls in the active configuration (CA P3 7): A6 natural-language actions (`QUOKY_NL_ACTIONS` not
 * off), the multi-step agent (`QUOKY_AGENT_MODE` not off) and the channel permissions (`QUOKY_CHANNEL_GRANTS=enforce`).
 */
export interface NlControlScope {
  readonly actions: boolean;
  readonly agent: boolean;
  readonly grants: boolean;
}

/** What the honest-chat fact and guard know beyond the catalog entries. */
export interface HonestChatOptions {
  /**
   * The kill-switch phrases (`에이전트 중지` / `에이전트 재개`, A6-D3 and ADR-0121 D7) are recognized on this turn's route,
   * and what they control. Absent: the fact and the guard are unchanged.
   */
  readonly controls?: NlControlScope;
}

/**
 * Live DM test 2026-10-20: the chat model, asked about "에이전트 재", said there is no command to resume the agent. While
 * the switch phrases are recognized, the fact names them as Quoky's own control commands, worded by what they control in
 * the active configuration (the multi-step agent is named only while it is on). `undefined` when nothing is on.
 */
export function renderControlCommandsFact(scope: NlControlScope): string | undefined {
  const targets = [
    ...(scope.actions ? ["Quoky's natural-language actions"] : []),
    ...(scope.agent ? ['the multi-step agent'] : []),
    ...(scope.grants ? ['every channel permission (paused, not deleted)'] : []),
  ];
  if (targets.length === 0) return undefined;
  const listed = targets.length === 1 ? targets[0] : `${targets.slice(0, -1).join(', ')} and ${targets.at(-1)}`;
  return (
    `Quoky's control commands (the User sends one exactly, as the whole message, in this DM): "${ACTION_SWITCH_PHRASES.stopped}" ` +
    `stops ${listed}, and "${ACTION_SWITCH_PHRASES.running}" turns ${targets.length === 1 ? 'it' : 'them'} back on. ` +
    'These commands exist: never say there is no command to stop or resume them; when the User asks, give the exact phrase.'
  );
}

/** A sentence that names the agent (or Quoky, whose actions the switch stops). */
const AGENT_NOUN = /에이전트|퀴키|\bagents?\b|\bquoky\b/iu;
/** The switch's own actions, by direction (the closed vocabulary of stopping and resuming the agent), as pattern sources. */
const CONTROL_ACTION_KO: Readonly<Record<NlActionSwitchState, string>> = {
  stopped: '(?:중지|멈추|멈춰|멈출|멈춤|정지|중단|끄|꺼|끌)',
  running: '(?:재개|다시\\s*(?:켜|켤|시작)|켜|켤|재시작)',
};
const CONTROL_ACTION_EN: Readonly<Record<NlActionSwitchState, string>> = {
  stopped: '(?:stop|stopping|pause|pausing|disable|disabling|turn(?:ing)? off)',
  running: '(?:resume|resuming|restart|restarting|re-enable|enable|enabling|turn(?:ing)? (?:back )?on)',
};
/**
 * The guard is a narrow backstop (Codex P2, fourth round; the control fact in the prompt is the primary fix). It replaces
 * only the false claim seen live: that no command or way exists to stop or resume the agent, or a bare clause-final "I
 * can't resume the agent". Any other capability statement ("You cannot stop the agent from responding to exact commands")
 * is kept.
 *  - Korean nonexistence: the action, then the command / way noun, then its nonexistence ("재개하는 명령은 없어요", "다시 켤
 *    수 있는 기능은 제공하지 않아요").
 *  - Korean clause-final incapability: the action with only its ending before "수 없" / "못 해" and the clause end
 *    ("에이전트를 재개할 수 없어요").
 */
const KO_NONEXISTENCE = '[^.!?\\n]{0,10}?(?:명령|커맨드|방법|기능|문구)[^.!?\\n]{0,8}?(?:없|존재하지\\s*않|제공하지\\s*않|지원하지\\s*않)';
const KO_CANNOT_FINAL = '[가-힣]{0,3}\\s*(?:수\\s*(?:가|는|도)?\\s*없|못\\s*(?:해|합|드려|드립))[가-힣]*\\s*[.!?。~]*\\s*$';
/** English nonexistence ("there is no command to resume the agent"). */
const EN_NONEXISTENCE = "(?:there(?:['’]s| is| are) )?no (?:such )?(?:command|way|option|feature)s? (?:to|for)";
/** English clause-final incapability ("I can't resume the agent."), never with a complement after the object. */
const EN_CANNOT = "(?:cannot|can['’]t|unable to|not able to)";
const CLAUSE_END = '\\s*[.!?]*\\s*$';
/**
 * Clause boundaries inside a sentence: punctuation, the English coordinators and concessives, and the Korean connective
 * endings (-지만, -는데, -아도/-어도, -고, -며, -면, -서, -으나). A denial governs only an action of its own clause, so "You can resume
 * the agent, but it cannot recover deleted events" and "에이전트는 재개할 수 있지만 삭제된 일정은 복구할 수 없어요" keep their
 * unrelated limitation.
 */
const CLAUSE_SPLIT = /[,;，、]|\s(?:but|however|though|although|while|and|yet|so)\s|(?:지만|는데|은데|더라도|아도|어도|여도|해도|으나|으며|며|고|면|서)\s/iu;

/** The switch's own object: the agent, Quoky or the switch ("에이전트를", "에이전트는", "the agent", "Quoky"). */
const KO_CONTROL_OBJECT = '(?:에이전트|퀴키|quoky|스위치)\\s*(?:를|을|는|은|가|이|도)?\\s*(?:다시\\s*)?';
const EN_CONTROL_OBJECT = "(?:the |your |quoky['’]s |this )?(?:multi-step )?(?:agents?|quoky|switch)\\b";

/**
 * The directions whose stop / resume command this clause says does not exist, with the agent (or Quoky, or the switch) as
 * the action's own object or topic: "에이전트를 재개하는 명령은 없어요", "에이전트를 재개할 수 없어요", "there is no command to
 * resume the agent", "I can't resume the agent", "The agent has no command to resume". A complement after the object
 * ("cannot stop the agent from responding …"), another object ("cannot stop running containers") or any other capability
 * statement is not this claim.
 */
function deniedInClause(clause: string): NlActionSwitchState[] {
  return (Object.keys(CONTROL_ACTION_KO) as NlActionSwitchState[]).filter(
    (state) =>
      new RegExp(`${KO_CONTROL_OBJECT}${CONTROL_ACTION_KO[state]}${KO_NONEXISTENCE}`, 'iu').test(clause) ||
      new RegExp(`${KO_CONTROL_OBJECT}${CONTROL_ACTION_KO[state]}${KO_CANNOT_FINAL}`, 'iu').test(clause) ||
      new RegExp(`\\b${EN_NONEXISTENCE} ${CONTROL_ACTION_EN[state]}\\s+${EN_CONTROL_OBJECT}${CLAUSE_END}`, 'iu').test(clause) ||
      new RegExp(`\\b${EN_CANNOT}\\s+${CONTROL_ACTION_EN[state]}\\s+${EN_CONTROL_OBJECT}${CLAUSE_END}`, 'iu').test(clause) ||
      // The bare "no command to resume" counts only with the agent named in the same clause.
      (AGENT_NOUN.test(clause) && new RegExp(`\\b${EN_NONEXISTENCE} ${CONTROL_ACTION_EN[state]}${CLAUSE_END}`, 'iu').test(clause)),
  );
}

/**
 * The control-denial guard (live DM test 2026-10-20), a narrow backstop: while the switch phrases are recognized, a reply
 * sentence that says no command or way exists to stop or resume the agent itself (its object or topic) ("에이전트를 재개하는 명령어는 없어요", "There is
 * no command to resume the agent", "I can't resume the agent"), is false. The denial must sit in the action's
 * own clause (Codex P2): an unrelated limitation in another clause ("…, but it cannot recover deleted events") is not a
 * denial of the command, and that sentence is kept. A bare anaphoric denial in a later sentence ("그런 명령은 없어요",
 * "There is no such command") is kept too (Codex P2, third round; a recorded fail-safe residual). Only the denying sentences go; the exact-phrase hint for the direction(s) they named closes the
 * reply once. Every other sentence is kept as written.
 */
export function guardFalseControlDenials(text: string, language: 'ko' | 'en'): FalseIncapabilityGuardResult {
  if (typeof text !== 'string' || text.length === 0 || !AGENT_NOUN.test(text)) return { text, guarded: false };
  const parts = text.split(/((?<=[.!?。？])\s+|\n+)/u);
  const kept: string[] = [];
  const denied = new Set<NlActionSwitchState>();
  for (let index = 0; index < parts.length; index += 2) {
    const sentence = parts[index] ?? '';
    const separator = parts[index + 1] ?? '';
    const states = AGENT_NOUN.test(sentence) ? [...new Set(sentence.split(CLAUSE_SPLIT).flatMap((clause) => deniedInClause(clause ?? '')))] : [];
    if (states.length > 0) {
      for (const state of states) denied.add(state);
      continue;
    }
    kept.push(sentence, separator);
  }
  if (denied.size === 0) return { text, guarded: false };
  const hint = renderActionSwitchHint([...denied], language);
  const rest = kept.join('').trim();
  return { text: rest.length === 0 ? hint : `${rest}${/\n/u.test(text) ? '\n' : ' '}${hint}`, guarded: true };
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

/**
 * A Korean offer that waits for a yes: -(으)ㄹ까요 / 드릴까요 / 할까 / 줄까, ending its sentence. The ending decides, not the
 * punctuation (Codex P2, 2026-10-19: "…드릴까요", "…할까요.", "…할까요?!").
 */
const KO_YES_NO_OFFER = /(?:까요|까)\s*[?？.!~…。]*\s*$/u;
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
  const reminderWords = actions.filter((entry) => entry.id === 'reminder.create').flatMap((entry) => entry.actionGrounding ?? []).map((word) => word.toLowerCase());
  const timedReminder =
    reminderWords.length === 0
      ? undefined
      : new RegExp(
          `(?<![가-힣])(?:${reminderWords.filter((word) => !/^[a-z ]+$/u.test(word)).map(escape).join('|') || '(?!)'})${'(?!으로|로|에서|에게|에|의|과|와)'}|\\b(?:${reminderWords.filter((word) => /^[a-z ]+$/u.test(word)).map(escape).join('|') || '(?!)'})\\b`,
          'u',
        );
  // Codex P2 (2026-10-19): list grounding is per sentence: only the guarded sentence counts, or the sentence before it when
  // the guarded one points back to it with an explicit anaphor (그거, 그건, 그 항목, it, that one).
  const namesList = (raw: string): boolean => {
    const lowered = raw.toLowerCase().replace(/to-do/gu, 'todo');
    return listNouns.some((noun) => lowered.includes(noun));
  };
  const ANAPHOR = /(?<![가-힣])(?:그거|그것|그건|그걸|그 항목|그 할 일|그 알림)(?![가-힣])|\b(?:it|that one)\b/u;
  const offending = (raw: string, previous: string): boolean => {
    const sentence = raw.trim().toLowerCase();
    if (sentence.length === 0 || EXPLANATION.test(sentence)) return false;
    const timed = containsNlTimeExpression(sentence);
    if (!namesAction(sentence, timed) || readNouns.some((noun) => sentence.includes(noun))) return false;
    // Codex P2 (2026-10-19): with reminders offered, a reminder verb beside a time is about Quoky's own reminders even with no
    // list noun ("내일 9시에 알려드릴까요?"); with reminders off nothing here counts, so a true denial stays.
    const grounded = namesList(sentence) || (ANAPHOR.test(sentence) && namesList(previous));
    if (!grounded && !/\d+\s*번|#\s?\d+|\bnumber\s+\d+/u.test(sentence) && !(timed && timedReminder?.test(sentence) === true)) return false;
    const offer = KO_YES_NO_OFFER.test(sentence) || EN_YES_NO_OFFER.test(sentence);
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
    if (offending(sentence, parts[index - 2] ?? '')) {
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
  raw: string,
  entries: readonly NlCatalogEntry[],
  language: 'ko' | 'en',
  helpLines: readonly string[] = [],
  options: HonestChatOptions = {},
): FalseIncapabilityGuardResult {
  if (typeof raw !== 'string' || raw.trim() === '') return { text: raw, guarded: false };
  // Live DM test 2026-10-20: a denied control command (재개 / 중지) is replaced by its exact phrase first; the rest of the
  // reply still meets every check below.
  if (options.controls !== undefined) {
    const control = guardFalseControlDenials(raw, language);
    if (control.guarded) {
      const rest = guardFalseIncapabilityClaims(control.text, entries, language, helpLines);
      return { text: rest.text, guarded: true };
    }
  }
  // A6-D6: a reply quoting an offered action family's command phrase is stale (checked before the D5 exemption below).
  if (entries.some((entry) => entry.risk !== 'READ' && (entry.staleCommands ?? []).some((pattern) => pattern.test(raw)))) return { text: renderRestate(language), guarded: true };
  // Live test 4: the dead-end action sentences go first, but that partial filter is not the whole guard (Codex P2): the
  // rest of the reply still meets the source-incapability check below.
  const deadEnd = guardDeadEndActionReplies(raw, entries, language);
  const text = deadEnd.text;
  const unchanged = { text, guarded: deadEnd.guarded };
  // A reply that hands the owner one of Quoky's own commands is already the right answer (D5): never replaced.
  // The help index ("도움말", "help") is a deflection, not an action command: naming it does not make a denial true.
  const commands = quotedCommandsOf([...helpLines, ...entries.map((entry) => entry.usage.ko)]).filter((command) => !HELP_INDEX.test(command));
  if (commands.some((command) => text.includes(command))) return unchanged;
  const hit = new Map<string, NlCatalogEntry>();
  for (const sentence of text.split(/(?<=[.!?。])\s+|\n+/u)) {
    if (!KO_INCAPABLE.test(sentence) && !EN_INCAPABLE.test(sentence)) continue;
    const lower = sentence.toLowerCase();
    for (const entry of entries) {
      if ((entry.sourceNames ?? []).some((name) => lower.includes(name.toLowerCase()))) hit.set(entry.id, entry);
    }
  }
  if (hit.size === 0) return unchanged;
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

/** The listing the previous turn showed, from Core's own record of it (`lastSelection`): its entry and canonical args. */
export interface ShownListing {
  readonly entry: NlCatalogEntry;
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * Owner decision of 2026-10-28 (fix 1 of the 95386868 analysis): the words of the items Core itself showed in that
   * listing (`nlShownItemWords` over Core's own reply), held in process memory only for the listing's lifetime. A denial
   * that names one of them refers to the listing. Never persisted, never sent anywhere (ADR-0110 D4).
   */
  readonly itemWords?: readonly string[];
}

/** The word tokens of a text: letters and digits, lower-cased (NFC); everything else separates. */
function wordTokens(text: string): string[] {
  return text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

/** A word long enough to identify an item: two Hangul syllables or three Latin letters, not only digits. */
function isItemWord(token: string): boolean {
  if (/^\p{N}+$/u.test(token)) return false;
  return /\p{Script=Hangul}/u.test(token) ? token.length >= 2 : token.length >= 3;
}

/**
 * Owner decision of 2026-10-28: the item words of a listing reply Core rendered, from its own list structure only: the
 * lines that start a list item ("- ", "1. ", "1) "). Their words, without digits-only tokens and time words
 * (`isNlTimeWord`: dates, weekdays, clock times). No vocabulary of its own. Local and pure.
 */
export function nlShownItemWords(reply: string): string[] {
  const words = new Set<string>();
  for (const line of reply.split(/\r?\n/u)) {
    const item = /^\s*(?:[-*•]|\d{1,3}[.)])\s+(.*)$/u.exec(line)?.[1];
    if (item === undefined) continue;
    for (const token of wordTokens(item)) if (isItemWord(token) && !isNlTimeWord(token)) words.add(token);
  }
  return [...words];
}

/**
 * Owner-approved fix of 2026-10-28 (pick a release by its listed title): the item titles of a listing reply Core rendered,
 * from its own list structure only: each list-item line ("- ", "1. ", "1) ") up to its first " · " field separator, as
 * written (digits kept). Local and pure; held in process memory only, like the item words (ADR-0110 D4).
 */
export function nlShownItemTitles(reply: string): string[] {
  const titles: string[] = [];
  for (const line of reply.split(/\r?\n/u)) {
    const item = /^\s*(?:[-*•]|\d{1,3}[.)])\s+(.*)$/u.exec(line)?.[1];
    if (item === undefined) continue;
    const title = item.split(' · ')[0]?.trim() ?? '';
    if (title.length > 0) titles.push(title);
  }
  return titles;
}

/**
 * Whether a sentence names one of the shown items' words, with the incapability phrase itself set aside first (so a
 * title word such as "확인" never matches "확인할 수 없어요"). A Korean word may carry a particle ("면접이" names "면접");
 * an English word may be the item word's short form ("doc" names "document"). Pure.
 */
function namesShownItem(sentence: string, itemWords: readonly string[]): boolean {
  if (itemWords.length === 0) return false;
  const rest = sentence.replace(KO_INCAPABLE, ' ').replace(EN_INCAPABLE, ' ');
  return wordTokens(rest).filter(isItemWord).some((token) => itemWords.some((word) => token.startsWith(word) || (!/\p{Script=Hangul}/u.test(token) && word.startsWith(token))));
}

/** Quoted segments of a reply ("…", “…”, ‘…’, `…`, '…' around a whole phrase). */
const QUOTED_SEGMENT = /"([^"\n]{2,80})"|“([^”\n]{2,80})”|‘([^’\n]{2,80})’|`([^`\n]{2,80})`|(?<![\p{L}\p{N}])'([^'\n]{2,80})'(?![\p{L}\p{N}])/gu;

/**
 * A sentence that names Quoky (or "above") as the one that showed a list: the reference the #280 note itself gives the
 * chat reply ("the list Quoky showed above"). A closed form of Quoky's own act, not a phrase list for the owner's words.
 */
const SHOWN_BY_QUOKY = /(?:quoky|퀴키|위에서?|above)[^.!?\n]{0,24}?(?:보여|보여\s*드|show(?:ed|n)|list(?:ed)?)/iu;

/** The Korean and English copy that closes a reply whose every sentence denied or re-ran the listing shown above. */
export function renderShownListingAsk(language: 'ko' | 'en'): string {
  return language === 'en'
    ? 'The list Quoky showed above is on your screen. Tell me which item to work from, or the detail the answer needs, and I will continue.'
    : '위에 보여드린 목록은 화면에 그대로 있어요. 어떤 항목을 기준으로 할지, 또는 필요한 내용을 알려 주시면 이어서 도와드릴게요.';
}

/**
 * #280 follow-up (context eval 2026-10-26, owner decision of 2026-10-22): right after Quoky showed a listing, a chat reply
 * must not tell the owner it cannot see, read or check that listing, and must not send them to show it again. The guard
 * works from Core's own record of what was shown (`listing`: the entry and args of the previous turn's selection), never
 * from the words of the reply:
 *  - a sentence stating a read / see / check incapability (the same closed patterns as the D9 guard) is dropped ONLY when
 *    it refers to the listing shown (CA review P1-1, 2026-10-27): it names that listing's own entry (its source names,
 *    its catalog aliases, the list nouns the D9 guard also uses, or its label), or it names Quoky as the one that showed
 *    a list above ({@link SHOWN_BY_QUOKY}); and it names no OTHER offered source (the D9 guard judges that one). Every
 *    other sentence is left to the D9 guard: "실시간 날씨는 확인할 수 없어요." right after a calendar listing is true and stays;
 *  - a sentence quoting a command that Core's own grammar maps to the very listing shown (same entry, same canonical
 *    args; `rerunsListing`, supplied by the runtime from the handlers' pure Class B probes) is dropped;
 *  - every other sentence is kept as written. A reply left empty gets the fixed ask above.
 * Nothing here reads, stores or sends item content (ADR-0110 D4): it only removes sentences. Pure.
 */
export function guardShownListingDenials(
  text: string,
  listing: ShownListing,
  offered: readonly NlCatalogEntry[],
  language: 'ko' | 'en',
  rerunsListing: (segment: string) => boolean = () => false,
): FalseIncapabilityGuardResult {
  if (typeof text !== 'string' || text.trim() === '') return { text, guarded: false };
  const ownNames = new Set((listing.entry.sourceNames ?? []).map((name) => name.toLowerCase()));
  // The words that name the listing shown: the catalog's own words for its entry (no list of this guard's own).
  const ownWords = [...ownNames, ...listing.entry.aliases, listing.entry.label.ko, listing.entry.label.en]
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 2);
  const refersToListing = (lower: string): boolean => ownWords.some((word) => lower.includes(word)) || SHOWN_BY_QUOKY.test(lower);
  const otherNames = offered
    .filter((entry) => entry.id !== listing.entry.id)
    .flatMap((entry) => entry.sourceNames ?? [])
    .map((name) => name.toLowerCase())
    .filter((name) => !ownNames.has(name));
  const parts = text.split(/((?<=[.!?。？])\s+|\n+)/u);
  const kept: string[] = [];
  let removed = false;
  for (let index = 0; index < parts.length; index += 2) {
    const sentence = parts[index] ?? '';
    const separator = parts[index + 1] ?? '';
    const lower = sentence.toLowerCase();
    const denies =
      (KO_INCAPABLE.test(sentence) || EN_INCAPABLE.test(sentence)) &&
      (refersToListing(lower) || namesShownItem(sentence, listing.itemWords ?? [])) &&
      !otherNames.some((name) => lower.includes(name));
    const reruns = [...sentence.matchAll(QUOTED_SEGMENT)].some((match) => {
      const segment = (match.slice(1).find((group) => group !== undefined) ?? '').trim();
      return segment.length > 0 && rerunsListing(segment);
    });
    if (denies || reruns) {
      removed = true;
      continue;
    }
    kept.push(sentence, separator);
  }
  if (!removed) return { text, guarded: false };
  const rest = kept.join('').trim();
  return { text: rest.length === 0 ? renderShownListingAsk(language) : rest, guarded: true };
}

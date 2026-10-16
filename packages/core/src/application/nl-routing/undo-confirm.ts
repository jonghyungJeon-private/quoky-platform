import { nlIsRequestForm } from './request-shape';
import { normalizeForMatch } from './selection-input';

/**
 * ADR-0120 A6-D3a amendment 1, undo confirmation rule (2026-10-16). An undo cannot itself be undone, and Korean morphology
 * is open-ended, so `action.undo` executes directly only when the whole undo clause is an unambiguous undo command; every
 * other selector-chosen undo asks a one-step confirmation that names the action. The closed word sets below are FILLERS and
 * REFERENCES to the last action (never routing): they only decide whether a message carries anything besides the command.
 * Pure.
 */

/** Adverbs, fillers and interjections that add nothing to the command ("좀", "빨리", "제발", "아니", "please"). */
const FILLERS = new Set(['좀', '다시', '지금', '빨리', '얼른', '어서', '바로', '당장', '제발', '요', '아', '앗', '헉', '아니', '아이고', 'please', 'pls', 'now', 'quickly', 'just', 'oh', 'oops']);
/** References to the last action ("방금 거", "그 작업", "the last one"). */
const REFERENCES = new Set([
  '그', '이', '저', '그거', '이거', '저거', '그것', '이것', '방금', '아까', '거', '것', '건', '걸', '한', '했던', '하신', '처리한',
  '처리했던', '작업', '마지막', '실행', '없었던', '없던', '걸로', '원래', '방금거', '아까거',
  '할', '일', '할일', '투두', '알림', '리마인더', '알람',
  'that', 'it', 'this', 'the', 'last', 'one', 'can', 'could', 'would', 'will', 'you', 'todo', 'reminder',
]);
/** The last action's shown label ("5번 되돌려줘"; the service asks when it is another number). */
const LABEL = /^#?\d{1,2}(?:번|번째)?$/u;
/** The tail of the capability request after 줄 / 주실 ("줄 수 있어?"). */
const CAPABILITY_TAIL = /^(?:수|있어|있어요|있나요|있니|있을까|있을까요|있겠어|있겠어요)$/u;
/** A request or auxiliary token that carries the command (해줘, 줘, 봐, 두세요, 돌려놔, 부탁 …). */
const COMMAND_PART = /^(?:해|하|합|주|줘|줄|드리|드려|드릴|보|봐|놔|두|둬|돌려|부탁)/u;
/** The undo nouns that are a complete command on their own ("되돌리기", "원래대로", "원복 좀", "undo"). */
const BARE_UNDO = /(?:되돌리기|원래대로|원상복구|원상|원복|롤백|취소|무르기|undo|revert|rollback)$/u;
const PARTICLE_TAIL = /(?:을|를|은|는|도|만|요|로)$/u;
const NOISE = /[.,!?~…ㅋㅎㅠㅜ^"'“”‘’()]+$/u;
/** Where a Korean clause ends: sentence punctuation, or a final ending followed by a space ("잘못 눌렀어 되돌려줘"). */
const CLAUSE_BOUNDARY = /[.!?。;\n]|(?:야|어|요|다|네|지)(?=\s)/gu;

function holdsUndo(token: string, undoWords: readonly string[]): boolean {
  return undoWords.some((raw) => {
    const word = normalizeForMatch(raw);
    if (word === '돌려') return /되돌려/u.test(token);
    return /^[a-z ]+$/u.test(word) ? token === word || token.startsWith(`${word} `) : token.includes(word);
  });
}

/**
 * Whether the message is an unambiguous undo command: from the clause holding the (last) undo word to the end, every token
 * is the undo word, a command part (request ending, auxiliary, the capability tail), a filler or a reference to the last
 * action, and the last meaningful token is a request form or a bare undo noun. Earlier clauses are reasons ("잘못
 * 눌렀어 되돌려줘"); the structural vetoes have already judged them.
 */
export function nlUndoIsDirect(text: string, undoWords: readonly string[]): boolean {
  const normalized = normalizeForMatch(text).replace(/\broll back\b/gu, 'rollback');
  let start = 0;
  for (const match of normalized.matchAll(CLAUSE_BOUNDARY)) {
    const end = (match.index ?? 0) + match[0].length;
    if (holdsUndoIn(normalized.slice(end), undoWords)) start = end;
  }
  const tokens = normalized
    .slice(start)
    .split(/\s+/u)
    .map((token) => token.replace(NOISE, ''))
    .filter((token) => token.length > 0);
  if (!tokens.some((token) => holdsUndo(token, undoWords))) return false;
  let lastMeaningful: string | undefined;
  let afterCapability = false;
  let seenUndo = false;
  for (const [index, token] of tokens.entries()) {
    const bare = token.replace(PARTICLE_TAIL, '');
    if (FILLERS.has(token) || FILLERS.has(bare)) continue;
    if (REFERENCES.has(token) || REFERENCES.has(bare) || LABEL.test(bare)) continue;
    // Before the undo word, a modifier of a reference noun names the last action ("방금 추가한 거 취소해줘"); after it, an
    // adnominal form is descriptive ("되돌려 주신 거").
    if (!seenUndo && isModifier(token) && REFERENCE_NOUN.test(tokens[index + 1] ?? '')) continue;
    if (afterCapability && CAPABILITY_TAIL.test(token)) continue;
    if (holdsUndo(token, undoWords) || COMMAND_PART.test(token)) {
      if (holdsUndo(token, undoWords)) seenUndo = true;
      lastMeaningful = token;
      afterCapability = /(?:줄|주실)$/u.test(token);
      continue;
    }
    return false;
  }
  if (lastMeaningful === undefined) return false;
  return nlIsRequestForm(lastMeaningful) || /(?:줄|주실)$/u.test(lastMeaningful) && afterCapability || BARE_UNDO.test(lastMeaningful) || BARE_UNDO.test(lastMeaningful.replace(PARTICLE_TAIL, '')) || /^부탁/u.test(lastMeaningful);
}

/** A reference noun after a modifier ("… 거", "… 작업", "… 할 일"). */
const REFERENCE_NOUN = /^(?:거|것|건|걸|작업|일|할|알림)/u;

/** An adnominal modifier: the last syllable has the final ㄴ, or is 던 / 는 ("추가한", "처리했던", "만든"). */
function isModifier(word: string): boolean {
  const last = Array.from(word).at(-1);
  if (last === undefined) return false;
  const code = last.charCodeAt(0) - 0xac00;
  return (code >= 0 && code <= 11171 && code % 28 === 4) || last === '던' || last === '는';
}

function holdsUndoIn(text: string, undoWords: readonly string[]): boolean {
  return text.split(/\s+/u).some((token) => token.length > 0 && holdsUndo(token.replace(NOISE, ''), undoWords));
}

export type NlUndoConfirmReply = 'approve' | 'deny' | 'none';

/** The narrow whole-message answers to the undo confirmation (like the R5a draft matcher, not ADR-0095 approvals). */
const APPROVE = new Set(['응', '어', '네', '넵', '예', '그래', '좋아', '맞아', 'ㅇㅇ', '되돌려줘', '되돌려', '해줘', 'yes', 'ok', 'okay', 'y']);
const DENY = new Set(['아니', '아니요', '아니야', '아뇨', '취소', '됐어', '그만', 'ㄴㄴ', 'no', 'n', 'cancel']);

/** The owner's answer to "…를 되돌릴까요?": the whole message, trailing `.`, `!`, `~` and spaces removed. */
export function interpretUndoConfirmReply(text: string): NlUndoConfirmReply {
  const normalized = text.normalize('NFC').trim().replace(/[.!~\s]+$/u, '');
  const key = /^[A-Za-z]+$/u.test(normalized) ? normalized.toLowerCase() : normalized;
  if (APPROVE.has(key)) return 'approve';
  if (DENY.has(key)) return 'deny';
  return 'none';
}

const ACTION_NAMES: Readonly<Record<string, { readonly ko: string; readonly en: string }>> = {
  'todo.add': { ko: '추가', en: 'add' },
  'todo.complete': { ko: '완료', en: 'completion' },
  'todo.cancel': { ko: '빼기', en: 'removal' },
  'reminder.create': { ko: '만들기', en: 'creation' },
  'reminder.cancel': { ko: '취소', en: 'cancellation' },
};

/** "방금 한 '할 일 2번 완료'를 되돌릴까요?" (content-free: the source, the shown label and the action only). */
export function renderUndoConfirm(undoEntryId: string, source: 'todo' | 'reminder' | 'mail' | 'drive', label: number | undefined, language: 'ko' | 'en'): string {
  const action = ACTION_NAMES[undoEntryId] ?? { ko: '작업', en: 'action' };
  if (language === 'en') {
    const item = source === 'reminder' ? `reminder${label !== undefined ? ` #${label}` : ''}` : `to-do${label !== undefined ? ` ${label}` : ''}`;
    return `Undo the ${item} ${action.en} you just made? (yes / no)`;
  }
  const item = source === 'reminder' ? `알림${label !== undefined ? ` #${label}` : ''}` : `할 일${label !== undefined ? ` ${label}번` : ''}`;
  return `방금 한 '${item} ${action.ko}'를 되돌릴까요? (응 / 아니)`;
}

import { normalizeForMatch } from './selection-input';

/**
 * ADR-0120 A6-D3a amendment 1, undo confirmation rule (2026-10-16). An undo cannot itself be undone, and Korean morphology
 * is open-ended, so `action.undo` executes directly only when the whole undo clause is an unambiguous undo command; every
 * other selector-chosen undo asks a one-step confirmation that names the action. The closed word sets below are FILLERS and
 * REFERENCES to the last action (never routing): they only decide whether a message carries anything besides the command.
 * Pure.
 */

/**
 * The direct path is a small CLOSED grammar over EXACT tokens (Codex P1: no prefix or suffix matching, so "되돌려 주신 거
 * 보여줘" never matches). In the clause that holds the undo (earlier clauses are reasons: "잘못 눌렀어 되돌려줘"):
 *   REFERENCE* HEAD (HEAD | VERB | AUX | FILLER | EN)*  end
 * and the last non-filler token is in {@link COMPLETE}. Every set is exact; anything else goes to the confirmation.
 */
/** References to the last action, before the head ("방금 거", "그 작업", "방금 추가한 거", "5번", "please"). */
const REFERENCES = new Set([
  '방금', '아까', '그거', '이거', '저거', '그것', '이것', '그', '이', '거', '것', '건', '걸', '한', '했던', '처리한', '처리했던', '추가한', '완료한',
  '취소한', '만든', '넣은', '작업', '마지막', '실행', '없었던', '없던', '걸로', '방금거', '아까거', '취소하고', '아니', '아', '앗', '헉', '아이고',
  '할', '일', '할일', '알림', 'please', 'can', 'could', 'would', 'you', 'oh', 'oops',
]);
/** The undo head itself. */
const HEADS = new Set([
  '되돌려줘', '되돌려줘요', '되돌려죠', '되돌려', '되돌려요', '되돌려줄래', '되돌려줄래요', '되돌려주세요', '되돌리기', '원래대로', '원상복구', '원복', '롤백',
  '취소', '취소해줘', '취소해', '취소하세요', '원복해줘', '원복해주십시오', '원상복구해줘', 'undo', 'revert', 'rollback',
]);
/** The light or undo verb after a bare head ("원래대로 돌려 놔", "원상복구 해 줄 수 있어?", "되돌리기 합시다"). */
const VERBS = new Set(['돌려', '돌려줘', '돌려놔', '돌려줘요', '해', '해줘', '해요', '해줘요', '해주세요', '하세요', '합시다']);
/** Auxiliary and request tokens ("되돌려 두세요", "되돌려 봐", "… 줄 수 있어?", "원상복구 부탁"). */
const AUX = new Set(['줘', '줘요', '줄래', '줄래요', '주세요', '주실래요', '두세요', '둬', '둬요', '봐', '봐요', '보세요', '줘봐', '놔', '놔요', '부탁', '부탁해', '부탁해요', '줄', '수', '있어', '있어요', '있나요']);
/** Fillers after the head ("빨리요", "제발", "please", "the last one"). */
const FILLERS = new Set(['좀', '빨리', '빨리요', '제발', '제발요', '지금', '다시', '방금', '그거', '요', 'please', 'now', 'that', 'it', 'this', 'the', 'last', 'one']);
/** What the clause may end on (after fillers): a head or verb that is a command, a request auxiliary, the capability tail. */
const COMPLETE = new Set([
  ...HEADS, '돌려', '돌려줘', '돌려놔', '돌려줘요', '해', '해줘', '해요', '해줘요', '해주세요', '하세요', '합시다',
  '줘', '줘요', '줄래', '줄래요', '주세요', '주실래요', '두세요', '둬', '둬요', '봐', '봐요', '보세요', '줘봐', '놔', '놔요', '부탁', '부탁해', '부탁해요',
  'that', 'it', 'one',
]);
/** A label of the last action before the head ("5번 되돌려줘"; the service asks when it is another number). */
const LABEL = /^#?\d{1,2}번?$/u;
const NOISE = /[.,!?~…ㅋㅎㅠㅜ^"'“”‘’()]+$/u;
/** Where a Korean clause ends: sentence punctuation, or a final ending followed by a space ("잘못 눌렀어 되돌려줘"). */
const CLAUSE_BOUNDARY = /[.!?。;\n]|(?:야|어|요|다|네|지)(?=\s)/gu;

function tokensOf(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((token) => token.replace(NOISE, '').replace(/요{2,}$/u, '요'))
    .filter((token) => token.length > 0);
}

/** Whether the message is an unambiguous undo command (the closed grammar above). */
export function nlUndoIsDirect(text: string): boolean {
  const normalized = normalizeForMatch(text).replace(/\broll back\b/gu, 'rollback');
  let start = 0;
  for (const match of normalized.matchAll(CLAUSE_BOUNDARY)) {
    const end = (match.index ?? 0) + match[0].length;
    if (tokensOf(normalized.slice(end)).some((token) => HEADS.has(token))) start = end;
  }
  const tokens = tokensOf(normalized.slice(start));
  const head = tokens.findIndex((token) => HEADS.has(token));
  if (head < 0) return false;
  if (!tokens.slice(0, head).every((token) => REFERENCES.has(token) || LABEL.test(token))) return false;
  let last = tokens[head] as string;
  for (const [offset, token] of tokens.slice(head + 1).entries()) {
    if (FILLERS.has(token) && !COMPLETE.has(token)) continue;
    if (HEADS.has(token) || VERBS.has(token) || AUX.has(token) || FILLERS.has(token)) {
      // The capability tail is complete only as "줄 수 있어" (exactly those three tokens).
      if ((token === '있어' || token === '있어요' || token === '있나요') && !(tokens[head + offset] === '수' && tokens[head + offset - 1] === '줄')) return false;
      last = token;
      continue;
    }
    return false;
  }
  return COMPLETE.has(last) || ((last === '있어' || last === '있어요' || last === '있나요') && tokens.includes('줄'));
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

import { isNegated } from '../intent-negation';

/**
 * Memory management command grammar (ADR-0106 D1). Pure and deterministic: no provider, storage or clock.
 *
 * Whole-message, closed, KO/EN forms only — a message is a memory command when the ENTIRE message (NFC, trimmed,
 * whitespace collapsed, trailing punctuation dropped) is one of:
 *
 *  - list:    `기억 목록`, `기억 목록 2` (page), `내 기억 보여줘`; `list memories`, `list memories 2`
 *  - view:    `기억 N 보여줘`; `show memory N`
 *  - edit:    `기억 N 수정: <text>`; `edit memory N: <text>` (the text may span lines)
 *  - forget:  `기억 N 잊어줘` / `기억 N 삭제해줘`; `forget memory N`
 *  - confirm: `기억 확인 <code>`; `confirm memory <code>`
 *  - bulk forget (`내 기억 다 지워줘`, `forget all memories`) — recognised only to be refused (D1)
 *  - status (plan DET-1 follow-up): `기억했어?`, `기억 저장됐어?`, `did you remember that?` — answered from the store
 *  - archive (ADR-0106 amendment): `보관함` / `기억 보관함` (`보관함 2` for a page); `memory archive`
 *  - restore: `기억 복원 N`; `restore memory N` — N is the archive's own number, not the active list's
 *  - permanent delete: `기억 완전 삭제 N`; `permanently delete memory N` (archive number)
 *
 * Anything else returns `null` and the turn falls through unchanged. `기억해: …` never matches (the runtime's
 * explicit-memory block runs before the `pre-classify` stage anyway), nor does a how-to question ("기억 어떻게
 * 지워?", answered by the help-intent handler) or a sentence that merely mentions memories. A command head under an
 * explicit negation ("기억 1 지우지 마") never matches; an edit's new text is free text and is not negation-checked.
 */

export type MemoryCommandLanguage = 'ko' | 'en';

export type MemoryCommand =
  | { readonly kind: 'list'; readonly page: number; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'view'; readonly number: number; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'edit'; readonly number: number; readonly text: string; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'forget'; readonly number: number; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'confirm'; readonly code: string; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'bulk-forget'; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'status'; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'archive-list'; readonly page: number; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'restore'; readonly number: number; readonly language: MemoryCommandLanguage }
  | { readonly kind: 'purge'; readonly number: number; readonly language: MemoryCommandLanguage }
  | {
      readonly kind: 'usage';
      readonly usage: 'edit' | 'confirm';
      readonly number?: number;
      readonly language: MemoryCommandLanguage;
    };

/** Length of a confirmation code (ADR-0106 D4). */
export const MEMORY_CONFIRMATION_CODE_LENGTH = 4;
/** A longer message is never a command head (an edit's text is measured separately). */
const MAX_COMMAND_HEAD_CHARS = 60;
/** Item numbers are 1-based and bounded (a typo like `기억 99999 잊어줘` is still a command; it just finds nothing). */
const NUMBER = String.raw`#?(\d{1,4})\s?(?:번(?:을|를|은|는)?)?`;
const MEMORY_NOUN = String.raw`(?:기억|메모리)`;
const VIEW_VERB = String.raw`(?:보여\s?줘|보여\s?줘요|보여\s?주세요|보여\s?줄래|보기|볼래)`;
const FORGET_VERB =
  String.raw`(?:잊어\s?줘|잊어\s?줘요|잊어\s?주세요|잊어|잊기|삭제|삭제\s?해\s?줘|삭제\s?해\s?줘요|삭제\s?해\s?주세요|삭제해|` +
  String.raw`지워\s?줘|지워\s?줘요|지워\s?주세요|지워|지우기)`;
const EDIT_VERB = String.raw`(?:(?:수정|변경)(?:\s?해\s?줘|\s?해\s?주세요|해)?|고쳐\s?줘|고쳐|바꿔\s?줘|바꿔)`;

const POLITE_DO = String.raw`(?:\s?(?:해\s?줘|해\s?줘요|해\s?주세요|해))?`;

const TRAILING_PUNCTUATION = /[\s.!?？！~。…]+$/u;

const KO_LIST = new RegExp(
  String.raw`^(?:(?:내|저장된)\s?)?${MEMORY_NOUN}\s?목록(?:\s?(\d{1,3})\s?(?:페이지|쪽)?)?(?:\s?${VIEW_VERB})?$`,
  'u',
);
const KO_LIST_SHOW = new RegExp(String.raw`^(?:내|저장된)\s?${MEMORY_NOUN}(?:들)?(?:을|를)?\s?${VIEW_VERB}$`, 'u');
const KO_VIEW = new RegExp(String.raw`^${MEMORY_NOUN}\s?${NUMBER}\s?${VIEW_VERB}$`, 'u');
const KO_FORGET = new RegExp(String.raw`^${MEMORY_NOUN}\s?${NUMBER}\s?${FORGET_VERB}$`, 'u');
const KO_EDIT_HEAD = new RegExp(String.raw`^${MEMORY_NOUN}\s?${NUMBER}\s?${EDIT_VERB}\s*[:：]`, 'u');
const KO_EDIT_NO_COLON = new RegExp(String.raw`^${MEMORY_NOUN}\s?${NUMBER}\s?${EDIT_VERB}$`, 'u');
const KO_CONFIRM = new RegExp(String.raw`^${MEMORY_NOUN}\s?확인(?:\s?코드)?\s*[:：]?\s*([0-9A-Za-z]+)$`, 'u');
const KO_CONFIRM_BARE = new RegExp(String.raw`^${MEMORY_NOUN}\s?확인(?:\s?코드)?$`, 'u');
const KO_BULK = [
  new RegExp(
    String.raw`^(?:(?:내|저장된)\s?)?${MEMORY_NOUN}(?:들)?(?:을|를|은|는)?\s?(?:다|전부|모두|싹|싹\s?다|전체|한꺼번에)\s?` +
      String.raw`(?:${FORGET_VERB}|잊어\s?버려|지워\s?버려)$`,
    'u',
  ),
  new RegExp(
    String.raw`^(?:모든|전체)\s?${MEMORY_NOUN}(?:들)?(?:을|를)?\s?(?:다\s?)?(?:${FORGET_VERB}|잊어\s?버려|지워\s?버려)$`,
    'u',
  ),
];
/** ADR-0106 amendment: the archive view, restore and permanent delete (numbers are the archive's own). */
const KO_ARCHIVE = new RegExp(
  String.raw`^(?:(?:내\s?)?${MEMORY_NOUN}\s?)?보관함(?:\s?(\d{1,3})\s?(?:페이지|쪽)?)?(?:\s?(?:목록|${VIEW_VERB}))?$`,
  'u',
);
const KO_RESTORE = new RegExp(String.raw`^${MEMORY_NOUN}\s?(?:복원|복구)\s?${NUMBER}${POLITE_DO}$`, 'u');
const KO_PURGE = new RegExp(String.raw`^${MEMORY_NOUN}\s?완전\s?(?:삭제|지우기)\s?${NUMBER}${POLITE_DO}$`, 'u');
/** A whole-message question whether something was saved to memory ("기억했어?", "기억 저장됐어?"). */
const KO_STATUS = new RegExp(
  String.raw`^(?:(?:방금|아까|그거|그것도|잘)\s?)*기억(?:\s?저장)?\s?` +
    String.raw`(?:했어|했어요|했니|했나|했나요|했지|했죠|됐어|됐어요|됐니|됐나|됐나요|됐지|됐죠|` +
    String.raw`해\s?줬어|해\s?줬어요|해\s?줬니|해\s?줬지|해\s?뒀어|해\s?뒀어요|해\s?뒀지|해\s?놨어|해\s?놨지)$`,
  'u',
);
/** Status endings that are questions even without "?" (니/나/나요/지/죠); "기억했어" alone is a statement. */
const KO_STATUS_INTERROGATIVE = /(?:니|나|나요|지|죠)$/u;

const EN_LIST = /^(?:list|show)\s+(?:my\s+)?memories(?:\s+(?:page\s+)?(\d{1,3}))?$/u;
const EN_VIEW = /^(?:show|view)\s+memory\s+#?(\d{1,4})$/u;
const EN_FORGET = /^(?:forget|delete|remove)\s+memory\s+#?(\d{1,4})$/u;
const EN_EDIT_HEAD = /^(?:edit|update|change)\s+memory\s+#?(\d{1,4})\s*:/u;
const EN_EDIT_NO_COLON = /^(?:edit|update|change)\s+memory\s+#?(\d{1,4})$/u;
const EN_CONFIRM = /^confirm\s+memory(?:\s+code)?\s*:?\s*([0-9a-z]+)$/u;
const EN_CONFIRM_BARE = /^confirm\s+memory(?:\s+code)?$/u;
const EN_BULK =
  /^(?:please\s+)?(?:forget|delete|erase|clear|remove|wipe)\s+(?:all\s+(?:of\s+)?(?:my\s+|your\s+)?memories|(?:all\s+)?my\s+memories|everything\s+you\s+(?:know|remember)(?:\s+about\s+me)?|your\s+(?:whole\s+)?memory|everything)$/u;
const EN_ARCHIVE =
  /^(?:(?:show|list|view)\s+)?(?:my\s+)?(?:the\s+)?(?:memory\s+archive|archived\s+memories)(?:\s+(?:page\s+)?(\d{1,3}))?$/u;
const EN_RESTORE = /^restore\s+memory\s+#?(\d{1,4})$/u;
const EN_PURGE = /^(?:permanently\s+delete|purge)\s+memory\s+#?(\d{1,4})$/u;
const EN_STATUS = /^did\s+you\s+(?:remember|save|store)\s+(?:that|it)(?:\s+(?:to|in)\s+(?:your\s+)?memory)?$/u;

/** NFC, whitespace collapsed, trimmed. */
function normalizeHead(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function positive(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function negated(head: string): boolean {
  return isNegated(head, 0, head.length);
}

function parseConfirm(rawCode: string | undefined, language: MemoryCommandLanguage): MemoryCommand | null {
  if (rawCode === undefined) return null;
  // A wrong-length code is still a confirmation attempt: it is refused (and changes nothing), never chat.
  return { kind: 'confirm', code: rawCode.toUpperCase(), language };
}

/** Edit: the head (`기억 N 수정:`) on the NFC text; the new text is everything after the colon, trimmed. */
function parseEdit(nfc: string): MemoryCommand | null {
  for (const [pattern, language] of [
    [KO_EDIT_HEAD, 'ko'],
    [EN_EDIT_HEAD, 'en'],
  ] as const) {
    const lowered = language === 'en' ? nfc.toLowerCase() : nfc;
    const match = pattern.exec(lowered);
    if (match === null) continue;
    const head = match[0];
    if (negated(head)) return null;
    const number = positive(match[1]);
    if (number === null) return null;
    const text = nfc.slice(head.length).trim();
    if (text.length === 0) return { kind: 'usage', usage: 'edit', number, language };
    return { kind: 'edit', number, text, language };
  }
  return null;
}

/** Parse one inbound message; `null` = not a memory command (fall through). */
export function parseMemoryCommand(text: string): MemoryCommand | null {
  if (typeof text !== 'string') return null;
  const nfc = text.normalize('NFC').trim();
  if (nfc.length === 0) return null;

  // Edit first: its text may be long and multi-line; only its head is bounded and negation-checked.
  const edit = parseEdit(nfc);
  if (edit !== null) return edit;

  const head = normalizeHead(nfc);
  if (Array.from(head).length > MAX_COMMAND_HEAD_CHARS || /\n/.test(nfc)) return null;
  const hadQuestionMark = /[?？]\s*$/u.test(head);
  const bare = head.replace(TRAILING_PUNCTUATION, '');
  if (bare.length === 0 || negated(bare)) return null;

  let match: RegExpExecArray | null;
  if ((match = KO_LIST.exec(bare)) !== null) {
    const page = match[1] === undefined ? 1 : positive(match[1]);
    return page === null ? null : { kind: 'list', page, language: 'ko' };
  }
  if (KO_LIST_SHOW.test(bare)) return { kind: 'list', page: 1, language: 'ko' };
  if ((match = KO_VIEW.exec(bare)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'view', number, language: 'ko' };
  }
  if ((match = KO_FORGET.exec(bare)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'forget', number, language: 'ko' };
  }
  if ((match = KO_EDIT_NO_COLON.exec(bare)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'usage', usage: 'edit', number, language: 'ko' };
  }
  if ((match = KO_ARCHIVE.exec(bare)) !== null) {
    const page = match[1] === undefined ? 1 : positive(match[1]);
    return page === null ? null : { kind: 'archive-list', page, language: 'ko' };
  }
  if ((match = KO_RESTORE.exec(bare)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'restore', number, language: 'ko' };
  }
  if ((match = KO_PURGE.exec(bare)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'purge', number, language: 'ko' };
  }
  if ((match = KO_CONFIRM.exec(bare)) !== null) return parseConfirm(match[1], 'ko');
  if (KO_CONFIRM_BARE.test(bare)) return { kind: 'usage', usage: 'confirm', language: 'ko' };
  if (KO_BULK.some((pattern) => pattern.test(bare))) return { kind: 'bulk-forget', language: 'ko' };
  if (KO_STATUS.test(bare) && (hadQuestionMark || KO_STATUS_INTERROGATIVE.test(bare))) {
    return { kind: 'status', language: 'ko' };
  }

  const english = bare.toLowerCase();
  if ((match = EN_LIST.exec(english)) !== null) {
    const page = match[1] === undefined ? 1 : positive(match[1]);
    return page === null ? null : { kind: 'list', page, language: 'en' };
  }
  if ((match = EN_VIEW.exec(english)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'view', number, language: 'en' };
  }
  if ((match = EN_FORGET.exec(english)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'forget', number, language: 'en' };
  }
  if ((match = EN_EDIT_NO_COLON.exec(english)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'usage', usage: 'edit', number, language: 'en' };
  }
  if ((match = EN_ARCHIVE.exec(english)) !== null) {
    const page = match[1] === undefined ? 1 : positive(match[1]);
    return page === null ? null : { kind: 'archive-list', page, language: 'en' };
  }
  if ((match = EN_RESTORE.exec(english)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'restore', number, language: 'en' };
  }
  if ((match = EN_PURGE.exec(english)) !== null) {
    const number = positive(match[1]);
    return number === null ? null : { kind: 'purge', number, language: 'en' };
  }
  if ((match = EN_CONFIRM.exec(english)) !== null) return parseConfirm(match[1], 'en');
  if (EN_CONFIRM_BARE.test(english)) return { kind: 'usage', usage: 'confirm', language: 'en' };
  if (EN_BULK.test(english)) return { kind: 'bulk-forget', language: 'en' };
  if (EN_STATUS.test(english) && hadQuestionMark) return { kind: 'status', language: 'en' };
  return null;
}

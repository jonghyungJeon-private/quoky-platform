import { MAIL_LISTING_MAX_ENTRIES, MAIL_SENDER_QUERY_MAX_LENGTH } from '../../ports/mail-reader.port';

/**
 * The deterministic mail grammar (ADR-0118 D4/D6/D7, GML-1). Pure and anchored: a message is claimed only when the
 * WHOLE message (after normalization) is one of the forms below, so a pasted mail draft, a how-to question or any
 * longer request falls through unchanged. Every decision is taken from the owner's own text (ADR-0118 D8); nothing
 * here ever sees mail content.
 *
 * Listings (KO): `안 읽은 메일`, `읽지 않은 메일`, `새 메일`, `메일 왔어?`, `메일 확인해줘`, `내 메일함에 뭐 왔어?`,
 * `오늘 온 메일`, `오늘 받은 메일`, `오늘 메일 뭐 왔어?`, `오늘 안 읽은 메일`, each with an optional tail such as
 * `보여줘`, `알려줘`, `확인해줘`, `있어?`, `뭐 있어?`, `몇 개야?`. (EN): `unread emails`, `emails today`,
 * `today's emails`, `find emails from <sender>`.
 *
 * Sender searches (review P2-2): `<X> 메일 찾아줘` / `검색해줘` / `찾아봐` for any sender text; with `보여줘` / `알려줘` only
 * when the head names a sender explicitly (`김철수가 보낸`, `김철수한테서 온`, `GitHub에서 온`, `김철수님`), since
 * `사과 메일 알려줘` asks Quoky to write one. Optional `오늘` / `안 읽은` qualifiers.

 * Summaries: `이 메일 요약해줘`, `3번 메일 요약해줘`, `메일 3번 요약`, `두 번째 메일 요약해줘`, `summarize this email`,
 * `summarize email 3`. A summary refers to the session's last listing; the number is 1..10.
 *
 * Write requests (refused with fixed copy, ADR-0118 D6): `메일 보내줘`, `<사람>에게 메일 보내줘`, `3번 메일 삭제해줘`,
 * `이 메일 보관해줘`, `메일 전달해줘`, `읽음으로 표시해줘`, `답장 보내줘`, `send/forward/delete/archive … email`.
 *
 * A sender form whose sender is a pronoun or a time word (`이`, `내`, `어제`, `모든`, …) is answered with the usage line
 * instead of a search. A time word with a particle (`지난 주에 온`, `작년에 받은`), a second-person word (`네`, `너`) or
 * `find emails from me…` is not a mail command at all and falls through to chat.
 */

export type MailLanguage = 'ko' | 'en';

export type MailSummaryTarget = { readonly kind: 'this' } | { readonly kind: 'index'; readonly index: number };

export type MailQuestion =
  | {
      readonly kind: 'list';
      readonly unread: boolean;
      readonly today: boolean;
      readonly from?: string;
      readonly language: MailLanguage;
    }
  | { readonly kind: 'summarize'; readonly target: MailSummaryTarget; readonly language: MailLanguage }
  | { readonly kind: 'write-refused'; readonly language: MailLanguage }
  | { readonly kind: 'usage'; readonly language: MailLanguage };

/** The mail noun (KO and the brand forms people type in Korean sentences). */
const MAIL = '(?:이메일|메일|지메일|gmail|g메일)';
/** A particle that may follow the noun. */
const NOUN_PARTICLE = '(?:들이|들은|들을|이|은|을|들)?';
/** The optional tail of a listing. */
const LIST_TAIL =
  '(?:보여 ?줘|보여 ?주세요|보여 ?줄래|알려 ?줘|알려 ?주세요|알려 ?줄래|확인해 ?줘|확인해 ?주세요|확인|목록|리스트|' +
  '찾아 ?줘|찾아 ?주세요|검색해 ?줘|검색해 ?주세요|뭐 ?있어요|뭐 ?있어|뭐 ?있나요|뭐 ?있나|뭐 ?왔어요|뭐 ?왔어|뭐야|뭐예요|' +
  '있어요|있어|있나요|있나|있니|왔어요|왔어|몇 ?(?:개|통|건)(?:이야|야|예요|있어요|있어|왔어요|왔어)?)';
const UNREAD_WORD = '(?:안 ?읽은|읽지 ?않은|미확인|새로 ?온|새)';
const ARRIVED_WORD = '(?:온|받은|들어온|도착한)';

const LIST_KO = new RegExp(
  `^(?<today>오늘 ?)?(?:${ARRIVED_WORD} ?)?(?<unread>${UNREAD_WORD} ?)?(?:${ARRIVED_WORD} ?)?${MAIL}${NOUN_PARTICLE} ?(?:좀 ?)?(?:${LIST_TAIL})?$`,
  'iu',
);

/**
 * The bare mailbox questions QUAL-7 sends to policy chat while no mail is configured (`메일 왔어?`, `메일 확인해줘`,
 * `내 메일함에 뭐 왔어?`, `새 메일 왔어?` is the unread form above): with Gmail configured they are the unread listing,
 * like the calendar's QUAL-7 switch (ADR-0110 D5). `이 메일 확인해줘` (a mail the owner points at) is never claimed.
 */
const INBOX_KO = new RegExp(
  `^(?:내 ?)?(?:받은 ?)?(?:편지함|메일함|${MAIL})(?:에|이|은|을)? ?(?:새로 ?)?(?:뭐 ?)?(?:왔어요|왔어|온 ?거 ?있어|확인해 ?줘|확인해 ?주세요|확인)$`,
  'iu',
);

/** A search verb: `<X> 메일 찾아줘` is a sender search even without a link word. */
const SEARCH_VERB = '(?:찾아 ?줘|찾아 ?주세요|찾아 ?줄래|찾아 ?봐 ?줘|찾아 ?봐|검색해 ?줘|검색해 ?주세요|검색)';
/**
 * A show verb. `사과 메일 알려줘` or `정중한 거절 메일 보여줘` asks Quoky to WRITE or EXPLAIN a mail (review P2-2), so
 * with `보여줘`/`알려줘` the head must name a sender explicitly ({@link EXPLICIT_SENDER_LINK}).
 */
const SHOW_VERB = '(?:보여 ?줘|보여 ?주세요|알려 ?줘)';
/** `<head> 메일 <verb>`: the head carries the sender plus optional qualifiers and linking words. */
const FROM_KO = new RegExp(
  `^(?<head>.+?) ?${MAIL}(?:을|를|들)? ?(?:좀 ?)?(?:(?<search>${SEARCH_VERB})|(?<show>${SHOW_VERB}))$`,
  'iu',
);
/** The link words that make a head an explicit sender: `가 보낸`, `한테서 온`, `에서 온`, `님`. */
const EXPLICIT_SENDER_LINK = /(?:(?:이|가) ?보낸|(?:에게서|한테서|으로부터|로부터|에서) ?(?:온|받은)|님)$/u;
/** A particle after a time word or pronoun (`지난 주에`, `작년에`, `어제부터`): the head is a time, never a sender. */
const TIME_PARTICLE = /(?:에서|에|부터|까지)$/u;
/** Second-person words: `네 메일 보여줘` is not a sender search. */
const SECOND_PERSON = new Set(['네', '너', '니', '너의', '당신']);
/** Linking words after a sender: `가 보낸`, `한테서 온`, `에서 온`, `의`, `님`. Stripped from the end, repeatedly. */
const SENDER_LINK =
  /(?: ?(?:이|가)? ?보낸| ?(?:에게서|한테서|으로부터|로부터|에서|한테|께서|께) ?(?:온|받은|보낸)?| (?:온|받은)| ?의| ?님)$/u;
const LEADING_TODAY = /^오늘 /u;
const UNREAD_QUALIFIER = new RegExp(`(?:^${UNREAD_WORD} | ${UNREAD_WORD}$)`, 'u');

/** Senders that are really a pronoun, a determiner or a time word: answered with the usage line, never searched. */
const NOT_A_SENDER = new Set([
  '이', '그', '저', '요', '내', '제', '나', '저희', '우리', '모든', '전체', '전부', '다', '새', '중요한', '중요', '첨부',
  '첨부된', '스팸', '광고', '최근', '요즘', '어제', '그제', '그저께', '내일', '오늘', '이번 주', '이번주', '지난 주',
  '지난주', '이번 달', '이번달', '지난 달', '지난달', '올해', '작년', '받은', '온', '보낸', '안 읽은', '읽은',
]);

const SUMMARY_TAIL = '(?:요약(?:해 ?줘|해 ?주세요|해 ?줄래|해 ?봐|해|좀|부탁해요|부탁해)?)';
const SUMMARY_THIS_KO = new RegExp(
  `^(?:이|그|저|방금|위|이번) ?(?:그 ?)?${MAIL}(?: ?내용)?(?:을|를)? ?(?:좀 ?)?${SUMMARY_TAIL}$`,
  'iu',
);
const SUMMARY_INDEX_KO = new RegExp(
  `^(?<n>\\d{1,2}) ?번(?:째)? ?${MAIL}(?: ?내용)?(?:을|를)? ?(?:좀 ?)?${SUMMARY_TAIL}$`,
  'iu',
);
const SUMMARY_INDEX_AFTER_KO = new RegExp(`^${MAIL} ?(?<n>\\d{1,2}) ?번(?:째)?(?:을|를)? ?(?:좀 ?)?${SUMMARY_TAIL}$`, 'iu');
const ORDINALS_KO: Readonly<Record<string, number>> = {
  첫: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
};
const SUMMARY_ORDINAL_KO = new RegExp(
  `^(?<o>첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열) ?번째 ?${MAIL}(?: ?내용)?(?:을|를)? ?(?:좀 ?)?${SUMMARY_TAIL}$`,
  'iu',
);

const WRITE_VERB_KO =
  '(?:보내 ?줘|보내 ?주세요|보내|전송해 ?줘|전송해 ?주세요|전송|삭제해 ?줘|삭제해 ?주세요|삭제|지워 ?줘|지워 ?주세요|' +
  '보관해 ?줘|보관해 ?주세요|보관|전달해 ?줘|전달해 ?주세요|전달|휴지통에 ?버려 ?줘|휴지통으로 ?옮겨 ?줘|' +
  '읽음 ?(?:으로 ?)?(?:표시|처리)해 ?줘|안 ?읽음 ?(?:으로 ?)?(?:표시|처리)해 ?줘|라벨 ?(?:붙여|달아|추가해) ?줘|' +
  '스팸 ?(?:으로 ?)?(?:신고|처리)해 ?줘)';
const WRITE_KO: readonly RegExp[] = [
  // `메일 보내줘`, `3번 메일 삭제해줘`, `이 메일 보관해줘`, `안 읽은 메일 다 읽음으로 표시해줘`
  new RegExp(
    `^(?:(?:\\d{1,2} ?번(?:째)?|이|그|저|방금|위|안 ?읽은|모든|전체)(?: ?메일)? ?)?(?:다 ?)?${MAIL}(?:을|를|들을|들)? ?(?:다 ?|모두 ?)?${WRITE_VERB_KO}$`,
    'iu',
  ),
  // `김철수에게 메일 보내줘`, `팀장님께 이메일 전송해줘`
  new RegExp(`^.{1,60}?(?:에게|한테|께) ?${MAIL}(?:을|를)? ?(?:보내 ?줘|보내 ?주세요|전송해 ?줘|전송해 ?주세요)$`, 'iu'),
  // `답장 보내줘`, `3번 메일에 답장 보내줘`, `회신 보내줘`
  new RegExp(`^(?:(?:\\d{1,2} ?번(?:째)? ?|이 ?|그 ?)?${MAIL}(?:에|에다)? ?)?(?:답장|회신) ?(?:을|를)? ?(?:보내 ?줘|보내 ?주세요|전송해 ?줘)$`, 'iu'),
  // `읽음으로 표시해줘` (no noun)
  /^(?:다 ?|모두 ?)?(?:안 ?)?읽음 ?(?:으로 ?)?(?:표시|처리)해 ?(?:줘|주세요)$/u,
];

const EN_MAIL = '(?:e-?mails?|mails?|inbox)';
const LIST_EN: ReadonlyArray<{ readonly re: RegExp; readonly unread: boolean; readonly today: boolean }> = [
  { re: new RegExp(`^(?:(?:show|list|check|any|get)(?: me)? )?(?:my |any )?(?:new |unread )${EN_MAIL}(?: please)?$`, 'i'), unread: true, today: false },
  { re: new RegExp(`^do i have (?:any )?(?:new |unread )${EN_MAIL}$`, 'i'), unread: true, today: false },
  { re: new RegExp(`^(?:did i get|have i got|do i have) any (?:new )?(?:e-?mails?|mails?)$`, 'i'), unread: true, today: false },
  { re: /^(?:check|show) my (?:inbox|e-?mail|mail)$/i, unread: true, today: false },
  { re: new RegExp(`^(?:(?:show|list|check|get)(?: me)? )?(?:my )?${EN_MAIL} (?:received |from |that came in )?today(?: please)?$`, 'i'), unread: false, today: true },
  { re: new RegExp(`^(?:(?:show|list|check|get)(?: me)? )?today'?s ${EN_MAIL}$`, 'i'), unread: false, today: true },
  { re: new RegExp(`^(?:(?:show|list|check|get)(?: me)? )?(?:my )?unread ${EN_MAIL} (?:from )?today$`, 'i'), unread: true, today: true },
];
const FROM_EN = new RegExp(`^(?:find|search(?: for)?|show(?: me)?|list|look for)(?: my)? ${EN_MAIL} from (?<sender>.+)$`, 'i');
const SUMMARY_THIS_EN = /^summari[sz]e (?:this|that|the) (?:e-?mail|mail|message)(?: please)?$/i;
const SUMMARY_INDEX_EN = /^summari[sz]e (?:e-?mail|mail|message) (?:#|no\.? ?|number )?(?<n>\d{1,2})(?: please)?$/i;
const WRITE_EN =
  /^(?:send|forward|delete|archive|trash|reply to|label|mark)(?: (?:an?|this|that|the|all|my))? (?:e-?mails?|mails?|messages?)(?: (?:to|from|as) [^.!?,;:]{1,60})?$/i;

/** Normalize like the other deterministic grammars: NFKC, no format characters, one space, no trailing punctuation. */
export function normalizeMailText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?!.。~…]+$/u, '')
    .trim();
}

function languageOf(text: string): MailLanguage {
  return /[가-힣]/u.test(text) ? 'ko' : 'en';
}

function indexTarget(raw: string | undefined): MailSummaryTarget | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAIL_LISTING_MAX_ENTRIES ? { kind: 'index', index: n } : null;
}

/**
 * The sender and qualifiers of a `<head> 메일 찾아줘` head; `'usage'` when no usable sender is left; `null` when the head
 * is another command (an anchored prefix such as `할 일 추가:`), which then falls through.
 */
function parseSenderHead(head: string, show: boolean): { from: string; today: boolean; unread: boolean } | 'usage' | null {
  if (/[:：]/u.test(head)) return null;
  if (show && !EXPLICIT_SENDER_LINK.test(head.trim().replace(new RegExp(` ${UNREAD_WORD}$`, 'u'), ''))) return null;
  let rest = head.trim();
  let today = false;
  let unread = false;
  for (let round = 0; round < 4; round += 1) {
    const before = rest;
    if (LEADING_TODAY.test(rest)) {
      today = true;
      rest = rest.replace(LEADING_TODAY, '').trim();
    }
    if (UNREAD_QUALIFIER.test(rest)) {
      unread = true;
      rest = rest.replace(UNREAD_QUALIFIER, '').trim();
    }
    rest = rest.replace(SENDER_LINK, '').trim();
    if (rest === before) break;
  }
  const from = rest.replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, '').trim();
  if (SECOND_PERSON.has(from)) return null;
  const stem = from.replace(TIME_PARTICLE, '').trim();
  if (stem !== from && (NOT_A_SENDER.has(stem) || /^(?:지난|이번|다음|올|작|재작) ?(?:주|달|해|년)$/u.test(stem))) return null;
  if (from.length === 0 || NOT_A_SENDER.has(from) || Array.from(from).length > MAIL_SENDER_QUERY_MAX_LENGTH) return 'usage';
  return { from, today, unread };
}

/**
 * The mail question `text` asks, or `null` when the message is not one of the anchored mail forms (it then falls
 * through unchanged). Pure; never reads a clock or any mail.
 */
export function parseMailQuestion(text: string): MailQuestion | null {
  if (typeof text !== 'string' || text.length > 300) return null;
  const normalized = normalizeMailText(text);
  // Whitespace runs (line breaks included) are already one space here, so a line break needs no check of its own.
  if (normalized.length === 0) return null;
  const language = languageOf(normalized);

  if (WRITE_KO.some((re) => re.test(normalized)) || WRITE_EN.test(normalized)) {
    return { kind: 'write-refused', language };
  }

  if (SUMMARY_THIS_KO.test(normalized) || SUMMARY_THIS_EN.test(normalized)) {
    return { kind: 'summarize', target: { kind: 'this' }, language };
  }
  const indexed =
    SUMMARY_INDEX_KO.exec(normalized) ?? SUMMARY_INDEX_AFTER_KO.exec(normalized) ?? SUMMARY_INDEX_EN.exec(normalized);
  if (indexed) {
    const target = indexTarget(indexed.groups?.n);
    return target ? { kind: 'summarize', target, language } : { kind: 'usage', language };
  }
  const ordinal = SUMMARY_ORDINAL_KO.exec(normalized);
  if (ordinal) {
    const index = ORDINALS_KO[ordinal.groups?.o ?? ''];
    return index !== undefined ? { kind: 'summarize', target: { kind: 'index', index }, language } : null;
  }

  const listKo = LIST_KO.exec(normalized);
  if (listKo && (listKo.groups?.today !== undefined || listKo.groups?.unread !== undefined)) {
    return { kind: 'list', unread: listKo.groups?.unread !== undefined, today: listKo.groups?.today !== undefined, language };
  }
  if (INBOX_KO.test(normalized)) return { kind: 'list', unread: true, today: false, language };
  for (const form of LIST_EN) {
    if (form.re.test(normalized)) return { kind: 'list', unread: form.unread, today: form.today, language };
  }

  const fromKo = FROM_KO.exec(normalized);
  if (fromKo) {
    const parsed = parseSenderHead(fromKo.groups?.head ?? '', fromKo.groups?.show !== undefined);
    if (parsed === null) return null;
    if (parsed === 'usage') return { kind: 'usage', language };
    return { kind: 'list', unread: parsed.unread, today: parsed.today, from: parsed.from, language };
  }
  const fromEn = FROM_EN.exec(normalized);
  if (fromEn) {
    const sender = (fromEn.groups?.sender ?? '').replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, '').trim();
    // `find emails from me please` is about the owner's own mail, never a sender called "me" (review P2-2).
    if (/^(?:me|myself|my)\b/i.test(sender)) return null;
    if (sender.length === 0 || Array.from(sender).length > MAIL_SENDER_QUERY_MAX_LENGTH || /^(?:me|today|yesterday)$/i.test(sender)) {
      return { kind: 'usage', language };
    }
    return { kind: 'list', unread: false, today: false, from: sender, language };
  }
  return null;
}

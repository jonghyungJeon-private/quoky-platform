import { detectReplyLanguage } from '@quoky/core';
import type { GeneralChatReplyPolicy } from '@quoky/core';

const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const OSC = 0x9d;
const ST = 0x9c;

function consumeCsi(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
    if (code < 0x20 || code > 0x3f) return i;
  }
  return input.length;
}

function consumeOsc(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === BEL || code === ST) return i + 1;
    if (code === ESC && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return input.length;
}

function consumeEscape(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code > 0x2f) break;
    i += 1;
  }
  if (i < input.length) {
    const final = input.charCodeAt(i);
    if (final >= 0x30 && final <= 0x7e) return i + 1;
  }
  return start;
}

/**
 * Remove machine-recognizable terminal framing without interpreting natural
 * language. LF, CR, and TAB are intentionally preserved for Markdown output.
 */
export function sanitizeTerminalOutput(input: string): string {
  let output = '';

  for (let i = 0; i < input.length; ) {
    const code = input.charCodeAt(i);

    if (code === ESC) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b) {
        i = consumeCsi(input, i + 2);
        continue;
      }
      if (next === 0x5d) {
        i = consumeOsc(input, i + 2);
        continue;
      }
      i = consumeEscape(input, i + 1);
      continue;
    }

    if (code === CSI) {
      i = consumeCsi(input, i + 1);
      continue;
    }
    if (code === OSC) {
      i = consumeOsc(input, i + 1);
      continue;
    }

    const allowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    const disallowedControl =
      (!allowedWhitespace && code < 0x20) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f);
    if (disallowedControl) {
      i += 1;
      continue;
    }

    output += input[i];
    i += 1;
  }

  return output;
}

const INTERNAL_PROVENANCE = 'ASSISTANT';
const INTERNAL_EPISTEMIC_STATUS = 'ASSISTANT_NON_AUTHORITATIVE';

function contentFromJsonEnvelope(input: string): string | null {
  try {
    const envelope = JSON.parse(input) as Record<string, unknown>;
    const role = envelope.role;
    return (role === undefined || role === 'assistant') &&
      envelope.provenance === INTERNAL_PROVENANCE &&
      envelope.epistemicStatus === INTERNAL_EPISTEMIC_STATUS &&
      typeof envelope.content === 'string'
      ? envelope.content
      : null;
  } catch {
    return null;
  }
}

/**
 * Remove only the adapter's machine-recognizable Assistant metadata envelope.
 * Natural-language content is otherwise preserved verbatim; this does not
 * interpret the response or choose user-facing wording.
 */
export function stripInternalMetadataEnvelope(input: string): string {
  const trimmed = input.trim();
  const jsonContent = contentFromJsonEnvelope(trimmed);
  if (jsonContent !== null) return jsonContent;

  const lines = input.split(/\r?\n/u);
  const roleHeading = /^## (SYSTEM|USER|ASSISTANT|UNKNOWN) message$/u;

  // A model can echo the role-attributed stdin transcript. Once a canonical
  // role heading is present, accept content only from an Assistant block. In
  // particular, never turn an echoed USER Content field into the response.
  if (lines.some((line) => roleHeading.test(line.trim()))) {
    const assistantOutput: string[] = [];
    let role: string | null = null;

    for (const line of lines) {
      const normalized = line.trim();
      const heading = roleHeading.exec(normalized);
      if (heading) {
        role = heading[1] ?? null;
        continue;
      }
      if (normalized === '# Role-attributed conversation') continue;
      if (role !== 'ASSISTANT') continue;
      if (normalized === 'Provenance: ASSISTANT') continue;
      if (normalized === 'Epistemic status: ASSISTANT_NON_AUTHORITATIVE') continue;

      const content = decodeContentLine(line);
      assistantOutput.push(content ?? line);
    }

    while (assistantOutput[0]?.trim() === '') assistantOutput.shift();
    while (assistantOutput.at(-1)?.trim() === '') assistantOutput.pop();
    return assistantOutput.join('\n');
  }

  // The older headerless Assistant envelope is still accepted. A headerless
  // USER provenance marker is an echoed input, so fail closed instead of
  // replaying its Content field as an Assistant response.
  if (lines.some((line) => line.trim() === 'Provenance: USER')) return '';
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const normalized = (lines[index] ?? '').trim();

    if (normalized === '# Role-attributed conversation') continue;
    if (/^## (?:SYSTEM|USER|ASSISTANT|UNKNOWN) message$/u.test(normalized)) continue;
    if (/^Provenance: [A-Z][A-Z_]*$/u.test(normalized)) continue;
    if (/^Epistemic status: [A-Z][A-Z_]*$/u.test(normalized)) continue;

    const content = decodeContentLine(lines[index] ?? '');
    if (content !== null) {
      output.push(content);
      continue;
    }

    output.push(lines[index] ?? '');
  }

  while (output[0]?.trim() === '') output.shift();
  while (output.at(-1)?.trim() === '') output.pop();
  return output.join('\n');
}

function decodeContentLine(line: string): string | null {
  const normalized = line.trim();
  if (!normalized.startsWith('Content: ')) return null;
  try {
    const content = JSON.parse(normalized.slice('Content: '.length)) as unknown;
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}

// Marker matching is per line and only on prose lines (never inside fenced or indented code). Up to three leading
// spaces, as in a Markdown paragraph; a deeper indent is an indented code block, not a heading.
const TRANSLATION_MARKER_LINE =
  /^ {0,3}[(\[]?[ \t]*(?:translated from [\p{L}]+|(?:english |korean )?translation|in english|in korean|(?:영어 |한국어 )?번역)[ \t]*(?:[:：)\]]|$)/iu;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const INDENTED_CODE_LINE = /^(?: {4}|[ ]{0,3}\t)/u;

interface SourceLine {
  /** Line text without its terminator. */
  readonly text: string;
  /** Offset of the first character of the line in the source text. */
  readonly start: number;
  /** True for a fence delimiter or a line inside a fenced code block. */
  readonly code: boolean;
}

/**
 * Split text into lines and classify each as prose or fenced code (CommonMark fences: ``` or ~~~, length >= 3, closed
 * by the same character with at least the opener's length and nothing but whitespace after it). A longer fence can
 * contain shorter ones, so nested examples stay inside the outer block. Returns `null` when a fence is left open, in
 * which case the code/prose split is not trustworthy.
 */
function classifyLines(text: string): SourceLine[] | null {
  const lines: SourceLine[] = [];
  const terminator = /\r?\n/gu;
  let start = 0;
  const raw: { text: string; start: number }[] = [];
  for (const match of text.matchAll(terminator)) {
    raw.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  raw.push({ text: text.slice(start), start });

  let fence: { char: string; length: number } | null = null;
  for (const line of raw) {
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line.text);
      const run = close?.[1];
      if (run !== undefined && run[0] === fence.char && run.length >= fence.length) fence = null;
      lines.push({ ...line, code: true });
      continue;
    }
    const open = FENCE_OPEN.exec(line.text);
    const run = open?.[1];
    // A backtick fence's info string cannot contain a backtick (that is inline code, not a fence).
    if (run !== undefined && !(run[0] === '`' && (open?.[2] ?? '').includes('`'))) {
      fence = { char: run[0] ?? '`', length: run.length };
      lines.push({ ...line, code: true });
      continue;
    }
    lines.push({ ...line, code: false });
  }
  return fence === null ? lines : null;
}

/**
 * True when the end of `prose` is inside an inline code span opened earlier in the same paragraph. Conservative: an
 * unmatched backtick run counts as an open span, so a marker after it is never treated as prose.
 */
function endsInsideInlineCode(prose: string): boolean {
  let open: number | null = null;
  for (const match of prose.matchAll(/`+/gu)) {
    const length = match[0].length;
    if (open === null) open = length;
    else if (length === open) open = null;
  }
  return open !== null;
}

/**
 * Remove a final, explicitly marked translation block that the User did not ask for (e.g. a trailing
 * "(Translated from Korean)" section). The User-side facts come only from Core's structured `GeneralChatReplyPolicy`
 * (`AiRequest.metadata`), never from searching the serialized prompt. Only when: the User message has a detectable
 * language and carries no language or translation request; the marker is a prose line outside any fenced, indented or inline code; the
 * marked block runs to the end of the text and is prose only (no code block); the text before the marker is in the
 * User language; and the marked block is in the other script. Code is never inspected for markers or stripped, and an
 * unbalanced fence disables stripping entirely. Otherwise the text is returned unchanged.
 */
export function stripUnsolicitedTranslationBlock(
  text: string,
  replyPolicy: GeneralChatReplyPolicy | undefined,
): string {
  if (replyPolicy === undefined) return text;
  const userLanguage = replyPolicy.replyLanguage;
  if (userLanguage === 'unknown' || replyPolicy.explicitLanguageRequest) return text;

  const lines = classifyLines(text);
  if (lines === null) return text;

  let markerIndex = -1;
  let marker: RegExpExecArray | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.code) continue;
    // A marker on an indented-code line (4+ spaces or a tab, Markdown code block) is code, not prose.
    if (INDENTED_CODE_LINE.test(line.text)) continue;
    const match = TRANSLATION_MARKER_LINE.exec(line.text);
    if (match === null) continue;
    markerIndex = index;
    marker = match;
    break;
  }
  if (marker === null) return text;
  const markerLine = lines[markerIndex];
  if (markerLine === undefined) return text;

  // The marker must not continue an inline code span opened earlier in its paragraph.
  const paragraph: string[] = [];
  for (let index = markerIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.code || line.text.trim() === '') break;
    paragraph.unshift(line.text);
  }
  if (endsInsideInlineCode(paragraph.join('\n'))) return text;

  // The translation section is the rest of the marker line plus every following line, and must be prose only.
  const trailing = lines.slice(markerIndex + 1);
  if (trailing.some((line) => line.code || INDENTED_CODE_LINE.test(line.text))) return text;

  const body = text.slice(0, markerLine.start);
  const block = text.slice(markerLine.start + marker[0].length);
  if (body.trim() === '') return text;
  if (detectReplyLanguage(body) !== userLanguage) return text;
  const blockLanguage = detectReplyLanguage(block);
  if (blockLanguage === 'unknown' || blockLanguage === userLanguage) return text;
  return body.trimEnd();
}

const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/u;
const LITERAL_NEWLINE = /(?<!\\)\\n/gu;

/**
 * Convert a literal two-character `\n` artifact to a real newline, outside code fences and inline code. Applies only
 * when the text has no real line break and at least two literal occurrences, so a single `\n` (or any `\n` in code
 * or a multi-line answer) is preserved.
 */
export function normalizeLiteralEscapes(text: string): string {
  if (/[\r\n]/u.test(text)) return text;
  const segments = text.split(CODE_SEGMENT);
  let occurrences = 0;
  for (let i = 0; i < segments.length; i += 2) {
    occurrences += segments[i]?.match(LITERAL_NEWLINE)?.length ?? 0;
  }
  if (occurrences < 2) return text;
  return segments
    .map((segment, index) => (index % 2 === 0 ? segment.replace(LITERAL_NEWLINE, '\n') : segment))
    .join('');
}

/** Deterministic Korean notice that replaces a reply claiming an unsupported external action (ADR-0098 amendment D2). */
export const UNSUPPORTED_ACTION_NOTICE_KO =
  'Quoky는 캘린더 등록, 메일·문자 발송, 예약, 결제, 외부 서비스 게시 같은 외부 작업을 직접 할 수 없어요. ' +
  '이 요청으로 실행된 작업은 없어요. 할 수 있는 일은 "도움말"에서 확인할 수 있어요.';

/** Deterministic English notice that replaces a reply claiming an unsupported external action (ADR-0098 amendment D2). */
export const UNSUPPORTED_ACTION_NOTICE_EN =
  "Quoky can't perform external actions such as adding calendar entries, sending email or messages, bookings, " +
  'payments or posting to other services. Nothing was done for this request. Type "/help" to see what Quoky can do.';

// Korean claim endings. SERVICE: the assistant did / will do it for the User ("추가해 드릴게요", "예약해 드렸어요",
// "등록해 놨어요", "완료됐어요"). ANY: SERVICE plus plain past/future ("추가했어요", "보낼게요").
const KO_SERVICE_END = String.raw`(?:해\s*(?:드릴게|드릴께|드리겠|드렸|놓을게|놓았|놨|뒀|두었|둘게|줄게|줬)|완료\s*(?:했|하였|됐|되었|해\s*드렸)|됐|되었)`;
const KO_ANY_END = String.raw`(?:${KO_SERVICE_END}|했|하였|하겠|할게|할께)`;
const KO_PARTICLE = String.raw`(?:\s*(?:을|를|이|가|은|는))?\s*`;
const KO_GIVE = String.raw`\s*(?:드릴게|드릴께|드리겠|드렸|놓을게|놓았|놨|뒀|두었|둘게|줄게|줬)`;
/** "보내 드렸어요", "보냈어요", "보낼게요", "보내겠습니다" — the same shape for 올리다/걸다/넣다/잡다. */
function koNativeVerb(stem: string, past: string, promise: string, intent: string): string {
  return String.raw`(?:${stem}${KO_GIVE}|${past}|${promise}(?:게|께)|${intent}겠)`;
}
const KO_SEND = koNativeVerb('보내', '보냈', '보낼', '보내');
const KO_POST = koNativeVerb('올려', '올렸', '올릴', '올리');
const KO_CALL = koNativeVerb('걸어', '걸었', '걸', '걸');
const KO_PUT = String.raw`(?:${koNativeVerb('넣어', '넣었', '넣을', '넣')}|${koNativeVerb('잡아', '잡았', '잡을', '잡')})`;
const KO_PUT_SERVICE = String.raw`(?:넣어|잡아)${KO_GIVE}`;
/** A conditional, question or negated continuation means the sentence does not claim the action. */
const KO_NOT_A_CLAIM = String.raw`(?!\s*(?:는지|냐|나요|다면|다고|다는|더라도|던|을\s*(?:때|경우|수)|으면|면|지\s*(?:않|못|마)|기\s*(?:전|위해)|어야|야\s*(?:해|합)))`;
/**
 * A claim quoted as UI copy is a mention, not a claim: "예약이 완료됐어요 메시지를 보여줍니다", "결제가 완료되었어요 화면을
 * 띄우세요", "…완료됐어요라는 문구".
 */
const KO_UI_COPY = String.raw`(?![가-힣]{0,5}['"’”」』]?\s*(?:(?:이)?라는|(?:이)?란|메시지|메세지|화면|문구|알림|토스트|팝업|텍스트|안내\s*문|라벨|레이블|버튼|페이지|모달|다이얼로그))`;
/** A planning list introduced by the claim ("아래와 같이 일정을 추가해 드릴게요: 1) 기상 2) 운동") drafts, never acts. */
const KO_PLANNING_LIST = String.raw`(?![가-힣]{0,5}\s*[:：]\s*(?:$|\d+\s*[.)]|[-*•·]|[①-⑳]))`;
const GAP = String.raw`[^.!?\n]{0,40}?`;

function koClaim(source: string, extraGuard = ''): RegExp {
  return new RegExp(`(?:${source})${KO_NOT_A_CLAIM}${KO_UI_COPY}${extraGuard}`, 'iu');
}

const KO_ACTION_CLAIMS: readonly RegExp[] = [
  // calendar: a calendar service noun with any claim; a bare 일정/회의 noun only with a service claim
  koClaim(String.raw`(?:캘린더|달력|calendar|outlook|아웃룩)${GAP}(?:(?:추가|등록|입력|생성|저장|예약)${KO_PARTICLE}${KO_ANY_END}|${KO_PUT})`),
  koClaim(
    String.raw`(?:일정|스케줄|미팅|회의(?!록))${GAP}(?:(?:추가|등록|입력|생성|예약)${KO_PARTICLE}${KO_SERVICE_END}|${KO_PUT_SERVICE})`,
    KO_PLANNING_LIST,
  ),
  // email
  koClaim(String.raw`(?:메일|이메일|e-?mail|gmail|지메일)${GAP}(?:(?:발송|전송|회신|답장|전달|포워딩)${KO_PARTICLE}${KO_ANY_END}|${KO_SEND})`),
  // SMS / messenger / phone
  koClaim(String.raw`(?:문자|sms|카톡|카카오톡|메시지|메세지|알림톡)${GAP}(?:(?:발송|전송)${KO_PARTICLE}${KO_ANY_END}|${KO_SEND})`),
  koClaim(String.raw`(?:전화|통화)${GAP}${KO_CALL}|(?:전화|통화)${KO_PARTICLE}${KO_ANY_END}`),
  // booking / payment: the action noun itself carries the claim
  koClaim(String.raw`(?:예약|예매)${KO_PARTICLE}(?:${KO_ANY_END}|${KO_PUT})`),
  koClaim(String.raw`(?:결제|송금|이체|입금|구매|구입|주문)${KO_PARTICLE}${KO_ANY_END}`),
  koClaim(String.raw`계좌${GAP}${KO_SEND}`),
  // posting to an external service
  koClaim(String.raw`(?:트위터|트윗|페이스북|인스타(?:그램)?|링크드인|블로그|슬랙|slack|게시판|sns|커뮤니티|레딧|reddit|유튜브|twitter|facebook|instagram|linkedin)${GAP}(?:(?:게시|포스팅|업로드|공유|등록|트윗)${KO_PARTICLE}${KO_ANY_END}|${KO_POST})`),
];

// English: the assistant as subject ("I have added", "I'll send", "Let me book", "I'm posting"), never after a
// conditional ("if I sent ..."); a negation ("I haven't sent", "I can't add", "I will not send") never matches.
const EN_SUBJECT_PAST = String.raw`(?<!\b(?:if|once|when|after|before|until|unless|whether)\s)\bI(?:'ve|\s+have)?(?:\s+(?:just|already|now|successfully|also))?\s+`;
const EN_SUBJECT_FUTURE = String.raw`(?:(?<!\b(?:if|once|when|after|before|until|unless|whether)\s)\bI(?:'ll|\s+will|'m\s+going\s+to|\s+am\s+going\s+to)\s+(?:now\s+|also\s+|go\s+ahead\s+and\s+)?|\blet\s+me\s+(?:go\s+ahead\s+and\s+)?)`;
const EN_SUBJECT_PROGRESSIVE = String.raw`\bI(?:'m|\s+am)\s+(?:now\s+)?`;

/**
 * `noun` follows the verb in the same sentence: anywhere when `maxWords` is omitted, else after at most `maxWords`
 * intervening words ("I booked a table", never "I've scheduled the cron job ... jobs table").
 */
function enClaim(past: string, base: string, progressive: string, noun?: string, maxWords?: number): RegExp {
  const verb = String.raw`(?:${EN_SUBJECT_PAST}(?:${past})|${EN_SUBJECT_FUTURE}(?:${base})|${EN_SUBJECT_PROGRESSIVE}(?:${progressive}))\b`;
  if (noun === undefined) return new RegExp(verb, 'iu');
  const gap = maxWords === undefined ? String.raw`[^.!?\n]*\b` : String.raw`(?:\s+[^\s.!?]+){0,${maxWords}}?\s+`;
  return new RegExp(String.raw`${verb}${gap}(?:${noun})\b`, 'iu');
}

/**
 * A User's calendar, never a calendar in code or UI: "your calendar", "your Google Calendar", "to the calendar", but
 * not "a calendar component" or "your calendar view".
 */
const EN_CALENDAR = String.raw`(?:(?:(?:your|my|his|her|their|our)\s+)?(?:google|outlook|icloud|apple|work|shared|team)\s+calendars?|(?:your|my|his|her|their|our)\s+calendars?|(?:to|on|in|into)\s+the\s+calendar)(?![\s-]+(?:component|view|widget|app|apps|application|style|styles|ui|library|api|module|class|page|layout|grid|picker|template|example|integration|feature|code|data|logic|state|event\s+handler)\b)`;
/** A messaging target, never a message to a queue, socket or other code object ("send a message to the queue"). */
const EN_MESSAGE = String.raw`(?:e-?mails?|mails?|inbox|texts?|sms|invites?|messages?(?![^.!?\n]*\b(?:queues?|broker|bus|body|payload|handler|object|type|event|topic|worker|socket|websocket|server|endpoint|api|webhook|thread|process|client|consumer|producer)\b))`;
/** An external service as the place something is posted ("on LinkedIn", "to your Slack channel"). */
const EN_EXTERNAL_SERVICE = String.raw`(?:on|to|in|onto|via)\s+(?:(?:your|the|my|our|a)\s+)?(?:twitter|x\.com|facebook|instagram|linkedin|blog|slack|reddit|threads|youtube|discord|social\s+media|(?:slack|discord|youtube|teams|telegram)\s+channel)(?!\s+(?:marketing|strategy|strategies|tips|posts?|content|best\s+practices|api|integration)\b)`;

const EN_ACTION_CLAIMS: readonly RegExp[] = [
  // calendar / booking
  enClaim('added|put', 'add|put', 'adding|putting', EN_CALENDAR),
  enClaim('scheduled|set\\s+up|booked', 'schedule|set\\s+up|book', 'scheduling|setting\\s+up|booking', EN_CALENDAR),
  enClaim(
    'scheduled|booked',
    'schedule|book',
    'scheduling|booking',
    'meetings?|appointments?|invites?|calls?|tables?|flights?|hotels?|rooms?|tickets?|seats?|reservations?',
    3,
  ),
  enClaim('set\\s+up', 'set\\s+up', 'setting\\s+up', 'meetings?|appointments?|calls?', 3),
  enClaim(
    'reserved',
    'reserve',
    'reserving',
    'tables?|rooms?|seats?|tickets?|flights?|hotels?|spots?|appointments?|reservations?',
    3,
  ),
  // email / SMS / messenger / phone
  enClaim('sent|forwarded', 'send|forward', 'sending|forwarding', EN_MESSAGE, 4),
  enClaim('emailed|texted|messaged|tweeted', 'email|text|tweet', 'emailing|texting|tweeting'),
  enClaim(
    'called|phoned',
    'call|phone',
    'calling|phoning',
    'you\\s+back|mom|mum|dad|him|her|phones?|(?:phone\\s+)?numbers?|(?:your|his|her|their)\\s+(?:mom|mum|dad|mother|father|wife|husband|boss|manager|doctor|office|friend|sister|brother|parents?)',
    1,
  ),
  // payment / purchase
  enClaim(
    'paid|transferred|wired',
    'pay|transfer|wire',
    'paying|transferring|wiring',
    'bills?|invoices?|rent|payments?|money|funds|fees?|\\d[\\d,.]*\\s*(?:won|dollars?|usd|krw)',
    3,
  ),
  enClaim(
    'purchased|bought',
    'purchase|buy',
    'purchasing|buying',
    'tickets?|items?|products?|subscriptions?|gifts?|shares?|stocks?|groceries|licen[cs]es?|it\\s+for\\s+you',
    3,
  ),
  enClaim(
    'ordered',
    'order',
    'ordering',
    'food|pizza|delivery|takeout|lunch|dinner|groceries|it\\s+for\\s+you|(?:a|an|the|your)\\s+(?:\\w+\\s+)?(?:pizza|meal)',
    2,
  ),
  enClaim('placed', 'place', 'placing', '(?:your|an?)\\s+(?:\\w+\\s+)?order|the\\s+order\\s+for\\s+you', 1),
  // posting to an external service
  enClaim(
    'posted|published|shared|uploaded',
    'post|publish|share|upload',
    'posting|publishing|sharing|uploading',
    EN_EXTERNAL_SERVICE,
  ),
  // passive completion ("Your meeting has been added to your calendar", "The email has been sent")
  new RegExp(
    String.raw`\b(?:has|have)\s+(?:now\s+)?been\s+(?:successfully\s+)?(?:added|scheduled|booked|reserved|put)\b[^.!?\n]*\b${EN_CALENDAR}`,
    'iu',
  ),
  /\b(?:has|have)\s+(?:now\s+)?been\s+(?:successfully\s+)?(?:sent|forwarded|emailed)\s+to\s+(?:your|his|her|their|the)\s+(?:inbox|manager|boss|team|client|customer|landlord|mom|dad|friend)\b/iu,
  /\b(?:your|the)\s+(?:calendar\s+)?(?:meetings?|appointments?|e-?mails?|reservations?|bookings?|payments?|orders?|tables?|flights?|tickets?|tweets?)\b[^.!?\n]*\b(?:has|have)\s+(?:now\s+)?been\s+(?:successfully\s+)?(?:added|scheduled|booked|reserved|sent|forwarded|emailed|paid|transferred|placed|posted|published|confirmed)\b/iu,
];

/**
 * An English sentence that describes code or UI copy rather than an action Quoky took ("Your order has been placed -
 * this is the success message the API returns").
 */
const EN_UI_OR_CODE_MENTION =
  /\b(?:(?:success|confirmation|error|status|toast|placeholder)\s+(?:message|screen|text|toast|banner|page|state|copy|string|dialog|modal)|(?:api|server|endpoint|function|method|handler|component|app|ui|backend|frontend|webhook|response)\s+(?:returns|shows|displays|renders|sends\s+back)|(?:message|text|toast|banner|alert|label|string)\s+(?:that\s+|which\s+)?(?:says|reads))\b/iu;

/** The prose of a reply: fenced and inline code, double-quoted text and block quotes are mentions, never claims. */
function claimProse(text: string): string[] {
  const prose = text
    .replace(/(?:^|\n)[ ]{0,3}(`{3,}|~{3,})[\s\S]*?(?:\n[ ]{0,3}\1[ \t]*(?=\n|$)|$)/gu, '\n')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/gu, ' ')
    .split(/\r?\n/u)
    .filter((line) => !/^\s{0,3}>/u.test(line))
    .join('\n');
  return prose.split(/(?<=[.!?。])\s+|\n+/u).filter((sentence) => sentence.trim() !== '');
}

/**
 * True when a chat reply claims to have performed, or to be about to perform, an external action Quoky has no
 * capability for (calendar entries, email/SMS/messenger sends, phone calls, bookings, payments, posting to external
 * services). Deterministic and provider-neutral (ADR-0098 amendment D2). Questions, conditionals, negations
 * ("보낼 수 없어요", "I can't send"), code, double-quoted text and block quotes never count. Matching is per sentence
 * (sentence punctuation or a line break), so a noun and a verb on different lines are not combined.
 */
export function claimsUnsupportedExternalAction(text: string): boolean {
  return claimProse(text).some(
    (sentence) =>
      KO_ACTION_CLAIMS.some((pattern) => pattern.test(sentence)) ||
      (!EN_UI_OR_CODE_MENTION.test(sentence) && EN_ACTION_CLAIMS.some((pattern) => pattern.test(sentence))),
  );
}

/** The notice in the reply language: the Core reply policy first, then the reply's own language, else both. */
function unsupportedActionNotice(text: string, replyPolicy: GeneralChatReplyPolicy | undefined): string {
  const fromPolicy = replyPolicy?.replyLanguage;
  const language = fromPolicy === 'ko' || fromPolicy === 'en' ? fromPolicy : detectReplyLanguage(text);
  if (language === 'ko') return UNSUPPORTED_ACTION_NOTICE_KO;
  if (language === 'en') return UNSUPPORTED_ACTION_NOTICE_EN;
  return `${UNSUPPORTED_ACTION_NOTICE_KO}\n\n${UNSUPPORTED_ACTION_NOTICE_EN}`;
}

/**
 * Provider-neutral action-claim guard (ADR-0098 amendment D2): a chat reply that claims an unsupported external
 * action is replaced as a whole by a deterministic notice that Quoky cannot do it and nothing was done. Any other
 * reply is returned unchanged.
 */
export function guardUnsupportedActionClaims(text: string, replyPolicy?: GeneralChatReplyPolicy): string {
  return claimsUnsupportedExternalAction(text) ? unsupportedActionNotice(text, replyPolicy) : text;
}

/**
 * Provider-neutral chat output hygiene applied after `stripInternalMetadataEnvelope` to every GENERAL_CHAT and
 * POLICY_SENSITIVE_CHAT reply (ADR-0098 D2 and amendment D2).
 */
export function sanitizeGeneralChatText(output: string, replyPolicy?: GeneralChatReplyPolicy): string {
  return guardUnsupportedActionClaims(
    stripUnsolicitedTranslationBlock(normalizeLiteralEscapes(output), replyPolicy),
    replyPolicy,
  );
}

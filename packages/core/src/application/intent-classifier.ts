import { Capability, IntentType } from '../domain';
import type { InboundMessage, Intent } from '../domain';
import type { CapabilityRouter } from './capability-router';
import { detectReplyLanguage, isExternalActionKind } from './chat-policy';
import type { ExternalActionKind, ExternalActionRequest } from './chat-policy';
import { hasCoLocatedUnnegated, unnegatedMatch } from './intent-negation';
import { detectExplicitValidationKinds, isDeniedValidationRequest } from './validation-run-intent';

export interface IntentClassifyContext {
  /** False when the conversation has no active project; omitted keeps the context-free behavior. */
  readonly hasActiveProject?: boolean;
}

/** `Intent.raw.kind` of a REGISTER_PROJECT intent whose path is not absolute (QA-015). */
export const NON_ABSOLUTE_REGISTRATION_KIND = 'non-absolute-path';

const REGISTER_VERB = /등록|register/i;
const PROJECT_NOUN = /(프로젝트|저장소|레포|\bprojects?\b|\brepos?\b|\brepositor(?:y|ies)\b)/i;

/** First absolute POSIX path (>= 2 segments, at a token start) in the text, if any — so "7/3" is not a path. */
function extractLocalPath(text: string): string | undefined {
  const match = text.match(/(?:^|[\s"'`(:=])(\/[^\s/]+(?:\/[^\s/]+)+)/);
  return match ? match[1] : undefined;
}

/**
 * A path-like token that is NOT absolute (QA-015): `./x`, `../x`, `~/x`, `.`/`..`, or an ASCII slash path with a
 * letter (`my/repo`; prose such as "등록/삭제" is not a path). A leading `/` is never reported here (absolute, or a one-segment `/repo` left to existing handling),
 * and a digits-only slash token ("7/3") is a date, not a path.
 */
function extractNonAbsolutePathToken(text: string): string | undefined {
  for (const raw of text.split(/[\s:"'`()<>]+/)) {
    const token = /^\.+$/.test(raw) ? raw : raw.replace(/[.,!?]+$/, '');
    if (!token || token.startsWith('/')) continue;
    if (/^(?:\.{1,2}|~)(?:\/|$)/.test(token)) return token;
    if (/^[\w.~-]+(?:\/[\w.~-]*)+$/.test(token) && /[A-Za-z]/.test(token)) return token;
  }
  return undefined;
}

/**
 * Explicit local project registration (ADR-0018; QA-015). Absolute: an absolute path (>= 2 segments) plus a
 * register word — unchanged. Non-absolute: a project noun (프로젝트/저장소/레포/repo/project) AND a register word
 * AND a relative/home path-like token, so "7/3 회의 등록해줘" (no project noun, no path) stays ordinary chat.
 */
export function detectProjectRegistration(text: string): { path: string; absolute: boolean } | null {
  if (!REGISTER_VERB.test(text)) return null;
  const absolute = extractLocalPath(text);
  if (absolute) return { path: absolute, absolute: true };
  // The project noun must be prose, not part of a path ("~/code/repo 등록해줘" has no project noun).
  if (!PROJECT_NOUN.test(text.replace(/\S*\/\S*/g, ' '))) return null;
  const relative = extractNonAbsolutePathToken(text);
  return relative ? { path: relative, absolute: false } : null;
}

/** `Intent.raw.kind` of a chat intent that Core routed to `POLICY_SENSITIVE_CHAT` (ADR-0098 amendment). */
export const POLICY_SENSITIVE_CHAT_KIND = 'policy-sensitive-chat';

/**
 * Why a chat turn is policy-sensitive (ADR-0098 amendment D1 a/b/c, plus `personal-data`: a question about the owner's
 * own schedule, mail, money or messages, which Quoky cannot see — QA-V2-005).
 */
export type PolicySensitiveChatReason = 'external-action' | 'injection' | 'unsupported-language' | 'personal-data';

/**
 * Korean request endings after a verb stem ("…해줘", "…보내 주세요", "…해줄래?", "…해줄 수 있어?"). A descriptive or
 * question-about form ("보내는 법", "추가하는 방법") never carries one, so it is not read as a request.
 */
const KO_REQUEST = String.raw`\s*(?:줘|주세요|주십시오|주실래요?|주시겠어요|주시겠습니까|줄래요?|줄\s*수\s*있|주실\s*수\s*있|달라|봐\s*줘|봐\s*주세요)`;
const KO_PARTICLE = String.raw`(?:\s*(?:을|를|은|는|도|로|으로))?\s*(?:좀\s*|빨리\s*|바로\s*)?`;

function koRequest(verbs: string): RegExp {
  return new RegExp(`(?:${verbs})${KO_REQUEST}`, 'iu');
}

/**
 * English request position: the verb starts a sentence, optionally after a greeting and "please" / "can you" /
 * "go ahead and" / "I want you to". "How do I send an email?" therefore never counts as a request.
 */
const EN_REQUEST_PREFIX =
  String.raw`(?:^|[.!?;]\s+|\n\s*)(?:(?:hey|hi|ok|okay)\b[^,.!?\n]{0,20},\s*)?(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|go\s+ahead\s+and\s+|i\s+(?:want|need)\s+you\s+to\s+|i(?:'d|\s+would)\s+like\s+you\s+to\s+)?`;

function enRequest(body: string): RegExp {
  return new RegExp(`${EN_REQUEST_PREFIX}(?:${body})`, 'iu');
}

const EN_SENTENCE_REST = String.raw`\b[^.!?\n]*\b`;

/**
 * Unsupported external actions (ADR-0098 amendment D1 a). Each entry is a noun/verb pair that must co-occur in one
 * un-negated clause; the verb carries the Korean request ending. "회의" alone is not a calendar noun ("7/3 회의
 * 등록해줘" stays ordinary chat, which the output action-claim guard does not inspect). `kind` is carried to the
 * adapter as `GeneralChatReplyPolicy.externalActionRequested`.
 */
const KO_EXTERNAL_ACTIONS: readonly {
  readonly kind: ExternalActionKind;
  readonly noun: RegExp;
  readonly verb: RegExp;
  readonly blocker?: RegExp;
}[] = [
  // calendar / schedule; a job schedule in code ("cron 스케줄 추가해줘", "스케줄러에 작업 등록해줘", "이 코드에 스케줄
  // 추가해줘") is not a calendar entry unless a calendar is named
  {
    kind: 'calendar',
    noun: /(캘린더|달력|calendar|일정|스케줄(?!러)|schedule)/iu,
    verb: koRequest(String.raw`(?:등록|추가|생성|입력|예약)${KO_PARTICLE}해|넣어|잡아`),
    blocker: /^(?![\s\S]*(?:캘린더|달력|calendar))[\s\S]*(?:cron|크론|스케줄러|scheduler|코드|code|함수|\bjobs?\b|배치|작업|태스크|\btasks?\b|워크플로|workflow|크롤)/iu,
  },
  // email
  {
    kind: 'email',
    noun: /(메일|이메일|e-?mail|gmail|지메일|아웃룩|outlook)/iu,
    verb: koRequest(String.raw`(?:발송|전송|답장|회신|포워드|포워딩|전달)${KO_PARTICLE}해|보내|부쳐`),
  },
  // booking
  {
    kind: 'booking',
    noun: /(예약|예매)/u,
    verb: koRequest(String.raw`(?:예약|예매)${KO_PARTICLE}(?:해|잡아|진행해|취소해|변경해|걸어)`),
  },
  // payment
  {
    kind: 'payment',
    noun: /(결제|송금|이체|입금|구매|구입|주문|계좌)/u,
    verb: koRequest(String.raw`(?:결제|송금|이체|입금|구매|구입|주문)${KO_PARTICLE}(?:해|진행해|넣어)|보내|부쳐`),
  },
  // phone / SMS
  // A code-side message ("에러 메시지", "커밋 메시지") is not a phone/SMS target.
  {
    kind: 'phone-sms',
    noun: /(전화|문자(?!열)|sms|(?<!(?:에러|오류|커밋|로그|경고|예외|알림|error|commit|log)\s*)(?:메시지|메세지)|카톡|카카오톡|통화)/iu,
    verb: koRequest(String.raw`(?:전화|문자|통화|카톡)${KO_PARTICLE}해|걸어|보내|돌려`),
  },
  // "남겨줘" is a phone/SMS action only for a voice/text message, never "에러 메시지 남겨줘" (log it).
  {
    kind: 'phone-sms',
    noun: /(문자(?!열)|sms|카톡|음성\s*(?:메시지|메세지|사서함)|보이스\s*메일|voicemail|부재중)/iu,
    verb: koRequest('남겨'),
  },
  // posting to an external service
  {
    kind: 'posting',
    noun: /(트위터|트윗|페이스북|인스타(?:그램)?|링크드인|블로그|슬랙|slack|sns|게시판|커뮤니티|카페|스레드|레딧|reddit|유튜브|youtube|twitter|facebook|instagram|linkedin)/iu,
    verb: koRequest(String.raw`올려|(?:게시|포스팅|업로드|공유|등록|트윗)${KO_PARTICLE}해`),
  },
  // Transmit to a work recipient without naming a mail noun ("팀에 회의록 보내줘", "팀장님께 전달해줘"): an email send.
  // Listed last so a phone/payment/posting noun in the same message wins.
  {
    kind: 'email',
    noun: /(?:팀원들?|우리\s*팀|팀|[가-힣]{0,4}(?:부장|팀장|과장|차장|대리|이사|사장|대표|교수|선생|실장|본부장|담당자|매니저|고객|거래처)(?:님|들)?)\s*(?:께서?|에게|한테|에게는|에)(?![가-힣])/u,
    verb: koRequest(String.raw`(?:전송|전달|포워드|포워딩|공유)${KO_PARTICLE}해|보내`),
  },
];

const EN_EXTERNAL_ACTIONS: readonly { readonly kind: ExternalActionKind; readonly pattern: RegExp }[] = [
  { kind: 'calendar', pattern: enRequest(String.raw`(?:add|put|schedule|create|set\s+up|book)${EN_SENTENCE_REST}(?:calendars?|meetings?|appointments?)\b`) },
  // "Send me an email template", "Can you send the email here?" ask for text in the chat, not a send. A draft is
  // text Quoky writes or shows ("write a draft email"), unless it is TRANSMITTED to a recipient ("send this draft
  // email to Alice").
  { kind: 'email', pattern: enRequest(
    String.raw`(?:send|forward|reply\s+to|write\s+and\s+send)(?![^.!?\n]*\b(?:templates?|examples?|samples?|outlines?|formats?|wording|subject\s+lines?|here)\b)(?![^.!?\n]*\bdrafts?\b(?![^.!?\n]*\b(?:to|for)\s+(?!me\b|us\b|here\b)[\p{L}\p{N}]))${EN_SENTENCE_REST}(?:e-?mails?|mails?|inbox)\b`,
  ) },
  { kind: 'email', pattern: enRequest(String.raw`(?:e-?mail)\s+(?!address)(?:my|him|her|them|the|this|[a-z]+\s+(?:about|that|the|a))\b`) },
  // Bare verb with a named recipient or an address ("Can you email Alice?", "email bob@example.com").
  { kind: 'email', pattern: enRequest(
    String.raw`(?:e-?mail|mail)\s+(?:[\w.+-]+@[\w-]+\.[\w.-]+|(?!(?:address(?:es)?|templates?|drafts?|subject|body|format|etiquette|marketing|newsletters?|signatures?|clients?|apps?|providers?|tips?|examples?|samples?|here|it|is|was|and|or|me|us|you|from|in|on|at|of|for|with|without)\b)\p{L}+(?:\s+\p{L}+)?\s*(?:[?.!,]|$|\s+(?:about|that|regarding|and|tomorrow|today|now|asap|please|the|a|an|my)\b))`,
  ) },
  { kind: 'booking', pattern: enRequest(String.raw`(?:book|reserve)${EN_SENTENCE_REST}(?:tables?|flights?|hotels?|rooms?|tickets?|seats?|restaurants?|appointments?|reservations?|trains?|taxis?|cabs?)\b`) },
  { kind: 'booking', pattern: enRequest(String.raw`make\s+(?:a|the|my)\s+(?:reservation|booking)\b`) },
  // "pay attention to the rent calculation bug" is not a payment.
  { kind: 'payment', pattern: enRequest(String.raw`(?:pay(?!\s+(?:close\s+|more\s+|special\s+|careful\s+|extra\s+)?attention\b)|transfer|wire)${EN_SENTENCE_REST}(?:bills?|invoices?|money|payments?|rent|dollars?|won)\b`) },
  // "buy some time" / "buy into" are idioms and "buy or rent" is a comparison, not purchases.
  { kind: 'payment', pattern: enRequest(
    String.raw`(?:buy|purchase)\b(?!\s+(?:or|vs\.?|versus)\b)(?!\s+(?:(?:me|us|you|myself|yourself)\s+)?(?:some\s+|more\s+|a\s+(?:little|bit)\s+(?:of\s+)?(?:more\s+)?)?time\b)(?!\s+into\b)|place\s+(?:an?|the|my)\s+order\b`,
  ) },
  // "call back function" is a callback, not a phone call.
  { kind: 'phone-sms', pattern: enRequest(
    String.raw`(?:call|phone|ring|text)\s+(?:my\s+\w+|mom|mum|dad|him|her|them|back(?![\s-]*(?:functions?|handlers?|urls?|hell|patterns?)\b))\b`,
  ) },
  { kind: 'phone-sms', pattern: enRequest(String.raw`(?:send|leave)\s+(?:an?\s+|the\s+)?(?:text|sms|text\s+message|voicemail)\b|(?:make|place)\s+an?\s+(?:phone\s+)?call\b`) },
  // "Share your thoughts on LinkedIn posts" asks for an opinion about the service, not a post to it.
  { kind: 'posting', pattern: enRequest(
    String.raw`(?:post|tweet|publish|share(?!\s+(?:your|my|some)\s+(?:thoughts|opinions?|views|tips|advice|ideas|experience)\b)|upload)${EN_SENTENCE_REST}(?:twitter|x\.com|facebook|instagram|linkedin|blog|slack|reddit|threads|youtube|social\s+media)\b(?!\s+(?:posts?|marketing|strateg(?:y|ies)|tips|content|best\s+practices|api|integration)\b)`,
  ) },
  { kind: 'posting', pattern: enRequest(String.raw`tweet\s+(?:this|that|it|about)\b`) },
];

/**
 * Override-shaped input (ADR-0098 amendment D1 b): "ignore all previous instructions", "이전 지시는 무시하고". The
 * `noun` group tells instruction nouns (instructions, prompts, 지시, 지침, 프롬프트) from tool-rule nouns (rules, 규칙,
 * 명령), see `isOverrideInjection`.
 */
const OVERRIDE_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:(?:of\s+)?(?:the|your|my|these|those)\s+)?(?:previous|prior|above|earlier|preceding|original|system|initial|all|your)\b[^.!?\n]{0,20}?\b(?<noun>instructions?|prompts?|rules?|directions?|guidelines?|guardrails?)\b/giu,
  /(?:이전|앞의|앞선|위의|위\s*에|기존|모든|지금까지의?|시스템|원래)\s*(?:의\s*)?(?<noun>지시|지침|명령|규칙|프롬프트|instructions?)\S*\s*(?:은|는|을|를|들을|들은)?\s*(?:모두\s*|다\s*|전부\s*|싹\s*)?(?:무시|잊어|잊고|따르지\s*마|어기|무효)/giu,
];
/** Nouns that are as often a tool's rules or commands ("eslint rules", "git 명령") as the assistant's instructions. */
const OVERRIDE_TOOL_RULE_NOUN = /^(?:rules?|규칙|명령)$/iu;
/** A qualifier that points the tool-rule noun at the assistant's own conversation ("your rules", "지금까지의 규칙"). */
const OVERRIDE_ASSISTANT_REF =
  /\b(?:your|previous|prior|above|earlier|preceding|system|initial)\b|quoky|쿼키|너의|당신의|이전|앞의|앞선|위의|위\s*에|지금까지|시스템|원래/iu;
/** A developer tool named in or just before the match ("eslint에서 모든 규칙", "git에서 이전 명령", "ignore all eslint rules"). */
const OVERRIDE_TOOL =
  /\b(?:eslint|tslint|prettier|stylelint|biome|tsconfig|tsc|git|gitignore|lint|linter|webpack|babel|jest|vitest|css|nginx|firewall|iptables)\b|린트|린터|컴파일러/iu;
/** A how-to question about the override ("How do I ignore …", "무시하는 방법", "무시하려면?"). */
const OVERRIDE_HOW_TO = /\bhow\s+(?:do|can|could|would|should)\s+(?:i|we|you)\b|\bhow\s+to\b|방법|하는\s*법|하려면|어떻게/iu;
/** Instructions scoped to a document the User shares ("disregard previous instructions in this ticket"). */
const OVERRIDE_DOCUMENT_SCOPE =
  /^\s+(?:in|from|of|within|on)\s+(?:this|the|that)\s+(?:ticket|issue|file|doc(?:ument)?|pr|pull\s+request|thread|e-?mail|message|spec|readme|page|section|comment|task)s?\b/iu;

/**
 * True when the text asks the assistant to drop its own instructions. Not injection: instructions scoped to a shared
 * document, an override next to a developer tool, and a tool-rule noun (rules/규칙/명령) that does not point at the
 * assistant or is asked as a how-to ("How do I ignore all eslint rules for one file?", "tsconfig에서 기존 규칙
 * 무시하고 새로 설정하려면?").
 */
function isOverrideInjection(text: string): boolean {
  for (const pattern of OVERRIDE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (OVERRIDE_DOCUMENT_SCOPE.test(text.slice(end))) continue;
      if (OVERRIDE_TOOL.test(text.slice(Math.max(0, start - 20), end))) continue;
      if (
        OVERRIDE_TOOL_RULE_NOUN.test(match.groups?.noun ?? '') &&
        (!OVERRIDE_ASSISTANT_REF.test(match[0]) || OVERRIDE_HOW_TO.test(text))
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

/** Injection-shaped input (ADR-0098 amendment D1 b): reveal hidden instructions or jailbreak. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  // A strong reveal verb with any hidden-instruction noun ("leak hidden instructions").
  /\b(?:reveal|dump|leak|expose)\b[^.!?\n]{0,40}\b(?:system|initial|hidden|internal|developer|original)\s+(?:prompts?|instructions?|messages?|rules?)\b/iu,
  // A display verb aimed at the assistant's own instructions ("print your system prompt", "show me the system
  // prompt"), never "show me an example system prompt" or "tell me about system prompts".
  /\b(?:show|print|display|output|repeat|share|copy|paste|tell\s+me(?!\s+about)|give\s+me(?!\s+(?:an?\s+)?examples?))\b[^.!?\n]{0,40}?\b(?:your|the|its|quoky's)\s+(?:(?:full|entire|exact|whole|complete|current|original|secret)\s+)?(?:system|initial|hidden|internal|developer|original)\s+(?:prompts?|instructions?|messages?|rules?)\b/iu,
  // A what-is question only when it asks for the assistant's own instructions ("What is your system prompt?"), never
  // the concept ("What is a system prompt in LLMs?").
  /\bwhat(?:'s|\s+is|\s+are|\s+were)\b[^.!?\n]{0,30}?\b(?:your|quoky's)\s+(?:(?:full|entire|exact|current|original|secret)\s+)?(?:system|initial|hidden|internal|developer|original)\s+(?:prompts?|instructions?|messages?|rules?)\b|\bwhat(?:'s|\s+is|\s+are|\s+were)\b[^.!?\n]{0,30}?\b(?:system|initial|hidden|internal|developer|original)\s+(?:prompts?|instructions?|messages?|rules?)\s+(?:that\s+)?you\s+(?:were|are|have\s+been|got|use|follow)\b/iu,
  /\b(?:jailbreak|jailbroken|developer\s+mode|do\s+anything\s+now)\b/iu,
  // The assistant's own instructions ("너의 시스템 프롬프트 보여줘", "Quoky의 지침이 뭐야?").
  /(?:너의|너\s+의|당신의|당신|quoky\s*의|쿼키\s*의|(?:^|\s)(?:네|니)\s)\s*(?:(?:시스템|내부|숨겨진|숨은|초기|개발자|원본)\s*(?:의\s*)?)?(?:프롬프트|지시(?:문|사항)?|지침|명령문)\S*\s*[^.!?\n]{0,15}(?:출력|보여|알려|공개|말해|읽어|복사|노출|뭐야|뭔지|뭐니|뭐예요|뭔가요|그대로)/iu,
  // A reveal request for hidden instructions; a concept question ("시스템 프롬프트란 뭐야?", "시스템 프롬프트가 뭔지
  // 알려줘", "시스템 프롬프트 작성법 알려줘") is not one.
  /(?:시스템|내부|숨겨진|숨은|초기|개발자|원본)\s*(?:의\s*)?(?:프롬프트|지시(?:문|사항)?|지침|명령문)(?![가-힣]{0,2}\s*(?:란|이란|에\s*(?:대해|대한|관해|관한)|가\s*뭐|이\s*뭐|는\s*뭐|은\s*뭐|가\s*뭔|이\s*뭔|가\s*무엇|이\s*무엇|의\s*(?:역할|개념|의미|정의|예)|(?:를|을)?\s*(?:작성|엔지니어링|설계|잘\s*쓰|쓰는|만드는|짜는)|작성|엔지니어링|설계|예시|예제|샘플|템플릿|개념|역할))\S*\s*[^.!?\n]{0,15}(?:출력|보여|알려|공개|말해|읽어|복사|노출|그대로)/iu,
  /(?:탈옥|제한\s*(?:을|를)?\s*(?:모두\s*)?(?:풀어|해제))/u,
];


/**
 * Function words of common Latin-script languages other than English (Spanish, French, German, Portuguese, Italian,
 * Dutch). Words that are also ordinary English words ("die", "son", "pour", "come") are left out.
 */
const OTHER_LATIN_FUNCTION_WORDS = new Set([
  // es
  'el', 'los', 'las', 'qué', 'que', 'cómo', 'como', 'está', 'estás', 'estoy', 'eres', 'por', 'para', 'hola',
  'gracias', 'dónde', 'donde', 'cuál', 'cuándo', 'muy', 'pero', 'también', 'puedes', 'necesito', 'quiero', 'mi', 'tu',
  'una', 'del', 'es', 'y', 'hoy',
  // fr
  'le', 'les', 'est', 'bonjour', 'merci', 'comment', 'pourquoi', 'je', 'vous', 'nous', 'avec', 'ça', 'une', 'des',
  'suis', 'êtes', 'ce', 'cette', 'mais', 'aujourd', 'oui', 'très', 'il', 'elle', 'et', 'qui', 'quoi',
  // de
  'ich', 'du', 'wie', 'ist', 'nicht', 'und', 'der', 'das', 'bitte', 'danke', 'guten', 'geht', 'dir', 'mit', 'ein',
  'eine', 'heute', 'warum', 'kannst', 'bist', 'sind', 'mir', 'mich', 'wo', 'ja', 'nein', 'auf',
  // pt / it / nl
  'você', 'obrigado', 'obrigada', 'olá', 'não', 'ciao', 'grazie', 'sono', 'sei', 'perché', 'buongiorno',
  'hallo', 'dank', 'jij', 'niet', 'het', 'een', 'wat', 'hoe',
]);
const ENGLISH_FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'in', 'on', 'for', 'with', 'you', 'i', 'it',
  'this', 'that', 'what', 'how', 'why', 'can', 'do', 'does', 'my', 'your', 'me', 'please', 'hello', 'hi', 'thanks',
]);

/**
 * A Latin-script message in a language other than English. Conservative: an inverted "¿"/"¡", or at least two words
 * that are non-English function words or carry a non-English diacritic (at least one a function word, since accented
 * names and loanwords are common in English), making up at least 40% of the words and outnumbering English function
 * words. "Comment out this line" and "Find a café near Zürich" stay English.
 */
function isOtherLatinLanguage(prose: string): boolean {
  if (/[¿¡]/u.test(prose)) return true;
  const words = prose.toLowerCase().match(/\p{Script=Latin}+(?:['’]\p{Script=Latin}+)?/gu) ?? [];
  if (words.length === 0) return false;
  let functionWords = 0;
  let accented = 0;
  let english = 0;
  for (const word of words) {
    const bare = word.replace(/['’].*$/u, '');
    if (ENGLISH_FUNCTION_WORDS.has(bare)) english += 1;
    else if (OTHER_LATIN_FUNCTION_WORDS.has(bare)) functionWords += 1;
    else if (/[à-öø-ÿœß]/u.test(word)) accented += 1;
  }
  const foreign = functionWords + accented;
  return functionWords >= 1 && foreign >= 2 && foreign / words.length >= 0.4 && foreign > english;
}

const NON_PROSE = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/giu;

/**
 * A message in a language other than Korean or English (ADR-0098 amendment D1 c). Reuses the chat-policy
 * `detectReplyLanguage`: an `unknown` message whose prose has a substantial share (>= 20%) of letters from a script
 * other than Hangul and Latin counts, so code-only, emoji-only and Korean/English mixes stay ordinary chat.
 * `detectReplyLanguage` reads every Latin-script message as `en`, so a Latin-script message also counts when it
 * carries a clear non-English signal (`isOtherLatinLanguage`). Known gap: a short or function-word-free message in
 * another Latin-script language (e.g. a single noun) still reads as English.
 */
function isOtherLanguage(text: string): boolean {
  const language = detectReplyLanguage(text);
  const prose = text.replace(NON_PROSE, ' ');
  if (language === 'en') return isOtherLatinLanguage(prose);
  if (language !== 'unknown') return false;
  const letters = prose.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return false;
  const hangul = prose.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  const latin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return (letters - hangul - latin) / letters >= 0.2;
}

/** Text inside "…", “…”, 「…」, 『…』, `…` and word-bounded '…' is a quoted example, not a request to Quoky. */
const QUOTED_SPAN =
  /"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|`[^`\n]*`|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])‘[^’\n]+’(?![\p{L}\p{N}])/gu;

function stripQuotedExamples(text: string): string {
  return text.replace(QUOTED_SPAN, ' ');
}

/**
 * Informational framing: a translation, meaning or phrasing question about a sentence, not an action request.
 * "번역해서 보내줘" / "translate it and send" still act.
 */
const META_FRAMING =
  /번역(?!\s*(?:해서|하고|한\s*(?:뒤|후|다음|걸)))|\btranslat(?:e|ion)\b(?![^.!?\n]*\b(?:and|then)\s+(?:send|email|forward|mail)\b)|뜻이\s*(?:뭐|무엇|뭔)|의미가\s*(?:뭐|무엇|뭔)|\bwhat\s+(?:does|do|did)\b[^.!?\n]*\bmeans?\b|\bhow\s+(?:do|can|would|should)\s+(?:i|you|we)\s+say\b|어떻게\s*(?:말|표현)|예문/iu;

function isMetaFraming(text: string): boolean {
  return META_FRAMING.test(text);
}

const RETRACTED_QUESTION = /[^.!?\n]*[?？]\s*(?:no|nope|nah|never\s*mind|아니(?:요|야)?|아냐)(?![\p{L}])/giu;

/**
 * Deterministic policy-sensitivity check for an otherwise GENERAL_CHAT message (ADR-0098 amendment D1). No LLM. A
 * question about an action ("메일 쓰는 법 알려줘", "how do I send an email?") is not a request for it.
 */
export function detectPolicySensitiveChat(text: string): PolicySensitiveChatReason | undefined {
  if (isOverrideInjection(text) || INJECTION_PATTERNS.some((pattern) => pattern.test(text))) return 'injection';
  if (detectExternalActionRequest(text) !== undefined) return 'external-action';
  if (isOtherLanguage(text)) return 'unsupported-language';
  if (isPersonalDataQuestion(text)) return 'personal-data';
  return undefined;
}

// ---- personal-data questions (QA-V2-005) ----
// The local model fabricated "내일 9시에는 일정이나 예약이 없어요" for a question about the owner's own schedule. Quoky has no
// calendar, mailbox, bank or messenger access, so such a question is routed like the other policy-sensitive turns and
// answered (truthfully: "I cannot see that") by a provider that meets the chat-policy bar. Deterministic, no LLM.

const KO_DAY = String.raw`(?:오늘|내일|모레|글피|이번\s*주|다음\s*주|담주|주말|(?:월|화|수|목|금|토|일)요일|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*[/.]\s*\d{1,2})`;
const KO_DAYPART = String.raw`(?:오전|오후|아침|저녁|밤|낮)`;
const KO_TIME_PARTICLE = String.raw`(?:에는|에|엔|은|는)?`;
/** A day / weekday / clock time, optionally with a part of day ("내일 오후 3시에", "9시에"). "저녁" alone is a meal. */
const KO_TIME = String.raw`(?:${KO_DAYPART}\s*)?${KO_DAY}(?:\s*${KO_TIME_PARTICLE}\s*(?:${KO_DAYPART}\s*)?${KO_DAY}|\s*${KO_TIME_PARTICLE}\s*${KO_DAYPART})*`;
const KO_POSSESSIVE = String.raw`(?<![가-힣])(?:내|제|나의|저의|우리|우리의)\s+`;
/** An optional short qualifier between the context and the noun ("점심 약속", "팀 회의"). */
const KO_MODIFIER = String.raw`(?:[가-힣]{1,4}\s+)?`;
const KO_PARTICLE_GAP = String.raw`(?:이|가|은|는|을|를|좀|도|에는|에서|에|엔)?\s*(?:좀\s*)?`;
const KO_ASK = String.raw`(?:뭐|뭔|무엇|무슨|어때|어떻|어떤|있|없|잡혀|알려|보여|확인|말해|읽어|체크|조회|브리핑|요약|몇)`;
const KO_AGENDA_NOUN = String.raw`(?:일정|스케줄(?!러)|약속|캘린더|달력|미팅|회의(?!록|실)|예약(?:\s*(?:내역|현황|목록))?)`;
const KO_MAIL_NOUN = String.raw`(?:이?메일(?!함)|e-?mail)`;
const KO_CHAT_NOUN = String.raw`(?:카톡|카카오톡|문자(?!열)|(?<!(?:에러|오류|커밋|로그|경고|예외|알림|error|commit|log)\s*)(?:메시지|메세지)|디엠|dm)`;
const KO_OWNER_CONTEXT = String.raw`(?:${KO_POSSESSIVE}|${KO_TIME}\s*${KO_TIME_PARTICLE}\s*)`;

const EN_DAY = String.raw`(?:today|tomorrow|tonight|tmrw|this\s+(?:morning|afternoon|evening|week|weekend)|next\s+(?:week|month|(?:mon|tues|wednes|thurs|fri|satur|sun)day)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)`;
const EN_ASK = String.raw`\b(?:what|show|tell|check|list|read|summari[sz]e|any|do\s+i|did\s+i|have\s+i|how\s+much|is\s+there|are\s+there|look\s+up|pull\s+up|open|see|got)\b`;
const EN_OWNED_NOUN = String.raw`\b(?:my|our)\s+(?:(?:google|outlook|work|personal|bank|account|new|unread)\s+)*(?:calendar|schedule|agenda|appointments?|meetings?(?!\s+notes?)|inbox|e-?mails?|text(?:\s+messages?)?s?|dms?|messages|balance|transactions?|statements?|reservations?|bookings?|payments?)\b`;

const ANY_CLAUSE = /(?:)/u;

/**
 * Questions about the owner's own data Quoky cannot see. `noun` and `verb` must co-occur in one un-negated clause. The
 * Korean rules are single adjacency patterns (the noun directly followed by an ask), so "일정 관리 팁" never matches.
 */
const PERSONAL_DATA_RULES: readonly { readonly noun: RegExp; readonly verb: RegExp }[] = [
  // "내일 9시에 뭐 있어?", "오늘 뭐 있어" — a day/time directly followed by "뭐 있", not "점심 뭐 있어"
  {
    noun: new RegExp(
      String.raw`${KO_TIME}\s*${KO_TIME_PARTICLE}\s*(?:(?:내가|제가|나|저|우리)\s*)?(?:또\s*)?(?:뭐|무슨\s*(?:일|약속|일정))\s*(?:가|이)?\s*(?:있|잡혀)`,
      'u',
    ),
    verb: ANY_CLAUSE,
  },
  // "내 일정 알려줘", "오늘 일정 어때", "다음 주 팀 회의 있어?", "내일 예약 있어?"
  { noun: new RegExp(`${KO_OWNER_CONTEXT}${KO_MODIFIER}${KO_AGENDA_NOUN}${KO_PARTICLE_GAP}${KO_ASK}`, 'u'), verb: ANY_CLAUSE },
  { noun: new RegExp(String.raw`예약\s*(?:내역|현황|목록)${KO_PARTICLE_GAP}${KO_ASK}`, 'u'), verb: ANY_CLAUSE },
  // mailbox / inbox; "내 메일 확인해줘", "새 메일 왔어?", "안 읽은 메일 있어?"
  {
    noun: new RegExp(
      String.raw`(?:메일함|받은\s*편지함|inbox|지메일|gmail)${KO_PARTICLE_GAP}${KO_ASK}|(?:${KO_POSSESSIVE}|새\s*|안\s*읽은\s*|읽지\s*않은\s*|받은\s*)${KO_MODIFIER}${KO_MAIL_NOUN}${KO_PARTICLE_GAP}(?:${KO_ASK}|왔|와\s*있|온)`,
      'iu',
    ),
    verb: ANY_CLAUSE,
  },
  // bank / card: 잔액, 결제·거래·지출 내역, "통장에 얼마 있어"
  {
    noun: new RegExp(
      String.raw`(?:잔액|잔고|결제\s*내역|거래\s*내역|입출금\s*내역|지출\s*내역|카드\s*(?:내역|명세서|사용\s*내역|청구)|계좌\s*내역|통장)${KO_PARTICLE_GAP}(?:${KO_ASK}|얼마|남았|남아)`,
      'u',
    ),
    verb: ANY_CLAUSE,
  },
  // messages: "카톡 왔어?", "문자 온 거 있어?", "내 메시지 확인해줘", "부재중 전화 있어?"
  {
    noun: new RegExp(
      String.raw`${KO_CHAT_NOUN}${KO_PARTICLE_GAP}(?:왔|와\s*있|안\s*왔|온\s*(?:거|게|것|건))|(?:${KO_POSSESSIVE}|새\s*|안\s*읽은\s*|읽지\s*않은\s*|받은\s*)${KO_MODIFIER}${KO_CHAT_NOUN}${KO_PARTICLE_GAP}${KO_ASK}|부재중\s*전화`,
      'iu',
    ),
    verb: ANY_CLAUSE,
  },
  // English: "what's on my calendar", "what's on tomorrow", "what do I have planned today", "am I free tomorrow"
  {
    noun: new RegExp(
      String.raw`\bwhat(?:'s|’s|\s+is)\s+(?:on|in)\s+my\s+(?:calendar|schedule|agenda|plate|diary|inbox)\b|\bwhat(?:'s|’s|\s+is)\s+on\s+(?:for\s+)?${EN_DAY}\b|\bwhat\s+do\s+i\s+have\s+(?:on|planned|scheduled|going\s+on|coming\s+up|for\s+${EN_DAY}|${EN_DAY})\b|\bwhat\s+am\s+i\s+(?:doing|up\s+to)\s+${EN_DAY}\b|\bwhat\s+are\s+my\s+(?:plans|meetings|appointments|events)\b|\bam\s+i\s+(?:free|busy|available)\s+${EN_DAY}\b`,
      'iu',
    ),
    verb: ANY_CLAUSE,
  },
  // "do I have meetings tomorrow", "do I have any dentist appointments"
  {
    noun: /\bdo\s+i\s+have\s+(?:(?:any|a|an|some)\s+)?(?:\w+\s+)?(?:meetings?|appointments?|events?|calls?|plans|reservations?|bookings?|deadlines?)\b/iu,
    verb: ANY_CLAUSE,
  },
  // "any new emails?", "did I get any unread messages"
  {
    noun: /\b(?:any|(?:do|did)\s+i\s+(?:have|get|receive)(?:\s+any)?|have\s+i\s+(?:got|received)(?:\s+any)?)\s+(?:new|unread|important)\s+(?:e-?mails?|messages?|texts?|dms?)\b/iu,
    verb: ANY_CLAUSE,
  },
  // "check my email", "what is my bank balance"; "how much money do I have"
  { noun: new RegExp(EN_OWNED_NOUN, 'iu'), verb: new RegExp(EN_ASK, 'iu') },
  { noun: /\bhow\s+much\s+(?:money\s+)?do\s+i\s+have\b/iu, verb: ANY_CLAUSE },
];

/**
 * Not a question about the owner's data: how-to / advice / template framing and code or product work ("결제 내역 조회
 * API 만들어줘", "my calendar app").
 */
const PERSONAL_DATA_BLOCKER =
  /방법|하는\s*법|쓰는\s*법|추천|팁|예시|예문|예제|템플릿|코드|함수|컴포넌트|엔드포인트|스키마|테이블|쿼리|구현|개발(?:해|하)|만들어|짜\s*줘|작성|설계|앱(?![가-힣])|\bhow\s+(?:do|to|can|should|would)\b|\b(?:tips?|recommend\w*|templates?|examples?|typos?|grammar|proofread|draft|api|code|component|function|endpoint|schema|database|table|class|module|script|implement|build|write|design|app|bot)\b/iu;

function isPersonalDataQuestion(text: string): boolean {
  const requests = stripQuotedExamples(text.replace(RETRACTED_QUESTION, ' '));
  return requests
    .split(CLAUSE_BOUNDARY)
    .filter((clause) => !isMetaFraming(clause) && !PERSONAL_DATA_BLOCKER.test(clause))
    .some((clause) => PERSONAL_DATA_RULES.some(({ noun, verb }) => hasCoLocatedUnnegated(clause, noun, verb)));
}

/**
 * The unsupported external action the message asks Quoky itself to perform (ADR-0098 amendment D1 a), or
 * `undefined`. Deterministic, no LLM. A question about an action ("메일 쓰는 법 알려줘", "how do I send an email?"), a
 * negated request and a request taken back in the same message are not requests.
 */
export function detectExternalActionRequest(text: string): ExternalActionRequest | undefined {
  // A request the User takes back in the same message ("Post the code to slack? no, just explain") is not one.
  const requests = stripQuotedExamples(text.replace(RETRACTED_QUESTION, ' '));
  // Meta framing suppresses only its own clause: "Pay the rent. Translate the receipt." still asks for the payment.
  const clauses = isMetaFraming(requests) ? requests.split(CLAUSE_BOUNDARY).filter((c) => !isMetaFraming(c)) : [requests];
  for (const clause of clauses) {
    const kind = externalActionKindOf(clause);
    if (kind !== undefined) return { kind };
  }
  return undefined;
}

/** Sentence punctuation (followed by space or the end), newlines and "and then" / "그리고" connectives. */
const CLAUSE_BOUNDARY = /[.!?。！？;；](?=\s|$)|[;；]|\n|\s+and\s+then\s+|\s+그리고(?:\s*나서)?\s+/iu;

function externalActionKindOf(requests: string): ExternalActionKind | undefined {
  const ko = KO_EXTERNAL_ACTIONS.find(({ noun, verb, blocker }) => hasCoLocatedUnnegated(requests, noun, verb, blocker));
  if (ko !== undefined) return ko.kind;
  return EN_EXTERNAL_ACTIONS.find(({ pattern }) => unnegatedMatch(requests, [pattern]))?.kind;
}

/**
 * The external-action decision Core recorded on a chat intent at classification time (`Intent.raw`), or `undefined`.
 * ConversationRuntime carries it to the adapter as `GeneralChatReplyPolicy.externalActionRequested`, so the
 * action-claim guard runs only for turns whose User message asked for an unsupported external action.
 */
export function externalActionRequestOf(intent: Intent): ExternalActionRequest | undefined {
  const raw = intent.raw;
  if (raw?.kind !== POLICY_SENSITIVE_CHAT_KIND) return undefined;
  const kind: unknown = raw.externalAction;
  return isExternalActionKind(kind) ? { kind } : undefined;
}

/** "분리해서 설명해줘" explains by splitting; the change is a means of the explanation, not the request. */
const KO_NOT_EXPLAIN = String.raw`(?!\s*(?:설명|알려|보여|말해|요약|이해))`;
/** "고치고 싶은 부분" is a wish, not a request. */
const KO_NOT_WISH = String.raw`(?!\s*싶)`;

/**
 * A path-scoped code-change verb (ADR-0098 amendment D3): with a real file path in the message, "src/a.ts를 고치고
 * src/new-helper.ts로 헬퍼를 분리해줘" is a code change even without the words "코드"/"파일". Korean verbs are
 * request/connective forms only (a request ending such as 줘/주세요, or a connective 고/서), so a descriptive
 * "추가된"/"분리된" or a necessity question "고쳐야 해?" does not count; English verbs must sit in request position, so
 * "how would you fix src/a.ts?" or "what does split do in src/a.ts?" stays chat.
 */
const KO_CHANGE_TAIL = String.raw`(?:\s*(?:줘|주세요|주십시오|주실래요?|주시겠어요|주시겠습니까|줄래요?|줄\s*수\s*있|봐\s*줘|봐\s*주세요|놔\s*줘|둬\s*줘)|서${KO_NOT_EXPLAIN}|라(?![가-힣]))`;
const PATH_CHANGE_VERB_KO = new RegExp(
  String.raw`(?:고쳐|바꿔|옮겨|쪼개|빼|(?:수정|분리|추가|변경|삭제|이동|교체|fix|update|change|modify|add|remove|delete|move|rename|refactor|extract|split)\s*해)${KO_CHANGE_TAIL}|고치(?:고${KO_NOT_WISH}|자)|바꾸고${KO_NOT_WISH}|(?:를|을)\s*빼고(?!\s*(?:나머지|말고|전부|다른))|(?:수정|분리|추가|변경|삭제|이동|교체)\s*(?:하고${KO_NOT_WISH}|하자|하여)`,
  'iu',
);
const PATH_CHANGE_VERB_EN = enRequest(
  String.raw`(?:fix|modify|refactor|extract|split|rename|add|update|change|move|remove|delete)\b`,
);

/**
 * Classifies a natural-language message into an Intent. v1 is MINIMAL and
 * deterministic:
 *   - "register this project: <path>" → REGISTER_PROJECT (ADR-0018)
 *   - "analyze/explain this project/repo/structure" → PROJECT_ANALYSIS (ADR-0019)
 *   - everything else → general chat (becomes a Task).
 * AI-driven classification arrives later; the `router` is held for it.
 */
export class IntentClassifier {
  constructor(private readonly router: CapabilityRouter) {}

  async classify(message: InboundMessage, ctx?: IntentClassifyContext): Promise<Intent> {
    const intent = this.classifyText(message);
    if (ctx?.hasActiveProject === false && IntentClassifier.isBareProjectKeywordMatch(message.text.trim(), intent)) {
      return IntentClassifier.chatIntent(message.text.trim());
    }
    return intent;
  }

  /**
   * With no active project, a code/test/analysis keyword alone ("이 문장 분석해줘", "7/3 회의 등록해줘") is
   * everyday chat. A project noun, a file path, or an explicit /preview keeps the project routing.
   */
  private static isBareProjectKeywordMatch(text: string, intent: Intent): boolean {
    if (
      intent.type !== IntentType.IMPLEMENT_CODE &&
      intent.type !== IntentType.RUN_TESTS &&
      intent.type !== IntentType.PROJECT_ANALYSIS
    ) {
      return false;
    }
    if (/^\/preview\b/i.test(text)) return false;
    if (/(프로젝트|저장소|레포|\bprojects?\b|\brepos?\b|\brepositor(?:y|ies)\b|\bcodebases?\b)/i.test(text)) return false;
    return !IntentClassifier.hasFilePathSignal(text);
  }

  /**
   * True when the prose (outside code fences / inline code) names a real file path: a token with a known file
   * extension that is not a call (`response.json()`), or a multi-segment path. Bare `A/B`, `UI/UX`, `total/count`
   * and a lone relative import (`'./utils'`) are not paths.
   */
  private static hasFilePathSignal(text: string): boolean {
    const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`]*`/g, ' ');
    const ext = /[\w@-]\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|yml|yaml|toml|sh|css|html)$/i;
    for (const match of prose.matchAll(/[\w@.~/-]+/g)) {
      const token = match[0].replace(/\.+$/, '');
      const next = prose.charAt((match.index ?? 0) + match[0].length);
      if (next === '(') continue;
      if (ext.test(token)) return true;
      const segments = token.split('/').filter((seg) => seg && seg !== '.' && seg !== '..');
      const prefixed = /^(?:\.{1,2}\/|~\/|\/)/.test(token);
      if (segments.length >= 2 && (prefixed || segments.length >= 3)) return true;
    }
    return false;
  }

  private classifyText(message: InboundMessage): Intent {
    void this.router;
    const text = message.text.trim();

    if (IntentClassifier.isPersonalWorkSurface(text)) {
      return {
        type: IntentType.LOOKUP,
        capability: Capability.READONLY_LOOKUP,
        confidence: 1,
        requiresWork: false,
        summary: text.slice(0, 200) || 'Show my personal work',
        raw: { kind: 'personal-work-surface' },
      };
    }

    // Explicit preview command (Sprint 4c-Follow-up, ADR-0062 draft) — an unambiguous entry into the code-change
    // preview pipeline (IMPLEMENT_CODE → planningOnly → HIGH-risk plan approval → CodeGeneration preview),
    // independent of NL phrasing. It never applies/commits/pushes — it stops at the read-only diff preview.
    if (/^\/preview\b/i.test(text)) {
      const rest = text.replace(/^\/preview\b\s*/i, '').trim();
      return {
        type: IntentType.IMPLEMENT_CODE,
        capability: Capability.CODE_IMPLEMENTATION,
        confidence: 1,
        requiresWork: true,
        summary: (rest || 'Preview a code change').slice(0, 200),
        raw: { kind: 'preview' },
      };
    }

    const registration = detectProjectRegistration(text);
    if (registration?.absolute) {
      return {
        type: IntentType.REGISTER_PROJECT,
        capability: Capability.READONLY_LOOKUP,
        confidence: 1,
        requiresWork: false,
        summary: `Register project: ${registration.path}`,
        raw: { path: registration.path },
      };
    }
    if (registration) {
      // QA-015: an explicit project registration with a relative/home path ("이 프로젝트 등록해줘: ../../etc") is
      // still a registration request — the runtime answers with the absolute-path rule, never a code-change
      // clarification or chat. `raw.path` is deliberately absent so nothing can register it.
      return {
        type: IntentType.REGISTER_PROJECT,
        capability: Capability.READONLY_LOOKUP,
        confidence: 1,
        requiresWork: false,
        summary: 'Register project (non-absolute path)',
        raw: { kind: NON_ABSOLUTE_REGISTRATION_KIND },
      };
    }

    // Test-run request (CAP live execution, ADR-0033). The classifier judges the intent + a
    // normalized `raw.kind` ONLY — the concrete command is the IntentResolver's decision.
    const testKind = IntentClassifier.detectTestRun(text);
    if (testKind) {
      return {
        type: IntentType.RUN_TESTS,
        capability: Capability.TEST_EXECUTION,
        confidence: 1,
        requiresWork: true,
        summary: text.slice(0, 200) || 'Run tests',
        raw: { kind: testKind },
      };
    }

    // Code-change request (live planning, ADR-0035). The classifier judges intent + a normalized
    // `raw.kind` ONLY — no implementation instruction, target-file guess, patch hint, or command.
    const codeChangeKind = IntentClassifier.detectCodeChange(text);
    if (codeChangeKind) {
      return {
        type: IntentType.IMPLEMENT_CODE,
        capability: Capability.CODE_IMPLEMENTATION,
        confidence: 1,
        requiresWork: true,
        summary: text.slice(0, 200) || 'Change code',
        raw: { kind: codeChangeKind },
      };
    }

    if (IntentClassifier.isProjectAnalysis(text)) {
      return {
        type: IntentType.PROJECT_ANALYSIS,
        capability: Capability.PROJECT_ANALYSIS,
        confidence: 1,
        requiresWork: true,
        summary: text.slice(0, 200) || 'Analyze the active project',
      };
    }

    return IntentClassifier.chatIntent(text);
  }

  /**
   * Every chat intent goes through here. ADR-0098 amendment: a policy-sensitive message (unsupported external action,
   * injection-shaped, or a language other than Korean/English) keeps `IntentType.CHAT` but asks for the
   * `POLICY_SENSITIVE_CHAT` capability, so only providers that meet the chat-policy bar serve it.
   */
  private static chatIntent(text: string): Intent {
    const policySensitive = detectPolicySensitiveChat(text);
    // Recorded for every policy-sensitive reason, so an injection-shaped message that also asks for an external action
    // still gets the action-claim guard.
    const externalAction = policySensitive ? detectExternalActionRequest(text) : undefined;
    return {
      type: IntentType.CHAT,
      capability: policySensitive ? Capability.POLICY_SENSITIVE_CHAT : Capability.GENERAL_CHAT,
      confidence: 1,
      requiresWork: true,
      summary: text.slice(0, 200) || '(empty message)',
      ...(policySensitive
        ? {
            raw: {
              kind: POLICY_SENSITIVE_CHAT_KIND,
              reason: policySensitive,
              ...(externalAction ? { externalAction: externalAction.kind } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Detect a test-run request → its kind, or undefined. Deterministic, conservative (KO + EN). The
   * kind is a classification tag only; the resolver maps it to a fixed allow-listed command (ADR-0033).
   */
  private static detectTestRun(text: string): 'typecheck' | 'test' | undefined {
    // Negation-aware (Sprint 4c-Follow-up, ADR-0062 draft): a NEGATED test/typecheck phrase ("테스트 실행하지 마",
    // "pnpm test 실행하지 마", "do not run tests") must NOT be read as a RUN_TESTS request — otherwise a
    // preview-only request that prohibits tests would run `pnpm test` (the Gate 4B observation). Positive
    // signals are required in one un-negated clause; negation never creates a test-run intent (ADR-0033).
    // A validation noun is only a topic until the same un-negated clause carries request-shaped action
    // semantics. The shared detector also preserves exact allow-listed command strings such as `pnpm test`.
    // Fail closed before recognizing a kind. This protects the general RUN_TESTS path independently of the
    // WORKSPACE_APPLIED direct-validation path, including denied fragments placed before a valid request tail.
    if (isDeniedValidationRequest(text)) return undefined;
    const kinds = detectExplicitValidationKinds(text);
    if (kinds.typecheck) return 'typecheck';
    if (kinds.test) return 'test';
    return undefined;
  }

  /**
   * Detect a code-change request → its kind, or undefined. Deterministic, conservative (KO + EN).
   * Kind is a classification tag only — never an implementation instruction (ADR-0035).
   */
  private static detectCodeChange(text: string): 'fix' | 'change' | 'refactor' | 'preview' | undefined {
    // Preview-only requests (Sprint 4c-Follow-up, ADR-0062 draft) — a preview phrase needs NO change verb; it is
    // still a CODE_IMPLEMENTATION intent that reuses the planningOnly → plan-approval → CodeGeneration-preview
    // pipeline and stops at the read-only diff preview (ELIGIBLE). Checked first so a preview phrasing wins.
    // F7-B (Sprint 4c-Follow-up-7): broadened preview coverage so the Gate 5 phrasing
    // "패치 변경안을 미리보기로 보여줘" routes to CODE_IMPLEMENTATION (preview) instead of falling to
    // GENERAL_CHAT — (?:코드|파일|패치)\s*변경안 (was 파일 only) and an optional 로/를 between 미리보기 and 보여.
    const previewWords =
      /(변경\s*미리\s*보기|코드\s*변경\s*미리\s*보기|패치\s*미리\s*보기|diff\s*미리\s*보기|미리\s*보기만|미리\s*보기\s*(?:로|를)?\s*(?:생성|만들|보여)|코드\s*변경\s*초안|(?:코드|파일|패치)\s*변경안|patch\s+preview|diff\s+preview|preview\s+only|preview\s+the\s+change|(?:generate|show|make|create)\s+(?:me\s+)?(?:a\s+)?(?:code\s+|patch\s+|diff\s+)?preview)/i;
    if (previewWords.test(text)) return 'preview';
    if (/(리팩터|리팩토링|refactor)/i.test(text)) return 'refactor';
    const bugish = /(버그|bug|에러|오류|error)/i;
    const fixVerb = /(고쳐|고치|수정|fix)/i;
    if (bugish.test(text) && fixVerb.test(text)) return 'fix';
    // ADR-0098 amendment D3: a real file path plus an un-negated change verb is a code change.
    if (
      IntentClassifier.hasFilePathSignal(text) &&
      unnegatedMatch(text, [PATH_CHANGE_VERB_KO, PATH_CHANGE_VERB_EN])
    ) {
      return 'change';
    }
    // A necessity question ("src/a.ts 수정해야 할 부분이 있을까?", "왜 고쳐야 해?") asks about a change, not for one,
    // and a wish ("고치고 싶은 부분 있으면 알려줘") is not a request.
    const changeVerb =
      /(?:고쳐|고치(?!고\s*싶)|수정해|수정\s*해|바꿔|바꾸어|변경해|구현해)(?!야[^.!\n]*(?:\?|까\s*$|나요?\s*$|니\s*$))|fix|change|modify|implement/i;
    const codeish = /(코드|code|파일|file|부분|함수|function|버그|bug)/i;
    if (changeVerb.test(text) && codeish.test(text)) return 'change';
    // F6 (Sprint 4c-Follow-up-6): an explicit create-file request is a CODE_IMPLEMENTATION intent. Require a
    // create VERB and a file/code NOUN CO-LOCATED in the same, un-negated clause, so "파일을 만들어줘" routes to
    // code (→ A2 new-file preview) while a negated "파일 만들지 마" does not. Keeps the exact Scenario C request
    // on the code-change path even absent an explicit preview phrase. The create VERB is REQUEST-shaped (kept in
    // sync with ConversationRuntime.NEW_FILE_CREATE_VERB), so a descriptive/past form — "이 파일이 어떻게
    // 만들어졌는지 알려줘" ("how was this file made") — is NOT read as a create request (F6 QA).
    if (
      hasCoLocatedUnnegated(
        text,
        /(파일|file)/i,
        /(만들어\s*줘|만들어\s*주(?:세요|실래요|시겠어요)?|만들어\s*줄래|만들어라|만들자|생성\s*해(?:\s*줘|\s*주세요)?|\bcreate\b|\bmake\b)/i,
      )
    ) {
      return 'change';
    }
    return undefined;
  }

  /**
   * Heuristic detection of a project structure/analysis request. Matches an
   * analysis verb and a project/structure noun in either order (KO + EN), so both
   * "이 프로젝트 구조 설명해줘" and "explain the structure of this repo" classify.
   */
  private static isProjectAnalysis(text: string): boolean {
    const noun = /(구조|아키텍처|레포|프로젝트|패키지|repo|project|package|structure|architecture)/i;
    const verb = /(분석|설명|알려|analyz|explain|describe|overview)/i;
    return /(분석|analyz)/i.test(text) || (noun.test(text) && verb.test(text));
  }

  private static isPersonalWorkSurface(text: string): boolean {
    return /(?:내가|제가|나는)?\s*(?:해야\s*할|할)\s*(?:일|작업).*(?:보여|알려)|(?:show|list|what(?:'s| is))\b.*\b(?:my|i need to)\b.*\bwork\b/i.test(text);
  }
}

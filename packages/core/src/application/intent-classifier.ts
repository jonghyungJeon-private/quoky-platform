import { Capability, IntentType } from '../domain';
import type { InboundMessage, Intent } from '../domain';
import type { CapabilityRouter } from './capability-router';
import { detectReplyLanguage } from './chat-policy';
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

/** Why a chat turn is policy-sensitive (ADR-0098 amendment D1 a/b/c). */
export type PolicySensitiveChatReason = 'external-action' | 'injection' | 'unsupported-language';

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
 * 등록해줘" stays ordinary chat; the output guard still catches a fabricated "등록했어요").
 */
const KO_EXTERNAL_ACTIONS: readonly { readonly noun: RegExp; readonly verb: RegExp }[] = [
  // calendar / schedule
  {
    noun: /(캘린더|달력|calendar|일정|스케줄|schedule)/iu,
    verb: koRequest(String.raw`(?:등록|추가|생성|입력|예약)${KO_PARTICLE}해|넣어|잡아`),
  },
  // email
  {
    noun: /(메일|이메일|e-?mail|gmail|지메일|아웃룩|outlook)/iu,
    verb: koRequest(String.raw`(?:발송|전송|답장|회신|포워드|포워딩|전달)${KO_PARTICLE}해|보내|부쳐`),
  },
  // booking
  {
    noun: /(예약|예매)/u,
    verb: koRequest(String.raw`(?:예약|예매)${KO_PARTICLE}(?:해|잡아|진행해|취소해|변경해|걸어)`),
  },
  // payment
  {
    noun: /(결제|송금|이체|입금|구매|구입|주문|계좌)/u,
    verb: koRequest(String.raw`(?:결제|송금|이체|입금|구매|구입|주문)${KO_PARTICLE}(?:해|진행해|넣어)|보내|부쳐`),
  },
  // phone / SMS
  {
    noun: /(전화|문자|sms|메시지|메세지|카톡|카카오톡|통화)/iu,
    verb: koRequest(String.raw`(?:전화|문자|통화|카톡)${KO_PARTICLE}해|걸어|보내|남겨|돌려`),
  },
  // posting to an external service
  {
    noun: /(트위터|트윗|페이스북|인스타(?:그램)?|링크드인|블로그|슬랙|slack|sns|게시판|커뮤니티|카페|스레드|레딧|reddit|유튜브|youtube|twitter|facebook|instagram|linkedin)/iu,
    verb: koRequest(String.raw`올려|(?:게시|포스팅|업로드|공유|등록|트윗)${KO_PARTICLE}해`),
  },
];

const EN_EXTERNAL_ACTIONS: readonly RegExp[] = [
  enRequest(String.raw`(?:add|put|schedule|create|set\s+up|book)${EN_SENTENCE_REST}(?:calendars?|meetings?|appointments?)\b`),
  enRequest(String.raw`(?:send|forward|reply\s+to|write\s+and\s+send)${EN_SENTENCE_REST}(?:e-?mails?|mails?|inbox)\b`),
  enRequest(String.raw`(?:e-?mail)\s+(?!address)(?:my|him|her|them|the|this|[a-z]+\s+(?:about|that|the|a))\b`),
  enRequest(String.raw`(?:book|reserve)${EN_SENTENCE_REST}(?:tables?|flights?|hotels?|rooms?|tickets?|seats?|restaurants?|appointments?|reservations?|trains?|taxis?|cabs?)\b`),
  enRequest(String.raw`make\s+(?:a|the|my)\s+(?:reservation|booking)\b`),
  enRequest(String.raw`(?:pay|transfer|wire)${EN_SENTENCE_REST}(?:bills?|invoices?|money|payments?|rent|dollars?|won)\b`),
  enRequest(String.raw`(?:buy|purchase)\b|place\s+(?:an?|the|my)\s+order\b`),
  enRequest(String.raw`(?:call|phone|ring|text)\s+(?:my\s+\w+|mom|mum|dad|him|her|them|back)\b`),
  enRequest(String.raw`(?:send|leave)\s+(?:an?\s+|the\s+)?(?:text|sms|text\s+message|voicemail)\b|(?:make|place)\s+an?\s+(?:phone\s+)?call\b`),
  enRequest(String.raw`(?:post|tweet|publish|share|upload)${EN_SENTENCE_REST}(?:twitter|x\.com|facebook|instagram|linkedin|blog|slack|reddit|threads|youtube|social\s+media)\b`),
  enRequest(String.raw`tweet\s+(?:this|that|it|about)\b`),
];

/** Injection-shaped input (ADR-0098 amendment D1 b): override prior instructions or reveal hidden instructions. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:(?:of\s+)?(?:the|your|my|these|those)\s+)?(?:previous|prior|above|earlier|preceding|original|system|initial|all|your)\b[^.!?\n]{0,20}\b(?:instructions?|prompts?|rules?|directions?|guidelines?|guardrails?)\b/iu,
  /\b(?:reveal|show|print|display|output|repeat|dump|leak|tell\s+me|give\s+me|what(?:'s|\s+is|\s+are))\b[^.!?\n]{0,40}\b(?:system|initial|hidden|internal|developer|original)\s+(?:prompts?|instructions?|messages?|rules?)\b/iu,
  /\b(?:jailbreak|jailbroken|developer\s+mode|do\s+anything\s+now)\b/iu,
  /(?:이전|앞의|앞선|위의|위\s*에|기존|모든|지금까지의?|시스템|원래)\s*(?:의\s*)?(?:지시|지침|명령|규칙|프롬프트|instructions?)\S*\s*(?:은|는|을|를|들을|들은)?\s*(?:모두\s*|다\s*|전부\s*|싹\s*)?(?:무시|잊어|잊고|따르지\s*마|어기|무효)/iu,
  /(?:시스템|내부|숨겨진|숨은|초기|개발자|원본)\s*(?:의\s*)?(?:프롬프트|지시(?:문|사항)?|지침|명령문)\S*\s*[^.!?\n]{0,15}(?:출력|보여|알려|공개|말해|읽어|복사|노출|뭐야|뭔지|그대로)/iu,
  /(?:탈옥|제한\s*(?:을|를)?\s*(?:모두\s*)?(?:풀어|해제))/u,
];

const NON_PROSE = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/giu;

/**
 * A message in a language other than Korean or English (ADR-0098 amendment D1 c). Reuses the chat-policy
 * `detectReplyLanguage`: only an `unknown` message whose prose has a substantial share (>= 20%) of letters from a
 * script other than Hangul and Latin counts, so code-only, emoji-only and Korean/English mixes stay ordinary chat.
 */
function isOtherLanguage(text: string): boolean {
  if (detectReplyLanguage(text) !== 'unknown') return false;
  const prose = text.replace(NON_PROSE, ' ');
  const letters = prose.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return false;
  const hangul = prose.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  const latin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return (letters - hangul - latin) / letters >= 0.2;
}

/**
 * Deterministic policy-sensitivity check for an otherwise GENERAL_CHAT message (ADR-0098 amendment D1). No LLM. A
 * question about an action ("메일 쓰는 법 알려줘", "how do I send an email?") is not a request for it.
 */
export function detectPolicySensitiveChat(text: string): PolicySensitiveChatReason | undefined {
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text))) return 'injection';
  if (KO_EXTERNAL_ACTIONS.some(({ noun, verb }) => hasCoLocatedUnnegated(text, noun, verb))) return 'external-action';
  if (unnegatedMatch(text, EN_EXTERNAL_ACTIONS)) return 'external-action';
  if (isOtherLanguage(text)) return 'unsupported-language';
  return undefined;
}

/**
 * A path-scoped code-change verb (ADR-0098 amendment D3): with a real file path in the message, "src/a.ts를 고치고
 * src/new-helper.ts로 헬퍼를 분리해줘" is a code change even without the words "코드"/"파일". Korean verbs are
 * request/connective forms only, so a descriptive "추가된"/"분리된" does not count; English verbs other than the
 * unambiguous ones must sit in request position.
 */
const PATH_CHANGE_VERB_KO =
  /(고쳐|고치(?:고|자)|(?:수정|분리|추가|변경|삭제|이동|교체)\s*(?:해|하고|하자|하여|해서)|바꿔|바꾸고|옮겨|빼\s*줘|빼고|쪼개)/u;
const PATH_CHANGE_VERB_EN = /\b(?:fix|modify|refactor|extract|split|rename)\b/iu;
const PATH_CHANGE_VERB_EN_REQUEST = enRequest(String.raw`(?:add|update|change|move|remove|delete)\b`);

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
    return {
      type: IntentType.CHAT,
      capability: policySensitive ? Capability.POLICY_SENSITIVE_CHAT : Capability.GENERAL_CHAT,
      confidence: 1,
      requiresWork: true,
      summary: text.slice(0, 200) || '(empty message)',
      ...(policySensitive ? { raw: { kind: POLICY_SENSITIVE_CHAT_KIND, reason: policySensitive } } : {}),
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
      unnegatedMatch(text, [PATH_CHANGE_VERB_KO, PATH_CHANGE_VERB_EN, PATH_CHANGE_VERB_EN_REQUEST])
    ) {
      return 'change';
    }
    const changeVerb = /(고쳐|고치|수정해|수정\s*해|바꿔|바꾸어|변경해|구현해|fix|change|modify|implement)/i;
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

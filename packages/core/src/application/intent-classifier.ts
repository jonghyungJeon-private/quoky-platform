import { Capability, IntentType } from '../domain';
import type { InboundMessage, Intent } from '../domain';
import type { CapabilityRouter } from './capability-router';
import { hasCoLocatedUnnegated } from './intent-negation';
import { detectExplicitValidationKinds, isDeniedValidationRequest } from './validation-run-intent';

export interface IntentClassifyContext {
  /** False when the conversation has no active project; omitted keeps the context-free behavior. */
  readonly hasActiveProject?: boolean;
}

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

    const path = IntentClassifier.extractLocalPath(text);
    if (path && /등록|register/i.test(text)) {
      return {
        type: IntentType.REGISTER_PROJECT,
        capability: Capability.READONLY_LOOKUP,
        confidence: 1,
        requiresWork: false,
        summary: `Register project: ${path}`,
        raw: { path },
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

  private static chatIntent(text: string): Intent {
    return {
      type: IntentType.CHAT,
      capability: Capability.GENERAL_CHAT,
      confidence: 1,
      requiresWork: true,
      summary: text.slice(0, 200) || '(empty message)',
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

  /** First absolute POSIX path (>= 2 segments, at a token start) in the text, if any — so "7/3" is not a path. */
  private static extractLocalPath(text: string): string | undefined {
    const match = text.match(/(?:^|[\s"'`(:=])(\/[^\s/]+(?:\/[^\s/]+)+)/);
    return match ? match[1] : undefined;
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

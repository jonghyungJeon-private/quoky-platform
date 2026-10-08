import { AiProviderError, NoProviderAvailableError } from '../errors';
import { AiFailureKind, Capability } from '../domain';

export interface FailureDescription {
  kind: AiFailureKind;
  /** Friendly, user-facing chat message. Owns no technical detail. */
  userMessage: string;
  /** Technical summary stored on the TaskRun (already secret-masked upstream). */
  errorSummary: string;
}

/** User-facing copy per failure kind. The core owns this text, not the provider. */
const USER_MESSAGES: Record<AiFailureKind, string> = {
  [AiFailureKind.UNAVAILABLE]:
    '지금은 AI를 사용할 수 없어요. 잠시 후 다시 시도해 주세요. 🥲',
  [AiFailureKind.AUTH_REQUIRED]:
    'AI 인증이 필요해요. 관리자가 Claude CLI 로그인을 확인해야 합니다. 🔑',
  [AiFailureKind.TIMEOUT]:
    '응답이 너무 오래 걸려서 멈췄어요. 잠시 후 다시 시도해 주세요. ⏳',
  [AiFailureKind.EXECUTION_FAILED]:
    '처리 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요. 🛠️',
  [AiFailureKind.EMPTY_OUTPUT]:
    'AI가 빈 응답을 반환했어요. 질문을 조금 바꿔서 다시 시도해 주세요. 🤔',
};

/**
 * No provider is configured/ready at all (a setup problem, not a transient one), so it
 * gets its own copy instead of the generic "try again later" UNAVAILABLE message.
 */
const NO_PROVIDER_USER_MESSAGE =
  'AI가 아직 설정되지 않았어요. 관리자가 Claude CLI 설치·로그인 또는 로컬 AI(Ollama) 설정을 확인해야 합니다. 🔧';

/**
 * No ready provider advertises `POLICY_SENSITIVE_CHAT` (ADR-0098 amendment D1): the turn is not answered by a
 * provider below the chat-policy bar. Truthful for every trigger (external action, injection-shaped input, a language
 * other than Korean/English): nothing was done and no external action can be done. Korean first, then English, since
 * the turn may be in neither language.
 */
export const POLICY_SENSITIVE_CHAT_UNAVAILABLE_MESSAGE =
  '이 요청은 지금 처리할 수 있는 AI가 준비되어 있지 않아 답하지 않았어요. 아무 작업도 실행하지 않았어요. ' +
  'Quoky는 캘린더 등록, 메일·문자 발송, 예약, 결제, 외부 서비스 게시 같은 외부 작업은 직접 할 수 없어요. ' +
  '할 수 있는 일은 "도움말"에서 확인할 수 있어요.\n' +
  'This request was not answered because no AI provider that can handle it is ready right now, and nothing was ' +
  'done. Quoky cannot perform external actions such as calendar entries, sending email or messages, bookings, ' +
  'payments or posting to other services. Type "/help" to see what Quoky can do.';

/**
 * True when a `NoProviderAvailableError` was raised for `capability`. The error carries no structured capability field,
 * so this compares against the message the error class itself builds for that capability; it follows any wording change
 * in `errors.ts` without parsing the text. (Follow-up: a public `capability` field on the error, when `errors.ts` is in
 * scope.)
 */
function isUnavailableFor(err: NoProviderAvailableError, capability: Capability): boolean {
  return err.message === new NoProviderAvailableError(capability).message;
}

/**
 * Map any execution error to a classified, user-safe description (ADR-0015).
 * Never leaks raw provider/CLI internals into the user message. Unknown errors
 * are treated as EXECUTION_FAILED.
 */
export function describeAiFailure(err: unknown): FailureDescription {
  let kind: AiFailureKind;
  let technical: string;
  let userMessage: string | undefined;

  if (err instanceof AiProviderError) {
    kind = err.kind;
    technical = err.message;
  } else if (err instanceof NoProviderAvailableError) {
    kind = AiFailureKind.UNAVAILABLE;
    technical = err.message;
    userMessage = isUnavailableFor(err, Capability.POLICY_SENSITIVE_CHAT)
      ? POLICY_SENSITIVE_CHAT_UNAVAILABLE_MESSAGE
      : NO_PROVIDER_USER_MESSAGE;
  } else {
    kind = AiFailureKind.EXECUTION_FAILED;
    technical = err instanceof Error ? err.message : String(err);
  }

  return {
    kind,
    userMessage: userMessage ?? USER_MESSAGES[kind],
    errorSummary: `${kind}: ${technical}`.slice(0, 500),
  };
}

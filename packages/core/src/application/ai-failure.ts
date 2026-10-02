import { AiProviderError, NoProviderAvailableError } from '../errors';
import { AiFailureKind } from '../domain';

export interface FailureDescription {
  kind: AiFailureKind;
  /** Friendly, user-facing message (Discord). Owns no technical detail. */
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
    userMessage = NO_PROVIDER_USER_MESSAGE;
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

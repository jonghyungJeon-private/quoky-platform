import { PENDING_APPROVAL_TTL_MS } from '../conversation-commands';
import { CREDENTIAL_OVERRIDE_SEND_PHRASE, type CredentialOverrideInvalidationReason } from './credential-override';

/**
 * User copy for the credential-guard override (ADR-0097 D3/D7). Pure functions returning Korean, emoji-free
 * strings. They take a user-supplied path and a line number only — never file content or the matched text — so
 * no value can reach a reply. `ResponseComposer` wraps them (OVR-4) and applies the message budget.
 */

const TTL_MINUTES = Math.round(PENDING_APPROVAL_TTL_MS / 60_000);
const NOT_MODIFIED = '파일은 수정되지 않았어요.';
const FRESH_REQUEST = '보내려면 처음부터 다시 요청해 주세요.';
const SEND_LINE = `보내려면 "${CREDENTIAL_OVERRIDE_SEND_PHRASE}"라고만 보내 주세요. 그만두려면 "취소" 또는 "새 대화"라고 보내 주세요.`;

/** Remaining time rounded up to whole minutes, never 0 (the ADR-0093 reminder convention). */
const minutesOf = (remainingMs: number): number => Math.max(1, Math.ceil(remainingMs / 60_000));

/** The warning raised with a CRITICAL override request: names file and line, states every consequence. */
export function credentialOverridePrompt(path: string, line: number): string {
  return [
    `이 파일의 ${line}번째 줄에 비밀 키나 비밀번호로 보이는 값이 있어서 AI에게 보내기 전에 멈췄어요: ${path}`,
    '그래도 보내면 이 파일 전체 내용이 외부 AI 서비스로 한 번 전송되고, 보낸 내용은 되돌릴 수 없어요.',
    '변경 미리보기(diff)에 그 줄이 그대로 보일 수 있고, AI가 만든 제안은 이 컴퓨터에 저장돼요.',
    '이번 한 번만 적용돼요. 같은 파일을 다음에 요청하면 다시 확인해요.',
    SEND_LINE,
    `${TTL_MINUTES}분 안에 답하지 않으면 자동으로 취소돼요. ${NOT_MODIFIED}`,
  ].join('\n');
}

/** Appended to a credential refusal that can never be overridden (token/private-key shapes, ADR-0097 D6). */
export function credentialOverrideHardRefusalLine(): string {
  return '이 파일에는 토큰이나 개인 키 형태의 값이 있어서 확인을 받아도 보낼 수 없어요.';
}

/** Any non-decision message while an override is pending; `승인` and similar words never send. */
export function credentialOverrideReprompt(path: string, remainingMs: number): string {
  return [
    `AI에게 보낼지 확인을 기다리는 파일이 있어요: ${path}`,
    `"승인", "좋아", "ok"로는 보내지 않아요. ${SEND_LINE}`,
    `남은 시간: 약 ${minutesOf(remainingMs)}분 (지나면 자동으로 취소돼요)`,
  ].join('\n');
}

/** The owner refused (or cancelled) the override: nothing was sent and the request ended. */
export function credentialOverrideDenied(path: string): string {
  return `이 파일은 AI에게 보내지 않았고, 코드 변경 요청을 멈췄어요: ${path}\n${NOT_MODIFIED}`;
}

/** The target's content or classification changed since the override was raised: nothing was sent. */
export function credentialOverrideContentChanged(path: string): string {
  return [
    `확인을 요청한 뒤 파일 내용이 바뀌어서 AI에게 보내지 않았어요: ${path}`,
    `${FRESH_REQUEST} ${NOT_MODIFIED}`,
  ].join('\n');
}

/** Prefixed to a successful preview that used granted content (`composeWithNotice`). */
export function credentialOverrideSentNotice(paths: readonly string[]): string {
  return `확인한 파일 내용을 이번 한 번만 AI에게 보냈어요: ${paths.join(', ')}`;
}

/** A send phrase arrived while nothing is pending (QA-018 pattern): nothing was sent. */
export function credentialOverrideNoPending(): string {
  return (
    '지금 AI에게 보낼지 확인 중인 파일이 없어요. 기다리던 확인 요청은 처리됐거나 만료됐을 수 있어요. ' +
    '아무 파일도 보내지 않았어요. 새로 요청하려면 원하는 작업을 말해 주세요.'
  );
}

/** The set was already consumed (or is being sent by another turn): never replayed. */
export function credentialOverrideAlreadyUsed(): string {
  return '이 확인은 이미 한 번 사용됐어요. 같은 파일을 다시 보내려면 처음부터 다시 요청해 주세요.';
}

/** The set was invalidated without sending anything; every variant asks for a fresh request. */
export function credentialOverrideInvalidated(reason: CredentialOverrideInvalidationReason): string {
  const why: Record<CredentialOverrideInvalidationReason, string> = {
    reset: '새 대화를 시작해서 파일 전송 확인을 취소했어요.',
    denied: '파일 전송을 거절해서 코드 변경 요청을 멈췄어요.',
    expired: `${TTL_MINUTES}분 안에 확인되지 않아 파일 전송 확인을 자동으로 취소했어요.`,
    'project-changed': '활성 프로젝트나 작업 공간이 바뀌어서 파일 전송 확인을 취소했어요.',
    changed: '확인을 요청한 뒤 파일 내용이 바뀌어서 파일 전송 확인을 취소했어요.',
    superseded: '더 새로운 요청이 있어서 이전 파일 전송 확인을 취소했어요.',
  };
  return `${why[reason]} 아무 파일도 AI에게 보내지 않았어요. ${FRESH_REQUEST}`;
}

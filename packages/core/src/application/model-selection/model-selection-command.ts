/**
 * The owner's model-selection chat command grammar (ADR-0092 amendment, runtime switching; OpenClaw `/model` style).
 * Pure and deterministic: no provider, no storage, no clock. Whole-message matches only (NFC, trimmed, inner
 * whitespace flexible, the ASCII command head case-insensitive), so ordinary chat that merely mentions a model
 * ("모델 변경해야 할까?", "모델 상태가 궁금해") falls through.
 *
 * Core never names a provider: a choice is an opaque token (`codex`, `claude:opus`, `ollama:granite3.3:8b`) or a list
 * number, validated and resolved by the composition root's handler.
 *
 *  - `모델 상태` | `/model status`                     → status (also "모델 상태 알려줘", "지금 모델 뭐야?", DET-2)
 *  - `모델 목록` | `모델 목록 보여줘` | `/model` | `/model list` → list (numbered)
 *  - `모델 변경: <choice>` | `대화 모델 변경: <choice>` | `/model <choice>` → set the chat-tier choice for this session
 *  - `이미지 모델 변경: <choice>` | `/model image <choice>`           → set the image choice for this session
 *  - `모델 기본값으로` | `/model reset`                 → clear this session's chat and image choices
 *  - `이미지 모델 기본값으로` | `/model image reset`     → clear this session's image choice only
 *  - a malformed explicit form (`/model a b`, `모델 변경:` with nothing usable) → usage
 */

export type ModelSelectionTier = 'chat' | 'image';

export type ModelSelectionChoice =
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'token'; readonly token: string };

export type ModelSelectionCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'list' }
  | { readonly kind: 'set'; readonly tier: ModelSelectionTier; readonly choice: ModelSelectionChoice }
  | { readonly kind: 'reset'; readonly tier: 'all' | 'image' }
  | { readonly kind: 'usage' };

/** A choice token: a bounded `provider[:model]` shape (no spaces, no shell or path metacharacters beyond `:./-`). */
const TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const NUMBER_SHAPE = /^(\d{1,2})\s*번?$/u;

const STATUS = /^모델\s*상태(?:\s*보여\s?줘)?$/u;
/**
 * DET-2: status questions about the conversation's model, answered with the same status reply ("모델 상태 알려줘",
 * "지금 모델 뭐야?", "무슨 모델 써?", "모델 바뀌었어?"). Whole message; advice and opinions ("모델 상태가 궁금해", "어떤
 * 모델이 좋아?", "모델 변경해야 할까?") stay chat. Trailing `?` is removed before matching.
 */
const STATUS_QUESTIONS: readonly RegExp[] = [
  /^(?:지금\s*|현재\s*)?(?:대화\s*)?모델\s*상태\s*(?:알려\s?줘|알려\s?주세요|확인해\s?줘|보여\s?주세요)$/u,
  /^(?:지금|현재)\s*(?:쓰는\s*|사용하는\s*|사용\s*중인\s*)?(?:대화\s*)?모델(?:은|이)?\s*(?:뭐야|뭐예요|뭐에요|뭐지|뭔가요|어떤\s*거야)$/u,
  /^(?:지금\s*|현재\s*)?(?:무슨|어떤|어느)\s*모델\s*(?:써|써요|쓰고\s*있어|쓰고\s*있어요|쓰는\s*중이야|사용해|사용해요|사용\s*중이야|사용하고\s*있어|이야|이에요|야)$/u,
  /^(?:대화\s*)?모델\s*(?:이|은)?\s*(?:바뀌었어|바뀌었어요|바뀌었나|바뀌었나요|바뀌었니|바꼈어|변경됐어|변경됐어요|변경됐나|변경됐나요|변경되었어|변경되었나요)$/u,
  /^이미지\s*모델\s*상태(?:\s*(?:보여\s?줘|알려\s?줘))?$/u,
  /^model\s+status$/iu,
];
/**
 * DET-2: "모델 바꿔줘" with no choice is the usage reply (it names the exact command), never chat. A natural-language
 * choice ("모델을 codex로 바꿔줘") stays chat on purpose: only the explicit forms change the model.
 */
const CHANGE_WITHOUT_CHOICE = /^(?:대화\s*)?모델(?:을|를)?\s*(?:바꿔\s?줘|바꿔\s?주세요|바꾸고\s?싶어|변경해\s?줘|변경해\s?주세요|변경\s?해\s?줘)$/u;

const LIST = /^모델\s*목록(?:\s*보여\s?줘)?$/u;
const SET_CHAT = /^(?:대화\s*)?모델\s*변경\s*[:：]\s*(.*)$/u;
const SET_IMAGE = /^이미지\s*모델\s*변경\s*[:：]\s*(.*)$/u;
const RESET_ALL = /^모델\s*기본값으로(?:\s*(?:돌려\s?줘|되돌려\s?줘|해\s?줘))?$/u;
const RESET_IMAGE = /^이미지\s*모델\s*기본값으로(?:\s*(?:돌려\s?줘|되돌려\s?줘|해\s?줘))?$/u;

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function choiceOf(raw: string): ModelSelectionChoice | null {
  const value = raw.trim();
  const numbered = NUMBER_SHAPE.exec(value);
  if (numbered) {
    const number = Number(numbered[1]);
    return number >= 1 ? { kind: 'number', number } : null;
  }
  return TOKEN_SHAPE.test(value) ? { kind: 'token', token: value } : null;
}

function setOrUsage(tier: ModelSelectionTier, raw: string): ModelSelectionCommand {
  const choice = choiceOf(raw);
  return choice === null ? { kind: 'usage' } : { kind: 'set', tier, choice };
}

/** The `/model …` slash form (OpenClaw style). */
function parseSlash(rest: string): ModelSelectionCommand {
  const words = rest.split(' ').filter((word) => word.length > 0);
  const [first, second, ...more] = words;
  if (first === undefined) return { kind: 'list' };
  const head = asciiLower(first);
  if (words.length === 1 && (head === 'list' || head === 'ls')) return { kind: 'list' };
  if (words.length === 1 && head === 'status') return { kind: 'status' };
  if (words.length === 1 && head === 'reset') return { kind: 'reset', tier: 'all' };
  if (head === 'image' && (second === undefined || more.length > 0)) return { kind: 'usage' };
  if (head === 'image' && second !== undefined) {
    return asciiLower(second) === 'reset' ? { kind: 'reset', tier: 'image' } : setOrUsage('image', second);
  }
  if (words.length === 1) return setOrUsage('chat', first);
  return { kind: 'usage' };
}

/** The model-selection command `text` is, or null when it is not one (the handler then falls through). */
export function parseModelSelectionCommand(text: string): ModelSelectionCommand | null {
  const normalized = text.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0) return null;
  const slash = /^\/model(?:\s+(.*))?$/iu.exec(normalized);
  if (slash) return parseSlash(slash[1] ?? '');
  if (STATUS.test(normalized)) return { kind: 'status' };
  const unpunctuated = normalized.replace(/[\s?？.!~]+$/u, '');
  if (STATUS_QUESTIONS.some((pattern) => pattern.test(unpunctuated))) return { kind: 'status' };
  if (CHANGE_WITHOUT_CHOICE.test(unpunctuated)) return { kind: 'usage' };
  if (LIST.test(normalized)) return { kind: 'list' };
  if (RESET_IMAGE.test(normalized)) return { kind: 'reset', tier: 'image' };
  if (RESET_ALL.test(normalized)) return { kind: 'reset', tier: 'all' };
  const image = SET_IMAGE.exec(normalized);
  if (image) return setOrUsage('image', image[1] ?? '');
  const chat = SET_CHAT.exec(normalized);
  if (chat) return setOrUsage('chat', chat[1] ?? '');
  return null;
}

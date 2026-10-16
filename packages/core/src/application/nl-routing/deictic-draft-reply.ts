/**
 * ADR-0120 amendment A6 R5a (owner decision 3, 2026-10-16): the narrow, whole-message matcher for the owner's answer to
 * a deictic-write preview. It applies ONLY to that LOW local draft: ADR-0095 D1 (`approval-decision.ts`) and its
 * `APPROVE_FILLERS` are untouched, and CRITICAL approvals keep their own interpreter. Pure.
 *
 * - Normalisation: NFC and trimming; trailing `.`, `!`, `~` and whitespace are removed. Nothing else is removed: an emoji,
 *   a question mark or any other word makes the message `none`.
 * - `approve`: the whole message is one token of {@link DEICTIC_APPROVE_TOKENS}.
 * - `deny`: the whole message is one token of {@link DEICTIC_DENY_TOKENS} ("되돌려줘" denies a pending preview; it never
 *   undoes an older action in that turn).
 * - Everything else is `none` ("응 근데 …", "응 아니", "응?", "응 👍").
 */

export type DeicticDraftReply = 'approve' | 'deny' | 'none';

export const DEICTIC_APPROVE_TOKENS: readonly string[] = Object.freeze([
  '응', '어', '네', '넵', '예', '그래', '좋아', '맞아',
  '추가해', '추가해줘', '만들어줘',
  'yes', 'ok', 'okay',
]);

export const DEICTIC_DENY_TOKENS: readonly string[] = Object.freeze([
  '아니', '아니요', '아니야', '아뇨',
  '취소', '취소해', '취소해줘',
  '됐어', '그만',
  '되돌려줘',
  'no', 'cancel',
]);

const APPROVE = new Set(DEICTIC_APPROVE_TOKENS);
const DENY = new Set(DEICTIC_DENY_TOKENS);

/** The normalised whole message the matcher compares (exported for tests). */
export function normalizeDeicticDraftReply(text: string): string {
  return text.normalize('NFC').trim().replace(/[.!~\s]+$/u, '');
}

export function interpretDeicticDraftReply(text: string): DeicticDraftReply {
  const normalized = normalizeDeicticDraftReply(text);
  if (normalized.length === 0) return 'none';
  // Latin tokens compare case-insensitively ("OK", "Yes"); Korean tokens are exact.
  const key = /^[A-Za-z]+$/u.test(normalized) ? normalized.toLowerCase() : normalized;
  if (APPROVE.has(key)) return 'approve';
  if (DENY.has(key)) return 'deny';
  return 'none';
}

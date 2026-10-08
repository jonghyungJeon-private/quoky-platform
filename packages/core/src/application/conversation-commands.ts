import type { IsoTimestamp } from '../domain';

/**
 * Conversation control phrases (ADR-0093). Pure and deterministic — no provider, no storage, no clock of its
 * own. A control phrase is a WHOLE message: trimmed, then compared exactly (ASCII case-insensitive), so a
 * sentence that merely contains one ("새 대화 기능 만들어줘") is ordinary work, never a control turn. These are
 * plain-text messages, not a chat platform's application (slash) commands.
 */
export type ConversationControlCommand = 'help' | 'reset';

const HELP_PHRASES: ReadonlySet<string> = new Set(['도움말', '/help']);
const RESET_PHRASES: ReadonlySet<string> = new Set(['새 대화', '/reset']);

/** Lower-case ASCII letters only (ADR-0093 "ASCII case-insensitive") — never a locale-aware fold. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The control command this whole message is, or null for any other (ordinary) message. */
export function detectConversationControl(text: string): ConversationControlCommand | null {
  const normalized = asciiLower(text.normalize('NFC').trim());
  if (HELP_PHRASES.has(normalized)) return 'help';
  if (RESET_PHRASES.has(normalized)) return 'reset';
  return null;
}

/** Pending-approval lifetime (ADR-0093): 30 minutes from `ApprovalRequest.createdAt`. Not configurable in v1. */
export const PENDING_APPROVAL_TTL_MS = 1_800_000;

/**
 * Milliseconds left before a pending approval created at `createdAt` expires, measured at `nowIso` (the
 * shared clock). `<= 0` means expired. Fail closed: an unparseable timestamp cannot prove the approval is
 * still fresh, so it reports 0 (expired) — an approval of unknown age must never be grantable. A `createdAt`
 * ahead of the clock (skew) is capped at the full lifetime.
 */
export function pendingApprovalRemainingMs(
  createdAt: IsoTimestamp,
  nowIso: IsoTimestamp,
  ttlMs: number = PENDING_APPROVAL_TTL_MS,
): number {
  const created = Date.parse(createdAt);
  const current = Date.parse(nowIso);
  if (Number.isNaN(created) || Number.isNaN(current)) return 0;
  return Math.min(ttlMs, created + ttlMs - current);
}

import type { InboundMessage } from '../../domain';
import { resolveSurfaceGroupAlias, type SurfaceGroupId } from './surface-groups';

/**
 * ADR-0122 D4: the anchored, owner-only Class A grant phrases. Whole message only, on the NFC-normalized,
 * whitespace-collapsed text with an optional closed polite tail (`해줘`, `해 줘`, `해주세요`) and trailing `.` / `!`.
 * Quoted text, code-formatted text and a message with attachments never match (ADR-0120 D8 / A6 formatting facts).
 * Never chosen by the selector or the chat model.
 *
 * The grant (`이 채널에 X 허용`) is never immediate: it asks for the exact confirmation `허용 실행` within 2 minutes
 * (`parseSurfaceGrantConfirm`, P2).
 */

export type SurfaceGrantPhrase =
  /** `이 채널 권한` / `이 채널 권한 보여줘` (in a channel). */
  | { readonly kind: 'list' }
  /** `채널 권한 목록` (in a DM). */
  | { readonly kind: 'list-all' }
  /** `이 채널에 <그룹>[, <그룹>…] 허용` (a confirmation, never an immediate grant). */
  | { readonly kind: 'grant'; readonly groups: readonly SurfaceGroupId[]; readonly unknown: readonly string[] }
  /** `이 채널에 <그룹>[, …] 허용 해제`. */
  | { readonly kind: 'revoke'; readonly groups: readonly SurfaceGroupId[]; readonly unknown: readonly string[] }
  /** `이 채널 권한 모두 해제`. */
  | { readonly kind: 'revoke-channel' }
  /** `모든 채널 권한 해제` (in a DM). */
  | { readonly kind: 'revoke-all' };

const POLITE_TAIL = /\s*(?:해\s?줘요?|해\s?주세요|해\s?주십시오)$/u;

/** NFC, whitespace collapsed, trailing `.`/`!` and one polite tail removed. */
export function normalizeSurfaceGrantText(text: string): string {
  let normalized = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  normalized = normalized.replace(/[.!。！]+$/u, '').trim();
  normalized = normalized.replace(POLITE_TAIL, '').trim();
  return normalized.replace(/[.!。！]+$/u, '').trim();
}

/** Whether the message carries anything that must never match an anchored phrase. */
function isIneligible(message: Pick<InboundMessage, 'text' | 'quotedRanges' | 'formatting' | 'attachments'>): boolean {
  if ((message.attachments?.length ?? 0) > 0) return true;
  if (message.formatting?.code === true) return true;
  if ((message.quotedRanges?.length ?? 0) > 0) return true;
  // Inline or fenced code and a quote line written by hand.
  if (/`/.test(message.text) || /^\s*>/mu.test(message.text)) return true;
  return message.text.includes('\n');
}

function groupsOf(list: string): { readonly groups: SurfaceGroupId[]; readonly unknown: string[] } {
  const groups: SurfaceGroupId[] = [];
  const unknown: string[] = [];
  for (const raw of list.split(/\s*(?:,|、|，|및|그리고)\s*/u)) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const id = resolveSurfaceGroupAlias(name);
    if (id === undefined) unknown.push(name);
    else if (!groups.includes(id)) groups.push(id);
  }
  return { groups, unknown };
}

/** The phrase this message is, or `undefined` (then the text routes as ordinary text). Pure. */
export function parseSurfaceGrantPhrase(
  message: Pick<InboundMessage, 'text' | 'quotedRanges' | 'formatting' | 'attachments'>,
): SurfaceGrantPhrase | undefined {
  if (isIneligible(message)) return undefined;
  const text = normalizeSurfaceGrantText(message.text);
  if (text.length === 0 || text.length > 200) return undefined;
  if (/^이 ?채널 ?권한(?: ?(?:보여|알려) ?(?:줘|주세요|줘요))?$/u.test(text) || /^이 ?채널 ?권한 ?(?:보기|확인)$/u.test(text)) return { kind: 'list' };
  if (/^채널 ?권한 ?목록(?: ?(?:보여|알려) ?(?:줘|주세요|줘요))?$/u.test(text)) return { kind: 'list-all' };
  if (/^이 ?채널 ?권한 ?(?:모두|전부|다) ?해제$/u.test(text)) return { kind: 'revoke-channel' };
  if (/^(?:모든|전체) ?채널 ?권한 ?(?:모두 ?)?해제$/u.test(text)) return { kind: 'revoke-all' };
  const revoke = /^이 ?채널(?:에서|에)? (.+?) ?허용 ?해제$/u.exec(text);
  if (revoke) return { kind: 'revoke', ...groupsOf(revoke[1] as string) };
  const grant = /^이 ?채널에 (.+?) ?허용$/u.exec(text);
  if (grant) return { kind: 'grant', ...groupsOf(grant[1] as string) };
  return undefined;
}

/**
 * D4.2: the exact confirmation `허용 실행` (whole message, NFC, whitespace collapsed, an optional polite tail and trailing
 * `.`/`!`; quoted, code-formatted, multi-line text and attachments never match). It does not overlap the approval
 * vocabulary (`승인`, `진행`, …).
 */
export function parseSurfaceGrantConfirm(message: Pick<InboundMessage, 'text' | 'quotedRanges' | 'formatting' | 'attachments'>): boolean {
  if (isIneligible(message)) return false;
  return /^허용 ?실행$/u.test(normalizeSurfaceGrantText(message.text));
}

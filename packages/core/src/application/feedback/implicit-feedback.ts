import { createHash } from 'node:crypto';
import { FEEDBACK_FINGERPRINT_MAX_ENTRIES, FeedbackSignalKind } from '../../domain';
import type { ConversationTurnRecord, FeedbackTurnControl, FeedbackTurnStatus } from '../../domain';
import { detectConversationControl } from '../conversation-commands';
import { extractSemanticKeywords } from '../semantic-relevance';

/**
 * Implicit feedback detector (ADR-0098 D5, QUAL-3). Pure and deterministic: no provider, no storage, no clock.
 * Implicit signals are evidence only — never ratings, and nothing reads them to drive behaviour.
 */

/** A reset (`새 대화`) this soon after a RESPONDED reply is evidence the reply missed. */
export const IMPLICIT_RESET_WINDOW_MS = 120_000;
/** A correction-lexicon message this soon after a RESPONDED reply. */
export const IMPLICIT_CORRECTION_WINDOW_MS = 300_000;
/** A rephrase (fingerprint Jaccard ≥ {@link IMPLICIT_REPHRASE_MIN_JACCARD}) this soon after a RESPONDED reply. */
export const IMPLICIT_REPHRASE_WINDOW_MS = 120_000;
export const IMPLICIT_REPHRASE_MIN_JACCARD = 0.5;

/** The ADR-0098 D6 control phrase (exact whole message, no slash alias). */
export const FEEDBACK_SUMMARY_PHRASE = '피드백 요약';

const CORRECTION_PATTERN =
  /^\s*(아니(요)?[,\s]|그게\s*아니(라|고)|틀렸|잘못\s*(이해|알아)|no[,\s]+(i\s+meant|that'?s\s+not)|that'?s\s+(wrong|not\s+what))/iu;

/** The control phrase this whole message is, or undefined for an ordinary message. */
export function detectFeedbackTurnControl(text: string): FeedbackTurnControl | undefined {
  if (text.normalize('NFC').trim() === FEEDBACK_SUMMARY_PHRASE) return 'feedback-summary';
  return detectConversationControl(text) ?? undefined;
}

/** True when the message opens with a correction-lexicon phrase (KO/EN). */
export function isCorrectionMessage(text: string): boolean {
  return CORRECTION_PATTERN.test(text.normalize('NFC'));
}

/**
 * Content-free request fingerprint: the first 8 hex of sha256 of each distinct semantic keyword, in first-seen
 * order, at most {@link FEEDBACK_FINGERPRINT_MAX_ENTRIES} entries. The keywords themselves are never kept.
 */
export function requestFingerprint(text: string): string[] {
  const hashes: string[] = [];
  for (const keyword of extractSemanticKeywords(text.normalize('NFC'))) {
    const hash = createHash('sha256').update(keyword, 'utf8').digest('hex').slice(0, 8);
    if (!hashes.includes(hash)) hashes.push(hash);
    if (hashes.length === FEEDBACK_FINGERPRINT_MAX_ENTRIES) break;
  }
  return hashes;
}

/** Jaccard similarity of two fingerprints as sets; 0 when either is empty. */
export function fingerprintJaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const entry of left) if (right.has(entry)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export interface ImplicitSignalInput {
  /** The previous turn at the same location by the same user, if any. */
  previous: ConversationTurnRecord | null;
  currentText: string;
  currentStatus: FeedbackTurnStatus;
  /** True when the current message was handled as a work turn (not a control or approval decision). */
  currentHasWorkFacts: boolean;
  /** Milliseconds from the previous reply's delivery to the current message. */
  elapsedMs: number;
}

/** The implicit signal kinds the current message gives about `previous` (empty when none). */
export function detectImplicitSignals(input: ImplicitSignalInput): FeedbackSignalKind[] {
  const { previous, currentText, currentStatus, currentHasWorkFacts, elapsedMs } = input;
  if (!previous || previous.control || !Number.isFinite(elapsedMs) || elapsedMs < 0) return [];
  const kinds: FeedbackSignalKind[] = [];
  if (previous.status === 'AWAITING_APPROVAL' && currentStatus === 'AWAITING_APPROVAL') {
    kinds.push(FeedbackSignalKind.IMPLICIT_APPROVAL_REPROMPT);
  }
  if (previous.status !== 'RESPONDED') return kinds;
  const control = detectFeedbackTurnControl(currentText);
  if (control === 'reset' && elapsedMs <= IMPLICIT_RESET_WINDOW_MS) {
    kinds.push(FeedbackSignalKind.IMPLICIT_RESET_AFTER_REPLY);
  }
  if (control) return kinds;
  if (elapsedMs <= IMPLICIT_CORRECTION_WINDOW_MS && isCorrectionMessage(currentText)) {
    kinds.push(FeedbackSignalKind.IMPLICIT_CORRECTION);
  }
  if (currentHasWorkFacts && elapsedMs <= IMPLICIT_REPHRASE_WINDOW_MS
    && fingerprintJaccard(previous.requestFingerprint, requestFingerprint(currentText)) >= IMPLICIT_REPHRASE_MIN_JACCARD) {
    kinds.push(FeedbackSignalKind.IMPLICIT_REPHRASE);
  }
  return kinds;
}

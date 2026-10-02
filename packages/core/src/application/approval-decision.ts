import { isNegated } from './intent-negation';

/**
 * Approval-decision interpretation (Quoky Personal v1, T1) — extracted from `ConversationRuntime` as a pure
 * module so the safety rules are unit-testable in isolation.
 *
 * The previous matcher used substring hits, so "why?" / "no problem" / "ok" inside a longer word were read as
 * decisions ("y" and "n" matched almost any English text) and a negated phrase ("진행하지 마", "don't approve")
 * was read as an APPROVE. This module is deliberately conservative: only whole tokens / phrases count, a
 * negated approve never approves, and anything uncertain (question, hedge, contradiction, long free text) is
 * `ambiguous` — the runtime then re-prompts and the pending approval stays pending. It only ever decides
 * whether a message IS a decision; the apply/patch/commit gates (APPLY_WORDS / FINAL_APPLY_WORDS, ADR-0040/0042)
 * are separate and untouched.
 */

/** Same union as `ApprovalDecisionKind` in conversation-runtime (kept local to avoid a circular import). */
export type ApprovalDecisionResult = 'approve' | 'deny' | 'cancel' | 'ambiguous';

const APPROVE_PHRASES = ['승인', '진행', '좋아', 'yes', 'ok', 'okay', 'approve', 'approved', 'go ahead'];
const DENY_PHRASES = ['거절', '아니', 'no', 'deny', 'denied', 'reject', 'rejected'];
const CANCEL_PHRASES = ['취소', '중단', '그만', 'cancel', 'stop', 'abort'];

/** Polite endings / particles that may follow a Korean stem and still be the same whole word
 *  ("승인해줘", "진행할게요", "아니요"). Anything outside this list ("승인하지", "진행상황") is NOT a match. */
const KOREAN_SUFFIX =
  '(?:하세요|해주세요|해줘요|해줘|해요|해라|하자|할게요|할게|합니다|할래요|할래|해|요|이요|이야|야|네요|네|입니다|예요|에요|다|라|뇨)?';
const TOKEN_BEFORE = '(?<![가-힣a-z0-9])';
const TOKEN_AFTER = '(?![가-힣a-z0-9])';
const HANGUL = /[가-힣]/;

/** A free-text message longer than this is never a bare approval (e.g. a new task request that merely
 *  contains "진행"). Deny/cancel are non-mutating and are not length-capped. */
const MAX_APPROVE_LENGTH = 80;

/** A message that ends as a question ("진행할까?", "why?", "승인해도 될까요") asks, it does not decide. */
const QUESTION_ENDING = /[?？]\s*$|(?:까|까요|나요|인가요|건가요|는가요)[\s.!]*$/;

/** Wait / look-first hedges — "먼저 보고 승인할게" / "approve later" must not decide anything. */
const HEDGE = /아직|먼저\s*(?:보|확인|검토|살펴|읽)|잠깐|잠시|나중|보고\s*(?:나서|서)|\b(?:yet|first|wait|later)\b|hold\s+on/;

/** Negations `isNegated` does not cover but that still flip an approve ("승인 안 할래", "not approve"). */
const KOREAN_SOFT_NEGATION = /(?:^|\s)(?:안|못)(?=\s|$|[하해할함했돼되됩])/;
const SOFT_NEGATION = new RegExp(
  `${KOREAN_SOFT_NEGATION.source}|\\b(?:not|no|cannot|can['’]?t|won['’]?t|wouldn['’]?t|shouldn['’]?t|mustn['’]?t)\\b`,
);

/** "no problem" / "no worries" read as a polite OK, not a refusal: ambiguous rather than a false deny. */
const NO_PROBLEM = /\bno\s+(?:problem|worries)\b/;

interface PhraseMatchers {
  /** Whole-token / whole-phrase (Korean: stem + allowed ending) matches. */
  exact: RegExp;
  /** Same stems but tolerant of any Hangul continuation — used ONLY to detect a negated phrase
   *  ("승인하지 마"), never to grant a decision. */
  loose: RegExp;
}

function matchersFor(phrases: string[]): PhraseMatchers {
  const exact: string[] = [];
  const loose: string[] = [];
  for (const phrase of phrases) {
    const body = phrase.replace(/\s+/g, '\\s+');
    if (HANGUL.test(phrase)) {
      exact.push(`${TOKEN_BEFORE}${body}${KOREAN_SUFFIX}${TOKEN_AFTER}`);
      loose.push(`${TOKEN_BEFORE}${body}[가-힣]*`);
    } else {
      const latin = `${TOKEN_BEFORE}${body}${TOKEN_AFTER}`;
      exact.push(latin);
      loose.push(latin);
    }
  }
  return { exact: new RegExp(exact.join('|'), 'g'), loose: new RegExp(loose.join('|'), 'g') };
}

const APPROVE = matchersFor(APPROVE_PHRASES);
const DENY = matchersFor(DENY_PHRASES);
const CANCEL = matchersFor(CANCEL_PHRASES);

interface KindHits {
  /** At least one whole-token match that is NOT under a negation. */
  positive: boolean;
  /** At least one (loose) match that IS under a negation ("승인하지 마", "don't approve"). */
  negated: boolean;
}

function scan(text: string, matchers: PhraseMatchers): KindHits {
  let positive = false;
  let negated = false;
  for (const m of text.matchAll(matchers.exact)) {
    if (!isNegated(text, m.index, m[0].length)) positive = true;
  }
  for (const m of text.matchAll(matchers.loose)) {
    if (isNegated(text, m.index, m[0].length)) negated = true;
  }
  return { positive, negated };
}

/**
 * Interpret a user message as an approval decision (only meaningful while a pending approval exists).
 * Pure and deterministic. Order of precedence:
 *  1. question / empty → ambiguous
 *  2. un-negated cancel → cancel (cancel is non-mutating; "승인 취소" cancels)
 *  3. hedge ("먼저", "yet", "wait"…) → ambiguous
 *  4. negated approve phrase ("진행하지 마", "don't approve") → deny (never approve); contradictory → ambiguous
 *  5. approve XOR deny (un-negated, whole token) → that decision; both or neither → ambiguous
 * A negated deny/cancel ("거절하지 마", "거절 안 해") yields nothing positive, so it falls through to ambiguous;
 * "no problem" is likewise ambiguous rather than a false deny.
 */
export function interpretApprovalDecision(text: string): ApprovalDecisionResult {
  const t = text.trim().toLowerCase();
  if (t.length === 0 || QUESTION_ENDING.test(t)) return 'ambiguous';

  const cancel = scan(t, CANCEL);
  if (cancel.positive) return 'cancel';
  if (HEDGE.test(t)) return 'ambiguous';

  const approve = scan(t, APPROVE);
  const deny = scan(t, DENY);

  if (approve.negated) {
    return approve.positive || deny.positive ? 'ambiguous' : 'deny';
  }
  if (approve.positive && !deny.positive) {
    if (t.length > MAX_APPROVE_LENGTH || SOFT_NEGATION.test(t)) return 'ambiguous';
    return 'approve';
  }
  if (deny.positive && !approve.positive) {
    // "거절 안 해" (I won't reject) / "no problem" are not refusals.
    return KOREAN_SOFT_NEGATION.test(t) || NO_PROBLEM.test(t) ? 'ambiguous' : 'deny';
  }
  return 'ambiguous';
}

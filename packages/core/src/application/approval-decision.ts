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

const APPROVE_PHRASES = ['승인', '진행', '좋아', 'yes', 'ok', 'okay', 'approve', 'approved', 'proceed', 'go ahead'];
const DENY_PHRASES = ['거절', '거부', '아니', 'no', 'deny', 'denied', 'reject', 'rejected', 'refuse', 'refused'];
const CANCEL_PHRASES = ['취소', '철회', '중단', '중지', '멈춰', '멈춰줘', '멈춰요', '멈추자', '그만', 'cancel', 'stop', 'abort'];

/** Polite endings / particles that may follow a Korean stem and still be the same whole word
 *  ("승인해줘", "진행할게요", "아니요"). Anything outside this list ("승인하지", "진행상황") is NOT a match. */
const KOREAN_SUFFIX =
  '(?:시켜줘|시켜요|시켜|하세요|해주세요|해줘요|해줘|해요|해라|하자|할게요|할게|합니다|할래요|할래|해|요|이요|이야|야|네요|네|입니다|예요|에요|다|라|뇨)?';
const TOKEN_BEFORE = '(?<![가-힣a-z0-9])';
const TOKEN_AFTER = '(?![가-힣a-z0-9])';
const HANGUL = /[가-힣]/;

/** A free-text message longer than this is never a bare approval (e.g. a new task request that merely
 *  contains "진행"). Deny/cancel are non-mutating and are not length-capped. */
const MAX_APPROVE_LENGTH = 80;

/** A message that ends as a question ("진행할까?", "why?", "승인해도 될까요") asks, it does not decide. A question
 *  mark ANYWHERE ("승인? 감사합니다.", "진행? 네", "ok?!") is a question too — never only at the end. */
const QUESTION = /[?？]|(?:까|까요|나요|인가요|건가요|는가요)[\s.!]*$/;

/** The only characters an approval may contain: letters, Hangul syllables, digits, whitespace, apostrophes (for
 *  "don't stop") and the benign punctuation `. , ! ~`. Anything else — an emoji ("승인 👎"), a mark ("승인 ❌",
 *  "승인 ✖"), a symbol, a jamo — is significant content we cannot read, so the message is NOT a plain approval.
 *  Nothing is stripped before this check; it applies only to approve (deny/cancel are non-mutating). */
const NON_APPROVE_CHARACTER = /[^a-z0-9가-힣\s.,!~'’]/;

/** Wait / look-first hedges — "먼저 보고 승인할게" / "approve later" must not decide anything. */
const HEDGE =
  /아직|먼저\s*(?:보|확인|검토|살펴|읽)|잠깐|잠시|나중|내일|보고\s*(?:나서|서)|원(?:하)?지\s*(?:않|안)|원치|\b(?:yet|first|wait|later|tomorrow)\b|hold\s+on|let\s+me/;

/** Negations `isNegated` does not cover but that still flip an approve ("승인 안 할래", "not approve"). */
const KOREAN_SOFT_NEGATION = /(?:^|\s)(?:안|못)(?=\s|$|[하해할함했돼되됩됨])/;
const SOFT_NEGATION = new RegExp(
  `${KOREAN_SOFT_NEGATION.source}|\\b(?:not|no|cannot|can['’]?t|won['’]?t|wouldn['’]?t|shouldn['’]?t|mustn['’]?t)\\b`,
);

/** A refusal / hold word sitting next to an approve word ("승인 불가", "진행 마", "승인 X", "approve nothing")
 *  turns an otherwise-approve message into a non-decision. Whole tokens only, so "마음에 들어" is untouched. */
const REFUSAL_QUALIFIER = new RegExp(
  `${TOKEN_BEFORE}(?:불가능?|불허|반려|보류|반대|대기|싫(?:어|어요|다)?|마(?:세요|라)?|말아(?:요|줘)?|ㄴㄴ|x|nope|nothing|hold)${TOKEN_AFTER}`,
);

/**
 * Words that may accompany an approve word WITHOUT adding content ("네, 진행할게요", "승인해 주세요",
 * "yes please", "안녕, 승인"). After the approve words and these are removed, any remaining word is extra
 * content (a status question, a restriction, an added instruction, a hedge we do not know) and the message is
 * not a plain approval: the runtime re-prompts and the approval stays pending.
 */
const APPROVE_FILLERS = [
  '네', '넵', '넹', '예', '응', '그래', '그럼', '그냥', '일단', '바로', '어서', '제발', '이제', '좀', '안녕', '하세요',
  '주세요', '줘', '줘요', '부탁', '부탁해', '부탁해요', '부탁드려요', '부탁드립니다', '감사합니다', '고마워', '고마워요',
  'please', 'pls', 'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'thanks', 'thank', 'you', 'it', 'this', 'that', 'now', 'hi', 'hello',
];
const APPROVE_FILLER_TOKEN = new RegExp(
  `${TOKEN_BEFORE}(?:${[...APPROVE_FILLERS].sort((a, b) => b.length - a.length).join('|')})${TOKEN_AFTER}`,
  'g',
);
/** "please don't stop, go ahead": a negated cancel word is filler, the approve is still plain. */
const NEGATED_CANCEL_FILLER = /\b(?:don['’]?t|do\s+not)\s+(?:stop|cancel|abort)\b/g;

/** True when anything beyond approve words, fillers and punctuation remains. */
function hasContentBeyondApproval(text: string): boolean {
  const remainder = text
    .replace(APPROVE.exact, ' ')
    .replace(NEGATED_CANCEL_FILLER, ' ')
    .replace(/[^가-힣a-z0-9]+/g, ' ')
    .replace(APPROVE_FILLER_TOKEN, ' ')
    .replace(APPROVE_FILLER_TOKEN, ' ');
  return remainder.trim().length > 0;
}

/** A don't / never / "하지 마" anywhere in an approve message attaches a condition we cannot honor
 *  ("yes but don't touch tests"): ambiguous so the user restates it. */
const CONDITION_NEGATION = /\b(?:don['’]?t|do\s+not|never)\b|하지\s*(?:마|말)/;

/** A negation that governs the approve word itself ("진행하지 마", "승인하지 말고", "don't approve"). Only this
 *  is a terminal deny; a negation elsewhere ("테스트 없이 진행해", "커밋하지 말고 진행해", "proceed without
 *  tests") is a conditional approval we cannot honor, so it re-prompts instead. */
const DIRECT_NEGATED_APPROVE =
  /(?:승인|진행)(?:하|시키)?지\s*(?:마|말)|\b(?:don['’]?t|do\s+not|never)\s+(?:approve|proceed|go\s+ahead)\b/;

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
  /** Index of the first negated (loose) match, or -1. Lets the caller tell "취소하지 말고 진행해" (a negated
   *  deny/cancel word BEFORE the approve word) from "승인하지 말고 거절" (the approve word is the negated one). */
  negatedAt: number;
}

function scan(text: string, matchers: PhraseMatchers): KindHits {
  let positive = false;
  let negatedAt = -1;
  for (const m of text.matchAll(matchers.exact)) {
    if (!isNegated(text, m.index, m[0].length)) positive = true;
  }
  for (const m of text.matchAll(matchers.loose)) {
    if (negatedAt < 0 && isNegated(text, m.index, m[0].length)) negatedAt = m.index;
  }
  return { positive, negated: negatedAt >= 0, negatedAt };
}

/**
 * Interpret a user message as an approval decision (only meaningful while a pending approval exists).
 * Pure and deterministic. Order of precedence:
 *  1. question (a `?`/`？` anywhere, or a question ending) / empty → ambiguous
 *  2. un-negated cancel → cancel (cancel is non-mutating; "승인 취소" cancels)
 *  3. hedge ("먼저", "yet", "wait"…) → ambiguous
 *  4. negated approve phrase ("진행하지 마", "don't approve") → deny (never approve); contradictory or
 *     contrastive ("취소하지 말고 진행해") → ambiguous
 *  5. approve XOR deny (un-negated, whole token) → that decision; both or neither → ambiguous. An approve with a
 *     refusal qualifier ("승인 불가"), an attached don't-condition ("yes but don't touch tests") or ANY further
 *     content word ("진행 상황 알려줘", "ok but only src/a.ts") or any character outside letters/Hangul/digits/
 *     whitespace and `. , ! ~ '` ("승인 ❌", "승인 👎") is ambiguous: approve is the narrow case.
 * A negated deny/cancel ("거절하지 마", "거절 안 해") yields nothing positive, so it falls through to ambiguous;
 * "no problem" is likewise ambiguous rather than a false deny.
 */
export function interpretApprovalDecision(text: string): ApprovalDecisionResult {
  const t = text.trim().toLowerCase();
  if (t.length === 0 || QUESTION.test(t)) return 'ambiguous';

  const cancel = scan(t, CANCEL);
  if (cancel.positive) return 'cancel';
  if (HEDGE.test(t)) return 'ambiguous';

  const approve = scan(t, APPROVE);
  const deny = scan(t, DENY);

  // Codex P2 (round 3 on cad729e): an explicit deny verb decides; an approve verb next to it makes it ambiguous.
  const denyVerb = hasExplicitDenyVerb(t);
  if (denyVerb) return hasApproveVerb(t) ? 'ambiguous' : 'deny';

  if (approve.negated) {
    // "취소하지 말고 진행해" / "거절하지 말고 승인해": the negation targets the deny/cancel word, so the user
    // did not say "don't approve" — re-prompt instead of a terminal deny.
    if (approve.positive || deny.positive) return 'ambiguous';
    const negatedRefusalFirst = [deny, cancel].some((k) => k.negated && k.negatedAt < approve.negatedAt);
    if (negatedRefusalFirst) return 'ambiguous';
    return DIRECT_NEGATED_APPROVE.test(t) ? 'deny' : 'ambiguous';
  }
  if (approve.positive && !deny.positive) {
    if (t.length > MAX_APPROVE_LENGTH || SOFT_NEGATION.test(t) || REFUSAL_QUALIFIER.test(t)) return 'ambiguous';
    if (NON_APPROVE_CHARACTER.test(t)) return 'ambiguous';
    // Approve is the narrow case: an approve word plus any further content word ("진행 상황 알려줘", "ok but only
    // src/a.ts", "yes and also push it") is a question, a condition or an added instruction, not a decision.
    if (hasContentBeyondApproval(t)) return 'ambiguous';
    // ("please don't stop, go ahead": the negation is on a cancel word, so it is still a plain approve.)
    if (CONDITION_NEGATION.test(t) && !cancel.negated && !deny.negated) return 'ambiguous';
    return 'approve';
  }
  if (deny.positive && !approve.positive) {
    // "거절 안 해" (I won't reject) / "no problem" are not refusals.
    if (KOREAN_SOFT_NEGATION.test(t) || NO_PROBLEM.test(t)) return 'ambiguous';
    // No deny verb here (that returned above): a bare deny word ("아니", "아니요", "no") decides, alone or followed only
    // by a stop word ("아니 됐어", "no, stop"); "아니 이건 내 친구 얘기야" carries other content and re-prompts.
    return isBareDenyWord(t) ? 'deny' : 'ambiguous';
  }
  // A bare deny word outside the deny phrase list ("nope", "아뇨") decides the same way (rule b).
  return !approve.positive && isBareDenyWord(t) ? 'deny' : 'ambiguous';
}

/**
 * Explicit deny verbs (round-3 rule a): 거절 / 거부 / 취소 in any verb form, "하지 마", "안 해", "승인 안 / 승인하지 않",
 * reject / deny / cancel. A deny verb that is itself negated ("거절하지 마", "거절 안 해", "취소하지 말고") is not one.
 */
/** 거절 / 거부 / 취소 as a verb ("거절해 주세요", "거절합니다", "취소할게") or standing alone ("거절", "거절요") — never a
 *  noun compound ("거절 사유", "거절사유"). */
const DENY_VERB_STEM =
  /(?<![가-힣a-z0-9])(?:거절|거부|취소)(?:(?:해|하|합|할|했|함|시켜|시킬)[가-힣]*|요|이요)?(?=$|[^가-힣a-z0-9])(?!\s*(?:사유|이유|내역|기록|방법|절차|버튼|여부))|\b(?:reject(?:ed|s)?|deny|denied|denies|refuse[ds]?|cancel(?:l?ed|s)?)\b/g;
const NEGATED_APPROVE_VERB =
  /(?:승인|진행|실행)\s*(?:안\s+(?:할|해|하|돼|됨|됩|될)|안(?:해|할|돼|됨|됩|될)|않|못\s*(?:해|하|할|돼|됨))|(?:승인|진행|실행)(?:하|시키)?지\s*(?:마|말|않)|\b(?:don['’]?t|do\s+not|never|won['’]?t)\s+(?:approve|proceed|go\s+ahead)\b|\bnot\s+approve\b/g;
const GENERIC_DENY_VERB = /(?:하지\s*마|하지마)(?:요|라|세요)?(?![가-힣])|(?<![가-힣])(?:안\s*해|안해)(?:요|라)?(?![가-힣])/;
/** A negated deny ("거절하지 마", "거절 안 해", "취소 안 할래"): the "하지 마" / "안 해" negates the refusal itself. */
const NEGATED_DENY =
  /(?:거절|거부|취소)(?:하|시키)?지\s*(?:마|말|않)|(?:거절|거부|취소)\s*(?:안\s+(?:할|해|하|돼|됨|됩|될)|안(?:해|할|돼|됨|됩|될)|않|못\s*(?:해|하|할))/;

function hasExplicitDenyVerb(t: string): boolean {
  if (t.search(NEGATED_APPROVE_VERB) >= 0) return true;
  for (const m of t.matchAll(DENY_VERB_STEM)) {
    if (!isNegated(t, m.index, m[0].length) && !NEGATED_DENY.test(t.slice(m.index))) return true;
  }
  return GENERIC_DENY_VERB.test(t) && !NEGATED_DENY.test(t);
}

/** An approve verb (round-3 rule d) that is not part of a negated approve ("승인 안 해" is a deny verb only). */
function hasApproveVerb(t: string): boolean {
  const rest = t.replace(NEGATED_APPROVE_VERB, ' ');
  // Loose stems on purpose: a conditional approval next to a deny verb ("승인하되 커밋은 하지 마") is ambiguous, never deny.
  return rest.search(APPROVE.loose) >= 0 || /(?<![가-힣])실행(?:해|하자|할게|시켜)/.test(rest);
}

/** Round-3 rule b: the whole message is a bare deny word (with punctuation or a polite ending), optionally followed by
 *  stop words only ("아니 됐어", "no, stop"). */
const BARE_DENY_WORD = /^(?:아니(?:요|에요|오|야)?|아뇨|노|no|nope|nah)(?=$|[^가-힣a-z0-9])/;

function isBareDenyWord(t: string): boolean {
  const match = BARE_DENY_WORD.exec(t);
  if (match === null) return false;
  const rest = t
    .slice(match[0].length)
    .replace(/(?<![가-힣a-z])(?:thanks|thank\s+you|감사합니다|고마워요|고마워)(?![가-힣a-z])/g, ' ')
    .replace(/[^가-힣a-z0-9]+/g, ' ')
    .trim();
  return rest.length === 0 || isPendingCancelUtterance(rest);
}

/** The explicit decision vocabulary a stand-alone utterance must contain to count as a STRAY decision (QA-018).
 *  Deliberately narrower than the decision phrases above: conversational replies ("좋아", "네", "아니", "no",
 *  "그만", "stop") stay ordinary chat when nothing is pending. */
const STRAY_DECISION_KEYWORDS = matchersFor([
  '승인', '진행', '거절', '거부', '취소', '철회',
  'approve', 'approved', 'proceed', 'go ahead', 'ok', 'okay',
  'deny', 'denied', 'reject', 'rejected', 'refuse', 'refused', 'cancel', 'abort',
]);

/** A stray decision is a short message: a whole-message "승인" / "거절해 주세요" / "ok thanks", never a sentence. */
const MAX_STRAY_DECISION_LENGTH = 30;

/**
 * QA-018: a message that is ESSENTIALLY just an approval decision word ("승인", "거절", "취소해줘", "approve",
 * "ok") — used only when NO approval or anchor is pending, so the runtime can answer deterministically that
 * there is nothing to decide instead of letting a chat model invent "승인이 접수되었습니다.". Pure.
 *
 * Narrow on purpose: the message must (1) be short, (2) be read by {@link interpretApprovalDecision} as a
 * decision, (3) contain an explicit decision keyword, and (4) contain nothing but decision words, fillers and
 * punctuation. So "승인 절차가 뭐야?", "승인 절차 설명해줘" and "회의 취소해줘" are NOT stray decisions.
 */
export function interpretStrayDecisionUtterance(text: string): Exclude<ApprovalDecisionResult, 'ambiguous'> | null {
  const t = text.trim().toLowerCase();
  if (t.length === 0 || t.length > MAX_STRAY_DECISION_LENGTH) return null;
  const decision = interpretApprovalDecision(t);
  if (decision === 'ambiguous') return null;
  if (t.search(STRAY_DECISION_KEYWORDS.exact) < 0) return null;
  const remainder = t
    .replace(APPROVE.exact, ' ')
    .replace(DENY.exact, ' ')
    .replace(CANCEL.exact, ' ')
    .replace(/[^가-힣a-z0-9]+/g, ' ')
    .replace(APPROVE_FILLER_TOKEN, ' ')
    .replace(APPROVE_FILLER_TOKEN, ' ');
  return remainder.trim().length === 0 ? decision : null;
}

/**
 * Live QA session 4 (N2): whole-message "stop / never mind" words that close a pending connector-write request or a
 * pending numbered calendar choice ("그만", "취소", "아니", "됐어", "cancel", "stop"). Wider than the stray-decision
 * vocabulary on purpose: it is consulted ONLY while such a request or choice is pending, where these words can only
 * mean "drop it" — closing is non-mutating (nothing is sent or changed). With nothing pending they stay ordinary chat.
 * A negated form ("그만하지 마") or anything else in the message ("그만 다른 거 보여줘") is not a cancel.
 */
const PENDING_CANCEL = matchersFor([
  '그만', '그만해', '그만할게', '그만둘게', '그만두자', '취소', '아니', '아뇨', '됐어', '됐다', '괜찮아',
  'cancel', 'stop', 'no', 'nope', 'never mind', 'nevermind', 'forget it',
]);
const PENDING_CANCEL_FILLER = new RegExp(`${TOKEN_BEFORE}(?:이제|그냥|좀|일단|그거|please|just)${TOKEN_AFTER}`, 'g');

export function isPendingCancelUtterance(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0 || t.length > MAX_STRAY_DECISION_LENGTH || QUESTION.test(t)) return false;
  if (t.search(PENDING_CANCEL.exact) < 0) return false;
  const remainder = t
    .replace(PENDING_CANCEL.exact, ' ')
    .replace(/[^가-힣a-z0-9]+/g, ' ')
    .replace(PENDING_CANCEL_FILLER, ' ');
  return remainder.trim().length === 0;
}

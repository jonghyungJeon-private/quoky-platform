import type { InboundQuotedRange } from '../../domain';
import { hasUntrustedSpanMarker } from '../agent/summary-grant';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import type { BoundConsent, ConsentClaim, ConsentLanguage, ConsentPending, ConsentPendingStore, ConsentScope } from './consent-pending';

/**
 * ADR-0121 amendment A6 (ratified 2026-11-23 with AM-1..AM-3; follow-up answers r-01..r-04 of 2026-11-24), slice A6-S1
 * "answer-checks": the owner's answer to a pending rule-① summary consent or A2 topic consent (A6.3 as amended by R3).
 *
 * Order, every step deterministic except the classifier, which is behind `QUOKY_CONSENT_ANSWER_CLASSIFIER` (default
 * `off`) and is not built in this slice (A6-S2):
 * 1. **Claim** ({@link ConsentPendingStore.claim}): the next owner turn of the same owner DM within W2 claims the step
 *    atomically (`open` → `answering`). A lost claim is not an answer: the turn takes the normal path.
 * 2. **Caps (a6-05, R5).** More than 3 non-empty lines or 60 characters is not an answer: the consent is cancelled and the
 *    message takes the normal path as a new request, never consumed by the consent.
 * 3. **Structural checks.** Not quote-only or empty (`prepareSelectionInput` skip), no untrusted-span marker
 *    (`hasUntrustedSpanMarker`, its four forms), no format character `\p{Cf}` in the RAW reply (a zero-width or direction
 *    mark), no attachment. Any failure cancels; the classifier is never called.
 * 4. **The fast path.** NFKC, then NFC, trim and one trailing `.` `!` `~` `?` removed, then the ratified closed tokens (A2
 *    answer 2, SR-1 W1): yes `응` `네` `예` `yes`, no `아니` `아니요` `아니오` `아뇨` `취소` `no`. NFKC folds compatibility forms
 *    only (fullwidth `ｙｅｓ`); a cross-script look-alike stays no token. A closed yes binds, a closed no cancels.
 * 5. **Switch off** (the default): any other reply cancels, exactly as W1 as built.
 *    **Switch on**: the classifier's closed label (`yes`, `yes-and-more`, `no`, `other`, `unclear`; anything else, a throw
 *    included, is `unclear`). It sees only the consent kind, the language and the reply: no item, topic, count or history.
 * 6. **Bind** ({@link ConsentPendingStore.bind}): compare-and-set from `answering`; a failed bind sends nothing.
 *    `yes-and-more` (AM-2) binds the same way and then the message runs again as a NEW ordinary turn (the step is `used`,
 *    so that turn can never answer, widen or revive it): the whole message (r-01), or, when the reply has more than one
 *    line and its first line is a closed yes token, the remaining lines only (r-02, a rule-based cut, never the classifier).
 *
 * After a cancel: a multi-line reply within the caps is consumed and NOT re-planned (`462` as built); a single-line `other`,
 * structural failure or switch-off reply takes the normal path (`472`, `473` as built); a no is the answer and is consumed.
 * `unclear` re-asks the fixed question once ({@link consentReaskQuestion}); a second `unclear` cancels. The audit carries
 * closed codes only ({@link ConsentAnswerCode}), never the reply text.
 */

/** The closed audit codes (A6.3, R3; `classifier-off` names the switch-off cancel, which A6.3 leaves without a code). */
export const CONSENT_ANSWER_CODES = [
  'closed-yes',
  'closed-no',
  'classifier-yes',
  'classifier-yes-and-more',
  'classifier-no',
  'classifier-other',
  'classifier-unclear',
  'classifier-off',
  'structural-fail',
  'over-caps',
  'claim-lost',
  'reask',
] as const;
export type ConsentAnswerCode = (typeof CONSENT_ANSWER_CODES)[number];

/** The classifier's closed labels (A6.3 step 3 as amended by AM-2). */
export const CONSENT_ANSWER_LABELS = ['yes', 'yes-and-more', 'no', 'other', 'unclear'] as const;
export type ConsentAnswerLabel = (typeof CONSENT_ANSWER_LABELS)[number];

/** a6-05 (R5): a reply to a pending consent holds at most 3 non-empty lines and 60 characters. */
export const CONSENT_REPLY_MAX_LINES = 3;
export const CONSENT_REPLY_MAX_CHARS = 60;

/** The content-free classifier request (A6.4): never an item, a topic, a count, a source content or the history. */
export interface ConsentClassifierRequest {
  readonly consent: ConsentPending['kind'];
  readonly language: ConsentLanguage;
  readonly reply: string;
}

/** The classifier call (A6-S2). Its result is read strictly: only a closed label string counts. */
export type ConsentAnswerClassifier = (request: ConsentClassifierRequest) => Promise<unknown>;

/** `QUOKY_CONSENT_ANSWER_CLASSIFIER`, as the composition root read it. `off` is the default. */
export type ConsentClassifierSwitch = { readonly mode: 'off' } | { readonly mode: 'on'; readonly classify: ConsentAnswerClassifier };

/** One owner turn as the answer pipeline sees it: the RAW text, before any normalisation. */
export interface ConsentReplyTurn {
  readonly scope: ConsentScope;
  /** Whether the turn is a direct message of the owner (a channel or group turn never answers; the step stays). */
  readonly ownerDm: boolean;
  readonly text: string;
  readonly atMs: number;
  readonly attachmentCount?: number;
  readonly quotedRanges?: readonly InboundQuotedRange[];
}

/** What the caller does with the turn after the answer pipeline. */
export type ConsentTurnDecision =
  /** No step was claimed: handle the turn as an ordinary message. */
  | { readonly kind: 'not-an-answer'; readonly audit: readonly ConsentAnswerCode[]; readonly next: 'ordinary' }
  /** The step is bound: run exactly its items (or topic) once. `rerun`: then run that text as a new ordinary turn (AM-2). */
  | {
      readonly kind: 'bound';
      readonly audit: readonly ConsentAnswerCode[];
      readonly bound: BoundConsent;
      readonly next: 'consumed' | 'rerun';
      readonly rerunText?: string;
    }
  /** The step is cancelled: nothing is sent. `ordinary`: the turn takes the normal path; `consumed`: it is not re-planned. */
  | { readonly kind: 'cancelled'; readonly audit: readonly ConsentAnswerCode[]; readonly next: 'ordinary' | 'consumed' }
  /** The step was replaced by its one fixed re-ask: show `question`; nothing is sent. */
  | { readonly kind: 'reask'; readonly audit: readonly ConsentAnswerCode[]; readonly pending: ConsentPending; readonly question: string; readonly next: 'consumed' };

/** Every line or paragraph separator a reply may carry (the caps count lines over all of them). */
const LINE_BREAKS = /[\n\r\u2028\u2029\u0085\v\f]+/u;
const FIRST_LINE = /^([^\n\r\u2028\u2029\u0085\v\f]*)(\r\n|[\n\r\u2028\u2029\u0085\v\f])/u;
const FORMAT_CHARACTER = /\p{Cf}/u;
const CLOSED_YES: readonly string[] = ['응', '네', '예', 'yes'];
const CLOSED_NO: readonly string[] = ['아니', '아니요', '아니오', '아뇨', '취소', 'no'];

function nonEmptyLines(text: string): string[] {
  return text.split(LINE_BREAKS).filter((line) => line.trim().length > 0);
}

/**
 * The fast path (A6.3 step 2): the ratified closed tokens after NFKC (compatibility forms of the same letters only), NFC,
 * trim and one trailing `.` `!` `~` `?` removed; Latin tokens in any case. `undefined`: no closed token. Pure.
 */
export function closedConsentToken(reply: string): 'yes' | 'no' | undefined {
  let folded = reply.normalize('NFKC').normalize('NFC').trim();
  if (/[.!~?]$/u.test(folded)) folded = folded.slice(0, -1);
  const lower = folded.toLowerCase();
  if (CLOSED_YES.includes(lower)) return 'yes';
  if (CLOSED_NO.includes(lower)) return 'no';
  return undefined;
}

export type ConsentReplyShape = { readonly kind: 'answer'; readonly lines: number } | { readonly kind: 'over-caps' } | { readonly kind: 'structural-fail'; readonly lines: number };

/** A6.3 step 1 (caps first, R5; then the structural checks) on the RAW reply. No model call. Pure. */
export function consentReplyShape(turn: Pick<ConsentReplyTurn, 'text' | 'attachmentCount' | 'quotedRanges'>): ConsentReplyShape {
  const lines = nonEmptyLines(turn.text).length;
  if (lines > CONSENT_REPLY_MAX_LINES || Array.from(turn.text.trim()).length > CONSENT_REPLY_MAX_CHARS) return { kind: 'over-caps' };
  if (FORMAT_CHARACTER.test(turn.text) || (turn.attachmentCount ?? 0) > 0) return { kind: 'structural-fail', lines };
  const prepared = prepareSelectionInput(turn.text, 0, turn.quotedRanges ?? []);
  if ('skip' in prepared || hasUntrustedSpanMarker(prepared.text)) return { kind: 'structural-fail', lines };
  return { kind: 'answer', lines };
}

/** A6.3 step 4: the fixed re-ask question (no item, count or topic in it). */
export function consentReaskQuestion(language: ConsentLanguage): string {
  return language === 'ko' ? '보낼까요? (응/아니)' : 'Shall I send it? (yes/no)';
}

/** Strict read of the classifier's result: a closed label string, else `unclear` (fail closed). */
export function consentAnswerLabel(raw: unknown): ConsentAnswerLabel {
  return typeof raw === 'string' && (CONSENT_ANSWER_LABELS as readonly string[]).includes(raw) ? (raw as ConsentAnswerLabel) : 'unclear';
}

/**
 * r-02 (2026-11-24): the text a `yes-and-more` reply reruns. When the reply has more than one line and its first line is a
 * closed yes token, only the text after that first line and its terminator runs, byte-identical (a rule-based cut); otherwise the whole message runs (r-01). Pure.
 */
export function consentRerunText(reply: string): string {
  const first = FIRST_LINE.exec(reply);
  if (first === null || closedConsentToken(first[1] ?? '') !== 'yes') return reply;
  // Only the first line and its own terminator (a CRLF as a unit) are removed; the remainder is returned byte-identical.
  const rest = reply.slice(first[0].length);
  return rest.trim().length > 0 ? rest : reply;
}

async function classifyStrict(classify: ConsentAnswerClassifier, request: ConsentClassifierRequest): Promise<ConsentAnswerLabel> {
  try {
    return consentAnswerLabel(await classify(request));
  } catch {
    return 'unclear';
  }
}

function bindOrLost(
  store: ConsentPendingStore,
  claim: ConsentClaim,
  atMs: number,
  code: 'closed-yes' | 'classifier-yes' | 'classifier-yes-and-more',
  rerunText?: string,
): ConsentTurnDecision {
  const bound = store.bind(claim, atMs);
  // A failed compare-and-set (cancelled by a newer turn, voided, superseded or late): the answer is discarded, nothing is sent.
  if (bound === undefined) return { kind: 'cancelled', audit: [code, 'claim-lost'], next: 'consumed' };
  return rerunText === undefined ? { kind: 'bound', audit: [code], bound, next: 'consumed' } : { kind: 'bound', audit: [code], bound, next: 'rerun', rerunText };
}

/**
 * The A6.3 pipeline for one owner turn. The time of every bind (and of the re-ask) is a fresh `now()` read (default: the real
 * clock), never the message's arrival time, so a late label or a slow turn cannot bind a step at or past W2. The classifier is called only with the switch on, at most once per turn.
 */
export async function answerConsentTurn(
  store: ConsentPendingStore,
  turn: ConsentReplyTurn,
  classifier: ConsentClassifierSwitch,
  now: () => number = () => Date.now(),
): Promise<ConsentTurnDecision> {
  if (!turn.ownerDm) return { kind: 'not-an-answer', audit: [], next: 'ordinary' };
  const claimed = store.claim(turn.scope, turn.atMs);
  if (!claimed.ok) return { kind: 'not-an-answer', audit: claimed.reason === 'claim-lost' ? ['claim-lost'] : [], next: 'ordinary' };
  const { claim } = claimed;
  try {
    return await decideClaimed(store, claim, turn, classifier, now);
  } catch (error) {
    // Any throw after the claim (a caller clock included) releases the step instead of leaving it `answering`.
    store.cancel(claim);
    throw error;
  }
}

async function decideClaimed(
  store: ConsentPendingStore,
  claim: ConsentClaim,
  turn: ConsentReplyTurn,
  classifier: ConsentClassifierSwitch,
  now: () => number,
): Promise<ConsentTurnDecision> {
  const shape = consentReplyShape(turn);
  if (shape.kind === 'over-caps') {
    store.cancel(claim);
    return { kind: 'cancelled', audit: ['over-caps'], next: 'ordinary' };
  }
  const afterCancel = (lines: number): 'ordinary' | 'consumed' => (lines > 1 ? 'consumed' : 'ordinary');
  if (shape.kind === 'structural-fail') {
    store.cancel(claim);
    return { kind: 'cancelled', audit: ['structural-fail'], next: afterCancel(shape.lines) };
  }
  const closed = closedConsentToken(turn.text);
  if (closed === 'yes') return bindOrLost(store, claim, now(), 'closed-yes');
  if (closed === 'no') {
    store.cancel(claim);
    return { kind: 'cancelled', audit: ['closed-no'], next: 'consumed' };
  }
  if (classifier.mode !== 'on') {
    store.cancel(claim);
    return { kind: 'cancelled', audit: ['classifier-off'], next: afterCancel(shape.lines) };
  }
  const label = await classifyStrict(classifier.classify, { consent: claim.pending.kind, language: claim.pending.language, reply: turn.text });
  // Freshness is judged on a fresh clock read after the classifier, never on the arrival time of the message.
  const atMs = now();
  switch (label) {
    case 'yes':
      return bindOrLost(store, claim, atMs, 'classifier-yes');
    case 'yes-and-more':
      return bindOrLost(store, claim, atMs, 'classifier-yes-and-more', consentRerunText(turn.text));
    case 'no':
      store.cancel(claim);
      return { kind: 'cancelled', audit: ['classifier-no'], next: 'consumed' };
    case 'other':
      store.cancel(claim);
      return { kind: 'cancelled', audit: ['classifier-other'], next: afterCancel(shape.lines) };
    case 'unclear': {
      if (claim.pending.reasked) {
        const lost = !store.holds(claim);
        store.cancel(claim);
        return { kind: 'cancelled', audit: lost ? ['classifier-unclear', 'claim-lost'] : ['classifier-unclear'], next: 'consumed' };
      }
      const pending = store.reask(claim, atMs);
      if (pending === undefined) return { kind: 'cancelled', audit: ['classifier-unclear', 'claim-lost'], next: 'consumed' };
      return { kind: 'reask', audit: ['classifier-unclear', 'reask'], pending, question: consentReaskQuestion(pending.language), next: 'consumed' };
    }
  }
}

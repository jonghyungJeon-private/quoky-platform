import type { InboundQuotedRange } from '../../domain';
import { hasUntrustedSpanMarker } from '../agent/summary-grant';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { buildConsentClassifierRequest } from './consent-classifier';
import { CONSENT_ANSWER_LABELS, type ConsentAnswerLabel, type ConsentChatFacts, type ConsentClassifierContext, type ConsentClassifierRequest } from './consent-labels';
import { recordOwnerYes } from './consent-yes';
import type { BoundConsent, ConsentClaim, ConsentLanguage, ConsentPending, ConsentPendingStore, ConsentScope } from './consent-pending';

/**
 * ADR-0121 amendment A6 (ratified 2026-11-23 with AM-1..AM-3; follow-up answers r-01..r-04 of 2026-11-24), slice A6-S1
 * "answer-checks": the owner's answer to a pending rule-① summary consent or A2 topic consent (A6.3 as amended by R3).
 *
 * Order, every step deterministic except the classifier, which is behind `QUOKY_CONSENT_ANSWER_CLASSIFIER` (default
 * `off`) (built in A6-S2, `consent-classifier.ts`; no live path calls it yet):
 * 1. **Claim** ({@link ConsentPendingStore.claim}): the next owner turn of the same owner DM within W2 claims the step
 *    atomically (`open` → `answering`). A lost claim is not an answer: the turn takes the normal path.
 * 2. **Caps (a6-05, R5).** More than 3 non-empty lines or 60 characters is not an answer: the consent is cancelled and the
 *    message takes the normal path as a new request, never consumed by the consent.
 * 3. **Structural checks.** Not quote-only or empty (`prepareSelectionInput` skip), no untrusted-span marker
 *    (`hasUntrustedSpanMarker(…, { contractions: true })`, its four forms; a letter-flanked ASCII or U+2019 apostrophe is a
 *    contraction, not a quote, per the A6.3 contraction note), no format character `\p{Cf}` in the RAW reply (a zero-width or direction
 *    mark), no attachment. Any failure cancels; the classifier is never called.
 * 4. **The fast path.** NFKC, then NFC, trim and one trailing `.` `!` `~` `?` removed, then the ratified closed tokens (A2
 *    answer 2, SR-1 W1): yes `응` `네` `예` `yes`, no `아니` `아니요` `아니오` `아뇨` `취소` `no`. NFKC folds compatibility forms
 *    only (fullwidth `ｙｅｓ`); a cross-script look-alike stays no token. A closed yes binds, a closed no cancels.
 * 5. **Handler claim** (switch on only): a turn a registered handler's `surfaceClaim` claims (lazy turn fact `handlerClaimed`, read only here)
 *    is `other` (audit `handler-claimed`); the classifier is not called.
 *    **Switch off** (the default): any other reply cancels, exactly as W1 as built.
 *    **Switch on**: the classifier's closed label (`yes`, `yes-and-more`, `no`, `other`, `unclear`; anything else, a throw
 *    included, is `unclear`). It sees only the fixed question with placeholders and the reply (A6-S2): no item, topic, count or history.
 * 6. **Bind** ({@link ConsentPendingStore.bind}): compare-and-set from `answering`; a failed bind sends nothing.
 *    `yes-and-more` (AM-2) binds the same way and then the message runs again as a NEW ordinary turn (the step is `used`,
 *    so that turn can never answer, widen or revive it): the whole message (r-01), or, when the reply has more than one
 *    line and its first line is a closed yes token, the remaining lines only (r-02, a rule-based cut, never the classifier).
 *
 * After a cancel: a multi-line reply within the caps is consumed and NOT re-planned (`462` as built); a single-line `other`,
 * structural failure or switch-off reply takes the normal path (`472`, `473` as built); a no is the answer and is consumed.
 * Step 5 cap (A6.3 standalone vowel jamo note, owner 2026-11-28): a classifier `yes`/`yes-and-more` on a reply with a standalone Hangul
 * vowel jamo ({@link hasStandaloneHangulVowelJamo}) is lowered to `unclear` (audit `jamo-vowel-cap`); switch off, the classifier is not called.
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
  'jamo-vowel-cap',
  'classifier-off',
  'handler-claimed',
  'structural-fail',
  'over-caps',
  'claim-lost',
  'reask',
] as const;
export type ConsentAnswerCode = (typeof CONSENT_ANSWER_CODES)[number];

export { CONSENT_ANSWER_LABELS };
export type { ConsentAnswerLabel, ConsentClassifierRequest };

/** a6-05 (R5): a reply to a pending consent holds at most 3 non-empty lines and 60 characters. */
export const CONSENT_REPLY_MAX_LINES = 3;
export const CONSENT_REPLY_MAX_CHARS = 60;

/** The classifier call (A6-S2). Its result is read strictly: only a closed label string counts. */
export type ConsentAnswerClassifier = (request: ConsentClassifierRequest, context?: ConsentClassifierContext) => Promise<unknown>;

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
  /**
   * A6 classifier wiring (CS-2 residual): a registered turn handler's pure `surfaceClaim` claims this turn, decided by the runtime
   * (never recomputed here from platform types). With the switch on, such a turn is `other` and the classifier is not called.
   */
  readonly handlerClaimed?: () => boolean;
  /**
   * The chat provider facts of this turn, resolved lazily by the runtime. Called only on the enabled classifier path (after the fast path
   * and the handler claim, switch on, a step open, owner DM), once per turn, and only when a classifier call is about to be made.
   */
  readonly chat?: () => Promise<ConsentChatFacts | undefined>;
  /** Charges ONE model call to the actor's hourly cap, leaving the continuation its call; `false`: no call (A6 classifier wiring). */
  readonly charge?: () => boolean;
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

const WORD_RUN = /[\p{L}\p{M}]+/gu;
// A script predicate counts only on a LETTER: a Cyrillic or Greek combining mark (script Cyrillic/Greek/Inherited) is not one.
const LATIN_LETTER = /(?=\p{L})\p{sc=Latin}/u;
const LOOKALIKE_LETTER = /(?=\p{L})[\p{sc=Cyrillic}\p{sc=Greek}]/u;

/**
 * A6.3 step 1 mixed-script check (owner ratification 2026-11-27; Unicode UTS #39 mixed-script precedent): true when one word
 * (a maximal run of letters and combining marks) holds at least one Latin letter and at least one Cyrillic or Greek letter (marks only join the word, they are never the letter),
 * judged on the NFC form of the RAW reply and on its NFKC form. Script property only; pure Cyrillic or Greek words, Latin with
 * Hangul and Latin and Cyrillic in separate words are not flagged. Pure.
 */
export function hasMixedScriptWord(text: string): boolean {
  for (const form of [text.normalize('NFC'), text.normalize('NFKC')]) {
    for (const word of form.match(WORD_RUN) ?? []) {
      if (LATIN_LETTER.test(word) && LOOKALIKE_LETTER.test(word)) return true;
    }
  }
  return false;
}

// Standalone vowel jamo by Unicode block (A6.3 standalone vowel jamo note): compatibility vowels, archaic compatibility vowels, conjoining
// medial vowels (U+1160 JUNGSEONG FILLER excluded: invisible, not a vowel; NFKC maps U+3164/U+FFA0 to it), Jamo Extended-B medial vowels, halfwidth vowels. A character class, never a word list.
/** Version of the cap's rule (range/normalization); the eval plan binds it, so a change to the regex must bump it. */
export const CONSENT_JAMO_VOWEL_CAP_VERSION = 'jamo-vowel-cap.v2';
const STANDALONE_VOWEL_JAMO = /[\u314F-\u3163\u3187-\u318E\u1161-\u11A7\uD7B0-\uD7C6\uFFC2-\uFFDC]/u;

/**
 * A6.3 step 5 cap predicate (owner ratification 2026-11-28): true when the reply holds a Hangul vowel jamo that is not composed into a
 * syllable. NFC composes a conjoining lead + vowel into a syllable, so any vowel left is standalone; the NFKC form is checked too. Pure.
 */
export function hasStandaloneHangulVowelJamo(reply: string): boolean {
  return [reply.normalize('NFC'), reply.normalize('NFKC')].some((form) => STANDALONE_VOWEL_JAMO.test(form));
}

/** The post-classifier cap: a binding label (`yes`, `yes-and-more`) on a reply with a standalone vowel jamo is `unclear`; any other label is unchanged. Pure. */
export function capConsentLabelForJamoVowel(label: ConsentAnswerLabel, reply: string): ConsentAnswerLabel {
  return (label === 'yes' || label === 'yes-and-more') && hasStandaloneHangulVowelJamo(reply) ? 'unclear' : label;
}

export type ConsentReplyShape = { readonly kind: 'answer'; readonly lines: number } | { readonly kind: 'over-caps' } | { readonly kind: 'structural-fail'; readonly lines: number };

/** A6.3 step 1 (caps first, R5; then the structural checks) on the RAW reply. No model call. Pure. */
export function consentReplyShape(turn: Pick<ConsentReplyTurn, 'text' | 'attachmentCount' | 'quotedRanges'>): ConsentReplyShape {
  const lines = nonEmptyLines(turn.text).length;
  if (lines > CONSENT_REPLY_MAX_LINES || Array.from(turn.text.trim()).length > CONSENT_REPLY_MAX_CHARS) return { kind: 'over-caps' };
  if (FORMAT_CHARACTER.test(turn.text) || (turn.attachmentCount ?? 0) > 0) return { kind: 'structural-fail', lines };
  const prepared = prepareSelectionInput(turn.text, 0, turn.quotedRanges ?? []);
  if ('skip' in prepared || hasUntrustedSpanMarker(prepared.text, { contractions: true })) return { kind: 'structural-fail', lines };
  if (hasMixedScriptWord(turn.text)) return { kind: 'structural-fail', lines };
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

async function classifyStrict(classify: ConsentAnswerClassifier, request: ConsentClassifierRequest, turn: ConsentReplyTurn): Promise<ConsentAnswerLabel> {
  try {
    // The chat fact stays a thunk: the adapter resolves it after its no-call checks and inside its deadline.
    const context: ConsentClassifierContext = { ...(turn.chat !== undefined ? { resolveChat: turn.chat } : {}), charge: turn.charge ?? (() => false) };
    return consentAnswerLabel(await classify(request, context));
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
  // The only place a yes is recorded: every caller of bindOrLost is a yes path.
  recordOwnerYes(bound);
  return rerunText === undefined ? { kind: 'bound', audit: [code], bound, next: 'consumed' } : { kind: 'bound', audit: [code], bound, next: 'rerun', rerunText };
}

/**
 * The A6.3 pipeline for one owner turn. The time of the claim, of every bind and of the re-ask is a fresh `now()` read (default: the real
 * clock), never the message's arrival time, so a late label or a slow turn cannot bind a step at or past W2. The classifier is called only with the switch on, at most once per turn.
 */
export async function answerConsentTurn(
  store: ConsentPendingStore,
  turn: ConsentReplyTurn,
  classifier: ConsentClassifierSwitch,
  now: () => number = () => Date.now(),
): Promise<ConsentTurnDecision> {
  if (!turn.ownerDm) return { kind: 'not-an-answer', audit: [], next: 'ordinary' };
  // One clock domain for the whole pipeline: the claim and the bind both judge freshness on `now()` (read afresh each time).
  let claimAtMs: number;
  try {
    claimAtMs = now();
  } catch (error) {
    // A turn that cannot be judged still consumes the chance to answer: an earlier in-flight label must never bind after it.
    store.forfeit(turn.scope);
    throw error;
  }
  const claimed = store.claim(turn.scope, claimAtMs);
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
  // The structural rule (A6 classifier wiring): after the closed-token fast path (a closed yes a listing handler also claims has bound
  // above) and before the model call, a turn a registered handler claims is a new request: `other`, no call, no cap charge.
  if (claimedByHandler(turn)) {
    store.cancel(claim);
    return { kind: 'cancelled', audit: ['handler-claimed'], next: afterCancel(shape.lines) };
  }
  const rawLabel = await classifyStrict(classifier.classify, buildConsentClassifierRequest(claim.pending, turn.text), turn);
  const label = capConsentLabelForJamoVowel(rawLabel, turn.text);
  const unclearCode = label !== rawLabel ? 'jamo-vowel-cap' : 'classifier-unclear';
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
        return { kind: 'cancelled', audit: lost ? [unclearCode, 'claim-lost'] : [unclearCode], next: 'consumed' };
      }
      const pending = store.reask(claim, atMs);
      // Lost or expired (late or non-finite clock): the step is not re-asked; an expiry reports `claim-lost` like a late bind.
      if (pending === undefined) return { kind: 'cancelled', audit: [unclearCode, 'claim-lost'], next: 'consumed' };
      return { kind: 'reask', audit: [unclearCode, 'reask'], pending, question: consentReaskQuestion(pending.language), next: 'consumed' };
    }
  }
}

/** The lazy handler-claim fact, read only on the enabled classifier path; a throw claims nothing (the registry walk is pure and total). */
function claimedByHandler(turn: ConsentReplyTurn): boolean {
  try {
    return turn.handlerClaimed?.() === true;
  } catch {
    return false;
  }
}

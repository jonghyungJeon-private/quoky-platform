/**
 * ADR-0121 amendment A6 (ratified 2026-11-23 with AM-1..AM-3; DECISIONS "ADR-0121 amendments A5 and A6 ratification record"
 * R3 and R10), slice A6-S1 "answer-checks": the two pending consent steps and their atomic state.
 *
 * - **Branded pending types (A6.2, as amended by AM-1).** {@link SummaryConsentPending} (the rule-① remote-summary consent) and
 *   {@link TopicConsentPending} (the ADR-0121 A2 topic consent) are distinct branded types made only by their own producers
 *   ({@link summaryConsentPending}, {@link topicConsentPending}); a producer also records the object in a module-private
 *   registry, so a structurally copied object is refused at run time too. No other pending step (approval, undo, handoff
 *   pick, request-list number, channel grant) has the brand, so none can be opened in the {@link ConsentPendingStore} or
 *   reach the answer function. `SummaryConsentPending` has **no `origin` field** (AM-1, R10): how the grant was minted is
 *   never an input of the answer.
 * - **The atomic claim and the compare-and-set bind (A6.3 steps 1, 4 and 5).** One pending step per (actor, conversation).
 *   The next owner turn claims it by moving it from `open` to `answering` on its version; the bind re-checks, by
 *   compare-and-set from `answering` on the same version, that it is still fresh (W2, 600 s), unused and not voided, and
 *   marks it `used`. A turn that arrives while the step is `answering` cancels it, so the in-flight answer's bind fails and
 *   nothing is sent. The kill switch voids every open or answering step; a restart drops the in-memory store.
 * - **Nothing REMOTE can bind yet.** CS-1a (the rule-① confirm slice, ask half) opens a summary consent from `AgentRunService`
 *   (the one allowlisted importer, pinned by `consent-answer.boundary.test.ts`); nothing answers or binds it until CS-2 (the
 *   runtime gate), and the continuation that sends is CS-1b. The A2 topic consent is not built.
 *
 * Pure, in-memory, no I/O, no clock of its own (every time is the caller's `atMs`), no provider or platform branch.
 */
import { isConsentSource, type ConsentSource } from './consent-labels';

declare const SUMMARY_CONSENT_BRAND: unique symbol;
declare const TOPIC_CONSENT_BRAND: unique symbol;
declare const CLAIM_BRAND: unique symbol;
declare const BOUND_BRAND: unique symbol;

/** W2: only the next owner turn of the same owner DM within 600 s answers a consent (age 600 s is already late). */
export const CONSENT_ANSWER_WINDOW_MS = 600_000;

/** Who may answer: the owner actor in one conversation (the owner DM the question was asked in). Opaque strings. */
export interface ConsentScope {
  readonly actorId: string;
  readonly conversationKey: string;
}

export type ConsentLanguage = 'ko' | 'en';

interface ConsentPendingCommon {
  readonly scope: ConsentScope;
  readonly language: ConsentLanguage;
  /** When the question was asked (or re-asked): W2 starts here. */
  readonly createdAtMs: number;
  /** The named recipient's display name (provider data, shown in the question); never branched on. */
  readonly recipient: string;
  /** Whether this step is the one fixed re-ask of an earlier step (A6.3 step 4: a second `unclear` cancels). */
  readonly reasked: boolean;
}

/** One source of a rule-① summary consent and the ids of its items. */
export interface SummaryConsentPendingSource {
  readonly source: ConsentSource;
  readonly itemIds: readonly string[];
}

/** The rule-① remote-summary consent: exactly these listed items of these sources, once (W3, W5). No `origin` (AM-1). */
export interface SummaryConsentPending extends ConsentPendingCommon {
  readonly kind: 'summary-consent';
  /**
   * Per source (R1 item 5, CS-1a): the closed source and the ids of exactly the items the question counted (1..10, distinct).
   * Ids only, never content.
   */
  readonly sources: readonly SummaryConsentPendingSource[];
  /** An opaque id (the shared id utility) of the run whose continuation record this step belongs to; it survives the re-ask. */
  readonly runRef: string;
  readonly [SUMMARY_CONSENT_BRAND]: true;
}

/** The ADR-0121 A2 topic consent: exactly this displayed topic, once. */
export interface TopicConsentPending extends ConsentPendingCommon {
  readonly kind: 'topic-consent';
  readonly topic: string;
  readonly [TOPIC_CONSENT_BRAND]: true;
}

/** The only two pending steps the A6 answer pipeline accepts (A6.2). */
export type ConsentPending = SummaryConsentPending | TopicConsentPending;

/** A claim of one pending step for one owner turn (`answering` at `version`). Made only by {@link ConsentPendingStore.claim}. */
export interface ConsentClaim {
  readonly pending: ConsentPending;
  readonly version: number;
  readonly [CLAIM_BRAND]: true;
}

/** A bound consent: the step was `used` by a compare-and-set bind. Made only by {@link ConsentPendingStore.bind}. */
export interface BoundConsent {
  readonly pending: ConsentPending;
  readonly boundAtMs: number;
  readonly [BOUND_BRAND]: true;
}

/** Closed reasons a producer refuses its input (value-free). */
export type ConsentPendingInvalid = 'scope' | 'language' | 'time' | 'recipient' | 'items' | 'sources' | 'topic' | 'run';

export class ConsentPendingInvalidError extends Error {
  constructor(readonly code: ConsentPendingInvalid) {
    super(`consent-pending-invalid:${code}`);
    this.name = 'ConsentPendingInvalidError';
  }
}

const MINTED = new WeakSet<object>();

/** Bound consents made by the real {@link ConsentPendingStore.prototype.bind} (via {@link sealBound}); not reachable by an instance override. */
const SEALED_BOUND = new WeakSet<object>();

function sealBound(pending: ConsentPending, boundAtMs: number): BoundConsent {
  const bound = Object.freeze({ pending, boundAtMs }) as BoundConsent;
  SEALED_BOUND.add(bound);
  return bound;
}

/** Whether `value` is a bound consent the real store `bind` made over a minted pending step (provenance, not a yes). */
export function isStoreBound(value: unknown): value is BoundConsent {
  return typeof value === 'object' && value !== null && SEALED_BOUND.has(value) && isConsentPending((value as BoundConsent).pending);
}

/** Whether `value` was made by one of this module's producers (the run-time half of the brand). */
export function isConsentPending(value: unknown): value is ConsentPending {
  return typeof value === 'object' && value !== null && MINTED.has(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function commonOf(input: Omit<ConsentPendingCommon, 'reasked'>): Omit<ConsentPendingCommon, 'reasked'> {
  if (!nonEmpty(input.scope?.actorId) || !nonEmpty(input.scope?.conversationKey)) throw new ConsentPendingInvalidError('scope');
  if (input.language !== 'ko' && input.language !== 'en') throw new ConsentPendingInvalidError('language');
  if (!Number.isFinite(input.createdAtMs)) throw new ConsentPendingInvalidError('time');
  if (!nonEmpty(input.recipient)) throw new ConsentPendingInvalidError('recipient');
  return {
    scope: Object.freeze({ actorId: input.scope.actorId, conversationKey: input.scope.conversationKey }),
    language: input.language,
    createdAtMs: input.createdAtMs,
    recipient: input.recipient,
  };
}

function distinctNonEmpty(values: readonly unknown[] | undefined): values is readonly string[] {
  return Array.isArray(values) && values.length > 0 && values.every(nonEmpty) && new Set(values).size === values.length;
}

function mint<P extends ConsentPending>(value: Omit<P, typeof SUMMARY_CONSENT_BRAND | typeof TOPIC_CONSENT_BRAND>): P {
  const frozen = Object.freeze(value) as P;
  MINTED.add(frozen);
  return frozen;
}

/** The most item ids one source of a summary consent may hold (the item cap of a summary read). */
export const SUMMARY_CONSENT_MAX_ITEMS_PER_SOURCE = 10;

/** The rule-① summary consent producer (its caller is `AgentRunService`, CS-1a; the continuation is CS-1b). */
export function summaryConsentPending(input: {
  readonly scope: ConsentScope;
  readonly language: ConsentLanguage;
  readonly createdAtMs: number;
  readonly recipient: string;
  readonly sources: readonly SummaryConsentPendingSource[];
  readonly runRef: string;
}): SummaryConsentPending {
  const common = commonOf(input);
  if (!nonEmpty(input.runRef)) throw new ConsentPendingInvalidError('run');
  const sources: unknown = input.sources;
  if (!Array.isArray(sources) || sources.length === 0) throw new ConsentPendingInvalidError('sources');
  const names = (sources as readonly { readonly source?: unknown }[]).map((entry) => entry?.source);
  if (!distinctNonEmpty(names) || !names.every(isConsentSource)) throw new ConsentPendingInvalidError('sources');
  const checked = (sources as readonly SummaryConsentPendingSource[]).map((entry) => {
    if (!distinctNonEmpty(entry.itemIds) || entry.itemIds.length > SUMMARY_CONSENT_MAX_ITEMS_PER_SOURCE) throw new ConsentPendingInvalidError('items');
    return Object.freeze({ source: entry.source, itemIds: Object.freeze([...entry.itemIds]) });
  });
  return mint<SummaryConsentPending>({ kind: 'summary-consent', ...common, reasked: false, sources: Object.freeze(checked), runRef: input.runRef });
}

/** The A2 topic consent producer (its only caller will be the A2 answer slice; not built). */
export function topicConsentPending(input: {
  readonly scope: ConsentScope;
  readonly language: ConsentLanguage;
  readonly createdAtMs: number;
  readonly recipient: string;
  readonly topic: string;
}): TopicConsentPending {
  const common = commonOf(input);
  if (!nonEmpty(input.topic)) throw new ConsentPendingInvalidError('topic');
  return mint<TopicConsentPending>({ kind: 'topic-consent', ...common, reasked: false, topic: input.topic });
}

/** A6.3 step 4: the fixed re-ask replaces the step with the same items (or topic), the same recipient and the same `runRef`, and restarts W2. */
function reaskedCopy(pending: ConsentPending, atMs: number): ConsentPending {
  return pending.kind === 'summary-consent'
    ? mint<SummaryConsentPending>({ ...pending, createdAtMs: atMs, reasked: true })
    : mint<TopicConsentPending>({ ...pending, createdAtMs: atMs, reasked: true });
}

export type ConsentPendingState = 'open' | 'answering' | 'used' | 'cancelled' | 'voided' | 'expired';

interface ConsentRecord {
  readonly pending: ConsentPending;
  state: ConsentPendingState;
  version: number;
}

export type ConsentClaimResult =
  | { readonly ok: true; readonly claim: ConsentClaim }
  /** `no-pending`: nothing was asked in this scope. `claim-lost`: a step exists but cannot be answered (A6.3 step 1). */
  | { readonly ok: false; readonly reason: 'no-pending' | 'claim-lost' };

const scopeKey = (scope: ConsentScope): string => `${scope.actorId}\u0000${scope.conversationKey}`;
const fresh = (pending: ConsentPending, atMs: number): boolean =>
  Number.isFinite(atMs) && atMs >= pending.createdAtMs && atMs - pending.createdAtMs < CONSENT_ANSWER_WINDOW_MS;

/** Module-wide, never reused or reset (not per store, not when a record is deleted): a claim of one store never matches a version of another. */
let generation = 0;
const nextGeneration = (): number => (generation += 1);

/**
 * The pending consent steps, one per (actor, conversation), with their state machine:
 * `open` → `answering` (claim) → `used` (bind) | `cancelled` | `open` again as a re-asked step; `voided` by the kill switch;
 * `expired` past W2. A terminal step answers nothing: the next claim reports `claim-lost` once and forgets it.
 * JavaScript runs each method to completion, so the version compare-and-set is atomic within one process.
 */
export class ConsentPendingStore {
  private readonly records = new Map<string, ConsentRecord>();
  private nextVersion(): number {
    return nextGeneration();
  }

  /** Open a pending step (a newer step in the same scope supersedes the older one, whose claim can then never bind). */
  open(pending: ConsentPending): void {
    if (!isConsentPending(pending)) throw new TypeError('consent-pending-not-minted');
    this.records.set(scopeKey(pending.scope), { pending, state: 'open', version: this.nextVersion() });
  }

  /** The state of the step in `scope`, or `undefined` (inspection only; never an answer). */
  stateOf(scope: ConsentScope): ConsentPendingState | undefined {
    return this.records.get(scopeKey(scope))?.state;
  }

  /**
   * A6.3 step 1: claim the step of `scope` for one owner turn, atomically `open` → `answering`. A step that is late, already
   * answering (step 5: the earlier answer is cancelled, its bind will fail), used, cancelled or voided is `claim-lost`.
   */
  claim(scope: ConsentScope, atMs: number): ConsentClaimResult {
    const key = scopeKey(scope);
    const record = this.records.get(key);
    if (record === undefined) return { ok: false, reason: 'no-pending' };
    if (record.state !== 'open' || !fresh(record.pending, atMs)) {
      // Any turn consumes the chance to answer: a late step expires, an answering one is cancelled, a terminal one is forgotten.
      this.records.delete(key);
      return { ok: false, reason: 'claim-lost' };
    }
    record.state = 'answering';
    record.version = this.nextVersion();
    return { ok: true, claim: Object.freeze({ pending: record.pending, version: record.version }) as ConsentClaim };
  }

  /** The current record of a claim, if the claim still holds it in `answering` at the same version (compare-and-set). */
  private held(claim: ConsentClaim): ConsentRecord | undefined {
    const record = this.records.get(scopeKey(claim.pending.scope));
    return record !== undefined && record.pending === claim.pending && record.state === 'answering' && record.version === claim.version ? record : undefined;
  }

  /**
   * An owner turn that cannot be judged (e.g. the clock failed before the claim) still consumes the chance to answer, like `claim`
   * on a late or answering step: the record is dropped, so an in-flight bind for an earlier turn can no longer match.
   */
  forfeit(scope: ConsentScope): void {
    this.records.delete(scopeKey(scope));
  }

  /** Whether the claim still holds its step in `answering` (inspection only; used for the audit). */
  holds(claim: ConsentClaim): boolean {
    return this.held(claim) !== undefined;
  }

  /** A6.3 step 4: `answering` → `used` by compare-and-set, only while still fresh. `undefined`: nothing may be sent. */
  bind(claim: ConsentClaim, atMs: number): BoundConsent | undefined {
    const record = this.held(claim);
    if (record === undefined) return undefined;
    record.version = this.nextVersion();
    if (!fresh(record.pending, atMs)) {
      record.state = 'expired';
      return undefined;
    }
    record.state = 'used';
    return sealBound(record.pending, atMs);
  }

  /** Cancel a claimed step (a no, an `other`, a structural failure, the caps). A lost claim is already not answerable. */
  cancel(claim: ConsentClaim): void {
    const record = this.held(claim);
    if (record === undefined) return;
    record.state = 'cancelled';
    record.version = this.nextVersion();
  }

  /**
   * A6.3 step 4, `unclear`: replace the claimed step by its one fixed re-ask (same items or topic, same recipient, W2
   * restarted). A step that was already re-asked is not re-asked again (the caller cancels it). `undefined`: the claim was lost.
   */
  reask(claim: ConsentClaim, atMs: number): ConsentPending | undefined {
    const record = this.held(claim);
    if (record === undefined || claim.pending.reasked) return undefined;
    // A late step, or a non-finite clock read, is not re-asked: it expires (W2 is judged on the caller's fresh clock read).
    if (!fresh(record.pending, atMs)) {
      record.state = 'expired';
      record.version = this.nextVersion();
      return undefined;
    }
    const next = reaskedCopy(claim.pending, atMs);
    this.records.set(scopeKey(next.scope), { pending: next, state: 'open', version: this.nextVersion() });
    return next;
  }

  /** The kill switch: every open or answering step is voided (an in-flight bind then fails). */
  voidAll(): void {
    for (const record of this.records.values()) {
      if (record.state === 'open' || record.state === 'answering') {
        record.state = 'voided';
        record.version = this.nextVersion();
      }
    }
  }
}

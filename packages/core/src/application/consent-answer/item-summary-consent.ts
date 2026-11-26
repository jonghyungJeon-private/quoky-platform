import type { Actor, InboundFormatting, InboundQuotedRange } from '../../domain';
import type { Logger } from '../../ports';
import type { AiProvider } from '../../ports/ai-provider.port';
import { renderSummaryConsentQuestion } from '../agent/summary-consent-question';
import { newId } from '../../util/id';
import { isWorkLookupConsentRefs, workLookupRefsKey, type ItemSummaryConsentDescriptor, type WorkLookupConsentDescriptor } from '../item-summary-consent-descriptor';
import { recipientVerdict, type RecipientVerdict } from '../item-summary/expected-recipient';
import { isConsentSource, type ConsentSource } from './consent-labels';
import { CONSENT_ANSWER_WINDOW_MS, summaryConsentPending, type BoundConsent, type ConsentLanguage, type ConsentPendingStore, type ConsentScope } from './consent-pending';
import { isOwnerYes } from './consent-yes';

/**
 * ADR-0121 amendment A8 (OQ1-1, dormant: nothing calls it yet): the in-memory continuation of ONE live item summary whose
 * recipient was not the expected one (A8.5), and the single-use token a yes turns it into.
 *
 * - `ask` opens the rule-① pending step for exactly one item (the shared {@link ConsentPendingStore}, the recipient's display
 *   label as its recipient) and keeps ids only (the descriptor, the scope, the recipient KEY and LABEL, the owner's request text
 *   handed in by the caller) in memory: at most {@link ITEM_SUMMARY_CONSENT_MAX_RECORDS} records (the oldest is dropped), each
 *   dead after the answer window ({@link CONSENT_ANSWER_WINDOW_MS}, with one fixed re-ask allowed for). OQ1-4 review round 1:
 *   retention is bounded by time, not by traffic: every entry point purges the expired records first (the shared clock), and an
 *   unref'd sweep timer drops a record (its request text and redo selection with it) no later than its lifetime even when no
 *   other call comes.
 * - `take` accepts only a bound consent that the answer pipeline recorded as the owner's yes (the owner-yes brand) for a record
 *   this instance made, once, for the same actor in the same direct conversation. It mints an {@link ItemSummaryConsentToken}
 *   through a module-private `WeakMap` (like `mintGrant`); there is no other maker.
 * - `allowsContinuation(token, verdict)` is the only judge (OQ1-3 review round 2: the OQ1-1 `allows` had no production caller
 *   and was removed): every named REMOTE recipient (expected or not) needs an unspent token of this instance whose recipient KEY
 *   and LABEL both equal the live ones; `local` and `unnamed` are `false` (a LOCAL call never presents the token).
 *   A token is bound to the item (actor, conversation, source, item id) it was minted for, lives {@link ITEM_SUMMARY_TOKEN_TTL_MS}
 *   from its mint, and is consumed per phase: one `call`, then (only after it) one `regeneration`. `spend` retires it early;
 *   `voidAll` voids every record and token and starts a new void epoch.
 * - OQ1-3 review round 2: `epoch()` is the void epoch a turn captures at its entry; `ask` refuses (opens nothing) when a stop
 *   voided consents after that capture, so a turn already in flight at the stop can never open a fresh question.
 * - OQ1-4 (A8.6, = A5-S6): `askWorkLookup` opens the same rule-① step for the refs of ONE ADR-0100 D8 lookup (one source, 1..10
 *   refs as the step's item ids); `take` turns a yes to it into a {@link WorkLookupContinuation} whose token is bound to that ref
 *   SET (`kind: 'work-lookup'`, item key {@link workLookupRefsKey}). An item token never admits a lookup use, nor the reverse.
 *
 * Core compares keys and labels as opaque strings and never names a provider.
 */

export const ITEM_SUMMARY_CONSENT_MAX_RECORDS = 64;

/** A re-ask restarts the answer window once, so a record outlives at most two windows. */
const RECORD_LIFETIME_MS = 2 * CONSENT_ANSWER_WINDOW_MS;

export interface ItemSummaryConsentToken {
  readonly kind: 'item-summary-consent-token';
}

/** A token's life from its mint: the answer window, on the shared clock. */
export const ITEM_SUMMARY_TOKEN_TTL_MS = CONSENT_ANSWER_WINDOW_MS;

/** Which model request of the one summary a token is presented for: the call, then at most one regeneration. */
export type ItemSummaryUsePhase = 'call' | 'regeneration';

/** The request facts a caller presents with the token: the same actor, conversation, source and item the token was minted for. */
export interface ItemSummaryUse {
  readonly phase: ItemSummaryUsePhase;
  readonly actorId: string;
  readonly conversationKey: string;
  readonly source: ConsentSource;
  /** One item's id, or for a D8 lookup the ref-set key ({@link workLookupRefsKey}) of the asked refs. */
  readonly itemId: string;
  /** OQ1-4: `'work-lookup'` for a D8 lookup use; absent: a single item. Must equal the token's kind. */
  readonly kind?: 'work-lookup';
}

/** What a record and its token are for: one live item (A8.5) or the asked refs of one D8 lookup (A8.6). */
type ConsentRecordKind = 'item' | 'work-lookup';

interface TokenFacts {
  readonly owner: ItemSummaryConsent;
  readonly generation: number;
  readonly actorId: string;
  readonly conversationKey: string;
  readonly source: ConsentSource;
  readonly kind: ConsentRecordKind;
  readonly itemId: string;
  readonly key: string;
  readonly label: string;
  readonly mintedAtMs: number;
  callUsed: boolean;
  regenerationUsed: boolean;
  spent: boolean;
}

const TOKENS = new WeakMap<object, TokenFacts>();

/** The bound consents a token was already made from: one yes makes at most one token. */
const MINTED_FROM = new WeakSet<object>();

interface ContinuationRecordBase {
  readonly runRef: string;
  readonly scope: ConsentScope;
  readonly language: ConsentLanguage;
  readonly source: ConsentSource;
  readonly recipientKey: string;
  readonly recipientLabel: string;
  readonly requestText: string;
  readonly createdAtMs: number;
}

/**
 * OQ1-4 review round 1: the content-free marks of the owner's request message (the platform's quoted ranges as offsets into the
 * request text and the formatting flags), kept with the request text so the D8 re-run reads the owner's words exactly as the
 * asking turn did (quoted text stays data). Offsets and flags only.
 */
export interface WorkLookupRequestMarks {
  readonly quotedRanges?: readonly InboundQuotedRange[];
  readonly formatting?: InboundFormatting;
}

type ContinuationRecord =
  | (ContinuationRecordBase & { readonly kind: 'item'; readonly itemId: string; readonly descriptor: ItemSummaryConsentDescriptor })
  | (ContinuationRecordBase & { readonly kind: 'work-lookup'; readonly lookup: WorkLookupConsentDescriptor; readonly requestMarks: WorkLookupRequestMarks });

export interface ItemSummaryConsentDeps {
  readonly store: ConsentPendingStore;
  readonly now: () => number;
  readonly logger?: Logger;
  /**
   * OQ1-2: the composition root's display-label function of a summary recipient (the same closed table the rule-① question
   * uses). Absent: no REMOTE recipient has a name, so every REMOTE verdict is `unnamed` (nothing is asked or sent; fail closed).
   */
  readonly recipientLabel?: (provider: AiProvider) => string | undefined;
}

export interface ItemSummaryConsentAsk {
  readonly scope: ConsentScope;
  readonly descriptor: ItemSummaryConsentDescriptor;
  /** The unexpected recipient: its selection key and its display label (from the composition root's closed label table). */
  readonly recipient: { readonly key: string; readonly label: string };
  /** The owner's request text, kept in memory until the record dies (ARCHITECTURE.md section 8 item 5 precedent); never logged. */
  readonly requestText: string;
  /**
   * OQ1-3 review round 2: the void epoch ({@link ItemSummaryConsent.epoch}) the asking turn captured at its entry, before any await.
   * A different current epoch (a stop voided consents during the turn) refuses the ask: no record, no pending step, no question.
   */
  readonly epoch: number;
}

/** What `take` returns: the stored continuation (ids and the request text) and the token that lets exactly this recipient be called. */
export interface ItemSummaryContinuation {
  readonly token: ItemSummaryConsentToken;
  readonly descriptor: ItemSummaryConsentDescriptor;
  readonly requestText: string;
  readonly recipient: { readonly key: string; readonly label: string };
}

/** OQ1-4 (A8.6): the input of the D8 lookup question. As {@link ItemSummaryConsentAsk}, with the lookup's ids-only descriptor. */
export interface WorkLookupConsentAsk {
  readonly scope: ConsentScope;
  readonly lookup: WorkLookupConsentDescriptor;
  readonly recipient: { readonly key: string; readonly label: string };
  readonly requestText: string;
  /** OQ1-4 review round 1: the request message's quoted ranges and formatting flags (offsets and flags only). */
  readonly requestMarks?: WorkLookupRequestMarks;
  readonly epoch: number;
}

/** OQ1-4 (A8.6): what `take` returns for a yes to a D8 lookup question: the asked refs, the request text and the set-bound token. */
export interface WorkLookupContinuation {
  readonly token: ItemSummaryConsentToken;
  readonly lookup: WorkLookupConsentDescriptor;
  readonly requestText: string;
  /** OQ1-4 review round 1: the asking message's quoted ranges and formatting flags, for the re-run of the same request text. */
  readonly requestMarks: WorkLookupRequestMarks;
  readonly recipient: { readonly key: string; readonly label: string };
}

/** OQ1-4: whether a taken continuation is a D8 lookup's (it carries `lookup`, never `descriptor`). */
export function isWorkLookupContinuation(taken: ItemSummaryContinuation | WorkLookupContinuation): taken is WorkLookupContinuation {
  return (taken as Partial<WorkLookupContinuation>).lookup !== undefined;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** A copy of the request marks with offsets and flags only (anything malformed is dropped). */
function copyRequestMarks(marks: WorkLookupRequestMarks | undefined): WorkLookupRequestMarks {
  const ranges = Array.isArray(marks?.quotedRanges)
    ? marks.quotedRanges.filter((range) => Number.isInteger(range?.start) && Number.isInteger(range?.end)).map((range) => Object.freeze({ start: range.start, end: range.end }))
    : [];
  return Object.freeze({
    ...(ranges.length > 0 ? { quotedRanges: Object.freeze(ranges) } : {}),
    ...(marks?.formatting?.code === true ? { formatting: Object.freeze({ code: true as const }) } : {}),
  });
}

/** The shortest gap between two sweep timer runs (a clock that did not move must not spin the timer). */
const MIN_SWEEP_DELAY_MS = 1_000;

export class ItemSummaryConsent {
  private readonly records = new Map<string, ContinuationRecord>();
  private generation = 0;
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ItemSummaryConsentDeps) {}

  /** The recipient's display label from the composition root's table (`undefined`: none, or no label function). Total. */
  recipientLabelOf(provider: AiProvider): string | undefined {
    try {
      return this.deps.recipientLabel?.(provider);
    } catch {
      return undefined;
    }
  }

  /** OQ1-3 review round 2: the current void epoch (it changes only on `voidAll`). A turn captures it at its entry. */
  epoch(): number {
    this.sweep();
    return this.generation;
  }

  /** OQ1-3 review round 2: whether no stop voided consents since `epoch` was captured. Total: anything but the current epoch is `false`. */
  isCurrent(epoch: number | undefined): boolean {
    this.sweep();
    return typeof epoch === 'number' && epoch === this.generation;
  }

  /** OQ1-2: the A8.3 verdict of `provider` against the policy's expected key, with this instance's label function. Total. */
  verdictOf(provider: AiProvider, expectedKey: string | undefined): RecipientVerdict {
    return recipientVerdict(provider, expectedKey, (candidate) => this.recipientLabelOf(candidate));
  }

  /**
   * Opens the question's pending step and records the continuation; returns the run ref and the fixed rule-① question (v2 nouns,
   * one item, the recipient's label) to show. `undefined`: invalid input or no question renders (nothing was opened, nothing may be asked).
   */
  ask(input: ItemSummaryConsentAsk): { readonly runRef: string; readonly question: string } | undefined {
    this.sweep();
    try {
      const { scope, descriptor, recipient } = input;
      if (!isConsentSource(descriptor?.source) || !nonEmpty(descriptor.itemId) || !nonEmpty(recipient?.key) || !nonEmpty(recipient.label) || typeof input.requestText !== 'string') return undefined;
      if (descriptor.language !== 'ko' && descriptor.language !== 'en') return undefined;
      if (!this.isCurrent(input.epoch)) {
        this.deps.logger?.info('item_summary_consent.ask_stale', {});
        return undefined;
      }
      const question = renderSummaryConsentQuestion({ language: descriptor.language, recipient: recipient.label, sources: [{ source: descriptor.source, count: 1 }] });
      if (question === '') return undefined;
      const nowMs = this.deps.now();
      if (!Number.isFinite(nowMs)) return undefined;
      this.purge(nowMs);
      const runRef = newId();
      const pending = summaryConsentPending({
        scope,
        language: descriptor.language,
        createdAtMs: nowMs,
        recipient: recipient.label,
        sources: [{ source: descriptor.source, itemIds: [descriptor.itemId] }],
        runRef,
      });
      this.deps.store.open(pending);
      this.makeRoom();
      this.records.set(runRef, {
        kind: 'item',
        runRef,
        scope: pending.scope,
        language: descriptor.language,
        source: descriptor.source,
        itemId: descriptor.itemId,
        descriptor,
        recipientKey: recipient.key,
        recipientLabel: recipient.label,
        requestText: input.requestText,
        createdAtMs: nowMs,
      });
      this.armSweep();
      return { runRef, question };
    } catch {
      this.deps.logger?.warn('item_summary_consent.ask_refused', {});
      return undefined;
    }
  }

  /**
   * OQ1-4 (A8.6): opens the rule-① step for the asked refs of ONE D8 lookup (one source, its 1..10 refs as the step's item ids) and
   * records the continuation; returns the run ref and the fixed question (the source noun and the count, the recipient's label;
   * the listing above it shows the items). `undefined`: invalid input, a stale epoch or no question renders (nothing opened).
   */
  askWorkLookup(input: WorkLookupConsentAsk): { readonly runRef: string; readonly question: string } | undefined {
    this.sweep();
    try {
      const { scope, lookup, recipient } = input;
      if (lookup?.kind !== 'work-lookup' || !isConsentSource(lookup.source) || !isWorkLookupConsentRefs(lookup.refs)) return undefined;
      if (!nonEmpty(lookup.redo?.handlerId) || !nonEmpty(recipient?.key) || !nonEmpty(recipient.label) || typeof input.requestText !== 'string') return undefined;
      if (lookup.language !== 'ko' && lookup.language !== 'en') return undefined;
      if (!this.isCurrent(input.epoch)) {
        this.deps.logger?.info('item_summary_consent.ask_stale', {});
        return undefined;
      }
      const refs = [...lookup.refs];
      const question = renderSummaryConsentQuestion({ language: lookup.language, recipient: recipient.label, sources: [{ source: lookup.source, count: refs.length }] });
      if (question === '') return undefined;
      const nowMs = this.deps.now();
      if (!Number.isFinite(nowMs)) return undefined;
      this.purge(nowMs);
      const runRef = newId();
      const pending = summaryConsentPending({
        scope,
        language: lookup.language,
        createdAtMs: nowMs,
        recipient: recipient.label,
        sources: [{ source: lookup.source, itemIds: refs }],
        runRef,
      });
      this.deps.store.open(pending);
      this.makeRoom();
      this.records.set(runRef, {
        kind: 'work-lookup',
        runRef,
        scope: pending.scope,
        language: lookup.language,
        source: lookup.source,
        lookup: { ...lookup, refs: Object.freeze(refs) },
        requestMarks: copyRequestMarks(input.requestMarks),
        recipientKey: recipient.key,
        recipientLabel: recipient.label,
        requestText: input.requestText,
        createdAtMs: nowMs,
      });
      this.armSweep();
      return { runRef, question };
    } catch {
      this.deps.logger?.warn('item_summary_consent.ask_refused', {});
      return undefined;
    }
  }

  /** Whether this instance holds a live continuation for the run (the gate dispatches an item-owned yes here). */
  owns(runRef: string): boolean {
    this.sweep();
    try {
      const record = this.records.get(runRef);
      return record !== undefined && this.deps.now() - record.createdAtMs < RECORD_LIFETIME_MS;
    } catch {
      return false;
    }
  }

  /**
   * The owner's yes to the question of a run: the continuation and a single-use token, or `undefined` (nothing may be sent). The
   * record is consumed by the first attempt that reaches it with a genuine yes, so a retry or a replay finds nothing.
   */
  take(
    bound: BoundConsent,
    turn: { readonly actor: Pick<Actor, 'id'>; readonly conversationKey: string; readonly direct: boolean },
  ): ItemSummaryContinuation | WorkLookupContinuation | undefined {
    this.sweep();
    try {
      if (!isOwnerYes(bound) || MINTED_FROM.has(bound)) return undefined;
      const pending = bound.pending;
      if (pending.kind !== 'summary-consent') return undefined;
      const record = this.records.get(pending.runRef);
      if (record === undefined) return undefined;
      MINTED_FROM.add(bound);
      this.records.delete(record.runRef);
      const nowMs = this.deps.now();
      if (!Number.isFinite(nowMs) || nowMs - record.createdAtMs >= RECORD_LIFETIME_MS || bound.boundAtMs - pending.createdAtMs >= CONSENT_ANSWER_WINDOW_MS) return undefined;
      if (turn.direct !== true || turn.actor.id !== record.scope.actorId || turn.conversationKey !== record.scope.conversationKey) return undefined;
      if (pending.scope.actorId !== record.scope.actorId || pending.scope.conversationKey !== record.scope.conversationKey) return undefined;
      const only = pending.sources.length === 1 ? pending.sources[0] : undefined;
      if (only === undefined || only.source !== record.source) return undefined;
      // An item record names exactly its one item; a D8 record exactly its asked refs, in the order they were asked.
      const askedIds = record.kind === 'item' ? [record.itemId] : record.lookup.refs;
      if (only.itemIds.length !== askedIds.length || only.itemIds.some((id, index) => id !== askedIds[index])) return undefined;
      if (pending.recipient !== record.recipientLabel) return undefined;
      const token = Object.freeze({ kind: 'item-summary-consent-token' }) as ItemSummaryConsentToken;
      TOKENS.set(token, {
        owner: this,
        generation: this.generation,
        actorId: record.scope.actorId,
        conversationKey: record.scope.conversationKey,
        source: record.source,
        kind: record.kind,
        itemId: record.kind === 'item' ? record.itemId : workLookupRefsKey(record.lookup.refs),
        key: record.recipientKey,
        label: record.recipientLabel,
        mintedAtMs: nowMs,
        callUsed: false,
        regenerationUsed: false,
        spent: false,
      });
      const recipient = { key: record.recipientKey, label: record.recipientLabel };
      if (record.kind === 'work-lookup') return { token, lookup: record.lookup, requestText: record.requestText, requestMarks: record.requestMarks, recipient };
      return { token, descriptor: record.descriptor, requestText: record.requestText, recipient };
    } catch {
      return undefined;
    }
  }

  /**
   * OQ1-3 review round 1 (orchestrator ruling, strict A8.5): the judge of the continuation after the owner's yes. The yes names ONE
   * recipient, so EVERY `REMOTE` recipient (expected or not) needs the token: this
   * instance's live token for the same actor, conversation, source, item, key AND label, within the TTL, one `call` then one
   * `regeneration`. `local` and `unnamed` are `false` here (a LOCAL continuation never presents the token). Total.
   */
  allowsContinuation(token: ItemSummaryConsentToken | undefined, verdict: RecipientVerdict, use: ItemSummaryUse): boolean {
    this.sweep();
    try {
      if (verdict.kind !== 'expected' && verdict.kind !== 'unexpected') return false;
      return this.useToken(token, verdict, use);
    } catch {
      return false;
    }
  }

  /** The token check of a named REMOTE recipient. Consumes the phase only when everything matches. */
  private useToken(token: ItemSummaryConsentToken | undefined, verdict: { readonly key: string; readonly label: string }, use: ItemSummaryUse): boolean {
    try {
      if (token === undefined) return false;
      const facts = TOKENS.get(token);
      if (facts === undefined || facts.owner !== this || facts.generation !== this.generation || facts.spent) return false;
      const nowMs = this.deps.now();
      if (!Number.isFinite(nowMs) || nowMs - facts.mintedAtMs >= ITEM_SUMMARY_TOKEN_TTL_MS) return false;
      if (use.actorId !== facts.actorId || use.conversationKey !== facts.conversationKey || use.source !== facts.source || use.itemId !== facts.itemId) return false;
      if ((use.kind === 'work-lookup' ? 'work-lookup' : 'item') !== facts.kind) return false;
      if (facts.key !== verdict.key || facts.label !== verdict.label) return false;
      if (use.phase === 'call') {
        if (facts.callUsed) return false;
        facts.callUsed = true;
        return true;
      }
      if (use.phase !== 'regeneration' || !facts.callUsed || facts.regenerationUsed) return false;
      facts.regenerationUsed = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Retires a token early (on any refusal or once the summary is done): every later `allowsContinuation` with it is `false`. */
  spend(token: ItemSummaryConsentToken): void {
    const facts = TOKENS.get(token);
    if (facts !== undefined && facts.owner === this) facts.spent = true;
  }

  /** The kill switch / stop: every record and every outstanding token is void. */
  voidAll(): void {
    this.records.clear();
    this.disarmSweep();
    this.generation += 1;
  }

  /** Test-only (OQ1-4 review round 1): how many records (each with its request text) are held right now. Does not purge. */
  retainedRecordCount(): number {
    return this.records.size;
  }

  /** At most {@link ITEM_SUMMARY_CONSENT_MAX_RECORDS} records: the oldest is dropped first. */
  private makeRoom(): void {
    while (this.records.size >= ITEM_SUMMARY_CONSENT_MAX_RECORDS) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) break;
      this.records.delete(oldest.value);
    }
  }

  private purge(nowMs: number): void {
    for (const [runRef, record] of this.records) if (nowMs - record.createdAtMs >= RECORD_LIFETIME_MS) this.records.delete(runRef);
    if (this.records.size === 0) this.disarmSweep();
  }

  /** OQ1-4 review round 1: drops every expired record on the shared clock. Total (a broken clock purges nothing). */
  private sweep(): void {
    try {
      const nowMs = this.deps.now();
      if (Number.isFinite(nowMs)) this.purge(nowMs);
    } catch {
      // Nothing to do: the record checks below still refuse an expired record.
    }
  }

  /**
   * OQ1-4 review round 1: one unref'd timer, due when the oldest record's lifetime ends, so a record (and its request text and
   * redo selection) is dropped on time even when no other call comes. It never keeps the process alive.
   */
  private armSweep(): void {
    try {
      if (this.sweepTimer !== undefined || this.records.size === 0) return;
      const oldest = this.records.values().next();
      if (oldest.done === true) return;
      const nowMs = this.deps.now();
      const due = Number.isFinite(nowMs) ? oldest.value.createdAtMs + RECORD_LIFETIME_MS - nowMs : RECORD_LIFETIME_MS;
      const timer = setTimeout(() => {
        this.sweepTimer = undefined;
        this.sweep();
        this.armSweep();
      }, Math.min(RECORD_LIFETIME_MS, Math.max(MIN_SWEEP_DELAY_MS, due)));
      (timer as { unref?: () => void }).unref?.();
      this.sweepTimer = timer;
    } catch {
      this.sweepTimer = undefined;
    }
  }

  private disarmSweep(): void {
    if (this.sweepTimer === undefined) return;
    clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}

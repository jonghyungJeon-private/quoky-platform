import type { Actor } from '../../domain';
import type { Logger } from '../../ports';
import type { AiProvider } from '../../ports/ai-provider.port';
import { renderSummaryConsentQuestion } from '../agent/summary-consent-question';
import { newId } from '../../util/id';
import type { ItemSummaryConsentDescriptor } from '../item-summary-consent-descriptor';
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
 *   dead after the answer window ({@link CONSENT_ANSWER_WINDOW_MS}, with one fixed re-ask allowed for).
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
  readonly itemId: string;
}

interface TokenFacts {
  readonly owner: ItemSummaryConsent;
  readonly generation: number;
  readonly actorId: string;
  readonly conversationKey: string;
  readonly source: ConsentSource;
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

interface ContinuationRecord {
  readonly runRef: string;
  readonly scope: ConsentScope;
  readonly language: ConsentLanguage;
  readonly source: ConsentSource;
  readonly itemId: string;
  readonly descriptor: ItemSummaryConsentDescriptor;
  readonly recipientKey: string;
  readonly recipientLabel: string;
  readonly requestText: string;
  readonly createdAtMs: number;
}

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

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export class ItemSummaryConsent {
  private readonly records = new Map<string, ContinuationRecord>();
  private generation = 0;

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
    return this.generation;
  }

  /** OQ1-3 review round 2: whether no stop voided consents since `epoch` was captured. Total: anything but the current epoch is `false`. */
  isCurrent(epoch: number | undefined): boolean {
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
      while (this.records.size >= ITEM_SUMMARY_CONSENT_MAX_RECORDS) {
        const oldest = this.records.keys().next();
        if (oldest.done === true) break;
        this.records.delete(oldest.value);
      }
      this.records.set(runRef, {
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
      return { runRef, question };
    } catch {
      this.deps.logger?.warn('item_summary_consent.ask_refused', {});
      return undefined;
    }
  }

  /** Whether this instance holds a live continuation for the run (the gate dispatches an item-owned yes here). */
  owns(runRef: string): boolean {
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
  take(bound: BoundConsent, turn: { readonly actor: Pick<Actor, 'id'>; readonly conversationKey: string; readonly direct: boolean }): ItemSummaryContinuation | undefined {
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
      if (only === undefined || only.source !== record.source || only.itemIds.length !== 1 || only.itemIds[0] !== record.itemId) return undefined;
      if (pending.recipient !== record.recipientLabel) return undefined;
      const token = Object.freeze({ kind: 'item-summary-consent-token' }) as ItemSummaryConsentToken;
      TOKENS.set(token, {
        owner: this,
        generation: this.generation,
        actorId: record.scope.actorId,
        conversationKey: record.scope.conversationKey,
        source: record.source,
        itemId: record.itemId,
        key: record.recipientKey,
        label: record.recipientLabel,
        mintedAtMs: nowMs,
        callUsed: false,
        regenerationUsed: false,
        spent: false,
      });
      return { token, descriptor: record.descriptor, requestText: record.requestText, recipient: { key: record.recipientKey, label: record.recipientLabel } };
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
    this.generation += 1;
  }

  private purge(nowMs: number): void {
    for (const [runRef, record] of this.records) if (nowMs - record.createdAtMs >= RECORD_LIFETIME_MS) this.records.delete(runRef);
  }
}

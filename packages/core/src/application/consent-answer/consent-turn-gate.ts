import type { Actor, InboundQuotedRange } from '../../domain';
import type { Logger } from '../../ports';
import { answerConsentTurn, closedConsentToken, type ConsentClassifierSwitch } from './consent-answer';
import type { ConsentChatFacts } from './consent-labels';
import type { BoundConsent, ConsentLanguage, ConsentPendingStore, ConsentScope } from './consent-pending';
import type { ItemSummaryConsent, ItemSummaryContinuation, WorkLookupContinuation } from './item-summary-consent';

/**
 * ADR-0121 SR-1 rule ① confirm slice, CS-2 "gate": the one runtime gate that gives every owner DM turn its chance to answer a
 * pending consent step (W2), and runs the bound yes (CS-1b `continueSummaryConsent`).
 *
 * - **Where.** `ConversationRuntime.handleInner`, after the approval expiry / override block and before the kill-switch phrase,
 *   only when the composition root built a gate (`QUOKY_SUMMARY_CONSENT=on`). Absent, the runtime is byte-identical.
 * - **Order of one turn.** (1) A channel turn leaves the step open and routes. (2) Another owner step (approval, scope
 *   clarification, override, connector-write step, channel grant, selection question, an expiry answered this turn) or a control
 *   phrase (decided by the runtime with the existing parsers, never here) forfeits the step with NO claim and routes: a
 *   control command never reaches a classifier (ARCHITECTURE.md section 12). (3) Otherwise `answerConsentTurn` runs on the RAW
 *   text and its decision is mapped to one of: route normally, reply with a fixed line or the continuation, or reply and then
 *   rerun a message once as a new ordinary turn (AM-2).
 * - **Clock.** `now` is the one clock of the step: the same domain as the service's `createdAtMs` (`AgentRunService` deps
 *   `elapsed`, default `Date.now`). The composition root passes the same function to both.
 * - **Cap (A6 classifier wiring).** With the switch on, the adapter charges `chargeModelCall` immediately before each provider call; a spent cap is
 *   `unclear` (re-ask, then cancel), never a yes. A turn a registered handler claims is `other` (`handler-claimed`) before any call.
 * - **No content.** The gate logs closed codes and counts only, never the reply text, an id or an item. History keeps only the
 *   fixed notes below (never the summary).
 *
 * The classifier switch is `{ mode: 'off' }` until A6-S2/A6-S4 (the composition root refuses `on`); a stub `on` is a unit-test input.
 */

const LINES = {
  ko: {
    expired: '요약 확인 시간이 지났어요. 다시 요청해 주세요.',
    cancelled: '요약을 취소했어요. 원문은 보내지 않았어요.',
    unavailable: '지금은 요약을 보낼 수 없어서 아무것도 보내지 않았어요. 다시 요청해 주세요.',
    note: '(확인한 항목의 요약을 전달했어요.)',
  },
  en: {
    expired: 'The summary confirmation has expired. Please ask again.',
    cancelled: 'I cancelled the summary. Nothing was sent.',
    unavailable: "I can't send the summary right now, so nothing was sent. Please ask again.",
    note: '(Delivered the summary of the confirmed items.)',
  },
} as const satisfies Record<ConsentLanguage, Record<string, string>>;

/** What the continuation of a bound yes returned (`AgentContinuationOutcome` satisfies it structurally). */
export type ConsentContinuation =
  | { readonly kind: 'reply'; readonly reply: { readonly text: string } }
  | { readonly kind: 'declined'; readonly reason: string; readonly text: string };

export type { ConsentChatFacts };

export interface ConsentTurnGateDeps {
  readonly store: ConsentPendingStore;
  /** `{ mode: 'off' }` unless the composition root built the adapter; `QUOKY_CONSENT_ANSWER_CLASSIFIER=on` stays refused (A6-S4). */
  readonly classifier: ConsentClassifierSwitch;
  /** Runs the bound summary yes (`AgentRunService.continueSummaryConsent`). Total: it never throws. */
  readonly continueSummary: (bound: BoundConsent, turn: { readonly actor: Actor; readonly direct: boolean }) => Promise<ConsentContinuation>;
  /** Drops the continuation records (`AgentRunService.voidAllSummaryConsents`); the store is voided by the gate itself. */
  readonly voidContinuations?: () => void;
  /**
   * A6 classifier wiring: charges ONE model call to the actor's per-actor hourly cap (the run service's 60/h), keeping one call for the
   * continuation, and answers whether it was available. The classifier adapter calls it immediately before the provider is called
   * (no charge when the adapter answers `unclear` without a call); absent or `false` there is no call (`unclear`, fail closed).
   */
  readonly chargeModelCall?: (actor: Actor, atMs: number) => boolean;
  /**
   * ADR-0121 amendment A8 (OQ1-2): the live item-summary consent, composed only with `QUOKY_ITEM_SUMMARY_CONSENT=on` (which needs
   * `QUOKY_SUMMARY_CONSENT=on`). The runtime reaches it through {@link ConsentTurnGate.items}; absent, nothing of A8 runs. A yes to
   * one of its questions is dispatched by `runRef` after the bind (AM-1): `take` mints the single-use token and the gate hands the
   * continuation to the runtime (`continue-item`, OQ1-3); a yes `take` refuses gets the fixed "unavailable" line. The kill switch voids it.
   */
  readonly items?: ItemSummaryConsent;
  /** The one clock of the step (ms): the same function the run service uses for `createdAtMs`. */
  readonly now: () => number;
  readonly logger?: Logger;
}

/** One owner turn as the gate sees it. `ownerStepPending` and `control` are decided by the runtime. */
export interface ConsentGateTurn {
  readonly actor: Actor;
  readonly conversationKey: string;
  readonly direct: boolean;
  /** The RAW message text. */
  readonly text: string;
  readonly attachmentCount: number;
  readonly quotedRanges?: readonly InboundQuotedRange[];
  /** Another owner step is open for this turn (it consumes the chance to answer). */
  readonly ownerStepPending: boolean;
  /** The text is a control phrase (existing parsers, in the runtime). */
  readonly control: boolean;
  /** Lazy: a registered turn handler's pure `surfaceClaim` claims the text (decided by the runtime; evaluated only on the enabled classifier path). */
  readonly handlerClaimed?: () => boolean;
  /** Lazy: the chat provider facts of this turn (decided by the runtime, resolved only when a classifier call is about to be made). */
  readonly chat?: () => Promise<ConsentChatFacts | undefined>;
}

export type ConsentGateOutcome =
  /** Not an answer, or a cancel that takes the normal path: route the turn as usual. */
  | { readonly kind: 'route' }
  /** The turn is consumed: show `text`; the history keeps `historyNote` (fixed, never the summary); `rerun` runs once as a new turn. */
  | { readonly kind: 'reply'; readonly text: string; readonly historyNote: string; readonly rerunText?: string; readonly replyKind: 'question' | 'note' }
  /**
   * ADR-0121 amendment A8.5 (OQ1-3): the owner's yes to a live item-summary question, taken (the record is consumed, the token
   * minted). The runtime runs the continuation (re-read, re-checks, one summary call with the token) and owns the reply and its
   * history note; `rerun` runs once afterwards as a new turn (AM-2). `unavailable` is the gate's fixed line for a continuation the
   * runtime cannot run at all. OQ1-4 (A8.6): the same outcome carries a yes to a D8 lookup question (a `WorkLookupContinuation`).
   */
  | {
      readonly kind: 'continue-item';
      readonly continuation: ItemSummaryContinuation | WorkLookupContinuation;
      readonly language: ConsentLanguage;
      readonly unavailable: string;
      readonly rerunText?: string;
    };

const ROUTE: ConsentGateOutcome = Object.freeze({ kind: 'route' });

/** The language of a fixed line when no step is held (a late token): the script of the reply, a structural check, not a word list. */
function languageOfReply(text: string): ConsentLanguage {
  return /\p{Script=Hangul}/u.test(text) ? 'ko' : 'en';
}

export class ConsentTurnGate {
  constructor(private readonly deps: ConsentTurnGateDeps) {}

  /** The scope key part of a turn: `platform|spaceId|channelId|threadId`. */
  static conversationKeyOf(context: { readonly platform: string; readonly spaceId?: string; readonly channelId: string; readonly threadId?: string }): string {
    return [context.platform, context.spaceId ?? '', context.channelId, context.threadId ?? ''].join('|');
  }

  /** ADR-0121 amendment A8 (OQ1-2): the live item-summary consent, or `undefined` (`QUOKY_ITEM_SUMMARY_CONSENT` off: nothing of A8 runs). */
  get items(): ItemSummaryConsent | undefined {
    return this.deps.items;
  }

  /** The kill switch: every pending consent is voided and every continuation record is dropped. */
  voidAll(): void {
    try {
      this.deps.store.voidAll();
    } finally {
      try {
        this.deps.voidContinuations?.();
      } catch {
        // Fail closed already (the store is voided); a throw here must not break the stop turn.
      }
      try {
        this.deps.items?.voidAll();
      } catch {
        // Same: the store is voided; the item records die with their window.
      }
    }
  }

  async handle(turn: ConsentGateTurn): Promise<ConsentGateOutcome> {
    const { store } = this.deps;
    const scope: ConsentScope = { actorId: turn.actor.id, conversationKey: turn.conversationKey };
    // A channel turn is not the owner DM: the step stays open (W2 counts the owner DM only).
    if (!turn.direct) return ROUTE;
    try {
      if (turn.ownerStepPending || turn.control) {
        // Logged only when a step was actually dropped: most approval/control/selection DM turns hold none.
        if (store.forfeit(scope)) this.log('forfeit', turn.control ? 'control' : 'owner-step');
        return ROUTE;
      }
      const language = store.languageOf(scope);
      const decision = await answerConsentTurn(
        store,
        {
          scope,
          ownerDm: true,
          text: turn.text,
          atMs: this.deps.now(),
          attachmentCount: turn.attachmentCount,
          ...(turn.quotedRanges !== undefined ? { quotedRanges: turn.quotedRanges } : {}),
          ...(turn.handlerClaimed !== undefined ? { handlerClaimed: turn.handlerClaimed } : {}),
          ...(turn.chat !== undefined ? { chat: turn.chat } : {}),
          charge: () => this.charge(turn.actor),
        },
        this.deps.classifier,
        this.deps.now,
      );
      const lines = LINES[language ?? languageOfReply(turn.text)];
      switch (decision.kind) {
        case 'not-an-answer':
          // ADR-0112 lapsed-step precedent: a late closed yes/no for a step that is gone is told so, never read as chat.
          if (decision.audit.includes('claim-lost') && closedConsentToken(turn.text) !== undefined) {
            this.log('late', 'claim-lost');
            return { kind: 'reply', text: lines.expired, historyNote: lines.expired, replyKind: 'note' };
          }
          return ROUTE;
        case 'cancelled':
          this.log('cancelled', decision.audit.join(','));
          if (decision.next === 'ordinary') return ROUTE;
          // A late label whose step was lost mid-answer is "expired", a real no is the cancel line.
          return decision.audit.includes('claim-lost') ? { kind: 'reply', text: lines.expired, historyNote: lines.expired, replyKind: 'note' } : { kind: 'reply', text: lines.cancelled, historyNote: lines.cancelled, replyKind: 'note' };
        case 'reask':
          this.log('reask', decision.audit.join(','));
          return { kind: 'reply', text: decision.question, historyNote: decision.question, replyKind: 'question' };
        case 'bound': {
          this.log('bound', decision.audit.join(','));
          const continued = await this.continueBound(decision.bound, turn, lines, language ?? languageOfReply(turn.text));
          return decision.next === 'rerun' && decision.rerunText !== undefined ? { ...continued, rerunText: decision.rerunText } : continued;
        }
      }
    } catch (error) {
      // Fail closed: a turn that cannot be judged consumes the chance to answer and is handled as an ordinary message.
      try {
        store.forfeit(scope);
      } catch {
        // already failing closed
      }
      this.log('failed', error instanceof Error ? error.name : 'unknown');
      return ROUTE;
    }
  }

  /** One model call charged to the actor's hourly cap (leaving the continuation its call); unavailable, absent or a throw is `false`: no call. */
  private charge(actor: Actor): boolean {
    try {
      return this.deps.chargeModelCall?.(actor, this.deps.now()) === true;
    } catch {
      return false;
    }
  }

  private async continueBound(
    bound: BoundConsent,
    turn: ConsentGateTurn,
    lines: (typeof LINES)[ConsentLanguage],
    language: ConsentLanguage,
  ): Promise<{ readonly kind: 'reply'; readonly text: string; readonly historyNote: string; readonly replyKind: 'note' } | Extract<ConsentGateOutcome, { readonly kind: 'continue-item' }>> {
    // Only the rule-① summary consent has a continuation here (the A2 topic slice adds `continueTopic`): another kind is spent, nothing runs.
    if (bound.pending.kind !== 'summary-consent') return { kind: 'reply', text: lines.expired, historyNote: lines.expired, replyKind: 'note' };
    // A8.5 (OQ1-3): a yes to a live item-summary question is dispatched by `runRef` after the bind (AM-1). `take` consumes the record
    // (single use) and mints the token; the runtime runs the continuation. A yes `take` refuses (late, another actor or conversation,
    // not a DM, a replay) is the fixed unavailable line, and nothing is sent.
    const items = this.deps.items;
    if (items !== undefined && items.owns(bound.pending.runRef)) {
      let taken: ItemSummaryContinuation | WorkLookupContinuation | undefined;
      try {
        taken = items.take(bound, { actor: turn.actor, conversationKey: turn.conversationKey, direct: turn.direct });
      } catch {
        taken = undefined;
      }
      if (taken === undefined) {
        this.log('item-unavailable', 'take-refused');
        return { kind: 'reply', text: lines.unavailable, historyNote: lines.unavailable, replyKind: 'note' };
      }
      this.log('item-continue', 'taken');
      return { kind: 'continue-item', continuation: taken, language, unavailable: lines.unavailable };
    }
    let outcome: ConsentContinuation;
    try {
      outcome = await this.deps.continueSummary(bound, { actor: turn.actor, direct: true });
    } catch {
      // A declined continuation spends the yes: no re-open (CS-1b review round 1).
      return { kind: 'reply', text: lines.unavailable, historyNote: lines.unavailable, replyKind: 'note' };
    }
    // The summary is the reply; the history keeps the fixed structural note only (ADR-0118 rule, N5).
    if (outcome.kind === 'reply' && typeof outcome.reply?.text === 'string' && outcome.reply.text.length > 0) return { kind: 'reply', text: outcome.reply.text, historyNote: lines.note, replyKind: 'note' };
    if (outcome.kind === 'declined' && typeof outcome.text === 'string' && outcome.text.length > 0) return { kind: 'reply', text: outcome.text, historyNote: outcome.text, replyKind: 'note' };
    return { kind: 'reply', text: lines.unavailable, historyNote: lines.unavailable, replyKind: 'note' };
  }

  /** One content-free line: a closed outcome and closed audit codes, never the text, an id or an item. */
  private log(outcome: string, reason: string): void {
    try {
      this.deps.logger?.info('consent_gate.turn', { outcome, reason });
    } catch {
      // best-effort
    }
  }
}

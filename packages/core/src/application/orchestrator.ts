import { NotImplementedError } from '../errors';
import type { ApprovalDecision, InboundMessage, IsoTimestamp } from '../domain';
import type { Logger, OutboundDeliveryReceipt, PlatformAdapter, PlatformFeedbackSignal } from '../ports';
import { now } from '../util/clock';
import type { ConversationRuntime, TurnResult } from './conversation-runtime';
import type { FeedbackReactionInput, RecordTurnInput } from './feedback/feedback-recorder';
import { formatSafeErrorText, safeRequestId, toSafeError } from './safe-error';

/**
 * The feedback capture the facade drives (ADR-0098 D5) — structurally `FeedbackRecorder`. Both methods are
 * best-effort; the facade additionally guards them so a capture failure never changes delivery.
 */
export interface QuokyCoreFeedback {
  recordTurn(input: RecordTurnInput): Promise<void>;
  recordReaction(signal: FeedbackReactionInput): Promise<void>;
}

/** Everything the facade needs, injected by the composition root. */
export interface QuokyCoreDeps {
  runtime: ConversationRuntime;
  platform: PlatformAdapter;
  logger: Logger;
  /** Optional local feedback capture (ADR-0098 D5); absent means nothing is recorded. */
  feedback?: QuokyCoreFeedback;
  /** Shared clock; defaults to `util/clock.now`. */
  clock?: () => IsoTimestamp;
}

/** Narrow an adapter's `sendMessage` result to a receipt (`void` from adapters that report no ids). */
function receiptOf(delivered: void | OutboundDeliveryReceipt): OutboundDeliveryReceipt | undefined {
  return typeof delivered === 'object' && delivered !== null && Array.isArray(delivered.platformMessageIds)
    ? delivered
    : undefined;
}

/**
 * QuokyCore is the **thin platform-entry facade** (ADR-0032). The full per-message conversation
 * flow lives in {@link ConversationRuntime}; QuokyCore only delegates to it and performs platform
 * delivery:
 *
 *   Platform Adapter → QuokyCore (facade) → ConversationRuntime.handle() → OutboundMessage → deliver
 *
 * There is exactly ONE conversation entry — QuokyCore and ConversationRuntime are never parallel
 * paths. Boundary note: this file imports NOTHING concrete — only ports + the runtime service.
 */
export class QuokyCore {
  private readonly clock: () => IsoTimestamp;

  constructor(private readonly deps: QuokyCoreDeps) {
    this.clock = deps.clock ?? now;
  }

  /**
   * Drive one inbound message: typing → runtime turn → deliver the runtime's OutboundMessage → (ADR-0098 D5)
   * best-effort feedback capture after delivery, which never changes or delays the reply itself.
   */
  async handleInboundMessage(message: InboundMessage): Promise<void> {
    await this.deps.platform.sendTyping(message.context).catch(() => undefined);
    const startedAt = this.clock();
    let result: TurnResult;
    try {
      result = await this.deps.runtime.handle(message);
    } catch (err) {
      // Backstop (Sprint 4c-Follow-up-7, F7-D): runtime.handle() is designed never to throw for an
      // application error, but if it ever does, deliver exactly ONE sanitized error response (never a raw
      // exception) and keep the runtime alive. A delivery failure is logged only — no recursive retry.
      const safe = toSafeError(err);
      this.deps.logger.error('inbound handling failed (backstop)', {
        errorName: err instanceof Error ? err.name : typeof err,
        code: safe.code,
        messageId: message.id,
        stack: err instanceof Error ? err.stack : undefined,
      });
      await this.deps.platform
        .sendMessage({
          context: message.context,
          // The facade backstop cannot prove where the runtime failed, so it MUST default to
          // "possibly applied" — never a false zero-mutation claim (Sprint 4c-Follow-up-7 CA correction).
          text: formatSafeErrorText(safe, {
            requestId: safeRequestId(message.id),
            mutationSafety: 'MAY_HAVE_APPLIED',
          }),
        })
        .catch((deliveryErr) =>
          this.deps.logger.error('error-response delivery failed', {
            errorName: deliveryErr instanceof Error ? deliveryErr.name : typeof deliveryErr,
          }),
        );
      // The backstop reply is never rateable: recorded as FAILED with no receipt and no session.
      await this.recordTurn({ message, result: { status: 'FAILED' }, startedAt, deliveredAt: this.clock() });
      return;
    }
    const delivered = await this.deps.platform.sendMessage(result.reply);
    const receipt = receiptOf(delivered);
    await this.recordTurn({
      message,
      result: {
        status: result.status,
        sessionId: result.sessionId,
        reply: { text: result.reply.text },
        ...(result.workFacts ? { workFacts: result.workFacts } : {}),
      },
      ...(receipt ? { receipt: { platformMessageIds: [...receipt.platformMessageIds] } } : {}),
      startedAt,
      deliveredAt: this.clock(),
    });
  }

  /**
   * ADR-0098 D3/D5: an admitted platform feedback reaction. Delegates to the recorder (which links it to the
   * recorded turn by the rated platform message id) and NEVER sends a message in response.
   */
  async handleFeedbackSignal(signal: PlatformFeedbackSignal): Promise<void> {
    const feedback = this.deps.feedback;
    if (!feedback) return;
    try {
      await feedback.recordReaction({
        platform: signal.platform,
        platformUserId: signal.context.userId,
        targetPlatformMessageId: signal.targetPlatformMessageId,
        rating: signal.rating,
        action: signal.action,
      });
    } catch (err) {
      this.logCaptureFailure('reaction', err);
    }
  }

  private async recordTurn(input: RecordTurnInput): Promise<void> {
    const feedback = this.deps.feedback;
    if (!feedback) return;
    try {
      await feedback.recordTurn(input);
    } catch (err) {
      this.logCaptureFailure('turn', err);
    }
  }

  /** Content-free: never the message text, reply text or any platform id. */
  private logCaptureFailure(stage: string, err: unknown): void {
    try {
      this.deps.logger.warn('feedback capture failed', {
        stage,
        errorName: err instanceof Error ? err.name : typeof err,
      });
    } catch {
      // Logging is best-effort; capture must never affect the turn.
    }
  }

  /**
   * Approval decisions now arrive as ordinary conversation turns and are routed by
   * `ConversationRuntime` (ADR-0032). This platform-event entry is retained for the inbound
   * wiring's signature and is not part of the turn flow.
   */
  async handleApprovalDecision(_decision: ApprovalDecision): Promise<void> {
    throw new NotImplementedError(
      'QuokyCore.handleApprovalDecision — approvals are handled as conversation turns (ADR-0032)',
    );
  }
}

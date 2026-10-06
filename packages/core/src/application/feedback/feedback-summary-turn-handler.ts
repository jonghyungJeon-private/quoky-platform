import type { FeedbackSummary, Id, Task } from '../../domain';
import type { ConversationTurnHandler, Logger, TurnHandlerContext, TurnHandlerReply } from '../../ports';
import type { FeedbackCapabilityTrend } from './feedback-recorder';
import { composeFeedbackSummaryText, FEEDBACK_SUMMARY_UNAVAILABLE_TEXT } from './feedback-summary-composer';
import { detectFeedbackTurnControl } from './implicit-feedback';

/**
 * The 30-day summary source — structurally `FeedbackRecorder.summarize`/`trend` (null when the store cannot be read).
 * `trend` (ADR-0107 D3) is optional: without it, or when it returns null, the reply has no trend line.
 */
export interface FeedbackSummarySource {
  summarize(actorId: Id): Promise<FeedbackSummary | null>;
  trend?(actorId: Id): Promise<FeedbackCapabilityTrend | null>;
}

/** Read-only Task lookup for the request text of recent 👎 turns. */
export interface FeedbackTaskLookup {
  get(id: Id): Promise<Pick<Task, 'description'> | null>;
}

export interface FeedbackSummaryTurnHandlerDeps {
  feedback: FeedbackSummarySource;
  tasks: FeedbackTaskLookup;
  logger?: Logger;
}

export const FEEDBACK_SUMMARY_TURN_HANDLER_ID = 'feedback.summary';
/** ADR-0098 D6: `control` stage, order 100. */
export const FEEDBACK_SUMMARY_TURN_HANDLER_ORDER = 100;
export const FEEDBACK_HELP_LINES: readonly string[] = [
  '- 답변에 👍/👎 반응을 남기면 품질 확인에 쓰여요(반응을 지우면 취소돼요).',
  '- "피드백 요약": 최근 30일 피드백을 확인해요.',
];

/**
 * `피드백 요약` (ADR-0098 D6, amends ADR-0093) as an ADR-0096 `control`-stage turn handler: exact whole-message
 * match (NFC + trim, no slash alias), read-only, provider-free, no Task, no memory write, and available in every
 * conversation state including a pending approval. Errors are caught here and answered with fixed copy.
 */
export class FeedbackSummaryTurnHandler implements ConversationTurnHandler {
  readonly id = FEEDBACK_SUMMARY_TURN_HANDLER_ID;
  readonly stage = 'control' as const;
  readonly order = FEEDBACK_SUMMARY_TURN_HANDLER_ORDER;
  readonly helpLines = FEEDBACK_HELP_LINES;

  constructor(private readonly deps: FeedbackSummaryTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    if (detectFeedbackTurnControl(ctx.message.text) !== 'feedback-summary') return null;
    const context = ctx.message.context;
    try {
      const summary = await this.deps.feedback.summarize(ctx.actor.id);
      const excerpts = new Map<Id, string>();
      for (const turn of summary?.recentNegative ?? []) {
        if (turn.taskId === undefined || excerpts.has(turn.taskId)) continue;
        const description = await this.describeTask(turn.taskId);
        if (description !== undefined) excerpts.set(turn.taskId, description);
      }
      const trend = summary && this.deps.feedback.trend ? await this.deps.feedback.trend(ctx.actor.id) : null;
      const text = composeFeedbackSummaryText(summary, excerpts, trend);
      return summary ? { reply: { context, text } } : { reply: { context, text }, status: 'FAILED' };
    } catch (err) {
      this.logFailure(err);
      return { reply: { context, text: FEEDBACK_SUMMARY_UNAVAILABLE_TEXT }, status: 'FAILED' };
    }
  }

  private async describeTask(taskId: Id): Promise<string | undefined> {
    try {
      return (await this.deps.tasks.get(taskId))?.description;
    } catch (err) {
      this.logFailure(err);
      return undefined;
    }
  }

  private logFailure(err: unknown): void {
    try {
      this.deps.logger?.warn('feedback summary failed', { errorName: err instanceof Error ? err.name : typeof err });
    } catch {
      // best-effort
    }
  }
}

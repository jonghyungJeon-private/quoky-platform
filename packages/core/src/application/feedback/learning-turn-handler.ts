import type { ConversationTurnHandler, Logger, TurnHandlerContext, TurnHandlerReply } from '../../ports';
import { parseLearningCommand } from './learning-commands';
import { LEARNING_FAILURE_TEXT } from './learning-service';
import type { LearningService } from './learning-service';

export const LEARNING_TURN_HANDLER_ID = 'feedback.learning';
/** ADR-0107 D3 (amends ADR-0096 D5): `pre-classify`, order 60 — after memory commands (50), before to-dos (100). */
export const LEARNING_TURN_HANDLER_ORDER = 60;
/** One contributed help line (ADR-0096 D6; under the composer's 120-character bound). */
export const LEARNING_HELP_LINES: readonly string[] = Object.freeze([
  '- 학습 후보: "피드백 후보", "후보 N 메모: 내용", "후보 N 예시로 저장", "예시 목록", "예시 N 수정: 답변", "예시 N 삭제"',
]);

export interface LearningTurnHandlerDeps {
  service: Pick<LearningService, 'execute'>;
  logger?: Logger;
}

/**
 * The owner learning commands (ADR-0107 D3) as a `pre-classify` turn handler: whole-message grammar only, provider-free,
 * no Task, no memory write. Errors are caught here and answered with fixed copy (never falling through, so chat never
 * claims a save that did not happen).
 */
export class LearningTurnHandler implements ConversationTurnHandler {
  readonly id = LEARNING_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = LEARNING_TURN_HANDLER_ORDER;
  readonly helpLines = LEARNING_HELP_LINES;

  constructor(private readonly deps: LearningTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    const command = parseLearningCommand(ctx.message.text);
    if (!command) return null;
    const context = ctx.message.context;
    try {
      const result = await this.deps.service.execute(command, {
        actorId: ctx.actor.id,
        platform: context.platform,
        channelId: context.channelId,
        ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
      }, ctx.now);
      return { reply: { context, text: result.text }, status: result.status };
    } catch (err) {
      try {
        // The command kind only; never the message text.
        this.deps.logger?.warn('learning command failed', {
          command: command.kind,
          errorName: err instanceof Error ? err.name : typeof err,
        });
      } catch {
        // best-effort
      }
      return { reply: { context, text: LEARNING_FAILURE_TEXT }, status: 'FAILED' };
    }
  }
}

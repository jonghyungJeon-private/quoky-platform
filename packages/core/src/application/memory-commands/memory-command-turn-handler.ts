import type { ConversationTurnHandler, Logger, TurnHandlerContext, TurnHandlerReply } from '../../ports';
import { outboundBody, outboundMessage } from '../message-rendering';
import { parseMemoryCommand } from './memory-command-grammar';
import { renderMemoryCommandFailed } from './memory-command-renderer';
import { memoryCommandHistory, type MemoryCommandService } from './memory-command-service';

export const MEMORY_COMMAND_TURN_HANDLER_ID = 'memory-commands';
/**
 * ADR-0106 D2 (amends ADR-0096 D5): `pre-classify`, order 50 — after the runtime's `기억해:` block, before learning
 * commands (60), anchored to-dos (100), calendar (150), reminders (200), work lookups (300) and help intent (400).
 */
export const MEMORY_COMMAND_TURN_HANDLER_ORDER = 50;

/** The contributed help line (ADR-0096 D6; one line, under the composer's 120-character bound). */
export const MEMORY_COMMAND_HELP_LINES: readonly string[] = Object.freeze([
  '- 기억 관리: "기억 목록", "기억 N 보여줘", "기억 N 수정: 내용", "기억 N 잊어줘" (수정·삭제는 확인 코드로 한 번 더 확인해요)',
  // ADR-0106 amendment: the archive (numbers are the archive's own).
  '- 기억 보관함: 잊은 기억은 "보관함"에서 보고 "기억 복원 N", "기억 완전 삭제 N"으로 되돌리거나 지워요 (확인 코드 필요)',
]);

export interface MemoryCommandTurnHandlerDeps {
  readonly service: Pick<MemoryCommandService, 'execute'>;
  readonly logger?: Logger;
}

/**
 * Memory management commands (ADR-0106) as an ADR-0096 `pre-classify` turn handler, order 50. Claims only a
 * whole-message memory command (`parseMemoryCommand`); everything else falls through (`null`) unchanged. Provider-
 * free, creates no Task, TaskRun or ApprovalRequest (D4: the explicit `기억 확인 <code>` is the consent), and acts
 * only for the turn's own actor. A claimed command whose execution throws is answered with fixed copy (never chat).
 */
export class MemoryCommandTurnHandler implements ConversationTurnHandler {
  readonly id = MEMORY_COMMAND_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = MEMORY_COMMAND_TURN_HANDLER_ORDER;
  readonly helpLines = MEMORY_COMMAND_HELP_LINES;

  constructor(private readonly deps: MemoryCommandTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    const command = parseMemoryCommand(ctx.message.text);
    if (command === null) return null;
    const context = ctx.message.context;
    try {
      const result = await this.deps.service.execute(command, {
        actorId: ctx.actor.id,
        now: ctx.now,
        sourceText: ctx.message.text,
        // ADR-0106 amendment D5: a confirmed forget/edit clears the actor's history of this conversation.
        sessionId: ctx.session.id,
      });
      return {
        reply: outboundMessage(context, outboundBody(result), { replyToMessageId: ctx.message.id }),
        status: result.status,
        // W2-L01: edit/forget turns keep no memory text in the conversation history.
        ...(result.history === undefined ? {} : { history: result.history }),
      };
    } catch (error) {
      try {
        this.deps.logger?.warn('memory_commands.turn_handler.failed', {
          command: command.kind,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // best-effort
      }
      const history = memoryCommandHistory(command, 'failed');
      return {
        reply: { context, text: renderMemoryCommandFailed(command.language), replyToMessageId: ctx.message.id },
        status: 'FAILED',
        ...(history === undefined ? {} : { history }),
      };
    }
  }
}

/** Factory for the composition root (ADR-0096 D7). */
export function createMemoryCommandTurnHandler(deps: MemoryCommandTurnHandlerDeps): MemoryCommandTurnHandler {
  return new MemoryCommandTurnHandler(deps);
}

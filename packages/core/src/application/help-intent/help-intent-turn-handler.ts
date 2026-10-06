import type { ConversationTurnHandler, Logger, TurnHandlerContext, TurnHandlerReply } from '../../ports';
import {
  composeHelpIntentReply,
  detectHelpIntent,
  HELP_INTENT_TOPICS,
  selectHelpLines,
  type HelpIntentTopic,
} from './help-intent';

export const HELP_INTENT_TURN_HANDLER_ID = 'help-intent';
/** ADR-0104 D4 (amends ADR-0096 D5): `pre-classify`, after work lookups (300), before the intent classifier. */
export const HELP_INTENT_TURN_HANDLER_ORDER = 400;

/** The help line this handler contributes (ADR-0096 D6; well under the composer's 120-character bound). */
export const HELP_INTENT_HELP_LINES: readonly string[] = Object.freeze([
  '- 사용법 질문: "완료 처리 어떻게 해?", "알림 어떻게 지워?"처럼 물으면 그 명령 안내만 보여줘요.',
]);

/**
 * The help lines to answer from: a fixed list, or a getter read on every turn (so the composition root can pass the
 * lines of the final, fully-registered handler list). The handler's own lines are always ignored.
 */
export type HelpIntentLineSource = readonly string[] | (() => readonly string[]);

export interface HelpIntentTurnHandlerDeps {
  readonly helpLines: HelpIntentLineSource;
  /** The closed topic index; defaults to {@link HELP_INTENT_TOPICS}. */
  readonly topics?: readonly HelpIntentTopic[];
  readonly logger?: Logger;
}

/**
 * Help intent (ADR-0104 D4) as an ADR-0096 `pre-classify` turn handler, order 400. A how-to question about one of
 * Quoky's own commands ("완료 처리 어떻게 해?", "알림 어떻게 지워?", "도움말 할 일") is answered with the matching
 * contributed help lines (ADR-0093 note: a filtered subset of the help reply), deterministically and provider-free.
 * Every other message, a how-to question whose topic has no contributed line, and any internal error fall through
 * (`null`) to the classifier unchanged. No Task, provider, tool, connector, memory or state.
 *
 * Registration is the composition root's job (ADR-0104 D4: DET-1 registers it in `turn-handlers.providers.ts`).
 */
export class HelpIntentTurnHandler implements ConversationTurnHandler {
  readonly id = HELP_INTENT_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = HELP_INTENT_TURN_HANDLER_ORDER;
  readonly helpLines = HELP_INTENT_HELP_LINES;

  constructor(private readonly deps: HelpIntentTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    try {
      const topics = this.deps.topics ?? HELP_INTENT_TOPICS;
      const match = detectHelpIntent(ctx.message.text, topics);
      if (match === null) return null;
      const source = typeof this.deps.helpLines === 'function' ? this.deps.helpLines() : this.deps.helpLines;
      const lines = selectHelpLines(match, source, { topics, exclude: HELP_INTENT_HELP_LINES });
      if (lines.length === 0) return null;
      return {
        reply: {
          context: ctx.message.context,
          text: composeHelpIntentReply(match.language, lines),
          replyToMessageId: ctx.message.id,
        },
      };
    } catch (error) {
      // Falling through is safe: the turn then behaves exactly as before this handler existed. Never log the text.
      try {
        this.deps.logger?.warn('help_intent.turn_handler.failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // best-effort
      }
      return null;
    }
  }
}

/** Factory for the composition root (ADR-0096 D7). */
export function createHelpIntentTurnHandler(deps: HelpIntentTurnHandlerDeps): HelpIntentTurnHandler {
  return new HelpIntentTurnHandler(deps);
}

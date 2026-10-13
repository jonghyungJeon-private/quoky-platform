import type { ConversationTurnHandler, Logger, TurnHandlerContext, TurnHandlerProbeContext, TurnHandlerReply } from '../../ports';
import { outboundMessage } from '../message-rendering';
import { nlStringArg, type NlCatalogEntry, type NlClassBProbe, type NlSelectedCommand } from '../nl-routing/catalog';
import { NL_HELP_TOPICS, nlWave1Entry } from '../nl-routing/wave1-entries';
import { renderHelpText } from '../response-composer';
import {
  composeHelpIntentReply,
  detectCapabilityQuestion,
  detectHelpIntent,
  HELP_INTENT_TOPICS,
  selectHelpLines,
  type HelpIntentTopic,
} from './help-intent';

export const HELP_INTENT_TURN_HANDLER_ID = 'help-intent';
/** The content-free Class B grammar id of the help-intent matcher (ADR-0120 D10 agreement log). */
export const HELP_INTENT_GRAMMAR_ID = 'help-intent';

/**
 * ADR-0120 `help.topic`: topics only selection names (the grammar's index stays frozen, ADR-0120 D10). A topic answers
 * with the contributed lines that carry its anchor, like every index topic.
 */
const SELECTION_ONLY_TOPICS: readonly HelpIntentTopic[] = Object.freeze([
  Object.freeze({ id: 'mail', keywords: Object.freeze([]), anchors: Object.freeze(['메일']) }),
  Object.freeze({ id: 'drive', keywords: Object.freeze([]), anchors: Object.freeze(['드라이브', 'Drive']) }),
]);
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

  /** ADR-0120 D1: `help.topic`, always offered (Quoky's own help). */
  readonly catalog: readonly NlCatalogEntry[] = Object.freeze([nlWave1Entry('help.topic')]);

  constructor(private readonly deps: HelpIntentTurnHandlerDeps) {}

  /**
   * A validated `help.topic` selection (ADR-0120 interfaces): the topic's contributed help lines (the same filtered
   * subset a how-to question gets), or the full help text for `all` or a topic with no contributed line.
   */
  async handleSelected(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    if (selected.entryId !== 'help.topic') return null;
    const all = typeof this.deps.helpLines === 'function' ? this.deps.helpLines() : this.deps.helpLines;
    const topic = nlStringArg(selected.args, 'topic') ?? 'all';
    const topics = [...(this.deps.topics ?? HELP_INTENT_TOPICS), ...SELECTION_ONLY_TOPICS];
    const lines =
      topic === 'all'
        ? []
        : selectHelpLines({ topicIds: [topic], language: selected.language }, all, { topics, exclude: HELP_INTENT_HELP_LINES });
    if (lines.length === 0) {
      return { reply: outboundMessage(ctx.message.context, renderHelpText(all), { replyToMessageId: ctx.message.id }) };
    }
    return {
      reply: { context: ctx.message.context, text: composeHelpIntentReply(selected.language, lines), replyToMessageId: ctx.message.id },
    };
  }

  /**
   * ADR-0120 D6 Phase C: the help-intent matcher (frozen Class B, ADR-0104 D4) would answer this message — a how-to
   * question with contributed lines, or the capability question. The `help.topic` equivalent is given for one topic the
   * catalog names (or `all` for the capability question); several topics have none. Pure, like `handle`'s matching.
   */
  classBProbe(ctx: TurnHandlerProbeContext): NlClassBProbe | null {
    try {
      const topics = this.deps.topics ?? HELP_INTENT_TOPICS;
      const match = detectHelpIntent(ctx.message.text, topics);
      if (match === null) {
        return detectCapabilityQuestion(ctx.message.text) === null ? null : { grammarId: HELP_INTENT_GRAMMAR_ID, selection: { entryId: 'help.topic', args: {} } };
      }
      const source = typeof this.deps.helpLines === 'function' ? this.deps.helpLines() : this.deps.helpLines;
      if (selectHelpLines(match, source, { topics, exclude: HELP_INTENT_HELP_LINES }).length === 0) return null;
      const [topic, ...more] = match.topicIds;
      return topic !== undefined && more.length === 0 && (NL_HELP_TOPICS as readonly string[]).includes(topic) && topic !== 'all'
        ? { grammarId: HELP_INTENT_GRAMMAR_ID, selection: { entryId: 'help.topic', args: { topic } } }
        : { grammarId: HELP_INTENT_GRAMMAR_ID };
    } catch {
      return null;
    }
  }

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    try {
      const topics = this.deps.topics ?? HELP_INTENT_TOPICS;
      const match = detectHelpIntent(ctx.message.text, topics);
      if (match === null) {
        // DET-2 (live QA session 3 D11): "뭐 할 수 있어?" gets exactly the "도움말" text (the quickstart's answer),
        // built from the same contributed lines the runtime's help reply lists (this handler's own line included).
        if (detectCapabilityQuestion(ctx.message.text) === null) return null;
        const all = typeof this.deps.helpLines === 'function' ? this.deps.helpLines() : this.deps.helpLines;
        // PLT-0: the help text carries a platform note (neutral content); the adapter renders it.
        return { reply: outboundMessage(ctx.message.context, renderHelpText(all), { replyToMessageId: ctx.message.id }) };
      }
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

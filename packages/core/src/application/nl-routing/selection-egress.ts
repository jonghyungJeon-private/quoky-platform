import { executionLocalityOf, type AiExecutionLocality, type AiProvider } from '../../ports/ai-provider.port';

/**
 * ADR-0120 D6/D8 (no new egress): a selection or planner call may go only to the provider (its id, or its family when it
 * has one) and the declared execution locality that this turn's chat would reach. Pure; one rule shared by
 * `NlSelectionService` and the ADR-0121 S2 planner (`AgentRunService`), never copied.
 */
export function nlSameEgress(
  selector: Pick<AiProvider, 'id' | 'family' | 'executionLocality'>,
  chatProviderId: string,
  chatProviderLocality: AiExecutionLocality | undefined,
): 'same' | 'chat-provider-differs' | 'chat-locality-differs' {
  if ((selector.family ?? selector.id) !== chatProviderId) return 'chat-provider-differs';
  if (executionLocalityOf(selector) !== (chatProviderLocality ?? 'REMOTE')) return 'chat-locality-differs';
  return 'same';
}

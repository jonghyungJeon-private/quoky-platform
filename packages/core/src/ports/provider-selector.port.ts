import type { Capability } from '../domain';
import type { AiProvider } from './ai-provider.port';
import type { ProviderSelectionContext } from './provider-selection-policy.port';

/**
 * PORT: selects an AiProvider for a capability (CAP-008, ADR-0029). The provider-
 * selection responsibility, separated from any single router implementation so a
 * capability depends on the SELECTION CONTRACT, not on a concrete router:
 *
 *   Capability → ProviderSelector → AiProvider
 *
 * v2 implementation: `CapabilityRouter` (highest-priority available provider). The
 * core never names a concrete CLI; selection stays policy-driven. The optional
 * `context` (ADR-0092 amendment, runtime switching) lets the owner's selection policy
 * apply a session-scoped preference; omitting it means "no conversation".
 */
export interface ProviderSelector {
  select(capability: Capability, context?: ProviderSelectionContext): Promise<AiProvider>;
  /**
   * Optional, SYNCHRONOUS dispatch-time check: whether `provider` (one this selector returned) is still eligible under
   * the live selection. Called immediately before `execute` with nothing awaited in between.
   */
  isStillEligible?(capability: Capability, context: ProviderSelectionContext, provider: AiProvider): boolean;
}

import type { Capability } from '../domain';
import type { AiProvider } from './ai-provider.port';
import type { ProviderSelectionContext } from './provider-selection-policy.port';

/**
 * Whether the provider a selector resolved is the owner's explicit selection for that request (ADR-0116 D3): plain
 * data derived from the policy's `ownerSelectedKey`, never from a provider id. `NOT_OWNER_SELECTED` covers the derived
 * default, the selection-time fallback and a selector without a policy.
 */
export type ProviderSelectionSource = 'OWNER_SELECTED' | 'NOT_OWNER_SELECTED';

/** A resolved selection: the provider and where its selection came from (ADR-0116 D3). */
export interface ResolvedProviderSelection {
  readonly provider: AiProvider;
  readonly source: ProviderSelectionSource;
}

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
   * Optional (ADR-0116 D3): `select`, plus the {@link ProviderSelectionSource} of the provider it resolved, taken from
   * the same policy answer. A caller that needs the source and finds no `resolve` treats the selection as
   * `NOT_OWNER_SELECTED` (fail closed).
   */
  resolve?(capability: Capability, context?: ProviderSelectionContext): Promise<ResolvedProviderSelection>;
  /**
   * Optional, SYNCHRONOUS dispatch-time check: whether `provider` (one this selector returned) is still eligible under
   * the live selection. Called immediately before `execute` with nothing awaited in between.
   */
  isStillEligible?(capability: Capability, context: ProviderSelectionContext, provider: AiProvider): boolean;
}

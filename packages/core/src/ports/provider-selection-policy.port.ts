import type { Capability, Id } from '../domain';

/**
 * What the router knows about the request it selects a provider for (ADR-0092 amendment of 2026-10-07, runtime
 * switching). Plain data; every field is optional, and a caller that has no conversation (the code-generation manager,
 * the recall scorer) passes nothing.
 */
export interface ProviderSelectionContext {
  /** The conversation Session the request belongs to, if any. */
  readonly sessionId?: Id;
  /**
   * The Actor whose turn this is. A session-scoped owner preference is keyed by (Session, Actor), so a channel Session
   * shared by several Actors never applies one Actor's preference to another.
   */
  readonly actorId?: Id;
}

/**
 * The owner's selection for one capability, as DATA (never a branch on a concrete provider):
 *
 * - `eligible` lists the selection keys of the registered providers that may serve this request. A key is the
 *   provider's `id`, supplied by the composition root's policy as an opaque string; Core compares keys, it never
 *   names one. A registered provider whose key is not listed is not eligible (it is not probed and never selected).
 *   An empty list means no provider may serve the request (for example image understanding switched off).
 * - `order`: `listed` ranks the eligible providers by their position in `eligible`, then by advertised priority;
 *   `priority` ranks them by advertised priority only (the legacy order), with `eligible` acting as a filter.
 *
 * Readiness (`isAvailable()`) still decides availability: a listed provider that is not ready is skipped, and the next
 * eligible one is selected (selection-time fallback, ADR-0092).
 */
export interface ProviderPreference {
  readonly eligible: readonly string[];
  readonly order: 'listed' | 'priority';
}

/**
 * PORT: the owner's provider-selection policy (ADR-0092 amendment, runtime switching). The router consults it with
 * the capability and the request's context; the composition root implements it from the effective selection
 * (session override → persisted operations-UI default → installation configuration → derived default). `null` means
 * "no preference": the router selects by advertised priority among every ready provider, exactly as without a policy.
 *
 * Contract: resolve, never reject (a policy that cannot read its state answers with its configured default), and
 * never call a provider.
 */
export interface ProviderSelectionPolicy {
  preferenceFor(capability: Capability, context: ProviderSelectionContext): Promise<ProviderPreference | null>;
  /**
   * Optional, SYNCHRONOUS: whether the provider with this key is still eligible for the capability under the LIVE
   * selection right now. Callers run it last, with nothing awaited between it and the provider call, so a selection
   * change that landed while selection awaited readiness (e.g. image understanding switched `off`) is honoured. It
   * must not throw; any doubt is `false`. Absent means "no dispatch-time check" (always eligible).
   */
  isEligible?(capability: Capability, context: ProviderSelectionContext, providerKey: string): boolean;
}

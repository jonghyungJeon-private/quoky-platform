import { AiProviderError, NoProviderAvailableError } from '../errors';
import { AiFailureKind, type Capability } from '../domain';
import type {
  AiProvider,
  ProviderPreference,
  ProviderSelectionContext,
  ProviderSelectionPolicy,
  ProviderSelector,
} from '../ports';
import type { AiProviderManager } from './ai-provider-manager';

/**
 * Selects an AiProvider for a capability — the `ProviderSelector` implementation
 * (CAP-008, ADR-0029). This is the concrete expression of "capabilities are above
 * models": the core asks for a CAPABILITY and the router returns whichever AVAILABLE
 * provider advertises the highest priority for it. No concrete CLI name appears here —
 * the fallback policy lives in the priorities each provider advertises (see
 * AiCapabilityDescriptor docs).
 *
 * ADR-0092 amendment (runtime switching): an optional {@link ProviderSelectionPolicy} supplies the owner's selection
 * as data — which providers are eligible and whether their listed order wins over advertised priority. The router
 * compares the policy's opaque keys with each provider's key ({@link selectionKeyOf}); it never names a provider and
 * never branches on one. Without a policy (or when the policy answers `null`) selection is exactly the legacy path.
 */
export class CapabilityRouter implements ProviderSelector {
  constructor(
    private readonly manager: AiProviderManager,
    private readonly policy?: ProviderSelectionPolicy,
  ) {}

  async select(capability: Capability, context: ProviderSelectionContext = {}): Promise<AiProvider> {
    const preference = this.policy ? await this.policy.preferenceFor(capability, context) : null;
    const candidates = preference === null
      ? await this.manager.availableFor(capability)
      : await this.manager.readyAmong(this.eligible(capability, preference));
    if (candidates.length === 0) {
      throw new NoProviderAvailableError(capability);
    }
    // Stable sort: ties keep the registration order.
    candidates.sort((a, b) => this.rank(a, preference) - this.rank(b, preference)
      || this.priority(b, capability) - this.priority(a, capability));
    // Non-null: length checked above; noUncheckedIndexedAccess-safe via assertion.
    return this.invalidatingOnUnavailable(candidates[0] as AiProvider);
  }

  /**
   * Dispatch-time check (synchronous): the policy's `isEligible` for this provider's key under the live selection. A
   * provider that no longer advertises the capability is not eligible; without a policy (or without `isEligible`) the
   * legacy path has nothing to re-check.
   */
  isStillEligible(capability: Capability, context: ProviderSelectionContext, provider: AiProvider): boolean {
    if (!provider.capabilities.some((c) => c.capability === capability)) return false;
    const check = this.policy?.isEligible;
    if (check === undefined) return true;
    try {
      return check.call(this.policy, capability, context, selectionKeyOf(provider));
    } catch {
      return false;
    }
  }

  /** Registered providers that advertise the capability and whose key the preference lists (unprobed). */
  private eligible(capability: Capability, preference: ProviderPreference): AiProvider[] {
    return this.manager
      .all()
      .filter((p) => p.capabilities.some((c) => c.capability === capability))
      .filter((p) => preference.eligible.includes(selectionKeyOf(p)));
  }

  /** The listed position (lower wins) under a `listed` preference; every provider ties otherwise. */
  private rank(provider: AiProvider, preference: ProviderPreference | null): number {
    if (preference === null || preference.order !== 'listed') return 0;
    const index = preference.eligible.indexOf(selectionKeyOf(provider));
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  }

  /**
   * The selected provider's `execute` drops its cached readiness probe when it fails UNAVAILABLE, so the
   * next turn re-probes (and can route to another provider) instead of reusing a stale "ready" for the TTL.
   * Every other member is delegated unchanged; the error is rethrown as-is.
   */
  private invalidatingOnUnavailable(provider: AiProvider): AiProvider {
    const manager = this.manager;
    return new Proxy(provider, {
      get(target, prop) {
        if (prop === 'execute') {
          return async (...args: Parameters<AiProvider['execute']>) => {
            try {
              return await target.execute(...args);
            } catch (err) {
              if (err instanceof AiProviderError && err.kind === AiFailureKind.UNAVAILABLE) {
                manager.invalidate(target);
              }
              throw err;
            }
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  private priority(provider: AiProvider, capability: Capability): number {
    const desc = provider.capabilities.find((c) => c.capability === capability);
    return desc ? desc.priority : Number.NEGATIVE_INFINITY;
  }
}

/**
 * The key a {@link ProviderSelectionPolicy} names a registered provider by: its stable `id`, read as opaque data and
 * only ever compared with the policy's own keys (never with a literal).
 */
function selectionKeyOf(provider: AiProvider): string {
  return provider.id;
}

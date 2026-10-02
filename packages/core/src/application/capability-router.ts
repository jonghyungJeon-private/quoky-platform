import { AiProviderError, NoProviderAvailableError } from '../errors';
import { AiFailureKind, type Capability } from '../domain';
import type { AiProvider, ProviderSelector } from '../ports';
import type { AiProviderManager } from './ai-provider-manager';

/**
 * Selects an AiProvider for a capability — the `ProviderSelector` implementation
 * (CAP-008, ADR-0029). This is the concrete expression of "capabilities are above
 * models": the core asks for a CAPABILITY and the router returns whichever AVAILABLE
 * provider advertises the highest priority for it. No concrete CLI name appears here —
 * the fallback policy lives in the priorities each provider advertises (see
 * AiCapabilityDescriptor docs).
 */
export class CapabilityRouter implements ProviderSelector {
  constructor(private readonly manager: AiProviderManager) {}

  async select(capability: Capability): Promise<AiProvider> {
    const candidates = await this.manager.availableFor(capability);
    if (candidates.length === 0) {
      throw new NoProviderAvailableError(capability);
    }
    candidates.sort((a, b) => this.priority(b, capability) - this.priority(a, capability));
    // Non-null: length checked above; noUncheckedIndexedAccess-safe via assertion.
    return this.invalidatingOnUnavailable(candidates[0] as AiProvider);
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

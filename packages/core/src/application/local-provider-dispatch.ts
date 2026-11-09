import type { Capability } from '../domain';
import { executionLocalityOf, type AiProvider } from '../ports/ai-provider.port';
import type { ProviderSelectionContext } from '../ports/provider-selection-policy.port';
import type { ProviderSelector } from '../ports/provider-selector.port';

/**
 * ADR-0124 Part L, slice C5a (DECISIONS ADR-0124 section 17): a provider for a request that must stay on this host. It sits
 * over the existing {@link ProviderSelector} port and adds no port: the constraint is data on the selection context
 * (`requiredLocality: 'LOCAL'`), and the answer of the port is re-read here rather than trusted.
 *
 * - A `REMOTE` provider is never returned, whatever the selector answers (its locality is read through
 *   {@link executionLocalityOf}: absent, unknown or a throwing declaration is `REMOTE`, fail closed).
 * - No ready `LOCAL` provider is a typed `not-ready`, never an exception, and nothing is called.
 * - Core reads only the declared locality: it never parses a model name or branches on a provider id. A cloud-served Ollama
 *   model is declared `REMOTE` by its adapter (any name or tag containing `cloud`, ADR-0107 D6), so it is refused here.
 */
export type RequiredLocalSelection = { readonly kind: 'selected'; readonly provider: AiProvider } | { readonly kind: 'not-ready' };

function declaresLocal(provider: AiProvider): boolean {
  try {
    return executionLocalityOf(provider) === 'LOCAL';
  } catch {
    return false;
  }
}

/** The context with the `LOCAL` constraint set (every other field kept). */
export function withRequiredLocal(context: ProviderSelectionContext = {}): ProviderSelectionContext {
  return { ...context, requiredLocality: 'LOCAL' };
}

/** Selects a `LOCAL` provider for `capability`, or `not-ready`. Total: never throws, never calls the provider. */
export async function selectRequiredLocalProvider(
  selector: ProviderSelector,
  capability: Capability,
  context: ProviderSelectionContext = {},
): Promise<RequiredLocalSelection> {
  let provider: AiProvider;
  try {
    provider = await selector.select(capability, withRequiredLocal(context));
  } catch {
    return { kind: 'not-ready' };
  }
  if (typeof provider !== 'object' || provider === null || !declaresLocal(provider)) return { kind: 'not-ready' };
  return { kind: 'selected', provider };
}

/**
 * The dispatch-time check, SYNCHRONOUS: run it immediately before `execute`, with nothing awaited in between. The provider
 * must still declare `LOCAL` and, when the selector can re-check, still be eligible under the constraint. `false` means no
 * call (and, in an S3 run, a partial reply: never another provider).
 */
export function isRequiredLocalDispatchAllowed(
  selector: ProviderSelector,
  capability: Capability,
  context: ProviderSelectionContext,
  provider: AiProvider,
): boolean {
  if (!declaresLocal(provider)) return false;
  const check = selector.isStillEligible;
  if (check === undefined) return true;
  try {
    return check.call(selector, capability, withRequiredLocal(context), provider) === true;
  } catch {
    return false;
  }
}

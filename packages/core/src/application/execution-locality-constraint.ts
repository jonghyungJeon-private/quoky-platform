import type { AiExecutionLocality, AiProvider } from '../ports/ai-provider.port';
import type { ProviderSelectionContext } from '../ports/provider-selection-policy.port';

/**
 * ADR-0121 D12 (amended, ratified 2026-11-16) and ADR-0124 Part L C5a: the execution-locality constraint of a selection
 * context, read as data. Pure and total.
 *
 * - `undefined`: no constraint (neither `requiredLocality` nor `allowedExecutionLocalities` is set); selection is unchanged.
 * - Otherwise the allowed set: `requiredLocality: 'LOCAL'` keeps `LOCAL` only (any other set value allows nothing), `allowedExecutionLocalities` keeps its listed
 *   localities, and when both are set the set is their intersection. An `allowedExecutionLocalities` that is not an array of
 *   known localities (or that cannot be read) is unverifiable: the empty set, so no provider fits (fail closed).
 */
export function allowedExecutionLocalitiesOf(context: ProviderSelectionContext): ReadonlySet<AiExecutionLocality> | undefined {
  let required: unknown;
  let listed: unknown;
  try {
    required = context.requiredLocality;
    listed = context.allowedExecutionLocalities;
  } catch {
    return new Set();
  }
  if (required === undefined && listed === undefined) return undefined;
  let allowed = new Set<AiExecutionLocality>(['LOCAL', 'REMOTE']);
  // `requiredLocality` (ADR-0124 Part L C5a): `'LOCAL'` keeps `LOCAL` only; any other set value is unverifiable, so nothing
  // fits (fail closed; CA review round 1).
  if (required !== undefined) allowed = required === 'LOCAL' ? new Set(['LOCAL']) : new Set();
  if (listed !== undefined) {
    const known = knownLocalities(listed);
    allowed = known === undefined ? new Set() : new Set([...allowed].filter((locality) => known.has(locality)));
  }
  return allowed;
}

/** The provider's declared locality (absent = `REMOTE`, ADR-0107 D6), or `undefined` when reading it throws (unverifiable). */
export function declaredExecutionLocality(provider: Pick<AiProvider, 'executionLocality'>): AiExecutionLocality | undefined {
  try {
    return provider.executionLocality === 'LOCAL' ? 'LOCAL' : 'REMOTE';
  } catch {
    return undefined;
  }
}

/** Whether the provider's declared locality is in the allowed set. A locality that cannot be read never fits. */
export function fitsExecutionLocality(allowed: ReadonlySet<AiExecutionLocality>, provider: Pick<AiProvider, 'executionLocality'>): boolean {
  const locality = declaredExecutionLocality(provider);
  return locality !== undefined && allowed.has(locality);
}

function knownLocalities(value: unknown): ReadonlySet<AiExecutionLocality> | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const out = new Set<AiExecutionLocality>();
    for (const item of value as unknown[]) {
      if (item !== 'LOCAL' && item !== 'REMOTE') return undefined;
      out.add(item);
    }
    return out;
  } catch {
    return undefined;
  }
}

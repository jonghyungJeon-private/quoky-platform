import type { AiProvider } from '../../ports/ai-provider.port';

/**
 * ADR-0121 amendment A8.3 (OQ1-1): is the provider that would summarise a live item the EXPECTED recipient?
 *
 * Pure data comparison. The composition root's selection policy supplies the expected key (`expectedRecipientKey`) and the
 * display label function; Core compares the selected provider's key and label with them and never names, ranks or branches on
 * a provider. Fail closed: a missing expected key, a missing label or any doubt is not "expected".
 *
 * - `local`: the provider declares local execution (nothing leaves the host): no question, no recipient line (SR-1 W4).
 * - `expected`: REMOTE, its key equals the expected key AND it has a display label (a label alone never qualifies).
 * - `unexpected`: REMOTE with a label but not the expected key (a fallback, the vendor exclusion, any other recipient).
 * - `unnamed`: REMOTE without a label: no question can name it, so nothing is sent.
 */
export type RecipientVerdict =
  | { readonly kind: 'local' }
  | { readonly kind: 'expected'; readonly key: string; readonly label: string }
  | { readonly kind: 'unexpected'; readonly key: string; readonly label: string }
  | { readonly kind: 'unnamed' };

export function recipientVerdict(
  provider: AiProvider,
  expectedKey: string | undefined,
  recipientLabel: (provider: AiProvider) => string | undefined,
): RecipientVerdict {
  try {
    // Fail closed like `executionLocalityOf`: only an explicit LOCAL declaration is local; anything else is REMOTE.
    if (provider.executionLocality === 'LOCAL') return { kind: 'local' };
    const label = recipientLabel(provider);
    if (typeof label !== 'string' || label.trim().length === 0) return { kind: 'unnamed' };
    // The selection key is the provider's opaque `id`, the same value the router's `selectionKeyOf` reads; compared, never branched on.
    const key = provider.id;
    if (typeof key !== 'string' || key.length === 0) return { kind: 'unnamed' };
    return typeof expectedKey === 'string' && expectedKey === key ? { kind: 'expected', key, label } : { kind: 'unexpected', key, label };
  } catch {
    return { kind: 'unnamed' };
  }
}

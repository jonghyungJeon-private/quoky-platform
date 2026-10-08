import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEARNING_EGRESS_LOCAL_ONLY, LEARNING_EXAMPLE_EGRESS_OWNER_SELECTED_REMOTE } from '../../domain';
import {
  LOCAL_ONLY_CURATED_EXAMPLE_EGRESS_POLICY,
  curatedExampleEgressOf,
  isCuratedExampleEgressAllowed,
} from './curated-example-egress-policy';

/**
 * ADR-0116 D2/D3: the curated-example egress rule as a table over the provider's declared locality, the selection
 * source and the entry's use-time egress class. Data only — no provider id appears anywhere.
 */
describe('curated-example egress policy (ADR-0107 D6 as amended by ADR-0116)', () => {
  const LOCAL_ONLY = LEARNING_EGRESS_LOCAL_ONLY;
  const OWNER_REMOTE = LEARNING_EXAMPLE_EGRESS_OWNER_SELECTED_REMOTE;

  it('the flag picks the use-time class; off (the default) is LOCAL_ONLY exactly as before', () => {
    expect(curatedExampleEgressOf(LOCAL_ONLY_CURATED_EXAMPLE_EGRESS_POLICY)).toBe(LOCAL_ONLY);
    expect(curatedExampleEgressOf({ remoteOwnerSelected: false })).toBe(LOCAL_ONLY);
    expect(curatedExampleEgressOf({ remoteOwnerSelected: true })).toBe(OWNER_REMOTE);
  });

  it.each([
    // [egress, locality, source, allowed]
    [LOCAL_ONLY, 'LOCAL', undefined, true],
    [LOCAL_ONLY, 'LOCAL', 'NOT_OWNER_SELECTED', true],
    [LOCAL_ONLY, 'LOCAL', 'OWNER_SELECTED', true],
    [LOCAL_ONLY, 'REMOTE', 'OWNER_SELECTED', false],
    [LOCAL_ONLY, 'REMOTE', 'NOT_OWNER_SELECTED', false],
    [LOCAL_ONLY, undefined, 'OWNER_SELECTED', false],
    [OWNER_REMOTE, 'LOCAL', undefined, true],
    [OWNER_REMOTE, 'LOCAL', 'NOT_OWNER_SELECTED', true],
    [OWNER_REMOTE, 'REMOTE', 'OWNER_SELECTED', true],
    // An undeclared locality is REMOTE (fail closed); with an owner selection the REMOTE rule applies.
    [OWNER_REMOTE, undefined, 'OWNER_SELECTED', true],
    // The derived default and the selection-time fallback are NOT_OWNER_SELECTED; a missing source fails closed.
    [OWNER_REMOTE, 'REMOTE', 'NOT_OWNER_SELECTED', false],
    [OWNER_REMOTE, 'REMOTE', undefined, false],
    [OWNER_REMOTE, undefined, undefined, false],
    // Unknown values are never allowed.
    ['ANYWHERE', 'LOCAL', 'OWNER_SELECTED', false],
    ['ANYWHERE', 'REMOTE', 'OWNER_SELECTED', false],
    [undefined, 'LOCAL', 'OWNER_SELECTED', false],
    [OWNER_REMOTE, 'cloud', 'NOT_OWNER_SELECTED', false],
    [OWNER_REMOTE, 'REMOTE', 'owner', false],
  ] as const)('%s for %s / %s → %s', (egress, executionLocality, selectionSource, allowed) => {
    const target = {
      ...(executionLocality === undefined ? {} : { executionLocality: executionLocality as 'LOCAL' }),
      ...(selectionSource === undefined ? {} : { selectionSource: selectionSource as 'OWNER_SELECTED' }),
    };
    expect(isCuratedExampleEgressAllowed(egress, target)).toBe(allowed);
  });

  it('source scan: the policy names no provider and reads no provider id', () => {
    const source = readFileSync(new URL('./curated-example-egress-policy.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/claude|codex|ollama|anthropic|openai|gemini/iu);
    expect(source).not.toMatch(/\.id\b|providerId/u);
  });
});

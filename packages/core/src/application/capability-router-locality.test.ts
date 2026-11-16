import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Capability } from '../domain';
import { NoProviderAvailableError } from '../errors';
import type { AiExecutionLocality, AiProvider, ProviderPreference, ProviderSelectionContext, ProviderSelectionPolicy } from '../ports';
import { AiProviderManager } from './ai-provider-manager';
import { CapabilityRouter } from './capability-router';
import { allowedExecutionLocalitiesOf, fitsExecutionLocality } from './execution-locality-constraint';

/**
 * ADR-0121 D12 (amended, ratified 2026-11-16): `allowedExecutionLocalities` on the existing `ProviderSelectionContext` is a data
 * constraint. Candidates are capability ∩ owner policy ∩ locality ∩ `workText` (the policy's own rule); the router never probes,
 * ranks or returns a provider outside the set, and its dispatch-time check answers `false` for one. `requiredLocality`
 * (ADR-0124 Part L C5a) keeps its meaning; with both set the allowed set is their intersection.
 */

function provider(id: string, locality: AiExecutionLocality | undefined, priority: number, probes: string[]): AiProvider {
  return {
    id,
    ...(locality !== undefined ? { executionLocality: locality } : {}),
    capabilities: [{ capability: Capability.SUMMARIZATION, priority }],
    isAvailable: async () => (probes.push(id), true),
    execute: async () => ({ text: id }),
  };
}

function fixture(policy?: ProviderSelectionPolicy) {
  const probes: string[] = [];
  const local = provider('p-local', 'LOCAL', 10, probes);
  const remote = provider('p-remote', 'REMOTE', 90, probes);
  const undeclared = provider('p-undeclared', undefined, 50, probes);
  const router = new CapabilityRouter(new AiProviderManager([local, remote, undeclared]), policy);
  return { probes, local, remote, undeclared, router };
}

describe('allowedExecutionLocalitiesOf (the constraint as data)', () => {
  it('absent means no constraint; a listed set is kept; the two fields intersect', () => {
    expect(allowedExecutionLocalitiesOf({})).toBeUndefined();
    expect(allowedExecutionLocalitiesOf({ workText: true, sessionId: 's' })).toBeUndefined();
    expect([...(allowedExecutionLocalitiesOf({ allowedExecutionLocalities: ['LOCAL'] }) ?? [])]).toEqual(['LOCAL']);
    expect([...(allowedExecutionLocalitiesOf({ allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }) ?? [])].sort()).toEqual(['LOCAL', 'REMOTE']);
    expect([...(allowedExecutionLocalitiesOf({ requiredLocality: 'LOCAL' }) ?? [])]).toEqual(['LOCAL']);
    expect([...(allowedExecutionLocalitiesOf({ requiredLocality: 'LOCAL', allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }) ?? [])]).toEqual(['LOCAL']);
    expect([...(allowedExecutionLocalitiesOf({ requiredLocality: 'LOCAL', allowedExecutionLocalities: ['REMOTE'] }) ?? [])]).toEqual([]);
  });

  it('an empty, malformed or unreadable set is unverifiable: nothing fits (fail closed)', () => {
    for (const bad of [[], ['local'], ['LOCAL', 'CLOUD'], 'LOCAL', { 0: 'LOCAL' }, null]) {
      expect([...(allowedExecutionLocalitiesOf({ allowedExecutionLocalities: bad as never }) ?? ['undefined'])], JSON.stringify(bad)).toEqual([]);
    }
    // A set `requiredLocality` other than 'LOCAL' is unverifiable too (CA review round 1).
    expect([...(allowedExecutionLocalitiesOf({ requiredLocality: 'REMOTE' as never }) ?? ['undefined'])]).toEqual([]);
    expect([...(allowedExecutionLocalitiesOf({ requiredLocality: 'REMOTE' as never, allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }) ?? ['undefined'])]).toEqual([]);
    const throwing = { get allowedExecutionLocalities(): never { throw new Error('x'); } } as ProviderSelectionContext;
    expect([...(allowedExecutionLocalitiesOf(throwing) ?? ['undefined'])]).toEqual([]);
  });

  it('the module reads declared locality only: no provider name, no id, no other literal', () => {
    const source = readFileSync(new URL('./execution-locality-constraint.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
    expect(code).not.toMatch(/\.id\b|claude|codex|ollama|openai|gemini/iu);
    expect(new Set([...code.matchAll(/'([^'\n]*)'/gu)].map((match) => match[1]))).toEqual(new Set(['../ports/ai-provider.port', '../ports/provider-selection-policy.port', 'LOCAL', 'REMOTE', 'executionLocality']));
  });

  it('a provider whose locality cannot be read never fits; an undeclared one is REMOTE', () => {
    const unreadable = { get executionLocality(): never { throw new Error('x'); } };
    expect(fitsExecutionLocality(new Set(['LOCAL', 'REMOTE']), unreadable)).toBe(false);
    expect(fitsExecutionLocality(new Set(['REMOTE']), {})).toBe(true);
    expect(fitsExecutionLocality(new Set(['LOCAL']), {})).toBe(false);
  });
});

describe('CapabilityRouter under allowedExecutionLocalities', () => {
  it('without the field selection is unchanged (the highest priority wins)', async () => {
    const { router } = fixture();
    expect((await router.select(Capability.SUMMARIZATION)).id).toBe('p-remote');
  });

  it('LOCAL only: a lower-ranked LOCAL provider is chosen and no REMOTE provider is even probed', async () => {
    const { router, probes } = fixture();
    const chosen = await router.select(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL'] });
    expect(chosen.id).toBe('p-local');
    expect(probes).toEqual(['p-local']);
  });

  it('REMOTE only keeps the undeclared provider (REMOTE by default) and drops the LOCAL one', async () => {
    const { router, probes } = fixture();
    expect((await router.select(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['REMOTE'] })).id).toBe('p-remote');
    expect(probes.sort()).toEqual(['p-remote', 'p-undeclared']);
  });

  it('an empty or malformed set selects nothing and probes nothing', async () => {
    for (const bad of [[], ['local']]) {
      const { router, probes } = fixture();
      await expect(router.select(Capability.SUMMARIZATION, { allowedExecutionLocalities: bad as never })).rejects.toBeInstanceOf(NoProviderAvailableError);
      expect(probes).toEqual([]);
    }
  });

  it('owner policy ∩ locality: a provider the policy does not list stays out even when its locality is allowed', async () => {
    const policy: ProviderSelectionPolicy = { preferenceFor: async (): Promise<ProviderPreference> => ({ eligible: ['p-local', 'p-undeclared'], order: 'priority' }) };
    const { router } = fixture(policy);
    expect((await router.select(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL', 'REMOTE'] })).id).toBe('p-undeclared');
    expect((await router.select(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL'] })).id).toBe('p-local');
  });

  it('workText ∩ locality: the policy excludes a work-text vendor and the locality excludes the rest, so nothing is chosen', async () => {
    const seen: ProviderSelectionContext[] = [];
    // A policy's work-text rule (as the composition root's): with `workText` the vendor key is not eligible.
    const policy: ProviderSelectionPolicy = {
      preferenceFor: async (_capability, context): Promise<ProviderPreference> => {
        seen.push(context);
        return { eligible: context.workText === true ? ['p-local'] : ['p-local', 'p-remote'], order: 'priority' };
      },
      isEligible: (_capability, context, key) => (context.workText === true ? key === 'p-local' : true),
    };
    const { router, remote, local } = fixture(policy);
    await expect(router.select(Capability.SUMMARIZATION, { workText: true, allowedExecutionLocalities: ['REMOTE'] })).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect((await router.select(Capability.SUMMARIZATION, { workText: true, allowedExecutionLocalities: ['LOCAL', 'REMOTE'] })).id).toBe('p-local');
    // The policy sees both constraints as data; the dispatch check applies both too.
    expect(seen.at(-1)).toMatchObject({ workText: true, allowedExecutionLocalities: ['LOCAL', 'REMOTE'] });
    expect(router.isStillEligible(Capability.SUMMARIZATION, { workText: true, allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }, remote)).toBe(false);
    expect(router.isStillEligible(Capability.SUMMARIZATION, { workText: true, allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }, local)).toBe(true);
  });

  it('under the D12 field the dispatch-time check needs an explicit policy verdict (none = false); without it, unchanged', () => {
    const { router, local } = fixture();
    expect(router.isStillEligible(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL'] }, local)).toBe(false);
    expect(router.isStillEligible(Capability.SUMMARIZATION, { requiredLocality: 'LOCAL' }, local)).toBe(true);
    expect(router.isStillEligible(Capability.SUMMARIZATION, {}, local)).toBe(true);
  });

  it('the dispatch-time check refuses a provider outside the set, and a provider whose locality changed', () => {
    const { router, local, remote } = fixture({ preferenceFor: async () => null, isEligible: () => true });
    expect(router.isStillEligible(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL'] }, remote)).toBe(false);
    expect(router.isStillEligible(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL'] }, local)).toBe(true);
    expect(router.isStillEligible(Capability.SUMMARIZATION, { allowedExecutionLocalities: [] }, local)).toBe(false);
    expect(router.isStillEligible(Capability.SUMMARIZATION, { requiredLocality: 'LOCAL', allowedExecutionLocalities: ['REMOTE'] }, local)).toBe(false);
    let flipped = false;
    const flipping: AiProvider = { ...local, get executionLocality(): AiExecutionLocality { return flipped ? 'REMOTE' : 'LOCAL'; } };
    expect(router.isStillEligible(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL'] }, flipping)).toBe(true);
    flipped = true;
    expect(router.isStillEligible(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL'] }, flipping)).toBe(false);
  });
});

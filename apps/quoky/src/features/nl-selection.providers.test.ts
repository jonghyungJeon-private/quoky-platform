import { describe, expect, it } from 'vitest';
import type { CapabilityRouter, MemoryManager, NlSelectionService, SessionManager, StorageProvider } from '@quoky/core';
import { parseNlSelectionConfig } from '../nl-selection/nl-selection-config';
import { NL_SELECTION, createNlSelectionProviders } from './nl-selection.providers';

// Owner decision of 2026-11-02 ("sonnet low로 켜서 배포"): the app composition builds the service with the D4 help-scope
// classifier switched on (its one request asks for the provider's stronger selection model). Core's default stays off.

function build(env: NodeJS.ProcessEnv): NlSelectionService {
  const providers = createNlSelectionProviders(() => ({ nlSelection: parseNlSelectionConfig(env), timeZone: 'Asia/Seoul' }), { logger: { info() {}, warn() {}, error() {} } });
  const provider = providers.find((candidate) => (candidate as { provide?: unknown }).provide === NL_SELECTION) as unknown as {
    useFactory: (...args: unknown[]) => NlSelectionService;
  };
  const storage = { actors: { get: async () => null, save: async (actor: unknown) => actor } } as unknown as StorageProvider;
  return provider.useFactory({} as CapabilityRouter, {} as SessionManager, storage, {} as MemoryManager, undefined);
}

describe('NL_SELECTION composition (D4 classifier)', () => {
  it('builds the service with the help-scope classifier on, in every mode', () => {
    for (const env of [{}, { QUOKY_NL_INTENT_MODE: 'shadow' }, { QUOKY_NL_INTENT_MODE: 'active' }] as NodeJS.ProcessEnv[]) {
      const deps = (build(env) as unknown as { deps: { helpScopeClassifier?: boolean } }).deps;
      expect(deps.helpScopeClassifier, JSON.stringify(env)).toBe(true);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { AiProviderManager, Capability, CapabilityRouter, selectRequiredLocalProvider } from '@quoky/core';
import type { CliRunner } from './cli-runner';
import { OllamaCliProvider } from './index';

/**
 * ADR-0124 Part L C5a: a cloud-served Ollama model is refused under `requiredLocality: 'LOCAL'`. Core reads only the
 * declared locality; the name rule (`cloud` in the name or tag, ADR-0107 D6) stays here in the adapter. Nothing is spawned:
 * a refused provider is never probed.
 */
describe('Ollama under requiredLocality LOCAL', () => {
  it('a cloud-named model is never probed or selected; a local-named one is', async () => {
    const spawned: string[][] = [];
    const runner: CliRunner = async (_bin, args) => {
      spawned.push(args);
      return { stdout: '', stderr: '', exitCode: 0 } as never;
    };
    for (const model of ['gpt-oss:120b-cloud', 'qwen3-coder:cloud', 'Model-Cloud:latest']) {
      const cloud = new OllamaCliProvider({ model, runner });
      const router = new CapabilityRouter(new AiProviderManager([cloud]));
      expect(await selectRequiredLocalProvider(router, Capability.SUMMARIZATION), model).toEqual({ kind: 'not-ready' });
    }
    expect(spawned).toEqual([]);
    // A local-named model is a candidate: the router probes it (the cloud-named one beside it is still never probed).
    const local = new OllamaCliProvider({ model: 'qwen3:8b', runner });
    const cloud = new OllamaCliProvider({ model: 'qwen3:8b-cloud', providerId: 'ollama-cloud', runner });
    expect(local.executionLocality).toBe('LOCAL');
    await selectRequiredLocalProvider(new CapabilityRouter(new AiProviderManager([cloud, local])), Capability.SUMMARIZATION);
    expect(spawned.length).toBeGreaterThan(0);
  });

});

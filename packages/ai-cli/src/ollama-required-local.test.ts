import { describe, expect, it } from 'vitest';
import { AiProviderManager, Capability, CapabilityRouter, selectRequiredLocalProvider } from '@quoky/core';
import type { CliRunner } from './cli-runner';
import { OLLAMA_GENERATION_ENV, OllamaCliProvider } from './index';

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

  it('a production generation run sets OLLAMA_NO_CLOUD=1, so a local-named alias of a cloud model cannot run off this host (review P2c)', async () => {
    const envs: unknown[] = [];
    const runner: CliRunner = async (_bin, _args, options) => {
      envs.push(options.env);
      return { code: 0, stdout: 'note', stderr: '', timedOut: false } as never;
    };
    // The name rule sees no `cloud` in an alias, so the adapter declares it LOCAL; the CLI flag is what refuses it.
    const alias = new OllamaCliProvider({ model: 'team-notes:8b', runner });
    expect(alias.executionLocality).toBe('LOCAL');
    await alias.execute({ capability: Capability.SUMMARIZATION, prompt: 'x' });
    expect(envs).toEqual([OLLAMA_GENERATION_ENV]);
    expect(OLLAMA_GENERATION_ENV).toMatchObject({ OLLAMA_NO_CLOUD: '1' });
  });
});

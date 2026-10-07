import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OllamaCliProvider } from '@quoky/ai-cli';
import type { AiProvider, AiRequest } from '@quoky/core';
import { ExternalEgressControl } from '../provider-routing/ollama-preflight/contracts';
import {
  EXPECTED_VALIDATION_OUTPUT,
  ModelAcquisitionControl,
  VALIDATION_ADAPTER_ID,
  VALIDATION_MODEL_ID,
  VALIDATION_PROMPT,
  VALIDATION_PROMPT_DIGEST,
  VALIDATION_PROVIDER_ID,
  executeProviderGenerationValidation,
  validationPromptDigest,
} from './provider-generation-validation';
import type {
  GenerationInventorySnapshot,
  ProviderGenerationValidationDependencies,
  ProviderGenerationValidationInput,
} from './provider-generation-validation';

const input = (
  control: ModelAcquisitionControl =
    ModelAcquisitionControl.PRECHECK_OBSERVE_POSTCHECK_RISK_ACCEPTED,
): ProviderGenerationValidationInput => ({
  executableRealpath: '/approved/ollama',
  approvedLoopbackEndpoint: 'http://127.0.0.1:11434',
  modelAcquisitionControl: control,
});

const snapshot = (overrides: Partial<GenerationInventorySnapshot> = {}): GenerationInventorySnapshot => ({
  passed: true,
  requiredModelPresent: true,
  inventoryFingerprint: 'a'.repeat(64),
  externalEgressControl: ExternalEgressControl.CONFIG_RESTRICTED_RISK_ACCEPTED,
  externalEgressIsolationVerified: false,
  networkClass: 'LOOPBACK_DAEMON',
  ...overrides,
});

function dependencies(
  outputs: readonly GenerationInventorySnapshot[] = [snapshot(), snapshot()],
  response = EXPECTED_VALIDATION_OUTPUT,
): ProviderGenerationValidationDependencies & { readonly phases: string[]; readonly calls: { value: number } } {
  const phases: string[] = [];
  const calls = { value: 0 };
  return {
    phases,
    calls,
    runPreflight: async (phase) => {
      phases.push(phase);
      return outputs[phases.length - 1] as GenerationInventorySnapshot;
    },
    generationRunner: async (bin, args, options) => {
      calls.value += 1;
      expect(bin).toBe('/approved/ollama');
      expect(args).toEqual(['run', '--nowordwrap', 'llama3.1:8b']);
      expect(options).toMatchObject({
        input: VALIDATION_PROMPT,
        timeoutMs: 45_000,
        environmentProfile: 'ISOLATED_OLLAMA_VALIDATION',
        downloadMarkerPolicy: 'OLLAMA_PULL',
        env: {
          OLLAMA_HOST: 'http://127.0.0.1:11434', OLLAMA_NO_CLOUD: '1',
          NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0',
        },
      });
      return { code: 0, stdout: response, stderr: '', timedOut: false, downloadObserved: false };
    },
  };
}

describe('Stage 2B primary-only Provider generation validation', () => {
  it('uses the exact prompt contract and the real primary-only routing chain once', async () => {
    const deps = dependencies();
    const result = await executeProviderGenerationValidation(input(), deps);

    expect(Buffer.byteLength(VALIDATION_PROMPT, 'utf8')).toBe(74);
    expect(validationPromptDigest()).toBe(VALIDATION_PROMPT_DIGEST);
    expect(result).toMatchObject({
      status: 'PASS', failureCode: null, selectedProviderId: VALIDATION_PROVIDER_ID,
      selectedAdapterId: VALIDATION_ADAPTER_ID, selectedModelId: VALIDATION_MODEL_ID,
      planAttemptCount: 1, providerExecutionCount: 1, retryCount: 0,
      fallbackCount: 0, escalationCount: 0, normalizedOutput: EXPECTED_VALIDATION_OUTPUT,
      normalizedOutputDigest: createHash('sha256').update(EXPECTED_VALIDATION_OUTPUT).digest('hex'),
      expectedOutputMatched: true, modelDownloadPreventionVerified: false,
      downloadCapableCommandInvoked: true, downloadObserved: false,
      preflightPassed: true, postflightPassed: true, inventoryUnchanged: true,
    });
    expect(deps.calls.value).toBe(1);
    expect(deps.phases).toEqual(['PRE', 'POST']);
  });

  it.each([
    ['missing model', snapshot({ requiredModelPresent: false }), 'MODEL_NOT_AVAILABLE'],
    ['failed preflight', snapshot({ passed: false }), 'PRE_GENERATION_PREFLIGHT_FAILED'],
    ['unfingerprinted inventory', snapshot({ inventoryFingerprint: null }), 'PRE_GENERATION_PREFLIGHT_FAILED'],
  ])('blocks %s before Provider execution', async (_label, preflight, code) => {
    const deps = dependencies([preflight]);
    const result = await executeProviderGenerationValidation(input(), deps);
    expect(result).toMatchObject({ status: 'BLOCKED', failureCode: code, providerExecutionCount: 0 });
    expect(deps.calls.value).toBe(0);
  });

  it('blocks invalid binding identity before Provider execution', async () => {
    const deps = dependencies();
    const result = await executeProviderGenerationValidation(input(), {
      ...deps,
      providerFactory: () => new (class implements AiProvider {
        readonly id = 'ollama-cli:wrong';
        readonly capabilities = [];
        async isAvailable(): Promise<boolean> { return true; }
        async execute(_request: AiRequest) { return { text: EXPECTED_VALIDATION_OUTPUT }; }
      })(),
    });
    expect(result).toMatchObject({
      status: 'BLOCKED', failureCode: 'PROVIDER_BINDING_MISMATCH', providerExecutionCount: 0,
    });
    expect(deps.calls.value).toBe(0);
  });

  it.each([
    ['http://example.com:11434', 'remote'],
    ['http://localhost:11434', 'implicit alias'],
    ['', 'missing'],
  ])('rejects %s host before preflight', async (host) => {
    const deps = dependencies();
    const result = await executeProviderGenerationValidation(
      { ...input(), approvedLoopbackEndpoint: host }, deps,
    );
    expect(result).toMatchObject({ status: 'BLOCKED', providerExecutionCount: 0 });
    expect(deps.phases).toEqual([]);
  });

  it('requires a successful independent verifier for denied-verified mode', async () => {
    for (const verifyModelAcquisitionDenied of [() => false, () => { throw new Error('raw'); }]) {
      const deps = dependencies();
      const result = await executeProviderGenerationValidation(
        input(ModelAcquisitionControl.DENIED_VERIFIED),
        { ...deps, verifyModelAcquisitionDenied },
      );
      expect(result).toMatchObject({
        status: 'BLOCKED', failureCode: 'MODEL_DOWNLOAD_RISK_UNCONTROLLED',
        modelDownloadPreventionVerified: false, providerExecutionCount: 0,
      });
    }
  });

  it('prioritizes download observation over an expected output and hides raw markers', async () => {
    const deps = dependencies();
    const result = await executeProviderGenerationValidation(input(), {
      ...deps,
      generationRunner: async () => ({
        code: 0, stdout: EXPECTED_VALIDATION_OUTPUT, stderr: 'pulling manifest raw',
        timedOut: false, downloadObserved: true,
      }),
    });
    expect(result).toMatchObject({
      status: 'FAIL', failureCode: 'MODEL_DOWNLOAD_DETECTED', downloadObserved: true,
      providerExecutionCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('pulling manifest raw');
  });

  it.each([
    ['generic post-execution throw', { code: 0, stdout: EXPECTED_VALIDATION_OUTPUT, stderr: '', timedOut: false },
      'PROVIDER_EXECUTION_FAILED', { timedOut: false, outputOverflowed: false, downloadObserved: false }],
    ['download then throw', { code: 0, stdout: EXPECTED_VALIDATION_OUTPUT, stderr: '', timedOut: false, downloadObserved: true },
      'MODEL_DOWNLOAD_DETECTED', { downloadObserved: true }],
    ['timeout then throw', { code: null, stdout: '', stderr: '', timedOut: true, downloadObserved: false },
      'PROVIDER_EXECUTION_FAILED', { timedOut: true }],
    ['overflow then throw', { code: null, stdout: '', stderr: 'unrelated bounded reason', timedOut: false,
      downloadObserved: false, outputOverflowed: true }, 'OUTPUT_OVERFLOW', { outputOverflowed: true }],
  ])('preserves observations after %s', async (_label, runnerResult, failureCode, observed) => {
    const result = await executeProviderGenerationValidation(input(), {
      ...dependencies(), generationRunner: async () => runnerResult,
      afterProviderExecution: () => { throw new Error('raw post-execution path'); },
    });
    expect(result).toMatchObject({
      status: 'BLOCKED', failureCode, providerExecutionCount: 1,
      downloadCapableCommandInvoked: true, ...observed,
    });
    expect(JSON.stringify(result)).not.toContain('raw post-execution path');
  });

  it('observes a second invocation, blocks its delegate, and reports one retry', async () => {
    const deps = dependencies();
    let delegatedRunnerCount = 0;
    const result = await executeProviderGenerationValidation(input(), {
      ...deps,
      generationRunner: async () => {
        delegatedRunnerCount += 1;
        return { code: 0, stdout: EXPECTED_VALIDATION_OUTPUT, stderr: '', timedOut: false };
      },
      providerFactory: (options) => new (class implements AiProvider {
        readonly id = VALIDATION_PROVIDER_ID;
        readonly capabilities = [];
        async isAvailable(): Promise<boolean> { return true; }
        async execute(request: AiRequest) {
          await options.runner(options.bin, ['run', options.model], {
            cwd: '/neutral', input: request.prompt, timeoutMs: 45_000,
          });
          await options.runner(options.bin, ['run', options.model], {
            cwd: '/neutral', input: request.prompt, timeoutMs: 45_000,
          });
          return { text: EXPECTED_VALIDATION_OUTPUT };
        }
      })(),
    });
    expect(result).toMatchObject({
      status: 'FAIL', failureCode: 'PROVIDER_EXECUTION_COUNT_EXCEEDED',
      providerExecutionCount: 2, retryCount: 1, downloadCapableCommandInvoked: true,
    });
    expect(delegatedRunnerCount).toBe(1);
  });

  it('fails changed/postflight inventory without retry or fallback', async () => {
    const changed = snapshot({ inventoryFingerprint: 'b'.repeat(64) });
    const deps = dependencies([snapshot(), changed]);
    const result = await executeProviderGenerationValidation(input(), deps);
    expect(result).toMatchObject({
      status: 'FAIL', failureCode: 'INVENTORY_CHANGED', inventoryUnchanged: false,
      providerExecutionCount: 1, retryCount: 0, fallbackCount: 0, escalationCount: 0,
    });
  });

  it('maps structured runner overflow without depending on stderr prose', async () => {
    const result = await executeProviderGenerationValidation(input(), {
      ...dependencies(),
      generationRunner: async () => ({
        code: null, stdout: '', stderr: 'bounded reason may change', timedOut: false,
        outputOverflowed: true,
      }),
    });
    expect(result).toMatchObject({
      status: 'FAIL', failureCode: 'OUTPUT_OVERFLOW', outputOverflowed: true,
      normalizedOutput: null, providerExecutionCount: 1,
    });
  });

  it.each([
    [` ${EXPECTED_VALIDATION_OUTPUT}\n`, 'PASS', null, EXPECTED_VALIDATION_OUTPUT],
    [EXPECTED_VALIDATION_OUTPUT.toLowerCase(), 'FAIL', 'EXPECTED_OUTPUT_MISMATCH', null],
    [`${EXPECTED_VALIDATION_OUTPUT}.`, 'FAIL', 'EXPECTED_OUTPUT_MISMATCH', null],
    ['arbitrary private model prose fixture', 'FAIL', 'EXPECTED_OUTPUT_MISMATCH', null],
    ['x'.repeat(129), 'FAIL', 'OUTPUT_OVERFLOW', null],
  ])('applies only whitespace normalization without disclosing mismatch', async (response, status, failureCode, projected) => {
    const result = await executeProviderGenerationValidation(input(), dependencies(undefined, response));
    expect(result).toMatchObject({ status, failureCode, normalizedOutput: projected });
    const normalized = response.trim();
    const expectedDigest = Buffer.byteLength(normalized, 'utf8') > 128 ? null
      : createHash('sha256').update(normalized).digest('hex');
    expect(result.normalizedOutputDigest).toBe(expectedDigest);
    if (projected === null) expect(JSON.stringify(result)).not.toContain(response);
  });

  it.each(['UNKNOWN_CONTROL', 'x'.repeat(2_000), 'DENIED_VERIFIED_suffix', 'prefix_DENIED_VERIFIED'])
    ('sanitizes invalid acquisition control %s', async (control) => {
      const deps = dependencies();
      const result = await executeProviderGenerationValidation(
        { ...input(), modelAcquisitionControl: control as ModelAcquisitionControl }, deps,
      );
      expect(result).toMatchObject({
        status: 'BLOCKED', failureCode: 'MODEL_DOWNLOAD_RISK_UNCONTROLLED',
        modelAcquisitionControl: null, providerExecutionCount: 0,
      });
      expect(JSON.stringify(result)).not.toContain(control);
      expect(deps.calls.value).toBe(0);
    });

  it('keeps the projection bounded and the validation tool unwired', async () => {
    const result = await executeProviderGenerationValidation(input(), dependencies());
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      VALIDATION_PROMPT, '/approved/ollama', 'HOME', 'TMPDIR', 'OLLAMA_HOST',
      'pulling manifest', 'raw stdout', 'raw stderr', 'NAME ID SIZE MODIFIED',
    ]) expect(serialized).not.toContain(forbidden);
    const appModule = readFileSync(resolve(__dirname, '../app.module.ts'), 'utf8');
    expect(appModule).not.toContain('provider-generation-validation');
  });

  it('uses one exact bounded key set for success and blocked projections', async () => {
    const success = await executeProviderGenerationValidation(input(), dependencies());
    const blocked = await executeProviderGenerationValidation(
      { ...input(), modelAcquisitionControl: 'invalid' as ModelAcquisitionControl }, dependencies(),
    );
    expect(Object.keys(success).sort()).toEqual(Object.keys(blocked).sort());
    expect(Object.keys(success).sort()).toContain('normalizedOutputDigest');
  });
});

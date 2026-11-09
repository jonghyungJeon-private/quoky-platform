/**
 * Slice 3 (DECISIONS ADR-0124 section 17): arm L for the eval, through the REAL composition of slice 2.
 *
 * - The model and its pin are validated by the service's own parser (`parseChunkItemsConfig` with `QUOKY_CHUNK_ITEMS=on`):
 *   a name with `cloud` is refused, a missing or malformed 12-hex digest is refused.
 * - The provider is `composeLongItems(...)`: an `OllamaCliProvider` ALWAYS built with `localWeights.pinnedDigest` (readiness
 *   needs positive local-weights evidence from the daemon and the `ollama list` ID equal to the pin), seen as a
 *   SUMMARIZATION-only view under its own key, and the process-wide single-in-flight gate.
 * - The selector is Core's `CapabilityRouter` over an `AiProviderManager` that probes the long-item provider fresh on every
 *   selection (the composition's `uncached`), so `runS3ItemSummary` selects it under `requiredLocality: 'LOCAL'` exactly as
 *   the runtime does.
 * - A meter around the provider counts calls (by capability, so an embedding call would show), times them and records the
 *   largest number in flight; the eval-provider guard (canaries outside the plan count) sits outside the meter.
 *
 * Nothing here calls a model at construction. `ready()` runs the provider's read-only readiness probe (`ollama list`,
 * `ollama show`, `ollama show --modelfile`; no input is sent).
 */
import { execFile } from 'node:child_process';
import type { CliRunner } from '@quoky/ai-cli';
import { AiProviderManager, Capability, CapabilityRouter, type AiProvider, type ProviderSelector } from '@quoky/core';
import { parseChunkItemsConfig } from '../../item-summary/chunk-items-config';
import { composeLongItems, type ExclusiveGate } from '../../item-summary/long-item-composition';
import { CANARY_TIMEOUT_MS, guardEvalProvider, providerCanary, providerFailureReason, type GuardedProvider } from '../eval-provider-guard';

export interface MeteredCall {
  readonly ms: number;
  readonly capability: string;
  readonly outcome: 'ok' | 'timeout' | 'failed';
}

export interface CallMeter {
  readonly provider: AiProvider;
  calls(): readonly MeteredCall[];
  maxInFlight(): number;
  /** Calls whose capability is EMBEDDING (S3 makes none; RQ-3 counts them separately). */
  embeddings(): number;
}

/** Wrap `provider`: same key, capabilities, locality and readiness; every `execute` is timed and counted. */
export function meterProvider(provider: AiProvider, clock: () => number): CallMeter {
  const calls: MeteredCall[] = [];
  let inFlight = 0;
  let peak = 0;
  const wrapped: AiProvider = {
    id: provider.id,
    ...(provider.family !== undefined ? { family: provider.family } : {}),
    ...(provider.executionLocality !== undefined ? { executionLocality: provider.executionLocality } : {}),
    capabilities: provider.capabilities,
    isAvailable: () => provider.isAvailable(),
    execute: async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const start = clock();
      try {
        const result = await provider.execute(request);
        calls.push({ ms: Math.round(clock() - start), capability: String(request.capability), outcome: 'ok' });
        return result;
      } catch (error) {
        calls.push({ ms: Math.round(clock() - start), capability: String(request.capability), outcome: providerFailureReason(error) === 'timeout' ? 'timeout' : 'failed' });
        throw error;
      } finally {
        inFlight -= 1;
      }
    },
  };
  return {
    provider: wrapped,
    calls: () => [...calls],
    maxInFlight: () => peak,
    embeddings: () => calls.filter((call) => call.capability === Capability.EMBEDDING).length,
  };
}

export interface LocalArm {
  /** The guarded, metered long-item provider the selector serves. */
  readonly provider: AiProvider;
  readonly selector: ProviderSelector;
  readonly exclusive: ExclusiveGate;
  readonly meter: CallMeter;
  readonly guard: GuardedProvider;
  /** The read-only readiness probe of the pinned local model (no input sent). */
  ready(): Promise<boolean>;
}

export interface LocalArmOptions {
  readonly model: string;
  readonly digest: string;
  readonly ollamaBin?: string;
  /** Offline-test seam: the CLI runner of the real `OllamaCliProvider` (nothing is spawned in tests). */
  readonly runner?: CliRunner;
  readonly clock: () => number;
  /** The plan's maximum local calls (scales the guard's mid-run share floor). */
  readonly maxCalls: number;
}

/** Throws `ChunkItemsConfigError` (value-free code) for a cloud name or a missing / malformed pin. */
export function composeLocalArm(options: LocalArmOptions): LocalArm {
  const chunkItems = parseChunkItemsConfig({ QUOKY_CHUNK_ITEMS: 'on', QUOKY_CHUNK_ITEMS_MODEL: options.model, QUOKY_CHUNK_ITEMS_MODEL_DIGEST: options.digest });
  const composition = composeLongItems({ chunkItems, ollamaBin: options.ollamaBin ?? 'ollama', ...(options.runner !== undefined ? { runner: options.runner } : {}) });
  const composed = composition.provider;
  const gate = composition.gate;
  if (composed === undefined || gate === undefined) throw new Error('the long-item composition registered no provider');
  const meter = meterProvider(composed, options.clock);
  const guard = guardEvalProvider(meter.provider, { maxCalls: options.maxCalls, canary: providerCanary(composed, CANARY_TIMEOUT_MS, Capability.SUMMARIZATION) });
  const provider = guard.provider;
  const manager = new AiProviderManager([provider], { uncached: (candidate) => candidate === provider });
  return { provider, selector: new CapabilityRouter(manager), exclusive: gate, meter, guard, ready: () => provider.isAvailable().catch(() => false) };
}

// ---------------------------------------------------------------- CH5: peak RSS of the Ollama processes (no new dependency)

export interface RssSample {
  /** The largest single Ollama process (the runner that holds the model), KiB. */
  readonly maxProcessKiB: number;
  /** Every Ollama process together, KiB. */
  readonly sumKiB: number;
}

/** `ps -axo rss=,comm=` parsed for processes whose command name contains `ollama`; `undefined` when none or ps failed. */
export function parsePsRss(stdout: string): RssSample | undefined {
  let max = 0;
  let sum = 0;
  let found = 0;
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match === null) continue;
    const command = (match[2] ?? '').trim();
    if (!/ollama/iu.test(command.split('/').pop() ?? '')) continue;
    const rss = Number(match[1]);
    found += 1;
    sum += rss;
    max = Math.max(max, rss);
  }
  return found === 0 ? undefined : { maxProcessKiB: max, sumKiB: sum };
}

export function sampleOllamaRss(): Promise<RssSample | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'rss=,comm='], { timeout: 5_000 }, (error, stdout) => resolve(error === null ? parsePsRss(String(stdout)) : undefined));
  });
}

export interface RssReport {
  readonly measured: boolean;
  readonly samples: number;
  readonly peakProcessKiB?: number;
  readonly peakSumKiB?: number;
  readonly note: string;
}

/** Samples every `intervalMs` until `stop()`; the peak over the samples (a sampled peak can miss a spike shorter than the interval). */
export function startRssSampler(sample: () => Promise<RssSample | undefined>, intervalMs = 1_000): { stop(): Promise<RssReport> } {
  let samples = 0;
  let peakProcess = 0;
  let peakSum = 0;
  let pending: Promise<void> = Promise.resolve();
  const take = (): void => {
    pending = pending.then(async () => {
      const got = await sample().catch(() => undefined);
      if (got === undefined) return;
      samples += 1;
      peakProcess = Math.max(peakProcess, got.maxProcessKiB);
      peakSum = Math.max(peakSum, got.sumKiB);
    });
  };
  take();
  const timer = setInterval(take, intervalMs);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      take();
      await pending;
      return samples === 0
        ? { measured: false, samples: 0, note: 'not measured: no Ollama process was visible to ps during the run' }
        : { measured: true, samples, peakProcessKiB: peakProcess, peakSumKiB: peakSum, note: `sampled with ps every ${intervalMs} ms; a spike shorter than the interval can be missed` };
    },
  };
}

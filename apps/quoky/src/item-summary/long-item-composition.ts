import { OllamaCliProvider, type CliRunner } from '@quoky/ai-cli';
import { AiFailureKind, AiProviderError, Capability, S3_LIMITS } from '@quoky/core';
import type { AiProvider, LongItemSummaryOptions, OutboundMessage } from '@quoky/core';
import type { ChunkItemsConfig } from './chunk-items-config';

/**
 * ADR-0124 Part L slice C5a-2 (DECISIONS ADR-0124 section 17, "slice 2"): the composition-root pieces of the S3 long-item
 * summary. Everything here is wiring data; Core never names the provider.
 *
 * - **The long-item provider** (`QUOKY_CHUNK_ITEMS=on` only): an `OllamaCliProvider` on `QUOKY_CHUNK_ITEMS_MODEL`, ALWAYS
 *   with `localWeights.pinnedDigest` = `QUOKY_CHUNK_ITEMS_MODEL_DIGEST` (readiness needs positive local evidence and the
 *   pinned `ollama list` ID), registered under its own key {@link LONG_ITEM_PROVIDER_ID} as a SUMMARIZATION-only view. The
 *   selection policy makes that key ineligible for every request without `requiredLocality` and the ONLY eligible key of a
 *   constrained SUMMARIZATION request (`ProviderSelectionService`, `longItemKey`).
 * - **The single-in-flight gate** (RQ-3 T3-5): one local model call at a time in this process. S3 takes it per call
 *   (`exclusive`); the local embedding provider is wrapped here so its calls take the same gate (the embedding adapter and
 *   the recall modules are CH7-hashed, so the gate is applied around the provider, never inside them).
 * - **Fresh readiness** (CA P3-a): the provider manager never serves the long-item provider's readiness from its cache.
 *
 * With `QUOKY_CHUNK_ITEMS` unset or `off` nothing is registered, wrapped or passed: the provider set, the routing and the
 * runtime options are exactly today's.
 */

/** The selection key of the long-item provider (opaque to Core). */
export const LONG_ITEM_PROVIDER_ID = 'ollama-cli-long-item';

export type ExclusiveGate = <T>(work: () => Promise<T>) => Promise<T>;

/** A FIFO mutex: each work starts only after the previous one settled (resolved or rejected). Never rejects by itself. */
export function createLocalModelGate(): ExclusiveGate {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(() => work());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** A view of `inner` that serves SUMMARIZATION only, under its own key; any other capability is refused before a spawn. */
export function summarizationOnlyView(inner: AiProvider, id: string): AiProvider {
  return {
    id,
    family: inner.family ?? id,
    capabilities: inner.capabilities.filter((descriptor) => descriptor.capability === Capability.SUMMARIZATION),
    ...(inner.executionLocality !== undefined ? { executionLocality: inner.executionLocality } : {}),
    isAvailable: () => inner.isAvailable(),
    execute: async (request) => {
      if (request.capability !== Capability.SUMMARIZATION) {
        throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'the long-item model serves item summaries only');
      }
      return inner.execute(request);
    },
  };
}

/**
 * `inner` with every `execute` taken through `gate` (same key, capabilities, locality and readiness). A call whose signal
 * was aborted while it waited for the gate is not run. Review round 1 (CA P3): a call with a `timeoutMs` is bounded from
 * when it was asked, not from when the gate let it in: one whose time ran out while it waited is dropped (a timeout, never
 * spawned) and otherwise it gets only the time it has left.
 */
export function gatedProvider(inner: AiProvider, gate: ExclusiveGate, now: () => number = () => performance.now()): AiProvider {
  return {
    id: inner.id,
    ...(inner.family !== undefined ? { family: inner.family } : {}),
    capabilities: inner.capabilities,
    ...(inner.executionLocality !== undefined ? { executionLocality: inner.executionLocality } : {}),
    isAvailable: () => inner.isAvailable(),
    execute: (request) => {
      const askedAt = now();
      return gate(async () => {
        if (request.signal?.aborted === true) throw new AiProviderError(AiFailureKind.TIMEOUT, 'the local model call was abandoned while it waited');
        if (request.timeoutMs === undefined) return inner.execute(request);
        const left = Math.floor(request.timeoutMs - Math.max(0, now() - askedAt));
        if (left <= 0) throw new AiProviderError(AiFailureKind.TIMEOUT, 'the local model call timed out while it waited');
        return inner.execute(left === request.timeoutMs ? request : { ...request, timeoutMs: left });
      });
    },
  };
}

export interface LongItemCompositionInput {
  readonly chunkItems: ChunkItemsConfig;
  readonly ollamaBin: string;
  /** Offline-test seam: the CLI runner of the production `OllamaCliProvider` (nothing is spawned in tests). */
  readonly runner?: CliRunner;
}

export interface LongItemComposition {
  readonly mode: ChunkItemsConfig['mode'];
  /** The registered long-item provider (`on` only). */
  readonly provider: AiProvider | undefined;
  /** The process-wide single-in-flight gate (`on` only). */
  readonly gate: ExclusiveGate | undefined;
  /** Whether handlers attach the whole item to their summary outcomes (`shadow` or `on`). */
  readonly handlersEnabled: boolean;
  /** The providers registered after the chat providers: `extra` (embedding, gated when `on`) then the long-item provider. */
  providersAfterChat(extra: readonly AiProvider[]): AiProvider[];
  /** The provider manager's `uncached` option (absent unless `on`). */
  readonly uncached: ((provider: AiProvider) => boolean) | undefined;
  /** The runtime's `longItemSummary` option (absent when `off`). */
  runtimeOption(notify: (message: OutboundMessage) => Promise<unknown>): LongItemSummaryOptions | undefined;
}

export function composeLongItems(input: LongItemCompositionInput): LongItemComposition {
  const { mode, model } = input.chunkItems;
  const on = mode === 'on' && model !== undefined;
  const gate = on ? createLocalModelGate() : undefined;
  // Always pinned: readiness needs the daemon's local-weights evidence AND the `ollama list` ID equal to the pin.
  const provider = on
    ? summarizationOnlyView(
        new OllamaCliProvider({
          bin: input.ollamaBin,
          model: model.name,
          providerId: LONG_ITEM_PROVIDER_ID,
          timeoutMs: S3_LIMITS.callTimeoutMs,
          localWeights: { pinnedDigest: model.digest },
          ...(input.runner !== undefined ? { runner: input.runner } : {}),
        }),
        LONG_ITEM_PROVIDER_ID,
      )
    : undefined;
  return {
    mode,
    provider,
    gate,
    handlersEnabled: mode !== 'off',
    providersAfterChat: (extra) => [
      ...(gate !== undefined ? extra.map((entry) => gatedProvider(entry, gate)) : extra),
      ...(provider !== undefined ? [provider] : []),
    ],
    uncached: provider !== undefined ? (candidate) => candidate === provider : undefined,
    runtimeOption: (notify) => {
      if (mode === 'off') return undefined;
      // `shadow` makes no model call; its gate is a pass-through (nothing to serialize).
      const exclusive: ExclusiveGate = gate ?? (<T>(work: () => Promise<T>) => work());
      return { mode, exclusive, notify };
    },
  };
}

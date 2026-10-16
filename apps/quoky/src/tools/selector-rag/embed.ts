// ADR-0123 D3 / D5: local embeddings pinned by model digest and Ollama runtime version, the vector store wiring
// (`LocalVectorProvider`, pool collection with `overflow: 'reject'`) and the tau calibration. Loopback only: nothing leaves
// the host. The harness reads the pins from the local Ollama daemon and never pulls a model.
import { createHash } from 'node:crypto';
import { cosineSimilarity } from '@quoky/core';
import type { VectorProvider } from '@quoky/core';
import { LocalVectorProvider, type VectorCorruptEvent } from '@quoky/vector-local';

/** The embedding prefix policy (ADR-0123 D3): `search_query:` on both sides, because pool and gold are the same kind of text. */
export const EMBEDDING_PREFIX = 'search_query: ';
export const TAU_MARGIN = 0.02;
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const EMBED_BATCH_SIZE = 16;

export interface EmbeddingPin {
  readonly model: string;
  /** First 12 hex of the Ollama manifest digest (`ollama list` id). */
  readonly digest12: string;
  readonly ollamaVersion: string;
  /** `<sanitized name>@<digest12>@ollama<version>` (ADR-0123 D3). */
  readonly spaceId: string;
  readonly prefix: string;
}

export function sanitizeModelName(model: string): string {
  return model.replace(/:latest$/, '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function spaceIdOf(model: string, digest12: string, ollamaVersion: string): string {
  return `${sanitizeModelName(model)}@${digest12}@ollama${ollamaVersion}`;
}

/** Collection names stay inside the store's `[a-z0-9-]` pattern: the digest keeps them unique per model. */
export function collectionName(kind: 'pool' | 'gold-audit', digest12: string): string {
  return `selector-${kind}-${digest12.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

export interface Embedder {
  readonly pin: EmbeddingPin;
  embed(texts: readonly string[]): Promise<number[][]>;
}

function assertLoopback(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('the embedding harness talks to a loopback Ollama only');
  }
  return url;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function readPin(model: string, baseUrl: string = DEFAULT_OLLAMA_URL, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<EmbeddingPin> {
  if (/cloud/i.test(model)) throw new Error('cloud-served embedding models are refused (ADR-0098 D8)');
  const root = assertLoopback(baseUrl).origin;
  const version = (await (await fetchImpl(`${root}/api/version`)).json()) as { version?: string };
  const tags = (await (await fetchImpl(`${root}/api/tags`)).json()) as { models?: Array<{ name: string; digest: string }> };
  const wanted = model.includes(':') ? model : `${model}:latest`;
  const found = tags.models?.find((entry) => entry.name === wanted);
  if (found === undefined) throw new Error(`embedding model ${wanted} is not installed (the harness never pulls)`);
  if (typeof version.version !== 'string') throw new Error('Ollama did not report a version');
  const digest12 = found.digest.slice(0, 12);
  return { model, digest12, ollamaVersion: version.version, spaceId: spaceIdOf(model, digest12, version.version), prefix: EMBEDDING_PREFIX };
}

/** Embeds through the local daemon's `/api/embed` (batched). Vectors of one space only. */
export class OllamaHttpEmbedder implements Embedder {
  constructor(
    readonly pin: EmbeddingPin,
    private readonly baseUrl: string = DEFAULT_OLLAMA_URL,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    assertLoopback(baseUrl);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const response = await this.fetchImpl(`${assertLoopback(this.baseUrl).origin}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.pin.model, input: batch.map((text) => `${this.pin.prefix}${text}`), truncate: true, keep_alive: '10m' }),
      });
      if (!response.ok) throw new Error(`embedding call failed with status ${response.status}`);
      const body = (await response.json()) as { embeddings?: number[][] };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== batch.length) throw new Error('unexpected embedding response');
      out.push(...body.embeddings);
    }
    return out;
  }
}

export const cosine = (a: readonly number[], b: readonly number[]): number => cosineSimilarity(a as number[], b as number[]);

/** Record id = the first 32 hex of `sha256(normalized text + "\n" + JSON(previous, context))` (ADR-0123 D2). */
export function recordId(text: string, previous?: string, context?: string): string {
  const normalized = text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${normalized}\n${JSON.stringify([previous ?? null, context ?? null])}`).digest('hex').slice(0, 32);
}

export interface StoreHandle {
  readonly provider: VectorProvider;
  readonly rebuilds: VectorCorruptEvent[];
}

/**
 * The pool store (ADR-0123 D2 Q1 safeguards): its own directory, `overflow: 'reject'`, a logger without content, and an
 * `onCorrupt` hook that re-embeds from the checked-in pool file (the caller supplies it).
 */
export function openStore(directory: string, onCorrupt: (event: VectorCorruptEvent) => void | Promise<void>, log: (line: string) => void = () => undefined): StoreHandle {
  const rebuilds: VectorCorruptEvent[] = [];
  const provider = new LocalVectorProvider(directory, {
    overflow: 'reject',
    logger: { warn: (message, fields) => log(`${message} ${JSON.stringify(fields)}`) },
    onCorrupt: (event) => {
      rebuilds.push(event);
      return onCorrupt(event);
    },
  });
  return { provider, rebuilds };
}

export interface CalibrationInput {
  /** Cosines of the known near-copy pairs (the positives). */
  readonly positives: readonly number[];
  /** Cosines of unrelated same-feature pairs. */
  readonly negatives: readonly number[];
  readonly margin?: number;
}

export interface Calibration {
  readonly tau: number;
  readonly minPositive: number;
  readonly margin: number;
  readonly positives: number;
  readonly negatives: number;
  readonly negativeMax: number;
  readonly negativeP99: number;
  /** Share of negatives at or above tau (the false-positive rate of the lint). */
  readonly falsePositiveRate: number;
}

/**
 * tau = (the minimum cosine among the positive near-copy pairs) - margin: the largest threshold that still flags every
 * calibration near-copy, with a stated margin. Negatives report the false-positive rate at that tau.
 */
export function calibrateTau(input: CalibrationInput): Calibration {
  if (input.positives.length === 0) throw new Error('no positive calibration pairs');
  const margin = input.margin ?? TAU_MARGIN;
  const minPositive = Math.min(...input.positives);
  const tau = minPositive - margin;
  const sorted = [...input.negatives].sort((a, b) => a - b);
  const negativeMax = sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number);
  const negativeP99 = sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] as number);
  const falsePositives = sorted.filter((value) => value >= tau).length;
  return {
    tau,
    minPositive,
    margin,
    positives: input.positives.length,
    negatives: sorted.length,
    negativeMax,
    negativeP99,
    falsePositiveRate: sorted.length === 0 ? 0 : falsePositives / sorted.length,
  };
}

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
}
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] as number;
  return { p50: at(0.5), p95: at(0.95) };
}

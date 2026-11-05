/**
 * ADR-0124 phase 1 (stage A, offline code): the embedder arms E0-E3 and the hybrid EH(x) for `eval:chunk`.
 *
 * Everything here talks to the LOOPBACK Ollama daemon only (the ADR-0123 `embed.ts` loopback check and cloud refusal are
 * reused), one local model at a time, batch 16, concurrency 1 (ADR-0124 section 3.7). The harness never pulls a model. A
 * model that is not installed is dropped from the run with a note. `truncate: false` makes a passage over the model
 * context an explicit error counted as `overContext` (ADR section 6 Fit), never a silent cut.
 *
 * Embeddings of synthetic text are cached on disk (gitignored, under `data/eval`) keyed by space id and the sha256 of
 * the prefixed text, so a rerun or a passage shared between cases never re-embeds.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chunking } from '@quoky/core';
import { DEFAULT_OLLAMA_URL, EMBED_BATCH_SIZE, ModelNotInstalledError, assertLoopback, percentiles, readPin, type EmbeddingPin, type FetchLike } from '../selector-rag/embed';
import { PACK_MISS_LIMIT, lexicalWindow, type ArmWindow, type LexicalOutcome } from './arms';
import { LANGUAGES, type ChunkEvalCase, type Language } from './corpus';

export const ARM_IDS = ['E0', 'E1', 'E2', 'E3'] as const;
export type ArmId = (typeof ARM_IDS)[number];

export const RRF_K = 60;
export const KEEP_ALIVE = '2m';
export const BATCH_SIZE = EMBED_BATCH_SIZE;
/** ADR section 3.8: 1 query embedding plus 200 passage embeddings inside the 8 s embedding sub-budget. */
export const LATENCY_PASSAGES = 200;
export const LATENCY_BUDGET_MS = 8_000;
export const LATENCY_QUERIES = 1;

export interface ArmSpec {
  readonly id: ArmId;
  readonly model: string;
  readonly queryPrefix: string;
  readonly documentPrefix: string;
  readonly prefixPolicy: string;
}

const NOMIC = { queryPrefix: 'search_query: ', documentPrefix: 'search_document: ', prefixPolicy: 'search_query: / search_document: ' } as const;
export const ARM_SPECS: Readonly<Record<ArmId, ArmSpec>> = {
  E0: { id: 'E0', model: 'nomic-embed-text', ...NOMIC },
  E1: { id: 'E1', model: 'nomic-embed-text-v2-moe', ...NOMIC },
  E2: { id: 'E2', model: 'bge-m3', queryPrefix: '', documentPrefix: '', prefixPolicy: 'none' },
  E3: {
    id: 'E3',
    model: 'qwen3-embedding:0.6b',
    queryPrefix: 'Instruct: Given a question, retrieve the passages that answer it\nQuery: ',
    documentPrefix: '',
    prefixPolicy: 'instruction on the query side only; documents raw',
  },
};

export interface ArmPin extends EmbeddingPin {
  readonly arm: ArmId;
  readonly queryPrefix: string;
  readonly documentPrefix: string;
  /** From the daemon's `/api/show` (`details.parameter_size`, metadata only; no model is loaded), as reported, and in millions. null when absent. */
  readonly parameterSize: string | null;
  readonly paramsM: number | null;
  /** On-disk size from `/api/tags`; the tie-break falls back to it when the parameter count is missing. */
  readonly sizeBytes: number | null;
}

/** "137M", "566.70M", "7B", "0.6B" -> millions; null when it does not parse. */
export function parseParameterSize(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMBT])\s*$/iu.exec(text);
  if (match === null) return null;
  const scale: Record<string, number> = { K: 0.001, M: 1, B: 1000, T: 1_000_000 };
  return Math.round(Number(match[1]) * (scale[(match[2] as string).toUpperCase()] as number) * 1000) / 1000;
}

/** Reads the pin from the loopback daemon (version and tags only; no model call). Cloud names and non-loopback URLs throw. */
export async function pinArm(spec: ArmSpec, baseUrl: string = DEFAULT_OLLAMA_URL, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ArmPin> {
  const base = await readPin(spec.model, baseUrl, fetchImpl);
  const root = assertLoopback(baseUrl).origin;
  const wanted = spec.model.includes(':') ? spec.model : `${spec.model}:latest`;
  let sizeBytes: number | null = null;
  let parameterSize: string | null = null;
  try {
    const tags = (await (await fetchImpl(`${root}/api/tags`)).json()) as { models?: Array<{ name: string; size?: number }> };
    const size = tags.models?.find((entry) => entry.name === wanted)?.size;
    sizeBytes = typeof size === 'number' && size > 0 ? size : null;
    const show = await fetchImpl(`${root}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: wanted }) });
    if (show.ok) {
      const size12 = ((await show.json()) as { details?: { parameter_size?: unknown } }).details?.parameter_size;
      parameterSize = typeof size12 === 'string' ? size12 : null;
    }
  } catch {
    // metadata only: a missing size leaves the tie-break to the next rule
  }
  return { ...base, prefix: spec.documentPrefix, arm: spec.id, queryPrefix: spec.queryPrefix, documentPrefix: spec.documentPrefix, parameterSize, paramsM: parseParameterSize(parameterSize), sizeBytes };
}

export interface ResolvedArms {
  readonly planned: readonly ArmId[];
  readonly available: readonly ArmPin[];
  readonly dropped: readonly { readonly arm: ArmId; readonly reason: string }[];
}

/** A model that is not installed is dropped with a note (not a failure); any other error (cloud, non-loopback, daemon down) is thrown. */
export async function resolveArms(ids: readonly ArmId[], baseUrl: string = DEFAULT_OLLAMA_URL, fetchImpl?: FetchLike): Promise<ResolvedArms> {
  const available: ArmPin[] = [];
  const dropped: { arm: ArmId; reason: string }[] = [];
  for (const id of ids) {
    try {
      available.push(await pinArm(ARM_SPECS[id], baseUrl, fetchImpl));
    } catch (error) {
      if (error instanceof ModelNotInstalledError) dropped.push({ arm: id, reason: error.message });
      else throw error;
    }
  }
  return { planned: [...ids], available, dropped };
}

// ---------------------------------------------------------------- scope

export type Scope = 'phase1' | 'all';
export type EvalSet = 'v1' | 'v2';

/**
 * Owner decision 2026-11-05: the v1 `adr-file` shape (2 MB tier, ~39k passages) runs on E0 only; every other v1 shape and all
 * of v2 run on every available arm. `all` removes the exclusion. `shapes` (when given) keeps only those shapes in every set.
 */
export function inScope(scope: Scope, shapes: readonly string[] | undefined, set: EvalSet, arm: ArmId, item: Pick<ChunkEvalCase, 'shape'>): boolean {
  if (shapes !== undefined && shapes.length > 0 && !shapes.includes(item.shape)) return false;
  if (scope === 'phase1' && set === 'v1' && item.shape === 'adr-file') return arm === 'E0';
  return true;
}

// ---------------------------------------------------------------- cache

const b64 = (vector: Float32Array): string => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
const unb64 = (text: string): Float32Array => {
  const bytes = Buffer.from(text, 'base64');
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

const checksum = (key: string, dim: number, payload: string): string => createHash('sha256').update(`${key}|${dim}|${payload}`).digest('hex').slice(0, 16);
const finite = (vector: ArrayLike<number>): boolean => {
  for (let at = 0; at < vector.length; at += 1) if (!Number.isFinite(vector[at])) return false;
  return true;
};

/**
 * Vectors of synthetic text only. A `null` entry records a passage the model refused as over its context. Every row carries its
 * key, its dimension and a checksum over both and the payload; a row that does not verify (torn, edited, non-finite) is dropped
 * at load and counted in `rejectedAtLoad`, so its text is simply embedded again.
 */
export class EmbeddingCache {
  private readonly entries = new Map<string, Float32Array | null>();
  /** Rows that failed validation when the file was read. */
  rejectedAtLoad = 0;
  /** The most common dimension among the valid rows (undefined for an empty cache). */
  readonly storedDimension: number | undefined;
  constructor(private readonly file?: string) {
    const dims = new Map<number, number>();
    if (file !== undefined && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line === '') continue;
        try {
          const row = JSON.parse(line) as { k?: unknown; v?: unknown; d?: unknown; o?: unknown; h?: unknown };
          if (typeof row.k !== 'string' || !/^[0-9a-f]{64}$/u.test(row.k) || typeof row.h !== 'string') throw new Error('shape');
          if (row.o === 1) {
            if (row.h !== checksum(row.k, 0, 'o')) throw new Error('checksum');
            this.entries.set(row.k, null);
            continue;
          }
          if (typeof row.v !== 'string' || typeof row.d !== 'number' || !Number.isInteger(row.d) || row.d <= 0) throw new Error('shape');
          if (row.h !== checksum(row.k, row.d, row.v)) throw new Error('checksum');
          const vector = unb64(row.v);
          if (vector.length !== row.d || !finite(vector)) throw new Error('vector');
          this.entries.set(row.k, vector);
          dims.set(row.d, (dims.get(row.d) ?? 0) + 1);
        } catch {
          this.rejectedAtLoad += 1;
        }
      }
    }
    this.storedDimension = [...dims.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0];
  }
  static key(spaceId: string, prefixedText: string): string {
    return createHash('sha256').update(`${spaceId}\n${prefixedText}`).digest('hex');
  }
  get(key: string): Float32Array | null | undefined {
    return this.entries.get(key);
  }
  set(key: string, vector: Float32Array | null): void {
    this.entries.set(key, vector);
    if (this.file === undefined) return;
    mkdirSync(resolve(this.file, '..'), { recursive: true });
    const row = vector === null ? { k: key, o: 1, h: checksum(key, 0, 'o') } : { k: key, d: vector.length, v: b64(vector), h: checksum(key, vector.length, b64(vector)) };
    appendFileSync(this.file, `${JSON.stringify(row)}\n`);
  }
  get size(): number {
    return this.entries.size;
  }
}

export const cachePath = (dir: string, spaceId: string): string => resolve(dir, `${spaceId.replace(/[^A-Za-z0-9._@-]/g, '-')}.jsonl`);

// ---------------------------------------------------------------- embedder

export type Role = 'query' | 'document';
export interface EmbedItem {
  readonly text: string;
  readonly language: Language;
}
export interface CallRecord {
  readonly role: Role;
  readonly language: Language;
  readonly texts: number;
  readonly ms: number;
  readonly promptTokens: number | undefined;
  readonly hangulSyllables: number;
  readonly codePoints: number;
  /** The call was refused as over the model context (counted in calls; carries no tokens and no latency sample). */
  readonly refused: boolean;
}
export interface PlanCount {
  readonly unique: number;
  readonly cacheHits: number;
  readonly toEmbed: number;
  readonly calls: number;
}

const HANGUL = /[가-힣]/gu;
const hangulCount = (text: string): number => (text.match(HANGUL) ?? []).length;
const points = (text: string): number => Array.from(text).length;

/** Language-homogeneous batches of at most 16, in the fixed language order, items in their given order. */
export function batchesOf(items: readonly EmbedItem[]): EmbedItem[][] {
  const out: EmbedItem[][] = [];
  for (const language of LANGUAGES) {
    const group = items.filter((item) => item.language === language);
    for (let at = 0; at < group.length; at += BATCH_SIZE) out.push(group.slice(at, at + BATCH_SIZE));
  }
  return out;
}

export interface ResidentMemory {
  readonly sizeBytes: number;
  readonly sizeVramBytes: number;
}
export interface EmbedderOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly cache?: EmbeddingCache;
  /** Milliseconds; injectable so a test is deterministic. */
  readonly clock?: () => number;
}

export class ArmEmbedder {
  readonly calls: CallRecord[] = [];
  /** Inputs over the model context: fresh refusals and cached refusals alike, so fit does not depend on cache history. */
  overContext = 0;
  /** Of `overContext`, the ones answered from the cache (a prior refusal). */
  cachedRefusals = 0;
  cacheHits = 0;
  cacheMisses = 0;
  /** Cached rows rejected (failed validation at load, or a dimension that differs from this arm's). */
  cacheRejected = 0;
  private dim: number | undefined;
  private freshDim: number | undefined;
  /** A dimension some cached vector was returned with before any fresh vector fixed the run's dimension. */
  private servedCacheDim: number | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly cache: EmbeddingCache;
  private readonly clock: () => number;

  constructor(readonly pin: ArmPin, options: EmbedderOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_URL;
    assertLoopback(this.baseUrl);
    if (/cloud/i.test(pin.model)) throw new Error('cloud-served embedding models are refused (ADR-0098 D8)');
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.cache = options.cache ?? new EmbeddingCache();
    this.clock = options.clock ?? (() => performance.now());
    this.cacheRejected = this.cache.rejectedAtLoad;
    this.dim = this.cache.storedDimension;
  }

  private prefix(role: Role): string {
    return role === 'query' ? this.pin.queryPrefix : this.pin.documentPrefix;
  }

  private dedupe(items: readonly EmbedItem[]): EmbedItem[] {
    const seen = new Set<string>();
    const out: EmbedItem[] = [];
    for (const item of items) {
      if (seen.has(item.text)) continue;
      seen.add(item.text);
      out.push(item);
    }
    return out;
  }

  /** A cached row, or undefined when absent or unusable (a vector of another dimension is a miss, counted once per lookup when `count`). */
  private lookup(role: Role, item: EmbedItem, count: boolean): Float32Array | null | undefined {
    const hit = this.cache.get(EmbeddingCache.key(this.pin.spaceId, `${this.prefix(role)}${item.text}`));
    if (hit === undefined || hit === null) return hit;
    if (this.dim !== undefined && hit.length !== this.dim) {
      if (count) this.cacheRejected += 1;
      return undefined;
    }
    return hit;
  }

  /** Counts what `embed` would send, from the cache only. No call. */
  plan(role: Role, items: readonly EmbedItem[]): PlanCount {
    const unique = this.dedupe(items);
    const missing = unique.filter((item) => this.lookup(role, item, false) === undefined);
    return { unique: unique.length, cacheHits: unique.length - missing.length, toEmbed: missing.length, calls: batchesOf(missing).length };
  }

  /**
   * Fixes the arm's dimension before any vector is returned: when the run has an uncached text, the first one is embedded
   * first (its vector sets the dimension), so a cached vector of another size can never be returned ahead of it. With
   * everything cached the dimension is the cache's own, and rows of another size are misses.
   */
  async settle(groups: readonly { readonly role: Role; readonly items: readonly EmbedItem[] }[]): Promise<void> {
    if (this.freshDim !== undefined) return;
    for (const group of groups) {
      const first = group.items.find((item) => this.lookup(group.role, item, false) === undefined);
      if (first !== undefined) {
        await this.embed(group.role, [first]);
        return;
      }
    }
  }

  /** Vectors by text (`null` = over the model context). Cache hits make no call. */
  async embed(role: Role, items: readonly EmbedItem[]): Promise<Map<string, Float32Array | null>> {
    const out = new Map<string, Float32Array | null>();
    const missing: EmbedItem[] = [];
    for (const item of this.dedupe(items)) {
      const hit = this.lookup(role, item, true);
      if (hit === undefined) missing.push(item);
      else {
        out.set(item.text, hit);
        this.cacheHits += 1;
        if (hit === null) {
          this.overContext += 1;
          this.cachedRefusals += 1;
        }
      }
    }
    const fresh = async (list: readonly EmbedItem[]): Promise<void> => {
      for (const batch of batchesOf(list)) {
        const vectors = await this.callBatch(role, batch);
        batch.forEach((item, at) => {
          const vector = vectors[at] ?? null;
          out.set(item.text, vector);
          this.cache.set(EmbeddingCache.key(this.pin.spaceId, `${this.prefix(role)}${item.text}`), vector);
        });
      }
    };
    this.cacheMisses += missing.length;
    await fresh(missing);
    // the first fresh vector of the run fixes the dimension: a cached vector of another size is rejected and embedded again
    if (this.freshDim !== undefined) {
      const missed = new Set(missing.map((item) => item.text));
      const stale = [...out.entries()].filter(([text, vector]) => vector !== null && vector.length !== this.freshDim && !missed.has(text));
      if (stale.length > 0) {
        this.cacheRejected += stale.length;
        this.cacheHits -= stale.length;
        this.cacheMisses += stale.length;
        const staleTexts = new Set(stale.map(([text]) => text));
        const again = this.dedupe(items).filter((item) => staleTexts.has(item.text));
        await fresh(again);
      }
    } else {
      for (const vector of out.values()) if (vector !== null) this.servedCacheDim = vector.length;
    }
    return out;
  }

  /** Batched calls over `items`, cache bypassed. Context refusals count in `calls` and `refused` (inputs); `successfulCalls` excludes them. */
  async timed(role: Role, items: readonly EmbedItem[]): Promise<{ ms: number; calls: number; successfulCalls: number; refused: number; firstCallMs: number }> {
    const before = this.calls.length;
    const refusedBefore = this.overContext;
    const started = this.clock();
    for (const batch of batchesOf(items)) await this.callBatch(role, batch);
    const made = this.calls.slice(before);
    return { ms: this.clock() - started, calls: made.length, successfulCalls: made.filter((call) => !call.refused).length, refused: this.overContext - refusedBefore, firstCallMs: made[0]?.ms ?? 0 };
  }

  private async post(path: string, body: object): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
    const origin = assertLoopback(this.baseUrl).origin;
    return this.fetchImpl(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  private async callBatch(role: Role, batch: readonly EmbedItem[]): Promise<(Float32Array | null)[]> {
    const prefixed = batch.map((item) => `${this.prefix(role)}${item.text}`);
    const started = this.clock();
    const response = await this.post('/api/embed', { model: this.pin.model, input: prefixed, truncate: false, keep_alive: KEEP_ALIVE });
    if (!response.ok) {
      const detail = ((await response.json().catch(() => ({}))) as { error?: unknown }).error;
      // Stage C (2026-11-05): the daemon answers 413 for a request it will not take (16 whole memories of up to 8,000 units
      // in one batch). Like a context refusal, the batch is split and a single input still refused counts as over the
      // model context: an explicit count, never a silent cut.
      const contextRefusal = response.status === 400 && typeof detail === 'string' && /context|length/i.test(detail);
      if (contextRefusal || response.status === 413) {
        this.calls.push({ role, language: (batch[0] as EmbedItem).language, texts: batch.length, ms: this.clock() - started, promptTokens: undefined, hangulSyllables: 0, codePoints: 0, refused: true });
        if (batch.length === 1) {
          this.overContext += 1;
          return [null];
        }
        // which input is refused is not known from a batch error: halve the batch (one by one in the end), an explicit
        // count, never a silent cut
        const half = Math.ceil(batch.length / 2);
        return [...(await this.callBatch(role, batch.slice(0, half))), ...(await this.callBatch(role, batch.slice(half)))];
      }
      throw new Error(`embedding call failed with status ${response.status}`);
    }
    const body = (await response.json()) as { embeddings?: number[][]; prompt_eval_count?: number };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== batch.length) throw new Error('unexpected embedding response');
    this.calls.push({
      role,
      language: (batch[0] as EmbedItem).language,
      texts: batch.length,
      ms: this.clock() - started,
      promptTokens: typeof body.prompt_eval_count === 'number' ? body.prompt_eval_count : undefined,
      hangulSyllables: prefixed.reduce((sum, text) => sum + hangulCount(text), 0),
      codePoints: prefixed.reduce((sum, text) => sum + points(text), 0),
      refused: false,
    });
    const vectors = body.embeddings.map((vector) => Float32Array.from(vector));
    for (const vector of vectors) {
      if (vector.length === 0 || !finite(vector)) throw new Error('the daemon returned an unusable embedding (empty or non-finite)');
      if (this.freshDim === undefined) {
        // the first fresh vector of the run fixes the arm's dimension; cached rows of another dimension become misses
        if (this.servedCacheDim !== undefined && this.servedCacheDim !== vector.length) {
          throw new Error(`the cache for this space holds ${this.servedCacheDim}-dimensional vectors but the daemon returns ${vector.length}; remove the cache file for ${this.pin.spaceId}`);
        }
        this.freshDim = vector.length;
        this.dim = vector.length;
      } else if (vector.length !== this.freshDim) throw new Error(`the daemon returned a ${vector.length}-dimensional embedding, expected ${this.freshDim}`);
    }
    return vectors;
  }

  /** Resident memory of this arm's model from the loopback `/api/ps` (null when it is not listed or the call fails). */
  async residentMemory(): Promise<ResidentMemory | null> {
    try {
      const response = await this.fetchImpl(`${assertLoopback(this.baseUrl).origin}/api/ps`);
      if (!response.ok) return null;
      const body = (await response.json()) as { models?: Array<{ name?: string; model?: string; size?: number; size_vram?: number }> };
      const wanted = this.pin.model.includes(':') ? this.pin.model : `${this.pin.model}:latest`;
      const found = body.models?.find((entry) => entry.name === wanted || entry.model === wanted);
      return found === undefined ? null : { sizeBytes: found.size ?? 0, sizeVramBytes: found.size_vram ?? 0 };
    } catch {
      return null;
    }
  }

  /** Models other than this arm's that are resident now (a note for the report: generation and embedding never run together). */
  async otherResident(): Promise<string[]> {
    try {
      const response = await this.fetchImpl(`${assertLoopback(this.baseUrl).origin}/api/ps`);
      if (!response.ok) return [];
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      const wanted = this.pin.model.includes(':') ? this.pin.model : `${this.pin.model}:latest`;
      return (body.models ?? []).map((entry) => entry.name ?? '').filter((name) => name !== '' && name !== wanted);
    } catch {
      return [];
    }
  }

  /** Best effort: ask the daemon to unload this arm's model so only one local model is resident at a time. Errors are ignored (keep_alive expires anyway). */
  async unload(): Promise<void> {
    try {
      await this.post('/api/embed', { model: this.pin.model, input: [], keep_alive: 0 });
    } catch {
      // ignored
    }
  }
}

// ---------------------------------------------------------------- vectors, ranking, fusion

export function cosine32(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  if (a.length !== b.length) throw new Error(`cosine over vectors of different dimensions (${a.length} and ${b.length})`);
  for (let at = 0; at < a.length; at += 1) {
    const x = a[at] as number;
    const y = b[at] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Item indexes by descending score; ties by index (ordinal order). `-Infinity` scores go last. */
export function rankByScores(scores: readonly number[]): number[] {
  return scores.map((_, at) => at).sort((a, b) => (scores[b] as number) - (scores[a] as number) || a - b);
}

/** Cosine of the query against each passage vector; a missing vector (over context) scores -Infinity. */
export function cosineScores(query: Float32Array | null, vectors: readonly (Float32Array | null)[]): number[] {
  return vectors.map((vector) => (query === null || vector === null ? Number.NEGATIVE_INFINITY : cosine32(query, vector)));
}

/** Reciprocal rank fusion: score(o) = sum over rankings of 1 / (k + rank), rank 1-based; ties by ordinal. Rankings may be partial. */
export function rrfFuse(rankings: readonly (readonly number[])[], k: number = RRF_K): number[] {
  const scores = new Map<number, number>();
  for (const ranking of rankings) ranking.forEach((ordinal, at) => scores.set(ordinal, (scores.get(ordinal) ?? 0) + 1 / (k + at + 1)));
  return [...scores.keys()].sort((a, b) => (scores.get(b) as number) - (scores.get(a) as number) || a - b);
}

/** The EL arm's one-window greedy packing, over any ranking (no positive-score gate: an embedder scores every passage). */
export function packRankedWindow(item: ChunkEvalCase, passages: readonly chunking.Passage[], ranking: readonly number[]): ArmWindow {
  const chosen: number[] = [];
  let misses = 0;
  for (const ordinal of ranking) {
    const trial = [...chosen, ordinal];
    if (chunking.packWindows(item.prepared, passages, trial).length === 1) chosen.push(ordinal);
    else if ((misses += 1) >= PACK_MISS_LIMIT) break;
  }
  const windows = chosen.length === 0 ? [] : chunking.packWindows(item.prepared, passages, chosen);
  const only = windows.length === 1 ? (windows[0] as chunking.Window) : undefined;
  return only === undefined ? { text: '', sent: false, refused: false } : { text: only.text, sent: true, refused: false };
}

// ---------------------------------------------------------------- per-case bundles

export interface CaseBundle {
  readonly item: ChunkEvalCase;
  readonly lexical: LexicalOutcome;
  /** The C1 passage texts, by ordinal. */
  readonly texts: readonly string[];
}

export function bundleOf(item: ChunkEvalCase): CaseBundle {
  const lexical = lexicalWindow(item);
  const index = new chunking.CodePointIndex(item.prepared);
  return { item, lexical, texts: lexical.passages.map((passage) => index.slice(passage.span.start, passage.span.end)) };
}

/** What an arm embeds for a set of bundles: every question (query role) and every passage (document role). */
export function itemsFor(bundles: readonly CaseBundle[]): { queries: EmbedItem[]; passages: EmbedItem[] } {
  const queries: EmbedItem[] = [];
  const passages: EmbedItem[] = [];
  for (const bundle of bundles) {
    queries.push({ text: bundle.item.question, language: bundle.item.language });
    for (const text of bundle.texts) passages.push({ text, language: bundle.item.language });
  }
  return { queries, passages };
}

// ---------------------------------------------------------------- cost and fit summaries

export interface CostReport {
  readonly calls: number;
  readonly firstCallMs: number;
  readonly warmCallMs: { readonly p50: number; readonly p95: number };
  /** Warm full 16-text document calls only. */
  readonly warmFullBatchMs: { readonly p50: number; readonly p95: number };
  readonly cacheHits: number;
  readonly cacheMisses: number;
  /** Cached rows rejected by validation or a dimension mismatch (re-embedded). */
  readonly cacheRejected: number;
  readonly resident: ResidentMemory | null;
}
export interface FitReport {
  readonly overContext: number;
  /** Of `overContext`, the refusals answered from the cache. */
  readonly cachedRefusals: number;
  readonly byLanguage: Readonly<Record<string, { readonly calls: number; readonly tokens: number; readonly hangulSyllables: number; readonly codePoints: number; readonly tokensPerHangulSyllable: number | null; readonly tokensPerCodePoint: number | null }>>;
  readonly note: string;
}

const r3 = (value: number): number => Math.round(value * 1000) / 1000;
const rp = (p: { p50: number; p95: number }): { p50: number; p95: number } => ({ p50: r3(p.p50), p95: r3(p.p95) });

export function costOf(embedder: ArmEmbedder, resident: ResidentMemory | null): CostReport {
  const warm = embedder.calls.slice(1).filter((call) => !call.refused);
  const full = warm.filter((call) => call.role === 'document' && call.texts === BATCH_SIZE);
  return {
    calls: embedder.calls.length,
    firstCallMs: r3(embedder.calls[0]?.ms ?? 0),
    warmCallMs: rp(percentiles(warm.map((call) => call.ms))),
    warmFullBatchMs: rp(percentiles(full.map((call) => call.ms))),
    cacheHits: embedder.cacheHits,
    cacheMisses: embedder.cacheMisses,
    cacheRejected: embedder.cacheRejected,
    resident,
  };
}

export function fitOf(embedder: ArmEmbedder): FitReport {
  const byLanguage: Record<string, { calls: number; tokens: number; hangulSyllables: number; codePoints: number; tokensPerHangulSyllable: number | null; tokensPerCodePoint: number | null }> = {};
  for (const language of LANGUAGES) {
    const calls = embedder.calls.filter((call) => call.language === language && call.promptTokens !== undefined);
    if (calls.length === 0) continue;
    const tokens = calls.reduce((sum, call) => sum + (call.promptTokens as number), 0);
    const syllables = calls.reduce((sum, call) => sum + call.hangulSyllables, 0);
    const codePoints = calls.reduce((sum, call) => sum + call.codePoints, 0);
    byLanguage[language] = {
      calls: calls.length,
      tokens,
      hangulSyllables: syllables,
      codePoints,
      tokensPerHangulSyllable: syllables === 0 ? null : r3(tokens / syllables),
      tokensPerCodePoint: codePoints === 0 ? null : r3(tokens / codePoints),
    };
  }
  return {
    overContext: embedder.overContext,
    cachedRefusals: embedder.cachedRefusals,
    byLanguage,
    note: 'tokens come from prompt_eval_count per call and include the prefix and special tokens, so per-syllable and per-code-point figures are upper bounds; mixed text includes its Latin part',
  };
}

// ---------------------------------------------------------------- latency sample and block

/** The fixed 200-passage sample: v2 passage texts in case order, de-duplicated, picked at a fixed stride. Frozen by the v2 digest. */
export function latencySample(bundles: readonly CaseBundle[], size: number = LATENCY_PASSAGES): EmbedItem[] {
  const all: EmbedItem[] = [];
  const seen = new Set<string>();
  for (const bundle of bundles)
    for (const text of bundle.texts) {
      if (seen.has(text)) continue;
      seen.add(text);
      all.push({ text, language: bundle.item.language });
    }
  if (all.length <= size) return all;
  const stride = Math.floor(all.length / size);
  return Array.from({ length: size }, (_, at) => all[at * stride] as EmbedItem);
}

export interface LatencyBlock {
  readonly passages: number;
  readonly calls: number;
  readonly queryMs: number;
  readonly passagesMs: number;
  readonly time200Ms: number;
  readonly firstCallMs: number;
  readonly meetsBar: boolean;
  /** Why the block cannot qualify for the bar (a refused input, no successful call, over the budget); null when it qualifies. */
  readonly reason: string | null;
  /** Inputs refused as over the model context during the block. */
  readonly overContext: number;
  readonly budgetMs: number;
}

/** Calls a latency block makes: one untimed warm-up (unless `cold`), one query call, and the language-grouped passage batches. */
export const latencyCalls = (sample: readonly EmbedItem[], warmup: boolean): number => (warmup ? 1 : 0) + 1 + batchesOf(sample).length;

/** 1 query + the sample's passages, cache bypassed. `warmup` sends one untimed call first so the measured pass is warm. */
export async function measureLatency(embedder: ArmEmbedder, query: EmbedItem, sample: readonly EmbedItem[], warmup: boolean): Promise<LatencyBlock> {
  if (warmup) await embedder.timed('query', [query]);
  const q = await embedder.timed('query', [query]);
  const p = await embedder.timed('document', sample);
  const total = q.ms + p.ms;
  const refused = q.refused + p.refused;
  const succeeded = q.successfulCalls + p.successfulCalls;
  const reason = sample.length < LATENCY_PASSAGES ? `sample smaller than the bar (${sample.length} of ${LATENCY_PASSAGES} passages)` : refused > 0 ? `${refused} input(s) refused as over the model context` : succeeded === 0 ? 'no successful call' : total > LATENCY_BUDGET_MS ? `over the ${LATENCY_BUDGET_MS} ms budget` : null;
  return {
    passages: sample.length,
    calls: q.calls + p.calls,
    queryMs: r3(q.ms),
    passagesMs: r3(p.ms),
    time200Ms: r3(total),
    firstCallMs: r3(q.firstCallMs),
    meetsBar: reason === null,
    reason,
    overContext: refused,
    budgetMs: LATENCY_BUDGET_MS,
  };
}

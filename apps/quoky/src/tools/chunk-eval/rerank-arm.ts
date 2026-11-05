/**
 * ADR-0124 phase 1 stage D: the listwise LLM rerank stage for the CH7 memory set (owner decision 2026-11-06).
 *
 * A first-stage embedder arm retrieves the top-N memories; a LOCAL model already installed in Ollama reorders them. Everything
 * talks to the LOOPBACK daemon only (`/api/chat`), temperature 0, fixed seed, no thinking, JSON output. The prompt is generic:
 * it names no vocabulary of the memory set (tested). The harness never pulls a model. Results are cached on disk keyed by
 * (model digest, prompt sha, candidate text cap, query id, candidate id list), so a rerun does not call the model again.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_OLLAMA_URL, ModelNotInstalledError, assertLoopback, readPin, type FetchLike } from '../selector-rag/embed';
import { KEEP_ALIVE, parseParameterSize } from './embed-arms';

/** The ratified reranker: already installed locally (owner 2026-11-06); its manifest digest is pinned by its first 12 hex. */
export const RERANK_MODEL = 'qwen3:8b';
export const RERANK_DIGEST12 = '500a1f067a9f';
export const RERANK_TOP_N = 20;
/** Each candidate's text is cut to this many UTF-16 units (a lone high surrogate at the cut is dropped). */
export const CANDIDATE_CAP_UNITS = 600;
export const RERANK_SEED = 7;
export const RERANK_NUM_PREDICT = 160;

/** One generic instruction. No phrase list, no synonym table, no knowledge of any set's vocabulary. */
export const RERANK_SYSTEM_PROMPT =
  'You rank candidate memories for a question. The candidates are numbered. Order them by how closely each one answers the question. ' +
  'The question may describe things in different words than the memory uses, so judge by meaning, not by shared words. ' +
  'Answer only with a JSON array of candidate numbers, best first, each number at most once.';
export const RERANK_QUESTION_HEAD = 'Question: ';
export const RERANK_CANDIDATES_HEAD = 'Candidates:';
export const RERANK_ANSWER_TAIL = 'Answer with the JSON array of candidate numbers, best first.';
export const RERANK_FORMAT = 'json';

/** sha256 over everything that shapes the text the model sees (system prompt and the user message layout). */
export const RERANK_PROMPT_SHA = createHash('sha256')
  .update(JSON.stringify({ system: RERANK_SYSTEM_PROMPT, questionHead: RERANK_QUESTION_HEAD, candidatesHead: RERANK_CANDIDATES_HEAD, answerTail: RERANK_ANSWER_TAIL, numbering: '[n] 1-based', whitespace: 'collapsed to single spaces' }))
  .digest('hex');

export interface RerankerPin {
  readonly model: string;
  readonly digest12: string;
  readonly ollamaVersion: string;
  readonly spaceId: string;
  readonly parameterSize: string | null;
  readonly paramsM: number | null;
  readonly sizeBytes: number | null;
}

/**
 * Reads the pin from the loopback daemon (version, tags, show; no generation). Throws ModelNotInstalledError when the model is
 * absent or its digest is not the ratified one (a different model must not silently take the reranker's place).
 */
export async function pinReranker(baseUrl: string = DEFAULT_OLLAMA_URL, fetchImpl: FetchLike = fetch as unknown as FetchLike, expectedDigest12: string = RERANK_DIGEST12): Promise<RerankerPin> {
  const base = await readPin(RERANK_MODEL, baseUrl, fetchImpl);
  if (base.digest12 !== expectedDigest12) throw new ModelNotInstalledError(`reranker ${RERANK_MODEL} has digest ${base.digest12}, not the ratified ${expectedDigest12}`);
  const root = assertLoopback(baseUrl).origin;
  let sizeBytes: number | null = null;
  let parameterSize: string | null = null;
  try {
    const tags = (await (await fetchImpl(`${root}/api/tags`)).json()) as { models?: Array<{ name: string; size?: number }> };
    const size = tags.models?.find((entry) => entry.name === RERANK_MODEL)?.size;
    sizeBytes = typeof size === 'number' && size > 0 ? size : null;
    const show = await fetchImpl(`${root}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: RERANK_MODEL }) });
    if (show.ok) {
      const text = ((await show.json()) as { details?: { parameter_size?: unknown } }).details?.parameter_size;
      parameterSize = typeof text === 'string' ? text : null;
    }
  } catch {
    // metadata only
  }
  return { model: RERANK_MODEL, digest12: base.digest12, ollamaVersion: base.ollamaVersion, spaceId: base.spaceId, parameterSize, paramsM: parseParameterSize(parameterSize), sizeBytes };
}

// ---------------------------------------------------------------- candidate text and prompt

export function capText(text: string, cap: number = CANDIDATE_CAP_UNITS): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length <= cap) return flat;
  const cut = flat.slice(0, cap);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface Candidate {
  readonly id: string;
  readonly text: string;
}

export function userMessage(question: string, candidates: readonly Candidate[]): string {
  const lines = candidates.map((candidate, at) => `[${at + 1}] ${capText(candidate.text)}`);
  return [`${RERANK_QUESTION_HEAD}${question}`, '', RERANK_CANDIDATES_HEAD, ...lines, '', RERANK_ANSWER_TAIL].join('\n');
}

// ---------------------------------------------------------------- parsing

export interface ParsedRanking {
  /** A permutation of 0..n-1: the valid numbers in the model's order, then every missing candidate in first-stage order. */
  readonly order: number[];
  /** false when nothing usable was parsed (the order is then the first-stage order). */
  readonly parsed: boolean;
}

function numbersIn(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) if (Array.isArray(inner)) return inner;
  }
  return undefined;
}

/** Keeps valid, unique, in-range 1-based numbers in order; appends the missing ones in first-stage order. Unparseable output falls back. */
export function parseRanking(content: string, count: number): ParsedRanking {
  const identity = Array.from({ length: count }, (_, at) => at);
  let list: unknown[] | undefined;
  try {
    list = numbersIn(JSON.parse(content));
  } catch {
    const match = /\[[^\[\]]*\]/u.exec(content);
    if (match !== null) {
      try {
        list = numbersIn(JSON.parse(match[0]));
      } catch {
        list = undefined;
      }
    }
  }
  if (list === undefined) return { order: identity, parsed: false };
  const seen = new Set<number>();
  const order: number[] = [];
  for (const entry of list) {
    const value = typeof entry === 'string' && /^\s*[0-9]+\s*$/u.test(entry) ? Number(entry) : entry;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > count || seen.has(value)) continue;
    seen.add(value);
    order.push(value - 1);
  }
  if (order.length === 0) return { order: identity, parsed: false };
  for (const at of identity) if (!order.includes(at)) order.push(at);
  return { order, parsed: true };
}

// ---------------------------------------------------------------- cache

export interface RerankRecord {
  readonly order: readonly number[];
  readonly fallback: boolean;
  readonly ms: number;
  readonly promptTokens: number | null;
  readonly evalTokens: number | null;
}

const rowSum = (key: string, record: RerankRecord): string =>
  createHash('sha256').update(`${key}|${record.order.join(',')}|${record.fallback ? 1 : 0}|${record.ms}|${record.promptTokens}|${record.evalTokens}`).digest('hex').slice(0, 16);

/** jsonl rows {k, o, f, ms, pt, et, h}; a row that does not verify is dropped at load and counted. */
export class RerankCache {
  private readonly entries = new Map<string, RerankRecord>();
  rejectedAtLoad = 0;
  constructor(private readonly file?: string) {
    if (file === undefined || !existsSync(file)) return;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line === '') continue;
      try {
        const row = JSON.parse(line) as { k?: unknown; o?: unknown; f?: unknown; ms?: unknown; pt?: unknown; et?: unknown; h?: unknown };
        if (typeof row.k !== 'string' || !/^[0-9a-f]{64}$/u.test(row.k) || !Array.isArray(row.o) || !row.o.every((n) => Number.isInteger(n) && (n as number) >= 0)) throw new Error('shape');
        if ((row.f !== 0 && row.f !== 1) || typeof row.ms !== 'number' || !Number.isFinite(row.ms)) throw new Error('shape');
        const record: RerankRecord = { order: row.o as number[], fallback: row.f === 1, ms: row.ms, promptTokens: typeof row.pt === 'number' ? row.pt : null, evalTokens: typeof row.et === 'number' ? row.et : null };
        if (row.h !== rowSum(row.k, record)) throw new Error('checksum');
        this.entries.set(row.k, record);
      } catch {
        this.rejectedAtLoad += 1;
      }
    }
  }
  /** `message` is the rendered user message, so the same ids with a different question or candidate text never hit. */
  static key(pin: Pick<RerankerPin, 'digest12'>, queryId: string, candidateIds: readonly string[], message: string): string {
    const messageSha = createHash('sha256').update(message).digest('hex');
    return createHash('sha256').update(JSON.stringify({ digest12: pin.digest12, prompt: RERANK_PROMPT_SHA, cap: CANDIDATE_CAP_UNITS, seed: RERANK_SEED, queryId, candidateIds, messageSha })).digest('hex');
  }
  get(key: string): RerankRecord | undefined {
    return this.entries.get(key);
  }
  set(key: string, record: RerankRecord): void {
    this.entries.set(key, record);
    if (this.file === undefined) return;
    mkdirSync(resolve(this.file, '..'), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ k: key, o: record.order, f: record.fallback ? 1 : 0, ms: record.ms, pt: record.promptTokens, et: record.evalTokens, h: rowSum(key, record) })}\n`);
  }
  get size(): number {
    return this.entries.size;
  }
}

export const rerankCachePath = (dir: string, pin: Pick<RerankerPin, 'digest12'>): string => resolve(dir, `rerank-${pin.digest12}.jsonl`);

// ---------------------------------------------------------------- the reranker

export interface RerankResult extends RerankRecord {
  readonly cached: boolean;
}
export interface RerankerOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly cache?: RerankCache;
  readonly clock?: () => number;
}

export class LlmReranker {
  calls = 0;
  cacheHits = 0;
  fallbacks = 0;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly cache: RerankCache;
  private readonly clock: () => number;

  constructor(readonly pin: RerankerPin, options: RerankerOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_URL;
    assertLoopback(this.baseUrl);
    if (/cloud/i.test(pin.model)) throw new Error('cloud-served models are refused (ADR-0098 D8)');
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.cache = options.cache ?? new RerankCache();
    this.clock = options.clock ?? (() => performance.now());
  }

  private async post(path: string, body: object): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
    return this.fetchImpl(`${assertLoopback(this.baseUrl).origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  /** Reorders `candidates` for `question`. `useCache: false` (the probe) neither reads nor writes the cache. */
  async rerank(queryId: string, question: string, candidates: readonly Candidate[], useCache = true): Promise<RerankResult> {
    const key = RerankCache.key(this.pin, queryId, candidates.map((candidate) => candidate.id), userMessage(question, candidates));
    if (useCache) {
      const hit = this.cache.get(key);
      if (hit !== undefined && hit.order.length === candidates.length) {
        this.cacheHits += 1;
        if (hit.fallback) this.fallbacks += 1;
        return { ...hit, cached: true };
      }
    }
    const started = this.clock();
    const response = await this.post('/api/chat', {
      model: this.pin.model,
      stream: false,
      think: false,
      format: RERANK_FORMAT,
      keep_alive: KEEP_ALIVE,
      options: { temperature: 0, seed: RERANK_SEED, num_predict: RERANK_NUM_PREDICT },
      messages: [
        { role: 'system', content: RERANK_SYSTEM_PROMPT },
        { role: 'user', content: userMessage(question, candidates) },
      ],
    });
    if (!response.ok) throw new Error(`rerank call failed with status ${response.status}`);
    const body = (await response.json()) as { message?: { content?: unknown }; prompt_eval_count?: unknown; eval_count?: unknown };
    const ms = Math.round((this.clock() - started) * 1000) / 1000;
    this.calls += 1;
    const parsed = parseRanking(typeof body.message?.content === 'string' ? body.message.content : '', candidates.length);
    if (!parsed.parsed) this.fallbacks += 1;
    const record: RerankRecord = {
      order: parsed.order,
      fallback: !parsed.parsed,
      ms,
      promptTokens: typeof body.prompt_eval_count === 'number' ? body.prompt_eval_count : null,
      evalTokens: typeof body.eval_count === 'number' ? body.eval_count : null,
    };
    if (useCache) this.cache.set(key, record);
    return { ...record, cached: false };
  }

  /** Best effort: ask the daemon to unload the reranker so only one local model is resident at a time. */
  async unload(): Promise<void> {
    try {
      await this.post('/api/chat', { model: this.pin.model, messages: [], keep_alive: 0 });
    } catch {
      // ignored
    }
  }
}

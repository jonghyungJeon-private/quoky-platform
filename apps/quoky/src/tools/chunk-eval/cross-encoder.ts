/**
 * ADR-0124 phase 1 stage E (owner decision 2026-11-06): a LOCAL multilingual cross-encoder reranker, offline eval tool only.
 *
 * The model is a pinned ONNX export of a multilingual XLM-R cross-encoder reranker (int8). It is loaded from a local directory only:
 * every file listed in `SHA256SUMS` is verified against both the list and the pins below before anything is read (fail closed),
 * the session is an onnxruntime CPU session, and the tokenizer is the pure-JS one built from the directory's `tokenizer.json`.
 * There is no remote model loading API in this file and nothing here opens a network connection.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** What every X arm scores with. `score` returns one relevance score per passage (higher is better), in passage order. */
export interface PairScorer {
  score(query: string, passages: readonly string[]): Promise<number[]>;
}

// ---------------------------------------------------------------- pins

export const CROSS_ENCODER_REPO = 'onnx-community/bge-reranker-v2-m3-ONNX';
export const CROSS_ENCODER_REVISION = '6f5ff65298512715a1e669753bc754d2bc8f367b';
export const CROSS_ENCODER_MODEL_FILE = 'onnx/model_int8.onnx';
/** Reranker parameters in millions (the XLM-R large body); used for the tie-break size of an X arm (embedder plus reranker). */
export const CROSS_ENCODER_PARAMS_M = 568;
/** Every file of the pinned download, by path relative to the model directory. */
export const CROSS_ENCODER_FILES: Readonly<Record<string, string>> = {
  'config.json': '122e922dcfed6503c8721e6fe1daf090340c3d95ca7f3aa3a72730b321a51cfd',
  'tokenizer.json': '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3',
  'tokenizer_config.json': 'b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80',
  'special_tokens_map.json': '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835',
  [CROSS_ENCODER_MODEL_FILE]: '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d',
};
/** Exact versions of the two devDependencies (a test pins these to `apps/quoky/package.json`). */
export const CROSS_ENCODER_RUNTIME = { onnxruntimeNode: '1.30.0', huggingfaceTokenizers: '0.2.0' } as const;
/** Plan parameters of the scoring itself. */
export const CROSS_ENCODER_MAX_LENGTH = 512;
export const CROSS_ENCODER_BATCH = 8;
export const CROSS_ENCODER_THREADS = 4;

export const defaultCrossEncoderDir = (): string => join(homedir(), 'Library', 'Application Support', 'Quoky', 'models', 'bge-reranker-v2-m3-onnx', CROSS_ENCODER_REVISION.slice(0, 12));

export interface CrossEncoderPin {
  readonly repo: string;
  readonly revision: string;
  readonly modelFile: string;
  readonly paramsM: number;
  readonly files: Readonly<Record<string, string>>;
  readonly runtime: typeof CROSS_ENCODER_RUNTIME;
}

export const crossEncoderPin = (files: Readonly<Record<string, string>> = CROSS_ENCODER_FILES): CrossEncoderPin => ({
  repo: CROSS_ENCODER_REPO,
  revision: CROSS_ENCODER_REVISION,
  modelFile: CROSS_ENCODER_MODEL_FILE,
  paramsM: CROSS_ENCODER_PARAMS_M,
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  runtime: CROSS_ENCODER_RUNTIME,
});

// ---------------------------------------------------------------- integrity (fail closed)

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(hash.digest('hex')));
  });
}

/**
 * Verifies the model directory: `SHA256SUMS` (shasum -a 256 format, relative paths) must list exactly the pinned files, every
 * listed hash must equal the pin, and every file must hash to it. Any missing file, extra or unlisted entry, or mismatch throws.
 * Returns the verified path to sha256 map. `expected` exists for tests that use a temporary directory.
 */
export async function verifyModelDir(dir: string, expected: Readonly<Record<string, string>> = CROSS_ENCODER_FILES): Promise<Record<string, string>> {
  const root = resolve(dir);
  const sums = join(root, 'SHA256SUMS');
  if (!existsSync(sums)) throw new Error(`cross-encoder model directory is not verifiable: ${sums} is missing`);
  const listed = new Map<string, string>();
  for (const line of readFileSync(sums, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (match === null) throw new Error(`cross-encoder SHA256SUMS has a malformed line: ${line.slice(0, 80)}`);
    const path = match[2] as string;
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`cross-encoder SHA256SUMS lists an unsafe path: ${path}`);
    if (listed.has(path)) throw new Error(`cross-encoder SHA256SUMS lists ${path} twice`);
    listed.set(path, match[1] as string);
  }
  for (const path of Object.keys(expected)) if (!listed.has(path)) throw new Error(`cross-encoder SHA256SUMS does not list ${path}`);
  for (const path of listed.keys()) if (!(path in expected)) throw new Error(`cross-encoder SHA256SUMS lists an unexpected file ${path}`);
  const verified: Record<string, string> = {};
  for (const [path, pinned] of Object.entries(expected)) {
    if (listed.get(path) !== pinned) throw new Error(`cross-encoder SHA256SUMS hash for ${path} differs from the pin`);
    const file = join(root, path);
    if (!existsSync(file)) throw new Error(`cross-encoder file is missing: ${path}`);
    const actual = await sha256File(file);
    if (actual !== pinned) throw new Error(`cross-encoder file ${path} does not match its sha256 (expected ${pinned.slice(0, 12)}, got ${actual.slice(0, 12)})`);
    verified[path] = actual;
  }
  return verified;
}

// ---------------------------------------------------------------- tokenization (pure)

/** What the scorer needs from a tokenizer: a pair encoding made by the model's own post-processor, and the pad id. */
export interface PairTokenizer {
  encodePair(query: string, passage: string): { ids: number[] };
  readonly padId: number;
  readonly eosId: number;
}

/**
 * Truncates an encoded pair to `maxLength` from the END, i.e. the passage side (the pair template is
 * `<s> query </s></s> passage </s>`), and keeps the closing special token. A sequence that already fits is returned as is.
 */
export function truncatePairIds(ids: readonly number[], maxLength: number, eosId: number): number[] {
  if (maxLength < 2) throw new Error('maxLength must be at least 2');
  if (ids.length <= maxLength) return [...ids];
  return [...ids.slice(0, maxLength - 1), eosId];
}

export interface PaddedBatch {
  readonly length: number;
  readonly rows: number;
  readonly inputIds: BigInt64Array;
  readonly attentionMask: BigInt64Array;
}

/** Dynamic padding: the batch is padded to its own longest row (never to maxLength). */
export function padBatch(sequences: readonly (readonly number[])[], padId: number): PaddedBatch {
  const length = Math.max(1, ...sequences.map((ids) => ids.length));
  const inputIds = new BigInt64Array(sequences.length * length).fill(BigInt(padId));
  const attentionMask = new BigInt64Array(sequences.length * length);
  sequences.forEach((ids, row) => {
    ids.forEach((id, at) => {
      inputIds[row * length + at] = BigInt(id);
      attentionMask[row * length + at] = 1n;
    });
  });
  return { length, rows: sequences.length, inputIds, attentionMask };
}

// ---------------------------------------------------------------- the ONNX cross-encoder

export interface CrossEncoderOptions {
  readonly maxLength?: number;
  readonly batchSize?: number;
  readonly threads?: number;
}

interface OrtTensorLike {
  readonly data: ArrayLike<number | bigint>;
}
interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release?(): Promise<void>;
}
interface OrtLike {
  readonly Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => unknown;
}

export class OnnxCrossEncoder implements PairScorer {
  readonly maxLength: number;
  readonly batchSize: number;
  readonly threads: number;
  pairsScored = 0;

  private constructor(
    private readonly session: OrtSessionLike,
    private readonly ort: OrtLike,
    private readonly tokenizer: PairTokenizer,
    private readonly inputNames: readonly string[],
    options: Required<CrossEncoderOptions>,
  ) {
    this.maxLength = options.maxLength;
    this.batchSize = options.batchSize;
    this.threads = options.threads;
  }

  /** Verifies the directory first (throws on any mismatch), then loads the local files only. */
  static async load(dir: string, options: CrossEncoderOptions = {}): Promise<OnnxCrossEncoder> {
    const resolved: Required<CrossEncoderOptions> = { maxLength: options.maxLength ?? CROSS_ENCODER_MAX_LENGTH, batchSize: options.batchSize ?? CROSS_ENCODER_BATCH, threads: options.threads ?? CROSS_ENCODER_THREADS };
    if (!Number.isInteger(resolved.maxLength) || resolved.maxLength < 8 || resolved.maxLength > 8192) throw new Error('maxLength must be an integer from 8 to 8192');
    if (!Number.isInteger(resolved.batchSize) || resolved.batchSize < 1) throw new Error('batchSize must be a positive integer');
    if (!Number.isInteger(resolved.threads) || resolved.threads < 1) throw new Error('threads must be a positive integer');
    await verifyModelDir(dir);
    const root = resolve(dir);
    const { Tokenizer } = await import('@huggingface/tokenizers');
    const tokenizerJson = JSON.parse(readFileSync(join(root, 'tokenizer.json'), 'utf8')) as object;
    const tokenizerConfig = JSON.parse(readFileSync(join(root, 'tokenizer_config.json'), 'utf8')) as object;
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const padId = tokenizer.token_to_id('<pad>');
    const eosId = tokenizer.token_to_id('</s>');
    if (padId === undefined || eosId === undefined) throw new Error('the tokenizer has no <pad> or </s> token');
    const ort = (await import('onnxruntime-node')) as unknown as OrtLike & { InferenceSession: { create(path: string, options: object): Promise<OrtSessionLike> } };
    const session = await ort.InferenceSession.create(join(root, CROSS_ENCODER_MODEL_FILE), { executionProviders: ['cpu'], intraOpNumThreads: resolved.threads, graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    const known = new Set(['input_ids', 'attention_mask', 'token_type_ids']);
    const unknown = session.inputNames.filter((name) => !known.has(name));
    if (unknown.length > 0 || !session.inputNames.includes('input_ids')) throw new Error(`the model declares inputs this scorer cannot feed: ${session.inputNames.join(', ')}`);
    const pairTokenizer: PairTokenizer = { padId, eosId, encodePair: (query, passage) => ({ ids: tokenizer.encode(query, { text_pair: passage }).ids }) };
    return new OnnxCrossEncoder(session, ort, pairTokenizer, session.inputNames, resolved);
  }

  async score(query: string, passages: readonly string[]): Promise<number[]> {
    const sequences = passages.map((passage) => truncatePairIds(this.tokenizer.encodePair(query, passage).ids, this.maxLength, this.tokenizer.eosId));
    const scores: number[] = [];
    for (let at = 0; at < sequences.length; at += this.batchSize) {
      const batch = padBatch(sequences.slice(at, at + this.batchSize), this.tokenizer.padId);
      const dims = [batch.rows, batch.length] as const;
      const feeds: Record<string, unknown> = {
        input_ids: new this.ort.Tensor('int64', batch.inputIds, dims),
        attention_mask: new this.ort.Tensor('int64', batch.attentionMask, dims),
      };
      if (this.inputNames.includes('token_type_ids')) feeds.token_type_ids = new this.ort.Tensor('int64', new BigInt64Array(batch.rows * batch.length), dims);
      const output = await this.session.run(feeds);
      const logits = output[this.session.outputNames[0] as string]?.data;
      if (logits === undefined || logits.length !== batch.rows) throw new Error(`the model returned ${logits?.length ?? 0} logits for ${batch.rows} pairs`);
      for (let row = 0; row < batch.rows; row += 1) {
        const value = Number(logits[row]);
        if (!Number.isFinite(value)) throw new Error('the model returned a non-finite logit');
        scores.push(value);
      }
    }
    this.pairsScored += passages.length;
    return scores;
  }

  async dispose(): Promise<void> {
    await this.session.release?.();
  }
}

// ---------------------------------------------------------------- sanity check (probe)

/** Neutral sentences written for this check; none comes from any eval set. */
export const SANITY_QUERY = 'How long should an egg be boiled to make it hard?';
export const SANITY_RELEVANT = 'A hard-boiled egg needs about ten minutes in gently boiling water, then a rinse in cold water.';
export const SANITY_UNRELATED = 'The evening train to the coast leaves from the fourth platform at a quarter past six.';

export interface SanityResult {
  readonly relevant: number;
  readonly unrelated: number;
  readonly ok: boolean;
}

/** An obviously relevant pair must outscore an unrelated one; the probe fails otherwise. */
export async function sanityCheck(scorer: PairScorer): Promise<SanityResult> {
  const [relevant, unrelated] = await scorer.score(SANITY_QUERY, [SANITY_RELEVANT, SANITY_UNRELATED]);
  if (relevant === undefined || unrelated === undefined) throw new Error('the scorer returned fewer scores than passages');
  return { relevant, unrelated, ok: relevant > unrelated };
}

/**
 * Orders candidate indexes by descending score; ties keep first-stage order (a stable sort). Used by every X arm.
 */
export function orderByScore(scores: readonly number[]): number[] {
  return scores.map((score, at) => ({ score, at })).sort((a, b) => b.score - a.score || a.at - b.at).map((entry) => entry.at);
}

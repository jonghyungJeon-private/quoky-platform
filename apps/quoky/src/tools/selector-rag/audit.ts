// ADR-0123 D5 (embedding half) and D6 (leakage control): embed the pool and the gold in one pinned space, calibrate tau,
// flag pool entries at or above tau, bucket the held-out cases by their maximum cosine to the pool, check the validity of
// the low-similarity stratum, and simulate the retrieval arms offline. No selector call, no egress (loopback embeddings).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  NL_ACTION_ENTRIES,
  NL_CATALOG_ENTRY_IDS,
  NL_WAVE1_ENTRIES,
  buildSelectionPrompt,
  closeness,
  extractPromptExamples,
  normalize,
  type NlCatalogEntry,
} from '@quoky/core';
import { collectionName, cosine, calibrateTau, openStore, percentiles, recordId, type Calibration, type Embedder, type EmbeddingPin } from './embed';
import type { CalibrationPositive, GoldCase, KnownFinding } from './gold';
import { poolDigest, type PoolEntry } from './pool';
import { DEFAULT_K, eligible, outputEntryId, retrieveRandomK, retrieveTopK, subsample, drawSwap, type PoolVector } from './retrieve';
import { seedFromString, seededRandom } from './stats';
import { tauLowFor, validity, type SplitResult, type ValidityReport } from './split';

/** A calibration positive must be at least this close by character-3-gram Jaccard (the NEAR_COPY char threshold). */
export const POSITIVE_MIN_CHAR_JACCARD = 0.6;

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
export const READ_ENTRY_IDS: ReadonlySet<string> = new Set(READS.map((entry) => entry.id));
export const A6_ENTRY_IDS: ReadonlySet<string> = new Set([...READS, ...ACTIONS].map((entry) => entry.id));

export interface StaticExamples {
  readonly texts: ReadonlySet<string>;
  /** Per-entry example counts of the A6 prompt (reads and actions), the A0-swap draw's target. */
  readonly counts: Readonly<Record<string, number>>;
}

/** The static examples the selector prompts show, as the model sees them (rendered, never copied). */
export function staticExamples(): StaticExamples {
  const read = extractPromptExamples(buildSelectionPrompt({ entries: READS, text: 'x' }));
  const action = extractPromptExamples(buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text: 'x', actions: { referenceContext: 'none' } }));
  const texts = new Set<string>();
  for (const example of [...read, ...action]) texts.add(normalize(example.text));
  const counts: Record<string, number> = {};
  for (const example of action) {
    let id = 'none';
    try {
      id = String((JSON.parse(example.output) as { entryId?: unknown }).entryId);
    } catch {
      // keep none
    }
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return { texts, counts };
}

export interface CalibrationPair {
  readonly example: string;
  readonly goldId: string;
  readonly kind: string;
  readonly cosine: number;
}

export interface FlaggedPair {
  readonly poolId: string;
  readonly goldId: string;
  readonly cosine: number;
}

export interface ModelAudit {
  readonly model: string;
  readonly spaceId: string;
  readonly digest12: string;
  readonly ollamaVersion: string;
  readonly prefix: string;
  readonly poolDigest: string;
  readonly goldDigest: string;
  readonly poolSize: number;
  readonly goldSize: number;
  readonly embedMs: { readonly pool: number; readonly gold: number; readonly calibration: number; readonly total: number };
  readonly calibration: Calibration;
  readonly calibrationPairs: readonly CalibrationPair[];
  readonly tauLow: number | null;
  readonly abort: string | null;
  readonly flaggedPairs: readonly FlaggedPair[];
  readonly buckets: { readonly heldOut: ValidityReport | null; readonly dev: ValidityReport | null; readonly excludedContaminated: number };
  readonly retrieval: {
    readonly casesChecked: number;
    readonly fullK: number;
    readonly meanRetrieved: number;
    readonly queryEmbedMs: { readonly p50: number; readonly p95: number; readonly sample: number };
    readonly storeQueryMs: { readonly p50: number; readonly p95: number };
    readonly swapShortfall: Readonly<Record<string, number>>;
  };
  readonly store: { readonly directory: string; readonly poolCollection: string; readonly goldCollection: string; readonly overflow: 'reject'; readonly corruptRebuilds: number };
}

export interface AuditInput {
  readonly embedder: Embedder;
  readonly pool: readonly PoolEntry[];
  readonly gold: readonly GoldCase[];
  readonly goldDigest: string;
  readonly split: SplitResult;
  readonly known: readonly KnownFinding[];
  /** The frozen calibration positives (ADR-0123 D5), not derived from the live prompt. */
  readonly positives: readonly CalibrationPositive[];
  readonly storeDirectory: string;
  readonly negativePairs?: number;
  readonly latencySample?: number;
  readonly log?: (line: string) => void;
}

/** The space manifest of a store directory: a collection built in another space is refused, never silently mixed. */
export class SpaceMismatchError extends Error {}
function manifestPath(directory: string): string {
  return resolve(directory, 'spaces.json');
}
export function readSpaces(directory: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(manifestPath(directory), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}
export function assertSpace(directory: string, collection: string, spaceId: string): void {
  const recorded = readSpaces(directory)[collection];
  if (recorded !== undefined && recorded !== spaceId) throw new SpaceMismatchError(`collection ${collection} was built in space ${recorded}, not ${spaceId}: rebuild it and re-run the audit`);
}
function recordSpace(directory: string, collection: string, spaceId: string): void {
  const spaces = readSpaces(directory);
  spaces[collection] = spaceId;
  writeFileSync(manifestPath(directory), `${JSON.stringify(spaces, null, 2)}\n`);
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}

export async function runEmbedAudit(input: AuditInput): Promise<ModelAudit> {
  const { embedder, pool, gold, split, known } = input;
  if (input.positives.length === 0) throw new Error('no positive calibration pairs: the frozen calibration fixture is empty');
  const pin: EmbeddingPin = embedder.pin;
  const log = input.log ?? (() => undefined);
  const wholeStarted = performance.now();
  mkdirSync(input.storeDirectory, { recursive: true });
  const poolCollection = collectionName('pool', pin.digest12);
  const goldCollection = collectionName('gold-audit', pin.digest12);

  // 1. embed the pool and the gold (the pool is a rebuildable cache: always rebuilt from the checked-in file)
  const poolEmbed = await timed(() => embedder.embed(pool.map((entry) => entry.text)));
  log(`  [${pin.model}] pool: ${pool.length} embedded in ${(poolEmbed.ms / 1000).toFixed(1)} s`);
  const goldEmbed = await timed(() => embedder.embed(gold.map((golden) => golden.queryText)));
  log(`  [${pin.model}] gold: ${gold.length} embedded in ${(goldEmbed.ms / 1000).toFixed(1)} s`);
  const poolVectors: PoolVector[] = pool.map((entry, index) => ({ entry, entryId: outputEntryId(entry), vector: poolEmbed.value[index] as number[] }));
  const goldVectors = new Map(gold.map((golden, index) => [golden.id, goldEmbed.value[index] as number[]] as const));

  // 2. the vector store: pool collection with overflow 'reject', its own directory
  for (const collection of [poolCollection, goldCollection]) rmSync(resolve(input.storeDirectory, `${collection}.json`), { force: true });
  const handle = openStore(input.storeDirectory, () => undefined, log);
  await handle.provider.init();
  await handle.provider.upsert(
    poolCollection,
    poolVectors.map((candidate) => ({ id: recordId(candidate.entry.text, candidate.entry.previous, candidate.entry.context), vector: [...candidate.vector], metadata: { poolId: candidate.entry.id, entryId: candidate.entryId, poolVersion: 1 } })),
  );
  await handle.provider.upsert(
    goldCollection,
    gold.map((golden, index) => ({ id: recordId(golden.queryText, golden.previous), vector: goldEmbed.value[index] as number[], metadata: { goldId: golden.id, entryId: golden.entry } })),
  );
  recordSpace(input.storeDirectory, poolCollection, pin.spaceId);
  recordSpace(input.storeDirectory, goldCollection, pin.spaceId);
  assertSpace(input.storeDirectory, poolCollection, pin.spaceId);

  // 3. calibration: known near-copy positives (RAG-0 ratchet: exact and near) and unrelated same-feature negatives
  const goldById = new Map(gold.map((golden) => [golden.id, golden] as const));
  // Positives come from the frozen fixture (calibration-positives.v1.json): exact copies and near copies with character-3-gram
  // Jaccard >= 0.6 that the prompt once held. They do not depend on contamination still existing in the live prompt.
  const positiveSources = input.positives.map((finding) => {
    if (!goldById.has(finding.goldId)) throw new Error(`calibration positive refers to gold case ${finding.goldId}, which is not in the gold corpora`);
    return finding;
  });
  const calibrationEmbed = await timed(() => embedder.embed(positiveSources.map((finding) => finding.example)));
  const calibrationPairs: CalibrationPair[] = positiveSources.map((finding, index) => ({
    example: finding.example,
    goldId: finding.goldId,
    kind: finding.kind,
    cosine: cosine(calibrationEmbed.value[index] as number[], goldVectors.get(finding.goldId) as number[]),
  }));
  const random = seededRandom(seedFromString('adr-0123-negatives'));
  const featureCases = gold.filter((golden) => golden.entry !== 'none');
  const negatives: number[] = [];
  const wanted = input.negativePairs ?? 400;
  for (let attempt = 0; attempt < wanted * 20 && negatives.length < wanted; attempt += 1) {
    const a = featureCases[Math.floor(random() * featureCases.length)] as GoldCase;
    const b = featureCases[Math.floor(random() * featureCases.length)] as GoldCase;
    if (a.id === b.id || a.entry !== b.entry) continue;
    const c = closeness(a.text, b.text);
    if (c.tokenJ >= 0.2 || c.charJ >= 0.2) continue;
    negatives.push(cosine(goldVectors.get(a.id) as number[], goldVectors.get(b.id) as number[]));
  }
  const calibration = calibrateTau({ positives: calibrationPairs.map((pair) => pair.cosine), negatives });
  const tau = calibration.tau;
  const low = tauLowFor(tau);

  // 4. the embedding lint: every pool entry against every gold case
  const flaggedPairs: FlaggedPair[] = [];
  for (const candidate of poolVectors) {
    for (const golden of gold) {
      const score = cosine(candidate.vector, goldVectors.get(golden.id) as number[]);
      if (score >= tau) flaggedPairs.push({ poolId: candidate.entry.id, goldId: golden.id, cosine: score });
    }
  }

  // 5. leakage buckets over the held-out set (known contaminated cases excluded) through the store
  const contaminated = new Set(known.map((finding) => finding.goldId));
  const heldOutIds = new Set(split.heldOut);
  const devIds = new Set(split.dev);
  const storeMs: number[] = [];
  const maxCosine = new Map<string, number>();
  for (const golden of gold) {
    const started = performance.now();
    const top = await handle.provider.query(poolCollection, goldVectors.get(golden.id) as number[], 1);
    storeMs.push(performance.now() - started);
    maxCosine.set(golden.id, top[0]?.score ?? 0);
  }
  const bucketCases = (ids: ReadonlySet<string>, skip: ReadonlySet<string>) =>
    gold.filter((golden) => ids.has(golden.id) && !skip.has(golden.id)).map((golden) => ({ id: golden.id, entry: golden.entry, maxCosine: maxCosine.get(golden.id) as number }));
  const heldOutCases = bucketCases(heldOutIds, contaminated);
  const buckets = low.abort
    ? { heldOut: null, dev: null, excludedContaminated: [...contaminated].filter((id) => heldOutIds.has(id)).length }
    : { heldOut: validity(heldOutCases, tau, low.tauLow), dev: validity(bucketCases(devIds, new Set()), tau, low.tauLow), excludedContaminated: [...contaminated].filter((id) => heldOutIds.has(id)).length };

  // 6. offline retrieval simulation on the held-out cases (run 1, A1 top-k, A2 random-k) and the A0-swap draw
  const statics = staticExamples();
  const subsampled = subsample(poolVectors, 'run-1');
  let fullK = 0;
  let retrievedTotal = 0;
  for (const golden of heldOutCases.map((item) => goldById.get(item.id) as GoldCase)) {
    const offered = golden.corpus === 'read' ? READ_ENTRY_IDS : A6_ENTRY_IDS;
    const candidates = eligible(subsampled, { offered, staticTexts: statics.texts }, normalize);
    const picked = retrieveTopK(goldVectors.get(golden.id) as number[], candidates, DEFAULT_K);
    retrievedTotal += picked.length;
    if (picked.length === DEFAULT_K) fullK += 1;
    retrieveRandomK(candidates, `A2:run-1:${golden.id}`, DEFAULT_K);
  }
  const sampleIds = heldOutCases.slice(0, input.latencySample ?? 50).map((item) => goldById.get(item.id) as GoldCase);
  const queryMs: number[] = [];
  for (const golden of sampleIds) {
    const started = performance.now();
    const [vector] = await embedder.embed([golden.queryText]);
    await handle.provider.query(poolCollection, vector as number[], DEFAULT_K);
    queryMs.push(performance.now() - started);
  }
  const swap = drawSwap(pool, statics.counts, 'A0-swap:run-1');
  const queryP = percentiles(queryMs);
  const storeP = percentiles(storeMs);

  return {
    model: pin.model,
    spaceId: pin.spaceId,
    digest12: pin.digest12,
    ollamaVersion: pin.ollamaVersion,
    prefix: pin.prefix,
    poolDigest: poolDigest(pool),
    goldDigest: input.goldDigest,
    poolSize: pool.length,
    goldSize: gold.length,
    embedMs: { pool: poolEmbed.ms, gold: goldEmbed.ms, calibration: calibrationEmbed.ms, total: performance.now() - wholeStarted },
    calibration,
    calibrationPairs,
    tauLow: low.abort ? null : low.tauLow,
    abort: low.abort ? low.reason : null,
    flaggedPairs,
    buckets,
    retrieval: {
      casesChecked: heldOutCases.length,
      fullK,
      meanRetrieved: heldOutCases.length === 0 ? 0 : retrievedTotal / heldOutCases.length,
      queryEmbedMs: { ...queryP, sample: queryMs.length },
      storeQueryMs: storeP,
      swapShortfall: swap.shortfall,
    },
    store: { directory: input.storeDirectory, poolCollection, goldCollection, overflow: 'reject', corruptRebuilds: handle.rebuilds.length },
  };
}

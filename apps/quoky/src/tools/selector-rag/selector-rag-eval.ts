// ADR-0123 D6 / D8 (RAG-2): renders the prompt of one experiment arm through Core's own builder and walks the schedule.
// Experiment-only: nothing here is read by the running service, and the selector transport is injected (this module never
// constructs a provider and never makes a call). Records are content-free: ids, rounded scores and hashes, never texts.
import { createHash } from 'node:crypto';
import { buildSelectionPrompt, extractPromptExamples, normalize, renderRetrievedBlock, renderSwappedExamplesBlock, retrievalPromptVersion, type NlCatalogEntry, type NlRetrievedExample, type NlSelectionPromptInput } from '@quoky/core';
import type { Arm, ScheduleUnit } from './arms';
import { drawSwap, eligible, outputEntryId, retrieveRandomK, retrieveTopK, subsample, DEFAULT_K, type PoolVector } from './retrieve';
import type { PoolEntry } from './pool';

/** What the case contributes to the prompt: the same inputs the runtime / eval would pass to `buildSelectionPrompt`. */
export interface PromptContext {
  readonly entries: readonly NlCatalogEntry[];
  readonly text: string;
  readonly previous?: NlSelectionPromptInput['previous'];
  readonly actions?: NlSelectionPromptInput['actions'];
}

export interface RetrievalRecord {
  readonly arm: string;
  readonly run: number;
  readonly caseId: string;
  readonly promptVersion: string;
  readonly poolDigest: string;
  readonly spaceId: string;
  readonly retrievedIds: readonly string[];
  /** Cosine scores rounded to 2 decimals (A1 only). */
  readonly scores: readonly number[];
  /** SHA-256 of the rendered retrieved block; null for A0 (no slot). */
  readonly blockSha256: string | null;
  /** SHA-256 of the whole rendered prompt (so a record can be replayed and checked). */
  readonly promptSha256: string;
}

export interface ArmRenderInput {
  readonly arm: Arm;
  readonly run: number;
  readonly caseId: string;
  readonly context: PromptContext;
  /** The prompt mode's offered entry ids (read mode: the reads; A6 mode: reads and actions). */
  readonly offered: ReadonlySet<string>;
  readonly staticTexts: ReadonlySet<string>;
  readonly pool: readonly PoolVector[];
  readonly poolDigest: string;
  readonly spaceId: string;
  /** The embedded query (A1 only). */
  readonly queryVector?: readonly number[];
  readonly baseVersion: string;
  readonly k?: number;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function toRetrievedExample(entry: PoolEntry): NlRetrievedExample {
  return { text: entry.text, output: entry.output, ...(entry.previous !== undefined ? { previous: entry.previous } : {}), ...(entry.context !== undefined ? { context: entry.context } : {}) };
}

/** Per-entry example counts of a rendered static prompt (the A0-swap draw target for that prompt mode). */
export function staticCountsOf(prompt: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const example of extractPromptExamples(prompt)) {
    let id = 'none';
    try {
      id = String((JSON.parse(example.output) as { entryId?: unknown }).entryId);
    } catch {
      // keep none
    }
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export function renderArmPrompt(input: ArmRenderInput): { readonly prompt: string; readonly record: RetrievalRecord } {
  const k = input.k ?? DEFAULT_K;
  const seed = `run-${input.run}`;
  const base = { arm: input.arm.id, run: input.run, caseId: input.caseId, poolDigest: input.poolDigest, spaceId: input.spaceId };
  const promptOf = (extra: Partial<NlSelectionPromptInput>): string =>
    buildSelectionPrompt({
      entries: input.context.entries,
      text: input.context.text,
      ...(input.context.previous !== undefined ? { previous: input.context.previous } : {}),
      ...(input.context.actions !== undefined ? { actions: input.context.actions } : {}),
      ...extra,
    });
  if (input.arm.kind === 'A0') {
    const prompt = promptOf({});
    return { prompt, record: { ...base, promptVersion: input.baseVersion, retrievedIds: [], scores: [], blockSha256: null, promptSha256: sha256(prompt) } };
  }
  if (input.arm.kind === 'A0-swap') {
    // the target counts come from THIS mode's static prompt, and only entries the mode offers can be drawn
    const counts = staticCountsOf(promptOf({}));
    const offeredPool = input.pool.filter((candidate) => (candidate.entryId === 'none' || input.offered.has(candidate.entryId)) && candidate.entry.needs.every((id) => input.offered.has(id)));
    const draw = drawSwap(offeredPool.map((candidate) => candidate.entry), counts, `A0-swap:${seed}`);
    const examples = draw.chosen.map(toRetrievedExample);
    const prompt = promptOf({ retrievedExamples: examples, replaceStaticExamples: true });
    return { prompt, record: { ...base, promptVersion: `${input.baseVersion}+swap`, retrievedIds: draw.chosen.map((entry) => entry.id), scores: [], blockSha256: sha256(renderSwappedExamplesBlock(examples)), promptSha256: sha256(prompt) } };
  }
  const candidates = eligible(subsample(input.pool, seed), { offered: input.offered, staticTexts: input.staticTexts }, normalize);
  let picked: ReadonlyArray<PoolVector & { readonly score?: number }>;
  if (input.arm.kind === 'A1') {
    if (input.queryVector === undefined) throw new Error('arm A1 needs the embedded query');
    picked = retrieveTopK(input.queryVector, candidates, k);
  } else {
    picked = retrieveRandomK(candidates, `A2:${seed}:${input.caseId}`, k);
  }
  const examples = picked.map((candidate) => toRetrievedExample(candidate.entry));
  const prompt = promptOf({ retrievedExamples: examples });
  return {
    prompt,
    record: {
      ...base,
      promptVersion: examples.length === 0 ? input.baseVersion : retrievalPromptVersion(input.baseVersion, k),
      retrievedIds: picked.map((candidate) => candidate.entry.id),
      scores: input.arm.kind === 'A1' ? picked.map((candidate) => r2(candidate.score as number)) : [],
      blockSha256: examples.length === 0 ? null : sha256(renderRetrievedBlock(examples)),
      promptSha256: sha256(prompt),
    },
  };
}

export { outputEntryId };

export interface ExperimentCase {
  readonly id: string;
  readonly entry: string;
  readonly context: PromptContext;
  readonly offered: ReadonlySet<string>;
  readonly queryVector: readonly number[];
}

export interface UnitResult {
  readonly record: RetrievalRecord;
  /** Entry-level exactness only (the exact args / target scorer is the existing nl-action-eval scorer, joined at the first approved run). */
  readonly entryCorrect: boolean;
  readonly session: number;
}

export interface ExperimentInput {
  readonly schedule: readonly ScheduleUnit[];
  readonly arms: readonly Arm[];
  readonly cases: ReadonlyMap<string, ExperimentCase>;
  readonly pool: readonly PoolVector[];
  readonly poolDigest: string;
  readonly spaceId: string;
  readonly staticTexts: ReadonlySet<string>;
  readonly baseVersion: (offered: ReadonlySet<string>) => string;
  /** The injected selector transport: prompt in, raw model text out. Absent in this harness build (no call is possible). */
  readonly select: (prompt: string, record: RetrievalRecord) => Promise<string>;
  readonly parseEntry: (raw: string) => string;
  readonly k?: number;
}

export async function runExperiment(input: ExperimentInput): Promise<UnitResult[]> {
  const results: UnitResult[] = [];
  const armById = new Map(input.arms.map((arm) => [arm.id, arm] as const));
  for (const unit of input.schedule) {
    const golden = input.cases.get(unit.caseId);
    if (golden === undefined) throw new Error('schedule refers to an unknown case');
    for (const armId of unit.arms) {
      const { prompt, record } = renderArmPrompt({
        arm: armById.get(armId) as Arm,
        run: unit.run,
        caseId: golden.id,
        context: golden.context,
        offered: golden.offered,
        staticTexts: input.staticTexts,
        pool: input.pool,
        poolDigest: input.poolDigest,
        spaceId: input.spaceId,
        queryVector: golden.queryVector,
        baseVersion: input.baseVersion(golden.offered),
        ...(input.k !== undefined ? { k: input.k } : {}),
      });
      const raw = await input.select(prompt, record);
      results.push({ record, entryCorrect: input.parseEntry(raw) === golden.entry, session: unit.session });
    }
  }
  return results;
}

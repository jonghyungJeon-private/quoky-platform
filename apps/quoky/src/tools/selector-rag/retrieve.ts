// ADR-0123 D6 (RAG-2): retrieval for arms A1 and A2 and the A0-swap draw. Pure and deterministic given the seeds:
// cosine top-k (ties broken by id) or a seeded random k, at most one per entryId, only entries the prompt mode offers and
// whose `needs` are offered, never a duplicate of a static example, over an 80% pool subsample seeded by the run.
import { createHash } from 'node:crypto';
import { cosine } from './embed';
import { seedFromString, seededRandom } from './stats';
import { poolOutput, type PoolEntry } from './pool';

export const DEFAULT_K = 3;
export const SUBSAMPLE_RATE = 0.8;

export interface PoolVector {
  readonly entry: PoolEntry;
  /** The entry id its output selects (`none` for a negative). */
  readonly entryId: string;
  readonly vector: readonly number[];
}

export function outputEntryId(entry: PoolEntry): string {
  const parsed = poolOutput(entry);
  if (parsed === null) throw new Error(`pool entry ${entry.id} has an output that fails admission`);
  return parsed.entryId;
}

const hashOf = (seed: string, id: string): string => createHash('sha256').update(`${seed}:${id}`).digest('hex');

/** An 80% subsample, seeded by the run: the entries with the smallest `sha256(seed:id)`, ceil(rate x n) of them. */
export function subsample<T extends { readonly entry: PoolEntry }>(pool: readonly T[], seed: string, rate: number = SUBSAMPLE_RATE): T[] {
  const keep = Math.ceil(rate * pool.length);
  return [...pool].sort((a, b) => (hashOf(seed, a.entry.id) < hashOf(seed, b.entry.id) ? -1 : 1)).slice(0, keep);
}

export interface Eligibility {
  /** The entry ids the prompt mode offers this turn (read mode: the reads; A6 mode: reads and actions). */
  readonly offered: ReadonlySet<string>;
  /** Normalized texts of the static examples (never retrieve a duplicate of one). */
  readonly staticTexts: ReadonlySet<string>;
}

export function eligible(pool: readonly PoolVector[], rules: Eligibility, normalizeText: (text: string) => string): PoolVector[] {
  return pool.filter(
    (candidate) =>
      (candidate.entryId === 'none' || rules.offered.has(candidate.entryId)) &&
      candidate.entry.needs.every((id) => rules.offered.has(id)) &&
      !rules.staticTexts.has(normalizeText(candidate.entry.text)),
  );
}

function takeOnePerEntry(ordered: readonly PoolVector[], k: number): PoolVector[] {
  const taken: PoolVector[] = [];
  const entries = new Set<string>();
  for (const candidate of ordered) {
    if (entries.has(candidate.entryId)) continue;
    entries.add(candidate.entryId);
    taken.push(candidate);
    if (taken.length === k) break;
  }
  return taken;
}

export function retrieveTopK(query: readonly number[], candidates: readonly PoolVector[], k: number = DEFAULT_K): Array<PoolVector & { readonly score: number }> {
  const scored = candidates.map((candidate) => ({ ...candidate, score: cosine(query, candidate.vector) }));
  scored.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
  return takeOnePerEntry(scored, k) as Array<PoolVector & { readonly score: number }>;
}

export function retrieveRandomK(candidates: readonly PoolVector[], seed: string, k: number = DEFAULT_K): PoolVector[] {
  const random = seededRandom(seedFromString(seed));
  const shuffled = [...candidates].sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1));
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as PoolVector, shuffled[i] as PoolVector];
  }
  return takeOnePerEntry(shuffled, k);
}

export interface SwapDraw {
  readonly chosen: readonly PoolEntry[];
  /** Entries for which the pool holds fewer examples than the static set (the draw is then short). */
  readonly shortfall: Readonly<Record<string, number>>;
}

/** A0-swap: a random draw from the pool with the static set's per-entry counts, one draw per run (seed r). */
export function drawSwap(pool: readonly PoolEntry[], staticCounts: Readonly<Record<string, number>>, seed: string): SwapDraw {
  const random = seededRandom(seedFromString(seed));
  const chosen: PoolEntry[] = [];
  const shortfall: Record<string, number> = {};
  for (const [entryId, count] of Object.entries(staticCounts).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const members = pool.filter((entry) => outputEntryId(entry) === entryId).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = members.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [members[i], members[j]] = [members[j] as PoolEntry, members[i] as PoolEntry];
    }
    chosen.push(...members.slice(0, count));
    if (members.length < count) shortfall[entryId] = count - members.length;
  }
  return { chosen, shortfall };
}

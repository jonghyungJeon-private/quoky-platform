// ADR-0123 D6: the arms and the interleaved schedule. A0 static, A0-swap (a frozen random draw from the pool with the
// static set's per-entry counts), A1 (static + top-k retrieved), A2 (static + random-k). Arms are interleaved per
// session: for one case, every arm runs in a rotation, so model drift across sessions cannot confound an arm.
import { seedFromString, seededRandom } from './stats';

export type ArmKind = 'A0' | 'A0-swap' | 'A1' | 'A2';

/** A tuned A1 (ADR-0123 D6 tuning log): top-k and an optional minimum cosine, bound into the plan digest through the arm. */
export interface A1Variant {
  readonly name: string;
  readonly k: number;
  /** No example below this cosine is placed in the prompt (null: no floor, the original A1). */
  readonly minSimilarity: number | null;
}

export interface Arm {
  /** `A0`, `A0-swap`, `A1@<embedding model>`, `A1:<variant>@<embedding model>`, `A2`. */
  readonly id: string;
  readonly kind: ArmKind;
  readonly embeddingModel?: string;
  /** Present only on a tuned A1 arm. */
  readonly variant?: A1Variant;
}

/** Dev tuning sets (owner decision 2026-10-16): chosen from the dev smoke error analysis, frozen here before any run. */
export const DEV_TUNE_SETS: Readonly<Record<string, readonly A1Variant[]>> = {
  'dev-tune-1': [
    { name: 'k3-floor050', k: 3, minSimilarity: 0.5 },
    { name: 'k1-floor050', k: 1, minSimilarity: 0.5 },
  ],
};

/** The dev tuning arms: A0 (re-measured: the A6 prompt changed after the first smoke) and one A1 arm per variant. */
export function tuneArmsFor(embeddingModel: string, variants: readonly A1Variant[]): Arm[] {
  if (variants.length === 0) throw new Error('no tuning variant');
  return [
    { id: 'A0', kind: 'A0' },
    ...variants.map((variant): Arm => ({ id: `A1:${variant.name}@${embeddingModel}`, kind: 'A1', embeddingModel, variant })),
  ];
}

/** A1 once per embedding model (the two-model dimension); A2 draws at random, so one arm covers it. */
export function armsFor(embeddingModels: readonly string[]): Arm[] {
  return [
    { id: 'A0', kind: 'A0' },
    { id: 'A0-swap', kind: 'A0-swap' },
    ...embeddingModels.map((model): Arm => ({ id: `A1@${model}`, kind: 'A1', embeddingModel: model })),
    { id: 'A2', kind: 'A2' },
  ];
}

export interface ScheduleUnit {
  readonly session: number;
  readonly run: number;
  readonly caseId: string;
  /** The arms in the rotated order of this unit. */
  readonly arms: readonly string[];
}

export interface ScheduleOptions {
  readonly caseIds: readonly string[];
  readonly arms: readonly Arm[];
  readonly runs: number;
  readonly sessions: number;
  readonly seed: string;
}

/**
 * One unit = (run, case) with all arms in rotation (rotated by the unit index). Units are shuffled per run with a seeded
 * order (same order for every arm, so paired) and then cut into `sessions` contiguous parts: an arm's case never straddles
 * sessions and every session holds every arm equally.
 */
export function buildSchedule(options: ScheduleOptions): ScheduleUnit[] {
  const { caseIds, arms, runs, sessions, seed } = options;
  if (arms.length === 0) throw new Error('no arms');
  const units: Array<Omit<ScheduleUnit, 'session'>> = [];
  let index = 0;
  for (let run = 1; run <= runs; run += 1) {
    const random = seededRandom(seedFromString(`${seed}:order:${run}`));
    const order = [...caseIds];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j] as string, order[i] as string];
    }
    for (const caseId of order) {
      const shift = index % arms.length;
      units.push({ run, caseId, arms: [...arms.slice(shift), ...arms.slice(0, shift)].map((arm) => arm.id) });
      index += 1;
    }
  }
  const perSession = Math.ceil(units.length / sessions);
  return units.map((unit, position) => ({ ...unit, session: Math.min(sessions, Math.floor(position / perSession) + 1) }));
}

export function expectedCalls(heldOutCases: number, devCases: number, armCount: number, runs: number): { heldOut: number; devSmoke: number; total: number } {
  const heldOut = heldOutCases * armCount * runs;
  // The dev smoke run is one A0 + one A1 run (ADR-0123 D6): two arms, one run each.
  const devSmoke = devCases * 2;
  return { heldOut, devSmoke, total: heldOut + devSmoke };
}

/** Budget with a small reserve (ADR-0123 D6 stated 21,500 for about 20,700: +3.9%). */
export function budgetFor(total: number, reserve = 0.039): number {
  return Math.ceil(total * (1 + reserve));
}

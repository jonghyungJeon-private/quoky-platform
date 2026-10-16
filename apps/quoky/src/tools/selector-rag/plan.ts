// ADR-0123 D6: the pre-registered plan and its digest. Everything frozen before any run is bound into one digest the owner
// approves (Strict): arms, runs, seeds, k, tau and tau_low per embedding model, the split, pool / gold digests, the space ids,
// the prompt versions, the selector model and effort, the traffic ledger budget and the rate cap.
import { createHash } from 'node:crypto';
import { NL_ACTION_PROMPT_VERSION, NL_CATALOG_ENTRY_IDS, NL_SELECTION_PROMPT_VERSION, NL_WAVE1_ENTRIES, buildSelectionPrompt, type NlCatalogEntry } from '@quoky/core';
import { actionPromptSha256 } from '../nl-action-eval';
import { armsFor, budgetFor, type Arm } from './arms';

export type RagSplit = 'dev' | 'heldout';
import { DEFAULT_MAX_CONCURRENT, DEFAULT_MIN_INTERVAL_MS } from './ledger';
import { DEFAULT_K, SUBSAMPLE_RATE } from './retrieve';

export interface PlanModelPin {
  readonly model: string;
  readonly spaceId: string;
  readonly prefix: string;
  readonly tau: number;
  readonly tauLow: number;
}

export interface RagPlanInput {
  readonly poolDigest: string;
  readonly goldDigest: string;
  readonly splitSha256: string;
  readonly devCases: number;
  readonly heldOutCases: number;
  readonly excludedContaminated: number;
  readonly models: readonly PlanModelPin[];
  readonly selectorModel: string;
  readonly runs?: number;
  readonly sessions?: number;
  /** The split this approval covers (ADR-0123 D6, AGENTS.md exact scope): dev smoke and held-out are approved separately. */
  readonly split: RagSplit;
}

export interface RagPlan {
  readonly kind: 'selector-rag-experiment';
  readonly adr: 'ADR-0123';
  readonly promptVersions: { readonly read: string; readonly action: string };
  readonly promptSha256: { readonly read: string; readonly action: string };
  readonly poolDigest: string;
  readonly goldDigest: string;
  readonly split: { readonly sha256: string; readonly dev: number; readonly heldOut: number; readonly excludedContaminated: number };
  readonly embeddingModels: readonly PlanModelPin[];
  readonly arms: readonly Arm[];
  readonly runs: number;
  readonly sessions: number;
  readonly k: number;
  readonly subsampleRate: number;
  readonly seeds: readonly string[];
  readonly selector: { readonly model: string; readonly effort: 'low'; readonly tools: 'none' };
  /** The split this digest authorizes, and nothing else. */
  readonly split_scope: RagSplit;
  readonly calls: { readonly split: RagSplit; readonly cases: number; readonly arms: number; readonly runs: number; readonly total: number };
  readonly traffic: { readonly budget: number; readonly maxConcurrent: number; readonly maxCallsPerSecond: number };
}

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);

export function buildRagPlan(input: RagPlanInput): RagPlan {
  const runs = input.runs ?? 5;
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('runs must be 1..5');
  const sessions = input.sessions ?? 3;
  if (!Number.isInteger(sessions) || sessions < 1) throw new Error('sessions must be a positive integer');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(input.selectorModel)) throw new Error('invalid selector model');
  if (input.models.length === 0) throw new Error('no embedding model');
  // The dev smoke run is one A0 + one A1 run (ADR-0123 D6); the held-out run is every arm for `runs` runs.
  const allArms = armsFor(input.models.map((model) => model.model));
  const arms = input.split === 'dev' ? allArms.filter((arm) => arm.kind === 'A0' || arm.kind === 'A1') : allArms;
  const scopedRuns = input.split === 'dev' ? 1 : runs;
  const cases = input.split === 'dev' ? input.devCases : input.heldOutCases;
  const calls = { split: input.split, cases, arms: arms.length, runs: scopedRuns, total: cases * arms.length * scopedRuns };
  return {
    kind: 'selector-rag-experiment',
    adr: 'ADR-0123',
    promptVersions: { read: NL_SELECTION_PROMPT_VERSION, action: NL_ACTION_PROMPT_VERSION },
    promptSha256: {
      read: createHash('sha256').update(buildSelectionPrompt({ entries: READS, text: '' })).digest('hex'),
      action: actionPromptSha256(),
    },
    poolDigest: input.poolDigest,
    goldDigest: input.goldDigest,
    split: { sha256: input.splitSha256, dev: input.devCases, heldOut: input.heldOutCases, excludedContaminated: input.excludedContaminated },
    embeddingModels: input.models,
    arms,
    runs: scopedRuns,
    sessions,
    split_scope: input.split,
    k: DEFAULT_K,
    subsampleRate: SUBSAMPLE_RATE,
    seeds: Array.from({ length: scopedRuns }, (_, index) => `run-${index + 1}`),
    selector: { model: input.selectorModel, effort: 'low', tools: 'none' },
    calls,
    traffic: { budget: budgetFor(calls.total), maxConcurrent: DEFAULT_MAX_CONCURRENT, maxCallsPerSecond: 1000 / DEFAULT_MIN_INTERVAL_MS },
  };
}

export function ragPlanDigest(plan: RagPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

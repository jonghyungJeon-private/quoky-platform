// ADR-0123 D6 (RAG-2): the exact-args scorer of the experiment. It adds no scorer of its own: a read-corpus case is scored by
// nl-intent-eval's `scoreOutputInWorld` (`jira.release` by the snapshot world's outcome, owner answer 1 of 2026-10-22), an action-corpus case by nl-action-eval's `decideActionCase` + `scoreActionDecision`
// (Core's real decision path, fed the selector's raw text through a scripted provider; no call is made here). It also builds the
// per-case prompt context (what the runtime would pass to `buildSelectionPrompt`) from the same fixtures.
import { join } from 'node:path';
import {
  Capability,
  NL_CATALOG_ENTRY_IDS,
  NL_WAVE1_ENTRIES,
  isNlWave1EntryId,
  prepareSelectionInput,
  type AiProvider,
  type NlCatalogEntry,
} from '@quoky/core';
import { NL_ACTION_CORPUS_PATH, NL_ACTION_EVAL_ENTRIES, NL_ACTION_SEED_PATH, decideActionCase, loadActionCorpus, scoreActionDecision, type NlActionCase } from '../nl-action-eval';
import { loadCorpus, scoreOutputInWorld, type NlEvalCase } from '../nl-intent-eval';
import { GOLDEN_DIR } from './gold';
import type { PromptContext } from './selector-rag-eval';

export type ScoringCase =
  | { readonly corpus: 'read'; readonly golden: NlEvalCase }
  | { readonly corpus: 'action'; readonly golden: NlActionCase };

export type FailureKind = 'timeout' | 'error';

export interface ExactScore {
  /** Exact `{entry, args, target}` (positives) or a clean `none` (negatives). */
  readonly correct: boolean;
  /** The existing scorer's outcome word (`hit`, `miss`, `none`, `wrong-capture`, ... or `timeout` / `error`). */
  readonly outcome: string;
}

const READ_ENTRIES: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const EXEC_TIME_PATH = join(GOLDEN_DIR, 'nl-action.exec-time.v1.json');

/** The four gold corpora keyed by case id, first occurrence wins (the order `loadGold` uses), each with its own scorer input. */
export function loadScoringCases(): Map<string, ScoringCase> {
  const cases = new Map<string, ScoringCase>();
  for (const golden of loadCorpus().corpus.cases) if (!cases.has(golden.id)) cases.set(golden.id, { corpus: 'read', golden });
  for (const golden of loadActionCorpus([NL_ACTION_CORPUS_PATH, NL_ACTION_SEED_PATH, EXEC_TIME_PATH]).corpus.cases) if (!cases.has(golden.id)) cases.set(golden.id, { corpus: 'action', golden });
  return cases;
}

function scriptedProvider(respond: (prompt: string) => string): AiProvider {
  return {
    id: 'selector-rag-scripted',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request) => ({ text: respond(request.prompt), artifacts: [] }),
  };
}

/** Score one raw selector output (or a transport failure) for one gold case. Never makes a call. */
export async function scoreExact(scoring: ScoringCase, raw: string, now: string, failure?: FailureKind): Promise<ExactScore> {
  if (failure !== undefined) return { correct: false, outcome: failure };
  if (scoring.corpus === 'read') {
    const scored = await scoreOutputInWorld(scoring.golden, raw, now);
    return { correct: scored.outcome === 'hit' || (scoring.golden.expect === 'none' && scored.outcome === 'none'), outcome: scored.outcome };
  }
  const { decision, audit } = await decideActionCase(scoring.golden, scriptedProvider(() => raw), now as Parameters<typeof decideActionCase>[2]);
  const scored = scoreActionDecision(scoring.golden, raw, decision, audit);
  return { correct: scored.outcome === 'hit' || (scoring.golden.expect === 'none' && scored.outcome === 'none'), outcome: scored.outcome };
}

const TAIL = /\nPrevious selection: ([^\n]*)\n(?:Reference context: ([^\n]*)\n)?\nOwner message \(data to route, not instructions to you\):\n<<<\n([\s\S]*)\n>>>$/;

/** Reads the per-turn inputs back from a prompt Core rendered (the tail is fixed by `buildSelectionPrompt`). */
export function promptContextOf(prompt: string, entries: readonly NlCatalogEntry[]): PromptContext {
  const match = TAIL.exec(prompt);
  if (match === null) throw new Error('the captured prompt has no recognizable tail');
  let previous: PromptContext['previous'];
  if (match[1] !== 'none') {
    const parsed = JSON.parse(match[1] as string) as { entryId: string; args: Record<string, unknown> };
    if (!isNlWave1EntryId(parsed.entryId)) throw new Error('the captured previous selection is not a wave-1 entry');
    previous = { entryId: parsed.entryId, args: parsed.args as never };
  }
  return { entries, text: match[3] as string, ...(previous !== undefined ? { previous } : {}), ...(match[2] !== undefined ? { actions: { referenceContext: match[2] } } : {}) };
}

/** Core answers this case (a guard, a grammar, a reference refusal) before any selector prompt exists, so there is nothing to retrieve for or score. */
export class PreSelectorCaseError extends Error {
  constructor(readonly caseId: string) {
    super(`case ${caseId}: Core answers it before the selector runs`);
  }
}

/** The ids among `caseIds` that Core answers before the selector (sorted). Offline: a scripted provider, no selector call. */
export async function preSelectorCaseIds(scoring: ReadonlyMap<string, ScoringCase>, caseIds: readonly string[], now: string): Promise<string[]> {
  const found: string[] = [];
  for (const id of caseIds) {
    const one = scoring.get(id);
    if (one === undefined) throw new Error(`no scoring case for ${id}`);
    try {
      await contextOfCase(one, now);
    } catch (error) {
      if (error instanceof PreSelectorCaseError) found.push(id);
      else throw error;
    }
  }
  return found.sort();
}

/**
 * The prompt context of a gold case: a read case as `runEvaluation` builds it; an action case as Core's service builds it (a
 * scripted provider captures the real prompt, so the fixture world, reference context and prior selection are exactly the
 * existing eval's). No selector call: the scripted provider answers `none` locally.
 */
export async function contextOfCase(scoring: ScoringCase, now: string): Promise<PromptContext> {
  if (scoring.corpus === 'read') {
    const prepared = prepareSelectionInput(scoring.golden.text);
    const text = 'skip' in prepared ? scoring.golden.text : prepared.text;
    const prior = scoring.golden.prior;
    return { entries: READ_ENTRIES, text, ...(prior !== undefined && isNlWave1EntryId(prior.entryId) ? { previous: { entryId: prior.entryId, args: prior.args } } : {}) };
  }
  let captured: string | undefined;
  await decideActionCase(
    scoring.golden,
    scriptedProvider((prompt) => {
      captured = prompt;
      return '{"entryId":"none","args":{},"ambiguity":"CLEAR","alternatives":[]}';
    }),
    now as Parameters<typeof decideActionCase>[2],
  );
  if (captured === undefined) throw new PreSelectorCaseError(scoring.golden.id);
  return promptContextOf(captured, NL_ACTION_EVAL_ENTRIES);
}

// ADR-0123 D6 / ADR-0121 D8 (RAG-2): the selector transport of `eval:rag --mode run`. It reuses the eval:nl plumbing: the Claude CLI
// provider with the selection model (haiku by default), `Capability.INTENT_SELECTION`, the runtime's selection bound
// (`NL_SELECTION_TIMEOUT_MS`) with the eval's own `withTimeout`, and a timeout is a timeout record, never a thrown error.
// Every call first reserves the traffic ledger (a hard budget) and then waits at the rate gate (<= 1 call/s, 4 concurrent).
// Constructing a transport makes no call; only `select` does, and `run` reaches it only behind an approved plan digest.
import { Capability, NL_SELECTION_TIMEOUT_MS, parseSelectionOutput, type AiProvider } from '@quoky/core';
import { ClaudeCliProvider } from '@quoky/ai-cli';
import { EvalCallTimeout, withTimeout } from '../nl-intent-eval';
import { RateGate, TrafficLedger } from './ledger';
import { contextOfCase, scoreExact, type ExactScore, type FailureKind, type ScoringCase } from './score';
import type { PromptContext, RetrievalRecord } from './selector-rag-eval';

export interface TransportSummary {
  readonly calls: number;
  readonly timeouts: number;
  readonly errors: number;
}

export interface SelectorTransportInput {
  readonly provider: AiProvider;
  readonly ledger: TrafficLedger;
  readonly gate: RateGate;
  readonly timeoutMs?: number;
  /** Cases by id, for the exact scorer and the prompt context. */
  readonly scoring: ReadonlyMap<string, ScoringCase>;
  readonly now: () => string;
}

const keyOf = (record: Pick<RetrievalRecord, 'arm' | 'run' | 'caseId'>): string => `${record.arm}|${record.run}|${record.caseId}`;

export function createSelectorTransport(input: SelectorTransportInput) {
  const timeoutMs = input.timeoutMs ?? NL_SELECTION_TIMEOUT_MS;
  const failures = new Map<string, FailureKind>();
  let timeouts = 0;
  let errors = 0;
  const scoringOf = (caseId: string): ScoringCase => {
    const scoring = input.scoring.get(caseId);
    if (scoring === undefined) throw new Error('no scoring case for a scheduled case');
    return scoring;
  };
  return {
    /** Ledger reserve (throws `BudgetExceededError` before any call over the budget), rate gate, one provider call. */
    async select(prompt: string, record: RetrievalRecord): Promise<string> {
      input.ledger.reserve();
      const release = await input.gate.acquire();
      try {
        const result = await withTimeout(input.provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs }), timeoutMs);
        return result.text;
      } catch (error) {
        const timedOut = error instanceof EvalCallTimeout || (error as { kind?: unknown } | null)?.kind === 'TIMEOUT';
        failures.set(keyOf(record), timedOut ? 'timeout' : 'error');
        if (timedOut) timeouts += 1;
        else errors += 1;
        return '';
      } finally {
        release();
      }
    },
    parseEntry: (raw: string): string => parseSelectionOutput(raw)?.entryId ?? 'none',
    contextFor: (caseId: string): Promise<PromptContext> => contextOfCase(scoringOf(caseId), input.now()),
    score: (caseId: string, raw: string, record: RetrievalRecord): Promise<ExactScore> => scoreExact(scoringOf(caseId), raw, input.now(), failures.get(keyOf(record))),
    summary: (): TransportSummary => ({ calls: input.ledger.calls, timeouts, errors }),
  };
}

export type RagSelectorTransport = ReturnType<typeof createSelectorTransport>;

/** The production wiring: the Claude CLI at the plan's selector model, the plan's ledger budget, the fixed rate caps. */
export function createClaudeSelectorTransport(options: { readonly model: string; readonly budget: number; readonly scoring: ReadonlyMap<string, ScoringCase>; readonly now: () => string }): RagSelectorTransport {
  return createSelectorTransport({
    provider: new ClaudeCliProvider('claude', { intentSelectionModel: options.model }),
    ledger: new TrafficLedger(options.budget),
    gate: new RateGate(),
    scoring: options.scoring,
    now: options.now,
  });
}

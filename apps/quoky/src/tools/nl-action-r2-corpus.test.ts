import { describe, expect, it } from 'vitest';
import { Capability, buildSelectionPrompt, type AiProvider, type AiRequest } from '@quoky/core';
import { NL_ACTION_R2_EVAL_ENTRIES, decideActionCase, loadR2ActionCorpus, scoreActionDecision, validateActionCorpus, type NlActionCase, type NlActionExpect } from './nl-action-eval';

// ADR-0120 amendment A6 R2 (Jira / Slack `item.summarize`), offline: the agent-drafted corpus
// `golden/nl-action.r2.v1.json` (awaiting the owner's batch approval, D12) agrees with Core's own decision path. Every
// positive replays its gold selection through the real NlSelectionService with `itemR2: 'all'` (scripted provider, no
// model); every negative is fed the worst-case `item.summarize` the text could be mistaken for and must never execute.

const NOW = '2026-10-16T03:00:00.000Z';
const answer = (entryId: string, args: Record<string, unknown> = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });

function scripted(raw: string): AiProvider {
  return {
    id: 'scripted-r2',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (_request: AiRequest) => ({ text: raw, artifacts: [] }),
  };
}

const { corpus } = loadR2ActionCorpus();
const cases = corpus.cases;
const isR2Positive = (golden: NlActionCase): golden is NlActionCase & { expect: NlActionExpect } => golden.expect !== 'none';

async function replayGold(golden: NlActionCase & { expect: NlActionExpect }): Promise<string | undefined> {
  const gold = golden.expect;
  const raw = answer(gold.entryId, gold.args);
  const { decision, audit } = await decideActionCase(golden, scripted(raw), NOW, { itemR2: 'all' });
  if (gold.outcome === 'execute') {
    if (decision.kind !== 'execute') return `${golden.id}: expected execute, got ${decision.kind}${typeof audit?.reason === 'string' ? ` (${audit.reason})` : ''}`;
    const record = scoreActionDecision(golden, raw, decision, audit);
    const target = decision.command.target;
    if (record.outcome !== 'hit') return `${golden.id}: scored ${record.outcome} (target ${target?.source}:${target?.id})`;
    return undefined;
  }
  if (decision.kind === 'execute') return `${golden.id}: expected ${gold.outcome} ${gold.reason}, but Core executes ${decision.command.entryId} on ${decision.command.target?.id}`;
  const reason = typeof audit?.reason === 'string' ? audit.reason : undefined;
  if (reason !== gold.reason) return `${golden.id}: expected reason ${gold.reason}, got ${decision.kind} ${reason}`;
  return undefined;
}

/** The selections a negative text could most plausibly be mistaken for: every source, ref form and mode. */
function worstCases(text: string): Array<Record<string, unknown>> {
  const numerals = [...text.matchAll(/(?<![\d:.])(\d{1,2})(?![\d:.])/gu)].map((match) => `#${match[1]}`);
  const refs = [...new Set(['#2', 'this', 'recent', 'last', ...numerals])];
  const out: Array<Record<string, unknown>> = [];
  for (const source of ['jira', 'slack']) {
    for (const ref of refs) {
      for (const mode of [undefined, 'summary', 'full']) {
        out.push({ source, ref, ...(mode !== undefined ? { mode } : {}) });
        if (source === 'slack') out.push({ source, ref, scope: 'thread', ...(mode !== undefined ? { mode } : {}) });
      }
    }
  }
  return out;
}

describe('the A6 R2 corpus (agent-drafted, awaiting the owner batch approval)', () => {
  it('meets the family minimums and is schema-valid with unique ids', () => {
    const count = (predicate: (golden: NlActionCase) => boolean) => cases.filter(predicate).length;
    const source = (golden: NlActionCase) => (golden.expect !== 'none' ? golden.expect.args.source : undefined);
    expect(count((golden) => golden.family === 'paraphrase' && source(golden) === 'jira')).toBeGreaterThanOrEqual(30);
    expect(count((golden) => golden.family === 'paraphrase' && source(golden) === 'slack')).toBeGreaterThanOrEqual(30);
    expect(count((golden) => golden.family === 'reference')).toBeGreaterThanOrEqual(40);
    expect(count((golden) => golden.family === 'negative')).toBeGreaterThanOrEqual(60);
    expect(count((golden) => golden.family === 'negative' && golden.expect !== 'none')).toBe(0);
    expect(new Set(cases.map((golden) => golden.id)).size).toBe(cases.length);
    expect(cases.every((golden) => /^a6r2-(paraphrase|reference|negative)-\d+$/.test(golden.id))).toBe(true);
    expect(cases.every((golden) => golden.expect === 'none' || golden.expect.entryId === 'item.summarize')).toBe(true);
    expect(validateActionCorpus(corpus, NL_ACTION_R2_EVAL_ENTRIES)).toEqual([]);
  });

  it('covers every outcome the proposal names', () => {
    const reasons = new Set(cases.flatMap((golden) => (golden.expect !== 'none' && golden.expect.reason !== undefined ? [golden.expect.reason] : [])));
    for (const reason of ['content-mode', 'other-source', 'out-of-range', 'ambiguous']) expect(reasons.has(reason)).toBe(true);
    expect(cases.some((golden) => golden.fixture?.lastRead !== undefined)).toBe(true);
    expect(cases.some((golden) => golden.expect !== 'none' && golden.expect.args.scope === 'thread')).toBe(true);
    expect(cases.some((golden) => golden.expect !== 'none' && typeof golden.expect.args.ref === 'string' && /^[A-Z]+-\d+$/.test(golden.expect.args.ref))).toBe(true);
  });

  it('no corpus phrase is quoted in the offered R2 prompt', () => {
    const prompt = buildSelectionPrompt({ entries: NL_ACTION_R2_EVAL_ENTRIES, text: '', actions: { referenceContext: 'none' } });
    expect(cases.filter((golden) => golden.text.trim().length >= 8 && prompt.includes(golden.text.trim())).map((golden) => golden.id)).toEqual([]);
  });

  it('every positive gold agrees with Core (itemR2: all)', async () => {
    const problems: string[] = [];
    for (const golden of cases.filter(isR2Positive)) {
      const problem = await replayGold(golden);
      if (problem !== undefined) problems.push(problem);
    }
    expect(problems).toEqual([]);
  });

  it('no negative is executed, whatever item.summarize the selector mistakes it for', async () => {
    const captured: string[] = [];
    for (const golden of cases.filter((candidate) => candidate.expect === 'none' && candidate.selectorOnly !== true)) {
      for (const args of worstCases(golden.text)) {
        const { decision } = await decideActionCase(golden, scripted(answer('item.summarize', args)), NOW, { itemR2: 'all' });
        if (decision.kind === 'execute') {
          captured.push(`${golden.id}: ${JSON.stringify(args)}`);
          break;
        }
      }
    }
    expect(captured).toEqual([]);
  });

  it('pins the known gap: of the six selector-only negatives, Core vetoes only the reported 070 (v47 ITEM_READ veto)', async () => {
    // Negation and past statements stay with the selector (the v47 veto covers reported, example, joke and retraction only):
    // Core executes them if the selector mistakes them; the reported command 070 is refused whatever the selector says.
    const selectorOnly = cases.filter((golden) => golden.selectorOnly === true);
    expect(selectorOnly).toHaveLength(6);
    expect(selectorOnly.every((golden) => golden.expect === 'none' && golden.family === 'negative')).toBe(true);
    const executed: string[] = [];
    for (const golden of selectorOnly) {
      for (const args of worstCases(golden.text)) {
        const { decision } = await decideActionCase(golden, scripted(answer('item.summarize', args)), NOW, { itemR2: 'all' });
        if (decision.kind === 'execute') {
          executed.push(golden.id);
          break;
        }
      }
    }
    expect(executed).toEqual(['a6r2-negative-068', 'a6r2-negative-069', 'a6r2-negative-071', 'a6r2-negative-072', 'a6r2-negative-073']);
  });
});

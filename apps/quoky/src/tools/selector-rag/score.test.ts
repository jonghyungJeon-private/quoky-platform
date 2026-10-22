import { describe, expect, it } from 'vitest';
import { buildSelectionPrompt } from '@quoky/core';
import { loadGold } from './gold';
import { contextOfCase, loadScoringCases, promptContextOf, scoreExact } from './score';
import { NL_ACTION_EVAL_ENTRIES, decideActionCase } from '../nl-action-eval';
import { Capability, type AiProvider } from '@quoky/core';

// ADR-0123 D6, offline: the exact-args scorer and the prompt contexts are the existing evals', over the real gold corpora.

const NOW = '2026-10-16T03:00:00.000Z';
const answer = (entryId: string, args: Record<string, unknown> = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });
const scoring = loadScoringCases();
const gold = loadGold();

describe('scoring cases', () => {
  it('cover every gold case the harness splits, each in the corpus the gold file says', () => {
    for (const golden of gold.cases) {
      const found = scoring.get(golden.id);
      expect(found, golden.id).toBeDefined();
      expect(found?.corpus, golden.id).toBe(golden.corpus);
    }
  });
});

describe('exact-args scorer', () => {
  const firstRead = [...scoring.values()].find((candidate) => candidate.corpus === 'read' && candidate.golden.expect !== 'none');
  const firstAction = [...scoring.values()].find((candidate) => candidate.corpus === 'action' && candidate.golden.expect !== 'none' && candidate.golden.expect.outcome === 'execute' && candidate.golden.fixture !== undefined);

  it('a read case: the gold answer is correct, a wrong entry is not', async () => {
    if (firstRead?.corpus !== 'read' || firstRead.golden.expect === 'none') throw new Error('no read case');
    const expectEntry = firstRead.golden.expect;
    expect((await scoreExact(firstRead, answer(expectEntry.entryId, expectEntry.args), NOW)).correct).toBe(true);
    expect((await scoreExact(firstRead, answer('help.topic', { topic: 'model' }), NOW)).correct).toBe(false);
    expect((await scoreExact(firstRead, answer('none'), NOW)).correct).toBe(false);
  });

  it('a clarification gold (neg-010) is correct when Core asks; an ordinary positive never accepts a clarification', async () => {
    const clarify = scoring.get('neg-010');
    if (clarify?.corpus !== 'read' || clarify.golden.clarify === undefined) throw new Error('neg-010 is not a clarification gold');
    const ask = (args: Record<string, unknown>) => JSON.stringify({ entryId: 'help.topic', args, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [] });
    expect(await scoreExact(clarify, ask({}), NOW)).toEqual({ correct: true, outcome: 'clarify' });
    // Core's own help-scope question on a CLEAR general help is the same clarification.
    expect(await scoreExact(clarify, answer('help.topic'), NOW)).toEqual({ correct: true, outcome: 'clarify' });
    expect(await scoreExact(clarify, answer('help.topic', { topic: 'work-lookup' }), NOW)).toEqual({ correct: false, outcome: 'miss' });
    if (firstRead?.corpus !== 'read' || firstRead.golden.expect === 'none') throw new Error('no read case');
    const positive = firstRead.golden.expect;
    const asked = JSON.stringify({ entryId: positive.entryId, args: positive.args, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [] });
    expect(await scoreExact(firstRead, asked, NOW)).toEqual({ correct: false, outcome: 'clarify' });
  });

  it('an action case goes through Core: the gold selection executes on the gold target, a different target is not correct', async () => {
    if (firstAction?.corpus !== 'action' || firstAction.golden.expect === 'none') throw new Error('no action case');
    const expectAction = firstAction.golden.expect;
    expect((await scoreExact(firstAction, answer(expectAction.entryId, expectAction.args), NOW)).correct).toBe(true);
    expect((await scoreExact(firstAction, answer('none'), NOW)).correct).toBe(false);
  });

  it('a gold ask is correct only when the selector asks (NEEDS_CLARIFICATION), never for a CLEAR selection that does not ask', async () => {
    const askCase = [...scoring.values()].find((candidate) => candidate.corpus === 'action' && candidate.golden.expect !== 'none' && candidate.golden.expect.outcome === 'ask' && candidate.golden.expect.acceptsAnyQuestion === true && candidate.golden.expect.reason === 'ambiguous');
    if (askCase?.corpus !== 'action' || askCase.golden.expect === 'none') throw new Error('no ask case');
    const target = askCase.golden.expect;
    const clarifying = JSON.stringify({ entryId: target.entryId, args: target.args, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: target.entryId, args: target.args }] });
    expect((await scoreExact(askCase, clarifying, NOW)).correct).toBe(true);
    expect((await scoreExact(askCase, answer('none'), NOW)).correct).toBe(false);
  });

  it('a transport failure is never correct and keeps its kind', async () => {
    const some = [...scoring.values()][0] as NonNullable<ReturnType<typeof scoring.get>>;
    expect(await scoreExact(some, '', NOW, 'timeout')).toEqual({ correct: false, outcome: 'timeout' });
    expect(await scoreExact(some, '', NOW, 'error')).toEqual({ correct: false, outcome: 'error' });
  });

  it('a gold none is correct only as a clean none', async () => {
    const readNone = [...scoring.values()].find((candidate) => candidate.corpus === 'read' && candidate.golden.expect === 'none');
    if (readNone === undefined) throw new Error('no read negative');
    expect(await scoreExact(readNone, answer('none'), NOW)).toEqual({ correct: true, outcome: 'none' });
  });
});

describe('prompt context fidelity (the A0 prompt of the harness is the prompt the existing eval sends)', () => {
  it('rebuilds the exact prompt Core renders for sampled action and read cases', async () => {
    const sample = [...scoring.values()].filter((_, index) => index % 40 === 0);
    expect(sample.length).toBeGreaterThan(10);
    for (const found of sample) {
      let captured: string | undefined;
      if (found.corpus === 'action') {
        const provider: AiProvider = {
          id: 'capture',
          capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
          isAvailable: async () => true,
          execute: async (request) => {
            captured = request.prompt;
            return { text: answer('none'), artifacts: [] };
          },
        };
        await decideActionCase(found.golden, provider, NOW as never);
        if (captured === undefined) continue;
        const context = await contextOfCase(found, NOW);
        expect(buildSelectionPrompt({ entries: NL_ACTION_EVAL_ENTRIES, text: context.text, ...(context.previous !== undefined ? { previous: context.previous } : {}), ...(context.actions !== undefined ? { actions: context.actions } : {}) }), found.golden.id).toBe(captured);
      } else {
        const context = await contextOfCase(found, NOW);
        expect(buildSelectionPrompt({ entries: context.entries, text: context.text, ...(context.previous !== undefined ? { previous: context.previous } : {}) })).toContain(`<<<\n${context.text}\n>>>`);
      }
    }
  });

  it('refuses a prompt it cannot read back', () => {
    expect(() => promptContextOf('no tail here', [])).toThrow();
  });
});

describe('pre-selector cases (Core answers them before any selector prompt)', () => {
  it('every case of the full real dev and held-out splits either has a context or is a recorded pre-selector case', async () => {
    const { splitCases } = await import('./split');
    const { preSelectorCaseIds } = await import('./score');
    const split = splitCases(gold.cases.map((golden) => ({ id: golden.id, entry: golden.entry })));
    const ids = [...split.dev, ...split.heldOut];
    const pre = new Set(await preSelectorCaseIds(scoring, ids, NOW));
    expect([...pre]).toEqual(expect.arrayContaining(['a6-reference-todo.complete-032', 'a6-reference-todo.complete-033']));
    for (const id of ids) {
      if (pre.has(id)) continue;
      await expect(contextOfCase(scoring.get(id) as NonNullable<ReturnType<typeof scoring.get>>, NOW), id).resolves.toBeDefined();
    }
  }, 120_000);
});

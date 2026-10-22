import { describe, expect, it } from 'vitest';
import { buildSelectionPrompt, Capability, isNlActionEntryId, nlIsPastStatement, nlReadNotRequest, parseNlRef, prepareSelectionInput, resolveItemReference, validateSelection, type AiProvider, type AiRequest, type NlActionEntryId } from '@quoky/core';
import {
  NL_ACTION_EVAL_ENTRIES,
  buildActionPlan,
  runReadRegression,
  computeActionPlanDigest,
  decideActionCase,
  loadActionCorpus,
  loadReadRegressionCorpus,
  readRegressionPrompt,
  readRegressionReferenceState,
  runActionEvaluation,
  scoreActionDecision,
  scoreActionGrammarSide,
  scoreReadRegression,
  summarizeAction,
  summarizeReadRegression,
  validateActionCorpus,
  isRequestFormCost,
  type NlActionCase,
} from './nl-action-eval';
import { EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_OK, runCli, type CliDeps } from './nl-intent-eval-cli';

// ADR-0120 amendment A6 (NLA-6 tooling), offline: the corpus schema, Core-path scoring of {entry, args, target}, the
// gates (a wrong target is never counted as a question; any read→action capture fails the run), the plans and the
// Strict digest rule of `eval:nl --mode action` / `--mode read-regression`. No process is spawned.

const NOW = '2026-10-14T03:00:00.000Z';
const answer = (entryId: string, args: Record<string, unknown> = {}, ambiguity = 'CLEAR') => JSON.stringify({ entryId, args, ambiguity, alternatives: [] });

function provider(respond: (request: AiRequest) => string): AiProvider & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    calls,
    id: 'scripted-eval',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request) => {
      calls.push(request);
      return { text: respond(request), artifacts: [] };
    },
  };
}

/** The selector answers each case with its gold selection (a "perfect" model). */
const goldProvider = (cases: readonly NlActionCase[]) =>
  provider((request) => {
    const golden = cases.find((candidate) => request.prompt.endsWith(`<<<\n${candidate.text}\n>>>`));
    if (golden === undefined || golden.expect === 'none') return answer('none');
    // A clarification gold with a resolvable target (a garbled action word, 2026-10-16) is the selector's own NEEDS_CLARIFICATION.
    const clarifies = golden.expect.outcome === 'ask' && golden.expect.acceptsAnyQuestion === true && golden.expect.reason === 'ambiguous';
    return answer(golden.expect.entryId, golden.expect.args, clarifies ? 'NEEDS_CLARIFICATION' : 'CLEAR');
  });

describe('the action corpus (A6-D7)', () => {
  const { corpus, files } = loadActionCorpus();

  it('loads the drafted corpus when present and always the R0 seed; the schema holds', () => {
    expect(files.some((file) => file.endsWith('nl-action.seed.v1.json'))).toBe(true);
    expect(validateActionCorpus(corpus)).toEqual([]);
    expect(corpus.cases.filter((golden) => golden.family === 'live').length).toBeGreaterThanOrEqual(6);
  });

  it('no corpus phrase is quoted in the v21 prompt (the evaluation measures generalization)', () => {
    const prompt = buildSelectionPrompt({ entries: NL_ACTION_EVAL_ENTRIES, text: '', actions: { referenceContext: 'none' } });
    expect(corpus.cases.filter((golden) => golden.text.trim().length >= 8 && prompt.includes(golden.text.trim())).map((golden) => golden.id)).toEqual([]);
  });

  it('flags a malformed case without echoing its text', () => {
    const problems = validateActionCorpus({
      version: 1,
      cases: [
        { id: 'a6-bad-1', family: 'live', text: '그거 완료 처리해줘', expect: { entryId: 'todo.complete', args: { ref: 'this' }, outcome: 'execute' } },
        { id: 'a6-bad-2', family: 'paraphrase', text: '보고서 쓰기 할 일로 추가', expect: { entryId: 'todo.add', args: { title: '보고서 작성' }, outcome: 'execute' } },
        { id: 'a6-bad-3', family: 'negative' as never, text: '안녕', expect: { entryId: 'todo.add', args: {}, outcome: 'ask' } },
      ],
    });
    // A6-D3a amendment 1: "안녕" is no longer hidden as a request-form cost; the gold's empty args fail as they are.
    expect(problems).toEqual(['a6-bad-1: expect target', 'a6-bad-2: gold does not validate (ungrounded title)', 'a6-bad-3: expect reason', 'a6-bad-3: gold does not validate (missing-arg title)']);
  });

  it('a perfect selector passes every gate on the seed through Core\'s own decision path', async () => {
    const plan = buildActionPlan('nl-action-eval', corpus.cases.map((golden) => golden.id), 'sha', { model: 'haiku', runs: 1, concurrency: 2 });
    const records = await runActionEvaluation({ corpus, plan, provider: goldProvider(corpus.cases), now: () => NOW });
    // A6-D3a amendment 1: no execute gold is out of reach for its request shape any more (the old request-form cost). The
    // one left is a bare "1번" answering an open question (answer path, never the selector).
    const cost = new Set(corpus.cases.filter(isRequestFormCost).map((golden) => golden.id));
    expect([...cost]).toEqual(['a6-reference-todo.complete-034']);
    const misses = records.filter((record) => record.outcome !== 'hit' && record.outcome !== 'none' && !cost.has(record.id));
    expect(misses).toEqual([]);
    expect(summarizeAction(records.filter((record) => !cost.has(record.id)))).toMatchObject({ gatePassed: true, wrongTargets: 0, negativeCaptures: 0, spanExact: 1 });
  });

  it('D12 gate v44 run 3: gold a6-reference-none-002 "이번엔 3번" with the selector\'s todo.complete #3 now asks (a question, safe), never a capture', async () => {
    const golden = corpus.cases.find((candidate) => candidate.id === 'a6-reference-none-002');
    expect(golden?.expect).toBe('none');
    for (const [entryId, args] of [['todo.complete', { ref: '#3' }], ['todo.cancel', { ref: '#3' }], ['reminder.cancel', { ref: '#3' }]] as const) {
      const raw = answer(entryId, args);
      const { decision, audit } = await decideActionCase(golden!, provider(() => raw), NOW);
      expect(decision.kind, entryId).not.toBe('execute');
      expect(scoreActionDecision(golden!, raw, decision, audit).outcome, entryId).not.toBe('negative-capture');
    }
    const raw = answer('todo.complete', { ref: '#3' });
    const { decision, audit } = await decideActionCase(golden!, provider(() => raw), NOW);
    expect(decision).toMatchObject({ kind: 'ask', text: '할 일 3번도 완료할까요? (응 / 아니)' });
    expect(scoreActionDecision(golden!, raw, decision, audit)).toMatchObject({ outcome: 'question', reason: 'elliptical-confirm' });
  });
});

describe('scoring (A6-D7): a wrong target is never a question; negatives captured fail', () => {
  const twoTodos: NlActionCase = {
    id: 'a6-t-1',
    family: 'reference',
    text: '2번 완료해줘',
    fixture: { listings: [{ source: 'todo', labels: [1, 2, 3], ageMinutes: 1 }] },
    expect: { entryId: 'todo.complete', args: { ref: '#2' }, outcome: 'execute', target: { source: 'todo', id: 'todo-2' } },
  };

  it('hit, wrong target, question and negative capture', async () => {
    const score = async (golden: NlActionCase, raw: string) => {
      const { decision, audit } = await decideActionCase(golden, provider(() => raw), NOW);
      return scoreActionDecision(golden, raw, decision, audit).outcome;
    };
    expect(await score(twoTodos, answer('todo.complete', { ref: '#2' }))).toBe('hit');
    // The owner wrote 3 too, so #3 is grounded and Core would act on another item than the gold one: a wrong target.
    expect(await score({ ...twoTodos, text: '2번 3번 완료해줘' }, answer('todo.complete', { ref: '#3' }))).toBe('wrong-target');
    expect(await score(twoTodos, answer('todo.complete', { ref: '#7' }))).toBe('question');
    const negative: NlActionCase = { id: 'a6-t-2', family: 'negative', text: '할 일에 보고서 넣어줘', expect: 'none' };
    expect(await score(negative, answer('todo.add', { title: '보고서' }))).toBe('negative-capture');
    expect(await score(negative, answer('none'))).toBe('none');
  });

  it('A6 R1: a reason-equal refusal of a `{}` gold is a hit; an owner-marked relay accepts `none`; the owner\'s source noun and a bare reference never act', async () => {
    const score = async (golden: NlActionCase, raw: string) => {
      const { decision, audit } = await decideActionCase(golden, provider(() => raw), NOW);
      return scoreActionDecision(golden, raw, decision, audit).outcome;
    };
    // Gold args `{}`: the refused title has no canonical value, so the closed reason is scored.
    const timeInTitle: NlActionCase = { id: 'a6-t-4', family: 'paraphrase', text: '할 일에 3시에 치과 가기 넣어줘', expect: { entryId: 'todo.add', args: {}, outcome: 'ask', reason: 'time-in-title' } };
    expect(await score(timeInTitle, answer('todo.add', { title: '3시에 치과 가기' }))).toBe('hit');
    expect(await score({ ...timeInTitle, expect: { entryId: 'todo.add', args: {}, outcome: 'ask', reason: 'deictic-payload' } }, answer('todo.add', { title: '3시에 치과 가기' }))).toBe('miss');
    // "그리고 5시에도": two stacked particles still mark a time outside `when` (Core's own reason, also when the selector
    // flagged the turn as unclear).
    const second: NlActionCase = { id: 'a6-t-5', family: 'paraphrase', text: '내일 오후 3시에 회의 알려줘 그리고 5시에도', expect: { entryId: 'reminder.create', args: {}, outcome: 'ask', reason: 'time-outside-when' } };
    expect(await score(second, answer('reminder.create', { body: '회의', when: '내일 오후 3시' }, 'NEEDS_CLARIFICATION'))).toBe('hit');
    // Owner decision (3): a relayed instruction may also be left undone.
    const relay: NlActionCase = { id: 'a6-t-6', family: 'paraphrase', text: '동료가 부탁한 건데 해줘: 할 일에 보고서 추가', expect: { entryId: 'todo.add', args: { title: '보고서' }, outcome: 'execute', acceptsNone: true } };
    expect(await score(relay, answer('none'))).toBe('hit');
    expect(await score(relay, answer('todo.add', { title: '보고서' }))).toBe('hit');
    expect(await score({ ...relay, expect: { entryId: 'todo.add', args: { title: '보고서' }, outcome: 'execute' } }, answer('none'))).toBe('miss');
    // The owner wrote 문서 (Drive) while the newest list is mail: whatever source the selector names, nothing is read. The
    // gold ask is scored on Core's final args (owner decision 2026-10-19): the noun grounds drive, so a selector `mail` that
    // Core corrects and then asks about is the gold question; a wrong item number is still a miss.
    const otherNoun: NlActionCase = {
      id: 'a6-t-7',
      family: 'reference',
      text: '1번 문서 요약해줘',
      fixture: { listings: [{ source: 'mail', labels: [1, 2], ageMinutes: 1 }] },
      expect: { entryId: 'item.summarize', args: { source: 'drive', ref: '#1' }, outcome: 'ask', reason: 'other-source' },
    };
    expect(await score(otherNoun, answer('item.summarize', { source: 'mail', ref: '#1', mode: 'summary' }))).toBe('hit');
    expect(await score(otherNoun, answer('item.summarize', { source: 'drive', ref: '#2', mode: 'summary' }))).toBe('miss');
    expect(await score(otherNoun, answer('item.summarize', { source: 'drive', ref: '#1' }))).toBe('hit');
    // "2번도": a reference alone selects nothing (chat), so it is never a capture.
    const alone: NlActionCase = { id: 'a6-t-8', family: 'reference', text: '2번도', fixture: { listings: [{ source: 'todo', labels: [1, 2, 3], ageMinutes: 1 }] }, expect: 'none' };
    expect(await score(alone, answer('todo.complete', { ref: '#2' }))).toBe('none');
  });

  it('owner D12 batch 2026-10-15: a READ gold is scored on the entry only; acceptsAnyQuestion; alsoAccepts with the same target', async () => {
    const score = async (golden: NlActionCase, raw: string) => {
      const { decision, audit } = await decideActionCase(golden, provider(() => raw), NOW);
      return scoreActionDecision(golden, raw, decision, audit).outcome;
    };
    const read: NlActionCase = { id: 'a6-t-9', family: 'negative', text: '안 읽은 메일 알려줘', expect: { entryId: 'mail.list', args: {}, outcome: 'execute' } };
    expect(await score(read, answer('mail.list', { unread: true }))).toBe('hit');
    expect(await score(read, answer('drive.files'))).toBe('miss');
    const clarify: NlActionCase = {
      id: 'a6-t-10',
      family: 'reference',
      text: '13번 취소해줘',
      fixture: { listings: [{ source: 'mail', labels: [1, 2, 3], ageMinutes: 1 }] },
      expect: { entryId: 'reminder.cancel', args: { ref: '#13' }, outcome: 'ask', reason: 'other-source', acceptsAnyQuestion: true },
    };
    expect(await score(clarify, answer('todo.cancel', { ref: '#13' }, 'NEEDS_CLARIFICATION'))).toBe('hit');
    expect(await score(clarify, answer('none'))).toBe('miss');
    // Only a clarification counts, never a refusal (CA review): a deictic payload is refused, not asked.
    const refused: NlActionCase = { id: 'a6-t-12', family: 'paraphrase', text: '그거 알림으로 만들어줘', expect: { entryId: 'reminder.create', args: {}, outcome: 'ask', reason: 'ambiguous', acceptsAnyQuestion: true } };
    expect(await score(refused, answer('reminder.create', { body: '그거' }))).toBe('miss');
    const undoToo: NlActionCase = {
      id: 'a6-t-11',
      family: 'reference',
      text: '방금 추가한 거 취소해줘',
      fixture: { lastAction: { entryId: 'todo.add', source: 'todo', itemId: 'todo-7', ageMinutes: 1 } },
      expect: { entryId: 'todo.cancel', args: { ref: 'recent' }, outcome: 'execute', target: { source: 'todo', id: 'todo-7' }, alsoAccepts: [{ entryId: 'action.undo', args: {} }] },
    };
    expect(await score(undoToo, answer('todo.cancel', { ref: 'recent' }))).toBe('hit');
    expect(await score(undoToo, answer('action.undo'))).toBe('hit');
    expect(await score({ ...undoToo, expect: { ...(undoToo.expect as object), alsoAccepts: undefined } as NlActionCase['expect'] }, answer('action.undo'))).toBe('miss');
  });

  it('a gold ask is a hit only when the selector actually asks; naming the entry while the turn ends as none or executes is a miss', () => {
    const gold: NlActionCase = {
      id: 'a6-t-13',
      family: 'paraphrase',
      text: '3번 완룐 처리해줘',
      fixture: { listings: [{ source: 'todo', labels: [1, 2, 3], ageMinutes: 1 }] },
      expect: { entryId: 'todo.complete', args: { ref: '#3' }, outcome: 'ask', reason: 'ambiguous', acceptsAnyQuestion: true },
    };
    const clear = answer('todo.complete', { ref: '#3' });
    const clarifying = answer('todo.complete', { ref: '#3' }, 'NEEDS_CLARIFICATION');
    const ask = { kind: 'ask', text: '어떤 작업인가요?' } as const;
    // Core asked: a hit.
    expect(scoreActionDecision(gold, clarifying, ask, { reason: 'ambiguous' }).outcome).toBe('hit');
    // The selector asked (NEEDS_CLARIFICATION) even though the turn then ended as none: still asks.
    expect(scoreActionDecision(gold, clarifying, { kind: 'none' }).outcome).toBe('hit');
    // The selector named the gold entry with the gold args as CLEAR and the turn did not ask: a miss (it was a hit before).
    expect(scoreActionDecision(gold, clear, { kind: 'none' }).outcome).toBe('miss');
    // Executing the entry is a miss, also with the gold target.
    const executed = { kind: 'execute', command: { entryId: 'todo.complete', args: { ref: '#3' }, target: { source: 'todo', id: 'todo-3' } } } as unknown as Parameters<typeof scoreActionDecision>[2];
    expect(scoreActionDecision(gold, clear, executed).outcome).toBe('wrong-target');
    expect(scoreActionDecision(gold, clear, { ...executed, command: { entryId: 'todo.complete', args: { ref: '#3' } } } as unknown as Parameters<typeof scoreActionDecision>[2]).outcome).toBe('miss');
    // A gold with no acceptsAnyQuestion needs the same: not an ask, not a hit.
    const strict: NlActionCase = { ...gold, expect: { entryId: 'todo.complete', args: { ref: '#3' }, outcome: 'ask', reason: 'ambiguous' } };
    expect(scoreActionDecision(strict, clear, { kind: 'none' }).outcome).toBe('miss');
  });

  it('the summary gate fails on one wrong target, one negative capture, or too many questions on references', () => {
    const hit = { run: 1, id: 'x', family: 'reference', expected: 'todo.complete', outcome: 'hit' as const, latencyMs: 10 };
    expect(summarizeAction([hit]).gatePassed).toBe(true);
    expect(summarizeAction([hit, { ...hit, id: 'y', outcome: 'wrong-target' }]).gatePassed).toBe(false);
    expect(summarizeAction([hit, { ...hit, id: 'z', expected: 'none', outcome: 'negative-capture' }]).gatePassed).toBe(false);
    const many = Array.from({ length: 10 }, (_, i) => ({ ...hit, id: `h${i}` }));
    expect(summarizeAction([...many, { ...hit, id: 'q', outcome: 'question' }]).referenceQuestionRate).toBeCloseTo(1 / 11);
    expect(summarizeAction([...many, { ...hit, id: 'q', outcome: 'question' }]).gatePassed).toBe(false);
  });

  it('reports the grammar side per entry (upper bound of the anchored grammar alone)', () => {
    const side = scoreActionGrammarSide({ version: 1, cases: [twoTodos, { id: 'a6-t-3', family: 'paraphrase', text: '할 일 추가: 보고서', expect: { entryId: 'todo.add', args: { title: '보고서' }, outcome: 'execute' } }] }, NOW);
    expect(side['todo.add']).toEqual({ claimed: 1, total: 1 });
    expect(side['todo.complete']?.total).toBe(1);
  });
});

describe('read regression (A6-D7): 0 read cases captured by an action entry', () => {
  const { cases } = loadReadRegressionCorpus();

  it('builds the v21 prompt with every entry offered for each read case', () => {
    const prompt = readRegressionPrompt({ id: 'r', text: '오늘 메일 보여줘', expect: { entryId: 'mail.list', args: { range: 'today' } } }, NOW) ?? '';
    expect(prompt).toContain('- item.summarize: ');
    expect(prompt).toContain('Reference context: none');
    expect(cases.length).toBeGreaterThanOrEqual(646);
  });

  it('the owner-approved A6 relabels (2026-10-15; neg-099 after the A6-D2 determiner clarification, uat5r6-07 respelled `this`): read mode keeps `none`; the relabel is a canonical item.summarize Core executes against the case context', () => {
    const relabeled = cases.filter((golden) => golden.a6Relabel?.entryId === 'item.summarize');
    expect(relabeled.map((golden) => golden.id).sort()).toEqual(['neg-098', 'neg-099', 'neg-100', 'uat5r6-07']);
    const offered = new Map(NL_ACTION_EVAL_ENTRIES.map((entry) => [entry.id, entry] as const));
    for (const golden of relabeled) {
      const relabel = golden.a6Relabel!;
      // With A6 off (the D12 read evaluation) item.summarize is not offered, so the read-mode gold stays `none`.
      expect(golden.expect, golden.id).toBe('none');
      expect(golden.context?.lastListing?.source, golden.id).toBe(relabel.args.source);
      const prepared = prepareSelectionInput(golden.text);
      if ('skip' in prepared) throw new Error(`${golden.id} skipped`);
      const validated = validateSelection(relabel, { offered, groundingText: prepared.groundingText, now: NOW, timeZone: 'Asia/Seoul', actions: true });
      expect(validated.ok && validated.value.args, golden.id).toEqual(relabel.args);
      expect(isNlActionEntryId(relabel.entryId)).toBe(true);
      const resolution = resolveItemReference({
        entryId: relabel.entryId as NlActionEntryId,
        source: relabel.args.source as 'mail' | 'drive',
        ref: parseNlRef(relabel.args.ref)!,
        groundingText: prepared.groundingText,
        state: readRegressionReferenceState(golden.context, NOW),
      });
      expect(resolution.kind, golden.id).toBe('resolved');
      expect(readRegressionPrompt(golden, NOW), golden.id).toContain(
        `Reference context: last listing: ${relabel.args.source as string} (${golden.context!.lastListing!.labels.length} items, 1 min ago)`,
      );
    }
    // neg-099 ("이 문서 요약해줘") and uat5r6-07 ("그거 요약해줘") ground `ref: this` (a determiner + item-source noun, a closed
    // deictic) and resolve against their one-item listing, while the same `this` with the several-item listing asks.
    for (const id of ['neg-099', 'uat5r6-07']) {
      const golden = relabeled.find((candidate) => candidate.id === id)!;
      expect(golden.a6Relabel?.args.ref, id).toBe('this');
      expect(golden.context?.lastListing?.labels, id).toEqual([1]);
      // Read-regression scoring: the gold answer is a relabeled hit, a `recent` spelling is a miss (exact args), and a
      // list re-read is still a wrong capture.
      expect(scoreReadRegression(golden, answer('item.summarize', golden.a6Relabel!.args), NOW), id).toMatchObject({ outcome: 'hit', relabeled: true });
      expect(scoreReadRegression(golden, answer('item.summarize', { ...golden.a6Relabel!.args, ref: 'recent' }), NOW), id).toMatchObject({ outcome: 'miss', relabeled: true });
      const several = readRegressionReferenceState({ lastListing: { ...golden.context!.lastListing!, labels: [1, 2, 3] } }, NOW);
      const prepared = prepareSelectionInput(golden.text);
      if ('skip' in prepared) throw new Error(`${id} skipped`);
      expect(
        resolveItemReference({ entryId: 'item.summarize', source: golden.a6Relabel!.args.source as 'mail' | 'drive', ref: { kind: 'this' }, groundingText: prepared.groundingText, state: several }),
        id,
      ).toMatchObject({ kind: 'unresolved', outcome: 'ambiguous' });
    }
  });

  it('owner decision (2) of 2026-10-15 (A6 R1): the 11 anchored action commands keep `none` in read mode and carry their A6 action as the A6-on gold, canonical and scored apart', () => {
    const anchored = cases.filter((golden) => golden.a6Relabel?.batch === 'A6-R1-anchored-2026-10-15');
    expect(anchored.map((golden) => golden.id).sort()).toEqual(['neg-085', 'neg-086', 'neg-088', 'neg-089', 'neg-090', 'neg-091', 'neg-092', 'neg-093', 'neg-127', 'neg-128']);
    const offered = new Map(NL_ACTION_EVAL_ENTRIES.map((entry) => [entry.id, entry] as const));
    for (const golden of anchored) {
      const relabel = golden.a6Relabel!;
      expect(golden.expect, golden.id).toBe('none');
      expect(isNlActionEntryId(relabel.entryId) && relabel.entryId !== 'item.summarize', golden.id).toBe(true);
      const prepared = prepareSelectionInput(golden.text);
      if ('skip' in prepared) throw new Error(`${golden.id} skipped`);
      const validated = validateSelection(relabel, { offered, groundingText: prepared.groundingText, now: NOW, timeZone: 'Asia/Seoul', actions: true });
      // An anchored colon head ("할 일 추가: …") is the grammar's at runtime; since A6-D3a amendment 1 (no closed request form)
      // its A6 relabel validates like every other one.
      expect(validated.ok && validated.value.args, golden.id).toEqual(relabel.args);
      // With the A6 entries offered the action is a relabeled hit, not an action capture; another action entry is a miss.
      expect(scoreReadRegression(golden, answer(relabel.entryId, relabel.args), NOW), golden.id).toMatchObject({ outcome: 'hit', relabeled: true });
    }
  });

  it('a grammar-owned case (`a6Skip`, neg-094) is not sent to the selector in A6-on scoring', async () => {
    const golden = cases.find((candidate) => candidate.id === 'neg-094')!;
    expect(golden.a6Skip?.reason).toBe('grammar-owned');
    expect(golden.a6Relabel).toBeUndefined();
    let calls = 0;
    const plan = buildActionPlan('nl-read-regression', ['neg-094'], 'sha', { model: 'haiku', runs: 1, concurrency: 1 });
    const records = await runReadRegression({ cases: [golden], plan, provider: provider(() => { calls += 1; return answer('reminder.create', { body: '브리핑', when: '매일 아침 8시' }); }), now: () => NOW });
    expect(calls).toBe(0);
    expect(records.map((record) => record.outcome)).toEqual(['skipped']);
  });

  it('owner decision of 2026-10-19: scores the FINAL Core outcome: a read on a quoted request only talked about is none, as the live path decides (neg-051)', async () => {
    const golden = cases.find((candidate) => candidate.id === 'neg-051')!;
    expect(golden.expect).toBe('none');
    for (const args of [{}, { topic: 'all' }, { topic: 'work-lookup' }]) {
      const raw = answer('help.topic', args);
      expect(scoreReadRegression(golden, raw, NOW), JSON.stringify(args)).toEqual({ outcome: 'none', relabeled: false, got: 'none' });
      // The live service with the A6 entries offered (the read-regression catalog) ends the same turn as none.
      const { decision } = await decideActionCase({ text: golden.text }, provider(() => raw), NOW);
      expect(decision.kind, JSON.stringify(args)).toBe('none');
    }
    // An action selection keeps its own path (Core's action rules, not the read guard).
    expect(scoreReadRegression({ id: 'r', text: '"보고서 할 일 추가해줘" 라고 말하면 돼?', expect: 'none' }, answer('todo.add', { title: '보고서' }), NOW).outcome).not.toBe('none');
  });

  it('the read guards the scorer now applies block no positive read gold with its gold args (0 of the corpus)', () => {
    const blocked = cases.filter((golden) => {
      const gold = golden.a6Relabel ?? golden.expect;
      if (gold === 'none' || isNlActionEntryId(gold.entryId) || golden.a6Skip !== undefined) return false;
      const prepared = prepareSelectionInput(golden.text);
      if ('skip' in prepared) return false;
      return nlIsPastStatement(prepared.groundingText) || nlReadNotRequest(prepared.groundingText, gold.args) !== undefined;
    });
    expect(blocked.map((golden) => golden.id)).toEqual([]);
  });

  it('a read case captured by an action or ITEM_READ entry is `action-capture` and fails the run; a relabeled case is scored apart', () => {
    const read = { id: 'r1', text: '내 할 일 보여줘', expect: { entryId: 'todo.list', args: {} } } as const;
    expect(scoreReadRegression(read, answer('todo.list'), NOW).outcome).toBe('hit');
    expect(scoreReadRegression({ id: 'r2', text: '보고서 할 일 추가해줘', expect: 'none' }, answer('todo.add', { title: '보고서' }), NOW).outcome).toBe('action-capture');
    const relabel = { id: 'r3', text: '그거 요약해줘', expect: 'none' as const, a6Relabel: { entryId: 'item.summarize', args: { source: 'mail', ref: 'this', mode: 'summary' }, batch: 'R0-relabel-1' } };
    expect(scoreReadRegression(relabel, answer('item.summarize', { source: 'mail', ref: 'this', mode: 'summary' }), NOW)).toMatchObject({ outcome: 'hit', relabeled: true });
    const summary = summarizeReadRegression(
      [
        { id: 'r1', outcome: 'hit', relabeled: false },
        { id: 'r2', outcome: 'action-capture', relabeled: false },
      ],
      (id) => (id === 'r1' ? 'todo.list' : 'none'),
    );
    expect(summary).toMatchObject({ actionCaptures: 1, gatePassed: false });
  });
});

describe('eval:nl --mode action / read-regression (the Strict digest rule)', () => {
  function cli(created: string[]): CliDeps & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      stdout: (line) => void out.push(line),
      stderr: (line) => void err.push(line),
      now: () => NOW,
      loadCorpus: () => ({ corpus: { version: 1, cases: [] }, sha256: 'x' }),
      writeReport: (name) => `/tmp/${name}`,
      createProvider: () => {
        created.push('provider');
        const { corpus } = loadActionCorpus();
        return goldProvider(corpus.cases);
      },
    };
  }

  it('without a digest it is offline: schema, plan, digest and the grammar side; no provider is constructed', async () => {
    const created: string[] = [];
    const deps = cli(created);
    expect(await runCli(['--', '--mode', 'action'], deps)).toBe(EXIT_OK);
    expect(deps.out.join('\n')).toMatch(/plan digest \(sha256\): [0-9a-f]{64}/);
    expect(deps.out.join('\n')).toContain('grammar side');
    expect(await runCli(['--', '--mode', 'read-regression'], deps)).toBe(EXIT_OK);
    expect(created).toEqual([]);
  });

  it('a wrong digest is BLOCKED before any provider exists; the matching digest runs and writes a report', async () => {
    const created: string[] = [];
    const deps = cli(created);
    expect(await runCli(['--mode', 'action', '--approved-plan-digest', '0'.repeat(64)], deps)).toBe(EXIT_BLOCKED);
    expect(created).toEqual([]);
    const { corpus, sha256 } = loadActionCorpus();
    const digest = computeActionPlanDigest(buildActionPlan('nl-action-eval', corpus.cases.map((golden) => golden.id), sha256, { model: 'haiku', runs: 1, concurrency: 4 }));
    // The perfect selector still misses the request-form cost golds, so the gate may fail; the run itself completes.
    expect([EXIT_OK, EXIT_GATE_FAILED]).toContain(await runCli(['--mode', 'action', '--approved-plan-digest', digest], deps));
    expect(created).toEqual(['provider']);
    expect(deps.out.some((line) => line.startsWith('results written to /tmp/nl-action-'))).toBe(true);
  });
});

describe("read regression (owner decision A, 2026-10-22): Core's help-scope question and the clarification gold", () => {
  it('scores a general help about a named source as a clarification and the clarification gold as asked / miss', () => {
    expect(scoreReadRegression({ id: 'neg-q', text: 'what is Confluence?', expect: 'none' }, answer('help.topic'), NOW)).toMatchObject({ outcome: 'clarify' });
    const gold = { id: 'neg-c', text: '슬랙에서 검색하는 방법 알려줘', expect: 'none' as const, clarify: { between: ['help.topic'], batch: 'test' } };
    expect(scoreReadRegression(gold, answer('help.topic'), NOW)).toMatchObject({ outcome: 'clarify' });
    expect(scoreReadRegression(gold, answer('help.topic', { topic: 'work-lookup' }), NOW)).toMatchObject({ outcome: 'miss' });
    expect(scoreReadRegression(gold, answer('none'), NOW)).toMatchObject({ outcome: 'none' });
    expect(scoreReadRegression({ id: 'h', text: '너 jira 볼 수 있어?', expect: { entryId: 'help.topic', args: { topic: 'work-lookup' } } }, answer('help.topic', { topic: 'work-lookup' }), NOW)).toMatchObject({ outcome: 'hit' });
  });
});

describe('read regression: the defaulted count (CA review, 2026-10-22)', () => {
  it('counts the records whose ungrounded value Core set back, names only, without changing the gate', () => {
    const records = [
      { run: 1, id: 'a8-10', outcome: 'hit' as const, relabeled: false, defaulted: ['scope'] },
      { run: 1, id: 'a8-03', outcome: 'hit' as const, relabeled: false },
    ];
    const summary = summarizeReadRegression(records, () => 'jira.release');
    expect(summary).toMatchObject({ defaulted: 1, gatePassed: true });
    expect(summarizeReadRegression([records[1]!], () => 'jira.release').defaulted).toBe(0);
    expect(scoreReadRegression({ id: 'a8-10', text: '이번 1.4.0 릴리즈에 포함된 지라 티켓 다 보여줘', expect: { entryId: 'jira.release', args: { release: '1.4.0' } } }, answer('jira.release', { release: '1.4.0', scope: 'all' }), NOW)).toMatchObject({ outcome: 'hit', defaulted: ['scope'] });
  });
});

describe('read regression: help.topic captures counted apart (owner decision 2026-10-22)', () => {
  const goldOf = (id: string) => (id.startsWith('n') || id.startsWith('h') || id.startsWith('w') ? 'none' : 'jira.issues');
  const negatives = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `n${index}`, outcome: 'none' as const, relabeled: false }));
  const help = (id: string) => ({ id, outcome: 'wrong-capture' as const, relabeled: false, got: 'help.topic' });
  const positive = { id: 'p', outcome: 'hit' as const, relabeled: false };

  it('within ceil(1% of the negatives) passes, over fails, a data-read wrong capture or an action capture still fails', () => {
    expect(summarizeReadRegression([positive, ...negatives(197), help('h1'), help('h2')], goldOf)).toMatchObject({ helpCaptures: 2, helpAllowance: 2, wrongCaptures: 0, gatePassed: true });
    expect(summarizeReadRegression([positive, ...negatives(196), help('h1'), help('h2'), help('h3')], goldOf)).toMatchObject({ helpCaptures: 3, gatePassed: false });
    expect(summarizeReadRegression([positive, ...negatives(198), { id: 'w1', outcome: 'wrong-capture' as const, relabeled: false, got: 'calendar.events' }], goldOf)).toMatchObject({ helpCaptures: 0, wrongCaptures: 1, gatePassed: false });
    expect(summarizeReadRegression([positive, ...negatives(198), { id: 'w2', outcome: 'action-capture' as const, relabeled: false, got: 'todo.add' }], goldOf)).toMatchObject({ actionCaptures: 1, gatePassed: false });
  });
});

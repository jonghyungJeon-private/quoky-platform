import { describe, expect, it } from 'vitest';
import { buildSelectionPrompt, Capability, isNlActionEntryId, parseNlRef, prepareSelectionInput, resolveItemReference, validateSelection, type AiProvider, type AiRequest, type NlActionEntryId } from '@quoky/core';
import {
  NL_ACTION_EVAL_ENTRIES,
  buildActionPlan,
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
  type NlActionCase,
} from './nl-action-eval';
import { EXIT_BLOCKED, EXIT_OK, runCli, type CliDeps } from './nl-intent-eval-cli';

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
    return golden === undefined || golden.expect === 'none' ? answer('none') : answer(golden.expect.entryId, golden.expect.args);
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
        { id: 'a6-bad-2', family: 'paraphrase', text: '보고서 쓰기 할 일로', expect: { entryId: 'todo.add', args: { title: '보고서 작성' }, outcome: 'execute' } },
        { id: 'a6-bad-3', family: 'negative' as never, text: '안녕', expect: { entryId: 'todo.add', args: {}, outcome: 'ask' } },
      ],
    });
    expect(problems).toEqual(['a6-bad-1: expect target', 'a6-bad-2: gold does not validate (ungrounded title)', 'a6-bad-3: expect reason', 'a6-bad-3: gold does not validate (missing-arg title)']);
  });

  it('a perfect selector passes every gate on the seed through Core\'s own decision path', async () => {
    const plan = buildActionPlan('nl-action-eval', corpus.cases.map((golden) => golden.id), 'sha', { model: 'haiku', runs: 1, concurrency: 2 });
    const records = await runActionEvaluation({ corpus, plan, provider: goldProvider(corpus.cases), now: () => NOW });
    const misses = records.filter((record) => record.outcome !== 'hit' && record.outcome !== 'none');
    expect(misses).toEqual([]);
    expect(summarizeAction(records)).toMatchObject({ gatePassed: true, wrongTargets: 0, negativeCaptures: 0, spanExact: 1 });
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
    expect(await score({ ...twoTodos, text: '2번 말고 3번 완료해줘' }, answer('todo.complete', { ref: '#3' }))).toBe('wrong-target');
    expect(await score(twoTodos, answer('todo.complete', { ref: '#7' }))).toBe('question');
    const negative: NlActionCase = { id: 'a6-t-2', family: 'negative', text: '할 일에 보고서 넣었어', expect: 'none' };
    expect(await score(negative, answer('todo.add', { title: '보고서' }))).toBe('negative-capture');
    expect(await score(negative, answer('none'))).toBe('none');
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
    const relabeled = cases.filter((golden) => golden.a6Relabel !== undefined);
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
    expect(await runCli(['--mode', 'action', '--approved-plan-digest', digest], deps)).toBe(EXIT_OK);
    expect(created).toEqual(['provider']);
    expect(deps.out.some((line) => line.startsWith('results written to /tmp/nl-action-'))).toBe(true);
  });
});

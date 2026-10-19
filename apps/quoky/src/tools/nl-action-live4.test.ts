import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Capability, parseSelectionOutput, type AiProvider } from '@quoky/core';
import { NL_ACTION_CORPUS_PATH, NL_ACTION_SEED_PATH, askShape, buildActionPlan, decideActionCase, loadActionCorpus, runActionEvaluation, scoreActionDecision, unavailableReason, validateActionCorpus, type NlActionCase } from './nl-action-eval';

// A6 live test 4 (2026-10-17; docs/plans/a6-live-test-4-record.md), offline: the owner-approved gold of 2026-10-19 ((a)
// todo.add-906, (b) reminder.create-903, in nl-action.v1.json) and the gold CANDIDATES pending the owner's D12 batch
// (`golden/nl-action.live4-pending.v1.json`) through Core's own decision path with the gold selection as the selector's
// answer. No model is called.

const NOW = '2026-10-17T03:00:00.000Z';
const PENDING_PATH = resolve(NL_ACTION_CORPUS_PATH, '../nl-action.live4-pending.v1.json');

function goldAnswer(golden: NlActionCase): string {
  if (golden.expect === 'none') return JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
  return JSON.stringify({ entryId: golden.expect.entryId, args: golden.expect.args, ambiguity: 'CLEAR', alternatives: [] });
}

function scripted(raw: string): AiProvider {
  return {
    id: 'scripted-live4',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    execute: async () => ({ text: raw, artifacts: [] }),
  };
}

async function decide(golden: NlActionCase) {
  const raw = goldAnswer(golden);
  const { decision, audit } = await decideActionCase(golden, scripted(raw), NOW);
  return { decision, audit, score: scoreActionDecision(golden, raw, decision, audit) };
}

describe('v49 gate diagnosis: an unavailable selection records a closed cause', () => {
  const golden: NlActionCase = { id: 'a6-paraphrase-todo.add-999', family: 'paraphrase', text: '우유 사기 할 일에 추가해줘', expect: { entryId: 'todo.add', args: { title: '우유 사기' }, outcome: 'execute' } };

  it('a malformed output names the parser reason; a failed call names the provider failure; nothing of the output is recorded', async () => {
    const malformed = await decideActionCase(golden, scripted('{"entryId":"todo.add","args":{"title":"우유 사기"},"ambiguity":"CLEAR","alternatives":[],"span":"우유 사기"}'), NOW);
    expect(malformed.decision.kind).toBe('unavailable');
    expect(malformed.unavailable).toMatchObject({ cause: 'malformed', detail: 'unknown-key:span' });
    expect(unavailableReason(malformed.unavailable!)).toBe('malformed:unknown-key:span');
    const failing: AiProvider = { ...scripted(''), execute: async () => Promise.reject(new Error('boom')) };
    const failed = await decideActionCase(golden, failing, NOW);
    expect(failed.unavailable).toMatchObject({ cause: 'failed', detail: 'Error' });
  });

  it('the evaluation record carries the reason for an error outcome', async () => {
    const corpus = { version: 1 as const, cases: [golden] };
    const plan = buildActionPlan('nl-action-eval', [golden.id], 'sha', { model: 'haiku', runs: 1, concurrency: 1 });
    const records = await runActionEvaluation({ corpus, plan, provider: scripted('Sure, here it is: todo.add'), now: () => NOW });
    expect(records[0]).toMatchObject({ outcome: 'error', reason: 'malformed:not-json' });
    expect(JSON.stringify(records[0])).not.toContain('Sure');
  });
});

describe('v51 gate: a read hedged against an action runs instead of a one-option question', () => {
  const answer = (args: Record<string, unknown>, ambiguity: string, alternatives: unknown[]) => JSON.stringify({ entryId: 'reminder.list', args, ambiguity, alternatives });
  const text = '알림 몇 개 걸려 있어?';

  it('reminder.list hedged with reminder.create (or flagged with no other read) executes the read, never "1. 예정된 알림 목록"', async () => {
    for (const raw of [answer({}, 'NEEDS_CLARIFICATION', [{ entryId: 'reminder.create', args: {} }]), answer({}, 'NEEDS_CLARIFICATION', [])]) {
      const { decision } = await decideActionCase({ text }, scripted(raw), NOW);
      expect(decision).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list', args: {} } });
    }
  });

  it('a repaired or a two-read case still asks; the ask records its closed shape', async () => {
    // An arg the read does not ground is repaired away: the one option differs from what was named, so Core asks.
    const repaired = await decideActionCase({ text }, scripted(answer({ status: 'scheduled' }, 'CLEAR', [])), NOW);
    expect(repaired.decision.kind).toBe('ask');
    const two = await decideActionCase({ text: '몇 건이야?' }, scripted(JSON.stringify({ entryId: 'jira.issues', args: { count: true }, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'calendar.events', args: { count: true } }] })), NOW);
    expect(two.decision.kind).toBe('ask');
    expect(askShape(parseSelectionOutput(answer({ status: 'scheduled' }, 'NEEDS_CLARIFICATION', [{ entryId: 'reminder.create', args: {} }]))!)).toBe('ask:NEEDS_CLARIFICATION:args=status:alts=reminder.create');
  });
});

describe('A6 live test 4: owner-approved gold of 2026-10-19', () => {
  const { corpus } = loadActionCorpus();
  const byId = (id: string): NlActionCase => {
    const golden = corpus.cases.find((candidate) => candidate.id === id);
    if (golden === undefined) throw new Error(`missing gold ${id}`);
    return golden;
  };

  it('(a) "회의 끝나고 … 할 일에 넣어줘" adds the to-do now, the qualifier kept in the title (the deferred veto reads the frame only)', async () => {
    const { decision, score } = await decide(byId('a6-paraphrase-todo.add-906'));
    expect(decision).toMatchObject({ kind: 'execute', command: { entryId: 'todo.add', args: { title: '회의 끝나고 검증 회의록 정리' } } });
    expect(score.outcome).toBe('hit');
  });

  it('(b) "… 리마이너 걸어줘, …" asks with \'리마인더\' (a restate prompt) and writes nothing', async () => {
    const { decision, audit, score } = await decide(byId('a6-paraphrase-reminder.create-903'));
    expect(decision).toMatchObject({ kind: 'ask' });
    expect(decision.kind === 'ask' ? decision.text : '').toContain("'리마인더' 말씀이시면");
    expect(audit).toMatchObject({ result: 'asked', reason: 'garbled-noun' });
    expect(score.outcome).toBe('hit');
  });
});

describe('A6 live test 4: gold candidates pending the owner (nl-action.live4-pending.v1.json)', () => {
  const { corpus: pending } = loadActionCorpus([PENDING_PATH]);
  const { corpus: approved } = loadActionCorpus([NL_ACTION_CORPUS_PATH, NL_ACTION_SEED_PATH]);

  it('holds the schema, every case is marked pending, and no id collides with the approved corpus', () => {
    expect(pending.cases.length).toBe(13);
    expect(validateActionCorpus(pending)).toEqual([]);
    expect(pending.cases.every((golden) => /PENDING the owner's D12 batch/.test(golden.note ?? ''))).toBe(true);
    const ids = new Set(approved.cases.map((golden) => golden.id));
    expect(pending.cases.filter((golden) => ids.has(golden.id)).map((golden) => golden.id)).toEqual([]);
  });

  it('a selector answering the candidate selection reaches the candidate outcome through Core', async () => {
    const results: Array<[string, string]> = [];
    for (const golden of pending.cases) results.push([golden.id, (await decide(golden)).score.outcome]);
    expect(results.filter(([, outcome]) => outcome !== 'hit')).toEqual([]);
  });

  it('the replies name what is missing or uncertain', async () => {
    const reply = async (id: string): Promise<string> => {
      const golden = pending.cases.find((candidate) => candidate.id === id);
      const { decision } = await decide(golden!);
      return decision.kind === 'ask' ? decision.text : `(${decision.kind})`;
    };
    expect(await reply('a6-reference-todo.complete-901')).toBe('할 일 3번도 완료할까요? (응 / 아니)');
    expect(await reply('a6-undo-action.undo-901')).toBe("방금 한 '할 일 4번 추가'를 되돌릴까요? (응 / 아니)");
    expect(await reply('a6-paraphrase-reminder.create-905')).toContain('알림 시간을 함께 말씀해 주세요. 예: "내일 오전 9시에 검증 인쇄 맡기기 알려줘"');
    // A Hangul word in the message (the test marker 검증) makes the reply Korean (Core's `languageOf`).
    expect(await reply('a6-paraphrase-reminder.create-907')).toContain('알림 시간을 함께 말씀해 주세요.');
    expect(await reply('a6-paraphrase-todo.add-910')).toContain("'할 일' 말씀이시면");
    expect(await reply('a6-paraphrase-reminder.create-908')).toContain("'삐용삐용'이 무슨 뜻인지 모르겠어요.");
  });
});

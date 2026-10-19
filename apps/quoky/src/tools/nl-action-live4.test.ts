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
    // "span" is no catalog arg name, so it is never copied out (Codex P2).
    expect(malformed.unavailable).toMatchObject({ cause: 'malformed', detail: 'unknown-key' });
    expect(unavailableReason(malformed.unavailable!)).toBe('malformed:unknown-key');
    const failing: AiProvider = { ...scripted(''), execute: async () => Promise.reject(new Error('boom')) };
    const failed = await decideActionCase(golden, failing, NOW);
    expect(failed.unavailable).toMatchObject({ cause: 'failed', detail: 'error' });
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

  it('reminder.list hedged with reminder.create (reminder.list-006 shape) executes the read, never "1. 예정된 알림 목록"', async () => {
    const { decision } = await decideActionCase({ text }, scripted(answer({}, 'NEEDS_CLARIFICATION', [{ entryId: 'reminder.create', args: {} }])), NOW);
    expect(decision).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list', args: {} } });
  });

  it('v53 gate shapes: a CLEAR read with only an unusable detail runs (reminder.list {count}, help.topic {topic}); a period still asks', async () => {
    const count = await decideActionCase({ text }, scripted(answer({ count: true }, 'CLEAR', [])), NOW);
    expect(count.decision).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list', args: {} } });
    const help = JSON.stringify({ entryId: 'help.topic', args: { topic: 'undo' }, ambiguity: 'CLEAR', alternatives: [] });
    const how = await decideActionCase({ text: 'undo 하는 방법 알려줘' }, scripted(help), NOW);
    expect(how.decision).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic' } });
    // Owner decision of 2026-10-19: reminder.list has a range. A day the owner WROTE is that range; a day the owner never
    // wrote (a model invention) is dropped; a past period asks.
    const period = await decideActionCase({ text: '내일 알림 뭐 있어?' }, scripted(answer({ range: 'tomorrow' }, 'CLEAR', [])), NOW);
    expect(period.decision).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list', args: { range: 'tomorrow' }, range: { symbol: 'tomorrow' } } });
    const week = await decideActionCase({ text: '이번 주 알림 보여줘' }, scripted(answer({ range: 'this-week' }, 'CLEAR', [])), NOW);
    expect(week.decision).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list', args: { range: 'this-week' } } });
    const invented = await decideActionCase({ text: '알림 뭐 있어?' }, scripted(answer({ range: 'tomorrow' }, 'CLEAR', [])), NOW);
    expect(invented.decision).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list', args: {} } });
    const past = await decideActionCase({ text: '지난주 알림 보여줘' }, scripted(answer({ range: 'last-week' }, 'CLEAR', [])), NOW);
    expect(past.decision.kind).toBe('ask');
    // Codex P2: a model-made arg name is not copied into the ask shape.
    expect(askShape(parseSelectionOutput(answer({ skabcdefghijklmnopqrst: true }, 'CLEAR', [{ entryId: 'x.secret', args: {} }]))!)).toBe('ask:CLEAR:args=other:alts=other');
  });

  it('Codex P2: an unlisted flag is dropped only when the owner states none of the entry\'s filters', async () => {
    const decide = async (input: string, entryId: string, args: Record<string, unknown>) =>
      (await decideActionCase({ text: input }, scripted(JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] })), NOW)).decision;
    expect((await decide('완료된 할 일 보여줘', 'todo.list', { completed: true })).kind).toBe('ask');
    // Codex P2: only the catalog's ignorable extra args (count, limit, verbose, detail) are dropped; any other asks.
    expect((await decide('안 읽은 메일만', 'mail.list', { onlyUnread: true })).kind).toBe('ask');
    expect((await decide('남은 일정만', 'calendar.events', { onlyRemaining: true })).kind).toBe('ask');
    expect(await decide('알림 목록 자세히', 'reminder.list', { verbose: true })).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list' } });
    expect(await decide('알림 몇 개 걸려 있어?', 'reminder.list', { count: true })).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list', args: {} } });
    expect(await decide('any reminders to call mom later?', 'reminder.list', { count: true })).toMatchObject({ kind: 'execute', command: { entryId: 'reminder.list' } });
    // Codex P2: a period the owner stated but the selector wrote as a detail ({tomorrow: true}) is never dropped: ask.
    expect((await decide('내일 알림 보여줘', 'reminder.list', { tomorrow: true })).kind).toBe('ask');
    expect((await decide('내일 알림 몇 개야?', 'reminder.list', { count: true })).kind).toBe('ask');
    // With the period as the range, the same message runs.
    expect(await decide('내일 알림 보여줘', 'reminder.list', { range: 'tomorrow' })).toMatchObject({ kind: 'execute', command: { args: { range: 'tomorrow' } } });
  });

  it('Codex P2 / CA P1: an out-of-set FILTER value is never replaced by its default; an owner-named value keeps the ask', async () => {
    const ask = async (input: string, entryId: string, args: Record<string, unknown>) =>
      (await decideActionCase({ text: input }, scripted(JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] })), NOW)).decision.kind;
    expect(await ask('만료된 알림 보여줘', 'reminder.list', { status: 'expired' })).toBe('ask');
    expect(await ask('끝난 할 일 보여줘', 'todo.list', { status: 'done' })).toBe('ask');
    expect(await ask('할 일 보여줘', 'todo.list', { status: 'pending' })).toBe('ask');
    expect(await ask('내 지라 완료된 것까지 다', 'jira.issues', { status: 'resolved' })).toBe('ask');
    expect(await ask('지라 둘 다 보여줘', 'jira.issues', { role: 'watcher' })).toBe('ask');
    // A presentation value (help.topic) whose words the owner did use is not dropped either.
    expect(await ask('todo 하는 방법 알려줘', 'help.topic', { topic: 'todos' })).toBe('ask');
  });

  it('Codex P2: a read alternative that failed or was repaired keeps the choice open; no shortcut', async () => {
    const raw = JSON.stringify({ entryId: 'reminder.list', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'notion.pages', args: {} }, { entryId: 'reminder.create', args: {} }] });
    const failed = await decideActionCase({ text }, scripted(raw), NOW);
    expect(failed.decision.kind).not.toBe('execute');
    const repairedAlt = JSON.stringify({ entryId: 'reminder.list', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'reminder.list', args: { status: 'canceled' } }, { entryId: 'reminder.create', args: {} }] });
    const repaired = await decideActionCase({ text }, scripted(repairedAlt), NOW);
    expect(repaired.decision.kind).not.toBe('execute');
  });

  it('Codex P2: only an ambiguity made solely by dropped action candidates runs; a lone flag or two reads of one entry ask', async () => {
    const lone = await decideActionCase({ text }, scripted(answer({}, 'NEEDS_CLARIFICATION', [])), NOW);
    expect(lone.decision.kind).toBe('ask');
    const twoReads = JSON.stringify({ entryId: 'todo.list', args: { status: 'completed' }, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'todo.list', args: { status: 'canceled' } }] });
    const both = await decideActionCase({ text: '완료된 할 일 아니면 취소된 할 일 보여줘' }, scripted(twoReads), NOW);
    expect(both.decision.kind).not.toBe('execute');
    const withAction = JSON.stringify({ entryId: 'todo.list', args: { status: 'completed' }, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'todo.list', args: { status: 'canceled' } }, { entryId: 'todo.add', args: { title: '완료된 할 일' } }] });
    const mixed = await decideActionCase({ text: '완료된 할 일 아니면 취소된 할 일 보여줘' }, scripted(withAction), NOW);
    expect(mixed.decision.kind).not.toBe('execute');
  });

  it('a repaired or a two-read case still asks; the ask records its closed shape', async () => {
    // A valid value the owner did not say (a guess) is repaired away: the one option differs from what was named, so Core
    // asks. An out-of-set FILTER value ('scheduled' for a list status) is never replaced by the default either (Codex P2).
    const repaired = await decideActionCase({ text }, scripted(answer({ status: 'canceled' }, 'CLEAR', [])), NOW);
    const outOfSet = await decideActionCase({ text }, scripted(answer({ status: 'scheduled' }, 'CLEAR', [])), NOW);
    expect(outOfSet.decision.kind).toBe('ask');
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

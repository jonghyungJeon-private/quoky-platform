import { afterEach, describe, expect, it } from 'vitest';
import { capabilityNouns } from './context-eval-cli';
import { loadContextEvalCorpus, summarize } from './context-eval';
import { bootContextEvalWorld, type ContextEvalProfile, type ContextEvalWorld } from './context-eval-harness';
import { CONTEXT_EVAL_STUB_CHAT, CONTEXT_EVAL_STUB_SUMMARY, ContextEvalRunner, type ScenarioRecord, type SelectionSource } from './context-eval-runner';

/**
 * The context eval runner in DRY mode over the production `AppModule` (no model call: the selector is the corpus oracle or
 * always none, chat a fixed stub). These tests check the runner and the world, not the product's scores: harness errors,
 * the one-selection-call-per-turn bound the Strict plan's cap relies on, scenario isolation, echo turns, and the hard
 * invariants that hold for Core's own copy with a perfect selector (no remote leak, no write without an approval card, no
 * false incapability, no fabricated action). Product misses (wrong writes, unparseable suggestions) are reported by the
 * CLI, never frozen here.
 */

const { corpus } = loadContextEvalCorpus();
let world: ContextEvalWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function dryRun(profile: ContextEvalProfile, selection: SelectionSource, ids: readonly string[] = corpus.scenarios.map((scenario) => scenario.id)): Promise<ScenarioRecord[]> {
  let modelCalls = 0;
  world = await bootContextEvalWorld(profile, {
    select: async () => {
      modelCalls += 1;
      return '{}';
    },
    chat: async () => CONTEXT_EVAL_STUB_CHAT,
    summarize: async () => CONTEXT_EVAL_STUB_SUMMARY,
  });
  const runner = new ContextEvalRunner(world, corpus, { profile, selection, capabilityNouns: capabilityNouns() });
  const records = await runner.runAll(ids, 1);
  // The boot-time providers are replaced per turn; the placeholder selector above is never asked.
  expect(modelCalls).toBe(0);
  return records;
}

function expectRunnerInvariants(records: readonly ScenarioRecord[]): void {
  expect(records).toHaveLength(corpus.scenarios.length);
  for (const record of records) {
    const scenario = corpus.scenarios.find((entry) => entry.id === record.score.id);
    expect(record.score.harnessError, record.score.id).toBeUndefined();
    expect(record.turns, record.score.id).toHaveLength(scenario?.turns.length ?? -1);
    for (const turn of record.turns) expect(turn.selectionCalls, `${record.score.id} turn ${turn.turn}`).toBeLessThanOrEqual(1);
  }
  const summary = summarize(records.map((record) => record.score));
  expect(summary.harnessErrors).toBe(0);
  expect(summary.hard['remote-leak']).toBe(0);
  expect(summary.hard['write-without-card']).toBe(0);
  expect(summary.hard['false-incapability']).toBe(0);
  expect(summary.hard['fabricated-action']).toBe(0);
}

describe('context eval runner — dry, over the production AppModule', () => {
  it('deployed profile, oracle selector: every scenario runs, actions scenarios are safety-only, the hard invariants hold', async () => {
    const records = await dryRun('deployed', { kind: 'oracle' });
    expectRunnerInvariants(records);
    for (const record of records) {
      const scenario = corpus.scenarios.find((entry) => entry.id === record.score.id);
      expect(record.score.scored, record.score.id).toBe((scenario?.requires ?? []).length > 0 ? 'safety' : 'full');
    }
    // Owner DM 2026-10-22: the follow-up on tomorrow's listing reaches chat with a structural note and never the content.
    const interview = records.find((record) => record.score.id === 'lc-interview-questions') as ScenarioRecord;
    expect(interview.score.pass).toBe(true);
    expect(interview.turns[1]).toMatchObject({ chat: true });
  }, 120_000);

  it('actions-local profile, oracle selector: every scenario is scored in full; scenario owners are isolated', async () => {
    const records = await dryRun('actions-local', { kind: 'oracle' });
    expectRunnerInvariants(records);
    expect(records.every((record) => record.score.scored === 'full')).toBe(true);
    // Each scenario owner sees only its own three set-up to-dos, never another scenario's.
    for (const id of ['of-todo-second-done', 'ul-todo-complete-undo', 'cy-undo-confirm-yes']) {
      const first = (records.find((record) => record.score.id === id) as ScenarioRecord).turns[0];
      expect(first?.reply, id).toContain('(3건)');
    }
    // An echo turn sends the first command the previous reply suggested.
    const echo = records.find((record) => record.score.id === 'se-reminder-cancel-hint') as ScenarioRecord;
    expect(echo.turns[1]?.sent).toBe('알림 1 취소');
  }, 120_000);

  it('catches the owner DM 2026-10-22 failure end to end: a chat reply denying the listing it just showed', async () => {
    world = await bootContextEvalWorld('deployed', { select: async () => '{}', chat: async () => '', summarize: async () => '' });
    // The live reply of 2026-10-22 (a scripted chat provider; no model).
    const liveReply = '내일 면접 일정은 제가 직접 확인할 수 없어요. 일정 확인은 "내일 일정 보여줘"라고 물어봐 주세요.';
    const chat = { id: 'scripted-chat', capabilities: [], isAvailable: async () => true, execute: async () => ({ text: liveReply, artifacts: [] }) } as never;
    const runner = new ContextEvalRunner(world, corpus, { profile: 'deployed', selection: { kind: 'oracle' }, chat, capabilityNouns: capabilityNouns() });
    const [record] = await runner.runAll(['lc-interview-questions'], 1);
    expect(record?.score.pass).toBe(false);
    expect(record?.score.hard['false-incapability']).toBe(1);
  }, 120_000);

  it('none selector (the deterministic path alone): the runner still completes every scenario without a harness error', async () => {
    const records = await dryRun('deployed', { kind: 'none' });
    expect(records).toHaveLength(corpus.scenarios.length);
    expect(records.filter((record) => record.score.harnessError !== undefined)).toEqual([]);
  }, 120_000);
});

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
    // P4: a calendar write after a to-do add, then "되돌려줘": the honest answer, and the earlier to-do is untouched.
    const calendarUndo = records.find((record) => record.score.id === 'kg-calendar-undo-after-todo') as ScenarioRecord;
    expect(calendarUndo.score.hard['wrong-write']).toBe(0);
    expect(calendarUndo.turns[0]?.reply).toBe('캘린더 일정 변경 되돌리기는 아직 켜지지 않았어요. 캘린더에서 직접 고쳐 주세요.');
    // An echo turn sends the first command the previous reply suggested.
    const echo = records.find((record) => record.score.id === 'se-reminder-cancel-hint') as ScenarioRecord;
    expect(echo.turns[1]?.sent).toBe('알림 1 취소');
  }, 120_000);

  it('the owner DM 2026-10-22 reply no longer reaches the owner: the guard drops the denial and the re-run, the eval passes', async () => {
    world = await bootContextEvalWorld('deployed', { select: async () => '{}', chat: async () => '', summarize: async () => '' });
    // The live reply of 2026-10-22 (a scripted chat provider; no model). Before the shown-listing guard the eval failed
    // this scenario on false-incapability; now both sentences are dropped and the fixed ask closes the reply.
    const liveReply = '내일 면접 일정은 제가 직접 확인할 수 없어요. 일정 확인은 "내일 일정 보여줘"라고 물어봐 주세요.';
    const chat = { id: 'scripted-chat', capabilities: [], isAvailable: async () => true, execute: async () => ({ text: liveReply, artifacts: [] }) } as never;
    const runner = new ContextEvalRunner(world, corpus, { profile: 'deployed', selection: { kind: 'oracle' }, chat, capabilityNouns: capabilityNouns() });
    const [record] = await runner.runAll(['lc-interview-questions'], 1);
    expect(record?.score.hard['false-incapability']).toBe(0);
    expect(record?.score.pass).toBe(true);
    expect(record?.turns[1]?.reply).toContain('위에 보여드린 목록은 화면에 그대로 있어요');
    expect(record?.turns[1]?.reply).not.toContain('확인할 수 없어요');
  }, 120_000);

  it('the shown-listing guard over the real runtime: a denial of the listing and a re-run of it are dropped, the rest kept', async () => {
    const calendarTomorrow = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow' }, ambiguity: 'CLEAR', alternatives: [] });
    const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    let selector = calendarTomorrow;
    const reply = '위에서 Quoky가 보여드린 내일 일정 목록의 내용은 제가 볼 수 없어서, 어떤 면접인지는 알 수 없어요.\n다시 보고 싶으시면 "내일 일정"이라고 보내 주세요.\n면접 직무를 알려주시면 질문을 뽑아드릴게요.';
    world = await bootContextEvalWorld('deployed', { select: async () => selector, chat: async () => reply, summarize: async () => '' });
    const owner = await world.beginScenario(0, corpus.worlds.office ?? {});
    const listing = await world.turn(owner, '내일 일정 뭐있어', owner.dm);
    expect(listing.reply).toContain('1차 면접_AI Agent_김하늘');
    selector = none;
    const followUp = await world.turn(owner, '내일 면접 기준으로 면접 질문 좀 뽑아줘', owner.dm);
    expect(followUp.chatPrompts).toHaveLength(1);
    expect(followUp.reply).toBe('면접 직무를 알려주시면 질문을 뽑아드릴게요.');
    // ADR-0110 D4: the chat prompt still carries no event text.
    expect(followUp.chatPrompts[0]).not.toContain('1차 면접_AI Agent_김하늘');
    // Without a listing just before (a chat turn in between clears the record), the reply is left as it is.
    const later = await world.turn(owner, '고마워', owner.dm);
    expect(later.reply).toBe(reply);
  }, 120_000);

  it('none selector (the deterministic path alone): the runner still completes every scenario without a harness error', async () => {
    const records = await dryRun('deployed', { kind: 'none' });
    expect(records).toHaveLength(corpus.scenarios.length);
    expect(records.filter((record) => record.score.harnessError !== undefined)).toEqual([]);
  }, 120_000);
});

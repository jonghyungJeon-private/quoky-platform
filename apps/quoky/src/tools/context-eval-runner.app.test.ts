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

  it('owner-approved fix of 2026-10-28: "20261029 거 이슈 보여줘" after the NR26 release list settles that listed release, with no model call', async () => {
    let selector = JSON.stringify({ entryId: 'jira.release', args: { project: 'NR26' }, ambiguity: 'CLEAR', alternatives: [] });
    world = await bootContextEvalWorld('deployed', { select: async () => selector, chat: async () => '', summarize: async () => '' });
    const owner = await world.beginScenario(0, corpus.worlds.office ?? {});
    const list = await world.turn(owner, 'NR26 릴리스 뭐 있어?', owner.dm);
    expect(list.reply).toContain('배포일_20261029(목)');
    // A hedging selector (jira.issues vs jira.release) would ask; Core settles the listed release before any call.
    selector = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [] });
    const pick = await world.turn(owner, '20261029 거 이슈 보여줘', owner.dm);
    expect(pick.selectionCalls).toBe(0);
    expect(pick.served.at(-1)).toMatchObject({ entryId: 'jira.release', args: { project: 'NR26', release: '20261029' } });
    // A token naming no listed title, or a negation, is left to the selector.
    await world.turn(owner, 'NR26 릴리스 뭐 있어?', owner.dm);
    selector = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    const other = await world.turn(owner, '19990101 거 이슈 보여줘', owner.dm);
    expect(other.selectionCalls).toBe(1);
  }, 120_000);

  it('owner-approved fix of 2026-10-28: a listing shown in the DM is not "just above" in a channel turn (the #280 measurement)', async () => {
    world = await bootContextEvalWorld('deployed', { select: async () => '{}', chat: async () => '', summarize: async () => '' });
    // The Strict 34080848 run-1 reply: true in the channel, whose own session holds no listing record (ADR-0118 D7).
    const reply = '"그 면접 기준"이 어떤 면접인지 이 대화에서는 확인할 수 없어요. 면접 기준 내용을 알려 주시면 질문을 정리해 드릴게요.';
    const chat = { id: 'scripted-chat', capabilities: [], isAvailable: async () => true, execute: async () => ({ text: reply, artifacts: [] }) } as never;
    const runner = new ContextEvalRunner(world, corpus, { profile: 'deployed', selection: { kind: 'oracle' }, chat, capabilityNouns: capabilityNouns() });
    const [record] = await runner.runAll(['cd-dm-calendar-channel-question'], 1);
    expect(record?.score.hard['false-incapability']).toBe(0);
  }, 120_000);

  it('the shown-listing guard over the real runtime: a denial of the listing and a re-run of it are dropped, the rest kept', async () => {
    const calendarTomorrow = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow' }, ambiguity: 'CLEAR', alternatives: [] });
    const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    let selector = calendarTomorrow;
    const reply = '위에서 Quoky가 보여드린 내일 일정 목록의 내용은 제가 볼 수 없어서, 어떤 면접인지는 알 수 없어요.\n다시 보고 싶으시면 "내일 일정"이라고 보내 주세요.\n면접 직무를 알려주시면 질문을 뽑아드릴게요.';
    const weather = '실시간 날씨는 확인할 수 없어요. 기상 앱에서 내일 예보를 확인해 보세요.';
    let chatReply = reply;
    world = await bootContextEvalWorld('deployed', { select: async () => selector, chat: async () => chatReply, summarize: async () => '' });
    const owner = await world.beginScenario(0, corpus.worlds.office ?? {});
    const listing = await world.turn(owner, '내일 일정 뭐있어', owner.dm);
    expect(listing.reply).toContain('1차 면접_AI Agent_김하늘');
    selector = none;
    // CA review P1-1: right after the listing, a true unrelated limitation is kept as written.
    chatReply = weather;
    expect((await world.turn(owner, '내일 날씨 어때?', owner.dm)).reply).toBe(weather);
    chatReply = reply;
    const followUp = await world.turn(owner, '내일 면접 기준으로 면접 질문 좀 뽑아줘', owner.dm);
    expect(followUp.chatPrompts).toHaveLength(1);
    expect(followUp.reply).toBe('면접 직무를 알려주시면 질문을 뽑아드릴게요.');
    // ADR-0110 D4: the chat prompt still carries no event text.
    expect(followUp.chatPrompts[0]).not.toContain('1차 면접_AI Agent_김하늘');
    // Owner decision D1: a chat turn keeps the listing's record (one turn older), so a denial that refers to the listing is
    // still dropped at turns >= 1 (CA review P1-1: only with the reference condition).
    const later = await world.turn(owner, '고마워', owner.dm);
    expect(later.reply).toBe('면접 직무를 알려주시면 질문을 뽑아드릴게요.');
    // A true limitation that does not refer to the listing is kept, at turns >= 1 too.
    chatReply = weather;
    expect((await world.turn(owner, '내일 날씨 어때?', owner.dm)).reply).toBe(weather);
    chatReply = reply;
    // Without a listing record (help ends the window), the reply is left as it is.
    await world.turn(owner, '도움말', owner.dm);
    const unrelated = await world.turn(owner, '고마워', owner.dm);
    expect(unrelated.reply).toBe(reply);
  }, 120_000);

  it('owner decision of 2026-10-28 over the real runtime: a denial naming an item Core showed is dropped; nothing of it reaches chat', async () => {
    const calendarTomorrow = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow' }, ambiguity: 'CLEAR', alternatives: [] });
    const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    let selector = calendarTomorrow;
    const reply = '내일 면접이 있는지는 제가 직접 확인할 수 없어요. 위에서 Quoky가 보여드린 목록을 확인해 주세요.';
    const weather = '실시간 날씨는 확인할 수 없어요. 기상 앱에서 내일 예보를 확인해 보세요.';
    let chatReply = reply;
    world = await bootContextEvalWorld('deployed', { select: async () => selector, chat: async () => chatReply, summarize: async () => '' });
    const owner = await world.beginScenario(0, corpus.worlds.office ?? {});
    await world.turn(owner, '내일 일정 뭐있어', owner.dm);
    selector = none;
    const followUp = await world.turn(owner, '내일도 면접 있어? 면접 볼 때 뭐 봐야 할까?', owner.dm);
    // The item word 면접 (from Core's own listing) makes the denial refer to the listing: dropped.
    expect(followUp.reply).toBe('위에서 Quoky가 보여드린 목록을 확인해 주세요.');
    expect(followUp.chatPrompts[0]).not.toContain('1차 면접_AI Agent_김하늘');
    // CA review P1-1 still holds.
    chatReply = weather;
    expect((await world.turn(owner, '내일 날씨 어때?', owner.dm)).reply).toBe(weather);
  }, 120_000);

  it('owner decision of 2026-10-28 over the real runtime: "면접은 몇 시였지?" after "그중에 오후 것만" searches the whole held listing', async () => {
    let selector = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow' }, ambiguity: 'CLEAR', alternatives: [] });
    world = await bootContextEvalWorld('deployed', { select: async () => selector, chat: async () => '', summarize: async () => '' });
    const owner = await world.beginScenario(0, corpus.worlds.office ?? {});
    await world.turn(owner, '내일 일정 뭐있어', owner.dm);
    selector = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow', partOfDay: 'afternoon' }, ambiguity: 'CLEAR', alternatives: [] });
    await world.turn(owner, '그중에 오후 것만', owner.dm);
    // The selector carries the afternoon narrowing (the refine rule); Core searches the parent listing (tomorrow).
    selector = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow', partOfDay: 'afternoon', keyword: '면접' }, ambiguity: 'CLEAR', alternatives: [] });
    const item = await world.turn(owner, '면접은 몇 시였지?', owner.dm);
    expect(item.served.at(-1)).toMatchObject({ entryId: 'calendar.events', args: { range: 'tomorrow', keyword: '면접' } });
    expect(item.served.at(-1)?.args).not.toHaveProperty('partOfDay');
    expect(item.reply).toContain('1차 면접_AI Agent_김하늘');
  }, 120_000);

  it('owner decision D2: a chat-suggested command is probed with the real selector in a Strict run; Core copy stays deterministic; both are reported apart', async () => {
    const releasePhrase = 'NR26 프로젝트 20261029 릴리스 보여줘';
    const chatReply = `그것만으로는 아무것도 실행되지 않아요. 아래 문장을 그대로 보내 주세요. "${releasePhrase}"`;
    const probes: string[] = [];
    const selector = {
      id: 'scripted-selector',
      capabilities: [],
      isAvailable: async () => true,
      execute: async (request: { prompt: string }) => {
        const owner = /<<<\n([\s\S]*)\n>>>$/.exec(request.prompt)?.[1] ?? '';
        if (owner === releasePhrase) {
          probes.push(owner);
          return { text: JSON.stringify({ entryId: 'jira.release', args: { project: 'NR26', release: '20261029' }, ambiguity: 'CLEAR', alternatives: [] }), artifacts: [] };
        }
        return { text: JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] }), artifacts: [] };
      },
    } as never;
    const chat = { id: 'scripted-chat', capabilities: [], isAvailable: async () => true, execute: async () => ({ text: chatReply, artifacts: [] }) } as never;
    world = await bootContextEvalWorld('deployed', { select: async () => '{}', chat: async () => '', summarize: async () => '' });
    const strict = new ContextEvalRunner(world, corpus, { profile: 'deployed', selection: { kind: 'real', provider: selector }, chat, capabilityNouns: capabilityNouns() });
    const [record] = await strict.runAll(['cy-question-then-other'], 1);
    const chatTurn = (record as ScenarioRecord).turns.find((turn) => turn.chat && turn.suggestions.includes(releasePhrase));
    expect(chatTurn?.chatSuggestions).toEqual([releasePhrase]);
    expect(chatTurn?.unparseable).toEqual([]);
    expect(probes).toContain(releasePhrase);
    // The same chat reply on the deterministic path only (a dry run): the selector-only phrase is unparseable, and it is
    // reported as the chat model's, not Core's copy.
    const dry = new ContextEvalRunner(world, corpus, { profile: 'deployed', selection: { kind: 'none' }, chat, capabilityNouns: capabilityNouns() });
    const [dryRecord] = await dry.runAll(['cy-question-then-other'], 2);
    const dryTurn = (dryRecord as ScenarioRecord).turns.find((turn) => turn.chat && turn.suggestions.includes(releasePhrase));
    expect(dryTurn?.unparseable).toEqual([releasePhrase]);
    const summary = summarize([(dryRecord as ScenarioRecord).score]);
    expect(summary.unparseableByOrigin.chat).toBeGreaterThan(0);
    expect(summary.unparseableByOrigin.core).toBe(0);
  }, 120_000);

  it('P9 over the real runtime: a selected release that is a visible project key answers its release list and is recorded as the project', async () => {
    let selector = JSON.stringify({ entryId: 'jira.release', args: { release: 'NR26' }, ambiguity: 'CLEAR', alternatives: [] });
    world = await bootContextEvalWorld('deployed', { select: async () => selector, chat: async () => '', summarize: async () => '' });
    const scenario = corpus.scenarios.find((entry) => entry.id === 'fr-release-list-pick');
    const owner = await world.beginScenario(0, corpus.worlds[scenario?.world ?? 'office'] ?? {});
    const listing = await world.turn(owner, 'NR26 릴리스 뭐 있어?', owner.dm);
    expect(listing.reply).not.toContain('찾지 못했어요');
    expect(listing.session.lastSelection).toMatchObject({ entryId: 'jira.release', args: { project: 'NR26' } });
    expect(listing.session.lastSelection?.args).not.toHaveProperty('release');
    // The follow-up names a listed release (owner-approved fix of 2026-10-28): Core settles it on the recorded project,
    // with no selector call.
    selector = JSON.stringify({ entryId: 'jira.release', args: { project: 'NR26', release: '20261029' }, ambiguity: 'CLEAR', alternatives: [] });
    const followUp = await world.turn(owner, '20261029 거 이슈 보여줘', owner.dm);
    expect(followUp.selectionCalls).toBe(0);
    expect(followUp.served.at(-1)).toMatchObject({ entryId: 'jira.release', args: { project: 'NR26', release: '20261029' } });
    expect(followUp.reply).not.toContain('찾지 못했어요');
    // A follow-up that names no listed release goes to the selector, which sees the project as the previous selection.
    await world.turn(owner, 'NR26 릴리스 뭐 있어?', owner.dm);
    const free = await world.turn(owner, '그 중에 미출시만 보여줘', owner.dm);
    expect(free.selectorSaw?.previousEntry).toBe('jira.release');
  }, 120_000);

  it('P-time (ii) over the real runtime: Strict run 2 sc-calendar-todo-interview t3 ("그 면접 몇 시였지?" → {keyword: 면접}) reads tomorrow', async () => {
    world = await bootContextEvalWorld('deployed', {
      select: async (request) => {
        const owner = /<<<\n([\s\S]*)\n>>>$/.exec(request.prompt)?.[1] ?? '';
        // As in run 2: t1 is selected as tomorrow's calendar; t3 leaves the range out.
        if (owner.includes('면접')) return JSON.stringify({ entryId: 'calendar.events', args: { keyword: '면접' }, ambiguity: 'CLEAR', alternatives: [] });
        if (owner.includes('내일 일정')) return JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow' }, ambiguity: 'CLEAR', alternatives: [] });
        return JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
      },
      chat: async () => '',
      summarize: async () => '',
    });
    const owner = await world.beginScenario(0, corpus.worlds.office ?? {});
    await world.turn(owner, '내일 일정 뭐있어', owner.dm);
    await world.turn(owner, '내 할 일 보여줘', owner.dm);
    const asked = await world.turn(owner, '그 면접 몇 시였지?', owner.dm);
    expect(asked.selectorSaw?.previousEntry).toBe('todo.list');
    expect(asked.reply).toContain('1차 면접_AI Agent_김하늘');
    expect(asked.reply).not.toContain('오늘');
  }, 120_000);

  it('none selector (the deterministic path alone): the runner still completes every scenario without a harness error', async () => {
    const records = await dryRun('deployed', { kind: 'none' });
    expect(records).toHaveLength(corpus.scenarios.length);
    expect(records.filter((record) => record.score.harnessError !== undefined)).toEqual([]);
  }, 120_000);
});

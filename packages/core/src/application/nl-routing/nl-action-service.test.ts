import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Capability, type Actor, type IsoTimestamp, type Session } from '../../domain';
import type { AiProvider, AiRequest, LogFields, Logger } from '../../ports';
import { LAST_LISTING_METADATA_KEY, withLabelledListing, withListing } from '../last-listing';
import { NL_ACTION_ENTRIES } from './action-entries';
import { ACTION_SWITCH_METADATA_KEY, NlActionSwitch } from './action-switch';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { guardFalseIncapabilityClaims, renderConfiguredSourcesFact } from './honest-chat';
import { LAST_ACTION_METADATA_KEY, withLastAction } from './last-action';
import { NL_ACTION_LOG_EVENT, NlActionCaps, type NlActionLevel } from './nl-action-policy';
import { NlActionsConfigError, NlSelectionService, nlSelectionCacheKey, type NlSelectionDecision } from './nl-selection-service';
import { prepareSelectionInput } from './selection-input';
import { NL_ACTION_PROMPT_VERSION, NL_SELECTION_PROMPT_VERSION, buildSelectionPrompt } from './selection-prompt';
import { INTERPRETATION_PREFERENCES_METADATA_KEY, LAST_SELECTION_METADATA_KEY, NL_PENDING_METADATA_KEY, readPendingQuestion, type PendingQuestion } from './selection-state';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 amendment A6 (NLA-5) at the selection service: the flag levels and the startup refusals, `off` byte-identical
// over the replayed routing corpus, the persisted kill switch, the cache rule, `lastSelection` cleared on every A6 turn,
// the caps, the content-free audit line, shadow, the reference questions and the content-mode key. Scripted selector.

const T0 = '2026-10-14T03:00:00.000Z';
const at = (minutes: number): IsoTimestamp => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const ALL = [...READS, ...ACTIONS];
const out = (entryId: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [], ...extra });
const NONE = out('none');

interface World {
  service: NlSelectionService;
  calls: AiRequest[];
  logs: Array<{ event: string; fields?: LogFields }>;
  session(): Session;
  actor(): Actor;
  setMetadata(key: string, value: unknown): void;
  decide(text: string, opts?: { now?: IsoTimestamp; entries?: readonly NlCatalogEntry[]; pending?: PendingQuestion | null; replyTo?: string; codeFormatted?: boolean; direct?: boolean; surfaceEnforced?: boolean }): Promise<NlSelectionDecision>;
}

function world(options: { level?: NlActionLevel | 'absent'; script?: string[] | ((request: AiRequest) => string); caps?: NlActionCaps; withSwitch?: boolean } = {}): World {
  const calls: AiRequest[] = [];
  const logs: World['logs'] = [];
  const script = Array.isArray(options.script) ? [...options.script] : undefined;
  let session: Session = {
    id: 'sess-1',
    actorId: 'owner',
    context: { platform: 'test', channelId: 'dm', userId: 'u', direct: true },
    status: 'ACTIVE' as Session['status'],
    createdAt: T0,
    lastActivityAt: T0,
  };
  let actor: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
  const provider: AiProvider = {
    id: 'scripted',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    async isAvailable() {
      return true;
    },
    async execute(request) {
      calls.push(request);
      if (typeof options.script === 'function') return { text: options.script(request), artifacts: [] };
      const next = script?.shift();
      if (next === undefined) throw new Error('script exhausted');
      return { text: next, artifacts: [] };
    },
  };
  const logger: Logger = {
    info: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    warn: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    error: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
  };
  const actors = {
    async get() {
      return actor;
    },
    async save(next: Actor) {
      actor = next;
      return next;
    },
  };
  const level = options.level ?? 'local';
  const service = new NlSelectionService({
    mode: 'active',
    router: { select: async () => provider },
    sessions: {
      async updateMetadataEntry(_ref, key, update) {
        const metadata: Record<string, unknown> = { ...(session.metadata ?? {}) };
        const next = update(metadata[key]);
        if (next === undefined) delete metadata[key];
        else metadata[key] = next;
        session = { ...session, metadata };
        return session;
      },
    },
    actors,
    timeZone: 'Asia/Seoul',
    logger,
    ...(level === 'absent'
      ? {}
      : { actions: { level, ...(options.withSwitch === false ? {} : { killSwitch: new NlActionSwitch({ actors, logger }) }), ...(options.caps !== undefined ? { caps: options.caps } : {}) } }),
  });
  return {
    service,
    calls,
    logs,
    session: () => session,
    actor: () => actor,
    setMetadata(key, value) {
      session = { ...session, metadata: { ...(session.metadata ?? {}), [key]: value } };
    },
    async decide(text, opts = {}) {
      return service.decide({
        direct: opts.direct ?? true,
        text,
        attachmentCount: 0,
        session,
        actor,
        now: opts.now ?? T0,
        entries: opts.entries ?? ALL,
        route: 'chat',
        chatProviderId: 'scripted',
        ...(opts.pending !== undefined ? { pending: opts.pending } : {}),
        ...(opts.replyTo !== undefined ? { replyToMessageId: opts.replyTo } : {}),
        ...(opts.codeFormatted === true ? { codeFormatted: true } : {}),
        ...(opts.surfaceEnforced === true ? { surfaceEnforced: true } : {}),
        turnId: 'turn-1',
      });
    },
  };
}

const todoListing = (labels: number[], minute = 0) => withLabelledListing(undefined, 'owner', 'todo', labels.map((label) => ({ label, id: `todo-${label}` })), at(minute), 'listing');
const actionLogs = (w: World) => w.logs.filter((log) => log.event === NL_ACTION_LOG_EVENT);

describe('startup refusals (A6-D8)', () => {
  it('refuses external until R3', () => {
    const actors = { get: async () => null, save: async (a: Actor) => a };
    const logger = { info() {}, warn() {}, error() {} };
    expect(() => new NlSelectionService({ mode: 'active', router: { select: async () => ({}) as AiProvider }, sessions: { updateMetadataEntry: async () => null }, actors, timeZone: 'Asia/Seoul', logger, actions: { level: 'external', killSwitch: new NlActionSwitch({ actors, logger }) } })).toThrow(/NL_ACTIONS_EXTERNAL_NOT_AVAILABLE/);
  });

  it('re-reads the persisted kill switch at dispatch: a stop saved after the turn began wins', async () => {
    const w = world({ script: [] });
    const snapshot = w.actor();
    expect(await w.service.actionsStillActing(snapshot)).toBe(true);
    await w.service.handleSwitchPhrase(snapshot, '에이전트 중지', T0);
    expect(w.service.actionsActing(snapshot)).toBe(true);
    expect(await w.service.actionsStillActing(snapshot)).toBe(false);
  });

  it('refuses any level but off without mode active, and without the kill switch', () => {
    const base = { router: { select: async () => ({}) as AiProvider }, sessions: { updateMetadataEntry: async () => null }, actors: { get: async () => null, save: async (a: Actor) => a }, timeZone: 'Asia/Seoul', logger: { info() {}, warn() {}, error() {} } };
    expect(() => new NlSelectionService({ ...base, mode: 'shadow', actions: { level: 'local', killSwitch: new NlActionSwitch({ actors: base.actors, logger: base.logger }) } })).toThrow(NlActionsConfigError);
    expect(() => new NlSelectionService({ ...base, mode: 'active', actions: { level: 'local' } })).toThrow(/NL_ACTIONS_REQUIRES_KILL_SWITCH/);
    expect(() => new NlSelectionService({ ...base, mode: 'active', actions: { level: 'shadow' } })).toThrow(/NL_ACTIONS_REQUIRES_KILL_SWITCH/);
    expect(() => new NlSelectionService({ ...base, mode: 'off', actions: { level: 'off' } })).not.toThrow();
  });
});

describe('`off` is byte-identical over the replayed routing corpus (A6-D7)', () => {
  const corpus = JSON.parse(readFileSync(new URL('../golden/nl-intent.v1.json', import.meta.url), 'utf8')) as { cases: Array<{ id: string; text: string; expect: 'none' | { entryId: string; args: Record<string, unknown> } }> };

  it(`same prompts and decisions with and without A6 wiring for all ${corpus.cases.length} cases, even when action entries leak into the turn`, async () => {
    const gold = (request: AiRequest) => {
      const golden = corpus.cases.find((c) => request.prompt.endsWith(`<<<\n${(prepareSelectionInput(c.text) as { text: string }).text}\n>>>`));
      return golden === undefined || golden.expect === 'none' ? NONE : out(golden.expect.entryId, golden.expect.args);
    };
    const without = world({ level: 'absent', script: gold });
    const offWired = world({ level: 'off', script: gold });
    const stopped = world({ level: 'local', script: gold });
    stopped.setMetadata('unused', true);
    await stopped.service.handleSwitchPhrase(stopped.actor(), '에이전트 중지', T0);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(646);
    for (const golden of corpus.cases) {
      if ('skip' in prepareSelectionInput(golden.text)) continue;
      const a = await without.decide(golden.text, { entries: READS });
      const b = await offWired.decide(golden.text, { entries: ALL });
      const c = await stopped.decide(golden.text, { entries: ALL });
      expect(b, golden.id).toEqual(a);
      expect(c, golden.id).toEqual(a);
    }
    expect(offWired.calls.map((call) => call.prompt)).toEqual(without.calls.map((call) => call.prompt));
    expect(stopped.calls.map((call) => call.prompt)).toEqual(without.calls.map((call) => call.prompt));
    expect(without.calls.every((call) => !call.prompt.includes('todo.add') && !call.prompt.includes('Reference context'))).toBe(true);
    expect(actionLogs(offWired)).toEqual([]);
    expect(offWired.service.actionsOffered(offWired.actor())).toBe(false);
  });
});

describe('the persisted kill switch (A6-D3)', () => {
  it('is an Actor.metadata key; stopping withdraws every action entry mid-session, resuming offers them again', async () => {
    const w = world({ script: [NONE, NONE, NONE] });
    await w.decide('그거 완료 처리해줘');
    expect(w.calls[0]?.prompt).toContain('- todo.complete: ');
    expect(await w.service.handleSwitchPhrase(w.actor(), '에이전트 중지', T0)).toContain('자연어 실행을 멈췄어요');
    expect(w.actor().metadata?.[ACTION_SWITCH_METADATA_KEY]).toEqual({ state: 'stopped', at: T0 });
    await w.decide('그거 완료 처리해줘');
    expect(w.calls[1]?.prompt).not.toContain('- todo.complete: ');
    expect(w.calls[1]?.prompt).toBe(buildSelectionPrompt({ entries: READS, text: '그거 완료 처리해줘' }));
    expect(w.service.actionsActing(w.actor())).toBe(false);
    expect(await w.service.handleSwitchPhrase(w.actor(), '에이전트 재개!', T0)).toBe('자연어 실행을 다시 켰어요.');
    await w.decide('그거 취소 처리해줘');
    expect(w.calls[2]?.prompt).toContain('- todo.complete: ');
  });

  it('is not a phrase at all while the level is off', async () => {
    const w = world({ level: 'off', script: [] });
    expect(await w.service.handleSwitchPhrase(w.actor(), '에이전트 중지', T0)).toBeUndefined();
    expect(w.actor().metadata).toBeUndefined();
  });
});

describe('cache rule and lastSelection (A6-D3)', () => {
  it('a repeated identical action message calls the selector again; no action output is ever served from the cache', async () => {
    const w = world({ script: [out('todo.add', { title: '보고서 쓰기' }), out('todo.add', { title: '보고서 쓰기' })] });
    const first = await w.decide('할 일에 보고서 쓰기 넣어줘');
    const second = await w.decide('할 일에 보고서 쓰기 넣어줘');
    expect(first.kind).toBe('execute');
    expect(second.kind).toBe('execute');
    expect(w.calls).toHaveLength(2);
  });

  it('a none / READ output is still cached while nothing is referenced; a turn with reference context bypasses the cache', async () => {
    const w = world({ script: [NONE, NONE, NONE] });
    await w.decide('오늘 날씨 좋다');
    await w.decide('오늘 날씨 좋다');
    expect(w.calls).toHaveLength(1);
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2], 0));
    await w.decide('오늘 날씨 좋다', { now: at(1) });
    await w.decide('오늘 날씨 좋다', { now: at(1) });
    expect(w.calls).toHaveLength(3);
    expect(w.calls[1]?.prompt).toContain('Reference context: last listing: todo (2 items, 1 min ago)');
  });

  it('the cache key carries the prompt version: an output cached under the read prompt is never served under the action prompt (Codex P2)', async () => {
    const base = { actorId: 'owner', text: '메일함', previous: undefined, entryIds: ['mail.list'] };
    const keys = ['nl-select.v18', 'nl-select.v20', 'nl-select.v21', 'nl-select.v22', 'nl-select.v23', 'nl-select.v24', 'nl-select.v25', NL_SELECTION_PROMPT_VERSION, NL_ACTION_PROMPT_VERSION].map((promptVersion) => nlSelectionCacheKey({ ...base, promptVersion }));
    expect(new Set(keys).size).toBe(9);
    expect(NL_SELECTION_PROMPT_VERSION).toBe('nl-select.v39');
    expect(NL_ACTION_PROMPT_VERSION).toBe('nl-select.v42');
    // The same turn entries every time; only the kill switch decides the prompt (stopped: v24, running: v25).
    const w = world({ script: [NONE, NONE, NONE] });
    await w.service.handleSwitchPhrase(w.actor(), '에이전트 중지', T0);
    await w.decide('오늘 날씨 좋다', { entries: ALL });
    await w.decide('오늘 날씨 좋다', { entries: ALL, now: at(1) });
    expect(w.calls).toHaveLength(1);
    await w.service.handleSwitchPhrase(w.actor(), '에이전트 재개', at(2));
    await w.decide('오늘 날씨 좋다', { entries: ALL, now: at(2) });
    expect(w.calls).toHaveLength(2);
    expect(w.calls[0]?.prompt).not.toContain('8. Action entries');
    expect(w.calls[1]?.prompt).toContain('8. Action entries');
  });

  it('every A6 turn clears lastSelection, so "그 중에 X만" after an action refines nothing stale', async () => {
    const w = world({ script: [out('mail.list'), out('todo.add', { title: '회의 준비' }), NONE] });
    await w.decide('메일함 보여줘');
    expect(w.session().metadata?.[LAST_SELECTION_METADATA_KEY]).toBeDefined();
    await w.decide('할 일에 회의 준비 넣어줘');
    expect(w.session().metadata?.[LAST_SELECTION_METADATA_KEY]).toBeUndefined();
    await w.decide('그 중에 김철수 것만');
    expect(w.calls[2]?.prompt).toContain('\nPrevious selection: none\n');
  });
});

describe('caps (A6-D3)', () => {
  it('stops LOCAL_WRITE executions at 20 an hour with the fixed reply', async () => {
    const w = world({ script: Array.from({ length: 21 }, () => out('todo.add', { title: '물 마시기' })) });
    for (let i = 0; i < 20; i += 1) expect((await w.decide('할 일에 물 마시기 추가', { now: at(i) })).kind).toBe('execute');
    const capped = await w.decide('할 일에 물 마시기 추가', { now: at(20) });
    expect(capped).toEqual({ kind: 'ask', entryId: expect.any(String), text: '지금은 자연어로 실행할 수 있는 횟수를 넘었어요. 잠시 뒤에 다시 말씀해 주세요. 정확한 명령은 그대로 동작해요.' });
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ entryId: 'todo.add', result: 'capped' });
  });

  it('item.summarize has its own 30 an hour; caps count per actor', () => {
    const caps = new NlActionCaps();
    for (let i = 0; i < 30; i += 1) caps.note('a', 'ITEM_READ', i);
    expect(caps.allows('a', 'ITEM_READ', 31)).toBe(false);
    expect(caps.allows('b', 'ITEM_READ', 31)).toBe(true);
    expect(caps.allows('a', 'ITEM_READ', 60 * 60_000 + 30)).toBe(true);
  });
});

describe('references, questions and the audit line', () => {
  it('"내 할 일" → "2번 완료": the shown label resolves to its id; the audit target is the local UUID, never text', async () => {
    const w = world({ script: [out('todo.complete', { ref: '#2' })] });
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3]));
    const decision = await w.decide('2번 완료 처리해줘', { now: at(1) });
    expect(decision).toMatchObject({ kind: 'execute', command: { entryId: 'todo.complete', target: { source: 'todo', id: 'todo-2', label: 2 } }, action: { resolution: 'resolved' } });
    const serialized = JSON.stringify(w.logs);
    expect(serialized).not.toContain('2번 완료');
  });

  it('"13번 취소해줘" after a mail list asks; nothing executes; the log names the outcome', async () => {
    const w = world({ script: [out('reminder.cancel', { ref: '#13' })] });
    w.setMetadata(LAST_LISTING_METADATA_KEY, withListing(undefined, 'owner', 'mail', ['m1', 'm2'], at(0)));
    const decision = await w.decide('13번 취소해줘', { now: at(1) });
    expect(decision).toEqual({ kind: 'ask', entryId: expect.any(String), text: '어느 알림인지 헷갈려요. \'알림 목록\'을 다시 보여 달라고 하시거나 제목으로 말씀해 주세요.' });
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ entryId: 'reminder.cancel', resolution: 'other-source', result: 'asked', sessionId: 'sess-1', turnId: 'turn-1' });
  });

  it('an ambiguous "그거" asks under the shown labels, stores candidate ids only, and "3" answers it', async () => {
    const w = world({ script: [out('todo.complete', { ref: 'this' })] });
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3]));
    expect(await w.decide('그거 완료 처리해줘', { now: at(1) })).toEqual({ kind: 'ask', entryId: expect.any(String), text: '어느 할 일인가요? 1번, 2번, 3번 중에서 번호로 답해 주세요.' });
    const pending = w.session().metadata?.[NL_PENDING_METADATA_KEY] as Record<string, unknown>;
    expect(pending).toMatchObject({ kind: 'action-target', entryId: 'todo.complete', candidates: [{ label: 1, id: 'todo-1' }, { label: 2, id: 'todo-2' }, { label: 3, id: 'todo-3' }], args: {} });
    expect(JSON.stringify(pending)).not.toContain('그거');
    const answered = await w.decide('3', { now: at(2) });
    expect(answered).toMatchObject({ kind: 'execute', command: { entryId: 'todo.complete', target: { id: 'todo-3', label: 3 } } });
    expect(w.calls).toHaveLength(1);
  });

  it('a payload entry never resumes and a deictic payload gets the fixed reply', async () => {
    const w = world({ script: [out('todo.add', { title: '그거' })] });
    expect(await w.decide('그거 할 일로 추가해줘')).toEqual({ kind: 'ask', entryId: expect.any(String), text: '내용을 직접 적어 주세요.' });
    expect(w.session().metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
  });

  it('"되돌려줘" undoes the fresh last action; never an undo of an undo', async () => {
    const w = world({ script: [out('action.undo'), out('action.undo')] });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.complete', source: 'todo', itemId: 'todo-2', label: 2, version: at(0), at: at(0), undoable: true, undone: false, echoReplyIds: [] }, at(0)));
    expect(await w.decide('되돌려줘', { now: at(1) })).toMatchObject({ kind: 'execute', command: { entryId: 'action.undo', target: { source: 'todo', id: 'todo-2' }, undo: { entryId: 'todo.complete', version: at(0) } } });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'action.undo', undoOf: 'todo.complete', source: 'todo', itemId: 'todo-2', at: at(1), undoable: false, undone: false, echoReplyIds: [] }, at(1)));
    expect(await w.decide('되돌려줘', { now: at(2) })).toEqual({ kind: 'ask', entryId: expect.any(String), text: '되돌린 작업은 다시 되돌릴 수 없어요.' });
  });

  it('"되돌려줘" as a reply to an older echo asks, never undoes something else', async () => {
    const w = world({ script: [out('action.undo')] });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-9', at: at(0), undoable: true, undone: false, echoReplyIds: ['echo-new'] }, at(0)));
    expect((await w.decide('되돌려줘', { now: at(1), replyTo: 'echo-old' })).kind).toBe('ask');
  });

  it('the anchored 되돌리기 decides the same undo with no selector call', async () => {
    const w = world({ script: [] });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-9', at: at(0), undoable: true, undone: false, echoReplyIds: [] }, at(0)));
    const decision = await w.service.decideAnchoredUndo({ direct: true, text: '되돌리기', session: w.session(), actor: w.actor(), now: at(1), entries: ALL });
    expect(decision).toMatchObject({ kind: 'execute', command: { entryId: 'action.undo', undo: { entryId: 'todo.add' } } });
    expect(w.calls).toHaveLength(0);
  });

  it('A6-D3a amendment 1 (CA round 3): the anchored 되돌리기 is DM-only while ADR-0122 enforcement is off', async () => {
    const w = world({ script: [] });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-9', at: at(0), undoable: true, undone: false, echoReplyIds: [] }, at(0)));
    const channel = await w.service.decideAnchoredUndo({ direct: false, text: '되돌리기', session: w.session(), actor: w.actor(), now: at(1), entries: ALL });
    expect(channel).toEqual({ kind: 'ask', entryId: 'action.undo', text: '이 작업은 DM에서만 해요. 아무것도 바꾸지 않았어요.' });
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ entryId: 'action.undo', result: 'refused', reason: 'dm-only' });
    const absent = await w.service.decideAnchoredUndo({ text: '되돌리기', session: w.session(), actor: w.actor(), now: at(1), entries: ALL });
    expect(absent?.kind).toBe('ask');
    const enforced = await w.service.decideAnchoredUndo({ direct: false, surfaceEnforced: true, text: '되돌리기', session: w.session(), actor: w.actor(), now: at(1), entries: ALL });
    expect(enforced?.kind).toBe('execute');
  });
});

describe('round 4: the anchored 되돌리기 meets the plain-line eligibility (Codex P2)', () => {
  it.each([
    ['a platform quote', { text: '되돌리기', quotedRanges: [{ start: 0, end: 4 }] }],
    ['platform code formatting', { text: '되돌리기', codeFormatted: true }],
    ['surrounding CRLF', { text: '\r\n되돌리기\r\n' }],
    ['a trailing U+2028', { text: '되돌리기\u2028' }],
    ['a padded 305-character message', { text: `${' '.repeat(301)}되돌리기` }],
    ['a full-width brace wrapper', { text: '｛되돌리기｝' }],
    ['a leading TAB', { text: '\t되돌리기' }],
    ['a trailing NBSP', { text: '되돌리기\u00A0' }],
  ])('%s never undoes', async (_name, extra) => {
    const w = world({ script: [] });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-9', at: at(0), undoable: true, undone: false, echoReplyIds: [] }, at(0)));
    const decision = await w.service.decideAnchoredUndo({ direct: true, session: w.session(), actor: w.actor(), now: at(1), entries: ALL, ...extra });
    expect(decision).toBeUndefined();
    expect(w.calls).toHaveLength(0);
  });

  it('spaces around the single line still anchor', async () => {
    const w = world({ script: [] });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-9', at: at(0), undoable: true, undone: false, echoReplyIds: [] }, at(0)));
    expect(await w.service.decideAnchoredUndo({ direct: true, text: '  되돌리기 ', session: w.session(), actor: w.actor(), now: at(1), entries: ALL })).toMatchObject({ kind: 'execute' });
  });

  it('platform code formatting refuses a selected action like a quote does', async () => {
    for (const codeFormatted of [true, false]) {
      const w = world({ script: [out('todo.complete', { ref: '#2' })] });
      w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3]));
      const decision = await w.decide('2번 완료 처리해줘', { now: at(1), codeFormatted });
      expect(decision.kind === 'execute', String(codeFormatted)).toBe(!codeFormatted);
    }
  });
});

describe('item.summarize content mode (ratification record C)', () => {
  it('asks once, keeps the answer 30 days, reuses it, and an explicit word overrides it', async () => {
    const w = world({ script: [out('item.summarize', { source: 'mail', ref: '#1' }), out('item.summarize', { source: 'mail', ref: '#2' }), out('item.summarize', { source: 'mail', ref: '#1', mode: 'full' })] });
    w.setMetadata(LAST_LISTING_METADATA_KEY, withListing(undefined, 'owner', 'mail', ['m1', 'm2', 'm3'], at(0)));
    const asked = await w.decide('아까 1번은 무슨 내용이었지', { now: at(1) });
    expect(asked).toEqual({ kind: 'ask', entryId: expect.any(String), text: '요약해서 볼까요, 전체를 볼까요? 한 번 정하면 30일 동안 같은 방식으로 보여 드릴게요.\n1. 요약해서 보기\n2. 전체 보기\n번호로 답해 주세요.' });
    const answered = await w.decide('요약', { now: at(2) });
    expect(answered).toMatchObject({ kind: 'execute', command: { entryId: 'item.summarize', args: { mode: 'summary' }, target: { source: 'mail', id: 'm1' } } });
    expect((w.actor().metadata?.[INTERPRETATION_PREFERENCES_METADATA_KEY] as Record<string, { value: string }>)['item.content-mode']?.value).toBe('summary');
    const reused = await w.decide('2번은 무슨 얘기야', { now: at(3) });
    expect(reused).toMatchObject({ kind: 'execute', command: { args: { mode: 'summary' }, target: { id: 'm2' } } });
    expect((reused as { basis?: string }).basis).toContain('기준: 요약해서 보기');
    const overridden = await w.decide('1번 원문 보여줘', { now: at(4) });
    expect(overridden).toMatchObject({ kind: 'execute', command: { args: { mode: 'full' } } });
    expect((w.actor().metadata?.[INTERPRETATION_PREFERENCES_METADATA_KEY] as Record<string, { value: string }>)['item.content-mode']?.value).toBe('full');
  });

  it('an older mail listing behind a newer Drive listing asks and reads nothing', async () => {
    const w = world({ script: [out('item.summarize', { source: 'mail', ref: '#1', mode: 'summary' })] });
    let value = withListing(undefined, 'owner', 'mail', ['m1'], at(0));
    value = withListing(value, 'owner', 'drive', ['d1'], at(1));
    w.setMetadata(LAST_LISTING_METADATA_KEY, value);
    expect((await w.decide('1번 메일 요약해줘', { now: at(2) })).kind).toBe('ask');
  });
});

describe('shadow (A6-D8): the decision is logged, nothing acts, nothing is written', () => {
  it('returns none for an action and writes no pending question or record', async () => {
    const w = world({ level: 'shadow', script: [out('todo.complete', { ref: 'this' })] });
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2]));
    expect(await w.decide('그거 완료 처리해줘', { now: at(1) })).toEqual({ kind: 'none' });
    expect(w.session().metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ entryId: 'todo.complete', result: 'shadow', resolution: 'ambiguous' });
    expect(w.service.actionsActing(w.actor())).toBe(false);
    expect(w.service.actionsOffered(w.actor())).toBe(true);
  });
});

describe('receipts: lastAction, the echo label and the delivery binding', () => {
  it('records an executed action and binds the echo ids after delivery; nothing while off', async () => {
    const w = world({ script: [] });
    const message = { id: 'in-1', context: { platform: 'test', channelId: 'dm' } };
    await w.service.recordActionReceipt({ session: w.session(), actor: w.actor(), message, now: at(0), action: { entryId: 'todo.add', result: 'executed', source: 'todo', itemId: 'todo-7', label: 7, version: at(0), undoable: true } });
    expect(w.session().metadata?.[LAST_ACTION_METADATA_KEY]).toMatchObject({ byActor: { owner: { entryId: 'todo.add', itemId: 'todo-7', label: 7, requestId: 'in-1', echoReplyIds: [] } } });
    expect(w.session().metadata?.[LAST_LISTING_METADATA_KEY]).toMatchObject({ byActor: { owner: { todo: { ids: ['todo-7'], labels: [7] } } } });
    await w.service.observeDelivery({ messageId: 'in-1', context: message.context as never, sessionId: 'sess-1', status: 'RESPONDED', platformMessageIds: ['echo-1'] });
    expect(w.session().metadata?.[LAST_ACTION_METADATA_KEY]).toMatchObject({ byActor: { owner: { echoReplyIds: ['echo-1'] } } });
    const off = world({ level: 'off', script: [] });
    await off.service.recordActionReceipt({ session: off.session(), actor: off.actor(), message, now: at(0), action: { entryId: 'todo.add', result: 'executed', source: 'todo', itemId: 'todo-7', label: 7 } });
    expect(off.session().metadata).toBeUndefined();
  });
});

describe('honest chat (A6-D6): no command phrases for offered action families, and the stale-command guard', () => {
  it('drops "reply with the exact command" only when action entries are offered', () => {
    const help = ['- 할 일: "할 일 추가: 내용", "완료 처리: 번호"'];
    expect(renderConfiguredSourcesFact(READS, help)).toContain('reply with the exact command to send.');
    const fact = renderConfiguredSourcesFact(ALL, help) ?? '';
    expect(fact).toContain('Quoky does these actions itself when the User asks in plain words');
    expect(fact).toContain('never tells the User to type a fixed command phrase');
  });

  it('replaces a chat reply that quotes an offered family\'s command phrase', () => {
    const reply = '할 일을 완료하려면 "완료 처리: 2"라고 보내 주세요.';
    expect(guardFalseIncapabilityClaims(reply, ALL, 'ko')).toEqual({ text: '무엇을/어느 항목을 다시 말씀해 주세요.', guarded: true });
    expect(guardFalseIncapabilityClaims(reply, READS, 'ko')).toEqual({ text: reply, guarded: false });
  });
});

describe('round 2: pending answers meet the input guard (Codex review P2)', () => {
  const pending = (version = at(0)): PendingQuestion => ({ kind: 'action-reschedule', at: at(1), language: 'ko', target: { source: 'reminder', id: 'rem-1', label: 13 }, version });

  it('a reschedule answer with a separator character or over 300 characters never acts (decide and early paths)', async () => {
    const w = world({ script: [NONE, NONE] });
    for (const text of ['내일 9시\u2028알림 1 취소', `내일 9시 ${'가'.repeat(320)}`]) {
      expect((await w.decide(text, { now: at(2), pending: pending() })).kind).not.toBe('execute');
      const early = await w.service.answerActionPending({ text, attachmentCount: 0, session: w.session(), actor: w.actor(), now: at(2), entries: ALL, route: 'chat', pending: pending() });
      expect(early).toBeUndefined();
    }
    expect(actionLogs(w).filter((log) => log.fields?.reason === 'hidden-characters' || log.fields?.reason === 'too-long').length).toBe(4);
    const ok = await w.service.answerActionPending({ text: '내일 9시', attachmentCount: 0, session: w.session(), actor: w.actor(), now: at(2), entries: ALL, route: 'chat', pending: pending() });
    expect(ok).toMatchObject({ kind: 'execute', command: { entryId: 'action.undo', args: { when: '내일 9시' }, undo: { entryId: 'reminder.cancel', version: at(0) } } });
  });

  it('a ref grounded only inside pasted JSON never executes against an existing listing', async () => {
    const w = world({ script: [out('todo.complete', { ref: '#1' })] });
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2]));
    expect((await w.decide('{"request":"1번 완료해줘"}', { now: at(1) })).kind).not.toBe('execute');
  });
});

describe('round 3: an argument-free undo from pasted JSON never executes', () => {
  it('{"request":"되돌려줘"} with a fresh last action gets the plain-sentence reply', async () => {
    const w = world({ script: [out('action.undo')] });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-9', at: at(0), undoable: true, undone: false, echoReplyIds: [] }, at(0)));
    const decision = await w.decide('{"request":"되돌려줘"}', { now: at(1) });
    expect(decision).toEqual({ kind: 'ask', entryId: expect.any(String), text: '아무것도 실행하지 않았어요. 동작 요청은 한 문장으로 말씀해 주세요 (붙여넣은 내용, 인용, 명령문 없이).' });
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ entryId: 'action.undo', result: 'refused', reason: 'not-plain' });
    // Reads still work on the same kind of text.
    const reads = world({ script: [out('mail.list')] });
    expect((await reads.decide('> 참고 메모\n메일함 보여줘', { now: at(1) })).kind).toBe('execute');
  });
});

describe('A6 R1 review: a scripted wrong selector never writes (Codex P1 strings)', () => {
  const reminderAction = (minute = 0) => withLastAction(undefined, 'owner', { entryId: 'reminder.create', source: 'reminder', itemId: 'reminder-13', label: 13, at: at(minute), undoable: true, undone: false, echoReplyIds: [] }, at(minute));
  const todoAction = (minute = 0) => withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-2', label: 2, at: at(minute), undoable: true, undone: false, echoReplyIds: [] }, at(minute));

  it('a reference without the entry\'s own action word is chat: "2번도", "2번만요", "그걸로요", "13번 알림"', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['2번도', 'todo.complete', { ref: '#2' }],
      ['2번만요', 'todo.complete', { ref: '#2' }],
      ['2번만요', 'todo.cancel', { ref: '#2' }],
      ['그걸로요', 'todo.cancel', { ref: 'this' }],
      ['13번 알림', 'reminder.cancel', { ref: '#13' }],
      ['그거', 'action.undo', {}],
    ];
    for (const [text, entryId, args] of cases) {
      const w = world({ level: 'local', script: () => out(entryId, args) });
      w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
      w.setMetadata(LAST_ACTION_METADATA_KEY, entryId === 'reminder.cancel' ? reminderAction() : todoAction());
      const decision = await w.decide(text, { now: at(1) });
      expect(decision.kind, `${text} ${entryId}`).toBe('none');
      expect(w.logs.some((log) => log.event === NL_ACTION_LOG_EVENT && log.fields?.reason === 'no-action-word'), text).toBe(true);
    }
    // With the action word the same reference acts as before.
    const w = world({ level: 'local', script: () => out('todo.complete', { ref: '#2' }) });
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
    expect((await w.decide('2번도 완료', { now: at(1) })).kind).toBe('execute');
  });

  it('"9" against an open question with candidates 2 and 3 asks again; a selector-chosen undo or another entry never runs', async () => {
    const pending: PendingQuestion = { kind: 'action-target', at: at(1), language: 'ko', entryId: 'todo.complete', source: 'todo', candidates: [{ label: 2, id: 'todo-2' }, { label: 3, id: 'todo-3' }], args: {} };
    const w = world({ level: 'local', script: () => out('action.undo') });
    w.setMetadata(LAST_ACTION_METADATA_KEY, todoAction());
    const nine = await w.decide('9', { now: at(1), pending });
    expect(nine.kind).toBe('ask');
    expect(w.calls).toHaveLength(0);
    // A full request for another entry while the question is open: the selector runs, nothing is written, and a short
    // fixed reply says so (the lock lasts this one turn: the reply ends the question).
    const other = world({ level: 'local', script: () => out('action.undo') });
    other.setMetadata(LAST_ACTION_METADATA_KEY, todoAction());
    const blocked = await other.decide('방금 거 되돌려줘', { now: at(1), pending });
    expect(blocked).toMatchObject({ kind: 'ask', text: '질문이 열려 있어 실행하지 않았어요. 다시 말씀해 주세요.' });
    expect(other.logs.some((log) => log.event === NL_ACTION_LOG_EVENT && log.fields?.reason === 'pending-question')).toBe(true);
    // The questioned entry on a candidate still runs.
    const same = world({ level: 'local', script: () => out('todo.complete', { ref: '#3' }) });
    same.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([2, 3], 0));
    expect((await same.decide('3번 완료해줘 그걸로', { now: at(1), pending })).kind).toBe('execute');
  });

  it('a selector undo never undoes another item than the owner names: "2번 취소해줘", "2번 메일 취소해줘" after "할 일 5번" ask', async () => {
    const added = withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-5', label: 5, at: at(0), undoable: true, undone: false, echoReplyIds: [] }, at(0));
    for (const [text, reason] of [['2번 취소해줘', 'ambiguous'], ['2번 메일 취소해줘', 'other-source'], ['그 알림 되돌려줘', 'other-source'], ['두 번째 거 되돌려줘', 'ambiguous']] as const) {
      const w = world({ level: 'local', script: () => out('action.undo') });
      w.setMetadata(LAST_ACTION_METADATA_KEY, added);
      const decision = await w.decide(text, { now: at(1) });
      expect(decision.kind, text).toBe('ask');
      expect(w.logs.some((log) => log.event === NL_ACTION_LOG_EVENT && log.fields?.reason === reason), text).toBe(true);
    }
    // Its own label, its own source noun, or no number: the undo runs.
    for (const text of ['5번 되돌려줘', '그 할 일 되돌려줘', '방금 거 되돌려줘']) {
      const w = world({ level: 'local', script: () => out('action.undo') });
      w.setMetadata(LAST_ACTION_METADATA_KEY, added);
      expect((await w.decide(text, { now: at(1) })).kind, text).toBe('execute');
    }
  });

  it('Codex P1 (round 2): reference payloads, terse payloads, negations, adnominals, glued nouns and match spans never write', async () => {
    const run = async (text: string, entryId: string, args: Record<string, unknown>) => {
      const w = world({ level: 'local', script: () => out(entryId, args) });
      w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
      w.setMetadata(LAST_ACTION_METADATA_KEY, todoAction());
      return w.decide(text, { now: at(1) });
    };
    for (const text of ['2번만요', '그걸로요', '13번 알림']) expect((await run(text, 'todo.add', { title: text })).kind, text).not.toBe('execute');
    expect((await run('2번만요 추가해줘', 'todo.add', { title: '2번만요' })).kind).toBe('ask');
    expect((await run('13번 알림 추가해줘', 'todo.add', { title: '13번 알림' })).kind).toBe('ask');
    expect((await run('내일 9시 우유', 'reminder.create', { body: '우유', when: '내일 9시' })).kind).toBe('ask');
    expect((await run('내일 9시에 우유 사라고 알려줘', 'reminder.create', { body: '우유 사라고', when: '내일 9시' })).kind).toBe('execute');
    // The action word without a request form asks for the request ("실행할까요?") and writes nothing.
    expect((await run('2번을 완료하지 말아줘', 'todo.complete', { ref: '#2' })).kind).not.toBe('execute');
    expect((await run('취소하지 마', 'todo.cancel', { ref: 'this' })).kind).not.toBe('execute');
    expect((await run('그거 제외된 거 뭐야', 'todo.cancel', { ref: 'this' })).kind).not.toBe('execute');
    for (const text of ['2번 메일취소해줘', '2번 알림취소해줘']) expect((await run(text, 'todo.cancel', { ref: '#2' })).kind, text).toBe('ask');
    expect((await run('할 일 말고 2번 메일 취소해줘', 'todo.cancel', { match: '메일' })).kind).toBe('ask');
    // A source noun inside the matched title alone is the title's own word.
    expect((await run('메일 답장 완료해줘', 'todo.complete', { match: '메일 답장' })).kind).toBe('execute');
  });

  it('CA delta: clause negations, questions and source nouns never write (scripted wrong selector)', async () => {
    const run = async (text: string, entryId: string, args: Record<string, unknown>) => {
      const w = world({ level: 'local', script: () => out(entryId, args) });
      w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
      return w.decide(text, { now: at(1) });
    };
    const writes: Array<[string, string, Record<string, unknown>]> = [
      ['2번 취소는 하지 마', 'todo.cancel', { ref: '#2' }],
      ['2번 삭제는 하지 말아줘', 'todo.cancel', { ref: '#2' }],
      ['2번 완료는 하지 마', 'todo.complete', { ref: '#2' }],
      ['2번 취소하면 안 돼', 'todo.cancel', { ref: '#2' }],
      ['2번 취소 안 해도 돼', 'todo.cancel', { ref: '#2' }],
      ['2번 취소 금지', 'todo.cancel', { ref: '#2' }],
      ['2번 아직 완료 안 됐어', 'todo.complete', { ref: '#2' }],
      ['2번 끝냈어?', 'todo.complete', { ref: '#2' }],
      ['2번 완료됐어?', 'todo.complete', { ref: '#2' }],
      ['2번 취소했어?', 'todo.cancel', { ref: '#2' }],
      ['2번 취소할까?', 'todo.cancel', { ref: '#2' }],
      ['취소된거 뭐야', 'todo.cancel', { ref: 'this' }],
      ['2번 완료된거 맞아', 'todo.complete', { ref: '#2' }],
      ['알림 설정 어떻게 해?', 'reminder.create', { body: '설정', when: '내일 9시' }],
      ['알림 왜 안 왔어?', 'reminder.create', { body: '왜', when: '내일 9시' }],
      ['알림장 챙기기 내일 9시', 'reminder.create', { body: '알림장 챙기기', when: '내일 9시' }],
      ['메모장 열어줘', 'todo.add', { title: '메모장 열어줘' }],
    ];
    // Codex (through 0e93136): glued, 말고 and English clause negations, for item writes and payload writes alike.
    writes.push(
      ['2번 완료 안 해도 돼', 'todo.complete', { ref: '#2' }],
      ['2번완료안해도돼', 'todo.complete', { ref: '#2' }],
      ['2번 완료 말고 보여줘', 'todo.complete', { ref: '#2' }],
      ["don't mark 2 complete", 'todo.complete', { ref: '#2' }],
      ['do not mark 2 complete', 'todo.complete', { ref: '#2' }],
      ['do not cancel the second one', 'todo.cancel', { ref: '#2' }],
      ['우유 사기 할 일에 추가하지 마', 'todo.add', { title: '우유 사기' }],
      ['우유 사기 추가 안 해도 돼', 'todo.add', { title: '우유 사기' }],
      ['내일 9시에 물 마시라고 알려주지 마', 'reminder.create', { body: '물 마시라고', when: '내일 9시' }],
      ["don't remind me tomorrow at 9am to call Kim", 'reminder.create', { body: 'call Kim', when: 'tomorrow at 9am' }],
    );
    for (const [text, entryId, args] of writes) expect((await run(text, entryId, args)).kind, text).not.toBe('execute');
    // A negation anywhere in the message vetoes (Codex: a later retraction counts), so this fails closed.
    expect((await run('not now, mark 2 complete', 'todo.complete', { ref: '#2' })).kind).not.toBe('execute');
    // A polite request in question form still acts.
    expect((await run('2번 완료해줄래?', 'todo.complete', { ref: '#2' })).kind).toBe('execute');
    expect((await run('2번 취소해 줄 수 있어?', 'todo.cancel', { ref: '#2' })).kind).toBe('execute');
  });

  it('positive request-form rule (fix-loop cap): only an affirmative request writes; CA round 3 and Codex strings never do', async () => {
    const run = async (text: string, entryId: string, args: Record<string, unknown>) => {
      const w = world({ level: 'local', script: () => out(entryId, args) });
      // The add's echo label merged into the listing in the add's own turn (same requestId), as recordReceipt writes it,
      // so the slot is the action's echo and never a tied newer listing (A6 reference priority, owner 2026-10-16).
      w.setMetadata(LAST_LISTING_METADATA_KEY, withLabelledListing(todoListing([1, 2, 3], 0), 'owner', 'todo', [{ label: 2, id: 'todo-2' }], at(0), 'merge', 'req-add'));
      w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-2', label: 2, at: at(0), undoable: true, undone: false, requestId: 'req-add', echoReplyIds: [] }, at(0)));
      return w.decide(text, { now: at(1) });
    };
    const complete = { ref: '#2' };
    const never: Array<[string, string, Record<string, unknown>]> = [
      // CA round 3
      ['2번 취소할지 모르겠어', 'todo.cancel', complete],
      ['2번 완료해줘야 할까?', 'todo.complete', complete],
      ['2번 완료해야 하나', 'todo.complete', complete],
      ['2번 완료해야 해', 'todo.complete', complete],
      ['2번 취소할까 해', 'todo.cancel', complete],
      ['2번 취소 필요 없어', 'todo.cancel', complete],
      ['2번 취소 싫어', 'todo.cancel', complete],
      ['2번 완료 아니고 3번', 'todo.complete', complete],
      ['is 2 done?', 'todo.complete', complete],
      ['did you cancel 2?', 'todo.cancel', complete],
      ['I shouldn’t cancel 2', 'todo.cancel', complete],
      ['we won’t cancel 2', 'todo.cancel', complete],
      ['추가 질문 있어', 'todo.add', { title: '질문' }],
      ['2번 완료할게', 'todo.complete', complete],
      ['2번 완료해?', 'todo.complete', complete],
      // Codex (on 4ab11e1)
      ['2번 완료해줄래? 아니 하지마', 'todo.complete', complete],
      ['2번완료해줄래?아니하지마', 'todo.complete', complete],
      ['2번 완료됐는지 보여줄래?', 'todo.complete', complete],
      ['2번 취소인지 확인해줄래?', 'todo.cancel', complete],
      ['can you tell me if 2 is complete?', 'todo.complete', complete],
      ['mark 2 complete 안 해도 돼', 'todo.complete', complete],
      ['2번완료하진마', 'todo.complete', complete],
      ['2번 완료할필요없어', 'todo.complete', complete],
      ['don’t mark 2 complete', 'todo.complete', complete],
      ['2 is done', 'todo.complete', complete],
      // CA delta (4ab11e1..cc81b2f): done-statement auxiliaries, retractions, reported speech, examples, 그만
      ['2번 완료해 뒀어', 'todo.complete', complete],
      ['2번 취소해 놨어', 'todo.cancel', complete],
      ['알림 꺼 놨어', 'reminder.cancel', { ref: 'this' }],
      ['2번 완료해 둘게', 'todo.complete', complete],
      ['2번 완료해 줘서 고마워', 'todo.complete', complete],
      ['2번 완료해줘 아냐', 'todo.complete', complete],
      ['2번 완료해줘 아님', 'todo.complete', complete],
      ['2번 완료해줘 ㄴㄴ', 'todo.complete', complete],
      ['2번 완료해줘 노노', 'todo.complete', complete],
      ['2번 완료해줘 됐어', 'todo.complete', complete],
      ['2번 완료해줘 아 잠깐', 'todo.complete', complete],
      ['complete 2 nope', 'todo.complete', complete],
      ['please complete 2, nah', 'todo.complete', complete],
      ['2번 완료해줘 취소', 'todo.complete', complete],
      ['2번 완료해줘 취소', 'todo.cancel', complete],
      ['2번 완료해줘 했던 거 되돌려줘', 'todo.complete', complete],
      ['2번 완료해줘 했던 거 되돌려줘', 'action.undo', {}],
      ['2번 완료해줘 하면 돼', 'todo.complete', complete],
      ['undo 해줘 했더니 이상해', 'action.undo', {}],
      ['예를 들어 2번 완료해줘', 'todo.complete', complete],
      ['2번 취소 그만해', 'todo.cancel', complete],
      // Codex at 186a94d: first-person volition, particle negations and 철회
      ['내가 2번 완료할래', 'todo.complete', complete],
      ['제가 2번 완료해요', 'todo.complete', complete],
      ['2번 완료해줘. 아직 실행하지는 마', 'todo.complete', complete],
      ['2번 완료해줘. 방금 요청 철회할게', 'todo.complete', complete],
    ];
    for (const [text, entryId, args] of never) expect((await run(text, entryId, args)).kind, text).not.toBe('execute');
    const genuine: Array<[string, string, Record<string, unknown>]> = [
      ['2번 완료해줘', 'todo.complete', complete],
      ['그거 취소해 줄래', 'todo.cancel', { ref: 'this' }],
      ['그거 취소해 줄 수 있어?', 'todo.cancel', { ref: 'this' }],
      ['그거 완료해줄래?', 'todo.complete', { ref: 'this' }],
      ['내일 9시에 회의 알려줘', 'reminder.create', { body: '회의', when: '내일 9시' }],
      ['please complete 2', 'todo.complete', complete],
      ['can you cancel 2', 'todo.cancel', complete],
      ["할 일에 '보고서' 추가해줘", 'todo.add', { title: '보고서' }],
      // Kept nominal commands (ratified A6 live phrases U4 / U8c; reported for the owner).
      ["할 일에 'UAT 결과 정리' 추가", 'todo.add', { title: 'UAT 결과 정리' }],
      ['2번도 완료', 'todo.complete', complete],
    ];
    for (const [text, entryId, args] of genuine) expect((await run(text, entryId, args)).kind, text).toBe('execute');
    // Post-rule extension (Haiku cost analysis): a reason clause before the request, 할래, a Latin action word in a Korean
    // request, the undo nouns; a negated clause naming the same action still vetoes.
    const extended: Array<[string, string, Record<string, unknown>]> = [
      ['3번 할 일은 필요 없어졌어 빼줘', 'todo.cancel', { ref: '#3' }],
      ['1번은 안 할 거야 삭제해줘', 'todo.cancel', { ref: '#1' }],
      ['알림 취소할래 2번', 'reminder.cancel', { ref: '#2' }],
      ['1번 done 처리해줘', 'todo.complete', { ref: '#1' }],
      ['아니 방금 거 되돌려줘', 'action.undo', {}],
      ['방금 한 거 롤백', 'action.undo', {}],
    ];
    for (const [text, entryId, args] of extended) expect((await run(text, entryId, args)).kind, text).toBe('execute');
    for (const [text, entryId, args] of [
      ['2번 취소하지 마 3번 빼줘', 'todo.cancel', { ref: '#2' }],
      ['2번 취소할래?', 'todo.cancel', { ref: '#2' }],
      ['완료하지 말고 2번 처리해줘', 'todo.complete', { ref: '#2' }],
    ] as const) expect((await run(text, entryId, args)).kind, text).not.toBe('execute');
  });

  it('a second or another source noun asks: "할 일 말고 2번 메일 취소해줘", "2번 (메일) 취소해줘", "메일2번 취소해줘"', async () => {
    for (const text of ['할 일 말고 2번 메일 취소해줘', '2번 (메일) 취소해줘', '메일2번 취소해줘']) {
      const w = world({ level: 'local', script: () => out('todo.cancel', { ref: '#2' }) });
      w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
      const decision = await w.decide(text, { now: at(1) });
      expect(decision.kind, text).toBe('ask');
      expect(w.logs.some((log) => log.event === NL_ACTION_LOG_EVENT && log.fields?.reason === 'other-source'), text).toBe(true);
    }
  });

  it('shadow logs `shadow` for the new refusals, and a turn that ends as chat keeps lastSelection (CA review)', async () => {
    const shadow = world({ level: 'shadow', script: () => out('todo.complete', { ref: '#2' }) });
    shadow.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
    expect((await shadow.decide('2번만요', { now: at(1) })).kind).toBe('none');
    expect(shadow.logs.some((log) => log.event === NL_ACTION_LOG_EVENT && log.fields?.result === 'shadow' && log.fields?.reason === 'no-action-word')).toBe(true);
    const w = world({ level: 'local', script: () => out('todo.complete', { ref: '#2' }) });
    const selection = { actorId: 'owner', entryId: 'mail.list', args: {}, at: at(0) };
    w.setMetadata(LAST_SELECTION_METADATA_KEY, selection);
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
    await w.decide('2번만요', { now: at(1) });
    expect(w.session().metadata?.[LAST_SELECTION_METADATA_KEY]).toEqual(selection);
    await w.decide('2번 완료', { now: at(1) });
    expect(w.session().metadata?.[LAST_SELECTION_METADATA_KEY]).toBeUndefined();
  });
});

describe('A6-D3a amendment 1 (owner-approved direction 2026-10-16): a chosen LOCAL_WRITE acts; only structure vetoes it', () => {
  const run = async (text: string, entryId: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const w = world({ level: 'local', script: () => out(entryId, args, extra) });
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3, 4], 0));
    const decision = await w.decide(text, { now: at(1) });
    return { w, decision };
  };

  it('the owner\'s live shadow phrases execute directly with the args from the text (no "할까요?")', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['3일 뒤 오전 9시에 월세 이체 리마인더', 'reminder.create', { body: '월세 이체', when: '3일 뒤 오전 9시' }],
      ['오늘 밤 10시에 알림: 가스 밸브 잠그기', 'reminder.create', { body: '가스 밸브 잠그기', when: '오늘 밤 10시' }],
      ['알림 설정: 모레 아침 8시 이사 업체 전화', 'reminder.create', { body: '이사 업체 전화', when: '모레 아침 8시' }],
      ['todo 추가: 프린터 토너 주문', 'todo.add', { title: '프린터 토너 주문' }],
      ['투두에 "회의실 정리" 추가 ㄱㄱ', 'todo.add', { title: '회의실 정리' }],
      ['1번 할일 체크해줘', 'todo.complete', { ref: '#1' }],
      ['2번 할 일 빼', 'todo.cancel', { ref: '#2' }],
    ];
    for (const [text, entryId, args] of cases) {
      const { w, decision } = await run(text, entryId, args);
      expect(decision, text).toMatchObject({ kind: 'execute', command: { entryId, args } });
      expect(actionLogs(w).some((log) => typeof log.fields?.reason === 'string' && String(log.fields.reason).startsWith('not-request')), text).toBe(false);
    }
    const { decision } = await run('1번 할일 체크해줘', 'todo.complete', { ref: '#1' });
    expect(decision).toMatchObject({ kind: 'execute', command: { target: { source: 'todo', id: 'todo-1' } } });
  });

  it('first-person volition is chat (none), never a question: "할 일 하나 추가할게. 도서관 책 반납"', async () => {
    for (const [text, entryId, args] of [
      ['할 일 하나 추가할게. 도서관 책 반납', 'todo.add', { title: '도서관 책 반납' }],
      ['할 일 하나 추가할게. 도서관 책 반납', 'todo.add', { title: '책 반납' }],
      ['도서관 책 반납 내가 할 일에 추가할게요', 'todo.add', { title: '도서관 책 반납' }],
      ['2번은 내가 완료할래', 'todo.complete', { ref: '#2' }],
      ['내일 9시에 병원 가는 거 알아서 적어둘게', 'reminder.create', { body: '병원 가는 거', when: '내일 9시' }],
      ["I'll add milk to my todos", 'todo.add', { title: 'milk' }],
    ] as const) {
      const { w, decision } = await run(text, entryId, args);
      expect(decision, text).toEqual({ kind: 'none' });
      expect(actionLogs(w).at(-1)?.fields, text).toMatchObject({ entryId, result: 'refused', reason: 'not-request:volition' });
    }
    // Shadow logs the same refusal as `shadow`.
    const shadow = world({ level: 'shadow', script: () => out('todo.add', { title: '도서관 책 반납' }) });
    expect((await shadow.decide('할 일 하나 추가할게. 도서관 책 반납', { now: at(1) })).kind).toBe('none');
    expect(actionLogs(shadow).at(-1)?.fields).toMatchObject({ result: 'shadow', reason: 'not-request:volition' });
  });

  it('every veto class ends as chat with its own closed reason (Korean and English)', async () => {
    const vetoed: Array<[string, string, Record<string, unknown>, string]> = [
      ['2번 완료하는 법 알려줘', 'todo.complete', { ref: '#2' }, 'question'],
      ['how do I complete 2?', 'todo.complete', { ref: '#2' }, 'question'],
      ['2번 완료하지 마', 'todo.complete', { ref: '#2' }, 'negation'],
      ["don't complete 2", 'todo.complete', { ref: '#2' }, 'negation'],
      ['2번 완료해줘 아 취소', 'todo.complete', { ref: '#2' }, 'retraction'],
      ['팀장님이 할 일에 보고서 추가하래', 'todo.add', { title: '보고서' }, 'reported'],
      ['my boss told me to add the report to my todos', 'todo.add', { title: 'the report' }, 'reported'],
      ['비 오면 내일 9시에 우산 알려줘', 'reminder.create', { body: '우산', when: '내일 9시' }, 'conditional'],
      ['if it rains remind me tomorrow at 9am to take an umbrella', 'reminder.create', { body: 'take an umbrella', when: 'tomorrow at 9am' }, 'conditional'],
      ['2번 완료했어', 'todo.complete', { ref: '#2' }, 'statement'],
      ['I already finished 2', 'todo.complete', { ref: '#2' }, 'statement'],
      ['제가 2번 취소할게요', 'todo.cancel', { ref: '#2' }, 'volition'],
      ['예를 들어 2번 완료해줘', 'todo.complete', { ref: '#2' }, 'example'],
    ];
    for (const [text, entryId, args, veto] of vetoed) {
      const { w, decision } = await run(text, entryId, args);
      expect(decision, text).toEqual({ kind: 'none' });
      expect(actionLogs(w).at(-1)?.fields?.reason, text).toBe(`not-request:${veto}`);
    }
  });

  it('asks only for a missing required slot or an ambiguous target', async () => {
    // A reminder without a time: the slot question, nothing written.
    const noTime = await run('월세 이체 리마인더 걸어줘', 'reminder.create', { body: '월세 이체' });
    expect(noTime.decision.kind).toBe('ask');
    expect(actionLogs(noTime.w).at(-1)?.fields).toMatchObject({ result: 'refused', reason: 'missing-arg' });
    // A number the owner never saw in the listing: the target question.
    const outOfRange = await run('9번 할일 체크해줘', 'todo.complete', { ref: '#9' });
    expect(outOfRange.decision.kind).toBe('ask');
    expect(actionLogs(outOfRange.w).at(-1)?.fields).toMatchObject({ result: 'asked', reason: 'out-of-range' });
    // A payload with nothing else said is content, not an action: restate ("내일 9시 우유").
    expect((await run('내일 9시 우유', 'reminder.create', { body: '우유', when: '내일 9시' })).decision.kind).toBe('ask');
    // A reference with nothing else said is chat ("2번도").
    expect((await run('2번도', 'todo.complete', { ref: '#2' })).decision).toEqual({ kind: 'none' });
  });

  it('typo case "3번 완룐 처리해줘": Core has no typo list; the selector\'s own NEEDS_CLARIFICATION flag is what asks', async () => {
    const flagged = await run('3번 완룐 처리해줘', 'todo.complete', { ref: '#3' }, { ambiguity: 'NEEDS_CLARIFICATION' });
    expect(flagged.decision.kind).toBe('ask');
    expect(actionLogs(flagged.w).at(-1)?.fields).toMatchObject({ result: 'asked', reason: 'ambiguous' });
    // A CLEAR selection of the same words executes: nothing in Core recognises the misspelling.
    expect((await run('3번 완룐 처리해줘', 'todo.complete', { ref: '#3' })).decision).toMatchObject({ kind: 'execute', command: { target: { id: 'todo-3' } } });
  });

  it('CA P2: while ADR-0122 enforcement is off a local write acts only in a DM; reads are unaffected', async () => {
    const w = world({ level: 'local', script: () => out('todo.complete', { ref: '#1' }) });
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2], 0));
    const channel = await w.decide('1번 할일 체크해줘', { now: at(1), direct: false });
    expect(channel).toMatchObject({ kind: 'ask', text: '이 작업은 DM에서만 해요. 아무것도 바꾸지 않았어요.' });
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ result: 'refused', reason: 'dm-only' });
    const undo = world({ level: 'local', script: () => out('action.undo') });
    expect((await undo.decide('되돌려줘', { now: at(1), direct: false })).kind).toBe('ask');
    // With ADR-0122 enforcement on, the surface gate has already decided the channel: the write acts.
    expect((await w.decide('1번 할일 체크해줘', { now: at(1), direct: false, surfaceEnforced: true })).kind).toBe('execute');
    // A read in a channel still works.
    const read = world({ level: 'local', script: () => out('mail.list') });
    expect((await read.decide('메일함 보여줘', { now: at(1), direct: false })).kind).toBe('execute');
    // Shadow logs the refusal as shadow.
    const shadow = world({ level: 'shadow', script: () => out('todo.complete', { ref: '#1' }) });
    shadow.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2], 0));
    expect((await shadow.decide('1번 할일 체크해줘', { now: at(1), direct: false })).kind).toBe('none');
    expect(actionLogs(shadow).at(-1)?.fields).toMatchObject({ result: 'shadow', reason: 'dm-only' });
  });

  it('span grounding stays: a title or body that is not verbatim in the message never writes', async () => {
    for (const [text, entryId, args] of [
      ['todo 추가: 프린터 토너 주문', 'todo.add', { title: '프린터 토너 주문하기' }],
      ['3일 뒤 오전 9시에 월세 이체 리마인더', 'reminder.create', { body: '월세 송금', when: '3일 뒤 오전 9시' }],
      ['3일 뒤 오전 9시에 월세 이체 리마인더', 'reminder.create', { body: '월세 이체', when: '사흘 뒤 9시' }],
    ] as const) {
      const { decision } = await run(text, entryId, args);
      expect(decision.kind, `${text} ${JSON.stringify(args)}`).not.toBe('execute');
    }
    // A negation inside delimited content is content ("…알림: 가스 밸브 잠그지 마"); undelimited at the end it vetoes.
    expect((await run('오늘 밤 10시에 알림: 가스 밸브 잠그지 마', 'reminder.create', { body: '가스 밸브 잠그지 마', when: '오늘 밤 10시' })).decision.kind).toBe('execute');
    expect((await run('할 일에 우유 추가하지 마', 'todo.add', { title: '우유 추가하지 마' })).decision).toEqual({ kind: 'none' });
  });
});

describe('A6-D3a amendment 1, undo confirmation rule: only an unambiguous undo executes directly', () => {
  const completed = (minute = 0) => withLastAction(undefined, 'owner', { entryId: 'todo.complete', source: 'todo', itemId: 'todo-2', label: 2, at: at(minute), undoable: true, undone: false, echoReplyIds: [] }, at(minute));
  const asked = async (text: string) => {
    const w = world({ level: 'local', script: () => out('action.undo') });
    w.setMetadata(LAST_ACTION_METADATA_KEY, completed());
    const decision = await w.decide(text, { now: at(1) });
    return { w, decision };
  };
  const answer = (w: World, text: string, minute = 2) =>
    w.service.answerActionPending({ text, attachmentCount: 0, session: w.session(), actor: w.actor(), now: at(minute), entries: ALL, route: 'chat', direct: true, pending: readPendingQuestion(w.session(), 'owner', at(minute)) ?? null });

  it('an unambiguous undo command executes directly', async () => {
    for (const text of ['되돌려줘', '원상복구 부탁', '되돌려줘 빨리요', '원래대로 돌려 줄 수 있어?']) {
      const { decision } = await asked(text);
      expect(decision, text).toMatchObject({ kind: 'execute', command: { entryId: 'action.undo', target: { id: 'todo-2' }, undo: { entryId: 'todo.complete' } } });
    }
  });

  it('any other selected undo asks a one-step confirmation naming the action; 응 executes it, 아니 does nothing', async () => {
    for (const text of ['되돌려 주셨던 기능 추천', '되돌려 봐 주는 앱 추천', '되돌려 주신 기능 설명해줘', '되돌려줘 주의 깊게']) {
      const { w, decision } = await asked(text);
      expect(decision, text).toMatchObject({ kind: 'ask', text: "방금 한 '할 일 2번 완료'를 되돌릴까요? (응 / 아니)" });
      expect(actionLogs(w).at(-1)?.fields, text).toMatchObject({ entryId: 'action.undo', result: 'asked', reason: 'undo-confirm' });
      expect(readPendingQuestion(w.session(), 'owner', at(2)), text).toMatchObject({ kind: 'action-undo-confirm', target: { id: 'todo-2' }, undoEntryId: 'todo.complete' });
    }
    const yes = await asked('되돌려 주신 기능 설명해줘');
    expect(await answer(yes.w, '응')).toMatchObject({ kind: 'execute', command: { entryId: 'action.undo', target: { id: 'todo-2' }, undo: { entryId: 'todo.complete' } } });
    const no = await asked('되돌려 주신 기능 설명해줘');
    const denied = await answer(no.w, '아니');
    expect(denied?.kind).toBe('ask');
    expect(denied).not.toMatchObject({ kind: 'execute' });
    // Not an answer: the question ends and the turn routes normally.
    const other = await asked('되돌려 주신 기능 설명해줘');
    expect(await answer(other.w, '응 근데 3번은?')).toBeUndefined();
  });

  it('Codex P2: the answer may be a platform reply to the confirmation message; it is bound to the stored action', async () => {
    const { w } = await asked('되돌려 주신 기능 설명해줘');
    const reply = await w.service.answerActionPending({
      text: '응', attachmentCount: 0, session: w.session(), actor: w.actor(), now: at(2), entries: ALL, route: 'chat', direct: true,
      replyToMessageId: 'confirm-question-1', pending: readPendingQuestion(w.session(), 'owner', at(2)) ?? null,
    });
    expect(reply).toMatchObject({ kind: 'execute', command: { entryId: 'action.undo', target: { id: 'todo-2' }, undo: { entryId: 'todo.complete' } } });
    // A changed lastAction still refuses, with or without a reply.
    const changed = await asked('되돌려 주신 기능 설명해줘');
    changed.w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.complete', source: 'todo', itemId: 'todo-2', label: 2, at: at(1), undoable: true, undone: false, echoReplyIds: [] }, at(1)));
    const refused = await changed.w.service.answerActionPending({
      text: '응', attachmentCount: 0, session: changed.w.session(), actor: changed.w.actor(), now: at(2), entries: ALL, route: 'chat', direct: true,
      replyToMessageId: 'confirm-question-1', pending: readPendingQuestion(changed.w.session(), 'owner', at(2)) ?? null,
    });
    expect(refused?.kind).toBe('ask');
    expect(actionLogs(changed.w).at(-1)?.fields).toMatchObject({ result: 'refused', reason: 'undo-changed' });
  });

  it('a confirmation runs only if the last action is still the one it named', async () => {
    const { w } = await asked('되돌려 주신 기능 설명해줘');
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-7', label: 7, at: at(1), undoable: true, undone: false, echoReplyIds: [] }, at(1)));
    const decision = await answer(w, '응');
    expect(decision?.kind).toBe('ask');
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ result: 'refused', reason: 'undo-changed' });
  });

  it('shadow logs the confirmation as shadow and asks nothing', async () => {
    const w = world({ level: 'shadow', script: () => out('action.undo') });
    w.setMetadata(LAST_ACTION_METADATA_KEY, completed());
    expect((await w.decide('되돌려 주신 기능 설명해줘', { now: at(1) })).kind).toBe('none');
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ result: 'shadow', reason: 'undo-confirm' });
  });
});

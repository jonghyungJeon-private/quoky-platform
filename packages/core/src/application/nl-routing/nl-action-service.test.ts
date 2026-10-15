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
import { INTERPRETATION_PREFERENCES_METADATA_KEY, LAST_SELECTION_METADATA_KEY, NL_PENDING_METADATA_KEY, type PendingQuestion } from './selection-state';
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
  decide(text: string, opts?: { now?: IsoTimestamp; entries?: readonly NlCatalogEntry[]; pending?: PendingQuestion | null; replyTo?: string; codeFormatted?: boolean }): Promise<NlSelectionDecision>;
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
    expect(NL_SELECTION_PROMPT_VERSION).toBe('nl-select.v27');
    expect(NL_ACTION_PROMPT_VERSION).toBe('nl-select.v28');
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
    expect(decision).toEqual({ kind: 'ask', entryId: expect.any(String), text: '가장 최근에 보여 드린 건 메일 목록이에요. 어느 알림인지 다시 말씀해 주세요.' });
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
    const decision = await w.service.decideAnchoredUndo({ text: '되돌리기', session: w.session(), actor: w.actor(), now: at(1), entries: ALL });
    expect(decision).toMatchObject({ kind: 'execute', command: { entryId: 'action.undo', undo: { entryId: 'todo.add' } } });
    expect(w.calls).toHaveLength(0);
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
    const decision = await w.service.decideAnchoredUndo({ session: w.session(), actor: w.actor(), now: at(1), entries: ALL, ...extra });
    expect(decision).toBeUndefined();
    expect(w.calls).toHaveLength(0);
  });

  it('spaces around the single line still anchor', async () => {
    const w = world({ script: [] });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, 'owner', { entryId: 'todo.add', source: 'todo', itemId: 'todo-9', at: at(0), undoable: true, undone: false, echoReplyIds: [] }, at(0)));
    expect(await w.service.decideAnchoredUndo({ text: '  되돌리기 ', session: w.session(), actor: w.actor(), now: at(1), entries: ALL })).toMatchObject({ kind: 'execute' });
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

describe('A6 R1 fix: a reference alone never selects an action (A6-D2)', () => {
  it('"2번도" after a to-do list is chat, logged as no-request; an open target question keeps the bare number an answer', async () => {
    const w = world({ level: 'local', script: () => out('todo.complete', { ref: '#2' }) });
    w.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
    expect((await w.decide('2번도', { now: at(1) })).kind).toBe('none');
    expect(w.logs.some((log) => log.event === NL_ACTION_LOG_EVENT && log.fields?.reason === 'no-request')).toBe(true);
    expect((await w.decide('그거', { now: at(1) })).kind).toBe('none');
    // The same words with a request word act as before.
    expect((await w.decide('2번도 완료', { now: at(1) })).kind).toBe('execute');
    const open = world({ level: 'local', script: () => out('todo.complete', { ref: '#2' }) });
    open.setMetadata(LAST_LISTING_METADATA_KEY, todoListing([1, 2, 3], 0));
    const pending: PendingQuestion = { kind: 'action-target', at: at(1), language: 'ko', entryId: 'todo.complete', source: 'todo', candidates: [{ label: 3, id: 'todo-3' }], args: {} };
    const decision = await open.decide('2번도', { now: at(1), pending });
    expect(decision.kind).not.toBe('none');
  });
});

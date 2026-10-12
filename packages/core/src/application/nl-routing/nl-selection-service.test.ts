import { describe, expect, it } from 'vitest';
import { AiProviderError } from '../../errors';
import { AiFailureKind, Capability, type Actor, type IsoTimestamp, type Session } from '../../domain';
import type { AiProvider, AiRequest, LogFields, Logger } from '../../ports';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { NlSelectionService, choiceIndex, type NlIntentMode, type NlSelectionDecision } from './nl-selection-service';
import {
  INTERPRETATION_PREFERENCES_METADATA_KEY,
  INTERPRETATION_PREFERENCE_TTL_MS,
  LAST_SELECTION_METADATA_KEY,
  NL_PENDING_METADATA_KEY,
  NL_PENDING_TTL_MS,
} from './selection-state';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 NlSelectionService with a scripted stub selector (no model): one call per message, the D3 bounds and the
// pre-egress credential guard, D4 validation, D7 clarification / lastSelection / interpretation preference (ask once,
// 30-day TTL, override), D11 shadow logs, and the provider-down fallback.

const T0 = '2026-10-12T03:00:00.000Z';
const at = (ms: number): IsoTimestamp => new Date(Date.parse(T0) + ms).toISOString();
const ALL: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const out = (entryId: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [], ...extra });
const NONE = out('none');

interface Harness {
  service: NlSelectionService;
  calls: AiRequest[];
  logs: Array<{ level: string; event: string; fields?: LogFields }>;
  session: Session;
  actor: () => Actor;
  decide(
    text: string,
    opts?: { now?: IsoTimestamp; entries?: readonly NlCatalogEntry[]; attachments?: number; chatProviderId?: string | null },
  ): Promise<NlSelectionDecision>;
  script: string[];
}

function harness(options: {
  mode?: NlIntentMode;
  script?: string[];
  execute?: (request: AiRequest) => Promise<{ text: string }>;
  select?: () => Promise<AiProvider>;
  timeoutMs?: number;
} = {}): Harness {
  const calls: AiRequest[] = [];
  const logs: Harness['logs'] = [];
  const script = [...(options.script ?? [])];
  let session: Session = {
    id: 'sess-1',
    actorId: 'owner',
    context: { platform: 'test', channelId: 'dm-1', userId: 'u', direct: true },
    status: 'ACTIVE' as Session['status'],
    createdAt: T0,
    lastActivityAt: T0,
  };
  let actor: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
  const provider: AiProvider = {
    id: 'scripted-selector',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    async isAvailable() {
      return true;
    },
    async execute(request) {
      calls.push(request);
      if (options.execute) return { ...(await options.execute(request)), artifacts: [] };
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted');
      return { text: next, artifacts: [] };
    },
  };
  const logger: Logger = {
    info: (event, fields) => void logs.push({ level: 'info', event, ...(fields ? { fields } : {}) }),
    warn: (event, fields) => void logs.push({ level: 'warn', event, ...(fields ? { fields } : {}) }),
    error: (event, fields) => void logs.push({ level: 'error', event, ...(fields ? { fields } : {}) }),
  };
  const service = new NlSelectionService({
    mode: options.mode ?? 'active',
    router: { select: options.select ?? (async (capability) => {
      expect(capability).toBe(Capability.INTENT_SELECTION);
      return provider;
    }) },
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
    actors: {
      async get() {
        return actor;
      },
      async save(next) {
        actor = next;
        return next;
      },
    },
    timeZone: 'Asia/Seoul',
    logger,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return {
    service,
    calls,
    logs,
    script,
    get session() {
      return session;
    },
    actor: () => actor,
    decide: (text, opts = {}) =>
      service.decide({
        text,
        attachmentCount: opts.attachments ?? 0,
        session,
        actor,
        now: opts.now ?? T0,
        entries: opts.entries ?? ALL,
        route: 'chat',
        ...(opts.chatProviderId === null ? {} : { chatProviderId: opts.chatProviderId ?? 'scripted-selector' }),
      }),
  } as Harness;
}

describe('NlSelectionService — modes and the D3 call contract', () => {
  it('off: never calls the selector; no catalog: skips', async () => {
    const h = harness({ mode: 'off', script: [NONE] });
    expect(await h.decide('내 지라 이슈')).toEqual({ kind: 'skip', reason: 'off' });
    const active = harness({ script: [NONE] });
    expect(await active.decide('내 지라 이슈', { entries: [] })).toEqual({ kind: 'skip', reason: 'no-catalog' });
    expect(h.calls).toHaveLength(0);
    expect(active.calls).toHaveLength(0);
  });

  it('makes one INTENT_SELECTION call with a bounded timeout, the prepared text and the offered catalog', async () => {
    const h = harness({ script: [out('jira.issues')] });
    await h.decide('오늘 나한테 할당된 jira 이슈가 있을텐데 ?');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ capability: Capability.INTENT_SELECTION, timeoutMs: 4000 });
    expect(h.calls[0]!.prompt).toContain('<<<\n오늘 나한테 할당된 jira 이슈가 있을텐데 ?\n>>>');
    expect(Object.keys(h.calls[0]!)).toEqual(['capability', 'prompt', 'timeoutMs']);
  });

  it('pre-egress guard: a credential-shaped message (or previous arg) makes zero selector calls and continues unchanged', async () => {
    const h = harness({ script: [NONE] });
    const token = 'ghp_' + 'Z'.repeat(36);
    expect(await h.decide(`내 지라 이슈 보여줘 ${token}`)).toEqual({ kind: 'skip', reason: 'credential' });
    expect(await h.decide(`password: ${'Hunter2!'.repeat(2)} 슬랙에서 검색`)).toEqual({ kind: 'skip', reason: 'credential' });
    expect(h.calls).toHaveLength(0);
    // A credential-shaped previous arg (a stored keyword) also skips the call: the whole outgoing request is guarded.
    const withPrevious = harness({ script: [NONE] });
    await withPrevious.service.decide({
      text: '그 중에 하나만',
      attachmentCount: 0,
      session: {
        ...withPrevious.session,
        metadata: { [LAST_SELECTION_METADATA_KEY]: { actorId: 'owner', entryId: 'slack.search', args: { keyword: token }, at: T0 } },
      },
      actor: withPrevious.actor(),
      now: at(1000),
      entries: ALL,
      route: 'chat',
      chatProviderId: 'scripted-selector',
    });
    expect(withPrevious.calls).toHaveLength(0);
  });

  it('D6/D8: no new egress — a chat turn served by another provider (local or remote) or an unknown one makes no call', async () => {
    const h = harness({ script: [out('jira.issues'), out('jira.issues')] });
    expect(await h.decide('내 지라 이슈', { chatProviderId: 'local-chat-model' })).toEqual({ kind: 'skip', reason: 'chat-provider-differs' });
    expect(await h.decide('내 지라 이슈', { chatProviderId: 'other-remote-chat' })).toEqual({ kind: 'skip', reason: 'chat-provider-differs' });
    expect(await h.decide('내 지라 이슈', { chatProviderId: null })).toEqual({ kind: 'skip', reason: 'chat-provider-unknown' });
    expect(h.calls).toHaveLength(0);
    expect(h.logs.filter((log) => log.event === 'nl_selection.skipped').map((log) => log.fields?.reason)).toEqual([
      'chat-provider-differs',
      'chat-provider-differs',
      'chat-provider-unknown',
    ]);
    expect(await h.decide('내 지라 이슈', { chatProviderId: 'scripted-selector' })).toMatchObject({ kind: 'execute' });
    expect(h.calls).toHaveLength(1);
  });

  it('skips text over 600 characters without a call', async () => {
    const h = harness({ script: [NONE] });
    expect(await h.decide(`내 지라 이슈 ${'가'.repeat(600)}`)).toEqual({ kind: 'skip', reason: 'too-long' });
    expect(h.calls).toHaveLength(0);
  });

  it('provider down, failure, timeout and malformed output are `unavailable` with no retry', async () => {
    const down = harness({ select: async () => { throw new Error('no provider'); } });
    expect(await down.decide('지라 이슈')).toEqual({ kind: 'unavailable' });
    const failing = harness({ execute: async () => { throw new AiProviderError(AiFailureKind.UNAVAILABLE, 'down'); } });
    expect(await failing.decide('지라 이슈')).toEqual({ kind: 'unavailable' });
    expect(failing.calls).toHaveLength(1);
    const slow = harness({ timeoutMs: 20, execute: () => new Promise((resolve) => setTimeout(() => resolve({ text: NONE }), 200)) });
    expect(await slow.decide('지라 이슈')).toEqual({ kind: 'unavailable' });
    const malformed = harness({ script: ['I think you mean Jira.'] });
    expect(await malformed.decide('지라 이슈')).toEqual({ kind: 'unavailable' });
    expect(malformed.calls).toHaveLength(1);
  });

  it('caches per actor and text for 10 minutes (in memory), so a repeat makes no second call', async () => {
    const h = harness({ script: [NONE] });
    expect(await h.decide('안녕')).toEqual({ kind: 'none' });
    expect(await h.decide('  안녕 ')).toEqual({ kind: 'none' });
    expect(h.calls).toHaveLength(1);
  });

  it('shadow: runs the selection beside the turn, acts on nothing, writes nothing, logs content-free fields only', async () => {
    const h = harness({ mode: 'shadow', script: [out('jira.issues', { keyword: '위클리카' })] });
    expect(await h.decide('위클리카 지라 이슈 보여줘')).toEqual({ kind: 'skip', reason: 'shadow' });
    await h.service.lastShadowRun;
    expect(h.calls).toHaveLength(1);
    expect(h.session.metadata).toBeUndefined();
    const line = h.logs.find((log) => log.event === 'nl_selection.shadow');
    expect(line?.fields).toMatchObject({ entryId: 'jira.issues', grammarId: 'chat', agree: false, outcome: 'CLEAR', cached: false });
    expect(typeof line?.fields?.latencyMs).toBe('number');
    expect(JSON.stringify(h.logs)).not.toMatch(/위클리카|지라|이슈/);
  });
});

describe('NlSelectionService — validation, clarification and follow-ups (D4, D7)', () => {
  it('executes a valid read with canonical args, the resolved range and the basis line, and records lastSelection', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'tomorrow' })] });
    const decision = await h.decide('내일 바빠?');
    expect(decision).toMatchObject({
      kind: 'execute',
      command: { entryId: 'calendar.events', args: { range: 'tomorrow' }, range: { dayOffset: 1 }, language: 'ko' },
      basis: '기준: 내일 일정',
    });
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toEqual({ actorId: 'owner', entryId: 'calendar.events', args: { range: 'tomorrow' }, at: T0 });
  });

  it('`none` is honest chat, and an entry the turn does not offer (an unconfigured source) is too', async () => {
    const h = harness({ script: [NONE, out('mail.list', { unread: true })] });
    expect(await h.decide('안녕')).toEqual({ kind: 'none' });
    expect(await h.decide('안 읽은 메일', { entries: [NL_WAVE1_ENTRIES['jira.issues']] })).toEqual({ kind: 'none' });
  });

  it('NEEDS_CLARIFICATION asks one numbered question; "1" or "지라" resolves it deterministically (no second call)', async () => {
    for (const reply of ['1', '1번', '지라', '지라로']) {
      const h = harness({
        script: [
          JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] }),
        ],
      });
      const asked = await h.decide('내 이슈 보여줘');
      expect(asked.kind).toBe('ask');
      expect((asked as { text: string }).text).toMatch(/^어떤 걸 찾으세요\?\n1\. Jira 이슈 조회 \(.+\)\n2\. GitHub 이슈·PR 조회 \(.+\)\n번호나 이름으로 답해 주세요\.$/);
      expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ kind: 'entry' });
      const answered = await h.decide(reply, { now: at(60_000) });
      expect(answered).toMatchObject({ kind: 'execute', command: { entryId: 'jira.issues' } });
      expect(h.calls).toHaveLength(1);
      expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
    }
  });

  it('a pending question expires after 5 minutes, and an unrelated reply ends it (routed normally)', async () => {
    const ask = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] });
    const h = harness({ script: [ask, NONE] });
    await h.decide('내 이슈');
    expect(await h.decide('1', { now: at(NL_PENDING_TTL_MS + 1) })).toEqual({ kind: 'none' });
    const other = harness({ script: [ask, out('calendar.events')] });
    await other.decide('내 이슈');
    expect(await other.decide('오늘 일정은?', { now: at(1000) })).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events' } });
    expect(other.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
  });

  it('a failed validation never guesses and never chats: it asks with the repaired candidate, or with the usage', async () => {
    const ungrounded = harness({ script: [out('jira.issues', { keyword: '결제' })] });
    const asked = await ungrounded.decide('내 지라 이슈 보여줘');
    expect(asked).toMatchObject({ kind: 'ask' });
    expect((asked as { text: string }).text).toContain('1. Jira 이슈 조회');
    expect(ungrounded.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ options: [{ entryId: 'jira.issues', args: {} }] });
    const missing = harness({ script: [out('slack.search', {})] });
    expect(await missing.decide('슬랙 좀 봐줘')).toEqual({ kind: 'ask', text: 'Slack 검색에서 무엇을 찾을지 정확히 모르겠어요. "Slack에서 배포 검색"처럼 말씀해 주세요.' });
  });

  it('a follow-up refines lastSelection; a keyword grounded only in the previous args is accepted', async () => {
    const h = harness({
      script: [
        out('jira.issues', { window: 'created', range: 'today', role: 'either' }),
        out('jira.issues', { window: 'created', range: 'today', role: 'either', keyword: '위클리카' }),
        out('jira.issues', { window: 'created', range: 'today', role: 'either', keyword: '위클리카', count: true }),
      ],
    });
    await h.decide('오늘 등록된 지라 이슈 담당이든 보고든 다 보여줘');
    expect(await h.decide('그 중에 위클리카만', { now: at(60_000) })).toMatchObject({
      kind: 'execute',
      command: { args: { window: 'created', range: 'today', role: 'either', keyword: '위클리카' } },
      basis: '기준: 내가 담당·보고자 / 오늘 생성 / "위클리카" 포함',
    });
    expect(await h.decide('몇 개야?', { now: at(120_000) })).toMatchObject({ kind: 'execute', command: { args: { keyword: '위클리카', count: true } } });
    expect(h.calls[1]!.prompt).toContain('Previous selection: {"entryId":"jira.issues","args":{"role":"either","window":"created","range":"today"}}');
  });

  it('lastSelection lives 30 minutes and is per actor', async () => {
    const h = harness({ script: [out('jira.issues', { window: 'created', range: 'today', role: 'either' }), NONE] });
    await h.decide('오늘 등록된 지라 이슈 다');
    await h.decide('그 중에 결제만', { now: at(31 * 60_000) });
    expect(h.calls[1]!.prompt).toContain('Previous selection: none');
  });
});

describe('NlSelectionService — the interpretation preference (D7: ask once, 30 days, override)', () => {
  const created = out('jira.issues', { window: 'created', range: 'today' });

  it('asks once, answers with the pick, stores it per actor, then reuses it without asking (owner phrase 1)', async () => {
    const h = harness({ script: [created, created] });
    const asked = await h.decide('오늘 jira 이슈 등록된거 브리핑해줘');
    expect(asked).toEqual({
      kind: 'ask',
      text: '"등록된 이슈"를 어떤 기준으로 볼까요? 한 번 정하면 30일 동안 같은 기준을 쓸게요.\n1. 내가 담당자인 이슈\n2. 내가 보고자(등록자)인 이슈\n3. 둘 다 (담당 또는 보고)\n번호로 답해 주세요.',
    });
    const answered = await h.decide('3', { now: at(30_000) });
    expect(answered).toMatchObject({
      kind: 'execute',
      command: { entryId: 'jira.issues', args: { window: 'created', range: 'today', role: 'either' } },
      basis: '기준: 내가 담당·보고자 / 오늘 생성 (30일 동안 이 기준을 써요. 바꾸려면 "아니 담당만"처럼 말해 주세요)',
    });
    expect(h.actor().metadata?.[INTERPRETATION_PREFERENCES_METADATA_KEY]).toEqual({ 'jira.created-scope': { value: 'either', at: at(30_000) } });
    const again = await h.decide('오늘 jira 이슈 등록된거 브리핑해줘 다시', { now: at(3_600_000) });
    expect(again).toMatchObject({ kind: 'execute', command: { args: { role: 'either' } }, basis: '기준: 내가 담당·보고자 / 오늘 생성' });
  });

  it('answers by name too ("담당", "둘 다요"), and an expired (30 days) or malformed preference is asked again', async () => {
    expect(choiceIndex('담당', [['담당'], ['보고'], ['둘 다']])).toBe(0);
    expect(choiceIndex('둘 다요', [['담당'], ['보고'], ['둘 다']])).toBe(2);
    expect(choiceIndex('2번이요', [['a'], ['b']])).toBe(1);
    expect(choiceIndex('두 번째', [['a'], ['b']])).toBe(1);
    expect(choiceIndex('다음 주 일정', [['담당'], ['보고'], ['다']])).toBeUndefined();
    expect(choiceIndex('5', [['a'], ['b']])).toBeUndefined();

    const h = harness({ script: [created, created] });
    await h.decide('오늘 등록된 지라 이슈');
    await h.decide('담당', { now: at(1000) });
    expect(await h.decide('오늘 등록된 지라 이슈 또', { now: at(INTERPRETATION_PREFERENCE_TTL_MS + 2000) })).toMatchObject({ kind: 'ask' });

    const malformed = harness({ script: [created] });
    await malformed.service.decide({
      text: '오늘 등록된 지라 이슈',
      attachmentCount: 0,
      session: malformed.session,
      actor: { ...malformed.actor(), metadata: { [INTERPRETATION_PREFERENCES_METADATA_KEY]: { 'jira.created-scope': { value: 'watcher', at: T0 } } } },
      now: T0,
      entries: ALL,
      route: 'chat',
      chatProviderId: 'scripted-selector',
    }).then((decision) => expect(decision.kind).toBe('ask'));
  });

  it('an explicit role in the text wins for that answer; correcting the previous answer overwrites the preference', async () => {
    const h = harness({
      script: [
        created,
        out('jira.issues', { window: 'created', range: 'today', role: 'reporter' }),
        out('jira.issues', { window: 'created', range: 'today', role: 'assignee' }),
      ],
    });
    await h.decide('오늘 등록된 지라 이슈');
    await h.decide('3', { now: at(1000) });
    // A fresh explicit value (no matching lastSelection role change… here it differs from `either`) is a correction.
    const reporter = await h.decide('아니 내가 만든 것만', { now: at(2000) });
    expect(reporter).toMatchObject({ command: { args: { role: 'reporter' } }, basis: '기준: 내가 보고자 / 오늘 생성 (기준을 바꿨어요)' });
    expect(h.actor().metadata?.[INTERPRETATION_PREFERENCES_METADATA_KEY]).toMatchObject({ 'jira.created-scope': { value: 'reporter' } });
    const assignee = await h.decide('아니 담당만', { now: at(3000) });
    expect(assignee).toMatchObject({ command: { args: { window: 'created', range: 'today', role: 'assignee' } }, basis: '기준: 내가 담당 / 오늘 생성 (기준을 바꿨어요)' });
    expect(h.actor().metadata?.[INTERPRETATION_PREFERENCES_METADATA_KEY]).toMatchObject({ 'jira.created-scope': { value: 'assignee', at: at(3000) } });
  });

  it('keeps other Actor metadata untouched when it writes the preference (re-read, one key replaced)', async () => {
    const h = harness({ script: [created] });
    const actor = h.actor();
    await h.service.decide({ text: '오늘 등록된 지라 이슈', attachmentCount: 0, session: h.session, actor, now: T0, entries: ALL, route: 'chat', chatProviderId: 'scripted-selector' });
    // Another writer added a key between the turn's snapshot and the answer.
    await (h.service as unknown as { deps: { actors: { save(a: Actor): Promise<Actor> } } }).deps.actors.save({ ...actor, metadata: { other: 1 } });
    await h.decide('1', { now: at(1000) });
    expect(h.actor().metadata).toMatchObject({ other: 1, [INTERPRETATION_PREFERENCES_METADATA_KEY]: { 'jira.created-scope': { value: 'assignee' } } });
  });
});

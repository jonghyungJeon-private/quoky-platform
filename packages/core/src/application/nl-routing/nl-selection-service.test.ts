import { describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '../../errors';
import { AiFailureKind, Capability, type Actor, type IsoTimestamp, type Session } from '../../domain';
import type { AiProvider, AiRequest, LogFields, Logger } from '../../ports';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { buildSelectionPrompt } from './selection-prompt';
import { NL_SELECTION_COLD_TIMEOUT_MS, NL_SELECTION_TIMEOUT_MS, NL_WARMUP_TIMEOUT_MS, NL_WARMUP_PROBE_TEXT, nlWarmupPrompt, NlSelectionService, choiceIndex, resolveChoice, type NlIntentMode, type NlSelectionDecision } from './nl-selection-service';
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
    opts?: { now?: IsoTimestamp; entries?: readonly NlCatalogEntry[]; attachments?: number; chatProviderId?: string | null; quotedRanges?: readonly { start: number; end: number }[] },
  ): Promise<NlSelectionDecision>;
  script: string[];
}

function harness(options: {
  mode?: NlIntentMode;
  script?: string[];
  execute?: (request: AiRequest) => Promise<{ text: string }>;
  select?: () => Promise<AiProvider>;
  timeoutMs?: number;
  elapsed?: () => number;
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
    ...(options.elapsed !== undefined ? { elapsed: options.elapsed } : {}),
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
        ...(opts.quotedRanges !== undefined ? { quotedRanges: opts.quotedRanges } : {}),
        ...(opts.chatProviderId === null ? {} : { chatProviderId: opts.chatProviderId ?? 'scripted-selector' }),
      }),
  } as Harness;
}

describe('NlSelectionService — grammar listings and lastSelection (ADR-0120 follow-up 2)', () => {
  it('records a handler-supplied selection like a selection would (structure only, 30 minutes) and clears it', async () => {
    const h = harness();
    expect(await h.service.recordGrammarSelection({ id: 'sess-1' }, 'owner', { entryId: 'calendar.events', args: { range: 'this-week' } }, T0)).toBe(true);
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toEqual({ actorId: 'owner', entryId: 'calendar.events', args: { range: 'this-week' }, period: { start: '2026-10-12', days: 7 }, at: T0 });
    await h.service.clearLastSelection({ id: 'sess-1' });
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toBeUndefined();
  });

  it('refines the recorded listing: the selector sees it as the previous selection, and it expires after 30 minutes', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'this-week', keyword: '스크럼' }), NONE] });
    await h.service.recordGrammarSelection({ id: 'sess-1' }, 'owner', { entryId: 'calendar.events', args: { range: 'this-week' } }, T0);
    expect(await h.decide('그 중에 스크럼만', { now: at(60_000) })).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼' } } });
    expect(h.calls[0]?.prompt).toContain('Previous selection: {"entryId":"calendar.events","args":{"range":"this-week"}}');
    await h.decide('그 중에 리뷰만', { now: at(40 * 60_000) });
    expect(h.calls[1]?.prompt.split('\n').filter((line) => line.startsWith('Previous selection:')).at(-1)).toBe('Previous selection: none');
  });

  it('amendment A2: grammars may yield only with the flag on, in active, and when the chat turn would reach the selector provider', async () => {
    const withFlag = (mode: NlIntentMode, grammarYield: boolean) => {
      const h = harness({ mode });
      return new NlSelectionService({ ...(h.service as unknown as { deps: ConstructorParameters<typeof NlSelectionService>[0] }).deps, mode, grammarYield });
    };
    expect(await withFlag('active', true).yieldsToSelection('scripted-selector')).toBe(true);
    expect(await withFlag('active', false).yieldsToSelection('scripted-selector')).toBe(false);
    expect(await withFlag('shadow', true).yieldsToSelection('scripted-selector')).toBe(false);
    expect(await withFlag('off', true).yieldsToSelection('scripted-selector')).toBe(false);
    expect(await withFlag('active', true).yieldsToSelection('another-provider')).toBe(false);
    expect(await withFlag('active', true).yieldsToSelection(undefined)).toBe(false);
  });

  it('ignores a selection that is not a closed entry with bounded plain args, and writes nothing outside active', async () => {
    const h = harness();
    expect(await h.service.recordGrammarSelection({ id: 'sess-1' }, 'owner', { entryId: 'jira.write' as never, args: {} }, T0)).toBe(false);
    expect(await h.service.recordGrammarSelection({ id: 'sess-1' }, 'owner', { entryId: 'jira.issues', args: { keyword: 'x'.repeat(300) } }, T0)).toBe(false);
    const shadow = harness({ mode: 'shadow' });
    expect(await shadow.service.recordGrammarSelection({ id: 'sess-1' }, 'owner', { entryId: 'jira.issues', args: {} }, T0)).toBe(false);
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toBeUndefined();
    expect(shadow.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toBeUndefined();
  });
});

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
    expect(h.calls[0]).toMatchObject({ capability: Capability.INTENT_SELECTION, timeoutMs: NL_SELECTION_COLD_TIMEOUT_MS });
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

  it('D6/D8: a model variant of the selector\'s own provider family runs selection; any other family still skips', async () => {
    const h: Harness = harness({
      script: [out('jira.issues')],
      select: async () => ({
        id: 'scripted-selector',
        family: 'scripted-family',
        capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
        isAvailable: async () => true,
        execute: async (request) => {
          h.calls.push(request);
          return { text: h.script.shift() as string, artifacts: [] };
        },
      }),
    });
    expect(await h.decide('내 지라 이슈', { chatProviderId: 'scripted-selector' })).toEqual({ kind: 'skip', reason: 'chat-provider-differs' });
    expect(await h.decide('내 지라 이슈', { chatProviderId: 'ollama-cli' })).toEqual({ kind: 'skip', reason: 'chat-provider-differs' });
    expect(await h.decide('내 지라 이슈', { chatProviderId: 'scripted-family' })).toMatchObject({ kind: 'execute' });
    expect(h.calls).toHaveLength(1);
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

  describe('cold-start-aware selector bound', () => {
    const MIN = 60_000;
    /** A call that never returns, so only the bound ends it; returns the bound the service used. */
    async function boundAt(h: Harness, advance: (ms: number) => void): Promise<number> {
      const pending = h.decide('지라 이슈');
      await vi.advanceTimersByTimeAsync(0);
      const bound = h.calls.at(-1)!.timeoutMs!;
      advance(0);
      await vi.advanceTimersByTimeAsync(bound);
      expect(await pending).toEqual({ kind: 'unavailable' });
      return bound;
    }
    function timed(timeoutMs?: number) {
      const h = harness({ ...(timeoutMs !== undefined ? { timeoutMs } : {}), elapsed: () => Date.now(), execute: () => new Promise(() => undefined) });
      return h;
    }

    it('uses 8000 ms during the first 180 s, then the configured bound; timeout still falls back with no retry and logs content-free timing', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        const h = timed();
        vi.setSystemTime(1_000_000 + 60_000);
        expect(await boundAt(h, () => undefined)).toBe(8_000);
        expect(h.calls).toHaveLength(1);
        const line = h.logs.find((log) => log.event === 'nl_selection.decided')!;
        expect(line.fields).toMatchObject({ outcome: 'unavailable', cause: 'timeout', boundMs: 8_000, sinceStartMs: 60_000, idleMs: 60_000 });
        expect(typeof line.fields!.promptChars).toBe('number');
        expect(JSON.stringify(line.fields)).not.toContain('지라');
        // The timeout is not a completed call: idle still counts from start. 200 s after start with no completed call is
        // idle 200 s (< 30 min) and past the start window: the configured 6 s.
        vi.setSystemTime(1_000_000 + 200_000);
        expect(await boundAt(h, () => undefined)).toBe(NL_SELECTION_TIMEOUT_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses 8000 ms after more than 30 min since the last completed call, 6000 ms just inside it', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        let hang = false;
        const h = harness({ elapsed: () => Date.now(), execute: () => (hang ? new Promise(() => undefined) : Promise.resolve({ text: NONE })) });
        vi.setSystemTime(10 * MIN);
        expect(await h.decide('안녕 하나')).toEqual({ kind: 'none' }); // completes at 10 min
        hang = true;
        vi.setSystemTime(10 * MIN + 30 * MIN); // exactly 30 min idle: not more than
        expect(await boundAt(h, () => undefined)).toBe(NL_SELECTION_TIMEOUT_MS);
        // The timed-out call did not complete, so idle keeps counting from the 10 min mark.
        vi.setSystemTime(10 * MIN + 30 * MIN + 1_000 + 6_000 + 1);
        expect(await boundAt(h, () => undefined)).toBe(NL_SELECTION_COLD_TIMEOUT_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a provider-reported TIMEOUT rejection does not reset the idle clock', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        let mode: 'ok' | 'timeout' | 'hang' = 'ok';
        const h = harness({
          elapsed: () => Date.now(),
          execute: () => (mode === 'ok' ? Promise.resolve({ text: NONE }) : mode === 'timeout' ? Promise.reject(new AiProviderError(AiFailureKind.TIMEOUT, 'slow')) : new Promise(() => undefined)),
        });
        vi.setSystemTime(10 * MIN);
        expect(await h.decide('안녕 하나')).toEqual({ kind: 'none' });
        mode = 'timeout';
        vi.setSystemTime(41 * MIN); // idle 31 min: cold
        expect(await h.decide('지라 이슈')).toEqual({ kind: 'unavailable' });
        expect(h.calls.at(-1)!.timeoutMs).toBe(NL_SELECTION_COLD_TIMEOUT_MS);
        mode = 'hang';
        vi.setSystemTime(41 * MIN + 1_000); // still 31 min since the last COMPLETED call
        expect(await boundAt(h, () => undefined)).toBe(NL_SELECTION_COLD_TIMEOUT_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a configured bound below 6 s stays as configured outside the windows; a bound of 8000 stays 8000', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const small = timed(3_000);
        vi.setSystemTime(200_000);
        expect(await boundAt(small, () => undefined)).toBe(3_000);
        const max = timed(8_000);
        vi.setSystemTime(400_000);
        expect(await boundAt(max, () => undefined)).toBe(8_000);
        const cold = timed(3_000);
        vi.setSystemTime(400_000 + 1_000);
        expect(await boundAt(cold, () => undefined)).toBe(8_000);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('provider down, failure, timeout and malformed output are `unavailable` with no retry', async () => {
    const down = harness({ select: async () => { throw new Error('no provider'); } });
    expect(await down.decide('지라 이슈')).toEqual({ kind: 'unavailable' });
    const failing = harness({ execute: async () => { throw new AiProviderError(AiFailureKind.UNAVAILABLE, 'down'); } });
    expect(await failing.decide('지라 이슈')).toEqual({ kind: 'unavailable' });
    expect(failing.calls).toHaveLength(1);
    let clock = 0;
    const slow = harness({ timeoutMs: 20, elapsed: () => clock, execute: () => new Promise((resolve) => setTimeout(() => resolve({ text: NONE }), 200)) });
    clock = 200_000;
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
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toEqual({ actorId: 'owner', entryId: 'calendar.events', args: { range: 'tomorrow' }, period: { start: '2026-10-13', days: 1 }, at: T0 });
  });

  it('`none` is honest chat, and an entry the turn does not offer (an unconfigured source) is too', async () => {
    const h = harness({ script: [NONE, out('mail.list', { unread: true })] });
    expect(await h.decide('안녕')).toEqual({ kind: 'none' });
    expect(await h.decide('안 읽은 메일', { entries: [NL_WAVE1_ENTRIES['jira.issues']] })).toEqual({ kind: 'none' });
  });

  it('Codex P2 (2026-10-27): each clarification candidate is grounded against its own listing (P7 history), so an earlier listing keeps its carried keyword', async () => {
    const h = harness({
      script: [
        out('calendar.events', { range: 'this-week', keyword: '스크럼' }),
        out('jira.issues', { keyword: '청구서' }),
        JSON.stringify({ entryId: 'jira.issues', args: { keyword: '청구서', count: true }, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼', count: true } }] }),
      ],
    });
    await h.decide('이번 주 스크럼 일정');
    await h.decide('청구서 지라 이슈');
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toMatchObject({ entryId: 'jira.issues', earlier: [{ entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼' } }] });
    expect((await h.decide('몇 개야?')).kind).toBe('ask');
    // Both options keep their own listing's args: the calendar option is the 스크럼 listing, not the broader calendar.
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({
      options: [
        { entryId: 'jira.issues', args: { keyword: '청구서', count: true } },
        { entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼', count: true } },
      ],
    });
    // Choosing the calendar option counts the 스크럼 listing.
    expect(await h.decide('2')).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼', count: true } } });
  });

  it('owner decision P-time (ii): a calendar question with no date or period inherits the held calendar listing\'s range; an explicit period wins', async () => {
    const h = harness({
      script: [
        out('calendar.events', { range: 'tomorrow' }),
        out('calendar.events', { keyword: '면접' }),
        out('todo.list'),
        out('calendar.events', { keyword: '면접' }),
        out('calendar.events', { keyword: '면접' }),
      ],
    });
    await h.decide('내일 일정 보여줘');
    // The selector left the range out; the owner named no period: tomorrow is kept.
    expect(await h.decide('그 면접 몇 시였지?')).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { range: 'tomorrow', keyword: '면접' } } });
    // After another listing in between, the earlier calendar listing (P7) is the held one.
    await h.decide('내 할 일 보여줘');
    expect(await h.decide('그 면접 어디서 해?')).toMatchObject({ kind: 'execute', command: { args: { range: 'tomorrow', keyword: '면접' } } });
    // An explicit period wins: "오늘" is the owner's (today is the default, so canonical args omit it).
    const today = await h.decide('오늘 면접 몇 시야?');
    expect(today).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { keyword: '면접' } } });
    expect((today as { command: { args: Record<string, unknown> } }).command.args).not.toHaveProperty('range');
  });

  it('Codex P2 (2026-10-27): the inherited period is the listing\'s own dates, never its symbol re-resolved after midnight', async () => {
    const beforeMidnight = '2026-10-27T14:55:00.000Z' as never; // 23:55 Asia/Seoul
    const afterMidnight = '2026-10-27T15:05:00.000Z' as never; // 00:05 Asia/Seoul, the next day
    const h = harness({ script: [out('calendar.events', { range: 'tomorrow' }), out('calendar.events', { keyword: '면접' }), out('calendar.events', { keyword: '면접' })] });
    expect(await h.decide('내일 일정 보여줘', { now: beforeMidnight })).toMatchObject({ command: { range: { startDate: { year: 2026, month: 10, day: 28 } } } });
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toMatchObject({ args: { range: 'tomorrow' }, period: { start: '2026-10-28', days: 1 } });
    // After midnight "tomorrow" would be 10-29: the listing showed 10-28, and that is what the follow-up reads.
    const after = await h.decide('그 면접 어디서 해?', { now: afterMidnight });
    expect(after).toMatchObject({ kind: 'execute', command: { args: { range: '2026-10-28', keyword: '면접' }, range: { startDate: { year: 2026, month: 10, day: 28 }, days: 1 } } });
    // Before midnight the symbol still names the shown dates and is kept as written.
    const same = harness({ script: [out('calendar.events', { range: 'tomorrow' }), out('calendar.events', { keyword: '면접' })] });
    await same.decide('내일 일정 보여줘', { now: beforeMidnight });
    expect(await same.decide('그 면접 어디서 해?', { now: '2026-10-27T14:58:00.000Z' as never })).toMatchObject({ command: { args: { range: 'tomorrow' } } });
  });

  it('Codex P2: a default-today listing shown before midnight is still that day after it', async () => {
    const h = harness({ script: [out('calendar.events'), out('calendar.events', { keyword: '면접' })] });
    await h.decide('일정 보여줘', { now: '2026-10-27T14:55:00.000Z' as never });
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toMatchObject({ period: { start: '2026-10-27', days: 1 } });
    expect(await h.decide('그 면접 몇 시였지?', { now: '2026-10-27T15:05:00.000Z' as never })).toMatchObject({ command: { args: { range: '2026-10-27' }, range: { startDate: { day: 27 } } } });
  });

  it('P-time (ii): without a held calendar listing nothing is inherited', async () => {
    const h = harness({ script: [out('calendar.events', { keyword: '면접' })] });
    const decision = await h.decide('그 면접 몇 시였지?');
    expect((decision as { command: { args: Record<string, unknown> } }).command.args).toEqual({ keyword: '면접' });
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

  it('resolves clarification answers strictly (numbers, ordinals, exact names; negation; no prefix match; cancel)', () => {
    const options = [['Jira 이슈 조회', 'jira', '지라', '이슈'], ['GitHub 이슈·PR 조회', 'github', '깃허브']];
    expect(resolveChoice('첫 번째 말고 두 번째', options)).toEqual({ kind: 'pick', index: 1 });
    expect(resolveChoice('2번', options)).toEqual({ kind: 'pick', index: 1 });
    expect(resolveChoice('두번째', options)).toEqual({ kind: 'pick', index: 1 });
    expect(resolveChoice('아니 1', options)).toEqual({ kind: 'pick', index: 0 });
    expect(resolveChoice('지라', options)).toEqual({ kind: 'pick', index: 0 });
    expect(resolveChoice('지라로 해줘', options)).toEqual({ kind: 'pick', index: 0 });
    expect(resolveChoice('GitHub 이슈·PR 조회', options)).toEqual({ kind: 'pick', index: 1 });
    expect(resolveChoice('1번 말고', options)).toEqual({ kind: 'pick', index: 1 });
    expect(resolveChoice('not 1', options)).toEqual({ kind: 'pick', index: 1 });
    expect(resolveChoice('둘 다 아니야', options)).toEqual({ kind: 'cancel' });
    expect(resolveChoice('취소', options)).toEqual({ kind: 'cancel' });
    expect(resolveChoice('1이랑 2', options)).toEqual({ kind: 'unclear' });
    expect(resolveChoice('3번', options)).toEqual({ kind: 'unclear' });
    // Never a prefix match inside a longer sentence: these are new requests.
    expect(resolveChoice('지라 이슈 다시 보여줘', options)).toEqual({ kind: 'none' });
    expect(resolveChoice('1분 뒤에 알려줘', options)).toEqual({ kind: 'none' });
    expect(resolveChoice('다음 주 일정', [['담당'], ['보고'], ['둘 다', '다']])).toEqual({ kind: 'none' });
    expect(resolveChoice('담당만', [['담당'], ['보고'], ['둘 다', '다']])).toEqual({ kind: 'pick', index: 0 });
    expect(resolveChoice('둘 다요', [['담당'], ['보고'], ['둘 다', '다']])).toEqual({ kind: 'pick', index: 2 });
  });

  it('a quoted "1" is not an answer: neither a platform range nor a > line resolves the open question', async () => {
    const ask = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] });
    const h = harness({ script: [ask] });
    await h.decide('내 이슈');
    expect(await h.decide('1', { now: at(1000), quotedRanges: [{ start: 0, end: 1 }] })).toEqual({ kind: 'skip', reason: 'empty' });
    expect(h.calls).toHaveLength(1);
    const again = harness({ script: [ask] });
    await again.decide('내 이슈');
    expect(await again.decide('> 1', { now: at(1000) })).toEqual({ kind: 'skip', reason: 'empty' });
    expect(again.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
  });

  it('picking a clarification option keeps the explicit role the original turn named', async () => {
    const ask = JSON.stringify({
      entryId: 'jira.issues',
      args: { window: 'created', range: 'today', role: 'reporter' },
      ambiguity: 'NEEDS_CLARIFICATION',
      alternatives: [{ entryId: 'github.items', args: {} }],
    });
    const h = harness({ script: [ask] });
    expect(await h.decide('내가 보고한 이슈 중 오늘 등록된 거')).toMatchObject({ kind: 'ask' });
    expect(await h.decide('지라', { now: at(1000) })).toMatchObject({
      kind: 'execute',
      command: { entryId: 'jira.issues', args: { window: 'created', role: 'reporter' } },
    });
  });

  it('a negated answer, a cancel and an unclear answer are handled end to end without a second call', async () => {
    const ask = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] });
    const h = harness({ script: [ask, ask] });
    await h.decide('내 이슈');
    expect(await h.decide('첫 번째 말고 두 번째', { now: at(1000) })).toMatchObject({ kind: 'execute', command: { entryId: 'github.items' } });
    await h.decide('내 이슈 다시', { now: at(2000) });
    expect(await h.decide('1이랑 2', { now: at(3000) })).toMatchObject({ kind: 'ask', text: expect.stringContaining('어떤 걸 찾으세요?') });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ kind: 'entry' });
    expect(await h.decide('둘 다 아니야', { now: at(4000) })).toEqual({ kind: 'ask', text: '알겠어요, 선택을 취소했어요. 필요하면 다시 말씀해 주세요.' });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
    expect(h.calls).toHaveLength(2);
  });

  it('takePending clears the open question at the start of any turn and hands it to decide (active only)', async () => {
    const ask = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] });
    const h = harness({ script: [ask] });
    await h.decide('내 이슈');
    const snapshot = h.session;
    const taken = await h.service.takePending(snapshot, 'owner', at(1000));
    expect(taken).toMatchObject({ kind: 'entry' });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
    // The answer turn gets the taken question even though its session snapshot predates the clear.
    expect(
      await h.service.decide({ text: '2', attachmentCount: 0, session: snapshot, actor: h.actor(), now: at(1000), entries: ALL, route: 'chat', chatProviderId: 'scripted-selector', pending: taken }),
    ).toMatchObject({ kind: 'execute', command: { entryId: 'github.items' } });
    expect(await h.service.takePending(h.session, 'owner', at(2000))).toBeNull();
    expect(await harness({ mode: 'shadow' }).service.takePending(snapshot, 'owner', at(1000))).toBeNull();
  });

  it('takePending is atomic: two concurrent takes hand the question to exactly one', async () => {
    const ask = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] });
    const h = harness({ script: [ask] });
    await h.decide('내 이슈');
    const snapshot = h.session;
    const taken = await Promise.all([h.service.takePending(snapshot, 'owner', at(1000)), h.service.takePending(snapshot, 'owner', at(1000))]);
    expect(taken.filter((question) => question !== null)).toHaveLength(1);
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
  });

  it('a failed clear fails closed: the question is not handed out and logs stay content-free', async () => {
    const ask = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] });
    const h = harness({ script: [ask] });
    await h.decide('내 이슈');
    const snapshot = h.session;
    const failing = new NlSelectionService({
      mode: 'active',
      router: { select: async () => { throw new Error('unused'); } },
      sessions: { async updateMetadataEntry() { throw new Error('secret 내 이슈'); } },
      actors: { async get() { return h.actor(); }, async save(next) { return next; } },
      timeZone: 'Asia/Seoul',
      logger: { info() {}, warn: (event, fields) => void h.logs.push({ level: 'warn', event, ...(fields ? { fields } : {}) }), error() {} },
    });
    expect(await failing.takePending(snapshot, 'owner', at(1000))).toBeNull();
    expect(JSON.stringify(h.logs)).not.toContain('secret');
    expect(JSON.stringify(h.logs)).not.toContain('내 이슈');
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
    expect(await missing.decide('슬랙 좀 봐줘')).toEqual({ kind: 'ask', entryId: expect.any(String), text: 'Slack 검색에서 무엇을 찾을지 정확히 모르겠어요. "Slack에서 배포 검색"처럼 말씀해 주세요.' });
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

  it('CA review: a jira.release fallback names the default in the basis line ("내 담당"); a Jira status fallback with a window says 미해결', async () => {
    const release = harness({ script: [out('jira.release', { release: '1.4.0', scope: 'all' })] });
    expect(await release.decide('이번 1.4.0 릴리즈에 포함된 지라 티켓 다 보여줘')).toMatchObject({ kind: 'execute', command: { entryId: 'jira.release', args: { release: '1.4.0' } }, basis: '기준: 릴리스 "1.4.0" / 내 담당' });
    const issues = harness({ script: [out('jira.issues', { window: 'updated', range: 'today', status: 'in-progress' })] });
    expect(await issues.decide('오늘 업데이트된 지라 이슈 보여줘')).toMatchObject({ kind: 'execute', command: { args: { window: 'updated', range: 'today' } }, basis: expect.stringContaining('미해결') });
    // Without a fallback the window line stays as before (no status label).
    const plain = harness({ script: [out('jira.issues', { window: 'updated', range: 'today' })] });
    expect(await plain.decide('오늘 업데이트된 지라 이슈 보여줘')).toMatchObject({ kind: 'execute', basis: expect.not.stringContaining('미해결') });
  });

  it('Codex P2: a fallback never restores a value from the previous selection of another entry', async () => {
    const h = harness({ script: [out('todo.list', { status: 'all' }), out('jira.issues', { status: 'in-progress' })] });
    expect(await h.decide('할 일 전부 보여줘')).toMatchObject({ kind: 'execute', command: { entryId: 'todo.list', args: { status: 'all' } } });
    expect(await h.decide('내 지라 이슈 보여줘', { now: at(60_000) })).toMatchObject({ kind: 'execute', command: { entryId: 'jira.issues', args: {} } });
  });

  it('refines a Jira listing to in-progress ("그 중에 진행중인거만") and a calendar listing by a title keyword, keeping the range', async () => {
    const jira = harness({ script: [out('jira.issues', {}), out('jira.issues', { status: 'in-progress' }), out('jira.issues', { status: 'in-progress' })] });
    await jira.decide('내 지라 이슈 보여줘');
    expect(await jira.decide('그 중에 진행중인거만', { now: at(60_000) })).toMatchObject({
      kind: 'execute',
      command: { args: { status: 'in-progress' } },
      basis: '기준: 내가 담당 / 진행 중',
    });
    // the status carries over once stated; a model guess without the owner saying it falls back to the default (open)
    expect(await jira.decide('그 중에 하나만', { now: at(120_000) })).toMatchObject({ kind: 'execute', command: { args: { status: 'in-progress' } } });
    const guessed = harness({ script: [out('jira.issues', { status: 'in-progress' })] });
    expect(await guessed.decide('내 지라 이슈 보여줘')).toMatchObject({ kind: 'execute', command: { entryId: 'jira.issues', args: {} } });

    const calendar = harness({ script: [out('calendar.events', { range: 'this-week' }), out('calendar.events', { range: 'this-week', keyword: '스크럼' })] });
    await calendar.decide('이번 주 일정 알려줘');
    expect(await calendar.decide('그 중에 스크럼만', { now: at(60_000) })).toMatchObject({
      kind: 'execute',
      command: { entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼' } },
      basis: expect.stringContaining('"스크럼" 포함'),
    });
  });

  it('a count follow-up with no previous selection asks the numbered entry question, and the picked entry counts', async () => {
    const ask = JSON.stringify({
      entryId: 'jira.issues',
      args: { count: true },
      ambiguity: 'NEEDS_CLARIFICATION',
      alternatives: [{ entryId: 'calendar.events', args: { count: true } }],
    });
    const h = harness({ script: [ask] });
    const asked = await h.decide('그거 몇 개야');
    expect(asked).toMatchObject({ kind: 'ask', text: expect.stringMatching(/^어떤 걸 찾으세요\?\n1\. Jira 이슈 조회/) });
    expect(await h.decide('2', { now: at(1000) })).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { count: true } } });
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
      kind: 'ask', entryId: expect.any(String),
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

  it.each(['오늘 등록된 지라 이슈 보고 싶어', '오늘 등록된 지라 이슈 보고해줘'])(
    'the bare word 보고 (see / report to) does not ground the reporter role: %s',
    async (text) => {
      const h = harness({ script: [out('jira.issues', { window: 'created', range: 'today', role: 'reporter' })] });
      expect(await h.decide(text)).toMatchObject({ kind: 'ask' });
    },
  );

  it.each(['내가 보고한 이슈 중 오늘 등록된 거', '보고자가 나인 오늘 등록된 이슈', 'issues where I am the reporter, created today', 'issues I reported, created today'])(
    'a reporter word grounds the reporter role: %s',
    async (text) => {
      const h = harness({ script: [out('jira.issues', { window: 'created', range: 'today', role: 'reporter' })] });
      expect(await h.decide(text)).toMatchObject({ kind: 'execute', command: { args: { role: 'reporter' } } });
    },
  );

  it('a role the selector guessed (not in the owner\'s words) neither answers nor overwrites the preference', async () => {
    const h = harness({
      script: [created, out('jira.issues', { window: 'created', range: 'today', role: 'assignee' })],
    });
    await h.decide('오늘 등록된 지라 이슈');
    await h.decide('3', { now: at(1000) });
    const stored = h.actor().metadata?.[INTERPRETATION_PREFERENCES_METADATA_KEY];
    // A new conversation: no lastSelection; the selector adds role "assignee" the owner never said.
    const fresh = await h.service.decide({
      text: '오늘 등록된 jira 다시',
      attachmentCount: 0,
      session: { ...h.session, metadata: {} },
      actor: h.actor(),
      now: at(60_000),
      entries: ALL,
      route: 'chat',
      chatProviderId: 'scripted-selector',
    });
    expect(fresh).toMatchObject({ kind: 'execute', command: { args: { window: 'created', range: 'today', role: 'either' } }, basis: '기준: 내가 담당·보고자 / 오늘 생성' });
    expect(h.actor().metadata?.[INTERPRETATION_PREFERENCES_METADATA_KEY]).toEqual(stored);
    expect(h.logs.some((log) => log.event === 'nl_selection.ungrounded_interpretation')).toBe(true);
  });

  it('a guessed role with no stored preference asks the question instead of answering with the guess', async () => {
    const h = harness({ script: [out('jira.issues', { window: 'created', range: 'today', role: 'reporter' })] });
    expect(await h.decide('오늘 등록된 지라 이슈 다시')).toMatchObject({ kind: 'ask' });
    expect(h.actor().metadata).toBeUndefined();
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

describe('NlSelectionService — startup warm-up (ADR-0120 A3 follow-up)', () => {
  it('fires once in active with the fixed content-free prompt and the generous bound, and logs only outcome and latency', async () => {
    const h = harness({ execute: async () => ({ text: '{}' }) });
    expect(await h.service.warmUp()).toBe('ok');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ capability: Capability.INTENT_SELECTION, timeoutMs: NL_WARMUP_TIMEOUT_MS });
    expect(h.calls[0]?.prompt).toBe(nlWarmupPrompt());
    expect(nlWarmupPrompt()).toBe(buildSelectionPrompt({ entries: [], text: NL_WARMUP_PROBE_TEXT }));
    const warm = h.logs.filter((entry) => entry.event === 'nl_selection.warmup');
    expect(warm).toHaveLength(1);
    expect(Object.keys(warm[0]?.fields ?? {}).sort()).toEqual(['latencyMs', 'outcome']);
    expect(warm[0]?.fields).toMatchObject({ outcome: 'ok' });
  });

  it('never fires in off mode', async () => {
    const h = harness({ mode: 'off' });
    expect(await h.service.warmUp()).toBe('skipped');
    expect(h.calls).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
  });

  it('is skipped when the selector family differs from the given chat provider', async () => {
    const h = harness();
    expect(await h.service.warmUp({ chatProviderId: 'other-family' })).toBe('skipped');
    expect(h.calls).toHaveLength(0);
  });

  it('logs a failure or a missing provider without throwing', async () => {
    const failing = harness({ execute: async () => { throw new Error('boom'); } });
    await expect(failing.service.warmUp()).resolves.toBe('error');
    expect(failing.logs.find((entry) => entry.event === 'nl_selection.warmup')?.fields).toMatchObject({ outcome: 'error' });
    const none = harness({ select: async () => { throw new Error('no provider'); } });
    await expect(none.service.warmUp()).resolves.toBe('error');
  });

  it('logs a timeout without throwing', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ execute: () => new Promise(() => undefined) });
      const run = h.service.warmUp();
      await vi.advanceTimersByTimeAsync(NL_WARMUP_TIMEOUT_MS + 1);
      await expect(run).resolves.toBe('timeout');
      expect(h.logs.find((entry) => entry.event === 'nl_selection.warmup')?.fields).toMatchObject({ outcome: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NlSelectionService — warm-up cancellation and timer (ADR-0120 A3 follow-up)', () => {
  it('passes the abort signal to the provider and starts no call when already aborted or aborted while resolving', async () => {
    const h = harness({ execute: async () => ({ text: '{}' }) });
    const controller = new AbortController();
    await h.service.warmUp({ signal: controller.signal });
    expect(h.calls[0]?.signal).toBe(controller.signal);
    controller.abort();
    expect(await h.service.warmUp({ signal: controller.signal })).toBe('skipped');
    const late = new AbortController();
    const h2 = harness({ select: async () => { late.abort(); return { id: 'scripted-selector', capabilities: [], isAvailable: async () => true, execute: async () => ({ text: '', artifacts: [] }) } as unknown as AiProvider; } });
    expect(await h2.service.warmUp({ signal: late.signal })).toBe('skipped');
    expect(h2.calls).toHaveLength(0);
  });

  it('unrefs the 20 s warm-up timer, leaving no ref\'d timer behind', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ execute: async () => ({ text: '{}' }) });
      await h.service.warmUp();
      expect(vi.getTimerCount()).toBe(0);
      const unref = vi.spyOn(globalThis, 'setTimeout');
      await h.service.warmUp();
      const timers = unref.mock.results.map((r) => r.value as { hasRef?: () => boolean });
      expect(timers.some((timer) => timer.hasRef?.() === false)).toBe(true);
      unref.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ADR-0120 A5 implementation note 2: a period that loses the owner\'s weekday asks, never answers another day', () => {
  it('"다음 주 수 일정 있어?" read as next Monday or the whole week asks with the usage (no repaired option); next-wed executes', async () => {
    for (const range of ['next-mon', 'next-week']) {
      const h = harness({ script: [out('calendar.events', { range })] });
      const decision = await h.decide('다음 주 수 일정 있어?');
      expect(decision, range).toMatchObject({ kind: 'ask' });
      expect(h.session.metadata?.[NL_PENDING_METADATA_KEY], range).toBeUndefined();
      expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY], range).toBeUndefined();
      expect(h.logs.find((log) => log.event === 'nl_selection.validation_failed')?.fields, range).toMatchObject({ entryId: 'calendar.events', reason: 'weekday', arg: 'range' });
    }
    const ok = harness({ script: [out('calendar.events', { range: 'next-wed' })] });
    expect(await ok.decide('다음 주 수 일정 있어?')).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { range: 'next-wed' } } });
  });

  it('the question names the week and the day, and an identical retry calls the selector again (no cached refusal)', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'next-mon' }), out('calendar.events', { range: 'next-wed' })] });
    expect(await h.decide('다음 주 수 일정 있어?')).toEqual({
      kind: 'ask', entryId: expect.any(String),
      text: '캘린더 일정 조회에서 어느 날을 볼지 정확히 모르겠어요. "다음 주 수요일"처럼 주와 요일을 함께 말씀해 주세요.',
    });
    expect(await h.decide('다음 주 수 일정 있어?', { now: at(1000) })).toMatchObject({ kind: 'execute', command: { args: { range: 'next-wed' } } });
    expect(h.calls).toHaveLength(2);
  });

  it('a future mail range repaired by dropping it then loses the weekday: asked with the weekday hint, no option', async () => {
    const h = harness({ script: [out('mail.list', { range: 'next-wed' }), out('mail.list', { range: 'last-wed' })] });
    const asked = await h.decide('지난주 수에 온 메일');
    expect(asked).toMatchObject({ kind: 'ask', text: expect.stringContaining('주와 요일을 함께') });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
    // The refusal reached through the repair is not cached: the identical retry asks the selector again.
    expect(await h.decide('지난주 수에 온 메일', { now: at(1000) })).toMatchObject({ kind: 'execute', command: { entryId: 'mail.list', args: { range: 'last-wed' } } });
    expect(h.calls).toHaveLength(2);
  });

  it('live 2026-10-14 16:48: the weekday read as a keyword ("다음 주" + keyword "수") asks with the weekday hint too', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'next-week', keyword: '수' }), out('calendar.events', { range: 'next-wed' })] });
    expect(await h.decide('다음 주 수 일정 있어?')).toEqual({
      kind: 'ask', entryId: expect.any(String),
      text: '캘린더 일정 조회에서 어느 날을 볼지 정확히 모르겠어요. "다음 주 수요일"처럼 주와 요일을 함께 말씀해 주세요.',
    });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toBeUndefined();
    expect(h.logs.find((log) => log.event === 'nl_selection.validation_failed')?.fields).toMatchObject({ entryId: 'calendar.events', reason: 'time-keyword', arg: 'keyword' });
    expect(await h.decide('다음 주 수 일정 있어?', { now: at(1000) })).toMatchObject({ kind: 'execute', command: { args: { range: 'next-wed' } } });
    expect(h.calls).toHaveLength(2);
  });

  it('a weekday refusal with a valid alternative keeps the weekday hint above the numbered options (Codex P2)', async () => {
    const h = harness({
      script: [out('calendar.events', { range: 'next-mon' }, { ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'calendar.events', args: { range: 'next-wed' } }] })],
    });
    const asked = await h.decide('다음 주 수 일정 있어?');
    expect(asked).toMatchObject({ kind: 'ask' });
    const text = (asked as { text: string }).text;
    expect(text.startsWith('캘린더 일정 조회에서 어느 날을 볼지 정확히 모르겠어요. "다음 주 수요일"처럼 주와 요일을 함께 말씀해 주세요.\n')).toBe(true);
    expect(text).toContain('1. ');
    expect(text).not.toContain('2. ');
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeDefined();
    // Without a weekday refusal the numbered question is unchanged.
    const plain = harness({
      script: [out('calendar.events', { range: 'tomorrow' }, { ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'jira.issues', args: {} }] })],
    });
    expect((await plain.decide('내일 일정 알려줘')) as { text: string }).toMatchObject({ text: expect.stringMatching(/^어떤 걸 찾으세요\?\n/) });
  });

  it('a refused time keyword without a weekday form keeps the usage question, even when the message names the day', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'next-wed', keyword: '오후' })] });
    const asked = await h.decide('다음 주 수요일 오후 일정');
    expect(asked).toEqual({ kind: 'ask', entryId: expect.any(String), text: '캘린더 일정 조회에서 무엇을 찾을지 정확히 모르겠어요. "오늘 일정"처럼 말씀해 주세요.' });
    expect(h.logs.find((log) => log.event === 'nl_selection.validation_failed')?.fields).toMatchObject({ reason: 'time-keyword', arg: 'keyword' });
    const full = harness({ script: [out('calendar.events', { range: 'next-week', keyword: '수요일' })] });
    expect(await full.decide('다음 주 수요일 일정')).toMatchObject({ kind: 'ask', text: expect.stringContaining('주와 요일을 함께') });
  });

  it('a time word taken as a keyword in a message that names no weekday keeps the usage question', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'tomorrow', keyword: '내일 오후' })] });
    expect(await h.decide('내일 오후 일정 알려줘')).toEqual({
      kind: 'ask', entryId: expect.any(String),
      text: '캘린더 일정 조회에서 무엇을 찾을지 정확히 모르겠어요. "오늘 일정"처럼 말씀해 주세요.',
    });
  });
});

describe('ADR-0120 amendment A7: until-<weekday> and the clear past-tense statement', () => {
  it('"이번 주 금요일까지 일정" read as Friday alone executes today through Friday, stored as until-fri', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'this-fri' })] });
    const decision = await h.decide('이번 주 금요일까지 일정');
    expect(decision).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { range: 'until-fri' }, range: { days: 5 } } });
    expect(JSON.stringify(h.session.metadata?.[LAST_SELECTION_METADATA_KEY])).toContain('until-fri');
  });

  it('a clear past-tense statement is chat: no question, no lastSelection, a content-free log line', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'yesterday' }), out('calendar.events', { range: 'yesterday' }, { ambiguity: 'NEEDS_CLARIFICATION' })] });
    expect(await h.decide('어제 일정 있었는데 까먹었어 ㅠ')).toEqual({ kind: 'none' });
    expect(await h.decide('오늘 일정 꽉 찼었어', { now: at(1000) })).toEqual({ kind: 'none' });
    expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY]).toBeUndefined();
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
    const lines = h.logs.filter((log) => log.event === 'nl_selection.statement');
    expect(lines.map((log) => log.fields)).toEqual([{ entryId: 'calendar.events' }, { entryId: 'calendar.events' }]);
    expect(JSON.stringify(h.logs)).not.toMatch(/까먹|꽉/);
  });

  it('shadow sees what active does: a statement is none and agrees with chat', async () => {
    const h = harness({ mode: 'shadow', script: [out('calendar.events', { range: 'yesterday' })] });
    expect(await h.decide('어제 일정 있었는데 까먹었어 ㅠ')).toEqual({ kind: 'skip', reason: 'shadow' });
    await h.service.lastShadowRun;
    expect(h.logs.find((log) => log.event === 'nl_selection.shadow')?.fields).toMatchObject({ entryId: 'calendar.events', agree: true, outcome: 'none' });
  });

  it('A7 span canonical form: "다음 주 월요일부터 금요일까지" read as next week executes Monday..Friday (live 2026-10-15)', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'next-week' })] });
    expect(await h.decide('다음 주 월요일부터 금요일까지 일정')).toMatchObject({
      kind: 'execute',
      command: { entryId: 'calendar.events', args: { range: '10-19..10-23' }, range: { days: 5 } },
    });
  });

  it('A7 span canonical form: a previous selection and a next-mon pick still execute Monday..Friday (live probe)', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'this-week' }), out('calendar.events', { range: 'next-mon' })] });
    await h.decide('이번 주 일정');
    expect(await h.decide('다음 주 월요일부터 금요일까지 일정', { now: at(60_000) })).toMatchObject({
      kind: 'execute',
      command: { entryId: 'calendar.events', args: { range: '10-19..10-23' }, range: { days: 5 } },
    });
  });

  it('A7 span repeat (live 2026-10-15 10:44): the same sentence again after a narrowed span executes for every probed pick', async () => {
    // Probe, previous = the stored span (60 calls): next-mon 37, 10-19..10-23 17, next-week 6; each must execute.
    for (const pick of ['next-mon', '10-19..10-23', 'next-week']) {
      const h = harness({ script: [out('calendar.events', { range: 'next-week' }), out('calendar.events', { range: pick })] });
      await h.decide('다음 주 월요일부터 금요일까지 일정');
      // The narrowed span is stored in the prompt's own MM-DD form, never with a year the owner did not write.
      expect(h.session.metadata?.[LAST_SELECTION_METADATA_KEY], pick).toMatchObject({ args: { range: '10-19..10-23' } });
      expect(await h.decide('다음 주 월요일부터 금요일까지 일정', { now: at(60_000) }), pick).toMatchObject({
        kind: 'execute',
        command: { args: { range: '10-19..10-23' }, range: { days: 5 } },
      });
      expect(h.calls[1]?.prompt, pick).toContain('Previous selection: {"entryId":"calendar.events","args":{"range":"10-19..10-23"}}');
    }
  });

  it('a past-tense question still executes', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'yesterday' })] });
    expect(await h.decide('어제 일정 뭐 있었지?')).toMatchObject({ kind: 'execute', command: { args: { range: 'yesterday' } } });
  });
});

describe('owner decision A (2026-10-22): a general help question about a named source asks Quoky or the app itself', () => {
  const QUESTION = [
    'Quoky로 슬랙을 조회하는 방법을 물으신 건가요, 아니면 슬랙 앱 자체의 사용법인가요?',
    '1. Quoky로 슬랙 조회하는 방법',
    '2. 슬랙 앱 자체의 사용법',
    '번호로 답해 주세요.',
  ].join('\n');

  it('asks instead of answering; the pending question holds the help option and the source (no model call on the answer)', async () => {
    const h = harness({ script: [out('help.topic')] });
    expect(await h.decide('슬랙에서 검색하는 방법 알려줘')).toEqual({ kind: 'ask', text: QUESTION, entryId: 'help.topic' });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ kind: 'entry', options: [{ entryId: 'help.topic', args: {} }], appSource: '슬랙' });
    // "1": Quoky's help (the general help, unchanged args).
    expect(await h.decide('1')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic', args: {} } });
    expect(h.calls).toHaveLength(1);
  });

  it('"2" (or the ordinal) is the app itself: a fixed honest reply, never instructions for the other app', async () => {
    const h = harness({ script: [out('help.topic', { topic: 'all' }), out('help.topic')] });
    await h.decide('슬랙에서 검색하는 방법 알려줘');
    expect(await h.decide('2번')).toEqual({ kind: 'ask', text: '그건 슬랙 앱 자체의 사용법이라 제가 안내해 드리긴 어려워요. 슬랙의 도움말을 확인해 주세요.' });
    await h.decide('what is Confluence?');
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ appSource: 'Confluence', language: 'en' });
    expect(await h.decide('the second one')).toEqual({ kind: 'ask', text: "That is about using the Confluence app itself, so I can't guide you through it reliably. Please check Confluence's own help." });
  });

  it("the Quoky option shows the source's help section: the topic of the entries that own the source name", async () => {
    const h = harness({ script: [out('help.topic')] });
    const topics = { 'slack.search': 'work-lookup', 'jira.issues': 'work-lookup', 'calendar.events': 'calendar' };
    await h.service.decide({ text: '슬랙에서 검색하는 방법 알려줘', attachmentCount: 0, session: h.session, actor: h.actor(), now: T0, entries: ALL, route: 'chat', chatProviderId: 'scripted-selector', entryHelpTopics: topics });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ options: [{ entryId: 'help.topic', args: { topic: 'work-lookup' } }] });
    expect(await h.decide('1')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic', args: { topic: 'work-lookup' } } });
  });

  it('Codex P2: each option is answered by its displayed text as well as by its number', async () => {
    const appReply = '그건 슬랙 앱 자체의 사용법이라 제가 안내해 드리긴 어려워요. 슬랙의 도움말을 확인해 주세요.';
    const cases: Array<[string, 'help' | 'app']> = [
      ['Quoky로 슬랙 조회하는 방법', 'help'],
      ['1', 'help'],
      ['슬랙 앱 자체의 사용법', 'app'],
      ['2', 'app'],
    ];
    for (const [reply, want] of cases) {
      const h = harness({ script: [out('help.topic')] });
      await h.decide('슬랙에서 검색하는 방법 알려줘');
      const decision = await h.decide(reply);
      if (want === 'help') expect(decision, reply).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic' } });
      else expect(decision, reply).toEqual({ kind: 'ask', text: appReply });
      expect(h.calls, reply).toHaveLength(1);
    }
    const en = harness({ script: [out('help.topic')] });
    await en.decide('how do I search in Slack?');
    expect(await en.decide('Looking up Slack with Quoky')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic' } });
  });

  it('a number that is no option asks the same help-scope question again; a cancel ends it', async () => {
    const h = harness({ script: [out('help.topic')] });
    await h.decide('슬랙에서 검색하는 방법 알려줘');
    expect(await h.decide('3번')).toEqual({ kind: 'ask', text: QUESTION });
    expect(await h.decide('취소')).toEqual({ kind: 'ask', text: '알겠어요, 선택을 취소했어요. 필요하면 다시 말씀해 주세요.' });
  });

  it('any other answer routes through natural-language selection as usual (no word list for the answer)', async () => {
    const h = harness({ script: [out('help.topic'), NONE] });
    await h.decide('슬랙에서 검색하는 방법 알려줘');
    expect(await h.decide('앱 자체 얘기였어')).toEqual({ kind: 'none' });
    expect(h.calls).toHaveLength(2);
  });

  it('D4 moved to the next merge (owner decision of 2026-10-27): a worded reply to the help-scope question is routed as usual, with no open question shown', async () => {
    const h = harness({ script: [out('help.topic'), NONE] });
    await h.decide('슬랙에서 검색하는 방법 알려줘');
    expect(await h.decide('퀴키로 하는 쪽')).toEqual({ kind: 'none' });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.prompt).not.toContain('Open question');
    // An `answer` field is outside the router's contract again: the output is malformed and nothing is answered.
    const stray = harness({ script: [out('help.topic'), out('none', {}, { answer: 1 })] });
    await stray.decide('슬랙에서 검색하는 방법 알려줘');
    expect(await stray.decide('퀴키로 하는 쪽')).toEqual({ kind: 'unavailable' });
  });

  it('a8-25 (2026-10-27): a link-only message is jira.release with no args, with no selector call', async () => {
    const h = harness({ script: [] });
    expect(await h.decide('https://example.atlassian.net/browse/OP26/fixforversion/16555')).toMatchObject({ kind: 'execute', command: { entryId: 'jira.release', args: {} } });
    expect(h.calls).toHaveLength(0);
    // A link with words goes to the selector as before.
    const worded = harness({ script: [out('jira.release')] });
    await worded.decide('https://example.atlassian.net/browse/OP26/fixforversion/16555 이거 몇 개야?');
    expect(worded.calls).toHaveLength(1);
  });

  it('owner decision of 2026-10-27 (range grounding): the one label-table period the owner states is the range Core runs', async () => {
    const h = harness({ script: [out('calendar.events', { range: 'next-week' })] });
    expect(await h.decide('다다음 주 일정 알려줘')).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { range: 'week-after-next' } } });
    const weekday = harness({ script: [out('calendar.events', { range: 'next-thu' })] });
    expect(await weekday.decide('목요일 일정 알려줘')).toMatchObject({ kind: 'execute', command: { args: { range: 'next-thu' } } });
  });

  it('owner decision of 2026-10-27 (ADR-0121 S2 note 2 on the one-step path): a meeting word alone turns timedOnly on', async () => {
    const run = async (text: string, args: Record<string, unknown>) => {
      const h = harness({ script: [out('calendar.events', args)] });
      return h.decide(text);
    };
    expect(await run('지난주에 무슨 회의 있었지?', { range: 'last-week' })).toMatchObject({ kind: 'execute', command: { entryId: 'calendar.events', args: { range: 'last-week', timedOnly: true } } });
    expect(await run('how many meetings do I have this week?', { range: 'this-week', count: true })).toMatchObject({ command: { args: { range: 'this-week', count: true, timedOnly: true } } });
    // Another name of the calendar ("일정") means the whole calendar; an exclusion or negation never sets it; a word inside
    // the read's own value (an event title) is that value's.
    for (const [text, args] of [
      ['이번 주 회의랑 연차 일정 보여줘', { range: 'this-week' }],
      ['내일 회의 말고 다른 거 있어?', { range: 'tomorrow' }],
      ['다음 주 주간회의 언제야?', { range: 'next-week', keyword: '주간회의' }],
    ] as const) {
      const decided = await run(text, args);
      expect(decided, text).toMatchObject({ kind: 'execute' });
      expect((decided as { command: { args: Record<string, unknown> } }).command.args.timedOnly, text).toBeUndefined();
    }
  });

  it('CA review W2: a topic the selector named but Core dropped as out of set is not a general help: no help-scope question', async () => {
    const h = harness({ script: [out('help.topic', { topic: 'slack' })] });
    expect(await h.decide('너 슬랙 볼 수 있어?')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic', args: {} } });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
  });

  it('Codex P2: another repaired detail (an ignorable extra arg dropped) still goes through the help-scope check', async () => {
    const extra = harness({ script: [out('help.topic', { verbose: true })] });
    expect(await extra.decide('슬랙에서 검색하는 방법 알려줘')).toEqual({ kind: 'ask', text: QUESTION, entryId: 'help.topic' });
    const topic = harness({ script: [out('help.topic', { topic: 'slack' })] });
    expect(await topic.decide('슬랙에서 검색하는 방법 알려줘')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic', args: {} } });
  });

  it('positives stay untouched: a source-specific or feature topic, or no source named', async () => {
    const h = harness({
      script: [out('help.topic', { topic: 'work-lookup' }), out('help.topic', { topic: 'drive' }), out('help.topic'), out('help.topic', { topic: 'reminder' })],
    });
    expect(await h.decide('너 jira 볼 수 있어?')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic', args: { topic: 'work-lookup' } } });
    expect(await h.decide('구글 드라이브에서 폴더 공유하는 법 알려줘')).toMatchObject({ kind: 'execute', command: { args: { topic: 'drive' } } });
    expect(await h.decide('사용법 알려줘')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic', args: {} } });
    expect(await h.decide('알림 설정하는 법 알려줘')).toMatchObject({ kind: 'execute', command: { args: { topic: 'reminder' } } });
  });

  it('owner decision of 2026-10-26: several named sources are asked about together; the Quoky option maps them structurally', async () => {
    const MULTI = [
      'Quoky로 구글 캘린더·지메일을 조회·연결하는 방법을 물으신 건가요, 아니면 그 앱 자체의 설정·사용법인가요?',
      '1. Quoky로 구글 캘린더·지메일 조회·연결하는 방법',
      '2. 그 앱 자체의 설정·사용법',
      '번호로 답해 주세요.',
    ].join('\n');
    const h = harness({ script: [out('help.topic')] });
    const topics = { 'calendar.events': 'calendar', 'mail.list': 'mail' };
    const decision = await h.service.decide({ text: '구글 캘린더랑 지메일 연동 설정 어디서 해?', attachmentCount: 0, session: h.session, actor: h.actor(), now: T0, entries: ALL, route: 'chat', chatProviderId: 'scripted-selector', entryHelpTopics: topics });
    expect(decision).toEqual({ kind: 'ask', text: MULTI, entryId: 'help.topic' });
    // Two sources mapping to two topics: the Quoky option is the general help; the record holds both names.
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ options: [{ entryId: 'help.topic', args: {} }], appSources: ['구글 캘린더', '지메일'] });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).not.toHaveProperty('appSource');
    expect(await h.decide('2')).toEqual({ kind: 'ask', text: '그건 구글 캘린더·지메일 앱 자체의 설정·사용법이라 제가 안내해 드리긴 어려워요. 각 앱의 도움말을 확인해 주세요.' });
    // Two sources whose entries share one help topic: that topic.
    const same = harness({ script: [out('help.topic')] });
    await same.service.decide({ text: '슬랙이랑 지라 쓰는 방법 알려줘', attachmentCount: 0, session: same.session, actor: same.actor(), now: T0, entries: ALL, route: 'chat', chatProviderId: 'scripted-selector', entryHelpTopics: { 'slack.search': 'work-lookup', 'jira.issues': 'work-lookup' } });
    expect(same.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ options: [{ entryId: 'help.topic', args: { topic: 'work-lookup' } }], appSources: ['슬랙', '지라'] });
    expect(await same.decide('Quoky로 슬랙·지라 조회·연결하는 방법')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic', args: { topic: 'work-lookup' } } });
  });

  it('Codex P2: more than three sources resolve the help topic from ALL of them; the stored and shown names are capped with "등"', async () => {
    const h = harness({ script: [out('help.topic')] });
    const topics = { 'slack.search': 'work-lookup', 'jira.issues': 'work-lookup', 'github.items': 'work-lookup', 'confluence.search': 'memory' };
    const decision = await h.service.decide({ text: '슬랙이랑 지라랑 깃허브랑 컨플루언스 연동하는 법 알려줘', attachmentCount: 0, session: h.session, actor: h.actor(), now: T0, entries: ALL, route: 'chat', chatProviderId: 'scripted-selector', entryHelpTopics: topics });
    expect(decision).toMatchObject({ kind: 'ask', text: expect.stringContaining('Quoky로 슬랙·지라·깃허브 등을 조회·연결하는 방법을 물으신 건가요') });
    // The fourth source maps to another topic: the general help, never the first three's topic.
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ options: [{ entryId: 'help.topic', args: {} }], appSources: ['슬랙', '지라', '깃허브'], appSourcesMore: true });
    expect(await h.decide('2')).toEqual({ kind: 'ask', text: '그건 슬랙·지라·깃허브 등 앱 자체의 설정·사용법이라 제가 안내해 드리긴 어려워요. 각 앱의 도움말을 확인해 주세요.' });
  });

  it('a selector clarification whose only read option is that help asks the same help-scope question', async () => {
    const h = harness({ script: [out('help.topic', {}, { ambiguity: 'NEEDS_CLARIFICATION' })] });
    expect(await h.decide('슬랙에서 검색하는 방법 알려줘')).toEqual({ kind: 'ask', text: QUESTION, entryId: 'help.topic' });
  });

  it('owner answer 2 (v66): the selector unclear how-to with a topic also asks; the topic it named is kept for the Quoky option', async () => {
    const h = harness({ script: [out('help.topic', { topic: 'work-lookup' }, { ambiguity: 'NEEDS_CLARIFICATION' })] });
    expect(await h.decide('슬랙에서 검색하는 방법 알려줘')).toEqual({ kind: 'ask', text: QUESTION, entryId: 'help.topic' });
    expect(await h.decide('1')).toMatchObject({ kind: 'execute', command: { entryId: 'help.topic', args: { topic: 'work-lookup' } } });
    // Without a source named, a selector clarification on help stays the ordinary one-option question.
    const plain = harness({ script: [out('help.topic', { topic: 'reminder' }, { ambiguity: 'NEEDS_CLARIFICATION' })] });
    expect(await plain.decide('알림 어떻게 해')).toMatchObject({ kind: 'ask', text: expect.stringContaining('어떤 걸 찾으세요?') });
  });
});

describe('owner decision B (2026-10-22): a handler confirmation is the open D7 question (yes runs it, no ends it)', () => {
  const selection = { entryId: 'jira.release' as const, args: { project: 'OP26' } };

  it('a yes runs exactly the confirmed read, without a model call', async () => {
    for (const yes of ['응', '맞아', '네', '1']) {
      const h = harness();
      expect(await h.service.recordConfirmQuestion({ id: 'sess-1' }, 'owner', selection, 'ko', T0)).toBe(true);
      expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toMatchObject({ kind: 'entry', confirm: true, options: [selection] });
      expect(await h.decide(yes), yes).toMatchObject({ kind: 'execute', command: { entryId: 'jira.release', args: { project: 'OP26' } } });
      expect(h.calls).toHaveLength(0);
    }
  });

  // Service level only: `decide` reads the slot itself here. In the runtime, `takePending` clears the slot at the start of
  // ANY turn in the session, so another member's message ends the owner's confirmation (the safe direction).
  it('CA review W5 (service level): the confirmation expires after the 5-minute TTL, and another actor\'s yes never answers it', async () => {
    const late = harness({ script: [NONE] });
    await late.service.recordConfirmQuestion({ id: 'sess-1' }, 'owner', selection, 'ko', T0);
    expect(await late.decide('응', { now: at(NL_PENDING_TTL_MS + 1) })).toEqual({ kind: 'none' });
    const other = harness({ script: [NONE] });
    await other.service.recordConfirmQuestion({ id: 'sess-1' }, 'owner', selection, 'ko', T0);
    const member = { id: 'member-2', displayName: 'Member', identities: [], createdAt: T0 };
    const decided = await other.service.decide({ text: '응', attachmentCount: 0, session: other.session, actor: member, now: T0, entries: ALL, route: 'chat', chatProviderId: 'scripted-selector' });
    expect(decided).toEqual({ kind: 'none' });
    // At the service level the owner's own yes still answers it afterwards (decide does not clear another actor's slot);
    // through the runtime the member's turn would already have ended it (`takePending`).
    expect(await other.decide('응')).toMatchObject({ kind: 'execute', command: { entryId: 'jira.release', args: { project: 'OP26' } } });
  });

  it('a no ends the question politely; anything else routes as usual', async () => {
    const h = harness({ script: [NONE] });
    await h.service.recordConfirmQuestion({ id: 'sess-1' }, 'owner', { entryId: 'jira.release', args: { project: 'OP26', release: '20261015' } }, 'ko', T0);
    expect(await h.decide('아니')).toEqual({ kind: 'ask', text: '알겠어요, 선택을 취소했어요. 필요하면 다시 말씀해 주세요.' });
    await h.service.recordConfirmQuestion({ id: 'sess-1' }, 'owner', selection, 'ko', T0);
    expect(await h.decide('오늘 날씨 어때?')).toEqual({ kind: 'none' });
    expect(h.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
  });

  it('a yes with the release words runs that release; outside active nothing is kept', async () => {
    const h = harness();
    await h.service.recordConfirmQuestion({ id: 'sess-1' }, 'owner', { entryId: 'jira.release', args: { project: 'OP26', release: '20261015' } }, 'ko', T0);
    expect(await h.decide('응')).toMatchObject({ kind: 'execute', command: { args: { project: 'OP26', release: '20261015' } } });
    const shadow = harness({ mode: 'shadow' });
    expect(await shadow.service.recordConfirmQuestion({ id: 'sess-1' }, 'owner', selection, 'ko', T0)).toBe(false);
    expect(shadow.session.metadata?.[NL_PENDING_METADATA_KEY]).toBeUndefined();
  });
});

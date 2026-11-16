import { describe, expect, it } from 'vitest';
import { Capability, type Actor } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import { ACTION_SWITCH_METADATA_KEY } from '../nl-routing/action-switch';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AGENT_ACTIVE_LOG_EVENT, AgentRunService, type AgentActiveOutcome, type AgentActiveTurn, type AgentMode } from './agent-run-service';
import type { AgentReadPort, AgentReadPorts, AgentReadRequest, AgentReadResponse } from './plan-executor';
import type { AgentRunBoundValues } from './run-bounds';

// ADR-0121 S2 wiring slice: `active` end to end with fake ports and no model. The planner (M1) is charged on the run budget
// before step 1, the re-plan (M1') is reserved explicitly, the executor reads through the injected ports, the summary grant
// comes from the owner's own words only, and the deterministic assembler answers; the kill switch is re-read before every step;
// a failure or a bound ends in a partial reply with no retry; `off` and `shadow` never run it; every log line is content-free.

const T0 = '2026-11-16T03:00:00.000Z';
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const CHAT = { id: 'claude-family', locality: 'REMOTE' as AiExecutionLocality };
const BODY_CANARY = 'RAW-BODY-CANARY-7731';
const SUMMARY_CANARY = 'SUMMARY-CANARY-4410';

const MAIL_SUMMARY_PLAN = JSON.stringify({ steps: [{ entryId: 'mail.list', args: {} }, { summarize: [1], schema: 'digest.v1' }], ambiguity: 'CLEAR' });
const MAIL_SUMMARY_TEXT = '메일 요약해줘';
const MAIL_AND_TODO_PLAN = JSON.stringify({ steps: [{ entryId: 'mail.list', args: {} }, { entryId: 'todo.list', args: {} }], ambiguity: 'CLEAR' });
const MAIL_AND_TODO_TEXT = '메일이랑 할 일 보여줘';

interface Harness {
  readonly service: AgentRunService;
  readonly plannerCalls: AiRequest[];
  readonly m2Calls: AiRequest[];
  readonly reads: AgentReadRequest[];
  readonly logs: Array<{ event: string; fields?: LogFields }>;
  readonly actors: Map<string, Actor>;
}

interface Options {
  readonly mode?: AgentMode;
  readonly script?: string[];
  readonly bounds?: Partial<AgentRunBoundValues>;
  readonly caps?: { perHour?: number; perDay?: number };
  /** A port behaviour per entry (default: an ok listing of 3 items with documents when asked). */
  readonly ports?: Partial<Record<string, (request: AgentReadRequest, h: Harness) => Promise<AgentReadResponse>>>;
  readonly actorsGet?: (id: string) => Promise<Actor | null>;
}

const documents = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, position: i + 1, title: `t${i + 1}`, author: 'a', date: '2026-11-01T09:00:00.000Z', body: `${BODY_CANARY} ${i + 1}` }));

function listing(request: AgentReadRequest): AgentReadResponse {
  if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
  return { ok: true, items: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], ...(request.withDocuments === true ? { documents: documents(3) } : {}) };
}

function harness(options: Options = {}): Harness {
  const plannerCalls: AiRequest[] = [];
  const m2Calls: AiRequest[] = [];
  const reads: AgentReadRequest[] = [];
  const logs: Array<{ event: string; fields?: LogFields }> = [];
  const actors = new Map<string, Actor>([['owner', { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 }]]);
  const script = [...(options.script ?? [])];
  const state = { plannerCalls, m2Calls, reads, logs, actors } as unknown as Harness;
  const planner: AiProvider = {
    id: 'scripted-planner',
    family: 'claude-family',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    async execute(request) {
      plannerCalls.push(request);
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted');
      return { text: next, artifacts: [] };
    },
  };
  const summarizer: AiProvider = {
    id: 'fake-summarizer',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    executionLocality: 'REMOTE',
    isAvailable: async () => true,
    async execute(request) {
      m2Calls.push(request);
      return { text: JSON.stringify({ items: [1, 2, 3].map((n) => ({ n, summary: `${SUMMARY_CANARY} ${n}` })) }) };
    },
  };
  const policy: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
  const port = (entryId: string): AgentReadPort => ({
    read: async (request) => {
      reads.push(request);
      const custom = options.ports?.[entryId];
      return custom !== undefined ? custom(request, state) : listing(request);
    },
  });
  const readers: AgentReadPorts = { 'mail.list': port('mail.list'), 'drive.files': port('drive.files'), 'todo.list': port('todo.list'), 'calendar.events': port('calendar.events') };
  const logger: Logger = {
    info: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    warn: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    error: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
  };
  const mode = options.mode ?? 'active';
  (state as { service: AgentRunService }).service = new AgentRunService({
    mode,
    router: { select: async () => planner },
    actors: {
      get: options.actorsGet ?? (async (id) => actors.get(id) ?? null),
      save: async (actor) => {
        actors.set(actor.id, actor);
        return actor;
      },
    },
    logger,
    timeZone: 'Asia/Seoul',
    timeoutMs: 6_000,
    ...(options.caps !== undefined ? { caps: options.caps } : {}),
    ...(options.bounds !== undefined ? { bounds: options.bounds } : {}),
    ...(mode === 'active' ? { readers, summarizer: new CapabilityRouter(new AiProviderManager([summarizer]), policy) } : {}),
  });
  return state;
}

const turn = (h: Harness, text: string, overrides: Partial<AgentActiveTurn> = {}): AgentActiveTurn => ({
  text,
  attachmentCount: 0,
  actor: h.actors.get('owner') as Actor,
  now: T0,
  entries: READS,
  direct: true,
  sessionId: 'session-1',
  ...overrides,
});

const stop = (h: Harness): void => {
  const owner = h.actors.get('owner') as Actor;
  h.actors.set('owner', { ...owner, metadata: { ...(owner.metadata ?? {}), [ACTION_SWITCH_METADATA_KEY]: { state: 'stopped', at: T0 } } });
};
const activeLines = (h: Harness) => h.logs.filter((log) => log.event === AGENT_ACTIVE_LOG_EVENT).map((log) => log.fields ?? {});
const replyOf = (outcome: AgentActiveOutcome) => {
  if (outcome.kind !== 'reply') throw new Error(`expected a reply, got ${JSON.stringify(outcome)}`);
  return outcome;
};
const utf8 = (text: string): number => new TextEncoder().encode(text).length;

describe('AgentRunService.runActive — end to end with fake ports', () => {
  it('plans, reads, summarizes on the owner\'s request and assembles the deterministic reply', async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN] });
    const outcome = replyOf(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT));
    expect(outcome.outcome).toBe('complete');
    expect(h.plannerCalls).toHaveLength(1);
    expect(h.plannerCalls[0]?.capability).toBe(Capability.INTENT_SELECTION);
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toMatchObject({ entryId: 'mail.list', withDocuments: true });
    expect(h.m2Calls).toHaveLength(1);
    expect(outcome.reply.parts.filter((part) => part.kind === 'summary')).toHaveLength(3);
    expect(outcome.reply.text).toContain('외부 모델');
    // The planner (1), the explicit re-plan reservation (1) and the one M2 call are on one budget; the input is both prompts.
    const line = activeLines(h).at(-1) ?? {};
    expect(line).toMatchObject({ outcome: 'reply', run: 'complete', modelCalls: 3, m2Calls: 1, connectorQueries: 1 });
    expect(line.inputTokens as number).toBe(utf8(h.plannerCalls[0]?.prompt ?? '') + utf8(h.m2Calls[0]?.prompt ?? ''));
  });

  it("the planner's summarize step alone grants nothing: without the owner's summary words mail stays listing-only, no body, no M2", async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN] });
    const outcome = replyOf(await h.service.runActive(turn(h, '메일 보여줘'), async () => CHAT));
    expect(h.reads[0]?.withDocuments).toBeUndefined();
    expect(h.m2Calls).toEqual([]);
    expect(outcome.reply.text).toContain('요약 요청이 확인되지 않아서');
  });

  it('a quoted summary request is not the owner\'s: listing-only', async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN] });
    const outcome = replyOf(await h.service.runActive(turn(h, '> 메일 요약해줘\n메일 보여줘'), async () => CHAT));
    expect(h.m2Calls).toEqual([]);
    expect(outcome.reply.text).toContain('요약 요청이 확인되지 않아서');
  });

  it('a one-step plan is handed back for the existing selection path (S2 plan Q2; P5 wires it): no read', async () => {
    const h = harness({ script: [JSON.stringify({ steps: [{ entryId: 'mail.list', args: {} }], ambiguity: 'CLEAR' })] });
    const outcome = await h.service.runActive(turn(h, '메일 보여줘'), async () => CHAT);
    expect(outcome.kind).toBe('one-step');
    expect(h.reads).toEqual([]);
  });

  it('a failed read ends in the partial reply, never a retry', async () => {
    const h = harness({ script: [MAIL_AND_TODO_PLAN], ports: { 'mail.list': async () => ({ ok: false, code: 'UNAVAILABLE' }) } });
    const outcome = replyOf(await h.service.runActive(turn(h, MAIL_AND_TODO_TEXT), async () => CHAT));
    expect(outcome.outcome).toBe('partial');
    expect(h.reads.map((request) => request.entryId)).toEqual(['mail.list', 'todo.list']);
    expect(outcome.reply.text).toContain('메일: 읽지 못했어요');
    expect(h.plannerCalls).toHaveLength(1);
  });

  it('a planner failure or a malformed plan reads nothing and is declined (no retry)', async () => {
    const failed = harness({ script: [] });
    expect(await failed.service.runActive(turn(failed, MAIL_SUMMARY_TEXT), async () => CHAT)).toEqual({ kind: 'declined', reason: 'failed' });
    const malformed = harness({ script: ['not json'] });
    expect(await malformed.service.runActive(turn(malformed, MAIL_SUMMARY_TEXT), async () => CHAT)).toEqual({ kind: 'declined', reason: 'malformed' });
    for (const h of [failed, malformed]) {
      expect(h.plannerCalls).toHaveLength(1);
      expect(h.reads).toEqual([]);
    }
  });

  it('every log line is content-free (no owner text, no body, no summary)', async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN] });
    await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT);
    const dumped = JSON.stringify(h.logs);
    for (const canary of [BODY_CANARY, SUMMARY_CANARY, MAIL_SUMMARY_TEXT]) expect(dumped).not.toContain(canary);
  });
});

describe('AgentRunService.runActive — the run budget (D3/D7 amendment wiring requirements)', () => {
  it('the planner and its prompt are charged BEFORE the call: a prompt over the input bound is never sent', async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN], bounds: { maxInputTokens: 100 } });
    expect(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT)).toEqual({ kind: 'declined', reason: 'bound' });
    expect(h.plannerCalls).toEqual([]);
    expect(activeLines(h).at(-1)).toMatchObject({ outcome: 'declined', reason: 'bound', breach: 'input-tokens' });
  });

  it('the re-plan is reserved explicitly: with 2 model calls (M1 + M1\') no M2 call is left, the summary is listing-only (budget)', async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN], bounds: { maxModelCalls: 2 } });
    const outcome = replyOf(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT));
    expect(h.m2Calls).toEqual([]);
    expect(outcome.reply.text).toContain('처리 한도가 남지 않아서');
    expect(activeLines(h).at(-1)).toMatchObject({ modelCalls: 2, m2Calls: 0 });
  });

  it('with 3 model calls exactly one M2 call fits after M1 and M1\'', async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN], bounds: { maxModelCalls: 3 } });
    replyOf(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT));
    expect(h.m2Calls).toHaveLength(1);
  });

  it('the planner\'s input counts toward the run\'s input bound: what is left after it is too little for M2', async () => {
    const probe = harness({ script: [MAIL_SUMMARY_PLAN] });
    await probe.service.runActive(turn(probe, MAIL_SUMMARY_TEXT), async () => CHAT);
    const plannerBytes = utf8(probe.plannerCalls[0]?.prompt ?? '');
    const h = harness({ script: [MAIL_SUMMARY_PLAN], bounds: { maxInputTokens: plannerBytes + 50 } });
    const outcome = replyOf(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT));
    expect(h.plannerCalls).toHaveLength(1);
    expect(h.m2Calls).toEqual([]);
    expect(outcome.reply.text).toContain('처리 한도가 남지 않아서');
  });

  it('uses the ratified caps by default: 8 model calls, 6 M2 calls, 120,000 input bytes, 60 s wall', async () => {
    const { AGENT_RUN_BOUNDS } = await import('./run-bounds');
    expect(AGENT_RUN_BOUNDS).toMatchObject({ maxModelCalls: 8, maxM2Calls: 6, maxInputTokens: 120_000, wallMs: 60_000, maxReplans: 1 });
  });
});

describe('AgentRunService.runActive — kill switch and caps (D7, ADR-0120 A6-D3 amendment)', () => {
  it('a stopped switch on the live actor declines before the planner (the turn snapshot is not trusted)', async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN] });
    const snapshot = h.actors.get('owner') as Actor;
    stop(h);
    expect(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT, { actor: snapshot }), async () => CHAT)).toEqual({ kind: 'declined', reason: 'kill-switch' });
    expect(h.plannerCalls).toEqual([]);
  });

  it('an unreadable switch declines (fail closed)', async () => {
    const h = harness({ script: [MAIL_SUMMARY_PLAN], actorsGet: async () => Promise.reject(new Error('db')) });
    expect(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT)).toEqual({ kind: 'declined', reason: 'kill-switch' });
    expect(h.plannerCalls).toEqual([]);
  });

  it('a stop during a read lets that read finish and starts no later step; the reply says so', async () => {
    const h = harness({
      script: [MAIL_AND_TODO_PLAN],
      ports: {
        'mail.list': async (request, state) => {
          stop(state);
          return listing(request);
        },
      },
    });
    const outcome = replyOf(await h.service.runActive(turn(h, MAIL_AND_TODO_TEXT), async () => CHAT));
    expect(h.reads.map((request) => request.entryId)).toEqual(['mail.list']);
    expect(outcome).toMatchObject({ outcome: 'partial', stopped: true });
    expect(outcome.reply.text).toContain('에이전트 중지로 남은 단계는 실행하지 않았어요.');
    expect(outcome.reply.text).toContain('할 일: 건너뛰었어요');
  });

  it('a stop recorded after planning stops the run before step 1', async () => {
    const h = harness({ script: [MAIL_AND_TODO_PLAN] });
    const original = h.plannerCalls.push.bind(h.plannerCalls);
    h.plannerCalls.push = (...items: AiRequest[]) => {
      stop(h);
      return original(...items);
    };
    const outcome = replyOf(await h.service.runActive(turn(h, MAIL_AND_TODO_TEXT), async () => CHAT));
    expect(h.reads).toEqual([]);
    expect(outcome).toMatchObject({ outcome: 'partial', stopped: true });
  });

  it('keeps the per-actor caps (30 an hour, 150 a day): a capped run makes no planner call', async () => {
    const h = harness({ script: [MAIL_AND_TODO_PLAN, MAIL_AND_TODO_PLAN], caps: { perHour: 1 } });
    replyOf(await h.service.runActive(turn(h, MAIL_AND_TODO_TEXT), async () => CHAT));
    expect(await h.service.runActive(turn(h, MAIL_AND_TODO_TEXT), async () => CHAT)).toEqual({ kind: 'declined', reason: 'hourly-cap' });
    expect(h.plannerCalls).toHaveLength(1);
  });

  it('keeps the S2 plan Q7 cap of 60 agent model calls per rolling hour: a run gets only what the hour has left', async () => {
    // 20 summary runs of 3 model calls each (M1, the reserved M1', one M2) fill the hour; the 21st is declined before the planner.
    const h = harness({ script: Array.from({ length: 21 }, () => MAIL_SUMMARY_PLAN), caps: { perHour: 100, perDay: 100 } });
    for (let run = 0; run < 20; run += 1) replyOf(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT));
    expect(h.m2Calls).toHaveLength(20);
    expect(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT)).toEqual({ kind: 'declined', reason: 'model-hourly-cap' });
    expect(h.plannerCalls).toHaveLength(20);
  });

  it('a run near the Q7 hourly cap is bounded by what is left (2 left: M1 and M1\' only, so no M2)', async () => {
    const script = [...Array.from({ length: 19 }, () => MAIL_SUMMARY_PLAN), 'not json', MAIL_SUMMARY_PLAN];
    const h = harness({ script, caps: { perHour: 100, perDay: 100 } });
    // 19 runs × 3 calls = 57, then a malformed plan (its planner call counts) = 58: two calls are left.
    for (let run = 0; run < 19; run += 1) replyOf(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT));
    expect(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT)).toEqual({ kind: 'declined', reason: 'malformed' });
    const outcome = replyOf(await h.service.runActive(turn(h, MAIL_SUMMARY_TEXT), async () => CHAT));
    expect(h.m2Calls).toHaveLength(19);
    expect(outcome.reply.text).toContain('처리 한도가 남지 않아서');
  });

  it('only in the owner\'s DM', async () => {
    const h = harness({ script: [MAIL_AND_TODO_PLAN] });
    expect(await h.service.runActive(turn(h, MAIL_AND_TODO_TEXT, { direct: false }), async () => CHAT)).toEqual({ kind: 'declined', reason: 'not-dm' });
    expect(h.plannerCalls).toEqual([]);
  });
});

describe('AgentRunService.runActive — off and shadow never run it', () => {
  it.each(['off', 'shadow'] as const)('%s: declined, no selection, no call, no read, no log line', async (mode) => {
    const h = harness({ mode, script: [MAIL_AND_TODO_PLAN] });
    expect(await h.service.runActive(turn(h, MAIL_AND_TODO_TEXT), async () => CHAT)).toEqual({ kind: 'declined', reason: 'not-active' });
    expect(h.plannerCalls).toEqual([]);
    expect(h.reads).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

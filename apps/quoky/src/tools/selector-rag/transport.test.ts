import { describe, expect, it } from 'vitest';
import { Capability, NL_SELECTION_TIMEOUT_MS, type AiProvider, type AiRequest } from '@quoky/core';
import { BudgetExceededError, RateGate, TrafficLedger } from './ledger';
import type { ScoringCase } from './score';
import type { RetrievalRecord } from './selector-rag-eval';
import { createSelectorTransport } from './transport';

// ADR-0123 D6 / ADR-0121 D8, offline: the transport with a fake provider. No process is spawned and no model is called.

const NOW = '2026-10-16T03:00:00.000Z';
const answer = (entryId: string, args: Record<string, unknown> = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });
const record = (caseId: string, run = 1): RetrievalRecord => ({ arm: 'A0', run, caseId, promptVersion: 'v', poolDigest: 'p', spaceId: 's', retrievedIds: [], scores: [], blockSha256: null, promptSha256: 'x' });

function fakeProvider(respond: (request: AiRequest) => Promise<string> | string): AiProvider & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    calls,
    id: 'fake',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request) => {
      calls.push(request);
      return { text: await respond(request), artifacts: [] };
    },
  };
}

const read = (id: string, text: string, expectEntry: string | 'none', args: Record<string, unknown> = {}): [string, ScoringCase] => [
  id,
  { corpus: 'read', golden: { id, text, expect: expectEntry === 'none' ? 'none' : { entryId: expectEntry, args } } as never },
];

function setup(provider: AiProvider, options: { budget?: number; gate?: RateGate; timeoutMs?: number } = {}) {
  const scoring = new Map<string, ScoringCase>([read('c1', '내 할 일 보여줘', 'todo.list'), read('c2', '저녁 뭐 먹지', 'none')]);
  const ledger = new TrafficLedger(options.budget ?? 10);
  const transport = createSelectorTransport({ provider, ledger, gate: options.gate ?? new RateGate({ now: () => 0, sleep: async () => undefined }), scoring, now: () => NOW, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
  return { transport, ledger };
}

describe('selector transport: calls', () => {
  it('asks the provider for INTENT_SELECTION with the runtime bound and returns the raw text', async () => {
    const provider = fakeProvider(() => answer('todo.list'));
    const { transport, ledger } = setup(provider);
    expect(await transport.select('PROMPT', record('c1'))).toBe(answer('todo.list'));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual(expect.objectContaining({ capability: Capability.INTENT_SELECTION, prompt: 'PROMPT', timeoutMs: NL_SELECTION_TIMEOUT_MS }));
    expect(ledger.calls).toBe(1);
  });

  it('refuses to go over the ledger budget and makes no call for the refused one', async () => {
    const provider = fakeProvider(() => answer('none'));
    const { transport } = setup(provider, { budget: 2 });
    await transport.select('a', record('c1'));
    await transport.select('b', record('c1', 2));
    await expect(transport.select('c', record('c1', 3))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(provider.calls).toHaveLength(2);
  });

  it('a call that does not answer in time is a timeout record, not a thrown error, and scores as a timeout', async () => {
    const provider = fakeProvider(() => new Promise<string>(() => undefined));
    const { transport } = setup(provider, { timeoutMs: 20 });
    const rec = record('c1');
    const raw = await transport.select('p', rec);
    expect(raw).toBe('');
    expect(await transport.score('c1', raw, rec)).toEqual({ correct: false, outcome: 'timeout' });
    expect(transport.summary()).toEqual({ calls: 1, timeouts: 1, errors: 0 });
  });

  it('a provider failure is an error record (never a hit)', async () => {
    const provider = fakeProvider(() => {
      throw new Error('boom');
    });
    const { transport } = setup(provider);
    const rec = record('c1');
    const raw = await transport.select('p', rec);
    expect(await transport.score('c1', raw, rec)).toEqual({ correct: false, outcome: 'error' });
    expect(transport.summary()).toEqual({ calls: 1, timeouts: 0, errors: 1 });
  });
});

describe('selector transport: rate limiting (<= 1 call/s sustained, 4 concurrent)', () => {
  it('spaces call starts at least one second apart on the injected clock', async () => {
    let clock = 0;
    const gate = new RateGate({ now: () => clock, sleep: async (ms) => void (clock += ms) });
    const starts: number[] = [];
    const provider = fakeProvider(() => {
      starts.push(clock);
      return answer('none');
    });
    const { transport } = setup(provider, { gate });
    for (let i = 1; i <= 5; i += 1) await transport.select('p', record('c1', i));
    expect(starts).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('never has more than 4 calls in flight even when many are issued at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const gate = new RateGate({ now: () => 0, sleep: async () => undefined });
    const provider = fakeProvider(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return answer('none');
    });
    const { transport } = setup(provider, { gate, budget: 20 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => transport.select('p', record('c1', i + 1))));
    expect(provider.calls).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('releases its slot after a failed call (a failure never wedges the gate)', async () => {
    const gate = new RateGate({ maxConcurrent: 1, now: () => 0, sleep: async () => undefined });
    let first = true;
    const provider = fakeProvider(() => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
      return answer('none');
    });
    const { transport } = setup(provider, { gate });
    await transport.select('p', record('c1', 1));
    await expect(transport.select('p', record('c1', 2))).resolves.toBe(answer('none'));
  });
});

describe('selector transport: exact-args scoring (the existing eval scorer)', () => {
  const { transport } = setup(fakeProvider(() => ''));
  it('scores a read positive exactly on entry and args, and a negative on a clean none', async () => {
    expect(await transport.score('c1', answer('todo.list'), record('c1'))).toEqual({ correct: true, outcome: 'hit' });
    expect(await transport.score('c1', answer('todo.list', { status: 'all' }), record('c1'))).toEqual({ correct: false, outcome: 'clarify' });
    expect(await transport.score('c1', answer('reminder.list'), record('c1'))).toEqual({ correct: false, outcome: 'miss' });
    expect(await transport.score('c2', answer('none'), record('c2'))).toEqual({ correct: true, outcome: 'none' });
    expect(await transport.score('c2', answer('todo.list'), record('c2'))).toEqual({ correct: false, outcome: 'wrong-capture' });
  });

  it('a malformed output is never correct', async () => {
    expect((await transport.score('c1', 'not json', record('c1'))).correct).toBe(false);
  });

  it('parseEntry reads the entry id (none for none or garbage)', () => {
    expect(transport.parseEntry(answer('todo.list'))).toBe('todo.list');
    expect(transport.parseEntry(answer('none'))).toBe('none');
    expect(transport.parseEntry('garbage')).toBe('none');
  });
});

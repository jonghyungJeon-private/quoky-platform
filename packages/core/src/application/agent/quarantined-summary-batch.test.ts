import { afterEach, describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AgentPlanExecutor, type AgentReadPort, type AgentReadResponse } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import {
  AGENT_M2_MAX_ITEMS,
  estimateInputTokens,
  mintSummaryEgressGrantForTest,
  newSummaryRunToken,
  quarantinedSummarize,
  setSummaryGrantsForTest,
  summaryEntriesForAssembler,
  type AgentSourceDocument,
  type AgentSummarySource,
  type QuarantinedCallAudit,
  type QuarantinedSummarizerRoute,
} from './quarantined-summary';

// ADR-0121 remote batch (owner 2026-11-03 answer 3) with the owner's 2026-11-16 caps (split M2 calls count; M2 6, model 8, input
// 120k bytes, wall 60 s): one sealed call per source, at most AGENT_M2_MAX_ITEMS items each, split calls run in parallel and
// planned up front within the remaining M2 calls, model calls and input bytes; a per-call reservation, final dispatch check and
// audit; never a retry; a deterministic merge in source order with global numbering and no model call.

const RUN = newSummaryRunToken();
const mailDoc = (position: number): AgentSourceDocument => ({ id: `m${position}`, position, title: `t${position}`, author: 'a', date: '', body: `mail body ${position}` });
const driveDoc = (position: number): AgentSourceDocument => ({ id: `f0000${position}`, position, title: `t${position}`, author: 'a', date: '', body: `drive body ${position}` });
const mails = (n: number): AgentSourceDocument[] => Array.from({ length: n }, (_, i) => mailDoc(i + 1));
const drives = (n: number): AgentSourceDocument[] => Array.from({ length: n }, (_, i) => driveDoc(i + 1));
const granted = (entryId: NlWave1EntryId, documents: readonly AgentSourceDocument[]): AgentSummarySource => ({ entryId, documents, grant: mintSummaryEgressGrantForTest(1, entryId, RUN) });
const base = { schema: 'digest.v1' as const, summaryStep: 1, reserve: (): boolean => true, run: RUN };
const PERMISSIVE: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };

/** The items in a prompt (`ITEM n` lines) and their bodies. */
const itemCount = (prompt: string): number => (prompt.match(/^ITEM \d+$/gm) ?? []).length;
const bodiesOf = (prompt: string): string[] => [...prompt.matchAll(/"body":"([^"]*)"/g)].map((match) => match[1] as string);
/** One entry per item of the prompt, in REVERSE order (the merge must not depend on the model's order). */
const answerAll = (request: AiRequest): string =>
  JSON.stringify({ items: bodiesOf(request.prompt).map((body, index) => ({ n: index + 1, summary: `about ${body}` })).reverse() });

interface Held {
  readonly request: AiRequest;
  resolve(text: string): void;
  reject(error: Error): void;
}

/** A provider whose calls are held until the test settles them (so parallel dispatch and settle order are observable). */
function heldProvider(id: string, locality: AiExecutionLocality): AiProvider & { readonly held: Held[] } {
  const held: Held[] = [];
  return {
    id,
    held,
    executionLocality: locality,
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
    isAvailable: async () => true,
    execute: (request) =>
      new Promise((resolve, reject) => {
        held.push({ request, resolve: (text) => resolve({ text }), reject });
      }),
  };
}

/** A provider that answers every call at once. */
function answering(id: string, locality: AiExecutionLocality, answer: (request: AiRequest) => string = answerAll): AiProvider & { readonly requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    id,
    requests,
    executionLocality: locality,
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request) => (requests.push(request), { text: answer(request) }),
  };
}

const routeOf = (provider: AiProvider): QuarantinedSummarizerRoute => ({ selector: new CapabilityRouter(new AiProviderManager([provider]), PERMISSIVE) });
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The byte size of the one prompt a single-call request over `documents` sends. */
async function promptBytes(source: AgentSummarySource): Promise<number> {
  const probe = answering('probe', 'LOCAL');
  await quarantinedSummarize({ ...base, sources: [source], route: routeOf(probe) });
  expect(probe.requests).toHaveLength(1);
  return estimateInputTokens((probe.requests[0] as AiRequest).prompt);
}

describe('remote batch: one sealed call per source, split calls in parallel (owner 2026-11-03 answer 3)', () => {
  it('splits mail (12) and Drive (3) into 3 calls dispatched in parallel, each sealed to one source and at most the item cap', async () => {
    const provider = heldProvider('p-remote', 'REMOTE');
    const pending = quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12)), granted('drive.files', drives(3))], route: routeOf(provider) });
    await tick();
    // All three are sent before any answers: parallel, not sequential.
    expect(provider.held).toHaveLength(3);
    const prompts = provider.held.map((call) => call.request.prompt);
    expect(prompts.map(itemCount)).toEqual([AGENT_M2_MAX_ITEMS, 2, 3]);
    expect(bodiesOf(prompts[0] as string).every((body) => body.startsWith('mail '))).toBe(true);
    expect(bodiesOf(prompts[1] as string)).toEqual(['mail body 11', 'mail body 12']);
    expect(bodiesOf(prompts[2] as string)).toEqual(['drive body 1', 'drive body 2', 'drive body 3']);
    // Every request is the sealed shape: capability, prompt and nothing else.
    for (const call of provider.held) expect(Object.keys(call.request).sort()).toEqual(['capability', 'prompt']);
    // Settle in REVERSE order: the merge is still source order with global numbers.
    for (const call of [...provider.held].reverse()) call.resolve(answerAll(call.request));
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'summary', omitted: 0 });
    if (outcome.kind !== 'summary') return;
    const entries = summaryEntriesForAssembler(outcome.summary) ?? [];
    expect(entries.map((entry) => entry.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(entries.map((entry) => `${entry.entryId}#${entry.position}`)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `mail.list#${i + 1}`),
      ...Array.from({ length: 3 }, (_, i) => `drive.files#${i + 1}`),
    ]);
    expect(entries.map((entry) => entry.text)).toEqual([...Array.from({ length: 12 }, (_, i) => `about mail body ${i + 1}`), ...Array.from({ length: 3 }, (_, i) => `about drive body ${i + 1}`)]);
    // One audit per call, in source order, each with its own token reservation.
    expect(outcome.audits.map((audit) => audit.locality)).toEqual(['REMOTE', 'REMOTE', 'REMOTE']);
    expect(outcome.audits.map((audit) => audit.estimatedTokens)).toEqual(prompts.map(estimateInputTokens));
    expect(outcome.summary.label).toMatchObject({ trust: 'UNTRUSTED', derivation: 'MODEL_DERIVED' });
  });

  it('the merge is deterministic: the same inputs give the same entries whatever order the calls settle in', async () => {
    const texts: string[] = [];
    for (const order of ['forward', 'reverse'] as const) {
      const provider = heldProvider('p', 'REMOTE');
      const pending = quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12)), granted('drive.files', drives(2))], route: routeOf(provider) });
      await tick();
      const calls = order === 'forward' ? provider.held : [...provider.held].reverse();
      for (const call of calls) {
        call.resolve(answerAll(call.request));
        await tick();
      }
      const outcome = await pending;
      if (outcome.kind !== 'summary') throw new Error('not a summary');
      texts.push(JSON.stringify(summaryEntriesForAssembler(outcome.summary)));
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it('the provider is selected once per step, and every call re-checks policy and locality right before its own dispatch', async () => {
    const provider = answering('p', 'REMOTE');
    let selects = 0;
    let checks = 0;
    const router = new CapabilityRouter(new AiProviderManager([provider]), PERMISSIVE);
    const selector: ProviderSelector = {
      select: (capability, context) => ((selects += 1), router.select(capability, context)),
      isStillEligible: (capability, context, candidate) => ((checks += 1), router.isStillEligible(capability, context as never, candidate)),
    };
    const outcome = await quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12)), granted('drive.files', drives(1))], route: { selector } });
    expect(outcome.kind).toBe('summary');
    expect(provider.requests).toHaveLength(3);
    expect(selects).toBe(1);
    // The selection-time verdict, then two checks per call (before its reservation, and immediately before execute).
    expect(checks).toBe(1 + 2 * 3);
  });
});

describe('remote batch: the calls are planned up front within what the run has left (owner 2026-11-16)', () => {
  it('remaining calls: only as many calls as are left are planned; the rest of the items are omitted, every reservation passes', async () => {
    const provider = answering('p', 'REMOTE');
    const reserved: number[] = [];
    const outcome = await quarantinedSummarize({
      ...base,
      sources: [granted('mail.list', mails(12)), granted('drive.files', drives(3))],
      route: routeOf(provider),
      remainingCalls: 2,
      reserve: (tokens) => (reserved.push(tokens), true),
    });
    expect(provider.requests.map((request) => itemCount(request.prompt))).toEqual([AGENT_M2_MAX_ITEMS, 2]);
    expect(reserved).toHaveLength(2);
    expect(outcome).toMatchObject({ kind: 'summary', omitted: 3 });
  });

  it('remaining input bytes: calls are added while the sum of their prompts fits; the item that does not fit and all after it are omitted', async () => {
    const ten = await promptBytes(granted('mail.list', mails(10)));
    const eleventh = await promptBytes(granted('mail.list', [mailDoc(11)]));
    const provider = answering('p', 'REMOTE');
    const reserved: number[] = [];
    // Room for the 10-item call and a 1-item call: item 12 and the Drive items do not fit.
    const budget = ten + eleventh;
    const outcome = await quarantinedSummarize({
      ...base,
      sources: [granted('mail.list', mails(12)), granted('drive.files', drives(3))],
      route: routeOf(provider),
      remainingInputTokens: budget,
      reserve: (tokens) => (reserved.push(tokens), true),
    });
    expect(provider.requests.map((request) => bodiesOf(request.prompt).length)).toEqual([10, 1]);
    expect(bodiesOf((provider.requests[1] as AiRequest).prompt)).toEqual(['mail body 11']);
    expect(reserved.reduce((sum, tokens) => sum + tokens, 0)).toBeLessThanOrEqual(budget);
    expect(outcome).toMatchObject({ kind: 'summary', omitted: 1 + 3 });
    // One byte less: the second call cannot be placed at all.
    const tighter = answering('p2', 'REMOTE');
    const cut = await quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12))], route: routeOf(tighter), remainingInputTokens: budget - 1 });
    expect(tighter.requests).toHaveLength(1);
    expect(cut).toMatchObject({ kind: 'summary', omitted: 2 });
  });

  it('executor: a run whose M2 cap is lower than the split never breaches; it summarises what was planned and is partial', async () => {
    setSummaryGrantsForTest(() => true);
    const provider = answering('p', 'REMOTE');
    const result = await new AgentPlanExecutor({
      readers: { 'mail.list': port(mails(12)), 'drive.files': port(drives(3)) },
      summarizer: routeOf(provider),
      bounds: { maxM2Calls: 2 },
    }).execute(plan([wide('mail.list', 12), wide('drive.files', 3), summarize([1, 2])]));
    expect(result.breach).toBeUndefined();
    expect(result.usage).toMatchObject({ m2Calls: 2, modelCalls: 2 });
    expect(provider.requests).toHaveLength(2);
    expect(result.steps[2]).toMatchObject({ status: 'ok', omitted: 3, audits: [{ locality: 'REMOTE' }, { locality: 'REMOTE' }] });
    expect(result.outcome).toBe('partial');
  });

  it('executor: the model-call cap and the input budget plan the split too, with no breach', async () => {
    setSummaryGrantsForTest(() => true);
    const byModel = answering('p', 'REMOTE');
    const capped = await new AgentPlanExecutor({ readers: { 'mail.list': port(mails(12)), 'drive.files': port(drives(3)) }, summarizer: routeOf(byModel), bounds: { maxModelCalls: 1 } }).execute(
      plan([wide('mail.list', 12), wide('drive.files', 3), summarize([1, 2])]),
    );
    expect(capped.breach).toBeUndefined();
    expect(capped.usage).toMatchObject({ m2Calls: 1, modelCalls: 1 });
    expect(capped.steps[2]).toMatchObject({ status: 'ok', omitted: 5 });

    const ten = await promptBytes(granted('mail.list', mails(10)));
    const byBytes = answering('p', 'REMOTE');
    const tight = await new AgentPlanExecutor({ readers: { 'mail.list': port(mails(12)), 'drive.files': port(drives(3)) }, summarizer: routeOf(byBytes), bounds: { maxInputTokens: ten + 1 } }).execute(
      plan([wide('mail.list', 12), wide('drive.files', 3), summarize([1, 2])]),
    );
    expect(tight.breach).toBeUndefined();
    expect(byBytes.requests).toHaveLength(1);
    expect(tight.usage.inputTokens).toBe(ten);
    expect(tight.steps[2]).toMatchObject({ status: 'ok', omitted: 5 });
  });

  it('executor: an ordinary split under the default caps (mail 12 + Drive 3) makes 3 calls and completes', async () => {
    setSummaryGrantsForTest(() => true);
    const provider = answering('p', 'REMOTE');
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(mails(12)), 'drive.files': port(drives(3)) }, summarizer: routeOf(provider) }).execute(
      plan([wide('mail.list', 12), wide('drive.files', 3), summarize([1, 2])]),
    );
    expect(result.breach).toBeUndefined();
    expect(result.usage).toMatchObject({ m2Calls: 3, modelCalls: 3 });
    expect(result.steps[2]).toMatchObject({ status: 'ok', omitted: 0 });
    expect(result.outcome).toBe('complete');
  });
});

describe('remote batch: partial failure, audits, dispatch refusal, no retry', () => {
  it('a failed call omits its items; the step is ok while one call succeeded; every sent call is audited; nothing is re-sent', async () => {
    const provider = heldProvider('p', 'REMOTE');
    const pending = quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12)), granted('drive.files', drives(3))], route: routeOf(provider) });
    await tick();
    const [first, second, third] = provider.held as [Held, Held, Held];
    first.resolve('not json');
    second.reject(new Error('SECRET-DETAIL'));
    third.resolve(answerAll(third.request));
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'summary', omitted: 12 });
    if (outcome.kind !== 'summary') return;
    expect(outcome.audits).toHaveLength(3);
    expect(summaryEntriesForAssembler(outcome.summary)?.map((entry) => [entry.n, entry.entryId])).toEqual([
      [13, 'drive.files'],
      [14, 'drive.files'],
      [15, 'drive.files'],
    ]);
    expect(JSON.stringify(outcome)).not.toContain('SECRET-DETAIL');
    await tick();
    expect(provider.held).toHaveLength(3);
  });

  it('every call failed: the step fails with the first reason in source order, whatever settled first, with every audit', async () => {
    const provider = heldProvider('p', 'REMOTE');
    const pending = quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12))], route: routeOf(provider) });
    await tick();
    const [first, second] = provider.held as [Held, Held];
    second.reject(new Error('down'));
    await tick();
    first.resolve('not json');
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'schema' });
    expect((outcome as { audits?: readonly QuarantinedCallAudit[] }).audits).toHaveLength(2);
    expect(provider.held).toHaveLength(2);
  });

  it('a locality flip at one call\'s final check refuses only that call: no request, no REMOTE audit for it', async () => {
    let remote = false;
    const requests: AiRequest[] = [];
    const flipping: AiProvider = {
      id: 'p-flip',
      get executionLocality(): AiExecutionLocality {
        return remote ? 'REMOTE' : 'LOCAL';
      },
      capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
      isAvailable: async () => true,
      execute: async (request) => (requests.push(request), { text: answerAll(request) }),
    };
    let checks = 0;
    const selector: ProviderSelector = {
      select: async () => flipping,
      // #1 selection verdict; call 1: #2 first check, #3 final check; call 2: #4, #5. The 5th verdict switches the adapter to
      // REMOTE and still answers true.
      isStillEligible: () => {
        checks += 1;
        if (checks === 5) remote = true;
        return true;
      },
    };
    const readers: (() => QuarantinedCallAudit | undefined)[] = [];
    const outcome = await quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12))], route: { selector }, onCallStart: (audit) => void readers.push(audit) });
    expect(requests).toHaveLength(1);
    expect(itemCount((requests[0] as AiRequest).prompt)).toBe(AGENT_M2_MAX_ITEMS);
    expect(outcome).toMatchObject({ kind: 'summary', omitted: 2, audits: [{ locality: 'LOCAL', auditId: 'p-flip' }] });
    if (outcome.kind === 'summary') expect(outcome.audits).toHaveLength(1);
    // Both calls started (reserved); the refused one reads no audit: nothing was sent.
    expect(readers).toHaveLength(2);
    expect(readers[0]?.()).toMatchObject({ locality: 'LOCAL' });
    expect(readers[1]?.()).toBeUndefined();
  });

  it('a policy refusal at one call\'s first check charges nothing for it; the other call still runs', async () => {
    const provider = answering('p', 'REMOTE');
    let checks = 0;
    const router = new CapabilityRouter(new AiProviderManager([provider]), PERMISSIVE);
    const selector: ProviderSelector = {
      select: (capability, context) => router.select(capability, context),
      // #4 is the second call's first check.
      isStillEligible: () => (checks += 1) !== 4,
    };
    const reserved: number[] = [];
    const outcome = await quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12))], route: { selector }, reserve: (tokens) => (reserved.push(tokens), true) });
    expect(provider.requests).toHaveLength(1);
    expect(reserved).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: 'summary', omitted: 2 });
  });

  it('executor: the wall cuts a parallel call; the step is not-run and carries the audit of every call that was sent', async () => {
    setSummaryGrantsForTest(() => true);
    const provider = heldProvider('p-wall', 'REMOTE');
    const pending = new AgentPlanExecutor({ readers: { 'mail.list': port(mails(12)) }, summarizer: routeOf(provider), bounds: { wallMs: 40 } }).execute(plan([wide('mail.list', 12), summarize([1])]));
    await tick();
    await tick();
    // The first call answers; the second hangs until the wall.
    const first = provider.held[0];
    if (first !== undefined) first.resolve(answerAll(first.request));
    const result = await pending;
    expect(provider.held).toHaveLength(2);
    expect(result.breach).toBe('wall-time');
    expect(result.steps[1]).toMatchObject({ status: 'not-run', audits: [{ locality: 'REMOTE', auditId: 'p-wall' }, { locality: 'REMOTE', auditId: 'p-wall' }] });
    expect(provider.held.every((call) => call.request.signal === undefined || call.request.signal.aborted)).toBe(true);
  });

  it('no retry: a failed split call is never re-sent and no other provider is tried', async () => {
    const failing = answering('p-first', 'REMOTE', () => 'not json');
    const other = answering('p-other', 'REMOTE');
    const router = new CapabilityRouter(new AiProviderManager([failing, { ...other, capabilities: [{ capability: Capability.SUMMARIZATION, priority: 0 }] }]), PERMISSIVE);
    const outcome = await quarantinedSummarize({ ...base, sources: [granted('mail.list', mails(12)), granted('drive.files', drives(1))], route: { selector: router } });
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'schema' });
    expect(failing.requests).toHaveLength(3);
    expect(other.requests).toHaveLength(0);
  });
});

// ── executor helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const wide = (entryId: NlWave1EntryId, limit: number): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit }, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });
function port(documents: readonly AgentSourceDocument[]): AgentReadPort {
  return {
    read: async (request): Promise<AgentReadResponse> => {
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      return { ok: true, items: documents.map((document) => ({ id: document.id })), documents };
    },
  };
}

afterEach(() => setSummaryGrantsForTest());

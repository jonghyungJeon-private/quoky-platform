import { describe, expect, it } from 'vitest';
import type { Logger } from '../../ports/logger.port';
import type { AiRequest } from '../../ports/ai-provider.port';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AgentPlanExecutor, type AgentReadPort, type AgentReadResponse } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import { summaryEntriesForAssembler, type AgentSourceDocument, type QuarantinedSummarizerModel } from './quarantined-summary';

// ADR-0121 D3/D4/D7 (stage S2 P3-3b): the executor's summarize step goes through the quarantined summariser, charged on the
// run bounds; a refusal or a breach is a partial result, never an error.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const read = (entryId: NlWave1EntryId): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: {}, provenance: {} });
const summarize = (from: number[], schema: 'digest.v1' | 'meeting-digest.v1' = 'digest.v1'): ValidatedAgentStep => ({ kind: 'summarize', from, schema });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });

const docs = (...bodies: string[]): AgentSourceDocument[] => bodies.map((body, i) => ({ position: i + 1, title: `t${i + 1}`, author: 'a', date: '2026-11-01T09:00:00.000Z', body }));
const port = (ids: readonly string[], documents?: readonly AgentSourceDocument[]): AgentReadPort => ({
  read: async (request) => {
    if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
    const response: AgentReadResponse = { ok: true, items: ids.map((id) => ({ id })), ...(documents !== undefined ? { documents } : {}) };
    return response;
  },
});

function model(locality: 'LOCAL' | 'REMOTE', answer = '{"items":[{"n":1,"summary":"CANARY-SUMMARY-91 text"}]}'): QuarantinedSummarizerModel & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return { requests, executionLocality: locality, run: async (request) => (requests.push(request), { text: answer }) };
}

function logger(): Logger & { lines: unknown[] } {
  const lines: unknown[] = [];
  const log = (message: string, fields?: unknown): void => void lines.push({ message, fields });
  return { lines, info: log, warn: log, error: log };
}

describe('AgentPlanExecutor: summaries (P3-3b)', () => {
  it('without a summarizer the step stays deferred', async () => {
    const result = await new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('x')) } }).execute(plan([read('jira.issues'), summarize([1])]));
    expect(result.steps[1]).toEqual({ step: 2, kind: 'summarize', status: 'deferred', from: [1], schema: 'digest.v1' });
    expect(result.outcome).toBe('complete');
  });

  it('runs one M2 call over the covered read and charges it on the run bounds', async () => {
    const fake = model('REMOTE');
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('quarterly body')) }, summarizer: { models: [fake] } });
    const result = await exec.execute(plan([read('jira.issues'), summarize([1])]));
    expect(result.outcome).toBe('complete');
    expect(fake.requests).toHaveLength(1);
    expect(result.usage).toMatchObject({ m2Calls: 1, modelCalls: 1 });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    const step = result.steps[1];
    expect(step).toMatchObject({ kind: 'summarize', status: 'ok', omitted: 0 });
    if (step?.kind !== 'summarize' || step.status !== 'ok') throw new Error('not ok');
    expect(step.summary.label).toMatchObject({ trust: 'UNTRUSTED', derivation: 'MODEL_DERIVED' });
    expect(summaryEntriesForAssembler(step.summary)[0]?.text).toContain('CANARY-SUMMARY-91');
  });

  it('M2 content is never stored or logged: not in the result, the projection or any log line', async () => {
    const fake = model('LOCAL');
    const log = logger();
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('RAW-BODY-CANARY-55')) }, summarizer: { models: [fake] }, logger: log });
    const result = await exec.execute(plan([read('jira.issues'), summarize([1])]));
    const dumped = JSON.stringify(result) + JSON.stringify(log.lines);
    expect(dumped).not.toContain('RAW-BODY-CANARY-55');
    expect(dumped).not.toContain('CANARY-SUMMARY-91');
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({ message: 'agent_run.exec', fields: { summaries: 1, m2Calls: 1, listingOnly: 0 } });
  });

  it('M2 output is never an argument: a reference step takes its keys from the projection only', async () => {
    const answer = '{"items":[{"n":1,"summary":"see ZZ-999 and ZZ-998 for the rest"}]}';
    const seen: (readonly string[] | undefined)[] = [];
    const jira: AgentReadPort = {
      read: async (request) => {
        seen.push(request.keys);
        return { ok: true, items: (request.keys ?? ['AB-1', 'AB-2']).map((id) => ({ id })), documents: docs('body') };
      },
    };
    const ref: ValidatedAgentStep = {
      ...(read('jira.issues') as Extract<ValidatedAgentStep, { kind: 'read' }>),
      ref: { step: 1, field: 'issueKeys', take: 2, provenance: { kind: 'reference', step: 1, entryId: 'jira.issues', origin: 'jira:configured-site' } },
    };
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': jira }, summarizer: { models: [model('REMOTE', answer)] } });
    await exec.execute(plan([read('jira.issues'), summarize([1]), ref]));
    expect(seen).toEqual([undefined, ['AB-1', 'AB-2']]);
  });

  it('egress: mail with only a remote model and no summary request is listing-only (no call, outcome partial)', async () => {
    const fake = model('REMOTE');
    const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('hello')) }, summarizer: { models: [fake] } });
    const result = await exec.execute(plan([read('mail.list'), summarize([1])]));
    expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-model' });
    expect(fake.requests).toHaveLength(0);
    expect(result.usage.m2Calls).toBe(0);
    expect(result.outcome).toBe('partial');
    expect(result.breach).toBeUndefined();
  });

  it('egress: the same mail run with a grounded summary request calls the remote model', async () => {
    const fake = model('REMOTE');
    const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('hello')) }, summarizer: { models: [fake] } });
    const result = await exec.execute(plan([read('mail.list'), summarize([1])]), { summaryRequested: true });
    expect(result.steps[1]).toMatchObject({ status: 'ok' });
    expect(fake.requests).toHaveLength(1);
  });

  it('calendar content has no readout shape: listing-only, no call, even with a local model', async () => {
    const fake = model('LOCAL');
    const exec = new AgentPlanExecutor({ readers: { 'calendar.events': port(['e1'], docs('standup')) }, summarizer: { models: [fake] } });
    const result = await exec.execute(plan([read('calendar.events'), summarize([1], 'meeting-digest.v1')]), { summaryRequested: true });
    expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-readout-source' });
    expect(fake.requests).toHaveLength(0);
  });

  it('a port that hands over no documents: listing-only (no-documents)', async () => {
    const fake = model('LOCAL');
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1']) }, summarizer: { models: [fake] } });
    const result = await exec.execute(plan([read('jira.issues'), summarize([1])]));
    expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-documents' });
  });

  it('a schema failure is a closed `failed` step and the run is partial, with no retry', async () => {
    const fake = model('LOCAL', 'free text, not the schema');
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('b')) }, summarizer: { models: [fake] } });
    const result = await exec.execute(plan([read('jira.issues'), summarize([1])]));
    expect(result.steps[1]).toMatchObject({ status: 'failed', errorCode: 'SCHEMA' });
    expect(result.outcome).toBe('partial');
    expect(fake.requests).toHaveLength(1);
  });

  it('a credential in the output fails the step (CREDENTIAL)', async () => {
    const answer = JSON.stringify({ items: [{ n: 1, summary: 'use ' + 'api_' + 'key=' + 'ab12cd34ef56gh78ij90' }] });
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('b')) }, summarizer: { models: [model('LOCAL', answer)] } });
    const result = await exec.execute(plan([read('jira.issues'), summarize([1])]));
    expect(result.steps[1]).toMatchObject({ status: 'failed', errorCode: 'CREDENTIAL' });
  });

  it('M2 cap: the call over the cap is not made; the run is a deterministic partial result, not an error', async () => {
    const fake = model('LOCAL');
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('b')) }, summarizer: { models: [fake] }, bounds: { maxM2Calls: 2 } });
    const result = await exec.execute(plan([read('jira.issues'), summarize([1]), summarize([1]), summarize([1])]));
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'not-run']);
    expect(fake.requests).toHaveLength(2);
    expect(result.breach).toBe('m2-calls');
    expect(result.outcome).toBe('partial');
    expect(result.usage.m2Calls).toBe(2);
  });

  it('the default cap is 3 M2 calls (D3)', async () => {
    const fake = model('LOCAL');
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('b')) }, summarizer: { models: [fake] } });
    const result = await exec.execute(plan([read('jira.issues'), summarize([1]), summarize([1]), summarize([1])]));
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(fake.requests).toHaveLength(3);
  });

  it('the model-call and input-token bounds stop the call before it is made', async () => {
    for (const [bounds, breach] of [[{ maxModelCalls: 0 }, 'model-calls'], [{ maxInputTokens: 10 }, 'input-tokens']] as const) {
      const fake = model('LOCAL');
      const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('b')) }, summarizer: { models: [fake] }, bounds });
      const result = await exec.execute(plan([read('jira.issues'), summarize([1])]));
      expect(result.steps[1], breach).toMatchObject({ status: 'not-run' });
      expect(result.breach).toBe(breach);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it('a hung model is cut at the wall: not-run, wall-time breach, partial', async () => {
    const hung: QuarantinedSummarizerModel = { executionLocality: 'LOCAL', run: () => new Promise(() => undefined) };
    const exec = new AgentPlanExecutor({ readers: { 'jira.issues': port(['AB-1'], docs('b')) }, summarizer: { models: [hung] }, bounds: { wallMs: 30 } });
    const result = await exec.execute(plan([read('jira.issues'), summarize([1])]));
    expect(result.steps[1]).toMatchObject({ status: 'not-run' });
    expect(result.breach).toBe('wall-time');
    expect(result.outcome).toBe('partial');
  });
});

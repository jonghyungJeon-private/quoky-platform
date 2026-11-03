import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../ports/logger.port';
import type { AiRequest } from '../../ports/ai-provider.port';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AgentPlanExecutor, type AgentReadPort, type AgentReadRequest, type AgentReadResponse } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import { setSummaryGrantsForTest, summaryEntriesForAssembler, type AgentSourceDocument, type QuarantinedSummarizerModel } from './quarantined-summary';

// ADR-0121 D3/D4/D7 (stage S2 P3-3b): the executor's summarize step goes through the quarantined summariser, charged on the
// run bounds; a refusal or a breach is a partial result, never an error. Mail is the readable source. Nothing in production
// makes a summary grant, so the tests that need one switch the test seam on.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const read = (entryId: NlWave1EntryId): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit: 1 }, provenance: {} });
const summarize = (from: number[], schema: 'digest.v1' | 'meeting-digest.v1' = 'digest.v1'): ValidatedAgentStep => ({ kind: 'summarize', from, schema });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `m${i + 1}`);
const docs = (...bodies: string[]): AgentSourceDocument[] => bodies.map((body, i) => ({ id: `m${i + 1}`, position: i + 1, title: `t${i + 1}`, author: 'a', date: '2026-11-01T09:00:00.000Z', body }));

interface SpyPort extends AgentReadPort {
  readonly requests: AgentReadRequest[];
}
function port(itemIds: readonly string[], documents?: readonly unknown[]): SpyPort {
  const requests: AgentReadRequest[] = [];
  return {
    requests,
    read: async (request) => {
      requests.push(request);
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      const response: AgentReadResponse = { ok: true, items: itemIds.map((id) => ({ id })), ...(documents !== undefined ? { documents: documents as readonly AgentSourceDocument[] } : {}) };
      return response;
    },
  };
}

function model(locality: 'LOCAL' | 'REMOTE', answer = '{"items":[{"n":1,"summary":"CANARY-SUMMARY-91 text"}]}'): QuarantinedSummarizerModel & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return { requests, executionLocality: locality, auditId: `audit-${locality}`, run: async (request) => (requests.push(request), { text: answer }) };
}

function logger(): Logger & { lines: unknown[] } {
  const lines: unknown[] = [];
  const log = (message: string, fields?: unknown): void => void lines.push({ message, fields });
  return { lines, info: log, warn: log, error: log };
}

const MAIL_PLAN = (): RunPlan => plan([read('mail.list'), summarize([1])]);
const grantAll = (): void => setSummaryGrantsForTest(() => true);

afterEach(() => setSummaryGrantsForTest());

describe('AgentPlanExecutor: summaries (P3-3b)', () => {
  it('without a summarizer the step stays deferred and no body is asked for', async () => {
    const mail = port(['m1'], docs('x'));
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail } }).execute(MAIL_PLAN());
    expect(result.steps[1]).toEqual({ step: 2, kind: 'summarize', status: 'deferred', from: [1], schema: 'digest.v1' });
    expect(result.outcome).toBe('complete');
    expect(mail.requests[0]?.withDocuments).toBeUndefined();
  });

  describe('with a summary grant (a test seam: no producer exists in this slice)', () => {
    beforeEach(grantAll);

    it('runs one M2 call over the covered read, charges it on the run bounds and records the audit', async () => {
      const fake = model('REMOTE');
      const mail = port(['m1'], docs('quarterly body'));
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: { models: [fake] } }).execute(MAIL_PLAN());
      expect(result.outcome).toBe('complete');
      expect(fake.requests).toHaveLength(1);
      expect(mail.requests[0]?.withDocuments).toBe(true);
      expect(result.usage).toMatchObject({ m2Calls: 1, modelCalls: 1 });
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      const step = result.steps[1];
      expect(step).toMatchObject({ kind: 'summarize', status: 'ok', omitted: 0, audit: { locality: 'REMOTE', auditId: 'audit-REMOTE' } });
      if (step?.kind !== 'summarize' || step.status !== 'ok') throw new Error('not ok');
      expect(step.audit.estimatedTokens).toBe(result.usage.inputTokens);
      expect(step.summary.label).toMatchObject({ trust: 'UNTRUSTED', derivation: 'MODEL_DERIVED' });
      expect(summaryEntriesForAssembler(step.summary)?.[0]?.text).toContain('CANARY-SUMMARY-91');
    });

    it('M2 content is never stored or logged: not in the result, the projection or any log line', async () => {
      const log = logger();
      const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('RAW-BODY-CANARY-55')) }, summarizer: { models: [model('LOCAL')] }, logger: log });
      const result = await exec.execute(MAIL_PLAN());
      const dumped = JSON.stringify(result) + JSON.stringify(log.lines);
      expect(dumped).not.toContain('RAW-BODY-CANARY-55');
      expect(dumped).not.toContain('CANARY-SUMMARY-91');
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toMatchObject({ message: 'agent_run.exec', fields: { summaries: 1, m2Calls: 1, listingOnly: 0 } });
    });

    it('M2 output is never an argument: a reference step takes its keys from the projection only', async () => {
      const answer = '{"items":[{"n":1,"summary":"see ZZ-999 and zz998 for the rest"}]}';
      const seen: (readonly string[] | undefined)[] = [];
      const mail: AgentReadPort = {
        read: async (request) => {
          seen.push(request.keys);
          return { ok: true, items: (request.keys ?? ['m1', 'm2']).map((id) => ({ id })), documents: docs('body') };
        },
      };
      const ref: ValidatedAgentStep = {
        ...(read('mail.list') as Extract<ValidatedAgentStep, { kind: 'read' }>),
        ref: { step: 1, field: 'messageIds', take: 2, provenance: { kind: 'reference', step: 1, entryId: 'mail.list', origin: 'mail:owner' } },
      };
      const exec = new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: { models: [model('LOCAL', answer)] } });
      await exec.execute(plan([read('mail.list'), summarize([1]), ref]));
      expect(seen).toEqual([undefined, ['m1', 'm2']]);
    });

    it('a remote model may take exactly one item; two items go to a LOCAL model or are listing-only', async () => {
      const remote = model('REMOTE');
      const batch = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1', 'm2'], docs('a', 'b')) }, summarizer: { models: [remote] } }).execute(MAIL_PLAN());
      expect(batch.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-model' });
      expect(remote.requests).toHaveLength(0);
      const local = model('LOCAL');
      const both = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1', 'm2'], docs('a', 'b')) }, summarizer: { models: [remote, local] } }).execute(MAIL_PLAN());
      expect(both.steps[1]).toMatchObject({ status: 'ok', omitted: 1 });
      expect(local.requests).toHaveLength(1);
      expect(remote.requests).toHaveLength(0);
    });

    it('model-omitted items make the run partial with an omitted count (3 documents, 1 summary is omitted 2)', async () => {
      const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1', 'm2', 'm3'], docs('a', 'b', 'c')) }, summarizer: { models: [model('LOCAL', '{"items":[{"n":3,"summary":"third"}]}')] } });
      const result = await exec.execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'ok', omitted: 2 });
      expect(result.outcome).toBe('partial');
      expect(result.breach).toBeUndefined();
    });

    it('S2: omitted is the listed items minus the entries the summary carries (3 listed, 1 document: omitted 2, partial)', async () => {
      const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1', 'm2', 'm3'], docs('a')) }, summarizer: { models: [model('LOCAL', '{"items":[{"n":1,"summary":"first"}]}')] } });
      const result = await exec.execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'ok', omitted: 2 });
      expect(result.outcome).toBe('partial');
    });

    it('S3: readiness sums the requested counts over the summary\'s reads: two reads of one item each are a batch, so REMOTE-only models fetch no bodies', async () => {
      const remote = model('REMOTE');
      const mail = port(['m1'], docs('a'));
      const drive = port(['d1'], [{ id: 'd1', position: 1, title: 't', author: 'a', date: '', body: 'b' }]);
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail, 'drive.files': drive }, summarizer: { models: [remote] } }).execute(plan([read('mail.list'), read('drive.files'), summarize([1, 2])]));
      expect(mail.requests[0]?.withDocuments).toBeUndefined();
      expect(drive.requests[0]?.withDocuments).toBeUndefined();
      expect(result.steps[2]).toMatchObject({ status: 'listing-only', reason: 'no-model' });
      expect(remote.requests).toHaveLength(0);
      // A LOCAL model qualifies for the same plan.
      const local = model('LOCAL');
      const mail2 = port(['m1'], docs('a'));
      const drive2 = port(['d1'], [{ id: 'd1', position: 1, title: 't', author: 'a', date: '', body: 'b' }]);
      await new AgentPlanExecutor({ readers: { 'mail.list': mail2, 'drive.files': drive2 }, summarizer: { models: [local] } }).execute(plan([read('mail.list'), read('drive.files'), summarize([1, 2])]));
      expect(mail2.requests[0]?.withDocuments).toBe(true);
      expect(drive2.requests[0]?.withDocuments).toBe(true);
    });

    it('an unstated limit counts as the item cap: REMOTE-only models with a grant are listing-only and no body is fetched', async () => {
      const remote = model('REMOTE');
      const mail = port(['m1'], docs('a'));
      const unstated: ValidatedAgentStep = { kind: 'read', entry: NL_WAVE1_ENTRIES['mail.list' as keyof typeof NL_WAVE1_ENTRIES], args: {}, provenance: {} };
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: { models: [remote] } }).execute(plan([unstated, summarize([1])]));
      expect(mail.requests[0]?.withDocuments).toBeUndefined();
      expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-model' });
      expect(remote.requests).toHaveLength(0);
    });

    it('a clock that throws while the budget is built is a closed partial result, never a rejection', async () => {
      const mail = port(['m1'], docs('a'));
      const result = await new AgentPlanExecutor({
        readers: { 'mail.list': mail },
        summarizer: { models: [model('LOCAL')] },
        elapsed: () => {
          throw new Error('clock');
        },
      }).execute(MAIL_PLAN());
      expect(result.outcome).toBe('partial');
      expect(result.steps.map((step) => step.status)).toEqual(['not-run', 'not-run']);
      expect(mail.requests).toHaveLength(0);
    });

    it('a model whose audit id getter throws is never called and the step is listing-only', async () => {
      const calls: number[] = [];
      const bad: QuarantinedSummarizerModel = { executionLocality: 'REMOTE', get auditId(): string { throw new Error('audit'); }, run: async () => (calls.push(1), { text: '{}' }) };
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('a')) }, summarizer: { models: [bad] } }).execute(MAIL_PLAN());
      expect(calls).toEqual([]);
      expect(result.steps[1]).toMatchObject({ status: 'listing-only' });
    });

    it('documents are asked for only when the read is covered and a model can already be selected', async () => {
      // Covered, selectable: asked.
      const covered = port(['m1'], docs('a'));
      await new AgentPlanExecutor({ readers: { 'mail.list': covered }, summarizer: { models: [model('LOCAL')] } }).execute(MAIL_PLAN());
      expect(covered.requests[0]?.withDocuments).toBe(true);
      // Uncovered read: never asked, its body never reaches the prompt, and the covered read's does.
      const fake = model('LOCAL');
      const uncovered = port(['d123456'], [{ id: 'd123456', position: 1, title: 'UNCOVERED-TITLE', author: 'a', date: '', body: 'UNCOVERED-BODY-CANARY' }]);
      const coveredMail = port(['m1'], docs('covered body'));
      const result = await new AgentPlanExecutor({ readers: { 'drive.files': uncovered, 'mail.list': coveredMail }, summarizer: { models: [fake] } }).execute(plan([read('drive.files'), read('mail.list'), summarize([2])]));
      expect(uncovered.requests[0]?.withDocuments).toBeUndefined();
      expect(coveredMail.requests[0]?.withDocuments).toBe(true);
      expect(result.steps[2]).toMatchObject({ status: 'ok' });
      expect(JSON.stringify(fake.requests)).not.toContain('UNCOVERED');
      expect(JSON.stringify(fake.requests)).toContain('covered body');
      // Covered but no selectable model: never asked.
      const none = port(['m1'], docs('a'));
      const refused = await new AgentPlanExecutor({ readers: { 'mail.list': none }, summarizer: { models: [] } }).execute(MAIL_PLAN());
      expect(none.requests[0]?.withDocuments).toBeUndefined();
      expect(refused.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-model' });
    });

    it('positions: out-of-range, duplicate and id-mismatched documents are dropped and counted as omitted', async () => {
      const good = (position: number, id = `m${position}`): AgentSourceDocument => ({ id, position, title: 't', author: 'a', date: '', body: `body ${position}` });
      const fake = model('LOCAL', '{"items":[{"n":1,"summary":"only the valid one"}]}');
      const documents = [good(1), good(9, 'm9'), good(2), good(2), good(3, 'WRONG'), { ...good(1), position: 1.5 }];
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(ids(3), documents) }, summarizer: { models: [fake] } }).execute(MAIL_PLAN());
      // Valid: position 1 only (position 2 is claimed twice, 9 is out of range, 3 mismatches, 1.5 is not an integer); omitted is
      // the 3 listed items minus the 1 the summary carries.
      expect(result.steps[1]).toMatchObject({ status: 'ok', omitted: 2 });
      const prompt = (fake.requests[0] as AiRequest).prompt;
      expect(prompt).toContain('body 1');
      for (const gone of ['body 2', 'body 3', 'body 9']) expect(prompt).not.toContain(gone);
      expect(result.outcome).toBe('partial');
    });

    it('malformed documents (not an array, wrong field types, null items) never throw and never reach the prompt', async () => {
      const fake = model('LOCAL');
      for (const documents of [{ not: 'an array' }, 'text', 5, [null, 7, 'x', { position: 1, id: 'm1', title: 3, author: 'a', date: '', body: 'b' }]]) {
        const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], documents as never) }, summarizer: { models: [fake] } }).execute(MAIL_PLAN());
        expect(result.steps[1], JSON.stringify(documents)).toMatchObject({ status: 'listing-only', reason: 'no-documents' });
      }
      expect(fake.requests).toHaveLength(0);
    });

    it('a throwing summariser model or reader never rejects `execute`', async () => {
      const throwing: QuarantinedSummarizerModel = {
        executionLocality: 'LOCAL',
        auditId: 'a',
        run: () => {
          throw new Error('boom');
        },
      };
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('a')) }, summarizer: { models: [throwing] } }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'failed', errorCode: 'MODEL' });
      const reader: AgentReadPort = { read: () => Promise.reject(new Error('boom')) };
      const failed = await new AgentPlanExecutor({ readers: { 'mail.list': reader }, summarizer: { models: [model('LOCAL')] } }).execute(MAIL_PLAN());
      expect(failed.steps[0]).toMatchObject({ status: 'failed', errorCode: 'UNKNOWN' });
    });

    it('a schema failure is a closed `failed` step and the run is partial, with no retry', async () => {
      const fake = model('LOCAL', 'free text, not the schema');
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [fake] } }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'failed', errorCode: 'SCHEMA', audit: { auditId: 'audit-LOCAL' } });
      expect(result.outcome).toBe('partial');
      expect(fake.requests).toHaveLength(1);
    });

    it('a credential in the output fails the step (CREDENTIAL)', async () => {
      const answer = JSON.stringify({ items: [{ n: 1, summary: 'use ' + 'api_' + 'key=' + 'ab12cd34ef56gh78ij90' }] });
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [model('LOCAL', answer)] } }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'failed', errorCode: 'CREDENTIAL' });
    });

    it('M2 cap: the call over the cap is not made; the run is a deterministic partial result, not an error', async () => {
      const fake = model('LOCAL');
      const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [fake] }, bounds: { maxM2Calls: 2 } });
      const result = await exec.execute(plan([read('mail.list'), summarize([1]), summarize([1]), summarize([1])]));
      expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'not-run']);
      expect(fake.requests).toHaveLength(2);
      expect(result.breach).toBe('m2-calls');
      expect(result.outcome).toBe('partial');
      expect(result.usage.m2Calls).toBe(2);
    });

    it('the default cap is 3 M2 calls (D3)', async () => {
      const fake = model('LOCAL');
      const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [fake] } });
      const result = await exec.execute(plan([read('mail.list'), summarize([1]), summarize([1]), summarize([1])]));
      expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
      expect(fake.requests).toHaveLength(3);
    });

    it('the model-call and input-token bounds stop the call before it is made', async () => {
      for (const [bounds, breach] of [[{ maxModelCalls: 0 }, 'model-calls'], [{ maxInputTokens: 10 }, 'input-tokens']] as const) {
        const fake = model('LOCAL');
        const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [fake] }, bounds });
        const result = await exec.execute(MAIL_PLAN());
        expect(result.steps[1], breach).toMatchObject({ status: 'not-run' });
        expect(result.breach).toBe(breach);
        expect(fake.requests).toHaveLength(0);
      }
    });

    it('a hung model is cut at the wall: not-run, wall-time breach, partial, and the request signal is aborted', async () => {
      const signals: AbortSignal[] = [];
      const hung: QuarantinedSummarizerModel = {
        executionLocality: 'LOCAL',
        auditId: 'a',
        run: (request) => {
          if (request.signal !== undefined) signals.push(request.signal);
          return new Promise(() => undefined);
        },
      };
      const exec = new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [hung] }, bounds: { wallMs: 30 } });
      const result = await exec.execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'not-run' });
      expect(result.breach).toBe('wall-time');
      expect(result.outcome).toBe('partial');
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    });
  });

  describe('review round 2 (N1-N4, C3)', () => {
    beforeEach(grantAll);
    const wide = (id: NlWave1EntryId, limit: number): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[id as keyof typeof NL_WAVE1_ENTRIES], args: { limit }, provenance: {} });

    it('N1: a REMOTE call the wall cuts off after it started still reports its audit', async () => {
      const hung: QuarantinedSummarizerModel = { executionLocality: 'REMOTE', auditId: 'audit-hung', run: () => new Promise(() => undefined) };
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [hung] }, bounds: { wallMs: 30 } }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'not-run', audit: { locality: 'REMOTE', auditId: 'audit-hung' } });
    });

    it('N1: a REMOTE call whose answer fails the schema reports its audit', async () => {
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [model('REMOTE', 'not json')] } }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'failed', errorCode: 'SCHEMA', audit: { locality: 'REMOTE' } });
    });

    it('N1: a step refused before any call carries no audit', async () => {
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [model('REMOTE')] }, bounds: { maxModelCalls: 0 } }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'not-run' });
      expect(result.steps[1]).not.toHaveProperty('audit');
    });

    it('N2: ten full Korean items send only those that fit the input budget and omit the rest, with no input-tokens breach', async () => {
      const body = '가나다라마바사아자차'.repeat(300);
      const bodies = Array.from({ length: 10 }, () => body);
      const fake = model('LOCAL');
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(ids(10), docs(...bodies)) }, summarizer: { models: [fake] }, bounds: { maxInputTokens: 12_000 } }).execute(plan([wide('mail.list', 10), summarize([1])]));
      expect(result.breach).toBeUndefined();
      const sent = (fake.requests[0]?.prompt.match(/^ITEM \d+$/gm) ?? []).length;
      expect(sent).toBeGreaterThan(0);
      expect(sent).toBeLessThan(10);
      expect(Buffer.byteLength(fake.requests[0]?.prompt ?? '', 'utf8')).toBeLessThanOrEqual(12_000);
      expect(result.steps[1]).toMatchObject({ status: 'ok' });
      expect((result.steps[1] as { omitted: number }).omitted).toBeGreaterThanOrEqual(10 - sent);
      expect(result.outcome).toBe('partial');
    });

    it('N3: a multi-item read with only REMOTE models never fetches bodies; a one-item read does', async () => {
      const remote = model('REMOTE');
      const many = port(ids(5), docs('a', 'b', 'c', 'd', 'e'));
      const listed = await new AgentPlanExecutor({ readers: { 'mail.list': many }, summarizer: { models: [remote] } }).execute(plan([wide('mail.list', 5), summarize([1])]));
      expect(many.requests[0]?.withDocuments).toBeUndefined();
      expect(listed.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-model' });
      const one = port(['m1'], docs('a'));
      await new AgentPlanExecutor({ readers: { 'mail.list': one }, summarizer: { models: [remote] } }).execute(plan([wide('mail.list', 1), summarize([1])]));
      expect(one.requests[0]?.withDocuments).toBe(true);
    });

    it('N4: a summary over [mail, jira] counts the denied jira items as omitted (partial)', async () => {
      const result = await new AgentPlanExecutor({
        readers: { 'mail.list': port(['m1'], docs('hello')), 'jira.issues': port(['AB-1', 'AB-2', 'AB-3'], []) },
        summarizer: { models: [model('LOCAL')] },
      }).execute(plan([read('mail.list'), read('jira.issues'), summarize([1, 2])]));
      expect(result.steps[2]).toMatchObject({ status: 'ok', omitted: 3 });
      expect(result.outcome).toBe('partial');
    });

    it('C3: a throwing logger never rejects execute', async () => {
      const bad: Logger = { info: () => { throw new Error('log down'); }, warn: () => undefined, error: () => undefined };
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1'], docs('b')) }, summarizer: { models: [model('LOCAL')] }, logger: bad }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'ok' });
    });
  });

  describe('without a grant (production today: nothing makes one)', () => {
    it('mail is listing-only (no-summary-grant): the body is never fetched, no model is called, even with a local one', async () => {
      const fake = model('LOCAL');
      const mail = port(['m1'], docs('hello'));
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: { models: [fake, model('REMOTE')] } }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-summary-grant' });
      expect(mail.requests[0]?.withDocuments).toBeUndefined();
      expect(fake.requests).toHaveLength(0);
      expect(result.usage.m2Calls).toBe(0);
      expect(result.outcome).toBe('partial');
      expect(result.breach).toBeUndefined();
    });

    it('the caller has no way to ask for one: `execute` takes a plan and nothing else', () => {
      expect(AgentPlanExecutor.prototype.execute.length).toBe(1);
    });
  });

  describe('Jira, Slack and calendar are listing-only whatever the grants say', () => {
    beforeEach(grantAll);

    it('Jira and Slack work text: work-text-controls-not-built, no body fetched, no call', async () => {
      for (const entryId of ['jira.issues', 'jira.release', 'slack.search'] as const) {
        const fake = model('LOCAL');
        const reader = port(['AB-1'], [{ id: 'AB-1', position: 1, title: 't', author: 'a', date: '', body: 'b' }]);
        const result = await new AgentPlanExecutor({ readers: { [entryId]: reader }, summarizer: { models: [fake] } }).execute(plan([read(entryId), summarize([1])]));
        expect(result.steps[1], entryId).toMatchObject({ status: 'listing-only', reason: 'work-text-controls-not-built' });
        expect(reader.requests[0]?.withDocuments, entryId).toBeUndefined();
        expect(fake.requests, entryId).toHaveLength(0);
      }
    });

    it('calendar content has no readout shape: listing-only, no call, even with a local model', async () => {
      const fake = model('LOCAL');
      const calendar = port(['e1'], docs('standup'));
      const result = await new AgentPlanExecutor({ readers: { 'calendar.events': calendar }, summarizer: { models: [fake] } }).execute(plan([read('calendar.events'), summarize([1], 'meeting-digest.v1')]));
      expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-readout-source' });
      expect(calendar.requests[0]?.withDocuments).toBeUndefined();
      expect(fake.requests).toHaveLength(0);
    });

    it('a port that hands over no documents: listing-only (no-documents)', async () => {
      const fake = model('LOCAL');
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1']) }, summarizer: { models: [fake] } }).execute(MAIL_PLAN());
      expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-documents' });
    });
  });
});

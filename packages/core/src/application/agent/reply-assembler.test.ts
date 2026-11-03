import { describe, expect, it } from 'vitest';
import { flowLabel } from '../../domain/flow-label';
import type { Logger } from '../../ports/logger.port';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AgentPlanExecutor, type AgentReadPort, type AgentRunResult } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import { QuarantinedSummary, type AgentSourceDocument, type ModelDerivedLabel, type QuarantinedSummarizerModel, type SummaryEntry } from './quarantined-summary';
import { assembleAgentReply } from './reply-assembler';
import type { AgentStepsPlan } from './reply-notes';

// ADR-0121 D3/D4 (stage S2 P3-3b): the deterministic reply assembler.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const read = (entryId: NlWave1EntryId): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: {}, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });
const doc = (position: number, body = 'body'): AgentSourceDocument => ({ position, title: 't', author: 'a', date: '2026-11-01T09:00:00.000Z', body });
const port = (ids: readonly string[], documents: readonly AgentSourceDocument[], more = false): AgentReadPort => ({
  read: async (request) => (request.budget.reserveQuery() && request.budget.reserveHttp() ? { ok: true, items: ids.map((id) => ({ id })), documents, ...(more ? { hasMore: true } : {}) } : { ok: false, code: 'BOUND' }),
});
const local = (answer: string): QuarantinedSummarizerModel => ({ executionLocality: 'LOCAL', run: async () => ({ text: answer }) });
const log = (): Logger & { lines: unknown[] } => {
  const lines: unknown[] = [];
  const push = (message: string, fields?: unknown): void => void lines.push({ message, fields });
  return { lines, info: push, warn: push, error: push };
};

async function run(steps: ValidatedAgentStep[], readers: Partial<Record<NlWave1EntryId, AgentReadPort>>, answer?: string, bounds = {}): Promise<{ plan: RunPlan; result: AgentRunResult }> {
  const p = plan(steps);
  const result = await new AgentPlanExecutor({ readers, ...(answer !== undefined ? { summarizer: { models: [local(answer)] } } : {}), bounds }).execute(p);
  return { plan: p, result };
}

const ONE = '{"items":[{"n":1,"summary":"Only item."}]}';
const SUMMARY = '{"items":[{"n":1,"summary":"First item is about the rollout."},{"n":2,"summary":"Second item is blocked."}]}';

describe('reply assembler', () => {
  it('puts Core facts first, then notes, then the model summaries, then fixed status lines', async () => {
    const { plan: p, result } = await run([read('jira.issues'), summarize([1])], { 'jira.issues': port(['AB-1', 'AB-2'], [doc(1), doc(2)]) }, SUMMARY);
    const reply = assembleAgentReply({ plan: p as AgentStepsPlan, result, language: 'ko', destinationIsOwnerDm: true });
    expect(reply.parts.map((part) => part.kind)).toEqual(['fact', 'status', 'summary', 'summary']);
    expect(reply.parts[0]?.text).toBe('• 지라 이슈: 2개 (AB-1, AB-2)');
    expect(reply.parts[1]?.text).toContain('모델이 쓴 요약');
    expect(reply.parts[2]?.text).toBe('지라 이슈 1번: First item is about the rollout.');
    expect(reply.text.split('\n')[0]).toBe(reply.parts[0]?.text);
    expect(reply.label).toMatchObject({ trust: 'UNTRUSTED', egress: 'REMOTE_OK', scope: 'WORK_CHANNEL_OK', sources: ['jira'] });
  });

  it('English facts, a "more" flag, and ids shown only for a field a person reads', async () => {
    const mail = await run([read('mail.list')], { 'mail.list': port(['m-1', 'm-2'], [], true) });
    const reply = assembleAgentReply({ plan: mail.plan as AgentStepsPlan, result: mail.result, language: 'en', destinationIsOwnerDm: true });
    expect(reply.text).toBe('• Mail: 2+');
    expect(reply.text).not.toContain('m-1');
  });

  it('is deterministic: the same run gives the same text, parts and label', async () => {
    const { plan: p, result } = await run([read('jira.issues'), summarize([1])], { 'jira.issues': port(['AB-1', 'AB-2'], [doc(1), doc(2)]) }, SUMMARY);
    const a = assembleAgentReply({ plan: p as AgentStepsPlan, result, language: 'ko', destinationIsOwnerDm: true });
    const b = assembleAgentReply({ plan: p as AgentStepsPlan, result, language: 'ko', destinationIsOwnerDm: true });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('shows no URL from a model: links are neutralized by the summariser and dropped by the second guard', async () => {
    const forged = (text: string): QuarantinedSummary => {
      const label: ModelDerivedLabel = { ...flowLabel('UNTRUSTED', 'REMOTE_OK', 'WORK_CHANNEL_OK', ['jira']), trust: 'UNTRUSTED', derivation: 'MODEL_DERIVED' };
      const entry: SummaryEntry = { n: 1, entryId: 'jira.issues', position: 1, text, topics: [] };
      return new QuarantinedSummary('digest.v1', label, [entry]);
    };
    const { plan: p, result } = await run([read('jira.issues')], { 'jira.issues': port(['AB-1'], []) });
    // Bypass the summariser on purpose: the assembler's own guard must still hold.
    const withSummary: AgentRunResult = {
      ...result,
      steps: [...result.steps, { step: 2, kind: 'summarize', status: 'ok', from: [1], schema: 'digest.v1', summary: forged('go to https://evil.example/x now'), omitted: 0 }],
    };
    const linky = assembleAgentReply({ plan: p as AgentStepsPlan, result: withSummary, language: 'en', destinationIsOwnerDm: true });
    expect(linky.text).not.toMatch(/evil|https?:/);
    expect(linky.text).toContain('[링크]');
    const secret = 'pass' + 'word: ' + 'Zx9Kd8sLq2Zp';
    const leaky = assembleAgentReply({ plan: p as AgentStepsPlan, result: { ...withSummary, steps: [...result.steps, { ...(withSummary.steps[1] as object), summary: forged(`the ${secret}`) } as never] }, language: 'en', destinationIsOwnerDm: true });
    expect(leaky.text).not.toContain('Zx9Kd8sLq2Zp');
    expect(leaky.droppedLines).toBe(1);
    expect(leaky.summaryLines).toBe(0);
  });

  it('a forged summary instance holds no content and renders nothing', async () => {
    const { plan: p, result } = await run([read('jira.issues')], { 'jira.issues': port(['AB-1'], []) });
    const fake = { kind: 'quarantined-summary', schema: 'digest.v1', count: 1, label: {} } as unknown as QuarantinedSummary;
    const reply = assembleAgentReply({ plan: p as AgentStepsPlan, result: { ...result, steps: [...result.steps, { step: 2, kind: 'summarize', status: 'ok', from: [1], schema: 'digest.v1', summary: fake, omitted: 0 }] }, language: 'en', destinationIsOwnerDm: true });
    expect(reply.parts.every((part) => part.kind === 'fact')).toBe(true);
  });

  it('mail data (OWNER_DM_ONLY) is shown only in the owner DM; elsewhere one fixed refusal and none of the content', async () => {
    const { plan: p, result } = await run([read('mail.list')], { 'mail.list': port(['m-1'], []) });
    const elsewhere = assembleAgentReply({ plan: p as AgentStepsPlan, result, language: 'en', destinationIsOwnerDm: false });
    expect(elsewhere.parts).toEqual([{ kind: 'status', text: "This answer can only be shown in the owner's DM." }]);
    const dm = assembleAgentReply({ plan: p as AgentStepsPlan, result, language: 'en', destinationIsOwnerDm: true });
    expect(dm.text).toContain('Mail: 1');
    // A work-channel-safe source is not restricted.
    const jira = await run([read('jira.issues')], { 'jira.issues': port(['AB-1'], []) });
    expect(assembleAgentReply({ plan: jira.plan as AgentStepsPlan, result: jira.result, language: 'en', destinationIsOwnerDm: false }).text).toContain('AB-1');
  });

  it('listing-only is stated, with the listing and no summary line', async () => {
    const { plan: p, result } = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m-1'], [doc(1)]) }, ONE);
    const reply = assembleAgentReply({ plan: p as AgentStepsPlan, result: { ...result }, language: 'ko', destinationIsOwnerDm: true });
    // This run had a local model, so redo it with a remote-only model and no request.
    expect(reply.parts.some((part) => part.kind === 'summary')).toBe(true);
    const remote: QuarantinedSummarizerModel = { executionLocality: 'REMOTE', run: async () => ({ text: ONE }) };
    const only = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m-1'], [doc(1)]) }, summarizer: { models: [remote] } }).execute(p);
    const listing = assembleAgentReply({ plan: p as AgentStepsPlan, result: only, language: 'ko', destinationIsOwnerDm: true });
    expect(listing.parts.map((part) => part.kind)).toEqual(['fact', 'status']);
    expect(listing.parts[1]?.text).toContain('목록만');
  });

  it('a failed summary and a bound stop are fixed status lines; a breach never throws', async () => {
    const failed = await run([read('jira.issues'), summarize([1])], { 'jira.issues': port(['AB-1'], [doc(1)]) }, 'not json');
    expect(assembleAgentReply({ plan: failed.plan as AgentStepsPlan, result: failed.result, language: 'en', destinationIsOwnerDm: true }).text).toContain('A summary could not be made');
    const capped = await run([read('jira.issues'), summarize([1]), summarize([1])], { 'jira.issues': port(['AB-1'], [doc(1)]) }, ONE, { maxM2Calls: 1 });
    const reply = assembleAgentReply({ plan: capped.plan as AgentStepsPlan, result: capped.result, language: 'ko', destinationIsOwnerDm: true });
    expect(reply.parts.at(-1)).toEqual({ kind: 'status', text: '한도에 도달해서 여기까지만 보여드려요.' });
    expect(reply.parts.some((part) => part.kind === 'summary')).toBe(true);
  });

  it('the omitted count is stated after the summaries', async () => {
    const docs = Array.from({ length: 12 }, (_, i) => doc(i + 1));
    const { plan: p, result } = await run([read('jira.issues'), summarize([1])], { 'jira.issues': port(['AB-1'], docs) }, '{"items":[{"n":1,"summary":"s"}]}');
    const reply = assembleAgentReply({ plan: p as AgentStepsPlan, result, language: 'en', destinationIsOwnerDm: true });
    expect(reply.parts.at(-1)?.text).toBe('2 items were left out of the summary.');
  });

  it('the log is content-free: ids and counters only', async () => {
    const logger = log();
    const { plan: p, result } = await run([read('jira.issues'), summarize([1])], { 'jira.issues': port(['AB-1'], [doc(1, 'RAW-BODY-CANARY-12')]) }, '{"items":[{"n":1,"summary":"CANARY-SUMMARY-33"}]}');
    assembleAgentReply({ plan: p as AgentStepsPlan, result, language: 'ko', destinationIsOwnerDm: true, logger });
    expect(logger.lines).toEqual([{ message: 'agent_run.assemble', fields: { parts: 3, facts: 1, summaryLines: 1, droppedLines: 0 } }]);
    expect(JSON.stringify(logger.lines)).not.toMatch(/CANARY|AB-1/);
  });
});

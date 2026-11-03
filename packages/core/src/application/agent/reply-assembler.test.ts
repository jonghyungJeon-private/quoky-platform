import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowLabel } from '../../domain/flow-label';
import type { Logger } from '../../ports/logger.port';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AgentPlanExecutor, type AgentReadPort, type AgentRunResult, type AgentStepResult } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import {
  QUARANTINED_LISTING_ONLY_REASONS,
  sealQuarantinedSummaryForTest,
  setSummaryGrantsForTest,
  type AgentSourceDocument,
  type ModelDerivedLabel,
  type QuarantinedSummarizerModel,
  type SummaryEntry,
} from './quarantined-summary';
import { assembleAgentReply } from './reply-assembler';
import type { AgentStepsPlan } from './reply-notes';

// ADR-0121 D3/D4 (stage S2 P3-3b): the deterministic reply assembler. Summaries come through the real path (the executor and the
// summariser, with the grant test seam on) or, to bypass the summariser's own guards, through the sealing test seam.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const read = (entryId: NlWave1EntryId): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit: 1 }, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });
const doc = (position: number, body = 'body'): AgentSourceDocument => ({ id: `m${position}`, position, title: 't', author: 'a', date: '2026-11-01T09:00:00.000Z', body });
const port = (ids: readonly string[], documents: readonly AgentSourceDocument[], more = false): AgentReadPort => ({
  read: async (request) => (request.budget.reserveQuery() && request.budget.reserveHttp() ? { ok: true, items: ids.map((id) => ({ id })), documents, ...(more ? { hasMore: true } : {}) } : { ok: false, code: 'BOUND' }),
});
const model = (locality: 'LOCAL' | 'REMOTE', answer: string): QuarantinedSummarizerModel => ({ executionLocality: locality, auditId: `audit-${locality}`, run: async () => ({ text: answer }) });
const log = (): Logger & { lines: unknown[] } => {
  const lines: unknown[] = [];
  const push = (message: string, fields?: unknown): void => void lines.push({ message, fields });
  return { lines, info: push, warn: push, error: push };
};

async function run(steps: ValidatedAgentStep[], readers: Partial<Record<NlWave1EntryId, AgentReadPort>>, answer?: string, bounds = {}, locality: 'LOCAL' | 'REMOTE' = 'LOCAL'): Promise<{ plan: RunPlan; result: AgentRunResult }> {
  const p = plan(steps);
  const result = await new AgentPlanExecutor({ readers, ...(answer !== undefined ? { summarizer: { models: [model(locality, answer)] } } : {}), bounds }).execute(p);
  return { plan: p, result };
}

const ONE = '{"items":[{"n":1,"summary":"Only item."}]}';
const SUMMARY = '{"items":[{"n":1,"summary":"First item is about the rollout."},{"n":2,"summary":"Second item is blocked."}]}';
const reply = (r: { plan: RunPlan; result: AgentRunResult }, language: 'ko' | 'en' = 'ko', destinationIsOwnerDm = true) => assembleAgentReply({ plan: r.plan as AgentStepsPlan, result: r.result, language, destinationIsOwnerDm });

beforeEach(() => setSummaryGrantsForTest(() => true));
afterEach(() => setSummaryGrantsForTest());

describe('reply assembler', () => {
  it('puts Core facts first, then notes, then the model summaries, then fixed status lines', async () => {
    const r = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1', 'm2'], [doc(1), doc(2)]) }, SUMMARY);
    const out = reply(r);
    expect(out.parts.map((part) => part.kind)).toEqual(['fact', 'status', 'summary', 'summary']);
    expect(out.parts[0]?.text).toBe('• 메일: 2개');
    expect(out.parts[1]?.text).toContain('모델이 쓴 요약');
    expect(out.parts[2]?.text).toBe('메일 1번: First item is about the rollout.');
    expect(out.text.split('\n')[0]).toBe(out.parts[0]?.text);
    expect(out.label).toMatchObject({ trust: 'UNTRUSTED', egress: 'REMOTE_ON_SUMMARY_REQUEST', scope: 'OWNER_DM_ONLY', sources: ['mail'] });
  });

  it('English facts, a "more" flag, and ids shown only for a field a person reads', async () => {
    const mail = await run([read('mail.list')], { 'mail.list': port(['m-1', 'm-2'], [], true) });
    const out = reply(mail, 'en');
    expect(out.text).toBe('• Mail: 2+');
    expect(out.text).not.toContain('m-1');
  });

  it('a Jira listing shows its issue keys and nothing a model wrote', async () => {
    const jira = await run([read('jira.issues'), summarize([1])], { 'jira.issues': port(['AB-1', 'AB-2'], [doc(1), doc(2)]) }, SUMMARY);
    const out = reply(jira);
    expect(out.parts[0]?.text).toBe('• 지라 이슈: 2개 (AB-1, AB-2)');
    expect(out.parts.some((part) => part.kind === 'summary')).toBe(false);
    expect(out.label).toMatchObject({ egress: 'REMOTE_OK', scope: 'WORK_CHANNEL_OK', sources: ['jira'] });
  });

  it('is deterministic and `parts` is frozen: the same run gives the same text, parts and label', async () => {
    const r = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1', 'm2'], [doc(1), doc(2)]) }, SUMMARY);
    const a = reply(r);
    const b = reply(r);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(Object.isFrozen(a.parts)).toBe(true);
    expect(a.parts.every((part) => Object.isFrozen(part))).toBe(true);
    // `text` is exactly the parts joined: parts are the one rendering input.
    expect(a.text).toBe(a.parts.map((part) => part.text).join('\n'));
  });

  describe('the second guard on a summary the summariser could not have produced (sealed through the test seam)', () => {
    const label: ModelDerivedLabel = { ...flowLabel('UNTRUSTED', 'REMOTE_ON_SUMMARY_REQUEST', 'OWNER_DM_ONLY', ['mail']), trust: 'UNTRUSTED', derivation: 'MODEL_DERIVED' };
    const sealed = async (text: string, topics: string[] = []): Promise<AssemblerCase> => {
      const base = await run([read('mail.list')], { 'mail.list': port(['m1'], []) });
      const entry: SummaryEntry = { n: 1, entryId: 'mail.list', position: 1, text, topics };
      const step: AgentStepResult = { step: 2, kind: 'summarize', status: 'ok', from: [1], schema: 'digest.v1', summary: sealQuarantinedSummaryForTest('digest.v1', label, [entry]), omitted: 0, audit: { locality: 'LOCAL', auditId: 'a', estimatedTokens: 1, latencyMs: 1 } };
      return { plan: base.plan, result: { ...base.result, steps: [...base.result.steps, step] } };
    };
    type AssemblerCase = { plan: RunPlan; result: AgentRunResult };

    it('a link is neutralized, and a credential or an action claim drops the line with the fixed "cannot show" status', async () => {
      const linky = reply(await sealed('go to https://evil.example/x now'), 'en');
      expect(linky.text).not.toMatch(/evil|https?:/);
      expect(linky.text).toContain('[링크]');
      const secret = 'pass' + 'word: ' + 'Zx9Kd8sLq2Zp';
      for (const text of [`the ${secret}`, '할 일을 추가했어요', 'I forwarded the email', '답장을 보냈어요']) {
        const out = reply(await sealed(text), 'en');
        expect(out.text, text).not.toContain('Zx9Kd8sLq2Zp');
        expect(out.text, text).not.toMatch(/forwarded|추가했어요|보냈어요/);
        expect(out.droppedLines, text).toBe(1);
        expect(out.summaryLines, text).toBe(0);
        expect(out.parts.at(-1), text).toEqual({ kind: 'status', text: 'A summary could not be shown.' });
      }
    });

    it('an action claim in a topic drops the line too', async () => {
      const out = reply(await sealed('fine summary', ['I forwarded the email']), 'en');
      expect(out.droppedLines).toBe(1);
      expect(out.parts.some((part) => part.kind === 'summary')).toBe(false);
    });

    it('a third-person sentence about the sender is shown', async () => {
      const out = reply(await sealed('The vendor sent the invoice.'), 'en');
      expect(out.summaryLines).toBe(1);
      expect(out.droppedLines).toBe(0);
    });

    it('an entry of a source with no readout shape cannot be judged and is dropped', async () => {
      const base = await run([read('mail.list')], { 'mail.list': port(['m1'], []) });
      const entry: SummaryEntry = { n: 1, entryId: 'calendar.events', position: 1, text: 'standup', topics: [] };
      const step: AgentStepResult = { step: 2, kind: 'summarize', status: 'ok', from: [1], schema: 'digest.v1', summary: sealQuarantinedSummaryForTest('digest.v1', label, [entry]), omitted: 0, audit: { locality: 'LOCAL', auditId: 'a', estimatedTokens: 1, latencyMs: 1 } };
      const out = reply({ plan: base.plan, result: { ...base.result, steps: [...base.result.steps, step] } }, 'en');
      expect(out.droppedLines).toBe(1);
      expect(out.text).not.toContain('standup');
    });
  });

  it('a forged summary instance holds no content: it renders nothing, not even its label', async () => {
    const r = await run([read('jira.issues')], { 'jira.issues': port(['AB-1'], []) });
    const fake = { kind: 'quarantined-summary', schema: 'digest.v1', count: 1, label: flowLabel('UNTRUSTED', 'HOST_ONLY', 'OWNER_DM_ONLY', ['x']) } as never;
    const out = reply({ plan: r.plan, result: { ...r.result, steps: [...r.result.steps, { step: 2, kind: 'summarize', status: 'ok', from: [1], schema: 'digest.v1', summary: fake, omitted: 0, audit: { locality: 'LOCAL', auditId: 'a', estimatedTokens: 1, latencyMs: 1 } }] } }, 'en');
    expect(out.parts.every((part) => part.kind === 'fact')).toBe(true);
    expect(out.label.egress).toBe('REMOTE_OK');
  });

  it('S6: a forged summary step with a REMOTE audit renders the facts and exactly the disclosure line, no summary text', async () => {
    const r = await run([read('jira.issues')], { 'jira.issues': port(['AB-1'], []) });
    const fake = { kind: 'quarantined-summary', schema: 'digest.v1', count: 1, label: flowLabel('UNTRUSTED', 'HOST_ONLY', 'OWNER_DM_ONLY', ['x']) } as never;
    const step = { step: 2, kind: 'summarize', status: 'ok', from: [1], schema: 'digest.v1', summary: fake, omitted: 0, audit: { locality: 'REMOTE', auditId: 'a', estimatedTokens: 1, latencyMs: 1 } } as AgentStepResult;
    const out = reply({ plan: r.plan, result: { ...r.result, steps: [...r.result.steps, step] } }, 'en');
    expect(out.parts.filter((part) => part.kind !== 'fact' && part.kind !== 'note')).toEqual([{ kind: 'status', text: 'Part of the original text was sent to an outside model to make this summary.' }]);
    expect(out.parts.some((part) => part.kind === 'summary')).toBe(false);
  });

  it('only the owner DM gets content: any other destination gets the one fixed refusal, whatever the label', async () => {
    const mail = await run([read('mail.list')], { 'mail.list': port(['m-1'], []) });
    const jira = await run([read('jira.issues')], { 'jira.issues': port(['AB-1'], []) });
    const todo = await run([read('todo.list')], { 'todo.list': port([], []) });
    for (const r of [mail, jira, todo]) {
      const elsewhere = reply(r, 'en', false);
      expect(elsewhere.parts).toEqual([{ kind: 'status', text: "This answer can only be shown in the owner's DM." }]);
      expect(elsewhere.text).not.toMatch(/AB-1|Mail|Jira/);
    }
    expect(reply(mail, 'en', true).text).toContain('Mail: 1');
    expect(reply(jira, 'en', true).text).toContain('AB-1');
  });

  describe('listing-only: each closed reason has its own fixed line', () => {
    const step = (reason: (typeof QUARANTINED_LISTING_ONLY_REASONS)[number], n = 2): AgentStepResult => ({ step: n, kind: 'summarize', status: 'listing-only', from: [1], schema: 'digest.v1', reason });

    it('every reason says something different, and none of them claims "cannot be sent" unless it is true', async () => {
      const base = await run([read('mail.list')], { 'mail.list': port(['m1'], []) });
      for (const language of ['ko', 'en'] as const) {
        const lines = new Map<string, string>();
        for (const reason of QUARANTINED_LISTING_ONLY_REASONS) {
          const out = reply({ plan: base.plan, result: { ...base.result, steps: [...base.result.steps, step(reason)] } }, language);
          expect(out.parts.map((part) => part.kind), reason).toEqual(['fact', 'status']);
          lines.set(reason, out.parts[1]?.text ?? '');
        }
        expect(new Set(lines.values()).size).toBe(QUARANTINED_LISTING_ONLY_REASONS.length);
        for (const reason of ['no-documents', 'no-readout-source'] as const) expect(lines.get(reason), `${language} ${reason}`).not.toMatch(/보낼 수 없|cannot be sent|cannot leave|may receive/);
      }
    });

    it('two steps with the same reason show one line; different reasons show each', async () => {
      const base = await run([read('mail.list')], { 'mail.list': port(['m1'], []) });
      const out = reply({ plan: base.plan, result: { ...base.result, steps: [...base.result.steps, step('no-model', 2), step('no-model', 3), step('host-only', 4)] } }, 'en');
      expect(out.parts.filter((part) => part.kind === 'status')).toHaveLength(2);
    });

    it('production today: mail with a model but no grant is listing-only with the no-grant line', async () => {
      setSummaryGrantsForTest();
      const r = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) }, ONE);
      const out = reply(r);
      expect(out.parts.map((part) => part.kind)).toEqual(['fact', 'status']);
      expect(out.parts[1]?.text).toContain('원문은 읽지 않고');
    });
  });

  it('a deferred step (no summariser) says the summary cannot be shown, never nothing', async () => {
    const r = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) });
    expect(reply(r).parts.at(-1)).toEqual({ kind: 'status', text: '요약을 보여드릴 수 없었어요.' });
  });

  it('a failed summary and a bound stop are fixed status lines; a breach never throws', async () => {
    const failed = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) }, 'not json');
    expect(reply(failed, 'en').text).toContain('A summary could not be made');
    const capped = await run([read('mail.list'), summarize([1]), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) }, ONE, { maxM2Calls: 1 });
    const out = reply(capped);
    expect(out.parts.at(-1)).toEqual({ kind: 'status', text: '한도에 도달해서 여기까지만 보여드려요.' });
    expect(out.parts.some((part) => part.kind === 'summary')).toBe(true);
  });

  it('the omitted count is stated after the summaries (items beyond the cap, and items the model left out)', async () => {
    const many = Array.from({ length: 12 }, (_, i) => doc(i + 1));
    const capped = await run([read('mail.list'), summarize([1])], { 'mail.list': port(Array.from({ length: 12 }, (_, i) => `m${i + 1}`), many) }, '{"items":[{"n":1,"summary":"s"},{"n":2,"summary":"s"},{"n":3,"summary":"s"},{"n":4,"summary":"s"},{"n":5,"summary":"s"},{"n":6,"summary":"s"},{"n":7,"summary":"s"},{"n":8,"summary":"s"},{"n":9,"summary":"s"},{"n":10,"summary":"s"}]}');
    expect(reply(capped, 'en').parts.at(-1)?.text).toBe('2 items were left out of the summary.');
    const skipped = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1', 'm2', 'm3'], [doc(1), doc(2), doc(3)]) }, '{"items":[{"n":2,"summary":"s"}]}');
    const out = reply(skipped, 'en');
    expect(out.parts.at(-1)?.text).toBe('2 items were left out of the summary.');
    expect(skipped.result.outcome).toBe('partial');
  });

  it('a summary made by a REMOTE model carries the fixed disclosure line; a LOCAL one does not', async () => {
    const remote = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) }, ONE, {}, 'REMOTE');
    const withRemote = reply(remote, 'en');
    expect(withRemote.parts.at(-1)).toEqual({ kind: 'status', text: 'Part of the original text was sent to an outside model to make this summary.' });
    expect(reply(remote, 'ko').parts.at(-1)?.text).toContain('외부 모델');
    const local = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) }, ONE, {}, 'LOCAL');
    expect(reply(local, 'en').text).not.toContain('outside model');
  });

  it('the log is content-free: ids and counters only', async () => {
    const logger = log();
    const r = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1, 'RAW-BODY-CANARY-12')]) }, '{"items":[{"n":1,"summary":"CANARY-SUMMARY-33"}]}');
    assembleAgentReply({ plan: r.plan as AgentStepsPlan, result: r.result, language: 'ko', destinationIsOwnerDm: true, logger });
    expect(logger.lines).toEqual([{ message: 'agent_run.assemble', fields: { parts: 3, facts: 1, summaryLines: 1, droppedLines: 0 } }]);
    expect(JSON.stringify(logger.lines)).not.toMatch(/CANARY|m1/);
  });

  it('N1: a REMOTE call is disclosed even when it failed or was cut off', async () => {
    const failed = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) }, 'not json', {}, 'REMOTE');
    expect(failed.result.steps[1]).toMatchObject({ status: 'failed', audit: { locality: 'REMOTE' } });
    expect(reply(failed, 'en').parts.map((part) => part.text)).toContain('Part of the original text was sent to an outside model to make this summary.');
    const local = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) }, 'not json', {}, 'LOCAL');
    expect(reply(local, 'en').parts.map((part) => part.text)).not.toContain('Part of the original text was sent to an outside model to make this summary.');
  });

  it('C3/N5: a throwing logger never fails the assembler', async () => {
    const r = await run([read('mail.list'), summarize([1])], { 'mail.list': port(['m1'], [doc(1)]) }, ONE);
    const bad: Logger = { info: () => { throw new Error('log down'); }, warn: () => undefined, error: () => undefined };
    const out = assembleAgentReply({ plan: r.plan as AgentStepsPlan, result: r.result, language: 'en', destinationIsOwnerDm: true, logger: bad });
    expect(out.parts.length).toBeGreaterThan(0);
  });
});

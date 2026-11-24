import { afterEach, describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AGENT_WORK_SUMMARY_SOURCES, workSummarySourceOf } from './flow-policy';
import { AgentPlanExecutor, type AgentReadPort, type AgentRunResult } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import {
  AGENT_M2_SUMMARY_MAX_CHARS,
  AGENT_SUMMARY_WORK_TEXT_PENDING,
  parseQuarantinedOutput,
  quarantinedSummarize,
  mintSummaryEgressGrantForTest,
  newSummaryRunToken,
  setSummaryGrantsForTest,
  type QuarantinedSummarizerRoute,
} from './quarantined-summary';
import { assembleAgentReply } from './reply-assembler';
import type { AgentStepsPlan } from './reply-notes';

// ADR-0121 A5-S2: the digest schemas per source (one line of at most 280 characters, URL-free, credential guard), the reply's
// per-source model-written marker and the per-source REMOTE disclosure line. No model prompt template and no catalog entry changed;
// the per-source switches stay default off and an off run is pinned below to carry none of this.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const WORK = ['calendar.events', 'jira.issues', 'jira.release', 'slack.search', 'confluence.search', 'github.items'] as const satisfies readonly NlWave1EntryId[];
const read = (entryId: NlWave1EntryId): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit: 1 }, provenance: {} });
const schemaOf = (entryId: NlWave1EntryId) => (entryId === 'calendar.events' ? 'meeting-digest.v1' : 'digest.v1') as 'digest.v1' | 'meeting-digest.v1';
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });
const ITEM: Readonly<Record<string, Record<string, unknown>>> = {
  'calendar.events': { id: 'ev1', title: 'Planning sync', description: 'Agree the plan' },
  'jira.issues': { id: 'AB-1', title: 'Checkout fails', excerpt: 'Steps' },
  'jira.release': { id: 'AB-2', title: 'Release item' },
  'slack.search': { id: 'C1-1700000000.0001', text: 'Ship it on Friday', author: 'Alex Rivers' },
  'confluence.search': { id: '1001', title: 'Runbook', excerpt: 'Restart the worker' },
  'github.items': { id: 'o/r#1', title: 'Fix the parser', excerpt: 'Handles empty input' },
};
const port = (item: Record<string, unknown>): AgentReadPort => ({
  read: async (request) => (request.budget.reserveQuery() && request.budget.reserveHttp() ? { ok: true, items: [item] } : { ok: false, code: 'BOUND' }),
});

function route(locality: 'LOCAL' | 'REMOTE', answer: string, on: QuarantinedSummarizerRoute['workSummarySources'] | undefined, requests: AiRequest[] = []): QuarantinedSummarizerRoute {
  const provider: AiProvider = {
    id: `audit-${locality}`,
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 100 }],
    executionLocality: locality,
    ...(locality === 'REMOTE' ? { dataUse: 'no-training' as const } : {}),
    isAvailable: async () => true,
    execute: async (request: AiRequest) => (requests.push(request), { text: answer }),
  };
  const policy: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
  return { selector: new CapabilityRouter(new AiProviderManager([provider]), policy), ...(on !== undefined ? { workSummarySources: on } : {}) };
}
const grantAll = (): void => setSummaryGrantsForTest(() => true);
afterEach(() => setSummaryGrantsForTest());

async function run(entryId: NlWave1EntryId, locality: 'LOCAL' | 'REMOTE', answer: string, on: QuarantinedSummarizerRoute['workSummarySources'] | undefined): Promise<{ plan: RunPlan; result: AgentRunResult }> {
  grantAll();
  const p = plan([read(entryId), { kind: 'summarize', from: [1], schema: schemaOf(entryId) }]);
  const result = await new AgentPlanExecutor({ readers: { [entryId]: port(ITEM[entryId] as Record<string, unknown>) }, summarizer: route(locality, answer, on) }).execute(p);
  return { plan: p, result };
}
const reply = (r: { plan: RunPlan; result: AgentRunResult }, language: 'ko' | 'en') => assembleAgentReply({ plan: r.plan as AgentStepsPlan, result: r.result, language, destinationIsOwnerDm: true });
const answerOf = (entryId: NlWave1EntryId): string => (entryId === 'calendar.events' ? '{"items":[{"n":1,"summary":"A short sync.","topics":["plan"]}]}' : '{"items":[{"n":1,"summary":"A short note."}]}');
const EN_NAME: Readonly<Record<string, string>> = { calendar: 'Calendar', jira: 'Jira', slack: 'Slack', confluence: 'Confluence', github: 'GitHub' };
const KO_NAME: Readonly<Record<string, string>> = { calendar: '캘린더', jira: '지라', slack: '슬랙', confluence: '컨플루언스', github: '깃허브' };
const numbered = (entryId: NlWave1EntryId) => [{ n: 1, entryId, position: 1 }];

describe('A5-S2 schema validation per source', () => {
  it.each(WORK)('%s: accepts one line of at most 280 characters and rejects every other shape', (entryId) => {
    const schema = schemaOf(entryId);
    const extra = schema === 'meeting-digest.v1' ? ',"topics":[]' : '';
    const wrap = (summary: string): string => JSON.stringify({ items: [{ n: 1, summary, ...(schema === 'meeting-digest.v1' ? { topics: [] } : {}) }] });
    expect(parseQuarantinedOutput(schema, wrap('x'.repeat(AGENT_M2_SUMMARY_MAX_CHARS)), numbered(entryId)).ok).toBe(true);
    for (const bad of ['x'.repeat(AGENT_M2_SUMMARY_MAX_CHARS + 1), 'first line\nsecond line', 'one\r\ntwo', 'one\u2028two', 'one\u0085two', 'one\u000btwo', 'one\u000ctwo', '']) {
      expect(parseQuarantinedOutput(schema, wrap(bad), numbered(entryId)), JSON.stringify(bad)).toEqual({ ok: false, reason: 'schema' });
    }
    // One sentence: a terminator followed by whitespace and more text is a second sentence; a final or inner (3.5, v1.2) one is fine.
    for (const bad of ['회의를 했다. 다음 주에 배포한다.', 'Shipped it. Next is QA', '何かした。 次もする', 'Really? yes']) {
      expect(parseQuarantinedOutput(schema, wrap(bad), numbered(entryId)), JSON.stringify(bad)).toEqual({ ok: false, reason: 'schema' });
    }
    for (const good of ['버전 3.5 배포를 논의했다.', '끝났다!', 'Upgrade to v1.2 done.', '完了した。']) {
      expect(parseQuarantinedOutput(schema, wrap(good), numbered(entryId)).ok, good).toBe(true);
    }
    // A link is neutralised to a fixed placeholder (URL-free output, as for mail and Drive), never passed through.
    for (const link of ['see https://example.test/page now', 'see www.example.test now']) {
      const parsed = parseQuarantinedOutput(schema, wrap(link), numbered(entryId));
      expect(parsed.ok ? JSON.stringify(parsed.entries) : 'failed', link).not.toContain('example.test');
    }
    expect(parseQuarantinedOutput(schema, `{"items":[{"n":1,"summary":"ok"${extra},"extra":1}]}`, numbered(entryId))).toEqual({ ok: false, reason: 'schema' });
    expect(parseQuarantinedOutput(schema, `{"items":[{"n":2,"summary":"ok"${extra}}]}`, numbered(entryId))).toEqual({ ok: false, reason: 'schema' });
    expect(parseQuarantinedOutput(schema, 'Sure! ' + wrap('ok'), numbered(entryId))).toEqual({ ok: false, reason: 'schema' });
  });

  it('a credential-shaped summary fails the whole output with the closed reason, for every source', () => {
    const secret = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    for (const entryId of WORK) {
      const schema = schemaOf(entryId);
      const text = JSON.stringify({ items: [{ n: 1, summary: `token ${secret}`, ...(schema === 'meeting-digest.v1' ? { topics: [] } : {}) }] });
      expect(parseQuarantinedOutput(schema, text, numbered(entryId)), entryId).toEqual({ ok: false, reason: 'credential' });
    }
  });

  it('credential material wins over a line break in a work-source summary', () => {
    const secret = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    for (const entryId of WORK) {
      const schema = schemaOf(entryId);
      const text = JSON.stringify({ items: [{ n: 1, summary: `token ${secret}\nmore`, ...(schema === 'meeting-digest.v1' ? { topics: [] } : {}) }] });
      expect(parseQuarantinedOutput(schema, text, numbered(entryId)), entryId).toEqual({ ok: false, reason: 'credential' });
    }
  });

  it('the calendar digest keeps at most three short topics; digest.v1 takes no topics key; meeting-digest.v1 is calendar only', async () => {
    const cal = numbered('calendar.events');
    expect(parseQuarantinedOutput('meeting-digest.v1', '{"items":[{"n":1,"summary":"s","topics":["a","b","c"]}]}', cal).ok).toBe(true);
    expect(parseQuarantinedOutput('meeting-digest.v1', '{"items":[{"n":1,"summary":"s","topics":["a","b","c","d"]}]}', cal).ok).toBe(false);
    expect(parseQuarantinedOutput('meeting-digest.v1', `{"items":[{"n":1,"summary":"s","topics":["${'t'.repeat(61)}"]}]}`, cal).ok).toBe(false);
    expect(parseQuarantinedOutput('meeting-digest.v1', '{"items":[{"n":1,"summary":"s","topics":["a\\nb"]}]}', cal)).toEqual({ ok: false, reason: 'schema' });
    expect(parseQuarantinedOutput('digest.v1', '{"items":[{"n":1,"summary":"s","topics":[]}]}', numbered('jira.issues')).ok).toBe(false);
    const token = newSummaryRunToken();
    grantAll();
    for (const entryId of ['jira.issues', 'slack.search', 'confluence.search', 'github.items'] as const) {
      const outcome = await quarantinedSummarize({
        schema: 'meeting-digest.v1', summaryStep: 1, run: token, route: route('LOCAL', answerOf(entryId), AGENT_WORK_SUMMARY_SOURCES), reserve: () => true,
        sources: [{ entryId, documents: [{ id: 'x', position: 1, title: 't', author: '', date: '', body: 'b' }], grant: mintSummaryEgressGrantForTest(1, entryId, token) }],
      });
      expect(outcome, entryId).toEqual({ kind: 'listing-only', reason: 'no-readout-source' });
    }
  });
});

describe('A5-S2 the reply: per-source marker and REMOTE disclosure', () => {
  it.each(WORK)('%s: a LOCAL summary carries the model-written marker and no disclosure', async (entryId) => {
    const out = reply(await run(entryId, 'LOCAL', answerOf(entryId), AGENT_WORK_SUMMARY_SOURCES), 'en');
    expect(out.parts.filter((part) => part.kind === 'summary')).toHaveLength(1);
    expect(out.parts.find((part) => part.kind === 'summary')?.text.startsWith('[Model summary] ')).toBe(true);
    expect(out.text).not.toContain('outside model');
  });

  it.each(WORK)('%s: a REMOTE summary is disclosed by one line naming its source (ko and en), never the generic line', async (entryId) => {
    const r = await run(entryId, 'REMOTE', answerOf(entryId), AGENT_WORK_SUMMARY_SOURCES);
    const step = r.result.steps[1];
    expect(step).toMatchObject({ kind: 'summarize', status: 'ok' });
    expect(step?.kind === 'summarize' && 'audits' in step ? step.audits?.[0]?.workSources : undefined).toEqual([workSummarySourceOf(entryId)]);
    const name = workSummarySourceOf(entryId) as string;
    const en = reply(r, 'en').parts.filter((part) => part.text.includes('outside model'));
    expect(en.map((part) => part.text)).toEqual([`Part of the original ${EN_NAME[name]} text was sent to an outside model to make this summary.`]);
    const ko = reply(r, 'ko').parts.filter((part) => part.text.includes('외부 모델'));
    expect(ko.map((part) => part.text)).toEqual([`${KO_NAME[name]} 요약을 만들려고 ${KO_NAME[name]} 원문 일부를 외부 모델로 보냈어요.`]);
  });

  it('a LOCAL-only calendar summary (the LOCAL_MODEL_ONLY default) is not disclosed as remote', async () => {
    const out = reply(await run('calendar.events', 'LOCAL', answerOf('calendar.events'), ['calendar']), 'en');
    expect(out.text).not.toContain('outside model');
  });

  it('switch off: no marker, no per-source disclosure and no audit carries a work source (listing only, nothing sent)', async () => {
    for (const entryId of WORK) {
      for (const off of [undefined, [], [workSummarySourceOf(entryId) === 'github' ? 'jira' : 'github']] as const) {
        const requests: AiRequest[] = [];
        grantAll();
        const p = plan([read(entryId), { kind: 'summarize', from: [1], schema: schemaOf(entryId) }]);
        const result = await new AgentPlanExecutor({ readers: { [entryId]: port(ITEM[entryId] as Record<string, unknown>) }, summarizer: route('REMOTE', answerOf(entryId), off as unknown as QuarantinedSummarizerRoute['workSummarySources'], requests) }).execute(p);
        const r = { plan: p, result };
        expect(requests, entryId).toHaveLength(0);
        expect(r.result.steps[1], entryId).toMatchObject({ kind: 'summarize', status: 'listing-only', reason: AGENT_SUMMARY_WORK_TEXT_PENDING.includes(entryId) ? 'work-text-controls-not-built' : 'no-readout-source' });
        expect(JSON.stringify(r.result), entryId).not.toContain('workSources');
        const out = reply(r, 'en');
        expect(out.parts.some((part) => part.kind === 'summary'), entryId).toBe(false);
        expect(out.text, entryId).not.toContain('[Model summary]');
        expect(out.text, entryId).not.toContain('outside model');
      }
    }
  });
});

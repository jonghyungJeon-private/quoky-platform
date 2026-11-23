import { afterEach, describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { renderUntrustedDocumentHistoryNote } from '../untrusted-document-readout';
import { AGENT_WORK_SUMMARY_SOURCES, readOutputLabel, summaryReadModeOf, summaryReadoutLabel, workSummarySourceOf } from './flow-policy';
import { AgentPlanExecutor, type AgentReadPort, type AgentReadRequest, type AgentReadResponse } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import {
  AGENT_SUMMARY_READOUT_SOURCE,
  mintSummaryEgressGrantForTest,
  newSummaryRunToken,
  quarantinedSummarize,
  setSummaryGrantsForTest,
  summaryEntriesForAssembler,
  summaryReadiness,
  type QuarantinedSummarizerRoute,
} from './quarantined-summary';
import { WORK_SUMMARY_FIELDS, projectWorkSummaryDocuments } from './work-summary-projection';

// ADR-0121 A5-S1: the summary-readout label and shapes of calendar, Jira, Slack, Confluence and GitHub, the A5.2 field
// projection from the listing response, the A5.3 provider constraints, and the per-source switch (default off). With every
// switch off the behaviour is the pre-A5 one, byte for byte (pinned below against a run with no summarizer at all).

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const WORK_ENTRIES = ['calendar.events', 'jira.issues', 'jira.release', 'slack.search', 'confluence.search', 'github.items'] as const satisfies readonly NlWave1EntryId[];
const read = (entryId: NlWave1EntryId): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit: 2 }, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });

interface SpyPort extends AgentReadPort {
  readonly requests: AgentReadRequest[];
}
/** A port that answers with the given raw items (all their members), counting every request it gets. */
function port(items: readonly Record<string, unknown>[]): SpyPort {
  const requests: AgentReadRequest[] = [];
  return {
    requests,
    read: async (request) => {
      requests.push(request);
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      const response: AgentReadResponse = { ok: true, items };
      return response;
    },
  };
}

interface Model {
  readonly locality: 'LOCAL' | 'REMOTE';
  readonly dataUse?: 'no-training';
  readonly requests: AiRequest[];
  readonly provider: AiProvider;
}
function model(locality: 'LOCAL' | 'REMOTE', dataUse?: 'no-training', answer = '{"items":[{"n":1,"summary":"SUMMARY-OK one"}]}'): Model {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    id: `audit-${locality}-${dataUse ?? 'plain'}`,
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 100 }],
    executionLocality: locality,
    ...(dataUse !== undefined ? { dataUse } : {}),
    isAvailable: async () => true,
    execute: async (request: AiRequest) => (requests.push(request), { text: answer }),
  };
  return { locality, ...(dataUse !== undefined ? { dataUse } : {}), requests, provider };
}
function route(models: readonly Model[], workSummarySources?: QuarantinedSummarizerRoute['workSummarySources']): QuarantinedSummarizerRoute {
  const policy: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
  const selector = new CapabilityRouter(new AiProviderManager(models.map((m, index) => ({ ...m.provider, capabilities: [{ capability: Capability.SUMMARIZATION, priority: 100 - index }] }))), policy);
  return { selector, ...(workSummarySources !== undefined ? { workSummarySources } : {}) };
}
const grantAll = (): void => setSummaryGrantsForTest(() => true);
afterEach(() => setSummaryGrantsForTest());

const RAW: Readonly<Record<(typeof WORK_ENTRIES)[number], Record<string, unknown>>> = {
  'calendar.events': { id: 'ev1', title: 'Planning sync', location: 'Room 4', description: 'Agree the launch plan', people: ['Alex Rivers', 'Sam Poe'], conference: 'CANARY-CONF', start: 'CANARY-START' },
  'jira.issues': { id: 'AB-1', title: 'Checkout fails', excerpt: 'Steps to reproduce', comment: 'CANARY-COMMENT', summary: 'CANARY-WRONG-MEMBER', people: ['Alex Rivers', 'Sam Poe'] },
  'jira.release': { id: 'AB-2', title: 'Release item', excerpt: 'CANARY-NO-DESCRIPTION-HERE' },
  'slack.search': { id: 'C1-1700000000.0001', text: 'Ship it on Friday', author: 'Alex Rivers', thread: 'CANARY-THREAD', permalink: 'CANARY-LINK' },
  'confluence.search': { id: '1001', title: 'Runbook', excerpt: 'Restart the worker', people: ['Sam Poe'], children: 'CANARY-CHILD' },
  'github.items': { id: 'o/r#1', title: 'Fix the parser', excerpt: 'Handles empty input', people: ['alexrivers'], comments: 'CANARY-DIFF' },
};
const FIX_IDS: Record<(typeof WORK_ENTRIES)[number], string> = Object.fromEntries(WORK_ENTRIES.map((entry) => [entry, String(RAW[entry].id)])) as never;

describe('A5-S1 labels and shapes', () => {
  it('the summary-readout label of the five sources is UNTRUSTED, REMOTE_ON_SUMMARY_REQUEST, OWNER_DM_ONLY', () => {
    for (const entryId of WORK_ENTRIES) {
      expect(summaryReadoutLabel(entryId), entryId).toEqual({ trust: 'UNTRUSTED', egress: 'REMOTE_ON_SUMMARY_REQUEST', scope: 'OWNER_DM_ONLY', sources: [workSummarySourceOf(entryId)] });
    }
    expect([...AGENT_WORK_SUMMARY_SOURCES]).toEqual(['calendar', 'jira', 'slack', 'confluence', 'github']);
  });

  it('every other use keeps its label: the listing label of each source is pinned explicitly (the GitHub readOutputLabel fix)', () => {
    expect(readOutputLabel('calendar.events').egress).toBe('LOCAL_MODEL_ONLY');
    for (const entryId of ['jira.issues', 'jira.release', 'slack.search', 'confluence.search', 'github.items'] as const) {
      expect(readOutputLabel(entryId), entryId).toMatchObject({ trust: 'UNTRUSTED', egress: 'REMOTE_OK', scope: 'WORK_CHANNEL_OK' });
    }
    expect(readOutputLabel('github.items').sources).toEqual(['github']);
    expect(readOutputLabel('mail.list').egress).toBe('REMOTE_ON_SUMMARY_REQUEST');
    // Mail, Drive and the local stores use the read label for a summary too.
    for (const entryId of ['mail.list', 'drive.files', 'todo.list', 'reminder.list', 'brief.today', 'help.topic'] as const) expect(summaryReadoutLabel(entryId), entryId).toEqual(readOutputLabel(entryId));
  });

  it('AGENT_SUMMARY_READOUT_SOURCE names a readout shape for each work entry; the read mode keeps the request of Jira, Slack, Confluence and GitHub unchanged', () => {
    expect(AGENT_SUMMARY_READOUT_SOURCE).toMatchObject({ 'calendar.events': 'calendar-event', 'jira.issues': 'jira-issue', 'jira.release': 'jira-issue', 'slack.search': 'slack-message', 'confluence.search': 'confluence-page', 'github.items': 'github-item' });
    expect(summaryReadModeOf('mail.list')).toBe('documents');
    expect(summaryReadModeOf('calendar.events')).toBe('listing-mask');
    for (const entryId of ['jira.issues', 'jira.release', 'slack.search', 'confluence.search', 'github.items'] as const) expect(summaryReadModeOf(entryId), entryId).toBe('listing');
  });

  it('the history note of each new shape is a fixed structural line with no content', () => {
    for (const source of ['calendar-event', 'confluence-page', 'github-item'] as const) {
      for (const language of ['ko', 'en'] as const) expect(renderUntrustedDocumentHistoryNote(source, language)).toMatch(/^\[.{10,120}\]$/u);
    }
  });
});

describe('A5.2 field projection from the listing response', () => {
  it('sends exactly the table fields and never any other member (a canary in an excluded field never appears)', () => {
    for (const entryId of WORK_ENTRIES) {
      const documents = projectWorkSummaryDocuments(entryId, [RAW[entryId]]).documents;
      expect(documents, entryId).toHaveLength(1);
      const dumped = JSON.stringify(documents);
      expect(dumped, entryId).not.toContain('CANARY');
      expect(dumped, entryId).not.toMatch(/Alex|Sam|Rivers|Poe/u);
      expect(documents[0]?.id).toBe(FIX_IDS[entryId]);
      expect(documents[0]?.position).toBe(1);
      expect(documents[0]?.date).toBe('');
    }
    expect(projectWorkSummaryDocuments('calendar.events', [RAW['calendar.events']]).documents[0]).toMatchObject({ title: 'Planning sync', body: 'Location: Room 4\nDescription: Agree the launch plan' });
    expect(projectWorkSummaryDocuments('jira.issues', [RAW['jira.issues']]).documents[0]).toMatchObject({ title: 'Checkout fails', body: 'Steps to reproduce' });
    expect(projectWorkSummaryDocuments('confluence.search', [RAW['confluence.search']]).documents[0]).toMatchObject({ title: 'Runbook', body: 'Restart the worker' });
    expect(projectWorkSummaryDocuments('github.items', [RAW['github.items']]).documents[0]).toMatchObject({ title: 'Fix the parser', body: 'Handles empty input' });
  });

  it('jira.release sends the summary only, even when the item carries a description', () => {
    expect(WORK_SUMMARY_FIELDS['jira.release']?.text).toEqual([]);
    expect(projectWorkSummaryDocuments('jira.release', [RAW['jira.release']]).documents[0]).toMatchObject({ title: 'Release item', body: 'Release item' });
  });

  it('Slack text is sent with its author only as a pseudonym, in order of first appearance, and a handle inside a text is pseudonymised', () => {
    const { documents } = projectWorkSummaryDocuments('slack.search', [
      { id: 'a', text: 'Ship it', author: 'Alex Rivers' },
      { id: 'b', text: 'Thanks Alex Rivers, ok', author: 'Sam Poe' },
      { id: 'c', text: 'again', author: 'Alex Rivers' },
    ]);
    expect(documents.map((document) => document.author)).toEqual(['참여자 A', '참여자 B', '참여자 A']);
    expect(documents[1]?.body).toBe('Thanks 참여자 A, ok');
    expect(JSON.stringify(documents)).not.toMatch(/Alex|Rivers|Sam|Poe/u);
  });

  it('a person handle inside a GitHub body is pseudonymised and the author is not sent', () => {
    const [document] = projectWorkSummaryDocuments('github.items', [{ id: 'o/r#2', title: 'Review', excerpt: 'cc zephyrquinn please look', people: ['zephyrquinn'] }]).documents;
    expect(document?.body).toBe('cc 참여자 A please look');
    expect(document?.author).toBe('');
  });

  it('bounds a title at 200 and every other field at 300 code points, one line, links neutralised', () => {
    const [document] = projectWorkSummaryDocuments('confluence.search', [{ id: 'p', title: `t${'x'.repeat(400)}`, excerpt: `see https://example.test/page?ref=1\n\n${'y'.repeat(500)}` }]).documents;
    expect(Array.from(document?.title ?? '').length).toBeLessThanOrEqual(200);
    expect(Array.from(document?.body ?? '').length).toBeLessThanOrEqual(300);
    expect(document?.body).not.toContain('\n');
    expect(document?.body).not.toContain('example.test');
  });

  it('a field the listing does not carry is omitted (never fetched); a row with no string id is skipped but keeps its position slot', () => {
    const { documents } = projectWorkSummaryDocuments('github.items', [{ title: 'no id' }, 'junk', { id: 'o/r#3', title: 'only a title' }]);
    expect(documents).toEqual([{ id: 'o/r#3', position: 3, title: 'only a title', author: '', date: '', body: 'only a title' }]);
    expect(projectWorkSummaryDocuments('mail.list', [{ id: 'm1' }]).documents).toEqual([]);
    expect(projectWorkSummaryDocuments('jira.issues', 'not a list').documents).toEqual([]);
  });
});

describe('review round 1: credentials and handles in the projection', () => {
  // A fake token built from fragments: a key prefix and a long secret, never a literal.
  const fakeToken = (): string => ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

  it('a credential that straddles the 300-character boundary withholds the whole item (no prefix survives the clip)', () => {
    const token = fakeToken();
    // The token starts a few characters before the clip, so a clip-then-check would keep only an innocuous-looking prefix.
    const excerpt = `${'x '.repeat(145)}token ${token}`;
    expect(excerpt.indexOf(token)).toBeLessThan(300);
    expect(excerpt.indexOf(token) + token.length).toBeGreaterThan(300);
    const result = projectWorkSummaryDocuments('github.items', [{ id: 'o/r#1', title: 'ok', excerpt }, { id: 'o/r#2', title: 'fine', excerpt: 'plain' }]);
    expect(result.withheld).toBe(1);
    expect(result.documents.map((document) => document.id)).toEqual(['o/r#2']);
    expect(JSON.stringify(result)).not.toContain('ghp_');
    expect(JSON.stringify(result)).not.toContain(token.slice(0, 8));
  });

  it('a credential split across two fields is still withheld (the joined text is guarded too)', () => {
    const token = fakeToken();
    const result = projectWorkSummaryDocuments('calendar.events', [{ id: 'e1', title: `key ${token.slice(0, 6)}`, location: token.slice(6), description: 'd' }]);
    expect(result.documents.length + result.withheld).toBe(1);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('the executor counts a withheld item as omitted and makes no model call when every item is withheld', async () => {
    grantAll();
    const spy = port([{ id: 'o/r#1', title: 'ok', excerpt: `${'x '.repeat(145)}token ${fakeToken()}` }]);
    const fake = model('LOCAL');
    const result = await new AgentPlanExecutor({ readers: { 'github.items': spy }, summarizer: route([fake], ['github']) }).execute(plan([read('github.items'), summarize([1])]));
    expect(fake.requests).toHaveLength(0);
    expect(result.steps[1]).toMatchObject({ kind: 'summarize', status: 'listing-only' });
  });

  it('a fullwidth handle is normalised like the text and is pseudonymised', () => {
    const fullwidth = '\uFF21\uFF4C\uFF45\uFF58 \uFF32\uFF49\uFF56\uFF45\uFF52\uFF53';
    const { documents } = projectWorkSummaryDocuments('slack.search', [
      { id: 'a', text: 'hello', author: fullwidth },
      { id: 'b', text: 'thanks Alex Rivers for this', author: 'Sam Poe' },
    ]);
    expect(documents[0]?.author).toBe('참여자 A');
    expect(documents[1]?.body).toBe('thanks 참여자 A for this');
    // The handle written fullwidth inside a text is normalised first and then replaced.
    const inText = projectWorkSummaryDocuments('github.items', [{ id: 'o/r#5', title: 't', excerpt: `cc ${fullwidth} now`, people: ['Alex Rivers'] }]).documents[0];
    expect(inText?.body).toBe('cc 참여자 A now');
    expect(JSON.stringify(documents)).not.toMatch(/Alex|Rivers|\uFF21/u);
  });
});

describe('switch off: the pre-A5 behaviour, byte for byte', () => {
  const GRANT_RUN = newSummaryRunToken();
  const OFF_ROUTES: readonly [string, (m: Model) => QuarantinedSummarizerRoute][] = [
    ['no switch key', (m) => route([m])],
    ['an empty switch list', (m) => route([m], [])],
    ['only another source on', (m) => route([m], ['github'])],
  ];

  it.each(OFF_ROUTES)('%s: every other work source keeps its closed pre-A5 reason and no model is called', async (_label, make) => {
    grantAll();
    for (const entryId of WORK_ENTRIES) {
      const work = workSummarySourceOf(entryId);
      if (_label === 'only another source on' && work === 'github') continue;
      const fake = model('LOCAL');
      const expected = entryId === 'jira.issues' || entryId === 'jira.release' || entryId === 'slack.search' ? 'work-text-controls-not-built' : 'no-readout-source';
      const ready = await summaryReadiness({ entryId, schema: 'digest.v1', summaryStep: 1, grant: mintSummaryEgressGrantForTest(1, entryId, GRANT_RUN), run: GRANT_RUN, askedItems: 1, route: make(fake) });
      expect(ready, entryId).toBe(expected);
      const outcome = await quarantinedSummarize({
        schema: 'digest.v1', summaryStep: 1, run: GRANT_RUN, route: make(fake), reserve: () => true,
        sources: [{ entryId, documents: [{ id: 'x', position: 1, title: 't', author: '', date: '', body: 'b' }], grant: mintSummaryEgressGrantForTest(1, entryId, GRANT_RUN) }],
      });
      expect(outcome, entryId).toEqual({ kind: 'listing-only', reason: expected });
      expect(fake.requests, entryId).toHaveLength(0);
    }
  });

  it('a whole run with every switch off sends the same port requests and gives the same step results as a run with no summarizer at all (apart from the deferred summarize step)', async () => {
    grantAll();
    for (const entryId of WORK_ENTRIES) {
      const plain = port([RAW[entryId]]);
      const off = port([RAW[entryId]]);
      const fake = model('LOCAL');
      const without = await new AgentPlanExecutor({ readers: { [entryId]: plain } }).execute(plan([read(entryId), summarize([1])]));
      const withOff = await new AgentPlanExecutor({ readers: { [entryId]: off }, summarizer: route([fake], []) }).execute(plan([read(entryId), summarize([1])]));
      expect(off.requests.map(({ entryId: e, args, keys, withDocuments, agentSummaryFieldMask }) => ({ e, args, keys, withDocuments, agentSummaryFieldMask })), entryId).toEqual(plain.requests.map(({ entryId: e, args, keys, withDocuments, agentSummaryFieldMask }) => ({ e, args, keys, withDocuments, agentSummaryFieldMask })));
      expect(off.requests[0]?.withDocuments, entryId).toBeUndefined();
      expect(off.requests[0]?.agentSummaryFieldMask, entryId).toBeUndefined();
      expect(withOff.steps[0], entryId).toEqual(without.steps[0]);
      expect(withOff.steps[1], entryId).toMatchObject({ kind: 'summarize', status: 'listing-only' });
      expect(fake.requests, entryId).toHaveLength(0);
      expect(withOff.usage, entryId).toMatchObject({ m2Calls: 0, modelCalls: 0 });
    }
  });
});

describe('switch on', () => {
  const RUN = newSummaryRunToken();
  const ready = (entryId: NlWave1EntryId, models: readonly Model[], withGrant = true, on: QuarantinedSummarizerRoute['workSummarySources'] = AGENT_WORK_SUMMARY_SOURCES) =>
    summaryReadiness({ entryId, schema: 'digest.v1', summaryStep: 1, grant: withGrant ? mintSummaryEgressGrantForTest(1, entryId, RUN) : undefined, run: RUN, askedItems: 1, route: route(models, on) });

  it('still needs the rule-① grant: without one the readiness is no-summary-grant for every source', async () => {
    for (const entryId of WORK_ENTRIES) expect(await ready(entryId, [model('LOCAL')], false), entryId).toBe('no-summary-grant');
  });

  it('A5.3: a REMOTE provider must declare dataUse no-training (LOCAL needs none), for all five sources, calendar included', async () => {
    for (const entryId of WORK_ENTRIES) {
      expect(await ready(entryId, [model('REMOTE')]), `${entryId} remote, no declaration`).toBe('no-model');
      expect(await ready(entryId, [model('REMOTE', 'no-training')]), `${entryId} remote, no-training`).toBeUndefined();
      expect(await ready(entryId, [model('LOCAL')]), `${entryId} local`).toBeUndefined();
    }
    // Mail keeps the pre-A5 rule: a remote provider with no declaration is fine.
    expect(await ready('mail.list', [model('REMOTE')])).toBeUndefined();
  });

  it('a REMOTE provider that does not declare it is never picked over a declaring one, and the work-text constraint is on the selection context', async () => {
    const contexts: unknown[] = [];
    const declared = model('REMOTE', 'no-training');
    const undeclared = model('REMOTE');
    const spy = route([undeclared, declared], ['jira']);
    const spied: QuarantinedSummarizerRoute = { ...spy, selector: { select: async (c, ctx) => (contexts.push(ctx), spy.selector.select(c, ctx)), isStillEligible: (c, ctx, p) => spy.selector.isStillEligible(c, ctx, p) } };
    // The router ranks `undeclared` first; the constraint is enforced in Core, so the step ends listing-only (never re-sent elsewhere).
    const outcome = await quarantinedSummarize({
      schema: 'digest.v1', summaryStep: 1, run: RUN, route: spied, reserve: () => true,
      sources: [{ entryId: 'jira.issues', documents: [{ id: 'AB-1', position: 1, title: 'T', author: '', date: '', body: 'B' }], grant: mintSummaryEgressGrantForTest(1, 'jira.issues', RUN) }],
    });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(undeclared.requests).toHaveLength(0);
    expect(declared.requests).toHaveLength(0);
    expect(contexts[0]).toMatchObject({ workText: true, requiredDataUse: 'no-training', allowedExecutionLocalities: ['LOCAL', 'REMOTE'] });
  });

  it('a switch is per source: only the switched-on source runs', async () => {
    expect(await ready('github.items', [model('LOCAL')], true, ['github'])).toBeUndefined();
    expect(await ready('jira.issues', [model('LOCAL')], true, ['github'])).toBe('work-text-controls-not-built');
    expect(await ready('calendar.events', [model('LOCAL')], true, ['github'])).toBe('no-readout-source');
  });

  it.each(WORK_ENTRIES)('%s: the executor summarises from the listing alone, with one request and only the table fields in the prompt', async (entryId) => {
    grantAll();
    const spy = port([RAW[entryId]]);
    const fake = model('LOCAL');
    const logLines: unknown[] = [];
    const log = (message: string, fields?: unknown): void => void logLines.push({ message, fields });
    const result = await new AgentPlanExecutor({ readers: { [entryId]: spy }, summarizer: route([fake], AGENT_WORK_SUMMARY_SOURCES), logger: { info: log, warn: log, error: log } }).execute(plan([read(entryId), summarize([1])]));
    expect(spy.requests).toHaveLength(1);
    expect(logLines.length).toBeGreaterThan(0);
    // A5.2: the request is the listing read's, no `withDocuments` body fetch; only the calendar's one `events.list` carries `agentSummaryFieldMask`.
    // Never `withDocuments` for any of the five; only the calendar carries the field-mask flag (the same single request).
    expect(spy.requests[0]?.withDocuments, entryId).toBeUndefined();
    expect(spy.requests[0]?.agentSummaryFieldMask, entryId).toBe(entryId === 'calendar.events' ? true : undefined);
    expect(fake.requests, entryId).toHaveLength(1);
    const prompt = String(fake.requests[0]?.prompt ?? '');
    expect(prompt, entryId).not.toContain('CANARY');
    expect(prompt, entryId).not.toMatch(/Alex|Sam Poe|Rivers/u);
    expect(prompt, entryId).not.toContain(FIX_IDS[entryId]);
    const step = result.steps[1];
    if (step?.kind !== 'summarize' || step.status !== 'ok') throw new Error(`not ok: ${JSON.stringify(step)}`);
    expect(summaryEntriesForAssembler(step.summary)?.[0]?.entryId).toBe(entryId);
    expect(step.summary.label).toMatchObject({ trust: 'UNTRUSTED', derivation: 'MODEL_DERIVED' });
    // Content-free: the result carries no item text, summary or pseudonym.
    const dumped = JSON.stringify(result) + JSON.stringify(logLines);
    expect(dumped).not.toContain('참여자');
    for (const text of ['Planning sync', 'Checkout fails', 'Ship it', 'Runbook', 'Fix the parser', 'SUMMARY-OK']) expect(dumped).not.toContain(text);
  });

  it('a credential-bearing item is withheld whole (never redacted and sent): no model call', async () => {
    grantAll();
    const secret = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    const spy = port([{ id: 'o/r#9', title: 'Rotate keys', excerpt: `token ${secret}` }]);
    const fake = model('LOCAL');
    const result = await new AgentPlanExecutor({ readers: { 'github.items': spy }, summarizer: route([fake], ['github']) }).execute(plan([read('github.items'), summarize([1])]));
    expect(fake.requests).toHaveLength(0);
    expect(result.steps[1]).toMatchObject({ kind: 'summarize', status: 'listing-only' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

import { describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AgentPlanExecutor, type AgentReadPort, type AgentReadRequest } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import type { AgentSourceDocument, QuarantinedSummarizerRoute } from './quarantined-summary';
import { ownerAskedSummary, ownerSummaryRequests, summaryGrantBasis, type SummaryGrantBasis } from './summary-grant';

// ADR-0121 S2 wiring slice: the summary grant producer (P3-3b owner answer 2). Core derives the grant per summarize step and per
// source from the owner's own words (quoted and pasted text excluded) with the approved summary vocabulary; never a caller flag
// and never the planner's step. Without it a REMOTE_ON_SUMMARY_REQUEST summary stays listing-only with no body fetched.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const read = (entryId: NlWave1EntryId, limit = 3): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit }, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });

/** The owner's grounding text exactly as the runtime prepares it (quoted lines, fences and quote ranges removed). */
const grounding = (text: string): string => {
  const prepared = prepareSelectionInput(text);
  if ('skip' in prepared) throw new Error('skipped');
  return prepared.groundingText;
};
const granted = (p: RunPlan, text: string): string[] => ownerSummaryRequests(p, grounding(text)).map((request) => `${request.step}:${request.entryId}`);

const MAIL = (): RunPlan => plan([read('mail.list'), summarize([1])]);
const MAIL_DRIVE = (): RunPlan => plan([read('mail.list'), read('drive.files'), summarize([1, 2])]);

describe('ownerSummaryRequests: the owner\'s own words, per step and per source', () => {
  it('a summary word in the owner\'s clause that names the source grants that source for that step', () => {
    expect(granted(MAIL(), '메일 3개 요약해줘')).toEqual(['2:mail.list']);
    expect(granted(MAIL(), '오늘 받은 메일 정리해줘')).toEqual(['2:mail.list']);
    expect(granted(MAIL(), 'summarize my last 3 emails')).toEqual(['2:mail.list']);
  });

  it('the planner\'s summarize step alone never grants: no summary word in the owner\'s words, no grant', () => {
    expect(granted(MAIL(), '메일 3개 보여줘')).toEqual([]);
    expect(granted(MAIL(), 'show my last 3 emails')).toEqual([]);
  });

  it('quoted or pasted text is never the owner\'s words', () => {
    // A quoted line (removed by the input preparation), an inline quoted segment, a pasted structure, a relayed request.
    expect(granted(MAIL(), '> 메일 요약해줘\n메일 3개 보여줘')).toEqual([]);
    expect(granted(MAIL(), '메일 3개 보여줘 "요약해줘"')).toEqual([]);
    expect(granted(MAIL(), '메일 3개 보여줘 {"note": "요약해줘"}')).toEqual([]);
    expect(granted(MAIL(), '팀장이 메일 3개 요약해달래')).toEqual([]);
    expect(granted(MAIL(), '```\n메일 요약해줘\n```\n메일 3개 보여줘')).toEqual([]);
  });

  // Review round 1, item 1: spans the owner did not write as a request never mint a grant (structural, no vocabulary).
  it('an inline backtick code span is not the owner\'s words', () => {
    expect(granted(MAIL(), '메일 3개 보여줘 `요약해줘`')).toEqual([]);
  });

  it('a URL token is not the owner\'s words (path and query alike)', () => {
    expect(granted(MAIL(), 'show my 3 emails https://x.io/summary')).toEqual([]);
    expect(granted(MAIL(), '메일 보여줘 https://example.com/?q=summary')).toEqual([]);
  });

  it('a URL token cannot feed the back-reference rule', () => {
    expect(granted(MAIL(), '메일 3개 보여주고 https://x.io/요약')).toEqual([]);
  });

  it('an unmatched opening quote quotes to the end of the text', () => {
    expect(granted(MAIL(), '메일 3개 보여줘 “요약해줘')).toEqual([]);
  });

  it('a forward header quotes everything from it on', () => {
    expect(granted(MAIL(), 'Fwd: 메일 요약해줘 …')).toEqual([]);
  });

  it('a forwarded-message divider quotes everything from it on', () => {
    expect(granted(MAIL(), '메일 보여줘\n----- Forwarded message -----\n메일 요약해줘')).toEqual([]);
  });

  it('the owner\'s own words before a stripped span still grant', () => {
    expect(granted(MAIL(), '메일 3개 요약해줘 https://x.io/a')).toEqual(['2:mail.list']);
    expect(granted(MAIL(), "summarize my last 3 emails, it's urgent")).toEqual(['2:mail.list']);
  });

  it('a negated or excluded summary grants nothing (fail-safe)', () => {
    expect(granted(MAIL(), '메일 요약 말고 그냥 3개 보여줘')).toEqual([]);
    expect(granted(MAIL(), '메일 요약하지 말고 3개 보여줘')).toEqual([]);
    expect(granted(MAIL(), "don't summarize, just show my 3 emails")).toEqual([]);
  });

  it('per source: the summary clause names which source; another source\'s clause grants nothing', () => {
    expect(granted(MAIL_DRIVE(), '메일 보여주고 드라이브 파일 요약해줘')).toEqual(['3:drive.files']);
    expect(granted(MAIL_DRIVE(), '메일 요약하고, 드라이브 파일은 그냥 보여줘')).toEqual(['3:mail.list']);
    // Coordinated nouns share the predicate (-랑, and -하고 on a source name).
    expect(granted(MAIL_DRIVE(), '메일이랑 드라이브 파일 요약해줘')).toEqual(['3:mail.list', '3:drive.files']);
    expect(granted(MAIL_DRIVE(), '메일하고 드라이브 파일 요약해줘')).toEqual(['3:mail.list', '3:drive.files']);
    // "-하고" on a verb is a clause boundary, not a coordination: the checked mail is not summarized.
    expect(granted(MAIL_DRIVE(), '메일 확인하고 드라이브 파일 요약해줘')).toEqual(['3:drive.files']);
  });

  it('a summary clause that names no source points back only when every named source is covered by that summary', () => {
    expect(granted(MAIL(), '메일 3개 보여주고 요약해줘')).toEqual(['2:mail.list']);
    // Drive is named but this summary covers only mail: ambiguous, so no grant.
    const mailOnly = plan([read('mail.list'), read('drive.files'), summarize([1])]);
    expect(granted(mailOnly, '메일 보여주고 드라이브 파일도 보여주고 요약해줘')).toEqual([]);
  });

  it('only sources that need a grant are listed (calendar is LOCAL_MODEL_ONLY; Jira is withheld elsewhere)', () => {
    const p = plan([read('calendar.events'), read('mail.list'), summarize([1, 2])]);
    expect(granted(p, '일정이랑 메일 요약해줘')).toEqual(['3:mail.list']);
  });

  it('two summary steps are granted one by one', () => {
    const p = plan([read('calendar.events'), summarize([1]), read('mail.list'), summarize([3])]);
    expect(granted(p, '내일 일정 요약하고, 안 읽은 메일도 따로 요약해줘')).toEqual(['4:mail.list']);
    expect(granted(p, '내일 일정 요약하고 메일도 보여줘')).toEqual([]);
  });

  it('nothing for a plan that is not a validated run', () => {
    expect(ownerSummaryRequests({ kind: 'none' }, '메일 요약해줘')).toEqual([]);
    expect(ownerSummaryRequests({ kind: 'clarify', steps: MAIL().steps, connectorCalls: 1 }, '메일 요약해줘')).toEqual([]);
  });
});

describe('summaryGrantBasis: opaque, bound to one validated plan', () => {
  it('answers only for the very plan it was derived for; a forged, foreign or absent basis grants nothing', () => {
    const p = MAIL();
    const basis = summaryGrantBasis(p, grounding('메일 3개 요약해줘'));
    expect(ownerAskedSummary(basis, p, 2, 'mail.list')).toBe(true);
    expect(ownerAskedSummary(basis, p, 1, 'mail.list')).toBe(false);
    expect(ownerAskedSummary(basis, p, 2, 'drive.files')).toBe(false);
    expect(ownerAskedSummary(basis, MAIL(), 2, 'mail.list')).toBe(false);
    expect(ownerAskedSummary(Object.freeze({}) as SummaryGrantBasis, p, 2, 'mail.list')).toBe(false);
    expect(ownerAskedSummary(undefined, p, 2, 'mail.list')).toBe(false);
  });
});

// ── through the executor: no grant = listing-only and no body fetched; the owner's words = the real grant ─────────────

const docs = (n: number): AgentSourceDocument[] => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, position: i + 1, title: `t${i + 1}`, author: 'a', date: '2026-11-01T09:00:00.000Z', body: `body ${i + 1}` }));

function port(n: number): AgentReadPort & { readonly requests: AgentReadRequest[] } {
  const requests: AgentReadRequest[] = [];
  return {
    requests,
    read: async (request) => {
      requests.push(request);
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      return { ok: true, items: Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}` })), ...(request.withDocuments === true ? { documents: docs(n) } : {}) };
    },
  };
}

function remoteRoute(): QuarantinedSummarizerRoute & { readonly requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    id: 'remote-summarizer',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    executionLocality: 'REMOTE',
    isAvailable: async () => true,
    execute: async (request) => {
      requests.push(request);
      return { text: JSON.stringify({ items: [1, 2, 3].map((n) => ({ n, summary: `line ${n}` })) }) };
    },
  };
  const policy: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
  return { requests, selector: new CapabilityRouter(new AiProviderManager([provider]), policy) };
}

describe('AgentPlanExecutor with the producer (no test seam)', () => {
  it('without a basis: listing-only (no-summary-grant), the body is never asked for, no model call', async () => {
    const mail = port(3);
    const route = remoteRoute();
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: route }).execute(MAIL());
    expect(result.steps[1]).toMatchObject({ kind: 'summarize', status: 'listing-only', reason: 'no-summary-grant' });
    expect(mail.requests[0]?.withDocuments).toBeUndefined();
    expect(route.requests).toEqual([]);
  });

  it("the owner's summary words grant it: the body is fetched and the asked-for items go to the selected model", async () => {
    const mail = port(3);
    const route = remoteRoute();
    const p = MAIL();
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: route }).execute(p, { grants: summaryGrantBasis(p, grounding('메일 3개 요약해줘')) });
    expect(mail.requests[0]?.withDocuments).toBe(true);
    expect(route.requests).toHaveLength(1);
    expect(result.steps[1]).toMatchObject({ kind: 'summarize', status: 'ok', audits: [{ locality: 'REMOTE' }] });
  });

  it('a basis from words without a summary request, or derived for another plan, grants nothing', async () => {
    for (const make of [(p: RunPlan) => summaryGrantBasis(p, grounding('메일 3개 보여줘')), () => summaryGrantBasis(MAIL(), grounding('메일 3개 요약해줘'))]) {
      const mail = port(3);
      const route = remoteRoute();
      const p = MAIL();
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: route }).execute(p, { grants: make(p) });
      expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-summary-grant' });
      expect(mail.requests[0]?.withDocuments).toBeUndefined();
      expect(route.requests).toEqual([]);
    }
  });
});

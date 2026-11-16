import { getEventListeners } from 'node:events';
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
import { hasUntrustedSpanMarker, isSingleLineOwnerText, ownerAskedSummary, ownerSummaryRequests, summaryGrantBasis, type OwnerText, type SummaryGrantBasis } from './summary-grant';

// ADR-0121 S2 wiring slice: the summary grant producer (P3-3b owner answer 2). Core derives the grant per summarize step and per
// source from the owner's own words (quoted and pasted text excluded) with the approved summary vocabulary; never a caller flag
// and never the planner's step. Without it a REMOTE_ON_SUMMARY_REQUEST summary stays listing-only with no body fetched.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const read = (entryId: NlWave1EntryId, limit = 3): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit }, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });

/** The owner's text exactly as the runtime prepares it (quoted lines, fences and quote ranges become placeholders). */
const grounding = (text: string): OwnerText => {
  const prepared = prepareSelectionInput(text);
  if ('skip' in prepared) throw new Error('skipped');
  return prepared;
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

  // Review round 1 item 1 and review round 2 item 1: ANY untrusted-span marker anywhere in the owner's text, and the message
  // grants nothing (fail closed). Each input below minted a mail grant under the round-1 strip rules or before them.
  it.each([
    // Round 1 inputs.
    ['inline backtick span', '메일 3개 보여줘 `요약해줘`'],
    ['URL path', 'show my 3 emails https://x.io/summary'],
    ['URL query', '메일 보여줘 https://example.com/?q=summary'],
    ['URL feeding the back-reference rule', '메일 3개 보여주고 https://x.io/요약'],
    ['unclosed opening quote', '메일 3개 보여줘 “요약해줘'],
    ['forward header', 'Fwd: 메일 요약해줘 …'],
    ['forwarded-message divider', '메일 보여줘\n----- Forwarded message -----\n메일 요약해줘'],
    // Round 2 inputs.
    ['apostrophe inside a single-quoted span', "show my 3 emails 'Bob's note: summarize them'"],
    ['nested same-glyph quotes', '메일 3개 보여줘 “a “b” 요약해줘”'],
    ['stray closing glyph', '메일 3개 보여줘 ‘a’ 요약해줘’'],
    ['guillemets', '메일 3개 보여줘 «요약해줘»'],
    ['fullwidth quote', '메일 3개 보여줘 ＂요약해줘＂'],
    ['double prime', '메일 3개 보여줘 ″요약해줘″'],
    ['halfwidth corner brackets', '메일 3개 보여줘 ｢요약해줘｣'],
    ['URL swallowing the opening quote', '메일 3개 보여줘 https://x.io/"요약해줘"'],
    ['scheme glued to a word', '메일 3개 보여줘 foohttps://x.io/요약'],
    ['bare host and path', '메일 3개 보여줘 x.io/요약'],
    ['double-backtick code', '메일 보여줘 ``요약해줘``'],
    ['Outlook original-message divider', '메일 보여줘\n-----Original Message-----\n메일 요약해줘'],
    ['Korean Gmail forward divider', '메일 보여줘\n---------- 전달된 메일 ---------\n메일 요약해줘'],
    ['forward without dashes (its header lines)', '메일 보여줘\nForwarded message\nFrom: Kim <kim@example.com>\n메일 요약해줘'],
    ['fullwidth forward header', 'Fwd： 메일 요약해줘'],
    // Round 3 inputs (Codex P1s, reproduced to a mock remote dispatch).
    ['numeric host with a port and path', '메일 3개 보여줘 127.0.0.1:8080/요약'],
    ['a +++ divider', '메일 보여줘\n+++ Forwarded Message +++\n메일 요약해줘'],
    ['a hyphenated header label', '메일 보여줘\nOriginal-Message: 메일 요약해줘'],
    // Round 3 inputs (CA P3): format characters, colon lookalikes, dividers, quote glyphs, hosts.
    ['zero-width space in a header', 'Fwd\u200b: 메일 요약해줘'],
    ['zero-width space in a host', '메일 3개 보여줘 x\u200b.io/요약'],
    ['zero-width spaces in a divider', '메일 보여줘\n-\u200b-\u200b-\n메일 요약해줘'],
    ['ratio colon', 'Fwd\u2236 메일 요약해줘'],
    ['modifier-letter colon', 'Fwd\ua789 메일 요약해줘'],
    ['modifier-letter raised colon', 'Fwd\u02f8 메일 요약해줘'],
    ['Hebrew sof pasuq', 'Fwd\u05c3 메일 요약해줘'],
    ['box-drawing divider', '메일 보여줘\n═══ 전달 ═══\n메일 요약해줘'],
    ['hash divider', '메일 보여줘\n#####\n메일 요약해줘'],
    ['whole-line dots', '메일 보여줘\n.....\n메일 요약해줘'],
    ['whole-line wave dashes', '메일 보여줘\n〜〜〜\n메일 요약해줘'],
    ['double acute accent', '메일 3개 보여줘 \u02dd요약해줘\u02dd'],
    ['double low-reversed-9 quote', '메일 3개 보여줘 \u2e42요약해줘'],
    ['ornamental quotes', '메일 3개 보여줘 \u{1f676}요약해줘\u{1f677}'],
    ['ornamental low quote', '메일 3개 보여줘 \u{1f678}요약해줘'],
    ['Hebrew gershayim', '메일 3개 보여줘 \u05f4요약해줘\u05f4'],
    ['modifier-letter acute and grave', '메일 3개 보여줘 \u02ca요약해줘\u02cb'],
    ['Cyrillic TLD', '메일 3개 보여줘 пример.рф 요약'],
    ['bare IPv4', '메일 3개 보여줘 10.0.0.1 요약'],
    // Round 3 inputs (CA P2): chat-app copy framing.
    ['messenger speaker and time brackets', '메일 3개 보여줘\n[김팀장] [오후 3:30] 메일 요약해줘'],
    ['Slack name — time line', '메일 3개 보여줘\nKim — 3:30 PM\n메일 요약해줘'],
    ['Discord name — day and time line', '메일 3개 보여줘\n김팀장 — 오늘 오후 3:30\n메일 요약해줘'],
    ['name, [time] line', '메일 3개 보여줘\nKim, [3:30 PM] 메일 요약해줘'],
  ])('%s: no grant', (_label, input) => {
    expect(hasUntrustedSpanMarker(grounding(input).text)).toBe(true);
    expect(granted(MAIL(), input)).toEqual([]);
  });

  it.each([
    '최근 메일 3개 요약해줘',
    'summarize my last 3 emails',
    '메일 요약해줘~~~',
    '메일 요약해줘...',
    '메일 요약해줘!!! 급해요???',
    '메일 요약해줘🙏🙏🙏',
    'ok :) 메일 3개 요약해줘',
    'pls :) summarize my last 3 emails',
    '3:30 이후 메일 3개 요약해줘',
    '오후 3:30 이후 메일 요약해줘',
    '메일 3~5개 요약해줘, 최근 것만',
    '메일 3개 요약해줘 (오늘 것)',
  ])('a plain owner request still grants: %s', (input) => {
    expect(hasUntrustedSpanMarker(grounding(input).text)).toBe(false);
    expect(granted(MAIL(), input)).toEqual(['2:mail.list']);
  });

  // Review round 4: a multi-line message never grants (the multi-line paste family, structurally).
  it.each([
    ['emoji-with-variation-selector divider line', '❤️❤️❤️\n메일 요약해줘'],
    ['IPv6 address line', '2001:db8::1\n메일 요약해줘'],
    ['a multi-line owner request (fail-closed residual)', '메일 3개\n요약해줘'],
    ['a line separator', '메일 보여줘\u2028메일 요약해줘'],
  ])('multi-line, no grant: %s', (_label, input) => {
    expect(isSingleLineOwnerText(grounding(input).text)).toBe(false);
    expect(granted(MAIL(), input)).toEqual([]);
  });

  it('a mention-prefixed speaker at the line start is a label (the @ widening of the line-start rule)', () => {
    expect(hasUntrustedSpanMarker(grounding('@alice: 메일 요약해줘').text)).toBe(true);
    expect(granted(MAIL(), '@alice: 메일 요약해줘')).toEqual([]);
  });

  it('a single-line plain request is single-line and still grants (surrounding blank space is trimmed)', () => {
    expect(isSingleLineOwnerText(grounding('  최근 메일 3개 요약해줘  ').text)).toBe(true);
    expect(granted(MAIL(), '\n최근 메일 3개 요약해줘\n')).toEqual(['2:mail.list']);
  });

  it('the [files: N] line the preparation appends is not a marker', () => {
    const prepared = prepareSelectionInput('메일 3개 요약해줘', 2);
    if ('skip' in prepared) throw new Error('skipped');
    expect(prepared.text).toContain('[files: 2]');
    expect(ownerSummaryRequests(MAIL(), prepared).map((request) => `${request.step}:${request.entryId}`)).toEqual(['2:mail.list']);
  });

  it('residual (accepted, fail closed): an English contraction or any URL in the owner\'s own request loses the grant', () => {
    expect(granted(MAIL(), "summarize my last 3 emails, it's urgent")).toEqual([]);
    expect(granted(MAIL(), '메일 3개 요약해줘 https://x.io/a')).toEqual([]);
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
    expect(ownerSummaryRequests({ kind: 'none' }, grounding('메일 요약해줘'))).toEqual([]);
    expect(ownerSummaryRequests({ kind: 'clarify', steps: MAIL().steps, connectorCalls: 1 }, grounding('메일 요약해줘'))).toEqual([]);
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

// ── S2 wiring review round 2 items 3 and 4: the shutdown signal at the executor ──────────────────────────────────────────

describe('AgentPlanExecutor and the shutdown signal (S2 wiring review round 2)', () => {
  it('leaves no listener on the service-lifetime signal: the count does not grow per port or M2 call', async () => {
    const shutdown = new AbortController();
    for (let run = 0; run < 3; run += 1) {
      const p = MAIL_DRIVE();
      await new AgentPlanExecutor({ readers: { 'mail.list': port(3), 'drive.files': port(3) }, summarizer: remoteRoute() }).execute(p, {
        grants: summaryGrantBasis(p, grounding('메일이랑 드라이브 요약해줘')),
        signal: shutdown.signal,
      });
    }
    expect(getEventListeners(shutdown.signal, 'abort')).toHaveLength(0);
  });

  it('a shutdown that cuts the last step stops the run (stopped, the read not-run as stopped)', async () => {
    const shutdown = new AbortController();
    const hung: AgentReadPort = {
      read: async () => {
        shutdown.abort();
        return new Promise<never>(() => undefined);
      },
    };
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': hung } }).execute(plan([read('mail.list')]), { signal: shutdown.signal });
    expect(result).toMatchObject({ outcome: 'partial', stopped: true });
    expect(result.steps[0]).toMatchObject({ kind: 'read', status: 'not-run', reason: 'stopped' });
  });

  it('a summarize step cut by shutdown is not-run with reason stopped, and the run is stopped', async () => {
    const shutdown = new AbortController();
    const provider: AiProvider = {
      id: 'hung-summarizer',
      capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
      executionLocality: 'REMOTE',
      isAvailable: async () => true,
      execute: async () => {
        shutdown.abort();
        return new Promise<never>(() => undefined);
      },
    };
    const policy: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
    const p = MAIL();
    const result = await new AgentPlanExecutor({
      readers: { 'mail.list': port(3) },
      summarizer: { selector: new CapabilityRouter(new AiProviderManager([provider]), policy) },
    }).execute(p, { grants: summaryGrantBasis(p, grounding('메일 3개 요약해줘')), signal: shutdown.signal });
    expect(result).toMatchObject({ outcome: 'partial', stopped: true });
    expect(result.steps[1]).toMatchObject({ kind: 'summarize', status: 'not-run', reason: 'stopped' });
  });
});

import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { agentPlanParseFailure, parseAgentPlanOutput, type AgentPlan, type AgentPlanStep } from './plan-schema';
import { absoluteDatesGrounded, validateAgentPlan, type AgentPlanValidationContext } from './plan-validator';
import { renderUnboundedAsk } from './unbounded-ask';

// ADR-0121 D2 / D5 / D7 (stage S2 P1): the v2 plan parse and every static rule of the deterministic plan validator.

const T0 = '2026-10-20T03:00:00.000Z';
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);

function ctx(groundingText: string, extra: Partial<AgentPlanValidationContext> = {}): AgentPlanValidationContext {
  return {
    offered: new Map([...READS, ...ACTIONS].map((entry) => [entry.id, entry] as const)),
    groundingText,
    now: T0,
    timeZone: 'Asia/Seoul',
    direct: true,
    ...extra,
  };
}

const read = (entryId: string, args: Record<string, string | number | boolean> = {}, ref?: { step: number; field: string; take: number }): AgentPlanStep => ({
  kind: 'read',
  entryId,
  args,
  ...(ref !== undefined ? { ref } : {}),
});
const summary = (from: number[], schema = 'digest.v1'): AgentPlanStep => ({ kind: 'summarize', from, schema });
const plan = (steps: AgentPlanStep[], ambiguity: 'CLEAR' | 'NEEDS_CLARIFICATION' = 'CLEAR'): AgentPlan => ({ kind: 'steps', form: 'steps', steps, ambiguity, alternatives: [] });

const JIRA_AND_CAL = '이번 주 일정이랑 지라 이슈 보여줘';

describe('plan schema v2 (parse)', () => {
  it('reads the ADR-0120 selection form as a one-step plan (or none), unchanged', () => {
    const one = parseAgentPlanOutput(JSON.stringify({ entryId: 'jira.issues', args: { status: 'all' }, ambiguity: 'CLEAR', alternatives: [] }));
    expect(one).toEqual({ kind: 'steps', form: 'selection', steps: [{ kind: 'read', entryId: 'jira.issues', args: { status: 'all' } }], ambiguity: 'CLEAR', alternatives: [] });
    expect(parseAgentPlanOutput(JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] }))).toEqual({ kind: 'none', form: 'selection' });
  });

  it('reads the steps form: reads, refs and summaries; a fence is tolerated', () => {
    const raw = '```json\n' + JSON.stringify({
      steps: [
        { entryId: 'jira.release', args: { release: '1.2.0' } },
        { entryId: 'jira.issues', args: {}, ref: { step: 1, field: 'issueKeys', take: 5 } },
        { summarize: [1, 2], schema: 'digest.v1' },
      ],
      ambiguity: 'CLEAR',
    }) + '\n```';
    const parsed = parseAgentPlanOutput(raw);
    expect(parsed?.kind).toBe('steps');
    expect(parsed?.kind === 'steps' ? parsed.steps : []).toEqual([
      { kind: 'read', entryId: 'jira.release', args: { release: '1.2.0' } },
      { kind: 'read', entryId: 'jira.issues', args: {}, ref: { step: 1, field: 'issueKeys', take: 5 } },
      { kind: 'summarize', from: [1, 2], schema: 'digest.v1' },
    ]);
  });

  it.each([
    ['no steps', { steps: [], ambiguity: 'CLEAR' }],
    ['seven steps', { steps: Array.from({ length: 7 }, () => ({ entryId: 'jira.issues' })), ambiguity: 'CLEAR' }],
    ['an unknown top key', { steps: [{ entryId: 'jira.issues' }], ambiguity: 'CLEAR', tools: [] }],
    ['an unknown step key', { steps: [{ entryId: 'jira.issues', url: 'https://x' }], ambiguity: 'CLEAR' }],
    ['a step mixing read and summary keys', { steps: [{ entryId: 'jira.issues', summarize: [1] }], ambiguity: 'CLEAR' }],
    ['a ref to step 0', { steps: [{ entryId: 'jira.issues', ref: { step: 0, field: 'issueKeys', take: 1 } }], ambiguity: 'CLEAR' }],
    ['a ref with a value list', { steps: [{ entryId: 'jira.issues', ref: { step: 1, field: 'issueKeys', take: 1, values: ['A-1'] } }], ambiguity: 'CLEAR' }],
    ['a fractional take', { steps: [{ entryId: 'jira.issues', ref: { step: 1, field: 'issueKeys', take: 1.5 } }], ambiguity: 'CLEAR' }],
    ['a free-text schema', { steps: [{ entryId: 'jira.issues' }, { summarize: [1], schema: 'write anything' }], ambiguity: 'CLEAR' }],
    ['a missing ambiguity', { steps: [{ entryId: 'jira.issues' }] }],
    ['a none step', { steps: [{ entryId: 'none' }], ambiguity: 'CLEAR' }],
    ['an object arg value', { steps: [{ entryId: 'jira.issues', args: { keyword: { x: 1 } } }], ambiguity: 'CLEAR' }],
  ])('rejects %s (closed JSON)', (_label, value) => {
    expect(parseAgentPlanOutput(JSON.stringify(value))).toBeNull();
    expect(agentPlanParseFailure(JSON.stringify(value))).toBeDefined();
  });

  it('rejects more than 2 KB and prose around the object', () => {
    const big = JSON.stringify({ steps: [{ entryId: 'jira.issues', args: { keyword: 'x'.repeat(190) } }], ambiguity: 'CLEAR', confidence: 0.5 }).padEnd(2100, ' ');
    expect(parseAgentPlanOutput(big)).toBeNull();
    expect(parseAgentPlanOutput(`Here is the plan: ${JSON.stringify({ steps: [{ entryId: 'jira.issues' }], ambiguity: 'CLEAR' })}`)).toBeNull();
  });
});

describe('plan validator: DM only, READ only, offered, step mix', () => {
  it('a valid two-read plan passes with literal provenance on every arg', () => {
    const result = validateAgentPlan(plan([read('calendar.events', { range: 'this-week' }), read('jira.issues')]), ctx(JIRA_AND_CAL));
    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.kind === 'none') throw new Error('expected a plan');
    expect(result.plan.kind).toBe('run');
    const first = result.plan.steps[0];
    expect(first?.kind === 'read' ? first.provenance.range : undefined).toEqual({ kind: 'literal', label: expect.objectContaining({ trust: 'TRUSTED' }) });
  });

  it('refuses every plan outside the owner DM (fail closed when absent)', () => {
    expect(validateAgentPlan(plan([read('jira.issues')]), ctx('지라 이슈', { direct: false }))).toMatchObject({ ok: false, reason: 'not-dm' });
    const { direct: _drop, ...rest } = ctx('지라 이슈');
    expect(validateAgentPlan(plan([read('jira.issues')]), rest)).toMatchObject({ ok: false, reason: 'not-dm' });
  });

  it('READ only: an ITEM_READ, LOCAL_WRITE or EXTERNAL_WRITE entry is refused even as a single step', () => {
    for (const entry of ACTIONS) {
      expect(validateAgentPlan(plan([read(entry.id, {})]), ctx('할 일 추가해줘')), entry.id).toMatchObject({ ok: false, reason: 'not-read', step: 1 });
    }
  });

  it('offered: an entry not offered this turn (an unconfigured source) is refused; an unknown id is refused', () => {
    const offered = new Map(READS.filter((entry) => entry.id !== 'mail.list').map((entry) => [entry.id, entry] as const));
    expect(validateAgentPlan(plan([read('mail.list')]), ctx('메일', { offered }))).toMatchObject({ ok: false, reason: 'not-offered', step: 1 });
    expect(validateAgentPlan(plan([read('shell.exec')]), ctx('x'))).toMatchObject({ ok: false, reason: 'unknown-entry', step: 1 });
  });

  it('step mix: at most 4 reads (more is an unbounded ask, decision (h)) and 3 summaries, at least one read', () => {
    const fiveReads = plan(Array.from({ length: 5 }, () => read('jira.issues')));
    expect(validateAgentPlan(fiveReads, ctx('지라 이슈'))).toMatchObject({ ok: true, plan: { kind: 'ask', reason: 'unbounded', bound: 'reads' } });
    // CA P2: an ask only when nothing but the bound is broken; an ungrounded keyword anywhere refuses with its own reason.
    const badFirst = plan([read('slack.search', { keyword: '배포' }), ...Array.from({ length: 4 }, () => read('jira.issues'))]);
    expect(validateAgentPlan(badFirst, ctx('지라 이슈'))).toMatchObject({ ok: false, reason: 'step-invalid', step: 1, stepReason: 'ungrounded' });
    const badLast = plan([...Array.from({ length: 4 }, () => read('jira.issues')), read('slack.search', { keyword: '배포' })]);
    expect(validateAgentPlan(badLast, ctx('지라 이슈'))).toMatchObject({ ok: false, reason: 'step-invalid', step: 5, stepReason: 'ungrounded' });
    const fourSummaries = plan([read('jira.issues'), summary([1]), summary([1]), summary([1]), summary([1])]);
    expect(validateAgentPlan(fourSummaries, ctx('지라 이슈 요약'))).toMatchObject({ ok: false, reason: 'too-many-summaries' });
    expect(validateAgentPlan(plan([summary([1])]), ctx('요약'))).toMatchObject({ ok: false, reason: 'no-read' });
    const sixSteps = plan([read('jira.issues'), read('github.items'), read('calendar.events'), read('mail.list'), summary([1, 2]), summary([3, 4])]);
    expect(validateAgentPlan(sixSteps, ctx('지라 깃허브 일정 메일 요약')).ok).toBe(true);
  });

  it('a multi-step plan never names help.topic, brief.today or an A6 entry; alone they stay today\'s selection', () => {
    expect(validateAgentPlan(plan([read('help.topic'), read('jira.issues')]), ctx('도움말이랑 지라'))).toMatchObject({ ok: false, reason: 'single-step-only', step: 1 });
    expect(validateAgentPlan(plan([read('jira.issues'), read('brief.today')]), ctx('지라랑 브리핑'))).toMatchObject({ ok: false, reason: 'single-step-only', step: 2 });
    expect(validateAgentPlan(plan([read('jira.issues'), read('todo.add', { title: '우유' })]), ctx('지라 보고 우유 할 일 추가'))).toMatchObject({ ok: false, reason: 'a6-in-plan', step: 2 });
    expect(validateAgentPlan(plan([read('brief.today')]), ctx('오늘 브리핑')).ok).toBe(true);
  });

  it('each read step passes ADR-0120 D4 unchanged (an ungrounded keyword is refused with its closed reason)', () => {
    const result = validateAgentPlan(plan([read('jira.issues'), read('slack.search', { keyword: '배포' })]), ctx('지라 이슈랑 슬랙 장애 얘기'));
    expect(result).toMatchObject({ ok: false, reason: 'step-invalid', step: 2, stepReason: 'ungrounded' });
  });

  it('NEEDS_CLARIFICATION with every rule met is a clarification, not a refusal', () => {
    expect(validateAgentPlan(plan([read('jira.issues')], 'NEEDS_CLARIFICATION'), ctx('지라'))).toMatchObject({ ok: true, plan: { kind: 'clarify' } });
  });

  it('a none plan is valid (honest chat), but never outside the DM', () => {
    expect(validateAgentPlan({ kind: 'none', form: 'selection' }, ctx('안녕'))).toEqual({ ok: true, plan: { kind: 'none' } });
    expect(validateAgentPlan({ kind: 'none', form: 'selection' }, ctx('안녕', { direct: false }))).toMatchObject({ ok: false, reason: 'not-dm' });
  });
});

describe('plan validator: references (ADR-0121 D2 / D11 cross-source test)', () => {
  const RELEASE = '1.2.0 릴리스 이슈들 상세도 같이 보여줘';

  it('a same-source Jira -> Jira reference to an earlier read passes, with reference provenance', () => {
    const result = validateAgentPlan(plan([read('jira.release', { release: '1.2.0' }), read('jira.issues', {}, { step: 1, field: 'issueKeys', take: 10 })]), ctx(RELEASE));
    expect(result.ok).toBe(true);
    if (!result.ok || result.plan.kind === 'none') throw new Error('expected a plan');
    const second = result.plan.steps[1];
    expect(second?.kind === 'read' ? second.ref?.provenance : undefined).toEqual({ kind: 'reference', step: 1, entryId: 'jira.release', origin: 'jira:configured-site' });
  });

  it('refs only to an EARLIER read step: forward, self and summary references are refused', () => {
    expect(validateAgentPlan(plan([read('jira.issues', {}, { step: 2, field: 'issueKeys', take: 1 }), read('jira.release', { release: '1.2.0' })]), ctx(RELEASE))).toMatchObject({ ok: false, reason: 'ref-forward', step: 1 });
    expect(validateAgentPlan(plan([read('jira.issues', {}, { step: 1, field: 'issueKeys', take: 1 })]), ctx('지라'))).toMatchObject({ ok: false, reason: 'ref-forward', step: 1 });
    expect(validateAgentPlan(plan([read('jira.release', { release: '1.2.0' }), summary([1]), read('jira.issues', {}, { step: 2, field: 'issueKeys', take: 1 })]), ctx(RELEASE))).toMatchObject({ ok: false, reason: 'ref-not-read', step: 3 });
  });

  it.each([
    ['mail.list', 'messageIds', '안 읽은 메일이랑 관련 지라 이슈'],
    ['calendar.events', 'eventIds', '오늘 일정이랑 관련 지라 이슈'],
    ['drive.files', 'fileIds', '드라이브 파일이랑 관련 지라 이슈'],
    ['slack.search', 'messageIds', '슬랙 배포 얘기랑 지라 이슈'],
  ])('a cross-source reference (%s ids -> Jira) is refused', (source, field, text) => {
    const first = source === 'slack.search' ? read(source, { keyword: '배포' }) : read(source);
    expect(validateAgentPlan(plan([first, read('jira.issues', {}, { step: 1, field, take: 3 })]), ctx(text))).toMatchObject({ ok: false, reason: 'ref-cross-source', step: 2 });
  });

  it('Jira ids never feed another connector either (Jira -> Confluence search is refused)', () => {
    const steps = [read('jira.release', { release: '1.2.0' }), read('confluence.search', { keyword: '릴리스' }, { step: 1, field: 'issueKeys', take: 2 })];
    expect(validateAgentPlan(plan(steps), ctx('1.2.0 릴리스 이슈랑 컨플루언스 릴리스 문서'))).toMatchObject({ ok: false, reason: 'ref-cross-source', step: 2 });
  });

  it('only the closed id field the source projects; a date field from content is refused as a date', () => {
    expect(validateAgentPlan(plan([read('jira.release', { release: '1.2.0' }), read('jira.issues', {}, { step: 1, field: 'summaries', take: 2 })]), ctx(RELEASE))).toMatchObject({ ok: false, reason: 'ref-field', step: 2 });
    for (const field of ['dueDates', 'startTime', 'eventDay', 'when']) {
      expect(validateAgentPlan(plan([read('calendar.events'), read('calendar.events', {}, { step: 1, field, take: 1 })]), ctx('오늘 일정')), field).toMatchObject({ ok: false, reason: 'ref-date', step: 2 });
    }
  });

  it('a local store has no projected ids: a reference from or to it is refused', () => {
    expect(validateAgentPlan(plan([read('todo.list'), read('todo.list', {}, { step: 1, field: 'itemIds', take: 1 })]), ctx('할 일 목록'))).toMatchObject({ ok: false, reason: 'ref-field', step: 2 });
  });

  it('at most 10 values per reference (ADR-0121 D2, kept 2026-10-21): 10 passes, the 11th asks for the first 10', () => {
    const ten = plan([read('jira.release', { release: '1.2.0' }), read('jira.issues', {}, { step: 1, field: 'issueKeys', take: 10 })]);
    expect(validateAgentPlan(ten, ctx(RELEASE)).ok).toBe(true);
    const eleven = plan([read('jira.release', { release: '1.2.0' }), read('jira.issues', {}, { step: 1, field: 'issueKeys', take: 11 })]);
    const asked = validateAgentPlan(eleven, ctx(RELEASE));
    expect(asked).toMatchObject({ ok: true, plan: { kind: 'ask', bound: 'refs' } });
    if (!asked.ok || asked.plan.kind !== 'ask') throw new Error('expected an ask');
    expect(asked.plan.suggestion.map((step) => (step.kind === 'read' ? step.ref?.take ?? 0 : -1))).toEqual([0, 10]);
    // A cross-source reference over the cap is refused for being cross-source, never asked (CA P2).
    expect(validateAgentPlan(plan([read('mail.list'), read('jira.issues', {}, { step: 1, field: 'messageIds', take: 80 })]), ctx('메일이랑 관련 지라 이슈'))).toMatchObject({ ok: false, reason: 'ref-cross-source', step: 2 });
  });

  it('at most 10 referenced values per run: 6 + 4 passes, 6 + 5 asks with the run clamped to 6 + 4', () => {
    const base = [read('jira.release', { release: '1.2.0' }), read('jira.issues', {}, { step: 1, field: 'issueKeys', take: 6 })];
    const within = validateAgentPlan(plan([...base, read('jira.issues', { status: 'all' }, { step: 1, field: 'issueKeys', take: 4 })]), ctx(`${RELEASE} 완료된 것도 전체`));
    expect(within).toMatchObject({ ok: true, plan: { kind: 'run' } });
    const over = validateAgentPlan(plan([...base, read('jira.issues', { status: 'all' }, { step: 1, field: 'issueKeys', take: 5 })]), ctx(`${RELEASE} 완료된 것도 전체`));
    if (!over.ok || over.plan.kind !== 'ask') throw new Error('expected an ask');
    expect(over.plan.bound).toBe('refs');
    expect(over.plan.suggestion.map((step) => (step.kind === 'read' ? step.ref?.take ?? 0 : -1))).toEqual([0, 6, 4]);
  });
});

describe('plan validator: dates only symbolic, summaries closed', () => {
  it('a symbolic period passes; an absolute date the owner wrote passes', () => {
    expect(validateAgentPlan(plan([read('calendar.events', { range: 'next-week' }), read('jira.issues')]), ctx('다음 주 일정이랑 지라 이슈')).ok).toBe(true);
    expect(validateAgentPlan(plan([read('calendar.events', { range: '10-23' }), read('jira.issues')]), ctx('10월 23일 일정이랑 지라 이슈')).ok).toBe(true);
  });

  it('a date taken from content (not in the owner\'s words) is refused', () => {
    const result = validateAgentPlan(plan([read('mail.list'), read('calendar.events', { range: '10-23' })]), ctx('메일에 나온 날짜 일정도 보여줘'));
    expect(result).toMatchObject({ ok: false, reason: 'date-ungrounded', step: 2 });
    expect(absoluteDatesGrounded('2027-10-23', '10월 23일')).toBe(false);
    expect(absoluteDatesGrounded('10-20..10-24', '10/20부터 10/24까지')).toBe(true);
    expect(absoluteDatesGrounded('this-week', '')).toBe(true);
    // Two numbers elsewhere in the owner's words are no date expression (CA review).
    expect(absoluteDatesGrounded('10-20', '10시 20분 회의 일정')).toBe(false);
    expect(absoluteDatesGrounded('10-20', '10명이 20개 처리')).toBe(false);
    expect(absoluteDatesGrounded('10-20', '10월 20일 일정')).toBe(true);
    expect(absoluteDatesGrounded('10-20', '10 월 20 일')).toBe(true);
    expect(absoluteDatesGrounded('10-20', '10/20 일정')).toBe(true);
    expect(absoluteDatesGrounded('10-20', '10-20 일정')).toBe(true);
    expect(absoluteDatesGrounded('2026-10-20', '2026-10-20 일정')).toBe(true);
    expect(absoluteDatesGrounded('10-02', '10월 2일')).toBe(true);
    expect(absoluteDatesGrounded('10-02', '10월 12일')).toBe(false);
    expect(validateAgentPlan(plan([read('calendar.events', { range: '10-20' }), read('jira.issues')]), ctx('10시 20분 일정이랑 지라 이슈'))).toMatchObject({ ok: false, reason: 'date-ungrounded', step: 1 });
  });

  it('step-scoped temporal grounding: one step\'s weekday never constrains another step (Codex P2)', () => {
    const text = '금요일 일정이랑 오늘 받은 메일 보여줘';
    const codex = plan([read('calendar.events', { range: 'fri' }), read('mail.list', { range: 'today' })]);
    expect(validateAgentPlan(codex, ctx(text))).toMatchObject({ ok: true, plan: { kind: 'run' } });
    // Each half validates on its own too (single-step plans are unchanged and see the whole prose).
    expect(validateAgentPlan(plan([read('calendar.events', { range: 'fri' })]), ctx('금요일 일정 보여줘')).ok).toBe(true);
    // English modifiers follow their noun.
    const english = plan([read('calendar.events', { range: 'fri' }), read('mail.list', { range: 'today' })]);
    expect(validateAgentPlan(english, ctx('show my calendar for friday and mail from today')).ok).toBe(true);
  });

  it('English binding: a prenominal period binds to the next source inside its conjunct, a postnominal one to the preceding source', () => {
    const steps = plan([read('calendar.events', { range: 'fri' }), read('mail.list', { range: 'today' })]);
    // Prenominal (Codex P2): "today" belongs to "mail", not to the calendar before the "and".
    expect(validateAgentPlan(steps, ctx('show Friday calendar and today mail')).ok).toBe(true);
    expect(validateAgentPlan(steps, ctx('show Friday calendar, today mail')).ok).toBe(true);
    // Postnominal: no source follows inside the conjunct, so the preceding one.
    expect(validateAgentPlan(steps, ctx('show my calendar for friday and my mail from today')).ok).toBe(true);
    // Swapped values under either construction are refused.
    const swapped = plan([read('calendar.events', { range: 'today' }), read('mail.list', { range: 'fri' })]);
    expect(validateAgentPlan(swapped, ctx('show Friday calendar and today mail'))).toMatchObject({ ok: false, reason: 'range-unnamed', step: 1 });
    expect(validateAgentPlan(swapped, ctx('show my calendar for friday and my mail from today'))).toMatchObject({ ok: false, reason: 'range-unnamed', step: 1 });
  });

  it('swapped ranges are refused: each period is bound to the source it modifies', () => {
    const swapped = plan([read('calendar.events', { range: 'today' }), read('mail.list', { range: 'fri' })]);
    expect(validateAgentPlan(swapped, ctx('금요일 일정이랑 오늘 받은 메일 보여줘'))).toMatchObject({ ok: false, reason: 'range-unnamed', step: 1 });
    // Both swapped periods would be valid values on their own: still refused.
    const both = plan([read('calendar.events', { range: 'today' }), read('mail.list', { range: 'yesterday' })]);
    expect(validateAgentPlan(both, ctx('어제 일정이랑 오늘 받은 메일 보여줘'))).toMatchObject({ ok: false, reason: 'range-unnamed', step: 1 });
    expect(validateAgentPlan(plan([read('calendar.events', { range: 'yesterday' }), read('mail.list', { range: 'today' })]), ctx('어제 일정이랑 오늘 받은 메일 보여줘')).ok).toBe(true);
  });

  it('a range named by nobody is refused; the previous selection may carry one', () => {
    const unnamed = plan([read('calendar.events', { range: 'tomorrow' }), read('mail.list', { range: 'today' })]);
    expect(validateAgentPlan(unnamed, ctx('일정이랑 오늘 받은 메일 보여줘'))).toMatchObject({ ok: false, reason: 'range-unnamed', step: 1 });
    expect(validateAgentPlan(plan([read('calendar.events', { range: 'tomorrow' }), read('jira.issues')]), ctx('일정이랑 지라 이슈'))).toMatchObject({ ok: false, reason: 'range-unnamed', step: 1 });
    expect(validateAgentPlan(unnamed, ctx('그 일정이랑 오늘 받은 메일 보여줘', { previousArgs: { range: 'tomorrow' } })).ok).toBe(true);
  });

  it('two steps of the same entry with different ranges are ambiguous', () => {
    const twice = plan([read('calendar.events', { range: 'today' }), read('calendar.events', { range: 'tomorrow' })]);
    expect(validateAgentPlan(twice, ctx('오늘 일정이랑 내일 일정'))).toMatchObject({ ok: false, reason: 'range-ambiguous', step: 2 });
  });

  it('the previous selection may carry a date the owner named earlier (structure only)', () => {
    expect(validateAgentPlan(plan([read('calendar.events', { range: '10-23' })]), ctx('그 날 일정 다시', { previousArgs: { range: '10-23' } })).ok).toBe(true);
  });

  it('a summary needs a closed schema over earlier read steps, each once', () => {
    expect(validateAgentPlan(plan([read('jira.issues'), summary([1], 'free-form.v1')]), ctx('지라 요약'))).toMatchObject({ ok: false, reason: 'summary-schema', step: 2 });
    expect(validateAgentPlan(plan([read('jira.issues'), summary([2])]), ctx('지라 요약'))).toMatchObject({ ok: false, reason: 'summary-source', step: 2 });
    expect(validateAgentPlan(plan([read('jira.issues'), summary([1, 1])]), ctx('지라 요약'))).toMatchObject({ ok: false, reason: 'summary-source', step: 2 });
    expect(validateAgentPlan(plan([read('jira.issues'), summary([1]), summary([2])]), ctx('지라 요약'))).toMatchObject({ ok: false, reason: 'summary-source', step: 3 });
    expect(validateAgentPlan(plan([read('calendar.events'), summary([1], 'meeting-digest.v1')]), ctx('오늘 회의 정리')).ok).toBe(true);
  });
});

describe('plan validator: the selection path vetoes are validator rules (CA review of S2 P2)', () => {
  it('a past statement is refused as veto-past-statement, before any other rule', () => {
    expect(validateAgentPlan(plan([read('calendar.events'), read('todo.list')]), ctx('아침에 일정이랑 할 일 정리 끝났다'))).toMatchObject({ ok: false, reason: 'veto-past-statement' });
    expect(validateAgentPlan(plan([read('shell.exec')]), ctx('아침에 지라 이슈 정리 끝났다'))).toMatchObject({ ok: false, reason: 'veto-past-statement' });
  });

  it('a read step whose sentence only quotes a request is refused with its step', () => {
    expect(validateAgentPlan(plan([read('jira.issues')]), ctx('"지라 이슈 보여줘"라는 말은 영어로 뭐라고 해?'))).toMatchObject({ ok: false, reason: 'veto-quoted-request', step: 1 });
  });

  it('a quote consumed as one step\'s search keyword is the owner\'s search term for the whole plan (Codex P2)', () => {
    const text = '슬랙에서 "일정 보여줘"라고 검색하고 지라 이슈 보여줘';
    expect(validateAgentPlan(plan([read('slack.search', { keyword: '일정 보여줘' }), read('jira.issues')]), ctx(text)).ok).toBe(true);
    // Consumed by no step: the veto stays.
    expect(validateAgentPlan(plan([read('jira.issues'), read('github.items')]), ctx('"일정 보여줘"라고 말하면 되나? 지라 이슈랑 깃허브 PR'))).toMatchObject({ ok: false, reason: 'veto-quoted-request', step: 1 });
  });

  it('a request is not vetoed; none stays none', () => {
    expect(validateAgentPlan(plan([read('jira.issues'), read('mail.list')]), ctx('지라 이슈랑 메일 보여줘')).ok).toBe(true);
    expect(validateAgentPlan({ kind: 'none', form: 'selection' }, ctx('아침에 일정 정리 끝났다'))).toEqual({ ok: true, plan: { kind: 'none' } });
  });
});

describe('plan validator: widened date expressions (CA review of S2 P2)', () => {
  it.each([
    ['10-25', 'what do I have on October 25?'],
    ['10-25', 'calendar for Oct 25th'],
    ['10-25', 'my calendar on 25 Oct'],
    ['10-25', 'the 25th of October'],
    ['10-25', 'oct. 25 일정'],
    ['10-01..10-07', '10월 1일부터 7일까지 일정 보여줘'],
    ['10-01..10-07', '10/1~7 일정'],
    ['10-01..10-07', '10월 1-7일 일정'],
    ['10-01..10-07', 'calendar for Oct 1 to 7'],
    ['10-01..10-07', '10월 1일부터 10월 7일까지'],
    ['10-01..10-07', 'October 1st through 7th'],
    ['10-01..10-07', 'Oct 1 until 7'],
    ['10-01..10-07', '10월 1일부터 7까지'],
    ['10-01..10-07', '10월 1일~7일 일정'],
  ])('%s is grounded by "%s"', (value, text) => {
    expect(absoluteDatesGrounded(value, text)).toBe(true);
  });

  it.each([
    ['10-25', 'October'],
    ['10-25', 'Oct 2'],
    ['10-25', 'November 25'],
    ['10-25', 'octopus 25'],
    ['10-01..10-07', '10월 1일 일정이랑 7개 이슈'],
    ['10-01..10-07', '10월 1일 3-7시 일정'],
    ['10-01..10-07', '1일부터 7일까지'],
    ['10-01..11-07', '10월 1일부터 7일까지'],
    ['10-01..10-08', '10/1~7'],
    ['2027-10-25', 'October 25'],
    // Codex P2: an inherited end number that means something else.
    ['10-01..10-07', 'from Oct 1 to 7 November'],
    ['10-01..10-07', '10월 1일부터 7개 일정'],
    ['10-01..10-07', 'Oct 1 to 7th of November'],
    ['10-01..10-07', '10월 1일부터 7월까지'],
    ['10-01..10-07', 'Oct 1 to 7pm'],
    ['10-01..10-07', 'Oct 1 - 7 items'],
    ['10-01..10-07', '10월 1일 ~ 7시'],
    ['10-01..10-07', '10월 1일부터 7건'],
    ['10-01..10-07', '10월 1일부터 7 일정'],
  ])('%s is not grounded by "%s" (the owner\'s own digits and month stay required)', (value, text) => {
    expect(absoluteDatesGrounded(value, text)).toBe(false);
  });

  it('the two one-step golds the P1 rule refused now validate', () => {
    expect(validateAgentPlan(plan([read('calendar.events', { range: '10-01..10-07' })]), ctx('10월 1일부터 7일까지 일정 보여줘')).ok).toBe(true);
    expect(validateAgentPlan(plan([read('calendar.events', { range: '10-25' })]), ctx('what do I have on October 25?')).ok).toBe(true);
  });
});

describe('plan validator: unbounded requests are a bounded-suggestion ask (owner review 2026-10-21, decision (h))', () => {
  const graph = (validation: ReturnType<typeof validateAgentPlan>) => {
    if (!validation.ok || validation.plan.kind !== 'ask') throw new Error(`expected an ask, got ${JSON.stringify(validation)}`);
    return { bound: validation.plan.bound, steps: validation.plan.suggestion.map((step) => (step.kind === 'read' ? { entryId: step.entry.id, args: step.args, ...(step.ref !== undefined ? { take: step.ref.take } : {}) } : { summarize: step.from, schema: step.schema })) };
  };

  it('a read per day of a longer period asks for this month; days inside this week ask for this week', () => {
    const days = plan(['10-01', '10-02', '10-03'].map((range) => read('calendar.events', { range })));
    expect(graph(validateAgentPlan(days, ctx('올해 매일 일정 보여줘')))).toEqual({ bound: 'per-period', steps: [{ entryId: 'calendar.events', args: { range: 'this-month' } }] });
    const week = plan([read('calendar.events', { range: 'this-mon' }), summary([1]), read('calendar.events', { range: 'this-tue' }), summary([3]), read('calendar.events', { range: 'this-wed' })]);
    expect(graph(validateAgentPlan(week, ctx('이번 주 매일 일정 하루씩 요약해줘')))).toEqual({
      bound: 'per-period',
      steps: [{ entryId: 'calendar.events', args: { range: 'this-week' } }, { summarize: [1], schema: 'meeting-digest.v1' }],
    });
  });

  it('two different periods of one entry stay range-ambiguous (P1); the third makes it a per-period ask', () => {
    expect(validateAgentPlan(plan([read('calendar.events', { range: 'today' }), read('calendar.events', { range: 'tomorrow' })]), ctx('오늘 일정이랑 내일 일정'))).toMatchObject({ ok: false, reason: 'range-ambiguous' });
    expect(validateAgentPlan(plan(['today', 'tomorrow', 'yesterday'].map((range) => read('calendar.events', { range }))), ctx('오늘 내일 어제 일정'))).toMatchObject({ ok: true, plan: { kind: 'ask', bound: 'per-period' } });
  });

  it('more than 4 reads asks for the first 4, with their summaries renumbered', () => {
    const six = plan([read('jira.issues'), read('github.items'), read('mail.list'), read('drive.files'), read('todo.list'), summary([1, 2, 3, 4, 5])]);
    expect(graph(validateAgentPlan(six, ctx('지라 깃허브 메일 드라이브 할 일 전부 정리')))).toEqual({
      bound: 'reads',
      steps: [{ entryId: 'jira.issues', args: {} }, { entryId: 'github.items', args: {} }, { entryId: 'mail.list', args: {} }, { entryId: 'drive.files', args: {} }],
    });
  });

  it('CA P2: only a plan that breaks nothing but a bound is asked; a content-borne or write-shaped plan never gets a suggestion', () => {
    // "메일에 적힌 대로 다 해줘": five reads, one keyword taken from content (not in the owner's words).
    const contentBorne = plan([read('mail.list'), read('jira.issues', { keyword: '인증서' }), read('github.items'), read('drive.files'), read('todo.list')]);
    expect(validateAgentPlan(contentBorne, ctx('메일에 적힌 대로 지라 깃허브 드라이브 할 일 다 해줘'))).toMatchObject({ ok: false, reason: 'step-invalid', step: 2, stepReason: 'ungrounded' });
    // A per-period plan whose other step is a cross-source reference.
    const crossSource = plan([...['today', 'tomorrow', 'yesterday'].map((range) => read('calendar.events', { range })), read('jira.issues', {}, { step: 1, field: 'eventIds', take: 3 })]);
    expect(validateAgentPlan(crossSource, ctx('오늘 내일 어제 일정이랑 관련 지라 이슈'))).toMatchObject({ ok: false, reason: 'ref-cross-source', step: 4 });
  });

  it('an A6 or single-step-only entry refuses before any bound: an unbounded plan holding one is never an ask', () => {
    const withA6 = plan([...Array.from({ length: 4 }, () => read('jira.issues')), read('todo.add', { title: '우유' })]);
    expect(validateAgentPlan(withA6, ctx('지라 이슈 보고 우유 할 일 추가'))).toMatchObject({ ok: false, reason: 'a6-in-plan', step: 5 });
    const withHelp = plan([...Array.from({ length: 4 }, () => read('jira.issues')), read('help.topic')]);
    expect(validateAgentPlan(withHelp, ctx('지라 이슈 도움말'))).toMatchObject({ ok: false, reason: 'single-step-only', step: 5 });
  });

  it('the ask reply is a fixed phrasing hint with closed nouns, never a yes/no question, an owner word or a value (CA P2)', () => {
    const ask = validateAgentPlan(plan(['10-01', '10-02', '10-03'].map((range) => read('calendar.events', { range }))), ctx('올해 매일 일정 보여줘'));
    if (!ask.ok || ask.plan.kind !== 'ask') throw new Error('expected an ask');
    expect(renderUnboundedAsk(ask.plan, 'ko')).toBe("기간을 날마다·주마다·달마다 나눠 읽는 건 한 번에 할 수 없어요. '이번 달 일정 보여줘'처럼 기간을 한 번에 말씀해 주세요.");
    const refs = validateAgentPlan(plan([read('jira.release', { release: '1.2.0' }), read('jira.issues', {}, { step: 1, field: 'issueKeys', take: 100 })]), ctx(RELEASE_TEXT));
    if (!refs.ok || refs.plan.kind !== 'ask') throw new Error('expected an ask');
    expect(renderUnboundedAsk(refs.plan, 'ko')).toBe("이슈 상세는 한 번에 10개까지 볼 수 있어요. '릴리스 이슈 10개 자세히 보여줘'처럼 10개 이하로 말씀해 주세요.");
    expect(renderUnboundedAsk(refs.plan, 'en')).toBe('I can open at most 10 issues in detail at once. Ask like "show 10 of the release issues in detail".');
    for (const language of ['ko', 'en'] as const) {
      for (const text of [renderUnboundedAsk(ask.plan, language), renderUnboundedAsk(refs.plan, language)]) expect(text).not.toMatch(/\?|볼까요|할까요/);
    }
    expect(renderUnboundedAsk(refs.plan, 'ko')).not.toContain('1.2.0');
  });
});

const RELEASE_TEXT = '1.2.0 릴리스 이슈 백 개 전부 상세';

describe('plan validator: the planner-only GitHub item type (owner review 2026-10-21, ap-p062)', () => {
  const argsOf = (validation: ReturnType<typeof validateAgentPlan>, step: number) => {
    if (!validation.ok || validation.plan.kind !== 'run') throw new Error(`expected a run plan, got ${JSON.stringify(validation)}`);
    const found = validation.plan.steps[step - 1];
    return found?.kind === 'read' ? found.args : undefined;
  };

  it('kind is grounded in the owner\'s words (PR / pull request / 풀리퀘 vs 이슈 / issue); all is the omitted default', () => {
    expect(argsOf(validateAgentPlan(plan([read('jira.issues'), read('github.items', { kind: 'pr' })]), ctx('지라 이슈랑 깃허브 PR 보여줘')), 2)).toEqual({ kind: 'pr' });
    expect(argsOf(validateAgentPlan(plan([read('jira.issues'), read('github.items', { kind: 'pr' })]), ctx('show my jira issues and my github pull requests')), 2)).toEqual({ kind: 'pr' });
    expect(argsOf(validateAgentPlan(plan([read('github.items', { kind: 'issue' }), read('mail.list')]), ctx('깃허브 내 이슈랑 메일함 보여줘')), 1)).toEqual({ kind: 'issue' });
    expect(argsOf(validateAgentPlan(plan([read('github.items', { kind: 'all' }), read('mail.list')]), ctx('깃허브랑 메일함 보여줘')), 1)).toEqual({});
  });

  it('CA P3: kind is grounded only in the GitHub step\'s own clause ("지라 이슈랑 깃허브 PR" never grounds kind issue)', () => {
    expect(validateAgentPlan(plan([read('jira.issues'), read('github.items', { kind: 'issue' })]), ctx('지라 이슈랑 깃허브 PR 보여줘'))).toMatchObject({ ok: false, reason: 'step-invalid', step: 2, stepReason: 'ungrounded' });
    expect(validateAgentPlan(plan([read('jira.issues'), read('github.items', { kind: 'issue' })]), ctx('show my jira issues and my github pull requests'))).toMatchObject({ ok: false, reason: 'step-invalid', step: 2 });
    expect(argsOf(validateAgentPlan(plan([read('github.items', { kind: 'issue' }), read('jira.issues')]), ctx('깃허브 내 이슈랑 지라 이슈 보여줘')), 1)).toEqual({ kind: 'issue' });
    expect(argsOf(validateAgentPlan(plan([read('github.items', { kind: 'pr' }), read('mail.list', { unread: true })]), ctx('내 PR이랑 안 읽은 메일 보여줘')), 1)).toEqual({ kind: 'pr' });
  });

  it('an ungrounded kind is refused; review requests drop it (they are pull requests already)', () => {
    expect(validateAgentPlan(plan([read('github.items', { kind: 'pr' }), read('mail.list')]), ctx('깃허브랑 메일함 보여줘'))).toMatchObject({ ok: false, reason: 'step-invalid', step: 1, stepReason: 'ungrounded' });
    expect(argsOf(validateAgentPlan(plan([read('github.items', { query: 'review-requests', kind: 'pr' }), read('mail.list')]), ctx('깃허브 PR 리뷰 요청이랑 메일함 보여줘')), 1)).toEqual({ query: 'review-requests' });
  });
});

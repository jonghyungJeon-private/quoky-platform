import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AGENT_HANDOFF_KINDS, AGENT_HANDOFF_SLOTS } from './handoff-slots';
import { agentPlanParseFailure, parseAgentPlanOutput } from './plan-schema';
import { validateAgentPlan, type AgentPlanValidationContext } from './plan-validator';

// ADR-0121 amendment A4, slice A4-S1 (handoff-plan): the `handoff` form of the plan schema and rule 8 of the validator.
// Structure only: closed sets, the closed slot table, the catalog's own arg declarations and the owner's own words.

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const ctx = (groundingText: string, extra: Partial<AgentPlanValidationContext> = {}): AgentPlanValidationContext => ({
  offered: new Map([...READS, ...ACTIONS].map((entry) => [entry.id, entry] as const)),
  groundingText,
  now: '2026-10-20T03:00:00.000Z',
  timeZone: 'Asia/Seoul',
  direct: true,
  ...extra,
});

const MAIL_TO_CALENDAR = {
  steps: [{ entryId: 'mail.list', args: {} }],
  ambiguity: 'CLEAR',
  handoff: { from: 1, kind: 'date', scope: 'one-item', item: 'owner-pick', to: { entryId: 'calendar.events', slot: 'range', args: { availability: true } } },
};
const TEXT = '메일에 나온 날짜에 내 일정 비어 있는지 봐줘';

function check(body: unknown, text = TEXT, extra: Partial<AgentPlanValidationContext> = {}) {
  const parsed = parseAgentPlanOutput(JSON.stringify(body));
  if (parsed === null || parsed.kind !== 'steps') throw new Error('does not parse');
  return validateAgentPlan(parsed, ctx(text, extra));
}
const withHandoff = (patch: Record<string, unknown>, steps: unknown[] = MAIL_TO_CALENDAR.steps) => ({
  ...MAIL_TO_CALENDAR,
  steps,
  handoff: { ...MAIL_TO_CALENDAR.handoff, ...patch },
});

describe('handoff form (parse)', () => {
  it('keeps a well-formed handoff and rejects every malformed one (strict and total)', () => {
    const parsed = parseAgentPlanOutput(JSON.stringify(MAIL_TO_CALENDAR));
    expect(parsed).toMatchObject({ kind: 'steps', form: 'steps', handoff: { from: 1, kind: 'date', scope: 'one-item', item: 'owner-pick', to: { entryId: 'calendar.events', slot: 'range', args: { availability: true } } } });
    const bad = [
      withHandoff({ extra: 1 }),
      withHandoff({ from: 0 }),
      withHandoff({ kind: 'Date value!' }),
      withHandoff({ to: { entryId: 'calendar.events' } }),
      withHandoff({ to: { entryId: 'calendar.events', slot: 'range', args: { a: { nested: 1 } } } }),
      withHandoff({ to: { entryId: 'calendar.events', slot: 'range', surplus: true } }),
      withHandoff({ fallback: { kind: 'titleKeyword' } }),
      { ...MAIL_TO_CALENDAR, handoff: 'date' },
    ];
    for (const body of bad) {
      expect(parseAgentPlanOutput(JSON.stringify(body))).toBeNull();
      expect(agentPlanParseFailure(JSON.stringify(body))).toBe('bad-handoff');
    }
  });

  it('is a steps-form key only: the selection form carries none', () => {
    const selection = { entryId: 'mail.list', args: {}, ambiguity: 'CLEAR', alternatives: [], handoff: MAIL_TO_CALENDAR.handoff };
    expect(parseAgentPlanOutput(JSON.stringify(selection))).toBeNull();
  });
});

describe('handoff plan (validator rule 8)', () => {
  it('validates a handoff into a catalog slot to a `handoff` plan: the source steps, the declared handoff, no value', () => {
    const got = check(MAIL_TO_CALENDAR);
    expect(got.ok).toBe(true);
    if (!got.ok || got.plan.kind !== 'handoff') throw new Error('not a handoff plan');
    expect(got.plan.steps.map((step) => (step.kind === 'read' ? step.entry.id : 'summarize'))).toEqual(['mail.list']);
    expect(got.plan.connectorCalls).toBe(1);
    expect(got.plan.handoff).toMatchObject({ from: 1, kind: 'date', scope: 'one-item', item: 'owner-pick', to: { slot: 'range', args: { availability: true } } });
    expect(got.plan.handoff.to.entry.id).toBe('calendar.events');
    expect(got.plan.handoff).not.toHaveProperty('fallback');
  });

  it('accepts the "newest item" and the each-item forms, a free-text each-item one only with the batch-preview consent', () => {
    expect(check(withHandoff({ item: 'first' }), '지난번 메일에 적힌 마감일로 일정 확인해줘').ok).toBe(true);
    const each = {
      steps: [{ entryId: 'calendar.events', args: { range: 'this-week', timedOnly: true } }],
      ambiguity: 'CLEAR',
      handoff: { from: 1, kind: 'titleKeyword', scope: 'each-item', to: { entryId: 'confluence.search', slot: 'keyword' }, consent: 'batch-preview' },
    };
    const text = '이번 주 회의마다 관련 컨플루언스 페이지 하나씩 붙여서 보여줘';
    const got = check(each, text);
    expect(got.ok && got.plan.kind === 'handoff' ? got.plan.handoff : undefined).toMatchObject({ scope: 'each-item', consent: 'batch-preview' });
    expect(got.ok && got.plan.kind === 'handoff' ? got.plan.handoff.item : 'x').toBeUndefined();
    expect(check({ ...each, handoff: { ...each.handoff, consent: undefined } }, text)).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    // A closed-format each-item kind never asks for the preview.
    const closed = { steps: [{ entryId: 'mail.list', args: {} }], ambiguity: 'CLEAR', handoff: { from: 1, kind: 'date', scope: 'each-item', to: { entryId: 'calendar.events', slot: 'range' } } };
    const closedText = '메일마다 거기 나온 날짜의 일정 보여줘';
    expect(check(closed, closedText).ok).toBe(true);
    expect(check({ ...closed, handoff: { ...closed.handoff, consent: 'batch-preview' } }, closedText)).toMatchObject({ ok: false, reason: 'handoff-invalid' });
  });

  it('fail closed on the closed sets, the scope/item pairing, a fallback off an each-item scope and a plan that is not CLEAR', () => {
    expect(check(withHandoff({ kind: 'secret' }))).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    expect(check(withHandoff({ scope: 'all-items' }))).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    expect(check(withHandoff({ item: undefined }))).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    expect(check(withHandoff({ item: 'latest' }))).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    expect(check(withHandoff({ scope: 'each-item' }))).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    expect(check(withHandoff({ fallback: { kind: 'titleKeyword', to: { entryId: 'jira.issues', slot: 'keyword' } } }))).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    expect(check({ ...MAIL_TO_CALENDAR, ambiguity: 'NEEDS_CLARIFICATION' })).toMatchObject({ ok: false, reason: 'handoff-invalid' });
  });

  it('the destination is a declared, existing, offered slot that accepts the kind; a planned slot is refused until A4-S3', () => {
    expect(check(withHandoff({ kind: 'jiraKey' }))).toMatchObject({ ok: false, reason: 'handoff-slot' });
    expect(check(withHandoff({ to: { entryId: 'calendar.events', slot: 'availability' } }))).toMatchObject({ ok: false, reason: 'handoff-slot' });
    expect(check(withHandoff({ to: { entryId: 'todo.add', slot: 'title' } }))).toMatchObject({ ok: false, reason: 'handoff-slot' });
    expect(check(withHandoff({ to: { entryId: 'calendar.events', slot: 'range' } }, [{ entryId: 'calendar.events', args: {} }]))).toMatchObject({ ok: false, reason: 'handoff-slot' });
    expect(check(withHandoff({ kind: 'jiraKey', to: { entryId: 'jira.issue', slot: 'key' } }), '메일에 적힌 지라 키로 이슈 상태 봐줘')).toMatchObject({ ok: false, reason: 'handoff-slot' });
    expect(check(withHandoff({ kind: 'email', to: { entryId: 'calendar.events', slot: 'attendee' } }), '메일에 나온 사람들 일정 다 확인해줘')).toMatchObject({ ok: false, reason: 'handoff-slot' });
    // Not offered this turn: nothing to read.
    const offered = new Map(READS.filter((entry) => entry.id !== 'calendar.events').map((entry) => [entry.id, entry] as const));
    expect(check(MAIL_TO_CALENDAR, TEXT, { offered })).toMatchObject({ ok: false, reason: 'handoff-slot' });
  });

  it('every row of the slot table is a closed kind, and the validator accepts exactly the catalog rows', () => {
    for (const [key, row] of Object.entries(AGENT_HANDOFF_SLOTS)) {
      expect(row.kinds.length, key).toBeGreaterThan(0);
      for (const kind of row.kinds) expect(AGENT_HANDOFF_KINDS as readonly string[], key).toContain(kind);
      const slot = key.split('.').at(-1) as string;
      const entryId = key.slice(0, key.length - slot.length - 1);
      const declared = READS.find((entry) => entry.id === entryId)?.args.some((spec) => spec.name === slot) === true;
      expect(declared, key).toBe(!row.planned);
    }
  });

  it('the destination args never preset the slot and pass ADR-0120 D4', () => {
    expect(check(withHandoff({ to: { entryId: 'calendar.events', slot: 'range', args: { range: 'today' } } }))).toMatchObject({ ok: false, reason: 'handoff-args' });
    expect(check(withHandoff({ to: { entryId: 'calendar.events', slot: 'range', args: { nonsense: 'x' } } }))).toMatchObject({ ok: false, reason: 'handoff-args' });
    const jira = (args: Record<string, unknown>) => withHandoff({ to: { entryId: 'jira.issues', slot: 'keyword', args }, kind: 'keyword' });
    expect(check(jira({ status: 'all' }), '메일에 적힌 키워드로 지라 이슈 찾아줘').ok).toBe(true);
    expect(check(jira({ status: 'bogus' }), '메일에 적힌 키워드로 지라 이슈 찾아줘')).toMatchObject({ ok: false, reason: 'handoff-args' });
  });

  it('grounding: the owner\'s own words must name the source entry and the destination entry', () => {
    // The destination is named only inside a quoted span (not the owner's words): ungrounded, in every quote form.
    expect(check(MAIL_TO_CALENDAR, '메일에 나온 날짜 봐줘')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    expect(check(MAIL_TO_CALENDAR, '메일에 나온 날짜 봐줘. 제목은 "내 일정"이야')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    expect(check(MAIL_TO_CALENDAR, "메일에 나온 날짜 봐줘. 제목은 '내 일정'이야")).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    expect(check(MAIL_TO_CALENDAR, '메일에 나온 날짜 봐줘 “일정 확인해줘”')).toMatchObject({ ok: false });
    // The source is not named.
    expect(check(MAIL_TO_CALENDAR, '내 일정 비어 있는지 봐줘')).toMatchObject({ ok: false, reason: 'handoff-ungrounded', step: 1 });
    expect(check(MAIL_TO_CALENDAR, '')).toMatchObject({ ok: false });
  });

  it('linkage and scope: one clause of the owner\'s words names source and destination; each-item needs a distributive marker; a negated clause grounds nothing', () => {
    // Two separate requests (two clauses) with an invented handoff between them.
    expect(check(MAIL_TO_CALENDAR, '메일 보여주고 일정도 보여줘')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    expect(check(MAIL_TO_CALENDAR, '메일 보고 일정 확인해줘')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    expect(check(MAIL_TO_CALENDAR, '메일 보여줘, 일정도 보여줘')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    // each-item without a distributive marker.
    const each = { ...MAIL_TO_CALENDAR, handoff: { from: 1, kind: 'date', scope: 'each-item', to: { entryId: 'calendar.events', slot: 'range' } } };
    expect(check(each, '메일에 나온 날짜로 일정 확인해줘')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    expect(check(each, '메일마다 나온 날짜로 일정 확인해줘').ok).toBe(true);
    expect(check(each, 'for every mail check the calendar on its date').ok).toBe(true);
    // The introductory distributive phrase joins the clause after its comma (an each-item form only).
    const keyword = { steps: [{ entryId: 'calendar.events', args: { range: 'today', timedOnly: true } }], ambiguity: 'CLEAR', handoff: { from: 1, kind: 'titleKeyword', scope: 'each-item', to: { entryId: 'confluence.search', slot: 'keyword' }, consent: 'batch-preview' } };
    expect(check(keyword, 'for each meeting today, find the confluence page about it').ok).toBe(true);
    expect(check(keyword, 'meetings today, find the confluence page about it')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    // A negated clause grounds nothing.
    expect(check(MAIL_TO_CALENDAR, '메일 보여줘, 일정은 보지마')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
    expect(check(MAIL_TO_CALENDAR, '메일에 나온 날짜로 일정 확인하지 마')).toMatchObject({ ok: false, reason: 'handoff-ungrounded' });
  });

  it('an over-bound plan never bypasses rule 8: no bounded suggestion for an invalid or valid handoff', () => {
    const five = Array.from({ length: 5 }, () => ({ entryId: 'mail.list', args: {} }));
    expect(check(withHandoff({ kind: 'secret' }, five), '메일 보여줘')).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    expect(check(withHandoff({}, five), TEXT)).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    // Without a handoff the same plan is still the bounded ask.
    expect(check({ steps: five, ambiguity: 'CLEAR' }, '메일 보여줘')).toMatchObject({ ok: true, plan: { kind: 'ask' } });
  });

  it('a handoff never rides on a reference, a non-listing source, the destination as its own source, or a non-DM turn', () => {
    const ref = [{ entryId: 'jira.issues', args: {} }, { entryId: 'jira.issues', args: {}, ref: { step: 1, field: 'issueKeys', take: 2 } }];
    expect(check(withHandoff({}, ref), '지라 이슈 보여주고 메일 일정')).toMatchObject({ ok: false, reason: 'handoff-invalid' });
    expect(check(withHandoff({}, [{ entryId: 'todo.list', args: {} }]), '할 일 보고 일정 확인해줘')).toMatchObject({ ok: false, reason: 'handoff-source' });
    expect(check(withHandoff({ from: 2 }), TEXT)).toMatchObject({ ok: false, reason: 'handoff-source' });
    expect(check(withHandoff({ to: { entryId: 'mail.list', slot: 'from' }, kind: 'email' }), '메일에서 메일 보낸 사람 봐줘')).toMatchObject({ ok: false, reason: 'handoff-slot' });
    expect(check(MAIL_TO_CALENDAR, TEXT, { direct: false })).toMatchObject({ ok: false, reason: 'not-dm' });
  });

  it('the source number follows Core\'s normalized order (a summary moves after the read it covers)', () => {
    // Planner order: mail, calendar, summary of the mail. Core's order: mail, summary, calendar: the calendar is step 3.
    const got = check(
      { steps: [{ entryId: 'mail.list', args: {} }, { entryId: 'calendar.events', args: { range: 'this-week' } }, { summarize: [1], schema: 'digest.v1' }], ambiguity: 'CLEAR', handoff: { from: 2, kind: 'attendee', scope: 'one-item', item: 'owner-pick', to: { entryId: 'mail.list', slot: 'from' } } },
      // Round 2: the former text ("메일 요약하고 ... 보여줘") is two predicates joined by the -고 connective, genuinely two requests:
      // the strict one-unit rule refuses it. This one is one request form (보여줘) naming the three entries.
      '이번 주 일정에 나온 사람들 메일 요약해서 보여줘',
    );
    expect(got.ok && got.plan.kind === 'handoff' ? got.plan.handoff.from : undefined).toBe(3);
    expect(got.ok && got.plan.kind === 'handoff' ? got.plan.steps[2]?.kind === 'read' && got.plan.steps[2].entry.id : undefined).toBe('calendar.events');
  });
});

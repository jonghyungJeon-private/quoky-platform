import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { parseAgentPlanOutput } from './plan-schema';
import { agentUncoveredClauses, validateAgentPlan } from './plan-validator';
import { AGENT_READ_WRITE_PROBE_PROMPT_VERSION, agentReadWriteProbeClauses, agentReadWriteProbePrompt, agentReadWriteProbeResult } from './read-write-probe';

// The owner-ratified amendment of 2026-10-26 to the trigger of the read + write note: an uncovered clause gets the note's
// one A6 selection; a write lying in that clause hands the turn to the read + write path.

const T0 = '2026-10-20T03:00:00.000Z';
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const ALL = [...READS, ...ACTIONS];
const OFFERED = new Map(ALL.map((entry) => [entry.id, entry] as const));
const CTX = { now: T0, timeZone: 'Asia/Seoul' };
const AP_N131 = '내일 일정 보여주고 내일 9시에 출발 알림 만들어줘';
const out = (entryId: string, args: Record<string, unknown> = {}, ambiguity = 'CLEAR'): string => JSON.stringify({ entryId, args, ambiguity, alternatives: [] });

function runPlan(text: string, steps: unknown[]) {
  const result = validateAgentPlan(parseAgentPlanOutput(JSON.stringify({ steps, ambiguity: 'CLEAR' }))!, { offered: new Map(READS.map((e) => [e.id, e] as const)), groundingText: text, now: T0, timeZone: 'Asia/Seoul', direct: true });
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

describe('the read + write probe (trigger amendment, owner-ratified 2026-10-26)', () => {
  it('ap-n131: the calendar read leaves the reminder clause uncovered; a clause naming a planned read is covered', () => {
    const plan = runPlan(AP_N131, [{ entryId: 'calendar.events', args: { range: 'tomorrow' } }]);
    expect(agentReadWriteProbeClauses(plan, AP_N131)).toEqual(['내일 9시에 출발 알림 만들어줘']);
    expect(agentReadWriteProbeClauses(runPlan('내일 일정 보여줘', [{ entryId: 'calendar.events', args: { range: 'tomorrow' } }]), '내일 일정 보여줘')).toEqual([]);
    const both = runPlan('알림 목록이랑 내일 일정 보여줘', [{ entryId: 'reminder.list', args: {} }, { entryId: 'calendar.events', args: { range: 'tomorrow' } }]);
    expect(agentReadWriteProbeClauses(both, '알림 목록이랑 내일 일정 보여줘')).toEqual([]);
    if (plan.kind !== 'run') throw new Error('run');
    expect(agentUncoveredClauses(plan.steps, AP_N131)).toHaveLength(1);
  });

  it('a write whose spans lie in the uncovered clause hands the turn over (write)', () => {
    expect(agentReadWriteProbeResult(out('reminder.create', { when: '내일 9시', body: '출발' }), ['내일 9시에 출발 알림 만들어줘'], OFFERED, CTX)).toEqual({ kind: 'write', entryId: 'reminder.create', clause: '내일 9시에 출발 알림 만들어줘' });
  });

  it('none, a read, or a malformed answer leaves the read plan standing', () => {
    const clause = ['내일 9시에 출발 알림 만들어줘'];
    // Closed, content-free diagnostics (gate report).
    expect(agentReadWriteProbeResult(out('none'), clause, OFFERED, CTX)).toEqual({ kind: 'stands', detail: 'none' });
    expect(agentReadWriteProbeResult(out('calendar.events', { range: 'tomorrow' }), clause, OFFERED, CTX)).toEqual({ kind: 'stands', detail: 'not-action' });
    expect(agentReadWriteProbeResult('not json', clause, OFFERED, CTX)).toEqual({ kind: 'stands', detail: 'malformed' });
  });

  it('CA W2: a requested write with a read-clause word, a missing detail or the selector\'s doubt is the A6 clarification, never written or dropped', () => {
    const clause = ['내일 9시에 출발 알림 만들어줘'];
    // "일정" is a word of the read clause: never the payload; the clause names the reminder, so the owner is asked.
    expect(agentReadWriteProbeResult(out('reminder.create', { when: '내일 9시', body: '일정' }), clause, OFFERED, CTX)).toEqual({ kind: 'clarify', entryId: 'reminder.create', clause: clause[0] });
    expect(agentReadWriteProbeResult(out('reminder.create', { when: '내일 9시', body: '출발' }, 'NEEDS_CLARIFICATION'), clause, OFFERED, CTX)).toMatchObject({ kind: 'clarify' });
    // Red team rt-s2rw-007 / -024: no title, no time.
    expect(agentReadWriteProbeResult(out('todo.add', {}), ['할 일 추가해줘'], OFFERED, CTX)).toMatchObject({ kind: 'clarify', entryId: 'todo.add' });
    expect(agentReadWriteProbeResult(out('reminder.create', { body: '운동' }), ['운동 알림 추가해줘'], OFFERED, CTX)).toMatchObject({ kind: 'clarify', entryId: 'reminder.create' });
    // A clause that neither names the entry nor is claimed by a write grammar is no request: the plan stands.
    expect(agentReadWriteProbeResult(out('todo.add', {}), ['고마워'], OFFERED, CTX)).toEqual({ kind: 'stands', detail: 'invalid:missing-arg' });
  });

  it('CA W1: a payload that points back is never written (note): a determiner span or a deictic-only payload', () => {
    expect(agentReadWriteProbeResult(out('reminder.create', { when: '3시', body: '그 첫 회의 제목' }), ['그 첫 회의 제목으로 3시에 알림 만들어줘'], OFFERED, CTX)).toMatchObject({ kind: 'note', entryId: 'reminder.create' });
    expect(agentReadWriteProbeResult(out('todo.add', { title: '그 내용' }), ['그 내용 할 일에 넣어줘'], OFFERED, CTX)).toMatchObject({ kind: 'note', entryId: 'todo.add' });
    expect(agentReadWriteProbeResult(out('todo.add', { title: '그거' }), ['그거 할 일로 추가해줘'], OFFERED, CTX)).toMatchObject({ kind: 'note' });
  });

  it('Codex P2 / gate on 5c09fee4: item.summarize is never a write; with a list reference in a clause naming it, it is decision (f)\'s note (itemRead)', () => {
    expect(agentReadWriteProbeResult(out('item.summarize', { source: 'mail', ref: '#2' }), ['두 번째 메일 요약해줘'], OFFERED, CTX)).toEqual({ kind: 'note', entryId: 'item.summarize', clause: '두 번째 메일 요약해줘', itemRead: true });
    expect(agentReadWriteProbeResult(out('item.summarize', { source: 'jira', ref: '#2' }), ['summarize the second one'], OFFERED, CTX)).toMatchObject({ kind: 'note', itemRead: true });
    // No reference: no note, the plan stands.
    expect(agentReadWriteProbeResult(out('item.summarize', { source: 'mail' }), ['요약해줘'], OFFERED, CTX)).toEqual({ kind: 'stands', detail: 'not-write' });
  });

  it('gate on 5c09fee4: a multi-word alias covers its clause ("할 일 목록 보여줘" with todo.list planned is no uncovered clause)', () => {
    const plan = runPlan('할 일 목록 보여주고 장보기 추가해줘', [{ entryId: 'todo.list', args: {} }]);
    expect(agentReadWriteProbeClauses(plan, '할 일 목록 보여주고 장보기 추가해줘')).toEqual(['장보기 추가해줘']);
    const both = runPlan('드라이브 최근 파일이랑 메일함이랑 할 일 목록 보여줘', [{ entryId: 'drive.files', args: {} }, { entryId: 'mail.list', args: {} }, { entryId: 'todo.list', args: {} }]);
    expect(agentReadWriteProbeClauses(both, '드라이브 최근 파일이랑 메일함이랑 할 일 목록 보여줘')).toEqual([]);
  });

  it('Codex P2: canonical-equivalent outputs never differ — a quoted determiner payload is a note like the unquoted one', () => {
    const clause = ['그 첫 회의 제목으로 3시에 알림 만들어줘'];
    for (const body of ['그 첫 회의 제목', '"그 첫 회의 제목"', '「그 첫 회의 제목」']) {
      expect(agentReadWriteProbeResult(out('reminder.create', { when: '3시', body }), clause, OFFERED, CTX), body).toMatchObject({ kind: 'note', entryId: 'reminder.create' });
    }
  });

  it('Codex P2: references come before clarifications — a pointing-back payload with a missing time is a note, not a question', () => {
    expect(agentReadWriteProbeResult(out('reminder.create', { body: '그 첫 회의 제목' }), ['그 첫 회의 제목으로 알림 만들어줘'], OFFERED, CTX)).toMatchObject({ kind: 'note' });
    expect(agentReadWriteProbeResult(out('reminder.create', { body: '그 첫 회의 제목' }, 'NEEDS_CLARIFICATION'), ['그 첫 회의 제목으로 알림 만들어줘'], OFFERED, CTX)).toMatchObject({ kind: 'note' });
    // A quoted list reference is a reference too.
    expect(agentReadWriteProbeResult(out('todo.cancel', { ref: '"#2"' }), ['두 번째 거 취소해줘'], OFFERED, CTX)).toMatchObject({ kind: 'note', entryId: 'todo.cancel' });
    // The reminder's own time span is no payload: a plain write stays a write.
    expect(agentReadWriteProbeResult(out('reminder.create', { when: '내일 9시', body: '"출발"' }), ['내일 9시에 출발 알림 만들어줘'], OFFERED, CTX)).toMatchObject({ kind: 'write' });
  });

  it('a write with a list or deictic reference is not run: the read sections and the decision (f) note (note)', () => {
    expect(agentReadWriteProbeResult(out('todo.cancel', { ref: '#2' }), ['두 번째 거 취소해줘'], OFFERED, CTX)).toMatchObject({ kind: 'note', entryId: 'todo.cancel' });
  });

  it('the probe prompt is the deployed A6 selection prompt with the action entries offered', () => {
    expect(AGENT_READ_WRITE_PROBE_PROMPT_VERSION).toBe('nl-select.v65');
    const prompt = agentReadWriteProbePrompt({ entries: ALL, clauses: ['내일 9시에 출발 알림 만들어줘'] });
    expect(prompt).toContain('reminder.create');
    expect(prompt).toContain('Reference context');
    // CA W2: only the uncovered clause is in the prompt; the read clause's words never are.
    expect(prompt).toContain('내일 9시에 출발 알림 만들어줘');
    expect(prompt).not.toContain('내일 일정 보여주고');
  });
});

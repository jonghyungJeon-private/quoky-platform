import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import type { AgentPlan, AgentPlanStep } from './plan-schema';
import { validateAgentPlan, type AgentPlanValidationContext } from './plan-validator';
import { a6InPlanGuidance, agentReplyNotes, renderA6InPlanNote, renderRefDetailCapNote, renderRelatedUncheckedNote, type AgentStepsPlan } from './reply-notes';

// ADR-0121 S2 P3: the fixed reply notes — the detail cap ("N개 중 10개" + the next-10 hint, owner decision (c) / A1
// answer 8), the relation note (owner decision (a)) and the action-in-plan guidance (decision (f)). Fixed text, closed
// nouns and Core's counts only.

const T0 = '2026-10-20T03:00:00.000Z';
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);

function ctx(groundingText: string): AgentPlanValidationContext {
  return { offered: new Map(READS.map((entry) => [entry.id, entry] as const)), groundingText, now: T0, timeZone: 'Asia/Seoul', direct: true };
}
const read = (entryId: string, args: Record<string, string | number | boolean> = {}, ref?: { step: number; field: string; take: number }): AgentPlanStep => ({
  kind: 'read',
  entryId,
  args,
  ...(ref !== undefined ? { ref } : {}),
});
const summary = (from: number[], schema = 'digest.v1'): AgentPlanStep => ({ kind: 'summarize', from, schema });
const plan = (steps: AgentPlanStep[], related = false): AgentPlan => ({ kind: 'steps', form: 'steps', steps, ambiguity: 'CLEAR', alternatives: [], ...(related ? { related: true as const } : {}) });

function runPlan(value: AgentPlan, text: string): AgentStepsPlan {
  const result = validateAgentPlan(value, ctx(text));
  if (!result.ok || result.plan.kind !== 'run') throw new Error(`expected a run plan: ${JSON.stringify(result)}`);
  return result.plan;
}

describe('the detail cap note (owner decision (c), A1 answer 8)', () => {
  it('says "N개 중 10개" and the fixed next-10 hint when the full 10 were read and the listing held more', () => {
    expect(renderRefDetailCapNote({ listed: 23, take: 10, shown: 10 }, 'ko')).toBe("이슈 23개 중 10개만 자세히 보여드렸어요. 더 보려면 '다음 10개 보여줘'라고 말씀해 주세요.");
    expect(renderRefDetailCapNote({ listed: 20, listedAtLeast: true, take: 10, shown: 10 }, 'ko')).toBe("이슈 20개 이상 중 10개만 자세히 보여드렸어요. 더 보려면 '다음 10개 보여줘'라고 말씀해 주세요.");
    expect(renderRefDetailCapNote({ listed: 23, take: 10, shown: 9 }, 'en')).toBe('Showing 9 of 23 issues in detail. To see more, say "show the next 10".');
  });

  it('says nothing for a complete listing of 10 or fewer, or for the owner\'s own smaller number', () => {
    expect(renderRefDetailCapNote({ listed: 10, take: 10, shown: 10 }, 'ko')).toBeUndefined();
    expect(renderRefDetailCapNote({ listed: 4, take: 10, shown: 4 }, 'ko')).toBeUndefined();
    expect(renderRefDetailCapNote({ listed: 30, take: 3, shown: 3 }, 'ko')).toBeUndefined();
  });
});

describe('the relation note (owner decision (a))', () => {
  it('is the recorded text for a calendar read, with the right particle for other sources', () => {
    expect(renderRelatedUncheckedNote('calendar.events', 'ko')).toBe('회의와 관련 있는지는 확인하지 않았어요.');
    expect(renderRelatedUncheckedNote('mail.list', 'ko')).toBe('메일과 관련 있는지는 확인하지 않았어요.');
    expect(renderRelatedUncheckedNote('jira.issues', 'ko')).toBe('지라 이슈와 관련 있는지는 확인하지 않았어요.');
    expect(renderRelatedUncheckedNote('calendar.events', 'en')).toBe("I didn't check whether these are related to the meetings; each was read on its own.");
  });
});

describe('agentReplyNotes (one executed run)', () => {
  const RELEASE = '1.2.0 릴리스 이슈들 상세도 같이 보여줘';

  it('a reference step gets the cap note from Core\'s counts (the listing of its source step, the bulk read of its own)', () => {
    const run = runPlan(plan([read('jira.release', { release: '1.2.0' }), read('jira.issues', {}, { step: 1, field: 'issueKeys', take: 10 })]), RELEASE);
    expect(agentReplyNotes(run, new Map([[1, { listed: 17 }], [2, { shown: 10 }]]), 'ko')).toEqual(["이슈 17개 중 10개만 자세히 보여드렸어요. 더 보려면 '다음 10개 보여줘'라고 말씀해 주세요."]);
    expect(agentReplyNotes(run, new Map([[1, { listed: 8 }], [2, { shown: 8 }]]), 'ko')).toEqual([]);
    // No counts (a failed step): no note, never a guess.
    expect(agentReplyNotes(run, new Map(), 'ko')).toEqual([]);
  });

  it('the relation note comes last, naming the first read\'s source; it needs the validated flag', () => {
    const text = '이번 주 회의 정리하고 관련 jira 이슈도 같이';
    const steps = [read('calendar.events', { range: 'this-week', timedOnly: true }), summary([1], 'meeting-digest.v1'), read('jira.issues')];
    expect(agentReplyNotes(runPlan(plan(steps, true), text), new Map(), 'ko')).toEqual(['회의와 관련 있는지는 확인하지 않았어요.']);
    expect(agentReplyNotes(runPlan(plan(steps), text), new Map(), 'ko')).toEqual([]);
  });
});

describe('the action-in-plan guidance (decision (f))', () => {
  it('a list plus one item\'s summary: item-read, the list as the remainder, the number hint', () => {
    const guidance = a6InPlanGuidance(plan([read('jira.issues'), read('item.summarize', { ref: '#1' })]), ctx('지라 이슈 보여주고 첫 번째 거 요약해줘'), 'ko');
    expect(guidance?.kind).toBe('item-read');
    expect(guidance?.remainder?.steps.map((step) => (step.kind === 'read' ? step.entry.id : 'summarize'))).toEqual(['jira.issues']);
    expect(guidance?.note).toBe("한 항목 요약은 목록을 보신 뒤 번호로 말씀해 주세요. 예: '1번 요약해줘'");
  });

  it('a write with reads: action, the reads (summaries over removed steps dropped, refs renumbered) as the remainder', () => {
    const steps = [read('todo.list'), read('todo.add', { title: '장보기' }), read('jira.release', { release: '1.2.0' }), read('jira.issues', {}, { step: 3, field: 'issueKeys', take: 2 }), summary([2, 4])];
    const guidance = a6InPlanGuidance(plan(steps), ctx('할 일 보여주고 장보기 추가하고 1.2.0 릴리스 이슈 2개 자세히 정리해줘'), 'ko');
    expect(guidance?.kind).toBe('action');
    const remainder = guidance?.remainder?.steps ?? [];
    expect(remainder.map((step) => (step.kind === 'read' ? step.entry.id : 'summarize'))).toEqual(['todo.list', 'jira.release', 'jira.issues']);
    const ref = remainder[2];
    expect(ref?.kind === 'read' ? ref.ref?.step : undefined).toBe(2);
    expect(guidance?.note).toBe('추가·변경·취소 같은 작업은 조회와 함께 하지 않았어요. 따로 한 번 더 말씀해 주세요.');
  });

  it('only an a6-in-plan refusal gets guidance; no read left means no remainder', () => {
    expect(a6InPlanGuidance(plan([read('jira.issues'), read('mail.list')]), ctx('지라 이슈랑 메일'), 'ko')).toBeUndefined();
    expect(a6InPlanGuidance(plan([read('help.topic'), read('jira.issues')]), ctx('도움말이랑 지라'), 'ko')).toBeUndefined();
    const onlyActions = a6InPlanGuidance(plan([read('todo.add', { title: 'a' }), read('action.undo')]), ctx('a 추가하고 되돌려줘'), 'en');
    expect(onlyActions).toEqual({ kind: 'action', note: renderA6InPlanNote('action', 'en') });
  });

  it('every note is fixed text: no owner word reaches it', () => {
    const owner = '비밀프로젝트 장보기 첫 번째';
    const guidance = a6InPlanGuidance(plan([read('todo.list'), read('todo.add', { title: '장보기' })]), ctx(`할 일 보여주고 ${owner} 추가해줘`), 'ko');
    for (const note of [guidance?.note ?? '', renderA6InPlanNote('item-read', 'ko'), renderRelatedUncheckedNote('drive.files', 'ko')]) {
      for (const word of owner.split(' ')) expect(note).not.toContain(word);
    }
  });
});

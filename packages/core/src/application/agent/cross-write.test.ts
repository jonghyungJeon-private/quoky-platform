import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import {
  WORK_CHAT_CHANNEL_NOUNS,
  WORK_CHAT_COMMENT_NOUNS,
  WORK_CHAT_COMMENT_VERBS,
  WORK_CHAT_ISSUE_NOUNS,
  WORK_CHAT_POST_NOUNS,
  WORK_CHAT_POST_VERBS,
  WORK_CHAT_REQUEST_ENDING_FORMS,
  detectWorkChatCommand,
} from '../work-chat/work-chat-command';
import { ConnectorWriteOperation } from '../../ports';
import {
  A7_POINT_BACK_DETERMINERS,
  AGENT_A7_TARGETS,
  analyseCrossWriteLiterals,
  checkCrossWriteDestination,
  crossWriteNouns,
  routeCrossWrite,
  type AgentCrossWriteContext,
  type CrossWriteDestinationPort,
} from './cross-write';
import { agentPlanParseFailure, parseAgentPlanOutput } from './plan-schema';
import { validateAgentPlan, type AgentPlanValidationContext } from './plan-validator';

// ADR-0121 amendment A7, slice A7-S1 (plan-form): the `propose` step and `payload-draft.v1` of the plan schema, rule 9 of the
// validator, the A7.4a role rule, the destination-span exclusion, the A7.5 step 0 routing precedence and the pre-read
// destination check. Structure only; nothing here reads, drafts, cards or sends, and a validated A7 plan is never runnable.

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const OFFERED = new Map([...READS, ...ACTIONS].map((entry) => [entry.id, entry] as const));

export const CW: AgentCrossWriteContext = {
  active: { jira: true, slack: true, calendar: true },
  writers: { jira: true, slack: true, calendar: true },
  jiraProjects: ['BE'],
  slackChannels: ['quoky-test'],
  sources: ['slack.search', 'jira.issues', 'jira.release'],
};
const RECEIPT = { fresh: true, sourceEntryId: 'slack.search', items: 3, hostOnly: false, handoffBuilt: false } as const;

const ctx = (groundingText: string, crossWrite: AgentCrossWriteContext | null = CW): AgentPlanValidationContext => ({
  offered: OFFERED,
  groundingText,
  now: '2026-11-24T03:00:00.000Z',
  timeZone: 'Asia/Seoul',
  direct: true,
  ...(crossWrite !== null ? { crossWrite } : {}),
});

const DRAFT_A = { summarize: [1], schema: 'payload-draft.v1' };
const DRAFT_B = { summarize: [], schema: 'payload-draft.v1' };
const slackRead = (keyword: string) => ({ entryId: 'slack.search', args: { keyword } });
const formA = (keyword: string, propose: unknown) => ({ steps: [slackRead(keyword), DRAFT_A, propose], ambiguity: 'CLEAR' });
const formB = (propose: unknown) => ({ steps: [DRAFT_B, propose], ambiguity: 'CLEAR' });
const jira = (args: Record<string, unknown> = {}) => ({ propose: 'jira.comment.propose', args });
const slack = (args: Record<string, unknown> = {}) => ({ propose: 'slack.post.propose', args });
const calendar = (args: Record<string, unknown> = {}) => ({ propose: 'calendar.create.propose', args });

function check(body: unknown, text: string, crossWrite: AgentCrossWriteContext | null = CW) {
  const parsed = parseAgentPlanOutput(JSON.stringify(body));
  if (parsed === null || parsed.kind !== 'steps') throw new Error(`does not parse: ${JSON.stringify(body)}`);
  return validateAgentPlan(parsed, ctx(text, crossWrite));
}
const withReceipt = { ...CW, receipt: RECEIPT };

describe('plan schema: propose step and payload-draft.v1 (parse)', () => {
  it('holds a trailing propose step beside the steps and keeps the steps exactly as before', () => {
    const parsed = parseAgentPlanOutput(JSON.stringify(formA('릴리즈', jira({ issueKey: 'BE-123' }))));
    expect(parsed).toMatchObject({ kind: 'steps', form: 'steps', propose: { target: 'jira.comment.propose', args: { issueKey: 'BE-123' } } });
    expect(parsed?.kind === 'steps' ? parsed.steps.map((step) => step.kind) : []).toEqual(['read', 'summarize']);
  });

  it('accepts an empty summarize source list for payload-draft.v1 only', () => {
    expect(parseAgentPlanOutput(JSON.stringify(formB(jira())))).not.toBeNull();
    expect(parseAgentPlanOutput(JSON.stringify({ steps: [{ summarize: [], schema: 'digest.v1' }, jira()], ambiguity: 'CLEAR' }))).toBeNull();
  });

  it('rejects a propose step that is not last, a second one, an unknown key and a malformed target (strict and total)', () => {
    const bad = [
      { steps: [slackRead('x'), jira(), DRAFT_A], ambiguity: 'CLEAR' },
      { steps: [slackRead('x'), DRAFT_A, jira(), jira()], ambiguity: 'CLEAR' },
      { steps: [slackRead('x'), DRAFT_A, { propose: 'jira.comment.propose', args: {}, payload: 'text' }], ambiguity: 'CLEAR' },
      { steps: [slackRead('x'), DRAFT_A, { propose: 'Jira Comment', args: {} }], ambiguity: 'CLEAR' },
      { steps: [jira()], ambiguity: 'CLEAR' },
    ];
    for (const body of bad) expect(parseAgentPlanOutput(JSON.stringify(body))).toBeNull();
    expect(agentPlanParseFailure(JSON.stringify(bad[0]))).toBe('bad-step');
  });
});

describe('plan validator rule 9: a validated A7 plan (form a)', () => {
  it('validates a Slack-sourced Jira comment to a cross-write plan: the destination is the marked literal of the owner\'s words', () => {
    const got = check(formA('릴리즈', jira({ issueKey: 'BE-123' })), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘');
    expect(got).toMatchObject({ ok: true, plan: { kind: 'cross-write', form: 'a', target: 'jira.comment.propose', operation: 'ISSUE_COMMENT', destination: { state: 'named', kind: 'jira', issueKey: 'BE-123', project: 'BE' } } });
    if (got.ok && got.plan.kind === 'cross-write') {
      expect(got.plan.source?.entry.id).toBe('slack.search');
      expect(got.plan.connectorCalls).toBe(1);
    }
  });

  it('validates a Slack post to an allowlisted channel, with the particle on a catalog noun between', () => {
    for (const text of ['슬랙 릴리즈 대화 요약해서 #quoky-test에 올려줘', '슬랙 릴리즈 대화 요약해서 #quoky-test 채널에 올려줘']) {
      expect(check(formA('릴리즈', slack({ channel: 'quoky-test' })), text)).toMatchObject({ ok: true, plan: { kind: 'cross-write', destination: { state: 'named', kind: 'slack', channel: 'quoky-test' } } });
    }
  });

  it('accepts the English `to` marker with a write verb before it', () => {
    expect(check(formA('release', jira({ issueKey: 'BE-123' })), 'summarize the slack release thread and add a comment to the BE-123 ticket')).toMatchObject({ ok: true, plan: { destination: { state: 'named', issueKey: 'BE-123' } } });
    expect(check(formA('release', slack({ channel: '#quoky-test' })), 'summarize the slack release thread and post it to #quoky-test')).toMatchObject({ ok: true, plan: { destination: { state: 'named', channel: 'quoky-test' } } });
  });

  it('the planner may not write a payload: a payload-shaped arg name is refused as not the closed shape', () => {
    for (const args of [{ issueKey: 'BE-123', text: '확인했습니다' }, { issueKey: 'BE-123', body: 'x' }, { issueKey: 'BE-123', payload: 'x' }, { issueKey: 'BE-123', summary: 'x' }]) {
      expect(check(formA('릴리즈', jira(args)), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    }
  });

  it('refuses the source read of a non-A7 source, a ref step and a read the validator refuses (ADR-0120 D4)', () => {
    const mail = { steps: [{ entryId: 'mail.list', args: {} }, DRAFT_A, jira({ issueKey: 'BE-123' })], ambiguity: 'CLEAR' };
    expect(check(mail, '메일 요약해서 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-source', step: 1 });
    // The keyword is not in the owner's words: the read fails ADR-0120 D4 grounding.
    expect(check(formA('배포', jira({ issueKey: 'BE-123' })), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'step-invalid' });
    // A source switched off.
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-123' })), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘', { ...CW, sources: ['jira.issues'] })).toMatchObject({ ok: false, reason: 'cross-write-source' });
  });

  it('refuses a plan that is not the closed shape: two reads, no draft step, a wrong summary source, a handoff, NEEDS_CLARIFICATION', () => {
    const text = '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘';
    const p = jira({ issueKey: 'BE-123' });
    expect(check({ steps: [slackRead('릴리즈'), slackRead('릴리즈'), DRAFT_A, p], ambiguity: 'CLEAR' }, text)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    expect(check({ steps: [slackRead('릴리즈'), { summarize: [1], schema: 'digest.v1' }, p], ambiguity: 'CLEAR' }, text)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    expect(check({ steps: [slackRead('릴리즈'), { summarize: [2], schema: 'payload-draft.v1' }, p], ambiguity: 'CLEAR' }, text)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    expect(check({ ...formA('릴리즈', p), ambiguity: 'NEEDS_CLARIFICATION' }, text)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    expect(check({ ...formA('릴리즈', p), related: 1 }, text)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    // payload-draft.v1 without a propose step is never a run.
    expect(check({ steps: [slackRead('릴리즈'), DRAFT_A], ambiguity: 'CLEAR' }, text)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
  });

  it('refuses an unknown propose target, a writer that is off and a kind that is not active', () => {
    const text = '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘';
    expect(check(formA('릴리즈', { propose: 'jira.transition.propose', args: { issueKey: 'BE-123' } }), text)).toMatchObject({ ok: false, reason: 'cross-write-target' });
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-123' })), text, { ...CW, writers: { ...CW.writers, jira: false } })).toMatchObject({ ok: false, reason: 'cross-write-writer' });
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-123' })), text, { ...CW, active: { ...CW.active, jira: false } })).toMatchObject({ ok: false, reason: 'cross-write-off' });
  });

  it('with A7 off (no context) every A7 plan is refused cross-write-off and no read-plan rule sees it', () => {
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-123' })), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘', null)).toMatchObject({ ok: false, reason: 'cross-write-off' });
    expect(check(formB(jira({ issueKey: 'BE-123' })), '요약해서 BE-123에 달아줘', null)).toMatchObject({ ok: false, reason: 'cross-write-off' });
  });

});

describe('destination grounding and the A7.4a role rule', () => {
  const text = (s: string) => s;
  it('refuses a destination the planner wrote that is not in the owner\'s words, and one off the allowlist', () => {
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-999' })), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-ungrounded' });
    expect(check(formA('릴리즈', jira({ issueKey: 'ZZ-5' })), '슬랙 릴리즈 대화 요약해서 ZZ-5에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-not-allowed' });
    expect(check(formA('릴리즈', slack({ channel: 'random' })), '슬랙 릴리즈 대화 요약해서 #random에 올려줘')).toMatchObject({ ok: false, reason: 'cross-write-not-allowed' });
  });

  it('a destination only in quoted text is not grounded (the grounding text is the non-quoted text)', () => {
    // `groundingText` is the owner's non-quoted text: the key is absent from it.
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-123' })), '슬랙 릴리즈 대화 요약해서 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-ungrounded' });
  });

  it('the planner role must equal the rule\'s role: the source literal as the destination is refused, never corrected', () => {
    expect(check({ steps: [{ entryId: 'jira.issues', args: { keyword: 'BE-12' } }, DRAFT_A, jira({ issueKey: 'BE-12' })], ambiguity: 'CLEAR' }, 'BE-12 댓글 요약해서 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-role' });
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-123', project: 'BE' })), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-role' });
    // The planner leaves a marked destination out: not the rule's role either.
    expect(check(formA('릴리즈', jira()), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-role' });
  });

  it('two literals of one kind: the marked one is the destination, the other can only be a source (both kinds, both orders)', () => {
    expect(check({ steps: [{ entryId: 'jira.issues', args: { keyword: 'BE-12' } }, DRAFT_A, jira({ issueKey: 'BE-123' })], ambiguity: 'CLEAR' }, 'BE-12 댓글 요약해서 BE-123에 달아줘')).toMatchObject({ ok: true, plan: { destination: { state: 'named', issueKey: 'BE-123' } } });
    expect(analyseCrossWriteLiterals('BE-123에 BE-12 요약해서 달아줘', CW, crossWriteNouns(OFFERED)).marked).toEqual([]);
    expect(analyseCrossWriteLiterals('BE-12 요약해서 BE-123 티켓에 달아줘', CW, crossWriteNouns(OFFERED)).marked.map((l) => l.value)).toEqual(['BE-123']);
    expect(analyseCrossWriteLiterals('BE-12로 인한 장애 요약해서 BE-123 티켓에 달아줘', CW, crossWriteNouns(OFFERED)).marked.map((l) => l.value)).toEqual(['BE-123']);
  });

  it('never marks by 에서, 로, 으로 or English on / in', () => {
    const nouns = crossWriteNouns(OFFERED);
    for (const t of ['BE-12에서 가져와서 BE-123으로 올려줘', 'BE-123으로 달아줘', 'BE-123에서 달아줘', 'summarize the slack thread and add a comment on BE-123', 'post the summary in #quoky-test']) {
      expect(analyseCrossWriteLiterals(t, CW, nouns).marked, t).toEqual([]);
    }
  });

  it('no literal marked: two literals ask with the readings (at most 2), one unmarked literal asks to restate, nothing is read', () => {
    const two = check({ steps: [{ entryId: 'jira.issues', args: { keyword: 'BE-12' } }, DRAFT_A, jira()], ambiguity: 'CLEAR' }, 'BE-12에서 가져와서 BE-123으로 올려줘');
    expect(two).toMatchObject({ ok: true, plan: { kind: 'cross-write', destination: { state: 'ask-readings', readings: [{ source: 'BE-12', destination: 'BE-123' }, { source: 'BE-123', destination: 'BE-12' }] } } });
    const one = check(formA('quoky-test', slack()), '#quoky-test 요약해서 올려줘');
    expect(one).toMatchObject({ ok: true, plan: { destination: { state: 'ask-restate' } } });
  });

  it('a kind mismatch asks: a Slack channel marked for a Jira comment is no destination of that operation', () => {
    const got = check(formA('릴리즈', jira()), '슬랙 릴리즈 대화 요약해서 #quoky-test에 올려줘');
    expect(got).toMatchObject({ ok: true, plan: { destination: { state: 'ask-restate' } } });
  });

  it('more than one write in one request is never covered', () => {
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-123' })), '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘 #quoky-test에 올려줘')).toMatchObject({ ok: false, reason: 'cross-write-writes' });
  });

  it('a kind named with no instance: the single allowlisted project skips the project question (a7-09)', () => {
    expect(check(formA('릴리즈', jira()), '슬랙 릴리즈 대화 요약해서 지라 티켓에 달아줘')).toMatchObject({ ok: true, plan: { destination: { state: 'pick-ticket', kind: 'jira', project: 'BE' } } });
  });

  it('a kind named with two projects allowlisted asks the project first; a named project skips that question (a7-09)', () => {
    const two = { ...CW, jiraProjects: ['BE', 'FE'] };
    expect(check(formA('릴리즈', jira()), '슬랙 릴리즈 대화 요약해서 지라 티켓에 달아줘', two)).toMatchObject({ ok: true, plan: { destination: { state: 'pick-project', projects: ['BE', 'FE'] } } });
    expect(check(formA('릴리즈', jira({ project: 'FE' })), '슬랙 릴리즈 대화 요약해서 FE 티켓에 달아줘', two)).toMatchObject({ ok: true, plan: { destination: { state: 'pick-ticket', project: 'FE' } } });
    expect(check(formA('릴리즈', jira({ project: 'FE' })), '슬랙 릴리즈 대화 요약해서 지라 티켓에 달아줘', two)).toMatchObject({ ok: false, reason: 'cross-write-ungrounded' });
  });

  it('a Slack kind named with no instance lists the allowlisted channels; no destination at all asks where', () => {
        expect(check({ steps: [{ entryId: 'jira.issues', args: {} }, DRAFT_A, slack()], ambiguity: 'CLEAR' }, '지라 이슈 요약해서 슬랙 채널에 올려줘')).toMatchObject({ ok: true, plan: { destination: { state: 'pick-channel', channels: ['quoky-test'] } } });
    expect(check({ steps: [{ entryId: 'jira.issues', args: {} }, DRAFT_A, slack()], ambiguity: 'CLEAR' }, '지라 이슈 요약해서 올려줘')).toMatchObject({ ok: true, plan: { destination: { state: 'missing', kind: 'slack' } } });
  });
  void text;
});

describe('form b: the held receipt, and the destination-span exclusion', () => {
  it('binds only with a fresh, usable, content-free receipt of an A7 source that is on', () => {
    const body = formB(jira({ issueKey: 'BE-123' }));
    const t = '해당 내용 요약해서 BE-123에 달아줘';
    expect(check(body, t, withReceipt)).toMatchObject({ ok: true, plan: { kind: 'cross-write', form: 'b', connectorCalls: 0, destination: { state: 'named', issueKey: 'BE-123' } } });
    for (const receipt of [undefined, { ...RECEIPT, fresh: false }, { ...RECEIPT, items: 0 }, { ...RECEIPT, items: 11 }, { ...RECEIPT, hostOnly: true }, { ...RECEIPT, handoffBuilt: true }, { ...RECEIPT, sourceEntryId: 'mail.list' }, { ...RECEIPT, sourceEntryId: 'jira.release' }]) {
      const context = receipt === undefined ? CW : { ...CW, ...(receipt.sourceEntryId === 'jira.release' ? { sources: ['slack.search'] } : {}), receipt };
      expect(check(body, t, context), JSON.stringify(receipt)).toMatchObject({ ok: false, reason: 'cross-write-receipt' });
    }
  });

  it('the source-name check skips the destination span: "지라 BE-123에" names no source', () => {
    expect(check(formB(jira({ issueKey: 'BE-123' })), '해당 내용 요약해서 지라 BE-123에 달아줘', withReceipt)).toMatchObject({ ok: true });
    expect(check(formB(jira({ issueKey: 'BE-123' })), '해당 내용 요약해서 지라 BE-123 티켓에 달아줘', withReceipt)).toMatchObject({ ok: true });
  });

  it('a name of the held source still binds; a different source is form (a) over that source, so a no-read plan is refused', () => {
    expect(check(formB(jira({ issueKey: 'BE-123' })), '슬랙 내용 요약해서 BE-123에 달아줘', withReceipt)).toMatchObject({ ok: true });
    expect(check(formB(jira({ issueKey: 'BE-123' })), '지라 이슈 내용 요약해서 BE-123에 달아줘', withReceipt)).toMatchObject({ ok: false, reason: 'cross-write-new-source' });
  });
});

describe('calendar propose: the title and the time are the owner\'s own spans (A7.3)', () => {
  const text = '슬랙 릴리즈 대화 요약해서 내일 오후 3시에 배포 점검 일정 만들어줘';
  it('validates verbatim spans, and lists a missing one for the existing clarification', () => {
    expect(check(formA('릴리즈', calendar({ title: '배포 점검', when: '내일 오후 3시' })), text)).toMatchObject({ ok: true, plan: { destination: { state: 'primary-calendar' }, calendar: { title: '배포 점검', when: '내일 오후 3시', missing: [] } } });
    expect(check(formA('릴리즈', calendar({ title: '배포 점검' })), text)).toMatchObject({ ok: true, plan: { calendar: { title: '배포 점검', missing: ['when'] } } });
    expect(check(formA('릴리즈', calendar()), text)).toMatchObject({ ok: true, plan: { calendar: { missing: ['title', 'when'] } } });
  });
  it('refuses a span that is not the owner\'s words, a deictic title and a kind-marked destination', () => {
    expect(check(formA('릴리즈', calendar({ title: '배포 회의', when: '내일 오후 3시' })), text)).toMatchObject({ ok: false, reason: 'cross-write-span' });
    expect(check(formA('릴리즈', calendar({ title: '그 내용', when: '내일' })), '슬랙 릴리즈 요약해서 그 내용 내일 일정 만들어줘')).toMatchObject({ ok: false, reason: 'cross-write-span' });
    // A destination marked for another kind is not a calendar request.
    expect(check(formA('릴리즈', calendar({ title: '배포', when: '내일' })), '슬랙 릴리즈 요약해서 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-role' });
  });
});

describe('routing precedence (A7.5 step 0)', () => {
  const route = (groundingText: string, context: AgentCrossWriteContext | null | 'on' = 'on') => routeCrossWrite({ groundingText, context: context === 'on' ? CW : (context ?? undefined), offered: OFFERED });
  it('1. the ADR-0112 grammar with the owner\'s verbatim payload is first and unchanged, even for a summary-looking payload', () => {
    expect(route('Jira BE-123에 댓글: 슬랙 대화 요약해서 올림')).toEqual({ route: 'grammar' });
    expect(route('Slack #quoky-test에 게시: #dev 요약')).toEqual({ route: 'grammar' });
    expect(route('Jira BE-123에 댓글: 슬랙 대화 요약해서 올림', undefined)).toEqual({ route: 'grammar' });
  });
  it('2. R2a: a source name outside the destination span, a second literal, or a summary word on an object is an A7 plan', () => {
    for (const t of ['슬랙 대화 요약해서 BE-123에 달아줘', '#dev 대화 요약해서 #quoky-test에 올려줘', 'BE-12 댓글 요약해서 BE-123에 달아줘', '그 내용 요약해서 BE-123에 달아줘', '해당 내용 정리해서 #quoky-test에 올려줘']) {
      expect(route(t), t).toEqual({ route: 'a7', trigger: 'cross-source' });
    }
  });
  it('2. a summary word alone is no trigger: a literal post with a summary word stays ordinary (A6 as today)', () => {
    for (const t of ['#quoky-test에 회의 정리 끝났다고 올려줘', 'BE-123에 짧게 배포 완료 달아줘']) expect(route(t), t).toEqual({ route: 'ordinary' });
  });
  it('2. R2b: a bare follow-up goes to A7 only with a fresh receipt, a marked destination and no owner content', () => {
    expect(route('응 그리고 BE-123에 달아줘', withReceipt)).toEqual({ route: 'a7', trigger: 'receipt-followup' });
    expect(route('BE-124에도 달아줘', withReceipt)).toEqual({ route: 'a7', trigger: 'receipt-followup' });
    expect(route('BE-124에도 달아줘')).toEqual({ route: 'ordinary' });
    expect(route('BE-123에 확인했습니다 달아줘', withReceipt)).toEqual({ route: 'ordinary' });
    expect(route('BE-124에도 달아줘', { ...withReceipt, receipt: { ...RECEIPT, fresh: false } })).toEqual({ route: 'ordinary' });
  });
  it('3. A7 off: routing is the same as today for every message (only `grammar` or `ordinary`)', () => {
    const off = { ...CW, active: { jira: false, slack: false, calendar: false } };
    for (const t of ['슬랙 대화 요약해서 BE-123에 달아줘', '#dev 대화 요약해서 #quoky-test에 올려줘', '응 그리고 BE-123에 달아줘', '그 내용 요약해서 BE-123에 달아줘']) {
      expect(route(t, off), t).toEqual({ route: 'ordinary' });
      expect(route(t, null), t).toEqual({ route: 'ordinary' });
    }
  });
  it('an A7-inactive destination kind stays ordinary while another kind is active', () => {
    const slackOnly = { ...CW, active: { jira: false, slack: true, calendar: false } };
    expect(route('슬랙 대화 요약해서 BE-123에 달아줘', slackOnly)).toEqual({ route: 'ordinary' });
    expect(route('슬랙 대화 요약해서 #quoky-test에 올려줘', slackOnly)).toEqual({ route: 'a7', trigger: 'cross-source' });
  });
});

describe('the pre-read destination check', () => {
  const port = (over: Partial<CrossWriteDestinationPort> = {}): CrossWriteDestinationPort => ({ jiraIssueExists: async () => true, slackChannelIsPublic: async () => true, ...over });
  it('passes an existing issue and a public channel, one call each', async () => {
    const calls: string[] = [];
    const p = port({ jiraIssueExists: async (key) => (calls.push(key), true), slackChannelIsPublic: async (name) => (calls.push(name), true) });
    expect(await checkCrossWriteDestination({ kind: 'jira', issueKey: 'BE-123', project: 'BE' }, p)).toEqual({ ok: true });
    expect(await checkCrossWriteDestination({ kind: 'slack', channel: 'quoky-test' }, p)).toEqual({ ok: true });
    expect(calls).toEqual(['BE-123', 'quoky-test']);
  });
  it('fails closed: a missing issue, a private channel and a port that throws', async () => {
    expect(await checkCrossWriteDestination({ kind: 'jira', issueKey: 'BE-1', project: 'BE' }, port({ jiraIssueExists: async () => false }))).toEqual({ ok: false, reason: 'not-found' });
    expect(await checkCrossWriteDestination({ kind: 'slack', channel: 'x' }, port({ slackChannelIsPublic: async () => false }))).toEqual({ ok: false, reason: 'not-public' });
    expect(await checkCrossWriteDestination({ kind: 'jira', issueKey: 'BE-1', project: 'BE' }, port({ jiraIssueExists: async () => { throw new Error('down'); } }))).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('pinned to the existing grammar and ports', () => {
  it('the destination nouns and write verbs are the ADR-0112 grammar\'s own: it accepts each between the literal and its particle, and after it', () => {
    for (const noun of ['', ' 이슈', ' 티켓']) expect(detectWorkChatCommand(`BE-123${noun}에 댓글: 내용`)?.kind, noun).toBe('connector-write');
    expect(detectWorkChatCommand('#quoky-test 채널에 게시: 내용')?.kind).toBe('connector-write');
    for (const verb of ['달아줘', '남겨줘', '써줘', '작성해줘', '추가해줘', '등록해줘']) expect(detectWorkChatCommand(`BE-123에 댓글 ${verb}`)?.kind, verb).toBe('connector-write');
    for (const verb of ['게시해줘', '올려줘', '보내줘', '포스트해줘', '전송해줘']) expect(detectWorkChatCommand(`#quoky-test에 ${verb}`)?.kind, verb).toBe('connector-write');
  });
  it('the grammar pieces A7 imports are the ADR-0112 grammar\'s own exported words, unchanged (review round 1, P3)', () => {
    expect([WORK_CHAT_ISSUE_NOUNS, WORK_CHAT_CHANNEL_NOUNS, WORK_CHAT_COMMENT_NOUNS, WORK_CHAT_POST_NOUNS]).toEqual([['이슈', '티켓'], ['채널'], ['댓글', '코멘트'], ['메시지', '글']]);
    expect(WORK_CHAT_COMMENT_VERBS).toEqual(['달아', '남겨', '써', '작성해', '추가해', '등록해']);
    expect(WORK_CHAT_POST_VERBS).toEqual(['게시', '올려', '보내', '포스트', '전송']);
    expect(WORK_CHAT_REQUEST_ENDING_FORMS).toBe('(?:줘|주세요|줄래(?:요)?|줘요)');
    // The grammar still behaves as before with the composed patterns (verbatim payload, usage hint, quoted post).
    expect(detectWorkChatCommand('Jira BE-123 티켓에 코멘트 남겨줘: 확인')?.kind).toBe('connector-write');
    expect(detectWorkChatCommand('슬랙 #quoky-test 채널에 메시지를 게시해줘: 공지')?.kind).toBe('connector-write');
    expect(detectWorkChatCommand('#quoky-test에 "배포 완료"라고 올려줘')?.kind).toBe('connector-write');
  });
  it('the three operations are the ports\' own operation names', () => {
    expect(Object.values(AGENT_A7_TARGETS).map((target) => target.operation).sort()).toEqual([ConnectorWriteOperation.CALENDAR_EVENT_CREATE, ConnectorWriteOperation.CHANNEL_POST, ConnectorWriteOperation.ISSUE_COMMENT].sort());
  });
});

describe('review round 1 (CA + Codex): every finding has a regression', () => {
  const route = (groundingText: string, context: AgentCrossWriteContext | undefined = CW) => routeCrossWrite({ groundingText, context, offered: OFFERED });
  const jiraRead = (args: Record<string, unknown> = {}) => ({ entryId: 'jira.issues', args });

  it('P2-1: form b names a new source by the catalog names AND aliases of EVERY read source, outside the destination span', () => {
    for (const text of ['메일 내용 요약해서 BE-123에 달아줘', '릴리즈 관련 그 내용 요약해서 BE-123에 달아줘', '그 이슈 요약해서 BE-123에 달아줘', '드라이브 문서 정리해서 #quoky-test에 올려줘']) {
      const body = text.includes('#') ? formB(slack({ channel: 'quoky-test' })) : formB(jira({ issueKey: 'BE-123' }));
      expect(check(body, text, withReceipt), text).toMatchObject({ ok: false, reason: 'cross-write-new-source' });
    }
    // A word naming the held entry still binds, also when it names a sibling entry too ("지라": both Jira entries).
    const jiraReceipt = { ...CW, receipt: { ...RECEIPT, sourceEntryId: 'jira.issues' } };
    expect(check(formB(jira({ issueKey: 'BE-123' })), '지라 내용 요약해서 BE-123에 달아줘', jiraReceipt)).toMatchObject({ ok: true });
    expect(check(formB(jira({ issueKey: 'BE-123' })), '그 이슈들 요약해서 BE-123에 달아줘', jiraReceipt)).toMatchObject({ ok: true });
    // An alias of a sibling entry alone is a new source: the release entry is not the held issues.
    expect(check(formB(jira({ issueKey: 'BE-123' })), '릴리즈 관련 그 내용 요약해서 BE-123에 달아줘', jiraReceipt)).toMatchObject({ ok: false, reason: 'cross-write-new-source' });
    // With no structural trigger the router leaves the turn ordinary (R2a is names only), so the plan is refused before the bind.
    expect(check(formB(jira({ issueKey: 'BE-123' })), '릴리즈 내용 요약해서 BE-123에 달아줘', withReceipt)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
  });

  it('P2-1 residual: R2a stays names only, now over every catalog read source; an alias alone keeps an A6 literal post', () => {
    expect(route('메일 내용 요약해서 BE-123에 달아줘')).toEqual({ route: 'a7', trigger: 'cross-source' });
    expect(route('BE-123에 짧게 배포 완료 달아줘')).toEqual({ route: 'ordinary' });
  });

  it('P2-2: form b with a read condition of its own (time scope, a filter slot of the held entry) is not form b', () => {
    expect(check(formB(jira({ issueKey: 'BE-123' })), '어제 슬랙 내용 요약해서 BE-123에 달아줘', withReceipt)).toMatchObject({ ok: false, reason: 'cross-write-read-condition' });
    expect(check(formB(slack({ channel: 'quoky-test' })), '오늘 그 내용 정리해서 #quoky-test에 올려줘', withReceipt)).toMatchObject({ ok: false, reason: 'cross-write-read-condition' });
    const jiraReceipt = { ...CW, receipt: { ...RECEIPT, sourceEntryId: 'jira.issues' } };
    expect(check(formB(jira({ issueKey: 'BE-123' })), '진행 중인 지라 이슈 요약해서 BE-123에 달아줘', jiraReceipt)).toMatchObject({ ok: false, reason: 'cross-write-read-condition' });
    // The same words with the read step are form a over that source, validated as any read.
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-123' })), '어제 슬랙 릴리즈 대화 요약해서 BE-123에 달아줘')).toMatchObject({ ok: true, plan: { form: 'a' } });
    // A calendar's own time span is the destination's, never a read condition.
    expect(check(formB(calendar({ title: '배포 점검', when: '내일 오후 3시' })), '그 내용 요약해서 내일 오후 3시에 배포 점검 일정 만들어줘', withReceipt)).toMatchObject({ ok: true, plan: { form: 'b', calendar: { when: '내일 오후 3시' } } });
  });

  it('P2-3: writes are counted by the grammar verb stems whatever the ending, connectives included, calendar too', () => {
    const text = '슬랙 회의 요약해서 BE-1에 달아주고 #quoky-test에도 올려줘';
    expect(check(formA('회의', jira({ issueKey: 'BE-1' })), text)).toMatchObject({ ok: false, reason: 'cross-write-writes' });
    expect(check(formA('회의', slack({ channel: 'quoky-test' })), text)).toMatchObject({ ok: false, reason: 'cross-write-writes' });
    expect(analyseCrossWriteLiterals(text, CW, crossWriteNouns(OFFERED)).writeUnits).toBe(2);
    expect(analyseCrossWriteLiterals('슬랙 릴리즈 요약해서 #quoky-test에 게시하고 BE-1에 남겨줘', CW, crossWriteNouns(OFFERED)).writeUnits).toBe(2);
    expect(route(text)).toEqual({ route: 'ordinary' });
    // Beside a calendar event (whose own verb is not a comment or post verb), the comment is a second write.
    expect(check(formA('릴리즈', calendar({ title: '점검', when: '내일 오후 3시' })), '슬랙 릴리즈 요약해서 BE-123에 달아주고 내일 오후 3시에 점검 일정 만들어줘')).toMatchObject({ ok: false, reason: 'cross-write-writes' });
    // A relative form is no write ("보내준": someone sent); one write stays one.
    expect(analyseCrossWriteLiterals('보내준 슬랙 대화 요약해서 BE-123에 달아줘', CW, crossWriteNouns(OFFERED)).writeUnits).toBe(1);
  });

  it('P2-4: the validator re-checks the step 0 route: an ordinary turn is never an A7 plan; form a needs the cross-source trigger', () => {
    expect(route('확인했습니다 BE-123에 달아줘', withReceipt)).toEqual({ route: 'ordinary' });
    expect(check(formB(jira({ issueKey: 'BE-123' })), '확인했습니다 BE-123에 달아줘', withReceipt)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    expect(check(formB(jira({ issueKey: 'BE-123' })), 'BE-123에 확인했습니다 달아줘', withReceipt)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    // A bare receipt-bound follow-up is form b only; as form a it has no cross-source trigger.
    expect(check(formB(jira({ issueKey: 'BE-124' })), 'BE-124에도 달아줘', withReceipt)).toMatchObject({ ok: true, plan: { form: 'b' } });
    expect(check(formA('릴리즈', jira({ issueKey: 'BE-124' })), 'BE-124에도 달아줘', withReceipt)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
    // A calendar plan needs the same cross-source trigger outside its title and time spans.
    expect(check(formB(calendar({ title: '배포 점검', when: '내일 오후 3시' })), '확인 내일 오후 3시에 배포 점검 일정 만들어줘', withReceipt)).toMatchObject({ ok: false, reason: 'cross-write-invalid' });
  });

  it('P2-5: the source read is grounded in the owner\'s words outside the destination span (its entry named, or its own value)', () => {
    const text = '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘';
    expect(check({ steps: [jiraRead(), DRAFT_A, jira({ issueKey: 'BE-123' })], ambiguity: 'CLEAR' }, text)).toMatchObject({ ok: false, reason: 'step-invalid', step: 1, stepReason: 'ungrounded' });
    expect(check({ steps: [jiraRead({ keyword: '릴리즈' }), DRAFT_A, jira({ issueKey: 'BE-123' })], ambiguity: 'CLEAR' }, text)).toMatchObject({ ok: false, reason: 'step-invalid', step: 1 });
    // "지라" inside the destination span grounds no Jira read.
    expect(check({ steps: [jiraRead(), DRAFT_A, jira({ issueKey: 'BE-123' })], ambiguity: 'CLEAR' }, '그 대화 요약해서 지라 BE-123에 달아줘')).toMatchObject({ ok: false, reason: 'step-invalid' });
    // Grounded: the entry is named outside the span, or nothing is named and the read carries the owner's own source literal.
    expect(check({ steps: [jiraRead(), DRAFT_A, slack({ channel: 'quoky-test' })], ambiguity: 'CLEAR' }, '지라 이슈 요약해서 #quoky-test에 올려줘')).toMatchObject({ ok: true });
    expect(check({ steps: [jiraRead({ keyword: 'BE-12' }), DRAFT_A, jira({ issueKey: 'BE-123' })], ambiguity: 'CLEAR' }, 'BE-12 댓글 요약해서 BE-123에 달아줘')).toMatchObject({ ok: true });
  });

  it('P2-6: A7 must be active for every destination kind the words resolve to (marked, literal, or kind noun)', () => {
    const slackOnly = { ...CW, active: { jira: false, slack: true, calendar: false } };
    expect(route('BE-12 댓글 요약해서 BE-123으로 올려줘', slackOnly)).toEqual({ route: 'ordinary' });
    expect(route('슬랙 대화 요약해서 지라 티켓에 달아줘', slackOnly)).toEqual({ route: 'ordinary' });
    expect(route('BE-12 댓글 요약해서 BE-123으로 올려줘')).toEqual({ route: 'a7', trigger: 'cross-source' });
    // The marked destination's kind decides; a source literal of an inactive kind does not block it.
    expect(route('BE-12 댓글 요약해서 #quoky-test에 올려줘', slackOnly)).toEqual({ route: 'a7', trigger: 'cross-source' });
  });

  it('P2-7: a kind-only destination has a span: form b over it asks the project or channel (a7-09), never new-source', () => {
    expect(check(formB(jira()), '해당 내용 요약해서 지라 티켓에 달아줘', withReceipt)).toMatchObject({ ok: true, plan: { form: 'b', destination: { state: 'pick-ticket', project: 'BE' } } });
    expect(check(formB(jira()), '해당 내용 요약해서 지라 티켓에 달아줘', { ...withReceipt, jiraProjects: ['BE', 'FE'] })).toMatchObject({ ok: true, plan: { destination: { state: 'pick-project' } } });
    expect(check(formB(slack()), '그 내용 정리해서 슬랙 채널에 올려줘', withReceipt)).toMatchObject({ ok: true, plan: { form: 'b', destination: { state: 'pick-channel' } } });
    expect(route('해당 내용 요약해서 지라 티켓에 달아줘', withReceipt)).toEqual({ route: 'a7', trigger: 'cross-source' });
  });

  it('P3-8: a destination literal the planner names that the rule did not mark is a role the rule did not give: refused', () => {
    expect(check({ steps: [jiraRead({ keyword: 'BE-12' }), DRAFT_A, jira({ issueKey: 'BE-123' })], ambiguity: 'CLEAR' }, 'BE-12에서 가져와서 BE-123으로 올려줘')).toMatchObject({ ok: false, reason: 'cross-write-role' });
    expect(check(formA('quoky-test', slack({ channel: 'quoky-test' })), '#quoky-test 요약해서 올려줘')).toMatchObject({ ok: false, reason: 'cross-write-role' });
    expect(check({ steps: [jiraRead({ keyword: 'ZZ-5' }), DRAFT_A, jira({ issueKey: 'ZZ-5' })], ambiguity: 'CLEAR' }, '지라 ZZ-5 요약해서 지라 티켓에 달아줘')).toMatchObject({ ok: false, reason: 'cross-write-role' });
  });

  it('P3-9: the named project matches the allowlist without case', () => {
    const two = { ...CW, jiraProjects: ['BE', 'FE'] };
    expect(check(formA('릴리즈', jira({ project: 'fe' })), '슬랙 릴리즈 대화 요약해서 fe 티켓에 달아줘', two)).toMatchObject({ ok: true, plan: { destination: { state: 'pick-ticket', project: 'FE' } } });
    expect(check(formA('릴리즈', jira()), '슬랙 릴리즈 대화 요약해서 Fe 티켓에 달아줘', { ...CW, jiraProjects: ['fe', 'BE'] })).toMatchObject({ ok: true, plan: { destination: { state: 'pick-ticket', project: 'FE' } } });
  });

  it('P3-11: 해당 is a named closed constant of the A7 router only; the A6 point-back grammar is not widened', () => {
    expect(A7_POINT_BACK_DETERMINERS).toEqual(['해당']);
    expect(route('해당 내용 정리해서 #quoky-test에 올려줘')).toEqual({ route: 'a7', trigger: 'cross-source' });
  });
});

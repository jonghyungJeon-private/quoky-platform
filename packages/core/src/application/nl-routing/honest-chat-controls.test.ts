import { describe, expect, it } from 'vitest';
import { guardFalseControlDenials, guardFalseIncapabilityClaims, renderConfiguredSourcesFact, renderControlCommandsFact } from './honest-chat';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// Live DM test 2026-10-20: asked about "에이전트 재", the chat model said there is no command to resume the agent. While the
// switch phrases are recognized, the honest-chat fact names them and a reply denying one is replaced by the exact phrase.

const ENTRIES = [NL_WAVE1_ENTRIES['calendar.events']];
const RESUME_HINT = '에이전트를 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
const ALL = { actions: true, agent: true, grants: false } as const;

describe('honest chat — the control commands (에이전트 중지 / 에이전트 재개)', () => {
  it('the fact names both exact phrases only when the switch is recognized', () => {
    const withControls = renderConfiguredSourcesFact(ENTRIES, [], { controls: ALL }) ?? '';
    expect(withControls).toContain(renderControlCommandsFact(ALL) ?? 'missing');
    expect(withControls).toContain('"에이전트 중지"');
    expect(withControls).toContain('"에이전트 재개"');
    expect(renderConfiguredSourcesFact(ENTRIES, [])).not.toContain('control commands');
    expect(renderConfiguredSourcesFact([], [], { controls: ALL })).toBe(renderControlCommandsFact(ALL));
    expect(renderConfiguredSourcesFact([], [])).toBeUndefined();
  });

  it('CA P3 7: the fact is worded by what the switch controls; the multi-step agent is named only while it is on', () => {
    const actionsOnly = renderControlCommandsFact({ actions: true, agent: false, grants: false }) ?? '';
    expect(actionsOnly).toContain("stops Quoky's natural-language actions, and");
    expect(actionsOnly).toContain('turns it back on');
    expect(actionsOnly).not.toContain('multi-step agent');
    const agentOnly = renderControlCommandsFact({ actions: false, agent: true, grants: false }) ?? '';
    expect(agentOnly).toContain('stops the multi-step agent, and');
    expect(agentOnly).not.toContain('natural-language actions');
    const grantsAndActions = renderControlCommandsFact({ actions: true, agent: false, grants: true }) ?? '';
    expect(grantsAndActions).toContain("stops Quoky's natural-language actions and every channel permission (paused, not deleted)");
    expect(grantsAndActions).toContain('turns them back on');
    expect(grantsAndActions).not.toContain('multi-step agent');
    expect(renderControlCommandsFact({ actions: false, agent: false, grants: false })).toBeUndefined();
  });

  it('a sentence denying the resume or stop command is replaced by the exact-phrase hint; the rest is kept', () => {
    const cases: Array<[string, string]> = [
      ['에이전트를 재개하는 명령어는 따로 없어요.', RESUME_HINT],
      ['죄송해요. 에이전트를 다시 켤 수 있는 기능은 제공하지 않아요. 다른 걸 도와드릴까요?', `죄송해요. 다른 걸 도와드릴까요? ${RESUME_HINT}`],
      ['에이전트를 중지하는 방법은 없습니다.', '에이전트를 멈추려면 "에이전트 중지"라고 보내 주세요.'],
      ['There is no command to resume the agent.', 'To turn the agent back on, send "에이전트 재개".'],
    ];
    for (const [reply, expected] of cases) {
      const language = /[가-힣]/u.test(reply) ? 'ko' : 'en';
      expect(guardFalseControlDenials(reply, language), reply).toEqual({ text: expected, guarded: true });
      expect(guardFalseIncapabilityClaims(reply, ENTRIES, language, [], { controls: ALL }), reply).toEqual({ text: expected, guarded: true });
    }
  });

  it('Codex P2: the denial must govern the stop / resume action in its own clause; an unrelated limitation is kept (KO, EN)', () => {
    for (const reply of [
      'You can resume the agent, but it cannot recover deleted events.',
      'You can resume the agent but it cannot recover deleted events.',
      'You can resume the agent anytime; deleted events cannot be restored.',
      'Stopping the agent is easy, and old reminders cannot be recovered.',
      '에이전트는 다시 켤 수 있지만 삭제된 일정은 복구할 수 없어요.',
      '에이전트를 재개해도 삭제된 일정은 복구할 수 없어요.',
      '에이전트를 재개하면 지운 메일은 되돌릴 수 없어요.',
      '에이전트를 중지하고 나서도 정확한 명령은 그대로 쓸 수 있고, 외부 메일은 보낼 수 없어요.',
    ]) {
      const language = /[가-힣]/u.test(reply) ? 'ko' : 'en';
      expect(guardFalseControlDenials(reply, language), reply).toEqual({ text: reply, guarded: false });
      expect(guardFalseIncapabilityClaims(reply, ENTRIES, language, [], { controls: ALL }), reply).toEqual({ text: reply, guarded: false });
    }
    // A clause that does deny the command is still replaced, also beside an unrelated clause or as "such a command".
    expect(guardFalseControlDenials('You can ask me anything, but there is no command to resume the agent.', 'en').text).toBe('To turn the agent back on, send "에이전트 재개".');
    expect(guardFalseControlDenials('Resuming the agent is not possible.', 'en').text).toBe('To turn the agent back on, send "에이전트 재개".');
    expect(guardFalseControlDenials('일정은 볼 수 있지만, 에이전트를 재개하는 명령은 없어요.', 'ko').text).toBe(RESUME_HINT);
    // Codex P2 (third round): a bare anaphoric denial in a later sentence is kept (no fallback; a recorded residual).
    for (const reply of [
      'The agent cannot stop running containers. There is no such command.',
      '에이전트 재개 말씀이신가요? 그런 명령은 없어요.',
      'Do you mean resuming the agent? There is no such command.',
    ]) {
      const language = /[가-힣]/u.test(reply) ? 'ko' : 'en';
      expect(guardFalseControlDenials(reply, language), reply).toEqual({ text: reply, guarded: false });
    }
  });

  it('Codex P2 (round 2): the negated stop / resume must take the agent, Quoky or the switch as its object or topic', () => {
    for (const reply of [
      'The agent can read schedules, but cannot stop running containers.',
      'The agent cannot stop running containers.',
      'The agent can read schedules, but there is no way to stop.',
      '에이전트는 일정을 볼 수 있지만 컨테이너를 중지할 수 없어요.',
      '에이전트는 컨테이너를 중지할 수 없어요.',
      '에이전트가 알림을 다시 켤 수는 없어요.',
    ]) {
      const language = /[가-힣]/u.test(reply) ? 'ko' : 'en';
      expect(guardFalseControlDenials(reply, language), reply).toEqual({ text: reply, guarded: false });
    }
    const stopHint = '에이전트를 멈추려면 "에이전트 중지"라고 보내 주세요.';
    expect(guardFalseControlDenials('저는 에이전트를 중지할 수 없어요.', 'ko').text).toBe(stopHint);
    expect(guardFalseControlDenials('에이전트 재개 명령은 따로 없어요.', 'ko').text).toBe(RESUME_HINT);
    expect(guardFalseControlDenials("Sorry, I can't resume the agent.", 'en').text).toBe('To turn the agent back on, send "에이전트 재개".');
    expect(guardFalseControlDenials('The agent has no command to resume.', 'en').text).toBe('To turn the agent back on, send "에이전트 재개".');
    expect(guardFalseControlDenials('There is no way to stop Quoky.', 'en').text).toBe('To stop the agent, send "에이전트 중지".');
  });

  it('true or unrelated sentences stay, and nothing changes while the switch is not recognized', () => {
    for (const reply of [
      '에이전트를 다시 켜려면 "에이전트 재개"라고 보내 주세요.',
      '지금 에이전트는 켜져 있어요.',
      '에이전트를 다시 켤 필요는 없어요.',
      '그 일정은 취소할 수 없어요.',
      '에이전트라는 단어는 여러 뜻이 있어요.',
    ]) {
      expect(guardFalseControlDenials(reply, 'ko'), reply).toEqual({ text: reply, guarded: false });
    }
    const denial = '에이전트를 재개하는 명령어는 없어요.';
    expect(guardFalseIncapabilityClaims(denial, ENTRIES, 'ko', [])).toEqual({ text: denial, guarded: false });
  });
});

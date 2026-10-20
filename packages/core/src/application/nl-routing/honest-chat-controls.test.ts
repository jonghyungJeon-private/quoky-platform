import { describe, expect, it } from 'vitest';
import { guardFalseControlDenials, guardFalseIncapabilityClaims, renderConfiguredSourcesFact, renderControlCommandsFact } from './honest-chat';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// Live DM test 2026-10-20: asked about "에이전트 재", the chat model said there is no command to resume the agent. While the
// switch phrases are recognized, the honest-chat fact names them and a reply denying one is replaced by the exact phrase.

const ENTRIES = [NL_WAVE1_ENTRIES['calendar.events']];
const RESUME_HINT = '에이전트를 다시 켜려면 "에이전트 재개"라고 보내 주세요.';

describe('honest chat — the control commands (에이전트 중지 / 에이전트 재개)', () => {
  it('the fact names both exact phrases only when the switch is recognized', () => {
    const withControls = renderConfiguredSourcesFact(ENTRIES, [], { controls: true }) ?? '';
    expect(withControls).toContain(renderControlCommandsFact());
    expect(withControls).toContain('"에이전트 중지"');
    expect(withControls).toContain('"에이전트 재개"');
    expect(renderConfiguredSourcesFact(ENTRIES, [])).not.toContain('control commands');
    expect(renderConfiguredSourcesFact([], [], { controls: true })).toBe(renderControlCommandsFact());
    expect(renderConfiguredSourcesFact([], [])).toBeUndefined();
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
      expect(guardFalseIncapabilityClaims(reply, ENTRIES, language, [], { controls: true }), reply).toEqual({ text: expected, guarded: true });
    }
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

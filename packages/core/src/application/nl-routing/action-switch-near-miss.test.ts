import { describe, expect, it } from 'vitest';
import {
  ACTION_SWITCH_PHRASES,
  nearMissActionSwitchPhrase,
  parseActionSwitchPhrase,
  renderActionSwitchHint,
} from './action-switch';
import { nlIsKeystrokePrefix, nlKeystrokeDistance } from './garbled-action';

// Live DM test 2026-10-20 (14:52–14:54): "에이ㄴ트 재개" and "에이전트 재" went to chat, which denied the command; only the
// exact "에이전트 재개" switched. A near miss of the closed switch phrases is now detected by the garbled-noun keystroke
// distance (no typo list) and answered with the exact phrase; execution stays exact for stop and resume alike (owner
// decision 2026-10-20).

describe('the switch near miss (keystroke distance over the closed phrase set)', () => {
  it('reads loose compatibility jamo as keys: "에이ㄴ트" is two keys from "에이전트"', () => {
    expect(nlKeystrokeDistance('에이ㄴ트', '에이전트')).toBe(2);
    expect(nlKeystrokeDistance('ㅇㅔ', '에')).toBe(0);
    expect(nlIsKeystrokePrefix('에이전트 잭', '에이전트 재개')).toBe(true);
    expect(nlIsKeystrokePrefix('에이전트 재개', '에이전트 재개')).toBe(false);
  });

  it('the live typo and truncation get the resume hint', () => {
    expect(nearMissActionSwitchPhrase('에이ㄴ트 재개')).toEqual({ kind: 'typo', state: 'running' });
    expect(nearMissActionSwitchPhrase('에이전트 재')).toEqual({ kind: 'prefix', state: 'running' });
  });

  it('typo, request-tail and truncation variants of both phrases', () => {
    const cases: Array<[string, ReturnType<typeof nearMissActionSwitchPhrase>]> = [
      ['에이전트 재게', { kind: 'typo', state: 'running' }],
      ['에이전트 쟤개', { kind: 'typo', state: 'running' }],
      ['에이젼트 재개', { kind: 'typo', state: 'running' }],
      ['에이전트재게!', { kind: 'typo', state: 'running' }],
      ['에이전트 잭', { kind: 'prefix', state: 'running' }],
      ['에이전트 재개해줘', { kind: 'request', state: 'running' }],
      ['에이전트 재개 좀 해 주세요', { kind: 'request', state: 'running' }],
      ['에이전트 재개요', { kind: 'request', state: 'running' }],
      ['에이전트 중자', { kind: 'typo', state: 'stopped' }],
      ['에이전트 증지', { kind: 'typo', state: 'stopped' }],
      ['에이ㄴ트 중지', { kind: 'typo', state: 'stopped' }],
      ['에이전트 중지해줘', { kind: 'request', state: 'stopped' }],
      ['에이전트 중지 해', { kind: 'request', state: 'stopped' }],
      ['에이전트 중', { kind: 'prefix', state: 'stopped' }],
      ['에이전트 주', { kind: 'prefix', state: 'stopped' }],
      ['에이전트 중ㅈ', { kind: 'prefix', state: 'stopped' }],
    ];
    for (const [text, expected] of cases) expect(nearMissActionSwitchPhrase(text), text).toEqual(expected);
  });

  it('the exact phrases are never a near miss (they switch exactly as before)', () => {
    for (const text of ['에이전트 중지', '에이전트 재개', '에이전트중지', '에이전트재개', ' 에이전트  재개. ', '에이전트 중지!']) {
      expect(nearMissActionSwitchPhrase(text), text).toBeUndefined();
      expect(parseActionSwitchPhrase(text), text).toBeDefined();
    }
  });

  it('normal sentences that mention 에이전트 are untouched', () => {
    for (const text of [
      '에이전트',
      '에이전트 ㅈ',
      '에이전트 좋지',
      '에이전트 재밌네',
      '에이전트 재미',
      '에이전트 재지',
      '에이전트 중이야',
      '에이전트 중지됐어',
      '에이전트 중지하지 마',
      '에이전트 재개함',
      '에이전트 중지?',
      '에이전트 재개 어떻게 해?',
      '에이전트 재개하는 명령어 있어?',
      '에이전트가 뭐야',
      '에이전트 중지하면 어떻게 돼',
      '에이전트 기능 설명해줘',
      '다단계 에이전트 재개',
      '에이전트 재개\n고마워',
      'agent 재개',
      '오늘 일정 보여줘',
      '재개',
      '중지',
    ]) {
      expect(nearMissActionSwitchPhrase(text), text).toBeUndefined();
    }
  });

  it('the hint names the exact phrase and is not a question', () => {
    expect(renderActionSwitchHint(['running'])).toBe('에이전트를 다시 켜려면 "에이전트 재개"라고 보내 주세요.');
    expect(renderActionSwitchHint(['stopped'])).toBe('에이전트를 멈추려면 "에이전트 중지"라고 보내 주세요.');
    const both = renderActionSwitchHint(['stopped', 'running']);
    expect(both).toContain(ACTION_SWITCH_PHRASES.stopped);
    expect(both).toContain(ACTION_SWITCH_PHRASES.running);
    for (const hint of [both, renderActionSwitchHint(['running']), renderActionSwitchHint(['stopped'], 'en')]) expect(hint).not.toMatch(/[?？]|까요/u);
  });
});

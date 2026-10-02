import { describe, expect, it } from 'vitest';
import { interpretApprovalDecision } from './approval-decision';

describe('interpretApprovalDecision', () => {
  const table: Array<[string, 'approve' | 'deny' | 'cancel' | 'ambiguous']> = [
    // approve
    ['승인', 'approve'],
    ['승인해줘', 'approve'],
    ['승인합니다', 'approve'],
    ['진행해', 'approve'],
    ['진행해주세요', 'approve'],
    ['좋아', 'approve'],
    ['좋아요', 'approve'],
    ['네, 진행할게요', 'approve'],
    ['yes', 'approve'],
    ['Yes!', 'approve'],
    ['ok', 'approve'],
    ['approve', 'approve'],
    ['Approved.', 'approve'],
    ['go ahead', 'approve'],
    ['yes, go ahead', 'approve'],
    // deny
    ['거절', 'deny'],
    ['거절할게요', 'deny'],
    ['아니', 'deny'],
    ['아니요', 'deny'],
    ['no', 'deny'],
    ['deny', 'deny'],
    ['reject', 'deny'],
    // cancel
    ['취소', 'cancel'],
    ['취소해줘', 'cancel'],
    ['중단', 'cancel'],
    ['그만', 'cancel'],
    ['cancel', 'cancel'],
    ['stop', 'cancel'],
    ['승인 취소', 'cancel'],
    // negated approve → never approve (deny)
    ['진행하지 마', 'deny'],
    ['진행하지 마세요', 'deny'],
    ['승인하지 마', 'deny'],
    ['승인하지 말고 거절', 'deny'],
    ["don't approve", 'deny'],
    ['do not approve', 'deny'],
    ["don't go ahead", 'deny'],
    ['never approve this', 'deny'],
    ['승인 안 할래', 'ambiguous'],
    ['승인 안해', 'ambiguous'],
    ['진행 안해', 'ambiguous'],
    ['승인 안할래', 'ambiguous'],
    ['진행 못해', 'ambiguous'],
    ["can't approve", 'ambiguous'],
    ['cannot approve', 'ambiguous'],
    ["won't approve", 'ambiguous'],
    ["I won't go ahead", 'ambiguous'],
    // positives that must keep approving
    ['승인해 주세요', 'approve'],
    ['안녕, 승인', 'approve'],
    ["please don't stop, go ahead", 'approve'],
    // not false denies
    ['거절 안 해', 'ambiguous'],
    ['no problem', 'ambiguous'],
    // negated deny / cancel → not a deny / cancel
    ['거절하지 마', 'ambiguous'],
    ['취소하지 마', 'ambiguous'],
    ["don't cancel", 'ambiguous'],
    // bare letters and substring hits are not decisions
    ['y', 'ambiguous'],
    ['n', 'ambiguous'],
    ['why', 'ambiguous'],
    ['why?', 'ambiguous'],
    ['nothing yet', 'ambiguous'],
    ['know', 'ambiguous'],
    ['book', 'ambiguous'],
    ['진행상황 알려줘', 'ambiguous'],
    ['', 'ambiguous'],
    ['   ', 'ambiguous'],
    // questions / hedges
    ['진행할까?', 'ambiguous'],
    ['진행할까', 'ambiguous'],
    ['승인해도 될까요', 'ambiguous'],
    ['approve?', 'ambiguous'],
    ['look at it first', 'ambiguous'],
    ['먼저 보고 승인할게', 'ambiguous'],
    ['approve later', 'ambiguous'],
    // contradictions
    ['yes no', 'ambiguous'],
    ['승인 거절', 'ambiguous'],
    // unrelated chat
    ['오늘 날씨 어때', 'ambiguous'],
  ];

  it.each(table)('%j → %s', (text, expected) => {
    expect(interpretApprovalDecision(text)).toBe(expected);
  });

  it('never approves a negated approve phrase (explicit safety table)', () => {
    for (const text of ['진행하지 마', '승인하지 마', "don't approve", 'do not proceed, approve nothing', '승인 안해', '진행 안해', "can't approve", "won't approve"]) {
      expect(interpretApprovalDecision(text), text).not.toBe('approve');
    }
  });

  it('a long free-text message containing an approve word is not an approval', () => {
    const long = `${'이 기능의 전체 흐름을 다시 설계해서 새 문서로 정리해 줘. '.repeat(3)}진행`;
    expect(interpretApprovalDecision(long)).toBe('ambiguous');
  });
});

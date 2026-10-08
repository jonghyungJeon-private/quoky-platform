import { describe, expect, expectTypeOf, it } from 'vitest';
import { interpretApprovalDecision, interpretStrayDecisionUtterance, isPendingCancelUtterance, type ApprovalDecisionResult } from './approval-decision';
import type { ApprovalDecisionKind } from './conversation-runtime';

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
    // conditional approval: the negation targets something else → re-prompt, never a terminal deny
  ['테스트 없이 진행해', 'ambiguous'],
  ['커밋하지 말고 진행해', 'ambiguous'],
  ['proceed without tests', 'ambiguous'],
  ['승인하되 커밋은 하지 마', 'ambiguous'],
  ['승인해줘 테스트 없이', 'ambiguous'],
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
    // refusal phrasings that carry an approve stem must never approve
    ['승인 거부', 'ambiguous'],
    ['승인 불가', 'ambiguous'],
    ['진행 불가', 'ambiguous'],
    ['승인 보류', 'ambiguous'],
    ['진행 보류', 'ambiguous'],
    ['승인 철회', 'cancel'],
    ['승인 반대', 'ambiguous'],
    ['진행 중지', 'cancel'],
    ['진행 대기', 'ambiguous'],
    ['진행 마', 'ambiguous'],
    ['승인 마', 'ambiguous'],
    ['진행 ㄴㄴ', 'ambiguous'],
    ['승인 X', 'ambiguous'],
    ['I refuse to approve', 'ambiguous'],
    ['approve nothing', 'ambiguous'],
    ['거부', 'deny'],
    ['refuse', 'deny'],
    // contrastive "A 말고 B": the negation targets the deny/cancel word, so re-prompt rather than deny
    ['취소 말고 진행해', 'ambiguous'],
    ['취소하지 말고 진행해', 'ambiguous'],
    ['거절하지 말고 승인해', 'ambiguous'],
    // an approve with a condition attached in another clause is not a plain approve
    ["yes but don't touch tests", 'ambiguous'],
    ['승인, 근데 테스트는 건드리지 마', 'ambiguous'],
    // newly accepted spellings
    ['진행시켜', 'approve'],
    ['proceed', 'approve'],
    // status questions / non-decisions that merely start with an approve stem
    ['진행 상황 알려줘', 'ambiguous'],
    ['진행 상황 좀', 'ambiguous'],
    ['승인 대상 뭐야', 'ambiguous'],
    ['승인 요청 내용 보여줘', 'ambiguous'],
    ['이거 진행 전에 설명해줘', 'ambiguous'],
    ['진행 여부는 내일 알려줄게', 'ambiguous'],
    ['ok 내일 할게', 'ambiguous'],
    ['ok let me think', 'ambiguous'],
    ['좋아 보이는데 확인 좀', 'ambiguous'],
    // refusals / stops that carry an approve stem
    ['진행 멈춰', 'cancel'],
    ['진행 싫어', 'ambiguous'],
    ['승인 하기 싫어', 'ambiguous'],
    ['승인 원하지 않음', 'ambiguous'],
    ['진행 원치 않아', 'ambiguous'],
    ['승인 불허', 'ambiguous'],
    ['승인 반려', 'ambiguous'],
    ['승인 노', 'ambiguous'],
    ['승인 절대 안됨', 'ambiguous'],
    ['진행 하면 안됨', 'ambiguous'],
    ['승인 안됨', 'ambiguous'],
    ['승인 안돼요', 'ambiguous'],
    // conditional / extended approvals cannot be honored: re-prompt instead of approving the whole request
    ['ok but only change src/a.ts', 'ambiguous'],
    ['승인. 단 package.json은 제외', 'ambiguous'],
    ['승인, package.json 빼고', 'ambiguous'],
    ['진행해 단 README만 바꿔', 'ambiguous'],
    ['진행해, 그리고 main에 바로 커밋해', 'ambiguous'],
    ['yes and also push it', 'ambiguous'],
    // plain approvals with only polite fillers keep approving
    ['yes please', 'approve'],
    ['네 승인해 주세요 감사합니다', 'approve'],
    ['그냥 진행해줘', 'approve'],
    // contradictions
    ['yes no', 'ambiguous'],
    ['승인 거절', 'ambiguous'],
    // unrelated chat
    ['오늘 날씨 어때', 'ambiguous'],
    // a question mark ANYWHERE is a question, not only at the end
    ['승인? 감사합니다.', 'ambiguous'],
    ['진행? 네', 'ambiguous'],
    ['ok?!', 'ambiguous'],
    ['승인？ 네', 'ambiguous'],
    ['취소? 아니 진행', 'ambiguous'],
    // significant symbols / emoji are never discarded: they make an approve ambiguous
    ['승인 ❌', 'ambiguous'],
    ['승인 ✖', 'ambiguous'],
    ['승인 👎', 'ambiguous'],
    ['승인 👍', 'ambiguous'],
    ['ok 🙅', 'ambiguous'],
    ['진행 ->', 'ambiguous'],
    ['승인 ㅠㅠ', 'ambiguous'],
    // benign punctuation (. , ! ~) still approves
    ['승인!!', 'approve'],
    ['승인.', 'approve'],
    ['승인~', 'approve'],
    ['네 승인할게요', 'approve'],
  ];

  it.each(table)('%j → %s', (text, expected) => {
    expect(interpretApprovalDecision(text)).toBe(expected);
  });

  it('never approves a negated approve phrase (explicit safety table)', () => {
    for (const text of ['진행하지 마', '승인하지 마', "don't approve", 'do not proceed, approve nothing', '승인 안해', '진행 안해', "can't approve", "won't approve", '승인 거부', '승인 불가', '진행 불가', '승인 보류', '진행 보류', '승인 철회', '승인 반대', '진행 중지', '진행 대기', '진행 마', '승인 마', '진행 ㄴㄴ', '승인 X', 'I refuse to approve', 'approve nothing', '취소 말고 진행해', "yes but don't touch tests", '진행 상황 알려줘', '진행 멈춰', '진행 싫어', '승인 불허', '승인 반려', '승인 절대 안됨', 'ok 내일 할게', 'ok let me think', 'ok but only change src/a.ts', 'yes and also push it', '승인 ❌', '승인? 감사합니다.', '승인 ✖', '승인 👎', 'ok?!', '진행? 네']) {
      expect(interpretApprovalDecision(text), text).not.toBe('approve');
    }
  });

  it('keeps ApprovalDecisionResult in sync with the runtime ApprovalDecisionKind', () => {
    expectTypeOf<ApprovalDecisionResult>().toEqualTypeOf<ApprovalDecisionKind>();
  });

  it('a long free-text message containing an approve word is not an approval', () => {
    const long = `${'이 기능의 전체 흐름을 다시 설계해서 새 문서로 정리해 줘. '.repeat(3)}진행`;
    expect(interpretApprovalDecision(long)).toBe('ambiguous');
  });
});

describe('interpretStrayDecisionUtterance (QA-018)', () => {
  it.each<[string, 'approve' | 'deny' | 'cancel']>([
    ['승인', 'approve'],
    ['승인해줘', 'approve'],
    ['승인합니다.', 'approve'],
    ['네, 승인', 'approve'],
    ['진행해', 'approve'],
    ['approve', 'approve'],
    ['ok', 'approve'],
    ['OK thanks', 'approve'],
    ['거절', 'deny'],
    ['거절해 주세요', 'deny'],
    ['reject', 'deny'],
    ['취소', 'cancel'],
    ['취소해줘', 'cancel'],
    ['cancel', 'cancel'],
  ])('"%s" is a whole-message decision → %s', (text, expected) => {
    expect(interpretStrayDecisionUtterance(text)).toBe(expected);
  });

  it.each([
    '승인 절차가 뭐야?',
    '승인 절차 설명해줘',
    '승인?',
    '회의 취소해줘',
    '예약 취소해 주세요',
    '거절당했어',
    '좋아',
    '네',
    '아니',
    'no',
    'yes',
    '그만',
    'stop',
    '진행하지 마',
    '',
    '승인 승인 승인 승인 승인 승인 승인 승인 승인 승인 승인 승인', // over the 30-char whole-message bound
  ])('"%s" is not a stray decision', (text) => {
    expect(interpretStrayDecisionUtterance(text)).toBeNull();
  });
});

describe('isPendingCancelUtterance (live QA session 4, N2)', () => {
  it.each(['그만', '그만해', '그만할게', '취소', '취소해줘', '아니', '아니요', '아뇨', '됐어', '됐어요', '이제 그만', '그냥 됐어', 'cancel', 'Stop', 'stop.', 'never mind', 'no'])(
    '"%s" is a stop word',
    (text) => {
      expect(isPendingCancelUtterance(text)).toBe(true);
    },
  );

  it.each(['그만하지 마', '그만 다른 일정 보여줘', '아니 3시 말고 4시', '됐어?', '아니 뭐라고?', 'stop the build', '1번', '승인', '', `${'그만 '.repeat(20)}`])(
    '"%s" is not',
    (text) => {
      expect(isPendingCancelUtterance(text)).toBe(false);
    },
  );
});

describe('interpretApprovalDecision: a deny word decides only as the whole message (Codex P2 on b571e4d)', () => {
  it.each([
    ['아니', 'deny'],
    ['아니요', 'deny'],
    ['아니에요.', 'deny'],
    ['거절할게요', 'deny'],
    ['이 요청 거절해 주세요', 'deny'],
    ['no', 'deny'],
    ['No, thanks', 'deny'],
    ['reject it', 'deny'],
    ['아니 됐어', 'deny'],
    ['아니 취소해', 'cancel'],
  ] as const)('"%s" → %s', (text, expected) => {
    expect(interpretApprovalDecision(text)).toBe(expected);
  });

  it.each(['아니 이건 내 친구 얘기야', '아니 그건 별로야', 'no, I meant the other channel', '거절 사유를 알려줘'])(
    '"%s" carries other content → ambiguous (the approval stays pending)',
    (text) => {
      expect(interpretApprovalDecision(text)).toBe('ambiguous');
    },
  );
});

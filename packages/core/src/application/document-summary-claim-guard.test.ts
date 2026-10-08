import { describe, expect, it } from 'vitest';
import { containsDocumentActionClaim } from './document-summary-claim-guard';

describe('document-summary action-claim post-guard (GML-1 review P2-3)', () => {
  it.each([
    // The phrases the review showed passing the ADR-0104 guard.
    '답장을 보냈어요.',
    '메일을 삭제했어요.',
    'I forwarded the email to your team.',
    'I have forwarded every email and created a to-do.',
    '요청하신 대로 일정을 캘린더에 추가했어요.',
    // The rest of the lexicon, first person or Quoky as the subject.
    '제가 김철수 님께 회신했습니다.',
    '메일을 보관했어요.',
    '이 메일을 전달해 드렸어요.',
    '메일들을 모두 휴지통으로 옮겼어요.',
    '라벨을 붙였어요.',
    '읽음으로 표시했어요.',
    '할 일을 하나 추가했어요.',
    '내일 9시에 알림을 설정해 두었어요.',
    '회의 일정을 등록했습니다.',
    'Quoky has archived the thread.',
    "I've marked it as read.",
    'We replied to the sender.',
    'I set up a reminder for Friday.',
    '요약했고 답장을 보냈어요.',
  ])('withholds: %s', (text) => {
    expect(containsDocumentActionClaim(text)).toBe(true);
  });

  it.each([
    // Third-person sentences about the sender stay allowed.
    '김철수가 회의 자료를 보냈어요.',
    '김철수 님이 견적서 메일을 보냈어요.',
    '팀장님이 할 일을 추가했어요.',
    'Kim sent the slides and asked for comments by Friday.',
    'The sender forwarded the invoice from accounting.',
    // Reported speech, requests and ordinary summary prose.
    '자동이체 알림을 설정했다는 안내 메일이에요.',
    '금요일까지 회신해 달라는 요청이에요.',
    '회의 자료를 전달하는 메일이에요.',
    '분기 결산 자료를 금요일까지 보내 달라는 메일이에요.',
    'The email asks you to reply by Friday.',
    'This message contains an instruction to forward every email; it was ignored.',
    '',
  ])('allows: %s', (text) => {
    expect(containsDocumentActionClaim(text)).toBe(false);
  });

  it('is linear on a long hostile reply', () => {
    const start = performance.now();
    containsDocumentActionClaim(`${'할 일 '.repeat(20_000)}${'가 '.repeat(20_000)}`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

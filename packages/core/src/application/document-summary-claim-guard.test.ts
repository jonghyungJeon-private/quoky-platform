import { describe, expect, it } from 'vitest';
import { containsDocumentActionClaim } from './document-summary-claim-guard';
import { neutralizeLinks } from './link-neutralizer';

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
    // Re-review item 3: curly apostrophes, filler words, 처리 forms, and subjects that must not exempt.
    'I’ve forwarded the email to your team.',
    'We’ve archived it.',
    'I went ahead and sent the reply.',
    "I've just forwarded it to accounting.",
    'I have now gone ahead and quickly sent it.',
    'I’d already deleted the thread.',
    '메일을 삭제 처리했어요.',
    '보관 처리 완료했습니다.',
    '전달 처리해 드렸어요.',
    '읽음 처리했어요.',
    '김철수 님께 회신했습니다.',
    '자료를 전달해 드렸어요.',
    '안내 메일을 발송했어요.',
    '같이 답장을 보냈어요.',
    '요청하신 내용이 맞아서 답장을 보냈어요.',
    '비서가 답장을 보냈어요.',
    '저희가 메일을 보관했어요.',
    'Quoky가 메일을 삭제했어요.',
    '답장을 보냈어요, 김철수가 요청해서요.',
    '답장을 보냈답니다.',
    // Sign-off item 3: a Quoky stand-in anywhere before the claim blocks the exemption (relative clauses).
    '제가 김철수가 요청한 답장을 보냈어요.',
    '제가 고객님이 요청하신 회신을 보냈습니다.',
    '저희가 팀장님이 말한 메일을 삭제했어요.',
    'I가 김철수가 요청한 답장을 보냈어요.',
    // Known false positives that fail closed (recorded in the live-QA list).
    '쿠팡에서 배송 안내 메일을 보냈어요.',
    '김철수 님은 "제가 메일을 보냈어요"라고 썼어요.',
  ])('withholds: %s', (text) => {
    expect(containsDocumentActionClaim(text)).toBe(true);
  });

  it.each([
    // Third-person sentences about the sender stay allowed.
    '김철수가 회의 자료를 보냈어요.',
    '김철수 님이 견적서 메일을 보냈어요.',
    '김철수가 메일을 보냈어요.',
    '인사팀에서는 팀장님이 메일을 전달했어요.',
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

describe('final sign-off W-1: the claim is found in the text the owner is shown', () => {
  it.each([['I se​nt the reply.'], ['Ｉ ｓｅｎｔ the reply.'], ['답장을 보​냈어요.']])(
    '%j is a claim once normalized for display',
    (text) => {
      expect(containsDocumentActionClaim(neutralizeLinks(text, 'display'))).toBe(true);
    },
  );
});

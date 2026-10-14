import { describe, expect, it } from 'vitest';
import {
  containsDocumentActionClaim,
  normalizeForClaimCheck,
  renderDocumentActionClaimWithheld,
} from './document-summary-claim-guard';
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
    expect(containsDocumentActionClaim(text, 'mail')).toBe(true);
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
    expect(containsDocumentActionClaim(text, 'mail')).toBe(false);
  });

  it('is linear on a long hostile reply', () => {
    const start = performance.now();
    containsDocumentActionClaim(`${'할 일 '.repeat(20_000)}${'가 '.repeat(20_000)}`, 'mail');
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('final sign-off W-1: the claim is found in the text the owner is shown', () => {
  it.each([['I se​nt the reply.'], ['Ｉ ｓｅｎｔ the reply.'], ['답장을 보​냈어요.']])(
    '%j is a claim once normalized for display',
    (text) => {
      expect(containsDocumentActionClaim(neutralizeLinks(text, 'display'), 'mail')).toBe(true);
    },
  );
});

describe('Codex final delta: an adverb before the verb, and an emphatic did', () => {
  it.each([['제가 답장을 대신 보냈습니다.'], ['답장을 방금 바로 보냈어요.'], ['I did send a reply.'], ['We did actually forward it.']])(
    '%j is withheld',
    (text) => expect(containsDocumentActionClaim(text, 'mail')).toBe(true),
  );
  it.each([['I did not send anything.'], ["I didn't forward the mail."], ['김철수가 답장을 대신 보냈어요.']])(
    '%j is not a claim',
    (text) => expect(containsDocumentActionClaim(text, 'mail')).toBe(false),
  );
});

describe('DRV-1: document actions (a Drive summary steered into an edit, share or permission claim)', () => {
  it.each([
    '문서를 공유했어요.',
    '파일을 삭제해 드렸어요.',
    '권한을 변경했어요.',
    '이 문서를 팀 전체에 공유해 드렸어요.',
    '스프레드시트를 수정했습니다.',
    '시트를 휴지통으로 옮겼어요.',
    '폴더를 다른 곳으로 옮겼어요.',
    '문서 이름을 바꿨어요.',
    '제가 문서를 편집해 두었어요.',
    '제가 답장을 보냈어요.',
    '요약했고 제가 답장을 보냈어요.',
    'Quoky가 링크를 공유했어요.',
    'I shared the document with your team.',
    "I've renamed the file.",
    'We edited the spreadsheet and created a to-do.',
    'I went ahead and uploaded a copy.',
    'I did share the doc.',
    // CA review P3-1
    '문서 공유를 완료했어요.',
    '편집 권한을 드렸어요.',
    '팀원들에게 공유했어요.',
    '요청대로 내용을 수정해 두었어요.',
    '문서를 업데이트했어요.',
    "I've updated the document as requested.",
    'I changed the permissions.',
    'I gave Kim edit access.',
    'I made the document public.',
    'I did change the sharing settings.',
  ])('withholds: %s', (text) => {
    expect(containsDocumentActionClaim(text, 'drive')).toBe(true);
  });

  it.each([
    // Third-person, reported speech and ordinary meeting-notes prose stay allowed.
    '김철수 님이 회의 결과를 팀에 공유했어요.',
    '팀장님이 문서를 수정했어요.',
    '진행 상황을 공유했어요.',
    '버그를 수정했다는 내용이에요.',
    '문서를 공유해 달라는 요청이에요.',
    '이 문서는 3월에 마지막으로 수정되었어요.',
    // CA review P3-2: reported speech with `다고` is not split into a clause that loses its `다고`.
    '답장을 보냈다고 해요.',
    '문서를 공유했다고 해요.',
    'Kim shared the roadmap with the team.',
    '김철수가 문서를 업데이트했어요.',
    '김철수가 내용을 수정해 두었어요.',
    'Kim updated the document and gave Lee edit access.',
    'The document asks you to share it by Friday.',
    'I did not share anything.',
  ])('allows: %s', (text) => {
    expect(containsDocumentActionClaim(text, 'drive')).toBe(false);
  });

  it('is linear on a long hostile reply with the document nouns', () => {
    const start = performance.now();
    containsDocumentActionClaim(`${'문서를 '.repeat(20_000)}${'가 '.repeat(20_000)}`, 'drive');
    containsDocumentActionClaim(`${'파일 '.repeat(30_000)}공유`, 'drive');
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('the Drive notice names document actions; the mail notice is unchanged', () => {
    expect(renderDocumentActionClaimWithheld('ko', 'drive')).toContain('문서를 읽기만 했고');
    expect(renderDocumentActionClaimWithheld('en', 'drive')).toContain('Quoky only read the document');
    expect(renderDocumentActionClaimWithheld('ko', 'mail')).toContain('메일을 읽기만 했고');
    expect(renderDocumentActionClaimWithheld('en', 'mail')).toContain('Quoky only read the email');
  });
});

describe('CA re-review item 1: the Drive wordings are scoped to a Drive summary', () => {
  const mailNews = [
    '계약서 내용을 수정했으니 검토해 달라는 요청이에요.',
    '약관 업데이트를 했으니 확인하라는 메일이에요.',
    'Acme writes: "We changed our pricing."',
    'The sender says we updated our privacy policy.',
  ];
  it.each(mailNews)('mail: shown (parity with the pre-DRV-1 guard): %s', (text) => {
    expect(containsDocumentActionClaim(text, 'mail')).toBe(false);
  });
  it.each([
    '요청대로 내용을 수정해 두었어요.',
    '문서를 업데이트했어요.',
    "I've updated the document as requested.",
    'We changed the permissions.',
  ])('drive: still withheld: %s', (text) => {
    expect(containsDocumentActionClaim(text, 'drive')).toBe(true);
  });
});

/**
 * CA review P2-A: the mail guard is exactly the pre-DRV-1 guard. Each row is `[text, result]` as the origin/main guard
 * (`document-summary-claim-guard.ts` before DRV-1) returned it, captured as a fixture. Note `답장을 보냈다고 해요.` is
 * withheld there (the `다고` split is a Drive-only fix) and every Drive wording is shown for mail.
 */
const MAIN_MAIL_GUARD_FIXTURE: ReadonlyArray<readonly [string, boolean]> = [
  ["The sender writes: 'We shared the document with the team.'", false],
  ["계약서 내용을 수정했으니 검토해 달라는 요청이에요.", false],
  ["약관 업데이트를 했으니 확인하라는 메일이에요.", false],
  ["Acme writes: \"We changed our pricing.\"", false],
  ["The sender says we updated our privacy policy.", false],
  ["김철수 님이 첨부 문서를 공유했어요.", false],
  ["첨부 문서를 공유했어요.", false],
  ["We shared the attachment with the team.", false],
  ["I edited the draft.", false],
  ["진행 상황을 공유했어요.", false],
  ["문서를 공유했다고 해요.", false],
  ["답장을 보냈다고 해요.", true],
  ["제가 답장을 보냈어요.", true],
  ["답장을 보냈어요.", true],
  ["자동이체 알림을 설정했다는 안내 메일이에요.", false],
  ["김철수가 메일을 보냈어요.", false],
  ["I forwarded the email to your team.", true],
  ["I did send a reply.", true],
  ["I did change the sharing settings.", false],
  ["I made the document public.", false],
  ["편집 권한을 드렸어요.", false],
  ["팀원들에게 공유했어요.", false],
  ["요청대로 내용을 수정해 두었어요.", false],
  ["문서를 업데이트했어요.", false],
  ["문서 공유를 완료했어요.", false],
  ["이 문서는 3월에 마지막으로 수정되었어요.", false],
  ["파일을 삭제해 드렸어요.", true],
  ["문서가 공유했어요.", false],
  ["권한을 변경했어요.", false],
  ["문서 이름을 바꿨어요.", false],
  ["I've renamed the file.", false],
  ["I gave Kim edit access.", false],
  ["Kim shared the roadmap with the team.", false],
  ["메일을 삭제했어요.", true],
  ["할 일을 하나 추가했어요.", true],
  ["내일 9시에 알림을 설정해 두었어요.", true],
  ["요약했고 문서를 공유했어요.", false],
  ["문서를 수정했고 답장을 보냈어요.", true],
];

describe('CA review P2-A: mail parity with the origin/main guard', () => {
  it.each(MAIN_MAIL_GUARD_FIXTURE)('mail: %s -> %s', (text, expected) => {
    expect(containsDocumentActionClaim(text, 'mail')).toBe(expected);
  });
});

describe('CA review P2-B: every pattern is linear (CPU time, not wall-clock)', () => {
  const cpuMs = (fn: () => void): number => {
    const before = process.cpuUsage();
    fn();
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  };
  const N = 32_000;
  const repeat = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const hostile: Record<string, string> = {
    '문서': repeat('문서'),
    '공유': repeat('공유'),
    '권한': repeat('권한'),
    'I have': repeat('I have '),
    '문서를 ': repeat('문서를 '),
    'spaces': `문서${' '.repeat(N)}`,
    'long words': `I ${'a'.repeat(N)}`,
    'we did': repeat('we did '),
    'mixed': repeat('문서를 공유 권한을 I have did made 내용을 에게 업데이트 할 일 알림 '),
    'no separators': repeat('문서공유권한내용업데이트에게알림할일'),
    // v5: the normalizer, the predicate scan, the actor scan and the English sentence checks.
    'split names': repeat('Q-u-o-k-쿼 '),
    'invisible': repeat('Q\u200bu\u3164o\u0301'),
    'subject and predicates': `김철수님이 ${repeat('부탁하셔서 ')}메일을 보내 드렸습니다`,
    'subjects': repeat('김철수가 메일을 '),
    'sentences': repeat('제가. 비서가. 김철수가 메일을 보냈어요. '),
    'passive': repeat('has been on your behalf '),
  };
  it.each(Object.keys(hostile))('%s: 32,000 characters, both sources, under 100 ms CPU each', (name) => {
    const text = hostile[name] as string;
    for (const source of ['mail', 'drive'] as const) {
      expect(cpuMs(() => containsDocumentActionClaim(text, source)), `${name} ${source}`).toBeLessThan(100);
    }
  });
});

describe('v5 W3: the guard stays strict — the widened-exemption bypass family stays blocked (Codex P2)', () => {
  it.each([
    '고객팀은 확인했고 메일을 보냈습니다, Quoky가 대신.',
    '고객팀은 확인했고 답장을 보냈습니다, Quoky가 대신.',
    '고객팀은 확인했고 메일을 보관했습니다, Quoky가 대신.',
    '고객팀은 확인했고 메일을 삭제했습니다, 비서가 대신.',
    '고객팀은 확인했고 일정을 캘린더에 등록했습니다, 저희가 대신.',
    '고객팀은 확인했고 Quoky에서 메일을 보냈습니다.',
    '고객팀은 확인했고 저희 측에서 답장을 보냈습니다.',
    '고객팀이 확인했고 제가 메일을 보냈습니다.',
    'Quo ky가 확인했고 메일을 보냈습니다.',
    'Quo​ky에서 메일을 보냈습니다.',
    'Gmail 팀은 새 받은편지함 사용 방법을 담은 메일을 보냈어요.',
    '김철수 님이 내용을 확인하고 답장했어요.',
  ])('withholds: %s', (text) => {
    for (const source of ['mail', 'mail-thread'] as const) expect(containsDocumentActionClaim(text, source)).toBe(true);
  });
});

/**
 * v5 claim guard: the three gaps recorded under the v5 W3 decision (ADR-0118 amendment implementation note, thread
 * summary claim guard false positive) are closed. Each row was NOT withheld by the origin/main guard.
 */
const SOURCES = ['mail', 'mail-thread', 'drive'] as const;

describe('v5 gap 1: a split, disguised or decorated Quoky name is Quoky', () => {
  it.each([
    'Quo-ky가 메일을 보냈습니다.',
    'Quo ky가 확인하고 메일을 보냈습니다.',
    'Quo​ky가 메일을 보냈어요.',
    'Quo⁠ky가 답장을 보냈어요.',
    'Quoㅤky가 메일을 보냈어요.', // Hangul filler
    'Quoﾠky가 메일을 보냈어요.', // half-width Hangul filler
    'Q.u.o.k.y가 메일을 삭제했어요.',
    'Quo_ky가 회신했습니다.',
    'Qu0ky가 메일을 보관했어요.',
    'Ｑｕｏｋｙ가 메일을 보냈어요.', // full-width
    'Ｑｕｏ－ｋｙ가 메일을 보냈어요.',
    'Ԛuoky가 메일을 보냈어요.', // Cyrillic Qa
    'Quоky가 메일을 보냈어요.', // Cyrillic o
    'Quokу가 메일을 보냈어요.', // Cyrillic u (y)
    'Quoκy가 메일을 보냈어요.', // Greek kappa
    'Q̈uoky가 메일을 보냈어요.', // combining diaeresis
    'Quóky가 답장을 보냈어요.', // combining acute
    '쿼 키가 메일을 보냈어요.',
    '쿼​키가 메일을 보냈어요.',
    'Quoky봇이 메일을 보냈어요.',
    'Quo-ky sent the reply.',
    'Q u o k y has forwarded the email.',
    'Ι sent the reply.', // Greek capital iota as `I`
    'І’ve forwarded it.', // Cyrillic I
    'I​sent the reply.',
    'Iㅤsent the reply.',
  ])('withholds: %j', (text) => {
    for (const source of SOURCES) expect(containsDocumentActionClaim(text, source), source).toBe(true);
  });
});

describe('v5 gap 2: a third-party subject exempts only the claim of its own verb', () => {
  it.each([
    // The recorded gap: the subject belongs to a connective clause, the benefactive claim has no subject.
    '김철수님이 부탁하셔서 메일을 보내 드렸습니다.',
    '김철수님이 부탁하셔서 메일을 보내 놓았습니다.',
    '김철수 님이 요청해서 답장을 보냈어요.',
    '김철수가 요청했는데 메일을 보냈어요.',
    '김철수가 요청하니까 답장을 보냈어요.',
    '김철수가 원하면 메일을 보냈어요.',
    '김철수님이 부탁해, 메일을 보내 드렸어요.',
    // A relative clause: the subject is the requester, not the actor.
    '김철수가 요청한 메일을 보냈어요.',
    '김철수가 보낸 메일을 전달했어요.',
    '김철수 님이 부탁하신 답장을 보냈습니다.',
    '김철수가 받은 메일을 삭제했어요.',
    '사용자님이 요청하신 브랜치를 삭제했습니다.',
    // An honorific subject never exempts a humble benefactive claim (an honoured subject would take -시-).
    '김철수님이 메일을 보내 드렸습니다.',
    '팀장님께서 답장을 전달해 드렸어요.',
    // Benefactive and completed forms with no subject are first-person claims.
    '메일을 보내 놓았습니다.',
    '메일을 보내 뒀어요.',
    '답장을 전달해 뒀어요.',
    '처리해 드렸습니다.',
    '요청하신 건은 처리 완료했습니다.',
    '할 일을 추가해 놨어요.',
  ])('withholds: %s', (text) => {
    for (const source of SOURCES) expect(containsDocumentActionClaim(text, source), source).toBe(true);
  });
});

describe('v5 gap 3: a claim is judged with the reply around it', () => {
  it.each([
    'Quoky가 처리했습니다. 김철수가 요청한 메일을 보냈습니다.',
    'Quoky가 확인했습니다. 김철수가 메일을 보냈습니다.',
    'Quoky는 확인만 했어요. 김철수 님이 답장을 보냈어요.',
    '제가 확인했어요.\n김철수 님이 메일을 보냈어요.',
    '김철수 님이 메일을 보냈어요.\n물론 제가 대신요.',
    '저희 측에서 검토했어요. 김철수가 메일을 보관했어요.',
    '비서가 확인했어요. 김철수가 답장을 보냈어요.',
    '김철수가 답장을 보냈어요. 비서가 대신 했어요.',
    'Quoky가\n메일을 보냈어요.',
    'Quoky\n가 메일을 보냈어요.',
    'Quoky here. Sent the reply.',
    'Done — forwarded it to Kim.',
    '- Archived the thread.',
    'The reply has been sent on your behalf.',
    'On your behalf, the email was forwarded to accounting.',
    'The invite was scheduled as you requested.',
    'Your reply was sent to Kim.',
    "I've sent the reply.",
  ])('withholds: %j', (text) => {
    for (const source of SOURCES) expect(containsDocumentActionClaim(text, source), source).toBe(true);
  });
});

describe('v5: legitimate third-party reports still pass', () => {
  it.each([
    '김철수님이 메일을 보냈습니다.',
    '김철수 님이 견적서 메일을 보냈어요.',
    '김철수가 메일을 보냈어요. 이영희 님이 답장을 보냈어요.',
    '김철수가 고객에게 메일을 보내 드렸어요.',
    '김철수님이 부탁하셔서 이영희가 메일을 보냈어요.',
    '인사팀에서는 팀장님이 메일을 전달했어요.',
    '시스템 점검 안내예요. 김철수 님이 공지 메일을 보냈어요.',
    'quoky-platform 저장소 알림이에요. 김철수가 리뷰 메일을 보냈어요.',
    'the PR was merged by Alice',
    'The PR was merged by Alice.',
    'Kim sent the slides and asked for comments by Friday.',
    'The email was sent to all staff.',
    'Kim forwarded the invoice on behalf of the finance team.',
    'Set up a meeting with Kim by Friday.',
  ])('allows: %j', (text) => {
    for (const source of ['mail', 'mail-thread'] as const) expect(containsDocumentActionClaim(text, source), source).toBe(false);
  });

  it.each([
    // Known false positives that fail closed: an adjective adnominal reads as a relative clause, a third-party report
    // split across a line break loses its subject, and a generic stand-in nearby removes the exemption.
    '김철수 님이 급한 메일을 보냈어요.',
    '김철수가\n메일을 보냈어요.',
    // A generic stand-in (`AI가`) in a neighbouring sentence withholds a third-party report.
    'AI가 업무를 바꾼다는 기사예요. 김철수 님이 이 기사를 메일로 보냈어요.',
  ])('fails closed: %j', (text) => {
    expect(containsDocumentActionClaim(text, 'mail')).toBe(true);
  });

  it('normalizes without changing ordinary text', () => {
    expect(normalizeForClaimCheck('김철수 님이 견적서 메일을 보냈어요.')).toBe('김철수 님이 견적서 메일을 보냈어요.');
    expect(normalizeForClaimCheck('Quo-ky와 쿼 키')).toBe('Quoky와 쿼키');
    expect(normalizeForClaimCheck('보​냈어요', '')).toBe('보냈어요');
    expect(normalizeForClaimCheck('I​sent', ' ')).toBe('I sent');
  });
});

import { describe, expect, it } from 'vitest';
import type { ConnectorItem, ConnectorItemDetail, ConnectorItemSection } from '../../ports';
import { plainTextOf } from '../message-rendering';
import { renderUntrustedDocumentForPrompt } from '../untrusted-document-readout';
import {
  WORK_ITEM_SECTION_MAX_CHARS,
  buildWorkItemReadout,
  pseudonymLabel,
  pseudonymiseParticipants,
  renderWorkItemFailure,
  renderWorkItemFallback,
  renderWorkItemFooter,
  workItemBytesBucket,
  workItemFetchOutcome,
  workItemLabel,
  workItemNotes,
  type WorkItemMode,
  type WorkItemScope,
  type WorkItemSource,
} from './work-item-summary';

function detail(sections: ConnectorItemSection[], extra: Partial<ConnectorItemDetail> = {}): ConnectorItemDetail {
  return { sections, partial: false, people: [], requests: 1, bytes: 100, ...extra };
}
function item(sections: ConnectorItemSection[], extra: Partial<ConnectorItem> = {}, d: Partial<ConnectorItemDetail> = {}): ConnectorItem {
  return { id: 'PROJ-1', title: '결제 오류 수정', itemRef: 'PROJ-1:10001', detail: detail(sections, d), ...extra };
}
function build(source: WorkItemSource, scope: WorkItemScope, mode: WorkItemMode, it: ConnectorItem) {
  return buildWorkItemReadout({ source, scope, mode, item: it });
}
function ok(result: ReturnType<typeof build>) {
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  return result;
}
const text = (body: Parameters<typeof plainTextOf>[0]): string => plainTextOf(body);

describe('buildWorkItemReadout: sections and bounds', () => {
  it('titles Jira sections with Quoky copy', () => {
    const r = ok(
      build('jira', 'item', 'summary', item([{ kind: 'description', text: '설명 본문입니다' }, { kind: 'comment', text: '첫 댓글' }, { kind: 'comment', text: '둘째 댓글' }])),
    );
    expect(r.readout.source).toBe('jira-issue');
    expect(r.readout.body).toContain('[Part 1/3] "설명"');
    expect(r.readout.body).toContain('[Part 2/3] "댓글 1"');
    expect(r.readout.body).toContain('[Part 3/3] "댓글 2"');
    expect(r.readout.body).not.toContain('Sheet');
  });

  it('titles Slack message and thread sections', () => {
    const message = ok(build('slack', 'item', 'summary', item([{ kind: 'message', author: 'U01ABC', text: '배포 언제 하나요' }], { id: 'C1:1.1' })));
    expect(message.readout.source).toBe('slack-message');
    expect(message.readout.body).toContain('"메시지 · 참여자 A"');
    const thread = ok(
      build(
        'slack',
        'thread',
        'summary',
        item([
          { kind: 'message', author: 'U01ABC', text: '원글 내용' },
          { kind: 'message', author: 'U02DEF', text: '답 하나' },
          { kind: 'message', author: 'U01ABC', text: '답 둘' },
        ]),
      ),
    );
    expect(thread.readout.source).toBe('slack-thread');
    expect(thread.readout.body).toContain('"원글 · 참여자 A"');
    expect(thread.readout.body).toContain('"답글 1 · 참여자 B"');
    expect(thread.readout.body).toContain('"답글 2 · 참여자 A"');
  });

  it('clips each section head and tail at 1,200 code points and marks the readout truncated', () => {
    expect(WORK_ITEM_SECTION_MAX_CHARS).toBe(1_200);
    const long = `HEAD${'가'.repeat(5_000)}TAIL`;
    const r = ok(build('jira', 'item', 'full', item([{ kind: 'description', text: long }])));
    expect(r.readout.truncated).toBe(true);
    expect(r.readout.body).toContain('HEAD');
    expect(r.readout.body).toContain('TAIL');
    expect(Array.from(r.readout.body).length).toBeLessThan(1_500);
    expect(r.totalChars).toBe(5_008);
  });

  it('keeps the first 10 and the last 10 of a thread with more than 20 messages and marks it truncated', () => {
    const sections: ConnectorItemSection[] = Array.from({ length: 25 }, (_, i) => ({ kind: 'message', author: 'U01ABC', text: `메시지번호${String(i).padStart(2, '0')}` }));
    const r = ok(build('slack', 'thread', 'summary', item(sections)));
    expect(r.readout.truncated).toBe(true);
    const body = r.readout.body;
    for (let i = 0; i < 10; i += 1) expect(body).toContain(`메시지번호${String(i).padStart(2, '0')}`);
    for (let i = 15; i < 25; i += 1) expect(body).toContain(`메시지번호${String(i).padStart(2, '0')}`);
    for (let i = 10; i < 15; i += 1) expect(body).not.toContain(`메시지번호${String(i).padStart(2, '0')}`);
    expect(body).toContain('[Part 20/20]');
  });

  it('keeps the whole body within 3,000 code points', () => {
    const sections: ConnectorItemSection[] = Array.from({ length: 12 }, (_, i) => ({ kind: i === 0 ? 'description' : 'comment', text: `${i}`.repeat(1_100) }));
    const r = ok(build('jira', 'item', 'full', item(sections)));
    expect(Array.from(r.readout.body).length).toBeLessThanOrEqual(3_000);
    expect(r.readout.truncated).toBe(true);
  });

  it('marks the readout truncated when the adapter says the item is partial', () => {
    const r = ok(build('jira', 'item', 'full', item([{ kind: 'description', text: '짧음' }], {}, { partial: true })));
    expect(r.readout.truncated).toBe(true);
  });

  it('refuses a credential-shaped section and an empty item', () => {
    const secret = build('jira', 'item', 'summary', item([{ kind: 'description', text: '정상 내용' }, { kind: 'comment', text: 'password: hunter2abc123XYZ' }]));
    expect(secret).toEqual({ ok: false, refusal: 'CREDENTIAL_SHAPED' });
    expect(build('jira', 'item', 'summary', item([]))).toEqual({ ok: false, refusal: 'EMPTY' });
    expect(build('jira', 'item', 'summary', item([{ kind: 'description', text: '   ' }]))).toEqual({ ok: false, refusal: 'EMPTY' });
    expect(build('jira', 'item', 'summary', { id: 'X-1', title: 't' })).toEqual({ ok: false, refusal: 'EMPTY' });
  });
});

describe('buildWorkItemReadout: people (D5)', () => {
  const jira = item(
    [
      { kind: 'description', text: 'Kim Chulsoo 님이 Kim 에게 넘겼고 이영희 도 봤어요' },
      { kind: 'comment', author: 'Kim Chulsoo', text: '확인했어요 @이영희' },
      { kind: 'comment', author: 'Kim', text: '저도 봤어요' },
    ],
    { title: '이영희 요청 건' },
    { people: ['Kim Chulsoo', 'Kim', '이영희'] },
  );

  it('summary mode pseudonymises Jira names, longest first, in first-appearance order, nowhere visible to a model', () => {
    const r = ok(build('jira', 'item', 'summary', jira));
    const prompt = renderUntrustedDocumentForPrompt(r.readout);
    for (const name of ['Kim Chulsoo', 'Kim', '이영희', 'Chulsoo']) expect(prompt).not.toContain(name);
    expect(prompt).toContain('참여자 A');
    expect(prompt).toContain('참여자 B');
    expect(prompt).toContain('참여자 C');
    // "Kim Chulsoo" is replaced whole (never "참여자 B Chulsoo").
    expect(prompt).not.toMatch(/참여자 [A-Z] Chulsoo/);
    expect(r.readout.title).toMatch(/^참여자 [A-C] 요청 건$/);
  });

  it('assigns letters by first appearance in the readout', () => {
    const r = ok(
      build(
        'slack',
        'thread',
        'summary',
        item(
          [
            { kind: 'message', author: 'U0ZZZ', text: '원글' },
            { kind: 'message', author: 'U0AAA', text: '답글 <@U0BBB> 님' },
          ],
          { id: 'C1:1.1' },
          { people: ['U0AAA', 'U0BBB', 'U0ZZZ'] },
        ),
      ),
    );
    expect(r.readout.body).toContain('"원글 · 참여자 A"');
    expect(r.readout.body).toContain('"답글 1 · 참여자 B"');
    expect(r.readout.body).toContain('참여자 C');
    const prompt = renderUntrustedDocumentForPrompt(r.readout);
    for (const id of ['U0ZZZ', 'U0AAA', 'U0BBB']) expect(prompt).not.toContain(id);
  });

  it('full mode keeps Jira display names but still pseudonymises Slack', () => {
    const full = ok(build('jira', 'item', 'full', jira));
    expect(full.readout.body).toContain('댓글 1 · Kim Chulsoo');
    expect(full.readout.body).toContain('이영희');
    const slack = ok(build('slack', 'item', 'full', item([{ kind: 'message', author: 'U01ABC', text: '<@U02DEF> 확인 부탁해요' }], { id: 'C1:1.1' }, { people: ['U01ABC', 'U02DEF'] })));
    expect(slack.readout.body).not.toContain('U01ABC');
    expect(slack.readout.body).not.toContain('U02DEF');
    expect(slack.readout.body).toContain('참여자');
  });

  it('does not name an author the adapter reports as unknown', () => {
    const r = ok(build('jira', 'item', 'full', item([{ kind: 'comment', author: 'unknown', text: '내용' }])));
    expect(r.readout.body).toContain('"댓글 1"');
  });
});

describe('pseudonymLabel', () => {
  it('runs A..Z then A2..', () => {
    expect(pseudonymLabel(0)).toBe('참여자 A');
    expect(pseudonymLabel(1)).toBe('참여자 B');
    expect(pseudonymLabel(25)).toBe('참여자 Z');
    expect(pseudonymLabel(26)).toBe('참여자 A2');
    expect(pseudonymLabel(52)).toBe('참여자 A3');
  });
});

describe('workItemNotes', () => {
  const base = (d: Partial<ConnectorItemDetail>, extra: Partial<ConnectorItem> = {}) => item([{ kind: 'description', text: 'x' }], extra, d);
  const notes = (it: ConnectorItem, extra: { source?: WorkItemSource; scope?: WorkItemScope; listedKey?: string; listingAt?: string } = {}) =>
    workItemNotes({ source: extra.source ?? 'jira', scope: extra.scope ?? 'item', item: it, ...(extra.listedKey !== undefined ? { listedKey: extra.listedKey } : {}), ...(extra.listingAt !== undefined ? { listingAt: extra.listingAt } : {}) });

  it('has no notes for a complete item', () => {
    expect(notes(base({}))).toEqual([]);
    expect(notes({ id: 'a', title: 'b' })).toEqual([]);
  });

  it('states a partial comment page exactly', () => {
    expect(notes(base({ comments: { total: 30, returned: 20, kept: 20 } }))).toEqual(['댓글 30개 중 앞쪽 20개만 받았어요. 최근 댓글 10개는 읽지 않았어요.']);
  });

  it('states the D12 newest wording', () => {
    expect(notes(base({ comments: { total: 30, returned: 10, kept: 10, newest: true } }))).toEqual(['댓글 30개 중 최근 10개만 읽었어요.']);
  });

  it('states a description-only read', () => {
    expect(notes(base({ descriptionOnly: true, comments: { total: 99, returned: 0, kept: 0 } }))).toEqual(['댓글은 너무 많아 읽지 않았어요.']);
  });

  it('states a validated move only when the key differs', () => {
    expect(notes(base({ movedTo: 'NEW-3' }), { listedKey: 'PROJ-12' })).toEqual(['PROJ-12 → NEW-3으로 옮겨졌어요.']);
    expect(notes(base({ movedTo: 'PROJ-12' }), { listedKey: 'PROJ-12' })).toEqual([]);
  });

  it('notes an edit after the listing', () => {
    const it = base({}, { updatedAt: '2026-10-10T10:00:00Z' });
    expect(notes(it, { listingAt: '2026-10-10T09:00:00Z' })).toEqual(['목록 이후 수정됨']);
    expect(notes(it, { listingAt: '2026-10-10T10:00:00Z' })).toEqual([]);
    expect(notes(it, { listingAt: '2026-10-10T11:00:00Z' })).toEqual([]);
  });

  it('notes the replies of a Slack message, only for the item scope', () => {
    const it = base({ replyCount: 3 });
    expect(notes(it, { source: 'slack', scope: 'item' })).toEqual(["스레드 답글 3개가 있어요. '스레드 요약'이라고 하시면 함께 볼게요."]);
    expect(notes(it, { source: 'slack', scope: 'thread' })).toEqual([]);
    expect(notes(base({ replyCount: 0 }), { source: 'slack', scope: 'item' })).toEqual([]);
  });

  it('notes a cut thread page', () => {
    expect(notes(base({ hasMore: true }), { source: 'slack', scope: 'thread' })).toEqual(['답글이 더 있지만 앞부분만 읽었어요.']);
  });
});

describe('renderWorkItemFailure (proposal §5)', () => {
  const copy = (source: WorkItemSource, reason: Parameters<typeof renderWorkItemFailure>[1], link?: string) => text(renderWorkItemFailure(source, reason, link));

  it('Jira copy for every reason', () => {
    expect(copy('jira', 'UNAUTHORIZED')).toBe('지라 인증이 만료됐어요. 토큰을 확인해 주세요.');
    expect(copy('jira', 'NOT_FOUND')).toBe('그 이슈를 찾을 수 없어요. 삭제됐거나 볼 권한이 없을 수 있어요.');
    expect(copy('jira', 'FORBIDDEN')).toBe('그 이슈를 볼 권한이 없어요.');
    expect(copy('jira', 'MOVED')).toBe('그 이슈는 다른 곳으로 옮겨졌어요. 목록을 다시 보여 드릴까요?');
    expect(copy('jira', 'RATE_LIMITED')).toBe('지금은 요청이 많아요. 잠시 후 다시 말씀해 주세요.');
    expect(copy('jira', 'UNAVAILABLE')).toBe('지라에 지금 연결할 수 없어요.');
    expect(copy('jira', 'TOO_LARGE')).toBe('이 이슈는 너무 커서 읽지 못했어요. 지라에서 직접 열어 주세요.');
  });

  it('Jira too-large reply carries the deterministic link', () => {
    const out = copy('jira', 'TOO_LARGE', 'https://acme.atlassian.net/browse/PROJ-1');
    expect(out).toContain('지라에서 직접 열어 주세요.');
    expect(out).toContain('https://acme.atlassian.net/browse/PROJ-1');
  });

  it('Slack copy', () => {
    expect(copy('slack', 'UNAUTHORIZED')).toBe('슬랙 인증이 만료됐어요. 토큰을 확인해 주세요.');
    expect(copy('slack', 'INSUFFICIENT_SCOPE')).toBe('비공개 채널 메시지는 읽을 권한이 없어요.');
    expect(copy('slack', 'NOT_FOUND')).toBe('메시지가 삭제됐거나 찾을 수 없어요.');
    expect(copy('slack', 'FORBIDDEN')).toBe('그 채널 메시지를 읽을 권한이 없어요.');
    expect(copy('slack', 'MOVED')).toBe('메시지가 삭제됐거나 찾을 수 없어요.');
    expect(copy('slack', 'UNAVAILABLE')).toBe('슬랙에 지금 연결할 수 없어요.');
    expect(copy('slack', 'TOO_LARGE')).toBe('이 메시지는 너무 커서 읽지 못했어요. 슬랙에서 직접 열어 주세요.');
  });
});

describe('audit helpers', () => {
  it('workItemFetchOutcome maps to the closed values', () => {
    expect(workItemFetchOutcome('NOT_FOUND')).toBe('not-found');
    expect(workItemFetchOutcome('FORBIDDEN')).toBe('forbidden');
    expect(workItemFetchOutcome('INSUFFICIENT_SCOPE')).toBe('scope');
    expect(workItemFetchOutcome('MOVED')).toBe('moved');
    expect(workItemFetchOutcome('RATE_LIMITED')).toBe('rate-limited');
    expect(workItemFetchOutcome('TOO_LARGE')).toBe('too-large');
    expect(workItemFetchOutcome('INVALID_RESPONSE')).toBe('invalid-response');
    expect(workItemFetchOutcome('UNAVAILABLE')).toBe('unavailable');
    expect(workItemFetchOutcome('UNAUTHORIZED')).toBe('unavailable');
    expect(workItemFetchOutcome('TIMEOUT')).toBe('unavailable');
  });

  it('workItemBytesBucket is content-free', () => {
    expect(workItemBytesBucket(undefined)).toBe('0');
    expect(workItemBytesBucket(0)).toBe('0');
    expect(workItemBytesBucket(-5)).toBe('0');
    expect(workItemBytesBucket(Number.NaN)).toBe('0');
    expect(workItemBytesBucket(1)).toBe('<1KiB');
    expect(workItemBytesBucket(1_023)).toBe('<1KiB');
    expect(workItemBytesBucket(1_024)).toBe('<16KiB');
    expect(workItemBytesBucket(16 * 1_024)).toBe('<128KiB');
    expect(workItemBytesBucket(128 * 1_024)).toBe('<1MiB');
    expect(workItemBytesBucket(1_048_575)).toBe('<1MiB');
    expect(workItemBytesBucket(1_048_576)).toBe('>=1MiB');
  });

  it('workItemLabel', () => {
    expect(workItemLabel('jira', 2)).toBe('지라 이슈 2번');
    expect(workItemLabel('slack', 3)).toBe('슬랙 메시지 3번');
    expect(workItemLabel('slack', 3, 'thread')).toBe('슬랙 스레드 3번');
    expect(workItemLabel('jira', undefined)).toBe('그 지라 이슈');
    expect(workItemLabel('slack', undefined, 'thread')).toBe('그 슬랙 스레드');
  });
});

describe('footer and fallback', () => {
  it('Jira footer carries the id, the link from item.url and the notes', () => {
    const it = item([{ kind: 'description', text: 'x' }], { url: 'https://acme.atlassian.net/browse/PROJ-1' });
    const out = text(renderWorkItemFooter('jira', 'item', 2, it, ['목록 이후 수정됨']));
    expect(out).toBe('출처: PROJ-1 https://acme.atlassian.net/browse/PROJ-1\n목록 이후 수정됨');
  });

  it('Jira footer without a usable url has no link', () => {
    const out = text(renderWorkItemFooter('jira', 'item', 2, item([{ kind: 'description', text: 'x' }]), []));
    expect(out).toBe('출처: PROJ-1');
  });

  it('Slack footer names the list number and never links', () => {
    const it = item([{ kind: 'message', text: 'x' }], { id: 'C1:1.1', url: 'https://acme.slack.com/archives/C1/p1' });
    expect(text(renderWorkItemFooter('slack', 'item', 4, it, []))).toBe('출처: 슬랙 목록 4번');
    expect(text(renderWorkItemFooter('slack', 'thread', undefined, it, []))).toBe('출처: 슬랙 스레드');
    expect(text(renderWorkItemFooter('slack', 'item', undefined, it, []))).toBe('출처: 슬랙 메시지');
  });

  it('fallback shows the title, status, link and the fixed line', () => {
    const it = item([], { url: 'https://acme.atlassian.net/browse/PROJ-1', status: 'In Progress' });
    const out = text(renderWorkItemFallback('jira', it, ['목록 이후 수정됨']));
    expect(out).toBe("결제 오류 수정 (In Progress) https://acme.atlassian.net/browse/PROJ-1\n요약을 만들지 못했어요. '원문 보여줘'로 볼 수 있어요.\n목록 이후 수정됨");
    const slack = text(renderWorkItemFallback('slack', item([], { url: 'https://x.slack.com/a' }), []));
    expect(slack).toBe("결제 오류 수정\n요약을 만들지 못했어요. '원문 보여줘'로 볼 수 있어요.");
  });
});

describe('pseudonymiseParticipants (D5, live test 3: a name inside free text)', () => {
  const people = [
    { handle: '전혜정', label: '참여자 A' },
    { handle: 'Minsu Kim', label: '참여자 B' },
    { handle: '이준', label: '참여자 C' },
  ];
  it.each([
    ['혜정님에게 전달', '참여자 A에게 전달'],
    ['전혜정님이 확인', '참여자 A이 확인'],
    ['전혜정 님이 확인', '참여자 A이 확인'],
    ['전혜정 확인 부탁', '참여자 A 확인 부탁'],
    ['혜정씨 의견대로', '참여자 A 의견대로'],
    ['혜정 씨 의견대로', '참여자 A 의견대로'],
    ['혜정에게 넘김', '참여자 A에게 넘김'],
    ['혜정께 보고', '참여자 A께 보고'],
    ['혜정아 이거 봐줘', '참여자 A 이거 봐줘'],
    ['Minsu Kim will review', '참여자 B will review'],
    ['ask Minsu tomorrow', 'ask 참여자 B tomorrow'],
    ['Minsu님 확인', '참여자 B 확인'],
    ['준님 확인', '참여자 C 확인'],
    ['이준 담당', '참여자 C 담당'],
  ])('%s -> %s', (input, expected) => {
    expect(pseudonymiseParticipants(input, people)).toBe(expected);
  });

  it.each(['정혜정리', '혜정리 작업', 'Minsukim', '준비 완료', '기준 변경', '수준 높음', '혜정이 맡기로 함'])('leaves %s untouched (not a certain name form)', (line) => {
    expect(pseudonymiseParticipants(line, people)).toBe(line);
  });

  it('CA P2: a bare given name that is an ordinary word stays intact ("버그 수정이 필요하고 서버 지원도")', () => {
    const words = [
      { handle: '김수정', label: '참여자 A' },
      { handle: '박지원', label: '참여자 B' },
    ];
    expect(pseudonymiseParticipants('버그 수정이 필요하고 서버 지원도 확인해 주세요. 수정 완료.', words)).toBe('버그 수정이 필요하고 서버 지원도 확인해 주세요. 수정 완료.');
    expect(pseudonymiseParticipants('수정님이 버그 수정을, 지원씨가 서버 지원을, 김수정 확인', words)).toBe('참여자 A이 버그 수정을, 참여자 B가 서버 지원을, 참여자 A 확인');
  });

  it('a given name two participants share becomes the plain "참여자", never the wrong person', () => {
    const shared = [
      { handle: '김민수', label: '참여자 A' },
      { handle: '이민수', label: '참여자 B' },
    ];
    expect(pseudonymiseParticipants('민수님께 전달, 이민수 확인', shared)).toBe('참여자께 전달, 참여자 B 확인');
  });

  it('buildWorkItemReadout pseudonymises a given name + honorific inside a comment body (no name reaches the prompt)', () => {
    const r = ok(
      build('jira', 'item', 'summary', item([{ kind: 'comment', author: '전혜정', text: '오토업 API 혜정님에게 전달했어요. 민수 씨도 참고' }], {}, { people: ['전혜정', '김민수'] })),
    );
    const prompt = renderUntrustedDocumentForPrompt(r.readout);
    expect(prompt).not.toMatch(/혜정|전혜정|민수|김민수/u);
    expect(prompt).toContain('참여자 A에게 전달');
    expect(prompt).toContain('참여자 B도 참고');
  });
});

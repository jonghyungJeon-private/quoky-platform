import { describe, expect, it } from 'vitest';
import { Capability, IntentType, ResourceRef } from '../../domain';
import type { Intent } from '../../domain';
import { IntentClassifier } from '../intent-classifier';
import { ANCHORED_TODO_PREFIX_HEADS, startsWithAnchoredTodoPrefix } from '../reminders';
import {
  WORK_CHAT_ANCHORED_TODO_HEADS,
  WORK_CHAT_INTENT_KIND,
  detectWorkChatCommand,
  extractExplicitResourceRefs,
  startsWithWorkChatAnchoredPrefix,
  workChatCommandFromIntent,
  workChatCommandMode,
} from './work-chat-command';
import type { WorkChatCommand } from './work-chat-command';

const jira = (key: string) => new ResourceRef({ source: 'jira', externalId: key });
const github = (id: string) => new ResourceRef({ source: 'github', externalId: id });

describe('anchored to-do prefixes (ADR-0100 D1 closed list)', () => {
  const ADD = ['할 일 추가', '할일 추가', '할 일 등록', '할일 등록', 'todo add', 'add todo', 'to-do add'];
  const COMPLETE = ['완료 처리', '할 일 완료', '할일 완료', 'todo done'];
  const CANCEL = ['할 일 취소', '할일 취소', 'todo cancel'];
  const LINK = ['할 일 연결', '할일 연결', 'todo link'];

  it('lists exactly the closed set and mirrors the reminder grammar literally', () => {
    expect([...WORK_CHAT_ANCHORED_TODO_HEADS]).toEqual([...ADD, ...COMPLETE, ...CANCEL, ...LINK]);
    expect([...ANCHORED_TODO_PREFIX_HEADS]).toEqual([...WORK_CHAT_ANCHORED_TODO_HEADS]);
  });

  it.each(ADD)('%s: adds the body as the title, even with a time phrase and 알려줘', (head) => {
    for (const sep of [':', '：', ' :', ': ']) {
      expect(detectWorkChatCommand(`${head}${sep}내일 9시에 회의 알려줘`)).toEqual({
        kind: 'todo.add',
        title: '내일 9시에 회의 알려줘',
        refs: [],
      });
    }
    expect(detectWorkChatCommand(`${head.toUpperCase()}: Review the PR at 5pm`)).toEqual({
      kind: 'todo.add',
      title: 'Review the PR at 5pm',
      refs: [],
    });
  });

  it.each(COMPLETE)('%s: completes by list number or title fragment', (head) => {
    expect(detectWorkChatCommand(`${head}: 2`)).toEqual({ kind: 'todo.complete', target: { index: 2 } });
    expect(detectWorkChatCommand(`${head}: 3번`)).toEqual({ kind: 'todo.complete', target: { index: 3 } });
    expect(detectWorkChatCommand(`${head}: 로그인   버그`)).toEqual({
      kind: 'todo.complete',
      target: { text: '로그인 버그' },
    });
    expect(detectWorkChatCommand(`${head}:`)).toEqual({ kind: 'usage', topic: 'todo-complete' });
  });

  it.each(CANCEL)('%s: cancels by list number or title fragment', (head) => {
    expect(detectWorkChatCommand(`${head}: 1`)).toEqual({ kind: 'todo.cancel', target: { index: 1 } });
    expect(detectWorkChatCommand(`${head}: 보고서`)).toEqual({ kind: 'todo.cancel', target: { text: '보고서' } });
    expect(detectWorkChatCommand(`${head}：`)).toEqual({ kind: 'usage', topic: 'todo-cancel' });
  });

  it.each(LINK)('%s: links explicit refs to a target', (head) => {
    expect(detectWorkChatCommand(`${head}: 2 Jira PROJ-123`)).toEqual({
      kind: 'todo.link',
      target: { index: 2 },
      refs: [jira('PROJ-123')],
    });
    expect(detectWorkChatCommand(`${head}: 로그인 버그 octo/repo#12`)).toEqual({
      kind: 'todo.link',
      target: { text: '로그인 버그' },
      refs: [github('octo/repo#12')],
    });
    expect(detectWorkChatCommand(`${head}: 2`)).toEqual({ kind: 'usage', topic: 'todo-link' });
    expect(detectWorkChatCommand(`${head}: Jira PROJ-1`)).toEqual({ kind: 'usage', topic: 'todo-link' });
  });

  it('matches no other spacing or separator and requires the colon', () => {
    for (const text of [
      '할  일 추가: x',
      '할일  추가: x',
      '할 일추가: x',
      '할 일 추가 x',
      '할 일 추가해줘',
      'todo  add: x',
      'todo-add: x',
      'please 할 일 추가: x',
    ]) {
      expect(startsWithWorkChatAnchoredPrefix(text), text).toBe(false);
    }
    expect(startsWithWorkChatAnchoredPrefix('  할 일 추가: x  ')).toBe(true);
  });

  it('agrees with the ADR-0101 mirror on every head', () => {
    for (const head of WORK_CHAT_ANCHORED_TODO_HEADS) {
      expect(startsWithWorkChatAnchoredPrefix(`${head}: 내일 9시에 알려줘`)).toBe(true);
      expect(startsWithAnchoredTodoPrefix(`${head}: 내일 9시에 알려줘`)).toBe(true);
    }
  });

  it('keeps the title verbatim and extracts explicit refs from it', () => {
    expect(detectWorkChatCommand('할 일 추가: /Users/x 정리')).toEqual({
      kind: 'todo.add',
      title: '/Users/x 정리',
      refs: [],
    });
    expect(detectWorkChatCommand('할 일 추가: 배포 확인 https://acme.atlassian.net/browse/OPS-7')).toEqual({
      kind: 'todo.add',
      title: '배포 확인 https://acme.atlassian.net/browse/OPS-7',
      refs: [jira('OPS-7')],
    });
    // An empty body still reaches the service, which refuses it with the empty-title copy.
    expect(detectWorkChatCommand('할 일 추가:')).toEqual({ kind: 'todo.add', title: '', refs: [] });
  });

  it('ignores negation for anchored commands (the body is a title)', () => {
    expect(detectWorkChatCommand('할 일 추가: 커밋하지 마')).toEqual({
      kind: 'todo.add',
      title: '커밋하지 마',
      refs: [],
    });
  });
});

describe('explicit ResourceRef extraction (ADR-0100 D6)', () => {
  it('accepts only the explicit forms', () => {
    const { refs } = extractExplicitResourceRefs(
      [
        'https://acme.atlassian.net/browse/ABC-1',
        'Jira ABC-2',
        '지라 abc-3',
        'https://github.com/octo/repo/pull/9',
        'https://github.com/octo/repo/issues/10',
        'octo/repo#11',
      ].join(' '),
    );
    expect(refs.map((ref) => ref.identity)).toEqual([
      'jira:ABC-1',
      'jira:ABC-2',
      'jira:ABC-3',
      'github:octo/repo#9',
      'github:octo/repo#10',
      'github:octo/repo#11',
    ]);
  });

  it('never links a bare key, a path or a repeated identity', () => {
    expect(extractExplicitResourceRefs('ABC-123 그리고 foo/bar/baz#1 그리고 #12').refs).toEqual([]);
    expect(extractExplicitResourceRefs('Jira ABC-1 지라 ABC-1 https://x.example/browse/ABC-1').refs).toHaveLength(1);
  });
});

describe('unanchored to-do phrases', () => {
  it.each([
    '내 할 일 보여줘',
    '할 일 목록',
    '할 일 목록 보여줘',
    '할일 목록 알려줘',
    '오늘 할 일 알려줘',
    '해야 할 일 알려줘',
    '내가 해야 할 일 보여줘',
    'show my work',
    "what's my work",
    'list my to-dos',
    'todo list',
    '내 업무 보여줘',
  ])('lists: %s', (text) => {
    expect(detectWorkChatCommand(text)).toEqual({ kind: 'todo.list' });
  });

  it('is a superset of the legacy personal-work-surface phrases', async () => {
    const classifier = new IntentClassifier(undefined as never);
    const phrases = [
      '내가 해야 할 일 보여줘',
      '할 일 알려줘',
      '제가 할 작업 보여줘',
      '나는 해야 할 일 알려줘',
      'show my work',
      'list what i need to work',
      "what's my work",
      'what is my work',
    ];
    let legacyHits = 0;
    for (const text of phrases) {
      const intent = await classifier.classify({ text } as never);
      const legacy = (intent.raw as { kind?: string } | undefined)?.kind === 'personal-work-surface';
      if (legacy) {
        legacyHits += 1;
        expect(detectWorkChatCommand(text), text).toEqual({ kind: 'todo.list' });
      }
    }
    expect(legacyHits).toBe(phrases.length);
  });

  it.each([
    ['2번 완료 처리해줘', { kind: 'todo.complete', target: { index: 2 } }],
    ['2번 완료', { kind: 'todo.complete', target: { index: 2 } }],
    ['할 일 3번 완료 처리', { kind: 'todo.complete', target: { index: 3 } }],
    ['할 일 4번 취소해줘', { kind: 'todo.cancel', target: { index: 4 } }],
    ['mark todo 5 done', { kind: 'todo.complete', target: { index: 5 } }],
    ['cancel task 6', { kind: 'todo.cancel', target: { index: 6 } }],
    [
      '할 일 2번에 Jira PROJ-1 연결',
      { kind: 'todo.link', target: { index: 2 }, refs: [jira('PROJ-1')] },
    ],
    [
      '할 일 2번에 octo/repo#7 연결해줘',
      { kind: 'todo.link', target: { index: 2 }, refs: [github('octo/repo#7')] },
    ],
    ['할 일 2번에 연결해줘', { kind: 'usage', topic: 'todo-link' }],
    ['할 일 추가해줘', { kind: 'usage', topic: 'todo-add' }],
  ] satisfies Array<[string, WorkChatCommand]>)('%s', (text, expected) => {
    expect(detectWorkChatCommand(text)).toEqual(expected);
  });
});

describe('connector lookups', () => {
  it.each([
    ['내 Jira 이슈 보여줘', { kind: 'lookup', source: 'jira', query: 'my-items' }],
    ['Jira 내 이슈 알려줘', { kind: 'lookup', source: 'jira', query: 'my-items' }],
    ['내 GitHub PR 보여줘', { kind: 'lookup', source: 'github', query: 'my-items' }],
    ['show my GitHub issues', { kind: 'lookup', source: 'github', query: 'my-items' }],
    ['이번 주 마감', { kind: 'lookup', source: 'jira', query: 'due-this-week' }],
    ['이번 주 마감 이슈 알려줘', { kind: 'lookup', source: 'jira', query: 'due-this-week' }],
    ['Jira 이번 주 마감 보여줘', { kind: 'lookup', source: 'jira', query: 'due-this-week' }],
    ['GitHub 리뷰 요청된 PR 알려줘', { kind: 'lookup', source: 'github', query: 'review-requests' }],
    ['리뷰 요청 받은 PR 보여줘', { kind: 'lookup', source: 'github', query: 'review-requests' }],
    ['show GitHub review requests', { kind: 'lookup', source: 'github', query: 'review-requests' }],
    ['Slack에서 배포 검색', { kind: 'lookup', source: 'slack', query: 'search', text: '배포' }],
    ['슬랙에서 배포 공지 검색해줘', { kind: 'lookup', source: 'slack', query: 'search', text: '배포 공지' }],
    ['Confluence에서 온보딩 찾아줘', { kind: 'lookup', source: 'confluence', query: 'search', text: '온보딩' }],
    ['"배포 가이드"를 컨플루언스에서 검색해줘', { kind: 'lookup', source: 'confluence', query: 'search', text: '배포 가이드' }],
    ['search Slack for deploy window', { kind: 'lookup', source: 'slack', query: 'search', text: 'deploy window' }],
    ['find onboarding in Confluence', { kind: 'lookup', source: 'confluence', query: 'search', text: 'onboarding' }],
    ['Jira에서 로그인 검색', { kind: 'lookup', source: 'jira', query: 'search', text: '로그인' }],
    ['Slack에서 검색해줘', { kind: 'usage', topic: 'search' }],
  ] satisfies Array<[string, WorkChatCommand]>)('%s', (text, expected) => {
    expect(detectWorkChatCommand(text)).toEqual(expected);
  });

  it('maps "my Jira and GitHub items" to the combined view', () => {
    expect(detectWorkChatCommand('내 Jira랑 GitHub 이슈 보여줘')).toEqual({ kind: 'todo.list' });
  });

  it('bounds the search text (usage hint, never a silent truncation)', () => {
    expect(detectWorkChatCommand(`Slack에서 ${'가'.repeat(100)} 검색`)).toMatchObject({ kind: 'lookup', query: 'search' });
    expect(detectWorkChatCommand(`Slack에서 ${'가'.repeat(101)} 검색`)).toEqual({
      kind: 'usage',
      topic: 'search-too-long',
    });
  });

  it.each([
    ['Jira 이슈 만들어줘', 'jira'],
    ['Slack에 배포 완료 메시지 보내줘', 'slack'],
    ['GitHub 이슈에 댓글 달아줘', 'github'],
    ['Confluence 페이지 수정해줘', 'confluence'],
    ['create a Jira ticket for the outage', 'jira'],
    ['post a message to Slack', 'slack'],
    ['comment on the GitHub issue', 'github'],
  ])('refuses external writes: %s', (text, source) => {
    expect(detectWorkChatCommand(text)).toEqual({ kind: 'external-write-unsupported', source });
  });
});

describe('negatives and exclusions', () => {
  it.each([
    '완료됐어?',
    'Slack에서 검색하지 마',
    'Jira 이슈 만들지 마',
    '내 Jira 이슈 보여주지 마',
    '할 일 보여주지 마',
    'ISO-8601 형식 알려줘',
    '할 일이 많아서 힘들어',
    '내일 Jira 이슈 보여줘',
    'GitHub 이슈 보여줘',
    'Jira 이슈 만든 사람 알려줘',
    '2번 취소',
    '프로젝트 분석해줘',
    '',
    '   ',
    'create a to-do about Jira',
    'send me my Jira issues',
  ])('is not claimed: %j', (text) => {
    expect(detectWorkChatCommand(text)).toBeNull();
  });

  it('never claims an unanchored time-bound 알려줘 (ADR-0101)', () => {
    for (const text of [
      '내일 9시에 할 일 알려줘',
      '10분 뒤에 내 Jira 이슈 알려줘',
      '오후 3시에 Slack에서 배포 검색 알려줘',
      '내 할 일 리마인드 해줘',
      'remind me to review my Jira issues',
    ]) {
      expect(detectWorkChatCommand(text), text).toBeNull();
    }
  });

  it('claims the anchored form before any reminder exclusion', () => {
    expect(detectWorkChatCommand('할 일 추가: 10분 뒤에 내 할 일 알려줘')).toMatchObject({ kind: 'todo.add' });
    expect(detectWorkChatCommand('todo add: remind me at 5pm')).toMatchObject({ kind: 'todo.add' });
  });

  it('ignores long pasted text for unanchored phrases', () => {
    expect(detectWorkChatCommand(`내 할 일 보여줘 ${'a'.repeat(400)}`)).toBeNull();
  });
});

describe('modes and intents', () => {
  it('splits mutation (order 100) from lookup (order 300) commands', () => {
    const cases: Array<[WorkChatCommand, 'mutation' | 'lookup']> = [
      [{ kind: 'todo.add', title: 'x', refs: [] }, 'mutation'],
      [{ kind: 'todo.complete', target: { index: 1 } }, 'mutation'],
      [{ kind: 'todo.cancel', target: { index: 1 } }, 'mutation'],
      [{ kind: 'todo.link', target: { index: 1 }, refs: [jira('A-1')] }, 'mutation'],
      [{ kind: 'usage', topic: 'todo-add' }, 'mutation'],
      [{ kind: 'usage', topic: 'todo-link' }, 'mutation'],
      [{ kind: 'usage', topic: 'search' }, 'lookup'],
      [{ kind: 'usage', topic: 'search-too-long' }, 'lookup'],
      [{ kind: 'todo.list' }, 'lookup'],
      [{ kind: 'lookup', source: 'jira', query: 'my-items' }, 'lookup'],
      [{ kind: 'external-write-unsupported', source: 'jira' }, 'lookup'],
    ];
    for (const [command, mode] of cases) expect(workChatCommandMode(command)).toBe(mode);
  });

  const intent = (raw: Intent['raw'], type: IntentType = IntentType.LOOKUP): Intent => ({
    type,
    capability: Capability.READONLY_LOOKUP,
    confidence: 1,
    requiresWork: false,
    summary: 'x',
    ...(raw ? { raw } : {}),
  });

  it('maps the legacy personal-work-surface kind to todo.list and re-detects work-chat text', () => {
    expect(workChatCommandFromIntent(intent({ kind: 'personal-work-surface' }))).toEqual({ kind: 'todo.list' });
    expect(workChatCommandFromIntent(intent({ kind: WORK_CHAT_INTENT_KIND, text: 'Slack에서 배포 검색' }))).toEqual({
      kind: 'lookup',
      source: 'slack',
      query: 'search',
      text: '배포',
    });
  });

  it('rejects malformed or foreign intents', () => {
    expect(workChatCommandFromIntent(intent(undefined))).toBeNull();
    expect(workChatCommandFromIntent(intent({ kind: 'preview' }))).toBeNull();
    expect(workChatCommandFromIntent(intent({ kind: WORK_CHAT_INTENT_KIND }))).toBeNull();
    expect(workChatCommandFromIntent(intent({ kind: WORK_CHAT_INTENT_KIND, text: 42 }))).toBeNull();
    expect(workChatCommandFromIntent(intent({ kind: 'personal-work-surface' }, IntentType.CHAT))).toBeNull();
  });
});

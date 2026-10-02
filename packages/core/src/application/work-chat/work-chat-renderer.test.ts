import { describe, expect, it } from 'vitest';
import { ResourceRef, WorkItemStatus } from '../../domain';
import type { WorkItem } from '../../domain';
import { CONNECTOR_QUERY_ERROR_REASONS } from '../../ports';
import type { WorkSurface } from '../work-surface-query';
import { buildExternalWorkReadout } from './external-work-readout';
import { WORK_CHAT_SOURCES } from './work-chat-command';
import type { WorkChatUsageTopic } from './work-chat-command';
import {
  WORK_CHAT_LOOKUP_HELP_LINES,
  WORK_CHAT_REPLY_MAX_CHARS,
  WORK_CHAT_TODO_HELP_LINES,
  renderExternalWorkList,
  renderExternalWriteRefusal,
  renderLookupFailure,
  renderLookupUnsupported,
  renderMyWork,
  renderSearchCredentialRefused,
  renderTodoAdded,
  renderTodoAmbiguous,
  renderTodoCanceled,
  renderTodoCompleted,
  renderTodoCredentialRefused,
  renderTodoEmptyTitle,
  renderTodoFailure,
  renderTodoListFailure,
  renderTodoLinked,
  renderTodoNotActive,
  renderTodoNotFound,
  renderTodoTitleTooLong,
  renderTodoTooManyRefs,
  renderWorkChatUsage,
} from './work-chat-renderer';
import type { WorkChatLookupFailure } from './work-chat-renderer';

function todo(title: string | undefined, refs: ResourceRef[] = [], index = 0): WorkItem {
  return {
    id: `w-${index}`,
    actorId: 'actor-1',
    ...(title !== undefined ? { title } : {}),
    resourceRefs: refs,
    status: WorkItemStatus.ACTIVE,
    origin: 'conversation',
    createdAt: `2026-10-02T00:00:${String(index).padStart(2, '0')}.000Z`,
    updatedAt: `2026-10-02T00:00:${String(index).padStart(2, '0')}.000Z`,
  };
}

const jira = (key: string) => new ResourceRef({ source: 'jira', externalId: key });

describe('to-do replies', () => {
  it('names the item changed', () => {
    const item = todo('로그인 버그 고치기', [jira('PROJ-1')]);
    expect(renderTodoAdded(item)).toBe('할 일을 추가했어요: "로그인 버그 고치기" (연결: jira:PROJ-1)');
    expect(renderTodoCompleted(item)).toContain('"로그인 버그 고치기"');
    expect(renderTodoCanceled(item)).toContain('"로그인 버그 고치기"');
    expect(renderTodoLinked(item, [jira('PROJ-1')])).toContain('"로그인 버그 고치기"');
    expect(renderTodoLinked(item, [jira('PROJ-1')])).toContain('jira:PROJ-1');
    expect(renderTodoLinked(item, [])).toContain('이미 연결돼 있어요');
  });

  it('escapes mentions and markdown in titles', () => {
    const text = renderTodoAdded(todo('@everyone **공지** <@123> [x](https://evil.example)'));
    expect(text).not.toContain('@everyone');
    expect(text).not.toContain('<@');
    expect(text).not.toContain('**공지**');
    expect(text).not.toContain('[x](');
  });

  it('says nothing changed for an ambiguous target and lists the numbered candidates', () => {
    const text = renderTodoAmbiguous('complete', [
      { no: 1, item: todo('보고서 작성') },
      { no: 4, item: todo('보고서 검토') },
    ]);
    expect(text).toContain('아무것도 완료 처리하지 않았어요');
    expect(text).toContain('1. 보고서 작성');
    expect(text).toContain('4. 보고서 검토');
  });

  it('explains not-found, refusals and usage', () => {
    expect(renderTodoNotFound({ index: 9 }, 3)).toContain('9번 할 일을 찾지 못해서 아무것도 바꾸지 않았어요');
    expect(renderTodoNotFound({ text: '없는 것' }, 0)).toContain('열린 할 일이 없어요');
    expect(renderTodoEmptyTitle()).toContain('비어 있어서');
    expect(renderTodoTitleTooLong(200)).toContain('200자');
    expect(renderTodoCredentialRefused()).toContain('저장하지 않았어요');
    expect(renderTodoTooManyRefs(10)).toContain('10개');
    expect(renderTodoNotActive()).toContain('아무것도 바꾸지 않았어요');
    expect(renderTodoFailure()).toContain('내 할 일');
    expect(renderTodoListFailure()).toContain('불러오지 못했어요');
    expect(renderSearchCredentialRefused()).toContain('보내지 않았어요');
  });

  it('has a usage hint for every topic', () => {
    const topics: WorkChatUsageTopic[] = [
      'todo-add',
      'todo-complete',
      'todo-cancel',
      'todo-link',
      'search',
      'search-too-long',
    ];
    for (const topic of topics) expect(renderWorkChatUsage(topic).length).toBeGreaterThan(10);
    expect(renderWorkChatUsage('search-too-long')).toContain('100자');
  });

  it('contributes bounded one-line help text', () => {
    for (const line of [...WORK_CHAT_TODO_HELP_LINES, ...WORK_CHAT_LOOKUP_HELP_LINES]) {
      expect(line).not.toContain('\n');
      expect(Array.from(line).length).toBeLessThanOrEqual(120);
    }
  });
});

describe('combined my-work view', () => {
  const surface = (overrides: Partial<WorkSurface> = {}): WorkSurface => ({
    status: 'COMPLETE',
    items: [
      { resource: jira('PROJ-2'), title: 'Jira task', url: 'https://acme.atlassian.net/browse/PROJ-2' },
      { resource: new ResourceRef({ source: 'github', externalId: 'o/r#5' }), title: 'PR review' },
    ],
    sources: [
      { source: 'jira', status: 'AVAILABLE', message: '' },
      { source: 'github', status: 'AVAILABLE', message: '' },
    ],
    ...overrides,
  });

  it('numbers local to-dos first, then external items', () => {
    const text = renderMyWork([todo('첫째', [], 1), todo('둘째', [jira('PROJ-1')], 2)], surface());
    expect(text.indexOf('1. 첫째')).toBeGreaterThan(-1);
    expect(text.indexOf('2. 둘째 (연결: jira:PROJ-1)')).toBeGreaterThan(text.indexOf('1. 첫째'));
    expect(text.indexOf('Jira·GitHub 업무')).toBeGreaterThan(text.indexOf('2. 둘째'));
    expect(text).toContain('- [jira:PROJ-2] Jira task <https://acme.atlassian.net/browse/PROJ-2>');
    expect(text).toContain('- [github:o/r#5] PR review');
  });

  it('names unavailable sources and never presents a partial result as "no work"', () => {
    const text = renderMyWork(
      [],
      surface({
        status: 'PARTIAL',
        items: [],
        sources: [
          { source: 'jira', status: 'IDENTITY_MISSING', message: '' },
          { source: 'github', status: 'NOT_CONFIGURED', message: '' },
        ],
      }),
    );
    expect(text).toContain('열린 할 일이 없어요');
    expect(text).toContain('확인하지 못한 소스가 있으니');
    expect(text).toContain('- Jira: 내 계정 정보(identity)가 설정되어 있지 않아요');
    expect(text).toContain('- GitHub: 연결이 설정되어 있지 않아요');
    expect(text).not.toContain('확인된 업무가 없어요');
  });

  it('says so when the external surface could not be read at all', () => {
    expect(renderMyWork([todo('x')], null)).toContain('불러오지 못했어요');
    expect(renderMyWork([], surface({ items: [] }))).toContain('Jira와 GitHub에서 확인된 업무가 없어요');
  });

  it('stays within the Discord-safe budget and keeps the section headers', () => {
    const todos = Array.from({ length: 40 }, (_v, index) => todo(`${'가'.repeat(190)} ${index}`, [jira('PROJ-1'), jira('PROJ-2'), jira('PROJ-3'), jira('PROJ-4')], index));
    const items = Array.from({ length: 30 }, (_v, index) => ({
      resource: jira(`PROJ-${index + 10}`),
      title: '나'.repeat(190),
      url: `https://acme.atlassian.net/browse/PROJ-${index + 10}`,
    }));
    const text = renderMyWork(todos, surface({ items }));
    expect(text.length).toBeLessThanOrEqual(WORK_CHAT_REPLY_MAX_CHARS);
    expect(text).toContain('**내 할 일** (40건)');
    expect(text).toContain('**Jira·GitHub 업무** (30건)');
    expect(text).toContain('길이 때문에 일부는 생략했어요');
  });
});

describe('lookup copy', () => {
  it('has a distinct deterministic line for every neutral failure reason and precondition', () => {
    const failures: WorkChatLookupFailure[] = [
      ...CONNECTOR_QUERY_ERROR_REASONS,
      'NOT_CONFIGURED',
      'IDENTITY_MISSING',
      'TIMEOUT',
    ];
    for (const source of WORK_CHAT_SOURCES) {
      const lines = failures.map((failure) => renderLookupFailure(source, failure));
      expect(new Set(lines).size).toBe(failures.length);
      for (const line of lines) expect(line.length).toBeGreaterThan(5);
    }
    expect(renderLookupFailure('slack', 'INSUFFICIENT_SCOPE')).toContain('search:read');
    expect(renderLookupFailure('jira', 'UNAUTHORIZED')).toContain('Jira');
  });

  it('explains unsupported combinations and refuses external writes with a fixed read-only message', () => {
    expect(renderLookupUnsupported('jira', 'search', ['my-items', 'due-this-week'])).toContain('내 항목, 이번 주 마감');
    const refusal = renderExternalWriteRefusal('jira');
    expect(refusal).toContain('읽기 전용');
    expect(refusal).toContain('Jira에는 아무것도 하지 않았어요');
    expect(renderExternalWriteRefusal('slack')).toContain('Slack에는 아무것도 하지 않았어요');
  });

  it('renders the deterministic list, an empty result and sensitive omissions', () => {
    const readout = buildExternalWorkReadout({
      source: 'jira',
      query: 'due-this-week',
      items: [
        { id: 'PROJ-1', title: '배포 점검', url: 'https://acme.atlassian.net/browse/PROJ-1', status: 'In Progress', dueDate: '2026-10-03', container: 'PROJ' },
        { id: 'PROJ-2', title: '비밀번호는 hunter2hunter2' },
      ],
    });
    const text = renderExternalWorkList(readout);
    expect(text).toContain('**Jira 이번 주 마감** (1건)');
    expect(text).toContain('- [jira:PROJ-1] 배포 점검 (In Progress · 마감 2026-10-03 · PROJ) <https://acme.atlassian.net/browse/PROJ-1>');
    expect(text).toContain('민감정보가 있는 1건은 제외했어요.');
    expect(text).not.toContain('hunter2');

    const empty = renderExternalWorkList(buildExternalWorkReadout({ source: 'slack', query: 'search', text: '배포', items: [] }));
    expect(empty).toBe('Slack 검색 "배포" 결과가 없어요.');
  });

  it('keeps the list within the budget', () => {
    const readout = buildExternalWorkReadout({
      source: 'github',
      query: 'my-items',
      items: Array.from({ length: 10 }, (_v, index) => ({
        id: `o/r#${index}`,
        title: 'x'.repeat(200),
        url: `https://github.com/o/r/pull/${index}`,
        status: 's'.repeat(100),
        container: 'c'.repeat(100),
      })),
    });
    expect(renderExternalWorkList(readout).length).toBeLessThanOrEqual(WORK_CHAT_REPLY_MAX_CHARS);
  });
});

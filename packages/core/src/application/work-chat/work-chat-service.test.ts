import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceRef,
  WORK_ITEM_MAX_RESOURCE_REFS,
  WorkItemCorrelationError,
  WorkItemStatus,
  correlateWorkItem,
  normalizeWorkItemTitle,
  transitionWorkItem,
  uniqueResourceRefs,
  assertResourceRefCapacity,
} from '../../domain';
import type { Actor, WorkItem } from '../../domain';
import { ConnectorQueryError } from '../../ports';
import type { ConnectorProvider, ConnectorQuery, ConnectorResult } from '../../ports';
import type { WorkSurface } from '../work-surface-query';
import { detectWorkChatCommand } from './work-chat-command';
import type { WorkChatCommand } from './work-chat-command';
import { WorkChatService } from './work-chat-service';
import type { WorkChatOutcome, WorkChatServiceDeps } from './work-chat-service';
import { EXTERNAL_WORK_PROMPT_MAX_CHARS, renderExternalWorkReadoutForPrompt } from './external-work-readout';
import { WORK_CHAT_REPLY_MAX_CHARS } from './work-chat-renderer';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const owner: Actor = {
  id: 'owner-1',
  displayName: 'Owner',
  identities: [
    { platform: 'discord', externalId: 'discord-1' },
    { platform: 'jira', externalId: 'jira-owner' },
    { platform: 'github', externalId: 'octocat' },
  ],
  createdAt: '2026-10-02T00:00:00.000Z',
};

/** A WorkManager-shaped fake over the real aggregate functions; records every call. */
class FakeWork {
  readonly items: WorkItem[] = [];
  readonly calls: string[] = [];
  failNextTransition = false;
  private clock = 0;

  async create(input: {
    actorId: string;
    title?: string;
    resourceRefs?: readonly ResourceRef[];
    origin: 'conversation' | 'connector';
  }): Promise<WorkItem> {
    this.calls.push('create');
    const refs = uniqueResourceRefs(input.resourceRefs ?? []);
    assertResourceRefCapacity(refs);
    this.clock += 1;
    const at = `2026-10-02T00:00:${String(this.clock).padStart(2, '0')}.000Z`;
    const item: WorkItem = {
      id: `w-${this.clock}`,
      actorId: input.actorId,
      ...(input.title !== undefined ? { title: normalizeWorkItemTitle(input.title) } : {}),
      resourceRefs: refs,
      status: WorkItemStatus.ACTIVE,
      origin: input.origin,
      createdAt: at,
      updatedAt: at,
    };
    this.items.push(item);
    return item;
  }

  async listActiveByActor(actorId: string): Promise<WorkItem[]> {
    this.calls.push('listActiveByActor');
    return this.items.filter((item) => item.actorId === actorId && item.status === WorkItemStatus.ACTIVE);
  }

  async transition(id: string, status: WorkItemStatus): Promise<WorkItem> {
    this.calls.push(`transition:${status}`);
    if (this.failNextTransition) {
      this.failNextTransition = false;
      throw new Error('storage offline');
    }
    return this.replace(id, (item) => transitionWorkItem(item, status, '2026-10-02T01:00:00.000Z'));
  }

  async correlate(id: string, refs: readonly ResourceRef[]): Promise<WorkItem> {
    this.calls.push('correlate');
    return this.replace(id, (item) => correlateWorkItem(item, refs, '2026-10-02T01:00:00.000Z'));
  }

  private replace(id: string, update: (item: WorkItem) => WorkItem): WorkItem {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('missing');
    const next = update(this.items[index] as WorkItem);
    this.items[index] = next;
    return next;
  }

  ofOwner(): WorkItem[] {
    return this.items.filter((item) => item.actorId === owner.id);
  }
}

interface FakeConnectorOptions {
  available?: boolean;
  items?: ConnectorResult['items'];
  error?: unknown;
  hang?: boolean;
}

class FakeConnector implements ConnectorProvider {
  readonly readOnly = true;
  readonly queries: ConnectorQuery[] = [];
  availabilityChecks = 0;
  constructor(
    readonly source: string,
    private readonly options: FakeConnectorOptions = {},
  ) {}
  async isAvailable(): Promise<boolean> {
    this.availabilityChecks += 1;
    return this.options.available ?? true;
  }
  async query(input: ConnectorQuery): Promise<ConnectorResult> {
    this.queries.push(input);
    if (this.options.hang) return new Promise<ConnectorResult>(() => undefined);
    if (this.options.error) throw this.options.error;
    return { source: this.source, items: this.options.items ?? [] };
  }
}

const emptySurface: WorkSurface = {
  status: 'COMPLETE',
  items: [],
  sources: [
    { source: 'jira', status: 'AVAILABLE', message: '' },
    { source: 'github', status: 'AVAILABLE', message: '' },
  ],
};

function harness(
  connectors: ConnectorProvider[] = [],
  options: { summaryEnabled?: boolean; lookupDeadlineMs?: number; surface?: WorkSurface | Error } = {},
) {
  const work = new FakeWork();
  const surfaceCalls: Actor[] = [];
  const deps: WorkChatServiceDeps = {
    workSurface: {
      async forActor(actor) {
        surfaceCalls.push(actor);
        if (options.surface instanceof Error) throw options.surface;
        return options.surface ?? emptySurface;
      },
    },
    connectors: { list: () => connectors },
    work: work as unknown as WorkChatServiceDeps['work'],
  };
  const service = new WorkChatService(deps, {
    summaryEnabled: options.summaryEnabled ?? true,
    ...(options.lookupDeadlineMs !== undefined ? { lookupDeadlineMs: options.lookupDeadlineMs } : {}),
  });
  const say = (text: string, actor: Actor = owner): Promise<WorkChatOutcome> => {
    const command = detectWorkChatCommand(text);
    if (!command) throw new Error(`not a work-chat command: ${text}`);
    return service.handle(command, actor);
  };
  return { service, work, say, surfaceCalls };
}

const textOf = (outcome: WorkChatOutcome): string => {
  if (outcome.kind !== 'reply') throw new Error(`expected a reply, got ${outcome.kind}`);
  return outcome.text;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('to-do commands (WorkManager only)', () => {
  it('adds a conversation-origin to-do with the verbatim title and explicit refs for the owner Actor', async () => {
    const { say, work } = harness();
    const text = textOf(await say('할 일 추가: 내일 9시에 회의 알려줘 Jira PROJ-1'));
    expect(text).toContain('"내일 9시에 회의 알려줘 Jira PROJ-1"');
    expect(work.ofOwner()).toHaveLength(1);
    expect(work.items[0]).toMatchObject({
      actorId: 'owner-1',
      origin: 'conversation',
      title: '내일 9시에 회의 알려줘 Jira PROJ-1',
      status: WorkItemStatus.ACTIVE,
    });
    expect(work.items[0]?.resourceRefs.map((ref) => ref.identity)).toEqual(['jira:PROJ-1']);
  });

  it('accepts a to-do whose body looks like a task, a path or an instruction', async () => {
    const { say, work } = harness();
    for (const body of ['로그인 버그 고쳐줘', '테스트 실행해줘', '/Users/x 정리']) {
      expect(textOf(await say(`할 일 추가: ${body}`))).toContain(body);
    }
    expect(work.items.map((item) => item.title)).toEqual(['로그인 버그 고쳐줘', '테스트 실행해줘', '/Users/x 정리']);
  });

  it('refuses an empty title and an over-long title without storing anything', async () => {
    const { say, work } = harness();
    expect(textOf(await say('할 일 추가:'))).toContain('비어 있어서');
    expect(textOf(await say('할 일 추가: ​ ​'))).toContain('비어 있어서');
    expect(textOf(await say(`할 일 추가: ${'가'.repeat(201)}`))).toContain('200자');
    expect(work.items).toHaveLength(0);
    expect(work.calls).not.toContain('create');
  });

  it('refuses a credential title before anything is stored', async () => {
    const { say, work } = harness();
    for (const body of [`토큰 ${SECRET} 정리`, '비밀번호는 hunter2hunter2 로 바꾸기', 'api_key=sk-abcdefghijklmnopqrstuvwx']) {
      const text = textOf(await say(`할 일 추가: ${body}`));
      expect(text).toContain('저장하지 않았어요');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('hunter2');
    }
    expect(work.items).toHaveLength(0);
  });

  it('refuses more than ten explicit refs and stores nothing', async () => {
    const { say, work } = harness();
    const refs = Array.from({ length: WORK_ITEM_MAX_RESOURCE_REFS + 1 }, (_v, index) => `Jira PROJ-${index + 1}`).join(' ');
    expect(textOf(await say(`할 일 추가: 정리 ${refs}`))).toContain('10개까지만');
    expect(work.items).toHaveLength(0);
  });

  it('completes and cancels by list number, in createdAt order, naming the item', async () => {
    const { say, work } = harness();
    await say('할 일 추가: 첫째');
    await say('할 일 추가: 둘째');
    await say('할 일 추가: 셋째');

    expect(textOf(await say('완료 처리: 2'))).toBe('할 일을 완료 처리했어요: "둘째"');
    expect(work.items.find((item) => item.title === '둘째')?.status).toBe(WorkItemStatus.COMPLETED);
    // Numbering is over the ACTIVE list at read time: 셋째 is now number 2.
    expect(textOf(await say('할 일 취소: 2'))).toBe('할 일을 취소했어요: "셋째"');
    expect(work.items.find((item) => item.title === '셋째')?.status).toBe(WorkItemStatus.CANCELED);
    expect(textOf(await say('2번 완료 처리해줘'))).toContain('찾지 못해서 아무것도 바꾸지 않았어요');
    expect(work.items.filter((item) => item.status === WorkItemStatus.ACTIVE).map((item) => item.title)).toEqual(['첫째']);
  });

  it('resolves a unique title fragment and prefers an exact title', async () => {
    const { say, work } = harness();
    await say('할 일 추가: 보고서 작성');
    await say('할 일 추가: 보고서');
    await say('할 일 추가: 회의 준비');
    expect(textOf(await say('할 일 완료: 회의'))).toContain('"회의 준비"');
    expect(textOf(await say('할 일 완료: 보고서'))).toContain('"보고서"');
    expect(work.items.find((item) => item.title === '보고서 작성')?.status).toBe(WorkItemStatus.ACTIVE);
  });

  it('never mutates on an ambiguous target and lists the candidates', async () => {
    const { say, work } = harness();
    await say('할 일 추가: 보고서 작성');
    await say('할 일 추가: 보고서 검토');
    work.calls.length = 0;
    const text = textOf(await say('할 일 취소: 보고서'));
    expect(text).toContain('아무것도 취소하지 않았어요');
    expect(text).toContain('1. 보고서 작성');
    expect(text).toContain('2. 보고서 검토');
    expect(work.calls.some((call) => call.startsWith('transition'))).toBe(false);
    expect(work.items.every((item) => item.status === WorkItemStatus.ACTIVE)).toBe(true);

    const link = textOf(await say('할 일 연결: 보고서 Jira PROJ-1'));
    expect(link).toContain('아무것도 연결하지 않았어요');
    expect(work.calls).not.toContain('correlate');
  });

  it('reports not-found without mutating', async () => {
    const { say, work } = harness();
    await say('할 일 추가: 하나');
    work.calls.length = 0;
    expect(textOf(await say('완료 처리: 7'))).toContain('7번 할 일을 찾지 못해서 아무것도 바꾸지 않았어요');
    expect(textOf(await say('완료 처리: 없는 제목'))).toContain('찾지 못해서');
    expect(work.calls.some((call) => call.startsWith('transition'))).toBe(false);
  });

  it('only sees the owner Actor’s own to-dos', async () => {
    const { say, work } = harness();
    await say('할 일 추가: 내 것');
    const other: Actor = { ...owner, id: 'someone-else', identities: [] };
    expect(textOf(await say('완료 처리: 1', other))).toContain('열린 할 일이 없어요');
    expect(work.items[0]?.status).toBe(WorkItemStatus.ACTIVE);
  });

  it('links explicit refs without any connector call, de-duplicating and naming the item', async () => {
    const connector = new FakeConnector('jira');
    const { say, work } = harness([connector]);
    await say('할 일 추가: 배포 점검 Jira PROJ-1');
    const text = textOf(await say('할 일 1번에 Jira PROJ-1 octo/repo#5 연결'));
    expect(text).toContain('"배포 점검 Jira PROJ-1"');
    expect(text).toContain('추가된 연결: github:octo/repo#5');
    expect(work.items[0]?.resourceRefs.map((ref) => ref.identity)).toEqual(['jira:PROJ-1', 'github:octo/repo#5']);
    expect(connector.queries).toHaveLength(0);
    expect(connector.availabilityChecks).toBe(0);
    expect(textOf(await say('할 일 연결: 1 Jira PROJ-1'))).toContain('이미 연결돼 있어요');
  });

  it('refuses a link that would exceed ten refs and leaves the item unchanged', async () => {
    const { say, work } = harness();
    const nine = Array.from({ length: 9 }, (_v, index) => `Jira PROJ-${index + 1}`).join(' ');
    await say(`할 일 추가: 정리 ${nine}`);
    const text = textOf(await say('할 일 연결: 1 Jira PROJ-20 Jira PROJ-21'));
    expect(text).toContain('10개까지만');
    expect(work.items[0]?.resourceRefs).toHaveLength(9);
  });

  it('answers a manager failure with a deterministic reply instead of throwing', async () => {
    const { say, work } = harness();
    await say('할 일 추가: 하나');
    work.failNextTransition = true;
    expect(textOf(await say('완료 처리: 1'))).toContain('문제가 생겼어요');
    expect(work.items[0]?.status).toBe(WorkItemStatus.ACTIVE);
  });

  it('maps a correlation race to the not-active copy', async () => {
    const { service, work } = harness();
    await service.handle({ kind: 'todo.add', title: '하나', refs: [] }, owner);
    vi.spyOn(work, 'correlate').mockRejectedValue(new WorkItemCorrelationError('NOT_ACTIVE'));
    const outcome = await service.handle(
      { kind: 'todo.link', target: { index: 1 }, refs: [new ResourceRef({ source: 'jira', externalId: 'PROJ-1' })] },
      owner,
    );
    expect(textOf(outcome)).toContain('이미 완료되었거나 취소된');
  });

  it('answers usage and the fixed write refusal without touching work or connectors', async () => {
    const connector = new FakeConnector('jira');
    const { say, work } = harness([connector]);
    expect(textOf(await say('완료 처리:'))).toContain('완료할 할 일을 알려 주세요');
    const refusal = textOf(await say('Jira 이슈 만들어줘'));
    expect(refusal).toContain('읽기 전용');
    expect(refusal).toContain('Jira에는 아무것도 하지 않았어요');
    expect(work.calls).toEqual([]);
    expect(connector.queries).toHaveLength(0);
    expect(connector.availabilityChecks).toBe(0);
  });
});

describe('combined my-work view', () => {
  it('combines local to-dos with the Jira/GitHub surface for the owner', async () => {
    const surface: WorkSurface = {
      status: 'COMPLETE',
      items: [{ resource: new ResourceRef({ source: 'jira', externalId: 'PROJ-9' }), title: 'Jira 업무', url: 'https://acme.atlassian.net/browse/PROJ-9' }],
      sources: emptySurface.sources,
    };
    const { say, surfaceCalls } = harness([], { surface });
    await say('할 일 추가: 로컬 할 일');
    const text = textOf(await say('내 할 일 보여줘'));
    expect(text).toContain('1. 로컬 할 일');
    expect(text).toContain('[jira:PROJ-9] Jira 업무');
    expect(surfaceCalls).toEqual([owner]);
  });

  it('still shows local to-dos when the surface fails', async () => {
    const { say } = harness([], { surface: new Error('boom') });
    await say('할 일 추가: 로컬 할 일');
    const text = textOf(await say('할 일 목록'));
    expect(text).toContain('1. 로컬 할 일');
    expect(text).toContain('불러오지 못했어요');
  });

  it('exposes the surface read through forActor', async () => {
    const { service } = harness();
    await expect(service.forActor(owner)).resolves.toEqual(emptySurface);
  });
});

describe('connector lookups', () => {
  const jiraItems = [
    { id: 'PROJ-1', title: '배포 점검', url: 'https://acme.atlassian.net/browse/PROJ-1', status: 'In Progress', dueDate: '2026-10-03' },
    { id: 'PROJ-2', title: '문서 정리', summary: '요약 본문' },
  ];

  it('returns summarize with a bounded readout, the deterministic list and the footer', async () => {
    const jira = new FakeConnector('jira', { items: jiraItems });
    const { say } = harness([jira]);
    const outcome = await say('내 Jira 이슈 보여줘');
    expect(outcome.kind).toBe('summarize');
    if (outcome.kind !== 'summarize') return;
    expect(outcome.readout.request).toEqual({ source: 'jira', query: 'my-items' });
    expect(outcome.readout.items.map((item) => item.ref)).toEqual(['jira:PROJ-1', 'jira:PROJ-2']);
    expect(outcome.fallbackText).toContain('- [jira:PROJ-1] 배포 점검');
    expect(outcome.footer).toContain('https://acme.atlassian.net/browse/PROJ-1');
    expect(outcome.footer).toContain('외부 항목 2건을 요약에 사용했어요.');
    expect(jira.queries).toEqual([
      { query: 'personal-work', params: { actorExternalId: 'jira-owner', filter: 'all', limit: 20 } },
    ]);
    expect(jira.availabilityChecks).toBe(1);
  });

  it('maps each lookup kind to its named query', async () => {
    const jira = new FakeConnector('jira', { items: jiraItems });
    const github = new FakeConnector('github', { items: [{ id: 'o/r#1', title: 'PR' }] });
    const slack = new FakeConnector('slack', { items: [{ id: 'C1-1', title: '배포 공지' }] });
    const confluence = new FakeConnector('confluence', { items: [{ id: '1', title: '온보딩' }] });
    const { say } = harness([jira, github, slack, confluence]);

    await say('이번 주 마감');
    await say('GitHub 리뷰 요청된 PR 알려줘');
    await say('Slack에서 배포 검색');
    await say('Confluence에서 온보딩 찾아줘');

    expect(jira.queries).toEqual([
      { query: 'personal-work', params: { actorExternalId: 'jira-owner', filter: 'due-this-week', limit: 20 } },
    ]);
    expect(github.queries).toEqual([
      { query: 'personal-work', params: { actorExternalId: 'octocat', filter: 'review-requested', limit: 20 } },
    ]);
    expect(slack.queries).toEqual([{ query: 'search', params: { text: '배포', limit: 20 } }]);
    expect(confluence.queries).toEqual([{ query: 'search', params: { text: '온보딩', limit: 20 } }]);
  });

  it('only ever calls isAvailable and named queries on a connector', async () => {
    const touched: string[] = [];
    const spy = new Proxy(new FakeConnector('jira', { items: jiraItems }), {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            touched.push(String(property));
            return value.apply(target, args);
          };
        }
        return value;
      },
    });
    const { say } = harness([spy]);
    await say('내 Jira 이슈 보여줘');
    expect(new Set(touched)).toEqual(new Set(['isAvailable', 'query']));
    const named = (spy as FakeConnector).queries.map((query) => query.query);
    expect(named.every((name) => name === 'personal-work' || name === 'search')).toBe(true);
  });

  it('never returns summarize when summaries are disabled (the list is the reply)', async () => {
    const jira = new FakeConnector('jira', { items: jiraItems });
    const { say } = harness([jira], { summaryEnabled: false });
    const text = textOf(await say('내 Jira 이슈 보여줘'));
    expect(text).toContain('**Jira 내 항목** (2건)');
    expect(text).toContain('- [jira:PROJ-2] 문서 정리');
  });

  it('answers an empty result as an empty result of a successful lookup', async () => {
    const { say } = harness([new FakeConnector('slack', { items: [] })]);
    expect(textOf(await say('Slack에서 없는말 검색'))).toBe('Slack 검색 "없는말" 결과가 없어요.');
  });

  it('answers NOT_CONFIGURED without a connector call', async () => {
    const { say } = harness([new FakeConnector('jira')]);
    expect(textOf(await say('Slack에서 배포 검색'))).toContain('Slack 연결이 설정되어 있지 않아요');
  });

  it('answers IDENTITY_MISSING without a connector call', async () => {
    const jira = new FakeConnector('jira', { items: jiraItems });
    const { say } = harness([jira]);
    const noIdentity: Actor = { ...owner, identities: [{ platform: 'discord', externalId: 'discord-1' }] };
    expect(textOf(await say('내 Jira 이슈 보여줘', noIdentity))).toContain('계정 정보(identity)가 필요한데');
    expect(jira.queries).toHaveLength(0);
    expect(jira.availabilityChecks).toBe(0);
  });

  it('answers an unavailable connector deterministically', async () => {
    const jira = new FakeConnector('jira', { available: false });
    const { say } = harness([jira]);
    expect(textOf(await say('내 Jira 이슈 보여줘'))).toContain('지금은 Jira에 연결할 수 없어요');
    expect(jira.queries).toHaveLength(0);
  });

  it('maps ConnectorQueryError reasons to their copy', async () => {
    const expectations: Array<[ConnectorQueryError['reason'], string]> = [
      ['INSUFFICIENT_SCOPE', 'search:read'],
      ['UNAUTHORIZED', '인증에 실패'],
      ['FORBIDDEN', '허용하지 않았어요'],
      ['RATE_LIMITED', '요청 한도'],
      ['UNAVAILABLE', '연결할 수 없어요'],
      ['INVALID_RESPONSE', '해석하지 못했어요'],
      ['NOT_FOUND', '찾지 못했어요'],
      ['UNSUPPORTED_QUERY', '지원하지 않아요'],
    ];
    for (const [reason, copy] of expectations) {
      const slack = new FakeConnector('slack', { error: new ConnectorQueryError(reason) });
      const { say } = harness([slack]);
      expect(textOf(await say('Slack에서 배포 검색')), reason).toContain(copy);
    }
  });

  it('answers an unexpected connector error with the unavailable copy and no leaked message', async () => {
    const slack = new FakeConnector('slack', { error: new Error(`socket hang up ${SECRET}`) });
    const { say } = harness([slack]);
    const text = textOf(await say('Slack에서 배포 검색'));
    expect(text).toContain('연결할 수 없어요');
    expect(text).not.toContain(SECRET);
  });

  it('answers a hung connector with the timeout copy after the deadline', async () => {
    vi.useFakeTimers();
    const slack = new FakeConnector('slack', { hang: true });
    const { say } = harness([slack], { lookupDeadlineMs: 5_000 });
    const pending = say('Slack에서 배포 검색');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(textOf(await pending)).toContain('제한 시간 안에 응답하지 않았어요');
  });

  it('applies the default 15 second deadline', async () => {
    vi.useFakeTimers();
    const slack = new FakeConnector('slack', { hang: true });
    const { say } = harness([slack]);
    let settled = false;
    const pending = say('Slack에서 배포 검색').then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(textOf(await pending)).toContain('제한 시간');
  });

  it('answers an unsupported source/query pair without a connector call', async () => {
    const jira = new FakeConnector('jira', { items: jiraItems });
    const slack = new FakeConnector('slack', { items: jiraItems });
    const { say } = harness([jira, slack]);
    expect(textOf(await say('Jira에서 로그인 검색'))).toContain('"검색" 조회를 지원하지 않아요');
    const slackMine: WorkChatCommand = { kind: 'lookup', source: 'slack', query: 'my-items' };
    const { service } = harness([slack]);
    expect(textOf(await service.handle(slackMine, owner))).toContain('지원하지 않아요');
    expect(jira.queries).toHaveLength(0);
    expect(slack.queries).toHaveLength(0);
  });

  it('refuses a credential-bearing search text and an invalid one without a connector call', async () => {
    const slack = new FakeConnector('slack', { items: jiraItems });
    const { service } = harness([slack]);
    const search = (text: string): WorkChatCommand => ({ kind: 'lookup', source: 'slack', query: 'search', text });
    expect(textOf(await service.handle(search(`token ${SECRET}`), owner))).toContain('보내지 않았어요');
    expect(textOf(await service.handle(search('   '), owner))).toContain('검색어를 알려 주세요');
    expect(textOf(await service.handle(search('가'.repeat(101)), owner))).toContain('100자');
    expect(slack.queries).toHaveLength(0);
  });

  it('drops credential-bearing excerpts and items from the readout and the list', async () => {
    const jira = new FakeConnector('jira', {
      items: [
        { id: 'PROJ-1', title: '정상 항목', summary: `배포 토큰 ${SECRET}` },
        { id: 'PROJ-2', title: '비밀번호는 hunter2hunter2' },
        { id: 'PROJ-3', title: '다른 항목', summary: '괜찮은 본문' },
      ],
    });
    const { say } = harness([jira]);
    const outcome = await say('내 Jira 이슈 보여줘');
    if (outcome.kind !== 'summarize') throw new Error('expected summarize');
    expect(outcome.readout.omittedSensitive).toBe(2);
    expect(outcome.readout.items.map((item) => item.ref)).toEqual(['jira:PROJ-1', 'jira:PROJ-3']);
    const everything = JSON.stringify(outcome) + renderExternalWorkReadoutForPrompt(outcome.readout);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('hunter2');
    expect(outcome.fallbackText).toContain('민감정보가 있는 2건은 제외했어요');
  });

  it('keeps the readout within 10 items and 3,000 prompt characters, and the list within the reply budget', async () => {
    const many = Array.from({ length: 20 }, (_v, index) => ({
      id: `PROJ-${index + 1}`,
      title: `${'제목'.repeat(100)} ${index}`,
      summary: '본문'.repeat(200),
      url: `https://acme.atlassian.net/browse/PROJ-${index + 1}`,
      container: 'PROJ',
      status: 'Open',
    }));
    const { say } = harness([new FakeConnector('jira', { items: many })]);
    const outcome = await say('내 Jira 이슈 보여줘');
    if (outcome.kind !== 'summarize') throw new Error('expected summarize');
    // The summary readout holds only the items the 3,000-character prompt carries; the footer matches it exactly.
    const prompt = renderExternalWorkReadoutForPrompt(outcome.readout);
    expect(outcome.readout.items.length).toBeGreaterThan(0);
    expect(outcome.readout.items.length).toBeLessThanOrEqual(10);
    expect(outcome.readout.truncated).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(EXTERNAL_WORK_PROMPT_MAX_CHARS);
    expect(prompt).not.toMatch(/omitted for length/);
    expect(outcome.footer).toContain(`외부 항목 ${outcome.readout.items.length}건을 요약에 사용했어요.`);
    expect(outcome.footer.match(/<https:/g)).toHaveLength(outcome.readout.items.length);
    // The deterministic fallback list still shows all 10 items.
    expect(outcome.fallbackText).toContain('(10건, 일부만 표시)');
    expect(outcome.fallbackText.length).toBeLessThanOrEqual(WORK_CHAT_REPLY_MAX_CHARS);
  });

  it('returns a plain reply (not summarize) when every item was sensitive', async () => {
    const jira = new FakeConnector('jira', { items: [{ id: 'PROJ-1', title: '비밀번호는 hunter2hunter2' }] });
    const { say } = harness([jira]);
    const outcome = await say('내 Jira 이슈 보여줘');
    expect(outcome.kind).toBe('reply');
    expect(textOf(outcome)).toContain('민감정보가 있는 1건은 제외했어요');
  });
});

describe('isolation guarantees', () => {
  it('never rejects: even a throwing dependency becomes a deterministic reply', async () => {
    const service = new WorkChatService(
      {
        workSurface: { forActor: async () => { throw new Error('x'); } },
        connectors: { list: () => { throw new Error('registry down'); } },
        work: {
          create: async () => { throw new Error('x'); },
          listActiveByActor: async () => { throw new Error('x'); },
          transition: async () => { throw new Error('x'); },
          correlate: async () => { throw new Error('x'); },
        },
      },
      { summaryEnabled: true },
    );
    const commands: WorkChatCommand[] = [
      { kind: 'todo.add', title: 'x', refs: [] },
      { kind: 'todo.list' },
      { kind: 'todo.complete', target: { index: 1 } },
      { kind: 'todo.cancel', target: { text: 'x' } },
      { kind: 'todo.link', target: { index: 1 }, refs: [new ResourceRef({ source: 'jira', externalId: 'A-1' })] },
      { kind: 'lookup', source: 'jira', query: 'my-items' },
      { kind: 'lookup', source: 'slack', query: 'search', text: 'x' },
    ];
    for (const command of commands) {
      const outcome = await service.handle(command, owner);
      expect(outcome.kind).toBe('reply');
    }
    // A failed read-only list never claims something may have changed or points back to the failed command.
    const list = textOf(await service.handle({ kind: 'todo.list' }, owner));
    expect(list).toContain('불러오지 못했어요');
    expect(list).not.toContain('바뀌');
    expect(list).not.toContain('내 할 일');
  });
});

describe('natural completion hints (QA-V2-W7-03, hint-only)', () => {
  const other: Actor = { ...owner, id: 'other-1' };

  async function seeded() {
    const h = harness();
    await h.say('할 일 추가: 내일 9시에 회의 알려줘');
    await h.say('할 일 추가: 보고서 초안 쓰기');
    h.work.calls.length = 0;
    return h;
  }

  it.each([
    ['보고서 초안 쓰기 완료', '"보고서 초안 쓰기" 할 일을 완료 처리하려면 "완료 처리: 2"라고 보내 주세요. 아직 아무것도 바꾸지 않았어요.'],
    ['보고서 초안 쓰기 완료했어', '"완료 처리: 2"'],
    ['보고서 초안 쓰기 완료했어요!', '"완료 처리: 2"'],
    ['보고서 초안 쓰기 끝났어', '"완료 처리: 2"'],
    ['보고서  초안 쓰기 다 했어.', '"완료 처리: 2"'],
    ['"보고서 초안 쓰기" 완료', '"완료 처리: 2"'],
    ['보고서 초안 쓰기, 완료', '"완료 처리: 2"'],
    ['보고서 초안 쓰기 취소', '"할 일 취소: 2"'],
    ['2번 완료했어', '"완료 처리: 2"'],
    ['할 일 2 완료', '"완료 처리: 2"'],
    ['할 일 1 취소', '"할 일 취소: 1"'],
    ['2번 할 일 완료했어', '"완료 처리: 2"'],
  ])('hints for %s without any mutation', async (text, expected) => {
    const { say, work } = await seeded();
    const out = await say(text);
    expect(textOf(out)).toContain(expected);
    expect(work.calls).toEqual(['listActiveByActor']);
    expect(work.ofOwner().every((item) => item.status === WorkItemStatus.ACTIVE)).toBe(true);
  });

  it('falls through (none) for no match, a partial title, an out-of-range number and another actor', async () => {
    const { say, work } = await seeded();
    for (const text of ['점심 먹기 완료', '보고서 완료', '9번 완료했어', '할 일 7 완료']) {
      expect(await say(text), text).toEqual({ kind: 'none' });
    }
    expect(await say('보고서 초안 쓰기 완료', other)).toEqual({ kind: 'none' });
    expect(work.calls.every((call) => call === 'listActiveByActor')).toBe(true);
  });

  it('falls through when two open to-dos share the title, and for a closed to-do', async () => {
    const { say, work } = harness();
    await say('할 일 추가: 보고서 쓰기');
    await say('할 일 추가: 보고서 쓰기');
    expect(await say('보고서 쓰기 완료')).toEqual({ kind: 'none' });
    await say('완료 처리: 1');
    await say('완료 처리: 1');
    expect(work.ofOwner().every((item) => item.status === WorkItemStatus.COMPLETED)).toBe(true);
    expect(await say('보고서 쓰기 완료')).toEqual({ kind: 'none' });
  });

  it('falls through when reading the to-dos fails', async () => {
    const { say, work } = await seeded();
    work.listActiveByActor = async () => {
      throw new Error('storage offline');
    };
    expect(await say('보고서 초안 쓰기 완료')).toEqual({ kind: 'none' });
  });

  it('keeps the anchored and numbered D1 forms mutating exactly as before', async () => {
    const { say, work } = await seeded();
    expect(textOf(await say('완료 처리: 2'))).toContain('완료 처리했어요: "보고서 초안 쓰기"');
    expect(textOf(await say('2번 완료'))).toContain('2번 할 일');
    expect(textOf(await say('할 일 취소: 1'))).toContain('취소했어요: "내일 9시에 회의 알려줘"');
    expect(work.calls.filter((call) => call.startsWith('transition'))).toEqual([
      `transition:${WorkItemStatus.COMPLETED}`,
      `transition:${WorkItemStatus.CANCELED}`,
    ]);
  });
});

describe('reminder-shaped to-do add hint (QA-V2-W7-04)', () => {
  const HINT = '알림은 설정하지 않았어요. 알림이 필요하면 "내일 9시에 회의 알려줘"처럼 따로 보내 주세요.';

  it('appends one line when the title contains a reminder-shaped phrase, and still adds only the to-do', async () => {
    const { say, work } = harness();
    const text = textOf(await say('할 일 추가: 내일 9시에 회의 알려줘'));
    expect(text).toBe(`할 일을 추가했어요: "내일 9시에 회의 알려줘"\n${HINT}`);
    expect(work.calls).toEqual(['create']);
  });

  it('adds no hint for an ordinary title', async () => {
    const { say } = harness();
    expect(textOf(await say('할 일 추가: 보고서 초안 쓰기'))).toBe('할 일을 추가했어요: "보고서 초안 쓰기"');
  });
});

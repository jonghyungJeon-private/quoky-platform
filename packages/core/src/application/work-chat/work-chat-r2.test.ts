import { describe, expect, it } from 'vitest';
import type { Actor, ConversationContext, Session } from '../../domain';
import { SessionStatus } from '../../domain';
import { ConnectorQueryError } from '../../ports';
import type { ConnectorItem, ConnectorProvider, ConnectorQuery, ConnectorResult, Logger, TurnHandlerContext } from '../../ports';
import type { NlSelectedCommand } from '../nl-routing/catalog';
import { plainTextOf } from '../message-rendering';
import { renderUntrustedDocumentHistoryNote } from '../untrusted-document-readout';
import type { WorkChatCommand } from './work-chat-command';
import { WorkChatService, type WorkChatOutcome, type WorkChatServiceDeps, type WorkDesk, type WorkItemRead } from './work-chat-service';
import { WorkChatTurnHandler } from './work-chat-turn-handler';

const owner: Actor = {
  id: 'owner-1',
  displayName: 'Owner',
  identities: [
    { platform: 'jira', externalId: 'jira-owner' },
    { platform: 'slack', externalId: 'U0OWNER' },
  ],
  createdAt: '2026-10-02T00:00:00.000Z',
};

class FakeConnector implements ConnectorProvider {
  readonly readOnly = true;
  readonly queries: ConnectorQuery[] = [];
  constructor(
    readonly source: string,
    private readonly answer: (query: ConnectorQuery) => ConnectorResult | Promise<ConnectorResult>,
  ) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async query(input: ConnectorQuery): Promise<ConnectorResult> {
    this.queries.push(input);
    return this.answer(input);
  }
}

function jiraItems(count: number, withRef = true): ConnectorItem[] {
  return Array.from({ length: count }, (_v, i) => ({
    id: `PROJ-${i + 1}`,
    title: `Task ${i + 1}`,
    url: `https://acme.atlassian.net/browse/PROJ-${i + 1}`,
    ...(withRef ? { itemRef: `PROJ-${i + 1}:${10001 + i}` } : {}),
  }));
}
function slackItems(count: number): ConnectorItem[] {
  return Array.from({ length: count }, (_v, i) => ({ id: `C1:1700000000.00${i}`, title: `msg ${i + 1}`, itemRef: `C1:1700000000.00${i}` }));
}

function service(connectors: ConnectorProvider[], options: { summaryEnabled?: boolean; numberedLists?: boolean } = {}) {
  const deps: WorkChatServiceDeps = {
    workSurface: { async forActor() { return { status: 'COMPLETE', items: [], sources: [] }; } },
    connectors: { list: () => connectors },
    work: {} as unknown as WorkChatServiceDeps['work'],
  };
  return new WorkChatService(deps, {
    summaryEnabled: options.summaryEnabled ?? true,
    ...(options.numberedLists !== undefined ? { numberedLists: options.numberedLists } : {}),
  });
}

const jiraMine: WorkChatCommand = { kind: 'lookup', source: 'jira', query: 'my-items' };
const jiraMineList: WorkChatCommand = { kind: 'lookup', source: 'jira', query: 'my-items', listOnly: true };
const slackSearch: WorkChatCommand = { kind: 'lookup', source: 'slack', query: 'search', text: '배포' };

describe('WorkChatService: numbered lists (A6 R2, D1)', () => {
  const jira = () => new FakeConnector('jira', () => ({ source: 'jira', items: jiraItems(3) }));

  it('listOnly returns a listing receipt built from the itemRefs and numbered rows', async () => {
    const outcome = await service([jira()], { numberedLists: true }).handle(jiraMineList, owner);
    if (outcome.kind !== 'reply') throw new Error('expected reply');
    expect(outcome.listing).toEqual({
      source: 'jira',
      items: [
        { label: 1, id: 'PROJ-1:10001' },
        { label: 2, id: 'PROJ-2:10002' },
        { label: 3, id: 'PROJ-3:10003' },
      ],
    });
    expect(outcome.text).toMatch(/^1\. \[jira:PROJ-1\] Task 1/m);
    expect(outcome.text).toMatch(/^3\. \[jira:PROJ-3\] Task 3/m);
    expect(outcome.text).not.toContain('- [');
  });

  it('with summaries off the lookup is the numbered list with a receipt', async () => {
    const outcome = await service([jira()], { numberedLists: true, summaryEnabled: false }).handle(jiraMine, owner);
    if (outcome.kind !== 'reply') throw new Error('expected reply');
    expect(outcome.listing?.items).toHaveLength(3);
    expect(outcome.listed).toEqual({ count: 3, truncated: false });
  });

  it('with summaries on returns a summarize outcome with summary and fallback receipts', async () => {
    const outcome = await service([jira()], { numberedLists: true }).handle(jiraMine, owner);
    if (outcome.kind !== 'summarize') throw new Error('expected summarize');
    const expected = [1, 2, 3].map((n) => ({ label: n, id: `PROJ-${n}:${10000 + n}` }));
    expect(outcome.numbered?.fallback).toEqual({ source: 'jira', items: expected });
    expect(outcome.numbered?.summary).toEqual({ source: 'jira', items: expected });
    const footer = plainTextOf(outcome.footer);
    expect(footer).toContain('1. Task 1 https://acme.atlassian.net/browse/PROJ-1');
    expect(footer).toContain('3. Task 3');
    expect(plainTextOf(outcome.fallbackText)).toMatch(/^1\. \[jira:PROJ-1\]/m);
  });

  it('a row without an itemRef stops the receipt there', async () => {
    const mixed = jiraItems(3);
    delete mixed[1]!.itemRef;
    const outcome = await service([new FakeConnector('jira', () => ({ source: 'jira', items: mixed }))], { numberedLists: true, summaryEnabled: false }).handle(jiraMine, owner);
    if (outcome.kind !== 'reply') throw new Error('expected reply');
    expect(outcome.listing?.items).toEqual([{ label: 1, id: 'PROJ-1:10001' }]);
  });

  it('is byte-identical to before with numberedLists false or absent', async () => {
    const connector = jira();
    for (const options of [{}, { numberedLists: false }]) {
      const listOnly = await service([connector], options).handle(jiraMineList, owner);
      if (listOnly.kind !== 'reply') throw new Error('expected reply');
      expect('listing' in listOnly).toBe(false);
      expect(listOnly.text).toContain('- [jira:PROJ-1] Task 1');
      expect(listOnly.text).not.toMatch(/^\d+\. \[/m);
      const summarize = await service([connector], options).handle(jiraMine, owner);
      if (summarize.kind !== 'summarize') throw new Error('expected summarize');
      expect('numbered' in summarize).toBe(false);
      expect(plainTextOf(summarize.footer)).toContain('- Task 1');
      expect(plainTextOf(summarize.footer)).not.toMatch(/^1\. /m);
    }
  });

  it('numbers a Slack search likewise', async () => {
    const slack = new FakeConnector('slack', () => ({ source: 'slack', items: slackItems(2) }));
    const outcome = await service([slack], { numberedLists: true }).handle(slackSearch, owner);
    if (outcome.kind !== 'summarize') throw new Error('expected summarize');
    expect(outcome.numbered?.fallback.source).toBe('slack');
    expect(outcome.numbered?.fallback.items).toEqual([
      { label: 1, id: 'C1:1700000000.000' },
      { label: 2, id: 'C1:1700000000.001' },
    ]);
    expect(outcome.numbered?.summary.items).toHaveLength(2);
    const off = await service([slack], { numberedLists: false, summaryEnabled: false }).handle(slackSearch, owner);
    if (off.kind !== 'reply') throw new Error('expected reply');
    expect('listing' in off).toBe(false);
    expect(off.text).toContain('- [');
  });
});

describe('WorkChatService.readItem', () => {
  const REF = 'PROJ-1:10001';
  const detailItem = (extra: Partial<ConnectorItem> = {}): ConnectorItem => ({
    id: 'PROJ-1',
    title: 'T',
    itemRef: REF,
    detail: { sections: [{ kind: 'description', text: 'x' }], partial: false, people: [], requests: 1, bytes: 10 },
    ...extra,
  });
  const read = (connector: ConnectorProvider | undefined, ref = REF, scope: 'item' | 'thread' = 'item'): Promise<WorkItemRead> =>
    service(connector === undefined ? [] : [connector]).readItem('jira', ref, scope);

  it('sends exactly the item query with id and scope', async () => {
    const connector = new FakeConnector('jira', () => ({ source: 'jira', items: [detailItem()] }));
    const result = await read(connector);
    expect(connector.queries).toEqual([{ query: 'item', params: { id: REF, scope: 'item' } }]);
    expect(result.kind).toBe('item');
    await read(connector, REF, 'thread');
    expect(connector.queries[1]).toEqual({ query: 'item', params: { id: REF, scope: 'thread' } });
  });

  it('maps a thrown ConnectorQueryError to its reason', async () => {
    for (const reason of ['MOVED', 'NOT_FOUND', 'FORBIDDEN', 'RATE_LIMITED', 'UNAUTHORIZED', 'INSUFFICIENT_SCOPE'] as const) {
      const connector = new FakeConnector('jira', () => {
        throw new ConnectorQueryError(reason);
      });
      expect(await read(connector)).toEqual({ kind: 'failure', reason });
    }
    expect(await read(new FakeConnector('jira', () => { throw new Error('boom'); }))).toEqual({ kind: 'failure', reason: 'UNAVAILABLE' });
  });

  it('is NOT_CONFIGURED without a connector', async () => {
    expect(await read(undefined)).toEqual({ kind: 'failure', reason: 'NOT_CONFIGURED' });
  });

  it('answers INVALID_RESPONSE for zero or two items, no detail, or another itemRef', async () => {
    const cases: ConnectorItem[][] = [[], [detailItem(), detailItem()], [{ id: 'PROJ-1', title: 'T', itemRef: REF }], [detailItem({ itemRef: 'PROJ-9:10009' })], [detailItem({ itemRef: undefined })]];
    for (const items of cases) {
      expect(await read(new FakeConnector('jira', () => ({ source: 'jira', items })))).toEqual({ kind: 'failure', reason: 'INVALID_RESPONSE' });
    }
  });
});

// ── turn handler ───────────────────────────────────────────────────────────────────────────────────────────────────

const T0 = '2026-10-16T09:00:00.000Z';
const DM: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-user', direct: true };
const CHANNEL: ConversationContext = { platform: 'test', channelId: 'chan-1', userId: 'owner-user', direct: false };
const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function ctxOf(context: ConversationContext): TurnHandlerContext {
  const session: Session = { id: 's', actorId: owner.id, context, status: SessionStatus.ACTIVE, createdAt: T0, lastActivityAt: T0 };
  return {
    message: { id: 'msg-1', context, text: '1번 요약해줘', receivedAt: T0 },
    session,
    actor: owner,
    now: T0,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  };
}

function selected(source: string, args: Record<string, string> = {}, target: Partial<NonNullable<NlSelectedCommand['target']>> = {}): NlSelectedCommand {
  return {
    entryId: 'item.summarize',
    args: { source, mode: 'summary', scope: 'item', ...args },
    language: 'ko',
    target: { source: source as 'jira', id: 'PROJ-12:10012', label: 2, listingAt: '2026-10-16T08:00:00.000Z', ...target },
  } as NlSelectedCommand;
}

function itemWith(extra: Partial<ConnectorItem> = {}): ConnectorItem {
  return {
    id: 'PROJ-12',
    title: '결제 오류 수정',
    url: 'https://acme.atlassian.net/browse/PROJ-12',
    itemRef: 'PROJ-12:10012',
    detail: { sections: [{ kind: 'description', text: '결제 화면에서 오류가 나요' }], partial: false, people: [], requests: 1, bytes: 2_000 },
    ...extra,
  };
}

function handler(options: { read?: (source: string, ref: string, scope: string) => WorkItemRead; itemR2?: 'off' | 'shadow' | 'jira' | 'all'; summaryEnabled?: boolean; sources?: Array<'jira' | 'slack' | 'github'>; withReadItem?: boolean }) {
  const calls: Array<{ source: string; ref: string; scope: string }> = [];
  const desk: Pick<WorkDesk, 'handle' | 'configuredSources'> & Partial<Pick<WorkDesk, 'readItem'>> = {
    async handle(): Promise<WorkChatOutcome> {
      return { kind: 'none' };
    },
    configuredSources: () => options.sources ?? ['jira', 'slack'],
    ...(options.withReadItem === false
      ? {}
      : {
          async readItem(source, ref, scope) {
            calls.push({ source, ref, scope });
            return options.read?.(source, ref, scope) ?? { kind: 'item', item: itemWith() };
          },
        }),
  };
  const h = new WorkChatTurnHandler({
    desk,
    mode: 'lookup',
    summaryEnabled: options.summaryEnabled ?? true,
    ...(options.itemR2 !== undefined ? { itemR2: options.itemR2 } : { itemR2: 'all' as const }),
    logger,
  });
  return { h, calls };
}

describe('WorkChatTurnHandler: item.summarize catalog (A6 R2)', () => {
  const entry = (h: WorkChatTurnHandler) => h.catalog.find((e) => e.id === 'item.summarize');
  const sourceValues = (h: WorkChatTurnHandler) => entry(h)?.args.find((a) => a.name === 'source')?.values;

  it('offers item.summarize with only the configured R2 sources', () => {
    expect(sourceValues(handler({ sources: ['jira', 'slack'] }).h)).toEqual(['mail', 'drive', 'jira', 'slack']);
    expect(sourceValues(handler({ sources: ['jira', 'github'] }).h)).toEqual(['mail', 'drive', 'jira']);
    expect(sourceValues(handler({ sources: ['slack'] }).h)).toEqual(['mail', 'drive', 'slack']);
  });

  it('offers none for non-R2 sources, when itemR2 is off or absent, or without readItem', () => {
    expect(entry(handler({ sources: ['github'] }).h)).toBeUndefined();
    expect(entry(handler({ itemR2: 'off' }).h)).toBeUndefined();
    expect(entry(handler({ withReadItem: false }).h)).toBeUndefined();
    const noLevel = new WorkChatTurnHandler({ desk: { async handle() { return { kind: 'none' } as const; }, configuredSources: () => ['jira'], async readItem() { return { kind: 'failure', reason: 'UNAVAILABLE' } as const; } }, mode: 'lookup', summaryEnabled: true, logger });
    expect(noLevel.catalog.find((e) => e.id === 'item.summarize')).toBeUndefined();
  });

  it('offers it at shadow, jira and all', () => {
    for (const itemR2 of ['shadow', 'jira', 'all'] as const) expect(entry(handler({ itemR2 }).h)).toBeDefined();
  });
});

describe('WorkChatTurnHandler.handleSelected item.summarize (A6 R2)', () => {
  const text = (outcome: Awaited<ReturnType<WorkChatTurnHandler['handleSelected']>>): string => {
    if (outcome === null || outcome.kind === 'summarize' || !('reply' in outcome)) throw new Error('expected a reply outcome');
    return outcome.reply.text;
  };
  const replyOf = (outcome: Awaited<ReturnType<WorkChatTurnHandler['handleSelected']>>) => {
    if (outcome === null || outcome.kind === 'summarize' || !('reply' in outcome)) throw new Error('expected a reply outcome');
    return outcome;
  };

  it('refuses outside a DM with a not-dm receipt and zero reads', async () => {
    const { h, calls } = handler({});
    const outcome = replyOf(await h.handleSelected(selected('jira'), ctxOf(CHANNEL)));
    expect(outcome.reply.text).toBe('이 작업은 DM에서만 해요');
    expect(outcome.nlAction).toMatchObject({ entryId: 'item.summarize', result: 'refused', reason: 'not-dm', source: 'jira', itemId: 'PROJ-12:10012', label: 2 });
    expect(calls).toHaveLength(0);
  });

  it('refuses a summary while summaries are off, before any read', async () => {
    const { h, calls } = handler({ summaryEnabled: false });
    const outcome = replyOf(await h.handleSelected(selected('jira'), ctxOf(DM)));
    expect(text(outcome)).toBe("요약이 꺼져 있어요. '원문 보여줘'로 전체를 볼 수 있어요.");
    expect(outcome.nlAction).toMatchObject({ result: 'refused', reason: 'summary-off' });
    expect(calls).toHaveLength(0);
  });

  it('full mode shows the text without a model, keeps only the fixed history note and reports the fetch', async () => {
    const { h, calls } = handler({ summaryEnabled: false });
    const outcome = replyOf(await h.handleSelected(selected('jira', { mode: 'full' }), ctxOf(DM)));
    expect(calls).toEqual([{ source: 'jira', ref: 'PROJ-12:10012', scope: 'item' }]);
    expect(outcome.reply.text).toContain('결제 화면에서 오류가 나요');
    expect(outcome.reply.text).toContain('지라 이슈 2번 원문이에요');
    expect(outcome.history).toEqual({ assistant: renderUntrustedDocumentHistoryNote('jira-issue', 'ko') });
    expect(outcome.nlAction).toEqual({
      entryId: 'item.summarize',
      result: 'executed',
      source: 'jira',
      itemId: 'PROJ-12:10012',
      label: 2,
      fetch: { outcome: 'ok', count: 1, bytes: '<16KiB' },
    });
  });

  it('summary mode returns a summarize outcome over a jira-issue readout with history and receipt', async () => {
    const { h, calls } = handler({});
    const outcome = await h.handleSelected(selected('jira'), ctxOf(DM));
    if (outcome === null || outcome.kind !== 'summarize') throw new Error('expected summarize');
    expect(calls).toHaveLength(1);
    expect(outcome.readout).toMatchObject({ kind: 'untrusted-document', source: 'jira-issue' });
    expect('items' in outcome.readout).toBe(false);
    expect(outcome.history).toEqual({ assistant: renderUntrustedDocumentHistoryNote('jira-issue', 'ko') });
    expect(outcome.nlAction).toMatchObject({ result: 'executed', fetch: { outcome: 'ok', count: 1 } });
    expect(plainTextOf(outcome.footer)).toContain('출처: PROJ-12 https://acme.atlassian.net/browse/PROJ-12');
    expect(plainTextOf(outcome.fallbackText)).toContain("요약을 만들지 못했어요. '원문 보여줘'로 볼 수 있어요.");
  });

  it('a Slack thread summary uses the slack-thread source and its own history noun', async () => {
    const slackItem: ConnectorItem = {
      id: 'C1:1.1',
      title: '스레드',
      itemRef: 'C1:1.1',
      detail: { sections: [{ kind: 'message', author: 'U01', text: '안녕' }, { kind: 'message', author: 'U02', text: '답' }], partial: false, people: ['U01', 'U02'], requests: 1, bytes: 10 },
    };
    const { h, calls } = handler({ read: () => ({ kind: 'item', item: slackItem }) });
    const outcome = await h.handleSelected(selected('slack', { scope: 'thread' }, { id: 'C1:1.1' }), ctxOf(DM));
    if (outcome === null || outcome.kind !== 'summarize') throw new Error('expected summarize');
    expect(calls[0]).toEqual({ source: 'slack', ref: 'C1:1.1', scope: 'thread' });
    expect(outcome.readout.source).toBe('slack-thread');
    expect(outcome.history?.assistant).toContain('슬랙 스레드');
    expect(plainTextOf(outcome.footer)).toContain('출처: 슬랙 목록 2번');
  });

  it('a failure answers the fixed copy with a refused receipt', async () => {
    const { h } = handler({ read: () => ({ kind: 'failure', reason: 'MOVED' }) });
    const outcome = replyOf(await h.handleSelected(selected('jira'), ctxOf(DM)));
    expect(outcome.reply.text).toBe('그 이슈는 다른 곳으로 옮겨졌어요. 목록을 다시 보여 드릴까요?');
    expect(outcome.nlAction).toMatchObject({ result: 'refused', reason: 'moved', fetch: { outcome: 'moved', count: 1, bytes: '0' } });
    expect(outcome.history).toEqual({ assistant: renderUntrustedDocumentHistoryNote('jira-issue', 'ko') });
  });

  it('a thrown read is answered as unavailable', async () => {
    const { h } = handler({
      read: () => {
        throw new Error('boom');
      },
    });
    const outcome = replyOf(await h.handleSelected(selected('jira'), ctxOf(DM)));
    expect(outcome.reply.text).toBe('지라에 지금 연결할 수 없어요.');
    expect(outcome.nlAction).toMatchObject({ result: 'refused', reason: 'unavailable' });
  });

  it('a credential-shaped item is withheld and an empty one answered', async () => {
    const secret = handler({ read: () => ({ kind: 'item', item: itemWith({ detail: { sections: [{ kind: 'description', text: 'password: hunter2abc123XYZ' }], partial: false, people: [], requests: 1, bytes: 10 } }) }) });
    const withheld = replyOf(await secret.h.handleSelected(selected('jira'), ctxOf(DM)));
    expect(withheld.reply.text).toBe('비밀값처럼 보이는 내용이 있어 이 항목은 읽지 않았어요. 아무것도 보내지 않았어요.');
    expect(withheld.nlAction).toMatchObject({ result: 'refused', reason: 'credential-withheld' });
    const empty = handler({ read: () => ({ kind: 'item', item: itemWith({ detail: { sections: [], partial: false, people: [], requests: 1, bytes: 10 } }) }) });
    const emptied = replyOf(await empty.h.handleSelected(selected('jira'), ctxOf(DM)));
    expect(emptied.reply.text).toBe('내용이 비어 있어요.');
    expect(emptied.nlAction).toMatchObject({ reason: 'empty' });
  });

  it('refuses a Jira thread scope as not isolable, with zero reads', async () => {
    const { h, calls } = handler({});
    const outcome = replyOf(await h.handleSelected(selected('jira', { scope: 'thread' }), ctxOf(DM)));
    expect(outcome.reply.text).toBe("스레드 답글 하나만 따로 읽을 수는 없어요. '스레드 요약'으로 스레드 전체를 볼 수 있어요.");
    expect(outcome.nlAction).toMatchObject({ result: 'refused', reason: 'reply-not-isolable' });
    expect(calls).toHaveLength(0);
  });

  it('returns null for another source (mail), a missing target id, itemR2 off or no readItem', async () => {
    const { h, calls } = handler({});
    expect(await h.handleSelected(selected('mail'), ctxOf(DM))).toBeNull();
    expect(await h.handleSelected(selected('jira', {}, { id: undefined }), ctxOf(DM))).toBeNull();
    expect(await handler({ itemR2: 'off' }).h.handleSelected(selected('jira'), ctxOf(DM))).toBeNull();
    expect(await handler({ withReadItem: false }).h.handleSelected(selected('jira'), ctxOf(DM))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('adds the deterministic notes (a move, an edit after the listing) to the footer', async () => {
    const moved = itemWith({
      updatedAt: '2026-10-16T08:30:00.000Z',
      detail: { sections: [{ kind: 'description', text: '본문' }], partial: false, people: [], movedTo: 'NEW-3', requests: 1, bytes: 10 },
    });
    const { h } = handler({ read: () => ({ kind: 'item', item: moved }) });
    const outcome = await h.handleSelected(selected('jira'), ctxOf(DM));
    if (outcome === null || outcome.kind !== 'summarize') throw new Error('expected summarize');
    const footer = plainTextOf(outcome.footer);
    expect(footer).toContain('PROJ-12 → NEW-3으로 옮겨졌어요.');
    expect(footer).toContain('목록 이후 수정됨');
  });
});

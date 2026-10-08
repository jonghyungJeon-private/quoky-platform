import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_WRITE_NOT_SENT_REASONS,
  CONNECTOR_WRITE_OPERATIONS,
  CONNECTOR_WRITE_UNCERTAIN_REASONS,
  Capability,
  FeedbackSignalKind,
  IntentType,
  MEMORY_CONFIRM_PREVIEW_MAX_CHARS,
  LEARNING_EGRESS_LOCAL_ONLY,
  LearningItemKind,
  LearningService,
  ReminderStatus,
  ResourceRef,
  HELP_INTENT_HELP_LINES,
  HelpIntentTurnHandler,
  ResponseComposer,
  WorkItemStatus,
  appendWorkSummaryFooter,
  composeDailyBrief,
  composeFeedbackSummaryText,
  connectorWriteNotSent,
  connectorWriteSent,
  connectorWriteUncertain,
  feedbackRequestExcerpt,
  memoryBody,
  memoryPreview,
  placeCalendarSpan,
  renderCalendarEvents,
  renderConnectorWriteDuplicateRisk,
  renderConnectorWriteOpsApprovedNotice,
  renderHelpText,
  renderEditConfirmation,
  renderEdited,
  renderExternalWorkFooter,
  renderExternalWorkList,
  renderForgetConfirmation,
  renderForgotten,
  renderMemoryArchive,
  renderPurgeConfirmation,
  renderPurged,
  renderMemoryList,
  renderMemoryStatusLatest,
  renderMemoryView,
  renderMyWork,
  renderRestoreConfirmation,
  renderTodoAdded,
  renderTodoAmbiguous,
  renderTodoCanceled,
  renderTodoCompleted,
  renderTodoCompletionHint,
  renderTodoLinked,
  renderTodoNotFound,
  renderTodoStatusAnswer,
} from '@quoky/core';
import type {
  CalendarEvent,
  CalendarSpan,
  ConnectorWriteEventSummary,
  ConnectorWritePreview,
  ConnectorWriteRefusal,
  ConnectorWriteStep,
  ConnectorWriteTargetSummary,
  ConversationContext,
  ExternalWorkReadout,
  FeedbackRatedTurn,
  FeedbackSummary,
  LearningItem,
  MessageBody,
  OutboundMessage,
  Reminder,
  WorkItem,
  WorkSurface,
} from '@quoky/core';
import { renderDiscordContent, renderOutboundForDiscord } from './rendering';

/**
 * PLT-0 golden fixtures: the exact Discord text of a broad corpus of deterministic replies — every renderer whose text
 * carries untrusted spans, links or conversation references, with adversarial markup, and lists sized to cross each
 * budget (work-chat 1,800, calendar 1,900, footer 1,000, summary 1,900, message 1,900). The fixture was captured from
 * the renderers BEFORE Core stopped emitting Discord markup; Discord output must stay byte-identical, so the fixture
 * is never regenerated to make this test pass. `QUOKY_UPDATE_RENDER_GOLDEN=1` writes it (for a new, reviewed corpus).
 */

const FIXTURE = join(__dirname, '__golden__', 'discord-rendering.v1.json');

const DM: ConversationContext = { platform: 'discord', channelId: 'dm-1', userId: 'owner-1' };
const GUILD: ConversationContext = { platform: 'discord', spaceId: 'g-1', channelId: '900000000000000002', userId: 'owner-1' };
const THREAD: ConversationContext = { ...GUILD, threadId: '900000000000000003' };
const ODD_ID: ConversationContext = { ...GUILD, channelId: 'chan nel/odd' };

/** Markup, mention, link and quote syntax a readout or the owner could carry. */
const NASTY = '@everyone @here <@123> <@!7> <@&42> <#456> [click](https://x.example) *b* _i_ ~~s~~ `c` | > q \\ <https://y.example>';
const NASTY_WS = 'tab\there  two  spaces\nnew line\r\nwin';
const TITLES = [
  '로그인 버그 고치기',
  NASTY,
  NASTY_WS,
  'snake_case_title_with_*stars*_and_[brackets]',
  '`'.repeat(5) + ' fence ' + '~'.repeat(3),
  '<<< >>> <> < > @ @@',
  'a'.repeat(79) + '_',
];

const composer = new ResponseComposer();

/** The Discord text of whatever a renderer or composer produced (plain copy, neutral content or an outbound message). */
function discord(value: MessageBody | OutboundMessage): string {
  if (typeof value === 'string' || Array.isArray(value)) return renderDiscordContent(value as MessageBody);
  return renderOutboundForDiscord(value as OutboundMessage);
}

function todo(title: string | undefined, index = 0, refs: ResourceRef[] = []): WorkItem {
  return {
    id: `w-${index}`,
    actorId: 'actor-1',
    ...(title !== undefined ? { title } : {}),
    resourceRefs: refs,
    status: WorkItemStatus.ACTIVE,
    origin: 'conversation',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

const jira = (key: string) => new ResourceRef({ source: 'jira', externalId: key });
const github = (key: string) => new ResourceRef({ source: 'github', externalId: key });

function readout(items: ExternalWorkReadout['items'], over: Partial<ExternalWorkReadout> = {}): ExternalWorkReadout {
  return { kind: 'external-work', request: { source: 'jira', query: 'my-items' }, items, truncated: false, omittedSensitive: 0, ...over };
}

function readoutItems(count: number, titleOf: (i: number) => string, urlLength: number): ExternalWorkReadout['items'] {
  return Array.from({ length: count }, (_, i) => ({
    ref: `jira:P_${i}*`,
    title: titleOf(i),
    url: `https://example.atlassian.net/browse/P-${i}/${'u'.repeat(Math.max(0, urlLength - 40))}`.slice(0, 300),
    status: i % 2 === 0 ? 'In *Progress*' : 'To_Do',
    ...(i % 3 === 0 ? { dueDate: '2026-10-09' } : {}),
    ...(i % 4 === 0 ? { container: 'Team [A] @here' } : {}),
  }));
}

const NOW = '2026-10-06T01:00:00.000Z';

function calendarEvent(i: number, title: string, location?: string, zoneDay = 0): CalendarEvent {
  const start = Date.parse('2026-10-06T00:00:00.000Z') + zoneDay * 86_400_000 + i * 1_800_000;
  return {
    id: `e-${zoneDay}-${i}`,
    title,
    allDay: false,
    status: i % 5 === 4 ? 'tentative' : 'confirmed',
    calendarName: 'primary',
    start: new Date(start).toISOString(),
    end: new Date(start + 1_800_000).toISOString(),
    ...(location !== undefined ? { location } : {}),
  };
}

function calendar(span: CalendarSpan, events: readonly CalendarEvent[], timeZone = 'Asia/Seoul', language: 'ko' | 'en' = 'ko', writesEnabled = false, remaining = false) {
  const window = placeCalendarSpan(span, NOW, timeZone);
  if (window === undefined) throw new Error('no window');
  return renderCalendarEvents(window, events, { timeZone, now: NOW, language, limit: 50, writesEnabled, ...(remaining ? { remaining: true } : {}) });
}

function summarySample(): FeedbackSummary {
  return {
    since: '2026-09-02T00:00:00.000Z',
    turnCount: 4,
    signals: [
      { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'NEGATIVE', count: 2 },
      { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'POSITIVE', count: 1 },
    ],
    byCapability: [{ key: Capability.GENERAL_CHAT, turns: 3, positive: 1, negative: 2, implicit: 0 }],
    byIntent: [{ key: IntentType.CHAT, turns: 3, positive: 1, negative: 2, implicit: 0 }],
    recentNegative: TITLES.map((_, i) => ({ turnId: `t-${i}`, createdAt: '2026-10-01T00:00:00.000Z', intentType: IntentType.CHAT, taskId: `task-${i}` })),
  };
}

function reminder(no: number, body: string): Reminder {
  return {
    id: `r${no}`,
    actorId: 'a1',
    displayNo: no,
    status: ReminderStatus.SCHEDULED,
    kind: 'TEXT',
    body,
    schedule: { type: 'ONCE', at: '2026-10-02T06:00:00.000Z' },
    timeZone: 'Asia/Seoul',
    origin: DM,
    occurrenceAt: '2026-10-02T06:00:00.000Z',
    nextFireAt: '2026-10-02T06:00:00.000Z',
    attempt: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const PREVIEWS: readonly ConnectorWritePreview[] = [
  { operation: 'ISSUE_COMMENT', issueKey: 'PROJ-12', text: NASTY },
  { operation: 'ISSUE_COMMENT', issueKey: 'P-1', text: 'a ```` b\n`x`' },
  { operation: 'ISSUE_TRANSITION', issueKey: 'PROJ-12', toStatus: 'In *Review* @here', toStatusId: '31', transitionName: 'Send_to <review>', transitionId: '41' },
  { operation: 'CHANNEL_POST', channelLabel: 'dev_ops*', channelId: 'C0123', text: NASTY_WS },
  {
    operation: 'CALENDAR_EVENT_CREATE',
    timeZone: 'America/New_York',
    event: {
      title: NASTY,
      location: '3층 [A] _room_',
      description: '설명 ``` @everyone',
      time: { allDay: false, start: '2026-10-07T06:00:00.000Z', end: '2026-10-07T07:00:00.000Z', timeZone: 'America/Los_Angeles' },
    },
  },
  {
    operation: 'CALENDAR_EVENT_UPDATE',
    timeZone: 'Asia/Seoul',
    before: { id: 'e1', title: '주간 *회의*', start: '2026-10-07T06:00:00.000Z', end: '2026-10-07T07:00:00.000Z', allDay: false, location: '<#1>' },
    after: { title: '주간 회의 @here', time: { allDay: true, startDate: '2026-10-08', endDate: '2026-10-09' }, location: 'B_1' },
  },
  {
    operation: 'CALENDAR_EVENT_DELETE',
    timeZone: 'Asia/Seoul',
    before: { id: 'e2', title: '', start: '2026-10-08', end: '2026-10-10', allDay: true, location: '_x_' },
  },
];

const CANDIDATES: readonly ConnectorWriteEventSummary[] = TITLES.map((title, i) => ({
  id: `c${i}`,
  title,
  start: `2026-10-0${(i % 3) + 6}T0${i}:00:00.000Z`,
  end: `2026-10-0${(i % 3) + 6}T0${i}:30:00.000Z`,
  allDay: false,
  ...(i % 2 === 0 ? { location: TITLES[(i + 1) % TITLES.length] } : {}),
}));

const TARGETS: readonly ConnectorWriteTargetSummary[] = [
  { kind: 'issue', issueKey: 'PROJ_1*' },
  { kind: 'channel', channelLabel: 'dev_[ops]', channelId: 'C1' },
  { kind: 'calendar' },
];

const REFUSALS: readonly ConnectorWriteRefusal[] = ['transition-unavailable', 'binding-mismatch', 'credential', 'event-not-found'];

// --- review P3-5: mention case variants, astral clip boundaries, escape-limit crossings, purge copy, learning lists --
const MENTION_CASES = ['@EVERYONE 공지', '@Here 확인', '@eVeRyOnE <@!1> @HERE', 'mail@Everyone.test <@&9>'];
const EMOJI = '\u{1F600}';
/** Titles whose escaped form crosses a limit exactly at the boundary: `limit` characters of markup, one either side. */
function crossing(limit: number): string[] {
  return ['*'.repeat(limit), `${'x'.repeat(limit - 1)}*_`, `${'x'.repeat(limit)}_`, `${'_'.repeat(limit - 1)}${EMOJI}`, `${'x'.repeat(limit - 2)}${EMOJI}${EMOJI}`];
}

class GoldenLearningStore {
  constructor(private readonly items: readonly LearningItem[]) {}
  async list(query: { actorId: string; kind: LearningItemKind; now: string; limit: number }) {
    return this.items.filter((i) => i.actorId === query.actorId && i.kind === query.kind && i.expiresAt > query.now).slice(0, query.limit);
  }
  insertWithinCap(): never { throw new Error('unused'); }
  findBySourceTurn(): never { throw new Error('unused'); }
  get(): never { throw new Error('unused'); }
  updateData(): never { throw new Error('unused'); }
  delete(): never { throw new Error('unused'); }
  deleteBySourceMemory(): never { throw new Error('unused'); }
  pruneExpired(): never { throw new Error('unused'); }
}

async function extraCases(add: (id: string, value: never) => void): Promise<void> {
  const put = (id: string, value: unknown) => add(id, value as never);
  MENTION_CASES.forEach((title, m) => {
    put(`p35.mention.todo.${m}`, renderTodoAdded(todo(title, m)));
    put(`p35.mention.memory.${m}`, renderMemoryView(m + 1, memoryBody(title), 'ko'));
    put(`p35.mention.excerpt.${m}`, feedbackRequestExcerpt(title));
    put(`p35.mention.calendar.${m}`, calendar({ kind: 'day', offset: 0 }, [calendarEvent(1, title, title)]));
  });
  put(
    'p35.mention.brief',
    composeDailyBrief({ now: '2026-10-01T23:00:00.000Z', timeZone: 'Asia/Seoul', reminders: MENTION_CASES.map((t, i) => reminder(i + 1, t)), workItems: MENTION_CASES.map((t, i) => todo(t, i)) }),
  );

  // Astral emoji exactly at code-point and UTF-16 clip boundaries.
  put('p35.emoji.todo.80', renderMyWork([todo(`${'a'.repeat(78)}${EMOJI.repeat(3)}`, 0)], null));
  put('p35.emoji.memory.120', renderMemoryList({ page: 1, pages: 1, total: 1, rows: [{ number: 1, preview: memoryPreview(`${'b'.repeat(118)}${EMOJI.repeat(2)}`) }] }, 'ko'));
  put('p35.emoji.calendar.80', calendar({ kind: 'day', offset: 0 }, [calendarEvent(1, `${'c'.repeat(79)}${EMOJI}${EMOJI}`)]));
  const emojiFooter = renderExternalWorkFooter(readout([{ ref: 'jira:E-1', title: `${'d'.repeat(49)}${EMOJI}${EMOJI}`, url: 'https://e.test/1' }]));
  put('p35.emoji.footer.50', emojiFooter);
  put('p35.emoji.summary', appendWorkSummaryFooter(`${'요'.repeat(1)}${EMOJI.repeat(2000)}`, emojiFooter));
  put('p35.emoji.mywork.fit', renderMyWork(Array.from({ length: 15 }, (_, i) => todo(`${EMOJI.repeat(79)}*`, i)), null));
  const emojiChoice = composer.composeConnectorWriteStep(DM, {
    kind: 'choice',
    mode: 'delete',
    candidates: Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, title: `${EMOJI.repeat(40)}_`, start: '2026-10-06T01:00:00.000Z', end: '2026-10-06T02:00:00.000Z', allDay: false })),
    timeZone: 'Asia/Seoul',
  });
  put('p35.emoji.notice.clamp', composer.composeWithNotice(composer.composeConnectorWriteStep(DM, { kind: 'closed', reason: 'expired', family: 'issue' }), emojiChoice));

  // Escaped titles crossing the 50 (footer), 80 (list title) and 120 (status answer, memory preview) limits.
  crossing(50).forEach((title, c) => put(`p35.limit.footer.50.${c}`, renderExternalWorkFooter(readout([{ ref: 'jira:L-1', title, url: 'https://e.test/l' }]))));
  crossing(80).forEach((title, c) => {
    put(`p35.limit.list.80.${c}`, renderTodoAmbiguous('complete', [{ no: 1, item: todo(title, 1) }, { no: 2, item: todo(title, 2) }]));
    put(`p35.limit.calendar.80.${c}`, calendar({ kind: 'day', offset: 0 }, [calendarEvent(1, title)]));
  });
  crossing(120).forEach((title, c) => {
    put(`p35.limit.status.120.${c}`, renderTodoStatusAnswer(todo(title, 1), 1));
    put(`p35.limit.memory.120.${c}`, renderMemoryStatusLatest(memoryPreview(title), 1, 'ko'));
  });

  // The read-only Personal Work Surface lookup line (composeWorkSurface), with connector titles and URLs.
  const surfaceItems = [...TITLES, ...MENTION_CASES].map((title, i) => ({
    resource: i % 2 ? github(`o/r#${i}`) : jira(`PROJ-${i}`),
    title,
    ...(i % 3 === 2 ? {} : { url: `https://example.test/w/${i}_x` }),
  }));
  put('p35.worksurface.items', composer.composeWorkSurface(DM, { status: 'COMPLETE', items: surfaceItems, sources: [] }));
  put('p35.worksurface.many', composer.composeWorkSurface(DM, { status: 'PARTIAL', items: [...surfaceItems, ...surfaceItems, ...surfaceItems], sources: [{ source: 'github', status: 'IDENTITY_MISSING', message: '' }] }));
  put('p35.worksurface.empty', composer.composeWorkSurface(DM, { status: 'COMPLETE', items: [], sources: [] }));
  put('p35.worksurface.unavailable', composer.composeWorkSurface(DM, { status: 'UNAVAILABLE', items: [], sources: [{ source: 'jira', status: 'UNAVAILABLE', message: '' }] }));

  // Permanent delete of an archived memory.
  for (const language of ['ko', 'en'] as const) {
    TITLES.slice(0, 3).forEach((title, t) => {
      put(`p35.purge.confirm.${language}.${t}`, renderPurgeConfirmation(t + 1, memoryPreview(title, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), 'PQ7Z', language));
      put(`p35.purged.${language}.${t}`, renderPurged(memoryPreview(title, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), t, language));
    });
  }

  // Learning candidate and example lists (request excerpts are untrusted handles).
  const requests = [...TITLES, ...MENTION_CASES, `${'긴 요청 '.repeat(20)}@x`];
  const turns: FeedbackRatedTurn[] = requests.map((_, i) => ({
    turnId: `turn-${i}`,
    createdAt: `2026-10-0${(i % 5) + 1}T09:00:00.000Z`,
    taskId: `task-${i}`,
    intentType: IntentType.CHAT,
    capability: Capability.GENERAL_CHAT,
    positive: i % 2,
    negative: (i + 1) % 2,
  }));
  const items: LearningItem[] = requests.map((requestText, i) => ({
    id: `item-${i}`,
    actorId: 'actor-1',
    kind: LearningItemKind.EXAMPLE,
    capability: Capability.GENERAL_CHAT,
    language: 'ko',
    egress: LEARNING_EGRESS_LOCAL_ONLY,
    createdAt: `2026-10-0${(i % 5) + 1}T10:00:00.000Z`,
    expiresAt: '2027-01-01T00:00:00.000Z',
    data: { requestText, ...(i % 2 ? { idealAnswer: '좋은 답' } : {}), sourceRating: 'POSITIVE' },
  }));
  const learning = new LearningService({
    feedback: { listRatedTurns: async () => turns },
    learning: new GoldenLearningStore(items) as never,
    tasks: { get: async (id: string) => ({ description: requests[Number(id.slice(5))] ?? '' }) },
  });
  const scope = { actorId: 'actor-1', platform: 'discord', channelId: 'c1' };
  put('p35.learning.candidates', await learning.execute({ kind: 'list-candidates' }, scope, '2026-10-06T12:00:00.000Z'));
  put('p35.learning.examples', await learning.execute({ kind: 'list-examples' }, scope, '2026-10-06T12:00:00.000Z'));
}

/** Build the whole corpus: case id -> the Discord text. */
async function corpus(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const add = (id: string, value: MessageBody | OutboundMessage) => {
    if (Object.hasOwn(out, id)) throw new Error(`duplicate golden case ${id}`);
    out[id] = discord(value);
  };

  // --- work chat: to-do replies -----------------------------------------------------------------------------------
  TITLES.forEach((title, t) => {
    const item = todo(title, t, [jira(`P_${t}*`), github('o/r#1'), jira('X-1'), jira('Y-2')]);
    add(`todo.added.${t}`, renderTodoAdded(item, t % 2 === 0));
    add(`todo.status.${t}`, renderTodoStatusAnswer(item, t + 1));
    add(`todo.status.completed.${t}`, renderTodoStatusAnswer({ ...item, status: WorkItemStatus.COMPLETED }, t + 1));
    add(`todo.hint.${t}`, renderTodoCompletionHint(t % 2 === 0 ? 'complete' : 'cancel', t + 1, item));
    add(`todo.completed.${t}`, renderTodoCompleted(item));
    add(`todo.canceled.${t}`, renderTodoCanceled(item));
    add(`todo.linked.${t}`, renderTodoLinked(item, [jira('NEW_1')]));
    add(`todo.linked.none.${t}`, renderTodoLinked(item, []));
    add(`todo.notfound.${t}`, renderTodoNotFound({ text: title }, t));
  });
  add('todo.notfound.index', renderTodoNotFound({ index: 3 }, 0));
  // DET-2: a hint about a to-do that is already closed answers with its status (number 0: not in the open list).
  TITLES.forEach((title, t) => {
    add(`todo.status.closed.${t}`, renderTodoStatusAnswer({ ...todo(title, t), status: t % 2 ? WorkItemStatus.CANCELED : WorkItemStatus.COMPLETED }, 0));
  });
  add('todo.untitled', renderTodoAdded(todo(undefined)));
  add('todo.ambiguous', renderTodoAmbiguous('complete', TITLES.map((title, i) => ({ no: i + 1, item: todo(title, i) }))));
  add(
    'todo.ambiguous.many',
    renderTodoAmbiguous('link', Array.from({ length: 20 }, (_, i) => ({ no: i + 1, item: todo(`${TITLES[i % TITLES.length]} ${'*'.repeat(i * 3)}`, i) }))),
  );
  add('todo.added.long', renderTodoAdded(todo(`${'_*'.repeat(150)}`, 1)));

  // --- work chat: combined view (1,800 budget, droppable lines) -----------------------------------------------------
  for (const stars of [0, 10, 20, 30, 40]) {
    for (const count of [3, 12, 15, 18]) {
      const todos = Array.from({ length: count }, (_, i) => todo(`${'할일'.repeat(10)}${'*'.repeat(stars)}${'가'.repeat(Math.max(0, 40 - stars))}${i}`, i, i % 2 ? [jira(`K_${i}`)] : []));
      const surface: WorkSurface = {
        status: count > 12 ? 'PARTIAL' : 'COMPLETE',
        items: Array.from({ length: Math.min(count, 12) }, (_, i) => ({
          resource: i % 2 ? github(`o/r_${i}#${i}`) : jira(`PROJ-${i}`),
          title: `${NASTY.slice(0, stars + 10)} ${i}`,
          ...(i % 3 === 0 ? {} : { url: `https://example.test/item/${i}/${'p'.repeat(stars * 4)}` }),
        })),
        sources: [
          { source: 'jira', status: 'AVAILABLE', message: '' },
          { source: 'github', status: count > 12 ? 'UNAVAILABLE' : 'AVAILABLE', message: '' },
        ],
      };
      add(`mywork.${stars}.${count}`, renderMyWork(todos, surface));
    }
  }
  add('mywork.empty', renderMyWork([], { status: 'COMPLETE', items: [], sources: [] }));
  add('mywork.surface-null', renderMyWork([todo(NASTY)], null));
  add('mywork.bad-url', renderMyWork([], { status: 'COMPLETE', items: [{ resource: jira('A-1'), title: 'x', url: 'javascript:alert(1)' }, { resource: jira('A-2'), title: 'y', url: 'https://ok.test/a b' }], sources: [] }));

  // --- work chat: lookup lists (1,800 budget) and summary footer (1,000) --------------------------------------------
  for (const stars of [0, 15, 30, 45]) {
    for (const urlLength of [40, 160, 300]) {
      const items = readoutItems(10, (i) => `${'제목'.repeat(20)}${'_'.repeat(stars)}${'x'.repeat(Math.max(0, 50 - stars))} ${i}`, urlLength);
      const r = readout(items, { truncated: stars > 20, omittedSensitive: urlLength === 300 ? 2 : 0 });
      add(`lookup.list.${stars}.${urlLength}`, renderExternalWorkList(r));
      const footer = renderExternalWorkFooter(r);
      add(`lookup.footer.${stars}.${urlLength}`, footer);
      add(`lookup.summary.${stars}.${urlLength}`, appendWorkSummaryFooter(`${'요약 문장입니다. '.repeat(stars * 4)}**끝**`, footer));
    }
  }
  add('lookup.list.empty', renderExternalWorkList(readout([])));
  add('lookup.list.search', renderExternalWorkList(readout(readoutItems(2, (i) => TITLES[i] as string, 60), { request: { source: 'slack', query: 'search', text: NASTY } })));
  add('lookup.footer.nasty', renderExternalWorkFooter(readout(TITLES.map((title, i) => ({ ref: `jira:N-${i}`, title, url: `https://example.test/${i}` })))));
  add('lookup.footer.nourl', renderExternalWorkFooter(readout([{ ref: 'jira:N-1', title: NASTY }])));
  add('lookup.summary.empty-footer', appendWorkSummaryFooter(`${'긴 요약 '.repeat(400)}`, ''));

  // --- calendar (1,900 budget, code points, grouped days) -----------------------------------------------------------
  const zones = ['Asia/Seoul', 'America/New_York', 'America/Los_Angeles'];
  for (const [z, zone] of zones.entries()) {
    add(`calendar.day.${z}`, calendar({ kind: 'day', offset: 0 }, TITLES.map((title, i) => calendarEvent(i, title, i % 2 ? NASTY_WS : undefined)), zone));
    add(`calendar.day.en.${z}`, calendar({ kind: 'day', offset: 0 }, TITLES.map((title, i) => calendarEvent(i, title)), zone, 'en', true));
    add(`calendar.empty.${z}`, calendar({ kind: 'day', offset: 1 }, [], zone));
    add(`calendar.next.${z}`, calendar({ kind: 'next' }, [calendarEvent(3, NASTY, '<#1> @x')], zone));
  }
  // DET-2: "남은 일정" (remaining) headers and empty-period copy.
  for (const [z, zone] of zones.entries()) {
    for (const language of ['ko', 'en'] as const) {
      add(`calendar.remaining.day.${z}.${language}`, calendar({ kind: 'day', offset: 0 }, TITLES.map((title, i) => calendarEvent(i, title, i % 2 ? NASTY : undefined)), zone, language, z === 1, true));
      add(`calendar.remaining.empty.${z}.${language}`, calendar({ kind: 'day', offset: 0 }, [], zone, language, false, true));
      add(`calendar.remaining.one.${z}.${language}`, calendar({ kind: 'day', offset: 0 }, [calendarEvent(2, NASTY_WS, '<#7>')], zone, language, false, true));
    }
  }
  for (const stars of [0, 40, 79]) {
    const events = Array.from({ length: 25 }, (_, i) => calendarEvent(i % 9, `${'회의'.repeat(5)}${'*'.repeat(stars)}${'가'.repeat(Math.max(0, 70 - stars))}`, `${'_'.repeat(Math.min(39, stars))}장소`, i % 3));
    add(`calendar.remaining.week.${stars}`, calendar({ kind: 'week', which: 'this' }, events, 'Asia/Seoul', 'ko', false, true));
  }
  for (const stars of [0, 20, 40, 60, 79]) {
    for (const days of [1, 3]) {
      const events = Array.from({ length: 25 }, (_, i) =>
        calendarEvent(i % 9, `${'회의'.repeat(5)}${'*'.repeat(stars)}${'가'.repeat(Math.max(0, 70 - stars))}`, i % 2 ? `${'_'.repeat(Math.min(39, stars))}장소` : undefined, i % days),
      );
      add(`calendar.week.${stars}.${days}`, calendar({ kind: 'week', which: 'this' }, events));
      add(`calendar.day.full.${stars}.${days}`, calendar({ kind: 'day', offset: 0 }, events.filter((e) => e.id.startsWith('e-0-')), 'Asia/Seoul', days === 1 ? 'ko' : 'en'));
    }
  }

  // --- connector writes (previews are never clamped; other steps are bounded to one message) ------------------------
  const approval = { id: 'approval-1' } as never;
  PREVIEWS.forEach((preview, p) => {
    add(`cw.preview.${p}`, composer.composeConnectorWriteStep(DM, { kind: 'preview', preview, approval, remainingMs: 29 * 60_000 + 1, executionPhrase: '댓글 실행' }));
    // UNC-1: the duplicate-risk lead of a preview whose identical earlier request is unresolved.
    for (const [u, unconfirmedEarlier] of [
      { status: 'UNCERTAIN', at: '2026-10-06T08:01:00.000Z', timeZone: 'Asia/Seoul' },
      { status: 'EXECUTING', at: '2026-10-06T23:59:00.000Z', timeZone: 'America/New_York' },
      { status: 'UNCERTAIN', at: 'not-a-time', timeZone: 'Asia/Seoul' },
    ].entries()) {
      add(
        `cw.preview.duplicate-risk.${p}.${u}`,
        composer.composeConnectorWriteStep(DM, { kind: 'preview', preview, approval, remainingMs: 600_000, executionPhrase: '게시 실행', unconfirmedEarlier } as ConnectorWriteStep),
      );
    }
    add(`cw.pending.${p}`, composer.composeConnectorWritePending(DM, preview, 60_000, '게시 실행'));
    const outcomes = [connectorWriteSent(`ref_${p}*`, `https://example.test/${p}_x`), connectorWriteSent(NASTY), connectorWriteSent(''), connectorWriteSent('r', 'http://not-https.test')];
    outcomes.forEach((outcome, o) => {
      add(`cw.outcome.${p}.${o}`, composer.composeConnectorWriteStep(DM, { kind: 'outcome', operation: preview.operation, outcome, preview }));
    });
  });
  for (const operation of CONNECTOR_WRITE_OPERATIONS) {
    for (const reason of CONNECTOR_WRITE_NOT_SENT_REASONS) {
      add(`cw.notsent.${operation}.${reason}`, composer.composeConnectorWriteStep(DM, { kind: 'outcome', operation, outcome: connectorWriteNotSent(reason), preview: PREVIEWS[0] as ConnectorWritePreview }));
    }
    for (const reason of CONNECTOR_WRITE_UNCERTAIN_REASONS) {
      add(`cw.uncertain.${operation}.${reason}`, composer.composeConnectorWriteStep(DM, { kind: 'outcome', operation, outcome: connectorWriteUncertain(reason), preview: PREVIEWS[0] as ConnectorWritePreview }));
    }
    for (const status of ['SENT', 'NOT_SENT', 'UNCERTAIN', 'EXECUTING'] as const) {
      add(`cw.repeat.${operation}.${status}`, composer.composeConnectorWriteStep(DM, { kind: 'repeat', operation, status, externalRef: 'R_1*', url: status === 'SENT' ? 'https://example.test/r_1' : undefined } as ConnectorWriteStep & { kind: 'repeat' }));
    }
    add(`cw.already-sent.${operation}`, composer.composeConnectorWriteStep(DM, { kind: 'already-sent', operation, externalRef: NASTY }));
    add(`cw.already-sent.url.${operation}`, composer.composeConnectorWriteStep(DM, { kind: 'already-sent', operation, url: 'https://example.test/a_b' }));
    add(`cw.approved.${operation}`, composer.composeConnectorWriteStep(DM, { kind: 'approved', operation, executionPhrase: '실행' }));
    add(`cw.already-approved.${operation}`, composer.composeConnectorWriteAlreadyApproved(DM, operation, '실행'));
    TARGETS.forEach((target, t) => {
      add(`cw.reminder.${operation}.${t}`, composer.composeConnectorWriteApprovedReminder(DM, operation, '실행', target));
      add(`cw.bare.${operation}.${t}`, composer.composeConnectorWriteBareExecution(DM, operation, '실행', target));
      add(`cw.executed.${operation}.${t}`, composer.composeConnectorWriteAlreadyExecuted(DM, operation, { sentAt: '2026-10-06T01:02:00.000Z', target, timeZone: 'Asia/Seoul', ...(t === 0 ? { url: 'https://example.test/x_1' } : t === 1 ? { externalRef: NASTY } : {}) }));
      [DM, GUILD, THREAD, ODD_ID].forEach((context, c) => {
        add(`cw.elsewhere.${operation}.${t}.${c}`, composer.composeConnectorWriteApprovedElsewhere(DM, { operation, target, context, executionPhrase: '실행', remainingMs: 600_000 }));
        add(`cw.ops-notice.${operation}.${t}.${c}`, renderConnectorWriteOpsApprovedNotice({ operation, target, executionPhrase: '실행', remainingMs: 600_000, chat: context }));
      });
      add(`cw.latest.${operation}.${t}`, composer.composeConnectorWriteLatestRequest(DM, { taskId: 't', operation, target, createdAt: NOW, state: { kind: 'closed', reason: 'denied' } }, t === 1));
    });
  }
  for (const operation of CONNECTOR_WRITE_OPERATIONS) {
    add(`cw.duplicate-risk.${operation}`, renderConnectorWriteDuplicateRisk(operation, { status: 'UNCERTAIN', at: '2026-10-06T08:01:00.000Z', timeZone: 'Asia/Seoul' }));
  }
  for (const mode of ['update', 'delete'] as const) {
    for (const basis of [undefined, 'listed', 'written', 'nearby'] as const) {
      add(`cw.choice.${mode}.${basis ?? 'dated'}`, composer.composeConnectorWriteStep(DM, { kind: 'choice', mode, candidates: CANDIDATES, timeZone: 'America/New_York', ...(basis ? { basis } : {}) }));
    }
  }
  for (const reason of REFUSALS) {
    add(`cw.refused.${reason}`, composer.composeConnectorWriteStep(DM, { kind: 'refused', reason, family: 'issue', availableStatuses: ['Done_*', NASTY, '<#9>'] }));
  }

  // --- memory commands (owner text echoed back) ---------------------------------------------------------------------
  const memories = [...TITLES, `${'긴 기억 '.repeat(300)}*`, 'line1\nline2 @everyone\n\n  line3'];
  memories.forEach((content, m) => {
    add(`memory.view.${m}`, renderMemoryView(m + 1, memoryBody(content), 'ko'));
    add(`memory.forget.${m}`, renderForgetConfirmation(m + 1, memoryPreview(content, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), 'AB2C', m % 2 ? 'en' : 'ko'));
    add(`memory.edit.${m}`, renderEditConfirmation(m + 1, memoryPreview(content, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), memoryPreview(NASTY, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), 'AB2C', 'ko'));
    add(`memory.forgotten.${m}`, renderForgotten(memoryPreview(content, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), m, m % 2 ? 'en' : 'ko', { mode: 'archived', archiveDays: 7 }));
    add(`memory.edited.${m}`, renderEdited(memoryPreview(content, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), 'ko', m % 2 === 0, m % 3 === 0));
    add(`memory.status.${m}`, renderMemoryStatusLatest(memoryPreview(content), m + 1, 'ko'));
    add(`memory.restore.${m}`, renderRestoreConfirmation(m + 1, memoryPreview(content, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), 'ZZ99', 'en'));
  });
  add('memory.list', renderMemoryList({ page: 1, pages: 2, total: 12, rows: memories.map((content, i) => ({ number: i + 1, preview: memoryPreview(content) })) }, 'ko'));
  add('memory.archive', renderMemoryArchive({ page: 1, pages: 1, total: 3, rows: memories.slice(0, 3).map((content, i) => ({ number: i + 1, preview: memoryPreview(content), daysLeft: i + 1 })) }, 'en'));

  // --- feedback summary, daily brief ---------------------------------------------------------------------------------
  const excerpts = new Map(TITLES.map((title, i) => [`task-${i}`, `${title} \`x\` @someone`]));
  add('feedback.summary', composeFeedbackSummaryText(summarySample(), excerpts));
  TITLES.forEach((title, i) => add(`feedback.excerpt.${i}`, feedbackRequestExcerpt(title)));
  add(
    'brief.nasty',
    composeDailyBrief({
      now: '2026-10-01T23:00:00.000Z',
      timeZone: 'Asia/Seoul',
      reminders: TITLES.map((title, i) => reminder(i + 1, title)),
      workItems: [...TITLES, '@EVERYONE <@1> @Here'].map((title, i) => todo(title, i)),
    }),
  );
  add(
    'brief.long',
    composeDailyBrief({ now: '2026-10-01T23:00:00.000Z', timeZone: 'Asia/Seoul', reminders: null, workItems: Array.from({ length: 30 }, (_, i) => todo(`${'@here '.repeat(20)}${i}`, i)) }),
  );

  // --- composer: help, notices, approval references ------------------------------------------------------------------
  add('help.base', composer.composeHelp(DM));
  add('help.contributed', composer.composeHelp(DM, ['- 할 일: "할 일 추가: 내용"', '- 업무 조회: "내 Jira 이슈"']));
  add('help.overflow', composer.composeHelp(DM, Array.from({ length: 14 }, (_, i) => `- 줄 ${i} ${'가'.repeat(110)}`)));
  // DET-2: the help text a capability question gets ("뭐 할 수 있어?"), with and without contributed lines.
  add('help.text.base', renderHelpText());
  add('help.text.capability', renderHelpText([...HELP_INTENT_HELP_LINES, '- 할 일: "할 일 추가: 내용"']));
  add('help.text.overflow', renderHelpText(Array.from({ length: 14 }, (_, i) => `- 줄 ${i} ${'가'.repeat(110)}`)));
  const helpIntent = new HelpIntentTurnHandler({ helpLines: [...HELP_INTENT_HELP_LINES, '- 할 일: "할 일 추가: 내용"'] });
  for (const [q, question] of ['뭐 할 수 있어?', 'what can you do?'].entries()) {
    const outcome = await helpIntent.handle({ message: { id: `m-${q}`, context: DM, text: question, receivedAt: NOW } } as never);
    if (outcome === null || !('reply' in outcome)) throw new Error(`no capability answer for ${question}`);
    add(`help.intent.capability.${q}`, outcome.reply);
  }
  const notice = composer.composeConnectorWriteStep(DM, { kind: 'closed', reason: 'expired', family: 'issue' });
  const preview = composer.composeConnectorWriteStep(DM, { kind: 'preview', preview: PREVIEWS[0] as ConnectorWritePreview, approval, remainingMs: 60_000, executionPhrase: '댓글 실행' });
  add('notice.preview', composer.composeWithNotice(notice, preview));
  add('notice.long', composer.composeWithNotice(notice, composer.composeConnectorWriteStep(DM, { kind: 'choice', mode: 'delete', candidates: [...CANDIDATES, ...CANDIDATES, ...CANDIDATES], timeZone: 'Asia/Seoul' })));
  add('approval.reference', composer.composeApprovalConfirmationReference(preview, 'K7Q2'));
  add('model-reply.table', { context: DM, text: '| a | b |\n|---|---|\n| 1 | 2 |', format: 'model-reply' });
  await extraCases(add as never);
  return out;
}

describe('Discord rendering goldens (PLT-0)', () => {
  it('renders every corpus case to the byte-identical Discord text', async () => {
    const actual = await corpus();
    if (process.env['QUOKY_UPDATE_RENDER_GOLDEN'] === '1') {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE)).toBe(true);
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, text] of Object.entries(expected)) expect(actual[id], id).toBe(text);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Capability, type Actor, type IsoTimestamp, type Session } from '../../domain';
import type { AiProvider, AiRequest, LogFields, Logger } from '../../ports';
import { LAST_LISTING_METADATA_KEY, withLabelledListing, withListingReplies } from '../last-listing';
import {
  NL_ACTION_ENTRIES,
  NL_R5A_VOCABULARY_ADDITIONS,
  nlActionWordGrounded,
  nlDeicticOriginOf,
  nlNamedItemSources,
  withoutNlOriginPhrases,
  withoutStructures,
} from './action-entries';
import { ACTION_SWITCH_METADATA_KEY, NlActionSwitch } from './action-switch';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry, type NlSelectedCommand } from './catalog';
import { DEICTIC_DRAFT_METADATA_KEY, readDeicticDraft, withDeicticDraft } from './deictic-draft';
import { interpretDeicticDraftReply } from './deictic-draft-reply';
import type { NlDeicticTextReader } from './deictic-writes';
import { LAST_ACTION_METADATA_KEY, withLastAction } from './last-action';
import { LAST_TURN_METADATA_KEY, nlOwnerMessageEligibility, readLastTurn, withLastTurnReplies } from './last-turn';
import { NL_ACTION_LOG_EVENT, NlActionCaps, renderDeicticPayload, renderGarbledAction } from './nl-action-policy';
import { DEICTIC_BLOCKING_FAILURES, NlActionsConfigError, NlSelectionService, type NlSelectionDecision } from './nl-selection-service';
import { NL_PENDING_METADATA_KEY, pendingQuestionRecord, readPendingQuestion } from './selection-state';
import { NL_ACTION_WORDS } from './action-entries';
import { nlRequestVeto } from './request-shape';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 amendment A6 R5a (deictic writes): the narrow draft matcher, eligibility at receipt, the origin words, the
// resolution order and the preview / approval cycle at the selection service over scripted selector outputs and fake
// stores; the offline run of the deictic corpus (`golden/nl-action.deictic.v1.json`); and the vocabulary no-regression
// gate with R5 OFF over every `nl-action` gold. No model call.

const T0 = '2026-10-16T03:00:00.000Z';
const at = (minutes: number): IsoTimestamp => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const ALL = [...READS, ...ACTIONS];
const out = (entryId: string, args: Record<string, unknown> = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });
const NONE = out('none');
const ACTOR = 'owner';
const SESSION = 'sess-1';
const PREV = 'prev-turn';

interface Item {
  readonly source: 'todo' | 'reminder';
  readonly label: number;
  readonly title: string;
  readonly kind?: 'TEXT' | 'BRIEF';
  readonly eventLinked?: boolean;
  readonly origin?: 'conversation' | 'connector';
}

interface World {
  readonly service: NlSelectionService;
  readonly calls: AiRequest[];
  readonly logs: Array<{ event: string; fields?: LogFields }>;
  readonly executed: NlSelectedCommand[];
  session(): Session;
  setMetadata(key: string, value: unknown): void;
  items: Item[];
  memories: Map<string, { content: string; sessionId: string; role: string }>;
  decide(text: string, selector: string, opts?: { now?: IsoTimestamp; replyTo?: string; direct?: boolean; extra?: Record<string, unknown> }): Promise<NlSelectionDecision>;
  /** The owner's next turn; by default the turn before it (the preview, `turn-now`) is recorded first, as the runtime does. */
  answer(text: string, opts?: { now?: IsoTimestamp; replyTo?: string; turnId?: string; recordPreview?: boolean }): ReturnType<NlSelectionService['answerDeicticDraft']>;
  record(input: { text: string; replyKind: Parameters<NlSelectionService['recordLastTurn']>[0]['replyKind']; listingSource?: 'todo' | 'reminder'; now?: IsoTimestamp; id?: string; attachment?: boolean; quoted?: boolean; code?: boolean }): Promise<void>;
}

function world(options: { deictic?: 'off' | 'shadow' | 'on' | 'absent'; level?: 'local' | 'shadow' } = {}): World {
  const calls: AiRequest[] = [];
  const logs: World['logs'] = [];
  const executed: NlSelectedCommand[] = [];
  let selector = NONE;
  let session: Session = { id: SESSION, actorId: ACTOR, context: { platform: 'test', channelId: 'dm', userId: 'u', direct: true }, status: 'ACTIVE' as Session['status'], createdAt: T0, lastActivityAt: T0 };
  let actor: Actor = { id: ACTOR, displayName: 'Owner', identities: [], createdAt: T0 };
  const items: Item[] = [];
  const memories = new Map<string, { content: string; sessionId: string; role: string }>();
  const provider: AiProvider = {
    id: 'scripted',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    async isAvailable() {
      return true;
    },
    async execute(request) {
      calls.push(request);
      return { text: selector, artifacts: [] };
    },
  };
  const logger: Logger = {
    info: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    warn: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    error: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
  };
  const actors = {
    async get() {
      return actor;
    },
    async save(next: Actor) {
      actor = next;
      return next;
    },
  };
  const texts: NlDeicticTextReader = {
    async todo(actorId, itemId) {
      const item = items.find((candidate) => candidate.source === 'todo' && `todo-${candidate.label}` === itemId);
      return item === undefined || actorId !== ACTOR ? null : { title: item.title, origin: item.origin ?? 'conversation' };
    },
    async reminder(actorId, displayNo) {
      const item = items.find((candidate) => candidate.source === 'reminder' && candidate.label === displayNo);
      return item === undefined || actorId !== ACTOR ? null : { id: `reminder-${item.label}`, body: item.title, kind: item.kind ?? 'TEXT', eventLinked: item.eventLinked === true };
    },
    async ownerMessage(memoryId) {
      return memories.get(memoryId) ?? null;
    },
    async duplicateTodo(_actorId, title) {
      const todos = items.filter((item) => item.source === 'todo');
      const index = todos.findIndex((item) => item.title === title);
      const item = todos[index];
      return item === undefined ? undefined : { id: `todo-${item.label}`, no: index + 1 };
    },
  };
  const level = options.level ?? 'local';
  const service = new NlSelectionService({
    mode: 'active',
    router: { select: async () => provider },
    sessions: {
      async updateMetadataEntry(_ref, key, update, opts) {
        const metadata: Record<string, unknown> = { ...(session.metadata ?? {}) };
        const next = update(metadata[key]);
        if (next === undefined) delete metadata[key];
        else metadata[key] = next;
        session = { ...session, metadata };
        opts?.onCommitted?.(session);
        return session;
      },
    },
    actors,
    timeZone: 'Asia/Seoul',
    logger,
    actions: { level, killSwitch: new NlActionSwitch({ actors, logger }) },
    ...(options.deictic === 'absent' ? {} : { deictic: { mode: options.deictic ?? 'on', texts } }),
  });
  return {
    service,
    calls,
    logs,
    executed,
    items,
    memories,
    session: () => session,
    setMetadata(key, value) {
      session = { ...session, metadata: { ...(session.metadata ?? {}), [key]: value } };
    },
    async decide(text, chosen, opts = {}) {
      selector = chosen;
      return service.decide({
        text,
        attachmentCount: 0,
        session,
        actor,
        now: opts.now ?? T0,
        entries: ALL,
        route: 'chat',
        chatProviderId: 'scripted',
        turnId: 'turn-now',
        ...(opts.direct === false ? {} : { direct: true }),
        ...(opts.replyTo !== undefined ? { replyToMessageId: opts.replyTo } : {}),
        ...(opts.extra ?? {}),
      });
    },
    async answer(text, opts = {}) {
      if (opts.recordPreview !== false) await this.record({ text: 'preview turn', replyKind: 'preview', id: 'turn-now', now: T0 });
      return service.answerDeicticDraft(
        { text, session, actor, now: opts.now ?? at(1), turnId: opts.turnId ?? 'turn-answer', direct: true, ...(opts.replyTo !== undefined ? { replyToMessageId: opts.replyTo } : {}) },
        async (command) => {
          executed.push(command);
          return 'executed';
        },
      );
    },
    async record(input) {
      const memoryId = `mem-${input.id ?? PREV}`;
      memories.set(memoryId, { content: input.text, sessionId: SESSION, role: 'user' });
      await service.recordLastTurn({
        session: { id: SESSION },
        actorId: ACTOR,
        message: { id: input.id ?? PREV, text: input.text, attachmentCount: input.attachment === true ? 1 : 0, quoted: input.quoted === true, codeFormatted: input.code === true },
        memoryId,
        replyKind: input.replyKind,
        ...(input.listingSource !== undefined ? { listingSource: input.listingSource } : {}),
        now: input.now ?? at(-1),
        direct: true,
      });
    },
  };
}

const isPreview = (decision: NlSelectionDecision): boolean => decision.kind === 'ask' && decision.replyKind === 'preview';
const deicticLogs = (w: World) => w.logs.filter((log) => log.event === NL_ACTION_LOG_EVENT && String(log.fields?.refKind ?? '').startsWith('deictic:'));

// ── the narrow draft matcher (§3.2) ──────────────────────────────────────────────────────────────────────────────

describe('interpretDeicticDraftReply (owner decision 3)', () => {
  it.each(['응', '어', '네', '넵', '예', '그래', '좋아', '맞아', '추가해', '추가해줘', '만들어줘', 'yes', 'OK', 'okay', '응.', '네!', '좋아~', ' 응 '])('"%s" approves', (text) => {
    expect(interpretDeicticDraftReply(text)).toBe('approve');
  });
  it.each(['아니', '아니요', '아니야', '아뇨', '취소', '취소해', '취소해줘', '됐어', '그만', '되돌려줘', 'no', 'cancel', '아니.'])('"%s" denies', (text) => {
    expect(interpretDeicticDraftReply(text)).toBe('deny');
  });
  it.each(['응 근데 …', '응 아니', '응?', '응 👍', '👍', '응응', '그래 그거 말고', '네 맞아요', '승인', 'ㅇㅇ', '', '추가해줘 내일'])('"%s" is none', (text) => {
    expect(interpretDeicticDraftReply(text)).toBe('none');
  });
});

// ── eligibility at receipt (§1.2) and the origin words (§1.4 step 4) ─────────────────────────────────────────────────

describe('owner-message eligibility at receipt', () => {
  it.each([
    ['UAT 결과 정리', undefined],
    ['분기 보고서 금요일까지 마무리', undefined],
    ['UAT 결과\n정리', 'multiline'],
    ['> 회의록 정리', 'quoted'],
    ['```회의록```', 'fenced'],
    ['{"title":"x"}', 'fenced'],
    ['회의록​정리', 'invisible'],
    ['회의록 ‮정리', 'invisible'],
    ['할 일 추가: 회의록 정리', 'command'],
    ['비밀번호는 hunter2-Secret!9 이고 토큰 ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'credential'],
    ['그거 할 일로 추가해줘', 'deictic'],
    ['그 할 일 알림으로 걸어줘', 'deictic'],
    ['내가 말한 거', 'deictic'],
  ])('"%s" → %s', (text, reason) => {
    const result = nlOwnerMessageEligibility({ text, attachmentCount: 0, quoted: false, codeFormatted: false });
    if (reason === undefined) expect(result).toEqual({ eligible: true });
    else expect(result).toEqual({ eligible: false, reason });
  });

  it('attachments, platform quotes and code formatting are ineligible whatever the text', () => {
    expect(nlOwnerMessageEligibility({ text: '보고서', attachmentCount: 1, quoted: false, codeFormatted: false })).toEqual({ eligible: false, reason: 'attachment' });
    expect(nlOwnerMessageEligibility({ text: '보고서', attachmentCount: 0, quoted: true, codeFormatted: false })).toEqual({ eligible: false, reason: 'quoted' });
    expect(nlOwnerMessageEligibility({ text: '보고서', attachmentCount: 0, quoted: false, codeFormatted: true })).toEqual({ eligible: false, reason: 'fenced' });
  });

  it('origin words are a closed value class: owner speech vs a Quoky answer', () => {
    expect(nlDeicticOriginOf('내가 말한 거 할 일로 추가해줘')).toBe('owner');
    expect(nlDeicticOriginOf('제가 아까 적은 거 넣어줘')).toBe('owner');
    expect(nlDeicticOriginOf('what I said, add it')).toBe('owner');
    expect(nlDeicticOriginOf('네가 추천한 거 할 일로 추가해줘')).toBe('assistant');
    expect(nlDeicticOriginOf('그 답변 할 일로 넣어줘')).toBe('assistant');
    expect(nlDeicticOriginOf('your answer, add it')).toBe('assistant');
    expect(nlDeicticOriginOf('그거 할 일로 추가해줘')).toBeUndefined();
    expect(withoutNlOriginPhrases('내가 말한 거')).toBe('거');
  });
});

// ── the service: flag, preview, approval, integrity ─────────────────────────────────────────────────────────────

describe('QUOKY_NL_DEICTIC_WRITES at the service', () => {
  it('any mode but off requires QUOKY_NL_ACTIONS=local (owner decision 7)', () => {
    expect(() => world({ deictic: 'on', level: 'shadow' })).toThrow(NlActionsConfigError);
    expect(() => world({ deictic: 'shadow', level: 'shadow' })).toThrow(/NL_DEICTIC_WRITES_REQUIRES_LOCAL/);
    expect(() => world({ deictic: 'off', level: 'shadow' })).not.toThrow();
  });

  it('off: nothing is recorded and the deictic reply is today\'s, byte for byte, with the same selector calls', async () => {
    for (const mode of ['off', 'absent'] as const) {
      const w = world({ deictic: mode });
      await w.record({ text: 'UAT 결과 정리', replyKind: 'question' });
      expect(w.session().metadata?.[LAST_TURN_METADATA_KEY]).toBeUndefined();
      const decision = await w.decide('그걸로 할 일 만들어줘', out('todo.add', { title: '그걸로' }));
      expect(decision).toEqual({ kind: 'ask', text: renderDeicticPayload('ko'), entryId: 'todo.add' });
      expect(w.calls).toHaveLength(1);
      expect(await w.answer('응')).toBeUndefined();
    }
  });

  it('shadow: resolves and logs, replies as today, writes no draft', async () => {
    const w = world({ deictic: 'shadow' });
    await w.record({ text: 'UAT 결과 정리', replyKind: 'question' });
    expect(readLastTurn(w.session().metadata?.[LAST_TURN_METADATA_KEY], ACTOR, T0)?.owner.eligible).toBe(true);
    const decision = await w.decide('그걸로 할 일 만들어줘', out('todo.add', { title: '그걸로' }));
    expect(decision).toEqual({ kind: 'ask', text: renderDeicticPayload('ko'), entryId: 'todo.add' });
    expect(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY]).toBeUndefined();
    expect(deicticLogs(w).map((log) => log.fields?.result)).toEqual(['shadow']);
    expect(deicticLogs(w)[0]?.fields?.refKind).toBe('deictic:owner.message');
  });

  it('the duplicate note names the open to-do by the label the owner saw, never a live number a fresh listing disagrees with (Codex P1)', async () => {
    const preview = async (listing?: ReadonlyArray<{ label: number; id: string }>): Promise<string> => {
      const w = world();
      w.items.push({ source: 'todo', label: 1, title: '보고서 쓰기' }, { source: 'todo', label: 2, title: '은행 서류' }, { source: 'todo', label: 3, title: 'UAT 결과 정리' });
      if (listing !== undefined) w.setMetadata(LAST_LISTING_METADATA_KEY, withLabelledListing(undefined, ACTOR, 'todo', listing, at(-1), 'listing', 'older-turn'));
      await w.record({ text: 'UAT 결과 정리', replyKind: 'question' });
      const decision = await w.decide('그걸로 할 일 만들어줘', out('todo.add', { title: '그걸로' }));
      expect(isPreview(decision)).toBe(true);
      const text = decision.kind === 'ask' ? decision.text : '';
      expect(text).toContain('> UAT 결과 정리');
      return text;
    };
    // No listing: the live open-list number (3).
    expect(await preview()).toContain('같은 제목의 할 일이 이미 있어요 (3번)');
    // A fresh listing showed it as 4 (1 was completed since): the shown 4, never the live 3 (which the listing gives to another item).
    expect(await preview([{ label: 3, id: 'todo-9' }, { label: 4, id: 'todo-3' }])).toContain('같은 제목의 할 일이 이미 있어요 (4번)');
    // A fresh listing that never showed it: no number.
    const unshown = await preview([{ label: 1, id: 'todo-1' }]);
    expect(unshown).toContain('같은 제목의 할 일이 이미 있어요');
    expect(unshown).not.toMatch(/이미 있어요 \(/u);
  });

  it('on: preview → "응" executes once with the previewed payload; the audit carries kinds, labels and origins, never text', async () => {
    const w = world();
    await w.record({ text: 'UAT  결과 정리', replyKind: 'question' });
    const decision = await w.decide('그걸로 할 일 만들어줘', out('todo.add', { title: '그걸로' }));
    expect(isPreview(decision)).toBe(true);
    expect(decision.kind === 'ask' && decision.text).toContain('> UAT 결과 정리');
    expect(decision.kind === 'ask' && decision.history).toBe('[할 일 추가 미리보기]');
    const approved = await w.answer('응');
    expect(approved?.kind).toBe('executed');
    expect(w.executed).toEqual([{ entryId: 'todo.add', args: { title: 'UAT 결과 정리' }, language: 'ko', previewApproved: true }]);
    expect(await w.answer('응')).toBeUndefined();
    expect(w.executed).toHaveLength(1);
    const results = deicticLogs(w).map((log) => log.fields?.result);
    expect(results).toEqual(['previewed', 'confirmed']);
    for (const log of deicticLogs(w)) expect(JSON.stringify(log.fields)).not.toContain('UAT');
    expect(deicticLogs(w)[1]?.fields).toMatchObject({ payloadOrigin: 'owner-message', refKind: 'deictic:owner.message' });
  });

  it('the hash covers the normalised title: a changed referent writes nothing', async () => {
    const w = world();
    w.items.push({ source: 'todo', label: 3, title: '보고서 쓰기' });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, ACTOR, { entryId: 'todo.add', source: 'todo', itemId: 'todo-3', label: 3, at: at(-1), undoable: true, undone: false, requestId: PREV, echoReplyIds: [] }, at(-1)));
    await w.record({ text: '할 일 추가: 보고서 쓰기', replyKind: 'echo', listingSource: 'todo' });
    expect(isPreview(await w.decide('방금 거 알림으로 걸어줘 내일 9시', out('reminder.create', { body: '방금 거', when: '내일 9시' })))).toBe(true);
    w.items.splice(0, 1, { source: 'todo', label: 3, title: '보고서 다시 쓰기' });
    const changed = await w.answer('응');
    expect(changed).toMatchObject({ kind: 'reply', text: '내용이 바뀌어서 추가하지 않았어요.' });
    expect(w.executed).toEqual([]);
  });

  it('an approved reminder carries the instant its time words were read at, so it fires when the preview said', async () => {
    const w = world();
    w.items.push({ source: 'todo', label: 2, title: '은행 서류' });
    w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, ACTOR, { entryId: 'todo.add', source: 'todo', itemId: 'todo-2', label: 2, at: at(-1), undoable: true, undone: false, requestId: PREV, echoReplyIds: [] }, at(-1)));
    await w.record({ text: '할 일 추가: 은행 서류', replyKind: 'echo', listingSource: 'todo' });
    await w.decide('그거 30분 뒤에 알려줘', out('reminder.create', { body: '그거', when: '30분 뒤' }));
    await w.answer('네', { now: at(3) });
    expect(w.executed).toEqual([{ entryId: 'reminder.create', args: { body: '은행 서류', when: '30분 뒤', whenAt: T0 }, language: 'ko' }]);
  });

  it('a platform reply must name the current preview (bound at delivery)', async () => {
    const w = world();
    await w.record({ text: '자료 정리', replyKind: 'question' });
    await w.decide('그거 할 일로 추가해줘', out('todo.add', { title: '그거' }));
    await w.service.observeDelivery({ messageId: 'turn-now', context: { platform: 'test', channelId: 'dm', userId: 'u', direct: true }, sessionId: SESSION, status: 'RESPONDED', platformMessageIds: ['p-1'] });
    expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toMatchObject({ previewReplyIds: ['p-1'] });
    expect(await w.answer('응', { replyTo: 'p-0' })).toMatchObject({ kind: 'reply', text: '그 미리보기는 끝났어요. 아무것도 추가하지 않았어요.' });
  });

  it('the preview caps: at most 10 previews an hour per actor', async () => {
    const w = world();
    let previews = 0;
    for (let index = 0; index < 12; index += 1) {
      await w.record({ text: `캡 시험 ${index}`, replyKind: 'question', now: at(index * 2) });
      const decision = await w.decide('그거 할 일로 추가해줘', out('todo.add', { title: '그거' }), { now: at(index * 2 + 1) });
      if (isPreview(decision)) previews += 1;
      else expect(decision.kind === 'ask' && decision.text).toBe('미리보기를 너무 많이 만들었어요. 잠시 후 다시 말씀해 주세요.');
    }
    expect(previews).toBe(10);
  });

  it('a draft written by an older turn is not answerable (next turn only)', async () => {
    const w = world();
    await w.record({ text: '다음 턴 시험', replyKind: 'question' });
    await w.decide('그거 할 일로 추가해줘', out('todo.add', { title: '그거' }));
    await w.record({ text: '도움말', replyKind: 'chat', id: 'turn-other', now: T0 });
    expect(await w.answer('응', { recordPreview: false })).toMatchObject({ kind: 'reply', text: '미리보기가 만료됐어요. 아무것도 추가하지 않았어요.' });
    expect(w.executed).toEqual([]);
    const stale = withDeicticDraft(undefined, ACTOR, undefined, T0);
    expect(stale).toBeUndefined();
  });
});

// ── A6 R5a review fixes ──────────────────────────────────────────────────────────────────────────────────────────

/** A recency conflict that offers to-do 1 (just added) and reminder #1 (the last listing): both carry the label 1. */
async function conflictWorld(reminderLabel = 1): Promise<World> {
  const w = world();
  w.items.push({ source: 'todo', label: 1, title: '전화하기' }, { source: 'reminder', label: reminderLabel, title: '약 먹기' });
  w.setMetadata(LAST_LISTING_METADATA_KEY, withLabelledListing(undefined, ACTOR, 'reminder', [{ label: reminderLabel, id: `reminder-${reminderLabel}` }], at(-1), 'listing', PREV));
  w.setMetadata(LAST_ACTION_METADATA_KEY, withLastAction(undefined, ACTOR, { entryId: 'todo.add', source: 'todo', itemId: 'todo-1', label: 1, at: at(-2), undoable: true, undone: false, requestId: 'older-turn', echoReplyIds: [] }, at(-2)));
  await w.record({ text: '내 알림 보여줘', replyKind: 'listing', listingSource: 'reminder' });
  const asked = await w.decide('방금 거 할 일로 추가해줘', out('todo.add', { title: '방금 거' }));
  expect(asked.kind === 'ask' && asked.text).toContain('어느 걸 할 일로 추가할까요?');
  return w;
}

describe('A6 R5a review: grounding, shared labels, preview caps and undelivered previews', () => {
  it('a deictic span the owner did not say, or a message with its own content, never previews an earlier message', async () => {
    for (const [text, args] of [
      ['할 일로 추가해줘', { title: '그거' }],
      ['그거 보고서 정리 할 일로 추가해줘', { title: '그거' }],
    ] as const) {
      const w = world();
      await w.record({ text: '견적서 다시 보내기', replyKind: 'question' });
      const decision = await w.decide(text, out('todo.add', args));
      expect(isPreview(decision), text).toBe(false);
      expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeUndefined();
    }
  });

  it('a to-do 1 and a reminder #1 in one question: a bare "1" asks again, a source-qualified answer picks that source', async () => {
    const bare = await conflictWorld();
    const again = await bare.answer('1', { now: at(1) });
    expect(again).toMatchObject({ kind: 'reply', replyKind: 'question' });
    expect(readDeicticDraft(bare.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)?.stage).toBe('choose');
    const todo = await conflictWorld();
    expect(await todo.answer('할 일 1', { now: at(1) })).toMatchObject({ kind: 'reply', replyKind: 'preview', text: expect.stringContaining('> 전화하기') });
    const reminder = await conflictWorld();
    expect(await reminder.answer('알림 1', { now: at(1) })).toMatchObject({ kind: 'reply', replyKind: 'preview', text: expect.stringContaining('> 약 먹기') });
  });

  it('Codex P2: whenever the answer names a source, the pick must be of that source as well as the label, else it asks again', async () => {
    // to-do 1 and reminder #2: the labels are unique.
    for (const [answer, preview] of [['할 일 1', '> 전화하기'], ['알림 2', '> 약 먹기'], ['1', '> 전화하기'], ['2', '> 약 먹기']] as const) {
      const w = await conflictWorld(2);
      expect(await w.answer(answer, { now: at(1) }), answer).toMatchObject({ kind: 'reply', replyKind: 'preview', text: expect.stringContaining(preview) });
    }
    for (const answer of ['알림 1', '할 일 2', 'reminder 1', '할 일 알림 1']) {
      const w = await conflictWorld(2);
      expect(await w.answer(answer, { now: at(1) }), answer).toMatchObject({ kind: 'reply', replyKind: 'question' });
      expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)?.stage, answer).toBe('choose');
      expect(w.executed, answer).toEqual([]);
    }
  });

  it('the preview budget is rechecked when an answer resumes into a preview', async () => {
    const w = await conflictWorld();
    const caps = (w.service as unknown as { deictic: { previewCaps: NlActionCaps } }).deictic.previewCaps;
    for (let index = 0; index < 10; index += 1) caps.note(ACTOR, 'LOCAL_WRITE', Date.parse(at(-30 + index)));
    const answered = await w.answer('할 일 1', { now: at(1) });
    expect(answered).toMatchObject({ kind: 'reply', text: '미리보기를 너무 많이 만들었어요. 잠시 후 다시 말씀해 주세요.' });
    expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeUndefined();
  });

  it('an undelivered preview is cleared and cannot be approved by a plain "응"', async () => {
    for (const delivery of [{ status: 'FAILED', platformMessageIds: ['p-1'] }, { status: 'RESPONDED', platformMessageIds: [] }]) {
      const w = world();
      await w.record({ text: '자료 정리', replyKind: 'question' });
      expect(isPreview(await w.decide('그거 할 일로 추가해줘', out('todo.add', { title: '그거' })))).toBe(true);
      await w.service.observeDelivery({ messageId: 'turn-now', context: { platform: 'test', channelId: 'dm', userId: 'u', direct: true }, sessionId: SESSION, ...delivery });
      expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeUndefined();
      expect(await w.answer('응')).toBeUndefined();
      expect(w.executed).toEqual([]);
    }
  });
});

// ── A6-D3a amendment 1 integration (rebase onto #244; Chief Architect review items (b), (c) and the pending rule) ──

describe('R5a on top of A6-D3a amendment 1 (act-then-undo)', () => {
  const lastTodoAdd = (label: number) =>
    withLastAction(undefined, ACTOR, { entryId: 'todo.add', source: 'todo', itemId: `todo-${label}`, label, at: at(-2), undoable: true, undone: false, requestId: 'older-turn', echoReplyIds: [] }, at(-2));

  it('(b) not-request blocks the deictic path: a vetoed deictic sentence is chat, never a preview or the deictic reply', async () => {
    expect(DEICTIC_BLOCKING_FAILURES.has('not-request')).toBe(true);
    const vetoed: ReadonlyArray<readonly [string, string]> = [
      ['그거 할 일로 추가할게', 'volition'],
      ['그거 할 일로 추가했어', 'statement'],
      ['그거 할 일로 추가하지 마', 'negation'],
      ['그거 할 일로 추가할까?', 'question'],
      ['민수가 그거 할 일로 추가하래', 'reported'],
      ['예를 들어 그거 할 일로 추가해줘', 'example'],
      ['내가 말한 거 할 일로 추가할게', 'volition'],
    ];
    // Both gates hold on their own: `isDeicticRequest` (nlActionWordGrounded) and, forced past it, DEICTIC_BLOCKING_FAILURES.
    for (const [text, veto] of [...vetoed, ...vetoed.map(([t, v]) => [`force:${t}`, v] as const)]) {
      const w = world();
      await w.record({ text: '자료 정리', replyKind: 'question' });
      if (text.startsWith('force:')) (w.service as unknown as { deictic: { isDeicticRequest(): boolean } }).deictic.isDeicticRequest = () => true;
      const said = text.replace(/^force:/u, '');
      const decision = await w.decide(said, out('todo.add', { title: said.startsWith('내가') ? '내가 말한 거' : '그거' }));
      expect(decision, text).toEqual({ kind: 'none' });
      expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR), text).toBeUndefined();
      expect(deicticLogs(w), text).toEqual([]);
      const logged = w.logs.filter((log) => log.event === NL_ACTION_LOG_EVENT).at(-1);
      expect(logged?.fields?.reason, text).toBe(`not-request:${veto}`);
    }
  });

  it('garbled-action blocks the deictic path: a garbled action word asks its own question, never a preview', async () => {
    expect(DEICTIC_BLOCKING_FAILURES.has('garbled-action')).toBe(true);
    const w = world();
    await w.record({ text: '자료 정리', replyKind: 'question' });
    (w.service as unknown as { deictic: { isDeicticRequest(): boolean } }).deictic.isDeicticRequest = () => true;
    const decision = await w.decide('그거 할 일로 츄가해줘', out('todo.add', { title: '그거' }));
    expect(decision).toEqual({ kind: 'ask', text: renderGarbledAction('추가', 'ko'), entryId: 'todo.add' });
    expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeUndefined();
    expect(deicticLogs(w)).toEqual([]);
    expect(w.logs.filter((log) => log.event === NL_ACTION_LOG_EVENT).at(-1)?.fields?.reason).toBe('garbled-action');
  });

  it('(c) origin phrases are stripped (requestFrame) before the vetoes, for the deictic path only', async () => {
    const text = '아까 내가 썼던 거 할 일에 추가';
    // Without the hook the first-person subject is volition.
    for (const mode of ['off', 'shadow'] as const) {
      const w = world({ deictic: mode });
      await w.record({ text: '분기 보고 초안 쓰기', replyKind: 'chat' });
      expect(await w.decide(text, out('todo.add', { title: '아까 내가 썼던 거' })), mode).toEqual({ kind: 'none' });
      expect(w.executed).toEqual([]);
    }
    const w = world();
    await w.record({ text: '분기 보고 초안 쓰기', replyKind: 'chat' });
    const decision = await w.decide(text, out('todo.add', { title: '아까 내가 썼던 거' }));
    expect(isPreview(decision), decision.kind === 'ask' ? decision.text : decision.kind).toBe(true);
    expect(decision.kind === 'ask' && decision.text).toContain('> 분기 보고 초안 쓰기');
    // A message with its own content is no deictic write: the stripped frame never lets it act (still volition, chat).
    const own = world();
    await own.record({ text: '분기 보고 초안 쓰기', replyKind: 'chat' });
    expect(await own.decide('아까 내가 썼던 보고서 할 일에 추가', out('todo.add', { title: '보고서' }))).toEqual({ kind: 'none' });
    expect(readDeicticDraft(own.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeUndefined();
  });

  it('a reminder time after the request ("… 30분 뒤") is the time, not a deferral', async () => {
    const w = world();
    await w.record({ text: '세미나 발표 연습', replyKind: 'question' });
    const decision = await w.decide('그거 알림으로 걸어줘 30분 뒤', out('reminder.create', { body: '그거', when: '30분 뒤' }));
    expect(isPreview(decision), decision.kind === 'ask' ? decision.text : decision.kind).toBe(true);
  });

  it('one next-turn question per session: an open undo confirmation refuses a new deictic draft', async () => {
    const w = world();
    await w.record({ text: '자료 정리', replyKind: 'question' });
    w.setMetadata(LAST_ACTION_METADATA_KEY, lastTodoAdd(3));
    w.setMetadata(NL_PENDING_METADATA_KEY, pendingQuestionRecord(ACTOR, { kind: 'action-undo-confirm', at: at(-1), language: 'ko', target: { source: 'todo', id: 'todo-3', label: 3 }, undoEntryId: 'todo.add', actionAt: at(-2) }));
    const decision = await w.decide('그거 할 일로 추가해줘', out('todo.add', { title: '그거' }));
    expect(isPreview(decision)).toBe(false);
    expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeUndefined();
    expect(deicticLogs(w).at(-1)?.fields).toMatchObject({ result: 'refused', reason: 'pending-question' });
  });

  it('one next-turn question per session: asking the undo confirmation drops a pending draft', async () => {
    const w = world();
    await w.record({ text: '자료 정리', replyKind: 'question' });
    expect(isPreview(await w.decide('그거 할 일로 추가해줘', out('todo.add', { title: '그거' })))).toBe(true);
    expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeDefined();
    w.setMetadata(LAST_ACTION_METADATA_KEY, lastTodoAdd(3));
    const asked = await w.decide('되돌려 주신 기능 설명해줘', out('action.undo'), { now: at(1) });
    expect(asked).toMatchObject({ kind: 'ask', text: "방금 한 '할 일 3번 추가'를 되돌릴까요? (응 / 아니)" });
    expect(readPendingQuestion(w.session(), ACTOR, at(2))).toMatchObject({ kind: 'action-undo-confirm', target: { id: 'todo-3' } });
    expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeUndefined();
    expect(w.logs.some((log) => log.event === 'nl_deictic.draft_superseded' && log.fields?.why === 'undo-confirm-asked')).toBe(true);
    // "응" now has one meaning: the draft cannot answer it.
    expect(await w.answer('응', { recordPreview: false })).toBeUndefined();
    expect(w.executed).toEqual([]);
  });

  it('one next-turn question per session: with both found at the start of a turn, the undo confirmation answers and the draft is dropped', async () => {
    const w = world();
    await w.record({ text: '자료 정리', replyKind: 'question' });
    expect(isPreview(await w.decide('그거 할 일로 추가해줘', out('todo.add', { title: '그거' })))).toBe(true);
    await w.record({ text: 'preview turn', replyKind: 'preview', id: 'turn-now', now: T0 });
    const answered = await w.service.answerDeicticDraft(
      { text: '응', session: w.session(), actor: { id: ACTOR, displayName: 'Owner', identities: [], createdAt: T0 }, now: at(1), turnId: 'turn-answer', direct: true },
      async (command) => {
        w.executed.push(command);
        return 'executed';
      },
      { actionQuestionOpen: true },
    );
    expect(answered).toBeUndefined();
    expect(w.executed).toEqual([]);
    expect(readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR)).toBeUndefined();
    expect(w.logs.some((log) => log.event === 'nl_deictic.draft_superseded' && log.fields?.why === 'undo-confirm-open')).toBe(true);
  });
});

// ── the offline run of the deictic corpus (§6.1) ────────────────────────────────────────────────────────────────

interface CorpusCase {
  readonly id: string;
  readonly family: 'positive' | 'ask' | 'must-not';
  readonly path?: string;
  readonly text: string;
  readonly selector: { readonly entryId: string; readonly args: Record<string, unknown> } | 'none';
  readonly fixture?: {
    readonly turn?: { readonly owner: { readonly text: string; readonly eligible: boolean; readonly attachment?: boolean; readonly quoted?: boolean; readonly code?: boolean }; readonly reply: { readonly kind: 'chat' | 'listing' | 'echo' | 'note' | 'question' | 'refusal' | 'preview'; readonly listingSource?: 'todo' | 'reminder' }; readonly ageMinutes?: number; readonly recorded?: boolean; readonly changed?: boolean };
    readonly items?: readonly Item[];
    readonly lastAction?: { readonly source: 'todo' | 'reminder'; readonly label: number; readonly own?: boolean; readonly ageMinutes?: number };
    readonly listing?: { readonly source: 'todo' | 'reminder' | 'mail' | 'drive'; readonly labels: readonly number[]; readonly own?: boolean };
    readonly replyTo?: 'echo' | 'listing' | 'chat' | 'note' | 'other';
    readonly direct?: boolean;
    readonly switch?: 'stopped';
    readonly questionOpen?: boolean;
    readonly capped?: boolean;
  };
  readonly expect: { readonly outcome: 'preview' | 'ask' | 'refuse' | 'chat'; readonly payload?: string; readonly referent?: 'item.local' | 'owner.message'; readonly text?: string };
}

const CORPUS = JSON.parse(readFileSync(new URL('../golden/nl-action.deictic.v1.json', import.meta.url), 'utf8')) as { version: string; cases: CorpusCase[] };

async function runCorpusCase(golden: CorpusCase): Promise<{ decision: NlSelectionDecision; w: World; eligible?: boolean }> {
  const w = world();
  const fixture = golden.fixture ?? {};
  for (const item of fixture.items ?? []) w.items.push(item);
  const itemId = (source: string, label: number) => `${source}-${label}`;
  let eligible: boolean | undefined;
  if (fixture.turn !== undefined && fixture.turn.recorded !== false) {
    const turnAt = at(-(fixture.turn.ageMinutes ?? 1));
    await w.record({
      text: fixture.turn.owner.text,
      replyKind: fixture.turn.reply.kind,
      ...(fixture.turn.reply.listingSource !== undefined ? { listingSource: fixture.turn.reply.listingSource } : {}),
      now: turnAt,
      ...(fixture.turn.owner.attachment === true ? { attachment: true } : {}),
      ...(fixture.turn.owner.quoted === true ? { quoted: true } : {}),
      ...(fixture.turn.owner.code === true ? { code: true } : {}),
    });
    eligible = readLastTurn(w.session().metadata?.[LAST_TURN_METADATA_KEY], ACTOR, at(-(fixture.turn.ageMinutes ?? 1)))?.owner.eligible;
    if (fixture.turn.changed === true) w.memories.set(`mem-${PREV}`, { content: `${fixture.turn.owner.text} (수정됨)`, sessionId: SESSION, role: 'user' });
  }
  if (fixture.listing !== undefined) {
    const listing = fixture.listing;
    w.setMetadata(
      LAST_LISTING_METADATA_KEY,
      withLabelledListing(w.session().metadata?.[LAST_LISTING_METADATA_KEY], ACTOR, listing.source, listing.labels.map((label) => ({ label, id: itemId(listing.source, label) })), at(-1), 'listing', listing.own === false ? 'older-turn' : PREV),
    );
  }
  if (fixture.lastAction !== undefined) {
    const action = fixture.lastAction;
    w.setMetadata(
      LAST_ACTION_METADATA_KEY,
      withLastAction(undefined, ACTOR, { entryId: action.source === 'todo' ? 'todo.add' : 'reminder.create', source: action.source, itemId: itemId(action.source, action.label), label: action.label, at: at(-(action.ageMinutes ?? 1)), undoable: true, undone: false, requestId: action.own === false ? 'older-turn' : PREV, echoReplyIds: fixture.replyTo === 'echo' ? ['reply-echo'] : [] }, at(-(action.ageMinutes ?? 1))),
    );
  }
  let replyTo: string | undefined;
  if (fixture.replyTo !== undefined) {
    replyTo = `reply-${fixture.replyTo}`;
    if (fixture.replyTo === 'listing' && fixture.listing !== undefined) {
      w.setMetadata(LAST_LISTING_METADATA_KEY, withListingReplies(w.session().metadata?.[LAST_LISTING_METADATA_KEY], ACTOR, fixture.listing.source, fixture.listing.own === false ? 'older-turn' : PREV, [replyTo], at(-1)).next);
    }
    if (fixture.replyTo === 'chat' || fixture.replyTo === 'note') w.setMetadata(LAST_TURN_METADATA_KEY, withLastTurnReplies(w.session().metadata?.[LAST_TURN_METADATA_KEY], ACTOR, PREV, [replyTo], at(-1)));
  }
  if (fixture.switch === 'stopped') await w.service.handleSwitchPhrase((await (w.service as unknown as { deps: { actors: { get(id: string): Promise<Actor> } } }).deps.actors.get(ACTOR)), '에이전트 중지', at(-1));
  if (fixture.questionOpen === true) {
    w.setMetadata(NL_PENDING_METADATA_KEY, pendingQuestionRecord(ACTOR, { kind: 'action-target', at: at(-1), language: 'ko', entryId: 'todo.complete', source: 'todo', candidates: [{ label: 1, id: 'todo-1' }, { label: 2, id: 'todo-2' }], args: {} }));
  }
  if (fixture.capped === true) {
    const caps = (w.service as unknown as { deictic: { previewCaps: NlActionCaps } }).deictic.previewCaps;
    for (let index = 0; index < 10; index += 1) caps.note(ACTOR, 'LOCAL_WRITE', Date.parse(at(-30 + index)));
  }
  const selector = golden.selector === 'none' ? NONE : out(golden.selector.entryId, golden.selector.args);
  const decision = await w.decide(golden.text, selector, { ...(replyTo !== undefined ? { replyTo } : {}), ...(fixture.direct === false ? { direct: false } : {}) });
  return { decision, w, ...(eligible !== undefined ? { eligible } : {}) };
}

describe(`the deictic corpus offline (${CORPUS.cases.length} cases, §6.1)`, () => {
  it('has the families and minimums of §6.1, unique ids and texts disjoint from nl-action.v1', () => {
    const count = (family: string) => CORPUS.cases.filter((golden) => golden.family === family).length;
    expect(CORPUS.version).toBe('nl-action.deictic.v1');
    expect(count('positive')).toBeGreaterThanOrEqual(50);
    expect(count('ask')).toBeGreaterThanOrEqual(40);
    expect(count('must-not')).toBeGreaterThanOrEqual(70);
    for (const path of ['echo', 'listing', 'owner-message', 'reply-to', 'determiner']) {
      expect(CORPUS.cases.filter((golden) => golden.family === 'positive' && golden.path === path).length, path).toBeGreaterThanOrEqual(10);
    }
    expect(new Set(CORPUS.cases.map((golden) => golden.id)).size).toBe(CORPUS.cases.length);
    const v1 = new Set((JSON.parse(readFileSync(new URL('../golden/nl-action.v1.json', import.meta.url), 'utf8')) as { cases: Array<{ text: string }> }).cases.map((golden) => golden.text));
    expect(CORPUS.cases.filter((golden) => v1.has(golden.text)).map((golden) => golden.id)).toEqual([]);
    for (const text of ['할 일 만들기 어떻게 해?', '알림으로 걸려면 어떻게 해?', '알림으로 설정돼 있어?', '그 할 일 만들어진 거 맞지?']) {
      expect(CORPUS.cases.some((golden) => golden.family === 'must-not' && golden.text === text), text).toBe(true);
    }
  });

  it.each(CORPUS.cases.map((golden) => [golden.id, golden] as const))('%s', async (_id, golden) => {
    const { decision, w, eligible } = await runCorpusCase(golden);
    if (golden.fixture?.turn !== undefined && golden.fixture.turn.recorded !== false) expect(eligible, 'eligibility at receipt').toBe(golden.fixture.turn.owner.eligible);
    const draft = readDeicticDraft(w.session().metadata?.[DEICTIC_DRAFT_METADATA_KEY], ACTOR);
    expect(decision.kind).not.toBe('execute');
    switch (golden.expect.outcome) {
      case 'preview': {
        expect(isPreview(decision), decision.kind === 'ask' ? decision.text : decision.kind).toBe(true);
        expect(decision.kind === 'ask' && decision.text).toContain(`> ${golden.expect.payload}`);
        expect(draft?.stage === 'preview' && draft.referent.kind).toBe(golden.expect.referent);
        // The approving owner turn executes exactly the previewed payload.
        const approved = await w.answer('응', { now: at(1) });
        expect(approved?.kind).toBe('executed');
        const command = w.executed[0];
        expect(command?.args[command.entryId === 'todo.add' ? 'title' : 'body']).toBe(golden.expect.payload);
        break;
      }
      case 'ask':
        expect(decision.kind).toBe('ask');
        expect(isPreview(decision)).toBe(false);
        expect(draft === undefined || draft.stage !== 'preview').toBe(true);
        if (golden.expect.text !== undefined) expect(decision.kind === 'ask' && decision.text.startsWith(golden.expect.text), decision.kind === 'ask' ? decision.text : '').toBe(true);
        break;
      case 'refuse':
        expect(isPreview(decision)).toBe(false);
        expect(draft).toBeUndefined();
        if (golden.expect.text !== undefined) expect(decision.kind === 'ask' && decision.text.startsWith(golden.expect.text), decision.kind === 'ask' ? decision.text : decision.kind).toBe(true);
        break;
      case 'chat':
        expect(['none', 'skip']).toContain(decision.kind);
        expect(draft).toBeUndefined();
        break;
    }
    // Never content in a selector prompt: the referenced text is not selector input.
    for (const item of golden.fixture?.items ?? []) for (const call of w.calls) expect(call.prompt.includes(item.title)).toBe(false);
  });
});

// ── the vocabulary no-regression gate with R5 OFF (D5) ──────────────────────────────────────────────────────────

describe('the D5 vocabulary additions, with R5 off, over every nl-action gold', () => {
  const golds = ['nl-action.v1.json', 'nl-action.seed.v1.json', 'nl-action.exec-time.v1.json'].flatMap((file) =>
    (JSON.parse(readFileSync(new URL(`../golden/${file}`, import.meta.url), 'utf8')) as { cases: Array<{ id: string; text: string; expect: unknown }> }).cases.map((golden) => ({ ...golden, id: `${file}:${golden.id}` })),
  );
  const added = Object.values(NL_R5A_VOCABULARY_ADDITIONS).flat();

  it('the glued-noun rule names the same item sources for every gold with and without the additions', () => {
    expect(golds.length).toBeGreaterThanOrEqual(500);
    const changed = golds.filter((golden) => [...nlNamedItemSources(golden.text)].sort().join() !== [...nlNamedItemSources(golden.text, { withoutVocabulary: added })].sort().join());
    expect(changed.map((golden) => golden.id)).toEqual([]);
  });

  it('every write entry grounds exactly as before for every gold (none contains an added phrase)', () => {
    const changed: string[] = [];
    for (const entry of ACTIONS) {
      const words = entry.actionGrounding;
      if (words === undefined) continue;
      const before = words.filter((word) => !added.includes(word));
      for (const golden of golds) {
        const prose = withoutStructures(golden.text);
        if (nlActionWordGrounded(prose, words) !== nlActionWordGrounded(prose, before)) changed.push(`${entry.id} ${golden.id}`);
      }
    }
    expect(changed).toEqual([]);
  });

  it('the seven deictic-payload golds keep their reason with R5 off, and with R5 on when nothing is referable', async () => {
    const deictic = golds.filter((golden) => (golden.expect as { reason?: string }).reason === 'deictic-payload');
    expect(deictic).toHaveLength(7);
    for (const mode of ['off', 'on'] as const) {
      for (const golden of deictic) {
        const entryId = (golden.expect as { entryId: string }).entryId;
        const w = world({ deictic: mode });
        const span = golden.text.split(' ')[0] === '방금' ? '방금 거' : golden.text.split(' ')[0] === '할' ? '할 일' : (golden.text.split(' ')[0] as string);
        const when = /내일 9시/u.test(golden.text) ? { when: '내일 9시' } : {};
        const decision = await w.decide(golden.text, out(entryId, entryId === 'todo.add' ? { title: span } : { body: span, ...when }));
        expect(decision, `${mode} ${golden.id}`).toEqual({ kind: 'ask', text: renderDeicticPayload('ko'), entryId });
      }
    }
  });

  it('A6-D3a amendment 1: every write entry gets the same request-shape veto for every gold with and without the additions', () => {
    const actionWithout = NL_ACTION_WORDS.filter((word) => !added.includes(word));
    const changed: string[] = [];
    for (const entry of ACTIONS) {
      const words = entry.actionGrounding;
      if (words === undefined || entry.risk !== 'LOCAL_WRITE') continue;
      const before = words.filter((word) => !added.includes(word));
      for (const golden of golds) {
        const prose = withoutStructures(golden.text);
        if (nlRequestVeto(prose, words, NL_ACTION_WORDS) !== nlRequestVeto(prose, before, actionWithout)) changed.push(`${entry.id} ${golden.id}`);
      }
    }
    expect(changed).toEqual([]);
  });

  it('the additions ground requests, and never questions or statements', () => {
    const todo = ACTIONS.find((entry) => entry.id === 'todo.add')?.actionGrounding ?? [];
    const reminder = ACTIONS.find((entry) => entry.id === 'reminder.create')?.actionGrounding ?? [];
    for (const text of ['그걸로 할 일 만들어줘', '보고서 검토 할일 만들어줘', '할 일 만들어 주세요']) expect(nlActionWordGrounded(text, todo), text).toBe(true);
    for (const text of ['방금 거 알림으로 걸어줘 내일 9시', '그 할 일 알림으로 걸어 줘']) expect(nlActionWordGrounded(text, reminder), text).toBe(true);
    for (const text of ['할 일 만들기 어떻게 해?', '그 할 일 만들어진 거 맞지?', '할 일 만들었어', '할일 만들지 마']) expect(nlActionWordGrounded(text, todo), text).toBe(false);
    for (const text of ['알림으로 걸려면 어떻게 해?', '알림으로 설정돼 있어?', '알림으로 걸었어', '알림으로 걸지 마']) expect(nlActionWordGrounded(text, reminder), text).toBe(false);
  });
});

void ACTION_SWITCH_METADATA_KEY;

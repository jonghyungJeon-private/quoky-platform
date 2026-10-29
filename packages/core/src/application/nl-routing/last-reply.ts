import type { Id, InboundQuotedRange, IsoTimestamp } from '../../domain';
import { prepareSelectionInput } from './selection-input';
import { interpretContinuationConfirmReply, type NlUndoConfirmReply } from './undo-confirm';

/**
 * Owner decision of 2026-10-29 ("끊긴 확인 고치고 재측정", context eval `cy-question-then-other`): a bare yes or no that no
 * question is waiting for gets Core's fixed notice, never a chat call, unless Quoky's previous reply was chat (the chat may
 * have asked something itself). `Session.metadata['quoky.lastReply']` is the content-free record that tells the two apart:
 *
 *   metadata['quoky.lastReply'] = { byActor: { [actorId]: { chat, at } } }
 *
 * - Written after each turn while selection is `active` (the D7 question exists only then), through the field-scoped
 *   `SessionManager.updateMetadataEntry` (under `SESSION_WRITE_LOCK`, ADR-0113 D7).
 * - `chat`: the turn was answered by GENERAL_CHAT / POLICY_SENSITIVE_CHAT. No text, no entry, no args.
 * - Kept {@link LAST_REPLY_TTL_MS} (30 minutes, as `quoky.lastTurn`); anything expired, malformed or another actor's counts
 *   as absent, and an absent record never triggers the notice (the turn goes to chat as before).
 *
 * Owner decision of 2026-10-29 ("1번 진행", context eval `sc-confirm-chat-yes`): the same record carries `questionClosedAt`,
 * the time a turn of this actor ended an open D7 question (ADR-0120 D7: any reply ends it) and was answered by chat, so
 * the question was closed without an answer. A time only: no entry, no option, no item, no text.
 * - Set on a chat reply to the turn whose start took this actor's open question (`takePending` returned it).
 * - Carried over by each later chat reply while it is within {@link LAST_REPLY_TTL_MS} of the close.
 * - Dropped by any reply that is not chat: a new D7 question (Core's ask), an answer to a question (its read, write or
 *   ack), a served command, a fixed notice or an error. Core's own reply is then the latest exchange, and a bare yes after
 *   it gets Core's notice without a chat call (above).
 * While it is fresh, the chat turns of this actor carry {@link CLOSED_QUESTION_FACT} (`honest-chat.ts`).
 */

export const LAST_REPLY_METADATA_KEY = 'quoky.lastReply';
export const LAST_REPLY_TTL_MS = 30 * 60_000;
const MAX_ACTORS = 64;

export interface LastReplyRecord {
  /** The reply came from chat (GENERAL_CHAT / POLICY_SENSITIVE_CHAT). */
  readonly chat: boolean;
  readonly at: IsoTimestamp;
  /** When this actor's open D7 question was closed without an answer (see above); absent when none is held. */
  readonly questionClosedAt?: IsoTimestamp;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One stored record, or `undefined` when malformed. */
export function lastReplyOf(raw: unknown): LastReplyRecord | undefined {
  const record = recordOf(raw);
  if (typeof record.chat !== 'boolean') return undefined;
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return undefined;
  const closed = typeof record.questionClosedAt === 'string' && Number.isFinite(Date.parse(record.questionClosedAt)) ? (record.questionClosedAt as IsoTimestamp) : undefined;
  return { chat: record.chat, at: record.at as IsoTimestamp, ...(closed !== undefined ? { questionClosedAt: closed } : {}) };
}

/** This actor's fresh record (within {@link LAST_REPLY_TTL_MS}), else `undefined`. Pure. */
export function readLastReply(value: unknown, actorId: Id, now: IsoTimestamp): LastReplyRecord | undefined {
  const record = lastReplyOf(recordOf(recordOf(value).byActor)[actorId]);
  if (record === undefined) return undefined;
  return fresh(record.at, now) ? record : undefined;
}

/** True when `iso` lies within {@link LAST_REPLY_TTL_MS} before `now`. */
function fresh(iso: IsoTimestamp, now: IsoTimestamp): boolean {
  const age = Date.parse(now) - Date.parse(iso);
  return Number.isFinite(age) && age >= 0 && age < LAST_REPLY_TTL_MS;
}

/**
 * Owner decision of 2026-10-29: this actor's open D7 question was closed without an answer within the TTL, and every
 * reply since was chat (the record is dropped otherwise). Content-free; pure.
 */
export function readClosedQuestion(value: unknown, actorId: Id, now: IsoTimestamp): boolean {
  const closed = readLastReply(value, actorId, now)?.questionClosedAt;
  return closed !== undefined && fresh(closed, now);
}

/**
 * Pure: the record for this actor's reply. `closedQuestion`: this turn took this actor's open D7 question at its start.
 * A chat reply sets `questionClosedAt` (now when this turn closed it, else the fresh earlier one); any other reply drops it.
 */
export function nextLastReply(current: unknown, actorId: Id, chat: boolean, closedQuestion: boolean, now: IsoTimestamp): LastReplyRecord {
  if (!chat) return { chat, at: now };
  const earlier = readClosedQuestion(current, actorId, now) ? readLastReply(current, actorId, now)?.questionClosedAt : undefined;
  const closedAt = closedQuestion ? now : earlier;
  return { chat, at: now, ...(closedAt !== undefined ? { questionClosedAt: closedAt } : {}) };
}

/** Pure: the next metadata value after `actorId`'s reply (other actors kept when fresh, at most 64). */
export function withLastReply(current: unknown, actorId: Id, record: LastReplyRecord, now: IsoTimestamp): unknown {
  const byActor: Record<string, unknown> = {};
  for (const [other, raw] of Object.entries(recordOf(recordOf(current).byActor))) {
    if (other === actorId) continue;
    if (readLastReply({ byActor: { [other]: raw } }, other, now) !== undefined) byActor[other] = raw;
  }
  const keys = Object.keys(byActor);
  while (keys.length >= MAX_ACTORS) {
    const victim = keys.shift();
    if (victim !== undefined) delete byActor[victim];
  }
  byActor[actorId] = { chat: record.chat, at: record.at, ...(record.questionClosedAt !== undefined ? { questionClosedAt: record.questionClosedAt } : {}) };
  return { byActor };
}

/**
 * The owner's whole turn, after the usual input preparation (quoted text and code removed), is a bare yes or no in the
 * closed continuation reply set ({@link interpretContinuationConfirmReply}); `none` for anything else, an attachment
 * included. No phrase of its own. Pure.
 */
export function nlBareYesNo(text: string, attachmentCount = 0, quotedRanges: readonly InboundQuotedRange[] = []): NlUndoConfirmReply {
  if (attachmentCount > 0) return 'none';
  const prepared = prepareSelectionInput(text, 0, quotedRanges);
  return 'skip' in prepared ? 'none' : interpretContinuationConfirmReply(prepared.groundingText);
}

/** The fixed notice for a bare yes or no with no question waiting: no action, no held state, no "cannot", no command. */
export function renderNoOpenQuestion(language: 'ko' | 'en'): string {
  return language === 'en'
    ? "There's no question waiting for an answer. Tell me what you'd like in a sentence."
    : '지금 답을 기다리는 질문이 없어요. 원하시는 걸 문장으로 말씀해 주세요.';
}

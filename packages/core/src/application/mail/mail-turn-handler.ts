import { nlFlagArg, nlStringArg, type NlCatalogEntry, type NlClassBProbe, type NlGrammarSelection, type NlSelectedCommand } from '../nl-routing/catalog';
import { nlWave1Entry } from '../nl-routing/wave1-entries';
import type {
  ConversationTurnHandler,
  TurnHandlerContext,
  TurnHandlerProbeContext,
  TurnHandlerReply,
  TurnHandlerSummarizeReply,
} from '../../ports/conversation-turn-handler.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import { isConnectorQueryError } from '../../ports/connector-query';
import {
  MAIL_LISTING_MAX_ENTRIES,
  type MailMessage,
  type MailReader,
  type MailSearchQuery,
  type MailSearchResult,
  type MailThread,
} from '../../ports/mail-reader.port';
import type { Id, IsoTimestamp, MessageBody } from '../../domain';
import { isDirectConversation, outboundMessage } from '../message-rendering';
import { parseReminderMessage } from '../reminders/reminder-grammar';
import { localDateOf, zonedToUtcIso } from '../reminders/zoned-time';
import {
  LAST_LISTING_TTL_MS,
  findListingByReply,
  findPersistedListingByReply,
  persistListing,
  persistListingReplies,
  readListing,
  readPersistedListing,
  withListing,
  withListingReplies,
  type ListingReplyMatch,
  type PersistedListing,
} from '../last-listing';
import type { SessionManager } from '../session-manager';
import type { DeliveredTurn, TurnDeliveryObserver } from '../turn-delivery';
import { buildUntrustedDocumentReadout } from '../untrusted-document-readout';
import { parseMailQuestion, type MailLanguage, type MailQuestion } from './mail-question';
import { buildMailThreadReadout } from './mail-thread-readout';
import {
  renderMailDmOnly,
  renderMailHistoryNote,
  renderMailListing,
  renderMailReadFailure,
  renderMailReplyPickExpired,
  renderMailReplyPickOutOfRange,
  renderMailReplyPickUnknown,
  renderMailReplyPickWhich,
  renderMailThreadNotSupported,
  renderMailThreadRefused,
  renderMailThreadSummaryFooter,
  renderMailThreadSummaryUnavailable,
  renderMailSummaryFooter,
  renderMailSummaryNeedsListing,
  renderMailSummaryOutOfRange,
  renderMailSummaryRefused,
  renderMailSummaryUnavailable,
  renderMailSummaryWhich,
  renderMailUsage,
  renderMailWriteRefused,
  type MailHistoryKind,
  type MailListingFilter,
  type MailReadFailure,
  type MailSourceCopy,
} from './mail-reply-renderer';

export const MAIL_TURN_HANDLER_ID = 'mail';
/**
 * ADR-0118 (amends ADR-0096 D5): `pre-classify`, order 140 — after memory (50), learning (60), model selection (70) and
 * anchored to-dos (100), and BEFORE the calendar (150), so `오늘 온 메일 뭐 있어?` is never read as a schedule question;
 * then reminders (200), work lookups (300) and help intent (400). A message the reminder grammar recognizes is never
 * claimed, so `내일 9시에 메일 확인 알려줘` stays a reminder.
 */
export const MAIL_TURN_HANDLER_ORDER = 140;
/** The content-free Class B grammar id of the mail listing forms (ADR-0120 D10 agreement log). */
export const MAIL_LIST_GRAMMAR_ID = 'mail-question.list';
/** The whole read (one search plus its metadata reads, or one message) must finish within this bound. */
export const MAIL_READ_TIMEOUT_MS = 30_000;
/** At most this many conversations' last mail list are kept in memory (the oldest is dropped first). */
export const MAIL_RECENT_LISTINGS_MAX = 256;
/** A summary may refer to a list shown at most this long ago (the shared listing TTL, memory and persisted alike). */
export const MAIL_RECENT_LISTING_TTL_MS = LAST_LISTING_TTL_MS;
/** GML-2: a listing waits at most this long for its delivery receipt (the reply is delivered right after the turn). */
export const MAIL_PENDING_RECEIPT_TTL_MS = 5 * 60_000;
/** GML-2: at most this many listings wait for their delivery receipt at once (the oldest is dropped first). */
export const MAIL_PENDING_RECEIPTS_MAX = 64;

/** The contributed help line (ADR-0096 D6; under the composer's 120-character bound; quoted phrases route here). */
export const MAIL_HELP_LINES: readonly string[] = Object.freeze([
  '- 메일(읽기 전용, DM에서만): "안 읽은 메일", "오늘 온 메일", "김철수 메일 찾아줘", "1번 메일 요약해줘"',
]);

export interface MailTurnHandlerDeps {
  readonly reader: MailReader;
  /** `QUOKY_TIMEZONE`: "today" and every rendered time are in this zone. */
  readonly timeZone: string;
  readonly logger?: Logger;
  /** Injectable for tests; production uses MAIL_READ_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** The source label and reconnect step the composition root supplies (review P3-6); neutral copy when absent. */
  readonly copy?: MailSourceCopy;
  /**
   * Persists the last listing's displayed ids in `Session.metadata` (no migration) so "N번 메일 요약해줘" survives a
   * restart; the persisted record wins over the in-memory cache. Absent = in-memory only.
   */
  readonly sessions?: Pick<SessionManager, 'updateMetadataEntry'>;
}

/** GML-2: a listing reply waiting for its delivery receipt. */
interface PendingReceipt {
  readonly sessionId: Id;
  readonly actorId: Id;
  readonly requestId: string;
  readonly at: IsoTimestamp;
}

class MailReadTimeout extends Error {
  constructor() {
    super('mail read timed out');
    this.name = 'MailReadTimeout';
  }
}

/**
 * The owner's mail, read-only (ADR-0118 D2–D8, GML-1), as an ADR-0096 `pre-classify` turn handler, order 140.
 * Registered by the composition root ONLY when a `MailReader` is configured; without one every reply is unchanged.
 *
 * - **Routing from the owner's text only (D8).** The anchored grammar reads `ctx.message.text`; no mail content is ever
 *   an input to a decision. A mail can neither claim a turn nor change which handler runs next.
 * - **Write requests (D6)** get the fixed read-only refusal; no read is made and no write path exists.
 * - **DM-only (D5).** Outside a direct conversation (`ConversationContext.direct`, on every platform) the reply says
 *   listings and summaries are DM-only, and nothing is read.
 * - **Listings (D4)** are deterministic: one bounded search, at most 10 entries plus "…외 N건", no model call. A failed
 *   read is the "could not read" note (status `FAILED`), never "no mail".
 * - **Summaries (D7)** happen only on an explicit request for one listed item: the handler reads that one message and
 *   returns a `summarize` outcome with the bounded, guarded untrusted readout; the runtime's existing SUMMARIZATION path
 *   (the effective chat-tier provider, no tool surface) produces the summary. A credential-shaped or empty mail is
 *   refused here, before anything leaves the host.
 * - **History.** SHORT_TERM history keeps a fixed note instead of any mail reply, so mail text never reaches a later
 *   prompt; the ids of the listed messages (never their text) are kept in memory per (session, actor) for 30 minutes.
 * - **Threads (GML-2).** `이 스레드 요약해줘` / `N번 메일 스레드 요약해줘` read the listed message's thread through the
 *   optional `MailReader.getThread` (at most 20 messages, 256 KiB) and return the same `summarize` outcome over a
 *   `mail-thread` readout: each message credential-guarded before and after the clip, no tools, the fixed footer.
 * - **Reply picks (GML-2).** A listing records the inbound id that asked for it; after delivery `observeDelivery`
 *   records the reply's platform ids (the delivery receipt). A later message whose opaque `replyTo.messageId` is one of
 *   them picks from THAT listing (`N번`, or `이 메일` for a one-entry listing), and only then may the mail noun be left
 *   out (`2번 요약해줘`). A reply to anything else picks nothing and the turn behaves as before.
 *
 * Creates no Task, TaskRun or ApprovalRequest; logs no message, mail text or query.
 */
export class MailTurnHandler implements ConversationTurnHandler, TurnDeliveryObserver {
  readonly id = MAIL_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = MAIL_TURN_HANDLER_ORDER;
  readonly helpLines = MAIL_HELP_LINES;
  /** The in-memory copy of the listing state, per session (the same shape and rules as the persisted record). */
  private readonly memory = new Map<Id, unknown>();
  /** GML-2: listings waiting for their delivery receipt, by inbound message. */
  private readonly pendingReceipts = new Map<string, PendingReceipt>();

  constructor(private readonly deps: MailTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | TurnHandlerSummarizeReply | null> {
    const picked = this.replyMatch(ctx);
    const question = this.parseQuestion(ctx, picked !== undefined);
    if (question === null) return null;
    const language = question.language;
    // GML-2: words that name no mail (`이 스레드 요약해줘`) may mean the platform's own thread outside a DM: not ours.
    if (question.kind === 'summarize' && question.unnamed === true && !isDirectConversation(ctx.message.context)) return null;

    if (question.kind === 'write-refused') {
      this.log('info', 'mail.turn_handler.write_refused', {});
      return this.reply(ctx, renderMailWriteRefused(language), 'RESPONDED', language, 'not-read');
    }
    if (question.kind === 'usage') return this.reply(ctx, renderMailUsage(language), 'RESPONDED', language, 'not-read');
    if (!isDirectConversation(ctx.message.context)) {
      this.log('info', 'mail.turn_handler.dm_only', { kind: question.kind });
      return this.reply(ctx, renderMailDmOnly(language), 'RESPONDED', language, 'not-read');
    }
    if (question.kind === 'list') {
      const listed = await this.list(ctx, { unread: question.unread, today: question.today, ...(question.from !== undefined ? { from: question.from } : {}) }, language);
      // ADR-0120 follow-up: the structural `mail.list` equivalent of what this grammar just listed.
      return listed.status === 'FAILED'
        ? listed
        : {
            ...listed,
            nlSelection: mailGrammarSelection(question),
          };
    }
    return this.summarize(ctx, question, picked);
  }

  /**
   * The mail grammar exactly as `handle` reads it (a reminder is never a mail question); `null` on no match. The
   * reply-pick forms are read only when `replyBound` (a reply to a recorded mail listing).
   */
  private parseQuestion(ctx: TurnHandlerProbeContext, replyBound = false): MailQuestion | null {
    try {
      if (parseReminderMessage(ctx.message.text, { now: ctx.now, timeZone: this.deps.timeZone }).kind !== 'NOT_REMINDER') return null;
      return parseMailQuestion(ctx.message.text, { replyBound });
    } catch {
      return null;
    }
  }

  /**
   * ADR-0120 D6 Phase C: only the listing forms are frozen Class B. A write refusal, the usage hint and an `N번 메일 요약`
   * item summary are Class A (`null`), so `handle` answers them exactly as before. Pure: nothing is read.
   */
  classBProbe(ctx: TurnHandlerProbeContext): NlClassBProbe | null {
    const question = this.parseQuestion(ctx);
    if (question === null || question.kind !== 'list') return null;
    return { grammarId: MAIL_LIST_GRAMMAR_ID, selection: mailGrammarSelection(question) };
  }

  /** ADR-0120 D1: `mail.list`, offered whenever this handler is registered (Gmail is configured). */
  readonly catalog: readonly NlCatalogEntry[] = Object.freeze([nlWave1Entry('mail.list')]);

  /**
   * A validated `mail.list` selection (ADR-0120 interfaces): the same bounded listing as "안 읽은 메일" / "오늘 온 메일" /
   * "<보낸 사람> 메일", DM-only like every mail reply (ADR-0118 D5), no model.
   */
  async handleSelected(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    if (selected.entryId !== 'mail.list') return null;
    const language: MailLanguage = selected.language;
    if (!isDirectConversation(ctx.message.context)) {
      this.log('info', 'mail.turn_handler.dm_only', { kind: 'list' });
      return this.reply(ctx, renderMailDmOnly(language), 'RESPONDED', language, 'not-read');
    }
    const from = nlStringArg(selected.args, 'from');
    return this.list(
      ctx,
      { unread: nlFlagArg(selected.args, 'unread'), today: nlFlagArg(selected.args, 'today'), ...(from !== undefined ? { from } : {}) },
      language,
    );
  }

  private async list(ctx: TurnHandlerContext, filter: MailListingFilter, language: MailLanguage): Promise<TurnHandlerReply> {
    const query: MailSearchQuery = {
      ...(filter.unread ? { unreadOnly: true } : {}),
      ...(filter.today ? { receivedAfter: startOfLocalDay(ctx.now, this.deps.timeZone) } : {}),
      ...(filter.from !== undefined ? { from: filter.from } : {}),
      limit: MAIL_LISTING_MAX_ENTRIES,
    };
    let result: MailSearchResult;
    try {
      result = await this.withTimeout(this.deps.reader.search(query));
    } catch (error) {
      const failure = failureOf(error);
      this.log('warn', 'mail.turn_handler.read_failed', { kind: 'list', reason: failure });
      return this.reply(ctx, renderMailReadFailure(failure, language, this.deps.copy), 'FAILED', language, 'not-read');
    }
    const messages = result.messages.slice(0, MAIL_LISTING_MAX_ENTRIES);
    this.log('info', 'mail.turn_handler.listed', { shown: messages.length, matched: result.matched });
    const shownIds = messages.map((message) => message.id);
    this.rememberListing(ctx, shownIds);
    await this.persistShown(ctx, shownIds);
    if (shownIds.length > 0) this.awaitReceipt(ctx);
    const body = renderMailListing(filter, { ...result, messages }, {
      timeZone: this.deps.timeZone,
      now: ctx.now,
      language,
      ...(this.deps.copy !== undefined ? { copy: this.deps.copy } : {}),
    });
    return this.reply(ctx, body, 'RESPONDED', language, 'listed');
  }

  private async summarize(
    ctx: TurnHandlerContext,
    question: Extract<MailQuestion, { kind: 'summarize' }>,
    picked: ListingReplyMatch | undefined,
  ): Promise<TurnHandlerReply | TurnHandlerSummarizeReply | null> {
    const { target, language } = question;
    if (picked?.kind === 'expired') {
      this.log('info', 'mail.turn_handler.reply_pick', { matched: 'expired' });
      return this.reply(ctx, renderMailReplyPickExpired(language), 'RESPONDED', language, 'not-read');
    }
    // Codex review P2: a reply that matches no live listing (another message, or a listing evicted past every record)
    // never falls back to the last list — only a message that is not a reply may use the 30-minute last-list rule.
    if (picked === undefined && isReply(ctx)) {
      if (question.unnamed === true) return null;
      this.log('info', 'mail.turn_handler.reply_pick', { matched: 'unknown' });
      return this.reply(ctx, renderMailReplyPickUnknown(language), 'RESPONDED', language, 'not-read');
    }
    const viaReply = picked?.kind === 'listing';
    if (viaReply) this.log('info', 'mail.turn_handler.reply_pick', { matched: 'listing' });
    const ids = picked?.kind === 'listing' ? picked.listing.ids : (this.currentListing(ctx)?.ids ?? []);
    if (ids.length === 0) {
      // CA review P3: words that name no mail (`이 스레드 요약해줘`, `3번 스레드 요약`) with no listing and no reply are not
      // about mail at all: chat answers them.
      if (question.unnamed === true && picked === undefined) return null;
      return this.reply(ctx, renderMailSummaryNeedsListing(language), 'RESPONDED', language, 'not-read');
    }
    let index: number;
    if (target.kind === 'this') {
      if (ids.length !== 1) {
        const which = viaReply ? renderMailReplyPickWhich(ids.length, language) : renderMailSummaryWhich(ids.length, language);
        return this.reply(ctx, which, 'RESPONDED', language, 'not-read');
      }
      index = 1;
    } else {
      index = target.index;
    }
    const id = ids[index - 1];
    if (id === undefined) {
      const outOfRange = viaReply
        ? renderMailReplyPickOutOfRange(index, ids.length, language)
        : renderMailSummaryOutOfRange(index, ids.length, language);
      return this.reply(ctx, outOfRange, 'RESPONDED', language, 'not-read');
    }
    if (question.scope === 'thread') return this.summarizeThread(ctx, id, language);

    let message: MailMessage;
    try {
      message = await this.withTimeout(this.deps.reader.getMessage(id));
    } catch (error) {
      const failure = failureOf(error);
      this.log('warn', 'mail.turn_handler.read_failed', { kind: 'summarize', reason: failure });
      return this.reply(ctx, renderMailReadFailure(failure, language, this.deps.copy), 'FAILED', language, 'not-read');
    }
    const built = buildUntrustedDocumentReadout({
      source: 'mail',
      title: message.subject,
      author: message.sender.name.trim().length > 0 ? message.sender.name : message.sender.address,
      date: message.receivedAt,
      body: message.bodyText,
      sourceTruncated: message.bodyTruncated,
    });
    if (!built.ok) {
      this.log('info', 'mail.turn_handler.summary_refused', { refusal: built.refusal });
      return this.reply(ctx, renderMailSummaryRefused(built.refusal, language), 'RESPONDED', language, 'not-summarized');
    }
    this.log('info', 'mail.turn_handler.summarize', { truncated: built.readout.truncated });
    return {
      kind: 'summarize',
      readout: built.readout,
      fallbackText: renderMailSummaryUnavailable(language),
      footer: renderMailSummaryFooter(language),
    };
  }

  /** GML-2: one thread, bounded and guarded like one mail; a reader without a thread read says so honestly. */
  private async summarizeThread(
    ctx: TurnHandlerContext,
    messageId: string,
    language: MailLanguage,
  ): Promise<TurnHandlerReply | TurnHandlerSummarizeReply> {
    const reader = this.deps.reader;
    if (typeof reader.getThread !== 'function') {
      this.log('info', 'mail.turn_handler.thread_unsupported', {});
      return this.reply(ctx, renderMailThreadNotSupported(language), 'RESPONDED', language, 'not-read');
    }
    let thread: MailThread;
    try {
      thread = await this.withTimeout(reader.getThread(messageId));
    } catch (error) {
      const failure = failureOf(error);
      this.log('warn', 'mail.turn_handler.read_failed', { kind: 'thread', reason: failure });
      return this.reply(ctx, renderMailReadFailure(failure, language, this.deps.copy), 'FAILED', language, 'not-read');
    }
    const { result, shown, total } = buildMailThreadReadout(thread);
    if (!result.ok) {
      this.log('info', 'mail.turn_handler.summary_refused', { kind: 'thread', refusal: result.refusal });
      return this.reply(ctx, renderMailThreadRefused(result.refusal, language), 'RESPONDED', language, 'not-summarized');
    }
    this.log('info', 'mail.turn_handler.summarize', { kind: 'thread', shown, total, truncated: result.readout.truncated });
    return {
      kind: 'summarize',
      readout: result.readout,
      fallbackText: renderMailThreadSummaryUnavailable(language),
      footer: renderMailThreadSummaryFooter(shown, total, language),
    };
  }

  /**
   * GML-2 (`TurnDeliveryObserver`, called by `QuokyCore` after delivery): bind a listing this handler answered to the
   * platform ids of its delivered reply, in memory and in the persisted record. Best-effort; never throws.
   */
  async observeDelivery(turn: DeliveredTurn): Promise<void> {
    try {
      const key = receiptKey(turn.messageId, turn.context);
      const pending = this.pendingReceipts.get(key);
      if (pending === undefined) return;
      this.pendingReceipts.delete(key);
      if (turn.status !== 'RESPONDED' || turn.sessionId !== pending.sessionId || turn.platformMessageIds.length === 0) return;
      const ids = turn.platformMessageIds;
      const memory = withListingReplies(this.memory.get(pending.sessionId), pending.actorId, 'mail', pending.requestId, ids, pending.at);
      if (memory.found) this.memory.set(pending.sessionId, memory.next);
      if (this.deps.sessions !== undefined) {
        await persistListingReplies(this.deps.sessions, pending.sessionId, pending.actorId, 'mail', pending.requestId, ids, pending.at);
      }
    } catch {
      this.log('warn', 'mail.turn_handler.receipt_persist_failed', {});
    }
  }

  /** GML-2: remember that this turn's reply is a listing, until its receipt arrives (bounded in count and time). */
  private awaitReceipt(ctx: TurnHandlerContext): void {
    const now = Date.parse(ctx.now);
    for (const [key, pending] of this.pendingReceipts) {
      const age = now - Date.parse(pending.at);
      if (!Number.isFinite(age) || age < 0 || age >= MAIL_PENDING_RECEIPT_TTL_MS) this.pendingReceipts.delete(key);
    }
    const key = receiptKey(ctx.message.id, ctx.message.context);
    this.pendingReceipts.delete(key);
    this.pendingReceipts.set(key, { sessionId: ctx.session.id, actorId: ctx.actor.id, requestId: ctx.message.id, at: ctx.now });
    while (this.pendingReceipts.size > MAIL_PENDING_RECEIPTS_MAX) {
      const oldest = this.pendingReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.pendingReceipts.delete(oldest);
    }
  }

  /**
   * GML-2: what a platform reply points at — a recorded mail listing (persisted record first, then memory), an expired
   * one, or nothing (`undefined`: not a reply, or a reply to anything else).
   */
  private replyMatch(ctx: TurnHandlerContext): ListingReplyMatch | undefined {
    const replyId = ctx.message.replyTo?.messageId;
    if (typeof replyId !== 'string' || replyId.length === 0) return undefined;
    const persisted = findPersistedListingByReply(ctx.session, ctx.actor.id, 'mail', replyId, ctx.now);
    if (persisted?.kind === 'listing') return persisted;
    const cached = findListingByReply(this.memory.get(ctx.session.id), ctx.actor.id, 'mail', replyId, ctx.now);
    return cached?.kind === 'listing' ? cached : (persisted ?? cached);
  }

  private rememberListing(ctx: TurnHandlerContext, messageIds: readonly string[]): void {
    const sessionId = ctx.session.id;
    const next = withListing(this.memory.get(sessionId), ctx.actor.id, 'mail', messageIds, ctx.now, ctx.message.id);
    this.memory.delete(sessionId);
    if (next !== undefined) this.memory.set(sessionId, next);
    while (this.memory.size > MAIL_RECENT_LISTINGS_MAX) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  /** Best-effort: a failed write leaves the in-memory cache as the only copy (never fails the turn). */
  private async persistShown(ctx: TurnHandlerContext, messageIds: readonly string[]): Promise<void> {
    if (this.deps.sessions === undefined) return;
    try {
      await persistListing(this.deps.sessions, ctx.session.id, ctx.actor.id, 'mail', messageIds, ctx.now, ctx.message.id);
    } catch {
      this.log('warn', 'mail.turn_handler.listing_persist_failed', {});
    }
  }

  /** This (session, actor)'s last list within the TTL (the newer of the persisted record and the cache), or `undefined`. */
  private currentListing(ctx: TurnHandlerContext): PersistedListing | undefined {
    const cached = readListing(this.memory.get(ctx.session.id), ctx.actor.id, 'mail', ctx.now);
    const persisted = readPersistedListing(ctx.session, ctx.actor.id, 'mail', ctx.now);
    if (persisted !== undefined && (cached === undefined || Date.parse(persisted.at) > Date.parse(cached.at))) return persisted;
    return cached;
  }

  private reply(
    ctx: TurnHandlerContext,
    text: MessageBody,
    status: 'RESPONDED' | 'FAILED',
    language: MailLanguage,
    history: MailHistoryKind,
  ): TurnHandlerReply {
    return {
      reply: outboundMessage(ctx.message.context, text, { replyToMessageId: ctx.message.id }),
      status,
      history: { assistant: renderMailHistoryNote(language, history) },
    };
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MailReadTimeout()), this.deps.timeoutMs ?? MAIL_READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private log(level: 'info' | 'warn', event: string, fields: LogFields): void {
    try {
      this.deps.logger?.[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

function failureOf(error: unknown): MailReadFailure {
  if (error instanceof MailReadTimeout) return 'TIMEOUT';
  return isConnectorQueryError(error) ? error.reason : 'UNAVAILABLE';
}

/** The local midnight of `now`'s day in `timeZone`, as an instant. */
function startOfLocalDay(now: IsoTimestamp, timeZone: string): IsoTimestamp {
  const day = localDateOf(now, timeZone);
  return zonedToUtcIso({ ...day, hour: 0, minute: 0 }, timeZone);
}

/** GML-2: whether the owner's message is a platform reply (to anything). */
function isReply(ctx: TurnHandlerContext): boolean {
  const replyId = ctx.message.replyTo?.messageId;
  return typeof replyId === 'string' && replyId.length > 0;
}

/** GML-2: one inbound message (platform message ids are unique only per conversation). */
function receiptKey(messageId: Id, context: { readonly platform: string; readonly channelId: string }): string {
  return JSON.stringify([context.platform, context.channelId, messageId]);
}

/** Factory for the composition root (ADR-0096 D7). */
export function createMailTurnHandler(deps: MailTurnHandlerDeps): MailTurnHandler {
  return new MailTurnHandler(deps);
}

/** The structural `mail.list` equivalent of a listing form (canonical: defaults omitted). */
function mailGrammarSelection(question: Extract<MailQuestion, { kind: 'list' }>): NlGrammarSelection {
  return {
    entryId: 'mail.list',
    args: { ...(question.unread ? { unread: true } : {}), ...(question.today ? { today: true } : {}), ...(question.from !== undefined ? { from: question.from } : {}) },
  };
}

import type {
  ConversationTurnHandler,
  TurnHandlerContext,
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
} from '../../ports/mail-reader.port';
import type { Id, IsoTimestamp, MessageBody } from '../../domain';
import { isDirectConversation, outboundMessage } from '../message-rendering';
import { parseReminderMessage } from '../reminders/reminder-grammar';
import { localDateOf, zonedToUtcIso } from '../reminders/zoned-time';
import { buildUntrustedDocumentReadout } from '../untrusted-document-readout';
import { parseMailQuestion, type MailLanguage, type MailQuestion, type MailSummaryTarget } from './mail-question';
import {
  renderMailDmOnly,
  renderMailHistoryNote,
  renderMailListing,
  renderMailReadFailure,
  renderMailSummaryFooter,
  renderMailSummaryNeedsListing,
  renderMailSummaryOutOfRange,
  renderMailSummaryRefused,
  renderMailSummaryUnavailable,
  renderMailSummaryWhich,
  renderMailUsage,
  renderMailWriteRefused,
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
/** The whole read (one search plus its metadata reads, or one message) must finish within this bound. */
export const MAIL_READ_TIMEOUT_MS = 30_000;
/** At most this many conversations' last mail list are kept in memory (the oldest is dropped first). */
export const MAIL_RECENT_LISTINGS_MAX = 256;
/** A summary may refer to a list shown at most this long ago. */
export const MAIL_RECENT_LISTING_TTL_MS = 30 * 60_000;

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
}

class MailReadTimeout extends Error {
  constructor() {
    super('mail read timed out');
    this.name = 'MailReadTimeout';
  }
}

interface RecentListing {
  readonly at: IsoTimestamp;
  readonly sessionId: Id;
  readonly actorId: Id;
  /** The ids of the entries shown, in list order (never their text). */
  readonly messageIds: readonly string[];
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
 *
 * Creates no Task, TaskRun or ApprovalRequest; logs no message, mail text or query.
 */
export class MailTurnHandler implements ConversationTurnHandler {
  readonly id = MAIL_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = MAIL_TURN_HANDLER_ORDER;
  readonly helpLines = MAIL_HELP_LINES;
  private readonly recentListings = new Map<string, RecentListing>();

  constructor(private readonly deps: MailTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | TurnHandlerSummarizeReply | null> {
    const text = ctx.message.text;
    let question: MailQuestion | null;
    try {
      if (parseReminderMessage(text, { now: ctx.now, timeZone: this.deps.timeZone }).kind !== 'NOT_REMINDER') return null;
      question = parseMailQuestion(text);
    } catch {
      return null;
    }
    if (question === null) return null;
    const language = question.language;

    if (question.kind === 'write-refused') {
      this.log('info', 'mail.turn_handler.write_refused', {});
      return this.reply(ctx, renderMailWriteRefused(language), 'RESPONDED', language);
    }
    if (question.kind === 'usage') return this.reply(ctx, renderMailUsage(language), 'RESPONDED', language);
    if (!isDirectConversation(ctx.message.context)) {
      this.log('info', 'mail.turn_handler.dm_only', { kind: question.kind });
      return this.reply(ctx, renderMailDmOnly(language), 'RESPONDED', language);
    }
    if (question.kind === 'list') {
      return this.list(ctx, { unread: question.unread, today: question.today, ...(question.from !== undefined ? { from: question.from } : {}) }, language);
    }
    return this.summarize(ctx, question.target, language);
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
      return this.reply(ctx, renderMailReadFailure(failure, language, this.deps.copy), 'FAILED', language);
    }
    const messages = result.messages.slice(0, MAIL_LISTING_MAX_ENTRIES);
    this.log('info', 'mail.turn_handler.listed', { shown: messages.length, matched: result.matched });
    this.rememberListing(ctx, messages.map((message) => message.id));
    const body = renderMailListing(filter, { ...result, messages }, {
      timeZone: this.deps.timeZone,
      now: ctx.now,
      language,
      ...(this.deps.copy !== undefined ? { copy: this.deps.copy } : {}),
    });
    return this.reply(ctx, body, 'RESPONDED', language);
  }

  private async summarize(
    ctx: TurnHandlerContext,
    target: MailSummaryTarget,
    language: MailLanguage,
  ): Promise<TurnHandlerReply | TurnHandlerSummarizeReply> {
    const listing = this.currentListing(ctx);
    const ids = listing?.messageIds ?? [];
    if (ids.length === 0) return this.reply(ctx, renderMailSummaryNeedsListing(language), 'RESPONDED', language);
    let index: number;
    if (target.kind === 'this') {
      if (ids.length !== 1) return this.reply(ctx, renderMailSummaryWhich(ids.length, language), 'RESPONDED', language);
      index = 1;
    } else {
      index = target.index;
    }
    const id = ids[index - 1];
    if (id === undefined) return this.reply(ctx, renderMailSummaryOutOfRange(index, ids.length, language), 'RESPONDED', language);

    let message: MailMessage;
    try {
      message = await this.withTimeout(this.deps.reader.getMessage(id));
    } catch (error) {
      const failure = failureOf(error);
      this.log('warn', 'mail.turn_handler.read_failed', { kind: 'summarize', reason: failure });
      return this.reply(ctx, renderMailReadFailure(failure, language, this.deps.copy), 'FAILED', language);
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
      return this.reply(ctx, renderMailSummaryRefused(built.refusal, language), 'RESPONDED', language);
    }
    this.log('info', 'mail.turn_handler.summarize', { truncated: built.readout.truncated });
    return {
      kind: 'summarize',
      readout: built.readout,
      fallbackText: renderMailSummaryUnavailable(language),
      footer: renderMailSummaryFooter(language),
    };
  }

  private rememberListing(ctx: TurnHandlerContext, messageIds: readonly string[]): void {
    const key = listingKey(ctx.session.id, ctx.actor.id);
    this.recentListings.delete(key);
    this.recentListings.set(key, { at: ctx.now, sessionId: ctx.session.id, actorId: ctx.actor.id, messageIds: [...messageIds] });
    while (this.recentListings.size > MAIL_RECENT_LISTINGS_MAX) {
      const oldest = this.recentListings.keys().next().value;
      if (oldest === undefined) break;
      this.recentListings.delete(oldest);
    }
  }

  /** This (session, actor)'s last list within the TTL, or `undefined`. */
  private currentListing(ctx: TurnHandlerContext): RecentListing | undefined {
    const key = listingKey(ctx.session.id, ctx.actor.id);
    const listing = this.recentListings.get(key);
    if (!listing || listing.sessionId !== ctx.session.id || listing.actorId !== ctx.actor.id) return undefined;
    const age = Date.parse(ctx.now) - Date.parse(listing.at);
    if (!Number.isFinite(age) || age < 0 || age >= MAIL_RECENT_LISTING_TTL_MS) {
      this.recentListings.delete(key);
      return undefined;
    }
    return listing;
  }

  private reply(
    ctx: TurnHandlerContext,
    text: MessageBody,
    status: 'RESPONDED' | 'FAILED',
    language: MailLanguage,
  ): TurnHandlerReply {
    return {
      reply: outboundMessage(ctx.message.context, text, { replyToMessageId: ctx.message.id }),
      status,
      history: { assistant: renderMailHistoryNote(language) },
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

function listingKey(sessionId: Id, actorId: Id): string {
  return JSON.stringify([sessionId, actorId]);
}

/** Factory for the composition root (ADR-0096 D7). */
export function createMailTurnHandler(deps: MailTurnHandlerDeps): MailTurnHandler {
  return new MailTurnHandler(deps);
}

import { nlStringArg, type NlCatalogEntry, type NlSelectedCommand } from '../nl-routing/catalog';
import { nlWave1Entry } from '../nl-routing/wave1-entries';
import type {
  ConversationTurnHandler,
  TurnHandlerContext,
  TurnHandlerReply,
  TurnHandlerSummarizeReply,
} from '../../ports/conversation-turn-handler.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import { isConnectorQueryError } from '../../ports/connector-query';
import {
  DRIVE_LISTING_KINDS,
  DRIVE_LISTING_MAX_ENTRIES,
  isDriveTextExportable,
  type DriveDocument,
  type DriveFileKind,
  type DriveListingKind,
  type DriveListResult,
  type DriveReader,
} from '../../ports/drive-reader.port';
import type { Id, IsoTimestamp, MessageBody } from '../../domain';
import { isDirectConversation, outboundMessage } from '../message-rendering';
import { parseReminderMessage } from '../reminders/reminder-grammar';
import { persistListing, readPersistedListing } from '../last-listing';
import type { SessionManager } from '../session-manager';
import { buildUntrustedDocumentReadout } from '../untrusted-document-readout';
import { parseDriveQuestion, type DriveLanguage, type DriveQuestion, type DriveSummaryTarget } from './drive-question';
import {
  renderDriveDmOnly,
  renderDriveHistoryNote,
  renderDriveListing,
  renderDriveReadFailure,
  renderDriveSummaryFooter,
  renderDriveSummaryNeedsListing,
  renderDriveSummaryNotText,
  renderDriveSummaryOutOfRange,
  renderDriveSummaryRefused,
  renderDriveSummaryUnavailable,
  renderDriveSummaryWhich,
  renderDriveUsage,
  renderDriveWriteRefused,
  type DriveHistoryKind,
  type DriveListingFilter,
  type DriveReadFailure,
  type DriveSourceCopy,
} from './drive-reply-renderer';

export const DRIVE_TURN_HANDLER_ID = 'drive';
/**
 * ADR-0118 (amends ADR-0096 D5): `pre-classify`, order 145 — after memory (50), learning (60), model selection (70),
 * anchored to-dos (100) and the mail handler (140), and BEFORE the calendar (150); then reminders (200), work lookups
 * (300) and help intent (400). The grammar names the drive or a Drive listing number, never `메일` or a schedule word, so
 * it steals no mail or calendar phrasing whichever of them is configured; a message the reminder grammar recognizes is
 * never claimed.
 */
export const DRIVE_TURN_HANDLER_ORDER = 145;
/** The whole read (one listing, or one export) must finish within this bound. */
export const DRIVE_READ_TIMEOUT_MS = 30_000;
/** At most this many conversations' last Drive list are kept in memory (the oldest is dropped first). */
export const DRIVE_RECENT_LISTINGS_MAX = 256;
/** A summary may refer to a list shown at most this long ago. */
export const DRIVE_RECENT_LISTING_TTL_MS = 30 * 60_000;

/** The contributed help line (ADR-0096 D6; under the composer's 120-character bound; quoted phrases route here). */
export const DRIVE_HELP_LINES: readonly string[] = Object.freeze([
  '- 드라이브(읽기 전용, DM에서만): "최근 문서", "드라이브에서 회의록 찾아줘", "1번 문서 요약해줘"',
]);

export interface DriveTurnHandlerDeps {
  readonly reader: DriveReader;
  /** `QUOKY_TIMEZONE`: every rendered time is in this zone. */
  readonly timeZone: string;
  readonly logger?: Logger;
  /** Injectable for tests; production uses DRIVE_READ_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** The source label and reconnect step the composition root supplies; neutral copy when absent. */
  readonly copy?: DriveSourceCopy;
  /** Persists the last listing's displayed ids in `Session.metadata` (see the mail handler); absent = in-memory only. */
  readonly sessions?: Pick<SessionManager, 'updateMetadataEntry'>;
}

class DriveReadTimeout extends Error {
  constructor() {
    super('drive read timed out');
    this.name = 'DriveReadTimeout';
  }
}

interface RecentListing {
  readonly at: IsoTimestamp;
  readonly sessionId: Id;
  readonly actorId: Id;
  /**
   * The ids (and, in memory only, the kinds) of the entries shown, in list order (never their names). A record restored
   * after a restart has ids only: the adapter re-checks the kind at export time.
   */
  readonly files: ReadonlyArray<{ readonly id: string; readonly kind?: DriveFileKind }>;
}

/**
 * The owner's Drive, read-only (ADR-0118 D2–D8, DRV-1), as an ADR-0096 `pre-classify` turn handler, order 145.
 * Registered by the composition root ONLY when a `DriveReader` is configured; without one every reply is unchanged.
 *
 * - **Routing from the owner's text only (D8).** The anchored grammar reads `ctx.message.text`; no file name or content
 *   is ever an input to a decision. A message that carries attachments belongs to the attachment path and is never
 *   claimed.
 * - **Write requests (D6)** get the fixed read-only refusal; no read is made and no write path exists.
 * - **DM-only (D5).** Outside a direct conversation (`ConversationContext.direct`, on every platform) the reply says
 *   listings and summaries are DM-only, and nothing is read.
 * - **Listings (D4)** are deterministic: one bounded read, at most 10 entries plus "…외 N건", no model call. A failed
 *   read is the "could not read" note (status `FAILED`), never "no files".
 * - **Summaries (D7)** happen only on an explicit request for one listed file whose kind has a text export: the handler
 *   reads that one file's text and returns a `summarize` outcome with the bounded, guarded untrusted readout; the
 *   runtime's existing SUMMARIZATION path (the effective chat-tier provider, no tool surface) produces the summary. A
 *   credential-shaped or empty document is refused here, before anything leaves the host.
 * - **History.** SHORT_TERM history keeps a fixed note instead of any Drive reply; the ids and kinds of the listed
 *   files (never their names) are kept in memory per (session, actor) for 30 minutes.
 *
 * Creates no Task, TaskRun or ApprovalRequest; logs no message, file name, text or query.
 */
export class DriveTurnHandler implements ConversationTurnHandler {
  readonly id = DRIVE_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = DRIVE_TURN_HANDLER_ORDER;
  readonly helpLines = DRIVE_HELP_LINES;
  private readonly recentListings = new Map<string, RecentListing>();

  constructor(private readonly deps: DriveTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | TurnHandlerSummarizeReply | null> {
    const text = ctx.message.text;
    if ((ctx.message.attachments?.length ?? 0) > 0) return null;
    let question: DriveQuestion | null;
    try {
      if (parseReminderMessage(text, { now: ctx.now, timeZone: this.deps.timeZone }).kind !== 'NOT_REMINDER') return null;
      question = parseDriveQuestion(text);
    } catch {
      return null;
    }
    if (question === null) return null;
    const language = question.language;
    // A bare `이 문서` / `this document` is someone else's document unless a Drive list is open in this conversation.
    if (question.kind === 'summarize' && !question.explicit && this.currentListing(ctx) === undefined) return null;

    if (question.kind === 'write-refused') {
      this.log('info', 'drive.turn_handler.write_refused', {});
      return this.reply(ctx, renderDriveWriteRefused(language), 'RESPONDED', language, 'not-read');
    }
    if (question.kind === 'usage') return this.reply(ctx, renderDriveUsage(language), 'RESPONDED', language, 'not-read');
    if (!isDirectConversation(ctx.message.context)) {
      this.log('info', 'drive.turn_handler.dm_only', { kind: question.kind });
      return this.reply(ctx, renderDriveDmOnly(language), 'RESPONDED', language, 'not-read');
    }
    if (question.kind === 'recent' || question.kind === 'search') {
      const listed = await this.list(ctx, question.kind === 'recent' ? { kind: 'recent' } : { kind: 'search', name: question.name }, language);
      // ADR-0120 follow-up: the structural `drive.files` equivalent of what this grammar just listed.
      return listed.status === 'FAILED'
        ? listed
        : { ...listed, nlSelection: { entryId: 'drive.files', args: question.kind === 'search' ? { name: question.name } : {} } };
    }
    return this.summarize(ctx, question.target, language);
  }

  /** ADR-0120 D1: `drive.files`, offered whenever this handler is registered (Drive is configured). */
  readonly catalog: readonly NlCatalogEntry[] = Object.freeze([nlWave1Entry('drive.files')]);

  /**
   * A validated `drive.files` selection (ADR-0120 interfaces): the same bounded recent-files or name-search listing,
   * DM-only like every Drive reply (ADR-0118 D5), no model.
   */
  async handleSelected(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    if (selected.entryId !== 'drive.files') return null;
    const language: DriveLanguage = selected.language;
    if (!isDirectConversation(ctx.message.context)) {
      this.log('info', 'drive.turn_handler.dm_only', { kind: 'list' });
      return this.reply(ctx, renderDriveDmOnly(language), 'RESPONDED', language, 'not-read');
    }
    const name = nlStringArg(selected.args, 'name');
    const kind = nlStringArg(selected.args, 'kind');
    const fileKind = kind !== undefined && (DRIVE_LISTING_KINDS as readonly string[]).includes(kind) ? (kind as DriveListingKind) : undefined;
    const narrowed = fileKind !== undefined ? { fileKind } : {};
    return this.list(ctx, name === undefined ? { kind: 'recent', ...narrowed } : { kind: 'search', name, ...narrowed }, language);
  }

  private async list(ctx: TurnHandlerContext, filter: DriveListingFilter, language: DriveLanguage): Promise<TurnHandlerReply> {
    let result: DriveListResult;
    try {
      result = await this.withTimeout(
        filter.kind === 'recent'
          ? this.deps.reader.recentFiles(DRIVE_LISTING_MAX_ENTRIES, ...(filter.fileKind !== undefined ? [filter.fileKind] : []))
          : this.deps.reader.searchByName(filter.name, DRIVE_LISTING_MAX_ENTRIES, filter.fileKind),
      );
    } catch (error) {
      const failure = failureOf(error);
      this.log('warn', 'drive.turn_handler.read_failed', { kind: filter.kind, reason: failure });
      return this.reply(ctx, renderDriveReadFailure(failure, language, this.deps.copy), 'FAILED', language, 'not-read');
    }
    const files = result.files.slice(0, DRIVE_LISTING_MAX_ENTRIES);
    this.log('info', 'drive.turn_handler.listed', { kind: filter.kind, shown: files.length, matched: result.matched });
    this.rememberListing(ctx, files.map((file) => ({ id: file.id, kind: file.kind })));
    await this.persistShown(ctx, files.map((file) => file.id));
    const body = renderDriveListing(filter, { ...result, files }, {
      timeZone: this.deps.timeZone,
      now: ctx.now,
      language,
      ...(this.deps.copy !== undefined ? { copy: this.deps.copy } : {}),
    });
    return this.reply(ctx, body, 'RESPONDED', language, 'listed');
  }

  private async summarize(
    ctx: TurnHandlerContext,
    target: DriveSummaryTarget,
    language: DriveLanguage,
  ): Promise<TurnHandlerReply | TurnHandlerSummarizeReply> {
    const files = this.currentListing(ctx)?.files ?? [];
    if (files.length === 0) return this.reply(ctx, renderDriveSummaryNeedsListing(language), 'RESPONDED', language, 'not-read');
    let index: number;
    if (target.kind === 'this') {
      if (files.length !== 1) return this.reply(ctx, renderDriveSummaryWhich(files.length, language), 'RESPONDED', language, 'not-read');
      index = 1;
    } else {
      index = target.index;
    }
    const file = files[index - 1];
    if (file === undefined) {
      return this.reply(ctx, renderDriveSummaryOutOfRange(index, files.length, language), 'RESPONDED', language, 'not-read');
    }
    if (file.kind !== undefined && !isDriveTextExportable(file.kind)) {
      this.log('info', 'drive.turn_handler.not_text', { kind: file.kind });
      return this.reply(ctx, renderDriveSummaryNotText(file.kind, language), 'RESPONDED', language, 'not-read');
    }

    let document: DriveDocument;
    try {
      document = await this.withTimeout(this.deps.reader.exportText(file.id));
    } catch (error) {
      const failure = failureOf(error);
      this.log('warn', 'drive.turn_handler.read_failed', { kind: 'summarize', reason: failure });
      // The adapter re-checks the kind at export time; a file that changed kind since the listing is not text.
      if (failure === 'UNSUPPORTED_QUERY') {
        return this.reply(ctx, renderDriveSummaryNotText('other', language), 'RESPONDED', language, 'not-read');
      }
      return this.reply(ctx, renderDriveReadFailure(failure, language, this.deps.copy), 'FAILED', language, 'not-read');
    }
    const built = buildUntrustedDocumentReadout({
      source: 'drive',
      title: document.name,
      author: document.ownerName,
      date: document.modifiedAt,
      body: document.text,
      sourceTruncated: document.textTruncated,
    });
    if (!built.ok) {
      this.log('info', 'drive.turn_handler.summary_refused', { refusal: built.refusal });
      return this.reply(ctx, renderDriveSummaryRefused(built.refusal, language), 'RESPONDED', language, 'not-summarized');
    }
    this.log('info', 'drive.turn_handler.summarize', { truncated: built.readout.truncated });
    return {
      kind: 'summarize',
      readout: built.readout,
      fallbackText: renderDriveSummaryUnavailable(language),
      footer: renderDriveSummaryFooter(language),
    };
  }

  private rememberListing(ctx: TurnHandlerContext, files: RecentListing['files']): void {
    const key = listingKey(ctx.session.id, ctx.actor.id);
    this.recentListings.delete(key);
    this.recentListings.set(key, { at: ctx.now, sessionId: ctx.session.id, actorId: ctx.actor.id, files: [...files] });
    while (this.recentListings.size > DRIVE_RECENT_LISTINGS_MAX) {
      const oldest = this.recentListings.keys().next().value;
      if (oldest === undefined) break;
      this.recentListings.delete(oldest);
    }
  }

  /** Best-effort: a failed write leaves the in-memory cache as the only copy (never fails the turn). */
  private async persistShown(ctx: TurnHandlerContext, fileIds: readonly string[]): Promise<void> {
    if (this.deps.sessions === undefined) return;
    try {
      await persistListing(this.deps.sessions, ctx.session.id, ctx.actor.id, 'drive', fileIds, ctx.now);
    } catch {
      this.log('warn', 'drive.turn_handler.listing_persist_failed', {});
    }
  }

  /** This (session, actor)'s last Drive list within the TTL (the newer of the persisted record and the cache), or `undefined`. */
  private currentListing(ctx: TurnHandlerContext): RecentListing | undefined {
    const cached = this.cachedListing(ctx);
    const persisted = readPersistedListing(ctx.session, ctx.actor.id, 'drive', ctx.now);
    if (persisted !== undefined && (cached === undefined || Date.parse(persisted.at) > Date.parse(cached.at))) {
      return { at: persisted.at, sessionId: ctx.session.id, actorId: ctx.actor.id, files: persisted.ids.map((id) => ({ id })) };
    }
    return cached;
  }

  private cachedListing(ctx: TurnHandlerContext): RecentListing | undefined {
    const key = listingKey(ctx.session.id, ctx.actor.id);
    const listing = this.recentListings.get(key);
    if (!listing || listing.sessionId !== ctx.session.id || listing.actorId !== ctx.actor.id) return undefined;
    const age = Date.parse(ctx.now) - Date.parse(listing.at);
    if (!Number.isFinite(age) || age < 0 || age >= DRIVE_RECENT_LISTING_TTL_MS) {
      this.recentListings.delete(key);
      return undefined;
    }
    return listing;
  }

  private reply(
    ctx: TurnHandlerContext,
    text: MessageBody,
    status: 'RESPONDED' | 'FAILED',
    language: DriveLanguage,
    history: DriveHistoryKind,
  ): TurnHandlerReply {
    return {
      reply: outboundMessage(ctx.message.context, text, { replyToMessageId: ctx.message.id }),
      status,
      history: { assistant: renderDriveHistoryNote(language, history) },
    };
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DriveReadTimeout()), this.deps.timeoutMs ?? DRIVE_READ_TIMEOUT_MS);
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

function failureOf(error: unknown): DriveReadFailure {
  if (error instanceof DriveReadTimeout) return 'TIMEOUT';
  return isConnectorQueryError(error) ? error.reason : 'UNAVAILABLE';
}

function listingKey(sessionId: Id, actorId: Id): string {
  return JSON.stringify([sessionId, actorId]);
}

/** Factory for the composition root (ADR-0096 D7). */
export function createDriveTurnHandler(deps: DriveTurnHandlerDeps): DriveTurnHandler {
  return new DriveTurnHandler(deps);
}

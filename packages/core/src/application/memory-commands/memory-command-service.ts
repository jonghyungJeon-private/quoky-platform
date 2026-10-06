import { createHash } from 'node:crypto';
import type {
  DurableMemoryAuthorityLevel,
  DurableMemoryKind,
  DurableMemoryProvenance,
  Id,
  IsoTimestamp,
  MemoryRecord,
} from '../../domain';
import { isArchivedMemory, MEMORY_ARCHIVE_EXPIRES_AT_KEY, MEMORY_ARCHIVED_AT_KEY, MemoryType } from '../../domain';
import type { DurableMemoryQuery, Logger } from '../../ports';
import { containsCredentialFileContent, CREDENTIAL_REJECTION_REASON } from '../credential-guard';
import {
  durableScopeOfRecord,
  isCredentialLikeMemoryText,
  MAX_DURABLE_CONTENT_CHARACTERS,
  type MemoryWriter,
} from '../memory-writer';
import type { MemoryCommand, MemoryCommandLanguage } from './memory-command-grammar';
import {
  MEMORY_CONFIRM_PREVIEW_MAX_CHARS,
  MEMORY_LIST_PAGE_SIZE,
  maskedMemoryText,
  memoryBody,
  memoryPreview,
  renderBulkForgetRefused,
  renderConfirmStale,
  renderConfirmUnknown,
  renderConfirmUsage,
  renderEditConfirmation,
  renderEditDuplicate,
  renderEditFailed,
  renderEdited,
  renderEditSensitiveRefused,
  renderEditTooLong,
  renderEditUnchanged,
  renderEditUsage,
  renderForgetConfirmation,
  renderForgetIncomplete,
  renderForgotten,
  renderEditRequestHistory,
  renderMemoryCommandFailed,
  renderMemoryCommandHistoryReply,
  renderMemoryList,
  renderMemoryListEmpty,
  renderMemoryNotFound,
  renderMemoryPageOutOfRange,
  renderMemoryStatusLatest,
  renderMemoryStatusNone,
  renderMemoryView,
  renderArchivedMemoryNotFound,
  renderMemoryArchive,
  renderMemoryArchiveEmpty,
  renderMemoryArchivePageOutOfRange,
  renderPurgeConfirmation,
  renderPurged,
  renderPurgeIncomplete,
  renderRestoreConfirmation,
  renderRestored,
  renderRestoreIncomplete,
  type MemoryCommandHistoryNoteOutcome,
} from './memory-command-renderer';
import type { MemoryRemovalCascade, SessionHistoryClearer } from './memory-removal-cascade';

/** ADR-0106 D4: the confirmation window; a code is accepted in the window it was issued in and the next one. */
export const MEMORY_CONFIRMATION_WINDOW_MS = 30 * 60 * 1_000;
/** Codes use an unambiguous alphabet (no I, L, O, 0, 1): 32 symbols, 5 bits each. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
/** Upper bound on the owner's records read for one command (a personal store holds far fewer). */
export const MEMORY_COMMAND_MAX_RECORDS = 2_000;
/** The edit cascade is tried this many times in total (one retry) before the reply notes the pending cleanup. */
const EDIT_CASCADE_ATTEMPTS = 2;
/** Pending confirmations kept per actor; the oldest are dropped first. */
const MAX_PENDING_PER_ACTOR = 10;
/** ADR-0106 amendment: `QUOKY_MEMORY_ARCHIVE_DAYS` default, and its bounds (0 = no archive, delete at once). */
export const DEFAULT_MEMORY_ARCHIVE_DAYS = 7;
export const MIN_MEMORY_ARCHIVE_DAYS = 0;
export const MAX_MEMORY_ARCHIVE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Rows read per expiry-purge batch (the purge repeats until a batch comes back short). */
const ARCHIVE_PURGE_BATCH = 500;

/** The store side the commands need — structurally the storage provider's memory repository. */
export interface MemoryCommandRecordSource {
  get(id: Id): Promise<MemoryRecord | null>;
  findDurableCandidates(query: DurableMemoryQuery): Promise<MemoryRecord[]>;
  /** ADR-0106 amendment: archive and restore set/clear the archive keys of an existing record in place. */
  save(record: MemoryRecord): Promise<MemoryRecord>;
}

/** What one expiry purge did (content-free; for the daily-maintenance log line). */
export interface MemoryArchivePurgeResult {
  readonly purged: number;
  readonly failed: number;
}

export interface MemoryCommandServiceDeps {
  readonly records: MemoryCommandRecordSource;
  /** Every write goes through the ADR-0073 writer policy (exact-scope forget, superseding promotion). */
  readonly writer: Pick<MemoryWriter, 'createCandidate' | 'promote' | 'forget'>;
  /** Derived-data cleanup on forget/edit (ADR-0106 D5): the vector cache today, LRN-1's learning items later. */
  readonly cascades?: readonly MemoryRemovalCascade[];
  /**
   * ADR-0106 amendment: days a forgotten memory stays in the archive (`QUOKY_MEMORY_ARCHIVE_DAYS`, integer 0–365,
   * default 7). `0` = no archive: a confirmed forget deletes permanently at once.
   */
  readonly archiveDays?: number;
  /** ADR-0106 amendment D5: clears the actor's history of the session a forget/edit is confirmed in. */
  readonly sessionHistory?: SessionHistoryClearer;
  readonly logger?: Logger;
}

export interface MemoryCommandRequest {
  readonly actorId: Id;
  /** The turn's shared clock reading. */
  readonly now: IsoTimestamp;
  /** The raw inbound text (kept as the edit's `sourceContent`; never logged). */
  readonly sourceText?: string;
  /** The turn's session: a confirmed forget/edit clears the actor's short-term history of it (amendment D5). */
  readonly sessionId?: Id;
}

export type MemoryCommandOutcome =
  | 'listed'
  | 'list-empty'
  | 'page-out-of-range'
  | 'viewed'
  | 'not-found'
  | 'forget-confirmation'
  | 'edit-confirmation'
  | 'edit-unchanged'
  | 'edit-sensitive'
  | 'edit-too-long'
  | 'forgotten'
  | 'forget-incomplete'
  | 'edited'
  | 'edit-duplicate'
  | 'edit-rejected'
  | 'confirm-unknown'
  | 'confirm-stale'
  | 'bulk-refused'
  | 'usage'
  | 'status'
  | 'archive-listed'
  | 'archive-empty'
  | 'archive-page-out-of-range'
  | 'archive-not-found'
  | 'restore-confirmation'
  | 'purge-confirmation'
  | 'restored'
  | 'restore-incomplete'
  | 'purged'
  | 'purge-incomplete'
  | 'failed';

export interface MemoryCommandResult {
  readonly outcome: MemoryCommandOutcome;
  readonly text: string;
  readonly status: 'RESPONDED' | 'FAILED';
  /**
   * W2-L01: what the SHORT_TERM conversation history keeps for this turn instead of the verbatim texts — set for edit
   * requests (`user`) and for the edit/forget replies that echo memory text (`assistant`). Omitted = verbatim.
   */
  readonly history?: MemoryCommandHistory;
}

export interface MemoryCommandHistory {
  readonly user?: string;
  readonly assistant?: string;
}

type PendingAction =
  | { readonly kind: 'forget' }
  | { readonly kind: 'restore' }
  | { readonly kind: 'purge' }
  | { readonly kind: 'edit'; readonly text: string; readonly sourceText: string };

type ConfirmationAction = 'forget' | 'restore' | 'purge' | { readonly edit: string };

function confirmationActionOf(action: PendingAction): ConfirmationAction {
  return action.kind === 'edit' ? { edit: action.text } : action.kind;
}

interface PendingConfirmation {
  readonly code: string;
  readonly recordId: Id;
  readonly window: number;
  readonly action: PendingAction;
  /** The record's archive generation when the code was issued (its `archivedAt`; absent for a live record). */
  readonly generation?: string;
  /** Disambiguates a re-issue whose code was already spent for the same record and generation. */
  readonly nonce: number;
}

/** A spent code, remembered per actor for the windows it could still be accepted in. */
interface ConsumedConfirmation {
  readonly code: string;
  readonly recordId: Id;
  readonly window: number;
}

/** Re-issue attempts before giving up on finding an unspent code (practically never more than one). */
const MAX_CODE_NONCE = 16;

/**
 * The strict credential guard (ADR-0107 D1, as the learning store uses it): the writer's predicate (chat-text
 * detector plus the secret-assignment pattern) and the stricter file-content detector. Credential-like record text
 * is never archived and never shown (ADR-0106 amendment D4).
 */
export function isStrictCredentialMemoryText(text: string): boolean {
  return isCredentialLikeMemoryText(text) || containsCredentialFileContent(text);
}

/** The archive generation of a record: its `archivedAt` while archived, `undefined` while live. */
function archiveGenerationOf(record: MemoryRecord): string | undefined {
  return metadataText(record, MEMORY_ARCHIVED_AT_KEY);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The confirmation window index of a timestamp. */
export function memoryConfirmationWindow(now: IsoTimestamp): number {
  const ms = Date.parse(now);
  if (Number.isNaN(ms)) throw new RangeError('now must be an ISO-8601 timestamp');
  return Math.floor(ms / MEMORY_CONFIRMATION_WINDOW_MS);
}

/**
 * ADR-0106 D4: a 4-character code from SHA-256 of (record id, content hash, proposed new text or the action name —
 * `forget`, and with the amendment `restore` / `purge` — window). A changed record, a different proposal or action,
 * or another window gives a different code.
 */
export function deriveMemoryConfirmationCode(input: {
  readonly recordId: Id;
  readonly content: string;
  readonly action: ConfirmationAction;
  readonly window: number;
  /** ADR-0106 amendment: the archive generation (`archivedAt`) the code is bound to; absent for a live record. */
  readonly generation?: string;
  /** A re-issue counter, so a code spent for this record and generation is never handed out again. */
  readonly nonce?: number;
}): string {
  const actionKey = typeof input.action === 'string' ? input.action : `edit:${sha256(input.action.edit)}`;
  const parts: unknown[] = ['quoky.memory-command.v1', input.recordId, sha256(input.content), actionKey, input.window];
  // Appended only when present, so a live record's first code is unchanged from ADR-0106 D4.
  if (input.generation !== undefined || (input.nonce ?? 0) > 0) parts.push(input.generation ?? null, input.nonce ?? 0);
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest();
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[(digest[i] ?? 0) % CODE_ALPHABET.length];
  return code;
}

function metadataText(record: MemoryRecord, key: string): string | undefined {
  const value = record.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizedForCompare(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

/**
 * ADR-0106 D3: a record the owner's durable recall can return — the actor's own `LONG_TERM` record with no
 * channel/thread/task scope, not expired at `nowMs`, not superseded.
 */
export function isListableMemory(record: MemoryRecord, actorId: Id, nowMs: number): boolean {
  if (record.type !== MemoryType.LONG_TERM || record.scope.userId !== actorId) return false;
  if (durableScopeOfRecord(record) === null) return false;
  if (metadataText(record, 'supersededBy') !== undefined) return false;
  if (isArchivedMemory(record)) return false;
  const expiresAt = metadataText(record, 'expiresAt');
  if (expiresAt !== undefined) {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresMs) || expiresMs < nowMs) return false;
  }
  return true;
}

/** When an archived record is due for permanent deletion (epoch ms); `NaN` when the record carries no valid expiry. */
export function archiveExpiryMs(record: MemoryRecord): number {
  const value = metadataText(record, MEMORY_ARCHIVE_EXPIRES_AT_KEY);
  return value === undefined ? Number.NaN : Date.parse(value);
}

/**
 * ADR-0106 amendment: a record the owner's archive view shows — the actor's own archived `LONG_TERM` head record
 * (not superseded; its earlier versions travel with it) with a durable write scope and an expiry still ahead.
 */
export function isArchiveListableMemory(record: MemoryRecord, actorId: Id, nowMs: number): boolean {
  if (record.type !== MemoryType.LONG_TERM || record.scope.userId !== actorId) return false;
  if (durableScopeOfRecord(record) === null) return false;
  if (metadataText(record, 'supersededBy') !== undefined) return false;
  if (!isArchivedMemory(record)) return false;
  const expiresMs = archiveExpiryMs(record);
  return !Number.isNaN(expiresMs) && expiresMs > nowMs;
}

function byArchiveTime(a: MemoryRecord, b: MemoryRecord): number {
  const at = metadataText(a, MEMORY_ARCHIVED_AT_KEY) ?? '';
  const bt = metadataText(b, MEMORY_ARCHIVED_AT_KEY) ?? '';
  return at < bt ? -1 : at > bt ? 1 : byCreation(a, b);
}

/** A copy of `record` without the archive keys (restore). */
function withoutArchive(record: MemoryRecord): MemoryRecord {
  const metadata = { ...(record.metadata ?? {}) };
  delete metadata[MEMORY_ARCHIVED_AT_KEY];
  delete metadata[MEMORY_ARCHIVE_EXPIRES_AT_KEY];
  return { ...record, metadata };
}

function byCreation(a: MemoryRecord, b: MemoryRecord): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * ADR-0106 memory management: list, view, edit and forget the owner's durable memories. Actor-scoped (only the
 * requesting actor's records are ever read, counted or changed), deterministic and provider-free. Numbers are
 * computed per command by `createdAt` ascending (no session state, D3). Edit and forget answer with a preview and
 * a content-bound one-time code (D4); only `기억 확인 <code>` executes, after re-checking that the record still
 * exists unchanged. Pending confirmations live in memory only: a restart forgets them (the owner asks again).
 */
export class MemoryCommandService {
  private readonly pending = new Map<Id, PendingConfirmation[]>();
  /** Spent codes per actor (still inside an accepting window), so a re-issue never hands one out again. */
  private readonly consumed = new Map<Id, ConsumedConfirmation[]>();
  private readonly cascades: readonly MemoryRemovalCascade[];
  readonly archiveDays: number;

  constructor(private readonly deps: MemoryCommandServiceDeps) {
    this.cascades = deps.cascades ?? [];
    const days = deps.archiveDays ?? DEFAULT_MEMORY_ARCHIVE_DAYS;
    if (!Number.isInteger(days) || days < MIN_MEMORY_ARCHIVE_DAYS || days > MAX_MEMORY_ARCHIVE_DAYS) {
      throw new RangeError(`archiveDays must be an integer from ${MIN_MEMORY_ARCHIVE_DAYS} to ${MAX_MEMORY_ARCHIVE_DAYS}`);
    }
    this.archiveDays = days;
  }

  /** Run one parsed command. Never throws: a store failure becomes a `failed` reply. */
  async execute(command: MemoryCommand, request: MemoryCommandRequest): Promise<MemoryCommandResult> {
    const result = await this.run(command, request);
    const history = memoryCommandHistory(command, result.outcome);
    return history === undefined ? result : { ...result, history };
  }

  private async run(command: MemoryCommand, request: MemoryCommandRequest): Promise<MemoryCommandResult> {
    const language = command.language;
    try {
      switch (command.kind) {
        case 'list':
          return await this.list(request, command.page, language);
        case 'view':
          return await this.view(request, command.number, language);
        case 'forget':
          return await this.requestForget(request, command.number, language);
        case 'edit':
          return await this.requestEdit(request, command.number, command.text, language);
        case 'confirm':
          return await this.confirm(request, command.code, language);
        case 'bulk-forget':
          return this.reply('bulk-refused', renderBulkForgetRefused(language));
        case 'status':
          return await this.status(request, language);
        case 'archive-list':
          return await this.archiveList(request, command.page, language);
        case 'restore':
          return await this.requestArchiveAction(request, command.number, 'restore', language);
        case 'purge':
          return await this.requestArchiveAction(request, command.number, 'purge', language);
        case 'usage':
          return this.reply(
            'usage',
            command.usage === 'edit' ? renderEditUsage(command.number, language) : renderConfirmUsage(language),
          );
      }
    } catch (error) {
      this.log('warn', 'memory_commands.failed', { command: command.kind, errorName: errorName(error) });
      return { outcome: 'failed', text: renderMemoryCommandFailed(language), status: 'FAILED' };
    }
  }

  /** The owner's listable memories, numbered from 1 by creation time. */
  async listable(actorId: Id, now: IsoTimestamp): Promise<readonly MemoryRecord[]> {
    const nowMs = Date.parse(now);
    const records = await this.deps.records.findDurableCandidates({
      scope: { userId: actorId },
      limit: MEMORY_COMMAND_MAX_RECORDS,
      excludeExpired: true,
      excludeSuperseded: true,
      archived: 'exclude',
    });
    return records.filter((record) => isListableMemory(record, actorId, nowMs)).sort(byCreation);
  }

  /** ADR-0106 amendment: the owner's archived memories, numbered from 1 by archive time (separately from the list). */
  async archived(actorId: Id, now: IsoTimestamp): Promise<readonly MemoryRecord[]> {
    const nowMs = Date.parse(now);
    const records = await this.deps.records.findDurableCandidates({
      scope: { userId: actorId },
      limit: MEMORY_COMMAND_MAX_RECORDS,
      excludeSuperseded: true,
      archived: 'only',
    });
    return records.filter((record) => isArchiveListableMemory(record, actorId, nowMs)).sort(byArchiveTime);
  }

  /**
   * ADR-0106 amendment D2: permanently delete every archived record whose archive expiry is at or before `now`, for
   * every actor (the daily maintenance and the startup run). Content-free: logs and returns counts only. Never throws.
   */
  async purgeExpiredArchive(now: IsoTimestamp): Promise<MemoryArchivePurgeResult> {
    let purged = 0;
    let failed = 0;
    const skipped = new Set<Id>();
    try {
      for (;;) {
        const batch = await this.deps.records.findDurableCandidates({
          scope: {},
          limit: ARCHIVE_PURGE_BATCH,
          archived: 'only',
          archiveExpiredBy: now,
          ...(skipped.size > 0 ? { excludeIds: [...skipped] } : {}),
        });
        let progressed = false;
        for (const record of batch) {
          if (!isArchivedMemory(record) || !(archiveExpiryMs(record) <= Date.parse(now))) {
            skipped.add(record.id);
            continue;
          }
          const scope = durableScopeOfRecord(record);
          if (scope === null) {
            skipped.add(record.id);
            failed += 1;
            continue;
          }
          try {
            // Conditional delete: re-read right before deleting and abort when the record is no longer the same expired
            // archive entry (a restore admitted just before expiry wins). Residual R1: no compare-and-set in the store,
            // so a restore landing between this read and the writer's own read-then-delete remains a one-await window.
            const current = await this.deps.records.get(record.id);
            if (
              current === null ||
              !isArchivedMemory(current) ||
              archiveGenerationOf(current) !== archiveGenerationOf(record) ||
              !(archiveExpiryMs(current) <= Date.parse(now))
            ) {
              skipped.add(record.id);
              continue;
            }
            const result = await this.deps.writer.forget({ memoryId: record.id, scope });
            if (result.outcome === 'REJECTED') {
              skipped.add(record.id);
              failed += 1;
            } else {
              purged += 1;
              progressed = true;
              this.dropPendingFor(new Set([record.id]));
            }
          } catch {
            skipped.add(record.id);
            failed += 1;
          }
        }
        if (batch.length < ARCHIVE_PURGE_BATCH || !progressed) break;
      }
    } catch (error) {
      this.log('warn', 'memory_archive.purge.failed', { purged, errorName: errorName(error) });
      return { purged, failed: failed + 1 };
    }
    this.log('info', 'memory_archive.purge.done', { purged, failed });
    return { purged, failed };
  }

  private async list(request: MemoryCommandRequest, page: number, language: MemoryCommandLanguage) {
    const records = await this.listable(request.actorId, request.now);
    if (records.length === 0) return this.reply('list-empty', renderMemoryListEmpty(language));
    const pages = Math.ceil(records.length / MEMORY_LIST_PAGE_SIZE);
    if (page > pages) return this.reply('page-out-of-range', renderMemoryPageOutOfRange(pages, language));
    const start = (page - 1) * MEMORY_LIST_PAGE_SIZE;
    const rows = records.slice(start, start + MEMORY_LIST_PAGE_SIZE).map((record, index) => ({
      number: start + index + 1,
      preview: this.previewOf(record.content, language),
    }));
    return this.reply('listed', renderMemoryList({ page, pages, total: records.length, rows }, language));
  }

  private async view(request: MemoryCommandRequest, number: number, language: MemoryCommandLanguage) {
    const records = await this.listable(request.actorId, request.now);
    const record = records[number - 1];
    if (record === undefined) {
      return this.reply('not-found', renderMemoryNotFound(number, records.length, language));
    }
    const body = isStrictCredentialMemoryText(record.content) ? maskedMemoryText(language) : memoryBody(record.content);
    return this.reply('viewed', renderMemoryView(number, body, language));
  }

  private async status(request: MemoryCommandRequest, language: MemoryCommandLanguage) {
    const records = await this.listable(request.actorId, request.now);
    const latest = records.at(-1);
    if (latest === undefined) return this.reply('status', renderMemoryStatusNone(language));
    return this.reply('status', renderMemoryStatusLatest(this.previewOf(latest.content, language), records.length, language));
  }

  private async archiveList(request: MemoryCommandRequest, page: number, language: MemoryCommandLanguage) {
    const records = await this.archived(request.actorId, request.now);
    if (records.length === 0) return this.reply('archive-empty', renderMemoryArchiveEmpty(this.archiveDays, language));
    const pages = Math.ceil(records.length / MEMORY_LIST_PAGE_SIZE);
    if (page > pages) {
      return this.reply('archive-page-out-of-range', renderMemoryArchivePageOutOfRange(pages, language));
    }
    const nowMs = Date.parse(request.now);
    const start = (page - 1) * MEMORY_LIST_PAGE_SIZE;
    const rows = records.slice(start, start + MEMORY_LIST_PAGE_SIZE).map((record, index) => ({
      number: start + index + 1,
      preview: this.previewOf(record.content, language),
      daysLeft: Math.max(1, Math.ceil((archiveExpiryMs(record) - nowMs) / DAY_MS)),
    }));
    return this.reply('archive-listed', renderMemoryArchive({ page, pages, total: records.length, rows }, language));
  }

  private async requestArchiveAction(
    request: MemoryCommandRequest,
    number: number,
    kind: 'restore' | 'purge',
    language: MemoryCommandLanguage,
  ) {
    const records = await this.archived(request.actorId, request.now);
    if (records.length === 0) return this.reply('archive-empty', renderMemoryArchiveEmpty(this.archiveDays, language));
    const record = records[number - 1];
    if (record === undefined) {
      return this.reply(
        'archive-not-found',
        renderArchivedMemoryNotFound(number, records.length, this.archiveDays, language),
      );
    }
    const code = this.issue(request, record, { kind });
    const preview = this.previewOf(record.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS);
    return kind === 'restore'
      ? this.reply('restore-confirmation', renderRestoreConfirmation(number, preview, code, language))
      : this.reply('purge-confirmation', renderPurgeConfirmation(number, preview, code, language));
  }

  private async requestForget(request: MemoryCommandRequest, number: number, language: MemoryCommandLanguage) {
    const records = await this.listable(request.actorId, request.now);
    const record = records[number - 1];
    if (record === undefined) {
      return this.reply('not-found', renderMemoryNotFound(number, records.length, language));
    }
    const code = this.issue(request, record, { kind: 'forget' });
    const preview = this.previewOf(record.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS);
    return this.reply('forget-confirmation', renderForgetConfirmation(number, preview, code, language));
  }

  private async requestEdit(
    request: MemoryCommandRequest,
    number: number,
    text: string,
    language: MemoryCommandLanguage,
  ) {
    const next = text.trim();
    // Refused before any lookup: a credential-shaped edit never produces a code (ADR-0106 acceptance).
    if (isCredentialLikeMemoryText(next) || isCredentialLikeMemoryText(request.sourceText ?? '')) {
      return this.reply('edit-sensitive', renderEditSensitiveRefused(language));
    }
    if (next.length > MAX_DURABLE_CONTENT_CHARACTERS) {
      return this.reply('edit-too-long', renderEditTooLong(MAX_DURABLE_CONTENT_CHARACTERS, language));
    }
    const records = await this.listable(request.actorId, request.now);
    const record = records[number - 1];
    if (record === undefined) {
      return this.reply('not-found', renderMemoryNotFound(number, records.length, language));
    }
    if (normalizedForCompare(record.content) === normalizedForCompare(next)) {
      return this.reply('edit-unchanged', renderEditUnchanged(language));
    }
    const code = this.issue(request, record, { kind: 'edit', text: next, sourceText: request.sourceText ?? next });
    return this.reply(
      'edit-confirmation',
      renderEditConfirmation(
        number,
        this.previewOf(record.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS),
        memoryPreview(next, MEMORY_CONFIRM_PREVIEW_MAX_CHARS),
        code,
        language,
      ),
    );
  }

  private async confirm(request: MemoryCommandRequest, rawCode: string, language: MemoryCommandLanguage) {
    const code = rawCode.toUpperCase();
    const window = memoryConfirmationWindow(request.now);
    const entries = this.livePending(request.actorId, window);
    const entry = code.length === CODE_LENGTH ? entries.find((candidate) => candidate.code === code) : undefined;
    if (entry === undefined) return this.reply('confirm-unknown', renderConfirmUnknown(language));
    // One-time: the code is spent whatever happens next, and remembered as spent for this record.
    this.setPending(
      request.actorId,
      entries.filter((candidate) => candidate !== entry),
    );
    this.liveConsumed(request.actorId, window).push({ code: entry.code, recordId: entry.recordId, window: entry.window });

    const record = await this.deps.records.get(entry.recordId);
    const nowMs = Date.parse(request.now);
    const onArchive = entry.action.kind === 'restore' || entry.action.kind === 'purge';
    const eligible =
      record !== null &&
      (onArchive
        ? isArchiveListableMemory(record, request.actorId, nowMs)
        : isListableMemory(record, request.actorId, nowMs));
    const unchanged =
      record !== null &&
      eligible &&
      archiveGenerationOf(record) === entry.generation &&
      deriveMemoryConfirmationCode({
        recordId: record.id,
        content: record.content,
        action: confirmationActionOf(entry.action),
        window: entry.window,
        ...(entry.generation === undefined ? {} : { generation: entry.generation }),
        nonce: entry.nonce,
      }) === entry.code;
    if (!unchanged || record === null) {
      return this.reply('confirm-stale', renderConfirmStale(language, onArchive ? 'archive' : 'list'));
    }

    let result: MemoryCommandResult;
    switch (entry.action.kind) {
      case 'forget':
        result = await this.executeForget(request, record, language);
        break;
      case 'edit':
        result = await this.executeEdit(request, record, entry.action, language);
        break;
      case 'restore':
        result = await this.executeRestore(request.actorId, record, language);
        break;
      case 'purge':
        result = await this.executePurge(request.actorId, record, language);
        break;
    }
    // Any executed state change (even a partial one) ends every outstanding code for the record and its chain: a
    // code issued before the change can never act on the record's next state (e.g. a permanent-delete code issued
    // before a restore can never delete a later archive of the same record).
    this.dropPendingFor(new Set([record.id, ...(await this.earlierVersionIds(request.actorId, record))]));
    return result;
  }

  /**
   * ADR-0106 D5 forget (with the amendment's archive), ordered so that it is always retryable and never leaves
   * unreachable text (the memory store has no multi-record transaction):
   *  1. the cascades run first (vector cache, learning items, history copies), then the actor's history of the
   *     current session is cleared, so derived data never outlives the memory's use;
   *  2. the earlier (superseded) versions are archived — or deleted, see below — oldest first, each before the version
   *     that superseded it;
   *  3. the current, listable record is archived (or deleted) last.
   * Archive (default, `archiveDays` > 0) sets `archivedAt`/`archiveExpiresAt` in place; the daily maintenance deletes
   * it at expiry. With `archiveDays` 0, or when any version's text is credential-like (never archived), every record
   * is deleted permanently through `MemoryWriter.forget` instead. If any step fails, the current record is still
   * listable, so asking again (a fresh `기억 N 잊어줘`) finishes the chain. The reply says only what happened.
   */
  private async executeForget(request: MemoryCommandRequest, record: MemoryRecord, language: MemoryCommandLanguage) {
    const actorId = request.actorId;
    // `include`: a version archived by an earlier, interrupted forget still belongs to the chain (archiving it again is
    // a no-op; the permanent-delete path deletes it), so the chain walk never stops at it.
    const history = await this.earlierVersions(actorId, record);
    // The strict guard over the whole version chain: one credential-like version keeps the chain out of the archive.
    const sensitive = [record, ...history].some((version) => isStrictCredentialMemoryText(version.content));
    const archive = this.archiveDays > 0 && !sensitive;
    const mode = archive ? 'archived' : 'deleted';
    const incomplete = (removedVersions: number, current: 'kept' | 'unknown') => ({
      outcome: 'forget-incomplete' as const,
      text: renderForgetIncomplete(removedVersions, current, language, mode),
      status: 'FAILED' as const,
    });
    let sessionCleared: boolean;
    try {
      await this.runCascades({ actorId, reason: 'forget', records: [record, ...history] });
      sessionCleared = await this.clearSessionHistory(request);
    } catch (error) {
      this.log('warn', 'memory_commands.forget.cascade_failed', { errorName: errorName(error) });
      return incomplete(0, 'kept');
    }
    const expiresAt = new Date(Date.parse(request.now) + this.archiveDays * DAY_MS).toISOString();
    const removeOne = (target: MemoryRecord) =>
      archive ? this.archiveOne(actorId, target, request.now, expiresAt) : this.forgetOne(actorId, target);
    // `earlierVersions` lists the chain nearest first; reversed, every record precedes its successor.
    let removedVersions = 0;
    for (const target of [...history].reverse()) {
      if (!(await removeOne(target))) {
        this.log('warn', 'memory_commands.forget.incomplete', { removedVersions, remainingVersions: history.length - removedVersions });
        return incomplete(removedVersions, 'kept');
      }
      removedVersions += 1;
    }
    if (!(await removeOne(record))) {
      this.log('warn', 'memory_commands.forget.incomplete', { removedVersions, remainingVersions: 0 });
      return incomplete(removedVersions, archive ? 'kept' : 'unknown');
    }
    this.log('info', archive ? 'memory_commands.archived' : 'memory_commands.forgotten', {
      removed: removedVersions + 1,
      sensitive: sensitive ? 1 : 0,
    });
    return this.reply(
      'forgotten',
      renderForgotten(this.previewOf(record.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), removedVersions, language, {
        mode: archive ? 'archived' : sensitive ? 'deleted-sensitive' : 'deleted',
        archiveDays: this.archiveDays,
        sessionCleared,
      }),
    );
  }

  /** Archive one record of the owner's chain in place; `true` when it is archived. Never throws. */
  private async archiveOne(actorId: Id, target: MemoryRecord, now: IsoTimestamp, expiresAt: IsoTimestamp): Promise<boolean> {
    if (target.type !== MemoryType.LONG_TERM || target.scope.userId !== actorId) return false;
    if (durableScopeOfRecord(target) === null) return false;
    if (isArchivedMemory(target)) return true;
    try {
      await this.deps.records.save({
        ...target,
        metadata: { ...(target.metadata ?? {}), [MEMORY_ARCHIVED_AT_KEY]: now, [MEMORY_ARCHIVE_EXPIRES_AT_KEY]: expiresAt },
      });
      return true;
    } catch (error) {
      this.log('warn', 'memory_commands.archive.save_failed', { errorName: errorName(error) });
      return false;
    }
  }

  /**
   * ADR-0106 amendment D3 restore: the archive keys are removed from the earlier versions first (they stay superseded,
   * so never listed or recalled), then from the archived record, which is then listed and recalled again — the
   * semantic recall re-embeds it into the vector cache on the next recall that sees it (the cache-miss path). If a
   * step fails, the record itself is still in the archive and asking again finishes the job.
   */
  private async executeRestore(actorId: Id, record: MemoryRecord, language: MemoryCommandLanguage) {
    const versions = (await this.earlierVersions(actorId, record)).filter((version) => isArchivedMemory(version));
    const generation = archiveGenerationOf(record);
    try {
      for (const target of [...versions.reverse(), record]) {
        // Re-read right before each write: a record the expiry purge deleted (or that changed) is never re-created by
        // the restore's upsert. Residual R1: the store has no compare-and-set, so a delete landing between this read
        // and the write below can still be undone by it (single process, one await apart).
        const current = await this.deps.records.get(target.id);
        if (current === null || archiveGenerationOf(current) !== archiveGenerationOf(target)) {
          throw new MemoryArchiveStateChangedError();
        }
        await this.deps.records.save(withoutArchive(current));
      }
      if (generation === undefined) throw new MemoryArchiveStateChangedError();
    } catch (error) {
      this.log('warn', 'memory_commands.restore.failed', { errorName: errorName(error) });
      return { outcome: 'restore-incomplete' as const, text: renderRestoreIncomplete(language), status: 'FAILED' as const };
    }
    this.log('info', 'memory_commands.restored', { restored: versions.length + 1 });
    return this.reply('restored', renderRestored(this.previewOf(record.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), language));
  }

  /**
   * ADR-0106 amendment D3 permanent delete from the archive, immediate: the earlier versions (archived or not) oldest
   * first, then the archived record, through `MemoryWriter.forget`. Its derived data was already removed at archive.
   */
  private async executePurge(actorId: Id, record: MemoryRecord, language: MemoryCommandLanguage) {
    const versions = await this.earlierVersions(actorId, record);
    let removedVersions = 0;
    for (const target of [...versions].reverse()) {
      if (!(await this.forgetOne(actorId, target))) {
        return { outcome: 'purge-incomplete' as const, text: renderPurgeIncomplete(language), status: 'FAILED' as const };
      }
      removedVersions += 1;
    }
    if (!(await this.forgetOne(actorId, record))) {
      return { outcome: 'purge-incomplete' as const, text: renderPurgeIncomplete(language), status: 'FAILED' as const };
    }
    this.log('info', 'memory_commands.purged', { removed: removedVersions + 1 });
    return this.reply(
      'purged',
      renderPurged(this.previewOf(record.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), removedVersions, language),
    );
  }

  /** Clears the actor's history of the request's session; `true` when it ran. A failure propagates (retryable). */
  private async clearSessionHistory(request: MemoryCommandRequest): Promise<boolean> {
    if (this.deps.sessionHistory === undefined || request.sessionId === undefined) return false;
    try {
      await this.deps.sessionHistory.clearSession(request.actorId, request.sessionId);
    } catch (error) {
      this.log('warn', 'memory_commands.session_history.failed', { errorName: errorName(error) });
      throw error;
    }
    return true;
  }

  /** Delete one record of the owner's chain; `true` when it is gone (already-absent counts as gone). Never throws. */
  private async forgetOne(actorId: Id, target: MemoryRecord): Promise<boolean> {
    const scope = durableScopeOfRecord(target);
    if (scope === null || target.scope.userId !== actorId) return false;
    try {
      const result = await this.deps.writer.forget({ memoryId: target.id, scope });
      if (result.outcome === 'REJECTED') {
        this.log('warn', 'memory_commands.forget.rejected', {});
        return false;
      }
      return true;
    } catch (error) {
      this.log('warn', 'memory_commands.forget.delete_failed', { errorName: errorName(error) });
      return false;
    }
  }

  /**
   * ADR-0106 D5 edit: a superseding record in the original scope through the normal writer policy (so the credential
   * guard and the 4,000-character bound apply again), then the old record's derived data is removed (best effort:
   * the old record stays only as superseded history, never in recall).
   */
  private async executeEdit(
    request: MemoryCommandRequest,
    record: MemoryRecord,
    action: Extract<PendingAction, { kind: 'edit' }>,
    language: MemoryCommandLanguage,
  ) {
    const actorId = request.actorId;
    const scope = durableScopeOfRecord(record);
    const kind = metadataText(record, 'kind');
    const provenance = metadataText(record, 'provenance');
    const authorityLevel = metadataText(record, 'authorityLevel');
    if (scope === null || kind === undefined || provenance === undefined || authorityLevel === undefined) {
      return this.reply('edit-rejected', renderEditFailed(language));
    }
    let decision;
    try {
      const candidate = this.deps.writer.createCandidate({
        content: action.text,
        sourceContent: action.sourceText,
        trigger: 'EXPLICIT_USER_INSTRUCTION',
        // Carried from the record; `createCandidate` validates them (a legacy record with bad values is refused).
        kind: kind as DurableMemoryKind,
        provenance: provenance as DurableMemoryProvenance,
        authorityLevel: authorityLevel as DurableMemoryAuthorityLevel,
        scope,
        metadata: { supersedesMemoryId: record.id, editedBy: 'memory-command' },
      });
      decision = await this.deps.writer.promote(candidate);
    } catch (error) {
      if (error instanceof Error && error.name === 'DurableMemoryValidationError') {
        return this.reply('edit-rejected', renderEditFailed(language));
      }
      throw error;
    }
    switch (decision.outcome) {
      case 'SUPERSEDING':
      case 'PROMOTED':
        break;
      case 'DUPLICATE':
        return this.reply('edit-duplicate', renderEditDuplicate(language));
      case 'REJECTED':
        return decision.policyReason === CREDENTIAL_REJECTION_REASON
          ? this.reply('edit-sensitive', renderEditSensitiveRefused(language))
          : this.reply('edit-rejected', renderEditFailed(language));
    }
    // The superseding write is done; the old record's derived data is cleaned up with one retry. A cleanup that still
    // fails is logged and the reply says so (the edit itself stands: the old record is out of recall as history).
    let cleanupPending = false;
    let sessionCleared = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.runCascades({ actorId, reason: 'edit', records: [record] });
        sessionCleared = await this.clearSessionHistory(request);
        break;
      } catch (error) {
        this.log('warn', 'memory_commands.edit.cascade_failed', { attempt, errorName: errorName(error) });
        if (attempt >= EDIT_CASCADE_ATTEMPTS) {
          cleanupPending = true;
          break;
        }
      }
    }
    this.log('info', 'memory_commands.edited', { cleanupPending: cleanupPending ? 1 : 0 });
    return this.reply(
      'edited',
      renderEdited(
        this.previewOf(decision.memory.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS),
        language,
        cleanupPending,
        sessionCleared,
      ),
    );
  }

  /**
   * Records whose `supersededBy` chain leads to `record` (same actor and write scope), newest first, archived or not
   * (callers decide what an archived version means for them).
   */
  private async earlierVersions(actorId: Id, record: MemoryRecord): Promise<MemoryRecord[]> {
    const all = await this.deps.records.findDurableCandidates({
      scope: { userId: actorId },
      limit: MEMORY_COMMAND_MAX_RECORDS,
      excludeExpired: false,
      excludeSuperseded: false,
      archived: 'include',
    });
    const scopeKey = JSON.stringify(durableScopeOfRecord(record));
    const found: MemoryRecord[] = [];
    const chain = new Set<Id>([record.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of all) {
        if (chain.has(candidate.id)) continue;
        const supersededBy = metadataText(candidate, 'supersededBy');
        if (
          supersededBy !== undefined &&
          chain.has(supersededBy) &&
          candidate.type === MemoryType.LONG_TERM &&
          candidate.scope.userId === actorId &&
          JSON.stringify(durableScopeOfRecord(candidate)) === scopeKey
        ) {
          chain.add(candidate.id);
          found.push(candidate);
          grew = true;
        }
      }
    }
    return found;
  }

  private async runCascades(input: {
    readonly actorId: Id;
    readonly reason: 'forget' | 'edit';
    readonly records: readonly MemoryRecord[];
  }): Promise<void> {
    const event = {
      actorId: input.actorId,
      reason: input.reason,
      memoryIds: input.records.map((record) => record.id),
      vectorIds: input.records.flatMap((record) => (record.vectorId === undefined ? [] : [record.vectorId])),
      contents: input.records.map((record) => record.content),
    };
    for (const cascade of this.cascades) {
      try {
        await cascade.onMemoriesRemoved(event);
      } catch (error) {
        this.log('warn', 'memory_commands.cascade.failed', { cascade: cascade.id, errorName: errorName(error) });
        throw error;
      }
    }
  }

  private issue(request: MemoryCommandRequest, record: MemoryRecord, action: PendingAction): string {
    const window = memoryConfirmationWindow(request.now);
    const generation = archiveGenerationOf(record);
    const spent = this.liveConsumed(request.actorId, window);
    let nonce = 0;
    let code = '';
    for (; nonce < MAX_CODE_NONCE; nonce += 1) {
      code = deriveMemoryConfirmationCode({
        recordId: record.id,
        content: record.content,
        action: confirmationActionOf(action),
        window,
        ...(generation === undefined ? {} : { generation }),
        nonce,
      });
      if (!spent.some((entry) => entry.code === code)) break;
    }
    if (nonce >= MAX_CODE_NONCE) throw new MemoryArchiveStateChangedError();
    const kept = this.livePending(request.actorId, window).filter(
      (entry) => entry.code !== code && !(entry.recordId === record.id && entry.action.kind === action.kind),
    );
    kept.push({ code, recordId: record.id, window, action, ...(generation === undefined ? {} : { generation }), nonce });
    this.setPending(request.actorId, kept.slice(-MAX_PENDING_PER_ACTOR));
    return code;
  }

  /** The actor's pending confirmations still inside the current or the previous window (expired ones are dropped). */
  private livePending(actorId: Id, window: number): PendingConfirmation[] {
    const live = (this.pending.get(actorId) ?? []).filter((entry) => window - entry.window <= 1 && window >= entry.window);
    this.setPending(actorId, live);
    return live;
  }

  private setPending(actorId: Id, entries: PendingConfirmation[]): void {
    if (entries.length === 0) this.pending.delete(actorId);
    else this.pending.set(actorId, entries);
  }

  /** The actor's spent codes still inside an accepting window (older ones are dropped); the live array. */
  private liveConsumed(actorId: Id, window: number): ConsumedConfirmation[] {
    const live = (this.consumed.get(actorId) ?? []).filter((entry) => window - entry.window <= 1 && window >= entry.window);
    this.consumed.set(actorId, live);
    return live;
  }

  /** Ends every outstanding code (any actor) for these record ids. */
  private dropPendingFor(recordIds: ReadonlySet<Id>): void {
    for (const [actorId, entries] of [...this.pending]) {
      this.setPending(
        actorId,
        entries.filter((entry) => !recordIds.has(entry.recordId)),
      );
    }
  }

  private async earlierVersionIds(actorId: Id, record: MemoryRecord): Promise<Id[]> {
    try {
      return (await this.earlierVersions(actorId, record)).map((version) => version.id);
    } catch {
      return [];
    }
  }

  private previewOf(content: string, language: MemoryCommandLanguage, maxChars?: number): string {
    return isStrictCredentialMemoryText(content) ? maskedMemoryText(language) : memoryPreview(content, maxChars);
  }

  private reply(outcome: MemoryCommandOutcome, text: string): MemoryCommandResult {
    return { outcome, text, status: 'RESPONDED' };
  }

  private log(level: 'info' | 'warn', event: string, fields: Record<string, string | number>): void {
    try {
      this.deps.logger?.[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

/** Outcomes whose reply echoes memory text (live or archived) and is kept in history as a content-free note. */
const HISTORY_NOTE_OUTCOMES: ReadonlySet<MemoryCommandOutcome> = new Set<MemoryCommandOutcome>([
  'forget-confirmation',
  'edit-confirmation',
  'forgotten',
  'edited',
  'archive-listed',
  'restore-confirmation',
  'purge-confirmation',
  'restored',
  'purged',
]);

/**
 * W2-L01 (ADR-0106 D5): the edit/forget command turns keep no memory text in the SHORT_TERM history. An edit request
 * is recorded as the command with its text withheld (whatever the outcome — a refused credential-shaped edit too),
 * and a reply that echoes memory text (the confirmation previews, the forgotten/edited result) as a content-free
 * note — with the amendment also the archive view and the restore/permanent-delete prompts and results, so archived
 * text never re-enters the conversation history. Every other turn carries no memory text, or only what a later
 * forget purges, and stays verbatim.
 */
export function memoryCommandHistory(
  command: MemoryCommand,
  outcome: MemoryCommandOutcome,
): MemoryCommandHistory | undefined {
  const user = command.kind === 'edit' ? renderEditRequestHistory(command.number, command.language) : undefined;
  const assistant = HISTORY_NOTE_OUTCOMES.has(outcome)
    ? renderMemoryCommandHistoryReply(outcome as MemoryCommandHistoryNoteOutcome, command.language)
    : undefined;
  if (user === undefined && assistant === undefined) return undefined;
  return { ...(user === undefined ? {} : { user }), ...(assistant === undefined ? {} : { assistant }) };
}

/** A record's archive state changed between the check and the write (restore aborted; nothing re-created). */
class MemoryArchiveStateChangedError extends Error {
  constructor() {
    super('memory archive state changed');
    this.name = 'MemoryArchiveStateChangedError';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

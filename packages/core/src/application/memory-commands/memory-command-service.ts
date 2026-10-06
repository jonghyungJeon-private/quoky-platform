import { createHash } from 'node:crypto';
import type {
  DurableMemoryAuthorityLevel,
  DurableMemoryKind,
  DurableMemoryProvenance,
  Id,
  IsoTimestamp,
  MemoryRecord,
} from '../../domain';
import { MemoryType } from '../../domain';
import type { DurableMemoryQuery, Logger } from '../../ports';
import { CREDENTIAL_REJECTION_REASON } from '../credential-guard';
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
  renderForgotten,
  renderMemoryCommandFailed,
  renderMemoryList,
  renderMemoryListEmpty,
  renderMemoryNotFound,
  renderMemoryPageOutOfRange,
  renderMemoryStatusLatest,
  renderMemoryStatusNone,
  renderMemoryView,
} from './memory-command-renderer';
import type { MemoryRemovalCascade } from './memory-removal-cascade';

/** ADR-0106 D4: the confirmation window; a code is accepted in the window it was issued in and the next one. */
export const MEMORY_CONFIRMATION_WINDOW_MS = 30 * 60 * 1_000;
/** Codes use an unambiguous alphabet (no I, L, O, 0, 1): 32 symbols, 5 bits each. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
/** Upper bound on the owner's records read for one command (a personal store holds far fewer). */
export const MEMORY_COMMAND_MAX_RECORDS = 2_000;
/** Pending confirmations kept per actor; the oldest are dropped first. */
const MAX_PENDING_PER_ACTOR = 10;

/** The read side the commands need — structurally the storage provider's memory repository. */
export interface MemoryCommandRecordSource {
  get(id: Id): Promise<MemoryRecord | null>;
  findDurableCandidates(query: DurableMemoryQuery): Promise<MemoryRecord[]>;
}

export interface MemoryCommandServiceDeps {
  readonly records: MemoryCommandRecordSource;
  /** Every write goes through the ADR-0073 writer policy (exact-scope forget, superseding promotion). */
  readonly writer: Pick<MemoryWriter, 'createCandidate' | 'promote' | 'forget'>;
  /** Derived-data cleanup on forget/edit (ADR-0106 D5): the vector cache today, LRN-1's learning items later. */
  readonly cascades?: readonly MemoryRemovalCascade[];
  readonly logger?: Logger;
}

export interface MemoryCommandRequest {
  readonly actorId: Id;
  /** The turn's shared clock reading. */
  readonly now: IsoTimestamp;
  /** The raw inbound text (kept as the edit's `sourceContent`; never logged). */
  readonly sourceText?: string;
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
  | 'edited'
  | 'edit-duplicate'
  | 'edit-rejected'
  | 'confirm-unknown'
  | 'confirm-stale'
  | 'bulk-refused'
  | 'usage'
  | 'status'
  | 'failed';

export interface MemoryCommandResult {
  readonly outcome: MemoryCommandOutcome;
  readonly text: string;
  readonly status: 'RESPONDED' | 'FAILED';
}

type PendingAction = { readonly kind: 'forget' } | { readonly kind: 'edit'; readonly text: string; readonly sourceText: string };

interface PendingConfirmation {
  readonly code: string;
  readonly recordId: Id;
  readonly window: number;
  readonly action: PendingAction;
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
 * ADR-0106 D4: a 4-character code from SHA-256 of (record id, content hash, proposed new text or `forget`, window).
 * A changed record, a different proposal or another window gives a different code.
 */
export function deriveMemoryConfirmationCode(input: {
  readonly recordId: Id;
  readonly content: string;
  readonly action: 'forget' | { readonly edit: string };
  readonly window: number;
}): string {
  const actionKey = input.action === 'forget' ? 'forget' : `edit:${sha256(input.action.edit)}`;
  const digest = createHash('sha256')
    .update(JSON.stringify(['quoky.memory-command.v1', input.recordId, sha256(input.content), actionKey, input.window]))
    .digest();
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
  const expiresAt = metadataText(record, 'expiresAt');
  if (expiresAt !== undefined) {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresMs) || expiresMs < nowMs) return false;
  }
  return true;
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
  private readonly cascades: readonly MemoryRemovalCascade[];

  constructor(private readonly deps: MemoryCommandServiceDeps) {
    this.cascades = deps.cascades ?? [];
  }

  /** Run one parsed command. Never throws: a store failure becomes a `failed` reply. */
  async execute(command: MemoryCommand, request: MemoryCommandRequest): Promise<MemoryCommandResult> {
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
    });
    return records.filter((record) => isListableMemory(record, actorId, nowMs)).sort(byCreation);
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
    const body = isCredentialLikeMemoryText(record.content) ? maskedMemoryText(language) : memoryBody(record.content);
    return this.reply('viewed', renderMemoryView(number, body, language));
  }

  private async status(request: MemoryCommandRequest, language: MemoryCommandLanguage) {
    const records = await this.listable(request.actorId, request.now);
    const latest = records.at(-1);
    if (latest === undefined) return this.reply('status', renderMemoryStatusNone(language));
    return this.reply('status', renderMemoryStatusLatest(this.previewOf(latest.content, language), records.length, language));
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
    // One-time: the code is spent whatever happens next.
    this.setPending(
      request.actorId,
      entries.filter((candidate) => candidate !== entry),
    );

    const record = await this.deps.records.get(entry.recordId);
    const nowMs = Date.parse(request.now);
    const unchanged =
      record !== null &&
      isListableMemory(record, request.actorId, nowMs) &&
      deriveMemoryConfirmationCode({
        recordId: record.id,
        content: record.content,
        action: entry.action.kind === 'forget' ? 'forget' : { edit: entry.action.text },
        window: entry.window,
      }) === entry.code;
    if (!unchanged || record === null) return this.reply('confirm-stale', renderConfirmStale(language));

    return entry.action.kind === 'forget'
      ? this.executeForget(request.actorId, record, language)
      : this.executeEdit(request.actorId, record, entry.action, language);
  }

  /**
   * ADR-0106 D5 forget: the cascades run first (so derived data never outlives the memory: if one fails, nothing is
   * deleted and the owner can ask again), then `MemoryWriter.forget` with each record's own write scope — the record
   * and the earlier versions it superseded, which are the same memory's history.
   */
  private async executeForget(actorId: Id, record: MemoryRecord, language: MemoryCommandLanguage) {
    const history = await this.earlierVersions(actorId, record);
    const removed = [record, ...history];
    try {
      await this.runCascades({ actorId, reason: 'forget', records: removed });
    } catch (error) {
      this.log('warn', 'memory_commands.forget.cascade_failed', { errorName: errorName(error) });
      return { outcome: 'failed' as const, text: renderMemoryCommandFailed(language), status: 'FAILED' as const };
    }
    for (const target of removed) {
      const scope = durableScopeOfRecord(target);
      if (scope === null || target.scope.userId !== actorId) continue;
      const result = await this.deps.writer.forget({ memoryId: target.id, scope });
      if (result.outcome === 'REJECTED' && target.id === record.id) {
        this.log('warn', 'memory_commands.forget.rejected', {});
        return { outcome: 'failed' as const, text: renderMemoryCommandFailed(language), status: 'FAILED' as const };
      }
    }
    this.log('info', 'memory_commands.forgotten', { removed: removed.length });
    return this.reply(
      'forgotten',
      renderForgotten(this.previewOf(record.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), history.length, language),
    );
  }

  /**
   * ADR-0106 D5 edit: a superseding record in the original scope through the normal writer policy (so the credential
   * guard and the 4,000-character bound apply again), then the old record's derived data is removed (best effort:
   * the old record stays only as superseded history, never in recall).
   */
  private async executeEdit(
    actorId: Id,
    record: MemoryRecord,
    action: Extract<PendingAction, { kind: 'edit' }>,
    language: MemoryCommandLanguage,
  ) {
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
    try {
      await this.runCascades({ actorId, reason: 'edit', records: [record] });
    } catch (error) {
      this.log('warn', 'memory_commands.edit.cascade_failed', { errorName: errorName(error) });
    }
    this.log('info', 'memory_commands.edited', {});
    return this.reply('edited', renderEdited(this.previewOf(decision.memory.content, language, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), language));
  }

  /** Records whose `supersededBy` chain leads to `record` (same actor and write scope), newest first. */
  private async earlierVersions(actorId: Id, record: MemoryRecord): Promise<MemoryRecord[]> {
    const all = await this.deps.records.findDurableCandidates({
      scope: { userId: actorId },
      limit: MEMORY_COMMAND_MAX_RECORDS,
      excludeExpired: false,
      excludeSuperseded: false,
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
    const code = deriveMemoryConfirmationCode({
      recordId: record.id,
      content: record.content,
      action: action.kind === 'forget' ? 'forget' : { edit: action.text },
      window,
    });
    const kept = this.livePending(request.actorId, window).filter(
      (entry) => entry.code !== code && !(entry.recordId === record.id && entry.action.kind === action.kind),
    );
    kept.push({ code, recordId: record.id, window, action });
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

  private previewOf(content: string, language: MemoryCommandLanguage, maxChars?: number): string {
    return isCredentialLikeMemoryText(content) ? maskedMemoryText(language) : memoryPreview(content, maxChars);
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

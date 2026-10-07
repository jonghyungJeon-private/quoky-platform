import path from 'node:path';
import type { IsoTimestamp, Logger } from '@quoky/core';
import { fileLedgerStore, type OpsNoticeLedgerStore } from '../ops/ops-notice';
import { chatChoiceFromData, chatChoiceToData, imageChoiceFromData } from './selection-choices';
import type { ChatChoice, ImageChoice } from './selection-choices';

/**
 * The persisted operations-UI default of the owner's runtime model switch (ADR-0092 amendment, runtime switching).
 *
 * No SQLite migration (host DB migrations are Strict): a small private JSON file beside the database,
 * `<database directory>/ops/provider-selection.json`, written like the `OPS_NOTICE` ledger — private directory (700),
 * private file (600), replaced atomically (write a temp file, then rename). It holds two optional facts, the chat-tier
 * default and the image default; absent means "use the installation configuration".
 *
 * Reading never fails startup: a missing file is the empty default, and a corrupt file, an unknown version or an
 * invalid entry is ignored (that entry only) with a value-free warning code, so the env selection applies.
 */

export const PROVIDER_SELECTION_FILE_VERSION = 1;

export interface PersistedProviderSelection {
  readonly chat?: ChatChoice;
  readonly image?: ImageChoice;
  /** When the file was last written (display only). */
  readonly updatedAt?: IsoTimestamp;
}

export type ProviderSelectionFileIo = OpsNoticeLedgerStore;

/** `<database directory>/ops/provider-selection.json`; `undefined` for a non-file database (`:memory:`). */
export function providerSelectionFilePath(dbPath: string, cwd: string = process.cwd()): string | undefined {
  if (dbPath === '' || dbPath === ':memory:') return undefined;
  return path.join(path.dirname(path.resolve(cwd, dbPath)), 'ops', 'provider-selection.json');
}

/** The private-file IO (mode 600 in a 700 directory, atomic replace); in memory when there is no file database. */
export function providerSelectionFileIo(filePath: string | undefined): ProviderSelectionFileIo {
  if (filePath !== undefined) return fileLedgerStore(filePath);
  let content: string | undefined;
  return { read: () => content, write: (next) => void (content = next) };
}

export class ProviderSelectionStore {
  private current: PersistedProviderSelection;

  constructor(
    private readonly io: ProviderSelectionFileIo,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {
    this.current = this.load();
  }

  /** The last loaded or saved default (never re-read per request). */
  get(): PersistedProviderSelection {
    return this.current;
  }

  /**
   * Replace the stored default. The file is written first; only a successful write changes what {@link get} returns,
   * so a failed write leaves the effective selection unchanged (the caller reports the failure).
   */
  save(next: PersistedProviderSelection): void {
    const data: Record<string, unknown> = { version: PROVIDER_SELECTION_FILE_VERSION };
    if (next.chat !== undefined) data.chat = chatChoiceToData(next.chat);
    if (next.image !== undefined) data.image = next.image;
    if (next.updatedAt !== undefined) data.updatedAt = next.updatedAt;
    this.io.write(`${JSON.stringify(data)}\n`);
    this.current = next;
  }

  private load(): PersistedProviderSelection {
    let raw: string | undefined;
    try {
      raw = this.io.read();
    } catch {
      this.logger.warn('provider selection default unreadable; using the configuration', { code: 'SELECTION_FILE_UNREADABLE' });
      return {};
    }
    if (raw === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn('provider selection default ignored', { code: 'SELECTION_FILE_CORRUPT' });
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== PROVIDER_SELECTION_FILE_VERSION) {
      this.logger.warn('provider selection default ignored', { code: 'SELECTION_FILE_VERSION' });
      return {};
    }
    const record = parsed as { chat?: unknown; image?: unknown; updatedAt?: unknown };
    const chat = record.chat === undefined ? undefined : chatChoiceFromData(record.chat);
    const image = record.image === undefined ? undefined : imageChoiceFromData(record.image);
    if (record.chat !== undefined && chat === null) {
      this.logger.warn('provider selection default entry ignored', { code: 'SELECTION_FILE_CHAT_INVALID' });
    }
    if (record.image !== undefined && image === null) {
      this.logger.warn('provider selection default entry ignored', { code: 'SELECTION_FILE_IMAGE_INVALID' });
    }
    return {
      ...(chat ? { chat } : {}),
      ...(image ? { image } : {}),
      ...(typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
        ? { updatedAt: record.updatedAt }
        : {}),
    };
  }
}

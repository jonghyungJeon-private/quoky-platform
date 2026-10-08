import path from 'node:path';
import type { TelegramOffsetStore } from '@quoky/adapter-telegram';
import { fileLedgerStore, type OpsNoticeLedgerStore } from '../ops/ops-notice';

/**
 * The persisted Telegram poll offset (TG-1 review decision 2): `<database directory>/ops/telegram-offset.json`, written
 * like the `OPS_NOTICE` ledger and `provider-selection.json` — private directory (700), private file (600), replaced
 * atomically. It holds the bot id and the next offset only (no content, no token). A file for another bot, a corrupt
 * file or an unknown version is ignored, and the adapter then resumes from Telegram's own confirmation.
 */
export const TELEGRAM_OFFSET_FILE_VERSION = 1;

/** `<database directory>/ops/telegram-offset.json`; `undefined` for a non-file database (`:memory:`). */
export function telegramOffsetFilePath(dbPath: string, cwd: string = process.cwd()): string | undefined {
  if (dbPath === '' || dbPath === ':memory:') return undefined;
  return path.join(path.dirname(path.resolve(cwd, dbPath)), 'ops', 'telegram-offset.json');
}

export function telegramOffsetStore(io: OpsNoticeLedgerStore, botId: string): TelegramOffsetStore {
  return {
    load(): number | undefined {
      const content = io.read();
      if (content === undefined) return undefined;
      const parsed = JSON.parse(content) as { version?: unknown; botId?: unknown; offset?: unknown };
      if (parsed.version !== TELEGRAM_OFFSET_FILE_VERSION || parsed.botId !== botId) return undefined;
      const offset = parsed.offset;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return undefined;
      return offset;
    },
    save(offset: number): void {
      io.write(`${JSON.stringify({ version: TELEGRAM_OFFSET_FILE_VERSION, botId, offset })}\n`);
    },
  };
}

/** The file-backed store for a file database; an in-memory one otherwise. */
export function telegramOffsetStoreFor(dbPath: string, botId: string): TelegramOffsetStore {
  const filePath = telegramOffsetFilePath(dbPath);
  if (filePath !== undefined) return telegramOffsetStore(fileLedgerStore(filePath), botId);
  let content: string | undefined;
  return telegramOffsetStore({ read: () => content, write: (next) => void (content = next) }, botId);
}

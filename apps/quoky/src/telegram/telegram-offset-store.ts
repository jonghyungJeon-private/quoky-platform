import path from 'node:path';
import type { TelegramOffsetStore } from '@quoky/adapter-telegram';
import { fileLedgerStore, type OpsNoticeLedgerStore } from '../ops/ops-notice';

/**
 * The persisted Telegram poll offset (TG-1 review decision 2): `<database directory>/ops/telegram-offset.json`, written
 * like the `OPS_NOTICE` ledger and `provider-selection.json` — private directory (700), private file (600), replaced
 * atomically. It holds the bot id, the next offset and when it was saved (no content, no token). A file for another bot,
 * a corrupt file, an unknown version, or one without `savedAt` (the earlier format) is ignored, and the adapter then
 * resumes from Telegram's own confirmation.
 *
 * Staleness (CA re-review P2): a file older than {@link TELEGRAM_OFFSET_MAX_AGE_MS} is ignored. Telegram keeps updates
 * for 24 hours, so after that nothing a stored offset protects against can still be pending; and after a long silence
 * Telegram may restart `update_id` from a random LOWER value, which a stored higher offset would swallow for good.
 */
export const TELEGRAM_OFFSET_FILE_VERSION = 2;
/** Telegram's own update retention: a stored offset older than this is never used. */
export const TELEGRAM_OFFSET_MAX_AGE_MS = 24 * 60 * 60_000;
/** A `savedAt` this far in the future (clock skew) is treated as unusable too. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** `<database directory>/ops/telegram-offset.json`; `undefined` for a non-file database (`:memory:`). */
export function telegramOffsetFilePath(dbPath: string, cwd: string = process.cwd()): string | undefined {
  if (dbPath === '' || dbPath === ':memory:') return undefined;
  return path.join(path.dirname(path.resolve(cwd, dbPath)), 'ops', 'telegram-offset.json');
}

export function telegramOffsetStore(
  io: OpsNoticeLedgerStore,
  botId: string,
  nowMs: () => number = () => Date.now(),
): TelegramOffsetStore {
  return {
    load(): number | undefined {
      const content = io.read();
      if (content === undefined) return undefined;
      const parsed = JSON.parse(content) as { version?: unknown; botId?: unknown; offset?: unknown; savedAt?: unknown };
      if (parsed.version !== TELEGRAM_OFFSET_FILE_VERSION || parsed.botId !== botId) return undefined;
      const offset = parsed.offset;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return undefined;
      const savedAt = typeof parsed.savedAt === 'string' ? Date.parse(parsed.savedAt) : Number.NaN;
      if (!Number.isFinite(savedAt)) return undefined;
      const age = nowMs() - savedAt;
      if (age > TELEGRAM_OFFSET_MAX_AGE_MS || age < -FUTURE_TOLERANCE_MS) return undefined;
      return offset;
    },
    save(offset: number): void {
      const savedAt = new Date(nowMs()).toISOString();
      io.write(`${JSON.stringify({ version: TELEGRAM_OFFSET_FILE_VERSION, botId, offset, savedAt })}\n`);
    },
  };
}

/** The file-backed store for a file database; an in-memory one otherwise. */
export function telegramOffsetStoreFor(dbPath: string, botId: string, nowMs?: () => number): TelegramOffsetStore {
  const filePath = telegramOffsetFilePath(dbPath);
  if (filePath !== undefined) return telegramOffsetStore(fileLedgerStore(filePath), botId, nowMs);
  let content: string | undefined;
  return telegramOffsetStore({ read: () => content, write: (next) => void (content = next) }, botId, nowMs);
}

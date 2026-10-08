import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { telegramOffsetFilePath, telegramOffsetStoreFor } from './telegram-offset-store';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function dbIn(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-tg-offset-'));
  dirs.push(dir);
  return join(dir, 'quoky.db');
}

describe('Telegram offset file (TG-1 review decision 2)', () => {
  it('lives in the private ops directory beside the database, holds only the bot id and offset, and round-trips', () => {
    const db = dbIn();
    const file = telegramOffsetFilePath(db) as string;
    expect(file).toBe(join(db, '..', 'ops', 'telegram-offset.json'));
    const store = telegramOffsetStoreFor(db, '7001234');
    expect(store.load()).toBeUndefined();
    store.save(43);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, botId: '7001234', offset: 43 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(db, '..', 'ops')).mode & 0o777).toBe(0o700);
    expect(telegramOffsetStoreFor(db, '7001234').load()).toBe(43);
  });

  it("another bot's offset, an unknown version or an invalid value is ignored", () => {
    const db = dbIn();
    telegramOffsetStoreFor(db, '7001234').save(43);
    expect(telegramOffsetStoreFor(db, '8009876').load()).toBeUndefined();
    const file = telegramOffsetFilePath(db) as string;
    writeFileSync(file, JSON.stringify({ version: 2, botId: '7001234', offset: 43 }));
    expect(telegramOffsetStoreFor(db, '7001234').load()).toBeUndefined();
    writeFileSync(file, JSON.stringify({ version: 1, botId: '7001234', offset: -1 }));
    expect(telegramOffsetStoreFor(db, '7001234').load()).toBeUndefined();
  });

  it('an in-memory database keeps the offset in memory only', () => {
    expect(telegramOffsetFilePath(':memory:')).toBeUndefined();
    const store = telegramOffsetStoreFor(':memory:', '7001234');
    store.save(9);
    expect(store.load()).toBe(9);
  });
});

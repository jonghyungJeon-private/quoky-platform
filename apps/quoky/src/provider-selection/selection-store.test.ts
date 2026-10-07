import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_SELECTION_FILE_VERSION, ProviderSelectionStore, providerSelectionFileIo, providerSelectionFilePath } from './selection-store';

/**
 * ADR-0092 amendment (runtime switching): the persisted operations-UI default is a private JSON file beside the DB
 * (no SQLite migration): 0600 in a 0700 directory, replaced atomically; a missing or corrupt file never fails startup
 * and the configuration then applies.
 */

let dir: string;
let file: string;
const warnings: Array<Record<string, unknown> | undefined> = [];
const logger = { warn: (_message: string, fields?: Record<string, unknown>) => void warnings.push(fields) };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'quoky-selection-store-'));
  file = path.join(dir, 'ops', 'provider-selection.json');
  warnings.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ProviderSelectionStore', () => {
  it('lives beside the database; no file for a non-file database', () => {
    expect(providerSelectionFilePath('/data/quoky/quoky.db')).toBe('/data/quoky/ops/provider-selection.json');
    expect(providerSelectionFilePath('./data/x.db', '/repo')).toBe('/repo/data/ops/provider-selection.json');
    expect(providerSelectionFilePath(':memory:')).toBeUndefined();
    expect(providerSelectionFilePath('')).toBeUndefined();
  });

  it('a missing file is the empty default, without a warning', () => {
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({});
    expect(warnings).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('round-trips through a private (0600) file in a private (0700) directory, replaced atomically', () => {
    const store = new ProviderSelectionStore(providerSelectionFileIo(file), logger);
    store.save({ chat: { provider: 'ollama', model: 'granite3.3:8b' }, image: 'off', updatedAt: '2026-10-07T01:00:00.000Z' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: PROVIDER_SELECTION_FILE_VERSION,
      chat: { provider: 'ollama', model: 'granite3.3:8b' },
      image: 'off',
      updatedAt: '2026-10-07T01:00:00.000Z',
    });
    // No temp file is left behind.
    expect(readdir(path.dirname(file))).toEqual(['provider-selection.json']);
    const reloaded = new ProviderSelectionStore(providerSelectionFileIo(file), logger);
    expect(reloaded.get()).toEqual({ chat: { provider: 'ollama', model: 'granite3.3:8b' }, image: 'off', updatedAt: '2026-10-07T01:00:00.000Z' });
    reloaded.save({ chat: { provider: 'codex' } });
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({ chat: { provider: 'codex' } });
  });

  it.each([
    ['corrupt JSON', '{not json', 'SELECTION_FILE_CORRUPT'],
    ['an unknown version', JSON.stringify({ version: 9, chat: { provider: 'codex' } }), 'SELECTION_FILE_VERSION'],
    ['not an object', '"codex"', 'SELECTION_FILE_VERSION'],
  ])('%s is ignored with a value-free code (the configuration applies)', (_label, content, code) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({});
    expect(warnings).toEqual([{ code }]);
  });

  it('an invalid entry is dropped alone; the valid one is kept', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, chat: { provider: 'claude', model: 'claude-3-opus' }, image: 'claude' }));
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({ image: 'claude' });
    expect(warnings).toEqual([{ code: 'SELECTION_FILE_CHAT_INVALID' }]);
  });

  it('an unreadable file is ignored; a failed write keeps the previous default', () => {
    let content: string | undefined = JSON.stringify({ version: 1, image: 'off' });
    let failWrites = false;
    const store = new ProviderSelectionStore({
      read: () => content,
      write: (next) => {
        if (failWrites) throw new Error('ENOSPC');
        content = next;
      },
    }, logger);
    failWrites = true;
    expect(() => store.save({ image: 'claude' })).toThrow();
    expect(store.get()).toEqual({ image: 'off' });
    const unreadable = new ProviderSelectionStore({ read: () => { throw new Error('EACCES'); }, write: () => undefined }, logger);
    expect(unreadable.get()).toEqual({});
    expect(warnings.at(-1)).toEqual({ code: 'SELECTION_FILE_UNREADABLE' });
  });

  it('without a file database the default lives in memory for the process', () => {
    const io = providerSelectionFileIo(undefined);
    new ProviderSelectionStore(io, logger).save({ image: 'off' });
    expect(new ProviderSelectionStore(io, logger).get()).toEqual({ image: 'off' });
  });
});

function readdir(dirPath: string): string[] {
  return readdirSync(dirPath).sort();
}

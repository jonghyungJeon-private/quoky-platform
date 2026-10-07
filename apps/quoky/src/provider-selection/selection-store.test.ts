import { chmodSync, lstatSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateFileRefusedError, writePrivateFileAtomic } from '../ops/ops-notice';
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
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content);
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({});
    expect(warnings).toEqual([{ code }]);
  });

  it('an invalid entry is dropped alone; the valid one is kept', () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
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

  it('refuses a symlinked ops directory: nothing is written through it (shared helper, OPS_NOTICE ledger too)', () => {
    const outside = path.join(dir, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, path.dirname(file));
    const store = new ProviderSelectionStore(providerSelectionFileIo(file), logger);
    expect(() => store.save({ image: 'off' })).toThrow(PrivateFileRefusedError);
    expect(readdir(outside)).toEqual([]);
    expect(store.get()).toEqual({});
  });

  it('reads nothing through a symlinked ops directory: a regular file there is ignored and the configuration applies', () => {
    const outside = path.join(dir, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(path.join(outside, 'provider-selection.json'), JSON.stringify({ version: 1, image: 'claude' }), { mode: 0o600 });
    symlinkSync(outside, path.dirname(file));
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({});
    expect(warnings).toEqual([{ code: 'SELECTION_FILE_REFUSED' }]);
  });

  it('reads nothing from an ops directory that is not private (0700)', () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ version: 1, image: 'claude' }), { mode: 0o600 });
    chmodSync(path.dirname(file), 0o755);
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({});
    expect(warnings).toEqual([{ code: 'SELECTION_FILE_REFUSED' }]);
    chmodSync(path.dirname(file), 0o700);
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({ image: 'claude' });
  });

  it('never follows a symlink at the target: it is replaced by a private regular file, the link target untouched', () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const victim = path.join(dir, 'victim.txt');
    writeFileSync(victim, 'keep me');
    symlinkSync(victim, file);
    // Reading refuses the link (never follows it): the store starts from the configuration.
    expect(new ProviderSelectionStore(providerSelectionFileIo(file), logger).get()).toEqual({});
    expect(warnings.at(-1)).toEqual({ code: 'SELECTION_FILE_REFUSED' });
    writePrivateFileAtomic(file, '{"version":1}\n');
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('uses an unpredictable, exclusively created temp name: a planted `.tmp-<pid>` symlink is never written through', () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const victim = path.join(dir, 'victim.txt');
    writeFileSync(victim, 'keep me');
    for (const name of [`${file}.tmp-${process.pid}`, path.join(path.dirname(file), `.provider-selection.json.tmp-${process.pid}`)]) {
      symlinkSync(victim, name);
    }
    writePrivateFileAtomic(file, 'one');
    writePrivateFileAtomic(file, 'two');
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(readFileSync(file, 'utf8')).toBe('two');
    // Only the target and the two planted links remain: no temp file is left behind.
    expect(readdir(path.dirname(file)).filter((name) => !name.includes(String(process.pid)))).toEqual(['provider-selection.json']);
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

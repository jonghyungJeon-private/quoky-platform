import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEARNING_EGRESS_LOCAL_ONLY, LearningItemKind } from '@quoky/core';
import type { GoldenCase, LearningItem } from '@quoky/core';
import { SqliteStorageProvider, openLearningExportReader } from '@quoky/storage-sqlite';
import {
  EXIT_BLOCKED, EXIT_OK, EXIT_USAGE, LEARNING_EXPORT_REVIEW_MARKER, LEARNING_EXPORT_SUITE, buildLearningExport,
  runCli, validateLearningExport,
} from './learning-export';
import type { LearningExportCliDeps } from './learning-export';

const NOW = '2026-10-06T12:00:00.000Z';
const CREDENTIAL = '비밀번호는 hunter2-secret 이야';
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-learning-export-'));
  dirs.push(dir);
  return dir;
}

function item(over: Partial<LearningItem> = {}): LearningItem {
  return {
    id: 'item-1',
    actorId: 'actor-1',
    kind: LearningItemKind.GOLDEN_CANDIDATE,
    capability: 'GENERAL_CHAT',
    language: 'ko',
    sourceTurnId: 'turn-1',
    egress: LEARNING_EGRESS_LOCAL_ONLY,
    createdAt: '2026-10-05T09:00:00.000Z',
    expiresAt: '2027-10-05T09:00:00.000Z',
    data: { requestText: '내일 회의 몇 시야?', note: '날씨를 답했어', sourceRating: 'NEGATIVE', intentType: 'CHAT' as never },
    ...over,
  };
}

describe('buildLearningExport / validateLearningExport (ADR-0107 D4)', () => {
  it('turns approved candidates into review-only golden cases in the GoldenCase shape', () => {
    const { file, skipped } = buildLearningExport([item()], NOW);
    expect(file.suite).toBe(LEARNING_EXPORT_SUITE);
    expect(file.exportedAt).toBe(NOW);
    expect(file.note).toContain('owner-reviewed PR');
    expect(file.cases).toEqual([{
      id: 'lrn-item-1',
      text: '내일 회의 몇 시야?',
      expected: { review: LEARNING_EXPORT_REVIEW_MARKER, ownerNote: '날씨를 답했어', observed: { capability: 'GENERAL_CHAT', intentType: 'CHAT' } },
      source: 'learning_items item-1 (owner note, captured 2026-10-05)',
      mustPass: false,
    }]);
    // Assignable to the golden scorer's case type.
    const asGolden: readonly GoldenCase[] = file.cases;
    expect(asGolden).toHaveLength(1);
    expect(skipped).toEqual({ guarded: 0, egress: 0, kind: 0, noNote: 0 });
    expect(validateLearningExport(JSON.parse(JSON.stringify(file)))).toEqual([]);
  });

  it('guards again at export: a credential-shaped item is left out, never redacted', () => {
    const { file, skipped } = buildLearningExport([
      item({ id: 'leak-request', data: { ...item().data, requestText: CREDENTIAL } }),
      item({ id: 'leak-note', data: { ...item().data, note: `메모 ${CREDENTIAL}` } }),
      item({ id: 'ok' }),
    ], NOW);
    expect(file.cases.map((c) => c.id)).toEqual(['lrn-ok']);
    expect(skipped.guarded).toBe(2);
    expect(JSON.stringify(file)).not.toContain('hunter2');
  });

  it('applies the strict (file-content) guard at export, not only the chat guard', () => {
    const strictOnly = 'const dbPassword = "SYNTHETIC_ONLY"';
    const { file, skipped } = buildLearningExport([
      item({ id: 'strict-request', data: { ...item().data, requestText: strictOnly } }),
      item({ id: 'strict-note', data: { ...item().data, note: strictOnly } }),
      item({ id: 'strict-behavior', data: { ...item().data, expectedBehavior: strictOnly } }),
      item({ id: 'ok' }),
    ], NOW);
    expect(file.cases.map((c) => c.id)).toEqual(['lrn-ok']);
    expect(skipped.guarded).toBe(3);
    expect(JSON.stringify(file)).not.toContain('SYNTHETIC_ONLY');
  });

  it('leaves out examples, non-LOCAL_ONLY egress and candidates without a note', () => {
    const { file, skipped } = buildLearningExport([
      item({ id: 'ex', kind: LearningItemKind.EXAMPLE }),
      item({ id: 'remote', egress: 'ANYWHERE' as never }),
      item({ id: 'bare', data: { requestText: 'r', sourceRating: 'NEGATIVE' } }),
    ], NOW);
    expect(file.cases).toEqual([]);
    expect(skipped).toEqual({ guarded: 0, egress: 1, kind: 1, noNote: 1 });
    expect(validateLearningExport(file)).toEqual([]);
  });

  it('validation reports a malformed file', () => {
    expect(validateLearningExport(null)).toEqual(['not an object']);
    const { file } = buildLearningExport([item(), item({ id: 'b' })], NOW);
    const broken = JSON.parse(JSON.stringify(file)) as { suite: string; cases: Array<Record<string, unknown>> };
    broken.suite = 'other';
    broken.cases[1]!.id = 'lrn-item-1';
    broken.cases[0]!.mustPass = true;
    delete (broken.cases[0]!.expected as Record<string, unknown>).review;
    expect(validateLearningExport(broken)).toEqual(['suite', 'cases[0].mustPass', 'cases[0].expected', 'cases[1].id duplicate']);
  });
});

describe('learning-export CLI (offline, read-only DB, new output file only)', () => {
  function deps(over: Partial<LearningExportCliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const base: LearningExportCliDeps = {
      now: () => NOW,
      openReader: openLearningExportReader,
      writeNewFile: (path, content) => writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' }),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      ...over,
    };
    return { deps: base, out, err };
  }

  async function seededDb(items: LearningItem[]): Promise<string> {
    const dbPath = join(tempDir(), 'quoky.db');
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    for (const entry of items) await storage.learning.insertWithinCap(entry, 1000, NOW);
    await storage.close();
    return dbPath;
  }

  it('writes a valid export file and prints counts only (never item text)', async () => {
    const dbPath = await seededDb([item(), item({ id: 'leak', data: { ...item().data, note: CREDENTIAL } })]);
    const outPath = join(tempDir(), 'candidates.json');
    const { deps: d, out, err } = deps();
    expect(await runCli(['--db', dbPath, '--out', outPath], d)).toBe(EXIT_OK);
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as unknown;
    expect(validateLearningExport(written)).toEqual([]);
    expect((written as { cases: unknown[] }).cases).toHaveLength(1);
    expect(out.join('\n')).toContain('1 cases written');
    expect(out.join('\n')).toContain('1 guarded');
    expect([...out, ...err].join('\n')).not.toContain('회의');
    expect([...out, ...err].join('\n')).not.toContain('hunter2');
  });

  it('never overwrites an existing output file', async () => {
    const dbPath = await seededDb([item()]);
    const outPath = join(tempDir(), 'exists.json');
    writeFileSync(outPath, 'keep me');
    const { deps: d, err } = deps();
    expect(await runCli(['--db', dbPath, '--out', outPath], d)).toBe(EXIT_BLOCKED);
    expect(readFileSync(outPath, 'utf8')).toBe('keep me');
    expect(err.join('\n')).toContain('already exists');
  });

  it('refuses a missing database without creating it, and writes nothing', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'missing.db');
    const outPath = join(dir, 'out.json');
    const { deps: d } = deps();
    expect(await runCli(['--db', dbPath, '--out', outPath], d)).not.toBe(EXIT_OK);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(outPath)).toBe(false);
  });

  it('rejects bad arguments with usage', async () => {
    const writeNewFile = vi.fn();
    const { deps: d } = deps({ writeNewFile });
    for (const argv of [[], ['--db', 'x'], ['--out', 'y'], ['--db', 'x', '--out'], ['--db', 'x', '--out', 'y', '--extra', 'z'], ['--db', '--out', 'y']]) {
      expect(await runCli(argv, d), argv.join(' ')).toBe(EXIT_USAGE);
    }
    expect(writeNewFile).not.toHaveBeenCalled();
    expect(await runCli(['--help'], d)).toBe(EXIT_OK);
  });
});

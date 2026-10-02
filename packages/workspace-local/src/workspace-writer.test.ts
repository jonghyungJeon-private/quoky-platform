import { afterAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { PatchOperation, WorkspaceRef } from '@quoky/core';
import { LocalWorkspaceWriter } from './index';

const created: string[] = [];
afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
function ws(): WorkspaceRef {
  return { id: 'w1', rootPath: tempDir('quoky-wswrite-'), kind: 'local-clone' };
}
function unified(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, '', '');
}

const writer = new LocalWorkspaceWriter();

describe('LocalWorkspaceWriter (CAP-006, ADR-0027) — atomic per file', () => {
  it('updates an existing file by applying its unified diff', async () => {
    const ref = ws();
    writeFileSync(join(ref.rootPath, 'a.txt'), 'hello\n');
    const op: PatchOperation = { path: 'a.txt', operation: 'update', diff: unified('a.txt', 'hello\n', 'world\n') };
    const r = await writer.applyOperation(ref, op);
    expect(r.status).toBe('applied');
    expect(readFileSync(join(ref.rootPath, 'a.txt'), 'utf8')).toBe('world\n');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('adds a new file (incl. nested dir)', async () => {
    const ref = ws();
    const op: PatchOperation = { path: 'src/new.ts', operation: 'add', diff: unified('src/new.ts', '', 'export const x = 1;\n') };
    const r = await writer.applyOperation(ref, op);
    expect(r.status).toBe('applied');
    expect(readFileSync(join(ref.rootPath, 'src/new.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('deletes a file', async () => {
    const ref = ws();
    writeFileSync(join(ref.rootPath, 'gone.txt'), 'bye\n');
    const r = await writer.applyOperation(ref, { path: 'gone.txt', operation: 'delete', diff: '' });
    expect(r.status).toBe('applied');
    expect(existsSync(join(ref.rootPath, 'gone.txt'))).toBe(false);
  });

  it('reports failed when the diff does not apply cleanly (conflict)', async () => {
    const ref = ws();
    writeFileSync(join(ref.rootPath, 'a.txt'), 'COMPLETELY DIFFERENT\n');
    const op: PatchOperation = { path: 'a.txt', operation: 'update', diff: unified('a.txt', 'hello\n', 'world\n') };
    const r = await writer.applyOperation(ref, op);
    expect(r.status).toBe('failed');
    // file unchanged on failure
    expect(readFileSync(join(ref.rootPath, 'a.txt'), 'utf8')).toBe('COMPLETELY DIFFERENT\n');
  });

  it('skips binary operations', async () => {
    const ref = ws();
    const r = await writer.applyOperation(ref, { path: 'img.png', operation: 'update', diff: '', metadata: { binary: true } });
    expect(r.status).toBe('skipped');
  });

  it('refuses to write outside the workspace root (sandbox)', async () => {
    const ref = ws();
    const r = await writer.applyOperation(ref, { path: '../escape.txt', operation: 'add', diff: unified('../escape.txt', '', 'x') });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/escape|root|absolute/i);
  });
});

describe('LocalWorkspaceWriter.applyOperation — no-follow write containment (ADR-0022, ADR-0099)', () => {
  const add = (path: string, content: string): PatchOperation => ({
    path,
    operation: 'add',
    diff: unified(path, '', content),
  });
  const update = (path: string, before: string, after: string): PatchOperation => ({
    path,
    operation: 'update',
    diff: unified(path, before, after),
  });
  const isSymlink = (abs: string): boolean => lstatSync(abs).isSymbolicLink();

  it('refuses a new file under a symlinked parent that points outside the root; nothing is written outside', async () => {
    const ref = ws();
    const outside = tempDir('quoky-wswrite-outside-');
    symlinkSync(outside, join(ref.rootPath, 'link'));
    const r = await writer.applyOperation(ref, add('link/new.txt', 'pwned\n'));
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/escapes the workspace root via symlink|symlinked directory/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses nested missing directories under a symlinked parent (no recursive mkdir outside the root)', async () => {
    const ref = ws();
    const outside = tempDir('quoky-wswrite-outside-');
    symlinkSync(outside, join(ref.rootPath, 'link'));
    const r = await writer.applyOperation(ref, add('link/deep/er/new.txt', 'pwned\n'));
    expect(r.status).toBe('failed');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses an update of an existing outside file through a symlinked parent', async () => {
    const ref = ws();
    const outside = tempDir('quoky-wswrite-outside-');
    writeFileSync(join(outside, 'victim.txt'), 'hello\n');
    symlinkSync(outside, join(ref.rootPath, 'link'));
    const r = await writer.applyOperation(ref, update('link/victim.txt', 'hello\n', 'pwned\n'));
    expect(r.status).toBe('failed');
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('hello\n');
  });

  it('refuses a symlinked target that points outside the root; the external file is untouched', async () => {
    const ref = ws();
    const outside = tempDir('quoky-wswrite-outside-');
    writeFileSync(join(outside, 'victim.txt'), 'hello\n');
    symlinkSync(join(outside, 'victim.txt'), join(ref.rootPath, 'alias.txt'));
    const r = await writer.applyOperation(ref, update('alias.txt', 'hello\n', 'pwned\n'));
    expect(r.status).toBe('failed');
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('hello\n');
    expect(isSymlink(join(ref.rootPath, 'alias.txt'))).toBe(true);
  });

  it('refuses a symlinked target even when it points inside the root; neither link nor file changes', async () => {
    const ref = ws();
    writeFileSync(join(ref.rootPath, 'real.txt'), 'hello\n');
    symlinkSync(join(ref.rootPath, 'real.txt'), join(ref.rootPath, 'alias.txt'));
    const r = await writer.applyOperation(ref, update('alias.txt', 'hello\n', 'world\n'));
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/symlinked target/);
    expect(isSymlink(join(ref.rootPath, 'alias.txt'))).toBe(true);
    expect(readFileSync(join(ref.rootPath, 'real.txt'), 'utf8')).toBe('hello\n');
  });

  it('refuses a symlinked directory even when it points inside the root', async () => {
    const ref = ws();
    mkdirSync(join(ref.rootPath, 'src'));
    symlinkSync(join(ref.rootPath, 'src'), join(ref.rootPath, 'alias'));
    const r = await writer.applyOperation(ref, add('alias/new.txt', 'x\n'));
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/symlinked directory/);
    expect(readdirSync(join(ref.rootPath, 'src'))).toEqual([]);
  });

  it('refuses a dangling symlinked target; the link is kept and its outside target is never created', async () => {
    const ref = ws();
    const outside = tempDir('quoky-wswrite-outside-');
    const target = join(outside, 'not-yet.txt');
    symlinkSync(target, join(ref.rootPath, 'dangling.txt'));
    const r = await writer.applyOperation(ref, add('dangling.txt', 'pwned\n'));
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/symlinked target/);
    expect(existsSync(target)).toBe(false);
    expect(readlinkSync(join(ref.rootPath, 'dangling.txt'))).toBe(target);
  });

  it('refuses a new file under a dangling symlinked parent', async () => {
    const ref = ws();
    const outside = tempDir('quoky-wswrite-outside-');
    symlinkSync(join(outside, 'missing-dir'), join(ref.rootPath, 'link'));
    const r = await writer.applyOperation(ref, add('link/new.txt', 'pwned\n'));
    expect(r.status).toBe('failed');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to delete a symlinked target; the link and its target survive', async () => {
    const ref = ws();
    writeFileSync(join(ref.rootPath, 'real.txt'), 'keep\n');
    symlinkSync(join(ref.rootPath, 'real.txt'), join(ref.rootPath, 'alias.txt'));
    const r = await writer.applyOperation(ref, { path: 'alias.txt', operation: 'delete', diff: '' });
    expect(r.status).toBe('failed');
    expect(isSymlink(join(ref.rootPath, 'alias.txt'))).toBe(true);
    expect(readFileSync(join(ref.rootPath, 'real.txt'), 'utf8')).toBe('keep\n');
  });

  it('never writes through a pre-planted temp-name symlink (temp names are unique and exclusive)', async () => {
    const ref = ws();
    const outside = tempDir('quoky-wswrite-outside-');
    writeFileSync(join(outside, 'victim.txt'), 'original\n');
    writeFileSync(join(ref.rootPath, 'a.txt'), 'hello\n');
    // The old fixed temp name `<abs>.chunsik-tmp`, planted as a symlink to an external file.
    symlinkSync(join(outside, 'victim.txt'), join(ref.rootPath, 'a.txt.chunsik-tmp'));
    const r = await writer.applyOperation(ref, update('a.txt', 'hello\n', 'world\n'));
    expect(r.status).toBe('applied');
    expect(readFileSync(join(ref.rootPath, 'a.txt'), 'utf8')).toBe('world\n');
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('original\n');
    expect(isSymlink(join(ref.rootPath, 'a.txt'))).toBe(false);
  });

  it('refuses a parent swapped for an external symlink after the checks; nothing escapes, nothing is left behind', async () => {
    const ref = ws();
    const outside = tempDir('quoky-wswrite-outside-');
    mkdirSync(join(ref.rootPath, 'src'));
    writeFileSync(join(ref.rootPath, 'src', 'a.txt'), 'hello\n');
    writeFileSync(join(outside, 'a.txt'), 'hello\n');
    const swapping = new LocalWorkspaceWriter({
      afterOperationCheck: () => {
        renameSync(join(ref.rootPath, 'src'), join(ref.rootPath, 'src-moved'));
        symlinkSync(outside, join(ref.rootPath, 'src'));
      },
    });
    const r = await swapping.applyOperation(ref, update('src/a.txt', 'hello\n', 'pwned\n'));
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/symlinked directory/);
    expect(readdirSync(outside)).toEqual(['a.txt']);
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(readdirSync(join(ref.rootPath, 'src-moved'))).toEqual(['a.txt']);
  });

  it('never clobbers a file that appeared after the checks, and creates no directory a racer already made', async () => {
    const ref = ws();
    mkdirSync(join(ref.rootPath, 'fresh'));
    const racing = new LocalWorkspaceWriter({
      afterOperationCheck: () => writeFileSync(join(ref.rootPath, 'fresh', 'late.txt'), 'raced\n'),
    });
    const r = await racing.applyOperation(ref, add('fresh/late.txt', 'mine\n'));
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/changed since it was checked/);
    expect(readFileSync(join(ref.rootPath, 'fresh', 'late.txt'), 'utf8')).toBe('raced\n');
    expect(readdirSync(join(ref.rootPath, 'fresh'))).toEqual(['late.txt']);

    // A missing parent replaced by an external symlink after the checks: mkdir is never recursive (EEXIST).
    const outside = tempDir('quoky-wswrite-outside-');
    const swapping = new LocalWorkspaceWriter({
      afterOperationCheck: () => symlinkSync(outside, join(ref.rootPath, 'made')),
    });
    const r2 = await swapping.applyOperation(ref, add('made/deep/new.txt', 'pwned\n'));
    expect(r2.status).toBe('failed');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('leaves no temp files behind and keeps the file mode on update', async () => {
    const ref = ws();
    const file = join(ref.rootPath, 'run.sh');
    writeFileSync(file, 'echo a\n');
    chmodSync(file, 0o755);
    const r = await writer.applyOperation(ref, update('run.sh', 'echo a\n', 'echo b\n'));
    expect(r.status).toBe('applied');
    expect(readFileSync(file, 'utf8')).toBe('echo b\n');
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(readdirSync(ref.rootPath)).toEqual(['run.sh']);
  });
});

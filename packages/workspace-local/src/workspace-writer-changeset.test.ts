import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { WorkspaceChangeStatus, WorkspaceWriteManager, ApprovalStatus, PatchStatus } from '@quoky/core';
import type {
  ApprovalRef,
  PatchOperation,
  PatchSet,
  StorageProvider,
  WorkspaceChange,
  WorkspaceRef,
} from '@quoky/core';
import { LocalCloneWorkspaceProvider, LocalWorkspaceWriter } from './index';

// Phase-2 failure injection: the adapter imports these from `node:fs`; every mock passes
// through to the real implementation unless a test overrides it (reset after each test).
const real = vi.hoisted(() => ({ fs: undefined as unknown as typeof import('node:fs') }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  real.fs = actual;
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    linkSync: vi.fn(actual.linkSync),
  };
});
const actualFs = real.fs;

afterEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(actualFs.renameSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync);
  vi.mocked(linkSync).mockReset().mockImplementation(actualFs.linkSync);
});

const created: string[] = [];
afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
function ws(): WorkspaceRef {
  return { id: 'w1', rootPath: tempDir('quoky-changeset-'), kind: 'local-clone' };
}
function unified(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, '', '');
}
function update(path: string, before: string, after: string): PatchOperation {
  return { path, operation: 'update', diff: unified(path, before, after) };
}
function add(path: string, content: string): PatchOperation {
  return { path, operation: 'add', diff: unified(path, '', content) };
}
function read(ref: WorkspaceRef, rel: string): string {
  return readFileSync(join(ref.rootPath, rel), 'utf8');
}
function put(ref: WorkspaceRef, rel: string, content: string): void {
  actualFs.writeFileSync(join(ref.rootPath, rel), content, 'utf8');
}
/** Every entry under `dir`, recursively (incl. dot files), as relative paths. */
function allEntries(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    out.push(rel);
    if (e.isDirectory()) out.push(...allEntries(join(dir, e.name), rel));
  }
  return out.sort();
}
function expectNoTempFiles(ref: WorkspaceRef): void {
  expect(allEntries(ref.rootPath).filter((p) => p.includes('.quoky-tmp-'))).toEqual([]);
}

const writer = new LocalWorkspaceWriter();

describe('LocalWorkspaceWriter.applyChangeSet (ADR-0099) — all-or-nothing', () => {
  it('applies an update + a nested add with exact final contents', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'export const a = 1;\n');
    const r = await writer.applyChangeSet(ref, [
      update('a.ts', 'export const a = 1;\n', 'export const a = 2;\n'),
      add('src/util/helper.ts', 'export const helper = () => 42;\n'),
    ]);
    expect(r.outcome).toBe('applied');
    expect(r.results.map((x) => [x.path, x.operation, x.status, x.message])).toEqual([
      ['a.ts', 'update', 'applied', 'updated'],
      ['src/util/helper.ts', 'add', 'applied', 'created'],
    ]);
    expect(read(ref, 'a.ts')).toBe('export const a = 2;\n');
    expect(read(ref, 'src/util/helper.ts')).toBe('export const helper = () => 42;\n');
    expectNoTempFiles(ref);
  });

  it('two adds into the same new directory share its creation', async () => {
    const ref = ws();
    const r = await writer.applyChangeSet(ref, [add('lib/one.ts', '1\n'), add('lib/two.ts', '2\n')]);
    expect(r.outcome).toBe('applied');
    expect(read(ref, 'lib/one.ts')).toBe('1\n');
    expect(read(ref, 'lib/two.ts')).toBe('2\n');
  });

  it('preserves the file mode of an updated file', async () => {
    const ref = ws();
    put(ref, 'run.sh', 'echo 1\n');
    chmodSync(join(ref.rootPath, 'run.sh'), 0o755);
    const r = await writer.applyChangeSet(ref, [update('run.sh', 'echo 1\n', 'echo 2\n')]);
    expect(r.outcome).toBe('applied');
    expect(statSync(join(ref.rootPath, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('a stale second update leaves BOTH files byte-identical and the add path absent (phase 1)', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'A1\n');
    put(ref, 'b.ts', 'B-CHANGED-ELSEWHERE\n');
    const r = await writer.applyChangeSet(ref, [
      update('a.ts', 'A1\n', 'A2\n'),
      update('b.ts', 'B1\n', 'B2\n'),
      add('new/c.ts', 'C\n'),
    ]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['skipped', 'failed', 'skipped']);
    expect(r.results[1]?.message).toMatch(/did not apply cleanly/);
    expect(read(ref, 'a.ts')).toBe('A1\n');
    expect(read(ref, 'b.ts')).toBe('B-CHANGED-ELSEWHERE\n');
    expect(existsSync(join(ref.rootPath, 'new'))).toBe(false);
    expectNoTempFiles(ref);
  });

  it('a file changed between check and promote fails the compare-and-swap and rolls back', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'A1\n');
    put(ref, 'b.ts', 'B1\n');
    const bAbs = join(ref.rootPath, 'b.ts');
    // An external writer touches b.ts while its result is being staged (after phase 1).
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      actualFs.writeFileSync(file, data, options);
      if (typeof file === 'string' && file.startsWith(`${bAbs}.quoky-tmp-`)) {
        actualFs.writeFileSync(bAbs, 'EXTERNAL\n');
      }
    });
    const r = await writer.applyChangeSet(ref, [
      add('new/c.ts', 'C\n'),
      update('a.ts', 'A1\n', 'A2\n'),
      update('b.ts', 'B1\n', 'B2\n'),
    ]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['rolled_back', 'rolled_back', 'failed']);
    expect(r.results[2]?.message).toMatch(/changed since it was checked/);
    expect(read(ref, 'a.ts')).toBe('A1\n');
    expect(read(ref, 'b.ts')).toBe('EXTERNAL\n'); // never overwritten
    expect(existsSync(join(ref.rootPath, 'new'))).toBe(false);
    expectNoTempFiles(ref);
  });

  it('refuses an add onto an existing file (no clobber)', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'A1\n');
    put(ref, 'README.md', 'keep me\n');
    const r = await writer.applyChangeSet(ref, [update('a.ts', 'A1\n', 'A2\n'), add('README.md', 'overwrite\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[1]).toMatchObject({ status: 'failed' });
    expect(r.results[1]?.message).toMatch(/already exists/);
    expect(read(ref, 'README.md')).toBe('keep me\n');
    expect(read(ref, 'a.ts')).toBe('A1\n');
  });

  it('refuses an add onto an existing secret-named file hidden from list() (no clobber)', async () => {
    const ref = ws();
    mkdirSync(join(ref.rootPath, 'config'));
    put(ref, 'config/api-token.txt', 'REAL-SECRET\n');
    const listed = await new LocalCloneWorkspaceProvider({ workspaceRoot: ref.rootPath }).listFiles(ref);
    expect(listed).not.toContain('config/api-token.txt');
    const r = await writer.applyChangeSet(ref, [add('config/api-token.txt', 'clobbered\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[0]?.status).toBe('failed');
    expect(read(ref, 'config/api-token.txt')).toBe('REAL-SECRET\n');
  });

  it('a no-clobber link failure in phase 2 (path appeared after the check) keeps the other file intact', async () => {
    const ref = ws();
    const raceAbs = join(ref.rootPath, 'race.ts');
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      actualFs.writeFileSync(file, data, options);
      if (typeof file === 'string' && file.startsWith(`${raceAbs}.quoky-tmp-`)) {
        actualFs.writeFileSync(raceAbs, 'THEIRS\n');
      }
    });
    const r = await writer.applyChangeSet(ref, [add('first.ts', '1\n'), add('race.ts', 'OURS\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['rolled_back', 'failed']);
    expect(r.results[1]?.message).toMatch(/already exists/);
    expect(read(ref, 'race.ts')).toBe('THEIRS\n');
    expect(existsSync(join(ref.rootPath, 'first.ts'))).toBe(false);
    expectNoTempFiles(ref);
  });

  it.each(['.env', 'config/.env.local', 'secrets.json', 'deploy/id_rsa', 'service-account.json'])(
    'refuses a secret-named new path: %s',
    async (path) => {
      const ref = ws();
      const r = await writer.applyChangeSet(ref, [add('ok.ts', 'ok\n'), add(path, 'x\n')]);
      expect(r.outcome).toBe('rolled_back');
      expect(r.results[1]?.status).toBe('failed');
      expect(r.results[1]?.message).toMatch(/secret/);
      expect(allEntries(ref.rootPath)).toEqual([]);
    },
  );

  it('refuses a new file under a symlinked parent directory that points outside the root', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    symlinkSync(outside, join(ref.rootPath, 'link'));
    for (const path of ['link/new.ts', 'link/sub/new.ts']) {
      const r = await writer.applyChangeSet(ref, [add(path, 'x\n')]);
      expect(r.outcome).toBe('rolled_back');
      expect(r.results[0]?.message).toMatch(/escapes the workspace root via symlink/);
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to update through a symlinked file', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    actualFs.writeFileSync(join(outside, 'target.ts'), 'T1\n');
    symlinkSync(join(outside, 'target.ts'), join(ref.rootPath, 'alias.ts'));
    const r = await writer.applyChangeSet(ref, [update('alias.ts', 'T1\n', 'T2\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(readFileSync(join(outside, 'target.ts'), 'utf8')).toBe('T1\n');
  });

  it.each(['../escape.ts', '/etc/passwd', '.'])('refuses a path outside the root: %s', async (path) => {
    const ref = ws();
    const r = await writer.applyChangeSet(ref, [add(path, 'x\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[0]?.status).toBe('failed');
    expect(r.results[0]?.message).toMatch(/escape|absolute|root/i);
  });

  it('a delete op rejects the whole set', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'A1\n');
    put(ref, 'gone.ts', 'bye\n');
    const r = await writer.applyChangeSet(ref, [
      update('a.ts', 'A1\n', 'A2\n'),
      { path: 'gone.ts', operation: 'delete', diff: '' },
    ]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['skipped', 'failed']);
    expect(r.results[1]?.message).toMatch(/delete is not allowed/);
    expect(read(ref, 'a.ts')).toBe('A1\n');
    expect(read(ref, 'gone.ts')).toBe('bye\n');
  });

  it('a binary op rejects the whole set', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'A1\n');
    const r = await writer.applyChangeSet(ref, [
      update('a.ts', 'A1\n', 'A2\n'),
      { path: 'img.png', operation: 'add', diff: '', metadata: { binary: true } },
    ]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[1]?.message).toMatch(/binary/);
    expect(read(ref, 'a.ts')).toBe('A1\n');
    expect(existsSync(join(ref.rootPath, 'img.png'))).toBe(false);
  });

  it('refuses a binary pre-image and duplicate paths', async () => {
    const ref = ws();
    actualFs.writeFileSync(join(ref.rootPath, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    const bin = await writer.applyChangeSet(ref, [update('bin.dat', 'A\n', 'B\n')]);
    expect(bin.outcome).toBe('rolled_back');
    expect(bin.results[0]?.message).toMatch(/binary/);
    const dup = await writer.applyChangeSet(ref, [add('x.ts', '1\n'), add('./x.ts', '2\n')]);
    expect(dup.outcome).toBe('rolled_back');
    expect(dup.results[1]?.message).toMatch(/duplicate/);
    expect(existsSync(join(ref.rootPath, 'x.ts'))).toBe(false);
  });

  it('enforces the operation-count, per-file and total byte bounds', async () => {
    const ref = ws();
    const six = Array.from({ length: 6 }, (_, i) => add(`f${i}.ts`, `${i}\n`));
    const tooMany = await writer.applyChangeSet(ref, six);
    expect(tooMany.outcome).toBe('rolled_back');
    expect(tooMany.results).toHaveLength(6);
    expect(tooMany.results.every((x) => x.status === 'failed' && /too many files/.test(x.message))).toBe(true);

    const empty = await writer.applyChangeSet(ref, []);
    expect(empty).toEqual({ outcome: 'rolled_back', results: [] });

    const big = await writer.applyChangeSet(ref, [add('big.ts', `${'x'.repeat(64 * 1024)}\n`)]);
    expect(big.results[0]?.message).toMatch(/too large/);

    put(ref, 'large.ts', `${'y'.repeat(64 * 1024 + 1)}`);
    const largePre = await writer.applyChangeSet(ref, [update('large.ts', 'y', 'z')]);
    expect(largePre.results[0]?.message).toMatch(/too large/);

    const sixtyK = (c: string): string => `${c.repeat(60 * 1024)}\n`;
    const total = await writer.applyChangeSet(
      ref,
      ['a', 'b', 'c', 'd', 'e'].map((c) => add(`t-${c}.ts`, sixtyK(c))),
    );
    expect(total.outcome).toBe('rolled_back');
    expect(total.results[4]?.message).toMatch(/in total/);
    expect(allEntries(ref.rootPath)).toEqual(['large.ts']);
  });

  it('an injected rename failure in phase 2 restores the pre-images and removes created directories', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'A1\n');
    put(ref, 'b.ts', 'B1\n');
    mkdirSync(join(ref.rootPath, 'existing'));
    let renames = 0;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      renames++;
      if (renames === 2) throw new Error('EIO: injected rename failure');
      actualFs.renameSync(from, to);
    });
    const r = await writer.applyChangeSet(ref, [
      add('existing/deep/nested/x.ts', 'X\n'),
      update('a.ts', 'A1\n', 'A2\n'),
      update('b.ts', 'B1\n', 'B2\n'),
    ]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['rolled_back', 'rolled_back', 'failed']);
    expect(r.results[2]?.message).toMatch(/injected rename failure/);
    expect(read(ref, 'a.ts')).toBe('A1\n');
    expect(read(ref, 'b.ts')).toBe('B1\n');
    // Only the directories this apply created are removed; the pre-existing one stays.
    expect(allEntries(ref.rootPath)).toEqual(['a.ts', 'b.ts', 'existing']);
  });

  it('an injected restore failure reports rollback_failed (may have applied)', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'A1\n');
    put(ref, 'b.ts', 'B1\n');
    let renames = 0;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      renames++;
      if (renames === 2) throw new Error('EIO: injected rename failure');
      if (renames === 3) throw new Error('EIO: injected restore failure');
      actualFs.renameSync(from, to);
    });
    const r = await writer.applyChangeSet(ref, [update('a.ts', 'A1\n', 'A2\n'), update('b.ts', 'B1\n', 'B2\n')]);
    expect(r.outcome).toBe('rollback_failed');
    expect(r.results.map((x) => x.status)).toEqual(['applied', 'failed']);
    expect(r.results[0]?.message).toMatch(/rollback failed, the change may have applied/);
    expect(read(ref, 'a.ts')).toBe('A2\n');
    expect(read(ref, 'b.ts')).toBe('B1\n');
    expectNoTempFiles(ref);
  });

  it('a failed temp-file stage (phase 2) writes nothing and leaves no temp files', async () => {
    const ref = ws();
    put(ref, 'a.ts', 'A1\n');
    let writes = 0;
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      writes++;
      if (writes === 2) throw new Error('ENOSPC: injected write failure');
      actualFs.writeFileSync(file, data, options);
    });
    const r = await writer.applyChangeSet(ref, [update('a.ts', 'A1\n', 'A2\n'), add('n/b.ts', 'B\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['skipped', 'failed']);
    expect(allEntries(ref.rootPath)).toEqual(['a.ts']);
    expect(read(ref, 'a.ts')).toBe('A1\n');
  });

  it('never throws: an unexpected fs error is encoded in the result', async () => {
    const ref = ws();
    vi.mocked(linkSync).mockImplementation(() => {
      throw new Error('EPERM: injected link failure');
    });
    const r = await writer.applyChangeSet(ref, [add('x.ts', 'X\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[0]?.message).toMatch(/injected link failure/);
    expect(allEntries(ref.rootPath)).toEqual([]);
  });
});

describe('LocalWorkspaceWriter.applyChangeSet (ADR-0099) — write-time no-follow containment', () => {
  /** Replace the in-root directory `rel` by a symlink to `target`, keeping the original as `<rel>-moved`. */
  function swapDirForSymlink(ref: WorkspaceRef, rel: string, target: string): void {
    actualFs.renameSync(join(ref.rootPath, rel), join(ref.rootPath, `${rel}-moved`));
    symlinkSync(target, join(ref.rootPath, rel));
  }

  it('a checked parent swapped for an external symlink between plan and apply is refused; nothing escapes', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    put(ref, 'a.ts', 'A1\n');
    mkdirSync(join(ref.rootPath, 'dir'));
    const swapping = new LocalWorkspaceWriter({ afterPlan: () => swapDirForSymlink(ref, 'dir', outside) });
    const r = await swapping.applyChangeSet(ref, [update('a.ts', 'A1\n', 'A2\n'), add('dir/new.ts', 'N\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['skipped', 'failed']);
    expect(r.results[1]?.message).toMatch(/symlinked directory/);
    expect(readdirSync(outside)).toEqual([]);
    expect(read(ref, 'a.ts')).toBe('A1\n');
    expect(allEntries(join(ref.rootPath, 'dir-moved'))).toEqual([]);
    expectNoTempFiles(ref);
  });

  it('a missing parent replaced by an external symlink between plan and apply is refused (mkdir never follows)', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    const swapping = new LocalWorkspaceWriter({ afterPlan: () => symlinkSync(outside, join(ref.rootPath, 'fresh')) });
    const r = await swapping.applyChangeSet(ref, [add('fresh/sub/new.ts', 'N\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[0]?.status).toBe('failed');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a parent swapped while the temp file is written: the escaped temp is detected and removed', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    mkdirSync(join(ref.rootPath, 'dir'));
    const tmpPrefix = `${join(ref.rootPath, 'dir', 'new.ts')}.quoky-tmp-`;
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (typeof file === 'string' && file.startsWith(tmpPrefix)) swapDirForSymlink(ref, 'dir', outside);
      actualFs.writeFileSync(file, data, options);
    });
    const r = await writer.applyChangeSet(ref, [add('dir/new.ts', 'N\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[0]?.message).toMatch(/symlinked directory/);
    expect(readdirSync(outside)).toEqual([]); // the temp that landed outside was ours, and it is gone
  });

  it('a parent swapped after staging (before promote) is refused and the earlier promote is restored', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    put(ref, 'a.ts', 'A1\n');
    mkdirSync(join(ref.rootPath, 'dir'));
    const swapping = new LocalWorkspaceWriter({ afterStage: () => swapDirForSymlink(ref, 'dir', outside) });
    const r = await swapping.applyChangeSet(ref, [update('a.ts', 'A1\n', 'A2\n'), add('dir/new.ts', 'N\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['rolled_back', 'failed']);
    expect(r.results[1]?.message).toMatch(/symlinked directory/);
    expect(read(ref, 'a.ts')).toBe('A1\n');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a parent swapped during the add promote: the escaped file is detected and removed by identity', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    put(ref, 'a.ts', 'A1\n');
    mkdirSync(join(ref.rootPath, 'dir'));
    const target = join(ref.rootPath, 'dir', 'new.ts');
    vi.mocked(linkSync).mockImplementation((from, to) => {
      if (to !== target) return actualFs.linkSync(from, to);
      // The race: the source resolves before the swap, the destination after it — the link lands outside.
      swapDirForSymlink(ref, 'dir', outside);
      actualFs.linkSync(String(from).replace(`${join(ref.rootPath, 'dir')}/`, `${join(ref.rootPath, 'dir-moved')}/`), to);
    });
    const r = await writer.applyChangeSet(ref, [update('a.ts', 'A1\n', 'A2\n'), add('dir/new.ts', 'N\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results.map((x) => x.status)).toEqual(['rolled_back', 'failed']);
    expect(r.results[1]?.message).toMatch(/symlinked directory/);
    expect(read(ref, 'a.ts')).toBe('A1\n');
    expect(readdirSync(outside)).toEqual([]); // the hard link that escaped was ours (same inode), and it is gone
  });

  it('rollback never removes or overwrites a file it did not create, even behind a swapped parent', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    actualFs.writeFileSync(join(outside, 'new.ts'), 'EXTERNAL\n');
    put(ref, 'b.ts', 'B1\n');
    mkdirSync(join(ref.rootPath, 'dir'));
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === join(ref.rootPath, 'b.ts')) {
        // After dir/new.ts was promoted: swap its parent for a symlink to a directory holding a same-named file.
        swapDirForSymlink(ref, 'dir', outside);
        throw new Error('EIO: injected rename failure');
      }
      actualFs.renameSync(from, to);
    });
    const r = await writer.applyChangeSet(ref, [add('dir/new.ts', 'N\n'), update('b.ts', 'B1\n', 'B2\n')]);
    expect(r.outcome).toBe('rollback_failed');
    expect(r.results[0]?.status).toBe('applied');
    expect(r.results[0]?.message).toMatch(/rollback failed, the change may have applied/);
    expect(readFileSync(join(outside, 'new.ts'), 'utf8')).toBe('EXTERNAL\n');
    expect(read(ref, 'b.ts')).toBe('B1\n');
  });

  it('an update target swapped for a symlink between plan and apply is refused; the external file is untouched', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    actualFs.writeFileSync(join(outside, 'target.ts'), 'A1\n');
    put(ref, 'a.ts', 'A1\n');
    const swapping = new LocalWorkspaceWriter({
      afterPlan: () => {
        actualFs.unlinkSync(join(ref.rootPath, 'a.ts'));
        symlinkSync(join(outside, 'target.ts'), join(ref.rootPath, 'a.ts'));
      },
    });
    const r = await swapping.applyChangeSet(ref, [update('a.ts', 'A1\n', 'A2\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[0]?.message).toMatch(/not a regular file/);
    expect(readFileSync(join(outside, 'target.ts'), 'utf8')).toBe('A1\n');
    expectNoTempFiles(ref);
  });

  it('an add target that appears as a (dangling) symlink after planning is refused; nothing is created outside', async () => {
    const ref = ws();
    const outside = tempDir('quoky-changeset-outside-');
    const swapping = new LocalWorkspaceWriter({
      afterPlan: () => symlinkSync(join(outside, 'created.ts'), join(ref.rootPath, 'new.ts')),
    });
    const r = await swapping.applyChangeSet(ref, [add('new.ts', 'N\n')]);
    expect(r.outcome).toBe('rolled_back');
    expect(r.results[0]?.message).toMatch(/already exists/);
    expect(readdirSync(outside)).toEqual([]);
    expectNoTempFiles(ref);
  });

  it('refuses a symlinked directory component even when it points inside the root', async () => {
    const ref = ws();
    mkdirSync(join(ref.rootPath, 'real'));
    symlinkSync(join(ref.rootPath, 'real'), join(ref.rootPath, 'alias'));
    for (const path of ['alias/new.ts', 'alias/sub/new.ts']) {
      const r = await writer.applyChangeSet(ref, [add(path, 'x\n')]);
      expect(r.outcome).toBe('rolled_back');
      expect(r.results[0]?.message).toMatch(/symlinked directory/);
    }
    expect(readdirSync(join(ref.rootPath, 'real'))).toEqual([]);
  });
});

/** In-memory WorkspaceChange storage for the manager integration. */
function memoryStorage(): StorageProvider {
  const rows = new Map<string, WorkspaceChange>();
  return {
    workspaceChanges: {
      async get(id: string) {
        return rows.get(id) ?? null;
      },
      async save(c: WorkspaceChange) {
        rows.set(c.id, c);
        return c;
      },
      async delete(id: string) {
        rows.delete(id);
      },
      async list() {
        return [...rows.values()];
      },
      async findByPatchSet(patchSetId: string) {
        return [...rows.values()].filter((c) => c.patchRef.id === patchSetId);
      },
    },
  } as unknown as StorageProvider;
}

describe('WorkspaceWriteManager.applyChangeSet + LocalWorkspaceWriter (ADR-0099)', () => {
  const planRef = { id: 'plan-1', goal: 'edit two files' };
  const approvalRef: ApprovalRef = { id: 'appr-1', status: ApprovalStatus.APPROVED, executionPlanRef: planRef };
  function patchSet(operations: PatchOperation[]): PatchSet {
    return {
      id: 'patch-1',
      executionPlanRef: planRef,
      approvalRef,
      operations,
      status: PatchStatus.GENERATED,
      createdAt: '2026-10-02T00:00:00.000Z',
    };
  }

  it('APPLIED on success, ROLLED_BACK on a stale file, PARTIALLY_APPLIED on a failed restore', async () => {
    const ok = ws();
    put(ok, 'a.ts', 'A1\n');
    const applied = await new WorkspaceWriteManager(memoryStorage(), writer).applyChangeSet({
      patchSet: patchSet([update('a.ts', 'A1\n', 'A2\n'), add('b.ts', 'B\n')]),
      approvalRef,
      workspaceRef: ok,
    });
    expect(applied.status).toBe(WorkspaceChangeStatus.APPLIED);
    expect(read(ok, 'b.ts')).toBe('B\n');

    const stale = ws();
    put(stale, 'a.ts', 'OTHER\n');
    const rolledBack = await new WorkspaceWriteManager(memoryStorage(), writer).applyChangeSet({
      patchSet: patchSet([update('a.ts', 'A1\n', 'A2\n'), add('b.ts', 'B\n')]),
      approvalRef,
      workspaceRef: stale,
    });
    expect(rolledBack.status).toBe(WorkspaceChangeStatus.ROLLED_BACK);
    expect(existsSync(join(stale.rootPath, 'b.ts'))).toBe(false);

    const partial = ws();
    put(partial, 'a.ts', 'A1\n');
    put(partial, 'b.ts', 'B1\n');
    let renames = 0;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      renames++;
      if (renames >= 2) throw new Error('EIO: injected');
      actualFs.renameSync(from, to);
    });
    const partiallyApplied = await new WorkspaceWriteManager(memoryStorage(), writer).applyChangeSet({
      patchSet: patchSet([update('a.ts', 'A1\n', 'A2\n'), update('b.ts', 'B1\n', 'B2\n')]),
      approvalRef,
      workspaceRef: partial,
    });
    expect(partiallyApplied.status).toBe(WorkspaceChangeStatus.PARTIALLY_APPLIED);
    expectNoTempFiles(partial);
  });
});

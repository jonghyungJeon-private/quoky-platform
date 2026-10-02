import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRef } from '@quoky/core';
import { DEFAULT_WORKSPACE_POLICY, LocalCloneWorkspaceProvider } from './index';

const provider = new LocalCloneWorkspaceProvider({ workspaceRoot: tmpdir() });
const created: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'quoky-scan-'));
  created.push(d);
  return d;
}

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

describe('LocalCloneWorkspaceProvider.scanProject (ADR-0018, read-only)', () => {
  it('returns exists=false for a non-existent path', async () => {
    const scan = await provider.scanProject('/definitely/not/here/quoky-xyz');
    expect(scan.exists).toBe(false);
    expect(scan.gitBranch).toBe('unknown');
  });

  it('scans a non-git directory: branch unknown, detects the package manager', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'package.json'), '{}');
    const scan = await provider.scanProject(dir);
    expect(scan.exists).toBe(true);
    expect(scan.gitBranch).toBe('unknown');
    expect(scan.packageManager).toBe('pnpm');
  });

  it('excludes node_modules/dist/build/.git/coverage from the file tree summary', async () => {
    const dir = tempDir();
    for (const d of ['node_modules', 'dist', 'build', 'coverage', 'src']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'README.md'), '#');
    const scan = await provider.scanProject(dir);
    expect(scan.fileTreeSummary).toContain('src/');
    expect(scan.fileTreeSummary).toContain('README.md');
    expect(scan.fileTreeSummary).not.toContain('node_modules');
    expect(scan.fileTreeSummary).not.toContain('dist');
    expect(scan.fileTreeSummary).not.toContain('coverage');
  });
});

describe('LocalCloneWorkspaceProvider.readProjectFiles (ADR-0019, gated read-only)', () => {
  it('reads only allow-listed metadata files; ignores non-allow-listed ones', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'README.md'), '# hi');
    writeFileSync(join(dir, 'index.ts'), 'export const x = 1;');
    const readout = await provider.readProjectFiles(dir);
    const paths = readout.files.map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('tsconfig.json');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('index.ts'); // source code is not in the allow-list
  });

  it('never reads env / secret-looking files', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, '.env'), 'DISCORD_BOT_TOKEN=abc');
    writeFileSync(join(dir, '.env.local'), 'SECRET=zzz');
    writeFileSync(join(dir, 'my-secret.json'), '{"token":"zzz"}');
    const readout = await provider.readProjectFiles(dir);
    const blob = JSON.stringify(readout.files);
    expect(blob).not.toContain('DISCORD_BOT_TOKEN');
    expect(blob).not.toContain('SECRET=zzz');
    expect(readout.files.map((f) => f.path)).not.toContain('my-secret.json');
  });

  it('caps each file at the size limit and flags truncation', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), 'x'.repeat(20000));
    const readout = await provider.readProjectFiles(dir);
    const pkg = readout.files.find((f) => f.path === 'package.json');
    expect(pkg?.truncated).toBe(true);
    expect(pkg?.content.length).toBe(8000);
  });

  it('includes a 2-level tree (root + apps/ + packages/), excluding ignored dirs', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'quoky'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    const readout = await provider.readProjectFiles(dir);
    expect(readout.tree).toContain('packages/core/');
    expect(readout.tree).toContain('apps/quoky/');
    expect(readout.tree).not.toContain('node_modules');
  });

  it('returns an empty readout for a non-existent path (no throw)', async () => {
    const readout = await provider.readProjectFiles('/definitely/not/here/quoky-xyz');
    expect(readout.files).toEqual([]);
  });
});

describe('LocalCloneWorkspaceProvider — v2 Workspace capability (ADR-0022, read-only)', () => {
  function ref(rootPath: string): WorkspaceRef {
    return { id: 'w1', rootPath, kind: 'local-clone' };
  }

  it('resolve() returns the ref for a real directory and rejects a non-directory', async () => {
    const dir = tempDir();
    await expect(provider.resolve(ref(dir))).resolves.toMatchObject({ rootPath: dir });
    await expect(provider.resolve(ref('/definitely/not/here/xyz'))).rejects.toThrow();
  });

  it('readFile() reads a file within the root', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    expect(await provider.readFile(ref(dir), 'a.txt')).toBe('hello');
  });

  it('readFile() rejects path traversal and absolute paths', async () => {
    const dir = tempDir();
    await expect(provider.readFile(ref(dir), '../../../etc/passwd')).rejects.toThrow(/escapes|not a file/);
    await expect(provider.readFile(ref(dir), '/etc/passwd')).rejects.toThrow(/absolute/);
  });

  it('readFile() refuses secret-named files', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'DISCORD_BOT_TOKEN=zzz');
    await expect(provider.readFile(ref(dir), '.env')).rejects.toThrow(/secret/);
  });

  it.each([
    'config/service-account.json',
    'gcp-service_account-prod.json',
    'credentials.json',
    'server.pem',
    'tls.key',
    'client.p12',
    'cert.pfx',
    'release.keystore',
    'release.jks',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.git-credentials',
    'secrets.yaml',
  ])('readFile() refuses the conventional credential file %s', async (relPath) => {
    const dir = tempDir();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, relPath), 'redacted');
    await expect(provider.readFile(ref(dir), relPath)).rejects.toThrow(/secret/);
  });

  it.each(['package.json', 'account.ts', 'service.json', 'pem-notes.md', 'README.md', 'id.ts'])(
    'does not treat %s as a credential file name',
    (name) => {
      expect(DEFAULT_WORKSPACE_POLICY.isSecret(name)).toBe(false);
    },
  );

  it('readFile() enforces the large-file guard', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(300_000));
    await expect(provider.readFile(ref(dir), 'big.txt')).rejects.toThrow(/too large/);
  });

  it('readFile() refuses binary content', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    await expect(provider.readFile(ref(dir), 'bin')).rejects.toThrow(/binary/);
  });

  it('listFiles() returns relative files, excluding ignored dirs and secrets', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'src', 'index.ts'), '1');
    writeFileSync(join(dir, 'README.md'), '#');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'node_modules', 'dep.js'), '1');
    const files = await provider.listFiles(ref(dir));
    expect(files).toContain('src/index.ts');
    expect(files).toContain('README.md');
    expect(files).not.toContain('.env');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('listFiles() applies a glob filter', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), '1');
    writeFileSync(join(dir, 'src', 'b.js'), '1');
    const ts = await provider.listFiles(ref(dir), '**/*.ts');
    expect(ts).toEqual(['src/a.ts']);
  });

  it('diff() generates a unified diff for add / modify / delete', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'mod.txt'), 'old line\n');
    writeFileSync(join(dir, 'del.txt'), 'gone\n');
    const out = await provider.diff(ref(dir), [
      { path: 'new.txt', newContent: 'fresh\n' },
      { path: 'mod.txt', newContent: 'new line\n' },
      { path: 'del.txt', delete: true },
    ]);
    expect(out.truncated).toBe(false);
    expect(out.estimatedChangedLines).toBeGreaterThan(0); // add+modify+delete all change lines
    const byPath = Object.fromEntries(out.files.map((f) => [f.path, f]));
    expect(byPath['new.txt'].changeKind).toBe('add');
    expect(byPath['new.txt'].unified).toContain('+fresh');
    expect(byPath['mod.txt'].changeKind).toBe('modify');
    expect(byPath['mod.txt'].unified).toContain('-old line');
    expect(byPath['mod.txt'].unified).toContain('+new line');
    expect(byPath['del.txt'].changeKind).toBe('delete');
    expect(byPath['del.txt'].unified).toContain('-gone');
  });

  it('diff() flags binary and large files instead of diffing them', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bin'), Buffer.from([0x00, 0x01, 0x02]));
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(300_000));
    const out = await provider.diff(ref(dir), [
      { path: 'bin', newContent: 'still\nbinary?' },
      { path: 'big.txt', newContent: 'small' },
    ]);
    expect(out.files.find((f) => f.path === 'bin')?.binary).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.files.find((f) => f.path === 'big.txt')?.unified).toBe('');
    expect(out.estimatedChangedLines).toBe(0); // binary + oversized contribute nothing
  });

  it('diff() estimates changed lines from the unified hunks', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const out = await provider.diff(ref(dir), [{ path: 'a.txt', newContent: 'one\nTWO\nthree\nfour\n' }]);
    // one line changed (two→TWO) = -1/+1, plus one added (four) = +1 → 3 changed lines
    expect(out.estimatedChangedLines).toBe(3);
  });

  it('diff() rejects paths escaping the workspace root', async () => {
    const dir = tempDir();
    await expect(provider.diff(ref(dir), [{ path: '../evil.txt', newContent: 'x' }])).rejects.toThrow(
      /escapes|absolute/,
    );
  });
});

import { describe, expect, it } from 'vitest';
import type { WorkspaceRef } from '../domain';
import {
  MAX_CODEGEN_CONTEXT_FILE_BYTES,
  MAX_CODEGEN_CONTEXT_TOTAL_BYTES,
  readCodeGenerationContextFiles,
} from './code-generation-context';

const REF: WorkspaceRef = { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' };

function reader(contents: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    async read(_ref: WorkspaceRef, relPath: string): Promise<string> {
      reads.push(relPath);
      const c = contents[relPath];
      if (c === undefined) throw new Error(`ENOENT ${relPath}`);
      return c;
    },
  };
}

describe('readCodeGenerationContextFiles (QA-012)', () => {
  it('returns current content per target in order, deduplicated by normalized path', async () => {
    const ws = reader({ 'src/a.js': 'A', './src/a.js': 'A', 'src/b.js': 'B' });
    const out = await readCodeGenerationContextFiles(ws, REF, ['src/a.js', './src/a.js', 'src/b.js']);
    expect(out).toEqual({ ok: true, contextFiles: [{ path: 'src/a.js', content: 'A' }, { path: 'src/b.js', content: 'B' }] });
    expect(ws.reads).toEqual(['src/a.js', 'src/b.js']);
  });

  it('skips explicit new-file targets without reading them', async () => {
    const ws = reader({ 'src/a.js': 'A' });
    const out = await readCodeGenerationContextFiles(ws, REF, ['src/a.js', 'src/new.js'], ['./src/new.js']);
    expect(out).toEqual({ ok: true, contextFiles: [{ path: 'src/a.js', content: 'A' }] });
    expect(ws.reads).toEqual(['src/a.js']);
  });

  it('an unreadable target fails with its index only (no path/content/error text)', async () => {
    const out = await readCodeGenerationContextFiles(reader({ 'src/a.js': 'A' }), REF, ['src/a.js', 'src/gone.js']);
    expect(out).toEqual({ ok: false, reason: 'target-read-failed', targetIndex: 1 });
  });

  it('accepts a file exactly at the per-file cap and rejects one byte over', async () => {
    const at = 'a'.repeat(MAX_CODEGEN_CONTEXT_FILE_BYTES);
    expect((await readCodeGenerationContextFiles(reader({ f: at }), REF, ['f'])).ok).toBe(true);
    expect(await readCodeGenerationContextFiles(reader({ f: at + 'a' }), REF, ['f'])).toEqual({
      ok: false, reason: 'target-too-large', targetIndex: 0,
    });
  });

  it('rejects when the running total exceeds the total cap', async () => {
    const chunk = 'b'.repeat(MAX_CODEGEN_CONTEXT_FILE_BYTES);
    const files = Object.fromEntries(['f1', 'f2', 'f3', 'f4', 'f5'].map((f) => [f, chunk]));
    expect(MAX_CODEGEN_CONTEXT_TOTAL_BYTES).toBe(4 * MAX_CODEGEN_CONTEXT_FILE_BYTES);
    expect((await readCodeGenerationContextFiles(reader(files), REF, ['f1', 'f2', 'f3', 'f4'])).ok).toBe(true);
    expect(await readCodeGenerationContextFiles(reader(files), REF, ['f1', 'f2', 'f3', 'f4', 'f5'])).toEqual({
      ok: false, reason: 'context-total-too-large', targetIndex: 4,
    });
  });

  it('refuses a target whose CONTENT carries credential material (name passes the workspace policy)', async () => {
    const key = '{ "type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n" }';
    const ws = reader({ 'src/a.js': 'A', 'config/app.json': key });
    expect(await readCodeGenerationContextFiles(ws, REF, ['src/a.js', 'config/app.json'])).toEqual({
      ok: false, reason: 'target-contains-credential', targetIndex: 1, targetPath: 'config/app.json',
    });
  });

  it.each(['{"password":"demo-value"}', 'DB_PASSWORD=hunter2', 'const k = "AKIAIOSFODNN7EXAMPLE";'])(
    'refuses credential content %j',
    async (content) => {
      const out = await readCodeGenerationContextFiles(reader({ f: content }), REF, ['f']);
      expect(out).toMatchObject({ ok: false, reason: 'target-contains-credential', targetIndex: 0 });
    },
  );
});

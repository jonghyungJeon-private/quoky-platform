import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkspaceRef } from '../domain';
import {
  type CredentialOverrideGrant,
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
      detector: 'secret-token', overridable: false,
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

// ADR-0097 D3/D5/D6: detector-aware refusals and hash-bound, consumed override grants.
describe('readCodeGenerationContextFiles credential override grants (ADR-0097)', () => {
  const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  // Line 3 carries a credential-named key assigned a literal (credential-assignment, not a token shape).
  const ASSIGN = 'export const a = 1;\n\nconst password = "demo-value";\n';
  const TOKEN = 'const k = "AKIAIOSFODNN7EXAMPLE";\n';
  const grant = (path: string, content: string, over: Partial<CredentialOverrideGrant> = {}): CredentialOverrideGrant => ({
    path, contentSha256: sha(content), detector: 'credential-assignment', line: 3, state: 'CONSUMED', ...over,
  });

  it('assignment without a grant → overridable refusal with the independent SHA-256 and the line', async () => {
    const out = await readCodeGenerationContextFiles(reader({ 'src/a.ts': ASSIGN }), REF, ['src/a.ts']);
    expect(out).toEqual({
      ok: false, reason: 'target-contains-credential', targetIndex: 0, targetPath: 'src/a.ts',
      detector: 'credential-assignment', overridable: true, contentSha256: sha(ASSIGN), line: 3,
    });
    expect(sha(ASSIGN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the 4-argument call (no options) keeps the strict refusal', async () => {
    const out = await readCodeGenerationContextFiles(reader({ f: ASSIGN }), REF, ['f'], []);
    expect(out).toMatchObject({ ok: false, reason: 'target-contains-credential', overridable: true });
  });

  it('secret-token is never overridable, even with a grant for that path and its exact hash', async () => {
    const out = await readCodeGenerationContextFiles(reader({ 'src/k.ts': TOKEN }), REF, ['src/k.ts'], [], {
      credentialOverrides: [grant('src/k.ts', TOKEN, { line: 1 })],
    });
    expect(out).toEqual({
      ok: false, reason: 'target-contains-credential', targetIndex: 0, targetPath: 'src/k.ts',
      detector: 'secret-token', overridable: false,
    });
  });

  it('a consumed grant with matching path, hash and line admits the file', async () => {
    const ws = reader({ 'src/b.ts': 'B', 'src/a.ts': ASSIGN });
    const out = await readCodeGenerationContextFiles(ws, REF, ['src/b.ts', 'src/a.ts'], [], {
      credentialOverrides: [grant('src/a.ts', ASSIGN)],
    });
    expect(out).toEqual({
      ok: true, contextFiles: [{ path: 'src/b.ts', content: 'B' }, { path: 'src/a.ts', content: ASSIGN }],
    });
  });

  it('a grant whose hash no longer matches → target-changed-since-override (no fresh prompt)', async () => {
    const edited = ASSIGN.replace('demo-value', 'other-value');
    const out = await readCodeGenerationContextFiles(reader({ 'src/a.ts': edited }), REF, ['src/a.ts'], [], {
      credentialOverrides: [grant('src/a.ts', ASSIGN)],
    });
    expect(out).toEqual({ ok: false, reason: 'target-changed-since-override', targetIndex: 0, targetPath: 'src/a.ts' });
  });

  it('a grant whose recorded line differs is not admitted', async () => {
    const out = await readCodeGenerationContextFiles(reader({ 'src/a.ts': ASSIGN }), REF, ['src/a.ts'], [], {
      credentialOverrides: [grant('src/a.ts', ASSIGN, { line: 1 })],
    });
    expect(out).toMatchObject({ ok: false, reason: 'target-changed-since-override', targetIndex: 0 });
  });

  it('a grant for path A does not admit path B with the same content', async () => {
    const ws = reader({ 'src/a.ts': ASSIGN, 'src/b.ts': ASSIGN });
    const out = await readCodeGenerationContextFiles(ws, REF, ['src/a.ts', 'src/b.ts'], [], {
      credentialOverrides: [grant('src/a.ts', ASSIGN)],
    });
    expect(out).toMatchObject({
      ok: false, reason: 'target-contains-credential', targetIndex: 1, targetPath: 'src/b.ts', overridable: true,
    });
  });

  it.each([
    ['./src/a.ts', 'src/a.ts'],
    ['src/a.ts', './src/a.ts'],
    ['src//a.ts', 'src/a.ts'],
  ])('grant path %j matches target %j after normalization', async (grantPath, targetPath) => {
    const out = await readCodeGenerationContextFiles(reader({ [targetPath]: ASSIGN }), REF, [targetPath], [], {
      credentialOverrides: [grant(grantPath, ASSIGN)],
    });
    expect(out).toEqual({ ok: true, contextFiles: [{ path: targetPath, content: ASSIGN }] });
  });

  it.each([
    ['GRANTED', { state: 'GRANTED' }],
    ['PENDING', { state: 'PENDING' }],
    ['secret-token detector', { detector: 'secret-token' }],
  ])('a grant that is not a consumed credential-assignment grant (%s) is ignored', async (_label, over) => {
    const forged = { ...grant('src/a.ts', ASSIGN), ...over } as unknown as CredentialOverrideGrant;
    const out = await readCodeGenerationContextFiles(reader({ 'src/a.ts': ASSIGN }), REF, ['src/a.ts'], [], {
      credentialOverrides: [forged],
    });
    expect(out).toMatchObject({ ok: false, reason: 'target-contains-credential', overridable: true });
  });

  it('granted files still count toward the per-file cap', async () => {
    const big = ASSIGN + '/'.repeat(MAX_CODEGEN_CONTEXT_FILE_BYTES);
    const out = await readCodeGenerationContextFiles(reader({ f: big }), REF, ['f'], [], {
      credentialOverrides: [grant('f', big)],
    });
    expect(out).toEqual({ ok: false, reason: 'target-too-large', targetIndex: 0 });
  });

  it('granted bytes still count toward the total cap', async () => {
    const granted = ASSIGN + '/'.repeat(MAX_CODEGEN_CONTEXT_FILE_BYTES - ASSIGN.length);
    const chunk = 'b'.repeat(MAX_CODEGEN_CONTEXT_FILE_BYTES);
    const ws = reader({ g: granted, f1: chunk, f2: chunk, f3: chunk, f4: 'x' });
    const opts = { credentialOverrides: [grant('g', granted)] };
    expect((await readCodeGenerationContextFiles(ws, REF, ['g', 'f1', 'f2', 'f3'], [], opts)).ok).toBe(true);
    expect(await readCodeGenerationContextFiles(ws, REF, ['g', 'f1', 'f2', 'f3', 'f4'], [], opts)).toEqual({
      ok: false, reason: 'context-total-too-large', targetIndex: 4,
    });
  });

  it('an unreadable target (e.g. an adapter-refused secret filename) is never admitted by a grant', async () => {
    const out = await readCodeGenerationContextFiles(reader({}), REF, ['.env'], [], {
      credentialOverrides: [grant('.env', ASSIGN)],
    });
    expect(out).toEqual({ ok: false, reason: 'target-read-failed', targetIndex: 0 });
  });

  it.each([
    ['a later secret-token target', { 'src/k.ts': TOKEN }, 'src/k.ts', {
      ok: false, reason: 'target-contains-credential', targetIndex: 1, targetPath: 'src/k.ts',
      detector: 'secret-token', overridable: false,
    }],
    ['a later unreadable (secret filename) target', {}, '.env.local', {
      ok: false, reason: 'target-read-failed', targetIndex: 1,
    }],
    ['a later oversized target', { big: 'z'.repeat(MAX_CODEGEN_CONTEXT_FILE_BYTES + 1) }, 'big', {
      ok: false, reason: 'target-too-large', targetIndex: 1,
    }],
  ])('%s fails the whole set before any override prompt', async (_label, extra, second, expected) => {
    const ws = reader({ 'src/a.ts': ASSIGN, ...extra });
    const out = await readCodeGenerationContextFiles(ws, REF, ['src/a.ts', second]);
    expect(out).toEqual(expected);
  });

  it('a later changed grant fails the set even after an earlier un-granted refusal', async () => {
    const edited = ASSIGN.replace('demo-value', 'other-value');
    const ws = reader({ 'src/a.ts': ASSIGN, 'src/b.ts': edited });
    const out = await readCodeGenerationContextFiles(ws, REF, ['src/a.ts', 'src/b.ts'], [], {
      credentialOverrides: [grant('src/b.ts', ASSIGN)],
    });
    expect(out).toEqual({ ok: false, reason: 'target-changed-since-override', targetIndex: 1, targetPath: 'src/b.ts' });
  });

  it('with several refused targets, the first un-granted one is reported (one override at a time)', async () => {
    const other = 'const apiKey = "demo-value";\n';
    const ws = reader({ 'src/a.ts': ASSIGN, 'src/b.ts': other, 'src/c.ts': 'C' });
    const targets = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    expect(await readCodeGenerationContextFiles(ws, REF, targets)).toMatchObject({
      reason: 'target-contains-credential', targetIndex: 0, targetPath: 'src/a.ts', overridable: true,
    });
    expect(await readCodeGenerationContextFiles(ws, REF, targets, [], {
      credentialOverrides: [grant('src/a.ts', ASSIGN)],
    })).toEqual({
      ok: false, reason: 'target-contains-credential', targetIndex: 1, targetPath: 'src/b.ts',
      detector: 'credential-assignment', overridable: true, contentSha256: sha(other), line: 1,
    });
    expect(await readCodeGenerationContextFiles(ws, REF, targets, [], {
      credentialOverrides: [grant('src/a.ts', ASSIGN), grant('src/b.ts', other, { line: 1 })],
    })).toEqual({
      ok: true,
      contextFiles: [
        { path: 'src/a.ts', content: ASSIGN }, { path: 'src/b.ts', content: other }, { path: 'src/c.ts', content: 'C' },
      ],
    });
  });

  it('a grant for a skipped new-file target reads nothing and admits nothing extra', async () => {
    const ws = reader({ 'src/a.ts': 'A', 'src/new.ts': ASSIGN });
    const out = await readCodeGenerationContextFiles(ws, REF, ['src/a.ts', 'src/new.ts'], ['src/new.ts'], {
      credentialOverrides: [grant('src/new.ts', ASSIGN)],
    });
    expect(out).toEqual({ ok: true, contextFiles: [{ path: 'src/a.ts', content: 'A' }] });
    expect(ws.reads).toEqual(['src/a.ts']);
  });

  it('a refusal never carries the matched value', async () => {
    const out = await readCodeGenerationContextFiles(reader({ 'src/a.ts': ASSIGN }), REF, ['src/a.ts']);
    expect(JSON.stringify(out)).not.toContain('demo-value');
  });
});

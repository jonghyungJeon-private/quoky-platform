import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { failSafeConnectorWriteTransportGuard } from './connector-write.port';

/**
 * UNC-1 review (Codex P2): Core owns only the neutral outcome contract (`ConnectorWriteTransportGuard`, NOT_SENT /
 * UNCERTAIN semantics). Transport specifics — the HTTP client library and Node's diagnostics channels — live in the
 * composition root (`apps/quoky/src/connector-write-transport.ts`). This scan keeps it that way.
 */
const CORE_SRC = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && path !== SELF ? [path] : [];
  });
}

describe('Core transport neutrality (UNC-1)', () => {
  it('no Core source imports node:diagnostics_channel or mentions the undici HTTP client', () => {
    const files = sourceFiles(CORE_SRC);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return /diagnostics_channel/.test(text) || /undici/i.test(text);
      })
      .map((file) => relative(CORE_SRC, file));
    expect(offenders).toEqual([]);
  });

  it('the Core default guard is fail safe: every thrown write request is UNCERTAIN', () => {
    const attempt = failSafeConnectorWriteTransportGuard.begin(new URL('https://example.invalid/write'));
    for (const error of [new Error('x'), Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }), undefined]) {
      expect(attempt.classifyFailure(error)).toEqual({ status: 'UNCERTAIN', reason: 'TRANSPORT' });
    }
    attempt.end();
    attempt.end();
  });
});

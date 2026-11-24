import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0125 D6/D11: `packages/adapter-local-client` imports only `@quoky/core`, `@quoky/local-auth` and `node:*`; its
 * HTTP-side modules import only `node:*`, `@quoky/local-auth` and siblings (no Core at all). Core never branches on the
 * platform id, and the package declares exactly those two dependencies.
 */

const SRC = __dirname;
const PACKAGE = path.resolve(SRC, '..');

function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1]) found.push(match[1]);
  return found;
}

const production = readdirSync(SRC).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'test-support.ts');
/** The modules that never touch Core (D6: "its HTTP files"). */
const HTTP_SIDE = ['constants.ts', 'events.ts', 'http.ts', 'idempotency.ts', 'socket.ts'];

describe('adapter-local-client import boundary (ADR-0125 D6)', () => {
  it('lists the production modules', () => {
    expect([...production].sort()).toEqual([
      'constants.ts',
      'events.ts',
      'http.ts',
      'idempotency.ts',
      'index.ts',
      'local-client-platform-adapter.ts',
      'render.ts',
      'socket.ts',
    ]);
  });

  it.each(production)('%s imports only @quoky/core, @quoky/local-auth, node:* and siblings', (file) => {
    for (const specifier of specifiers(readFileSync(path.join(SRC, file), 'utf8'))) {
      const allowed = specifier.startsWith('node:') || specifier === '@quoky/core' || specifier === '@quoky/local-auth' || /^\.\/[a-z-]+$/.test(specifier);
      expect(allowed, `${file} imports ${specifier}`).toBe(true);
    }
  });

  it.each(HTTP_SIDE)('%s (HTTP side) imports only node:*, @quoky/local-auth and siblings', (file) => {
    for (const specifier of specifiers(readFileSync(path.join(SRC, file), 'utf8'))) {
      const allowed = specifier.startsWith('node:') || specifier === '@quoky/local-auth' || /^\.\/[a-z-]+$/.test(specifier);
      expect(allowed, `${file} imports ${specifier}`).toBe(true);
    }
  });

  it('declares exactly the two allowed dependencies and no TCP listener API', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@quoky/core', '@quoky/local-auth']);
    for (const file of production) {
      const source = readFileSync(path.join(SRC, file), 'utf8');
      expect(source, file).not.toMatch(/\bnode:(https?2?|dgram|tls)\b.*createServer|listen\(\s*\d|listen\(\{\s*port|127\.0\.0\.1|0\.0\.0\.0/);
    }
  });

  it('Core never branches on the local-client platform id', () => {
    const coreSrc = path.resolve(PACKAGE, '..', 'core', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && /local-client/.test(readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    walk(coreSrc);
    expect(offenders).toEqual([]);
  });
});

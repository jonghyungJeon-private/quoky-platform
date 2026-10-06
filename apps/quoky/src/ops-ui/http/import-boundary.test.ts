import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0113 D8: `ops-ui/http/*` imports only `node:*` built-ins and its own modules (the view-model types): no Core,
 * Nest, Discord, SQLite, provider or other app import. It receives already-guarded view-model strings.
 */

const HTTP_DIR = __dirname;

function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1]) found.push(match[1]);
  }
  return found;
}

describe('ops-ui/http import boundary (ADR-0113 D8)', () => {
  const files = readdirSync(HTTP_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

  it('covers the listener, auth, CSRF, rendering, assets and view-model modules', () => {
    expect(files.sort()).toEqual(['assets.ts', 'render.ts', 'security.ts', 'server.ts', 'token-file.ts', 'view-model.ts']);
  });

  it.each(files)('%s imports only node:* built-ins and sibling http modules', (file) => {
    const source = readFileSync(path.join(HTTP_DIR, file), 'utf8');
    for (const specifier of specifiers(source)) {
      const allowed = specifier.startsWith('node:') || /^\.\/[a-z-]+$/.test(specifier);
      expect(allowed, `${file} imports ${specifier}`).toBe(true);
    }
  });

  it('detects a forbidden import (self-check of the scanner)', () => {
    expect(specifiers("import { x } from '@quoky/core';\nimport type { Y } from '../snapshot/guard';")).toEqual([
      '@quoky/core',
      '../snapshot/guard',
    ]);
  });
});

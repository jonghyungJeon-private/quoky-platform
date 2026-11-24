import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.[cm]?tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
  });
}

describe('local-auth import boundary (ADR-0125 D11)', () => {
  const files = sourceFiles(__dirname);

  it('covers production source and declares no package dependencies or references', () => {
    expect(files.length).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(Object.keys(manifest[key] ?? {})).toEqual([]);
    }
    const config = JSON.parse(readFileSync(path.join(__dirname, '../tsconfig.json'), 'utf8'));
    expect(config.references).toEqual([]);
  });

  it.each(files)('%s imports only node:* built-ins', (file) => {
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      expect(specifier.startsWith('node:'), `${file} imports ${specifier}`).toBe(true);
    }
  });

  it('detects static, type, side-effect, export, require and dynamic imports', () => {
    const forms = [
      "import { x } from '@quoky/core';",
      "import type { X } from '@quoky/core';",
      "import '@quoky/core';",
      "export { x } from '@quoky/core';",
      "const x = require('@quoky/core');",
      "const x = import('@quoky/core');",
    ];
    for (const form of forms) expect(specifiers(form)).toEqual(['@quoky/core']);
  });
});

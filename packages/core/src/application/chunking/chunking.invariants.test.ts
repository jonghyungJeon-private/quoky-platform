import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunk } from './index';

const DIRECTORY = __dirname;
const SOURCES = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(join(DIRECTORY, name), 'utf8') }));

/** Source with comments removed (a rough pass is enough: this code has no comment markers inside strings). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
}

describe('ADR-0124 RQ-1 invariants for chunking/', () => {
  it('T1-2: imports no vector-store, persistence, history, port or provider module', () => {
    const allowed = new Set(['node:crypto', '../untrusted-document-readout']);
    const found: string[] = [];
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] as string;
        if (specifier.startsWith('./')) continue;
        found.push(`${source.name}: ${specifier}`);
        expect(allowed.has(specifier), `${source.name} imports ${specifier}`).toBe(true);
      }
      expect(/\b(?:fs|node:fs|node:net|node:http|node:child_process|sqlite|console)\b/.test(withoutComments(source.text.replace(/from '[^']+'/g, ''))) || false).toBe(false);
    }
    expect(found.length).toBeGreaterThan(0);
  });

  it('T1-3: accepts exactly one item; a second item or a list of items does not type-check and throws', () => {
    expect(() => {
      // @ts-expect-error a second item is not a list of sections
      chunk('첫째 문서입니다.', '둘째 문서입니다.');
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error a list of items is not one prepared item
      chunk(['첫째 문서입니다.', '둘째 문서입니다.']);
    }).toThrow(TypeError);
    expect(chunk('한 문서입니다.').length).toBe(1);
  });

  it('T2-5: no phrase list and no wording-based regex in chunking code', () => {
    for (const source of SOURCES) {
      const code = withoutComments(source.text);
      // Natural-language text appears only in the fixed coverage templates.
      if (source.name !== 'coverage.ts') expect(/[가-힣]/.test(code), `${source.name} holds Hangul`).toBe(false);
      expect(/new RegExp\(/.test(code), `${source.name} builds a RegExp`).toBe(false);
      // No array of three or more plain words.
      expect(/\[\s*(?:'[A-Za-z]{3,}'\s*,\s*){2,}'[A-Za-z]{3,}'/.test(code), `${source.name} lists words`).toBe(false);
      // No regex literal that alternates words.
      for (const literal of code.matchAll(/\/((?:[^/\n\\]|\\.)+)\/[dgimsuy]*(?=[.),;\s])/g)) {
        const pattern = (literal[1] as string).replace(/\\p\{[^}]*\}/g, '');
        expect(/[A-Za-z]{3,}\|[A-Za-z]{3,}/.test(pattern), `${source.name}: ${pattern}`).toBe(false);
      }
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0124 N1 / RQ-1 (b)(c) for the S3 pipeline (C5a): nothing is persisted. The module imports no store, history,
 * memory, vector, platform or provider module, uses no file system, network, process or console, and holds no phrase list.
 */
const DIRECTORY = __dirname;
const SOURCES = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(join(DIRECTORY, name), 'utf8') }));

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
}

describe('item-summary/ invariants (ADR-0124 Part L C5a)', () => {
  it('N1: imports only pure Core modules and port TYPES; no store, history, memory, vector or I/O', () => {
    const allowed = new Set([
      '../../domain',
      '../../domain/flow-label',
      '../../ports/ai-provider.port',
      '../../ports/logger.port',
      '../../ports/provider-selection-policy.port',
      '../../ports/provider-selector.port',
      '../card-spoof',
      '../chat-policy/chat-response-policy',
      '../chunking',
      '../credential-guard',
      '../document-summary-claim-guard',
      '../link-neutralizer',
      '../local-provider-dispatch',
      '../prompt-composer',
      '../prompt-renderer',
      '../untrusted-document-readout',
    ]);
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] as string;
        if (specifier.startsWith('./')) continue;
        expect(allowed.has(specifier), `${source.name} imports ${specifier}`).toBe(true);
      }
      // Port modules are imported for their types only.
      for (const match of source.text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(\.\.\/\.\.\/ports\/[^']+)'/g)) {
        const values = (match[1] === undefined ? (match[2] as string).split(',') : []).map((part) => part.trim()).filter((part) => part.length > 0 && !part.startsWith('type '));
        expect(values, `${source.name}: ${match[3]}`).toEqual([]);
      }
      const code = withoutComments(source.text.replace(/from '[^']+'/g, ''));
      expect(/\b(?:node:fs|node:net|node:http|node:child_process|sqlite|console|process\.env|localStorage)\b/.test(code), source.name).toBe(false);
    }
  });

  it('no phrase list and no wording-based regex; Hangul only in the fixed Core copy', () => {
    for (const source of SOURCES) {
      const code = withoutComments(source.text);
      expect(/new RegExp\(/.test(code), `${source.name} builds a RegExp`).toBe(false);
      expect(/\[\s*(?:'[A-Za-z]{3,}'\s*,\s*){2,}'[A-Za-z]{3,}'/.test(code.replace(/CHUNK_ITEMS_MODES[^\n]*/g, '')), `${source.name} lists words`).toBe(false);
      for (const literal of code.matchAll(/\/((?:[^/\n\\]|\\.)+)\/[dgimsuy]*(?=[.),;\s])/g)) {
        expect(/[A-Za-z]{3,}\|[A-Za-z]{3,}/.test(literal[1] as string), `${source.name}: ${literal[1]}`).toBe(false);
      }
      const hangulLines = code.split('\n').filter((line) => /[가-힣]/.test(line));
      for (const line of hangulLines) expect(/^\s+ko: '/.test(line), `${source.name}: ${line.trim()}`).toBe(true);
    }
  });
});

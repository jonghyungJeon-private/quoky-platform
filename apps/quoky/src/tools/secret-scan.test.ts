import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyReviewed,
  categorize,
  formatHit,
  gatingHits,
  historyByCommit,
  isCredentialShapedValue,
  isValidGithubTokenShape,
  loadReviewed,
  scanDiffStream,
  scanHistory,
  scanText,
  summarize,
} from './secret-scan';

// Fixtures are built from fragments at run time: no credential-shaped literal exists in this file.
const GH_PREFIX = ['gh', 'p_'].join('');
const tokenValue = `${GH_PREFIX}${'A1b2C3d4E5'.repeat(4)}`;
const assignment = (value: string): string => ['pass', 'word'].join('') + ` = "${value}"`;

async function* lines(...text: string[]): AsyncIterable<string> {
  for (const t of text) yield* t.split('\n');
}

describe('scanText', () => {
  it('reports nothing for clean text', () => {
    expect(scanText('a.ts', 'WORKTREE', 'const answer = 42;\n')).toEqual([]);
  });

  it('reports a vendor token shape with its line and never the value', () => {
    const hit = scanText('a.ts', 'WORKTREE', `// header\nconst t = '${tokenValue}';\n`)[0];
    expect(hit).toMatchObject({ file: 'a.ts', commit: 'WORKTREE', line: 2, rule: 'secret-token', masked: '[masked]' });
    expect(JSON.stringify(hit)).not.toContain(tokenValue);
    expect(formatHit(hit!)).not.toContain(tokenValue);
  });

  it('reports a credential assignment with the exact line', () => {
    const hit = scanText('c.env', 'abc', `A=1\n${assignment(['q7Zk', 'P2mX', '9vLd'].join(''))}\n`)[0];
    expect(hit).toMatchObject({ line: 2, rule: 'credential-assignment' });
    expect(JSON.stringify(hit)).not.toContain('q7Zk');
  });
});

describe('scanDiffStream', () => {
  const sha = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);
  const log = [
    `commit ${sha}`,
    '',
    'diff --git a/src/x.ts b/src/x.ts',
    'index 111..222 100644',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1,2 +10,4 @@',
    ' context',
    '+const ok = 1;',
    `+const leaked = '${tokenValue}';`,
    ' context',
    `commit ${sha2}`,
    '',
    'diff --git a/y.txt b/y.txt',
    '--- /dev/null',
    '+++ b/y.txt',
    '@@ -0,0 +1,1 @@',
    '+nothing here',
    `-${tokenValue}`,
  ].join('\n');

  it('maps a hit to the commit, file and new-file line, and ignores removed lines', async () => {
    const result = await scanDiffStream(lines(log));
    expect(result.commits).toBe(2);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ file: 'src/x.ts', commit: sha, line: 12, rule: 'secret-token' });
    expect(JSON.stringify(result)).not.toContain(tokenValue);
  });
});

const key = ['pass', 'word'].join('');
const issuedBody = ['xox', 'b-', 'q7ZkP2mX9vLdR4tYb8NcW3sHf6JeA1uKo5Gi'].join('');
const realish = ['q7Zk', 'P2mX', '9vLd', 'R4tY', 'b8Nc'].join('');

describe('credential-assignment precision', () => {
  it.each([
    ['an identifier', `${key} = someOtherValue`],
    ['an env lookup', `const ${key} = process.env.QUOKY_THING;`],
    ['an empty string', `${key} = ""`],
    ['a placeholder', `${key} = "<your-${key}>"`],
    ['a changeme value', `${key}: "changeme"`],
    ['an env name with no value', `${key.toUpperCase()}=`],
    ['a type annotation', `const ${key}: string = ${key}Input;`],
    ['prose in a comment', `// the ${key} = "${realish}" example`],
  ])('does not count %s', (_name, line) => {
    expect(scanText('apps/quoky/src/a.ts', 'WORKTREE', `${line}\n`)).toEqual([]);
  });

  it('counts a credential-shaped string literal in source', () => {
    const hit = scanText('apps/quoky/src/a.ts', 'WORKTREE', `const ${key} = "${realish}";\n`)[0];
    expect(hit).toMatchObject({ rule: 'credential-assignment', category: 'source', line: 1 });
  });

  it('judges values by shape', () => {
    expect(isCredentialShapedValue(realish)).toBe(true);
    expect(isCredentialShapedValue('QUOKY_TELEGRAM_BOT_TOKEN')).toBe(false);
    expect(isCredentialShapedValue('xxxxxxxxxxxxxxxx')).toBe(false);
    expect(isCredentialShapedValue('your-token-here')).toBe(false);
    expect(isCredentialShapedValue('./data/google-gmail-token.json')).toBe(false);
  });

  it('reports a placeholder token shape as a placeholder that does not gate', () => {
    const hits = scanText('docs/a.md', 'WORKTREE', `token: ${GH_PREFIX}${'x'.repeat(24)}\n`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ rule: 'secret-token', classification: 'placeholder' });
    expect(gatingHits(hits)).toHaveLength(0);
  });
});

describe('summary and gating', () => {
  const hits = [
    ...scanText('a.test.ts', 'WORKTREE', `x = '${tokenValue}'\n`),
    ...scanText('docs/a.md', 'a'.repeat(40), `${key}: ${realish}\n`),
    ...scanText('src/b.ts', 'WORKTREE', `const ${key} = "${realish}";\n`),
  ];

  it('categorizes files', () => {
    expect(categorize('packages/x/src/a.test.ts')).toBe('test');
    expect(categorize('.env.example')).toBe('docs');
    expect(categorize('apps/quoky/src/config.ts')).toBe('source');
  });

  it('counts by rule, tree or history, and category', () => {
    expect(summarize(hits)).toEqual([
      { rule: 'credential-assignment', where: 'history', category: 'docs', count: 1 },
      { rule: 'credential-assignment', where: 'tree', category: 'source', count: 1 },
      { rule: 'secret-token', where: 'tree', category: 'test', count: 1 },
    ]);
    expect(historyByCommit(hits, 'credential-assignment')).toEqual([`${'a'.repeat(10)} docs x1`]);
  });

  it('gates only on non-test hits', () => {
    // The test hit's body is patterned (a fake), so it is not an issued-key candidate and does not gate.
    expect(gatingHits(hits)).toHaveLength(2);
    expect(gatingHits(hits.filter((h) => h.category === 'test'))).toHaveLength(0);
  });

  it('flags an issued-looking provider key outside tests, with no value', () => {
    const hit = scanText('src/c.ts', 'b'.repeat(40), `const t = '${issuedBody}';\n`)[0];
    expect(hit?.issuedCandidate).toBe(true);
    expect(formatHit(hit!)).toContain('ROTATE-CANDIDATE');
    expect(formatHit(hit!)).not.toContain(issuedBody);
  });

  it('gates on an issued-looking key even in a test file', () => {
    const hits = scanText('x.test.ts', 'c'.repeat(40), `const t = '${issuedBody}';\n`);
    expect(hits[0]?.issuedCandidate).toBe(true);
    expect(gatingHits(hits)).toHaveLength(1);
  });
});

describe('every hit in a blob is reported', () => {
  const secretKey = ['client', '_secret'].join('');

  it('does not let an early placeholder token hide a later real token', () => {
    const placeholder = ['sk', '-', 'x'.repeat(30)].join('');
    const real = ['xox', 'b-', 'q7Zk', 'P2mX', '9vLd', 'R4tY', 'b8Nc'].join('');
    const hits = scanText('src/a.ts', 'WORKTREE', `// ${placeholder}\nconst a = 1;\nconst slack = '${real}';\n`);
    expect(hits.map((h) => [h.line, h.classification])).toEqual([
      [1, 'placeholder'],
      [3, 'issued-candidate'],
    ]);
    expect(gatingHits(hits).map((h) => h.line)).toEqual([3]);
  });

  it('does not let password="changeme" hide a later client secret', () => {
    const text = `${key} = "changeme"\nother = 1\n\n${secretKey} = "${realish}"\n`;
    const hits = scanText('src/a.ts', 'WORKTREE', text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 4, rule: 'credential-assignment' });
  });

  it('reports several real hits with their own lines', () => {
    const text = `${key} = "${realish}"\nx = 1\n${secretKey}: "${realish}Z9"\n`;
    expect(scanText('src/a.ts', 'WORKTREE', text).map((h) => h.line)).toEqual([1, 3]);
  });
});

describe('git failures', () => {
  it('rejects instead of reporting a clean scan when git fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-nogit-'));
    try {
      await expect(scanHistory(dir)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GitHub token shape and the reviewed list', () => {
  // Builds a token with a valid body length and a computed checksum, from fragments (no literal in the file).
  function validToken(body30 = 'Q7zKp2MxL9vDr4TyB8NcW3sHf6JeA1'): string {
    // Reuse the scanner's own checksum by brute force over the checksum alphabet is not possible; compute here.
    const table = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    let c = 0xffffffff;
    for (const b of Buffer.from(body30)) c = (table[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    let n = (c ^ 0xffffffff) >>> 0;
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let out = '';
    for (let i = 0; i < 6; i++) {
      out = alphabet[n % 62] + out;
      n = Math.floor(n / 62);
    }
    return ['gh', 'p_'].join('') + body30 + out;
  }

  it('accepts a 36-character body with a valid checksum and rejects a wrong checksum or length', () => {
    const good = validToken();
    expect(isValidGithubTokenShape(good)).toBe(true);
    expect(isValidGithubTokenShape(`${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`)).toBe(false);
    expect(isValidGithubTokenShape(good.slice(0, -3))).toBe(false);
  });

  it('marks a GitHub-prefixed value with a bad checksum not-issued-shape and does not gate it', () => {
    const fake = ['gh', 's_', 'q7ZkP2mX9vLdR4tYb8NcW3sHf6JeA1uKo5Gi'].join('');
    const hits = scanText('x.test.ts', 'c'.repeat(40), `const t = '${fake}';\n`);
    expect(hits[0]).toMatchObject({ notIssuedShape: true, issuedCandidate: false });
    expect(gatingHits(hits)).toHaveLength(0);
    expect(formatHit(hits[0]!)).toContain('not-issued-shape');
  });

  it('keeps a checksum-valid GitHub token as an issued candidate and gates on it', () => {
    const hits = scanText('x.test.ts', 'c'.repeat(40), `const t = '${validToken()}';\n`);
    expect(hits[0]).toMatchObject({ issuedCandidate: true, notIssuedShape: false });
    expect(gatingHits(hits)).toHaveLength(1);
  });

  it('does not gate a hit whose fingerprint is in the reviewed list, and reports it as reviewed', () => {
    const hits = scanText('src/a.ts', 'c'.repeat(40), `const t = '${validToken()}';\n`);
    const reviewed = [{ fingerprint: hits[0]!.fingerprint, reason: 'r', reviewer: 'x', date: '2026-10-13' }];
    const applied = applyReviewed(hits, reviewed);
    expect(applied[0]?.reviewed).toBe(true);
    expect(gatingHits(applied)).toHaveLength(0);
    expect(formatHit(applied[0]!)).toContain('reviewed');
    expect(applyReviewed(hits, [])[0]?.reviewed).toBe(false);
  });

  it('stores fingerprints only: the committed list loads and has no values', () => {
    const entries = loadReviewed(fileURLToPath(new URL('../../../../', import.meta.url)));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('regression: no span hides another, no cap (S0-ops escalation)', () => {
  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  /** A GitHub classic token with a valid CRC32/base62 checksum, built at run time (no token literal in this file). */
  function checksumValid(body30: string): string {
    let c = 0xffffffff;
    for (const b of Buffer.from(body30)) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    let n = (c ^ 0xffffffff) >>> 0;
    let out = '';
    for (let i = 0; i < 6; i++) {
      out = ALPHABET[n % 62] + out;
      n = Math.floor(n / 62);
    }
    return GH_PREFIX + body30 + out;
  }
  const secretKey = ['client', '_secret'].join('');

  it('(a) a real assignment followed later by a placeholder token: both reported, the real one gates', () => {
    const text = `${key} = "${realish}"\nconst a = 1;\nconst t = '${GH_PREFIX}${'x'.repeat(36)}';\n`;
    const hits = scanText('src/a.ts', 'WORKTREE', text);
    expect(hits.map((h) => [h.line, h.rule, h.classification])).toEqual([
      [1, 'credential-assignment', 'credential'],
      [3, 'secret-token', 'placeholder'],
    ]);
    expect(gatingHits(hits).map((h) => h.line)).toEqual([1]);
  });

  it('(a) also when the placeholder shares the file with several real assignments', () => {
    const text = `${secretKey} = "${realish}"\nx = 1\n${key}: "${realish}Z9"\n// ${GH_PREFIX}${'x'.repeat(30)}\n`;
    expect(gatingHits(scanText('src/a.ts', 'WORKTREE', text)).map((h) => h.line)).toEqual([1, 3]);
  });

  it('(b) two candidates on one line, one reviewed: the other still gates', () => {
    const first = checksumValid('Q7zKp2MxL9vDr4TyB8NcW3sHf6JeA1');
    const second = checksumValid('m4Rt8WqZ2nLp6YcV0bHs3KdJ9uFe5G');
    const hits = scanText('x.test.ts', 'c'.repeat(40), `const pair = ['${first}', '${second}'];\n`);
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.fingerprint)).size).toBe(2);
    const reviewed = [{ fingerprint: hits[0]!.fingerprint, reason: 'r', reviewer: 'x', date: '2026-10-13' }];
    const gating = gatingHits(applyReviewed(hits, reviewed));
    expect(gating).toHaveLength(1);
    expect(gating[0]?.fingerprint).toBe(hits[1]!.fingerprint);
    expect(JSON.stringify(hits)).not.toContain(second);
  });

  it('(b) a reviewed assignment literal does not cover another literal on the same line', () => {
    const hits = scanText('src/a.ts', 'WORKTREE', `${key} = "${realish}"; ${secretKey} = "${realish}Q4"\n`);
    expect(hits).toHaveLength(2);
    const applied = applyReviewed(hits, [{ fingerprint: hits[0]!.fingerprint, reason: 'r', reviewer: 'x', date: 'd' }]);
    expect(gatingHits(applied)).toHaveLength(1);
  });

  it('(c) more than 500 hits in one blob are all reported (no cap)', async () => {
    const body = Array.from({ length: 620 }, (_, i) => `${key}_${i} = "${realish}${i}"`).join('\n');
    const hits = scanText('src/many.ts', 'WORKTREE', body);
    expect(hits).toHaveLength(620);
    expect(hits[619]?.line).toBe(620);
    expect(gatingHits(hits)).toHaveLength(620);
    const log = [`commit ${'d'.repeat(40)}`, 'diff --git a/src/many.ts b/src/many.ts', '+++ b/src/many.ts', '@@ -0,0 +1,620 @@', ...body.split('\n').map((l) => `+${l}`)];
    expect((await scanDiffStream(lines(log.join('\n')))).hits).toHaveLength(620);
  });

  it('(d) a checksum-valid ghp_ token containing "test" in a test path is an issued candidate and gates', () => {
    const token = checksumValid(`test${'x'.repeat(6)}TESTabcd1234FakeDumm`);
    expect(isValidGithubTokenShape(token)).toBe(true);
    const hits = scanText('apps/quoky/src/fixtures/a.test.ts', 'WORKTREE', `const t = '${token}';\n`);
    expect(hits[0]).toMatchObject({ category: 'test', classification: 'issued-candidate', issuedCandidate: true });
    expect(gatingHits(hits)).toHaveLength(1);
    expect(formatHit(hits[0]!)).toContain('ROTATE-CANDIDATE');
  });

  it('enumerates a bearer header and the GitHub token inside it as separate spans', () => {
    const token = checksumValid('Q7zKp2MxL9vDr4TyB8NcW3sHf6JeA1');
    const hits = scanText('x.test.ts', 'WORKTREE', `headers: ['${['Bear', 'er'].join('')} ${token}']\n`);
    expect(hits.map((h) => h.classification).sort()).toEqual(['credential', 'issued-candidate']);
    expect(gatingHits(hits)).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  categorize,
  formatHit,
  gatingHits,
  historyByCommit,
  isCredentialShapedValue,
  scanDiffStream,
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
    expect(scanText('a.ts', 'WORKTREE', 'const answer = 42;\n')).toBeUndefined();
  });

  it('reports a vendor token shape with its line and never the value', () => {
    const hit = scanText('a.ts', 'WORKTREE', `// header\nconst t = '${tokenValue}';\n`);
    expect(hit).toMatchObject({ file: 'a.ts', commit: 'WORKTREE', line: 2, rule: 'secret-token', masked: '[masked]' });
    expect(JSON.stringify(hit)).not.toContain(tokenValue);
    expect(formatHit(hit!)).not.toContain(tokenValue);
  });

  it('reports a credential assignment with the exact line', () => {
    const hit = scanText('c.env', 'abc', `A=1\n${assignment(['q7Zk', 'P2mX', '9vLd'].join(''))}\n`);
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
    expect(scanText('apps/quoky/src/a.ts', 'WORKTREE', `${line}\n`)).toBeUndefined();
  });

  it('counts a credential-shaped string literal in source', () => {
    const hit = scanText('apps/quoky/src/a.ts', 'WORKTREE', `const ${key} = "${realish}";\n`);
    expect(hit).toMatchObject({ rule: 'credential-assignment', category: 'source', line: 1 });
  });

  it('judges values by shape', () => {
    expect(isCredentialShapedValue(realish)).toBe(true);
    expect(isCredentialShapedValue('QUOKY_TELEGRAM_BOT_TOKEN')).toBe(false);
    expect(isCredentialShapedValue('xxxxxxxxxxxxxxxx')).toBe(false);
    expect(isCredentialShapedValue('your-token-here')).toBe(false);
    expect(isCredentialShapedValue('./data/google-gmail-token.json')).toBe(false);
  });

  it('does not count a placeholder token shape', () => {
    expect(scanText('docs/a.md', 'WORKTREE', `token: ${GH_PREFIX}xxxxxxxxxxxxxxxxxxxxxxxx\n`)).toBeUndefined();
  });
});

describe('summary and gating', () => {
  const hits = [
    scanText('a.test.ts', 'WORKTREE', `x = '${tokenValue}'\n`),
    scanText('docs/a.md', 'a'.repeat(40), `${key}: ${realish}\n`),
    scanText('src/b.ts', 'WORKTREE', `const ${key} = "${realish}";\n`),
  ].flatMap((h) => (h ? [h] : []));

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
    expect(gatingHits(hits)).toHaveLength(2);
    expect(gatingHits(hits.filter((h) => h.category === 'test'))).toHaveLength(0);
  });

  it('flags an issued-looking provider key outside tests, with no value', () => {
    const hit = scanText('src/c.ts', 'b'.repeat(40), `const t = '${tokenValue}';\n`);
    expect(hit?.issuedCandidate).toBe(true);
    expect(formatHit(hit!)).toContain('ROTATE-CANDIDATE');
    expect(formatHit(hit!)).not.toContain(tokenValue);
  });
});

import { describe, expect, it } from 'vitest';
import { formatHit, scanDiffStream, scanText } from './secret-scan';

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
    const hit = scanText('c.env', 'abc', `A=1\n${assignment('hunter2hunter2')}\n`);
    expect(hit).toMatchObject({ line: 2, rule: 'credential-assignment' });
    expect(JSON.stringify(hit)).not.toContain('hunter2');
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

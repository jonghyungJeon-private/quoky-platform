import { describe, expect, it } from 'vitest';
import {
  MAX_PR_BODY_CHARS,
  MAX_PR_BODY_LISTED_FILES,
  MAX_PR_TITLE_CHARS,
  PR_BODY_PROVENANCE_LINE,
  buildDeterministicPrDescription,
  committedSubjectOf,
  deterministicPrBody,
  deterministicPrTitle,
  prDescriptionContentHash,
} from './pr-description';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const base = { commitHash: SHA, headBranch: 'feature/login', baseBranch: 'main' };

describe('committedSubjectOf (ADR-0108 D2)', () => {
  it('keeps a single-line subject, collapses whitespace and strips control characters', () => {
    expect(committedSubjectOf('feat: add login')).toBe('feat: add login');
    expect(committedSubjectOf('  feat:\tadd   login  ')).toBe('feat: add login');
    expect(committedSubjectOf('feat: add\u0007 login')).toBe('feat: add login');
    expect(committedSubjectOf('feat: first line\n\nbody text')).toBe('feat: first line');
  });

  it('bounds to 72 characters and refuses empty or credential-bearing subjects', () => {
    const long = committedSubjectOf(`feat: ${'x'.repeat(200)}`)!;
    expect(Array.from(long)).toHaveLength(MAX_PR_TITLE_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(committedSubjectOf('   ')).toBeUndefined();
    expect(committedSubjectOf(undefined)).toBeUndefined();
    expect(committedSubjectOf(`fix: ghp_${'a'.repeat(36)}`)).toBeUndefined();
    expect(committedSubjectOf('chore: password=hunter2')).toBeUndefined();
  });
});

describe('deterministicPrTitle (ADR-0108 D2)', () => {
  it('uses the committed subject when present', () => {
    expect(deterministicPrTitle('docs: add UAT note', ['docs/uat-note.md'])).toBe('docs: add UAT note');
  });

  it('falls back to "chore: update <first path> (+N files)"', () => {
    expect(deterministicPrTitle(undefined, ['docs/uat-note.md'])).toBe('chore: update docs/uat-note.md');
    expect(deterministicPrTitle(undefined, ['a.ts', 'b.ts'])).toBe('chore: update a.ts (+1 file)');
    expect(deterministicPrTitle(undefined, ['a.ts', 'b.ts', 'c.ts'])).toBe('chore: update a.ts (+2 files)');
    expect(deterministicPrTitle(`fix: ghp_${'a'.repeat(36)}`, ['a.ts'])).toBe('chore: update a.ts');
    expect(deterministicPrTitle(undefined, [])).toBe('chore: update approved changes');
  });

  it('shortens the path, not the count, to stay within 72 characters', () => {
    const title = deterministicPrTitle(undefined, [`src/${'deep/'.repeat(30)}file.ts`, 'b.ts', 'c.ts']);
    expect(Array.from(title).length).toBeLessThanOrEqual(MAX_PR_TITLE_CHARS);
    expect(title.startsWith('chore: update src/')).toBe(true);
    expect(title.endsWith('… (+2 files)')).toBe(true);
  });

  it('never names a secret-looking or unsafe path', () => {
    expect(deterministicPrTitle(undefined, ['.env.local', 'src/a.ts'])).toBe('chore: update src/a.ts (+1 file)');
    expect(deterministicPrTitle(undefined, ['../escape.ts'])).toBe('chore: update 1 file');
  });
});

describe('deterministicPrBody (ADR-0108 D3)', () => {
  it('lists the commit, head→base, the committed paths and the provenance line', () => {
    const body = deterministicPrBody({ ...base, committedSubject: 'feat: add login', committedFiles: ['src/a.ts', 'docs/b.md'] });
    expect(body).toBe(
      [
        PR_BODY_PROVENANCE_LINE,
        '',
        'Commit: `0123456` feat: add login',
        'Branch: feature/login → main',
        '',
        'Changed files (2):',
        '- `src/a.ts`',
        '- `docs/b.md`',
      ].join('\n'),
    );
  });

  it('lists at most 20 paths, then "+N more"', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    const body = deterministicPrBody({ ...base, committedFiles: files });
    expect(body.split('\n').filter((l) => l.startsWith('- `'))).toHaveLength(MAX_PR_BODY_LISTED_FILES);
    expect(body).toContain('- +5 more');
    expect(body).toContain('Changed files (25):');
    expect(body).toContain('Commit: `0123456`\n'); // no subject recorded → hash only
  });

  it('never shows secret-looking, credential-bearing, traversal or backtick paths (counted in "+N more")', () => {
    const body = deterministicPrBody({
      ...base,
      committedFiles: ['src/ok.ts', '.env', 'config/secrets.yaml', `x/ghp_${'a'.repeat(36)}.ts`, '../up.ts', 'we`ird.ts'],
    });
    expect(body).toContain('- `src/ok.ts`');
    expect(body).not.toMatch(/\.env|secrets|ghp_|up\.ts|we`ird/);
    expect(body).toContain('- +5 more');
  });

  it('stays within 4,000 characters by moving paths into "+N more"', () => {
    const files = Array.from({ length: 20 }, (_, i) => `${'d'.repeat(180)}/file-${String(i).padStart(2, '0')}.ts`); // 192 chars each
    const body = deterministicPrBody({ ...base, committedFiles: files });
    expect(body.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    expect(body).toMatch(/- \+\d+ more$/);
  });
});

describe('PR description hash binding (ADR-0108 D5)', () => {
  it('is a SHA-256 over exactly (title, body)', () => {
    const d = buildDeterministicPrDescription({ ...base, committedSubject: 'feat: x', committedFiles: ['a.ts'] });
    expect(d.title).toBe('feat: x');
    expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.contentHash).toBe(prDescriptionContentHash(d.title, d.body));
    expect(prDescriptionContentHash(d.title, `${d.body} `)).not.toBe(d.contentHash);
    expect(prDescriptionContentHash(`${d.title} `, d.body)).not.toBe(d.contentHash);
    // the split point matters: (title, body) is not just the concatenation
    expect(prDescriptionContentHash('ab', 'c')).not.toBe(prDescriptionContentHash('a', 'bc'));
  });

  it('is deterministic for the same input', () => {
    const input = { ...base, committedSubject: 'feat: x', committedFiles: ['a.ts', 'b.ts'] };
    expect(buildDeterministicPrDescription(input)).toEqual(buildDeterministicPrDescription(input));
  });
});

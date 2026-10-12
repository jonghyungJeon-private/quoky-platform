import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PLT-1 source scan: a Core reply module must not put an obviously outside value (a file path, branch, repository,
 * commit message, PR title or URL) into a plain template literal. Such a value goes through `untrustedText` (the
 * `outside()` / `copy` helpers of `response-composer.ts`), so each platform adapter neutralizes it its own way: Discord
 * escapes it, Telegram's plain-text translation never alters it (a `_draft_.ts` keeps its underscores).
 *
 * Deliberately narrow, in the spirit of `platform-neutral-rendering.test.ts`:
 * - it reads the reply modules that build neutral content (any non-test module importing `message-rendering`) plus the
 *   code-work reply copy that predates it;
 * - it is line-based, so it sees single-line template literals only;
 * - it recognizes an outside value by its name (`path`, `branch`, `owner`, `repo`, `commitMessage`, ...), so a value
 *   under another name is not caught: the targeted tests in `application/response-composer-spans.test.ts` pin every
 *   converted reply instead;
 * - a `copy` template is the span-aware form, but it accepts plain strings too, so its `${}` values are checked the same
 *   way: an outside-value name must be wrapped in `outside(`, `outsideList(`, `repositoryPart(`, `urlPart(`,
 *   `renderFileList(` or `untrustedText(` (a bare name, even of an already-built span, is flagged and renamed). A value wrapped in an inline code span (a backtick on each side) is verbatim on every platform.
 *   Anything else flagged here is either converted to a span or listed in {@link ALLOWED} with the reason.
 */

const SRC = __dirname;

/** The reply copy modules that do not import `message-rendering` but write replies naming outside values. */
const ALSO_SCANNED = ['application/code-work/git-branch-command.ts'];

function coreSources(dir: string = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...coreSources(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

/**
 * The names an outside value goes by in a template expression: the last property or the bare identifier, optionally
 * through a string method (`input.owner.slice(0, 80)`). A property of it (`file.kind`) or a `.length` is not the value.
 */
const OUTSIDE_NAME =
  /(?<![A-Za-z0-9_])(?:[A-Za-z0-9_]+\.)*(path|paths|file|files|targetPath|targetFiles|candidateFiles|branch|headBranch|baseBranch|cleanedBranch|remote|owner|repo|commitMessage|prUrl|pullRequestUrl|title)(?![A-Za-z0-9_])(?!\.(?!slice|join|trim|replace|map|toString)[A-Za-z_])/;

/** Modules that name outside values in data that is not chat reply copy (so the scan skips them), with the reason. */
const NOT_REPLY_COPY: Readonly<Record<string, string>> = {
  'application/conversation-runtime.ts':
    'its templates build ApprovalRequest summaries (stored records shown by the operations UI) and logs; chat replies come from the composer',
};

interface Finding {
  readonly line: number;
  readonly expression: string;
  readonly source: string;
}

/** The plain (untagged) template literals of a line whose `${…}` expression names an outside value, outside code spans. */
function findOutsideValuesInPlainCopy(source: string): Finding[] {
  const findings: Finding[] = [];
  source.split('\n').forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const template of line.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
      const start = template.index ?? 0;
      // `outside(` and `untrustedText(` build the span from the template (verbatim).
      if (/\b(?:outside\(|untrustedText\()$/.test(line.slice(0, start))) continue;
      const body = template[1] as string;
      for (const expression of body.matchAll(/\$\{([^{}]*)\}/g)) {
        // A count (`paths.length - shown.length`) is a number, not the value.
        const text = (expression[1] as string).replace(/[A-Za-z0-9_.]*\.length/g, '0');
        if (!OUTSIDE_NAME.test(text)) continue;
        // The span-building helpers: what they return is already an untrusted span.
        if (/\b(?:outside|outsideList|repositoryPart|urlPart|renderFileList|untrustedText)\(/.test(text)) continue;
        const at = expression.index ?? 0;
        // An inline code span: an escaped backtick right before the expression and right after it.
        if (body.slice(0, at).endsWith('\\`') && body.slice(at + expression[0].length).startsWith('\\`')) continue;
        findings.push({ line: index + 1, expression: text, source: line.trim().slice(0, 120) });
      }
    }
  });
  return findings;
}

/**
 * Plain templates that name an outside value on purpose. Keyed by `file:expression`; the reason is the review record.
 */
const ALLOWED: Readonly<Record<string, string>> = {};

describe('Core replies keep outside values out of plain copy (PLT-1)', () => {
  const files = coreSources().filter((file) => {
    const rel = relative(SRC, file);
    if (NOT_REPLY_COPY[rel] !== undefined) return false;
    return ALSO_SCANNED.includes(rel) || /from '(?:\.\.?\/)+(?:application\/)?message-rendering'/.test(readFileSync(file, 'utf8'));
  });

  it('scans the response composer and the other reply modules', () => {
    const names = files.map((file) => relative(SRC, file));
    expect(names).toContain('application/response-composer.ts');
    expect(names).toContain('application/credential-override/credential-override-copy.ts');
    expect(names).toContain('application/code-work/git-branch-command.ts');
    expect(files.length).toBeGreaterThan(8);
  });

  it('no reply module writes an outside value into a plain template literal', () => {
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      for (const finding of findOutsideValuesInPlainCopy(readFileSync(file, 'utf8'))) {
        if (ALLOWED[`${rel}:${finding.expression}`] !== undefined) continue;
        hits.push(`${rel}:${finding.line} \${${finding.expression}}: ${finding.source}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the scan catches the plain copy PLT-1 removed (it is not vacuous)', () => {
    const legacy = [
      'return `파일을 수정했어요: ${files}\\n` + more;',
      'lines.push(`- ${c.path}: 바이너리 파일이라`);',
      'const target = `대상: ${remote}/${branch} (원격보다 ${input.ahead}개 앞섬)`;',
      'const line = `커밋 메시지: ${input.commitMessage}`;',
      '`- 저장소: ${input.owner.slice(0, 80)}/${input.repo.slice(0, 80)}`',
    ];
    legacy.push('const line = copy`대상: ${input.branch}`;', 'copy`대상 파일: ${files}`');
    for (const line of legacy) {
      expect(findOutsideValuesInPlainCopy(line).length, line).toBeGreaterThan(0);
    }
  });

  it('the span-aware forms pass: a `copy` template, and a value inside an inline code span', () => {
    const fine = [
      'return copy`파일을 수정했어요: ${outsideList(files)}\\n`;',
      'return copy`파일: ${renderFileList(files, newFiles)}\\n`;',
      'return `\\`${shown}\\``;',
      'const note = `새 브랜치를 만들고 전환했어요: \\`${result.branch}\\``;',
      'const count = `외 ${omitted}개`;',
    ];
    for (const line of fine) expect(findOutsideValuesInPlainCopy(line), line).toEqual([]);
  });
});

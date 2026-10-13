/**
 * Repository secret scan (ADR-0121 S0, MSIT ③-2): scans the tracked working tree and the added lines of the full git
 * history for credential-shaped values with the SAME detector as the runtime credential guard
 * (`classifyCredentialFileContent`, ADR-0097). In-repo, no new dependency.
 *
 * A hit names the file, the commit and the line, and a masked marker. The matched value is never read back out of the
 * detector, never stored in a finding and never printed (the detector only reports which rule fired and a line).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { classifyCredentialFileContent, containsCredentialMaterial } from '@quoky/core';

export type HitCategory = 'test' | 'docs' | 'source';

export interface SecretScanHit {
  readonly file: string;
  /** `test` (fixtures and tests), `docs` (markdown, docs/, `.env.example`) or `source`. Only non-test hits gate. */
  readonly category: HitCategory;
  /** A known provider prefix with a plausible length outside a placeholder: a key to rotate if it is in a non-test file. */
  readonly issuedCandidate: boolean;
  /** Commit sha for a history hit, or `WORKTREE` for the working tree. */
  readonly commit: string;
  /** 1-based line in the file at that commit; 0 when the finding spans lines and no single line is responsible. */
  readonly line: number;
  readonly rule: 'secret-token' | 'credential-assignment';
  /** Always the fixed marker; the value is not available to this tool. */
  readonly masked: '[masked]';
}

export const WORKTREE_COMMIT = 'WORKTREE';
/** Content above this size is skipped (generated or binary blobs), and counted in `skipped`. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export function categorize(file: string): HitCategory {
  if (/(\.|-)(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?|fixtures?|__fixtures__|uat)\//i.test(file)) return 'test';
  if (/\.(md|mdx|txt|rst)$|^docs\/|(^|\/)\.env\.example$|(^|\/)CHANGELOG/i.test(file)) return 'docs';
  return 'source';
}

const PLACEHOLDER =
  /^(<[^>]*>|\$\{.*\}|\{\{.*\}\}|%\(.*\)s|\*{3,}|x{3,}.*|.*x{6,}.*|(change|replace)[-_ ]?me.*|your[-_ ].*|.*[-_]here|example.*|placeholder.*|dummy.*|fake.*|redacted.*|\[redacted\]|\[masked\]|todo|tbd|none|null|undefined|secret|password|token)$/i;

export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (PLACEHOLDER.test(v)) return true;
  return new Set(v).size <= 2; // 'aaaaaaaa', '00000000'
}

function entropy(v: string): number {
  const counts = new Map<string, number>();
  for (const c of v) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / v.length) * Math.log2(n / v.length);
  return h;
}

/**
 * Whether a literal is credential-shaped by VALUE (the runtime guard's value rules plus length, charset and entropy):
 * a known vendor shape, or a 12+ character whitespace-free run with letters and digits and enough entropy.
 * Identifiers, env-var names, paths, URLs without userinfo and placeholders are not.
 */
export function isCredentialShapedValue(raw: string): boolean {
  const v = raw.trim();
  if (isPlaceholder(v)) return false;
  if (/\$\{|\{\{/.test(v)) return false; // an interpolated template is a reference, not a value
  if (containsCredentialMaterial(v)) return true;
  if (v.length < 12 || /\s/.test(v)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(v) && !/\d/.test(v)) return false; // identifier, env name
  if (/^(\.{0,2}\/|https?:\/\/[^@]*$|[a-z]+:\/\/[^@]*$)/i.test(v)) return false; // path or URL without userinfo
  if (!/^[A-Za-z0-9+/=_.~-]+$/.test(v)) return false; // regexes, templates and prose are not credential charsets
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  return entropy(v) >= 3.0;
}

/** A token body with a repeated block, a run (abcd, 1234, xxxx) or very few distinct characters is a hand-made fake. */
export function looksPatterned(token: string): boolean {
  const body = token.replace(ISSUED_PREFIX, '');
  return (
    /(.{3,16})\1/.test(body) ||
    /(abcd|0123|1234|x{4}|a{4}|0{4}|1{4}|fake|test|dummy|example|redact|secret|sample)/i.test(body) ||
    new Set(body).size <= Math.ceil(body.length / 4)
  );
}

const ISSUED_PREFIX = /^(sk-ant-|sk-proj-|github_pat_|gh[pousr]_|xox[bpsa]-|AKIA|ASIA|AIza|sk_live_)/;

/**
 * Right-hand-side literals of an assignment on this line: a quoted literal right after `:`, `=`, `=>` or `:=`
 * (optionally wrapped in one call), or a bare `KEY=value` / `key: value` at the line start. Comment lines and
 * prose mentions (quotes elsewhere in a sentence) yield nothing.
 */
function assignedLiterals(line: string, category: HitCategory): string[] {
  if (/^\s*(\/\/|\/\*|\*)/.test(line)) return [];
  const out: string[] = [];
  if (category !== 'docs') {
    const re = /(?::=|=>|[:=])\s*(?:[A-Za-z_][\w.]*\(\s*)?(["'`])((?:\\.|(?!\1).)*)\1/g;
    for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[2] ?? '');
  }
  const bare = /^[\s#-]*[A-Za-z_][\w.-]*\s*[:=]\s*(["'`]?)([^\s"'`#,;]+)\1\s*$/.exec(line);
  if (bare?.[2]) out.push(bare[2]);
  return out;
}

function tokensOf(line: string): string[] {
  return line.split(/[\s'"`,;()[\]{}=:<>]+/).filter(Boolean);
}

const MAX_HITS_PER_BLOB = 500;

/**
 * Scans one text blob and returns EVERY hit. `lineNumbers[i]` is the file line of `text.split('\n')[i]` (defaults to
 * i + 1). The guard reports the first finding of the text it is given, so after each finding (kept or filtered as a
 * placeholder) scanning resumes on the next line: an early placeholder never hides a later real secret.
 */
export function scanText(
  file: string,
  commit: string,
  text: string,
  lineNumbers?: readonly number[],
): SecretScanHit[] {
  const lines = text.split('\n');
  const category = categorize(file);
  const map = (index: number): number => lineNumbers?.[index] ?? index + 1;
  const hits: SecretScanHit[] = [];
  let start = 0;
  while (start < lines.length && hits.length < MAX_HITS_PER_BLOB) {
    const finding = classifyCredentialFileContent(start === 0 ? text : lines.slice(start).join('\n'));
    if (finding.kind === 'none') break;
    let index: number;
    if (finding.kind === 'credential-assignment') {
      index = start + finding.line - 1;
      // Precision: a hit counts only when a string literal near the key is credential-shaped by value.
      const near = [lines[index] ?? '', lines[index + 1] ?? ''];
      if (near.some((l) => assignedLiterals(l, category).some(isCredentialShapedValue))) {
        hits.push({ file, category, issuedCandidate: false, commit, line: map(index), rule: finding.kind, masked: '[masked]' });
      }
    } else {
      // Locate the line with the same detector, one line at a time; a multi-line shape (private-key block) reports 0.
      let found = -1;
      for (let i = start; i < lines.length; i++) {
        if (classifyCredentialFileContent(lines[i] ?? '').kind === 'secret-token') {
          found = i;
          break;
        }
      }
      if (found < 0) {
        hits.push({ file, category, issuedCandidate: false, commit, line: 0, rule: 'secret-token', masked: '[masked]' });
        break;
      }
      index = found;
      const lineText = lines[index] ?? '';
      const tokens = tokensOf(lineText);
      const candidates = tokens.filter((t) => containsCredentialMaterial(t));
      if (!(candidates.length > 0 && candidates.every(isPlaceholder))) {
        const issuedCandidate = tokens.some(
          (t) => ISSUED_PREFIX.test(t) && t.length >= 24 && !isPlaceholder(t) && entropy(t) >= 3.5 && !looksPatterned(t),
        );
        hits.push({ file, category, issuedCandidate, commit, line: map(index), rule: 'secret-token', masked: '[masked]' });
      }
    }
    start = index + 1;
  }
  return hits;
}

export interface HistoryScanResult {
  readonly hits: SecretScanHit[];
  readonly commits: number;
  readonly skipped: number;
}

/**
 * Parses `git log -p --all --no-color --no-ext-diff` output line by line and scans the ADDED lines of every file in
 * every commit (a deleted line was already added by an earlier commit, so it is covered there).
 */
export async function scanDiffStream(lines: AsyncIterable<string>): Promise<HistoryScanResult> {
  const hits: SecretScanHit[] = [];
  let commits = 0;
  let skipped = 0;
  let commit = '';
  let file = '';
  let added: string[] = [];
  let numbers: number[] = [];
  let nextLine = 0;
  let inHunk = false;

  const flush = (): void => {
    if (file && added.length > 0) {
      const text = added.join('\n');
      if (text.length > MAX_SCAN_BYTES) skipped++;
      else {
        hits.push(...scanText(file, commit, text, numbers));
      }
    }
    added = [];
    numbers = [];
  };

  for await (const line of lines) {
    if (!inHunk && line.startsWith('commit ') && /^commit [0-9a-f]{7,64}\b/.test(line)) {
      flush();
      commit = line.slice(7, 47);
      file = '';
      commits++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      flush();
      file = '';
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const path = line.slice(4);
        file = path === '/dev/null' ? '' : path.replace(/^b\//, '');
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        // A new hunk starts a new block so line numbers stay exact.
        flush();
        nextLine = Number(hunk[1]);
        inHunk = true;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      nextLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+')) {
      added.push(line.slice(1));
      numbers.push(nextLine++);
    } else if (line.startsWith(' ')) {
      nextLine++;
    } else if (line.startsWith('-') || line.startsWith('\\')) {
      // removed line or "no newline" marker: no new-file line
    } else {
      // Anything else (commit header, message, next diff) ends the hunk.
      flush();
      inHunk = false;
      if (line.startsWith('commit ') && /^commit [0-9a-f]{7,64}\b/.test(line)) {
        commit = line.slice(7, 47);
        file = '';
        commits++;
      }
    }
  }
  flush();
  return { hits, commits, skipped };
}

/** Streams git's stdout lines; rejects when git is missing (ENOENT) or exits non-zero. */
async function* runGit(cwd: string, args: readonly string[]): AsyncGenerator<string> {
  const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`git ${args[0] ?? ''} exited with ${code ?? signal ?? 'unknown'}`)),
    );
  });
  done.catch(() => undefined); // observed below; avoids an unhandled rejection while lines are still streaming
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) yield line;
  await done;
}

async function gitLines(cwd: string, args: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const l of runGit(cwd, args)) out.push(l);
  return out;
}

export async function scanWorkingTree(cwd: string): Promise<{ hits: SecretScanHit[]; files: number; skipped: number }> {
  const names = await gitLines(cwd, ['ls-files']);
  const hits: SecretScanHit[] = [];
  let skipped = 0;
  for (const name of names) {
    let buf: Buffer;
    try {
      buf = readFileSync(`${cwd}/${name}`);
    } catch {
      continue;
    }
    if (buf.length > MAX_SCAN_BYTES || buf.includes(0)) {
      skipped++;
      continue;
    }
    hits.push(...scanText(name, WORKTREE_COMMIT, buf.toString('utf8')));
  }
  return { hits, files: names.length, skipped };
}

export async function scanHistory(cwd: string): Promise<HistoryScanResult> {
  return scanDiffStream(runGit(cwd, ['log', '-p', '--all', '--no-color', '--no-ext-diff', '--format=commit %H']));
}

/** One report line per hit: file, commit, line, rule, masked value. Never the value. */
export function formatHit(hit: SecretScanHit): string {
  const flag = hit.issuedCandidate ? '  ROTATE-CANDIDATE' : '';
  return `${hit.file}:${hit.line || '?'}  commit ${hit.commit.slice(0, 12)}  ${hit.rule}  ${hit.category}  ${hit.masked}${flag}`;
}

/**
 * Non-test hits fail the scan (placeholders and non-credential literals are already filtered out), and so does any
 * hit that looks like an issued provider key (known prefix, plausible length and entropy), test paths included.
 */
export function gatingHits(hits: readonly SecretScanHit[]): SecretScanHit[] {
  return hits.filter((h) => h.category !== 'test' || h.issuedCandidate);
}

export interface SummaryRow {
  readonly rule: SecretScanHit['rule'];
  readonly where: 'tree' | 'history';
  readonly category: HitCategory;
  readonly count: number;
}

export function summarize(hits: readonly SecretScanHit[]): SummaryRow[] {
  const rows = new Map<string, SummaryRow>();
  for (const h of hits) {
    const where = h.commit === WORKTREE_COMMIT ? 'tree' : 'history';
    const key = `${h.rule}|${where}|${h.category}`;
    const prev = rows.get(key);
    rows.set(key, { rule: h.rule, where, category: h.category, count: (prev?.count ?? 0) + 1 });
  }
  return [...rows.values()].sort((a, b) =>
    `${a.rule}${a.where}${a.category}`.localeCompare(`${b.rule}${b.where}${b.category}`),
  );
}

/** History hit counts per commit (short sha, category), most hits first. */
export function historyByCommit(hits: readonly SecretScanHit[], rule: SecretScanHit['rule']): string[] {
  const counts = new Map<string, number>();
  for (const h of hits) {
    if (h.commit === WORKTREE_COMMIT || h.rule !== rule) continue;
    const key = `${h.commit.slice(0, 10)} ${h.category}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`);
}

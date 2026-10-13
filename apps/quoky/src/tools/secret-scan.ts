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
  if (containsCredentialMaterial(v)) return true;
  if (v.length < 12 || /\s/.test(v)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(v) && !/\d/.test(v)) return false; // identifier, env name
  if (/^(\.{0,2}\/|https?:\/\/[^@]*$|[a-z]+:\/\/[^@]*$)/i.test(v)) return false; // path or URL without userinfo
  if (!/^[A-Za-z0-9+/=_.~-]+$/.test(v)) return false; // regexes, templates and prose are not credential charsets
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  return entropy(v) >= 3.0;
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

/** Scans one text blob. `lineNumbers[i]` is the file line of `text.split('\n')[i]` (defaults to i + 1). */
export function scanText(
  file: string,
  commit: string,
  text: string,
  lineNumbers?: readonly number[],
): SecretScanHit | undefined {
  const finding = classifyCredentialFileContent(text);
  if (finding.kind === 'none') return undefined;
  const lines = text.split('\n');
  const map = (index: number): number => lineNumbers?.[index] ?? index + 1;
  let index = -1;
  if (finding.kind === 'credential-assignment') {
    index = finding.line - 1;
    // Precision: a hit counts only when a string literal near the key is credential-shaped by value.
    const near = [lines[index] ?? '', lines[index + 1] ?? ''];
    if (!near.some((l) => assignedLiterals(l, categorize(file)).some(isCredentialShapedValue))) return undefined;
  } else {
    // Locate the line with the same detector, one line at a time; multi-line shapes (private-key blocks) report 0.
    index = lines.findIndex((l) => classifyCredentialFileContent(l).kind === 'secret-token');
    if (index >= 0) {
      const candidates = tokensOf(lines[index] ?? '').filter((t) => containsCredentialMaterial(t));
      if (candidates.length > 0 && candidates.every(isPlaceholder)) return undefined;
    }
  }
  const lineText = index >= 0 ? (lines[index] ?? '') : '';
  const issuedCandidate =
    finding.kind === 'secret-token' &&
    tokensOf(lineText).some((t) => ISSUED_PREFIX.test(t) && t.length >= 24 && !isPlaceholder(t) && entropy(t) >= 3.5);
  return {
    file,
    category: categorize(file),
    issuedCandidate,
    commit,
    line: index >= 0 ? map(index) : 0,
    rule: finding.kind,
    masked: '[masked]',
  };
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
        const hit = scanText(file, commit, text, numbers);
        if (hit) hits.push(hit);
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

function runGit(cwd: string, args: readonly string[]): AsyncIterable<string> {
  const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  return createInterface({ input: child.stdout, crlfDelay: Infinity });
}

function gitLines(cwd: string, args: readonly string[]): Promise<string[]> {
  return (async () => {
    const out: string[] = [];
    for await (const l of runGit(cwd, args)) out.push(l);
    return out;
  })();
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
    const hit = scanText(name, WORKTREE_COMMIT, buf.toString('utf8'));
    if (hit) hits.push(hit);
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

/** Only non-test hits fail the scan (placeholders and non-credential literals are already filtered out). */
export function gatingHits(hits: readonly SecretScanHit[]): SecretScanHit[] {
  return hits.filter((h) => h.category !== 'test');
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

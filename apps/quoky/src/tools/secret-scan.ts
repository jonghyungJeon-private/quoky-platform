/**
 * Repository secret scan (ADR-0121 S0, MSIT ③-2): scans the tracked working tree and the added lines of the full git
 * history for credential-shaped values with the runtime credential guard's shapes and key rule (ADR-0097). In-repo,
 * no new dependency.
 *
 * Every rule enumerates EVERY span in a blob independently (no first-match, no early exit, no cap): each vendor token
 * shape match, and each credential-shaped literal assigned to a credential-named key. Each span is classified and
 * fingerprinted on its own, so a placeholder, a reviewed value or a fixture never hides another span. A hit names the
 * file, the commit, the line and the span's SHA-256 fingerprint; the value itself is never stored or printed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  classifyCredentialFileContent,
  containsCredentialMaterial,
  credentialDetectionView,
  SECRET_TOKEN_PATTERNS,
} from '@quoky/core';

export type HitCategory = 'test' | 'docs' | 'source';

/**
 * How one span is judged, on its own:
 * - `issued-candidate`: a vendor prefix with a plausible, random-looking body, or a GitHub token whose CRC32/base62
 *   checksum is valid (always, in any path; no placeholder or fixture heuristic overrides a valid checksum);
 * - `not-issued-shape`: a GitHub prefix whose body length or checksum is wrong, so GitHub cannot have issued it;
 * - `fixture-shape`: a vendor prefix with a hand-made body (repeats, runs, `test`/`fake`, too short or low entropy);
 * - `credential`: a credential-shaped value with no verifiable issuer shape (assignment literal, bearer, JWT, key block);
 * - `placeholder`: a template or placeholder value. Reported, never gates.
 */
export type SpanClass = 'issued-candidate' | 'not-issued-shape' | 'fixture-shape' | 'credential' | 'placeholder';

export interface SecretScanHit {
  readonly file: string;
  /** `test` (fixtures and tests), `docs` (markdown, docs/, `.env.example`) or `source`. */
  readonly category: HitCategory;
  readonly classification: SpanClass;
  /** `classification === 'issued-candidate'`: a key to rotate unless its fingerprint is reviewed. Gates in any path. */
  readonly issuedCandidate: boolean;
  /** `classification === 'not-issued-shape'`. */
  readonly notIssuedShape: boolean;
  /** SHA-256 of this span's exact value (never the value). One per span; the reviewed list matches on it only. */
  readonly fingerprint: string;
  /** The fingerprint is in the reviewed list: reported, does not gate. */
  readonly reviewed: boolean;
  /** Commit sha for a history hit, or `WORKTREE` for the working tree. */
  readonly commit: string;
  /** 1-based line in the file at that commit where the span starts. */
  readonly line: number;
  readonly rule: 'secret-token' | 'credential-assignment';
  /** Always the fixed marker; the value is never stored in a hit. */
  readonly masked: '[masked]';
}

export const WORKTREE_COMMIT = 'WORKTREE';

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

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(text: string): number {
  let c = 0xffffffff;
  for (const b of Buffer.from(text, 'utf8')) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * GitHub's token format: `ghp_|gho_|ghu_|ghs_|ghr_` + 30 random characters + a 6-character base62 CRC32 checksum of those
 * 30, 36 characters in all. Anything else with such a prefix cannot have been issued by GitHub.
 */
export function isValidGithubTokenShape(token: string): boolean {
  const m = /^gh[pousr]_([A-Za-z0-9]+)$/.exec(token);
  const body = m?.[1];
  if (!body || body.length !== 36) return false;
  let n = crc32(body.slice(0, 30));
  let out = '';
  for (let i = 0; i < 6; i++) {
    out = (BASE62[n % 62] ?? '0') + out;
    n = Math.floor(n / 62);
  }
  return out === body.slice(30);
}

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Every vendor prefix of the guard's token shapes; a random-looking body after one is an issued-key candidate. */
const ISSUED_PREFIX = /^(sk-|[sr]k_live_|github_pat_|gh[pousr]_|xox[abeprs]-|AKIA|ASIA|AIza)/;
const GITHUB_CLASSIC = /^gh[pousr]_/;
const BEARER_PREFIX = /^Bearer\s+/;
const PRIVATE_KEY_BEGIN = /^-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function isPlaceholderToken(span: string): boolean {
  if (PRIVATE_KEY_BEGIN.test(span)) return false;
  const body = span.replace(ISSUED_PREFIX, '').replace(BEARER_PREFIX, '');
  return isPlaceholder(span) || isPlaceholder(body);
}

/**
 * Classifies one vendor-shaped span on its own. A GitHub classic token (`gh[pousr]_`) with a valid body length and
 * CRC32/base62 checksum is ALWAYS an issued candidate: no placeholder, `test` or pattern heuristic can override it.
 */
export function classifyTokenSpan(span: string): SpanClass {
  if (GITHUB_CLASSIC.test(span)) {
    if (isValidGithubTokenShape(span)) return 'issued-candidate';
    return isPlaceholderToken(span) ? 'placeholder' : 'not-issued-shape';
  }
  if (isPlaceholderToken(span)) return 'placeholder';
  if (ISSUED_PREFIX.test(span)) {
    const minLength = /^(AKIA|ASIA)/.test(span) ? 20 : 24;
    return span.length >= minLength && entropy(span) >= 3.5 && !looksPatterned(span) ? 'issued-candidate' : 'fixture-shape';
  }
  return 'credential';
}

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

const TOKEN_PATTERNS = SECRET_TOKEN_PATTERNS.map((p) => new RegExp(p, 'gu'));
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/gu;

/**
 * Every match of every vendor token shape in `text`, each pattern on its own (overlapping matches of different shapes,
 * e.g. a bearer header around a GitHub token, are all kept). A private-key span runs from BEGIN to its END line.
 */
function tokenSpans(text: string): { index: number; value: string }[] {
  const out: { index: number; value: string }[] = [];
  for (const pattern of TOKEN_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const index = m.index ?? 0;
      let value = m[0];
      if (PRIVATE_KEY_BEGIN.test(value)) {
        PRIVATE_KEY_END.lastIndex = index + value.length;
        const end = PRIVATE_KEY_END.exec(text);
        const eol = text.indexOf('\n', index);
        value = text.slice(index, end ? end.index + end[0].length : eol < 0 ? text.length : eol);
      }
      out.push({ index, value });
    }
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 0-based line index of `offset`. */
function lineIndexOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Token spans replaced by same-length filler (line feeds kept), so a token shape cannot pre-empt the key rule. */
function maskTokens(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, (m) => m.replace(/[^\n]/gu, '_'));
  return out;
}

/** Whether the guard's key rule sees a credential-named key assigned a literal on line `i` or the line before it. */
function credentialKeyNear(lines: readonly string[], i: number): boolean {
  const window = i > 0 ? `${lines[i - 1] ?? ''}\n${lines[i] ?? ''}` : (lines[i] ?? '');
  return classifyCredentialFileContent(maskTokens(credentialDetectionView(window))).kind === 'credential-assignment';
}

/**
 * Scans one text blob and returns EVERY hit; `lineNumbers[i]` is the file line of `text.split('\n')[i]` (defaults to
 * i + 1). There is no first-match logic, no early exit and no cap:
 * - `secret-token`: every match of every vendor shape, in the text and in its detection view;
 * - `credential-assignment`: on every line, every credential-shaped literal assigned next to a credential-named key.
 * Each span is classified and fingerprinted on its own; a filtered span (placeholder, fixture, reviewed) never
 * suppresses another span.
 */
export function scanText(
  file: string,
  commit: string,
  text: string,
  lineNumbers?: readonly number[],
): SecretScanHit[] {
  const category = categorize(file);
  const map = (index: number): number => lineNumbers?.[index] ?? index + 1;
  const hits: SecretScanHit[] = [];
  const seen = new Set<string>();
  const add = (rule: SecretScanHit['rule'], index: number, value: string, classification: SpanClass): void => {
    const key = `${rule}\u0000${index}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      file,
      category,
      classification,
      issuedCandidate: classification === 'issued-candidate',
      notIssuedShape: classification === 'not-issued-shape',
      fingerprint: tokenFingerprint(value),
      reviewed: false,
      commit,
      line: map(index),
      rule,
      masked: '[masked]',
    });
  };

  const view = credentialDetectionView(text);
  for (const source of view === text ? [text] : [text, view]) {
    const starts = lineStarts(source);
    for (const span of tokenSpans(source)) {
      add('secret-token', lineIndexOf(starts, span.index), span.value, classifyTokenSpan(span.value));
    }
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const values = assignedLiterals(lines[i] ?? '', category).filter(isCredentialShapedValue);
    if (values.length === 0 || !credentialKeyNear(lines, i)) continue;
    for (const value of values) add('credential-assignment', i, value, 'credential');
  }

  return hits.sort((x, y) => x.line - y.line || x.rule.localeCompare(y.rule));
}

export interface HistoryScanResult {
  readonly hits: SecretScanHit[];
  readonly commits: number;
}

/**
 * Parses `git log -p --text --all --no-color --no-ext-diff` output line by line and scans the ADDED lines of every
 * file in every commit (a deleted line was already added by an earlier commit, so it is covered there). Every hunk is
 * scanned whatever its size: there is no size cap and no hit cap.
 */
export async function scanDiffStream(lines: AsyncIterable<string>): Promise<HistoryScanResult> {
  const hits: SecretScanHit[] = [];
  let commits = 0;
  let commit = '';
  let file = '';
  let added: string[] = [];
  let numbers: number[] = [];
  let nextLine = 0;
  let inHunk = false;

  const flush = (): void => {
    if (file && added.length > 0) {
      for (const hit of scanText(file, commit, added.join('\n'), numbers)) hits.push(hit);
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
  return { hits, commits };
}

/** Streams git's stdout lines; rejects when git is missing (ENOENT) or exits non-zero. */
async function* runGit(cwd: string, args: readonly string[]): AsyncGenerator<string> {
  const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} exited with ${code ?? signal ?? 'unknown'}`)),
    );
  });
  done.catch(() => undefined); // observed below; avoids an unhandled rejection while lines are still streaming
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) yield line;
  await done;
}

export interface WorkingTreeScanResult {
  readonly hits: SecretScanHit[];
  readonly files: number;
  /** Tracked paths that could not be read (deleted in the working tree, or not a regular file). Listed, never silent. */
  readonly unreadable: string[];
}

/**
 * Scans every tracked file, whatever its size or content (a text file with a NUL byte is still scanned): there is no
 * size cap and no hit cap.
 */
export async function scanWorkingTree(cwd: string): Promise<WorkingTreeScanResult> {
  const raw: string[] = [];
  for await (const l of runGit(cwd, ['-c', 'core.quotePath=false', 'ls-files', '-z'])) raw.push(l);
  const names = raw.join('\n').split('\u0000').filter(Boolean);
  const hits: SecretScanHit[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    let buf: Buffer;
    try {
      buf = readFileSync(`${cwd}/${name}`);
    } catch {
      unreadable.push(name);
      continue;
    }
    for (const hit of scanText(name, WORKTREE_COMMIT, buf.toString('utf8'))) hits.push(hit);
  }
  return { hits, files: names.length, unreadable };
}

export async function scanHistory(cwd: string): Promise<HistoryScanResult> {
  return scanDiffStream(
    runGit(cwd, ['-c', 'core.quotePath=false', 'log', '-p', '--text', '--all', '--no-color', '--no-ext-diff', '--format=commit %H']),
  );
}

/** One report line per hit: file, commit, line, rule, masked value. Never the value. */
export function formatHit(hit: SecretScanHit): string {
  const flag = hit.reviewed
    ? '  reviewed'
    : hit.issuedCandidate
      ? '  ROTATE-CANDIDATE'
      : hit.classification === 'credential'
        ? ''
        : `  ${hit.classification}`;
  return `${hit.file}:${hit.line}  commit ${hit.commit.slice(0, 12)}  ${hit.rule}  ${hit.category}  ${hit.masked}  sha256:${hit.fingerprint.slice(0, 12)}${flag}`;
}

/**
 * A hit gates unless its own fingerprint is reviewed or it is a placeholder: every non-test hit, and every
 * issued-key candidate in any path (a checksum-valid GitHub token in a test file included).
 */
export function gatingHits(hits: readonly SecretScanHit[]): SecretScanHit[] {
  return hits.filter(
    (h) => !h.reviewed && h.classification !== 'placeholder' && (h.category !== 'test' || h.issuedCandidate),
  );
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

export interface ReviewedEntry {
  readonly fingerprint: string;
  readonly reason: string;
  readonly reviewer: string;
  readonly date: string;
}

export const REVIEWED_FILE = 'ops/security/secret-scan-reviewed.json';

/** Loads the committed list of reviewed SHA-256 fingerprints (no values). A missing file is an empty list. */
export function loadReviewed(cwd: string): ReviewedEntry[] {
  const path = `${cwd}/${REVIEWED_FILE}`;
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error('secret-scan-reviewed.json: entries must be an array');
  return entries.map((e: Partial<ReviewedEntry>) => {
    if (!/^[0-9a-f]{64}$/.test(e.fingerprint ?? '') || !e.reason || !e.reviewer || !e.date) {
      throw new Error('secret-scan-reviewed.json: each entry needs fingerprint (sha-256 hex), reason, reviewer, date');
    }
    return { fingerprint: e.fingerprint as string, reason: e.reason, reviewer: e.reviewer, date: e.date };
  });
}

/** Marks hits whose own span fingerprint is EXACTLY in the reviewed list (never by line, file or commit). */
export function applyReviewed(hits: readonly SecretScanHit[], reviewed: readonly ReviewedEntry[]): SecretScanHit[] {
  const known = new Set(reviewed.map((e) => e.fingerprint));
  return hits.map((h) => (h.fingerprint !== '' && known.has(h.fingerprint) ? { ...h, reviewed: true } : h));
}

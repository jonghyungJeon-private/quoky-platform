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
import { classifyCredentialFileContent } from '@quoky/core';

export interface SecretScanHit {
  readonly file: string;
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

/** Scans one text blob. `lineNumbers[i]` is the file line of `text.split('\n')[i]` (defaults to i + 1). */
export function scanText(
  file: string,
  commit: string,
  text: string,
  lineNumbers?: readonly number[],
): SecretScanHit | undefined {
  const finding = classifyCredentialFileContent(text);
  if (finding.kind === 'none') return undefined;
  const map = (index: number): number => lineNumbers?.[index] ?? index + 1;
  let line = 0;
  if (finding.kind === 'credential-assignment') {
    line = map(finding.line - 1);
  } else {
    // Locate the line with the same detector, one line at a time; multi-line shapes (private-key blocks) report 0.
    const lines = text.split('\n');
    const at = lines.findIndex((l) => classifyCredentialFileContent(l).kind === 'secret-token');
    line = at >= 0 ? map(at) : 0;
  }
  return { file, commit, line, rule: finding.kind, masked: '[masked]' };
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
  return `${hit.file}:${hit.line || '?'}  commit ${hit.commit.slice(0, 12)}  ${hit.rule}  ${hit.masked}`;
}

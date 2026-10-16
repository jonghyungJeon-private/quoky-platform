// The D12 gold corpora as the harness sees them: id, text, entry label, corpus (read regression vs A6 action), the
// corpus digest, and the cases the RAG-0 ratchet already marks as contaminated (excluded from pass / stop scoring).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareSelectionInput } from '@quoky/core';

export const GOLDEN_DIR = resolve(__dirname, '../../../../../packages/core/src/application/golden');
export const KNOWN_FINDINGS_PATH = resolve(__dirname, '../../../../../packages/core/src/application/nl-routing/example-contamination.known.v1.json');
export const GOLD_FILES = ['nl-intent.v1.json', 'nl-action.v1.json', 'nl-action.seed.v1.json', 'nl-action.exec-time.v1.json'] as const;

export type Corpus = 'read' | 'action';

export interface GoldCase {
  readonly id: string;
  readonly text: string;
  /** The text the retrieval query embeds (`prepareSelectionInput().text`: quoted and code spans masked). */
  readonly queryText: string;
  /** The expected entry id, or `none`. */
  readonly entry: string;
  readonly corpus: Corpus;
  readonly previous?: string;
  readonly expect?: { readonly entryId?: unknown; readonly args?: unknown };
}

export interface GoldSet {
  readonly cases: readonly GoldCase[];
  /** sha256 over the four corpus files in their fixed order. */
  readonly sha256: string;
}

interface RawCase {
  id: string;
  text: string;
  prior?: unknown;
  fixture?: unknown;
  expect: unknown;
}

export function entryOf(expect: unknown): string {
  if (typeof expect === 'string') return expect;
  if (typeof expect === 'object' && expect !== null && typeof (expect as { entryId?: unknown }).entryId === 'string') return (expect as { entryId: string }).entryId;
  return 'none';
}

export function queryTextOf(text: string): string {
  const prepared = prepareSelectionInput(text);
  return 'skip' in prepared ? text : prepared.text;
}

export function loadGold(dir: string = GOLDEN_DIR): GoldSet {
  const hash = createHash('sha256');
  const cases: GoldCase[] = [];
  const seen = new Set<string>();
  for (const file of GOLD_FILES) {
    const raw = readFileSync(resolve(dir, file), 'utf8');
    hash.update(raw);
    const corpus: Corpus = file === 'nl-intent.v1.json' ? 'read' : 'action';
    for (const golden of (JSON.parse(raw) as { cases: RawCase[] }).cases) {
      if (seen.has(golden.id)) continue;
      seen.add(golden.id);
      const previousParts: string[] = [];
      if (golden.prior !== undefined) previousParts.push(JSON.stringify(golden.prior));
      if (golden.fixture !== undefined) previousParts.push(JSON.stringify(golden.fixture));
      cases.push({
        id: golden.id,
        text: golden.text,
        queryText: queryTextOf(golden.text),
        entry: entryOf(golden.expect),
        corpus,
        ...(previousParts.length > 0 ? { previous: previousParts.join(' ') } : {}),
        ...(typeof golden.expect === 'object' && golden.expect !== null ? { expect: golden.expect as GoldCase['expect'] } : {}),
      });
    }
  }
  return { cases, sha256: hash.digest('hex') };
}

export interface KnownFinding {
  readonly example: string;
  readonly previous?: string;
  readonly goldId: string;
  readonly kind: string;
  readonly tokenJ?: number;
  readonly charJ?: number;
}

export function loadKnownFindings(path: string = KNOWN_FINDINGS_PATH): KnownFinding[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { findings: KnownFinding[] }).findings;
}

/** The gold cases the static prompt's own examples already copy (RAG-0 ratchet): reported apart, never scored. */
export function contaminatedGoldIds(findings: readonly KnownFinding[]): Set<string> {
  return new Set(findings.map((finding) => finding.goldId));
}

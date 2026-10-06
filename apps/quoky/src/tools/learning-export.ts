/**
 * Offline learning export (ADR-0107 D4, LRN-1).
 *
 *   node apps/quoky/dist/tools/learning-export.js --db <path to the Quoky SQLite DB> --out <new JSON file>
 *
 * Reads the owner's approved `GOLDEN_CANDIDATE` items (`후보 N 메모: …`) and writes them as golden corpus cases to a
 * NEW local file. No network, no provider, no Discord. The database is opened read-only and is never created,
 * migrated or pruned (a schema below v14 or ahead of this build is refused). The output file must not exist yet
 * (never overwritten). The credential guard runs again at export (ADR-0107 D1 "again at use"): a matching item is
 * left out, never redacted. Only text is printed to the file; the console shows counts only.
 *
 * The cases are review material, not a corpus: each has `mustPass: false` and an `expected` that the owner replaces
 * with the target suite's expected value. Cases enter the repository only through an owner-reviewed PR; committing
 * them publishes their text to the repository remote, which the owner decides per case.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEARNING_EGRESS_LOCAL_ONLY, LearningItemKind, learningItemUsable } from '@quoky/core';
import type { LearningItem } from '@quoky/core';
import { openLearningExportReader } from '@quoky/storage-sqlite';

export const LEARNING_EXPORT_SUITE = 'learning-golden-candidates';
export const LEARNING_EXPORT_VERSION = 1;
export const LEARNING_EXPORT_REVIEW_MARKER = 'OWNER_REVIEW_REQUIRED';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
/** The database cannot be exported from (missing schema, ahead of this build) or the output file already exists. */
export const EXIT_BLOCKED = 3;

/** The review-only expected value of an exported case. */
export interface LearningExportExpected {
  readonly review: typeof LEARNING_EXPORT_REVIEW_MARKER;
  /** The owner's note on what was wrong (`후보 N 메모: …`). */
  readonly ownerNote: string;
  readonly expectedBehavior?: string;
  /** What the turn was routed to when it was rated 👎 (routing facts, never a provider id). */
  readonly observed: { readonly capability: string; readonly intentType?: string };
}

/** One exported case: the `GoldenCase` shape (`id`, `text`, `expected`, `source`, `mustPass`). */
export interface LearningExportCase {
  readonly id: string;
  readonly text: string;
  readonly expected: LearningExportExpected;
  readonly source: string;
  readonly mustPass: false;
}

export interface LearningExportFile {
  readonly suite: typeof LEARNING_EXPORT_SUITE;
  readonly version: typeof LEARNING_EXPORT_VERSION;
  readonly note: string;
  readonly exportedAt: string;
  readonly cases: readonly LearningExportCase[];
}

export interface LearningExportResult {
  readonly file: LearningExportFile;
  /** Items left out: guard or bound failure at export, a non-`LOCAL_ONLY` egress, another kind, or no note. */
  readonly skipped: { readonly guarded: number; readonly egress: number; readonly kind: number; readonly noNote: number };
}

const EXPORT_NOTE =
  'ADR-0107 D4 export of owner-approved learning candidates. Review material only: move a case into the target suite '
  + '(e.g. intent-routing, turn-handler-routing) with that suite\'s expected value and source, through an owner-reviewed '
  + 'PR. Committing a case publishes its text to the repository remote; decide per case. Cases are never added '
  + 'automatically (ADR-0098 D7).';

/** Build the export from stored items. Pure: no I/O, no clock. Item order is kept (the reader gives oldest first). */
export function buildLearningExport(items: readonly LearningItem[], exportedAt: string): LearningExportResult {
  const skipped = { guarded: 0, egress: 0, kind: 0, noNote: 0 };
  const cases: LearningExportCase[] = [];
  for (const item of items) {
    if (item.kind !== LearningItemKind.GOLDEN_CANDIDATE) {
      skipped.kind += 1;
      continue;
    }
    if (item.egress !== LEARNING_EGRESS_LOCAL_ONLY) {
      skipped.egress += 1;
      continue;
    }
    if (item.data.note === undefined) {
      skipped.noNote += 1;
      continue;
    }
    if (!learningItemUsable(item.data)) {
      skipped.guarded += 1;
      continue;
    }
    cases.push({
      id: `lrn-${item.id}`,
      text: item.data.requestText,
      expected: {
        review: LEARNING_EXPORT_REVIEW_MARKER,
        ownerNote: item.data.note,
        ...(item.data.expectedBehavior !== undefined ? { expectedBehavior: item.data.expectedBehavior } : {}),
        observed: {
          capability: item.capability,
          ...(item.data.intentType !== undefined ? { intentType: item.data.intentType } : {}),
        },
      },
      source: `learning_items ${item.id} (owner note, captured ${item.createdAt.slice(0, 10)})`,
      mustPass: false,
    });
  }
  return {
    file: { suite: LEARNING_EXPORT_SUITE, version: LEARNING_EXPORT_VERSION, note: EXPORT_NOTE, exportedAt, cases },
    skipped,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an export file (as parsed JSON): the suite header, unique non-empty case ids, and every case in the
 * `GoldenCase` shape with the review marker. Returns the problems found (empty when valid).
 */
export function validateLearningExport(value: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(value)) return ['not an object'];
  if (value.suite !== LEARNING_EXPORT_SUITE) problems.push('suite');
  if (value.version !== LEARNING_EXPORT_VERSION) problems.push('version');
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) problems.push('exportedAt');
  if (!Array.isArray(value.cases)) return [...problems, 'cases'];
  const ids = new Set<string>();
  value.cases.forEach((entry: unknown, index) => {
    const at = `cases[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(at);
      return;
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) problems.push(`${at}.id`);
    else if (ids.has(entry.id)) problems.push(`${at}.id duplicate`);
    else ids.add(entry.id);
    if (typeof entry.text !== 'string' || entry.text.trim().length === 0) problems.push(`${at}.text`);
    if (typeof entry.source !== 'string' || entry.source.length === 0) problems.push(`${at}.source`);
    if (entry.mustPass !== false) problems.push(`${at}.mustPass`);
    const expected = entry.expected;
    if (!isPlainObject(expected) || expected.review !== LEARNING_EXPORT_REVIEW_MARKER
      || typeof expected.ownerNote !== 'string' || !isPlainObject(expected.observed)
      || typeof expected.observed.capability !== 'string') {
      problems.push(`${at}.expected`);
    }
  });
  return problems;
}

export interface LearningExportCliDeps {
  readonly now: () => string;
  readonly openReader: typeof openLearningExportReader;
  /** Write a NEW file; throws (EEXIST) when it exists. */
  readonly writeNewFile: (path: string, content: string) => void;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const HELP = `Learning export (ADR-0107 D4) — offline, read-only, no network

  node apps/quoky/dist/tools/learning-export.js --db <quoky sqlite db> --out <new json file>

Writes the owner-approved learning candidates ("후보 N 메모: …") as review-only golden cases to a NEW file.
The database is opened read-only and never migrated; the output file must not exist.
`;

const DEFAULT_DEPS: LearningExportCliDeps = {
  now: () => new Date().toISOString(),
  openReader: openLearningExportReader,
  writeNewFile: (path, content) => writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

function parseArgs(argv: readonly string[]): Record<string, string> | null {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if ((key !== '--db' && key !== '--out') || value === undefined || value.startsWith('--') || key in options) return null;
    options[key] = value;
  }
  return options['--db'] && options['--out'] ? options : null;
}

/** Run the export. Prints counts only (never item text or the file content). */
export async function runCli(argv: readonly string[], deps: LearningExportCliDeps = DEFAULT_DEPS): Promise<number> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.includes('--help') || args.includes('-h')) {
    deps.stdout(HELP);
    return EXIT_OK;
  }
  const options = parseArgs(args);
  if (!options) {
    deps.stderr(HELP);
    return EXIT_USAGE;
  }
  const dbPath = resolve(options['--db'] as string);
  const outPath = resolve(options['--out'] as string);
  let reader: ReturnType<typeof openLearningExportReader> | undefined;
  try {
    reader = deps.openReader(dbPath);
    const exportedAt = deps.now();
    const items = reader.listForExport(LearningItemKind.GOLDEN_CANDIDATE, exportedAt);
    const result = buildLearningExport(items, exportedAt);
    const problems = validateLearningExport(result.file);
    if (problems.length > 0) {
      deps.stderr(`export is invalid (${problems.length} problems); nothing was written`);
      return EXIT_FAILED;
    }
    deps.writeNewFile(outPath, `${JSON.stringify(result.file, null, 2)}\n`);
    const { guarded, egress, kind, noNote } = result.skipped;
    deps.stdout(`learning export: ${result.file.cases.length} cases written to ${outPath}`);
    deps.stdout(`left out: ${guarded} guarded, ${egress} non-local egress, ${kind} other kind, ${noNote} without a note`);
    return EXIT_OK;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : '';
    if (code === 'EEXIST') {
      deps.stderr('BLOCKED: the output file already exists; choose a new path (nothing was overwritten)');
      return EXIT_BLOCKED;
    }
    if (message === 'LEARNING_SCHEMA_MISSING' || message === 'SCHEMA_VERSION_AHEAD') {
      deps.stderr(`BLOCKED: ${message}; the database was not changed`);
      return EXIT_BLOCKED;
    }
    deps.stderr(`error: ${error instanceof Error ? error.name : 'unknown'}${typeof code === 'string' ? ` (${code})` : ''}`);
    return EXIT_FAILED;
  } finally {
    reader?.close();
  }
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT_FAILED;
    },
  );
}

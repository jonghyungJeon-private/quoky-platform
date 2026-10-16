// ADR-0123 D4 / RAG-1: the example pool. Loader, schema check (closed entry ids and args through Core's catalog),
// credential guard, identifier rule (placeholders only), the n-gram lint against every gold case (any finding rejects an
// entry: the pool has no ratchet), the coverage report and the pool digest.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NL_ACTION_ENTRIES,
  NL_CATALOG_ENTRY_IDS,
  NL_RANGE_SYMBOLS,
  NL_WAVE1_ENTRIES,
  closeness,
  containsCredentialMaterial,
  findingKind,
  isShortText,
  normalize,
  sharedSpanArg,
  type NlCatalogEntry,
} from '@quoky/core';
import type { GoldCase } from './gold';

export const POOL_PATH = resolve(__dirname, '../../../../../apps/quoky/src/tools/selector-rag/selector-pool.v1.json');
export const POOL_CAP = 2000;
export const COVERAGE_TARGET = { entries: 150, perEntry: 5, negativeShare: 0.2 } as const;
/** A pair finding needs the message alone to be at least this close to the gold message (RAG-0 note). */
const PAIR_TEXT_FLOOR = 0.3;

export type BatchStatus = 'pending-owner-approval' | 'approved' | 'rejected';

export interface PoolBatch {
  readonly batch: number;
  readonly status: BatchStatus;
  readonly drafter: string;
  readonly draftedOn: string;
  readonly approvedBy: string | null;
  readonly approvedOn: string | null;
}

export interface PoolEntry {
  readonly id: string;
  readonly text: string;
  readonly previous?: string;
  readonly context?: string;
  /** The exact expected output string, as a `PromptExample` renders it. */
  readonly output: string;
  readonly needs: readonly string[];
  readonly source: 'drafted' | 'owner';
  readonly batch: number;
  readonly language: 'ko' | 'en';
}

export interface PoolFile {
  readonly version: 1;
  readonly description: string;
  readonly batches: readonly PoolBatch[];
  readonly entries: readonly PoolEntry[];
}

export function loadPoolFile(path: string = POOL_PATH): PoolFile {
  return JSON.parse(readFileSync(path, 'utf8')) as PoolFile;
}

/** sha256 over the entries only, so approving a batch (a status change) does not move the digest. */
export function poolDigest(entries: readonly PoolEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Entries usable in a plan or run: only those of an owner-approved batch (the drafter never approves). */
export function approvedEntries(pool: PoolFile): PoolEntry[] {
  const approved = new Set(pool.batches.filter((batch) => batch.status === 'approved' && batch.approvedBy !== null).map((batch) => batch.batch));
  return pool.entries.filter((entry) => approved.has(entry.batch));
}

const ALL_ENTRIES: ReadonlyMap<string, NlCatalogEntry> = new Map(
  [...NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]), ...Object.values(NL_ACTION_ENTRIES)]
    .filter((entry): entry is NlCatalogEntry => entry !== undefined)
    .map((entry) => [entry.id, entry] as const),
);
/** Entry ids a pool example may select: the offered catalog (`slack.post` and `calendar.create` are never offered). */
export const POOL_ENTRY_IDS: readonly string[] = [...ALL_ENTRIES.keys()];

const WEEKDAY = '(?:mon|tue|wed|thu|fri|sat|sun)';
const RANGE_PATTERN = new RegExp(`^(?:${WEEKDAY}|(?:this|next|last|until|until-next)-${WEEKDAY}|until-${WEEKDAY}|\\d{2}-\\d{2}(?:\\.\\.\\d{2}-\\d{2})?)$`);

// --- identifier rule (D4): placeholders only --------------------------------------------------------------------------
const PLACEHOLDER_PROJECTS = new Set(['ABC', 'DEF', 'XYZ', 'PROJ', 'DEMO']);
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-\d{1,6}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const URL_HOST = /\bhttps?:\/\/([^\s/'")]+)/gi;
const CHANNEL = /(?:^|\s)#([A-Za-z0-9가-힣_-]+)/g;
const MENTION = /(?:^|\s)@([A-Za-z0-9가-힣_.-]+)/g;
const PLACEHOLDER_HOST = /(?:^|\.)(?:example\.invalid|example\.com|example\.org|example\.net)$/i;

export function identifierProblems(text: string): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(JIRA_KEY)) if (!PLACEHOLDER_PROJECTS.has(match[1] as string)) problems.push(`issue key ${match[0]} is not a placeholder (use ABC-123 style)`);
  for (const match of text.matchAll(EMAIL)) if (!PLACEHOLDER_HOST.test(match[1] as string)) problems.push('email address is not a placeholder (use user@example.com)');
  for (const match of text.matchAll(URL_HOST)) if (!PLACEHOLDER_HOST.test(match[1] as string)) problems.push(`URL host ${match[1]} is not a placeholder (use example.invalid)`);
  for (const match of text.matchAll(CHANNEL)) if (!/^channel-[a-z]$/.test(match[1] as string)) problems.push(`channel #${match[1]} is not a placeholder (use #channel-a)`);
  for (const match of text.matchAll(MENTION)) problems.push(`mention @${match[1]} is not allowed (use <person>)`);
  return problems;
}

// --- schema -------------------------------------------------------------------------------------------------------------
function argProblems(entry: NlCatalogEntry, args: Record<string, unknown>, text: string): string[] {
  const problems: string[] = [];
  const haystack = text.normalize('NFC');
  for (const spec of entry.args) if (spec.required === true && !(spec.name in args)) problems.push(`missing required arg ${spec.name}`);
  for (const [name, value] of Object.entries(args)) {
    const spec = entry.args.find((candidate) => candidate.name === name);
    if (spec === undefined) {
      problems.push(`unknown arg ${name} for ${entry.id}`);
      continue;
    }
    switch (spec.kind) {
      case 'enum':
        if (typeof value !== 'string' || !(spec.values ?? []).includes(value)) problems.push(`arg ${name} is not one of ${(spec.values ?? []).join('|')}`);
        break;
      case 'flag':
        if (value !== true) problems.push(`arg ${name} must be true`);
        break;
      case 'limit':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) problems.push(`arg ${name} must be an integer 1..10`);
        break;
      case 'range':
        if (typeof value !== 'string' || !((NL_RANGE_SYMBOLS as readonly string[]).includes(value) || RANGE_PATTERN.test(value))) problems.push(`arg ${name} is not a range symbol`);
        break;
      case 'ref':
        if (typeof value !== 'string' || !/^(?:#\d{1,3}|recent|this|last)$/.test(value)) problems.push(`arg ${name} is not a reference`);
        break;
      default:
        // keyword / span: verbatim from the message (the reminder `when` may drop a trailing particle, so only containment is checked)
        if (typeof value !== 'string' || value.length === 0 || Array.from(value).length > 200) problems.push(`arg ${name} must be 1..200 characters`);
        else if (!haystack.includes(value.normalize('NFC'))) problems.push(`arg ${name} is not verbatim in the message`);
    }
  }
  return problems;
}

export function entryProblems(entry: PoolEntry): string[] {
  const problems: string[] = [];
  if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,80}$/.test(entry.id)) problems.push('id must match [a-z0-9._-]{3,81}');
  if (typeof entry.text !== 'string' || entry.text.trim().length === 0 || Array.from(entry.text).length > 300) problems.push('text must be 1..300 characters');
  if (entry.source !== 'drafted' && entry.source !== 'owner') problems.push('source must be drafted or owner');
  if (entry.language !== 'ko' && entry.language !== 'en') problems.push('language must be ko or en');
  if (!Number.isInteger(entry.batch) || entry.batch < 1) problems.push('batch must be a positive integer');
  let parsed: { entryId?: unknown; args?: unknown; ambiguity?: unknown; alternatives?: unknown } | undefined;
  try {
    parsed = JSON.parse(entry.output) as typeof parsed;
  } catch {
    problems.push('output is not JSON');
  }
  if (parsed !== undefined) {
    const id = parsed.entryId;
    if (id === 'none') {
      if (JSON.stringify(parsed.args) !== '{}') problems.push('a none output has empty args');
    } else if (typeof id !== 'string' || !ALL_ENTRIES.has(id)) problems.push(`entryId ${String(id)} is not in the offered catalog`);
    else problems.push(...argProblems(ALL_ENTRIES.get(id) as NlCatalogEntry, (parsed.args ?? {}) as Record<string, unknown>, entry.text));
    if (parsed.ambiguity !== 'CLEAR' && parsed.ambiguity !== 'NEEDS_CLARIFICATION') problems.push('ambiguity must be CLEAR or NEEDS_CLARIFICATION');
    if (!Array.isArray(parsed.alternatives)) problems.push('alternatives must be an array');
  }
  if (!Array.isArray(entry.needs) || entry.needs.some((id) => !ALL_ENTRIES.has(id))) problems.push('needs must list catalog entry ids');
  const all = [entry.text, entry.previous ?? '', entry.context ?? '', entry.output].join('\n');
  if (containsCredentialMaterial(all)) problems.push('credential-shaped material (an entry is rejected, never redacted)');
  problems.push(...identifierProblems(all));
  return problems;
}

// --- contamination lint against gold (no ratchet) ---------------------------------------------------------------------
export interface PoolFinding {
  readonly poolId: string;
  readonly goldId: string;
  readonly kind: 'exact' | 'near' | 'containment' | 'pair' | 'output';
  readonly tokenJ: number;
  readonly charJ: number;
  readonly contain: number;
}

/** A gold text of one whitespace-free word of at most this many characters is exempt from the containment measure. */
export const SINGLE_WORD_MAX_CHARS = 8;
export function isSingleWord(text: string): boolean {
  const normalized = normalize(text);
  return !/\s/.test(normalized) && Array.from(normalized).length <= SINGLE_WORD_MAX_CHARS;
}

const round = (n: number): number => Math.round(n * 100) / 100;
const pairText = (...parts: Array<string | undefined>): string => parts.filter((part) => part !== undefined && part !== '').join(' ');

/** The RAG-0 measures applied to one pool entry against the whole gold set. */
export function lintEntry(entry: PoolEntry, gold: readonly GoldCase[]): PoolFinding[] {
  const found: PoolFinding[] = [];
  const short = isShortText(entry.text);
  let output: { entryId?: unknown; args?: unknown } | undefined;
  try {
    output = JSON.parse(entry.output) as typeof output;
  } catch {
    output = undefined;
  }
  for (const golden of gold) {
    const c = closeness(entry.text, golden.text);
    const metrics = { tokenJ: round(c.tokenJ), charJ: round(c.charJ), contain: round(c.contain) };
    let kind = short ? (c.exact ? 'exact' : undefined) : findingKind(c);
    // Pool-lint deviation (reported to the owner): a gold text that is one bare word of at most SINGLE_WORD_MAX_CHARS
    // characters ("깃허브", "컨플루언스", "되돌려줘") sits inside any natural example that names that source or verb, so
    // containment of it cannot be avoided and carries no copy signal. Exact and near-copy findings still apply.
    if (kind === 'containment' && isSingleWord(golden.text)) kind = undefined;
    if (kind !== undefined) found.push({ poolId: entry.id, goldId: golden.id, kind, ...metrics });
    if ((entry.previous !== undefined || entry.context !== undefined) && golden.previous !== undefined) {
      const pair = closeness(pairText(entry.previous, entry.context, entry.text), pairText(golden.previous, golden.text));
      const pairKind = findingKind(pair);
      const related = c.tokenJ >= PAIR_TEXT_FLOOR || c.charJ >= PAIR_TEXT_FLOOR;
      if (pairKind !== undefined && !short && related && kind === undefined) found.push({ poolId: entry.id, goldId: golden.id, kind: 'pair', tokenJ: round(pair.tokenJ), charJ: round(pair.charJ), contain: round(pair.contain) });
    }
    if (output !== undefined && golden.expect !== undefined && sharedSpanArg(output, golden.expect) !== undefined) found.push({ poolId: entry.id, goldId: golden.id, kind: 'output', ...metrics });
  }
  return found;
}

export interface Coverage {
  readonly total: number;
  readonly perEntry: Readonly<Record<string, number>>;
  readonly entriesBelowTarget: readonly string[];
  readonly negatives: number;
  readonly negativeShare: number;
  readonly targetMet: boolean;
}

export function coverageOf(entries: readonly PoolEntry[]): Coverage {
  const perEntry: Record<string, number> = Object.fromEntries(POOL_ENTRY_IDS.map((id) => [id, 0]));
  let negatives = 0;
  for (const entry of entries) {
    let id = 'none';
    try {
      id = String((JSON.parse(entry.output) as { entryId?: unknown }).entryId);
    } catch {
      continue;
    }
    if (id === 'none') negatives += 1;
    else perEntry[id] = (perEntry[id] ?? 0) + 1;
  }
  const entriesBelowTarget = Object.entries(perEntry).filter(([, count]) => count < COVERAGE_TARGET.perEntry).map(([id]) => id).sort();
  const negativeShare = entries.length === 0 ? 0 : negatives / entries.length;
  return {
    total: entries.length,
    perEntry,
    entriesBelowTarget,
    negatives,
    negativeShare,
    targetMet: entries.length >= COVERAGE_TARGET.entries && entriesBelowTarget.length === 0 && negativeShare >= COVERAGE_TARGET.negativeShare,
  };
}

export interface PoolReport {
  readonly digest: string;
  readonly entries: number;
  readonly schemaProblems: ReadonlyArray<{ readonly id: string; readonly problems: readonly string[] }>;
  readonly duplicates: readonly string[];
  readonly findings: readonly PoolFinding[];
  readonly coverage: Coverage;
  readonly ok: boolean;
}

/** Schema + identifier + credential + duplicate + n-gram lint over a pool. `ok` means zero problems of any kind. */
export function checkPool(entries: readonly PoolEntry[], gold: readonly GoldCase[]): PoolReport {
  const schemaProblems: Array<{ id: string; problems: readonly string[] }> = [];
  const ids = new Set<string>();
  const texts = new Set<string>();
  const duplicates: string[] = [];
  const findings: PoolFinding[] = [];
  if (entries.length > POOL_CAP) schemaProblems.push({ id: '*', problems: [`the pool exceeds the cap of ${POOL_CAP}`] });
  for (const entry of entries) {
    const problems = entryProblems(entry);
    if (ids.has(entry.id)) duplicates.push(entry.id);
    ids.add(entry.id);
    const key = JSON.stringify([normalize(entry.text), entry.previous ?? '', entry.context ?? '']);
    if (texts.has(key)) duplicates.push(`${entry.id} (same text, previous and context as another entry)`);
    texts.add(key);
    if (problems.length > 0) schemaProblems.push({ id: entry.id, problems });
    findings.push(...lintEntry(entry, gold));
  }
  const coverage = coverageOf(entries);
  return { digest: poolDigest(entries), entries: entries.length, schemaProblems, duplicates, findings, coverage, ok: schemaProblems.length === 0 && duplicates.length === 0 && findings.length === 0 };
}

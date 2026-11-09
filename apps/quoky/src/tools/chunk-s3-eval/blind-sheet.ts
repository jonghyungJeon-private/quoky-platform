/**
 * The CH3 owner blind labelling sheet (slice 3, DECISIONS ADR-0124 section 17) and the scorer of the filled sheet.
 *
 * - **Blinding.** One pair per item: today's summary and the S3 summary, shown as `A` and `B`. The order of the pairs and the
 *   side of each arm follow the `g4-rubric.v1` presentation rule (sha256 of `<seed>:order:<id>` / the parity of the first
 *   byte of sha256 of `<seed>:side:<id>`), with a FRESH random seed per run that is written to the key file only. The sheet
 *   carries no arm name, no model name, no coverage line or footer (Core copy that would name the arm) and no score.
 * - **Key.** A separate file: the seed, which arm is `A` for each pair, the plan digest and the sha256 of the sheet's fixed
 *   part (everything but the owner's answers), so an edited answer text or a reordered sheet is refused when scored.
 * - **Rubric.** The `g4-rubric.v1` label wording (`useless` / `usable` / `good`), read from its frozen file, and a pairwise
 *   preference `A` / `B` / `tie`.
 * - **Test.** Ties are dropped; S3 is preferred when the one-sided exact binomial test over the non-tie pairs gives
 *   p < 0.05 with at least 25 non-tie pairs (CH3 bar, ratified 2026-11-09).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const BLIND_SHEET_VERSION = 'chunk-s3-ch3-blind.v1';
export const LABELS = ['useless', 'usable', 'good'] as const;
export type Label = (typeof LABELS)[number];
export const PREFERENCES = ['A', 'B', 'tie'] as const;
export type Preference = (typeof PREFERENCES)[number];
export type Arm = 'S3' | 'today';

/** CH3 preference bar (ratified 2026-11-09). */
export const PREFERENCE_BAR = Object.freeze({ minNonTiePairs: 25, alpha: 0.05 });

export const G4_RUBRIC_PATH = resolve(__dirname, '../../../../../packages/core/src/application/golden/a2/g4-rubric.v1.json');

export interface RubricWording {
  readonly source: 'g4-rubric.v1';
  readonly sha256: string;
  readonly labels: Readonly<Record<Label, { readonly ko: string; readonly en: string }>>;
  readonly note: string;
}

export function loadRubricWording(path: string = G4_RUBRIC_PATH): RubricWording {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as { labels: Record<Label, { ko: string; en: string }> };
  return {
    source: 'g4-rubric.v1',
    sha256: createHash('sha256').update(raw).digest('hex'),
    labels: { useless: parsed.labels.useless, usable: parsed.labels.usable, good: parsed.labels.good },
    note: 'The g4-rubric.v1 wording was written for event outputs; read "this event" as "this item" (one long mail, thread, document or sheet).',
  };
}

export interface BlindPairInput {
  readonly caseId: string;
  readonly request: string;
  readonly item: { readonly shape: string; readonly language: string; readonly title: string; readonly codePoints: number };
  /** The planted key points (the same for both answers, so they do not reveal an arm). */
  readonly keyPoints: readonly string[];
  readonly answers: Readonly<Record<Arm, string>>;
}

export interface BlindSheetEntry {
  readonly position: number;
  readonly caseId: string;
  readonly request: string;
  readonly item: BlindPairInput['item'];
  readonly keyPoints: readonly string[];
  readonly answers: { readonly A: string; readonly B: string };
  /** Filled by the owner. */
  labels: { A: Label | null; B: Label | null };
  preference: Preference | null;
  note: string;
}

export interface BlindSheet {
  readonly kind: 'chunk-s3-ch3-blind-sheet';
  readonly version: typeof BLIND_SHEET_VERSION;
  readonly sheetId: string;
  readonly instructions: readonly string[];
  readonly rubric: RubricWording;
  readonly entries: BlindSheetEntry[];
}

export interface BlindKey {
  readonly kind: 'chunk-s3-ch3-blind-key';
  readonly version: typeof BLIND_SHEET_VERSION;
  readonly sheetId: string;
  readonly seed: string;
  readonly planDigest: string;
  readonly sheetDigest: string;
  readonly sides: Readonly<Record<string, { readonly A: Arm; readonly B: Arm }>>;
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256 of the sheet's fixed part (positions, ids, requests, items, key points, answers); the owner's fields are excluded. */
export function sheetDigest(entries: readonly Pick<BlindSheetEntry, 'position' | 'caseId' | 'request' | 'item' | 'keyPoints' | 'answers'>[]): string {
  return sha(JSON.stringify(entries.map((e) => [e.position, e.caseId, e.request, [e.item.shape, e.item.language, e.item.title, e.item.codePoints], e.keyPoints, e.answers.A, e.answers.B])));
}

/** The order and sides of the g4-rubric.v1 presentation rule under `seed`. */
export function presentation(seed: string, caseIds: readonly string[]): { readonly order: string[]; readonly firstIsS3: Readonly<Record<string, boolean>> } {
  const order = [...caseIds].sort((a, b) => (sha(`${seed}:order:${a}`) < sha(`${seed}:order:${b}`) ? -1 : 1));
  const firstIsS3: Record<string, boolean> = {};
  for (const id of caseIds) firstIsS3[id] = parseInt(sha(`${seed}:side:${id}`).slice(0, 2), 16) % 2 === 0;
  return { order, firstIsS3 };
}

export function buildBlindSheet(
  pairs: readonly BlindPairInput[],
  options: { readonly planDigest: string; readonly rubric: RubricWording; readonly seed?: string },
): { readonly sheet: BlindSheet; readonly key: BlindKey } {
  const seed = options.seed ?? randomBytes(16).toString('hex');
  const byId = new Map(pairs.map((pair) => [pair.caseId, pair] as const));
  const { order, firstIsS3 } = presentation(seed, pairs.map((pair) => pair.caseId));
  const sides: Record<string, { A: Arm; B: Arm }> = {};
  const entries: BlindSheetEntry[] = order.map((caseId, index) => {
    const pair = byId.get(caseId) as BlindPairInput;
    const s3First = firstIsS3[caseId] === true;
    sides[caseId] = s3First ? { A: 'S3', B: 'today' } : { A: 'today', B: 'S3' };
    return {
      position: index + 1,
      caseId,
      request: pair.request,
      item: pair.item,
      keyPoints: pair.keyPoints,
      answers: { A: s3First ? pair.answers.S3 : pair.answers.today, B: s3First ? pair.answers.today : pair.answers.S3 },
      labels: { A: null, B: null },
      preference: null,
      note: '',
    };
  });
  const digest = sheetDigest(entries);
  const sheetId = sha(`${seed}:sheet:${digest}`).slice(0, 12);
  const sheet: BlindSheet = {
    kind: 'chunk-s3-ch3-blind-sheet',
    version: BLIND_SHEET_VERSION,
    sheetId,
    instructions: [
      'Each entry is one synthetic long item and two summaries of it, A and B, in random order. Nothing on this sheet says which system wrote which.',
      'Label each answer useless / usable / good with the rubric wording below, then set preference to A, B or tie, and add a note if useful.',
      'The key points are what was planted in the item; they are the same for A and B. The full item texts are in the separate items file.',
      'Edit only labels, preference and note. Do not open the key file before every entry is filled.',
    ],
    rubric: options.rubric,
    entries,
  };
  return { sheet, key: { kind: 'chunk-s3-ch3-blind-key', version: BLIND_SHEET_VERSION, sheetId, seed, planDigest: options.planDigest, sheetDigest: digest, sides } };
}

/** A Markdown rendering of the sheet for reading (the JSON sheet is the one the owner fills). */
export function renderSheetMarkdown(sheet: BlindSheet): string {
  const lines = [`# CH3 blind labelling sheet ${sheet.sheetId}`, '', ...sheet.instructions.map((line) => `- ${line}`), '', '## Rubric (g4-rubric.v1)', ''];
  for (const label of LABELS) lines.push(`- **${label}**: ${sheet.rubric.labels[label].ko} / ${sheet.rubric.labels[label].en}`);
  lines.push(`- ${sheet.rubric.note}`, '');
  for (const entry of sheet.entries) {
    lines.push(`## ${entry.position}. ${entry.caseId}`, '', `- Request: ${entry.request}`, `- Item: ${entry.item.shape}, ${entry.item.language}, "${entry.item.title}", ${entry.item.codePoints} code points`, '- Key points:');
    for (const key of entry.keyPoints) lines.push(`  - ${key}`);
    lines.push('', '### A', '', '```text', entry.answers.A, '```', '', '### B', '', '```text', entry.answers.B, '```', '');
  }
  return `${lines.join('\n')}\n`;
}

/** P(X >= k) for X ~ Binomial(n, 1/2): the one-sided exact p of k successes in n trials. */
export function binomialOneSidedP(k: number, n: number): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0) throw new RangeError('k and n must be non-negative integers');
  if (n === 0) return 1;
  if (k > n) return 0;
  const logChoose = (nn: number, kk: number): number => {
    let sum = 0;
    for (let i = 1; i <= kk; i += 1) sum += Math.log((nn - kk + i) / i);
    return sum;
  };
  let tail = 0;
  for (let i = k; i <= n; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, tail);
}

export interface LabelTally {
  readonly useless: number;
  readonly usable: number;
  readonly good: number;
}

export interface PreferenceResult {
  readonly pairs: number;
  readonly s3Wins: number;
  readonly todayWins: number;
  readonly ties: number;
  readonly nonTies: number;
  readonly pOneSided: number;
  readonly labels: Readonly<Record<Arm, LabelTally>>;
  readonly usablePlus: Readonly<Record<Arm, number>>;
  readonly pass: boolean;
  readonly reason: string;
}

export type FilledSheetScore = { readonly ok: false; readonly problems: readonly string[] } | ({ readonly ok: true } & PreferenceResult);

/** Score a filled sheet against its key. Refuses an incomplete, edited or mismatched sheet (problems name the entries). */
export function scoreFilledSheet(sheet: BlindSheet, key: BlindKey): FilledSheetScore {
  const problems: string[] = [];
  if (sheet?.kind !== 'chunk-s3-ch3-blind-sheet' || key?.kind !== 'chunk-s3-ch3-blind-key') return { ok: false, problems: ['not a CH3 sheet and key'] };
  if (sheet.sheetId !== key.sheetId) problems.push(`sheet ${sheet.sheetId} does not match key ${key.sheetId}`);
  if (sheetDigest(sheet.entries) !== key.sheetDigest) problems.push('the sheet fixed part changed (answers, order or items); only labels, preference and note may be edited');
  const tally = (): { useless: number; usable: number; good: number } => ({ useless: 0, usable: 0, good: 0 });
  const labels: Record<Arm, { useless: number; usable: number; good: number }> = { S3: tally(), today: tally() };
  let s3Wins = 0;
  let todayWins = 0;
  let ties = 0;
  for (const entry of sheet.entries) {
    const side = key.sides[entry.caseId];
    if (side === undefined) {
      problems.push(`${entry.caseId}: not in the key`);
      continue;
    }
    for (const slot of ['A', 'B'] as const) {
      const label = entry.labels?.[slot];
      if (label === null || label === undefined || !(LABELS as readonly string[]).includes(label)) problems.push(`${entry.caseId}: label ${slot} missing or not one of ${LABELS.join('/')}`);
      else labels[side[slot]][label] += 1;
    }
    const preference = entry.preference;
    if (preference === null || !(PREFERENCES as readonly string[]).includes(preference)) problems.push(`${entry.caseId}: preference missing or not one of ${PREFERENCES.join('/')}`);
    else if (preference === 'tie') ties += 1;
    else if (side[preference] === 'S3') s3Wins += 1;
    else todayWins += 1;
  }
  if (Object.keys(key.sides).length !== sheet.entries.length) problems.push('the key and the sheet have a different number of pairs');
  if (problems.length > 0) return { ok: false, problems };
  const nonTies = s3Wins + todayWins;
  const pOneSided = binomialOneSidedP(s3Wins, nonTies);
  const enough = nonTies >= PREFERENCE_BAR.minNonTiePairs;
  const pass = enough && pOneSided < PREFERENCE_BAR.alpha;
  const reason = !enough
    ? `only ${nonTies} non-tie pairs (needs >= ${PREFERENCE_BAR.minNonTiePairs})`
    : pass
      ? `S3 preferred in ${s3Wins} of ${nonTies} non-tie pairs, one-sided p = ${pOneSided.toPrecision(3)} < ${PREFERENCE_BAR.alpha}`
      : `S3 preferred in ${s3Wins} of ${nonTies} non-tie pairs, one-sided p = ${pOneSided.toPrecision(3)} >= ${PREFERENCE_BAR.alpha}`;
  const usablePlus = { S3: labels.S3.usable + labels.S3.good, today: labels.today.usable + labels.today.good };
  return { ok: true, pairs: sheet.entries.length, s3Wins, todayWins, ties, nonTies, pOneSided, labels, usablePlus, pass, reason };
}

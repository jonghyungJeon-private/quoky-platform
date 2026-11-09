/**
 * The deterministic CH3 scorer (slice 3, DECISIONS ADR-0124 section 17). No model, no phrase list: it compares VALUE ATOMS.
 *
 * - **Atoms.** A text is read (NFKC, lower case) for: dates (`12월 3일`, `2027-12-03`, `12/3`, `December 3`, `3 Dec`) as
 *   `date:MM-DD`; clock times (`14:30`) as `time:HH:MM`; numbers of at least two digits after removing thousands separators
 *   (`3,450` -> `num:3450`) as `num:<digits>`; and, for coverage only, a key point's fictional name (`name:<normalized>`,
 *   a substring test). Single-digit numbers are not atoms: they are ordinals and counts ("2 risks", "6 parts") that a
 *   faithful summary writes freely.
 * - **Coverage.** A key point is covered when its one recorded atom is in the summary. Each atom occurs once in its item, so
 *   the summary can only have it from that key point. This is a LOWER bound: a summary that rewrites a value ("3.4 thousand",
 *   "early December") is not credited. The owner's blind labels judge the rest. A stricter `subject` coverage (the atom AND
 *   the key point's subject codename) is reported beside it.
 * - **Invented points.** A date, time or number atom of the summary that is not in the item's source atoms (its full text,
 *   metadata included, and the request) is an invented point. Only the model's text is scored (Core's coverage line and
 *   footers are never part of it). An item has "0 invented points" when the set is empty.
 */
import { DEPTH_STRATA, normalizedName, type Ch3Case, type DepthStratum, type KeyPoint } from './ch3-corpus';

export const CH3_SCORER_VERSION = 'chunk-s3-ch3-scorer.v1';

const MONTH_INDEX: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const pad = (n: number): string => String(n).padStart(2, '0');
const validDate = (month: number, day: number): boolean => month >= 1 && month <= 12 && day >= 1 && day <= 31;

const DATE_PATTERNS: readonly { readonly re: RegExp; readonly read: (m: RegExpExecArray) => [number, number] }[] = [
  { re: /(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/gu, read: (m) => [Number(m[2]), Number(m[3])] },
  { re: /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu, read: (m) => [Number(m[2]), Number(m[3])] },
  { re: /(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu, read: (m) => [Number(m[1]), Number(m[2])] },
  { re: new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gu'), read: (m) => [MONTH_INDEX[(m[1] ?? '').toLowerCase()] ?? 0, Number(m[2])] },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME}\\b`, 'gu'), read: (m) => [MONTH_INDEX[(m[2] ?? '').toLowerCase()] ?? 0, Number(m[1])] },
  { re: /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/gu, read: (m) => [Number(m[1]), Number(m[2])] },
];
const TIME = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu;
const NUMBER = /\d[\d,]*(?:\.\d+)?/gu;

/** Blank a matched span so later patterns do not read it again (same length keeps the other offsets). */
function blank(text: string, start: number, length: number): string {
  return `${text.slice(0, start)}${' '.repeat(length)}${text.slice(start + length)}`;
}

/** The date, time and number atoms of `text` (a multiset as counts). */
export function valueAtoms(raw: string): Map<string, number> {
  let text = raw.normalize('NFKC').toLowerCase();
  const out = new Map<string, number>();
  const add = (atom: string): void => void out.set(atom, (out.get(atom) ?? 0) + 1);
  for (const { re, read } of DATE_PATTERNS) {
    re.lastIndex = 0;
    const matches: RegExpExecArray[] = [];
    for (let m = re.exec(text); m !== null; m = re.exec(text)) matches.push(m);
    for (const m of matches) {
      const [month, day] = read(m);
      if (!validDate(month, day)) continue;
      add(`date:${pad(month)}-${pad(day)}`);
      text = blank(text, m.index, m[0].length);
    }
  }
  TIME.lastIndex = 0;
  for (const m of [...text.matchAll(TIME)]) {
    add(`time:${pad(Number(m[1]))}:${m[2] as string}`);
    text = blank(text, m.index ?? 0, m[0].length);
  }
  for (const m of text.matchAll(NUMBER)) {
    const digits = (m[0].replace(/,/gu, '').split('.')[0] ?? '').replace(/^0+(?=\d)/u, '');
    if (digits.length >= 2) add(`num:${digits}`);
  }
  return out;
}

/** Whether `text` carries `atom` (a `name:` atom is a normalized substring; the others are value atoms). */
export function hasAtom(text: string, atom: string, atoms: ReadonlyMap<string, number> = valueAtoms(text)): boolean {
  if (atom.startsWith('name:')) return normalizedName(text).includes(atom.slice('name:'.length));
  return (atoms.get(atom) ?? 0) > 0;
}

export interface ItemScore {
  readonly id: string;
  readonly keyPoints: number;
  readonly covered: number;
  /** Atom and subject codename both present. */
  readonly coveredWithSubject: number;
  readonly coveredIds: readonly string[];
  /** Invented atoms (counts only in the report; the atoms themselves are synthetic values). */
  readonly invented: readonly string[];
  readonly perStratum: Readonly<Partial<Record<DepthStratum, { readonly keyPoints: number; readonly covered: number }>>>;
}

export function scoreSummary(item: Ch3Case, summary: string, sourceAtoms: ReadonlyMap<string, number>): ItemScore {
  const atoms = valueAtoms(summary);
  const normalized = normalizedName(summary);
  const covered = item.keyPoints.filter((key) => hasAtom(summary, key.atom, atoms));
  const perStratum: Partial<Record<DepthStratum, { keyPoints: number; covered: number }>> = {};
  for (const key of item.keyPoints) {
    const entry = perStratum[key.stratum] ?? { keyPoints: 0, covered: 0 };
    entry.keyPoints += 1;
    if (covered.includes(key)) entry.covered += 1;
    perStratum[key.stratum] = entry;
  }
  const invented = [...atoms.keys()].filter((atom) => !sourceAtoms.has(atom)).sort();
  return {
    id: item.item.id,
    keyPoints: item.keyPoints.length,
    covered: covered.length,
    coveredWithSubject: covered.filter((key: KeyPoint) => normalized.includes(normalizedName(key.subject))).length,
    coveredIds: covered.map((key) => key.id),
    invented,
    perStratum,
  };
}

export interface ArmAggregate {
  readonly items: number;
  readonly keyPoints: number;
  readonly covered: number;
  /** covered / keyPoints over every item (the CH3 coverage metric). */
  readonly coverage: number;
  readonly coverageWithSubject: number;
  readonly itemsWithoutInvented: number;
  /** itemsWithoutInvented / items. */
  readonly inventedFreeShare: number;
  readonly perStratum: Readonly<Record<string, { readonly keyPoints: number; readonly covered: number; readonly coverage: number }>>;
  /** Items above the 6-window cap only (CA condition (b)). */
  readonly aboveCapPerStratum: Readonly<Record<string, { readonly keyPoints: number; readonly covered: number; readonly coverage: number }>>;
}

const ratio = (a: number, b: number): number => (b === 0 ? 0 : Math.round((10_000 * a) / b) / 10_000);

export function aggregate(cases: readonly Ch3Case[], scores: readonly ItemScore[]): ArmAggregate {
  const byId = new Map(cases.map((c) => [c.item.id, c] as const));
  let keyPoints = 0;
  let covered = 0;
  let withSubject = 0;
  let clean = 0;
  const strata = (aboveOnly: boolean): Record<string, { keyPoints: number; covered: number; coverage: number }> => {
    const out: Record<string, { keyPoints: number; covered: number; coverage: number }> = {};
    for (const stratum of DEPTH_STRATA) {
      let k = 0;
      let c = 0;
      for (const score of scores) {
        if (aboveOnly && byId.get(score.id)?.aboveCap !== true) continue;
        const entry = score.perStratum[stratum.id];
        if (entry === undefined) continue;
        k += entry.keyPoints;
        c += entry.covered;
      }
      if (k > 0) out[stratum.id] = { keyPoints: k, covered: c, coverage: ratio(c, k) };
    }
    return out;
  };
  for (const score of scores) {
    keyPoints += score.keyPoints;
    covered += score.covered;
    withSubject += score.coveredWithSubject;
    if (score.invented.length === 0) clean += 1;
  }
  return {
    items: scores.length,
    keyPoints,
    covered,
    coverage: ratio(covered, keyPoints),
    coverageWithSubject: ratio(withSubject, keyPoints),
    itemsWithoutInvented: clean,
    inventedFreeShare: ratio(clean, scores.length),
    perStratum: strata(false),
    aboveCapPerStratum: strata(true),
  };
}

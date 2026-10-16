import { normalizeForMatch } from './selection-input';
import { nlIsRequestForm } from './request-shape';

/**
 * ADR-0120 A6-D3a amendment 1, garbled action word addendum (owner decision 2026-10-16): "3번 완룐 처리해줘" asks, because
 * 완룐 may be 완료 or something else. The A6 prompt line alone did not hold (the selector executed `todo.complete` 3/3), so
 * Core decides structurally, with no typo list:
 *
 *  - A word of the owner's frame (the prose without the selector's content spans) is GARBLED when its stem is at edit
 *    distance exactly 1 from an action word of the closed A6 vocabularies, measured on jamo for Hangul (initial, medial,
 *    final) and on characters for Latin, and the word neither holds a known action word ("완료해줘", "완료로", "완료됨",
 *    "완료하고") nor is a normal inflection of one.
 *  - Short words are noise: a Hangul action word needs two syllables (one syllable is 2-3 jamo, so one edit turns 꺼 into
 *    거 and 빼 into 해), a Latin one five letters ("undo", "done", "drop" never match).
 *  - The ANCHOR: the word sits where the action word stands, the predicate slot. In Korean that is a word with a request
 *    ending glued on ("완룐해줘", "지웨줘", "완룐 처리해") or a word right before a request form or the light verb 처리
 *    ("완룐 처리해줘", "완룐 해줘", "완룐 좀 해줘") that holds no action word of its own ("필요 없어 취소해줘": 취소 is the
 *    action, 없어 is not 없애). In English it is the imperative slot: the first word, after a request
 *    lead ("please", "can you"), or the complement after "as" ("mark 2 as complte"). The slot is what makes a near word
 *    the action word: a noun elsewhere in the frame that is one jamo away ("원본" beside 원복, "제가" beside 제거) is
 *    not in it, and an adnominal inflection ("끝낸 거", "마친 일": 끝내 / 마치 plus a final ㄴ, which a jamo comparison cannot
 *    tell from 완료 plus ㄴ = 완룐) modifies the noun after it and never carries a request ending.
 *  - Normal inflection inside the slot: the 어/아 infinitive contracts a stem's last vowel (마치 → 마쳐줘, 멈추 → 멈춰,
 *    지우 → 지워: ㅣ/ㅕ, ㅜ/ㅝ, ㅗ/ㅘ, ㅡ/ㅓ, ㅡ/ㅏ, ㅚ/ㅙ on the last syllable), and English adds -s or -d ("completes",
 *    "removed"). Those are forms, not garbles.
 *
 * The result is only ever a question (the selection asks, offering the candidate); nothing here selects or executes.
 * Pure; the owner's text is never logged.
 */

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** Medial (vowel) pairs of the 어/아 infinitive contraction on a stem's last syllable: ㅣ/ㅕ, ㅜ/ㅝ, ㅗ/ㅘ, ㅡ/ㅓ, ㅡ/ㅏ, ㅚ/ㅙ. */
const CONTRACTION_PAIRS: ReadonlyArray<readonly [number, number]> = [[20, 6], [13, 14], [8, 9], [18, 4], [18, 0], [11, 10]];
/** A request tail glued on a word: the light verb (처리)(해/하) and the closed request endings, or the ending alone. */
const GLUED_REQUEST_TAIL = /(?:처리)?(?:해|하)?(?:줘요|줘|주세요|주십시오|줄래요|줄래|세요|십시오)$|(?:처리)?(?:해요|해라|해|하자)$/u;
/** English request leads before the imperative slot. */
const EN_LEADS = new Set(['please', 'pls', 'plz', 'kindly']);
const EN_MODAL_LEAD = /^(?:can|could|would|will)$/u;
/** Closed particles glued on a Korean word ("완룐로", "완룐을"): up to two stacked. */
const PARTICLE_TAIL = /(?:으로|에서|까지|부터|에는|이랑|하고|은|는|이|가|을|를|에|의|도|만|로|랑|요)$/u;
const MIN_HANGUL_SYLLABLES = 2;
const MIN_LATIN_LETTERS = 5;

type Unit = string | number;

function isSyllable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= HANGUL_BASE && code <= HANGUL_LAST;
}

/** A Hangul syllable as [initial, medial, final?] (the final omitted when absent); any other character as itself. */
export function nlJamoOf(text: string): Unit[] {
  const units: Unit[] = [];
  for (const char of Array.from(text)) {
    if (!isSyllable(char)) {
      units.push(char);
      continue;
    }
    const index = (char.codePointAt(0) ?? 0) - HANGUL_BASE;
    const final = index % 28;
    // Initials, medials and finals are separate alphabets: 1xx, 2xx, 3xx.
    units.push(100 + Math.floor(index / 588), 200 + Math.floor((index % 588) / 28));
    if (final !== 0) units.push(300 + final);
  }
  return units;
}

/** Levenshtein distance on units, stopping early above `limit`. */
function distance(a: readonly Unit[], b: readonly Unit[], limit = 2): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/** The jamo edit distance of two words (Hangul decomposed into initial, medial, final; other characters as they are). */
export function nlJamoDistance(a: string, b: string): number {
  return distance(nlJamoOf(a), nlJamoOf(b));
}

/** The 어/아 infinitive contraction: same syllables except the last, whose medials form a contraction pair, no finals. */
function isContraction(a: string, b: string): boolean {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length !== y.length || x.length === 0 || x.slice(0, -1).join('') !== y.slice(0, -1).join('')) return false;
  const p = ((x.at(-1) ?? '').codePointAt(0) ?? 0) - HANGUL_BASE;
  const q = ((y.at(-1) ?? '').codePointAt(0) ?? 0) - HANGUL_BASE;
  if (p < 0 || q < 0 || p > HANGUL_LAST - HANGUL_BASE || q > HANGUL_LAST - HANGUL_BASE) return false;
  if (p % 28 !== 0 || q % 28 !== 0 || Math.floor(p / 588) !== Math.floor(q / 588)) return false;
  const m = Math.floor((p % 588) / 28);
  const n = Math.floor((q % 588) / 28);
  return CONTRACTION_PAIRS.some(([u, v]) => (m === u && n === v) || (m === v && n === u));
}

/** A normal inflection of `action`: English -s / -d, or the 어/아 contraction of a Hangul stem's last vowel. */
function isInflection(stem: string, action: string): boolean {
  return isLatinWord(action) ? stem === `${action}s` || stem === `${action}d` : isContraction(stem, action);
}

const isHangulWord = (word: string): boolean => word.length > 0 && Array.from(word).every(isSyllable);
const isLatinWord = (word: string): boolean => /^[a-z]+$/u.test(word);

/** Whether `word` holds a known action word: a Latin word equal to it, a Hangul word containing it. */
function holdsKnown(word: string, known: readonly string[]): boolean {
  return known.some((action) => (isLatinWord(action) ? word === action : word.includes(action)));
}

/** The vocabulary word `stem` garbles, if any (prefers `own`, the selected entry's words, then the rest in order). */
function garbledOf(stems: readonly string[], own: readonly string[], known: readonly string[]): string | undefined {
  // A stem that is a normal inflection of any known word is a form, whatever else it is near ("마쳐": 마치 + 어, beside 마쳤).
  if (stems.some((stem) => known.some((action) => isInflection(stem, action)))) return undefined;
  for (const action of [...own, ...known]) {
    if (/\s/u.test(action)) continue;
    const latin = isLatinWord(action);
    if (latin ? action.length < MIN_LATIN_LETTERS : !isHangulWord(action) || Array.from(action).length < MIN_HANGUL_SYLLABLES) continue;
    for (const stem of stems) {
      if (latin ? !isLatinWord(stem) : !isHangulWord(stem)) continue;
      if (nlJamoDistance(stem, action) === 1) return action;
    }
  }
  return undefined;
}

function wordsOf(frame: string): string[] {
  return normalizeForMatch(frame)
    .split(' ')
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => word.length > 0);
}

/**
 * The action word a garbled word of the owner's `frame` most likely stands for (a word of the closed vocabularies, never
 * the owner's text), or `undefined`. `own` is the selected entry's action vocabulary, `known` every A6 action word.
 */
export function nlGarbledActionWord(frame: string, own: readonly string[], known: readonly string[]): string | undefined {
  const ownWords = own.map(normalizeForMatch);
  const knownWords = [...new Set(known.map(normalizeForMatch))];
  const words = wordsOf(frame);
  for (const [index, word] of words.entries()) {
    if (holdsKnown(word, knownWords)) continue;
    let stems: string[] = [];
    if (isLatinWord(word)) {
      // The imperative slot: the first word, after a request lead ("please", "can you"), or after "as".
      const before = words.slice(0, index);
      const lead = before.every((w) => EN_LEADS.has(w)) || (before.length >= 2 && EN_MODAL_LEAD.test(before[0] ?? '') && before[1] === 'you' && before.slice(2).every((w) => EN_LEADS.has(w)));
      if (lead || before.at(-1) === 'as') stems = [word];
    } else {
      const tail = nlIsRequestForm(word) ? GLUED_REQUEST_TAIL.exec(word) : null;
      let next = words[index + 1] ?? '';
      if (next === '좀') next = words[index + 2] ?? '';
      // A next word that holds an action word is itself the action ("필요 없어 취소해줘"): the word before it is not in the slot.
      const slot = tail !== null || ((nlIsRequestForm(next) || /^처리/u.test(next)) && !holdsKnown(next, knownWords));
      if (slot) {
        const stem = tail !== null ? word.slice(0, tail.index) : word;
        const once = stem.replace(PARTICLE_TAIL, '');
        stems = [...new Set([stem, once, once.replace(PARTICLE_TAIL, '')])];
      }
    }
    if (stems.length === 0) continue;
    const garbled = garbledOf(stems, ownWords, knownWords);
    if (garbled !== undefined) return garbled;
  }
  return undefined;
}

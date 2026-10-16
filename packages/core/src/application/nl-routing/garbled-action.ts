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
 *    action, 없어 is not 없애). Korean is verb-final, so a bare word that ENDS the owner's message (followed by nothing or
 *    punctuation only: "사무실 청소 할 일 츄가", "… 츄가!") is in the predicate slot too, live test 2026-10-16 H09; a word
 *    that ends the frame only because a content span after it was removed is not. In English it is the imperative slot:
 *    the first word, after a request lead ("please", "can you"), or the complement after "as" ("mark 2 as complte").
 *    The slot is what makes a near word the action word: a noun elsewhere in the frame that is one jamo away ("원본"
 *    beside 원복, "제가" beside 제거) is not in it, and an adnominal inflection ("끝낸 거", "마친 일": 끝내 / 마치 plus a final ㄴ, which a jamo comparison cannot
 *    tell from 완료 plus ㄴ = 완룐) modifies the noun after it and never carries a request ending.
 *  - Normal inflection of a VERB form (CA / Codex review): on the last syllable, the ending consonants ㄴ / ㄹ / ㅁ / ㅂ / ㅆ
 *    come and go on the same initial and vowel (끝내 → "끝냄 처리해줘", 마치 → "마침", 지우 → "지움", 없애 → "없앰", 끝났 →
 *    "끝남으로", 해치웠 ↔ "해치워줘", 끝내 ↔ 끝냈), and the 어/아 infinitive contracts the last vowel (마치 → "마쳐줘", 멈추 ↔
 *    멈춰: ㅣ/ㅕ, ㅜ/ㅝ, ㅗ/ㅘ, ㅡ/ㅓ, ㅡ/ㅏ, ㅚ/ㅙ). A verbal NOUN (완료, 취소, 추가 …: the caller's `verbalNouns`) does not
 *    inflect by itself (it takes 하다 / 되다 / 처리), so any one-jamo change to it is a garble: 완룐 asks. English adds -s or
 *    -d ("completes", "removed").
 *
 * The result names the vocabulary that holds the near word (the caller offers that entry's canonical word, never the raw
 * stem) and is only ever a question; nothing here selects or executes.
 * Pure; the owner's text is never logged.
 */

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** The final consonants of the closed ending class (index in the final alphabet): ㄴ 4, ㄹ 8, ㅁ 16, ㅂ 17, ㅆ 20; 0 = none. */
const ENDING_FINALS: ReadonlySet<number> = new Set([0, 4, 8, 16, 17, 20]);
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

/** A Hangul syllable's [initial, medial, final] indices, or `undefined`. */
function partsOf(char: string | undefined): readonly [number, number, number] | undefined {
  if (char === undefined || !isSyllable(char)) return undefined;
  const index = (char.codePointAt(0) ?? 0) - HANGUL_BASE;
  return [Math.floor(index / 588), Math.floor((index % 588) / 28), index % 28];
}

/**
 * A normal inflection of a Hangul VERB form: the same syllables except the last, whose initial is the same and which either
 * keeps its vowel and swaps one ending consonant for another or none (ㄴ / ㄹ / ㅁ / ㅂ / ㅆ: 끝냄, 마침, 해치워 ↔ 해치웠), or,
 * both open, contracts the vowel (마쳐, 멈추 ↔ 멈춰).
 */
function isVerbInflection(a: string, b: string): boolean {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length !== y.length || x.length === 0 || x.slice(0, -1).join('') !== y.slice(0, -1).join('')) return false;
  const p = partsOf(x.at(-1));
  const q = partsOf(y.at(-1));
  if (p === undefined || q === undefined || p[0] !== q[0]) return false;
  if (p[1] === q[1]) return ENDING_FINALS.has(p[2]) && ENDING_FINALS.has(q[2]);
  if (p[2] !== 0 || q[2] !== 0) return false;
  return CONTRACTION_PAIRS.some(([u, v]) => (p[1] === u && q[1] === v) || (p[1] === v && q[1] === u));
}

/** A normal inflection of `action`: English -s / -d, or a Hangul verb form's ending consonant or contraction. */
function isInflection(stem: string, action: string, verbalNouns: ReadonlySet<string>): boolean {
  if (/^[a-z]+$/u.test(action)) return stem === `${action}s` || stem === `${action}d`;
  return !verbalNouns.has(action) && isVerbInflection(stem, action);
}

const isHangulWord = (word: string): boolean => word.length > 0 && Array.from(word).every(isSyllable);
const isLatinWord = (word: string): boolean => /^[a-z]+$/u.test(word);

/** Whether `word` holds a known action word: a Latin word equal to it, a Hangul word containing it. */
function holdsKnown(word: string, known: readonly string[]): boolean {
  return known.some((action) => (isLatinWord(action) ? word === action : word.includes(action)));
}

/** One closed action vocabulary and the entry that owns it. */
export interface NlActionVocabulary {
  readonly owner: string;
  readonly words: readonly string[];
}

/** A garbled word's candidate: the vocabulary word it is near, and the vocabulary's owner. */
export interface NlGarbledAction {
  readonly word: string;
  readonly owner: string;
}

/** The vocabulary word the stems garble, if any (vocabularies in order: the selected entry's first). */
function garbledOf(stems: readonly string[], vocabularies: readonly NlActionVocabulary[], known: readonly string[], verbalNouns: ReadonlySet<string>): NlGarbledAction | undefined {
  // A stem that is a normal inflection of any known word is a form, whatever else it is near ("해치워": 해치웠 without ㅆ).
  if (stems.some((stem) => known.some((action) => isInflection(stem, action, verbalNouns)))) return undefined;
  for (const vocabulary of vocabularies) {
    for (const action of vocabulary.words) {
      if (/\s/u.test(action)) continue;
      const latin = isLatinWord(action);
      if (latin ? action.length < MIN_LATIN_LETTERS : !isHangulWord(action) || Array.from(action).length < MIN_HANGUL_SYLLABLES) continue;
      for (const stem of stems) {
        if (latin ? !isLatinWord(stem) : !isHangulWord(stem)) continue;
        if (nlJamoDistance(stem, action) === 1) return { word: action, owner: vocabulary.owner };
      }
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
 * The action vocabulary word a garbled word of the owner's `frame` most likely stands for, with the vocabulary's owner
 * (closed words, never the owner's text), or `undefined`. `vocabularies` are the LOCAL_WRITE vocabularies, the selected
 * entry's first; `verbalNouns` the vocabulary words that are verbal nouns (no inflection of their own); `catalogWords` the
 * catalog's own aliases and source names, which are known words.
 */
export function nlGarbledActionWord(
  frame: string,
  vocabularies: readonly NlActionVocabulary[],
  verbalNouns: readonly string[],
  catalogWords: readonly string[] = [],
  message: string = frame,
): NlGarbledAction | undefined {
  const normalized = vocabularies.map((vocabulary) => ({ owner: vocabulary.owner, words: vocabulary.words.map(normalizeForMatch) }));
  const knownWords = [...new Set(normalized.flatMap((vocabulary) => vocabulary.words))];
  const nouns = new Set(verbalNouns.map(normalizeForMatch));
  // The catalog's own words (entry aliases and source names of two syllables or more: "리마인더" beside 리마인드) are known
  // words too, never a garble.
  const catalog = [...new Set(catalogWords.map(normalizeForMatch))].filter((word) => !/\s/u.test(word) && (isLatinWord(word) ? word.length >= MIN_LATIN_LETTERS : isHangulWord(word) && Array.from(word).length >= MIN_HANGUL_SYLLABLES));
  const words = wordsOf(frame);
  // The message's own last word (punctuation stripped): the verb-final predicate slot of a Korean sentence.
  const messageLast = wordsOf(message).at(-1);
  for (const [index, word] of words.entries()) {
    if (holdsKnown(word, knownWords) || holdsKnown(word, catalog)) continue;
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
      // Verb-final: the bare last word of the message is the predicate ("사무실 청소 할 일 츄가").
      const final = index === words.length - 1 && word === messageLast;
      const slot = tail !== null || final || ((nlIsRequestForm(next) || /^처리/u.test(next)) && !holdsKnown(next, knownWords));
      if (slot) {
        const stem = tail !== null ? word.slice(0, tail.index) : word;
        const once = stem.replace(PARTICLE_TAIL, '');
        stems = [...new Set([stem, once, once.replace(PARTICLE_TAIL, '')])];
      }
    }
    if (stems.length === 0) continue;
    const garbled = garbledOf(stems, normalized, knownWords, nouns);
    if (garbled !== undefined) return garbled;
  }
  return undefined;
}

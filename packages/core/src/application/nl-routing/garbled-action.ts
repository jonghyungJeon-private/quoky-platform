import { normalizeForMatch } from './selection-input';
import { nlIsRequestForm } from './request-shape';
import { isNlTimeWord } from './symbolic-time';

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
 *  - Loanword vowels (owner decision E, 2026-10-17): for an action word the caller tags as a LOANWORD (`loanwords`: 캔슬,
 *    리마인드, 롤백, a tag on the existing vocabulary), a token in the slot with the same syllable count and the same initial
 *    and final consonant in every syllable but other vowels is garbled too, whatever the distance ("칸셀해줘" asks, "캔슬해줘"
 *    acts). Known words and normal inflections are checked first, as for every near word.
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
export const NL_GLUED_REQUEST_TAIL = /(?:처리)?(?:해|하)?(?:줘요|줘|주세요|주십시오|줄래요|줄래|세요|십시오)$|(?:처리)?(?:해요|해라|해|하자)$/u;
/** English request leads before the imperative slot (also the colon-label head of owner decision D, `action-entries.ts`). */
export const NL_EN_REQUEST_LEADS: ReadonlySet<string> = new Set(['please', 'pls', 'plz', 'kindly']);
const EN_LEADS = NL_EN_REQUEST_LEADS;
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

/**
 * Owner decision E (2026-10-17): a vowel-only variant of a LOANWORD action word. A loanword is spelled from its sound, so
 * its vowels drift (캔슬 / 칸셀 / 캔설) while its consonant frame stays: the same number of syllables, and in every syllable
 * the same initial and the same final consonant, with at least one vowel different. Such a token is garbled however many
 * vowels differ (the one-jamo distance alone lets 칸셀, two vowels away from 캔슬, through).
 */
function isVowelOnlyVariant(stem: string, action: string): boolean {
  const x = Array.from(stem);
  const y = Array.from(action);
  if (x.length !== y.length || x.length === 0) return false;
  let vowelDiffers = false;
  for (const [index, char] of x.entries()) {
    const p = partsOf(char);
    const q = partsOf(y[index]);
    if (p === undefined || q === undefined || p[0] !== q[0] || p[2] !== q[2]) return false;
    if (p[1] !== q[1]) vowelDiffers = true;
  }
  return vowelDiffers;
}

/** The vocabulary word the stems garble, if any (vocabularies in order: the selected entry's first). */
function garbledOf(
  stems: readonly string[],
  vocabularies: readonly NlActionVocabulary[],
  known: readonly string[],
  verbalNouns: ReadonlySet<string>,
  loanwords: ReadonlySet<string> = new Set(),
): NlGarbledAction | undefined {
  // A stem that is a normal inflection of any known word is a form, whatever else it is near ("해치워": 해치웠 without ㅆ).
  if (stems.some((stem) => known.some((action) => isInflection(stem, action, verbalNouns)))) return undefined;
  for (const vocabulary of vocabularies) {
    for (const action of vocabulary.words) {
      if (/\s/u.test(action)) continue;
      const latin = isLatinWord(action);
      if (latin ? action.length < MIN_LATIN_LETTERS : !isHangulWord(action) || Array.from(action).length < MIN_HANGUL_SYLLABLES) continue;
      for (const stem of stems) {
        if (latin ? !isLatinWord(stem) : !isHangulWord(stem)) continue;
        if (nlJamoDistance(stem, action) === 1 || (loanwords.has(action) && isVowelOnlyVariant(stem, action))) return { word: action, owner: vocabulary.owner };
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
  loanwords: readonly string[] = [],
): NlGarbledAction | undefined {
  const normalized = vocabularies.map((vocabulary) => ({ owner: vocabulary.owner, words: vocabulary.words.map(normalizeForMatch) }));
  const loans = new Set(loanwords.map(normalizeForMatch));
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
      const tail = nlIsRequestForm(word) ? NL_GLUED_REQUEST_TAIL.exec(word) : null;
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
    const garbled = garbledOf(stems, normalized, knownWords, nouns, loans);
    if (garbled !== undefined) return garbled;
  }
  return undefined;
}

// ── owner decision (b) of 2026-10-19: a garbled ENTRY noun ─────────────────────────────────────────────────────────

/** Hangul initial consonants as keys (index into ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ), for each final consonant (0 = none). */
const FINAL_KEYS: ReadonlyArray<readonly number[]> = [
  [], [0], [1], [0, 9], [2], [2, 12], [2, 18], [3], [5], [5, 0], [5, 6], [5, 7], [5, 9], [5, 16], [5, 17], [5, 18],
  [6], [7], [7, 9], [9], [10], [11], [12], [14], [15], [16], [17], [18],
];

/**
 * The keys of a loose compatibility jamo (U+3131 ㄱ … U+3163 ㅣ), the letter the input method leaves when a syllable was not
 * completed ("에이ㄴ트"): a consonant as its initial key (a double final such as ㄳ as its two keys), a vowel as its medial.
 */
const COMPAT_CONSONANT_KEYS: ReadonlyArray<readonly number[]> = [
  [0], [1], [0, 9], [2], [2, 12], [2, 18], [3], [4], [5], [5, 0], [5, 6], [5, 7], [5, 9], [5, 16], [5, 17], [5, 18],
  [6], [7], [8], [7, 9], [9], [10], [11], [12], [13], [14], [15], [16], [17], [18],
];
const COMPAT_FIRST = 0x3131;
const COMPAT_VOWEL_FIRST = 0x314f;
const COMPAT_LAST = 0x3163;

/**
 * The KEYSTROKES of a word: a Hangul syllable as its consonant and vowel keys, with an initial and a final consonant as the
 * SAME key (the input method composes a syllable from keys and moves a final consonant to the next syllable when a vowel
 * follows), a loose compatibility jamo as its key(s); other characters as they are. A one-key slip is distance 1 here even
 * when the composition moved a consonant across a syllable boundary ("리마이너" is "리마인더" without its ㄷ key; on
 * positional jamo the two are 2 apart), and "에이ㄴ트" is "에이전트" without its ㅈ and ㅓ keys (distance 2).
 */
function keysOf(text: string): Unit[] {
  const units: Unit[] = [];
  for (const char of Array.from(text)) {
    const parts = partsOf(char);
    if (parts === undefined) {
      const code = char.codePointAt(0) ?? 0;
      if (code >= COMPAT_FIRST && code < COMPAT_VOWEL_FIRST) units.push(...(COMPAT_CONSONANT_KEYS[code - COMPAT_FIRST] ?? []).map((key) => 100 + key));
      else if (code >= COMPAT_VOWEL_FIRST && code <= COMPAT_LAST) units.push(200 + (code - COMPAT_VOWEL_FIRST));
      else if (!/\s/u.test(char)) units.push(char);
      continue;
    }
    units.push(100 + parts[0], 200 + parts[1], ...(FINAL_KEYS[parts[2]] ?? []).map((key) => 100 + key));
  }
  return units;
}

/** The keystroke edit distance of two words (spaces ignored); see {@link keysOf}. */
export function nlKeystrokeDistance(a: string, b: string): number {
  return distance(keysOf(a), keysOf(b));
}

/**
 * Whether `prefix` is, key for key, a strict prefix of `word` (spaces ignored; see {@link keysOf}): the message stopped
 * mid-word ("에이전트 재" of "에이전트 재개", or "에이전트 잭" where the input method had already put the ㄱ key on 재).
 */
export function nlIsKeystrokePrefix(prefix: string, word: string): boolean {
  const a = keysOf(prefix);
  const b = keysOf(word);
  return a.length > 0 && a.length < b.length && a.every((unit, index) => unit === b[index]);
}

/** The number of keys of `text` (spaces ignored; see {@link keysOf}). */
export function nlKeystrokeCount(text: string): number {
  return keysOf(text).length;
}

/** The nouns that name one item list (the catalog's own list aliases), and the list they name. */
export interface NlEntryNouns {
  readonly owner: string;
  readonly words: readonly string[];
}

/** What a garbled entry noun asks: a typo of a known noun ("'리마인더' 말씀이시면 …"), or an unknown word in its slot. */
export type NlGarbledEntryNoun = { readonly kind: 'typo'; readonly noun: string; readonly owner: string } | { readonly kind: 'unknown'; readonly word: string };

/** Closed fillers and quantifiers that may stand between the entry noun and its verb ("알림 하나 걸어줘", "알림 좀 만들어줘"). */
const NOUN_SLOT_FILLERS: ReadonlySet<string> = new Set(['좀', '좀만', '하나', '한개', '두개', '한번', '빨리', '다시', '제발', '지금', '꼭', '새로']);
/** A destination or instrumental particle on the entry noun ("할 일에 넣어줘", "알림으로 만들어줘"). */
const DESTINATION_PARTICLE = /(?:에다가|에다|으로|에|로)$/u;
const MIN_UNKNOWN_SYLLABLES = 2;
/** The object or topic particle an unknown noun may carry in the object slot ("뭐뭐를 걸어줘"). */
const OBJECT_PARTICLE = /(?:을|를|은|는)$/u;
/**
 * Non-noun morphology on a token (Codex P2, 2026-10-19): an adverb in -게 / -히 / -이 ("새롭게", "천천히", "깨끗이"), a case
 * ending -로 / -으로 / -에 / -에서 / -서, or a verb or adjective ending (-다, -고, -면, -며, -지, -요, -어/-아/-여, -던, a
 * past or future marker, an adnominal -ㄴ / -ㄹ / -는). Such a token is no noun, so it is never asked about as one.
 */
const NON_NOUN_TAIL = /(?:게|히|이|로|에|서|다|고|면|며|지|요|어|아|여|던|었|았|였|겠|는|도|만|까지|부터)$/u;

/**
 * Codex P2 (2026-10-19, two rounds): the unknown-noun path is narrow and structural, since there is no dictionary. A token
 * is asked about only when it carries an explicit OBJECT or TOPIC particle (을/를, 은/는) and stands directly before a
 * list-noun verb (`verbs`: 걸, 만들, 설정, 맞춰): "삐용삐용을 걸어줘". Adverbs never take these particles, so "그냥 걸어줘",
 * "얼른", "당장", "살짝" never ask; a bare unknown word with no entry noun ("타이머 걸어줘") is left to the selector and Core's
 * usual validation (recorded residual). The stem is a Hangul word of two syllables or more with no adverbial, case or
 * verbal morphology ({@link NON_NOUN_TAIL}), no closed filler and no time word. Returns the stem to name, or `undefined`.
 * The typo-of-a-known-noun path (typed-key distance: "리마이너 걸어줘") is separate and unchanged.
 */
function isUnknownNounCandidate(raw: string, next: string, verbs: readonly string[]): string | undefined {
  // CA P3 #7: a filler glued on the token ("꼭좀", "빨리좀만") is set aside first; the stem meets the same checks.
  const word = raw.replace(/(?:좀만|좀)$/u, '');
  if (word.length === 0) return undefined;
  const particle = OBJECT_PARTICLE.exec(word);
  // A bare token never asks (an adverb such as 그냥 would): only an explicit object or topic particle marks a noun.
  if (particle === null) return undefined;
  const stem = word.slice(0, particle.index);
  const beforeVerb = verbs.some((verb) => next.startsWith(verb));
  if (!beforeVerb || !isHangulWord(stem) || Array.from(stem).length < MIN_UNKNOWN_SYLLABLES) return undefined;
  if (NOUN_SLOT_FILLERS.has(stem) || NOUN_SLOT_FILLERS.has(word) || isNlTimeWord(word) || isNlTimeWord(stem)) return undefined;
  return NON_NOUN_TAIL.test(stem) ? undefined : stem;
}

/**
 * Owner decision (b) of 2026-10-19 (live test 4, turn 25: "10월 21일 오전 9시에 리마이너 걸어줘, 검증 도면 회신" executed
 * `reminder.create`): the garbled-action rule extended from the action word to the NOUN that decides which list an entry
 * writes (the catalog's to-do and reminder list aliases: 할 일, 투두, todo, 알림, 리마인더, 알람, reminder). Read on the owner's
 * frame (content and time spans removed), and only when no correct list noun is in it.
 *
 * The noun's SLOT is grammar, not a phrase: the object right before a verb the vocabularies pair with a list noun
 * (`nounVerbs`: 걸, 만들, 설정, 맞춰 from "알림 걸", "리마인더 설정", "할 일 만들"; closed fillers such as 좀 / 하나 may stand
 * between) or before a request form ("3번 리마이너 취소해줘"), a list noun with a destination particle before a request
 * ("할릴에 넣어줘"), or the verb-final last word of the message (a bare "<title> 할 일"). A Latin word is checked anywhere in
 * the frame (English puts the noun after its verb).
 *  - `typo`: a word in the slot (particles stripped) is one KEYSTROKE from a list noun ({@link nlKeystrokeDistance}; on
 *    Hangul the jamo distance of garbled-action plus the input method's syllable composition), or, for a loanword noun
 *    (`loanwords`), a vowel-only variant of it (owner decision E). Latin: one letter, five letters or more.
 *  - `unknown`: a noun-shaped token directly in the object slot of a list-noun verb ({@link isUnknownNounCandidate}), no
 *    known word and near no list noun: the owner is asked what it means.
 * Known words (`knownWords`: the catalog aliases and source names, every action word) are never garbled. Only a question;
 * nothing here selects or executes. Pure; the owner's text is never logged.
 */
export function nlGarbledEntryNoun(
  frame: string,
  nouns: readonly NlEntryNouns[],
  nounVerbs: readonly string[],
  knownWords: readonly string[],
  message: string = frame,
  loanwords: readonly string[] = [],
): NlGarbledEntryNoun | undefined {
  const lists = nouns.map((list) => ({ owner: list.owner, words: list.words.map(normalizeForMatch) }));
  const spaceless = (word: string): string => word.replace(/\s+/gu, '');
  const text = normalizeForMatch(frame);
  const flat = spaceless(text);
  // A correct list noun anywhere in the frame decides the entry: nothing is garbled.
  const present = lists.some((list) =>
    list.words.some((noun) => (isLatinWord(spaceless(noun)) ? new RegExp(`(?<![a-z])${spaceless(noun)}(?![a-z])`, 'u').test(text.replace(/-/gu, '')) : flat.includes(spaceless(noun)))),
  );
  if (present) return undefined;
  const known = [...new Set(knownWords.map((word) => spaceless(normalizeForMatch(word))).filter((word) => word.length > 0))];
  const loans = new Set(loanwords.map((word) => spaceless(normalizeForMatch(word))));
  const verbs = nounVerbs.map(normalizeForMatch).filter((verb) => verb.length > 0);
  const words = wordsOf(frame);
  const messageLast = wordsOf(message).at(-1);
  const isKnown = (stem: string): boolean => known.some((word) => (isLatinWord(word) ? stem === word : stem === word || (Array.from(word).length >= MIN_HANGUL_SYLLABLES && stem.includes(word))));
  const nextContent = (index: number): string => {
    let at = index + 1;
    while (NOUN_SLOT_FILLERS.has(words[at] ?? '')) at += 1;
    return words[at] ?? '';
  };
  const near = (stem: string): { readonly noun: string; readonly owner: string } | undefined => {
    for (const list of lists) {
      for (const raw of list.words) {
        const noun = spaceless(raw);
        if (isLatinWord(noun)) {
          if (isLatinWord(stem) && noun.length >= MIN_LATIN_LETTERS && stem !== `${noun}s` && distance(Array.from(stem), Array.from(noun)) === 1) return { noun: raw, owner: list.owner };
          continue;
        }
        if (!isHangulWord(stem) || !isHangulWord(noun) || Array.from(noun).length < MIN_HANGUL_SYLLABLES || Array.from(stem).length < MIN_HANGUL_SYLLABLES) continue;
        if (nlKeystrokeDistance(stem, noun) <= 1 || (loans.has(noun) && isVowelOnlyVariant(stem, noun))) return { noun: raw, owner: list.owner };
      }
    }
    return undefined;
  };
  let unknown: string | undefined;
  for (const [index, word] of words.entries()) {
    const latin = isLatinWord(word.replace(/-/gu, ''));
    const plain = word.replace(/-/gu, '');
    const once = word.replace(PARTICLE_TAIL, '');
    const stems = latin ? [plain] : [...new Set([word, once, once.replace(PARTICLE_TAIL, '')])].filter((stem) => isHangulWord(stem));
    if (stems.length === 0 || stems.some(isKnown)) continue;
    const next = nextContent(index);
    const objectSlot = !latin && verbs.some((verb) => next.startsWith(verb));
    // The object of the request itself ("3번 리마이너 취소해줘"): the word right before a request form.
    const requestSlot = !latin && nlIsRequestForm(next);
    const destinationSlot = !latin && DESTINATION_PARTICLE.test(word) && (requestSlot || objectSlot);
    const finalSlot = !latin && index === words.length - 1 && word === messageLast;
    if (!latin && !objectSlot && !requestSlot && !destinationSlot && !finalSlot) continue;
    for (const stem of stems) {
      const candidate = near(stem);
      if (candidate !== undefined) return { kind: 'typo', ...candidate };
    }
    if (unknown === undefined) unknown = isUnknownNounCandidate(word, words[index + 1] ?? '', verbs);
  }
  return unknown === undefined ? undefined : { kind: 'unknown', word: unknown };
}

/**
 * Elliptical continuation (CA review P2): whether a word of the owner's `frame` is a normal inflection of an action word
 * of the closed vocabularies (a verb form's ending consonant or contraction: "끝냄", "마침", "지움", "없앰", "마쳐"; English
 * -s / -d), with a glued request tail and particles removed. Such a frame names its action, so it is never elliptical even
 * when the request around it is only the light verb ("2번 끝냄 처리해줘"). The same inflection rule as the garble check.
 */
export function nlFrameHasActionInflection(frame: string, actionWords: readonly string[], verbalNouns: readonly string[]): boolean {
  const known = [...new Set(actionWords.map(normalizeForMatch))].filter((word) => !/\s/u.test(word));
  const nouns = new Set(verbalNouns.map(normalizeForMatch));
  return wordsOf(frame).some((word) => {
    const tail = NL_GLUED_REQUEST_TAIL.exec(word);
    const stem = tail !== null ? word.slice(0, tail.index) : word;
    const once = stem.replace(PARTICLE_TAIL, '');
    const stems = [...new Set([stem, once, once.replace(PARTICLE_TAIL, '')])].filter((candidate) => candidate.length > 0);
    return stems.some((candidate) => known.some((action) => isInflection(candidate, action, nouns)));
  });
}

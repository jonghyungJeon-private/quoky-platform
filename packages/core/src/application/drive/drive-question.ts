import { DRIVE_LISTING_MAX_ENTRIES, DRIVE_NAME_QUERY_MAX_LENGTH } from '../../ports/drive-reader.port';
import { normalizeForMatch } from '../nl-routing/selection-input';
import { groundingWordIn } from '../nl-routing/selection-validator';
import { DRIVE_KIND_WORDS } from '../nl-routing/wave1-entries';

/**
 * The deterministic Drive grammar (ADR-0118 D4/D6/D7, DRV-1). Pure and anchored: a message is claimed only when the
 * WHOLE message (after normalization) is one of the forms below, so a pasted document, a how-to question, a coding
 * request about a file or any longer request falls through unchanged. Every decision is taken from the owner's own
 * text (ADR-0118 D8); nothing here ever sees a file name or file content.
 *
 * Recent files (KO): `최근 문서`, `최근 파일`, `최근 수정한 문서`, `드라이브 최근 파일`, `최근 드라이브 문서 보여줘`, with an
 * optional tail such as `보여줘`, `알려줘`, `목록`, `뭐 있어?`. (EN): `recent documents`, `recent drive files`,
 * `show my recent docs`, `what's new in my drive`.
 *
 * Name searches always name the drive, so a Confluence or code question about a "문서" or a "파일" is never claimed:
 * `드라이브에서 <이름> 찾아줘`, `드라이브에서 <이름> 문서 검색해줘`, `<이름> 문서 드라이브에서 찾아줘`,
 * `구글 드라이브 <이름> 검색`, and `보여줘` only with a document noun (`드라이브에서 회의록 문서 보여줘`). (EN):
 * `find <name> in my drive`, `search drive for <name>`.
 *
 * Summaries: `N번 문서 요약해줘`, `문서 N번 요약`, `드라이브 N번 요약해줘`, `두 번째 문서 요약해줘`, `이 문서 요약해줘`,
 * `summarize document 3`, `summarize drive file 3`, `summarize this document`. Distinct from the mail grammar's
 * `N번 메일`: the noun is `문서` (or the drive), never `메일`, and never a bare `N번 파일`, which a code proposal could
 * mean. A summary refers to the session's last Drive listing; the number is 1..10. `이 문서` without the drive word is
 * claimed by the handler only while such a listing exists (otherwise it is someone else's document and falls through).
 *
 * Write requests (refused with fixed copy, ADR-0118 D6) also name the drive or a listed number: `드라이브에서 회의록
 * 삭제해줘`, `드라이브에 올려줘`, `3번 문서 공유해줘`, `share the budget doc in my drive`, `delete document 2`.
 *
 * A name that is a pronoun, a time word, a relative time or a topic (`드라이브에서 어제 문서 찾아줘`, `드라이브에서 회의 관련
 * 문서 찾아줘`) gets the usage line: Drive search is by name only. A how-to or explanation (`드라이브에서 파일 찾는 법`) or a
 * second-person word falls through to chat.
 */

export type DriveLanguage = 'ko' | 'en';

export type DriveSummaryTarget = { readonly kind: 'this' } | { readonly kind: 'index'; readonly index: number };

export type DriveQuestion =
  | { readonly kind: 'recent'; readonly language: DriveLanguage }
  | { readonly kind: 'search'; readonly name: string; readonly language: DriveLanguage }
  | {
      readonly kind: 'summarize';
      readonly target: DriveSummaryTarget;
      /** False for a bare `이 문서` / `this document`: claimed only while a Drive listing exists in the conversation. */
      readonly explicit: boolean;
      readonly language: DriveLanguage;
    }
  | { readonly kind: 'write-refused'; readonly language: DriveLanguage }
  | { readonly kind: 'usage'; readonly language: DriveLanguage };

/**
 * The drive noun. `드라이브` alone also means a local disk (`D 드라이브`, `USB 드라이브`; refused below) or a car drive
 * (`드라이브 코스 찾아줘`), so a search or a write with the bare word needs a particle (`드라이브에서`) or a document noun;
 * the brand forms (`구글 드라이브`, `Google Drive`) need neither.
 */
const BRAND_DRIVE = '(?:구글 ?드라이브|google ?drive)';
const DRIVE = `(?:${BRAND_DRIVE}|드라이브)`;
/** A local or removable disk is never the owner's cloud drive: such a message is not a Drive command at all. */
const LOCAL_DISK = /(?:^|[\s(])(?:[a-z]|usb|외장|로컬|ssd|hdd|nas|네트워크|이동식|하드|시스템|공유) ?드라이브/iu;
/** A document noun. `파일` counts only next to the drive word or in a recent-files listing. */
const DOC_NOUN = '(?:구글 ?문서|구글 ?시트|스프레드 ?시트|문서|파일|시트|docs?)';
const NOUN_PARTICLE = '(?:들이|들은|들을|들|이|은|을|를)?';
const LIST_TAIL =
  '(?:보여 ?줘|보여 ?주세요|보여 ?줄래|알려 ?줘|알려 ?주세요|알려 ?줄래|확인해 ?줘|확인해 ?주세요|목록|리스트|' +
  '찾아 ?줘|찾아 ?주세요|뭐 ?있어요|뭐 ?있어|뭐 ?있나요|뭐 ?있나|뭐야|뭐예요|있어요|있어|있나요|몇 ?개(?:야|예요|있어)?)';
/** What "recent" may say about the files: modified, changed or edited (the listing is ordered by modification time). */
const RECENT_WORD = '(?:내가 ?)?(?:최근(?:에)?|요즘) ?(?:(?:내가 ?)?(?:수정한|수정된|바뀐|변경된|편집한|작업한) ?)?';

const RECENT_KO = new RegExp(
  `^(?:내 ?)?(?:${DRIVE}(?:에서|의|에)? ?)?${RECENT_WORD}(?:${DRIVE}(?:의)? ?)?(?:${DOC_NOUN})${NOUN_PARTICLE} ?(?:좀 ?)?(?:${LIST_TAIL})?$`,
  'iu',
);

const SEARCH_VERB = '(?:찾아 ?줘|찾아 ?주세요|찾아 ?줄래|찾아 ?봐 ?줘|찾아 ?봐|검색해 ?줘|검색해 ?주세요|검색해 ?줄래|검색)';
const SHOW_VERB = '(?:보여 ?줘|보여 ?주세요|알려 ?줘|알려 ?주세요)';
/** `드라이브에서 <head> [문서] 찾아줘`: the drive word first. */
const SEARCH_DRIVE_FIRST = new RegExp(
  `^(?:내 ?)?(?:(?<brand>${BRAND_DRIVE})|드라이브)(?<particle>에서|에|의)? (?<head>.+?)(?: ?(?<noun>${DOC_NOUN})(?:을|를|들)?)? ?(?:좀 ?)?(?:(?<search>${SEARCH_VERB})|(?<show>${SHOW_VERB}))$`,
  'iu',
);
/** `<head> 문서 드라이브에서 찾아줘`: the drive word before the verb; a document noun is required. */
const SEARCH_DRIVE_LAST = new RegExp(
  `^(?<head>.+?) ?(?<noun>${DOC_NOUN})(?:을|를)? (?:내 ?)?${DRIVE}(?:에서|에) ?(?:좀 ?)?(?<search>${SEARCH_VERB})$`,
  'iu',
);
/** A drive word with no name: `드라이브에서 찾아줘`. */
const SEARCH_NO_NAME = new RegExp(`^(?:내 ?)?${DRIVE}(?:에서|에)? ?(?:${DOC_NOUN} ?)?(?:좀 ?)?${SEARCH_VERB}$`, 'iu');

/** Name suffixes that only say "named": `회의록이라는`, `예산이라고 된`, `계약 이름의`. Stripped from the end. */
const NAME_LINK = /(?: ?(?:이?라는|이?라고 된|이?란|이름의|이름이 들어간|(?:이|가) 들어간|(?:이|가) 포함된|제목의))$/u;
/** A topic, not a name (usage line): `회의 관련`, `예산에 관한`, `계약에 대한`. */
const TOPIC_NAME = /(?:관련된?|에 관한|에 대한|에 관해)$/u;
/** An explanation or how-to request, never a search (falls through): `파일 찾는 법`, `공유 방법`. */
const EXPLAIN_NAME = /(?:법|방법|사용법|이유|뭐야|뭐예요|어떻게|하는지|되는지|할 수 있어)$|어떻게/u;
/** A relative time (`3일 전`, `2주 전`): a time, never a name. */
const RELATIVE_TIME = /^\d{1,3} ?(?:일|주|달|개월|년) ?전$/u;
/** A particle after a time word (`어제부터`, `지난주에`). */
const TIME_PARTICLE = /(?:에서|에|부터|까지|에 만든|에 수정한|에 올린)$/u;
/** Names that are really a pronoun, a determiner or a time word (usage line). */
const NOT_A_NAME = new Set([
  '이', '그', '저', '요', '내', '제', '나', '저희', '우리', '모든', '전체', '전부', '다', '새', '중요한', '공유된', '공유받은',
  '공유 받은', '내가 만든', '내가 쓴', '오늘', '어제', '그제', '그저께', '내일', '이번 주', '이번주', '지난 주', '지난주',
  '이번 달', '이번달', '지난 달', '지난달', '올해', '작년', '최신', '새로운',
]);
const SECOND_PERSON = new Set(['네', '너', '니', '너의', '당신']);
/** `최근`, `최근에 수정한`: the recent listing even inside a search form (`드라이브에서 최근 문서 찾아줘`). */
const RECENT_NAME = new RegExp(`^${RECENT_WORD}$`, 'u');
/** A name that starts with a time word or a relative time (`오늘 수정한`, `어제 만든 회의록`, `지난주 회의록`, `3일 전 자료`). */
const TIME_LEAD =
  /^(?:오늘|어제|그제|그저께|내일|요즘|올해|작년|재작년|(?:지난|이번|다음) ?(?:주|달|해)|\d{1,3} ?(?:일|주|달|개월|년) ?전)(?:에|부터|까지|의)?(?: |$)/u;
/** A "who made or changed it" participle (`내가 작성한`, `김철수가 공유한`, `받은`): not a name. */
const PARTICIPLE = /(?:^|\s)\S*(?:만든|수정한|수정된|작성한|올린|받은|공유한|공유된|편집한|쓴|업로드한|변경한|바뀐)(?:\s|$)/u;

const SUMMARY_TAIL = '(?:요약(?:해 ?줘|해 ?주세요|해 ?줄래|해 ?봐|해|좀|부탁해요|부탁해)?)';
/** The summary noun: `문서`, or the drive word with an optional document noun. Never a bare `파일` and never `메일`. */
const SUMMARY_NOUN = `(?:(?<drive>${DRIVE}) ?(?:${DOC_NOUN})?|문서)`;
const SUMMARY_THIS_KO = new RegExp(
  `^(?:이|그|방금|위|이번) ?(?:그 ?)?${SUMMARY_NOUN}(?: ?내용)?(?:을|를)? ?(?:좀 ?)?${SUMMARY_TAIL}$`,
  'iu',
);
const SUMMARY_INDEX_KO = new RegExp(
  `^(?<n>\\d{1,2}) ?번(?:째)? ?${SUMMARY_NOUN}(?: ?내용)?(?:을|를)? ?(?:좀 ?)?${SUMMARY_TAIL}$`,
  'iu',
);
const SUMMARY_INDEX_AFTER_KO = new RegExp(
  `^(?:${DRIVE} ?(?:${DOC_NOUN} ?)?|문서 ?)(?<n>\\d{1,2}) ?번(?:째)?(?: ?(?:문서|파일))?(?:을|를)? ?(?:좀 ?)?${SUMMARY_TAIL}$`,
  'iu',
);
const ORDINALS_KO: Readonly<Record<string, number>> = {
  첫: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
};
const SUMMARY_ORDINAL_KO = new RegExp(
  `^(?<o>첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열) ?번째 ?${SUMMARY_NOUN}(?: ?내용)?(?:을|를)? ?(?:좀 ?)?${SUMMARY_TAIL}$`,
  'iu',
);

/** Imperative write verbs (`… 해줘` / `… 해 주세요`): every file, sharing or permission change, and uploads. */
const WRITE_VERB_KO =
  '(?:삭제해|지워|공유해|공유 ?설정해|수정해|편집해|고쳐|이름 ?(?:을 ?)?바꿔|이름 ?변경해|옮겨|이동해|복사해|만들어|생성해|' +
  '업로드해|올려|휴지통에 ?버려|휴지통으로 ?옮겨|권한 ?(?:을 ?)?(?:바꿔|변경해|부여해|줘)|저장해) ?(?:줘|주세요|줄래)';
/** `드라이브에서 회의록 삭제해줘`, `드라이브 문서 공유해줘`, `구글 드라이브 회의록 지워줘`: the drive word first. */
const WRITE_DRIVE_FIRST = new RegExp(
  `^(?:내 ?)?(?:(?<brand>${BRAND_DRIVE})|드라이브)(?<particle>에서|에|의|로|에다)? ?(?<rest>.{0,60}?) ?(?:다 ?|모두 ?)?${WRITE_VERB_KO}$`,
  'iu',
);
const WRITE_KO: readonly RegExp[] = [
  // `회의록 드라이브에 올려줘`, `이거 드라이브에 저장해줘`
  new RegExp(`^.{1,60}? (?:내 ?)?${DRIVE}(?:에|로|에다|에서) ?(?:다 ?|모두 ?)?${WRITE_VERB_KO}$`, 'iu'),
  // `3번 문서 공유해줘`, `2번째 드라이브 파일 삭제해줘`
  new RegExp(`^\\d{1,2} ?번(?:째)? ?${SUMMARY_NOUN}(?:을|를)? ?(?:다 ?)?${WRITE_VERB_KO}$`, 'iu'),
];
const DOC_NOUN_ANYWHERE = new RegExp(DOC_NOUN, 'iu');

/** A bare `드라이브` is the cloud drive only with a particle or a document noun (`드라이브 코스 수정해줘` is a car trip). */
function isDriveWrite(normalized: string): boolean {
  const first = WRITE_DRIVE_FIRST.exec(normalized);
  if (first) {
    const groups = first.groups ?? {};
    if (groups.brand !== undefined || groups.particle !== undefined || DOC_NOUN_ANYWHERE.test(groups.rest ?? '')) return true;
  }
  return WRITE_KO.some((re) => re.test(normalized));
}

const EN_DOC = '(?:files?|docs?|documents?|spreadsheets?|sheets?)';
/**
 * The cloud drive in English: `my drive` or `google drive` (review P2-3: `the drive` is as often a disk or a car).
 * Only `search drive for …` and `summarize drive file N` also take the bare word.
 */
const EN_DRIVE = '(?:my (?:google )?drive|google drive)';
const EN_DRIVE_LOOSE = '(?:(?:my |google |my google )?drive)';
/** A local, removable or network disk in English is never the cloud drive (review P2-3). */
const EN_LOCAL_DISK = /\b(?:usb|external|hard|ssd|hdd|flash|thumb|network|disk|[a-z]:?)\s?drives?\b/i;
const RECENT_EN: readonly RegExp[] = [
  new RegExp(
    `^(?:(?:show|list|get|check)(?: me)? )?(?:my )?(?:recent|latest|recently (?:modified|edited|changed)) (?:(?:google )?drive )?${EN_DOC}(?: (?:in|on|from) ${EN_DRIVE})?(?: please)?$`,
    'i',
  ),
  new RegExp(`^what(?:'s| is) (?:new|recent) (?:in|on) ${EN_DRIVE}$`, 'i'),
];
const SEARCH_EN: readonly RegExp[] = [
  new RegExp(`^(?:find|search for|look for|look up)(?: (?:the|a|my))?(?: ${EN_DOC}(?: (?:named|called))?)? (?<name>.+?) in ${EN_DRIVE}(?: please)?$`, 'i'),
  new RegExp(`^search ${EN_DRIVE_LOOSE} for(?: (?:the|a))?(?: ${EN_DOC}(?: (?:named|called))?)? (?<name>.+?)(?: please)?$`, 'i'),
];
/** Review P3-1: a bare `file` is a code proposal's as often as a Drive file, so `this file` needs the drive word. */
const SUMMARY_THIS_EN = new RegExp(
  `^summari[sz]e (?:this|that|the) (?:(?<drive>(?:google )?drive) (?:document|doc|file)|document|doc)(?: please)?$`,
  'i',
);
const SUMMARY_INDEX_EN = new RegExp(
  `^summari[sz]e (?:(?:google )?drive (?:file|doc|document)|doc|document) (?:#|no\\.? ?|number )?(?<n>\\d{1,2})(?: please)?$`,
  'i',
);
const EN_WRITE_VERB = '(?:share|unshare|delete|remove|trash|edit|modify|rename|move|copy|upload|create|save|write)';
const WRITE_EN: readonly RegExp[] = [
  new RegExp(`^${EN_WRITE_VERB}\\b.{0,80}? (?:in|on|to|from|into) ${EN_DRIVE}(?: please)?$`, 'i'),
  new RegExp(`^${EN_WRITE_VERB} (?:(?:google )?drive (?:file|doc|document)|doc|document) (?:#|no\\.? ?|number )?\\d{1,2}$`, 'i'),
];
const EN_NOT_A_NAME = /^(?:me|myself|my|it|this|that|everything|anything|all|today|yesterday|this week|last week|this month|last month)$/i;
const EN_RECENT_NAME = /^(?:(?:my )?(?:recent|latest|new) (?:files?|docs?|documents?))$/i;
const EN_TOPIC_OR_TIME = /^(?:about|related to|regarding|on the topic of|from (?:today|yesterday|last|this)|modified|created|shared)\b/i;
/** Review P2-2: a time filter anywhere in the name (`report from last week`, `notes created yesterday`). */
const EN_TIME_FILTER =
  /\b(?:from|since|modified|created|edited|shared|uploaded|made|written)\b[\s\S]{0,60}?\b(?:today|yesterday|last|this|ago)\b|\b(?:today|yesterday)'?s?\b/i;
const EN_EXPLAIN = /\b(?:how|why|what|way|ways)\b/i;

/** Normalize like the other deterministic grammars: NFKC, no format characters, one space, no trailing punctuation. */
export function normalizeDriveText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?!.。~…]+$/u, '')
    .trim();
}

function languageOf(text: string): DriveLanguage {
  return /[가-힣]/u.test(text) ? 'ko' : 'en';
}

function indexTarget(raw: string | undefined): DriveSummaryTarget | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= DRIVE_LISTING_MAX_ENTRIES ? { kind: 'index', index: n } : null;
}

const stripQuotes = (value: string) => value.replace(/^["'“”‘’`「『]+|["'“”‘’`」』]+$/gu, '').trim();

/** The jongseong index of a Hangul syllable (0 = none, 8 = `ㄹ`), -1 for anything else. */
const jongseong = (syllable: string): number => {
  const code = syllable.charCodeAt(0) - 0xac00;
  return code >= 0 && code < 11172 ? code % 28 : -1;
};
/** Common one-syllable `ㄹ` nouns (and `역할`) that are file names, never an adnominal verb form. */
const RIEUL_NOUNS = new Set(['일', '글', '설', '말', '물', '술', '별', '달', '길', '불', '칼', '쌀', '역할']);
/**
 * A first word (followed by a space) that is an adnominal verb form: `…을` after a stem with a final consonant
 * (`먹을`, `읽을`, `찾을`; `가을` and `노을` are names), a lone `ㄹ` syllable (`볼`, `갈`), a longer word ending in a
 * verb-like `ㄹ` syllable (`만들`, `해볼`), or `-ㄹ만한` (`볼만한`, `먹을만한`). A noun that ends in `ㄹ` (`서울`, `겨울`)
 * is not matched.
 */
function hasAdnominalHead(head: string): boolean {
  const word = /^(\S+) /u.exec(head)?.[1];
  if (word === undefined || !/^[가-힣]+$/u.test(word)) return false;
  if (RIEUL_NOUNS.has(word)) return false;
  const chars = Array.from(word);
  const last = chars[chars.length - 1] as string;
  if (chars.length >= 3 && last === '한' && chars[chars.length - 2] === '만') {
    const stem = chars[chars.length - 3] as string;
    return jongseong(stem) === 8 || (stem === '을' && chars.length >= 4);
  }
  if (chars.length >= 2 && last === '을') return jongseong(chars[chars.length - 2] as string) > 0;
  if (chars.length === 1) return jongseong(last) === 8;
  return /[할볼갈쓸놀걸팔풀]/u.test(last) || (last === '들' && word.endsWith('만들'));
}
const PRODUCT_HEAD = /^(?:요금제|가격|요금|대안|용량|플랜|설치|다운로드|앱|사용법|대체재|대체)(?: |$)/u;

/**
 * The name of a Korean search head; `'recent'` for the recent listing; `'usage'` when no usable name is left; `null`
 * when the head is not a search at all (an anchored command, a how-to, a second-person word), which then falls through.
 */
function parseNameHead(head: string, brand = false): string | 'recent' | 'usage' | null {
  let rest = head.trim();
  // CA review P2-3: an adnominal first word (`볼 영화`, `먹을 간식`, `들을 노래`) is a request for something to watch,
  // eat or hear, never a file name; and `구글 드라이브 요금제 찾아줘` asks about the product, not the owner's files.
  if (hasAdnominalHead(rest)) return null;
  if (brand && PRODUCT_HEAD.test(rest)) return null;
  if (/[:：]/u.test(rest)) return null;
  if (EXPLAIN_NAME.test(rest)) return null;
  if (TOPIC_NAME.test(rest)) return 'usage';
  for (let round = 0; round < 3; round += 1) {
    const next = stripQuotes(rest.replace(NAME_LINK, '').trim());
    if (next === rest) break;
    rest = next;
  }
  if (SECOND_PERSON.has(rest)) return null;
  if (RECENT_NAME.test(rest)) return 'recent';
  // Review P3-2: `드라이브에 있는 예산`, `드라이브에서 내 이력서`: the location and the owner are not part of the name. A
  // leading `최근` only says "newest first", which every listing already is (`최근 회의록` searches `회의록`).
  const trimmed = rest.replace(/^(?:있는|내|제|나의|저의|최근(?:에)?) /u, '').trim();
  if (trimmed !== rest && trimmed.length > 0 && !RECENT_NAME.test(trimmed)) rest = trimmed;
  // Review P2-2: a time filter or a "who made / changed it" phrase is not a name (`오늘 수정한`, `어제 만든 회의록`,
  // `지난주 회의록`, `내가 작성한`): Drive search is by name only, so these get the usage line.
  if (TIME_LEAD.test(rest) || PARTICIPLE.test(rest)) return 'usage';
  const stem = rest.replace(TIME_PARTICLE, '').trim();
  const isTime = (word: string) =>
    NOT_A_NAME.has(word) || RELATIVE_TIME.test(word) || /^(?:지난|이번|다음|올|작|재작) ?(?:주|달|해|년)$/u.test(word);
  if (isTime(rest) || isTime(stem)) return 'usage';
  if (rest.length === 0 || Array.from(rest).length > DRIVE_NAME_QUERY_MAX_LENGTH) return 'usage';
  return rest;
}

/** The English name: `'recent'`, `'usage'` (a time or a topic), `null` (a how-to or the owner), or the name. */
function parseEnglishName(raw: string): string | 'recent' | 'usage' | null {
  let name = stripQuotes(raw);
  if (/[:：]/u.test(name) || EN_EXPLAIN.test(name)) return null;
  if (/^(?:me|myself)\b/i.test(name)) return null;
  if (EN_RECENT_NAME.test(name)) return 'recent';
  // `find my resume in my drive`, `find recent budget in my drive`: the owner and "newest first" are not the name.
  name = name.replace(/^(?:my|the|recent|latest) (?=\S)/i, '').trim();
  if (EN_NOT_A_NAME.test(name) || EN_TOPIC_OR_TIME.test(name) || EN_TIME_FILTER.test(name)) return 'usage';
  if (name.length === 0 || Array.from(name).length > DRIVE_NAME_QUERY_MAX_LENGTH) return 'usage';
  return name;
}

function fromName(parsed: string | 'recent' | 'usage' | null, language: DriveLanguage): DriveQuestion | null {
  if (parsed === null) return null;
  if (parsed === 'recent') return { kind: 'recent', language };
  if (parsed === 'usage') return { kind: 'usage', language };
  return { kind: 'search', name: parsed, language };
}

/**
 * The Drive question `text` asks, or `null` when the message is not one of the anchored Drive forms (it then falls
 * through unchanged). Pure; never reads a clock or any file.
 */
export function parseDriveQuestion(text: string, options: { readonly yieldToSelection?: boolean } = {}): DriveQuestion | null {
  const question = parseDriveGrammar(text);
  // ADR-0120 A2: a listing carries no file kind. With yield on, a message that names one (`최근 스프레드시트`, `pdf`,
  // `폴더`) is a qualifier the grammar cannot express, so it declines and selection binds `kind`. A plain `문서`/`파일`
  // is not a kind word and still answers.
  if (options.yieldToSelection === true && question !== null && (question.kind === 'recent' || question.kind === 'search')) {
    // The selector's own grounding matcher: an ASCII word needs word boundaries (`docsify` is not `docs`).
    const normalized = normalizeForMatch(normalizeDriveText(text));
    if (Object.values(DRIVE_KIND_WORDS).some((words) => words.some((word) => groundingWordIn(normalized, normalizeForMatch(word))))) return null;
  }
  return question;
}

function parseDriveGrammar(text: string): DriveQuestion | null {
  if (typeof text !== 'string' || text.length > 300) return null;
  const normalized = normalizeDriveText(text);
  if (normalized.length === 0) return null;
  if (LOCAL_DISK.test(normalized) || EN_LOCAL_DISK.test(normalized)) return null;
  const language = languageOf(normalized);

  if (isDriveWrite(normalized) || WRITE_EN.some((re) => re.test(normalized))) {
    return { kind: 'write-refused', language };
  }

  const thisKo = SUMMARY_THIS_KO.exec(normalized) ?? SUMMARY_THIS_EN.exec(normalized);
  if (thisKo) {
    return { kind: 'summarize', target: { kind: 'this' }, explicit: thisKo.groups?.drive !== undefined, language };
  }
  const indexed =
    SUMMARY_INDEX_KO.exec(normalized) ?? SUMMARY_INDEX_AFTER_KO.exec(normalized) ?? SUMMARY_INDEX_EN.exec(normalized);
  if (indexed) {
    const target = indexTarget(indexed.groups?.n);
    return target ? { kind: 'summarize', target, explicit: true, language } : { kind: 'usage', language };
  }
  const ordinal = SUMMARY_ORDINAL_KO.exec(normalized);
  if (ordinal) {
    const index = ORDINALS_KO[ordinal.groups?.o ?? ''];
    return index !== undefined ? { kind: 'summarize', target: { kind: 'index', index }, explicit: true, language } : null;
  }

  if (RECENT_KO.test(normalized) || RECENT_EN.some((re) => re.test(normalized))) return { kind: 'recent', language };

  if (SEARCH_NO_NAME.test(normalized)) return { kind: 'usage', language };
  const first = SEARCH_DRIVE_FIRST.exec(normalized);
  if (first) {
    // `보여줘` / `알려줘` search only with a document noun (`드라이브에서 회의록 문서 보여줘`): `드라이브 사용법 알려줘` is a
    // question about the drive, not a search.
    if (first.groups?.show !== undefined && first.groups?.noun === undefined) return null;
    // A bare `드라이브` needs a particle or a document noun: `드라이브 코스 찾아줘` is a car trip.
    if (first.groups?.brand === undefined && first.groups?.particle === undefined && first.groups?.noun === undefined) return null;
    return fromName(parseNameHead(first.groups?.head ?? '', first.groups?.brand !== undefined), language);
  }
  const last = SEARCH_DRIVE_LAST.exec(normalized);
  if (last) return fromName(parseNameHead(last.groups?.head ?? ''), language);
  for (const form of SEARCH_EN) {
    const match = form.exec(normalized);
    if (match) return fromName(parseEnglishName(match.groups?.name ?? ''), language);
  }
  return null;
}

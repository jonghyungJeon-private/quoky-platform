/**
 * ADR-0124 phase 2 P2-5: CH9, a hand-written, hash-frozen OWN-MEMORY set for measuring the own-memory judgment rule.
 *
 * Why it exists: an own-memory question ("내가 좋아하는 과일이 뭐였지?") is answered from recalled durable entries only when the
 * policy (`own-memory-recall.ts`) finds a hit; otherwise the user gets the fixed truthful "not in memory" reply. A FALSE hit lets the
 * answering model invent a personal fact, a MISS only costs a truthful "not in memory". CH9 measures how many paraphrase-only questions
 * (no shared topic word) the production score floor misses, and whether a calibrated offline rule could recover them with ZERO false hits.
 *
 * Authored by hand, memory by memory, before any model ran on it; nothing was fitted to a score. Fictional only: no real person, company,
 * product, address or number; people appear by ROLE only; no credential-like content.
 *
 * Question categories (every question satisfies `detectOwnMemoryRecallQuestion(text) !== null`, tested):
 *   - `positive-paraphrase`: a stored memory answers it and it shares NO topic word with ANY stored memory (production `sharesTopicWord`).
 *   - `positive-shared`    : names the subject the way its gold memory does (production already hits these).
 *   - `negative`           : NOTHING stored answers it. HARD on purpose: same domain as a stored fact but another attribute or object. A negative
 *                            also shares no topic word with any memory (tested), so the measured false hits isolate the SEMANTIC path (a topic-word
 *                            false hit is a separate production property and is reported by the eval as its own count).
 *
 * Negative review (each checked by hand against every stored memory; "stored -> asked"):
 *   favourite fruit -> favourite vegetable / fish / snack / drink / flower; favourite genre of music -> singer / actor; cat's name -> dog / hamster name;
 *   sister's birthday -> grandmother's 생신 (same attribute, other person, other word); mother's job -> uncle / older sister / classmate jobs;
 *   wedding anniversary -> wedding venue / honeymoon; hometown -> favourite city, university major, high school; commute by subway -> transfer station,
 *   leaving time; gym membership -> pilates coach; weekly yoga -> art teacher name; allergy -> blood type, medicine cabinet; rent day -> deposit end date,
 *   insurance, savings maturity; (EN) favourite board game / pizza topping -> herb, pen brand, poet, concert venue, playwright; parrot / rabbit -> dog / hamster; grandfather birthday -> grandmother
 *   birth date; mother's job -> father profession, cousin job, aunt; best friend city -> neighbour, doctor, landlord names; bookstore -> restaurant.
 *
 * Single actor: all 70 memories belong to ONE user, so across the WHOLE set (both languages) at most one memory answers any question and no two memories give
 * competing values for the same subject (each memory has its own subject: different relatives, pets, places per language); a question names its subject unambiguously.
 *
 * Split (pre-declared): per category and language, in set order, even position = `calibrate`, odd = `validate`.
 */
import { createHash } from 'node:crypto';
import type { MemoryItem } from './memory-set';

export const MEMORY_OWN_VERSION = 'chunk-eval-memory-own.v1';
export const MEMORY_OWN_SEED = 'quoky-adr-0124-ch9-own-memory-hand-written-2026-11-09';

export type OwnCategory = 'positive-paraphrase' | 'positive-shared' | 'negative';
export const OWN_CATEGORIES: readonly OwnCategory[] = ['positive-paraphrase', 'positive-shared', 'negative'];
export type OwnLanguage = 'ko' | 'en';
export const OWN_LANGUAGES: readonly OwnLanguage[] = ['ko', 'en'];
export type OwnHalf = 'calibrate' | 'validate';

export interface OwnMemory extends MemoryItem {
  readonly language: OwnLanguage;
  readonly daysAgo: number;
  readonly domain: string;
}
export interface OwnQuery {
  readonly id: string;
  readonly language: OwnLanguage;
  readonly text: string;
  readonly category: OwnCategory;
  /** The memory ids that answer the question; empty for a negative. */
  readonly gold: readonly string[];
  readonly half: OwnHalf;
}
export interface OwnSet {
  readonly memories: readonly OwnMemory[];
  readonly queries: readonly OwnQuery[];
}

type MemRow = readonly [id: string, daysAgo: number, domain: string, text: string];

const KO_MEMORIES: readonly MemRow[] = [
  ['k01', 40, 'preference', '내가 제일 좋아하는 과일은 샤인머스캣이야.'],
  ['k02', 22, 'preference', '커피는 속이 쓰려서 안 마시고 아침마다 보리차를 한 잔 마셔.'],
  ['k03', 150, 'preference', '옷은 거의 남색이랑 회색 계열로만 사는 편이야.'],
  ['k04', 63, 'preference', '운전할 때는 항상 재즈 앨범을 틀어 놓고 다녀.'],
  ['k05', 90, 'preference', '사계절 중에서는 선선한 가을을 제일 좋아해.'],
  ['k06', 35, 'preference', '나는 민트초코 맛은 질색이라 아이스크림 고를 때 꼭 뺀다.'],
  ['k07', 17, 'preference', '운동 중에는 배드민턴이 제일 재밌어서 주말마다 친다.'],
  ['k08', 120, 'preference', '영화는 잔잔한 가족 드라마가 취향이야.'],
  ['k09', 180, 'people', '여동생 생일은 3월 14일이야.'],
  ['k10', 170, 'people', '어머니는 초등학교에서 오랫동안 교사로 일하셨어.'],
  ['k11', 100, 'people', '제일 친한 친구는 대전에 살고 있어.'],
  ['k12', 12, 'people', '팀장님은 회의 전에 항상 자료를 미리 읽어 오라고 하셔.'],
  ['k13', 140, 'people', '형은 병원에서 간호사로 일해.'],
  ['k14', 75, 'people', '아버지는 주말마다 낚시를 가시는 게 취미야.'],
  ['k15', 60, 'people', '옆집 아주머니가 가끔 반찬을 나눠 주셔서 명절마다 작은 선물을 드린다.'],
  ['k16', 30, 'pets', '우리 고양이 이름은 보리고 올해 세 살이야.'],
  ['k17', 14, 'pets', '고양이 예방접종은 매년 5월에 집 앞 동물병원에서 맞혀.'],
  ['k18', 8, 'pets', '베란다에 금붕어 두 마리를 키우는데 먹이는 하루에 한 번만 줘.'],
  ['k19', 200, 'dates', '내 생일은 9월 2일이야.'],
  ['k20', 110, 'dates', '결혼기념일은 5월 21일이라서 매년 그 주에 식당을 예약해.'],
  ['k21', 45, 'dates', '운전면허 갱신 기한이 내년 2월 말까지야.'],
  ['k22', 190, 'places', '고향은 부산이고 지금은 서울 외곽에서 살아.'],
  ['k23', 95, 'places', '작년 여름휴가는 제주도 동쪽 해변 근처 숙소에서 보냈어.'],
  ['k24', 28, 'places', '자주 가는 카페는 역 앞 골목 안쪽에 있는 작은 로스터리야.'],
  ['k25', 20, 'places', '헬스장은 회사 건물 지하 이층에 있고 회원권은 12월까지야.'],
  ['k26', 5, 'routine', '평일에는 아침 여섯 시 반에 일어나서 스트레칭부터 해.'],
  ['k27', 9, 'routine', '출근은 지하철 이호선으로 하고 환승은 한 번 해.'],
  ['k28', 3, 'routine', '매주 화요일 저녁에는 요가 수업에 가.'],
  ['k29', 11, 'routine', '밤 열한 시가 되면 휴대전화를 거실에 두고 잠자리에 들어.'],
  ['k30', 6, 'routine', '일요일 오전에는 장을 보고 반찬을 한꺼번에 만들어 둬.'],
  ['k31', 130, 'health', '나는 갑각류 알레르기가 있어서 새우가 들어간 음식은 못 먹어.'],
  ['k32', 7, 'health', '비타민은 점심 먹고 바로 챙겨 먹는 걸로 정했어.'],
  ['k33', 25, 'work', '업무용 노트북은 가벼운 은색 모델이고 가방에 항상 넣어 다녀.'],
  ['k34', 33, 'hobby', '수채화 수업은 매주 목요일 밤에 있어.'],
  ['k35', 4, 'hobby', '요즘은 퇴근길에 추리소설을 읽는 게 낙이야.'],
  ['k36', 70, 'home', '차는 흰색 소형차고 주차는 아파트 지하 삼층에 해.'],
  ['k37', 16, 'home', '이사한 집 와이파이 공유기는 거실 서랍장 위에 있어.'],
  ['k38', 13, 'hobby', '영어 회화는 매주 토요일 아침에 온라인으로 공부해.'],
  ['k39', 80, 'people', '조카가 올해 중학교에 입학해서 입학 선물로 시계를 줬어.'],
  ['k40', 21, 'people', '후배한테 빌려준 우산은 아직 돌려받지 못했어.'],
  ['k41', 52, 'dates', '월세는 매달 25일에 자동이체로 나가.'],
  ['k42', 38, 'preference', '라면은 순한 맛만 먹고 매운 건 못 먹어.'],
];

const EN_MEMORIES: readonly MemRow[] = [
  ['e01', 60, 'preference', 'My favourite board game is chess because a match fits in under an hour.'],
  ['e02', 25, 'preference', 'My favourite pizza topping is mushrooms.'],
  ['e03', 11, 'preference', 'I always order my eggs scrambled, never fried.'],
  ['e04', 45, 'pets', 'My parrot Pepper is five years old and hates the vacuum cleaner.'],
  ['e05', 18, 'pets', 'I have a rabbit named Clover who only eats timothy hay.'],
  ['e06', 160, 'people', "My grandfather's birthday is on July 9th."],
  ['e07', 130, 'people', 'My cousin works as a pharmacist at a hospital downtown.'],
  ['e08', 85, 'people', 'My old flatmate moved to Denver last spring.'],
  ['e09', 14, 'people', 'My client prefers a short summary before any long report.'],
  ['e10', 22, 'people', 'My brother is training for his first marathon in October.'],
  ['e11', 100, 'people', 'My uncle runs a small bakery near the harbor.'],
  ['e12', 170, 'dates', 'I started at the company on October 3rd, so I celebrate my work anniversary then.'],
  ['e13', 55, 'dates', 'My passport expires in the spring of 2028.'],
  ['e14', 190, 'places', 'I played the trumpet in the school band until I was eighteen.'],
  ['e15', 110, 'places', "Next spring we're renting a cabin in the mountains for a week."],
  ['e16', 35, 'places', 'My favourite bookstore is the little one with the green door near the station.'],
  ['e17', 8, 'routine', 'My gym is open twenty-four hours and I go on Monday, Wednesday and Friday mornings.'],
  ['e18', 3, 'routine', 'I leave for the station at seven fifteen and buy a paper on the way.'],
  ['e19', 6, 'routine', 'On Sundays I clean the apartment and do the laundry.'],
  ['e20', 10, 'routine', 'I swim every Thursday after work.'],
  ['e21', 125, 'health', "I'm allergic to peanuts, so I always read the labels."],
  ['e22', 9, 'health', 'I keep my spare house key in a small lockbox by the back gate.'],
  ['e23', 30, 'work', 'My headphones are cream-coloured over-ear ones and the case lives in my desk drawer.'],
  ['e24', 20, 'hobby', "I'm learning the cello and my lesson is on Saturday afternoons."],
  ['e25', 4, 'hobby', "I'm knitting a long scarf on the train these days."],
  ['e26', 65, 'home', 'My bike is a small blue folding one parked in the stairwell.'],
  ['e27', 48, 'home', 'My phone bill is due on the first of every month.'],
  ['e28', 75, 'people', "My daughter starts high school this fall; I'm giving her a backpack."],
];

type QRow = readonly [gold: string | null, text: string];

const KO_PARAPHRASE: readonly QRow[] = [
  ['k01', '내가 좋아하는 생과일 종류가 뭐였지?'],
  ['k02', '내가 말한 건강 음료 종류 기억나?'],
  ['k03', '내가 말한 패션 색조 기억나?'],
  ['k04', '내가 좋아하는 음악 장르가 뭐였지?'],
  ['k05', '내가 좋아하는 계절이 뭐였지?'],
  ['k06', '내가 싫어하는 디저트 향이 뭐였지?'],
  ['k07', '내가 좋아하는 스포츠가 뭐였지?'],
  ['k08', '내가 좋아하는 볼거리 분위기가 뭐였지?'],
  ['k09', '내 동생 탄생일이 언제였지?'],
  ['k10', '내 모친 직업이 뭐였지?'],
  ['k11', '내 절친 거주지가 어디였지?'],
  ['k12', '내 상사 업무 지시 버릇이 뭐였지?'],
  ['k13', '내 손위 형제 근무처가 어디였지?'],
  ['k14', '내 부친 여가 활동이 뭐였지?'],
  ['k16', '내 반려묘 이름이 뭐였지?'],
  ['k17', '내 반려묘 주사 맞는 시기가 언제였지?'],
  ['k18', '내 관상어 사료 급여 횟수가 뭐였지?'],
  ['k19', '내 출생일이 언제였지?'],
  ['k20', '내 혼인 기념 날짜가 언제였지?'],
  ['k21', '내 자동차 면허 만료 시점이 언제였지?'],
  ['k22', '내 유년기 거주 도시가 어디였지?'],
  ['k23', '내 지난 피서지가 어디였지?'],
  ['k24', '내 단골 찻집 위치가 어디였지?'],
  ['k25', '내 피트니스 이용권 만료가 언제였지?'],
  ['k26', '내 눈 뜨는 시간이 언제였지?'],
  ['k27', '내 통근 수단이 뭐였지?'],
  ['k28', '내 명상 체조 클래스 요일이 언제였지?'],
  ['k29', '내 수면 직전 습관이 뭐였지?'],
  ['k30', '내 휴일 식재료 구입 습관이 뭐였지?'],
  ['k31', '내가 말한 해산물 섭취 금지 기억나?'],
];

const EN_PARAPHRASE: readonly QRow[] = [
  ['e01', "What's my favourite tabletop pastime?"],
  ['e02', 'What did I say my preferred pie garnish was?'],
  ['e03', 'What did I say my breakfast protein style was?'],
  ['e04', "What did I say my feathered pet's age was?"],
  ['e05', "What's my bunny's name again?"],
  ['e06', "What did I say my grandpa's birth date was?"],
  ['e07', "What did I tell you about my relative's dispensary role?"],
  ['e08', "What did I say my former dorm mate's residence was?"],
  ['e09', "What did I say my customer's preferred briefing format was?"],
  ['e10', "What did I say my sibling's race goal is?"],
  ['e11', "What did I tell you about my relative's pastry shop?"],
  ['e12', "What's my employment milestone date again?"],
  ['e13', "What did I say my travel document's expiry was?"],
  ['e14', 'What did I tell you about my adolescent brass instrument?'],
  ['e15', 'What did I say my upcoming getaway accommodation was?'],
  ['e16', "What's my favourite spot to purchase paperbacks?"],
  ['e17', 'What did I say my fitness-centre visit weekdays were?'],
  ['e18', 'What did I say my leaving time was?'],
  ['e19', 'What did I say my garment-washing weekday was?'],
  ['e20', 'What did I tell you about my weekly pool session?'],
];

const KO_SHARED: readonly QRow[] = [
  ['k01', '내가 제일 좋아하는 과일이 뭐였지?'],
  ['k16', '내 고양이 이름이 뭐였지?'],
  ['k19', '내 생일이 언제였지?'],
  ['k22', '내 고향이 어디였지?'],
  ['k32', '내 비타민 복용 시간이 언제였지?'],
  ['k34', '내가 말한 수채화 수업 요일 기억나?'],
  ['k36', '내 차 색깔이 뭐였지?'],
  ['k38', '내가 말한 영어 공부 시간 기억나?'],
  ['k41', '내 월세 나가는 날이 언제였지?'],
  ['k31', '내 새우 알레르기 기억나?'],
  ['k26', '내가 말한 스트레칭 기억나?'],
  ['k29', '내 휴대전화 둔 곳이 어디였지?'],
];

const EN_SHARED: readonly QRow[] = [
  ['e04', "What's my parrot's name again?"],
  ['e06', "What did I say my grandfather's birthday was?"],
  ['e07', 'What did I tell you about my cousin?'],
  ['e13', 'What did I say my passport expiry was?'],
  ['e21', 'What did I tell you about my peanut allergy?'],
  ['e24', 'What did I say my cello lesson day was?'],
  ['e26', "What's my bike's colour again?"],
  ['e27', 'What did I tell you about my phone bill?'],
];

const KO_NEGATIVE: readonly string[] = [
  '내가 좋아하는 채소가 뭐였지?',
  '내가 싫어하는 채소가 뭐였지?',
  '내가 좋아하는 생선이 뭐였지?',
  '내가 좋아하는 간식이 뭐였지?',
  '내가 좋아하는 술이 뭐였지?',
  '내가 좋아하는 꽃이 뭐였지?',
  '내가 좋아하는 가수가 누구였지?',
  '내가 좋아하는 배우가 누구였지?',
  '내가 좋아하는 디저트가 뭐였지?',
  '내가 좋아하는 만화가가 누구였지?',
  '내가 좋아하는 도시가 어디였지?',
  '내가 좋아하는 향수가 뭐였지?',
  '내 강아지 이름이 뭐였지?',
  '내 햄스터 이름이 뭐였지?',
  '내 할머니 생신이 언제였지?',
  '내 고모 직업이 뭐였지?',
  '내 누나 직업이 뭐였지?',
  '내 남편 이름이 뭐였지?',
  '내 이모 거주지가 어디였지?',
  '내 대학 동기 직업이 뭐였지?',
  '내 결혼식 장소가 어디였지?',
  '내 신혼여행지가 어디였지?',
  '내 대학교 전공이 뭐였지?',
  '내 출신 고등학교가 어디였지?',
  '내 이사 날짜가 언제였지?',
  '내 필라테스 강사 이름이 뭐였지?',
  '내 퇴근 시각이 언제였지?',
  '내가 말한 야식 메뉴 기억나?',
  '내 환승역이 어디였지?',
  '내 킥보드 보관 장소가 어디였지?',
  '내 모니터 크기가 뭐였지?',
  '내 운동화 사이즈가 뭐였지?',
  '내 혈액형이 뭐였지?',
  '내 구두 사이즈가 뭐였지?',
  '내 상비약 위치가 어디였지?',
  '내 정기 건강검진 날짜가 언제였지?',
  '내 치과 예약 날이 언제였지?',
  '내 보험 만기일이 언제였지?',
  '내 적금 만기가 언제였지?',
  '내 전세 계약 종료일이 언제였지?',
  '내 미술 선생님 이름이 뭐였지?',
  '내가 말한 운전 연수 강사 기억나?',
];

const EN_NEGATIVE: readonly string[] = [
  "What's my favourite herb?",
  "What's my favourite pen brand?",
  "What's my favourite poet?",
  "What's my favourite concert venue?",
  "What's my favourite playwright?",
  'What did I say my dog\'s name was?',
  "What's my hamster's name again?",
  "What did I say my grandmother's birth date was?",
  "What did I tell you about my stepbrother's job?",
  "What did I say my father's profession was?",
  'What did I tell you about my aunt?',
  "Do you remember my wife's name?",
  "What did I say my neighbour's name was?",
  "What's my driver's licence class again?",
  'What did I say my previous employer was?',
  'What did I tell you about my college major?',
  'What did I say my alma mater mascot was?',
  "What's my shoe size again?",
  'What did I say my blood type was?',
  'Do you remember my favourite restaurant?',
  'What did I tell you about my honeymoon?',
  'What did I say my commute time was?',
  'What did I say my pool membership price was?',
  "What did I say my tablet's screen size was?",
  'What did I tell you about my scooter?',
  "What did I say my landlord's name was?",
  "What did I say my doctor's name was?",
  'What did I tell you about my insurance?',
];

const memoryOf = (language: OwnLanguage, [id, daysAgo, domain, text]: MemRow): OwnMemory => ({ id: `m-${id}`, language, text, long: false, factOffsets: [0], daysAgo, domain });

/** The CH9 set, assembled from the hand-written tables above (no random draw anywhere). */
export function loadMemorySetOwn(): OwnSet {
  const memories: OwnMemory[] = [...KO_MEMORIES.map((row) => memoryOf('ko', row)), ...EN_MEMORIES.map((row) => memoryOf('en', row))];
  const raw: Array<{ language: OwnLanguage; category: OwnCategory; gold: readonly string[]; text: string }> = [];
  const addRows = (language: OwnLanguage, category: OwnCategory, rows: readonly QRow[]): void => {
    for (const [gold, text] of rows) raw.push({ language, category, gold: gold === null ? [] : [`m-${gold}`], text });
  };
  addRows('ko', 'positive-paraphrase', KO_PARAPHRASE);
  addRows('en', 'positive-paraphrase', EN_PARAPHRASE);
  addRows('ko', 'positive-shared', KO_SHARED);
  addRows('en', 'positive-shared', EN_SHARED);
  addRows('ko', 'negative', KO_NEGATIVE.map((text): QRow => [null, text]));
  addRows('en', 'negative', EN_NEGATIVE.map((text): QRow => [null, text]));
  const seen = new Map<string, number>();
  const queries: OwnQuery[] = raw.map((item, at) => {
    const key = `${item.category}/${item.language}`;
    const position = seen.get(key) ?? 0;
    seen.set(key, position + 1);
    return { id: `q9-${String(at + 1).padStart(3, '0')}`, language: item.language, text: item.text, category: item.category, gold: item.gold, half: position % 2 === 0 ? 'calibrate' : 'validate' };
  });
  return { memories, queries };
}

// ---------------------------------------------------------------- digest

const memoryDigestOf = (item: OwnMemory): string => createHash('sha256').update(JSON.stringify([item.id, item.language, item.text, item.daysAgo, item.domain])).digest('hex');
const queryDigestOf = (item: OwnQuery): string => createHash('sha256').update(JSON.stringify([item.id, item.language, item.text, item.category, item.gold, item.half])).digest('hex');

/** sha256 over the version, the seed label, the counts and every memory and query digest, in order. Changes with any byte. */
export function memoryDigestOwn(set: OwnSet): string {
  const hash = createHash('sha256');
  hash.update(`${MEMORY_OWN_VERSION}\n${MEMORY_OWN_SEED}\n${set.memories.length}\n${set.queries.length}\n`);
  for (const item of set.memories) hash.update(`${memoryDigestOf(item)}\n`);
  for (const item of set.queries) hash.update(`${queryDigestOf(item)}\n`);
  return hash.digest('hex');
}

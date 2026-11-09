/**
 * ADR-0124 phase 2 P2-3 validation: gate CH8, an INDEPENDENT hash-frozen durable-memory set, hand-written (not generated).
 *
 * Why it exists: the CH7 blend comparison ran on a set whose `updatedAt` values are random, so it cannot show when recency
 * HELPS, and its vocabulary was the one already measured on. CH8 is authored by hand, memory by memory, as realistic personal
 * assistant notes (preferences, routines, health, work, home, people named by role only, places, purchases, plans), each with an
 * authored `daysAgo` that fits the fact; nothing is drawn from CH7's vocabulary tables and nothing was fitted to a score. The
 * content was written before any model ran on it.
 *
 * Query categories (every query is tagged):
 *   - `paraphrase`   : no content word shared with the gold (checked: `sharedTerms === 0`).
 *   - `shared`       : names the subject the way the memory does.
 *   - `recency-wins` : a topic with TWO memories, an older one (60-180 days) and a newer contradicting one (1-20 days), neither marked
 *                      superseded; the query asks about the CURRENT state. Gold = the newer id, `staleId` = the older id.
 *   - `old-relevant` : the gold is old (90-200 days) while several recent (0-14 days) memories of the same domain exist.
 *
 * Fictional only: no real person, company, product, address or phone number, no token-like literal. People appear by role.
 */
import { createHash } from 'node:crypto';
import type { Language } from './corpus';
import { sharedContentTerms, type MemoryItem, type MemoryQuery } from './memory-set';

export const MEMORY_V2_VERSION = 'chunk-eval-memory.v2';
/** Hand-written set: the label only names the authoring (there is no generator and no random draw). */
export const MEMORY_V2_SEED = 'quoky-adr-0124-ch8-memory-hand-written-2026-11-09';
/** The fixed retrieval time CH8's `daysAgo` values are relative to (equals stage R's RETRIEVAL_TIME; pinned by a test). */
export const MEMORY_V2_RETRIEVAL_TIME = '2026-11-06T00:00:00.000Z';

export type Ch8Category = 'paraphrase' | 'shared' | 'recency-wins' | 'old-relevant';
export const CH8_CATEGORIES: readonly Ch8Category[] = ['paraphrase', 'shared', 'recency-wins', 'old-relevant'];

export interface Ch8Memory extends MemoryItem {
  readonly daysAgo: number;
  readonly domain: string;
}
export interface Ch8Query extends MemoryQuery {
  readonly category: Ch8Category;
  /** recency-wins only: the older, contradicted memory the gold (newer) memory must outrank. */
  readonly staleId: string | null;
}
export interface Ch8Set {
  readonly memories: readonly Ch8Memory[];
  readonly queries: readonly Ch8Query[];
}

type Lang = Language;
type MemRow = readonly [id: string, language: Lang, daysAgo: number, text: string];
type QueryRow = readonly [language: Lang, category: 'paraphrase' | 'shared' | 'old-relevant', gold: string, text: string];

interface Domain {
  readonly name: string;
  readonly memories: readonly MemRow[];
  readonly queries: readonly QueryRow[];
}

// ---------------------------------------------------------------- the domains (hand-written)

const DOMAINS: readonly Domain[] = [
  {
    name: 'health',
    memories: [
      ['hl-o1', 'ko', 120, '작년 건강검진에서 콜레스테롤 수치가 조금 높게 나와서 의사 선생님이 기름진 음식을 줄이라고 했다.'],
      ['hl-o2', 'ko', 150, '무릎이 좋지 않아서 정형외과에서 소염제를 이 주일치 받았고, 계단 오르내리기는 피하라고 했다.'],
      ['hl-o3', 'ko', 95, '나는 꽃가루 알레르기가 있어서 봄마다 안약과 마스크를 챙겨 다닌다.'],
      ['hl-r1', 'ko', 3, '이번 주부터 아침 공복에 유산균을 하나씩 먹기 시작했다.'],
      ['hl-r2', 'ko', 8, '허리 통증 때문에 매주 목요일 저녁에 물리치료를 예약해 두었다.'],
      ['hl-r3', 'ko', 12, '요즘 잠이 얕아서 자기 전에 스마트폰을 거실 충전기에 두는 규칙을 만들었다.'],
      ['hl-r4', 'en', 5, 'I started taking a vitamin D supplement every morning after my last blood test.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'hl-o1', '건강검진 결과에서 의사가 내 피 속 기름 수치에 대해 뭐라고 했었지?'],
      ['ko', 'old-relevant', 'hl-o2', '무릎이 아파서 병원 갔을 때 무슨 약을 며칠치 받았더라?'],
      ['ko', 'old-relevant', 'hl-o3', '봄만 되면 눈이 가렵고 재채기 나는 건 무슨 알레르기 때문이었지?'],
      ['ko', 'paraphrase', 'hl-o1', '지난해 진단 받고 혈관 걱정돼서 식단 관련해 뭘 피하라는 조언이 있었지?'],
      ['mixed', 'paraphrase', 'hl-r1', '배 속 건강에 이로운 supplement를 처음 챙긴 게 언제였더라?'],
      ['ko', 'paraphrase', 'hl-r2', '등 아래쪽이 아파서 재활 받으러 가는 날이 언제였지?'],
      ['ko', 'paraphrase', 'hl-r3', '숙면을 방해하지 않으려고 휴대전화를 어디에 두기로 했지?'],
      ['en', 'paraphrase', 'hl-r4', 'What daily capsule did I begin following my latest lab work?'],
      ['ko', 'shared', 'hl-r2', '물리치료 예약을 무슨 요일 저녁에 잡아 뒀지?'],
      ['en', 'shared', 'hl-r4', 'Which supplement did I start taking after my last blood test?'],
      ['ko', 'shared', 'hl-o3', '꽃가루 알레르기 때문에 봄마다 챙겨야 할 게 뭐였지?'],
    ],
  },
  {
    name: 'food',
    memories: [
      ['fd-o1', 'ko', 130, '나는 고수와 오이를 못 먹어서 음식을 주문할 때마다 빼 달라고 말한다.'],
      ['fd-o2', 'ko', 175, '어머니가 담가 주신 김치는 너무 시어지기 전에 냉동실에 소분해서 보관한다.'],
      ['fd-o3', 'en', 100, "I'm allergic to shrimp, so I always ask whether a dish has shellfish."],
      ['fd-r1', 'ko', 2, '이번 주 저녁 메뉴는 월요일 된장찌개, 화요일 닭볶음탕, 수요일 비빔밥으로 정했다.'],
      ['fd-r2', 'ko', 6, '냉장고에 두부 두 모와 계란 열 개가 남아 있어서 이번 주에는 더 안 사도 된다.'],
      ['fd-r3', 'en', 4, "I'm meal prepping chicken and brown rice on Sundays to save money on takeout."],
      ['fd-r4', 'mixed', 9, '요즘 diet 중이라 저녁에는 탄수화물을 줄이고 protein 위주로 먹는다.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'fd-o1', '음식점에서 내가 꼭 빼 달라고 하는 재료가 뭐였지?'],
      ['ko', 'old-relevant', 'fd-o2', '엄마가 담가 준 김치는 어떻게 보관하기로 했더라?'],
      ['en', 'old-relevant', 'fd-o3', 'What kind of seafood should I stay away from at restaurants?'],
      ['ko', 'paraphrase', 'fd-o2', '모친이 직접 만든 발효 채소는 어떻게 오래 두기로 했더라?'],
      ['en', 'paraphrase', 'fd-o3', 'Which seafood should I never order?'],
      ['mixed', 'paraphrase', 'fd-r1', '향후 며칠 밥상에 올릴 dinner 반찬 순서가 뭐였더라?'],
      ['ko', 'paraphrase', 'fd-r2', '장 보러 가기 전에 집에 남은 식재료가 뭐뭐 있지?'],
      ['en', 'paraphrase', 'fd-r3', 'How do I keep my takeaway spending low during the week?'],
      ['mixed', 'paraphrase', 'fd-r4', 'weight 관리하려고 밤에 뭘 덜 먹고 있지?'],
      ['ko', 'shared', 'fd-r1', '수요일 저녁 메뉴가 뭐로 정해져 있지?'],
      ['en', 'shared', 'fd-r3', 'What do I prep on Sundays to save money?'],
      ['mixed', 'shared', 'fd-r4', 'diet 중이라 저녁에는 protein 위주라고 했던 이유가 뭐지?'],
    ],
  },
  {
    name: 'work',
    memories: [
      ['wk-o1', 'ko', 110, '분기 보고서는 매 분기 마지막 주 금요일까지 팀장님께 제출해야 한다.'],
      ['wk-o2', 'en', 160, "My team's shared drive password policy requires a change every ninety days."],
      ['wk-o3', 'mixed', 125, '재택근무 날에는 VPN을 켜야 사내 wiki에 접속된다.'],
      ['wk-r1', 'ko', 1, '내일 오전 열 시에 신규 프로젝트 킥오프 회의가 잡혀 있다.'],
      ['wk-r2', 'ko', 7, '옆자리 동료가 휴가 가 있는 동안 내가 주간 업무 공유 메일을 대신 보내기로 했다.'],
      ['wk-r3', 'en', 3, "I need to finish the vendor comparison slides before Thursday's review."],
      ['wk-r4', 'mixed', 10, '이번 sprint에서는 로그인 화면 bug 수정이 내 담당이다.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'wk-o1', '분기 보고서 제출 마감이 언제까지라고 했더라?'],
      ['en', 'old-relevant', 'wk-o2', 'How often am I forced to rotate my login secret at work?'],
      ['mixed', 'old-relevant', 'wk-o3', '재택하는 날 internal 문서 사이트에 접속하려면 뭘 켜야 하지?'],
      ['ko', 'paraphrase', 'wk-r1', '새 사업 첫 모임 시간이 언제였지?'],
      ['ko', 'paraphrase', 'wk-r2', '출근 안 하는 사람 몫으로 발송을 맡은 정례 소식이 뭐지?'],
      ['en', 'paraphrase', 'wk-r3', 'What presentation must be ready ahead of the mid-week assessment?'],
      ['en', 'paraphrase', 'wk-r3', 'Which deck do I owe my colleagues ahead of the midweek checkpoint?'],
      ['mixed', 'paraphrase', 'wk-r4', '현재 개발 주기 중에 내게 배정된 ticket이 뭐였지?'],
      ['ko', 'shared', 'wk-r1', '내일 킥오프 회의 몇 시에 시작이지?'],
      ['mixed', 'shared', 'wk-r3', 'Thursday review 때문에 어떤 slides를 마무리해야 해?'],
      ['ko', 'shared', 'wk-r2', '휴가 간 동료 대신 내가 보내기로 한 주간 업무 공유 메일이 뭐였지?'],
      ['mixed', 'shared', 'wk-r4', 'sprint에서 내 bug 담당이 뭐였지?'],
    ],
  },
  {
    name: 'home',
    memories: [
      ['hm-o1', 'ko', 140, '보일러는 겨울에 외출 모드로 해 두고, 연말 전에 점검을 한 번 받아야 한다.'],
      ['hm-o2', 'ko', 185, '현관 도어락 건전지는 일 년에 한 번 갈아 주기로 했고 여분은 서랍 안쪽에 있다.'],
      ['hm-o3', 'mixed', 110, '거실 전등이 깜빡거려서 LED 전구로 교체했고 남은 spare 전구는 신발장 위 서랍에 있다.'],
      ['hm-r1', 'ko', 2, '안방 에어컨 필터 청소를 이번 주말에 하기로 했다.'],
      ['hm-r2', 'ko', 7, '베란다 배수구가 막혀서 관리사무소에 수리를 요청해 놓았다.'],
      ['hm-r3', 'ko', 11, '다음 주 화요일 오전에 도시가스 점검 기사님이 방문한다.'],
      ['hm-r4', 'en', 6, "I'm planning to rearrange the living room so the desk faces the window."],
    ],
    queries: [
      ['ko', 'old-relevant', 'hm-o1', '겨울에 보일러 쓸 때 어떻게 해 두기로 했었지?'],
      ['ko', 'old-relevant', 'hm-o2', '도어락 전원은 얼마나 자주 새로 넣기로 했지?'],
      ['mixed', 'old-relevant', 'hm-o3', '깜빡이던 불 고친 뒤에 남은 spare 부품은 어디 있더라?'],
      ['ko', 'paraphrase', 'hm-o2', '출입문 자동 잠금장치의 전력원을 얼마 간격으로 바꿔 넣으려 했었지?'],
      ['ko', 'paraphrase', 'hm-r1', '냉방기 먼지 거름망 손질은 언제로 정했지?'],
      ['mixed', 'paraphrase', 'hm-r2', '물이 안 내려가는 drain 문제는 누구에게 부탁했지?'],
      ['ko', 'paraphrase', 'hm-r3', '연료 설비 안전 확인하러 사람이 오는 때가 언제야?'],
      ['en', 'paraphrase', 'hm-r4', 'How am I going to reposition the furniture so my workspace has daylight?'],
      ['ko', 'shared', 'hm-r1', '안방 에어컨 필터 청소는 언제 하기로 했지?'],
      ['en', 'shared', 'hm-r4', 'Where is the desk going in the living room?'],
    ],
  },
  {
    name: 'travel',
    memories: [
      ['tr-o1', 'ko', 165, '제주도 여행 때 묵었던 숙소는 바다가 보이는 작은 게스트하우스였고 조식이 맛있었다.'],
      ['tr-o2', 'ko', 130, '해외여행 갈 때는 항상 통로 쪽 좌석을 고르고 기내용 가방 하나만 챙긴다.'],
      ['tr-o3', 'en', 195, 'My passport expires in March next year, so I must renew it before booking long trips.'],
      ['tr-r1', 'ko', 4, '다음 달 둘째 주 금요일에 부산행 기차표를 예매해 두었다.'],
      ['tr-r2', 'ko', 13, '연말에 부모님과 온천 여행을 가기로 해서 숙소 후보를 세 군데 골라 놓았다.'],
      ['tr-r3', 'en', 2, 'I booked a window seat for the Friday morning flight to visit my cousin.'],
      ['tr-r4', 'mixed', 9, '이번 휴가에는 camping 장비를 빌려서 강원도 계곡으로 갈 계획이다.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'tr-o1', '제주도 갔을 때 묵었던 숙소가 어땠었지?'],
      ['ko', 'old-relevant', 'tr-o2', '비행기 탈 때 내가 늘 고르는 자리랑 짐은 어떻게 챙긴다고 했지?'],
      ['en', 'old-relevant', 'tr-o3', 'When do I have to get my travel document renewed?'],
      ['ko', 'paraphrase', 'tr-o1', '섬에서 머문 곳 풍경이랑 아침밥 평은 어땠지?'],
      ['ko', 'paraphrase', 'tr-o2', '비행기에서 선호하는 자리랑 짐 크기는 어떻게 한다고 했지?'],
      ['en', 'paraphrase', 'tr-o3', 'Why should I handle my identity booklet soon, ahead of planning distant journeys?'],
      ['mixed', 'paraphrase', 'tr-r1', '남쪽 항구 도시로 가는 train 예약은 언제 날짜였지?'],
      ['ko', 'paraphrase', 'tr-r2', '해가 바뀌기 전에 어른들 모시고 떠나는 휴양 계획은 어디까지 진행됐지?'],
      ['en', 'paraphrase', 'tr-r3', 'Where will I sit on the early plane to see my relative?'],
      ['mixed', 'paraphrase', 'tr-r4', '다음 쉬는 기간에 outdoor 숙박은 어디로 가기로 했지?'],
      ['ko', 'shared', 'tr-r1', '부산행 기차표는 언제로 예매해 놨지?'],
      ['ko', 'shared', 'tr-r2', '온천 여행 숙소 후보 몇 군데 골랐지?'],
      ['en', 'shared', 'tr-r3', 'Which window seat did I book for the Friday flight?'],
      ['mixed', 'shared', 'tr-r4', 'camping 장비는 빌려서 어디로 간다고 했지?'],
    ],
  },
  {
    name: 'purchases',
    memories: [
      ['pc-o1', 'ko', 105, '작년에 산 로봇청소기는 보증 기간이 일 년이라 영수증을 서랍에 보관해 두었다.'],
      ['pc-o2', 'mixed', 145, '겨울 coat는 사이즈가 커서 교환을 신청했고, 교환 기한은 구매 후 삼십 일이었다.'],
      ['pc-o3', 'en', 175, 'I bought noise-cancelling headphones last spring and the warranty card is in my desk drawer.'],
      ['pc-r1', 'ko', 3, '새 운동화를 주문했고 배송은 모레 도착 예정이다.'],
      ['pc-r2', 'ko', 7, '전기밥솥이 고장 나서 사십 만 원 이하로 새로 사기로 했다.'],
      ['pc-r3', 'ko', 12, '친구 생일 선물로 보온 텀블러를 고르고 포장까지 맡겼다.'],
      ['pc-r4', 'en', 1, "I'm comparing two standing desks and leaning toward the cheaper one with a wider top."],
    ],
    queries: [
      ['ko', 'old-relevant', 'pc-o1', '청소기 보증서랑 영수증은 어디에 두었지?'],
      ['mixed', 'old-relevant', 'pc-o2', '겨울 coat 바꾸려고 한 이유랑 교환 마감이 뭐였지?'],
      ['en', 'old-relevant', 'pc-o3', 'Where did I put the warranty card for my headphones?'],
      ['ko', 'paraphrase', 'pc-o1', '큰 기기 고장 대비해서 구매 증빙은 어디 넣어 놨지?'],
      ['mixed', 'paraphrase', 'pc-o2', '큰 outerwear를 바꾸려 한 이유랑 마감이 뭐였지?'],
      ['ko', 'paraphrase', 'pc-r1', '신발은 언제쯤 집에 오지?'],
      ['mixed', 'paraphrase', 'pc-r2', '쌀 짓는 appliance가 망가져서 예산을 얼마로 잡았지?'],
      ['ko', 'paraphrase', 'pc-r3', '지인 기념일 답례품으로 뭘 골랐더라?'],
      ['en', 'paraphrase', 'pc-r4', 'Which adjustable workstation am I favoring, the pricier or the roomier one?'],
      ['ko', 'shared', 'pc-r1', '새 운동화는 언제 도착해?'],
      ['ko', 'shared', 'pc-r2', '전기밥솥을 새로 사려는 예산이 얼마였지?'],
      ['en', 'shared', 'pc-r4', 'Which standing desk am I leaning toward?'],
    ],
  },
  {
    name: 'people',
    memories: [
      ['fm-o1', 'ko', 160, '어머니 생신은 시월 둘째 주 일요일이라 매년 가족이 같이 저녁을 먹는다.'],
      ['fm-o2', 'ko', 115, '아버지는 무릎 수술 이후 계단을 힘들어해서 항상 엘리베이터가 있는 식당을 고른다.'],
      ['fm-o3', 'mixed', 190, '옆집 이웃은 alarm이 울리면 전화해 주기로 했고 열쇠도 맡겨 두었다.'],
      ['fm-r1', 'ko', 5, '친구 결혼식이 다음 달 셋째 토요일 오후 두 시에 있어서 축의금을 준비해야 한다.'],
      ['fm-r2', 'ko', 10, '후배가 다음 주에 승진해서 축하 점심을 사 주기로 했다.'],
      ['fm-r3', 'en', 8, 'My roommate from college is visiting next weekend, so I need to clean the guest room.'],
      ['fm-r4', 'mixed', 2, '사촌 동생이 졸업 선물로 wireless 이어폰을 갖고 싶다고 했다.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'fm-o1', '엄마 생신이 언제고 매년 뭘 하지?'],
      ['ko', 'old-relevant', 'fm-o2', '아빠랑 같이 밥 먹을 때 식당을 어떻게 골라야 하지?'],
      ['mixed', 'old-relevant', 'fm-o3', '옆집 사람이 alarm 울릴 때 대신 해 주기로 한 게 뭐였지?'],
      ['ko', 'paraphrase', 'fm-o2', '부친이랑 외식할 때 가게를 어떤 조건으로 정해야 하지?'],
      ['ko', 'paraphrase', 'fm-r1', '동창 혼례식 날짜랑 시간이 언제였지?'],
      ['ko', 'paraphrase', 'fm-r2', '아랫사람 직급 오른 걸 기념하며 어떤 대접을 하려고 했지?'],
      ['en', 'paraphrase', 'fm-r3', 'What should I tidy before my old school friend stays over?'],
      ['en', 'paraphrase', 'fm-r3', 'Who is coming to stay, and what chore must I do first?'],
      ['mixed', 'paraphrase', 'fm-r4', '어린 친척이 학위 받은 기념으로 뭘 원했더라, gift 고르려고?'],
      ['ko', 'shared', 'fm-r1', '친구 결혼식이 언제고 뭘 준비해야 하지?'],
      ['ko', 'shared', 'fm-r2', '후배가 승진해서 내가 뭘 사 주기로 했지?'],
      ['en', 'shared', 'fm-r3', 'When is my roommate visiting?'],
      ['mixed', 'shared', 'fm-r4', '사촌 동생 졸업 선물로 wireless 뭐 사 주면 되지?'],
    ],
  },
  {
    name: 'hobby',
    memories: [
      ['hb-o1', 'ko', 170, '독서 모임에서는 한 달에 한 권씩 읽고, 발제는 돌아가며 맡는다.'],
      ['hb-o2', 'ko', 125, '사진 찍는 걸 좋아해서 주말마다 필름 카메라를 들고 골목을 걷는다.'],
      ['hb-o3', 'mixed', 150, '뜨개질은 beginner 수준이라 목도리부터 만들고 있고 털실은 베이지색으로 골랐다.'],
      ['hb-r1', 'ko', 6, '다음 주 토요일에 도자기 공방 원데이 클래스를 신청해 두었다.'],
      ['hb-r2', 'ko', 13, '요즘 출퇴근길에 역사 팟캐스트를 들으며 오래된 사건들을 공부하고 있다.'],
      ['hb-r3', 'en', 4, "I'm training for a ten-kilometer race in December and run three times a week."],
      ['hb-r4', 'mixed', 1, '새로 시작한 podcast 제작 취미 때문에 마이크 사는 걸 고민하고 있다.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'hb-o1', '독서 모임에서 책은 얼마나 자주 읽고 발제는 누가 해?'],
      ['ko', 'old-relevant', 'hb-o2', '주말마다 골목 걸을 때 뭘 들고 다닌다고 했지?'],
      ['mixed', 'old-relevant', 'hb-o3', '뜨개 첫 작품이 뭐고 실 색깔은 뭘로 골랐지, beginner라서?'],
      ['ko', 'paraphrase', 'hb-o2', '쉬는 날에는 오래된 촬영 기기로 동네를 돌아다니는 취미가 뭐였지?'],
      ['mixed', 'paraphrase', 'hb-r1', '흙으로 그릇 빚는 workshop은 언제로 잡아 놨지?'],
      ['ko', 'paraphrase', 'hb-r2', '이동하는 시간에 옛날 이야기 방송 듣는다고 했던 게 뭐였지?'],
      ['en', 'paraphrase', 'hb-r3', 'What big event am I preparing for with my jogging?'],
      ['mixed', 'paraphrase', 'hb-r4', '음성 콘텐츠 만드는 데 쓸 장비를 알아보던 게 뭐였지, gear 말야?'],
      ['ko', 'shared', 'hb-r1', '도자기 공방 원데이 클래스는 언제로 신청해 뒀지?'],
      ['ko', 'shared', 'hb-r2', '역사 팟캐스트는 언제 들으면서 공부한다고 했지?'],
      ['en', 'shared', 'hb-r3', 'How many times a week do I run for the December race?'],
      ['mixed', 'shared', 'hb-r4', 'podcast 제작하려고 마이크 알아보는 중이었지?'],
    ],
  },
  {
    name: 'finance',
    memories: [
      ['fn-o1', 'ko', 135, '관리비는 매달 이십오 일에 자동이체되고 한 달 평균 십이만 원이 나온다.'],
      ['fn-o2', 'en', 155, 'My emergency fund target is three months of expenses, kept in a separate savings account.'],
      ['fn-o3', 'mixed', 100, '연말정산 때 medical receipt는 병원별로 모아서 pdf로 스캔해 둔다.'],
      ['fn-r1', 'ko', 3, '이번 달 카드값이 평소보다 많이 나와서 외식 예산을 줄이기로 했다.'],
      ['fn-r2', 'ko', 9, '적금 만기가 다음 달 십오 일이라 새 상품을 알아봐야 한다.'],
      ['fn-r3', 'ko', 14, '전기요금 고지서가 도착했는데 지난달보다 이만 원쯤 올랐다.'],
      ['fn-r4', 'mixed', 5, '친구에게 빌린 오만 원은 이번 금요일까지 transfer 하기로 했다.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'fn-o1', '관리비는 언제 빠져나가고 보통 얼마나 나오지?'],
      ['en', 'old-relevant', 'fn-o2', 'How many months of living costs should my rainy-day savings cover?'],
      ['mixed', 'old-relevant', 'fn-o3', '연말정산 때 진료비 서류는 어떻게 모아 두기로 했지, scan해서?'],
      ['mixed', 'paraphrase', 'fn-o3', '세금 환급 준비용 진료 증빙은 어떻게 갈무리했지, 파일로?'],
      ['ko', 'paraphrase', 'fn-r1', '지출이 늘어난 달에는 어떤 항목부터 아끼려고 했지?'],
      ['ko', 'paraphrase', 'fn-r2', '저금해 둔 게 끝나는 날짜가 언제라서 뭘 새로 골라야 하지?'],
      ['ko', 'paraphrase', 'fn-r3', '불 켜는 데 드는 청구 금액이 얼마나 늘었더라?'],
      ['mixed', 'paraphrase', 'fn-r4', '동료한테 받은 돈 갚는 날이 언제였지, 계좌로 send 해야 해?'],
      ['ko', 'shared', 'fn-r1', '이번 달 카드값 때문에 외식 예산을 어떻게 하기로 했지?'],
      ['ko', 'shared', 'fn-r3', '전기요금 고지서 지난달보다 얼마나 올랐지?'],
      ['mixed', 'shared', 'fn-r4', '친구한테 빌린 돈 이번 금요일까지 transfer 해야 하는 금액이 얼마지?'],
    ],
  },
  {
    name: 'commute',
    memories: [
      ['cm-o1', 'ko', 180, '퇴근 후에는 지하철 이호선보다 버스가 덜 붐벼서 종점 근처 정류장에서 탄다.'],
      ['cm-o2', 'mixed', 120, '차는 보험 갱신일이 이월이라 renewal 안내가 오면 비교 견적을 받아 본다.'],
      ['cm-o3', 'en', 140, 'My bike lock key is hidden in the small pocket of my backpack.'],
      ['cm-r1', 'ko', 4, '이번 주 목요일에 자동차 정기 검사를 받으러 센터에 가야 한다.'],
      ['cm-r2', 'ko', 8, '회사 주차장은 월말까지만 쓸 수 있어서 다음 달부터는 공영주차장을 알아봐야 한다.'],
      ['cm-r3', 'ko', 12, '교통카드 잔액이 오천 원 이하로 떨어지면 편의점에서 충전한다.'],
      ['cm-r4', 'en', 0, 'There is road work near my office this week, so I leave fifteen minutes earlier.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'cm-o1', '퇴근길에 지하철 말고 어디서 뭘 타는 게 덜 붐비더라?'],
      ['mixed', 'old-relevant', 'cm-o2', '자동차 보험은 언제 갱신되고 안내 오면 뭘 하기로 했지, renewal 때?'],
      ['en', 'old-relevant', 'cm-o3', 'Where did I hide the key to my cycle lock?'],
      ['ko', 'paraphrase', 'cm-r1', '차량 법정 점검 일정이 언제였지?'],
      ['ko', 'paraphrase', 'cm-r2', '일터 차 세우는 곳 기한이 언제 끝나고 그 뒤엔 어떻게 하지?'],
      ['ko', 'paraphrase', 'cm-r3', '버스랑 지하철 탈 때 쓰는 선불 수단에 돈이 모자라면 어디서 채워 넣지?'],
      ['en', 'paraphrase', 'cm-r4', 'Why am I heading out a bit sooner than usual lately?'],
      ['en', 'paraphrase', 'cm-r4', "What's making my morning travel start sooner at the moment?"],
      ['ko', 'shared', 'cm-r1', '목요일에 자동차 정기 검사 받으러 가야 하는 곳이 어디지?'],
      ['ko', 'shared', 'cm-r2', '회사 주차장 쓸 수 있는 기한이 언제까지지?'],
      ['en', 'shared', 'cm-r4', 'How much earlier do I leave because of the road work?'],
    ],
  },
  {
    name: 'pets-plants',
    memories: [
      ['pt-o1', 'ko', 190, '고양이 화장실 모래는 두 주에 한 번 전부 갈아 주고 매일 아침 삽으로 치운다.'],
      ['pt-o2', 'ko', 110, '몬스테라 화분은 햇빛이 드는 창가에 두고 물은 일주일에 한 번만 준다.'],
      ['pt-r1', 'ko', 1, '강아지 심장사상충 약을 이번 주 일요일에 먹여야 한다.'],
      ['pt-r2', 'ko', 10, '베란다 허브 화분에 진딧물이 생겨서 식초 희석액을 뿌려 보기로 했다.'],
      ['pt-r3', 'en', 6, "The vet said my dog should lose two kilograms, so I'm cutting his treats."],
      ['pt-r4', 'mixed', 3, 'balcony 화분 분갈이는 날씨가 풀리는 다음 주말에 하려고 한다.'],
    ],
    queries: [
      ['ko', 'old-relevant', 'pt-o1', '고양이 모래는 얼마나 자주 전부 갈아 주지?'],
      ['ko', 'old-relevant', 'pt-o2', '화분에 물은 얼마나 자주 주고 어디 두기로 했지?'],
      ['ko', 'paraphrase', 'pt-r1', '반려견 기생충 예방약 먹이는 날이 언제였지?'],
      ['ko', 'paraphrase', 'pt-r2', '집 바깥쪽 향신 식물에 벌레가 꼬여서 어떻게 대응하려고 했지?'],
      ['en', 'paraphrase', 'pt-r3', 'Why am I giving my pet fewer snacks lately?'],
      ['en', 'paraphrase', 'pt-r3', 'What did the animal doctor tell me about my dog’s weight?'],
      ['mixed', 'paraphrase', 'pt-r4', '발코니 식물 옮겨 심는 건 언제로 잡았지, gardening 때문에?'],
      ['ko', 'shared', 'pt-r2', '베란다 허브 화분 진딧물에 뭘 뿌려 보기로 했지?'],
      ['en', 'shared', 'pt-r3', 'How many kilograms does my dog need to lose?'],
      ['mixed', 'shared', 'pt-r4', 'balcony 화분 분갈이는 언제 하려고 했지?'],
    ],
  },
];

// ---------------------------------------------------------------- recency pairs (hand-written): older memory, newer contradicting memory, the query

interface PairRow {
  readonly id: string;
  readonly language: Lang;
  readonly domain: string;
  readonly oldDays: number;
  readonly oldText: string;
  readonly newDays: number;
  readonly newText: string;
  readonly query: string;
}

const PAIRS: readonly PairRow[] = [
  { id: 'p01', language: 'ko', domain: 'health', oldDays: 150, oldText: '예전엔 집 앞 헬스장에서 저녁마다 웨이트 운동을 했다.', newDays: 6, newText: '요즘은 헬스장은 그만두고 회사 근처 수영장에서 점심시간에 수영한다.', query: '요즘 점심시간에 어떤 운동을 해?' },
  { id: 'p02', language: 'ko', domain: 'food', oldDays: 130, oldText: '아침마다 출근길에 아메리카노를 두 잔씩 마시는 게 습관이었다.', newDays: 10, newText: '요즘은 카페인을 줄이려고 아침에 보리차나 따뜻한 녹차를 마신다.', query: '요즘 아침에 뭘 마시고 있지?' },
  { id: 'p03', language: 'ko', domain: 'commute', oldDays: 100, oldText: '출근할 때는 집 앞 정류장에서 버스를 타고 사십 분쯤 걸린다.', newDays: 4, newText: '지난달부터 자전거로 출근하는데 이십오 분이면 도착한다.', query: '지금 출근은 어떻게 해?' },
  { id: 'p04', language: 'ko', domain: 'work', oldDays: 90, oldText: '팀장님과의 일대일 면담은 매주 월요일 오후에 있다.', newDays: 9, newText: '팀장님이 일정을 바꿔서 이제 일대일 면담은 수요일 오전이다.', query: '팀장님이랑 면담이 요즘 무슨 요일이야?' },
  { id: 'p05', language: 'ko', domain: 'home', oldDays: 170, oldText: '예전에 살던 동네에서는 걸어서 오 분 거리의 작은 마트를 자주 갔다.', newDays: 15, newText: '새로 이사 온 동네에서는 아파트 단지 앞 대형 마트에서 장을 본다.', query: '지금 장은 어디서 봐?' },
  { id: 'p06', language: 'ko', domain: 'people', oldDays: 140, oldText: '동생은 작은 광고 회사에서 디자이너로 일하고 있다.', newDays: 12, newText: '동생이 최근에 이직해서 지금은 게임 회사에서 일한다.', query: '동생은 요즘 어디서 일해?' },
  { id: 'p07', language: 'ko', domain: 'finance', oldDays: 110, oldText: '휴대폰 요금제는 한 달에 오만 원짜리 무제한 요금제를 쓴다.', newDays: 7, newText: '휴대폰 요금제를 바꿔서 이제 한 달 삼만 원짜리 중간 요금제를 쓴다.', query: '지금 내 통신 요금이 얼마지?' },
  { id: 'p08', language: 'ko', domain: 'food', oldDays: 120, oldText: '아침 식사는 식빵에 잼을 발라서 간단히 먹는다.', newDays: 3, newText: '요즘 아침에는 오트밀에 바나나를 썰어 넣어 먹는다.', query: '요즘 아침 식사 뭐 먹어?' },
  { id: 'p09', language: 'ko', domain: 'health', oldDays: 160, oldText: '평일에는 밤 열두 시가 넘어서야 잠자리에 든다.', newDays: 14, newText: '요즘은 열한 시 전에 불을 끄고 자려고 노력 중이다.', query: '요즘 몇 시에 자?' },
  { id: 'p10', language: 'ko', domain: 'hobby', oldDays: 180, oldText: '주말에는 친구들과 근처 산으로 등산을 가는 게 낙이었다.', newDays: 5, newText: '요즘 주말에는 집에서 보드게임을 하거나 영화를 보며 쉰다.', query: '요즘 주말에 집에서 어떻게 쉬어?' },
  { id: 'p11', language: 'ko', domain: 'food', oldDays: 75, oldText: '점심은 매일 집에서 싸 온 도시락을 먹는다.', newDays: 2, newText: '도시락 싸는 게 귀찮아서 요즘은 구내식당에서 점심을 해결한다.', query: '요즘 점심은 어떻게 해결해?' },
  { id: 'p12', language: 'ko', domain: 'health', oldDays: 135, oldText: '치과는 집 근처 사거리에 있는 치과로 다녔다.', newDays: 11, newText: '치과를 옮겨서 이제는 회사 건물 이층에 있는 치과에 다닌다.', query: '지금 다니는 치과가 어디야?' },
  { id: 'p13', language: 'ko', domain: 'pets-plants', oldDays: 95, oldText: '강아지에게는 닭고기가 들어간 사료를 주고 있다.', newDays: 8, newText: '강아지가 닭고기에 알레르기 반응을 보여서 연어 사료로 바꿨다.', query: '지금 강아지한테 어떤 사료를 먹이고 있지?' },
  { id: 'pe1', language: 'en', domain: 'home', oldDays: 85, oldText: 'My landlord collects the rent on the first of every month.', newDays: 10, newText: 'My landlord moved the rent due date to the fifteenth starting this month.', query: 'When does my landlord want the rent these days?' },
  { id: 'pe2', language: 'en', domain: 'hobby', oldDays: 125, oldText: 'I return my library books on Saturdays.', newDays: 4, newText: 'The library changed its hours, so I now return my books on Tuesday evenings.', query: 'When do I return my library books these days?' },
  { id: 'pe3', language: 'en', domain: 'work', oldDays: 105, oldText: 'My manager likes to get project updates by email on Fridays.', newDays: 13, newText: 'My manager asked for a quick call every Monday morning instead of emails.', query: 'How does my manager want updates currently?' },
  { id: 'pe4', language: 'en', domain: 'hobby', oldDays: 165, oldText: 'I am learning to play the acoustic guitar on weekends.', newDays: 9, newText: 'I gave up guitar last month and started piano lessons on Saturdays.', query: 'What instrument am I practicing these days?' },
  { id: 'pm1', language: 'mixed', domain: 'work', oldDays: 100, oldText: '팀 standup 미팅은 매일 오전 9시에 시작한다.', newDays: 6, newText: '이제 standup 미팅은 오전 10시 30분으로 늦춰졌다.', query: 'standup이 지금 몇 시에 시작하지?' },
  { id: 'pm2', language: 'mixed', domain: 'health', oldDays: 170, oldText: '요가는 집 근처 24시간 yoga studio에서 한다.', newDays: 12, newText: '요즘은 회사 앞 yoga studio로 옮겨서 퇴근 후에 간다.', query: '요즘 어느 yoga 스튜디오 다녀?' },
  { id: 'pm3', language: 'mixed', domain: 'finance', oldDays: 140, oldText: 'music app은 유료 premium 플랜으로 구독 중이다.', newDays: 5, newText: 'music app 구독을 해지하고 다시 무료 플랜으로 돌아왔다.', query: '지금 music app은 어떤 플랜이야?' },
  { id: 'pm4', language: 'mixed', domain: 'food', oldDays: 155, oldText: '단골 카페는 역 앞에 있는 작은 coffee shop이다.', newDays: 14, newText: '요즘은 사무실 1층에 새로 생긴 coffee shop을 자주 간다.', query: '요즘 자주 가는 coffee shop이 어디지?' },
  { id: 'pm5', language: 'mixed', domain: 'food', oldDays: 80, oldText: '간식은 보통 사무실 vending machine에서 과자를 사 먹는다.', newDays: 1, newText: '요즘은 간식으로 집에서 싸 온 fruit를 자리에서 먹는다.', query: '요즘 snack은 어떻게 해?' },
];

// ---------------------------------------------------------------- assembly

const memoryOf = (id: string, language: Lang, domain: string, daysAgo: number, text: string): Ch8Memory => ({ id: `m-${id}`, language, text, long: false, factOffsets: [0], daysAgo, domain });

/** The CH8 set, assembled from the hand-written tables above (no random draw anywhere). */
export function loadMemorySetV2(): Ch8Set {
  const memories: Ch8Memory[] = [];
  for (const domain of DOMAINS) for (const [id, language, daysAgo, text] of domain.memories) memories.push(memoryOf(id, language, domain.name, daysAgo, text));
  for (const pair of PAIRS) {
    memories.push(memoryOf(`${pair.id}-old`, pair.language, pair.domain, pair.oldDays, pair.oldText));
    memories.push(memoryOf(`${pair.id}-new`, pair.language, pair.domain, pair.newDays, pair.newText));
  }
  const textOf = new Map(memories.map((memory) => [memory.id, memory.text]));
  const queries: Ch8Query[] = [];
  const add = (language: Lang, category: Ch8Category, gold: string, text: string, staleId: string | null): void => {
    const sharedTerms = sharedContentTerms(text, textOf.get(gold) as string);
    queries.push({ id: `q8-${String(queries.length + 1).padStart(3, '0')}`, language, text, gold: [gold], mode: sharedTerms > 0 ? 'shared' : 'paraphrase', sharedTerms, targetLong: false, factIndex: null, beyondCut: false, category, staleId });
  };
  for (const domain of DOMAINS) for (const [language, category, gold, text] of domain.queries) add(language, category, `m-${gold}`, text, null);
  for (const pair of PAIRS) add(pair.language, 'recency-wins', `m-${pair.id}-new`, pair.query, `m-${pair.id}-old`);
  return { memories, queries };
}

// ---------------------------------------------------------------- digest

const memoryDigestOf = (item: Ch8Memory): string => createHash('sha256').update(JSON.stringify([item.id, item.language, item.text, item.daysAgo, item.domain])).digest('hex');
const queryDigestOf = (item: Ch8Query): string => createHash('sha256').update(JSON.stringify([item.id, item.language, item.text, item.gold, item.category, item.staleId, item.sharedTerms])).digest('hex');

/** sha256 over the version, the seed label, the counts and every memory and query digest, in order. Changes with any byte. */
export function memoryDigestV2(set: Ch8Set): string {
  const hash = createHash('sha256');
  hash.update(`${MEMORY_V2_VERSION}\n${MEMORY_V2_SEED}\n${set.memories.length}\n${set.queries.length}\n`);
  for (const item of set.memories) hash.update(`${memoryDigestOf(item)}\n`);
  for (const item of set.queries) hash.update(`${queryDigestOf(item)}\n`);
  return hash.digest('hex');
}

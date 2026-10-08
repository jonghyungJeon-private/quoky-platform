import { describe, expect, it } from 'vitest';
import {
  OWN_MEMORY_SEMANTIC_HIT_FLOOR,
  detectOwnMemoryRecallQuestion,
  hasOwnMemoryRecallHit,
  renderOwnMemoryNotFound,
  type OwnMemoryRecallContext,
} from './own-memory-recall';

const EMPTY: OwnMemoryRecallContext = { conversationTranscript: [] };
const durable = (...contents: string[]): OwnMemoryRecallContext => ({
  conversationTranscript: [],
  durableRecall: contents.map((content) => ({ content })),
});
const userTurn = (content: string) => ({ content, role: 'user' as const, provenance: 'USER' });
const assistantTurn = (content: string) => ({ content, role: 'assistant' as const, provenance: 'ASSISTANT' });

describe('detectOwnMemoryRecallQuestion (W3-L01)', () => {
  it.each([
    ['내가 좋아하는 과일이 뭐였지?', 'ko', ['과일'], 'like'],
    ['내가 제일 좋아하는 과일이 뭐였더라', 'ko', ['과일'], 'like'],
    ['내가 좋아하는 과일이 뭐야?', 'ko', ['과일'], 'like'],
    ['혹시 내가 싫어하는 음식이 뭐였지?', 'ko', ['음식'], 'dislike'],
    ['내가 말한 고양이 이름 기억나?', 'ko', ['고양이', '이름'], undefined],
    ['내가 알려준 강아지 이름이 뭐였죠?', 'ko', ['강아지', '이름'], undefined],
    ['내 고양이 이름이 뭐라고 했지?', 'ko', ['고양이', '이름'], undefined],
    ['내 생일이 언제였지?', 'ko', ['생일'], undefined],
    ['제 생일 기억하세요?', 'ko', ['생일'], undefined],
    ['내가 고양이 이름을 뭐라고 했더라?', 'ko', ['고양이', '이름'], undefined],
    ['what did I say my favourite fruit was?', 'en', ['fruit'], 'like'],
    ['What did I tell you my dog\'s name is?', 'en', ['dog', 'name'], undefined],
    ['do you remember my favorite color?', 'en', ['color'], 'like'],
    ["what's my favourite fruit again?", 'en', ['fruit'], 'like'],
    ['what was the city I told you about?', 'en', ['city'], undefined],
    // live UAT phrasing (intent-routing intent-021 keeps classifying it as GENERAL_CHAT)
    ['내 UAT 확인 단어가 뭐였지?', 'ko', ['uat', '확인', '단어'], undefined],
  ] as const)('%s → own-memory question', (text, language, topics, relation) => {
    const question = detectOwnMemoryRecallQuestion(text);
    expect(question, text).not.toBeNull();
    expect(question?.language).toBe(language);
    expect(question?.topics).toEqual(topics);
    expect(question?.relation).toBe(relation);
  });

  it.each([
    // general knowledge / ordinary chat
    '사과의 효능이 뭐야?',
    '과일 추천해줘',
    '오늘 점심 뭐 먹을까?',
    '안녕',
    'what are the benefits of apples?',
    'tell me about my cat Nabi',
    // the assistant itself
    '너가 좋아하는 과일이 뭐야?',
    '네가 좋아하는 음식은 뭐였지?',
    '내가 너한테 뭐라고 했지?',
    'what is your favourite fruit?',
    // conversation continuity (the transcript / Stage 2B recency path), not a stored personal fact
    '내가 방금 뭐라고 했지?',
    '아까 내가 뭐라고 했어?',
    '방금 내가 좋아한다고 말한 음식이 뭐였지?',
    '내가 방금 말한 음식이 뭐였지?',
    '방금 한 말 기억나?',
    '이거 뭐였지?',
    'what did I just say?',
    // too generic: no concrete topic
    '내가 말한 거 뭐였지?',
    '내가 뭐라고 했지?',
    // schedules (QUAL-7 path), to-dos, reminders, code work
    '내 일정이 뭐였지?',
    '내가 말한 회의 언제였지?',
    '내 할 일이 뭐였지?',
    '내가 말한 알림 뭐였지?',
    '내가 말한 브랜치 이름이 뭐였지?',
    'what did I say my meeting time was?',
    // memory management and credentials
    '내가 저장한 기억이 뭐였지?',
    '내 비밀번호가 뭐였지?',
    'what did I say my password was?',
    // ambiguous with the imperative "remember" (route-150 stays chat)
    '내 생일 기억해?',
    '내 생일 기억해',
    // present tense without a preference / told clause
    '내 이름이 뭐야?',
    // requests and statements
    '내가 좋아하는 과일 추천해줘',
    '나는 귤을 좋아해',
    '기억해: 내가 좋아하는 과일은 귤',
    // memory commands
    '기억 목록',
    '기억했어?',
  ])('%s → not captured', (text) => {
    expect(detectOwnMemoryRecallQuestion(text)).toBeNull();
  });

  it('rejects multi-line and over-long messages', () => {
    expect(detectOwnMemoryRecallQuestion('내가 좋아하는 과일이 뭐였지?\n그리고 오늘 날씨는?')).toBeNull();
    expect(detectOwnMemoryRecallQuestion(`내가 좋아하는 ${'과일 '.repeat(30)}뭐였지?`)).toBeNull();
  });
});

describe('hasOwnMemoryRecallHit', () => {
  const fruit = detectOwnMemoryRecallQuestion('내가 좋아하는 과일이 뭐였지?')!;
  const cat = detectOwnMemoryRecallQuestion('내 고양이 이름이 뭐라고 했지?')!;

  it('no durable recall and no earlier User turn → no hit', () => {
    expect(hasOwnMemoryRecallHit(fruit, EMPTY)).toBe(false);
  });

  it('a durable entry sharing a topic stem is a hit', () => {
    expect(hasOwnMemoryRecallHit(fruit, durable('좋아하는 과일은 귤'))).toBe(true);
    expect(hasOwnMemoryRecallHit(cat, durable('우리 고양이는 나비야'))).toBe(true);
  });

  it('a stated preference about something else is no durable evidence (live QA D5: recall returns every memory)', () => {
    expect(hasOwnMemoryRecallHit(fruit, durable('나는 귤을 좋아해'))).toBe(false);
  });

  it('being recalled is no evidence: a durable entry with no shared topic word is no hit (live QA D5, session 4)', () => {
    // Lexical and semantic recall both rank every eligible memory and never drop one, so "it was recalled" says
    // nothing. The Codex P2 paraphrase ("나는 철수야" for "내 이름이 뭐였지?") now needs a very high semantic score.
    const name = detectOwnMemoryRecallQuestion('내 이름이 뭐였지?')!;
    expect(hasOwnMemoryRecallHit(name, durable('나는 철수야'))).toBe(false);
    expect(hasOwnMemoryRecallHit(fruit, durable('커피는 아메리카노', '주간 회의는 화요일'))).toBe(false);
    expect(hasOwnMemoryRecallHit(cat, durable('커피는 아메리카노'))).toBe(false);
    expect(hasOwnMemoryRecallHit(cat, { conversationTranscript: [], durableRecall: [] })).toBe(false);
  });

  it('an unrelated earlier User turn is not a hit', () => {
    expect(hasOwnMemoryRecallHit(cat, { conversationTranscript: [userTurn('커피는 아메리카노')] })).toBe(false);
  });

  it("the User's own earlier turn in this conversation is a hit; assistant turns and repeated questions are not", () => {
    expect(hasOwnMemoryRecallHit(cat, { conversationTranscript: [userTurn('우리 고양이 이름은 나비야')] })).toBe(true);
    expect(hasOwnMemoryRecallHit(cat, { conversationTranscript: [assistantTurn('고양이 이름은 나비였어요')] })).toBe(false);
    expect(
      hasOwnMemoryRecallHit(cat, { conversationTranscript: [userTurn('내 고양이 이름이 뭐라고 했지?')] }),
    ).toBe(false);
    // A legacy entry without a role counts by provenance.
    expect(hasOwnMemoryRecallHit(cat, { conversationTranscript: [{ content: '고양이는 나비', provenance: 'USER' }] })).toBe(
      true,
    );
  });

  it('English topics match case-insensitively', () => {
    const en = detectOwnMemoryRecallQuestion('what did I say my favourite fruit was?')!;
    expect(hasOwnMemoryRecallHit(en, durable('My favourite Fruit is mango'))).toBe(true);
    expect(hasOwnMemoryRecallHit(en, { conversationTranscript: [userTurn('coffee: americano')] })).toBe(false);
  });
});

describe('hasOwnMemoryRecallHit with semantic recall scores (live QA D5)', () => {
  const color = detectOwnMemoryRecallQuestion('내가 좋아하는 색깔이 뭐였지?')!;
  const name = detectOwnMemoryRecallQuestion('내 이름이 뭐였지?')!;
  const scored = (...entries: Array<[string, number]>): OwnMemoryRecallContext => ({
    conversationTranscript: [],
    durableRecall: entries.map(([content, semanticScore]) => ({ content, retrievalMode: 'semantic' as const, semanticScore })),
  });

  it('the QA repro: every stored memory came back scored low and none mentions the topic → no hit', () => {
    expect(hasOwnMemoryRecallHit(color, scored(['나는 샤인머스캣을 좋아해', 0.41], ['QA 테스트용 기억', 0.22]))).toBe(false);
  });

  it('session 4 repro: nomic-embed-text scores an unrelated question like the true match, so the score alone is no hit', () => {
    // Measured locally (nomic-embed-text, service prefixes, synthetic sentences): 0.760 / 0.706 for the tea question.
    const tea = detectOwnMemoryRecallQuestion('내가 좋아하는 차 종류 기억나?')!;
    expect(tea.topics).toEqual(['차', '종류']);
    const memories = scored(['내가 제일 좋아하는 과일은 샤인머스캣이야', 0.76], ['우리 고양이 이름은 나비야', 0.706]);
    expect(hasOwnMemoryRecallHit(tea, memories)).toBe(false);
    // The true match scored only 0.794, below the floor: it is a hit through the shared word "과일".
    expect(hasOwnMemoryRecallHit(detectOwnMemoryRecallQuestion('내가 좋아하는 과일 뭐였지?')!, memories)).toBe(true);
    expect(hasOwnMemoryRecallHit(detectOwnMemoryRecallQuestion('내가 말한 샤인머스캣 기억나?')!, memories)).toBe(true);
    expect(OWN_MEMORY_SEMANTIC_HIT_FLOOR).toBeGreaterThan(0.794);
  });

  it('a semantic score at or above the (very high) floor is a hit even with no shared word (Codex P2 kept for it)', () => {
    expect(hasOwnMemoryRecallHit(name, scored(['나는 철수야', OWN_MEMORY_SEMANTIC_HIT_FLOOR]))).toBe(true);
    expect(hasOwnMemoryRecallHit(name, scored(['나는 철수야', 0.97]))).toBe(true);
    expect(hasOwnMemoryRecallHit(name, scored(['나는 철수야', 0.83]))).toBe(false);
    expect(hasOwnMemoryRecallHit(name, scored(['나는 철수야', OWN_MEMORY_SEMANTIC_HIT_FLOOR - 0.0001]))).toBe(false);
  });

  it('a topic stem in the memory is a hit whatever its semantic score', () => {
    expect(hasOwnMemoryRecallHit(color, scored(['좋아하는 색깔은 파랑', 0.1]))).toBe(true);
  });

  it('a stated preference about something else is not evidence for a durable entry (only for the User\'s own turns)', () => {
    expect(hasOwnMemoryRecallHit(color, scored(['나는 귤을 좋아해', 0.3]))).toBe(false);
    expect(hasOwnMemoryRecallHit(color, { conversationTranscript: [userTurn('나는 귤을 좋아해')] })).toBe(true);
  });

  it('one entry above the floor among low ones is a hit', () => {
    expect(hasOwnMemoryRecallHit(name, scored(['커피는 아메리카노', 0.2], ['나는 철수야', 0.93]))).toBe(true);
  });

  it('an entry without a semantic score (lexical-only recall) is a hit only through a shared topic word', () => {
    const lexical = (...contents: string[]): OwnMemoryRecallContext => ({
      conversationTranscript: [],
      durableRecall: contents.map((content) => ({ content, retrievalMode: 'lexical' as const })),
    });
    expect(hasOwnMemoryRecallHit(name, lexical('나는 철수야'))).toBe(false);
    expect(hasOwnMemoryRecallHit(name, lexical('내 이름은 철수야'))).toBe(true);
    const mixed: OwnMemoryRecallContext = {
      conversationTranscript: [],
      durableRecall: [
        { content: '커피는 아메리카노', retrievalMode: 'semantic', semanticScore: 0.1 },
        { content: '내 이름은 철수야', retrievalMode: 'lexical' },
      ],
    };
    expect(hasOwnMemoryRecallHit(name, mixed)).toBe(true);
  });

  it('compares the raw structured score; edge values never pass by rounding or parsing (Codex P3)', () => {
    const one = (semanticScore: number | undefined): OwnMemoryRecallContext => ({
      conversationTranscript: [],
      durableRecall: [{ content: '나는 철수야', retrievalMode: 'semantic', ...(semanticScore === undefined ? {} : { semanticScore }) }],
    });
    expect(hasOwnMemoryRecallHit(name, one(0.89996))).toBe(false); // would have printed as 0.9000
    expect(hasOwnMemoryRecallHit(name, one(0.9))).toBe(true);
    expect(hasOwnMemoryRecallHit(name, one(0.1))).toBe(false); // "1e-1" as a number is just 0.1
    expect(hasOwnMemoryRecallHit(name, one(Number.NaN))).toBe(false);
    expect(hasOwnMemoryRecallHit(name, one(Number.POSITIVE_INFINITY))).toBe(false);
    expect(hasOwnMemoryRecallHit(name, one(1.5))).toBe(false);
    expect(hasOwnMemoryRecallHit(name, one(undefined))).toBe(false); // semantic mode without a score is no evidence
    // Diagnostic text is never read: a reason line claiming a high score changes nothing.
    const textOnly = {
      conversationTranscript: [],
      durableRecall: [{ content: '나는 철수야', retrievalMode: 'semantic' as const, semanticScore: 0.2, retrievalReason: 'semantic=0.9900' }],
    };
    expect(hasOwnMemoryRecallHit(name, textOnly)).toBe(false);
  });
});

describe('hasOwnMemoryRecallHit topic-word overlap (live QA D5, session 4)', () => {
  const MEMORIES = durable('내가 제일 좋아하는 과일은 샤인머스캣이야', '우리 고양이 이름은 나비야');
  const ask = (text: string) => {
    const question = detectOwnMemoryRecallQuestion(text);
    expect(question, text).not.toBeNull();
    return question!;
  };

  it.each([
    // "과일" overlaps ("과일은" with its particle peeled)
    '내가 좋아하는 과일 뭐였지?',
    '내가 제일 좋아하는 과일이 뭐였더라',
    // the fact itself ("샤인머스캣이야" with its ending peeled)
    '내가 말한 샤인머스캣 기억나?',
    // "고양이" overlaps; a particle on either side is peeled ("고양이의")
    '내 고양이의 이름이 뭐였지?',
    '내가 말한 고양이 기억나?',
  ])('%s → hit (a shared topic word)', (text) => {
    expect(hasOwnMemoryRecallHit(ask(text), MEMORIES)).toBe(true);
  });

  it.each([
    // the live repro: "차" and the generic head "종류" are in no memory
    '내가 좋아하는 차 종류 기억나?',
    // only stop-words / the relation are shared ("내가", "좋아하는", "제일", "기억나", "뭐였지")
    '내가 좋아하는 색깔이 뭐였지?',
    '내가 제일 좋아하는 음식이 뭐였지?',
    '내가 좋아하는 영화 기억나?',
    '내가 싫어하는 운동이 뭐였지?',
    '내 생일이 언제였지?',
    // "이름" is generic: it counts only as a sole topic, so another pet's name is no hit
    '내 강아지 이름 기억나?',
    // a one-syllable stem never matches inside another word ("자동차", "차가운")
    '내가 말한 차 기억나?',
  ])('%s → no hit (only stop-words, a generic head or nothing shared)', (text) => {
    expect(hasOwnMemoryRecallHit(ask(text), MEMORIES)).toBe(false);
  });

  it('a one-syllable topic matches the whole word up to a particle, never a piece of another word', () => {
    const tea = ask('내가 좋아하는 차 종류 기억나?');
    expect(hasOwnMemoryRecallHit(tea, durable('자동차는 회색이 좋아', '차가운 물이 좋아'))).toBe(false);
    expect(hasOwnMemoryRecallHit(tea, durable('나는 차는 녹차를 좋아해'))).toBe(true);
    expect(hasOwnMemoryRecallHit(tea, durable('차: 보이차'))).toBe(true);
  });

  it('a generic head counts when it is the only topic; Korean endings are peeled on the memory side', () => {
    expect(hasOwnMemoryRecallHit(ask('내 이름이 뭐였지?'), durable('내 이름은 철수입니다'))).toBe(true);
    expect(hasOwnMemoryRecallHit(ask('내가 좋아하는 음식이 뭐였지?'), durable('제일 좋아하는 음식이에요: 김치찌개'))).toBe(true);
    expect(hasOwnMemoryRecallHit(ask('내가 좋아하는 차 종류 기억나?'), durable('좋아하는 과일 종류는 샤인머스캣'))).toBe(false);
  });

  it('the same overlap rule applies to the User\'s own earlier turns (the preference fallback stays for them)', () => {
    const tea = ask('내가 좋아하는 차 종류 기억나?');
    expect(hasOwnMemoryRecallHit(tea, { conversationTranscript: [userTurn('우리 고양이 이름은 나비야')] })).toBe(false);
    expect(hasOwnMemoryRecallHit(tea, { conversationTranscript: [userTurn('나는 차를 자주 마셔')] })).toBe(true);
  });

  it.each([
    // Codex P2 (b571e4d): Korean-aware containment — the shorter side keeps at least two syllables
    ['내 생일날 언제였지?', '내 생일은 3월 5일이야'],
    ['내 생일이 언제였지?', '생일날은 3월 5일'],
    ['내가 말한 고양이 기억나?', '고양이랑 같이 살아'],
    ['내가 말한 회사 기억나?', '회사에서 일해'],
    ['내가 말한 회사 기억나?', '나는 회사원이야'],
  ])('%s ↔ %s → hit (containment after one particle)', (text, memory) => {
    expect(hasOwnMemoryRecallHit(ask(text), durable(memory))).toBe(true);
  });

  it.each([
    // Codex P2 (b571e4d): a one-syllable topic is that syllable alone or with exactly one particle
    ['내가 좋아하는 차 종류 기억나?', '차고에 자전거를 뒀어'],
    ['내가 좋아하는 차 종류 기억나?', '차고 정리했어'],
    ['내가 좋아하는 차 종류 기억나?', '자동차는 회색'],
    ['내가 좋아하는 차 종류 기억나?', '차가운 물이 좋아'],
  ])('%s ↔ %s → no hit (never a longer noun)', (text, memory) => {
    expect(hasOwnMemoryRecallHit(ask(text), durable(memory))).toBe(false);
  });

  it.each(['나는 차를 좋아해', '차가 좋아', '차는 녹차', '좋아하는 건 차'])('"차" matches "%s" (the syllable plus one particle)', (memory) => {
    expect(hasOwnMemoryRecallHit(ask('내가 좋아하는 차 종류 기억나?'), durable(memory))).toBe(true);
  });

  it('English topics compare without plural or possessive endings', () => {
    const en = ask('what did I say my favourite fruit was?');
    expect(hasOwnMemoryRecallHit(en, durable('Fruits I love: mango'))).toBe(true);
    expect(hasOwnMemoryRecallHit(en, durable('my favourite movie is Up'))).toBe(false);
  });
});

describe('renderOwnMemoryNotFound', () => {
  it('is fixed KO/EN copy naming the real save command', () => {
    expect(renderOwnMemoryNotFound('ko')).toBe('그 내용은 기억에 없어요. 알려 주시면 "기억해: …"로 저장해 둘게요.');
    expect(renderOwnMemoryNotFound('en')).toBe(`I don't have that in my memory. If you tell me with "remember: …", I'll save it.`);
  });
});

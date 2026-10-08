import { describe, expect, it } from 'vitest';
import {
  OWN_MEMORY_SEMANTIC_HIT_FLOOR,
  detectOwnMemoryRecallQuestion,
  hasOwnMemoryRecallHit,
  renderOwnMemoryNotFound,
  semanticScoreOfRetrievalReason,
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

  it('for a preference question any stated preference is a hit (generous: the provider flow stays)', () => {
    expect(hasOwnMemoryRecallHit(fruit, durable('나는 귤을 좋아해'))).toBe(true);
  });

  it('ANY durable recall entry in the built context is a hit, even with no shared word (the retriever chose it)', () => {
    // Codex P2 regression: a semantic match with no lexical overlap must never get "not in memory".
    const name = detectOwnMemoryRecallQuestion('내 이름이 뭐였지?')!;
    expect(hasOwnMemoryRecallHit(name, durable('나는 철수야'))).toBe(true);
    expect(hasOwnMemoryRecallHit(fruit, durable('커피는 아메리카노', '주간 회의는 화요일'))).toBe(true);
    expect(hasOwnMemoryRecallHit(cat, durable('커피는 아메리카노'))).toBe(true);
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
    durableRecall: entries.map(([content, semantic]) => ({
      content,
      retrievalReason: `lexical=0.0000; recency=0.9876; semantic=${semantic.toFixed(4)}`,
    })),
  });

  it('the QA repro: every stored memory came back scored low and none mentions the topic → no hit', () => {
    expect(hasOwnMemoryRecallHit(color, scored(['나는 샤인머스캣을 좋아해', 0.41], ['QA 테스트용 기억', 0.22]))).toBe(false);
  });

  it('a semantic score at or above the floor is a hit even with no shared word (Codex P2 kept)', () => {
    expect(hasOwnMemoryRecallHit(name, scored(['나는 철수야', OWN_MEMORY_SEMANTIC_HIT_FLOOR]))).toBe(true);
    expect(hasOwnMemoryRecallHit(name, scored(['나는 철수야', 0.83]))).toBe(true);
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
    expect(hasOwnMemoryRecallHit(name, scored(['커피는 아메리카노', 0.2], ['나는 철수야', 0.71]))).toBe(true);
  });

  it('an entry without a semantic score (lexical-only recall, or not scored this turn) stays a hit', () => {
    const lexicalOnly: OwnMemoryRecallContext = {
      conversationTranscript: [],
      durableRecall: [{ content: '나는 철수야', retrievalReason: 'lexical=0.0000; recency=0.9876' }],
    };
    expect(hasOwnMemoryRecallHit(name, lexicalOnly)).toBe(true);
    const mixed: OwnMemoryRecallContext = {
      conversationTranscript: [],
      durableRecall: [
        { content: '커피는 아메리카노', retrievalReason: 'lexical=0.0000; recency=0.9; semantic=0.1000' },
        { content: '나는 철수야', retrievalReason: 'lexical=0.0000; recency=0.9' },
      ],
    };
    expect(hasOwnMemoryRecallHit(name, mixed)).toBe(true);
  });

  it('reads the semantic score from the retriever\'s reason line only', () => {
    expect(semanticScoreOfRetrievalReason('lexical=0.1000; recency=0.5000; semantic=0.7300')).toBe(0.73);
    expect(semanticScoreOfRetrievalReason('lexical=0.1000; recency=0.5000')).toBeUndefined();
    expect(semanticScoreOfRetrievalReason('test')).toBeUndefined();
    expect(semanticScoreOfRetrievalReason(undefined)).toBeUndefined();
    expect(semanticScoreOfRetrievalReason('lexical=0; nonsemantic=0.9')).toBeUndefined();
  });
});

describe('renderOwnMemoryNotFound', () => {
  it('is fixed KO/EN copy naming the real save command', () => {
    expect(renderOwnMemoryNotFound('ko')).toBe('그 내용은 기억에 없어요. 알려 주시면 "기억해: …"로 저장해 둘게요.');
    expect(renderOwnMemoryNotFound('en')).toBe(`I don't have that in my memory. If you tell me with "remember: …", I'll save it.`);
  });
});

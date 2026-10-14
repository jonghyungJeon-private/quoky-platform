import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../../domain';
import { parseCalendarQuestion } from '../calendar/calendar-question';
import type { CapabilityRouter } from '../capability-router';
import { IntentClassifier } from '../intent-classifier';
import { detectWorkChatCommand, todoListLeavesUnexpressedContent } from '../work-chat/work-chat-command';

/**
 * ADR-0120 amendment A2, implementation note 2 (live Telegram, 2026-10-14): one rule over every Class B grammar. A grammar
 * answers only when it expresses everything the message asks; otherwise, when selection would run (`yield`), it declines.
 * With yield off every grammar answers exactly as before. Rows: grammars; the residual kind names WHY a grammar may not
 * answer. The live sentences are rows here, but the rule never names them: each is declined by a leftover word, a typed
 * arg's grounding word or the catalog's own keyword rule.
 */

type Residual = 'none' | 'part-of-day' | 'leftover-content' | 'exclusion' | 'swallowed-slot' | 'typed-arg-word';

const classifier = new IntentClassifier({} as unknown as CapabilityRouter);
const message = (text: string): InboundMessage => ({ text, context: {} }) as unknown as InboundMessage;

/** Whether each Class B grammar claims the text (a probe-equivalent: the pure grammar or the classifier clause). */
const GRAMMARS = {
  'calendar-question': async (text: string, grammarYield: boolean) => parseCalendarQuestion(text, { yieldToSelection: grammarYield })?.kind === 'events',
  'work-lookup': async (text: string, grammarYield: boolean) => {
    const command = detectWorkChatCommand(text, { yieldToSelection: grammarYield });
    return command !== null && (command.kind === 'lookup' || command.kind === 'todo.list');
  },
  // The classifier clause itself is unchanged; with yield on the runtime asks the selector first when the clause leaves
  // content (and keeps the surface as the fallback when the selector does not answer, A5 change 9).
  'work-surface': async (text: string, grammarYield: boolean) =>
    (await classifier.classify(message(text))).raw?.kind === 'personal-work-surface' && !(grammarYield && todoListLeavesUnexpressedContent(text)),
} as const;

const TABLE: ReadonlyArray<{ readonly grammar: keyof typeof GRAMMARS; readonly residual: Residual; readonly text: string }> = [
  // Calendar: a part of the day is the typed partOfDay arg (A5); the grammar would answer the whole day.
  { grammar: 'calendar-question', residual: 'none', text: '내일 일정' },
  { grammar: 'calendar-question', residual: 'none', text: '내일 오후 3시에 뭐 있어' },
  { grammar: 'calendar-question', residual: 'part-of-day', text: '다음 주 수요일 오후에 뭐 있어' },
  { grammar: 'calendar-question', residual: 'part-of-day', text: '내일 오후 일정' },
  { grammar: 'calendar-question', residual: 'part-of-day', text: '내일 밤 일정' },
  { grammar: 'calendar-question', residual: 'leftover-content', text: '이번 주 정기회의 일정 있어?' },
  { grammar: 'calendar-question', residual: 'leftover-content', text: '다음 주 수 일정 있어?' },
  { grammar: 'calendar-question', residual: 'none', text: "what's on my calendar at 3pm this afternoon" },
  { grammar: 'calendar-question', residual: 'none', text: 'any meetings this afternoon at 3pm?' },
  { grammar: 'calendar-question', residual: 'part-of-day', text: 'what is on my calendar this afternoon' },
  // The to-do list phrases (one of them a substring match) and the classifier's surface clause, the same phrase family.
  { grammar: 'work-lookup', residual: 'none', text: '내 할 일' },
  { grammar: 'work-lookup', residual: 'none', text: '남은 할 일 보여줘' },
  { grammar: 'work-lookup', residual: 'none', text: '내가 해야 할 일 알려줘' },
  { grammar: 'work-lookup', residual: 'leftover-content', text: '할 일 관리하는 좋은 습관 알려줘' },
  // A one-syllable word is a word: only the closed classes make a token grammar, never its length.
  { grammar: 'work-lookup', residual: 'leftover-content', text: '할 일 앱 알려줘' },
  { grammar: 'work-lookup', residual: 'leftover-content', text: '할 일 팁 알려줘' },
  // The closed one-syllable classes (adverbs, dependent nouns) are grammar; a glued fragment is an ending only when it is one.
  { grammar: 'work-lookup', residual: 'none', text: '할 일 다 보여줘' },
  { grammar: 'work-lookup', residual: 'none', text: '할 일 또 보여줘' },
  { grammar: 'work-lookup', residual: 'none', text: '할 일 좀 더 알려줘' },
  { grammar: 'work-lookup', residual: 'none', text: '할 일 꼭 알려줘' },
  { grammar: 'work-lookup', residual: 'none', text: '할 일 알려줄 수 있어?' },
  { grammar: 'work-lookup', residual: 'none', text: '할일들 보여줘' },
  { grammar: 'work-lookup', residual: 'leftover-content', text: '할일앱 알려줘' },
  { grammar: 'work-lookup', residual: 'leftover-content', text: '할일팁 알려줘' },
  // Glued endings only after the grammar word, once and in order (plural, one particle); nothing before it.
  { grammar: 'work-lookup', residual: 'leftover-content', text: '할일지도 알려줘' },
  { grammar: 'work-lookup', residual: 'leftover-content', text: '할일만나 보여줘' },
  { grammar: 'work-lookup', residual: 'leftover-content', text: '아들할일 보여줘' },
  { grammar: 'work-lookup', residual: 'leftover-content', text: '아이할일 보여줘' },
  { grammar: 'work-lookup', residual: 'none', text: '할 일들을 보여줘' },
  { grammar: 'work-lookup', residual: 'none', text: '할일이랑 보여줘' },
  { grammar: 'work-lookup', residual: 'none', text: '할일도 보여줘' },
  // A dependent noun is grammar only after an adnominal word (ㄴ/ㄹ final): "알려줄 수", not "다음 주 수".
  { grammar: 'work-lookup', residual: 'none', text: '할 일 알려줄 수 있나요?' },
  { grammar: 'work-lookup', residual: 'none', text: '할 일 보여줄 수 있어요?' },
  { grammar: 'work-surface', residual: 'leftover-content', text: '할 일 팁 알려줘' },
  { grammar: 'work-lookup', residual: 'none', text: '내 지라 티켓 뭐 있어?' },
  { grammar: 'work-lookup', residual: 'none', text: '내 github 이슈들 보여줘' },
  { grammar: 'work-lookup', residual: 'none', text: '리뷰 요청 온 거 있어?' },
  { grammar: 'work-surface', residual: 'none', text: '내가 해야 할 일 보여줘' },
  { grammar: 'work-surface', residual: 'none', text: 'Show me what I need to work on' },
  { grammar: 'work-surface', residual: 'exclusion', text: '캘린더는 보지 말고 할 일만 알려줘' },
  { grammar: 'work-surface', residual: 'leftover-content', text: '할 일 관리하는 좋은 습관 알려줘' },
  // Free-text keyword slots: the slot must already be the catalog's canonical keyword.
  { grammar: 'work-lookup', residual: 'none', text: '슬랙에서 배포 찾아줘' },
  { grammar: 'work-lookup', residual: 'none', text: '컨플루언스에서 온보딩 검색해줘' },
  { grammar: 'work-lookup', residual: 'swallowed-slot', text: '슬랙에서 배포 얘기 나온 거 찾아줘' },
  { grammar: 'work-lookup', residual: 'swallowed-slot', text: '컨플루언스에서 결제 관련 내용 찾아줘' },
  { grammar: 'work-lookup', residual: 'swallowed-slot', text: '지라에서 배포 얘기 찾아줘' },
  // Quotes mark the owner's exact literal: a quoted keyword is never cut, even when it ends in a generic word.
  { grammar: 'work-lookup', residual: 'none', text: '슬랙에서 "배포 관련" 찾아줘' },
  { grammar: 'work-lookup', residual: 'none', text: '슬랙에서 "온보딩 문서" 찾아줘' },
  { grammar: 'work-lookup', residual: 'none', text: '컨플루언스에서 “온보딩 문서” 검색해줘' },
  { grammar: 'work-lookup', residual: 'none', text: '지라에서 "배포 관련" 이슈 찾아줘' },
  { grammar: 'work-lookup', residual: 'swallowed-slot', text: '슬랙에서 배포 관련 찾아줘' },
  { grammar: 'work-lookup', residual: 'none', text: '"진행중인 배포" 관련 지라 이슈 보여줘' },
  { grammar: 'work-lookup', residual: 'typed-arg-word', text: '진행중인 "배포" 관련 지라 이슈 보여줘' },
  { grammar: 'work-lookup', residual: 'none', text: '지라에서 위클리카 찾아줘' },
  { grammar: 'work-lookup', residual: 'typed-arg-word', text: '지라에서 진행중인 위클리카 찾아줘' },
  { grammar: 'work-lookup', residual: 'none', text: '위클리카 관련 지라 이슈 보여줘' },
  { grammar: 'work-lookup', residual: 'swallowed-slot', text: '위클리카 얘기 관련 지라 이슈 보여줘' },
];

describe('A2 rule table: grammars x residual kinds (ADR-0120 A2 implementation note 2)', () => {
  it.each(TABLE)('$grammar / $residual: "$text"', async ({ grammar, residual, text }) => {
    const claims = GRAMMARS[grammar];
    // Yield off (flag off, mode off/shadow, selector not the chat provider, an approval pending): the frozen grammar is
    // unchanged, so every row is still claimed.
    expect(await claims(text, false), `${text} (yield off)`).toBe(true);
    // Yield on: only a message the grammar expresses entirely is claimed.
    expect(await claims(text, true), `${text} (yield on)`).toBe(residual === 'none');
  });

  it('the work-chat detector declines the exclusion sentence even with yield off (negation), so only the surface clause took it', () => {
    expect(detectWorkChatCommand('캘린더는 보지 말고 할 일만 알려줘')).toBeNull();
  });
});

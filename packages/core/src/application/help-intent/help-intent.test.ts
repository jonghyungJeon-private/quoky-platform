import { describe, expect, it } from 'vitest';
import approvalCorpus from '../golden/approval-decision.v1.json';
import controlCorpus from '../golden/conversation-control.v1.json';
import intentCorpus from '../golden/intent-routing.v1.json';
import registrationCorpus from '../golden/project-registration.v1.json';
import precedenceCorpus from '../golden/reminder-todo-precedence.v1.json';
import strayCorpus from '../golden/stray-decision.v1.json';
import routingCorpus from '../golden/turn-handler-routing.v1.json';
import { GIT_BRANCH_HELP_LINE } from '../code-work/git-branch-command';
import { FEEDBACK_HELP_LINES } from '../feedback/feedback-summary-turn-handler';
import { REMINDER_DISABLED_HELP_LINES, REMINDER_HELP_LINES } from '../reminders/reminder-turn-handler';
import {
  WORK_CHAT_LOOKUP_TURN_HELP_LINES,
  WORK_CHAT_TODO_TURN_HELP_LINES,
} from '../work-chat/work-chat-turn-handler';
import {
  HELP_INTENT_MAX_CHARS,
  HELP_INTENT_MAX_LINE_CHARS,
  HELP_INTENT_MAX_LINES,
  HELP_INTENT_TOPICS,
  CAPABILITY_QUESTION_MAX_CHARS,
  composeHelpIntentReply,
  detectCapabilityQuestion,
  detectHelpIntent,
  selectHelpLines,
} from './help-intent';
import { HELP_INTENT_HELP_LINES } from './help-intent-turn-handler';

/** The lines the production handlers contribute today (ADR-0096 D6), in a plausible registry order. */
const CONTRIBUTED: readonly string[] = [
  GIT_BRANCH_HELP_LINE,
  ...WORK_CHAT_TODO_TURN_HELP_LINES,
  ...WORK_CHAT_LOOKUP_TURN_HELP_LINES,
  ...REMINDER_HELP_LINES,
  ...FEEDBACK_HELP_LINES,
  ...HELP_INTENT_HELP_LINES,
];

function topicsOf(text: string): readonly string[] | null {
  return detectHelpIntent(text)?.topicIds ?? null;
}

describe('detectHelpIntent: how-to questions about Quoky commands', () => {
  it.each([
    // live QA QA-V2-W7-06 and the ADR-0104 D4 examples
    ['완료 처리 어떻게 해?', ['todo.complete']],
    ['알림 어떻게 지워?', ['reminder']],
    ['알림 어떻게 설정해?', ['reminder']],
    ['완료 처리는 어떻게 하는 거야?', ['todo.complete']],
    ['완료처리 어떻게 해요', ['todo.complete']],
    ['할 일 어떻게 추가해?', ['todo']],
    ['할일은 어떻게 추가해요?', ['todo']],
    ['할 일 완료 처리 어떻게 해?', ['todo', 'todo.complete']],
    ['할 일 추가하는 법 알려줘', ['todo']],
    ['할 일 추가하는법 좀 알려줘', ['todo']],
    ['알림 설정 방법', ['reminder']],
    ['알림 설정 어떻게 해?', ['reminder']],
    ['알림 취소하려면?', ['reminder']],
    ['알림 지우려면 어떻게 해?', ['reminder']],
    ['알림 끄는 방법 알려주세요', ['reminder']],
    ['리마인더 사용법', ['reminder']],
    ['알림 도움말', ['reminder']],
    ['알림 기능은 어떻게 써?', ['reminder']],
    ['할 일 명령어 뭐야?', ['todo']],
    ['피드백 어떻게 남겨?', ['feedback']],
    ['브랜치 어떻게 만들어?', ['branch']],
    ['업무 조회 어떻게 해?', ['work-lookup']],
    ['기억 어떻게 지워?', ['memory']],
    ['커밋 어떻게 해?', ['commit']],
    ['프로젝트 등록 어떻게 해?', ['project']],
    ['  알림   어떻게   지워??  ', ['reminder']],
    // an address before the topic
    ['Quoky야, 알림 어떻게 설정해?', ['reminder']],
    ['여기서 할 일 어떻게 추가해?', ['todo']],
    ['퀴키에서 알림 어떻게 써?', ['reminder']],
    // "도움말 <topic>"
    ['도움말 알림', ['reminder']],
    ['도움말: 할 일', ['todo']],
    ['도움말 알림 기능', ['reminder']],
    ['/help 알림', ['reminder']],
    // English
    ['How do I set a reminder?', ['reminder']],
    ['how to cancel my reminders', ['reminder']],
    ['How can I mark a todo as done?', ['todo']],
    ['how do I add a to-do in Quoky', ['todo']],
  ])('%s → %j', (text, expected) => {
    expect(topicsOf(text)).toEqual(expected);
  });

  it('answers English questions in English and Korean ones in Korean', () => {
    expect(detectHelpIntent('How do I set a reminder?')?.language).toBe('en');
    expect(detectHelpIntent('알림 어떻게 설정해?')?.language).toBe('ko');
  });
});

describe('detectHelpIntent: everything else falls through', () => {
  it.each([
    // the commands themselves (their handlers own them)
    '알림 목록',
    '알림 1 취소',
    '할 일 추가: 보고서 쓰기',
    '완료 처리: 1',
    '도움말',
    '/help',
    '도움말 좀 알려줘',
    // generic programming / tool questions
    'git 브랜치 어떻게 만들어?',
    '파이썬 리스트 정렬 어떻게 해?',
    'pnpm test 실행 결과는 보통 어떻게 해석해?',
    'eslint에서 모든 규칙 무시하는 방법 알려줘',
    'How do I send an email with an attachment?',
    'How do I ignore all eslint rules for one file?',
    'how do I create a branch in git',
    // other apps and advice questions
    '아이폰 알림 어떻게 꺼?',
    '카톡 알림 어떻게 꺼?',
    '알림 소리 어떻게 바꿔?',
    '할 일 관리하는 방법 알려줘',
    '할 일 어떻게 정리해?',
    '할 일 잘 정리하는 법',
    '일정 관리 잘하는 방법 알려줘',
    '슬랙 어떻게 써?',
    'Slack 알림 어떻게 꺼?',
    '알림 어떻게 생각해?',
    '기억력 어떻게 높여?',
    '완료했어 어떻게 해?',
    // negations, statements, long or multi-line or code-bearing messages
    '알림 어떻게 하지 마',
    '알림 설정했어',
    '할 일 다 끝냈어',
    '알림 어떻게 설정하는지 알려주고 오늘 날씨도 알려주고 내일 일정도 정리해 줘 그리고 메일 초안도 써 줘',
    '알림 어떻게 지워?\n그리고 할 일도',
    '`알림` 어떻게 지워?',
    'https://example.com 알림 어떻게 써?',
    '',
    '   ',
  ])('%j → null', (text) => {
    expect(detectHelpIntent(text)).toBeNull();
  });

  it('caps the message length', () => {
    const padded = `알림 어떻게 지워?${' '.repeat(10)}`;
    expect(detectHelpIntent(padded)).not.toBeNull();
    expect(HELP_INTENT_MAX_CHARS).toBe(60);
  });

  it('a topic missing from the supplied index never matches', () => {
    const withoutReminders = HELP_INTENT_TOPICS.filter((topic) => topic.id !== 'reminder');
    expect(detectHelpIntent('알림 어떻게 지워?', withoutReminders)).toBeNull();
    expect(detectHelpIntent('How do I set a reminder?', withoutReminders)).toBeNull();
  });
});

describe('detectHelpIntent over the existing golden corpora (zero hijacks)', () => {
  /**
   * The only corpus texts that are Quoky how-to questions: the routing cases pinned to the help-intent handler
   * (route-021/022 and the wave-1 integration help cases). Every other corpus text must stay unmatched.
   */
  const EXPECTED_HELP = new Set([
    '완료 처리 어떻게 해?',
    ...(routingCorpus as { cases: ReadonlyArray<{ text: string; expected: { route?: string } }> }).cases
      .filter((c) => c.expected.route === 'help-intent')
      .map((c) => c.text),
  ]);
  const corpora = [
    approvalCorpus,
    controlCorpus,
    intentCorpus,
    registrationCorpus,
    precedenceCorpus,
    strayCorpus,
    routingCorpus,
  ] as ReadonlyArray<{ suite: string; cases: ReadonlyArray<{ id: string; text: string }> }>;

  it('matches no corpus case except the known how-to question', () => {
    const matched = corpora.flatMap((corpus) =>
      corpus.cases.filter((c) => detectHelpIntent(c.text) !== null).map((c) => `${corpus.suite}/${c.id}: ${c.text}`),
    );
    const unexpected = matched.filter((entry) => !EXPECTED_HELP.has(entry.slice(entry.indexOf(': ') + 2)));
    expect(unexpected).toEqual([]);
    expect(matched.length).toBeGreaterThan(0);
    expect(corpora.reduce((sum, corpus) => sum + corpus.cases.length, 0)).toBeGreaterThan(500);
  });
});

describe('selectHelpLines', () => {
  it('answers "완료 처리 어떻게 해?" with the to-do line only', () => {
    const match = detectHelpIntent('완료 처리 어떻게 해?');
    expect(match).not.toBeNull();
    const lines = selectHelpLines(match!, CONTRIBUTED, { exclude: HELP_INTENT_HELP_LINES });
    expect(lines).toEqual([...WORK_CHAT_TODO_TURN_HELP_LINES]);
    expect(lines.join('\n')).toContain('"완료 처리: 번호"');
  });

  it('answers a reminder question with the reminder lines, never with its own help line', () => {
    const lines = selectHelpLines(detectHelpIntent('알림 어떻게 지워?')!, CONTRIBUTED, {
      exclude: HELP_INTENT_HELP_LINES,
    });
    expect(lines).toEqual([...REMINDER_HELP_LINES]);
    expect(lines.join('\n')).not.toContain('사용법 질문');
  });

  it('a disabled feature answers with its disabled line', () => {
    const lines = selectHelpLines(detectHelpIntent('알림 어떻게 설정해?')!, [...REMINDER_DISABLED_HELP_LINES]);
    expect(lines).toEqual([...REMINDER_DISABLED_HELP_LINES]);
  });

  it('is empty when no contributed line covers the topic (the turn falls through)', () => {
    expect(selectHelpLines(detectHelpIntent('기억 어떻게 지워?')!, CONTRIBUTED)).toEqual([]);
    expect(selectHelpLines(detectHelpIntent('커밋 어떻게 해?')!, CONTRIBUTED)).toEqual([]);
    expect(selectHelpLines(detectHelpIntent('알림 어떻게 지워?')!, [])).toEqual([]);
  });

  it('a quoted example that only mentions the topic word does not answer it', () => {
    // The lookup line quotes "내 할 일 보여줘" and a reminder line quotes "… 오늘 할 일 알려줘": neither is a to-do command.
    const lines = selectHelpLines(detectHelpIntent('할 일 어떻게 추가해?')!, CONTRIBUTED);
    expect(lines).toEqual([...WORK_CHAT_TODO_TURN_HELP_LINES]);
    expect(selectHelpLines(detectHelpIntent('업무 조회 어떻게 해?')!, CONTRIBUTED)).toEqual([
      ...WORK_CHAT_LOOKUP_TURN_HELP_LINES,
    ]);
    expect(selectHelpLines(detectHelpIntent('피드백 어떻게 남겨?')!, CONTRIBUTED)).toEqual([...FEEDBACK_HELP_LINES]);
    expect(selectHelpLines(detectHelpIntent('브랜치 어떻게 만들어?')!, CONTRIBUTED)).toEqual([GIT_BRANCH_HELP_LINE]);
  });

  it('unions several topics in contribution order, without duplicates, bounded', () => {
    const same = selectHelpLines(detectHelpIntent('할 일 완료 처리 어떻게 해?')!, [
      ...CONTRIBUTED,
      ...WORK_CHAT_TODO_TURN_HELP_LINES,
    ], { exclude: HELP_INTENT_HELP_LINES });
    expect(same).toEqual([...WORK_CHAT_TODO_TURN_HELP_LINES]);
    const union = selectHelpLines({ topicIds: ['reminder', 'todo'], language: 'ko' }, CONTRIBUTED, {
      exclude: HELP_INTENT_HELP_LINES,
    });
    expect(union).toEqual([...WORK_CHAT_TODO_TURN_HELP_LINES, ...REMINDER_HELP_LINES]);

    const many = Array.from({ length: 10 }, (_, i) => `- 알림 줄 ${i} ${'가'.repeat(200)}`);
    const bounded = selectHelpLines(detectHelpIntent('알림 사용법')!, many);
    expect(bounded).toHaveLength(HELP_INTENT_MAX_LINES);
    for (const line of bounded) {
      expect(Array.from(line)).toHaveLength(HELP_INTENT_MAX_LINE_CHARS);
      expect(line.endsWith('…')).toBe(true);
    }
  });
});

describe('composeHelpIntentReply', () => {
  it('frames the lines and points to the full help', () => {
    const ko = composeHelpIntentReply('ko', ['- a']);
    expect(ko.split('\n')).toEqual(['Quoky에서는 이렇게 하면 돼요.', '- a', '전체 안내는 "도움말"이라고 보내 주세요.']);
    const en = composeHelpIntentReply('en', ['- a']);
    expect(en).toContain('- a');
    expect(en).toContain('"/help"');
  });
});

describe('DET-2 topic index additions: calendar, model command, connector writes', () => {
  it.each([
    ['캘린더 어떻게 써?', ['calendar']],
    ['일정 어떻게 잡아?', ['calendar']],
    ['일정 잡는 법', ['calendar']],
    ['일정 추가 어떻게 해?', ['calendar']],
    ['달력 보는 법', ['calendar']],
    ['모델 변경 어떻게 해?', ['model']],
    ['모델 바꾸는 법', ['model']],
    ['모델 어떻게 바꿔?', ['model']],
    ['이미지 모델 변경 방법', ['model']],
    ['Slack 게시 어떻게 해?', ['connector-write']],
    ['Jira 댓글 어떻게 달아?', ['connector-write']],
    ['슬랙 글 올리는 법', ['connector-write']],
  ])('%s → %j', (text, ids) => {
    expect(topicsOf(text)).toEqual(ids);
  });

  it.each([
    '모델 만드는 법', '모델 학습 어떻게 해?', '3D 모델 바꾸는 법', '일정 관리 어떻게 해?', '일정 정리하는 법 알려줘', '구글 캘린더 연동 어떻게 해?',
    '회의 일정 잡는 팁 알려줘', '슬랙 어떻게 써?', '댓글 어떻게 달아?', 'Slack에 글 올리는 방법 알려줘', '일정 공유 어떻게 해?',
  ])('%s stays chat', (text) => {
    expect(detectHelpIntent(text)).toBeNull();
  });

  it('answers only from the lines that carry the topic anchor', () => {
    const calendarLine = '- 캘린더(읽기 전용): "오늘 일정", "내일 일정 뭐야?", "이번 주 일정", "다음 회의 언제야?"';
    const modelLine = '- 모델: "모델 상태", "모델 목록", "모델 변경: codex", "이미지 모델 변경: off", "모델 기본값으로" (이 대화에서만)';
    const slackLine = '- Slack 게시: "#채널에 게시: 내용" 또는 "#채널에 내용이라고 올려줘" → "승인" → "Slack 게시 실행"';
    const lines = [...CONTRIBUTED, calendarLine, modelLine, slackLine];
    expect(selectHelpLines(detectHelpIntent('캘린더 어떻게 써?')!, lines)).toEqual([calendarLine]);
    expect(selectHelpLines(detectHelpIntent('모델 바꾸는 법')!, lines)).toEqual([modelLine]);
    expect(selectHelpLines(detectHelpIntent('Slack 게시 어떻게 해?')!, lines)).toEqual([slackLine]);
    // Without the feature's line (not registered / writes off) the topic answers nothing and the turn falls through.
    expect(selectHelpLines(detectHelpIntent('Slack 게시 어떻게 해?')!, CONTRIBUTED)).toEqual([]);
  });
});

describe('detectCapabilityQuestion (DET-2, live QA session 3 D11)', () => {
  it.each([
    '뭐 할 수 있어?', '뭘 할 수 있어?', '뭐 할 수 있어', '너 뭐 할 수 있어?', '넌 뭘 할 수 있어?', 'Quoky야 뭐 할 수 있어?', 'Quoky야, 넌 뭘 할 수 있어?',
    'Quoky는 뭐 할 수 있어?', 'Quoky가 뭘 할 수 있어?', '여기서 뭐 할 수 있어?', '무엇을 할 수 있나요?', '어떤 일을 할 수 있어?', '뭐 도와줄 수 있어?',
    '뭘 도와줄 수 있어?', '뭐 할 줄 알아?', '할 수 있는 게 뭐야?', '할 수 있는 일이 뭐야?', '할 수 있는 거 알려줘', '할 수 있는 기능 뭐 있어?',
    '무슨 기능 있어?', '어떤 기능이 있어?', '기능 뭐 있어?', '기능 목록', '명령어 뭐 있어?', '명령어 알려줘', '명령어 목록', '명령어', '사용법',
  ])('%s → ko', (text) => {
    expect(detectCapabilityQuestion(text)).toBe('ko');
  });

  it.each(['what can you do?', 'What can you help me with?', 'what can quoky do?', 'what are your features?', 'show me the commands'])('%s → en', (text) => {
    expect(detectCapabilityQuestion(text)).toBe('en');
  });

  it.each([
    '파이썬으로 뭐 할 수 있어?', '주말에 뭐 할 수 있어?', '내가 뭐 할 수 있어?', '이 함수로 뭐 할 수 있어?', '오늘 뭐 할 수 있어?', 'React로 할 수 있는 게 뭐야?',
    '뭐 할 수 있어? 그리고 날씨 알려줘', 'what can you do with python?', 'help', 'help me', 'help me write a function', '이 기능 뭐 있어?', '명령어 만드는 법',
    '할 수 있는 게 없어', '뭐 할 수 없어?', '`뭐 할 수 있어?`', `${'뭐 '.repeat(CAPABILITY_QUESTION_MAX_CHARS)}할 수 있어?`, '',
  ])('%j stays chat', (text) => {
    expect(detectCapabilityQuestion(text)).toBeNull();
  });

  it('matches no golden corpus case pinned to another route', () => {
    const corpora = [approvalCorpus, controlCorpus, intentCorpus, registrationCorpus, precedenceCorpus, strayCorpus, routingCorpus] as ReadonlyArray<{
      suite: string;
      cases: ReadonlyArray<{ id: string; text: string; expected: unknown }>;
    }>;
    const matched = corpora.flatMap((corpus) =>
      corpus.cases
        .filter((c) => detectCapabilityQuestion(c.text) !== null)
        .filter((c) => (c.expected as { route?: string } | null)?.route !== 'help-intent')
        .map((c) => `${corpus.suite}/${c.id}: ${c.text}`),
    );
    expect(matched).toEqual([]);
  });
});

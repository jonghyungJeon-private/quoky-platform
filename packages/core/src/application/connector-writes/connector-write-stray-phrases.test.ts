import { describe, expect, it } from 'vitest';
import { CONNECTOR_WRITE_OPERATIONS, type ConnectorWriteOperation } from '../../ports';
import { EXECUTION_PHRASES, isAcceptedExecutionPhrase, type ExecutionGate } from '../execution-command-guard';
import { renderConnectorWriteBareExecution } from './connector-write-copy';
import {
  connectorWriteExecutionGate,
  connectorWriteOperationsAskedAbout,
  connectorWriteOperationsNamedLoosely,
  isBareExecutionProhibition,
  isBareExecutionQuestionOrNegation,
  isBareExecutionRequest,
} from './connector-write-flow';

// Routing exec gaps (after INT-2 / PR #137): the classifiers that pick a NON-mutating reply for a bare execution command
// while a write waits approved, and for a write-step question / negation with nothing approved. Neither ever executes:
// every input they match is rejected by every connector-write execution gate.

const PHRASES: ReadonlyArray<readonly [ConnectorWriteOperation, string]> = [
  ['ISSUE_COMMENT', '댓글 실행'],
  ['ISSUE_TRANSITION', '상태 변경 실행'],
  ['CHANNEL_POST', 'Slack 게시 실행'],
  ['CALENDAR_EVENT_CREATE', '일정 추가 실행'],
  ['CALENDAR_EVENT_UPDATE', '일정 변경 실행'],
  ['CALENDAR_EVENT_DELETE', '일정 삭제 실행'],
];

const CONNECTOR_GATES: readonly ExecutionGate[] = CONNECTOR_WRITE_OPERATIONS.map(connectorWriteExecutionGate);
const acceptedByConnectorGate = (text: string) => CONNECTOR_GATES.some((gate) => isAcceptedExecutionPhrase(gate, text));

describe('isBareExecutionRequest', () => {
  it.each([
    '실행', '실행해', '실행해줘', '실행 해줘', '실행 해 주세요', '실행해줘요', '실행!', '지금 실행', '이제 실행해줘', '바로 실행해',
    '실행하자', 'go', 'Go', 'GO!', 'go now', 'run it', 'Run it.', 'run it now', 'run it please', 'execute', 'execute it', 'do it',
  ])('a bare command naming no step %j matches — and no connector-write gate accepts it', (text) => {
    expect(isBareExecutionRequest(text)).toBe(true);
    expect(acceptedByConnectorGate(text)).toBe(false);
  });

  it.each([
    '실행해?', '실행해도 돼?', '실행하지 마', '실행 안 해', '실행했어', '실행 결과 알려줘', '파일 실행해줘', '테스트 실행해줘',
    '댓글 실행', 'Slack 게시 실행', '일정 추가 실행해줘', 'go home', 'go ahead', 'run the tests', 'run it again tomorrow',
    'execute the deploy now', '진행 상황 알려줘', '',
  ])('%j is not a bare execution command', (text) => {
    expect(isBareExecutionRequest(text)).toBe(false);
  });

  it('every bare form stays outside every connector-write allow-list (the exact phrase is the only executor)', () => {
    for (const gate of CONNECTOR_GATES) {
      for (const phrase of EXECUTION_PHRASES[gate]) expect(isBareExecutionRequest(phrase), `${gate}: ${phrase}`).toBe(false);
    }
  });
});

describe('connectorWriteOperationsAskedAbout', () => {
  it.each(PHRASES)('%s: "%s" asked as a question or a negation names that write and is never executable', (operation, phrase) => {
    for (const text of [
      `${phrase}해도 돼?`,
      `${phrase}해도 될까`,
      `${phrase}할까?`,
      `지금 ${phrase}해도 괜찮아?`,
      `${phrase}하지 마`,
      `${phrase}하지 말아줘`,
      `${phrase} 안 해도 돼`,
      `${phrase}은 취소해`,
    ]) {
      expect(connectorWriteOperationsAskedAbout(text), text).toEqual([operation]);
      expect(acceptedByConnectorGate(text), text).toBe(false);
    }
  });

  it.each(PHRASES)('%s: the exact phrase, an explanation, a concept question or a statement is not a stray question', (_op, phrase) => {
    for (const text of [
      phrase,
      `${phrase}해줘`,
      `${phrase} 방법 알려줘`,
      `${phrase}은 어떻게 해?`,
      `${phrase}이 뭐야?`,
      `${phrase} 뜻이 궁금해?`,
      `${phrase}했어`,
      `${phrase}해도 돼? ${'긴 설명 '.repeat(30)}`,
    ]) {
      expect(connectorWriteOperationsAskedAbout(text), text).toEqual([]);
    }
  });

  it('questions that name no write step are not matched', () => {
    for (const text of ['실행해도 돼?', '파일 실행해도 돼?', '테스트 실행하지 마', '푸시 실행해도 돼?', '댓글 달아도 돼?', '게시물 봐도 돼?']) {
      expect(connectorWriteOperationsAskedAbout(text), text).toEqual([]);
    }
  });
});

describe('renderConnectorWriteBareExecution', () => {
  it('says the approved write did not run and quotes its exact phrase (only about that write, never "nothing was sent")', () => {
    expect(renderConnectorWriteBareExecution('CHANNEL_POST', 'Slack 게시 실행')).toBe(
      '승인된 Slack 게시는 아직 실행하지 않았어요. 실행할 작업을 정확히 말해 주세요: "Slack 게시 실행"',
    );
    expect(renderConnectorWriteBareExecution('ISSUE_COMMENT', '댓글 실행')).toBe(
      '승인된 Jira 댓글은 아직 실행하지 않았어요. 실행할 작업을 정확히 말해 주세요: "댓글 실행"',
    );
    expect(renderConnectorWriteBareExecution('CALENDAR_EVENT_DELETE', '일정 삭제 실행')).toBe(
      '승인된 캘린더 일정 삭제는 아직 실행하지 않았어요. 실행할 작업을 정확히 말해 주세요: "일정 삭제 실행"',
    );
  });
});

describe('connectorWriteOperationsNamedLoosely (DET-2 sweep)', () => {
  it.each(PHRASES)('%s: a loose imperative of "%s" names that write and is never executable', (operation, phrase) => {
    for (const text of [`${phrase}해`, `${phrase}해요`, `${phrase}하자`, `${phrase}시켜줘`, `지금 ${phrase}해`, `${phrase} 부탁해`, `${phrase}해 줄래`]) {
      expect(connectorWriteOperationsNamedLoosely(text), text).toEqual([operation]);
      expect(acceptedByConnectorGate(text), text).toBe(false);
      expect(isBareExecutionRequest(text), text).toBe(false);
    }
  });

  it.each([
    ['ISSUE_COMMENT', ['댓글 달았어?', '댓글 달았나', 'Jira 댓글 남겼어?', '코멘트 달렸어?', '댓글 잘 올라갔지?']],
    ['ISSUE_TRANSITION', ['상태 변경했어?', '상태 바뀌었어?', 'Jira 상태 변경됐나요?', '상태 변경 됐어?']],
    ['CHANNEL_POST', ['Slack 게시했어?', 'Slack에 올렸어?', '슬랙에 메시지 보냈어?', '게시했어?', '게시물 올라갔나']],
    ['CALENDAR_EVENT_CREATE', ['일정 추가됐어?', '일정 추가했어?', '일정 잡혔어?', '캘린더에 일정 들어갔나', '일정 추가 됐어?']],
    ['CALENDAR_EVENT_UPDATE', ['일정 변경됐어?', '일정 바뀌었어?', '일정 옮겨졌나요?']],
    ['CALENDAR_EVENT_DELETE', ['일정 삭제됐어?', '일정 취소됐어?', '일정 지워졌나']],
  ] as const)('%s: "did it happen?" questions name that write and are never executable', (operation, texts) => {
    for (const text of texts) {
      expect(connectorWriteOperationsNamedLoosely(text), text).toEqual([operation]);
      expect(acceptedByConnectorGate(text), text).toBe(false);
    }
  });

  it('statements, explanations, other objects and long text are not matched', () => {
    for (const text of [
      '댓글 달았어', 'Slack 게시했어', '일정 추가됐어', '상태 변경했어', '댓글 실행해?', '보냈어?', '올렸어?', '했어?', '회의 잡혔어?',
      '댓글 다는 법 알려줘', '게시 실행이 뭐야?', '파일 실행해', '테스트 실행해', '실행해', '댓글 실행', '댓글 실행해줘',
      `댓글 달았어? ${'긴 설명 '.repeat(10)}`, '',
    ]) {
      expect(connectorWriteOperationsNamedLoosely(text), text).toEqual([]);
    }
  });

  it('never overlaps an accepted execution phrase of any gate', () => {
    for (const gate of CONNECTOR_GATES) {
      for (const phrase of EXECUTION_PHRASES[gate]) expect(connectorWriteOperationsNamedLoosely(phrase), `${gate}: ${phrase}`).toEqual([]);
    }
  });
});

describe('isBareExecutionQuestionOrNegation (DET-2 sweep)', () => {
  it.each(['실행해도 돼?', '실행해도 될까', '실행할까?', '지금 실행해도 될까', '실행하지 마', '실행하지 마세요', '실행 안 해도 돼', '실행 가능해?', 'should I run it?', "don't run it"])(
    '%j matches and no gate accepts it',
    (text) => {
      expect(isBareExecutionQuestionOrNegation(text)).toBe(true);
      expect(isBareExecutionRequest(text)).toBe(false);
      expect(acceptedByConnectorGate(text)).toBe(false);
    },
  );

  it.each(['실행', '실행해줘', '실행했어', '실행 결과 알려줘', '파일 실행해도 돼?', '테스트 실행하지 마', '댓글 실행해도 돼?', '실행해도 돼? 그리고 테스트도', ''])(
    '%j does not match',
    (text) => {
      expect(isBareExecutionQuestionOrNegation(text)).toBe(false);
    },
  );
});

describe('isBareExecutionProhibition (Codex P2 on 5594c16)', () => {
  it('only the prohibitions withdraw; questions and "no need" forms only get the hint', () => {
    for (const text of ['실행하지 마', '실행하지 마세요', '지금 실행하지 말아 줘', '실행하면 안 돼', "don't run it", 'do not execute it']) {
      expect(isBareExecutionProhibition(text), text).toBe(true);
      expect(isBareExecutionQuestionOrNegation(text), text).toBe(true);
    }
    for (const text of ['실행해도 돼?', '실행할까?', '실행 안 해도 돼', '실행', '댓글 실행하지 마', '테스트 실행하지 마', '']) {
      expect(isBareExecutionProhibition(text), text).toBe(false);
    }
  });
});

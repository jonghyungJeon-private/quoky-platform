import { describe, expect, it } from 'vitest';
import { parseLearningCommand } from './learning-commands';

describe('parseLearningCommand (ADR-0107 D3 grammar)', () => {
  it.each([
    ['피드백 후보', { kind: 'list-candidates' }],
    ['  피드백 후보  ', { kind: 'list-candidates' }],
    ['피드백후보', { kind: 'list-candidates' }],
    ['피드백 후보 보여줘', { kind: 'list-candidates' }],
    ['예시 목록', { kind: 'list-examples' }],
    ['예시목록', { kind: 'list-examples' }],
    ['후보 2 메모: 일정 대신 날씨를 답했어', { kind: 'candidate-note', index: 2, note: '일정 대신 날씨를 답했어' }],
    ['후보 2번 메모：  너무 길어  ', { kind: 'candidate-note', index: 2, note: '너무 길어' }],
    ['후보 1 메모: 첫 줄\n둘째 줄', { kind: 'candidate-note', index: 1, note: '첫 줄\n둘째 줄' }],
    ['후보 3 예시로 저장', { kind: 'candidate-example', index: 3 }],
    ['후보 3번을 예시로 저장해줘', { kind: 'candidate-example', index: 3 }],
    ['후보 3 예시로 저장해 줘', { kind: 'candidate-example', index: 3 }],
    ['예시 1 수정: 이렇게 답하면 좋아요', { kind: 'example-edit', index: 1, answer: '이렇게 답하면 좋아요' }],
    ['예시 12 삭제', { kind: 'example-delete', index: 12 }],
    ['예시 4번 삭제해줘', { kind: 'example-delete', index: 4 }],
  ])('parses %j', (text, expected) => {
    expect(parseLearningCommand(text)).toEqual(expected);
  });

  it.each([
    '',
    '피드백 요약',
    '피드백 후보가 뭐야?',
    '예시 좀 들어줘',
    '예시 목록을 만들어줘',
    '후보 메모: 번호 없음',
    '후보 0 메모: 영번',
    '후보 1 메모:',
    '후보 1 메모:    ',
    '예시 1 수정:',
    '후보 1234 예시로 저장',
    '후보 1 예시로 저장하는 방법',
    '이 문장은 후보 1 메모: 로 시작하지 않아',
    '예시 1 삭제하지 마',
    '할 일 추가: 예시 목록 정리',
  ])('falls through for %j', (text) => {
    expect(parseLearningCommand(text)).toBeNull();
  });
});

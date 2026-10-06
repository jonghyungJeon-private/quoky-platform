import { describe, expect, it } from 'vitest';
import { parseMemoryCommand } from './memory-command-grammar';

describe('parseMemoryCommand — ADR-0106 D1 grammar', () => {
  it.each([
    ['기억 목록', { kind: 'list', page: 1, language: 'ko' }],
    ['기억목록', { kind: 'list', page: 1, language: 'ko' }],
    ['기억 목록 2', { kind: 'list', page: 2, language: 'ko' }],
    ['기억 목록 3페이지', { kind: 'list', page: 3, language: 'ko' }],
    ['내 기억 목록 보여줘', { kind: 'list', page: 1, language: 'ko' }],
    ['기억 목록?', { kind: 'list', page: 1, language: 'ko' }],
    ['내 기억 보여줘', { kind: 'list', page: 1, language: 'ko' }],
    ['저장된 기억들 보여주세요', { kind: 'list', page: 1, language: 'ko' }],
    ['list memories', { kind: 'list', page: 1, language: 'en' }],
    ['List my memories', { kind: 'list', page: 1, language: 'en' }],
    ['list memories page 2', { kind: 'list', page: 2, language: 'en' }],
    ['기억 3 보여줘', { kind: 'view', number: 3, language: 'ko' }],
    ['기억 3번 보여줘', { kind: 'view', number: 3, language: 'ko' }],
    ['기억3 보여주세요', { kind: 'view', number: 3, language: 'ko' }],
    ['show memory 3', { kind: 'view', number: 3, language: 'en' }],
    ['기억 2 잊어줘', { kind: 'forget', number: 2, language: 'ko' }],
    ['기억 2번 잊어 줘', { kind: 'forget', number: 2, language: 'ko' }],
    ['기억 2번을 삭제해줘', { kind: 'forget', number: 2, language: 'ko' }],
    ['기억 2 지워줘.', { kind: 'forget', number: 2, language: 'ko' }],
    ['forget memory 2', { kind: 'forget', number: 2, language: 'en' }],
    ['Delete memory #2', { kind: 'forget', number: 2, language: 'en' }],
    ['기억 확인 AB2C', { kind: 'confirm', code: 'AB2C', language: 'ko' }],
    ['기억 확인 ab2c', { kind: 'confirm', code: 'AB2C', language: 'ko' }],
    ['기억 확인: AB2C', { kind: 'confirm', code: 'AB2C', language: 'ko' }],
    ['기억 확인 코드 AB2C', { kind: 'confirm', code: 'AB2C', language: 'ko' }],
    ['기억 확인 ABCDE', { kind: 'confirm', code: 'ABCDE', language: 'ko' }],
    ['confirm memory ab2c', { kind: 'confirm', code: 'AB2C', language: 'en' }],
    ['기억 확인', { kind: 'usage', usage: 'confirm', language: 'ko' }],
    ['기억 2 수정', { kind: 'usage', usage: 'edit', number: 2, language: 'ko' }],
    ['기억 2 수정:', { kind: 'usage', usage: 'edit', number: 2, language: 'ko' }],
    ['edit memory 2', { kind: 'usage', usage: 'edit', number: 2, language: 'en' }],
    ['내 기억 다 지워줘', { kind: 'bulk-forget', language: 'ko' }],
    ['기억 전부 삭제해줘', { kind: 'bulk-forget', language: 'ko' }],
    ['모든 기억 잊어줘', { kind: 'bulk-forget', language: 'ko' }],
    ['forget all memories', { kind: 'bulk-forget', language: 'en' }],
    ['delete all my memories', { kind: 'bulk-forget', language: 'en' }],
    ['기억했어?', { kind: 'status', language: 'ko' }],
    ['방금 기억했어?', { kind: 'status', language: 'ko' }],
    ['기억 저장됐어?', { kind: 'status', language: 'ko' }],
    ['기억해 줬지', { kind: 'status', language: 'ko' }],
    ['did you remember that?', { kind: 'status', language: 'en' }],
  ] as const)('%s', (text, expected) => {
    expect(parseMemoryCommand(text)).toEqual(expected);
  });

  it('edit keeps the new text verbatim after the head (multi-line, with its own negations and colons)', () => {
    expect(parseMemoryCommand('기억 2 수정: 커피는 아메리카노')).toEqual({
      kind: 'edit',
      number: 2,
      text: '커피는 아메리카노',
      language: 'ko',
    });
    expect(parseMemoryCommand('기억 2번 수정해줘: 아침엔 커피 마시지 말기\n저녁: 차')).toEqual({
      kind: 'edit',
      number: 2,
      text: '아침엔 커피 마시지 말기\n저녁: 차',
      language: 'ko',
    });
    expect(parseMemoryCommand('기억 4 바꿔줘 : 새 내용')).toMatchObject({ kind: 'edit', number: 4, text: '새 내용' });
    expect(parseMemoryCommand('Edit memory 5: Prefer tea')).toEqual({
      kind: 'edit',
      number: 5,
      text: 'Prefer tea',
      language: 'en',
    });
  });

  it.each([
    // `기억해:` stays the runtime's explicit save (it runs before the pre-classify stage; the grammar never claims it).
    '기억해: 기억 목록',
    '기억해: 커피는 아메리카노',
    'remember: list memories',
    // How-to questions belong to the help-intent handler (400).
    '기억 어떻게 지워?',
    '기억 목록 어떻게 봐?',
    // Negated command heads.
    '기억 1 지우지 마',
    '기억 1 잊지 마',
    '기억 목록 보여주지 마',
    '기억 다 지우지 마',
    '기억 전부 삭제하지 마',
    // Sentences that merely mention memories, and to-do / reminder phrases.
    '기억 목록 정리하는 법 알려줘',
    '기억 목록을 매일 아침 9시에 알려줘',
    '할 일 추가: 기억 목록 정리',
    '30분 뒤에 기억 1 잊어줘 알려줘',
    '내 생일 기억해?',
    '기억했어',
    '기억나?',
    '어제 말한 거 기억했어?',
    '방금 내가 말한 거 기억해 줬지?',
    '기억력 좋아지는 법',
    '기억 0 잊어줘',
    'show memory',
    'forget it',
    'forget everything about python decorators',
    'do you remember me?',
    '',
    '   ',
  ])('falls through: %s', (text) => {
    expect(parseMemoryCommand(text)).toBeNull();
  });

  it('a long or multi-line message is never a command head', () => {
    expect(parseMemoryCommand(`기억 목록 ${'아'.repeat(80)}`)).toBeNull();
    expect(parseMemoryCommand('기억 목록\n보여줘')).toBeNull();
  });
});

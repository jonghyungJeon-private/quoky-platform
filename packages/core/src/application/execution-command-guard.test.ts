import { describe, expect, it } from 'vitest';
import { executionCommandRejection, isAffirmativeExecutionCommand, MAX_EXECUTION_COMMAND_CHARS } from './execution-command-guard';

describe('isAffirmativeExecutionCommand (Codex wave-8 re-review)', () => {
  it.each([
    // documented next-step phrases (composer / help copy)
    '커밋 실행', '푸시 실행', 'PR 생성 실행', '머지해줘', 'main 동기화해줘', '브랜치 정리해줘', '원격 브랜치 삭제 실행해줘',
    '패치 적용해줘', '테스트 실행해줘', '타입체크 실행해줘',
    // accepted variants
    '승인된 커밋 실행해줘', '이제 실제 커밋해줘', 'execute commit', 'commit approved changes', 'run approved commit',
    '승인된 push 실행해줘', 'execute approved push', 'push approved commit', 'PR 만들어줘', 'open a PR', 'create pull request',
    '이 PR 머지해줘', 'merge this PR', 'merge approved PR', 'execute approved merge', 'merge now', '머지된 main 받아와줘',
    'sync main', 'update local main', 'delete local merged branch', 'cleanup local branch', '원격 브랜치 제거 실행해줘',
    '실행해줘', '진행해', 'proceed', 'go ahead', 'do it', 'apply patch', '최종 적용해줘',
  ])('"%s" → affirmative', (text) => {
    expect(executionCommandRejection(text)).toBeNull();
    expect(isAffirmativeExecutionCommand(text)).toBe(true);
  });

  it.each([
    ['푸시 실행해도 돼?', 'question'],
    ['푸시 실행해도 돼', 'question'],
    ['main 동기화해도 돼?', 'question'],
    ['커밋 실행할까', 'question'],
    ['머지해도 될까', 'question'],
    ['PR 생성 실행하나요', 'question'],
    ['머지 되나', 'question'],
    ['should I execute commit', 'question'],
    ['can we merge now', 'question'],
    ['is it ok to push', 'question'],
    ['main 동기화하지 마', 'negation'],
    ['브랜치 정리하지 말아줘', 'negation'],
    ['커밋 실행 안 해', 'negation'],
    ['do not execute approved merge', 'negation'],
    ["don't delete local branch", 'negation'],
    ['never apply patch', 'negation'],
    ['푸시 실행 취소', 'negation'],
    ['커밋 실행 중지', 'negation'],
    ['푸시 실행했어', 'past-or-statement'],
    ['브랜치 정리 완료', 'past-or-statement'],
    ['이미 머지 실행', 'past-or-statement'],
    ['merge was executed', 'past-or-statement'],
    ['commit already done', 'past-or-statement'],
    ['원격 브랜치 삭제 실행됐어', 'past-or-statement'],
    ['"커밋 실행"이라고 하면 뭐가 돼', 'question'],
    ['"커밋 실행"이라고 보내라던데', 'reported-or-hypothetical'],
    ['커밋 실행하면 파일이 바뀌나', 'reported-or-hypothetical'],
    ['main 동기화하면 좋겠어', 'reported-or-hypothetical'],
    ['푸시 실행 방법 알려줘', 'reported-or-hypothetical'],
    ['머지 실행 로그 요약해줘', 'reported-or-hypothetical'],
    ['he said merge now', 'reported-or-hypothetical'],
    ['merge if CI passes', 'reported-or-hypothetical'],
    ['', 'empty'],
    ['   ', 'empty'],
  ])('"%s" → rejected (%s)', (text, reason) => {
    expect(executionCommandRejection(text)).toBe(reason);
    expect(isAffirmativeExecutionCommand(text)).toBe(false);
  });

  it('long free text is never an execution command', () => {
    expect(executionCommandRejection(`커밋 실행해줘 ${'가'.repeat(MAX_EXECUTION_COMMAND_CHARS)}`)).toBe('too-long');
  });

  it('a non-string input is rejected', () => {
    expect(isAffirmativeExecutionCommand(undefined as unknown as string)).toBe(false);
  });
});

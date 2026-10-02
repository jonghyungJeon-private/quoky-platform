import { describe, expect, it } from 'vitest';
import {
  documentedExecutionPhrase,
  EXECUTION_PHRASES,
  executionCommandRejection,
  type ExecutionGate,
  isAcceptedExecutionPhrase,
  isAffirmativeExecutionCommand,
  MAX_EXECUTION_COMMAND_CHARS,
  normalizeExecutionPhrase,
} from './execution-command-guard';

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

describe('execution allow-list (orchestrator decision after the Codex wave-8 reviews)', () => {
  const GATES = Object.keys(EXECUTION_PHRASES) as ExecutionGate[];

  it('the documented phrase is the first entry of each gate', () => {
    expect(GATES.map((g) => [g, documentedExecutionPhrase(g)])).toEqual([
      ['commit', '커밋 실행'],
      ['push', '푸시 실행'],
      ['prCreate', 'PR 생성 실행'],
      ['merge', '머지해줘'],
      ['mainSync', 'main 동기화해줘'],
      ['localCleanup', '브랜치 정리해줘'],
      ['remoteCleanup', '원격 브랜치 삭제 실행해줘'],
      ['patchApply', '패치 적용해줘'],
      ['validationTest', '테스트 실행해줘'],
      ['validationTypecheck', '타입체크 실행해줘'],
    ]);
  });

  it('every entry is accepted by its own gate, passes the affirmative veto, and by NO other gate', () => {
    for (const gate of GATES) {
      for (const phrase of EXECUTION_PHRASES[gate]) {
        expect(isAffirmativeExecutionCommand(phrase), phrase).toBe(true);
        expect(isAcceptedExecutionPhrase(gate, phrase), `${gate}: ${phrase}`).toBe(true);
        for (const other of GATES.filter((g) => g !== gate)) {
          expect(isAcceptedExecutionPhrase(other, phrase), `${other} must not accept ${phrase}`).toBe(false);
        }
      }
    }
  });

  it.each([
    ['  커밋   실행  ', '커밋 실행'],
    ['푸시 실행!', '푸시 실행'],
    ['머지해줘~', '머지해줘'],
    ['원격 브랜치 삭제 실행 해줘', '원격 브랜치 삭제 실행해줘'],
    ['원격 브랜치 삭제 실행해 줘', '원격 브랜치 삭제 실행해줘'],
    ['원격 브랜치 삭제 실행해 주세요', '원격 브랜치 삭제 실행해줘'],
    ['원격 브랜치 삭제 실행해줘요.', '원격 브랜치 삭제 실행해줘'],
    ['PR 만들어 주세요', 'pr 만들어줘'],
    ['Merge This PR', 'merge this pr'],
  ])('normalizes "%s" → "%s"', (text, normalized) => {
    expect(normalizeExecutionPhrase(text)).toBe(normalized);
  });

  it.each([
    ['commit', '이제 실제 커밋해줘'],
    ['push', '지금 푸시 실행'],
    ['merge', 'merge this PR now'],
    ['merge', 'now merge this PR'],
    ['remoteCleanup', 'proceed please'],
    ['mainSync', 'sync main please'],
    ['remoteCleanup', '지금 원격 브랜치 삭제해줘'],
  ] as const)('%s accepts the optional leading/trailing word in "%s"', (gate, text) => {
    expect(isAcceptedExecutionPhrase(gate, text)).toBe(true);
  });

  it.each([
    // Codex final-check repros (each was one mutation before the allow-list)
    ['push', '푸시 실행할 필요 없어'],
    ['localCleanup', '브랜치 정리할 필요 없어'],
    ['mainSync', 'main 동기화해도 좋을까'],
    ['merge', 'merge the config files now'],
    ['remoteCleanup', '원격 브랜치 백업 파일 삭제 실행해줘'],
    // earlier rounds
    ['push', '푸시 실행해도 돼?'],
    ['push', '푸시 실행했어'],
    ['merge', 'do not execute approved merge'],
    ['mainSync', 'main 동기화하지 마'],
    ['localCleanup', 'do not delete local branch'],
    ['remoteCleanup', 'delete the file now'],
    ['remoteCleanup', 'execute approved push'],
    // the bare step word / an optional word alone is never a command
    ['merge', 'merge'],
    ['merge', '머지'],
    ['remoteCleanup', '지금'],
    ['remoteCleanup', 'now'],
    ['remoteCleanup', '원격 브랜치 삭제해줘'],
    ['commit', '커밋해줘'],
    ['commit', '승인된 커밋 실행해줘 메시지는 "feat: x"'],
    ['prCreate', 'PR'],
    ['patchApply', '적용해줘'],
    ['validationTest', '테스트'],
  ] as const)('%s rejects "%s"', (gate, text) => {
    expect(isAcceptedExecutionPhrase(gate, text)).toBe(false);
  });
});

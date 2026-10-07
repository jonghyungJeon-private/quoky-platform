import { describe, expect, it } from 'vitest';
import { isGitConceptQuestion, isGitTopicOnlyMention } from './git-request-shape';

describe('isGitConceptQuestion (live QA 2026-10-07)', () => {
  it.each([
    'git rebase와 merge 차이를 간단히 설명해줘',
    'rebase와 merge 차이',
    '머지랑 리베이스 차이가 뭐야?',
    '머지 전략 비교해줘',
    'merge conflict 해결법 알려줘',
    '머지 충돌 해결하는 법',
    'git merge 설명해줘',
    'merge가 뭐야',
    '머지가 뭐예요?',
    'merge란?',
    'rebase란',
    'squash merge는 무슨 뜻이야',
    'git merge는 어떻게 동작해?',
    'fast-forward 병합 원리',
    'PR 만드는 방법 알려줘',
    'cherry-pick은 언제 써?',
    'checkout과 switch 차이',
    "what's the difference between rebase and merge",
    'what is a merge commit?',
    'explain git merge',
    'how do I resolve a merge conflict',
    'rebase vs merge',
    'merge strategy pros and cons',
  ])('%s → concept question', (text) => {
    expect(isGitConceptQuestion(text)).toBe(true);
    expect(isGitTopicOnlyMention(text)).toBe(true);
  });

  it.each([
    'PR 머지해줘',
    '머지해줘',
    '병합해줘',
    'merge the PR',
    'main에 머지해줘',
    '머지 승인해줘',
    'approve merge',
    '푸시해줘',
    'PR 만들어줘',
    'main 동기화해줘',
    '브랜치 정리해줘',
    '원격 브랜치 삭제해줘',
    '커밋해줘',
    // status asks keep the deterministic read-only status replies
    'PR 상태가 뭐야?',
    'CI 결과 설명해줘',
    '머지 어떻게 됐어?',
    '머지됐어?',
    'what is the status of the PR?',
    '머지 가능해?',
    '',
  ])('%j → not a concept question', (text) => {
    expect(isGitConceptQuestion(text)).toBe(false);
  });
});

describe('isGitTopicOnlyMention (live QA 2026-10-07)', () => {
  it.each(['머지 로그 요약해줘', '푸시 로직을 검토해줘', 'git push 명령을 한국어로 번역해줘', '머지 관련 문서 작성해줘', 'summarize the merge log', 'review the push logic'])(
    '%s → a request whose own verb is a non-git one',
    (text) => {
      expect(isGitTopicOnlyMention(text)).toBe(true);
    },
  );

  it.each(['머지하고 릴리즈 노트 작성해줘', 'PR 만들고 설명 작성해줘', '푸시하고 결과 요약해줘', 'review and merge this PR', '머지해줘', '배포해줘', '브랜치 삭제하고 로그 요약해줘'])(
    '%s → a git operation verb is attached, so it is not topic-only',
    (text) => {
      expect(isGitTopicOnlyMention(text)).toBe(false);
    },
  );
});

import { describe, expect, it } from 'vitest';
import { hasAttachedGitOperation, isChainCompanionRequest, isGitConceptQuestion, isGitTopicOnlyMention } from './git-request-shape';

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

describe('Codex review of f45ab9d — word boundaries, clause precedence and status priority', () => {
  it.each(['차이나 서버 변경을 푸시해줘', '차이콥스키 PR 머지해줘', '비교적 오래된 원격 브랜치 삭제해줘', '설명서 업데이트 커밋해줘', '무방법 PR 만들어줘'])(
    '%s → a marker inside another word is not a concept marker',
    (text) => {
      expect(isGitConceptQuestion(text)).toBe(false);
      expect(isGitTopicOnlyMention(text)).toBe(false);
    },
  );

  it.each(['rebase와 merge 차이', '차이가 뭐야', '차이를 알려줘', '차이점이 있어?', 'merge 방법을 알려줘', 'squash 머지의 의미가 뭐야'])(
    '%s → a whole marker word (with a particle) still counts',
    (text) => {
      expect(isGitConceptQuestion(text)).toBe(true);
    },
  );

  it.each(['머지해줘. 그리고 rebase와 차이를 설명해줘', '머지해줘, rebase와 차이도 설명해줘', '머지하고 rebase와 차이를 설명해줘', 'merge the PR and explain rebase'])(
    '%s → an attached git imperative in another clause keeps the action handling',
    (text) => {
      expect(hasAttachedGitOperation(text)).toBe(true);
      expect(isGitConceptQuestion(text)).toBe(false);
      expect(isGitTopicOnlyMention(text)).toBe(false);
    },
  );

  it.each(["what's the difference between rebase and merge", 'how to create a branch and merge it', '머지하는 방법 설명해줘', 'PR 만드는 법 알려줘'])(
    '%s → one question clause, no attached imperative',
    (text) => {
      expect(hasAttachedGitOperation(text)).toBe(false);
      expect(isGitConceptQuestion(text)).toBe(true);
    },
  );

  it.each(['PR 리뷰 어떻게 하는지 알려줘', 'code review 방법 설명해줘', '리뷰어와 리뷰의 차이'])(
    '%s → a review noun alone is not a status predicate (Codex re-review of 63ab7a0)',
    (text) => {
      expect(isGitConceptQuestion(text)).toBe(true);
    },
  );

  it.each(['머지 가능한지 설명해줘', 'PR 리뷰 어때? 문제점 설명해줘', '머지 상태 설명해줘', 'CI 결과가 뭐야?', '머지됐는지 설명해줘'])(
    '%s → a status ask keeps priority over the concept guard',
    (text) => {
      expect(isGitConceptQuestion(text)).toBe(false);
    },
  );
});

describe('isChainCompanionRequest (live QA 2026-10-07, LRN-2 at PR_CREATED)', () => {
  it.each(['배포해줘', 'release 해줘', '릴리즈 진행해', '리뷰어 추가해줘', '리뷰어 alice 지정해줘', '라벨 붙여줘', '담당자 지정해줘', 'auto merge 켜줘', 'enable auto-merge', 'deploy it', '배포', '머지', 'auto merge', 'PR 만들고 배포하자', 'merge PR #42', 'merge the pr', 'merge it', 'merge #42', 'PR #42 머지', '이 PR 머지', 'please merge this PR into main', 'merge my PR now', 'merge the pull request.', 'merge the branch', 'merge pull request #7', 'PR main에 머지', '#42 병합'])(
    '%s → a companion request',
    (text) => {
      expect(isChainCompanionRequest(text)).toBe(true);
    },
  );

  it.each([
    '예시 1 수정: 1) 결정 사항을 맨 위에 적어요. 2) 할 일은 담당자와 기한을 함께 적어요. 3) 논의 과정은 한두 줄로 줄여요.',
    '할 일은 담당자와 기한을 함께 적어요',
    '배포 일정 회의록',
    '라벨 디자인 아이디어',
    '리뷰어 후보가 너무 많네',
    '오늘 머지 회의는 길었어',
    '머지 충돌 해결해줘',
    'merge conflicts are annoying',
    'merge strategy for monorepos',
    'Merge failed with conflicts',
    'merge failed yesterday',
    'merge sort algorithm',
    'merge conflict 해결법',
    'merge commit이 뭐야',
    'merge it later after lunch',
    'merge the PR description into the doc',
    'PR #42 머지 로그',
    '',
  ])('%j → free text that merely contains a companion noun', (text) => {
    expect(isChainCompanionRequest(text)).toBe(false);
  });
});

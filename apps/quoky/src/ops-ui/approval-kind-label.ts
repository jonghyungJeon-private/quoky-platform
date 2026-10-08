import type { ApprovalGateKind } from '@quoky/core';

/**
 * The fixed Korean label of each approval decision kind (ADR-0113 D7). The approvals list and the confirmation page
 * both name a pending approval with this one map over the Core `ApprovalGateKind` (live QA D7: the list said
 * "미지정" while the page said "커넥터 쓰기").
 */
export const APPROVAL_KIND_LABEL: Readonly<Record<ApprovalGateKind, string>> = {
  PLAN: '코드 변경 계획',
  CREDENTIAL_OVERRIDE: '비밀값 검사 예외 (1회)',
  CONNECTOR_WRITE: '커넥터 쓰기',
  APPLY: '파일 적용',
  COMMIT: '커밋',
  PUSH: '푸시',
  PR: 'PR 생성',
  MERGE: 'PR 머지',
  REMOTE_BRANCH_CLEANUP: '원격 브랜치 삭제',
};

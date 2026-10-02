import { describe, expect, it } from 'vitest';
import { ConversationRuntime } from './conversation-runtime';

// Sprint 4c-Follow-up (ADR-0062 draft): the pre-classification mutation gates are negation-aware. A NEGATED
// mutation token ("커밋하지 마", "do not push") must NOT trigger the gate; a genuine (non-negated) request is
// unchanged. These gates are pure static matchers, so they are unit-testable directly.
describe('ConversationRuntime negation-aware mutation gates', () => {
  describe('interpretCommitIntent', () => {
    it('a negated commit request is not a commit intent', () => {
      expect(ConversationRuntime.interpretCommitIntent('커밋하지 마')).toBeNull();
      expect(ConversationRuntime.interpretCommitIntent('do not commit')).toBeNull();
    });
    it('P5: a preview-only request prohibiting commit/push is not a commit intent', () => {
      expect(
        ConversationRuntime.interpretCommitIntent(
          'diff preview only. do not run pnpm test. do not commit. do not push.',
        ),
      ).toBeNull();
    });
    it('R1: a genuine commit request is unchanged', () => {
      expect(ConversationRuntime.interpretCommitIntent('커밋해줘')).toBe('commit');
    });
    it('R2: a genuine commit-with-forbidden-companion is unchanged', () => {
      expect(ConversationRuntime.interpretCommitIntent('커밋하고 푸시해줘')).toBe('commit-with-forbidden');
    });
  });

  describe('interpretPushIntent', () => {
    it('a negated push request is not a push intent', () => {
      expect(ConversationRuntime.interpretPushIntent('푸시하지 마')).toBeNull();
      expect(ConversationRuntime.interpretPushIntent('do not push')).toBeNull();
    });
    it('R4: a genuine push request is unchanged', () => {
      expect(ConversationRuntime.interpretPushIntent('푸시해줘')).toBe('push');
    });
  });

  describe('interpretApplyIntent / interpretFinalApplyIntent', () => {
    it('a negated apply request is not an apply intent', () => {
      expect(ConversationRuntime.interpretApplyIntent('적용하지 마')).toBe(false);
      expect(ConversationRuntime.interpretFinalApplyIntent('파일에 적용하지 마')).toBe(false);
    });
    it('R5/R7: a genuine apply request is unchanged', () => {
      expect(ConversationRuntime.interpretApplyIntent('적용해줘')).toBe(true);
      expect(ConversationRuntime.interpretFinalApplyIntent('파일에 적용해줘')).toBe(true);
    });
  });

  describe('interpretPrIntent', () => {
    it('a negated PR request is not a PR intent', () => {
      expect(ConversationRuntime.interpretPrIntent('PR 만들지 마')).toBeNull();
      expect(ConversationRuntime.interpretPrIntent('do not create a PR')).toBeNull();
    });
    it('a genuine PR-creation request is unchanged', () => {
      expect(ConversationRuntime.interpretPrIntent('PR 만들어줘')).toBe('create');
    });
  });

  describe('interpretPostApplyValidationIntent', () => {
    it('a negated test/validation request is not a validation run', () => {
      expect(ConversationRuntime.interpretPostApplyValidationIntent('테스트 실행하지 마')).toBeNull();
      expect(ConversationRuntime.interpretPostApplyValidationIntent('do not run pnpm test')).toBeNull();
    });
    it('a genuine validation request is unchanged', () => {
      expect(ConversationRuntime.interpretPostApplyValidationIntent('테스트 실행해줘')).toBe('test');
    });
  });

  describe('interpretDecision (delegates to interpretApprovalDecision)', () => {
    it('a negated approve phrase never approves', () => {
      for (const text of ['진행하지 마', '승인하지 마', "don't approve", 'do not approve']) {
        expect(ConversationRuntime.interpretDecision(text), text).not.toBe('approve');
      }
    });
    it('genuine decisions are unchanged', () => {
      expect(ConversationRuntime.interpretDecision('승인')).toBe('approve');
      expect(ConversationRuntime.interpretDecision('진행해')).toBe('approve');
      expect(ConversationRuntime.interpretDecision('거절')).toBe('deny');
      expect(ConversationRuntime.interpretDecision('취소')).toBe('cancel');
    });
    it('bare "y" and a question are ambiguous', () => {
      expect(ConversationRuntime.interpretDecision('y')).toBe('ambiguous');
      expect(ConversationRuntime.interpretDecision('진행할까?')).toBe('ambiguous');
    });
  });
});

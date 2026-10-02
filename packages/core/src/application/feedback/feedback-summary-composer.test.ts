import { describe, expect, it } from 'vitest';
import { Capability, FeedbackSignalKind, IntentType } from '../../domain';
import type { FeedbackSummary } from '../../domain';
import {
  FEEDBACK_SUMMARY_EMPTY_TEXT,
  FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS,
  FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS,
  FEEDBACK_SUMMARY_UNAVAILABLE_TEXT,
  composeFeedbackSummaryText,
  feedbackCapabilityLabel,
  feedbackIntentLabel,
  feedbackRequestExcerpt,
} from './feedback-summary-composer';

function summary(over: Partial<FeedbackSummary> = {}): FeedbackSummary {
  return {
    since: '2026-09-02T00:00:00.000Z',
    turnCount: 4,
    signals: [
      { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'NEGATIVE', count: 1 },
      { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'POSITIVE', count: 2 },
      { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'RETRACTED', count: 1 },
      { kind: FeedbackSignalKind.IMPLICIT_RESET_AFTER_REPLY, value: 'OBSERVED', count: 1 },
      { kind: FeedbackSignalKind.IMPLICIT_REPHRASE, value: 'OBSERVED', count: 2 },
    ],
    byCapability: [
      { key: Capability.GENERAL_CHAT, turns: 3, positive: 2, negative: 1, implicit: 3 },
      { key: null, turns: 1, positive: 0, negative: 0, implicit: 0 },
    ],
    byIntent: [{ key: IntentType.CHAT, turns: 4, positive: 2, negative: 1, implicit: 3 }],
    recentNegative: [
      { turnId: 'turn-9', createdAt: '2026-10-01T23:59:00.000Z', intentType: IntentType.CHAT, taskId: 'task-9' },
    ],
    ...over,
  };
}

describe('composeFeedbackSummaryText (ADR-0098 D6)', () => {
  it('renders totals, breakdowns and the recent 👎 list with the request excerpt', () => {
    const text = composeFeedbackSummaryText(summary(), new Map([['task-9', '배포 창을 알려줘']]));
    expect(text).toContain('최근 30일 피드백 요약이에요.');
    expect(text).toContain('- 기록된 대화 4건 · 👍 2 · 👎 1 · 참고 신호 3');
    expect(text).toContain('기능별:');
    expect(text).toContain('- 일반 대화: 대화 3건 · 👍 2 · 👎 1 · 참고 신호 3');
    expect(text).toContain('- 기타: 대화 1건');
    expect(text).toContain('요청 유형별:');
    expect(text).not.toMatch(/GENERAL_CHAT|CHAT/u);
    expect(text).toContain('최근 👎 답변:');
    expect(text).toContain('- 2026-10-01 · 일반 대화 · "배포 창을 알려줘"');
  });

  it('never renders a provider id, a turn id or a run id', () => {
    const text = composeFeedbackSummaryText(summary(), new Map([['task-9', 'q']]));
    expect(text).not.toMatch(/provider|claude|ollama|turn-9|run-/iu);
  });

  it('maps every capability and intent enum to a Korean label and falls back safely', () => {
    for (const key of Object.values(Capability)) expect(feedbackCapabilityLabel(key)).not.toMatch(/^[A-Z_]+$/u);
    for (const key of Object.values(IntentType)) expect(feedbackIntentLabel(key)).not.toMatch(/^[A-Z_]+$/u);
    expect(feedbackCapabilityLabel(Capability.POLICY_SENSITIVE_CHAT)).toBe('위험 민감 대화');
    expect(feedbackCapabilityLabel(Capability.PROJECT_ANALYSIS)).toBe('프로젝트 분석');
    expect(feedbackCapabilityLabel(Capability.SUMMARIZATION)).toBe('요약');
    expect(feedbackCapabilityLabel('claude-cli')).toBe('기타');
    expect(feedbackCapabilityLabel('toString')).toBe('기타');
    expect(feedbackIntentLabel(undefined)).toBe('기타');
    expect(feedbackIntentLabel('ollama-local')).toBe('기타');
  });

  it('a retraction is neither positive nor negative', () => {
    const text = composeFeedbackSummaryText(summary({
      signals: [{ kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'RETRACTED', count: 5 }],
    }));
    expect(text).toContain('👍 0 · 👎 0 · 참고 신호 0');
  });

  it('answers with fixed copy for an empty window and for an unreadable store', () => {
    expect(composeFeedbackSummaryText(summary({ turnCount: 0 }))).toBe(FEEDBACK_SUMMARY_EMPTY_TEXT);
    expect(composeFeedbackSummaryText(null)).toBe(FEEDBACK_SUMMARY_UNAVAILABLE_TEXT);
  });

  it('bounds the breakdown rows', () => {
    const rows = Array.from({ length: FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS + 3 }, (_, i) => ({
      key: i === 0 ? Capability.CODE_IMPLEMENTATION : `K${i}`, turns: i + 1, positive: 0, negative: 0, implicit: 0,
    }));
    const text = composeFeedbackSummaryText(summary({ byCapability: rows, byIntent: [], recentNegative: [] }));
    expect(text).toContain('- 코드 작업: 대화 1건');
    expect(text).toContain(`대화 ${FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS}건`);
    expect(text).not.toContain(`대화 ${FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS + 1}건`);
    expect(text).toContain('- 외 3개');
  });

  it('shows a placeholder when the Task text is unavailable', () => {
    const text = composeFeedbackSummaryText(summary());
    expect(text).toContain('(요청 내용을 찾을 수 없어요)');
  });
});

describe('feedbackRequestExcerpt', () => {
  it(`truncates to ${FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS} code points and collapses whitespace`, () => {
    const long = `${'가'.repeat(70)}`;
    expect(feedbackRequestExcerpt(long)).toBe(`"${'가'.repeat(FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS)}…"`);
    expect(feedbackRequestExcerpt('한 줄\n\n  두 줄\t세 줄')).toBe('"한 줄 두 줄 세 줄"');
  });

  it('suppresses a request that matches the credential guard', () => {
    const excerpt = feedbackRequestExcerpt('이 키 써줘 ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(excerpt).toBe('(민감한 내용일 수 있어 표시하지 않아요)');
    expect(excerpt).not.toContain('ghp_');
  });

  it('neutralises mentions and code fences', () => {
    const excerpt = feedbackRequestExcerpt('@everyone `rm` 해줘');
    expect(excerpt).not.toContain('@everyone');
    expect(excerpt).not.toContain('`');
  });
});

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
  feedbackTrendLines,
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

describe('feedbackTrendLines (ADR-0107 D3 trend line)', () => {
  const row = (key: string | null, turns: number, negative: number) => ({ key, turns, positive: 0, negative, implicit: 0 });

  it('shows the 👎 rate per capability, this 30 days against the previous 30, with the direction', () => {
    const lines = feedbackTrendLines({
      current: [row(Capability.GENERAL_CHAT, 20, 2), row(Capability.SUMMARIZATION, 4, 2), row(null, 3, 0)],
      previous: [row(Capability.GENERAL_CHAT, 10, 2), row(Capability.SUMMARIZATION, 4, 1), row(Capability.CODE_REVIEW, 2, 1)],
    });
    expect(lines).toEqual([
      '👎 비율 추이(최근 30일 · 이전 30일):',
      '- 일반 대화: 10% (👎 2/20) · 이전 20% (👎 2/10) · 개선',
      '- 요약: 50% (👎 2/4) · 이전 25% (👎 1/4) · 악화',
      '- 기타: 0% (👎 0/3) · 이전 - · 비교 불가',
      '- 코드 리뷰: - · 이전 50% (👎 1/2) · 비교 불가',
    ]);
  });

  it('compares exact ratios, not rounded percentages, and is empty without turns', () => {
    expect(feedbackTrendLines({ current: [row(Capability.GENERAL_CHAT, 3, 1)], previous: [row(Capability.GENERAL_CHAT, 6, 2)] }))
      .toContain('- 일반 대화: 33% (👎 1/3) · 이전 33% (👎 2/6) · 같음');
    expect(feedbackTrendLines({ current: [], previous: [] })).toEqual([]);
    expect(feedbackTrendLines(null)).toEqual([]);
    expect(feedbackTrendLines(undefined)).toEqual([]);
  });

  it('bounds the rows like the breakdowns', () => {
    const keys = Object.values(Capability);
    const lines = feedbackTrendLines({ current: keys.map((key) => row(key, 1, 0)), previous: [] });
    expect(lines).toHaveLength(1 + FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS + 1);
    expect(lines.at(-1)).toBe(`- 외 ${keys.length - FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS}개`);
  });

  it('the summary includes the trend after the capability breakdown, and is unchanged without one', () => {
    const base = composeFeedbackSummaryText(summary());
    expect(composeFeedbackSummaryText(summary(), new Map(), null)).toBe(base);
    const withTrend = composeFeedbackSummaryText(summary(), new Map(), {
      current: [row(Capability.GENERAL_CHAT, 3, 1)], previous: [row(Capability.GENERAL_CHAT, 2, 1)],
    });
    expect(withTrend).toContain('기능별:');
    expect(withTrend).toContain('👎 비율 추이(최근 30일 · 이전 30일):\n- 일반 대화: 33% (👎 1/3) · 이전 50% (👎 1/2) · 개선');
    expect(withTrend.indexOf('기능별:')).toBeLessThan(withTrend.indexOf('👎 비율 추이'));
    expect(withTrend.indexOf('👎 비율 추이')).toBeLessThan(withTrend.indexOf('요청 유형별:'));
  });

  it('the footer says text is stored only when the owner chooses it', () => {
    const text = composeFeedbackSummaryText(summary());
    expect(text).toContain('답변 방식이 자동으로 바뀌지는 않아요');
    expect(text).toContain('직접 고른 것만 이 기기에 저장해요');
  });
});

describe('feedbackRequestExcerpt strict guard (Codex wave-2 follow-up)', () => {
  it('hides file-content credentials such as const dbPassword = "…"', () => {
    const excerpt = feedbackRequestExcerpt('const dbPassword = "SYNTHETIC_ONLY" 이거 고쳐줘');
    expect(excerpt).not.toContain('SYNTHETIC_ONLY');
    expect(excerpt).not.toContain('dbPassword');
  });
});

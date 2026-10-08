import { Capability, FeedbackSignalKind, IntentType } from '../../domain';
import type { FeedbackBreakdownRow, FeedbackSummary, Id } from '../../domain';
import type { FeedbackCapabilityTrend } from './feedback-recorder';
import { containsCredentialFileContent, containsCredentialMaterial } from '../credential-guard';

/**
 * `피드백 요약` reply text (ADR-0098 D6, QUAL-4). Pure and deterministic: no provider, no storage, no clock.
 *
 * The input {@link FeedbackSummary} carries counts and ids only — never a provider id — and the only text shown
 * is the owner's own Task request, truncated and passed through the credential guard. Copy is fixed Korean.
 */

/** Request excerpts are cut to this many characters (code points), ADR-0098 D6. */
export const FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS = 60;
/** Upper bound on breakdown rows shown per section; the rest are folded into one "외 N개" line. */
export const FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS = 8;

export const FEEDBACK_SUMMARY_UNAVAILABLE_TEXT = '피드백 요약을 지금 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
export const FEEDBACK_SUMMARY_EMPTY_TEXT =
  '최근 30일 동안 기록된 대화가 없어요. 답변에 👍/👎 반응을 남기면 여기에서 확인할 수 있어요.';
/** What a request excerpt shows instead of a guarded request (never a redacted copy). */
export const FEEDBACK_SUPPRESSED_EXCERPT = '(민감한 내용일 수 있어 표시하지 않아요)';
const SUPPRESSED_EXCERPT = FEEDBACK_SUPPRESSED_EXCERPT;
const MISSING_EXCERPT = '(요청 내용을 찾을 수 없어요)';
const FOOTER =
  '피드백은 품질 확인용 기록이며 답변 방식이 자동으로 바뀌지는 않아요. 메시지 내용은 "후보 N 메모"나 "예시로 저장"으로 직접 고른 것만 이 기기에 저장해요.';

/** Task request text by Task id, for the recent 👎 turns; a missing id shows a neutral placeholder. */
export type FeedbackRequestExcerpts = ReadonlyMap<Id, string>;

function countOf(summary: FeedbackSummary, predicate: (kind: FeedbackSignalKind, value: string) => boolean): number {
  return summary.signals.reduce((total, row) => (predicate(row.kind, row.value) ? total + row.count : total), 0);
}

/**
 * One request excerpt: whitespace collapsed, at most {@link FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS} code points, mentions
 * neutralised (`@` → `@` + U+200B so a quoted `@everyone` never pings), and fully suppressed when the strict
 * credential guard (chat + file-content detectors) matches the original request.
 */
export function feedbackRequestExcerpt(text: string | undefined): string {
  if (text === undefined) return MISSING_EXCERPT;
  // Strict check (chat + file-content detectors): a 👎 summary must never show `const dbPassword = "…"` verbatim.
  if (containsCredentialMaterial(text) || containsCredentialFileContent(text)) return SUPPRESSED_EXCERPT;
  const flat = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (flat.length === 0) return MISSING_EXCERPT;
  const chars = [...flat];
  const cut = chars.length > FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS
    ? `${chars.slice(0, FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS).join('')}…`
    : flat;
  return `"${cut.replace(/@/gu, '@​').replace(/`/gu, "'")}"`;
}

const CAPABILITY_LABEL_KO: Readonly<Record<string, string>> = {
  [Capability.GENERAL_CHAT]: '일반 대화',
  [Capability.POLICY_SENSITIVE_CHAT]: '위험 민감 대화',
  [Capability.SUMMARIZATION]: '요약',
  [Capability.DOCUMENT_ANALYSIS]: '문서 분석',
  [Capability.CODE_IMPLEMENTATION]: '코드 작업',
  [Capability.CODE_REVIEW]: '코드 리뷰',
  [Capability.ARCHITECTURE_PLANNING]: '설계 계획',
  [Capability.TEST_EXECUTION]: '테스트 실행',
  [Capability.READONLY_LOOKUP]: '조회',
  [Capability.PROJECT_ANALYSIS]: '프로젝트 분석',
  [Capability.EMBEDDING]: '임베딩',
  [Capability.IMAGE_UNDERSTANDING]: '이미지 이해',
};

/**
 * A breakdown row whose turn recorded no capability / intent: a command or another deterministic reply that ran no
 * work task (live QA D8: it shared the "기타" label with an unlabelled capability, so two rows read "기타").
 */
export const FEEDBACK_NO_WORK_LABEL = '명령·바로 답한 대화';

const INTENT_LABEL_KO: Readonly<Record<string, string>> = {
  [IntentType.CHAT]: '일반 대화',
  [IntentType.SUMMARIZE]: '요약',
  [IntentType.ANALYZE_DOCUMENT]: '문서 분석',
  [IntentType.IMPLEMENT_CODE]: '코드 작업',
  [IntentType.REVIEW_CODE]: '코드 리뷰',
  [IntentType.PLAN_ARCHITECTURE]: '설계 계획',
  [IntentType.RUN_TESTS]: '테스트 실행',
  [IntentType.LOOKUP]: '조회',
  [IntentType.REGISTER_PROJECT]: '프로젝트 등록',
  [IntentType.PROJECT_ANALYSIS]: '프로젝트 분석',
  [IntentType.UNKNOWN]: '기타',
};

/** Korean label for a capability key; unknown or missing keys fall back to `기타` (never the raw enum or an id). */
export function feedbackCapabilityLabel(key: string | null | undefined): string {
  return (key != null && Object.hasOwn(CAPABILITY_LABEL_KO, key) ? CAPABILITY_LABEL_KO[key] : undefined) ?? '기타';
}

/** Korean label for an intent key; unknown or missing keys fall back to `기타`. */
export function feedbackIntentLabel(key: string | null | undefined): string {
  return (key != null && Object.hasOwn(INTENT_LABEL_KO, key) ? INTENT_LABEL_KO[key] : undefined) ?? '기타';
}

/**
 * The label of a per-capability breakdown row (the chat summary, the trend lines and the operations UI table): every
 * Capability its own, a row with no capability {@link FEEDBACK_NO_WORK_LABEL} (live QA D8: both used to read "기타").
 */
export function feedbackCapabilityRowLabel(key: string | null | undefined): string {
  return key == null ? FEEDBACK_NO_WORK_LABEL : feedbackCapabilityLabel(key);
}

/** The label of a per-intent breakdown row; a row with no intent is {@link FEEDBACK_NO_WORK_LABEL}. */
export function feedbackIntentRowLabel(key: string | null | undefined): string {
  return key == null ? FEEDBACK_NO_WORK_LABEL : feedbackIntentLabel(key);
}

function breakdownLines(
  title: string,
  rows: readonly FeedbackBreakdownRow[],
  label: (key: string | null) => string,
): string[] {
  if (rows.length === 0) return [];
  const shown = rows.slice(0, FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS);
  const lines = [title];
  for (const row of shown) {
    lines.push(`- ${label(row.key)}: 대화 ${row.turns}건 · 👍 ${row.positive} · 👎 ${row.negative} · 참고 신호 ${row.implicit}`);
  }
  if (rows.length > shown.length) lines.push(`- 외 ${rows.length - shown.length}개`);
  return lines;
}

/** A 👎 rate as a whole percentage of the window's turns; `-` when the window has no turns. */
function negativeRate(row: Pick<FeedbackBreakdownRow, 'turns' | 'negative'> | undefined): string {
  if (!row || row.turns === 0) return '-';
  return `${Math.round((row.negative / row.turns) * 100)}% (👎 ${row.negative}/${row.turns})`;
}

function trendWord(
  current: Pick<FeedbackBreakdownRow, 'turns' | 'negative'> | undefined,
  previous: Pick<FeedbackBreakdownRow, 'turns' | 'negative'> | undefined,
): string {
  if (!current || current.turns === 0 || !previous || previous.turns === 0) return '비교 불가';
  // Compare the exact ratios (cross-multiplied), never the rounded percentages.
  const now = current.negative * previous.turns;
  const before = previous.negative * current.turns;
  return now < before ? '개선' : now > before ? '악화' : '같음';
}

/**
 * ADR-0107 D3 trend line: 👎 rate per capability (👎-rated turns ÷ recorded turns), this 30 days against the
 * previous 30. Empty when neither window has a turn. Capability keys only, shown as Korean labels.
 */
export function feedbackTrendLines(trend: FeedbackCapabilityTrend | null | undefined): string[] {
  if (!trend) return [];
  const keys: Array<string | null> = [];
  for (const row of [...trend.current, ...trend.previous]) {
    if (row.turns > 0 && !keys.includes(row.key)) keys.push(row.key);
  }
  if (keys.length === 0) return [];
  const find = (rows: readonly FeedbackBreakdownRow[], key: string | null) => rows.find((row) => row.key === key);
  const shown = keys.slice(0, FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS);
  const lines = ['👎 비율 추이(최근 30일 · 이전 30일):'];
  for (const key of shown) {
    const current = find(trend.current, key);
    const previous = find(trend.previous, key);
    lines.push(`- ${feedbackCapabilityRowLabel(key)}: ${negativeRate(current)} · 이전 ${negativeRate(previous)} · ${trendWord(current, previous)}`);
  }
  if (keys.length > shown.length) lines.push(`- 외 ${keys.length - shown.length}개`);
  return lines;
}

/**
 * Compose the `피드백 요약` reply. `summary` null means the store could not be read. Provider ids are never part of
 * the input and never rendered; only fixed copy, counts, Korean capability/intent labels, UTC dates and guarded excerpts.
 */
export function composeFeedbackSummaryText(
  summary: FeedbackSummary | null,
  excerpts: FeedbackRequestExcerpts = new Map(),
  trend?: FeedbackCapabilityTrend | null,
): string {
  if (!summary) return FEEDBACK_SUMMARY_UNAVAILABLE_TEXT;
  if (summary.turnCount === 0) return FEEDBACK_SUMMARY_EMPTY_TEXT;

  const isRating = (kind: FeedbackSignalKind) => kind === FeedbackSignalKind.EXPLICIT_RATING;
  const positive = countOf(summary, (kind, value) => isRating(kind) && value === 'POSITIVE');
  const negative = countOf(summary, (kind, value) => isRating(kind) && value === 'NEGATIVE');
  const implicit = countOf(summary, (kind) => !isRating(kind));

  const lines: string[] = [
    '최근 30일 피드백 요약이에요.',
    `- 기록된 대화 ${summary.turnCount}건 · 👍 ${positive} · 👎 ${negative} · 참고 신호 ${implicit}`,
  ];
  const byCapability = breakdownLines('기능별:', summary.byCapability, feedbackCapabilityRowLabel);
  if (byCapability.length > 0) lines.push('', ...byCapability);
  const trendLines = feedbackTrendLines(trend);
  if (trendLines.length > 0) lines.push('', ...trendLines);
  const byIntent = breakdownLines('요청 유형별:', summary.byIntent, feedbackIntentRowLabel);
  if (byIntent.length > 0) lines.push('', ...byIntent);
  if (summary.recentNegative.length > 0) {
    lines.push('', '최근 👎 답변:');
    for (const turn of summary.recentNegative) {
      const date = turn.createdAt.slice(0, 10);
      const excerpt = feedbackRequestExcerpt(turn.taskId === undefined ? undefined : excerpts.get(turn.taskId));
      lines.push(`- ${date} · ${feedbackIntentLabel(turn.intentType)} · ${excerpt}`);
    }
  }
  lines.push('', FOOTER);
  return lines.join('\n');
}

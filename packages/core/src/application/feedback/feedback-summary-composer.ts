import { FeedbackSignalKind } from '../../domain';
import type { FeedbackBreakdownRow, FeedbackSummary, Id } from '../../domain';
import { containsCredentialMaterial } from '../credential-guard';

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
const SUPPRESSED_EXCERPT = '(민감한 내용일 수 있어 표시하지 않아요)';
const MISSING_EXCERPT = '(요청 내용을 찾을 수 없어요)';
const FOOTER = '피드백은 품질 확인용 기록일 뿐이며 답변 방식이 자동으로 바뀌지는 않아요. 메시지 내용은 저장하지 않아요.';

/** Task request text by Task id, for the recent 👎 turns; a missing id shows a neutral placeholder. */
export type FeedbackRequestExcerpts = ReadonlyMap<Id, string>;

function countOf(summary: FeedbackSummary, predicate: (kind: FeedbackSignalKind, value: string) => boolean): number {
  return summary.signals.reduce((total, row) => (predicate(row.kind, row.value) ? total + row.count : total), 0);
}

/**
 * One request excerpt: whitespace collapsed, at most {@link FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS} code points, mentions
 * neutralised (`@` → `@` + U+200B so a quoted `@everyone` never pings), and fully suppressed when the credential
 * guard matches the original request.
 */
export function feedbackRequestExcerpt(text: string | undefined): string {
  if (text === undefined) return MISSING_EXCERPT;
  if (containsCredentialMaterial(text)) return SUPPRESSED_EXCERPT;
  const flat = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (flat.length === 0) return MISSING_EXCERPT;
  const chars = [...flat];
  const cut = chars.length > FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS
    ? `${chars.slice(0, FEEDBACK_SUMMARY_EXCERPT_MAX_CHARS).join('')}…`
    : flat;
  return `"${cut.replace(/@/gu, '@​').replace(/`/gu, "'")}"`;
}

function breakdownLines(title: string, rows: readonly FeedbackBreakdownRow[]): string[] {
  if (rows.length === 0) return [];
  const shown = rows.slice(0, FEEDBACK_SUMMARY_MAX_BREAKDOWN_ROWS);
  const lines = [title];
  for (const row of shown) {
    lines.push(`- ${row.key ?? '기타'}: 대화 ${row.turns}건 · 👍 ${row.positive} · 👎 ${row.negative} · 참고 신호 ${row.implicit}`);
  }
  if (rows.length > shown.length) lines.push(`- 외 ${rows.length - shown.length}개`);
  return lines;
}

/**
 * Compose the `피드백 요약` reply. `summary` null means the store could not be read. Provider ids are never part of
 * the input and never rendered; only fixed copy, counts, capability/intent enum keys, UTC dates and guarded excerpts.
 */
export function composeFeedbackSummaryText(
  summary: FeedbackSummary | null,
  excerpts: FeedbackRequestExcerpts = new Map(),
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
  const byCapability = breakdownLines('기능별:', summary.byCapability);
  if (byCapability.length > 0) lines.push('', ...byCapability);
  const byIntent = breakdownLines('요청 유형별:', summary.byIntent);
  if (byIntent.length > 0) lines.push('', ...byIntent);
  if (summary.recentNegative.length > 0) {
    lines.push('', '최근 👎 답변:');
    for (const turn of summary.recentNegative) {
      const date = turn.createdAt.slice(0, 10);
      const excerpt = feedbackRequestExcerpt(turn.taskId === undefined ? undefined : excerpts.get(turn.taskId));
      lines.push(`- ${date} · ${turn.intentType ?? '기타'} · ${excerpt}`);
    }
  }
  lines.push('', FOOTER);
  return lines.join('\n');
}

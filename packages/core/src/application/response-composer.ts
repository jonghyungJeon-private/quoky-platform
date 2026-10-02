import { RiskLevel } from '../domain';
import type {
  ApprovalRequest,
  Artifact,
  ConversationContext,
  GitDiff,
  GitStatus,
  OutboundMessage,
  PreviewFile,
  PullRequestStatusPreview,
} from '../domain';
import type { AiExecutionResult } from '../ports';
import { newId } from '../util/id';
import { buildCanonicalDiff } from './preview-delivery';
import {
  MAX_CHANGE_SET_FILES,
  MAX_CHANGE_SET_FILE_BYTES,
  MAX_CHANGE_SET_TOTAL_BYTES,
} from './code-work/code-change-set';
import {
  credentialOverrideAlreadyUsed,
  credentialOverrideContentChanged,
  credentialOverrideDenied,
  credentialOverrideHardRefusalLine,
  credentialOverrideInvalidated,
  credentialOverrideNoPending,
  credentialOverridePrompt,
  credentialOverrideReprompt,
  credentialOverrideSentNotice,
} from './credential-override/credential-override-copy';
import type { CredentialOverrideInvalidationReason } from './credential-override/credential-override';
import { formatSafeErrorText } from './safe-error';
import type { SafeError, SafeErrorContext } from './safe-error';
import type { WorkSurface } from './work-surface-query';
import { ProviderGatewayTerminalStatus } from './provider-routing-gateway';
import type { ProviderGatewayFailureCode } from './provider-routing-gateway';
import { RoutingFailureCode } from './runtime-response-validation-contracts';

export type ProviderRoutingTerminalReplyStatus = Exclude<
  ProviderGatewayTerminalStatus,
  ProviderGatewayTerminalStatus.ACCEPTED
>;

/**
 * Read-only display context for the last post-apply validation run (Sprint 2w, ADR-0044). `'none'` = no
 * validation was ever recorded; `'unavailable'` = a ref exists but could not be resolved (its lookup must
 * NOT fail the git preview); otherwise the resolved command + terminal status. Never asserts current
 * validity.
 */
export type ValidationContext = { command: string; status: string } | 'unavailable' | 'none';

/**
 * The terminal/halt status of an execution turn (Conversation Runtime, ADR-0032). Kept as a
 * narrow local union so ResponseComposer does not depend on the orchestrator module; the runtime
 * passes the Execution Orchestrator's `ExecutionOutcome.status` (a superset) through unchanged.
 */
export type ExecutionReplyStatus =
  | 'COMPLETED'
  | 'AWAITING_APPROVAL'
  | 'DENIED'
  | 'STOPPED_ON_FAILURE'
  | 'CANCELLED';

/**
 * Display-relevant facts for one test/typecheck `CommandExecution` (Test Result Detail UX,
 * ADR-0034). An Application-layer DTO — not domain, not persisted, deliberately narrower than
 * `CommandExecution` itself: no id/Ref/hash/status, only what is safe and useful to render.
 * `ConversationRuntime` assembles it from the aggregate it already reads (`frameTestResult`); it
 * never truncates the streams or writes any text — that stays entirely inside `ResponseComposer`.
 */
export interface TestResultDetail {
  kind: 'test' | 'typecheck';
  command: string;
  args: string[];
  /** Absent for TIMED_OUT — the process was killed, it never produced a real exit. */
  exitCode?: number;
  durationMs: number;
  /** Already masked + size-capped by the command-runner adapter (ADR-0028) — never re-masked here. */
  stdout: string;
  stderr: string;
}

/**
 * Display-relevant shape of an AI code-change proposal (AI Code Generation Preview, ADR-0038).
 * Application-layer, not domain, not persisted — deliberately narrower than `CodeProposal` (no
 * id/Ref/providerId). `changes` contains only paths that normalized-matched the validated
 * `targetFiles` the request was approved for; `outOfScopeWarnings` holds everything else the AI
 * proposed touching, which is never rendered as content — AI-proposed paths are untrusted.
 */
export interface CodeChangePreview {
  changes: Array<{ path: string; kind: 'update' | 'delete'; excerpt?: string }>;
  outOfScopeWarnings: string[];
}

/**
 * Display-relevant shape of a unified-diff-style code-change preview (Unified Diff Preview, ADR-0039).
 * Application-layer, not domain, not persisted. `unified`/`binary` come straight from a
 * `WorkspaceManager.diff()` `FileDiff` — current-content-vs-proposed, never AI-authored diff text.
 * Each entry's `kind` is `'add' | 'update' | 'delete'`. An `'add'` is a confirmed EXPLICIT new-file
 * preview (F3-A, Sprint 4c-Follow-up-3), rendered as an all-additions diff against empty content; an
 * unexpected/unexplained `'add'` is still rejected as a failure before this DTO is built
 * (`ConversationRuntime.runCodeGenerationPreview`), so it never reaches rendering.
 */
export interface CodeDiffPreview {
  changes: Array<{
    path: string;
    kind: 'add' | 'update' | 'delete';
    unified: string;
    binary: boolean;
    /** Byte sizes from the workspace diff, when known — the ADR-0099 D1 bounds checked for the apply footer. */
    oldSize?: number;
    newSize?: number;
  }>;
  outOfScopeWarnings: string[];
}

/**
 * Display DTO for a generated PatchSet (Approved Apply Context → PatchSet Preview, ADR-0041).
 * Application-layer, not domain — each entry is a `PatchOperation` reshaped for display. `unified` came
 * from `WorkspaceManager.diff`, never AI-authored text. A PatchSet existing means a REPRESENTATION was
 * generated; it does NOT mean it was applied (no file/command/git mutation).
 */
export interface PatchSetPreview {
  operations: Array<{ path: string; kind: 'add' | 'update' | 'delete'; unified: string }>;
}

/** Per-stream tail kept in a reply excerpt (lines), before the char cap applies. */
const MAX_SUMMARY_LINES = 20;
/** Char cap on the rendered excerpt, leaving headroom under Discord's 2000-char message limit. */
const MAX_SUMMARY_CHARS = 1200;
/** Hard cap on the full rendered reply (excerpt + surrounding sentences), same reason. */
const MAX_MESSAGE_CHARS = 1900;
/** The command-runner adapter's own truncation marker (`maskCommandOutput`, ADR-0028). */
const ADAPTER_TRUNCATION_MARKER = '…[truncated]';
/** Per-file excerpt cap before the overall message clamp applies (AI Code Generation Preview, ADR-0038). */
const MAX_PREVIEW_EXCERPT_CHARS = 800;
/** Bound on how many out-of-scope paths are listed before truncating (ADR-0038). */
const MAX_OUT_OF_SCOPE_WARNING_PATHS = 5;
/** Per-file diff line/char caps before the reserved-budget assembly applies (Unified Diff Preview,
 *  ADR-0039) — independent of MAX_PREVIEW_EXCERPT_CHARS (different content shape). Lowered to 1000
 *  chars (from an initial 2000) so a single file's diff leaves headroom for the header, footer, and
 *  other files' blocks within MAX_MESSAGE_CHARS (CA Round 1 Required Change #2). */
const MAX_DIFF_LINES_PER_FILE = 40;
const MAX_DIFF_CHARS_PER_FILE = 1000;
/** Bound on displayed user-controllable git refs (remote/branch/upstream) in push replies (Sprint 2z,
 *  ADR-0047, CA #6) — a defensive display cap even though upstream parsing already rejects over-long refs. */
const MAX_GIT_REF_DISPLAY = 80;
/** Display bound on a user-typed path echoed back in the rejected-path reply (QA-016). */
const MAX_REJECTED_PATH_DISPLAY = 80;
/** Bound on a displayed PR URL (Sprint 3d-D) — the adapter already validates it to the canonical bounded
 *  github.com form; this is a defensive display cap. */
const MAX_PR_URL_DISPLAY = 200;
/** Fixed upper bound on the "N개 파일... 생략했어요" notice's length (N is bounded by
 *  MAX_TARGET_CANDIDATES = 5 upstream, so always short) — reserved up front so the notice never has to
 *  compete for budget after the fact (ADR-0039). */
const MAX_OMITTED_NOTICE_CHARS = 40;
/** Slack for line-join overhead across header/blocks/footer (ADR-0039, CA Round 1 Required Change #2). */
const DIFF_BUDGET_MARGIN_CHARS = 20;

const DIFF_PREVIEW_HEADER =
  '코드 변경 제안을 diff로 보여드려요. 아직 실제로 적용되지 않았어요. 파일은 수정되지 않았어요.';
/** Apply-INcapable preview footer — the change shape (a deleted file, binary or undisplayable content, or more
 *  than MAX_CHANGE_SET_FILES files) is outside what the WorkspaceWrite integrity gate accepts (ADR-0099 D1), so
 *  THIS preview has no apply step and must not offer the "적용해줘" request phrase. It replaces the old blanket
 *  "apply is not supported" wording, which became false once preview → apply approval → patch → apply shipped
 *  (ADR-0040–0042; Personal v1 scope D5), and names the real next step instead. */
const DIFF_PREVIEW_FOOTER = [
  `이 제안은 파일 삭제, 바이너리·표시할 수 없는 변경 또는 ${MAX_CHANGE_SET_FILES}개보다 많은 파일이 포함돼 바로 적용할 수는 없어요.`,
  `파일에 적용까지 하려면 고칠 기존 파일이나 새로 만들 파일을 ${MAX_CHANGE_SET_FILES}개까지 경로와 함께 다시 요청해 주세요.`,
].join('\n');
/** Apply-CAPABLE preview footer (Footer Minimal Fix). Shown only when the previewed change is a shape the
 *  WorkspaceWrite integrity gate accepts (1..5 non-binary `update`/`add` files, ADR-0099 D1). It
 *  states files are still unmodified, that apply is now available, the explicit apply-REQUEST phrase, and
 *  that a bare "승인" does not modify files. The phrase is "적용해줘" (an APPLY_WORDS entry that drives the
 *  ELIGIBLE→apply-approval transition) — deliberately NOT the later FINAL_APPLY phrase "파일에 적용", which
 *  at ELIGIBLE would route to workspace-apply-unavailable. Keeps a "적용되지 않았어요" phrase so the
 *  repeated not-applied assertion still holds alongside DIFF_PREVIEW_HEADER. */
const DIFF_PREVIEW_APPLY_FOOTER = [
  '아직 실제 파일에는 적용되지 않았어요.',
  '적용하려면 "적용해줘"라고 다시 요청해 주세요. 단순히 "승인"만으로는 파일이 변경되지 않아요.',
].join('\n');

/** PatchSet preview (Sprint 2t, ADR-0041). CA Round 1 Required Change #3: "패치 미리보기" framing —
 *  never a bare "패치를 만들었어요" a non-developer could read as "applied." */
const PATCH_PREVIEW_HEADER =
  '패치 미리보기를 만들었어요. 아직 실제 파일에는 적용하지 않았어요. 파일은 수정되지 않았어요.';
const PATCH_PREVIEW_FOOTER = [
  '파일은 아직 그대로예요.',
  '이 패치를 실제 파일에 적용하려면 "패치 적용해줘"라고 요청해 주세요.',
].join('\n');

/**
 * User-facing Korean risk line for an approval (QA-017). `ApprovalRequest.reason` is an internal English audit
 * string ("HIGH risk requires human approval", "operation: git push approval planning …") and is never shown to
 * the user; the reminder/notice/expiry replies render only this label for the request's risk level.
 */
function approvalRiskLine(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case RiskLevel.CRITICAL:
      return '위험도: 매우 높음 — 원격 저장소처럼 되돌리기 어려운 곳의 변경으로 이어질 수 있어요';
    case RiskLevel.HIGH:
      return '위험도: 높음 — 실제 파일이나 Git 변경으로 이어질 수 있어요';
    case RiskLevel.MEDIUM:
      return '위험도: 보통';
    case RiskLevel.LOW:
      return '위험도: 낮음';
    default:
      return '위험도: 확인 필요';
  }
}

/** How to decide a pending approval (ADR-0093) — the decision words `interpretApprovalDecision` accepts. */
const APPROVAL_DECISION_LINE = '진행하려면 "승인", 거절하려면 "거절"이라고 답해 주세요.';

/** The next phrase after a commit approval is recorded (QA-021) — "커밋 실행" is a COMMIT_EXECUTION_WORDS phrase
 *  (`interpretCommitExecutionIntent` → 'execute' at COMMIT_APPROVED), the same phrase help names. */
const COMMIT_EXECUTE_NEXT_LINE = '실제로 커밋하려면 "커밋 실행"이라고 보내 주세요.';

/** Next phrases after a real workspace apply (ADR-0043 validation; ADR-0093 reset). "테스트 실행해줘" is an
 *  explicit validation request (`detectExplicitValidationKinds`); "새 대화" is the reset control phrase. */
const WORKSPACE_APPLIED_NEXT_LINE =
  '다음으로 "테스트 실행해줘"로 검증할 수 있고, 여기서 마치려면 "새 대화"라고 보내 주세요.';

/** Fixed help text (ADR-0093). Lists only what Personal v1 actually does, with phrases the runtime accepts.
 *  Split at the end of the capability list so contributed handler lines (ADR-0096 D6) extend that list; the base
 *  text itself is edited only by CODE-3 and OVR-4. */
const HELP_CAPABILITY_LINES: readonly string[] = [
  'Quoky로 할 수 있는 일이에요.',
  '- 일상 대화와 질문 답변',
  '- 기억: "기억해: <내용>"이라고 보내면 오래 기억해 둬요.',
  '- 프로젝트 등록: "이 프로젝트 등록해줘: /path/to/project"',
  '- 등록한 프로젝트 분석·설명과 코드 리뷰',
  '- 코드 수정: 파일 경로와 함께 요청 → "승인" → 미리보기 확인 → "적용해줘" → "승인" → "패치 만들어줘" → "패치 적용해줘"',
  '- 비밀 값처럼 보여 AI에게 보내지 않은 파일은 "그래도 보내줘"라고 하면 그 파일만 이번 한 번 보내요. 토큰·개인 키 형태나 .env 같은 비밀 파일은 보낼 수 없어요.',
  `- 여러 파일·새 파일: 한 요청에 파일 경로를 ${MAX_CHANGE_SET_FILES}개까지 적을 수 있어요. 없는 파일은 "새 파일 만들어줘"처럼 요청해야 새로 만들어요.`,
  '- 적용 후 검증: "테스트 실행해줘" 또는 "타입체크 실행해줘"',
  '- 로컬 커밋: 적용 후 "커밋해줘" → "승인" → "커밋 실행" (main/master 브랜치에는 커밋하지 않아요)',
];
const HELP_CONTROL_LINES: readonly string[] = [
  '',
  '승인 요청에는 "승인" 또는 "거절"로 답해 주세요. 30분 안에 답하지 않으면 자동으로 거절돼요.',
  '',
  '대화 제어:',
  '- "도움말": 이 안내를 다시 보여줘요.',
  '- "새 대화": 지금 대화를 끝내고 새로 시작해요. 기다리던 승인 요청은 거절로 처리돼요.',
  '- "/help", "/reset"도 같아요. 다만 Discord에서는 "/"로 시작하면 명령 선택 창이 열리니, Esc로 창을 닫은 뒤 Enter로 보내 주세요.',
];
const HELP_TEXT = [...HELP_CAPABILITY_LINES, ...HELP_CONTROL_LINES].join('\n');

/** ADR-0096 D6: at most this many contributed help lines are shown (the rest are dropped, in registry order). */
export const MAX_CONTRIBUTED_HELP_LINES = 12;
/** ADR-0096 D6: a contributed help line longer than this is cut, ending in `…`. */
export const MAX_CONTRIBUTED_HELP_LINE_CHARS = 120;

/** Bound contributed help lines (ADR-0096 D6): one line each (whitespace collapsed), blank lines dropped, at most
 *  `MAX_CONTRIBUTED_HELP_LINES` lines of at most `MAX_CONTRIBUTED_HELP_LINE_CHARS` characters, order kept. */
function boundContributedHelpLines(extraLines: readonly string[]): string[] {
  return extraLines
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_CONTRIBUTED_HELP_LINES)
    .map((line) => {
      const chars = Array.from(line);
      return chars.length <= MAX_CONTRIBUTED_HELP_LINE_CHARS
        ? line
        : `${chars.slice(0, MAX_CONTRIBUTED_HELP_LINE_CHARS - 1).join('')}…`;
    });
}

/** Which stream a rendered excerpt came from, and which non-empty stream was left out. */
interface OutputSummary {
  chosenStream: 'stdout' | 'stderr' | 'none';
  omittedStream?: 'stdout' | 'stderr';
  excerpt: string;
  truncated: boolean;
}

/**
 * Deterministic, non-AI summarization of one command's captured output (Test Result Detail UX,
 * ADR-0034). Prefers `stdout` (test runners/typecheckers report there); falls back to `stderr` only
 * when `stdout` is empty — a single stream, never an interleaved merge of both. Keeps the **tail**
 * (last `MAX_SUMMARY_LINES` lines, then `MAX_SUMMARY_CHARS` chars) since the actionable detail for a
 * failing test/typecheck run is at the end. Truncating already-masked text cannot re-expose
 * anything (CA review Q3) — this is a length transform only, not a second masking pass.
 */
function summarizeOutput(stdout: string, stderr: string): OutputSummary {
  const chosenStream: OutputSummary['chosenStream'] = stdout.trim()
    ? 'stdout'
    : stderr.trim()
      ? 'stderr'
      : 'none';
  if (chosenStream === 'none') {
    return { chosenStream, excerpt: '', truncated: false };
  }
  // stdout-preferred can only ever omit stderr (stderr is chosen only when stdout is empty) —
  // don't hide that stderr output existed (CA review, required change #1).
  const omittedStream = chosenStream === 'stdout' && stderr.trim() ? 'stderr' : undefined;

  const raw = chosenStream === 'stdout' ? stdout : stderr;
  const adapterTruncated = raw.includes(ADAPTER_TRUNCATION_MARKER);
  const lines = raw.split('\n');
  const lineTruncated = lines.length > MAX_SUMMARY_LINES;
  const tail = lineTruncated ? lines.slice(-MAX_SUMMARY_LINES) : lines;

  let excerpt = tail.join('\n');
  const charTruncated = excerpt.length > MAX_SUMMARY_CHARS;
  if (charTruncated) excerpt = excerpt.slice(excerpt.length - MAX_SUMMARY_CHARS);

  return {
    chosenStream,
    ...(omittedStream ? { omittedStream } : {}),
    excerpt,
    truncated: adapterTruncated || lineTruncated || charTruncated,
  };
}

/** `durationMs` as seconds with one decimal, e.g. `"30.0s"`. */
function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/** The fixed command shape ("pnpm test"), never a shell string — display only. */
function formatCommand(detail: Pick<TestResultDetail, 'command' | 'args'>): string {
  return [detail.command, ...detail.args].join(' ');
}

/**
 * Render the excerpt block: a fenced code block plus notice lines. Notice wording is deliberately
 * modest (CA review, required change #5) — it states that the log was cut, never that it is
 * "완전히 안전"/fully redacted; we trust the adapter's masking boundary (ADR-0028) without asserting
 * it to the user.
 */
function renderExcerptBlock(summary: OutputSummary): string {
  if (summary.chosenStream === 'none') return '출력이 없어요.';
  const lines = ['마지막 출력:', '```', summary.excerpt, '```'];
  if (summary.truncated) lines.push('출력이 길어서 마지막 부분만 보여드렸어요.');
  if (summary.omittedStream) {
    lines.push(`${summary.omittedStream} 출력도 있었지만, 여기서는 ${summary.chosenStream} 마지막 부분만 보여드려요.`);
  }
  return lines.join('\n');
}

/** A user-typed path for echoing inside inline code (QA-016): backticks/control characters stripped, truncated. */
function sanitizeTypedPath(typedPath: string): string {
  const cleaned = typedPath.replace(/[\u0000-\u001f\u007f`]/g, '').trim();
  return cleaned.length > MAX_REJECTED_PATH_DISPLAY ? `${cleaned.slice(0, MAX_REJECTED_PATH_DISPLAY)}…` : cleaned;
}

/** A bounded, comma-joined file list with new files marked "(새 파일)" (ADR-0099 D3) and a "외 N개" suffix. */
function renderFileList(files: readonly string[], newFiles: readonly string[] = [], max: number = MAX_GIT_CHANGED_FILES): string {
  const isNew = new Set(newFiles);
  const shown = files.slice(0, max).map((f) => (isNew.has(f) ? `${f} (새 파일)` : f));
  const omitted = files.length - shown.length;
  return `${shown.join(', ')}${omitted > 0 ? ` 외 ${omitted}개` : ''}`;
}

/** Defensive final-length guard (CA review, required change #6) — belt-and-suspenders over the excerpt cap. */
function clampToMessageBudget(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

/**
 * A fence guaranteed longer than any backtick run already inside `excerpt` (AI Code Generation
 * Preview, ADR-0038 — CA Round 1) — untrusted AI content can never break the surrounding message's
 * Markdown structure.
 */
function fenceFor(excerpt: string): string {
  const longestRun = Math.max(2, ...(excerpt.match(/`+/g) ?? ['']).map((r) => r.length));
  return '`'.repeat(longestRun + 1);
}

/** Bounded, comma-joined out-of-scope path list with a "외 N개" suffix when truncated (ADR-0038). */
function renderOutOfScopeWarning(paths: string[]): string | undefined {
  if (!paths.length) return undefined;
  const shown = paths.slice(0, MAX_OUT_OF_SCOPE_WARNING_PATHS);
  const suffix = paths.length > shown.length ? ` 외 ${paths.length - shown.length}개` : '';
  return `참고: ${shown.join(', ')}${suffix}에도 변경을 제안했지만, 확인된 대상 파일이 아니라서 보여드리지 않았어요.`;
}

/** Clamp one file's unified diff to a bounded number of lines, then chars (Unified Diff Preview,
 *  ADR-0039); reports whether either cap fired so the caller can add a truncation notice. */
function clampDiffText(unified: string, maxChars: number = MAX_DIFF_CHARS_PER_FILE): { text: string; truncated: boolean } {
  const lines = unified.split('\n');
  const lineTruncated = lines.length > MAX_DIFF_LINES_PER_FILE;
  let text = (lineTruncated ? lines.slice(0, MAX_DIFF_LINES_PER_FILE) : lines).join('\n');
  const charTruncated = text.length > maxChars;
  if (charTruncated) text = text.slice(0, maxChars);
  return { text, truncated: lineTruncated || charTruncated };
}

/** Floor on a file's share of the text-fallback diff budget, so a share is never uselessly small. */
const MIN_DIFF_CHARS_PER_FILE_SHARE = 120;
/** Most shrink rounds {@link fitDiffBlocks} takes before leaving any remaining overflow to the drop rule. */
const MAX_DIFF_FIT_ROUNDS = 8;

/**
 * Render one block per file within the message budget (ADR-0099 D1). A single file keeps
 * MAX_DIFF_CHARS_PER_FILE; for a change set every block is rendered, then each file's diff share is shrunk by
 * the measured overflow — so the REAL per-block overhead (path label, fences, truncation note) is accounted
 * for, and a long path never pushes a later file out. Only when even the floor share cannot fit does
 * {@link assembleBoundedBody}'s drop-with-notice rule apply — the accepted bound: five blocks fit with paths up to
 * ~120 chars; past that a block may be dropped with the explicit "N개 생략" notice (path labels are never
 * shortened, and the lossless structured preview still carries every full diff).
 */
function fitDiffBlocks(header: string, footerLines: string[], count: number, render: (i: number, maxChars: number) => string): string[] {
  const renderAll = (maxChars: number): string[] => Array.from({ length: count }, (_, i) => render(i, maxChars));
  let maxChars = MAX_DIFF_CHARS_PER_FILE;
  let blocks = renderAll(maxChars);
  if (count <= 1) return blocks;
  const bodyBudget = diffBodyBudget(header, footerLines);
  for (let round = 0; round < MAX_DIFF_FIT_ROUNDS && maxChars > MIN_DIFF_CHARS_PER_FILE_SHARE; round++) {
    // +1 per block for the joining newline.
    const used = blocks.reduce((n, b) => n + b.length + 1, 0);
    if (used <= bodyBudget) break;
    // Shrink from the longest block actually rendered (a line-capped diff may be far below maxChars).
    const longest = Math.max(...blocks.map((b) => b.length));
    const next = Math.min(maxChars, longest) - Math.ceil((used - bodyBudget) / count);
    maxChars = Math.max(MIN_DIFF_CHARS_PER_FILE_SHARE, next);
    blocks = renderAll(maxChars);
  }
  return blocks;
}

/** The body budget left for file blocks once the header, footer and omitted-notice are reserved. */
function diffBodyBudget(header: string, footerLines: string[]): number {
  const footer = footerLines.join('\n');
  const reserved = header.length + footer.length + MAX_OMITTED_NOTICE_CHARS + DIFF_BUDGET_MARGIN_CHARS;
  return Math.max(0, MAX_MESSAGE_CHARS - reserved);
}

/**
 * Render one changed file's block (Unified Diff Preview, ADR-0039). Binary and size-skipped files must
 * say plainly that a diff could not be displayed — never phrased as if one was shown — and repeat that
 * the file was not modified (CA Round 1 Required Change #4).
 */
function renderDiffChange(c: CodeDiffPreview['changes'][number], maxChars: number = MAX_DIFF_CHARS_PER_FILE): string {
  if (c.binary) return `- ${c.path}: 바이너리 파일이라 diff를 표시할 수 없어요. (파일은 수정되지 않았어요)`;
  if (!c.unified.trim()) {
    return `- ${c.path}: 내용이 너무 커서 diff를 표시할 수 없어요. (파일은 수정되지 않았어요)`;
  }
  const { text, truncated } = clampDiffText(c.unified, maxChars);
  const fence = fenceFor(text);
  // F3-A (Sprint 4c-Follow-up-3): an 'add' is an explicit new-file preview — every line is an addition,
  // rendered against empty content. Same bounded, backtick-safe rendering as update/delete.
  const label = c.kind === 'delete' ? `${c.path} (삭제 제안)` : c.kind === 'add' ? `${c.path} (새 파일)` : c.path;
  const note = truncated ? '\n(diff가 길어서 일부만 보여드렸어요.)' : '';
  return `- ${label}\n${fence}diff\n${text}\n${fence}${note}`;
}

/** Render one PatchSet operation's block (Sprint 2t, ADR-0041). Operations only ever carry a real
 *  unified diff here — binary/empty/delete are rejected before PatchSet generation, and an `add` is an
 *  anchored new-file target (ADR-0099 D1) — so this reuses the same bounded, backtick-safe rendering as
 *  {@link renderDiffChange}. */
function renderPatchOperation(op: PatchSetPreview['operations'][number], maxChars: number = MAX_DIFF_CHARS_PER_FILE): string {
  const { text, truncated } = clampDiffText(op.unified, maxChars);
  const fence = fenceFor(text);
  const label = op.kind === 'delete' ? `${op.path} (삭제)` : op.kind === 'add' ? `${op.path} (새 파일)` : op.path;
  const note = truncated ? '\n(diff가 길어서 일부만 보여드렸어요.)' : '';
  return `- ${label}\n${fence}diff\n${text}\n${fence}${note}`;
}

/**
 * Budget-aware, backtick-safe block assembly shared by the diff and PatchSet previews (Sprint 2r/2t).
 * The header + footer are reserved budget FIRST; pre-rendered blocks are then added until the remaining
 * budget is used up, and any that don't fit are DROPPED (never truncated mid-block) with a bounded
 * "N개 생략" notice — so the mandatory safety wording always survives. The trailing clampToMessageBudget
 * is a defensive backstop, not the primary guarantee.
 */
function assembleBoundedBody(header: string, footerLines: string[], blocks: string[]): string {
  const bodyBudget = diffBodyBudget(header, footerLines);

  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const block of blocks) {
    if (used + block.length > bodyBudget) {
      omitted++;
      continue;
    }
    used += block.length;
    kept.push(block);
  }

  const lines = [header, ...kept];
  if (omitted > 0) lines.push(`(길이 제한으로 파일 ${omitted}개의 diff는 생략했어요.)`);
  lines.push(...footerLines);
  return clampToMessageBudget(lines.join('\n'));
}

/**
 * The ADR-0099 D1 byte bounds (per file on current and proposed content, and the proposed total) over the sizes
 * the diff reported — the same bounds the patch-time check enforces, so a preview never offers "적용해줘" for a
 * set that "패치 만들어줘" would refuse. An unknown size is not counted (the patch-time check stays authoritative).
 */
function withinChangeSetByteBounds(changes: CodeDiffPreview['changes']): boolean {
  let total = 0;
  for (const c of changes) {
    if ((c.oldSize ?? 0) > MAX_CHANGE_SET_FILE_BYTES || (c.newSize ?? 0) > MAX_CHANGE_SET_FILE_BYTES) return false;
    total += c.newSize ?? 0;
  }
  return total <= MAX_CHANGE_SET_TOTAL_BYTES;
}

/**
 * Pre-apply SHAPE signal for footer wording ONLY (Footer Minimal Fix, widened by ADR-0099 D1). A previewed
 * change is apply-capable iff it is 1..MAX_CHANGE_SET_FILES non-binary, displayable `update`/`add` files — the
 * shapes the authoritative WorkspaceWrite integrity gate (ConversationRuntime.handleWorkspaceApplyTurn) accepts
 * (an `add` only ever reaches a preview for an explicit, re-checked new-file target); delete/binary/undisplayable
 * and larger sets are not applicable. This is NOT an
 * authorization check: it deliberately does not — and must not — inspect the ApprovalRef, PatchSet, or
 * ExecutionPlan binding (the runtime owns that gate; it is never re-implemented here). It reads only the
 * deterministic change metadata already present on the preview, and does not query any Manager, the DB,
 * the ApplyPreviewAnchor, or the filesystem. Target-scope path safety is already guaranteed upstream
 * (the preview is built solely from validated, in-scope targetFiles).
 */
function isApplyCapablePreview(preview: CodeDiffPreview): boolean {
  const n = preview.changes.length;
  return (
    n >= 1 &&
    n <= MAX_CHANGE_SET_FILES &&
    withinChangeSetByteBounds(preview.changes) &&
    preview.changes.every((c) => {
      if (c.binary) return false;
      const displayable = c.unified.trim().length > 0;
      // A lone `update` keeps the original ADR-0042 rule unchanged; every other allowed file must be displayable.
      if (c.kind === 'update') return n === 1 || displayable;
      return c.kind === 'add' && displayable;
    })
  );
}

/**
 * Turns an execution result (or an approval prompt) into a normalized
 * OutboundMessage. The PlatformAdapter renders it natively. v1 implements a
 * straightforward pass-through; richer formatting per ArtifactKind is a TODO.
 *
 * Note: it deliberately never includes which provider was selected — the user
 * should not normally see that.
 */

/** Git-preview display bounds (Sprint 2w, ADR-0044). Layered above the message clamp; every truncation is
 *  labeled. `MAX_GIT_DIFF_CHARS` is the display cut, distinct from the adapter's larger hard safety cap. */
const MAX_GIT_CHANGED_FILES = 30;
const MAX_GIT_DIFF_FILES = 5;
const MAX_GIT_DIFF_CHARS = 3000;
/** Out-of-scope changed-file display cap for the commit-approval flow (Sprint 2x, ADR-0045, CA #7). */
const MAX_COMMIT_OUT_OF_SCOPE_SHOWN = 10;

/** The fixed read-only disclaimer lines every successful git preview must carry (Sprint 2w, CA #10). */
const GIT_READONLY_DISCLAIMER = [
  '읽기 전용 Git 미리보기예요.',
  'git add/commit/push는 하지 않았어요.',
  '파일 수정은 하지 않았어요.',
  '명령 실행도 하지 않았어요.',
];

/** Render the last-validation context line(s) for a git preview (Sprint 2w, CA Q8) — record-only, never
 *  asserts current validity. */
function renderValidationContext(v: ValidationContext): string {
  if (v === 'none') return '검증 기록 없음';
  if (v === 'unavailable') return '최근 검증 기록을 불러올 수 없어요.';
  return `최근 검증 기록: ${v.command} ${v.status}\n이번에 다시 실행하진 않았어요.`;
}

/** Bounded, labeled changed-files block from a GitStatus (Sprint 2w). */
function renderChangedFiles(status: GitStatus): string {
  const label = (kind: string, paths: string[]): string[] =>
    paths.length ? [`${kind} (${paths.length}):`, ...paths.map((p) => `  ${p}`)] : [];
  const all = [
    ...label('staged', status.staged),
    ...label('unstaged', status.unstaged),
    ...label('untracked', status.untracked),
  ];
  if (all.length === 0) return '현재 Git 기준 변경 파일이 없어요.';
  const shown = all.slice(0, MAX_GIT_CHANGED_FILES);
  const dropped = all.length - shown.length;
  const lines = [`브랜치: ${status.branch || '(unknown)'}`, ...shown];
  if (dropped > 0) lines.push(`… 외 ${dropped}개 항목은 생략했어요.`);
  return lines.join('\n');
}

/** Bounded, labeled unified-diff block (Sprint 2w). Splits by file header, keeps ≤5 files and ≤`maxChars`
 *  (the caller sizes `maxChars` so the mandatory frame — disclaimers etc. — always survives the final message
 *  clamp; never exceeds MAX_GIT_DIFF_CHARS). Labels any truncation (incl. the adapter's hard cap). Binary
 *  files already appear as git's marker line inside `unified` — never binary content. */
function renderDiffBlock(diff: GitDiff, maxChars: number): string {
  if (diff.unified.trim().length === 0) return '추적 중인 파일에 표시할 변경 내용이 없어요.';
  // Split into per-file sections on the `diff --git` header (keep the delimiter).
  const sections = diff.unified.split(/(?=^diff --git )/m).filter((s) => s.trim().length > 0);
  const shownFiles = sections.slice(0, MAX_GIT_DIFF_FILES);
  let body = shownFiles.join('');
  let truncated = diff.truncated || sections.length > shownFiles.length;
  const cap = Math.min(MAX_GIT_DIFF_CHARS, Math.max(0, maxChars));
  if (body.length > cap) {
    body = body.slice(0, cap);
    truncated = true;
  }
  const fence = fenceFor(body);
  const lines = [`${fence}diff`, body, fence];
  if (truncated) lines.push('diff가 길어서 일부만 보여드렸어요.');
  return lines.join('\n');
}

export class ResponseComposer {
  /** Read-only Personal Work Surface. Availability is always explicit when the projection is incomplete. */
  composeWorkSurface(context: ConversationContext, surface: WorkSurface): OutboundMessage {
    const lines: string[] = [];
    if (surface.status === 'UNAVAILABLE') {
      lines.push('지금은 개인 작업 목록을 불러올 수 없어요.');
    } else if (surface.items.length === 0) {
      lines.push(surface.status === 'COMPLETE' ? '현재 Jira와 GitHub에서 확인된 작업이 없어요.' : '확인 가능한 소스에서는 작업이 없어요.');
    } else {
      lines.push('지금 확인할 작업이에요:');
      for (const item of surface.items.slice(0, 20)) {
        const link = item.url ? ` — ${item.url}` : '';
        lines.push(`- [${item.resource.source}] ${item.title}${link}`);
      }
      if (surface.items.length > 20) lines.push(`- 외 ${surface.items.length - 20}개`);
    }

    const unavailable = surface.sources.filter((source) => source.status !== 'AVAILABLE');
    if (unavailable.length > 0) {
      lines.push('일부 소스 상태:');
      for (const source of unavailable) {
        const action = source.status === 'IDENTITY_MISSING'
          ? 'Actor 외부 identity를 설정해 주세요.'
          : source.status === 'NOT_CONFIGURED'
            ? 'connector 설정을 확인해 주세요.'
            : 'connector 연결 상태를 확인해 주세요.';
        lines.push(`- ${source.source}: ${action}`);
      }
    }
    return { context, text: clampToMessageBudget(lines.join('\n')) };
  }

  composeMemoryStored(context: ConversationContext): OutboundMessage {
    return { context, text: '요청한 내용을 기억해 둘게요.' };
  }

  composeMemorySensitiveRefused(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '비밀번호·키·토큰 같은 민감한 정보는 기억하지 않아요. 안전한 비밀번호 관리자에 보관해 주세요.',
    };
  }

  composeMemoryUsageHint(context: ConversationContext): OutboundMessage {
    return { context, text: '기억할 내용을 함께 보내 주세요. 예: "기억해: 내 배포 창은 화요일이야"' };
  }

  composeMemoryStoreFailed(context: ConversationContext): OutboundMessage {
    return { context, text: '지금은 요청한 내용을 장기 기억에 저장하지 못했어요. 대화는 계속할 수 있어요.' };
  }

  compose(
    context: ConversationContext,
    result: AiExecutionResult,
    artifacts: Artifact[] = [],
  ): OutboundMessage {
    const text = result.text.trim() || '(빈 응답이에요. 다시 시도해 주세요.)';
    return {
      context,
      text,
      ...(artifacts.length ? { artifacts } : {}),
    };
  }

  composeApprovalNotice(context: ConversationContext, request: ApprovalRequest): OutboundMessage {
    return {
      context,
      text: `이 작업은 승인이 필요해요.\n${approvalRiskLine(request.riskLevel)}\n${APPROVAL_DECISION_LINE}`,
    };
  }

  /**
   * Reminder for an ordinary message while an unexpired approval is pending (ADR-0093). The message is not
   * routed to chat or a provider; this names what is pending, how to approve or deny, the remaining time
   * (rounded up to whole minutes, never 0), and "새 대화" as the way out.
   */
  composePendingApprovalReminder(
    context: ConversationContext,
    request: ApprovalRequest,
    remainingMs: number,
  ): OutboundMessage {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    const text = [
      '승인을 기다리는 작업이 있어요.',
      approvalRiskLine(request.riskLevel),
      APPROVAL_DECISION_LINE,
      `남은 시간: 약 ${minutes}분 (지나면 자동으로 거절돼요)`,
      '이 요청을 그만두고 새로 시작하려면 "새 대화"라고 보내 주세요.',
    ].join('\n');
    return { context, text: clampToMessageBudget(text) };
  }

  /**
   * A bare decision word ("승인", "거절", "취소", "ok") arrived while nothing is pending (QA-018). Deterministic —
   * never routed to a provider, so no model can claim an approval was accepted. States only what is true: there is
   * nothing to decide now, and an earlier request may already have been decided or expired.
   */
  composeNoPendingDecision(context: ConversationContext): OutboundMessage {
    return {
      context,
      text:
        '지금 승인하거나 거절할 작업이 없어요. 기다리던 승인 요청은 처리됐거나 만료됐을 수 있어요. ' +
        '새로 요청하려면 원하는 작업을 말해 주세요.',
    };
  }

  /** A pending approval passed its lifetime and was recorded as denied (ADR-0093). It can no longer be approved. */
  composeApprovalExpired(context: ConversationContext, request: ApprovalRequest, ttlMs: number): OutboundMessage {
    const minutes = Math.round(ttlMs / 60_000);
    const text = [
      `승인 요청이 ${minutes}분 안에 결정되지 않아 자동으로 거절했어요.`,
      approvalRiskLine(request.riskLevel),
      '이 요청은 이제 승인할 수 없어요. 필요하면 처음부터 다시 요청해 주세요.',
    ].join('\n');
    return { context, text: clampToMessageBudget(text) };
  }

  /**
   * Help reply (ADR-0093): Personal v1 capabilities, the control phrases, and how to approve or deny. ADR-0096 D6:
   * the registered turn handlers' `extraLines` (registry order) are appended to the capability list, bounded by
   * `boundContributedHelpLines`. The base text always survives whole: trailing contributed lines are dropped
   * until the reply fits the message budget. With no contributed lines the reply is exactly the fixed base text.
   */
  composeHelp(context: ConversationContext, extraLines: readonly string[] = []): OutboundMessage {
    const contributed = boundContributedHelpLines(extraLines);
    const render = (): string => [...HELP_CAPABILITY_LINES, ...contributed, ...HELP_CONTROL_LINES].join('\n');
    while (contributed.length > 0 && render().length > MAX_MESSAGE_CHARS) contributed.pop();
    if (contributed.length === 0) return { context, text: HELP_TEXT };
    return { context, text: clampToMessageBudget(render()) };
  }

  /**
   * Reset reply (ADR-0093). States what reset did (session closed, a pending approval denied) and what it did
   * not do: no applied change or commit is rolled back and remembered knowledge stays.
   */
  composeConversationReset(context: ConversationContext, input: { deniedPendingApproval: boolean }): OutboundMessage {
    const lines = ['새 대화를 시작할게요. 다음 메시지부터 새 대화로 이어져요.'];
    if (input.deniedPendingApproval) lines.push('기다리던 승인 요청은 거절로 처리했어요.');
    lines.push('이미 적용한 파일 변경이나 커밋은 되돌리지 않았고, "기억해:"로 저장한 내용은 그대로 있어요.');
    lines.push('대화에 연결돼 있던 프로젝트는 풀렸어요. 코드 작업은 프로젝트를 다시 등록한 뒤 요청해 주세요.');
    return { context, text: lines.join('\n') };
  }

  /** Prepend a notice (e.g. an approval-expiry notice) to another reply, keeping the reply's own fields. */
  composeWithNotice(notice: OutboundMessage, reply: OutboundMessage): OutboundMessage {
    return { ...reply, text: clampToMessageBudget(`${notice.text}\n\n${reply.text}`) };
  }

  /**
   * Generic "this needs approval" prompt for when only a reference (not the full `ApprovalRequest`)
   * is at hand — e.g. a fresh execution that halted at `AWAITING_APPROVAL` (Conversation Runtime,
   * ADR-0032). Keeps all user-facing text inside ResponseComposer.
   */
  composeApprovalRequired(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: `이 작업은 승인이 필요해요. ${APPROVAL_DECISION_LINE}`,
    };
  }

  /**
   * Code-change-specific "approval required" prompt (Live Code Change Planning, ADR-0035). More
   * specific than {@link composeApprovalRequired}: names this as a code-change request and states
   * explicitly that no file is modified yet — a `planningOnly` halt never mutates.
   */
  composeCodeChangeApprovalRequired(
    context: ConversationContext,
    sentFilePaths: string[] = [],
    newFilePaths: readonly string[] = [],
  ): OutboundMessage {
    const shown = sentFilePaths.slice(0, 3).join(', ');
    const more = sentFilePaths.length > 3 ? ` 외 ${sentFilePaths.length - 3}개` : '';
    // Disclosure: existing target files' content goes to the AI provider for the preview (best-effort credential guard).
    const disclosure = sentFilePaths.length
      ? `승인하면 지정한 파일(${shown}${more})의 현재 내용이 미리보기 생성을 위해 AI에게 전달돼요. ` +
        '비밀번호·키가 들어 있는 파일은 보내지 않도록 확인하지만, 모든 경우를 걸러내지는 못해요.\n'
      : '';
    // ADR-0099 D1: in a multi-file set, name the paths that will be CREATED, so a typo of an existing file the
    // owner meant to update is visible before "승인" (create wording applies to every missing path named).
    const creates =
      newFilePaths.length && sentFilePaths.length + newFilePaths.length > 1
        ? `새로 만들 파일: ${renderFileList(newFilePaths, [], MAX_CHANGE_SET_FILES)} ` +
          '(기존 파일을 고치려던 거라면 "거절"하고 경로를 확인해 다시 요청해 주세요.)\n'
        : '';
    return {
      context,
      text:
        '이 작업은 코드 변경으로 이어질 수 있어 승인이 필요해요.\n' +
        '이번 단계에서는 실제 파일을 수정하지 않고 계획/승인까지만 진행해요.\n' +
        creates +
        disclosure +
        APPROVAL_DECISION_LINE,
    };
  }

  /**
   * Reply for "승인" on a `planningOnly` CODE_IMPLEMENTATION request (Live Code Change Planning,
   * ADR-0035). Must NEVER read as "the code was fixed" — nothing was generated, patched, or written
   * this sprint. Distinct from {@link composeExecutionResult}('COMPLETED'), which would falsely
   * imply the work happened.
   */
  composePlanningOnlyApproved(context: ConversationContext): OutboundMessage {
    return {
      context,
      text:
        '승인은 확인했어요. 이번 단계에서는 코드 수정 전 계획까지만 진행했어요. ' +
        '실제 코드 제안/수정은 다음 단계에서 진행할 수 있어요.',
    };
  }

  /**
   * Map a finished/halted execution turn to a natural reply (Conversation Runtime, ADR-0032). The
   * runtime never builds reply text itself — it hands the outcome status (and any produced
   * artifacts) here. AWAITING_APPROVAL is handled by {@link composeApprovalNotice}, not here.
   */
  composeExecutionResult(
    context: ConversationContext,
    status: ExecutionReplyStatus,
    artifacts: Artifact[] = [],
  ): OutboundMessage {
    const text =
      status === 'COMPLETED'
        ? '요청하신 작업을 완료했어요.'
        : status === 'DENIED'
          ? '승인이 거절되어 작업을 진행하지 않았어요.'
          : status === 'CANCELLED'
            ? '작업을 취소했어요.'
            : '작업을 진행하던 중 문제가 생겨서 멈췄어요. 다시 시도해 주세요.'; // STOPPED_ON_FAILURE
    return { context, text, ...(artifacts.length ? { artifacts } : {}) };
  }

  /** Bounded Stage 2B terminal wording. Internal routing identity, raw output, and failure detail stay out. */
  composeProviderRoutingTerminal(
    context: ConversationContext,
    status: ProviderRoutingTerminalReplyStatus,
    failureCode: ProviderGatewayFailureCode | null = null,
  ): OutboundMessage {
    const text =
      failureCode === RoutingFailureCode.SEMANTIC_VALIDATION_UNRESOLVED
        ? '최근 대화에서 확인된 사실과 일치하는 응답을 확정할 수 없어 답변을 전달하지 않았어요.'
        : status === ProviderGatewayTerminalStatus.HUMAN_REVIEW_REQUIRED
        ? '응답을 자동으로 확정할 수 없어 검토가 필요해요.'
        : status === ProviderGatewayTerminalStatus.REJECTED
          ? '응답이 검증 기준을 통과하지 못해 전달하지 않았어요. 다시 시도해 주세요.'
          : status === ProviderGatewayTerminalStatus.SAFETY_BLOCKED
            ? '안전 검증에서 문제가 확인되어 응답을 전달하지 않았어요.'
            : status === ProviderGatewayTerminalStatus.CONFIGURATION_FAILED
              ? '응답 처리 구성이 올바르지 않아 작업을 완료하지 못했어요.'
              : '응답 생성 중 문제가 생겨 작업을 완료하지 못했어요. 다시 시도해 주세요.';
    return { context, text };
  }

  /** A user-facing failure reply (ADR-0015). Never includes technical detail. */
  composeError(context: ConversationContext, userMessage: string): OutboundMessage {
    return { context, text: userMessage };
  }

  /**
   * A sanitized, user-visible inbound-failure response (Sprint 4c-Follow-up-7, F7-D; mutation-certainty
   * correction). Takes an already-mapped {@link SafeError} (raw exception/stack stay in internal logs) and
   * renders the CA-required template: a failure statement, the safe message, a mutation-certainty line
   * (chosen by `ctx.mutationSafety` — conservative `MAY_HAVE_APPLIED` when omitted), the safe code, and
   * optional non-secret stage/requestId. Never carries raw exception text.
   */
  composeSanitizedError(context: ConversationContext, safe: SafeError, ctx: SafeErrorContext = {}): OutboundMessage {
    return { context, text: formatSafeErrorText(safe, ctx) };
  }

  /**
   * A **product test result** (Live Test Execution, ADR-0033; detail added in Test Result Detail
   * UX, ADR-0034). A failing test (exit ≠ 0) is the project's result — NOT a bot/system error — so
   * it is phrased as such. The runtime passes only raw facts (`TestResultDetail` + `passed`); all
   * summarization (excerpt tail/cap, omitted-stream notice, truncation notice) and wording live here.
   */
  composeTestResult(context: ConversationContext, detail: TestResultDetail & { passed: boolean }): OutboundMessage {
    const label = detail.kind === 'typecheck' ? '타입체크' : '테스트';
    const verdict = detail.passed ? `${label}가 모두 통과했어요. ✅` : `${label}에서 실패가 있었어요. ❌`;
    const summary = summarizeOutput(detail.stdout, detail.stderr);
    const text = clampToMessageBudget(
      [
        verdict,
        `명령: ${formatCommand(detail)}`,
        `종료 코드: ${detail.exitCode ?? '-'}`,
        `실행 시간: ${formatDuration(detail.durationMs)}`,
        renderExcerptBlock(summary),
      ].join('\n'),
    );
    return { context, text };
  }

  /**
   * A `TIMED_OUT` `CommandExecution` (Test Result Detail UX, ADR-0034). Distinct from
   * {@link composeTestResult} on purpose (CA review): the process was killed, not evaluated, so this
   * NEVER phrases it as a test failure and NEVER shows an exit code (none exists). `durationMs` is
   * the actual elapsed time, not the configured limit — `TestResultDetail` carries no such value, so
   * the wording only reports what happened, not what the limit was.
   */
  composeTestTimedOut(context: ConversationContext, detail: TestResultDetail): OutboundMessage {
    const label = detail.kind === 'typecheck' ? '타입체크' : '테스트';
    const text = clampToMessageBudget(
      [
        `${label}가 제한 시간 안에 끝나지 않아 중단됐어요.`,
        `명령: ${formatCommand(detail)}`,
        `실행 시간: ${formatDuration(detail.durationMs)}`,
      ].join('\n'),
    );
    return { context, text };
  }

  /** No active project — guide the user to register one first (ADR-0033). */
  composeNeedsProject(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '먼저 사용할 프로젝트를 등록해 주세요. (예: "이 프로젝트 등록해줘: /path/to/project")',
    };
  }

  /** The active project's workspace could not be opened (ADR-0033). */
  composeWorkspaceUnavailable(context: ConversationContext): OutboundMessage {
    return { context, text: '프로젝트 작업 공간을 열 수 없었어요. 프로젝트 경로를 확인해 주세요.' };
  }

  /** The command could not be run (timeout / refused / system error) — not a test result (ADR-0033). */
  composeCommandUnavailable(context: ConversationContext): OutboundMessage {
    return { context, text: '명령을 실행할 수 없었어요. 잠시 후 다시 시도해 주세요.' };
  }

  /**
   * Clarification prompt when a code-change request names no validated target file (Code Change
   * Scope Collection, ADR-0036). No ExecutionPlan/ApprovalRequest exists at this point — this is a
   * plain conversational reply, not an approval/waiting state. Wording is CA-specified (Round 1):
   * asks for a file path as the sufficient ask, frames natural-language scope as optional context
   * only, and tells the user to re-send the full request together with the path (no multi-turn
   * memory this sprint).
   */
  composeTargetScopeClarification(context: ConversationContext): OutboundMessage {
    return {
      context,
      text:
        '수정할 파일 경로와 함께 다시 요청해 주세요.\n' +
        '예: packages/core/src/application/foo.ts 파일에서 이 버그 고쳐줘\n\n' +
        '"로그인 처리 부분"처럼 설명만으로는 아직 부족해요. 어떤 부분을 고치려는지는 파일 경로와 함께 ' +
        '추가로 적어주면 더 좋아요.',
    };
  }

  /** A project registration named a relative/home path (QA-015). Nothing was registered or scanned. */
  composeProjectPathNotAbsolute(context: ConversationContext): OutboundMessage {
    return { context, text: '프로젝트는 절대경로로 등록해 주세요. 예: 이 프로젝트 등록해줘: /Users/me/my-repo' };
  }

  /**
   * A code-change request named a path that cannot be used as a target (QA-016): it does not exist in the project,
   * or it is absolute / traversal / outside the project. The same wording covers every case so the reply never
   * reveals whether an out-of-root file exists. The path is echoed as typed — inside inline code (no mention or
   * markdown can fire), backticks/control characters stripped, truncated.
   */
  composeTargetPathRejected(context: ConversationContext, typedPath: string): OutboundMessage {
    const shown = sanitizeTypedPath(typedPath);
    return {
      context,
      text:
        `요청한 파일을 프로젝트 안에서 찾을 수 없거나 프로젝트 밖 경로예요: \`${shown}\`\n` +
        '등록한 프로젝트 기준 상대경로(예: src/app.ts)로 다시 요청해 주세요.',
    };
  }

  /**
   * Some paths a code-change request named do not exist in the project and the request has no create wording
   * (ADR-0099 D1) — never silently dropped, never guessed. Names every missing path (sanitized like
   * {@link composeTargetPathRejected}) and asks for the request again. Nothing was planned or modified.
   */
  composeTargetsMissing(context: ConversationContext, missingPaths: readonly string[]): OutboundMessage {
    const shown = missingPaths.slice(0, MAX_CHANGE_SET_FILES).map((p) => `\`${sanitizeTypedPath(p)}\``);
    return {
      context,
      text: clampToMessageBudget(
        [
          `요청한 파일 중 프로젝트에서 찾을 수 없는 파일이 있어요: ${shown.join(', ')}`,
          '경로를 확인해서 전체 요청을 다시 보내 주세요. 새로 만들 파일이라면 "새 파일 만들어줘"처럼 함께 적어 주세요.',
          '파일은 수정되지 않았어요.',
        ].join('\n'),
      ),
    };
  }

  /**
   * A code-change request named more files than one change set may carry (ADR-0099 D1) — refused before any
   * lookup; the owner splits the request. Nothing was planned or modified.
   */
  composeTooManyTargets(context: ConversationContext, count: number, max: number = MAX_CHANGE_SET_FILES): OutboundMessage {
    return {
      context,
      text:
        `한 번에 바꿀 수 있는 파일은 ${max}개까지예요. 이 요청에는 파일 경로가 ${count}개 있어요.\n` +
        `요청을 ${max}개 이하의 파일로 나눠서 다시 보내 주세요. 파일은 수정되지 않았어요.`,
    };
  }

  /**
   * Reply for "취소" while a code-change scope clarification is pending (Multi-turn Code Scope
   * Clarification, ADR-0037). No ExecutionPlan/ApprovalRequest/Patch ever existed for this request —
   * the wording must not imply an execution or plan was cancelled, only that the request itself was
   * dropped. Distinct from composeExecutionResult('CANCELLED')'s "작업을 취소했어요", which could be
   * misread as cancelling in-flight work that never existed.
   */
  composeScopeClarificationCancelled(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '코드 변경 요청을 취소했어요. 다시 필요하시면 파일 경로와 함께 새로 요청해 주세요.',
    };
  }

  /**
   * A successful AI code-change proposal preview (AI Code Generation Preview, ADR-0038). Repeats,
   * not merely mentions once, that nothing was applied — never uses wording that could be read as
   * "적용했어요"/"수정했어요"/"반영했어요"/"변경 완료". AI content is rendered inside a fence
   * guaranteed safe against backticks already present in the (untrusted) excerpt.
   */
  composeCodeGenerationPreview(context: ConversationContext, preview: CodeChangePreview): OutboundMessage {
    const lines = [
      '코드 변경 제안이 준비됐어요. 아직 실제로 적용되지 않았어요. 파일은 수정되지 않았어요.',
      ...preview.changes.map((c) => {
        if (c.kind === 'delete') return `- ${c.path} (삭제 제안 — 아직 적용되지 않음)`;
        const excerpt = (c.excerpt ?? '').slice(0, MAX_PREVIEW_EXCERPT_CHARS);
        const fence = fenceFor(excerpt);
        return `- ${c.path}\n${fence}\n${excerpt}\n${fence}`;
      }),
    ];
    const warning = renderOutOfScopeWarning(preview.outOfScopeWarnings);
    if (warning) lines.push(warning);
    // Legacy excerpt-only preview (no runtime caller): it carries no binary/displayability/size facts, so it keeps
    // its original rule — only a single existing-file `update` has an apply step. The ADR-0099 D1 change-set rule
    // lives in isApplyCapablePreview (unified diff previews) and is not approximated here.
    const only = preview.changes.length === 1 ? preview.changes[0] : undefined;
    lines.push(only?.kind === 'update' ? DIFF_PREVIEW_APPLY_FOOTER : DIFF_PREVIEW_FOOTER);
    return { context, text: clampToMessageBudget(lines.join('\n')) };
  }

  /** AI Code Generation failed to produce a usable proposal (ADR-0038). CA-specified wording verbatim. */
  composeCodeGenerationPreviewFailed(context: ConversationContext): OutboundMessage {
    return { context, text: '코드 변경 제안을 생성하지 못했어요.\n파일은 수정되지 않았어요.' };
  }

  /**
   * A validated target's CONTENT carries credential material (private key, vendor token, credential
   * assignment), so it was never sent to the AI provider. Names the target so the user can move the
   * secret out; never echoes any content.
   */
  composeCodeGenerationPreviewCredentialRefused(context: ConversationContext, targetPath: string): OutboundMessage {
    return {
      context,
      text: clampToMessageBudget(
        [
          `이 파일에는 비밀 키나 비밀번호로 보이는 내용이 있어서 AI에게 보내지 않았어요: ${targetPath}`,
          '민감한 값은 환경 변수나 비밀 저장소로 옮긴 뒤 다시 요청해 주세요.',
          '파일은 수정되지 않았어요.',
        ].join('\n'),
      ),
    };
  }

  // ADR-0097 credential-guard override copy: thin, budget-clamped delegates over `credential-override-copy`
  // (paths and line numbers only — never file content or the matched text).

  /** The warning raised with the CRITICAL override request: names file and line and every consequence. */
  composeCredentialOverridePrompt(context: ConversationContext, targetPath: string, line: number): OutboundMessage {
    return { context, text: clampToMessageBudget(credentialOverridePrompt(targetPath, line)) };
  }

  /** A token/private-key refusal that can never be overridden: the credential refusal plus the hard line. */
  composeCredentialOverrideHardRefused(context: ConversationContext, targetPath: string): OutboundMessage {
    const refused = this.composeCodeGenerationPreviewCredentialRefused(context, targetPath).text;
    return { context, text: clampToMessageBudget(`${refused}\n${credentialOverrideHardRefusalLine()}`) };
  }

  /** Any non-decision message (including "승인") while an override is pending; nothing is sent. */
  composeCredentialOverrideReprompt(context: ConversationContext, targetPath: string, remainingMs: number): OutboundMessage {
    return { context, text: clampToMessageBudget(credentialOverrideReprompt(targetPath, remainingMs)) };
  }

  /** The owner refused or cancelled the override: nothing was sent and the request ended. */
  composeCredentialOverrideDenied(context: ConversationContext, targetPath: string): OutboundMessage {
    return { context, text: clampToMessageBudget(credentialOverrideDenied(targetPath)) };
  }

  /** A target's content changed since the override was raised: nothing was sent. */
  composeCredentialOverrideContentChanged(context: ConversationContext, targetPath: string): OutboundMessage {
    return { context, text: clampToMessageBudget(credentialOverrideContentChanged(targetPath)) };
  }

  /**
   * The one-time-send notice on its own. A granted preview carries it inside its header instead
   * (`composeCodeDiffPreview` `credentialOverrideSentPaths`), so preview-aware delivery keeps it.
   */
  composeCredentialOverrideSentNotice(context: ConversationContext, targetPaths: readonly string[]): OutboundMessage {
    return { context, text: clampToMessageBudget(credentialOverrideSentNotice(targetPaths)) };
  }

  /** A send phrase with nothing pending (QA-018 pattern): nothing was sent. */
  composeNoPendingCredentialOverride(context: ConversationContext): OutboundMessage {
    return { context, text: clampToMessageBudget(credentialOverrideNoPending()) };
  }

  /** The override set was already consumed (or is being sent by another turn): never replayed. */
  composeCredentialOverrideAlreadyUsed(context: ConversationContext): OutboundMessage {
    return { context, text: clampToMessageBudget(credentialOverrideAlreadyUsed()) };
  }

  /** The override set was invalidated without sending anything; asks for a fresh request. */
  composeCredentialOverrideInvalidated(
    context: ConversationContext,
    reason: CredentialOverrideInvalidationReason,
  ): OutboundMessage {
    return { context, text: clampToMessageBudget(credentialOverrideInvalidated(reason)) };
  }

  /**
   * Every proposed path was outside the validated targetFiles (AI Code Generation Preview, ADR-0038).
   * Distinct from {@link composeCodeGenerationPreviewFailed}: generation itself succeeded, but
   * nothing it proposed matched the confirmed target — a different, more precise claim. Never
   * presented as a successful proposal.
   */
  composeCodeGenerationPreviewNoValidChange(context: ConversationContext, outOfScopeWarnings: string[]): OutboundMessage {
    const lines = ['AI가 제안한 변경이 확인된 대상 파일과 일치하지 않아 보여드릴 수 없어요.', '파일은 수정되지 않았어요.'];
    const warning = renderOutOfScopeWarning(outOfScopeWarnings);
    if (warning) lines.push(warning);
    return { context, text: clampToMessageBudget(lines.join('\n')) };
  }

  /**
   * A successful unified-diff-style code-change preview (Unified Diff Preview, ADR-0039). Supersedes
   * {@link composeCodeGenerationPreview} as the primary success rendering for a post-approval
   * CodeGeneration preview — that method is retained, unreached from this call site, the same accepted
   * status ADR-0038 gave `composePlanningOnlyApproved`. Must repeat, not merely mention once, that
   * nothing was applied.
   *
   * CA Round 1 Required Change #2: the header and footer (incl. the out-of-scope warning, if any, and
   * a bound on the "files omitted" notice) are reserved budget FIRST; only the remaining budget is
   * spent on file blocks, which are dropped (not truncated mid-block) once that budget is used up. This
   * guarantees the safety wording survives even when the diff content alone would have exceeded
   * MAX_MESSAGE_CHARS — the trailing clampToMessageBudget call below is now a defensive backstop, not
   * the primary guarantee.
   */
  composeCodeDiffPreview(
    context: ConversationContext,
    preview: CodeDiffPreview,
    options: { readonly credentialOverrideSentPaths?: readonly string[] } = {},
  ): OutboundMessage {
    // ADR-0097 D7: a preview built from override-granted content leads with the one-time-send notice. It is part
    // of the header, so it is budgeted with the safety wording and reaches preview-aware (lossless) delivery too.
    const sent = options.credentialOverrideSentPaths ?? [];
    const header = sent.length ? `${credentialOverrideSentNotice(sent)}\n\n${DIFF_PREVIEW_HEADER}` : DIFF_PREVIEW_HEADER;
    const warning = renderOutOfScopeWarning(preview.outOfScopeWarnings);
    // Footer Minimal Fix: an apply-capable single existing-file `update` truthfully advertises apply;
    // every other shape gets the "this shape cannot be applied" footer (accurate — the update-only gate rejects it).
    const footer = isApplyCapablePreview(preview) ? DIFF_PREVIEW_APPLY_FOOTER : DIFF_PREVIEW_FOOTER;
    const footerLines = [...(warning ? [warning] : []), footer];
    const blocks = fitDiffBlocks(header, footerLines, preview.changes.length, (i, maxChars) =>
      renderDiffChange(preview.changes[i]!, maxChars),
    );
    const text = assembleBoundedBody(header, footerLines, blocks);
    // F5-A (Sprint 4c-Follow-up-5): also attach a COMPLETE structured preview (full canonical diff, never
    // clamped). A preview-aware adapter delivers this losslessly (multipart or `.diff` attachment) so the
    // final result is never content-dropped; `text` above is a bounded fallback for preview-unaware
    // adapters. Binary/empty diffs carry no renderable body and are excluded from the canonical payload.
    const files: PreviewFile[] = preview.changes
      .filter((c) => !c.binary && c.unified.trim().length > 0)
      .map((c) => ({ path: c.path, changeKind: c.kind, unifiedDiff: c.unified }));
    if (files.length === 0) return { context, text };
    // F5-E (Sprint 4c-Follow-up-5): one stable, secret-safe correlation id for the whole delivery
    // lifecycle. `newId()` is a fresh non-content id (never a diff hash), filesystem-safe for the filename.
    const previewId = newId();
    return {
      context,
      text,
      preview: {
        previewId,
        header,
        // F5 (Sprint 4c-Follow-up-5): carry the out-of-scope safety warning INTO the artifact so a
        // preview-aware adapter (which delivers `preview`, not `text`) still surfaces it. Absent → clean.
        ...(warning ? { warning } : {}),
        footer,
        files,
        canonicalDiff: buildCanonicalDiff(files),
        attachmentFilename: `quoky-preview-${previewId}.diff`,
      },
    };
  }

  /**
   * The second approval exists to authorize FILE MODIFICATION — distinct from the first approval (which
   * only authorized generating a preview) (Explicit Preview Apply Approval, ADR-0040). Must say so
   * explicitly, mention that actual apply will re-validate/re-diff against the latest file content, and
   * name all three decision words (not just 승인/취소).
   */
  composeApplyApprovalRequested(context: ConversationContext, targetFiles: string[]): OutboundMessage {
    return {
      context,
      text:
        `AI가 준비한 코드 변경을 실제 파일(${targetFiles.join(', ')})에 적용하려면 별도 승인이 필요해요.\n` +
        '이 승인은 미리보기 생성이 아니라 실제 파일 수정을 위한 것이에요. 아직 파일은 수정되지 않았어요.\n' +
        '실제 적용 시에는 최신 파일 내용으로 다시 확인해요.\n' +
        '진행하려면 "승인", 거절하려면 "거절", 그만두려면 "취소"라고 답해 주세요.',
    };
  }

  /**
   * Explicit apply intent detected, but no eligible preview/refs to apply (ADR-0040). Never creates an
   * approval.
   */
  composeApplyPreviewUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '적용할 수 있는 코드 변경 미리보기가 없어요. 먼저 코드 변경을 요청하고 미리보기를 확인해 주세요.',
    };
  }

  /**
   * The apply approval was recorded (or was already approved and the user asked again) — this sprint
   * does not implement the apply step itself (ADR-0040). Must not read as if the task is complete —
   * never "적용 완료"/"반영 완료"/"수정했어요".
   */
  composeApplyApprovalRecorded(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '적용 승인만 기록했어요.\n아직 실제 파일 적용은 수행하지 않았어요.\n파일은 수정되지 않았어요.\n다음 단계로 "패치 만들어줘"라고 요청하면 적용 전에 확인할 수 있는 패치 미리보기를 만들어 드려요.',
    };
  }

  /**
   * A generated PatchSet preview (Approved Apply Context → PatchSet Preview, ADR-0041). CA Round 1
   * Required Change #3: "패치 미리보기" framing — a PatchSet REPRESENTATION exists, nothing was applied.
   * Reuses the Sprint 2r budget-aware, backtick-safe block assembly. Must repeat, not merely mention
   * once, that files were not modified; never "적용했어요"/"반영했어요"/"수정했어요"/"변경 완료"/"적용 완료".
   */
  composePatchSetPreview(context: ConversationContext, preview: PatchSetPreview): OutboundMessage {
    const blocks = fitDiffBlocks(PATCH_PREVIEW_HEADER, [PATCH_PREVIEW_FOOTER], preview.operations.length, (i, maxChars) =>
      renderPatchOperation(preview.operations[i]!, maxChars),
    );
    return { context, text: assembleBoundedBody(PATCH_PREVIEW_HEADER, [PATCH_PREVIEW_FOOTER], blocks) };
  }

  /**
   * No approved apply context to build a patch from (ADR-0041, CA Q3) — no anchor / not APPROVED /
   * missing approval / missing proposal / all-out-of-scope. Never implies anything was generated or applied.
   */
  composePatchUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '패치를 만들 수 있는 승인된 코드 변경이 없어요. 먼저 코드 변경을 요청하고 미리보기·적용 승인을 완료해 주세요.',
    };
  }

  /**
   * Approved, but the latest diff/generation could not be built cleanly (ADR-0041, CA Q7) — stale/add/
   * binary/empty/throw. Safe user-facing message; the failure reason is logged separately (never here).
   */
  composePatchGenerationFailed(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '승인된 변경으로 패치를 만들지 못했어요. 파일 내용이 바뀌었거나 표시할 수 없는 변경일 수 있어요. 파일은 수정되지 않았어요.',
    };
  }

  /**
   * A PatchSet was already generated (anchor PATCH_READY) and the user asked again (ADR-0041) — no
   * regeneration. Must not read as if the patch was applied.
   */
  composePatchAlreadyGenerated(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '이미 패치 미리보기를 만들어 뒀어요.\n아직 실제 파일 적용은 하지 않았어요.\n파일은 수정되지 않았어요.',
    };
  }

  /**
   * Successful workspace file mutation (PatchRef → WorkspaceWrite Apply, ADR-0042). CA Round 1 #5/#6/Q10:
   * says the file was modified, git COMMANDS were not run, commit/push were not performed, tests were not
   * run, and the working tree may now hold the change. Never "git 변경 없음"/committed/pushed/deployed/
   * verified/적용 완료 — after a write the working tree is NOT clean.
   */
  composeWorkspaceApplied(context: ConversationContext, targetFiles: string[], newFiles: readonly string[] = []): OutboundMessage {
    // ADR-0099 D3: a created file is marked; with no new file the text is unchanged.
    const isNew = new Set(newFiles);
    const files = targetFiles.map((f) => (isNew.has(f) ? `${f} (새 파일)` : f)).join(', ');
    return {
      context,
      text:
        `파일을 수정했어요: ${files}\n` +
        'git 명령은 실행하지 않았어요. 커밋/푸시는 하지 않았어요.\n' +
        '작업 트리에는 방금 적용한 파일 변경이 남아 있을 수 있어요.\n' +
        '테스트도 실행하지 않았어요.\n' +
        WORKSPACE_APPLIED_NEXT_LINE,
    };
  }

  /**
   * No PATCH_READY apply context to write (ADR-0042, CA Q4) — no anchor / not PATCH_READY / PATCH_READY
   * without patchRef. Never implies anything was written.
   */
  composeWorkspaceApplyUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금 파일에 적용할 수 있는 준비된 패치가 없어요. 먼저 코드 변경 요청 → 승인 → 패치 생성을 완료해 주세요.',
    };
  }

  /**
   * PATCH_READY but the PatchSet is missing/invalid/unsupported, or WorkspaceWrite failed / the diff no
   * longer applies cleanly (stale/conflict) (ADR-0042, CA Q5/Q6). Safe; the reason is logged separately,
   * never here. CA Round 1 #5: "git 명령이나 테스트는 실행하지 않았어요", never "git 변경 없음".
   */
  composeWorkspaceApplyFailed(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '이 패치를 파일에 적용하지 못했어요. 파일 내용이 바뀌었거나 지원하지 않는 변경일 수 있어요. git 명령이나 테스트는 실행하지 않았어요.',
    };
  }

  /**
   * A change-set apply failed and was rolled back (ADR-0099 D2, `ROLLED_BACK`) — every file the set wrote was
   * restored and every created file removed, so nothing changed. The patch is still ready; no git/test ran.
   */
  composeWorkspaceApplyRolledBack(context: ConversationContext, files: readonly string[]): OutboundMessage {
    return {
      context,
      text: clampToMessageBudget(
        [
          `변경 묶음을 파일에 적용하지 못해서 되돌렸어요. 바뀐 파일은 없어요: ${renderFileList(files)}`,
          '파일 내용이 바뀌었거나 지원하지 않는 변경일 수 있어요. git 명령이나 테스트는 실행하지 않았어요.',
        ].join('\n'),
      ),
    };
  }

  /**
   * A change-set apply could not be verified or its rollback failed (ADR-0099 D2, `PARTIALLY_APPLIED`) — part
   * of the set MAY be on disk. Uses the existing "may have applied" wording and names the files to check; never
   * claims nothing changed and never claims it applied.
   */
  composeWorkspaceApplyPartiallyApplied(context: ConversationContext, files: readonly string[]): OutboundMessage {
    return {
      context,
      text: clampToMessageBudget(
        [
          '변경 묶음을 적용하던 중 문제가 생겼고, 일부 파일에는 변경이 적용됐을 수 있어요.',
          `확인할 파일: ${renderFileList(files)}`,
          '파일 상태를 직접 확인해 주세요. git 명령이나 테스트는 실행하지 않았어요.',
        ].join('\n'),
      ),
    };
  }

  /**
   * WORKSPACE_APPLIED + another final/patch/apply command (ADR-0042) — no re-apply, and must not hide the
   * applied state (CA Round 1 #8). CA Round 1 #5: "git 명령이나 테스트는 실행하지 않았어요".
   */
  composeWorkspaceAlreadyApplied(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '이미 파일을 수정했어요. git 명령이나 테스트는 실행하지 않았어요.',
    };
  }

  /**
   * Post-apply validation PASSED (Post-Apply Validation Command, ADR-0043). Reuses the Sprint 2m/2n
   * bounded-output helpers. CA Required Change #5: states git commands were NOT run AND commit/push were
   * NOT performed. "This-run" phrasing only — a pass is point-in-time. Never
   * committed/pushed/deployed/완전히 검증/배포 가능/clean tree/git 변경 없음.
   */
  composePostApplyValidationPassed(context: ConversationContext, detail: TestResultDetail): OutboundMessage {
    const label = detail.kind === 'typecheck' ? '타입체크' : '테스트';
    const summary = summarizeOutput(detail.stdout, detail.stderr);
    const text = clampToMessageBudget(
      [
        `이번 실행 기준으로 ${label}가 통과했어요. ✅`,
        `명령: ${formatCommand(detail)}`,
        `종료 코드: ${detail.exitCode ?? '-'}`,
        `실행 시간: ${formatDuration(detail.durationMs)}`,
        renderExcerptBlock(summary),
        'git 명령은 실행하지 않았어요. 커밋/푸시는 하지 않았어요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /**
   * Post-apply validation FAILED (ADR-0043) — the project's result, not a bot/system error. CA Required
   * Change #5: git commands were NOT run AND commit/push were NOT performed; and rollback was NOT
   * performed (the applied file is left as-is). Never git 변경 없음/committed/pushed/deployed/clean tree.
   */
  composePostApplyValidationFailed(context: ConversationContext, detail: TestResultDetail): OutboundMessage {
    const label = detail.kind === 'typecheck' ? '타입체크' : '테스트';
    const summary = summarizeOutput(detail.stdout, detail.stderr);
    const text = clampToMessageBudget(
      [
        `${label}에서 실패가 있었어요. ❌ (적용한 파일은 그대로 두었어요)`,
        `명령: ${formatCommand(detail)}`,
        `종료 코드: ${detail.exitCode ?? '-'}`,
        `실행 시간: ${formatDuration(detail.durationMs)}`,
        renderExcerptBlock(summary),
        'git 명령은 실행하지 않았어요. 커밋/푸시는 하지 않았어요.',
        '되돌리기(rollback)도 하지 않았어요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /**
   * Post-apply validation TIMED_OUT (ADR-0043) — distinct from a failure verdict (CA Q11): the process was
   * killed, not evaluated, so no exit code is shown. CA Required Change #5: git commands were NOT run AND
   * commit/push were NOT performed. States validation did not complete; the applied file is left as-is.
   */
  composePostApplyValidationTimedOut(context: ConversationContext, detail: TestResultDetail): OutboundMessage {
    const label = detail.kind === 'typecheck' ? '타입체크' : '테스트';
    const text = clampToMessageBudget(
      [
        `${label}가 제한 시간 안에 끝나지 않아 중단됐어요. (검증이 끝까지 완료되지 않았어요)`,
        `명령: ${formatCommand(detail)}`,
        `실행 시간: ${formatDuration(detail.durationMs)}`,
        'git 명령은 실행하지 않았어요. 커밋/푸시는 하지 않았어요.',
        '적용한 파일은 그대로 있어요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /**
   * Ambiguous validation — bare "검증", OR both test and typecheck requested (ADR-0043, CA Round 1 #1). Ask
   * for exactly one. A NORMAL response (RESPONDED), never a failure (CA Round 1 #3); no command runs.
   */
  composePostApplyValidationClarify(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '한 번에 하나만 검증할 수 있어요. "테스트" 또는 "타입체크" 중에 무엇을 실행할지 알려 주세요. (pnpm test / pnpm typecheck)',
    };
  }

  /**
   * A validation phrase carried a command outside the allow-list (ADR-0043, CA Round 1 #2) — distinct from
   * the ambiguous "검증" clarify. A NORMAL response (RESPONDED); no command runs.
   */
  composePostApplyValidationUnsupported(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '검증 명령은 pnpm test 또는 pnpm typecheck만 실행할 수 있어요. 다른 명령은 실행하지 않았어요.',
    };
  }

  /**
   * Validation could not run at all (unexpected throw / non-terminal status, ADR-0043) — not a validation
   * verdict. States git commands were NOT run and commit/push were NOT performed.
   */
  composePostApplyValidationUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '검증 명령을 실행할 수 없었어요. 잠시 후 다시 시도해 주세요. git 명령은 실행하지 않았어요. 커밋/푸시는 하지 않았어요.',
    };
  }

  /**
   * Read-only git status preview (Post-Validation Git Status Preview, ADR-0044). Branch + bounded changed
   * files (≤30, labeled); clean → "현재 Git 기준 변경 파일이 없어요." (never infers tests passed / deploy).
   * Always carries the fixed read-only disclaimers (CA #10) and the record-only validation context (CA Q8).
   * Forbidden: 커밋 준비 완료 / push 가능 / 배포 가능 / 검증 완료 / committed / pushed / deployed.
   */
  composeGitStatusPreview(context: ConversationContext, input: { status: GitStatus; validation: ValidationContext }): OutboundMessage {
    const text = clampToMessageBudget(
      [
        renderChangedFiles(input.status),
        renderValidationContext(input.validation),
        ...GIT_READONLY_DISCLAIMER,
      ].join('\n'),
    );
    return { context, text };
  }

  /**
   * Read-only git diff preview (ADR-0044). Takes BOTH status and diff: the unified diff shows TRACKED
   * staged/unstaged changes only (≤5 files / ≤3000 chars, truncation labeled; binary → marker only), and
   * untracked paths are surfaced from `status` — the reply says so explicitly (CA #2). Fixed read-only
   * disclaimers + record-only validation context.
   */
  composeGitDiffPreview(context: ConversationContext, input: { status: GitStatus; diff: GitDiff; validation: ValidationContext }): OutboundMessage {
    const untracked = input.status.untracked;
    const untrackedLine = untracked.length
      ? `untracked 파일 (${untracked.length}): ${untracked.slice(0, MAX_GIT_CHANGED_FILES).join(', ')}${untracked.length > MAX_GIT_CHANGED_FILES ? ' 외 …' : ''}`
      : 'untracked 파일은 없어요.';
    // The mandatory "frame" (branch + notes + validation + read-only disclaimers) must always survive; size
    // the diff block so the whole message fits MAX_MESSAGE_CHARS and the final clamp never eats the frame.
    const DIFF_SLOT = ' DIFF ';
    const frameLines = [
      `브랜치: ${input.status.branch || '(unknown)'}`,
      DIFF_SLOT,
      'diff는 추적 중인 파일 변경만 포함해요. untracked 파일은 상태 목록에만 표시돼요.',
      untrackedLine,
      renderValidationContext(input.validation),
      ...GIT_READONLY_DISCLAIMER,
    ];
    const frameLen = frameLines.join('\n').length - DIFF_SLOT.length;
    const diffBudget = MAX_MESSAGE_CHARS - frameLen - 60; // 60: fences + truncation label margin
    const diffBlock = renderDiffBlock(input.diff, diffBudget);
    const text = clampToMessageBudget(frameLines.map((l) => (l === DIFF_SLOT ? diffBlock : l)).join('\n'));
    return { context, text };
  }

  /**
   * A git MUTATION phrase other than a plain commit request (푸시/add/reset/stash/…, or a bare English `commit`)
   * arrived on the post-apply path (ADR-0044, CA Q4) — no git ran. QA-020: local commit IS supported ("커밋해줘",
   * ADR-0045/0046), so the copy never says commit is unsupported. `scope: 'remote'` (a push/remote phrase) says
   * remote git is off in Personal v1 (`remoteEnabled` false, the default) or that a push needs a local commit
   * first; `scope: 'local'` names the unsupported local operations. Never implies a commit/push happened.
   */
  composeGitMutationNotSupported(
    context: ConversationContext,
    input: { scope: 'remote' | 'local'; remoteEnabled?: boolean } = { scope: 'local' },
  ): OutboundMessage {
    const lines =
      input.scope === 'remote'
        ? input.remoteEnabled
          ? ['push는 로컬 커밋을 먼저 한 뒤에 요청할 수 있어요. 먼저 "커밋해줘"로 커밋해 주세요.']
          : [
              '원격 git 작업(push 등)은 Personal v1에서 꺼져 있어요(QUOKY_GIT_REMOTE_ENABLED=false). ' +
                '로컬 커밋은 "커밋해줘"로 할 수 있어요.',
            ]
        : [
            'git add/reset/stash/checkout/merge 같은 git 작업은 지원하지 않아요. 로컬 커밋은 "커밋해줘"로 할 수 있어요.',
            '읽기 전용 미리보기(git 상태 / diff)도 볼 수 있어요.',
          ];
    return { context, text: [...lines, 'git 명령은 실행하지 않았어요.'].join('\n') };
  }

  /**
   * Git read failed / not a repository (ADR-0044, CA Q10; CA Implementation Review — blocking fix). This is
   * the READ-FAILURE path: a read-only git subcommand (via GitProvider) WAS attempted, so it must NOT claim
   * "git 명령은 실행하지 않았어요". It states what was NOT done: no git add/commit/push, no file mutation, no
   * CommandExecution/shell fallback. Not a status/diff verdict.
   */
  composeGitPreviewUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text:
        'Git 상태를 읽지 못했어요. 잠시 후 다시 시도해 주세요.\n' +
        '읽기 전용 Git 확인 중 문제가 발생했지만, git add/commit/push는 하지 않았어요.\n' +
        '파일 수정은 하지 않았고, CommandExecution을 통한 명령 실행도 하지 않았어요.',
    };
  }

  /**
   * Git-commit approval REQUESTED (Explicit Git Commit Approval, ADR-0045). AWAITING_APPROVAL prompt: bounded
   * candidate files (≤30) + commit message + validation record + 승인/거절. CA #4/#5: MUST state approving
   * does NOT run git add/commit/push in this step and that actual commit is a later step. Says nothing is
   * committed.
   */
  composeCommitApprovalRequested(
    context: ConversationContext,
    input: { candidateFiles: string[]; commitMessage: string; validation: ValidationContext; newFiles?: readonly string[] },
  ): OutboundMessage {
    // ADR-0099 D3: new files are marked "(새 파일)" — the commit will `git add` exactly those.
    const files = renderFileList(input.candidateFiles, input.newFiles);
    const text = clampToMessageBudget(
      [
        '커밋 승인을 요청했어요.',
        `대상 파일: ${files}`,
        `커밋 메시지: ${input.commitMessage}`,
        renderValidationContext(input.validation),
        '승인해도 이번 단계에서는 실제 git add/commit/push는 수행하지 않아요.',
        '실제 커밋 실행은 다음 단계에서 진행돼요. 진행하려면 "승인", 원치 않으면 "거절"이라고 알려 주세요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /**
   * Commit requested while the workspace is on main/master (QA-022, ADR-0094) — refused before any approval is
   * created; no git mutation ran (only the read-only status that reported the branch).
   */
  composeCommitProtectedBranch(context: ConversationContext): OutboundMessage {
    return {
      context,
      text:
        'main/master 브랜치에는 커밋하지 않아요. 작업용 브랜치(예: feature/…)로 전환한 뒤 다시 요청해 주세요.\n' +
        '커밋 승인 요청은 만들지 않았어요. git add/commit/push는 하지 않았어요.',
    };
  }

  /** Commit approval RECORDED after "승인" (ADR-0045, CA #10) — records permission only; never says committed. */
  composeCommitApprovalRecorded(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: `커밋 승인은 기록했어요.\n아직 실제 git add/commit/push는 수행하지 않았어요.\n${COMMIT_EXECUTE_NEXT_LINE}`,
    };
  }

  /** Commit approval DENIED (ADR-0045, CA #11) — commit-specific; the applied files remain. */
  composeCommitApprovalDenied(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '커밋 승인을 거절했어요.\n이미 적용된 파일 변경은 그대로 있어요. 실제 git commit은 수행하지 않았어요.',
    };
  }

  /** Commit approval CANCELLED (ADR-0045, CA #11) — commit-specific; the applied files remain. */
  composeCommitApprovalCancelled(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '커밋 승인을 취소했어요.\n이미 적용된 파일 변경은 그대로 있어요. 실제 git commit은 수행하지 않았어요.',
    };
  }

  /** Nothing to commit — Git reports a clean tree (ADR-0045). No approval was created. */
  composeCommitNothingToCommit(context: ConversationContext): OutboundMessage {
    return { context, text: '현재 Git 기준 커밋할 변경이 없어요. 커밋 승인 요청은 만들지 않았어요.' };
  }

  /**
   * Changed files outside the applied scope (or unsafe paths) exist (ADR-0045, CA #6/#7/#14) — no approval.
   * Bounded (≤10 shown).
   */
  composeCommitOutOfScopeChanges(context: ConversationContext, outOfScope: string[]): OutboundMessage {
    const shown = outOfScope.slice(0, MAX_COMMIT_OUT_OF_SCOPE_SHOWN);
    const omitted = outOfScope.length - shown.length;
    const list = shown.length ? `${shown.join(', ')}${omitted > 0 ? ` 외 ${omitted}개` : ''}` : '(없음)';
    return {
      context,
      text:
        `적용 대상 밖의(또는 안전하지 않은) 변경이 있어서 커밋 승인을 만들지 않았어요: ${list}\n` +
        '적용한 파일만 커밋할 수 있도록 먼저 정리가 필요해요. git 명령은 실행하지 않았어요.',
    };
  }

  /** User-provided commit message failed validation (ADR-0045, CA #8) — ask again; no approval. */
  composeCommitMessageInvalid(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '커밋 메시지는 한 줄로, 120자 이하, 하나만 알려 주세요. (예: 메시지는 "fix: …") 커밋 승인 요청은 만들지 않았어요.',
    };
  }

  /** Commit not available — wrong state / incomplete pending context (ADR-0045, CA #12). Not a git-read failure. */
  composeCommitUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 커밋 승인을 준비할 수 없어요. 먼저 코드 변경을 적용(WORKSPACE_APPLIED)한 뒤에 커밋을 요청해 주세요. git 명령은 실행하지 않았어요.',
    };
  }

  /**
   * Git STATUS read failure on the commit path (ADR-0045, CA #9/#12) — a read WAS attempted, so it must NOT
   * say "git 명령은 실행하지 않았어요". No approval, no CommandExecution/shell fallback.
   */
  composeCommitStatusUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text:
        '커밋 준비를 위해 읽기 전용 Git 상태를 확인하는 중 문제가 발생했어요.\n' +
        '커밋 승인 요청은 만들지 않았어요. git add/commit/push는 하지 않았고, CommandExecution/shell fallback도 쓰지 않았어요.',
    };
  }

  /** Commit already approved (COMMIT_APPROVED, ADR-0045, CA #10) — not committed; execution is a later step. */
  composeCommitAlreadyApproved(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: `이미 커밋 승인을 받아 뒀어요.\n아직 실제 git add/commit/push는 수행하지 않았어요.\n${COMMIT_EXECUTE_NEXT_LINE}`,
    };
  }

  /** Commit bundled with push/reset/add/… (ADR-0045) — commit-approval planning only; no git ran. */
  composeCommitUnsupportedCompanion(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '커밋 승인만 준비할 수 있어요. push/reset/add 같은 다른 git 작업은 아직 지원하지 않아요. git 명령은 실행하지 않았어요.',
    };
  }

  /**
   * Approved commit EXECUTED (Sprint 2y, ADR-0046) — the first real git mutation. States the short hash +
   * bounded committed files and, per the no-overclaim rule, that `git push` was NOT run (committed only,
   * never pushed/deployed).
   */
  composeCommitExecuted(
    context: ConversationContext,
    input: { commitHash: string; files: string[]; newFiles?: readonly string[] },
  ): OutboundMessage {
    const shortHash = input.commitHash.slice(0, 7);
    const files = input.files.length ? renderFileList(input.files, input.newFiles) : '(없음)';
    const text = clampToMessageBudget(
      [`커밋했어요: ${shortHash}`, `대상 파일: ${files}`, 'git push는 하지 않았어요.'].join('\n'),
    );
    return { context, text };
  }

  /**
   * Commit EXECUTION failed (Sprint 2y, ADR-0046, CA #10) — MUST state not committed + no push + rollback NOT
   * performed + re-check git state. MUST NOT claim 변경 없음 / 원상복구 완료 / index unchanged / 안전하게
   * 되돌렸어요. No raw stderr (the adapter masks it).
   */
  composeCommitExecutionFailed(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '커밋을 완료하지 못했어요. git push는 하지 않았어요. rollback은 수행하지 않았어요. Git 상태는 다시 확인해 주세요.',
    };
  }

  /**
   * Commit EXECUTION not available (Sprint 2y, ADR-0046) — wrong state / stale-or-mismatched approval / scope
   * changed since approval. A NEW commit approval is required; nothing was committed, no git mutation ran.
   */
  composeCommitExecutionUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 승인된 커밋을 실행할 수 없어요. 승인 이후 상태가 달라졌거나 승인이 유효하지 않아요. 다시 커밋 승인을 받아 주세요. git commit/push는 하지 않았어요.',
    };
  }

  /**
   * An approved candidate is an untracked (new) file that was NOT requested as a new file (Sprint 2y, ADR-0046,
   * CA #3; ADR-0099 D3) — DISTINCT from unavailable. Only files the owner asked to create in the code-change
   * request are `git add`ed; any other untracked file is never added. Nothing committed, no push.
   */
  composeCommitExecutionUntrackedUnsupported(context: ConversationContext): OutboundMessage {
    return {
      context,
      text:
        '승인된 후보 파일 중 새로 만들기로 요청하지 않은 새 파일(untracked)이 있어 커밋하지 않았어요.\n' +
        '코드 변경 요청에서 새 파일로 요청한 파일만 git add해서 커밋해요. git push는 하지 않았어요.',
    };
  }

  /**
   * Execution requested again after a successful commit (Sprint 2y, ADR-0046, Q11) — GIT_COMMITTED. Already
   * committed (shows the recorded hash); no new commit, no push.
   */
  composeCommitAlreadyCommitted(context: ConversationContext, commitHash?: string): OutboundMessage {
    const shown = commitHash ? commitHash.slice(0, 7) : '(hash 미상)';
    return { context, text: `이미 커밋했어요: ${shown}. 새로 커밋하지 않았어요. git push는 하지 않았어요.` };
  }

  /**
   * A push/reset/… phrase on a commit-relevant anchor (Sprint 2y, ADR-0046) — push is not supported this
   * sprint; commit only. No git ran, no mutation.
   */
  composeCommitPushUnsupported(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'push는 아직 지원하지 않아요. 커밋만 가능해요. push는 하지 않았어요.',
    };
  }

  /**
   * Git-push approval REQUESTED (Explicit Git Push Approval, Sprint 2z, ADR-0047). AWAITING_APPROVAL prompt:
   * short hash + bounded remote/branch + ahead count + 승인/거절. States approving does NOT run `git push`
   * in this step and that the approval is a point-in-time snapshot (re-check before actual push) (CA #4/#6).
   * Never says pushed / ready-to-push / push-safe / deployed.
   */
  composePushApprovalRequested(
    context: ConversationContext,
    input: { commitHash: string; remote: string; branch: string; upstream: string; ahead: number },
  ): OutboundMessage {
    const shortHash = input.commitHash.slice(0, 7);
    const remote = input.remote.slice(0, MAX_GIT_REF_DISPLAY);
    const branch = input.branch.slice(0, MAX_GIT_REF_DISPLAY);
    const text = clampToMessageBudget(
      [
        'push 승인을 요청했어요.',
        `커밋: ${shortHash}`,
        `대상: ${remote}/${branch} (원격보다 ${input.ahead}개 앞섬)`,
        '승인해도 이번 단계에서는 실제 git push를 하지 않아요.',
        '승인은 현재 확인한 Git 상태 기준이에요. 실제 push 실행 전에는 다시 확인이 필요해요.',
        '진행하려면 "승인", 원치 않으면 "거절"이라고 알려 주세요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /** Push approval RECORDED after "승인" (Sprint 2z) — records permission only; never says pushed. */
  composePushApprovalRecorded(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'push 승인은 기록했어요.\n아직 실제 git push는 하지 않았어요. (실제 push는 이후 단계에서 Git 상태를 다시 확인한 뒤 진행돼요)',
    };
  }

  /** Push approval DENIED (Sprint 2z) — the local commit remains; nothing pushed. */
  composePushApprovalDenied(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'push 승인을 거절했어요.\n커밋은 로컬에 그대로 있어요. git push는 하지 않았어요.',
    };
  }

  /** Push approval CANCELLED (Sprint 2z) — the local commit remains; nothing pushed. */
  composePushApprovalCancelled(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'push 승인을 취소했어요.\n커밋은 로컬에 그대로 있어요. git push는 하지 않았어요.',
    };
  }

  /** Push approval not available — wrong state / incomplete or stale pending context (Sprint 2z). No push. */
  composePushApprovalUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 push 승인을 준비할 수 없어요. 먼저 커밋을 완료(GIT_COMMITTED)한 뒤에 push를 요청해 주세요. git push는 하지 않았어요.',
    };
  }

  /**
   * Read-only Git inspection failed on the push path (Sprint 2z) — a read WAS attempted, so it does NOT say
   * "git 명령은 실행하지 않았어요"; states no approval, no push, and no CommandExecution/shell fallback.
   */
  composePushStatusUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text:
        'push 준비를 위해 읽기 전용 Git 상태를 확인하는 중 문제가 발생했어요.\n' +
        'push 승인 요청은 만들지 않았어요. git push는 하지 않았고, CommandExecution/shell fallback도 쓰지 않았어요.',
    };
  }

  /** HEAD moved / detached — no longer the committed hash (Sprint 2z). Committed state changed; re-review; no push. */
  composePushHeadMovedUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '커밋 이후 Git 상태(HEAD)가 바뀌었어요. push 승인을 만들지 않았어요. 다시 검토하고 승인을 받아 주세요. git push는 하지 않았어요.',
    };
  }

  /** Working tree has uncommitted changes (Sprint 2z, CA #10) — commit/clean first; no approval, no push. */
  composePushDirtyWorkingTree(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '로컬에 커밋되지 않은 변경이 있어서 push 승인을 만들지 않았어요. 먼저 커밋하거나 변경을 정리해 주세요. git push는 하지 않았어요.',
    };
  }

  /** No (or unparseable) upstream (Sprint 2z) — 2z does not create/ask for an upstream; no approval, no push. */
  composePushNoUpstream(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '업스트림(추적 브랜치)을 확인할 수 없어 push 대상을 정할 수 없어요. 이번 단계에서는 업스트림을 새로 만들지 않아요. push 승인은 만들지 않았어요.',
    };
  }

  /** Nothing to push — the branch is not ahead of its upstream (Sprint 2z). No approval, no push. */
  composePushNothingToPush(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '원격보다 앞선 커밋이 없어 push할 게 없어요. push 승인은 만들지 않았어요.',
    };
  }

  /** Branch has diverged (behind > 0) (Sprint 2z) — resolve first; no approval, no force push. */
  composePushDiverged(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '브랜치가 원격과 갈라졌어요(diverged). 먼저 정리가 필요해요. 강제 push는 하지 않아요. push 승인은 만들지 않았어요.',
    };
  }

  /** Push already approved (PUSH_APPROVED, Sprint 2z) — not pushed; no new approval. */
  composePushAlreadyApproved(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '이미 push 승인을 받아 뒀어요.\n아직 실제 git push는 하지 않았어요. (실제 push는 이후 단계에서 다시 확인 후 진행돼요)',
    };
  }

  /** Push bundled with force/PR/deploy/tag/branch/… (Sprint 2z) — push approval only; no approval, no git. */
  composePushUnsupportedCompanion(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'push 승인만 준비할 수 있어요. force push/PR/배포/태그/브랜치/reset 같은 다른 작업은 지원하지 않아요. git push는 하지 않았어요.',
    };
  }

  /**
   * Approved git push EXECUTED (Sprint 3a, ADR-0048) — the first remote mutation. States the short hash +
   * bounded remote/branch and, per the no-overclaim rule, that PR creation and deployment were NOT done.
   * Never says ready-to-push / push-safe / deploy-ready / PR created (CA #1/#14).
   */
  composePushExecuted(
    context: ConversationContext,
    input: { commitHash: string; remote: string; branch: string },
  ): OutboundMessage {
    const shortHash = input.commitHash.slice(0, 7);
    const remote = input.remote.slice(0, MAX_GIT_REF_DISPLAY);
    const branch = input.branch.slice(0, MAX_GIT_REF_DISPLAY);
    const text = clampToMessageBudget(
      [`원격에 push했어요: ${shortHash} → ${remote}/${branch}`, 'PR 생성과 배포는 하지 않았어요.'].join('\n'),
    );
    return { context, text };
  }

  /**
   * Push execution not available (Sprint 3a, ADR-0048, CA #2) — a PRE-push failure (wrong state / stale
   * approval / HEAD·upstream drift / malformed persisted target). Safe to state git push was NOT attempted;
   * a new push approval is needed.
   */
  composePushExecutionUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 승인된 push를 실행할 수 없어요. 승인 이후 상태가 달라졌거나 승인이 유효하지 않아요. 다시 push 승인을 받아 주세요. git push는 시도하지 않았어요.',
    };
  }

  /**
   * The `git push` provider call failed (Sprint 3a, ADR-0048, CA #2/#10) — do NOT claim the remote is
   * unchanged / definitely not pushed; say the push did not complete and the remote should be checked if
   * unsure; NO rollback. No raw stderr (adapter masks).
   */
  composePushExecutionFailed(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'push를 완료하지 못했어요. 원격 상태는 필요하면 직접 확인해 주세요. rollback은 하지 않았어요.',
    };
  }

  /**
   * The `git push` provider reported success but the result did not match the approved target (Sprint 3a,
   * ADR-0048, CA #2/#10) — the push may have been attempted; the result could not be verified; check the
   * remote manually; NO rollback; NOT re-anchored to GIT_PUSHED.
   */
  composePushResultUnverified(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'push는 시도됐지만 결과를 확인할 수 없어요. 원격 상태를 직접 확인해 주세요. rollback은 하지 않았어요.',
    };
  }

  /**
   * A push/execution phrase after a successful push (GIT_PUSHED, Sprint 3a, Q13/CA #7) — already pushed
   * (shows the pushed hash + target); no new push.
   */
  composePushAlreadyPushed(
    context: ConversationContext,
    input: { commitHash?: string; remote?: string; branch?: string },
  ): OutboundMessage {
    const shown = input.commitHash ? input.commitHash.slice(0, 7) : '(hash 미상)';
    const target =
      input.remote && input.branch ? ` → ${input.remote.slice(0, MAX_GIT_REF_DISPLAY)}/${input.branch.slice(0, MAX_GIT_REF_DISPLAY)}` : '';
    return { context, text: `이미 push했어요: ${shown}${target}. 다시 push하지 않았어요.` };
  }

  /**
   * A deploy-only phrase after a successful push (GIT_PUSHED, Sprint 3a → narrowed in Sprint 3b, ADR-0049) —
   * the local commit is already pushed; deployment is a future sprint (not done). PR creation is now a
   * supported approval flow, so it is NO LONGER mentioned here (CA #8). Wording avoids implying this turn pushed.
   */
  composePushPrDeployUnsupported(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '이미 로컬 커밋은 원격에 push된 상태예요. 배포는 아직 지원하지 않아요.',
    };
  }

  // ── Sprint 3b (ADR-0049): explicit Pull Request creation APPROVAL — approval-only, never PR-created ──

  /**
   * PR-creation approval REQUESTED (Sprint 3b, CA #1/#12). Shows the deterministic head→base target + pushed
   * short hash + bounded title. Says approval only — no PR is created this step; never claims the branch is
   * verified on a hosting provider or that a PR can definitely be created.
   */
  composePrApprovalRequested(
    context: ConversationContext,
    input: { pushedCommitHash: string; headBranch: string; baseBranch: string; title: string },
  ): OutboundMessage {
    const shortHash = input.pushedCommitHash.slice(0, 7);
    const head = input.headBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const base = input.baseBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const title = input.title.slice(0, MAX_GIT_REF_DISPLAY);
    const text = clampToMessageBudget(
      [
        'PR 생성 승인을 요청했어요.',
        `대상: ${head} → ${base} (커밋 ${shortHash})`,
        `제목(안): ${title}`,
        '승인해도 이번 단계에서는 실제 PR을 만들지 않아요.',
        '지금 기록된 push 정보를 기준으로 한 승인이에요. 실제 PR 생성은 이후 단계에서 진행돼요.',
        '진행하려면 "승인", 원치 않으면 "거절"이라고 알려 주세요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /** PR-creation approval RECORDED after "승인" (Sprint 3b) — records permission only; never says PR created. */
  composePrApprovalRecorded(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 생성 승인은 기록했어요.\n아직 PR은 만들지 않았어요. (실제 PR 생성은 이후 저장소 호스팅 단계에서 진행돼요)',
    };
  }

  /** PR-creation approval DENIED (Sprint 3b) — the pushed commit remains; no PR created. */
  composePrApprovalDenied(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 생성 승인을 거절했어요.\n커밋은 원격에 push된 그대로예요. PR은 만들지 않았어요.',
    };
  }

  /** PR-creation approval CANCELLED (Sprint 3b) — the pushed commit remains; no PR created. */
  composePrApprovalCancelled(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 생성 승인을 취소했어요.\n커밋은 원격에 push된 그대로예요. PR은 만들지 않았어요.',
    };
  }

  /** PR-creation approval not available — wrong state / incomplete or stale pending context (Sprint 3b). No PR. */
  composePrApprovalUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 PR 생성 승인을 준비할 수 없어요. 먼저 push를 완료(GIT_PUSHED)한 뒤에 요청해 주세요. PR은 만들지 않았어요.',
    };
  }

  /** Head branch == base branch under the fixed base policy (Sprint 3b, CA #10) — a product/base-policy
   *  limitation, NOT a Git error and NOT a PR-creation attempt. No approval. */
  composePrHeadEqualsBaseUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '현재 push된 브랜치가 PR base(main)와 같아서, 이 정책으로는 PR 생성을 준비할 수 없어요. PR 승인은 만들지 않았어요.',
    };
  }

  /** A PR-creation phrase while already PR_APPROVED (Sprint 3b, Q11) — already approved, not created. No new approval. */
  composePrAlreadyApproved(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 생성 승인은 이미 기록돼 있어요. 아직 PR은 만들지 않았어요. 다시 승인하지 않았어요.',
    };
  }

  /** PR request bundled with deploy/merge/release/force/… (Sprint 3b, CA #5) — unsupported companion; no PR. */
  composePrUnsupportedCompanion(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 생성 요청에 배포/merge/release 같은 작업은 함께 처리하지 않아요. PR 승인도, 배포/merge도 하지 않았어요.',
    };
  }

  /** A deploy-only phrase while PR_APPROVED (Sprint 3b, CA #8) — state-specific: approval recorded, PR not
   *  created, deployment not done. */
  composePrApprovedDeployUnsupported(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 생성 승인은 기록되어 있지만, 배포는 아직 지원하지 않아요.\nPR은 아직 만들지 않았고 배포도 하지 않았어요.',
    };
  }

  // ── Sprint 3d-D (ADR-0054): actual PR creation execution wording. Never a token; never overclaims. ──

  /** A new Pull Request was created (Sprint 3d-D). Shows repo/branches/short commit/URL; no merge/deploy/release. */
  composePrCreated(
    context: ConversationContext,
    input: { owner: string; repo: string; headBranch: string; baseBranch: string; commitHash: string; prNumber: number; prUrl: string },
  ): OutboundMessage {
    const head = input.headBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const base = input.baseBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const text = clampToMessageBudget(
      [
        'PR을 만들었어요.',
        `- 저장소: ${input.owner.slice(0, MAX_GIT_REF_DISPLAY)}/${input.repo.slice(0, MAX_GIT_REF_DISPLAY)}`,
        `- 브랜치: ${head} → ${base}`,
        `- 커밋: ${input.commitHash.slice(0, 7)}`,
        `- PR: ${input.prUrl.slice(0, MAX_PR_URL_DISPLAY)}`,
        '아직 머지/배포/릴리즈는 하지 않았어요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /** An existing open PR was connected instead of creating a new one (Sprint 3d-D, Q9) — never says "newly created". */
  composePrCreatedReusedExisting(
    context: ConversationContext,
    input: { owner: string; repo: string; headBranch: string; baseBranch: string; commitHash: string; prNumber: number; prUrl: string },
  ): OutboundMessage {
    const head = input.headBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const base = input.baseBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const text = clampToMessageBudget(
      [
        '기존에 열려 있던 PR을 연결했어요.',
        `- 저장소: ${input.owner.slice(0, MAX_GIT_REF_DISPLAY)}/${input.repo.slice(0, MAX_GIT_REF_DISPLAY)}`,
        `- 브랜치: ${head} → ${base}`,
        `- 커밋: ${input.commitHash.slice(0, 7)}`,
        `- PR: ${input.prUrl.slice(0, MAX_PR_URL_DISPLAY)}`,
        '새 PR을 만들지는 않았어요. 머지/배포/릴리즈도 하지 않았어요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /** Repository identity or GitHub token is not configured (Sprint 3d-D) — safe not-configured; NO PR attempt. */
  composePrCreationNotConfigured(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 생성 대상 저장소 또는 GitHub 토큰이 설정되지 않았어요. PR은 만들지 않았어요.',
    };
  }

  /** PR execution context/approval mismatch (Sprint 3d-D) — pre-mutation; NO PR created. */
  composePrCreationUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 PR을 생성할 수 없어요. 승인/컨텍스트를 확인해 주세요. PR은 만들지 않았어요.',
    };
  }

  /** PR creation blocked BEFORE any mutating call (repo/branch missing, existing-PR invalid/ambiguous) —
   *  Sprint 3d-D, CA change 6/14. Definitively no PR created. */
  composePrCreationBlocked(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'GitHub 저장소/브랜치 상태를 확인할 수 없어 PR을 생성하지 못했어요. PR은 만들지 않았어요.',
    };
  }

  /** The create call was ATTEMPTED but could not be completed/verified (Sprint 3d-D, CA change 6) — a PR MAY
   *  exist; must NOT claim it wasn't created. */
  composePrCreationUnverified(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 생성 완료를 확인하지 못했어요. GitHub 상태를 확인해 주세요.',
    };
  }

  /** A PR create/open phrase while already PR_CREATED (Sprint 3d-D) — already created; returns the PR URL. */
  composePrAlreadyCreated(context: ConversationContext, input: { prNumber: number; prUrl: string }): OutboundMessage {
    return {
      context,
      text: `이미 PR을 만들었어요: #${input.prNumber} ${input.prUrl.slice(0, MAX_PR_URL_DISPLAY)}\n새 PR을 만들지 않았어요. 머지/배포/릴리즈는 하지 않았어요.`,
    };
  }

  /** A deploy/merge/release/companion phrase while PR_CREATED (Sprint 3d-D) — unsupported future step. */
  composePrCreatedCompanionUnsupported(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '머지/배포/릴리즈는 이후 단계예요. 지금은 하지 않았어요. PR은 이미 만들어져 있어요.',
    };
  }

  // ── Sprint 3e (ADR-0055): read-only PR STATUS PREVIEW wording — point-in-time only, never verified/safe-to-merge. ──

  /**
   * A bounded, point-in-time PR status preview (Sprint 3e). States it is a current-snapshot observation; never
   * "safe to merge" / "CI verified" / "deploy ready". Checks summary is provider-reported and may be partial
   * (check-runs only); empty check-runs is NOT rendered as success. No raw logs / review body / file data.
   */
  composePrStatusPreview(
    context: ConversationContext,
    preview: PullRequestStatusPreview,
    opts: { mergeApproved?: boolean } = {},
  ): OutboundMessage {
    const head = preview.headBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const base = preview.baseBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const stateKo =
      preview.state === 'open' ? '열림' : preview.state === 'closed' ? '닫힘(provider 보고)' : preview.state === 'merged' ? '머지됨(provider 보고)' : '알 수 없음';
    const c = preview.checks;
    const checksLine =
      c.totalCount === 0
        ? '- 체크: 현재 표시할 체크 결과가 없거나 확인되지 않았어요'
        : `- 체크: 성공 ${c.successCount} / 실패 ${c.failureCount} / 대기 ${c.pendingCount} (총 ${c.totalCount}) — 제공자 보고 기준이라 일부 체크는 반영되지 않을 수 있어요`;
    const lines = [
      '현재 조회 기준으로 PR 상태를 확인했어요. (지금 이 시점 조회 결과이며, 계속 바뀔 수 있어요)',
      `- PR: #${preview.ref.pullRequestNumber} ${preview.ref.pullRequestUrl.slice(0, MAX_PR_URL_DISPLAY)}`,
      `- 상태: ${stateKo}${preview.isDraft ? ' (draft)' : ''}`,
      `- 브랜치: ${head} → ${base}`,
      `- 커밋: ${preview.headCommitHash.slice(0, 7)}`,
      checksLine,
    ];
    if (preview.reviews && preview.reviews.state !== 'unknown') {
      lines.push(
        `- 리뷰: 승인 ${preview.reviews.approvedCount ?? 0} / 변경요청 ${preview.reviews.changesRequestedCount ?? 0} (현재 리뷰 신호이며 머지 승인 게이트는 아니에요)`,
      );
    }
    lines.push('머지/배포/릴리즈는 하지 않았어요. 안전하게 머지해도 된다는 뜻은 아니에요.');
    // (Sprint 3f) when reached from MERGE_APPROVED, remind that the merge approval is still recorded and no
    // merge happened — the status preview does not consume/clear the approval.
    if (opts.mergeApproved) lines.push('머지 승인은 기록되어 있지만, 아직 머지는 하지 않았어요.');
    return { context, text: clampToMessageBudget(lines.join('\n')) };
  }

  // ── Sprint 3f (ADR-0056): explicit PR merge APPROVAL — permission record only, never merged/deployed/released. ──

  /** Merge approval REQUESTED (Sprint 3f). Shows the PR target; says no merge happened; approval records permission only. */
  composeMergeApprovalRequested(
    context: ConversationContext,
    input: { owner: string; repo: string; prNumber: number; prUrl: string; headBranch: string; baseBranch: string; commitHash: string },
  ): OutboundMessage {
    const head = input.headBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const base = input.baseBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const text = clampToMessageBudget(
      [
        'PR 머지 승인을 요청했어요.',
        `대상: ${input.owner.slice(0, MAX_GIT_REF_DISPLAY)}/${input.repo.slice(0, MAX_GIT_REF_DISPLAY)} #${input.prNumber} (${head} → ${base}, 커밋 ${input.commitHash.slice(0, 7)})`,
        `- PR: ${input.prUrl.slice(0, MAX_PR_URL_DISPLAY)}`,
        '아직 머지는 하지 않았어요. 승인하면 이후 별도 단계에서 머지를 실행할 수 있어요. 배포/릴리즈도 하지 않았어요.',
        '진행하려면 "승인", 원치 않으면 "거절"이라고 알려 주세요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /** Merge approval RECORDED after "승인" (Sprint 3f) — permission only; never says merged. */
  composeMergeApprovalRecorded(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 머지 승인이 기록됐어요.\n아직 머지는 하지 않았어요. 배포/릴리즈도 하지 않았어요. (실제 머지는 이후 단계에서 진행돼요)',
    };
  }

  /** Merge approval DENIED (Sprint 3f) — PR remains; no merge. */
  composeMergeApprovalDenied(context: ConversationContext): OutboundMessage {
    return { context, text: 'PR 머지 승인을 거절했어요.\nPR은 그대로 있고 머지는 하지 않았어요.' };
  }

  /** Merge approval CANCELLED (Sprint 3f) — PR remains; no merge. */
  composeMergeApprovalCancelled(context: ConversationContext): OutboundMessage {
    return { context, text: 'PR 머지 승인을 취소했어요.\nPR은 그대로 있고 머지는 하지 않았어요.' };
  }

  /** Merge approval not available — wrong state / incomplete or stale pending context (Sprint 3f). No merge. */
  composeMergeApprovalUnavailable(context: ConversationContext): OutboundMessage {
    return { context, text: '지금은 PR 머지 승인을 준비할 수 없어요. (머지는 하지 않았어요)' };
  }

  /** A WEAK/incomplete merge mention (bare "머지"/"merge", no execution verb) while MERGE_APPROVED (Sprint 3f,
   *  re-worded Sprint 3g CA change 4). Approval is recorded; the user can now ask to merge explicitly. Used ONLY
   *  for the bare mention — a direct merge command ("머지해줘"/…) executes instead. No mutation. */
  composeMergeAlreadyApproved(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 머지 승인은 이미 기록되어 있어요.\n머지하려면 "머지해줘"처럼 말씀해 주세요. (아직 머지하지 않았어요)',
    };
  }

  /** A deploy/release/reviewer/label/assignee phrase while MERGE_APPROVED (Sprint 3f) — unsupported future step. */
  composeMergeApprovedCompanionUnsupported(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '배포/릴리즈/리뷰어/라벨/담당자 변경은 이후 단계예요. 지금은 하지 않았어요. PR 머지 승인만 기록되어 있어요.',
    };
  }

  /** Repository identity / GitHub token not configured for status preview (Sprint 3e) — read-only, no state change. */
  composePrStatusNotConfigured(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: 'PR 상태를 확인할 저장소 또는 GitHub 토큰이 설정되지 않았어요. (상태 조회만 하며 아무것도 변경하지 않았어요)',
    };
  }

  /** PR status preview context is incomplete/mismatched (Sprint 3e) — read-only, no state change. */
  composePrStatusUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 PR 상태를 확인할 수 없어요. (아무것도 변경하지 않았어요)',
    };
  }

  /** PR status read failed / result was stale-unattributable (Sprint 3e) — "could not check", NOT "checks failed". */
  composePrStatusCheckFailed(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '현재 PR 상태를 확인하지 못했어요. PR이 없어졌거나 체크가 실패했다는 뜻은 아니에요. (아무것도 변경하지 않았어요)',
    };
  }

  // ── Sprint 3g (ADR-0057): PR MERGE EXECUTION. "머지했어요" NEVER means deployed/released/production-ready. ──

  /** A KNOWN pre-mutation block (stale head / conflict / checks-or-reviews blocking / could-not-determine / PR
   *  closed / approval or context mismatch). Definitively NOT merged. Never claims success. (Sprint 3g) */
  composeMergeExecutionPreflightBlocked(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 머지하지 않았어요. 승인 이후 PR 상태가 바뀌었거나(헤드 변경/충돌/필수 체크·리뷰 미충족) 머지 가능 여부를 확인할 수 없어, 안전을 위해 머지를 진행하지 않았어요. PR 상태를 확인해 주세요. (배포/릴리즈도 하지 않았어요)',
    };
  }

  /** Merge SUCCEEDED (Sprint 3g) — provider reported the approved PR merged. Merged ≠ deployed/released. */
  composeMergeExecutionSucceeded(
    context: ConversationContext,
    input: { owner: string; repo: string; prNumber: number; prUrl: string; mergedHeadSha: string; mergeCommitHash?: string },
  ): OutboundMessage {
    const lines = [
      'PR을 머지했어요.',
      `대상: ${input.owner.slice(0, MAX_GIT_REF_DISPLAY)}/${input.repo.slice(0, MAX_GIT_REF_DISPLAY)} #${input.prNumber}`,
      `- PR: ${input.prUrl.slice(0, MAX_PR_URL_DISPLAY)}`,
      `- 머지된 헤드 커밋: ${input.mergedHeadSha.slice(0, 7)}`,
    ];
    if (input.mergeCommitHash) lines.push(`- 머지 커밋: ${input.mergeCommitHash.slice(0, 7)} (provider 보고)`);
    lines.push('머지했다는 것이 배포/릴리즈를 뜻하지는 않아요. 배포/릴리즈는 하지 않았어요. 로컬 main 동기화나 브랜치 삭제도 하지 않았어요.');
    return { context, text: clampToMessageBudget(lines.join('\n')) };
  }

  /** Merge outcome UNVERIFIED (Sprint 3g) — the mutating call was attempted but could not be completed/verified.
   *  MUST NOT say "not merged" and MUST NOT say "merged" — ask the user to check PR status. */
  composeMergeExecutionUnverified(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '머지를 시도했지만 결과를 확인하지 못했어요. 머지가 됐을 수도, 안 됐을 수도 있어요 — PR 상태를 확인해 주세요. (배포/릴리즈는 하지 않았어요)',
    };
  }

  /** Merge execution capability not configured (no repository/token binding) (Sprint 3g) — no state change. */
  composeMergeExecutionUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '머지를 실행할 저장소 또는 GitHub 토큰이 설정되지 않았어요. (아무것도 변경하지 않았어요)',
    };
  }

  /** The approved PR was observed ALREADY merged at the exact approved head (Sprint 3g) — idempotent, no new
   *  mutation. Merged ≠ deployed/released. */
  composeMergeExecutionAlreadyMerged(
    context: ConversationContext,
    input: { owner: string; repo: string; prNumber: number; prUrl: string },
  ): OutboundMessage {
    const text = clampToMessageBudget(
      [
        '이 PR은 이미 머지되어 있어요. (새로 머지하지 않았어요)',
        `대상: ${input.owner.slice(0, MAX_GIT_REF_DISPLAY)}/${input.repo.slice(0, MAX_GIT_REF_DISPLAY)} #${input.prNumber}`,
        `- PR: ${input.prUrl.slice(0, MAX_PR_URL_DISPLAY)}`,
        '머지되어 있다는 것이 배포/릴리즈를 뜻하지는 않아요. 배포/릴리즈는 하지 않았어요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /** A deploy/release/reviewer/label/assignee/other companion phrase at MERGE_APPROVED or PR_MERGED (Sprint 3g)
   *  — unsupported future step; no deploy/release, no merge. */
  composeMergeExecutionUnsupportedCompanion(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '배포/릴리즈/리뷰어/라벨/담당자 변경, 브랜치 삭제 등은 이후 단계예요. 지금은 하지 않았어요.',
    };
  }

  // ── Sprint 3h (ADR-0058): post-merge LOCAL main sync. Never "deployed/released/branch-deleted". ──

  /** Local main sync SUCCEEDED (Sprint 3h) — mode-aware wording (CA change 5). Never says "workspace synced" or
   *  "working tree is now main"; distinguishes ref-only (current checkout untouched) from checked-out-main. */
  composeMainSyncSucceeded(
    context: ConversationContext,
    input: {
      syncMode: 'checked-out-main' | 'ref-only';
      syncedCommitHash: string;
      previousMainCommit: string;
      workingTreeUpdated: boolean;
      alreadyUpToDate: boolean;
    },
  ): OutboundMessage {
    const reached = input.syncedCommitHash.slice(0, 7);
    const lines: string[] =
      input.syncMode === 'checked-out-main'
        ? [
            input.alreadyUpToDate
              ? `체크아웃된 로컬 main은 이미 최신이에요 (${reached}). 옮길 게 없었어요.`
              : `체크아웃된 로컬 main을 ${reached}로 fast-forward 했어요. 워킹트리가 fast-forward로 갱신됐어요.`,
            '동기화 후에도 워킹트리는 깨끗해요.',
          ]
        : [
            input.alreadyUpToDate
              ? `로컬 main ref는 이미 최신이에요 (${reached}). 옮길 게 없었어요.`
              : `로컬 main ref를 ${reached}로 동기화했어요.`,
            '현재 체크아웃한 브랜치는 그대로예요 (변경하지 않았어요). 워킹트리도 깨끗해요.',
          ];
    lines.push('로컬 main만 fast-forward 했어요. 배포/릴리즈/브랜치 삭제는 하지 않았어요.');
    return { context, text: clampToMessageBudget(lines.join('\n')) };
  }

  /** A KNOWN pre-ref-update block (dirty/untracked/staged tree, detached HEAD, remote read failure, remote main !=
   *  expected merge, non-fast-forward, local main moved, no local main, no mergeCommitHash). Definitively NOT
   *  synchronized. Never claims synced. (Sprint 3h) */
  composeMainSyncBlocked(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '로컬 main을 동기화하지 않았어요. 워킹트리가 깨끗하지 않거나(스테이징/추적되지 않은 파일/detached HEAD), 원격 main을 확인할 수 없거나 기대한 머지 커밋과 다르거나 fast-forward가 불가능해서, 안전을 위해 진행하지 않았어요. git status로 확인해 주세요. (배포/릴리즈/브랜치 삭제도 하지 않았어요)',
    };
  }

  /** Local main sync UNVERIFIED (Sprint 3h) — the ref-update was attempted but could not be confirmed. MUST NOT
   *  say "not synced" and MUST NOT say "synced" — ask the user to check git status/log. */
  composeMainSyncUnverified(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '로컬 main 동기화를 시도했지만 결과를 확인하지 못했어요. 옮겨졌을 수도, 아닐 수도 있어요 — git status / git log로 로컬 main을 확인해 주세요. (배포/릴리즈는 하지 않았어요)',
    };
  }

  /** Local main sync not available — repository/identity not configured (Sprint 3h). No state change. */
  composeMainSyncUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '로컬 main을 동기화할 수 없어요. 저장소 또는 설정을 확인해 주세요. (아무것도 변경하지 않았어요)',
    };
  }

  // ── Sprint 3i (ADR-0059): post-merge LOCAL branch cleanup. Never "deployed/released/tagged/remote-deleted". ──

  /** LOCAL branch cleanup SUCCEEDED / already-absent (Sprint 3i). Distinguishes local-deleted vs already-absent; always
   *  states remote + main were not touched (CA change 5 / Q7). Never claims remote deletion. */
  composeBranchCleanupSucceeded(
    context: ConversationContext,
    input: { cleanedBranch: string; cleanedLocalBranch: boolean; alreadyAbsent: boolean },
  ): OutboundMessage {
    const name = input.cleanedBranch.slice(0, MAX_GIT_REF_DISPLAY);
    const text = input.alreadyAbsent
      ? clampToMessageBudget(
          [
            `로컬 브랜치 '${name}'은 이미 없어요.`,
            '이번엔 삭제한 브랜치가 없어요. 원격 브랜치는 삭제하지 않았어요. main은 변경하지 않았어요.',
            '배포/릴리즈/태그도 하지 않았어요.',
          ].join('\n'),
        )
      : clampToMessageBudget(
          [
            `로컬 브랜치 '${name}'을 삭제했어요 (이미 main에 병합된 브랜치예요).`,
            '원격 브랜치와 main은 건드리지 않았어요. 배포/릴리즈/태그도 하지 않았어요.',
          ].join('\n'),
        );
    return { context, text };
  }

  /** A KNOWN pre-delete block (target is main / unsafe name / not merged / checked out / main moved / context
   *  incomplete). Definitively NOT deleted. Never claims deleted. (Sprint 3i) */
  composeBranchCleanupBlocked(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '브랜치를 삭제하지 않았어요. 대상이 main이거나, 아직 병합되지 않았거나, 현재 체크아웃 중이거나, 이름이 안전하지 않거나, 로컬 main이 동기화 시점과 달라서 안전을 위해 진행하지 않았어요. git branch로 확인해 주세요. (원격 브랜치·배포·릴리즈도 하지 않았어요)',
    };
  }

  /** LOCAL branch cleanup UNVERIFIED (Sprint 3i) — the delete was attempted but could not be confirmed. MUST NOT say
   *  "not deleted" and MUST NOT say "deleted" — ask the user to check git branch. */
  composeBranchCleanupUnverified(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '브랜치 삭제를 시도했지만 결과를 확인하지 못했어요. 삭제됐을 수도, 아닐 수도 있어요 — git branch로 확인해 주세요. (원격 브랜치·배포·릴리즈는 하지 않았어요)',
    };
  }

  /** LOCAL branch cleanup not available — repository/identity not configured (Sprint 3i). No state change. */
  composeBranchCleanupUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '브랜치를 정리할 수 없어요. 저장소 또는 설정을 확인해 주세요. (아무것도 변경하지 않았어요)',
    };
  }

  /** A REMOTE branch cleanup phrase BEFORE the local branch is cleaned (at MAIN_SYNCED) — remote cleanup is available
   *  only after the local branch is cleaned (from BRANCH_CLEANED). NO mutation (Sprint 3i → reworded Sprint 3j-A). */
  composeRemoteBranchCleanupUnsupported(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '원격 브랜치 정리는 로컬 브랜치를 먼저 정리한 뒤에 요청할 수 있어요. 지금은 아무것도 삭제하지 않았어요.',
    };
  }

  // ── Sprint 3j-A (ADR-0060): CRITICAL remote-branch-cleanup APPROVAL gate. Permission only — NEVER deletes a remote
  //    branch (execution is Sprint 3j-B). No message claims a branch was/​will be deleted or that deletion is safe. ──

  /** Remote-branch-cleanup approval REQUESTED (Sprint 3j-A) — states the permission target ONLY; never claims the
   *  branch exists / its SHA is current / the PR is still merged / deletion is safe (CA change 4). */
  composeRemoteBranchCleanupRequested(
    context: ConversationContext,
    input: { owner: string; repo: string; prNumber: number; prUrl: string; branch: string; expectedHeadCommit: string },
  ): OutboundMessage {
    const branch = input.branch.slice(0, MAX_GIT_REF_DISPLAY);
    const text = clampToMessageBudget(
      [
        '원격 브랜치 정리(삭제) 승인을 요청했어요.',
        `대상: ${input.owner.slice(0, MAX_GIT_REF_DISPLAY)}/${input.repo.slice(0, MAX_GIT_REF_DISPLAY)} #${input.prNumber} 원격 브랜치 '${branch}' (예상 커밋 ${input.expectedHeadCommit.slice(0, 7)})`,
        `- PR: ${input.prUrl.slice(0, MAX_PR_URL_DISPLAY)}`,
        '아직 아무것도 삭제하지 않았어요. 이 승인은 권한만 기록해요 — 실제 삭제는 이후 별도 실행 단계에서 진행돼요.',
        '승인 시점에 원격 브랜치가 존재하는지·커밋이 그대로인지·PR이 여전히 병합 상태인지·삭제가 안전한지는 이 승인으로 보장하지 않아요 (실행 시 확인해요).',
        '진행하려면 "승인", 원치 않으면 "거절"이라고 알려 주세요.',
      ].join('\n'),
    );
    return { context, text };
  }

  /** Remote-branch-cleanup approval RECORDED after "승인" (Sprint 3j-A) — permission only; never says deleted. */
  composeRemoteBranchCleanupRecorded(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '원격 브랜치 정리 승인이 기록됐어요.\n아직 아무것도 삭제하지 않았어요. 실제 원격 브랜치 삭제는 이후 실행 단계에서 진행돼요. 배포/릴리즈/태그도 하지 않았어요.',
    };
  }

  /** Remote-branch-cleanup approval DENIED (Sprint 3j-A) — nothing deleted; the branch/main are untouched. */
  composeRemoteBranchCleanupDenied(context: ConversationContext): OutboundMessage {
    return { context, text: '원격 브랜치 정리 승인을 거절했어요.\n원격 브랜치는 그대로 있고 아무것도 삭제하지 않았어요.' };
  }

  /** Remote-branch-cleanup approval CANCELLED (Sprint 3j-A) — nothing deleted; the branch/main are untouched. */
  composeRemoteBranchCleanupCancelled(context: ConversationContext): OutboundMessage {
    return { context, text: '원격 브랜치 정리 승인을 취소했어요.\n원격 브랜치는 그대로 있고 아무것도 삭제하지 않았어요.' };
  }

  /** Remote-branch-cleanup approval not available — wrong state / incomplete or stale pending context (Sprint 3j-A).
   *  No deletion. */
  composeRemoteBranchCleanupApprovalUnavailable(context: ConversationContext): OutboundMessage {
    return { context, text: '지금은 원격 브랜치 정리 승인을 준비할 수 없어요. (아무것도 삭제하지 않았어요)' };
  }

  /** A remote cleanup phrase while already REMOTE_BRANCH_CLEANUP_APPROVED (Sprint 3j-A) — approval is recorded; the
   *  actual deletion is a future step. No mutation. */
  composeRemoteBranchCleanupAlreadyApproved(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '원격 브랜치 정리 승인은 이미 기록되어 있어요.\n실제 원격 브랜치 삭제는 이후 실행 단계에서 진행돼요. (아직 아무것도 삭제하지 않았어요)',
    };
  }

  /** Remote branch cleanup execution not available — repository/GitHub token not configured (Sprint 3j-B, repurposed
   *  from 3j-A). No state change; the approval stays recorded; nothing deleted. */
  composeRemoteBranchCleanupExecutionUnavailable(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '지금은 원격 브랜치 삭제를 실행할 수 없어요. 저장소 또는 설정을 확인해 주세요. (승인은 기록되어 있고, 아직 아무것도 삭제하지 않았어요)',
    };
  }

  // ── Sprint 3j-B (ADR-0060): remote-branch-cleanup EXECUTION replies. Never claim deploy/release/tag/local delete. ──

  /** Remote branch cleanup SUCCEEDED / already-absent (Sprint 3j-B). Distinguishes remote-deleted vs already-absent;
   *  every path states the local branch + main were NOT touched. Never claims deploy/release/tag. */
  composeRemoteBranchCleanupSucceeded(
    context: ConversationContext,
    input: { branch: string; cleanedRemoteBranch: boolean; alreadyAbsent: boolean },
  ): OutboundMessage {
    const name = input.branch.slice(0, MAX_GIT_REF_DISPLAY);
    const text = input.alreadyAbsent
      ? clampToMessageBudget(
          [
            `원격 브랜치 '${name}'은 이미 없어요.`,
            '이번엔 삭제한 원격 브랜치가 없어요. 로컬 브랜치·main은 변경하지 않았어요.',
            '배포/릴리즈/태그도 하지 않았어요.',
          ].join('\n'),
        )
      : clampToMessageBudget(
          [
            `원격 브랜치 '${name}'을 삭제했어요 (병합 완료된 PR의 브랜치예요).`,
            '로컬 브랜치·main은 건드리지 않았어요. 배포/릴리즈/태그도 하지 않았어요.',
          ].join('\n'),
        );
    return { context, text };
  }

  /** A KNOWN pre-DELETE block (approval/preflight invalid, PR not merged, remote SHA moved, …) — definitively NOT
   *  deleted. Never claims deleted. (Sprint 3j-B) */
  composeRemoteBranchCleanupExecutionBlocked(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '원격 브랜치를 삭제하지 않았어요. 승인/대상 컨텍스트가 불완전하거나, PR이 병합 상태로 확인되지 않거나, 원격 브랜치가 예상 커밋과 달라서 안전을 위해 진행하지 않았어요. GitHub에서 확인해 주세요. (로컬 브랜치·main·배포·릴리즈도 하지 않았어요)',
    };
  }

  /** Remote branch cleanup UNVERIFIED (Sprint 3j-B) — the DELETE was attempted but could not be confirmed. MUST NOT
   *  say "not deleted" and MUST NOT say "deleted" — ask the user to check GitHub. */
  composeRemoteBranchCleanupUnverified(context: ConversationContext): OutboundMessage {
    return {
      context,
      text: '원격 브랜치 삭제를 시도했지만 결과를 확인하지 못했어요. 삭제됐을 수도, 아닐 수도 있어요 — GitHub에서 확인해 주세요. (로컬 브랜치·main·배포·릴리즈는 하지 않았어요)',
    };
  }

  /** A remote cleanup / execute phrase at terminal REMOTE_BRANCH_CLEANED (Sprint 3j-B) — already cleaned; nothing
   *  newly deleted. No second DELETE. */
  composeRemoteBranchAlreadyCleaned(context: ConversationContext, input: { branch: string }): OutboundMessage {
    const name = input.branch.slice(0, MAX_GIT_REF_DISPLAY);
    return {
      context,
      text: `원격 브랜치 '${name}'는 이미 정리됐어요.\n이번엔 새로 삭제한 게 없어요. 로컬 브랜치·main은 변경하지 않았어요. 배포/릴리즈/태그도 하지 않았어요.`,
    };
  }
}

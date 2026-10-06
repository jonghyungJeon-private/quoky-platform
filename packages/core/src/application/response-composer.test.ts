import { describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  ResourceRef,
  RiskLevel,
  type ApprovalRequest,
  type ConversationContext,
  type GitDiff,
  type GitStatus,
} from '../domain';
import { MAX_CONTRIBUTED_HELP_LINE_CHARS, MAX_CONTRIBUTED_HELP_LINES, ResponseComposer } from './response-composer';
import type { CodeChangePreview, CodeDiffPreview, PatchSetPreview, TestResultDetail } from './response-composer';
import { ProviderGatewayTerminalStatus } from './provider-routing-gateway';
import { RoutingFailureCode } from './runtime-response-validation-contracts';

const CTX: ConversationContext = { platform: 'test', channelId: 'c1', userId: 'u1' };
const composer = new ResponseComposer();

const detailOf = (o: Partial<TestResultDetail> = {}): TestResultDetail => ({
  kind: 'test',
  command: 'pnpm',
  args: ['test'],
  durationMs: 1234,
  stdout: '',
  stderr: '',
  ...o,
});

describe('ResponseComposer.compose', () => {
  it('forwards contaminated provider text unchanged to the outbound platform path', () => {
    const contaminated =
      '{"role":"assistant","provenance":"ASSISTANT","content":"안녕?"}';

    expect(composer.compose(CTX, { text: contaminated }).text).toBe(contaminated);
  });
});

describe('ResponseComposer.composeWorkSurface', () => {
  it('renders work and an actionable partial-availability indication', () => {
    const reply = composer.composeWorkSurface(CTX, {
      status: 'PARTIAL',
      items: [{ resource: new ResourceRef({ source: 'jira', externalId: 'J-1' }), title: 'Ship M3A-1' }],
      sources: [
        { source: 'jira', status: 'AVAILABLE', message: 'available' },
        { source: 'github', status: 'IDENTITY_MISSING', message: 'missing' },
      ],
    });
    expect(reply.text).toContain('[jira] Ship M3A-1');
    expect(reply.text).toContain('github: Actor 외부 identity를 설정해 주세요.');
  });

  it('never renders a partial empty projection as an authoritative no-work result', () => {
    const reply = composer.composeWorkSurface(CTX, {
      status: 'PARTIAL',
      items: [],
      sources: [
        { source: 'jira', status: 'AVAILABLE', message: 'available' },
        { source: 'github', status: 'UNAVAILABLE', message: 'unavailable' },
      ],
    });
    expect(reply.text).toContain('확인 가능한 소스에서는 작업이 없어요.');
    expect(reply.text).toContain('github: connector 연결 상태를 확인해 주세요.');
    expect(reply.text).not.toContain('Jira와 GitHub에서 확인된 작업이 없어요.');
  });
});

describe('ResponseComposer.composeProviderRoutingTerminal', () => {
  const terminalStatuses = [
    ProviderGatewayTerminalStatus.HUMAN_REVIEW_REQUIRED,
    ProviderGatewayTerminalStatus.REJECTED,
    ProviderGatewayTerminalStatus.SAFETY_BLOCKED,
    ProviderGatewayTerminalStatus.CONFIGURATION_FAILED,
    ProviderGatewayTerminalStatus.EXECUTION_FAILED,
  ] as const;

  it.each(terminalStatuses)('renders bounded category wording for %s without internal routing detail', (status) => {
    const reply = composer.composeProviderRoutingTerminal(CTX, status);

    expect(reply.text.length).toBeLessThan(200);
    expect(reply.text).not.toMatch(
      /provider-a|opaque-model|private prompt|raw output|raw error|reasoning|[a-f0-9]{64}/i,
    );
  });

  it('keeps all five terminal category messages distinct', () => {
    const texts = terminalStatuses.map((status) => composer.composeProviderRoutingTerminal(CTX, status).text);

    expect(new Set(texts).size).toBe(terminalStatuses.length);
  });

  it('renders a classified grounding fallback that acknowledges it could not confirm a correct answer', () => {
    const reply = composer.composeProviderRoutingTerminal(
      CTX,
      ProviderGatewayTerminalStatus.HUMAN_REVIEW_REQUIRED,
      RoutingFailureCode.SEMANTIC_VALIDATION_UNRESOLVED,
    );

    expect(reply.text).toContain('최근 대화에서 확인된 사실');
    expect(reply.text).toContain('확정할 수 없어');
    expect(reply.text).toContain('전달하지 않았어요');
  });
});

// ── Sprint 2m — Test Result Detail UX (ADR-0034) ────────────────────────────────────────────────

describe('ResponseComposer.composeTestResult', () => {
  it('success — contains command, duration, exitCode, excerpt', () => {
    const reply = composer.composeTestResult(CTX, { ...detailOf({ exitCode: 0, stdout: 'all green\n' }), passed: true });
    expect(reply.text).toContain('통과');
    expect(reply.text).toContain('pnpm test');
    expect(reply.text).toContain('종료 코드: 0');
    expect(reply.text).toContain('실행 시간: 1.2s');
    expect(reply.text).toContain('all green');
  });

  it('failure — contains command, duration, non-zero exitCode, excerpt', () => {
    const reply = composer.composeTestResult(CTX, {
      ...detailOf({ exitCode: 1, stdout: 'FAIL x.test.ts\n' }),
      passed: false,
    });
    expect(reply.text).toContain('실패');
    expect(reply.text).toContain('종료 코드: 1');
    expect(reply.text).toContain('FAIL x.test.ts');
  });

  it('short output → no truncation notice', () => {
    const reply = composer.composeTestResult(CTX, { ...detailOf({ exitCode: 0, stdout: 'ok\n' }), passed: true });
    expect(reply.text).not.toContain('마지막 부분만');
  });

  it('output >20 lines → tail kept, truncation notice shown', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const reply = composer.composeTestResult(CTX, {
      ...detailOf({ exitCode: 1, stdout: lines.join('\n') }),
      passed: false,
    });
    expect(reply.text).toContain('line-29');
    expect(reply.text).not.toContain('line-0\n');
    expect(reply.text).toContain('출력이 길어서 마지막 부분만 보여드렸어요.');
  });

  it('one huge line (>1200 chars, ≤20 lines) → char-capped tail kept, truncation notice shown', () => {
    const huge = `${'x'.repeat(2000)}TAIL_MARKER`;
    const reply = composer.composeTestResult(CTX, { ...detailOf({ exitCode: 1, stdout: huge }), passed: false });
    expect(reply.text).toContain('TAIL_MARKER');
    expect(reply.text).toContain('출력이 길어서 마지막 부분만 보여드렸어요.');
  });

  it('adapter-level "…[truncated]" marker → truncation notice shown even without a chat-level cut', () => {
    const reply = composer.composeTestResult(CTX, {
      ...detailOf({ exitCode: 1, stdout: 'short but adapter-capped\n…[truncated]' }),
      passed: false,
    });
    expect(reply.text).toContain('출력이 길어서 마지막 부분만 보여드렸어요.');
  });

  it('stdout preferred over stderr when both are non-empty', () => {
    const reply = composer.composeTestResult(CTX, {
      ...detailOf({ exitCode: 1, stdout: 'STDOUT_MARK', stderr: 'STDERR_MARK' }),
      passed: false,
    });
    expect(reply.text).toContain('STDOUT_MARK');
  });

  it('stdout selected but stderr also non-empty → omitted-stream notice present (does not hide stderr existed)', () => {
    const reply = composer.composeTestResult(CTX, {
      ...detailOf({ exitCode: 1, stdout: 'STDOUT_MARK', stderr: 'STDERR_MARK' }),
      passed: false,
    });
    expect(reply.text).toContain('stderr 출력도 있었지만');
  });

  it('stdout empty → stderr selected and shown, no omitted-stream notice', () => {
    const reply = composer.composeTestResult(CTX, {
      ...detailOf({ exitCode: 1, stdout: '', stderr: 'STDERR_ONLY' }),
      passed: false,
    });
    expect(reply.text).toContain('STDERR_ONLY');
    expect(reply.text).not.toContain('출력도 있었지만');
  });

  it('no output on either stream → graceful "출력이 없어요" line, not an empty block', () => {
    const reply = composer.composeTestResult(CTX, { ...detailOf({ exitCode: 0 }), passed: true });
    expect(reply.text).toContain('출력이 없어요.');
  });

  it('never asserts a completeness/security guarantee about the log', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const reply = composer.composeTestResult(CTX, {
      ...detailOf({ exitCode: 1, stdout: lines.join('\n') }),
      passed: false,
    });
    expect(reply.text).not.toContain('안전');
    expect(reply.text).not.toContain('완전히 제거');
  });

  it('full rendered text stays under ~1900 chars even at max excerpt size', () => {
    const huge = Array.from({ length: 50 }, (_, i) => 'x'.repeat(100) + i).join('\n');
    const reply = composer.composeTestResult(CTX, { ...detailOf({ exitCode: 1, stdout: huge }), passed: false });
    expect(reply.text.length).toBeLessThanOrEqual(1900);
  });
});

describe('ResponseComposer.composeTestTimedOut', () => {
  it('does not claim pass/fail, does not show exitCode, does not claim a configured timeout value', () => {
    const reply = composer.composeTestTimedOut(CTX, detailOf({ durationMs: 30_000 }));
    expect(reply.text).not.toContain('통과');
    expect(reply.text).not.toContain('실패');
    expect(reply.text).not.toContain('종료 코드');
    expect(reply.text).not.toContain('configured');
    expect(reply.text).toContain('제한 시간');
    expect(reply.text).toContain('실행 시간: 30.0s');
  });

  it('is distinct from composeTestResult wording', () => {
    const timedOut = composer.composeTestTimedOut(CTX, detailOf({ durationMs: 30_000 }));
    const result = composer.composeTestResult(CTX, { ...detailOf({ exitCode: 1 }), passed: false });
    expect(timedOut.text).not.toBe(result.text);
  });
});

// ── Sprint 2n — Live Code Change Planning (ADR-0035) ────────────────────────────────────────────

describe('ResponseComposer.composeCodeChangeApprovalRequired', () => {
  it('names this as a code-change request, states no file is modified yet, and how to reply', () => {
    const reply = composer.composeCodeChangeApprovalRequired(CTX);
    expect(reply.text).toContain('승인');
    expect(reply.text).toContain('코드 변경');
    expect(reply.text).toContain('수정하지 않');
    expect(reply.text).toContain('"승인"');
    expect(reply.text).toContain('"거절"');
  });

  it('discloses that target file content goes to the AI provider (max 3 paths, then 외 N개)', () => {
    const one = composer.composeCodeChangeApprovalRequired(CTX, ['a.ts']).text;
    expect(one).toContain('지정한 파일(a.ts)의 현재 내용이 미리보기 생성을 위해 AI에게 전달돼요');
    expect(one).toContain('모든 경우를 걸러내지는 못해요');
    const many = composer.composeCodeChangeApprovalRequired(CTX, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']).text;
    expect(many).toContain('(a.ts, b.ts, c.ts 외 2개)');
    expect(composer.composeCodeChangeApprovalRequired(CTX).text).not.toContain('AI에게 전달');
  });

  it('names the files a multi-file set will create (ADR-0099 D1), but not for a lone new file', () => {
    const mixed = composer.composeCodeChangeApprovalRequired(CTX, ['src/a.ts'], ['src/b.ts']).text;
    expect(mixed).toContain('새로 만들 파일: src/b.ts');
    expect(mixed).toContain('"거절"');
    const twoNew = composer.composeCodeChangeApprovalRequired(CTX, [], ['src/b.ts', 'src/c.ts']).text;
    expect(twoNew).toContain('새로 만들 파일: src/b.ts, src/c.ts');
    expect(composer.composeCodeChangeApprovalRequired(CTX, [], ['src/b.ts']).text).toBe(
      composer.composeCodeChangeApprovalRequired(CTX).text,
    );
  });

  it('is distinct from the generic composeApprovalRequired wording', () => {
    const generic = composer.composeApprovalRequired(CTX);
    const codeChange = composer.composeCodeChangeApprovalRequired(CTX);
    expect(codeChange.text).not.toBe(generic.text);
  });
});

describe('ResponseComposer.composePlanningOnlyApproved', () => {
  it('never claims completion — no "완료", states planning-only progress', () => {
    const reply = composer.composePlanningOnlyApproved(CTX);
    expect(reply.text).not.toContain('완료');
    expect(reply.text).toContain('승인은 확인했어요');
    expect(reply.text).toContain('계획까지만');
  });

  it('is distinct from composeExecutionResult("COMPLETED")', () => {
    const planningOnly = composer.composePlanningOnlyApproved(CTX);
    const completed = composer.composeExecutionResult(CTX, 'COMPLETED');
    expect(planningOnly.text).not.toBe(completed.text);
  });
});

// ── Sprint 2o — Code Change Scope Collection (ADR-0036) ─────────────────────────────────────────

describe('ResponseComposer.composeTargetScopeClarification', () => {
  it('asks for a file path with a concrete example', () => {
    const reply = composer.composeTargetScopeClarification(CTX);
    expect(reply.text).toContain('파일 경로');
    expect(reply.text).toContain('packages/core/src/application/foo.ts');
  });

  it('instructs the user to re-send the full request together with the path', () => {
    const reply = composer.composeTargetScopeClarification(CTX);
    expect(reply.text).toContain('다시 요청');
    expect(reply.text).toContain('파일에서');
  });

  it('does not present module/area text alone as a sufficient example', () => {
    const reply = composer.composeTargetScopeClarification(CTX);
    expect(reply.text).toContain('아직 부족해요');
    expect(reply.text).not.toMatch(/또는\s*"로그인 처리 부분"/);
  });
});

// ── Sprint 2p — Multi-turn Code Scope Clarification (ADR-0037) ─────────────────────────────────

describe('ResponseComposer.composeScopeClarificationCancelled', () => {
  it('does not claim a plan/patch/execution was created or cancelled', () => {
    const reply = composer.composeScopeClarificationCancelled(CTX);
    expect(reply.text).not.toContain('완료');
    expect(reply.text).not.toContain('계획');
    expect(reply.text).not.toContain('작업을 취소');
  });

  it('states the request itself was dropped and how to try again', () => {
    const reply = composer.composeScopeClarificationCancelled(CTX);
    expect(reply.text).toContain('요청');
    expect(reply.text).toContain('취소');
    expect(reply.text).toContain('파일 경로');
  });

  it('is distinct from the generic composeExecutionResult("CANCELLED") wording', () => {
    const scopeCancel = composer.composeScopeClarificationCancelled(CTX);
    const generic = composer.composeExecutionResult(CTX, 'CANCELLED');
    expect(scopeCancel.text).not.toBe(generic.text);
  });
});

// ── Sprint 2q — AI Code Generation Preview (ADR-0038) ───────────────────────────────────────────

const FORBIDDEN_MUTATION_WORDS = ['적용했어요', '수정했어요', '반영했어요', '변경 완료'];

describe('ResponseComposer.composeCodeGenerationPreview', () => {
  const previewOf = (o: Partial<CodeChangePreview> = {}): CodeChangePreview => ({
    changes: [{ path: 'packages/core/src/application/foo.ts', kind: 'update', excerpt: 'fixed content' }],
    outOfScopeWarnings: [],
    ...o,
  });

  it('states, at least twice, that nothing was applied yet', () => {
    const reply = composer.composeCodeGenerationPreview(CTX, previewOf());
    const notAppliedMentions = (reply.text.match(/적용되지 않|지원하지 않/g) ?? []).length;
    expect(notAppliedMentions).toBeGreaterThanOrEqual(2);
  });

  it('never uses wording that implies a completed mutation', () => {
    const reply = composer.composeCodeGenerationPreview(CTX, previewOf());
    for (const word of FORBIDDEN_MUTATION_WORDS) {
      expect(reply.text).not.toContain(word);
    }
  });

  it('lists the changed file path and a bounded excerpt', () => {
    const reply = composer.composeCodeGenerationPreview(CTX, previewOf());
    expect(reply.text).toContain('packages/core/src/application/foo.ts');
    expect(reply.text).toContain('fixed content');
  });

  it('a delete change is shown without an excerpt', () => {
    const reply = composer.composeCodeGenerationPreview(
      CTX,
      previewOf({ changes: [{ path: 'packages/core/old.ts', kind: 'delete' }] }),
    );
    expect(reply.text).toContain('packages/core/old.ts');
    expect(reply.text).toContain('삭제 제안');
  });

  it('includes the out-of-scope warning line when present, omits it when absent', () => {
    const withWarning = composer.composeCodeGenerationPreview(CTX, previewOf({ outOfScopeWarnings: ['other.ts'] }));
    expect(withWarning.text).toContain('other.ts');
    const withoutWarning = composer.composeCodeGenerationPreview(CTX, previewOf({ outOfScopeWarnings: [] }));
    expect(withoutWarning.text).not.toContain('참고:');
  });

  it('more than the warning cap shows a truncated list with an "외 N개" suffix', () => {
    const manyPaths = Array.from({ length: 8 }, (_, i) => `packages/core/extra-${i}.ts`);
    const reply = composer.composeCodeGenerationPreview(CTX, previewOf({ outOfScopeWarnings: manyPaths }));
    expect(reply.text).toContain('외 3개');
    expect(reply.text).not.toContain('extra-7.ts');
  });

  it('an excerpt containing a run of triple backticks does not break the rendered fence', () => {
    const reply = composer.composeCodeGenerationPreview(
      CTX,
      previewOf({ changes: [{ path: 'foo.ts', kind: 'update', excerpt: 'before\n```\nnested\n```\nafter' }] }),
    );
    // A safe render uses a fence strictly longer than the longest backtick run already present.
    expect(reply.text).toContain('````');
    expect(reply.text).toContain('nested');
  });

  it('stays within the existing message-length bound even with a near-limit excerpt', () => {
    const reply = composer.composeCodeGenerationPreview(
      CTX,
      previewOf({ changes: [{ path: 'foo.ts', kind: 'update', excerpt: 'x'.repeat(5000) }] }),
    );
    expect(reply.text.length).toBeLessThanOrEqual(1900);
  });
});

describe('ResponseComposer.composeCodeGenerationPreviewFailed', () => {
  it('matches the CA-specified wording exactly', () => {
    const reply = composer.composeCodeGenerationPreviewFailed(CTX);
    expect(reply.text).toBe('코드 변경 제안을 생성하지 못했어요.\n파일은 수정되지 않았어요.');
  });

  it('does not imply a file was written or a patch was created', () => {
    const reply = composer.composeCodeGenerationPreviewFailed(CTX);
    for (const word of FORBIDDEN_MUTATION_WORDS) {
      expect(reply.text).not.toContain(word);
    }
  });
});

describe('ResponseComposer.composeCodeGenerationPreviewCredentialRefused', () => {
  it('names the target, asks to move the secret out, and states nothing was modified', () => {
    const reply = composer.composeCodeGenerationPreviewCredentialRefused(CTX, 'config/service-account.json');
    expect(reply.text).toBe(
      '이 파일에는 비밀 키나 비밀번호로 보이는 내용이 있어서 AI에게 보내지 않았어요: config/service-account.json\n' +
        '민감한 값은 환경 변수나 비밀 저장소로 옮긴 뒤 다시 요청해 주세요.\n' +
        '파일은 수정되지 않았어요.',
    );
    for (const word of FORBIDDEN_MUTATION_WORDS) {
      expect(reply.text).not.toContain(word);
    }
  });
});

describe('ResponseComposer.composeCodeGenerationPreviewNoValidChange', () => {
  it('does not claim a successful proposal; states the file was not modified', () => {
    const reply = composer.composeCodeGenerationPreviewNoValidChange(CTX, ['other.ts']);
    expect(reply.text).not.toContain('제안이 준비됐어요');
    expect(reply.text).toContain('수정되지 않았어요');
  });

  it('includes the bounded out-of-scope warning when paths are given', () => {
    const reply = composer.composeCodeGenerationPreviewNoValidChange(CTX, ['other.ts']);
    expect(reply.text).toContain('other.ts');
  });

  it('is distinct from composeCodeGenerationPreviewFailed — generation succeeded, just out of scope', () => {
    const noValidChange = composer.composeCodeGenerationPreviewNoValidChange(CTX, ['other.ts']);
    const failed = composer.composeCodeGenerationPreviewFailed(CTX);
    expect(noValidChange.text).not.toBe(failed.text);
  });
});

// ── Sprint 2r — Unified Diff Preview (ADR-0039) ─────────────────────────────────────────────────

describe('ResponseComposer.composeCodeDiffPreview', () => {
  const diffPreviewOf = (o: Partial<CodeDiffPreview> = {}): CodeDiffPreview => ({
    changes: [
      {
        path: 'packages/core/src/application/foo.ts',
        kind: 'update',
        unified: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n',
        binary: false,
      },
    ],
    outOfScopeWarnings: [],
    ...o,
  });

  it('states, at least twice, that nothing was applied yet', () => {
    const reply = composer.composeCodeDiffPreview(CTX, diffPreviewOf());
    const notAppliedMentions = (reply.text.match(/적용되지 않|지원하지 않/g) ?? []).length;
    expect(notAppliedMentions).toBeGreaterThanOrEqual(2);
  });

  it('never uses wording that implies a completed mutation', () => {
    const reply = composer.composeCodeDiffPreview(CTX, diffPreviewOf());
    for (const word of FORBIDDEN_MUTATION_WORDS) {
      expect(reply.text).not.toContain(word);
    }
  });

  it('lists the changed file path and the unified diff text', () => {
    const reply = composer.composeCodeDiffPreview(CTX, diffPreviewOf());
    expect(reply.text).toContain('packages/core/src/application/foo.ts');
    expect(reply.text).toContain('-old');
    expect(reply.text).toContain('+new');
  });

  it('a delete change is labeled "(삭제 제안)"', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: [{ path: 'packages/core/old.ts', kind: 'delete', unified: '--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n', binary: false }],
      }),
    );
    expect(reply.text).toContain('packages/core/old.ts');
    expect(reply.text).toContain('삭제 제안');
  });

  it('a binary change renders a "diff를 표시할 수 없어요" notice, no code fence, and reaffirms not-modified (CA Round 1 Required Change #4)', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({ changes: [{ path: 'image.png', kind: 'update', unified: '', binary: true }] }),
    );
    expect(reply.text).toContain('diff를 표시할 수 없어요');
    expect(reply.text).toContain('image.png');
    expect(reply.text).not.toContain('```');
    expect(reply.text).toContain('수정되지 않았어요');
  });

  it('an empty unified diff (size-skipped) renders a "diff를 표시할 수 없어요" notice — never a fabricated diff (CA Round 1 Required Change #4)', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({ changes: [{ path: 'huge.ts', kind: 'update', unified: '', binary: false }] }),
    );
    expect(reply.text).toContain('diff를 표시할 수 없어요');
    expect(reply.text).toContain('huge.ts');
    expect(reply.text).not.toContain('```');
  });

  it('includes the out-of-scope warning line when present, omits it when absent', () => {
    const withWarning = composer.composeCodeDiffPreview(CTX, diffPreviewOf({ outOfScopeWarnings: ['other.ts'] }));
    expect(withWarning.text).toContain('other.ts');
    const withoutWarning = composer.composeCodeDiffPreview(CTX, diffPreviewOf({ outOfScopeWarnings: [] }));
    expect(withoutWarning.text).not.toContain('참고:');
  });

  it('a diff text containing a run of triple backticks does not break the rendered fence', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: [{ path: 'foo.ts', kind: 'update', unified: 'before\n```\nnested\n```\nafter', binary: false }],
      }),
    );
    expect(reply.text).toContain('````');
    expect(reply.text).toContain('nested');
  });

  it('a diff exceeding the per-file line/char cap is clamped with a truncation notice (CA Round 1 Required Change #2)', () => {
    const hugeUnified = Array.from({ length: 200 }, (_, i) => `-line ${i}`).join('\n');
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({ changes: [{ path: 'foo.ts', kind: 'update', unified: hugeUnified, binary: false }] }),
    );
    expect(reply.text).toContain('일부만 보여드렸어요');
    expect(reply.text).not.toContain('line 199'); // well past the 40-line cap
  });

  it('F5-A: the attached PreviewArtifact carries the COMPLETE canonical diff even when the text field is clamped (Sprint 4c-Follow-up-5)', () => {
    const hugeUnified = Array.from({ length: 200 }, (_, i) => `-line ${i}`).join('\n');
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({ changes: [{ path: 'foo.ts', kind: 'update', unified: hugeUnified, binary: false }] }),
    );
    // the bounded `text` fallback is still clamped…
    expect(reply.text).not.toContain('line 199');
    // …but the artifact is COMPLETE — no per-file omission, no truncation note in the canonical payload.
    expect(reply.preview).toBeDefined();
    expect(reply.preview!.canonicalDiff).toContain('-line 199');
    expect(reply.preview!.canonicalDiff).not.toContain('일부만');
    expect(reply.preview!.files).toHaveLength(1);
    expect(reply.preview!.files[0]!.unifiedDiff).toBe(hugeUnified);
    // F5-E: a stable, non-empty, secret-safe correlation id + a filesystem-safe non-secret filename.
    expect(typeof reply.preview!.previewId).toBe('string');
    expect(reply.preview!.previewId.length).toBeGreaterThan(0);
    expect(reply.preview!.attachmentFilename).toBe(`quoky-preview-${reply.preview!.previewId}.diff`);
    expect(reply.preview!.attachmentFilename).not.toContain('line 199'); // filename never carries diff content
  });

  it('F5-E: each preview gets its own stable previewId (distinct across calls, one per artifact)', () => {
    const a = composer.composeCodeDiffPreview(CTX, diffPreviewOf());
    const b = composer.composeCodeDiffPreview(CTX, diffPreviewOf());
    expect(a.preview!.previewId).not.toBe(b.preview!.previewId); // generated once per preview
    expect(a.preview!.footer).toContain('적용'); // apply-boundary framing present for the final message
  });

  it('F5: the out-of-scope safety warning is carried IN the PreviewArtifact (not only the fallback text)', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({ outOfScopeWarnings: ['packages/core/other.ts'] }),
    );
    expect(reply.preview!.warning).toBeDefined();
    expect(reply.preview!.warning).toContain('packages/core/other.ts');
    expect(reply.text).toContain('packages/core/other.ts'); // fallback text behavior unchanged
  });

  it('F5: no warning in the artifact when nothing is out of scope', () => {
    const reply = composer.composeCodeDiffPreview(CTX, diffPreviewOf({ outOfScopeWarnings: [] }));
    expect(reply.preview!.warning).toBeUndefined();
  });

  it('F5-A: no PreviewArtifact when there is no renderable diff (binary/empty only)', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({ changes: [{ path: 'bin', kind: 'update', unified: '', binary: true }] }),
    );
    expect(reply.preview).toBeUndefined();
  });

  it('many large diffs together still preserve the not-applied/not-modified wording and stay within the message budget (CA Round 1 Required Change #2)', () => {
    const bigUnified = Array.from({ length: 60 }, (_, i) => `-line ${i}`).join('\n');
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: Array.from({ length: 5 }, (_, i) => ({
          path: `packages/core/file-${i}.ts`,
          kind: 'update' as const,
          unified: bigUnified,
          binary: false,
        })),
      }),
    );
    expect(reply.text.length).toBeLessThanOrEqual(1900);
    expect(reply.text).toContain('파일은 수정되지 않았어요');
    expect(reply.text).toContain('아직 실제로 적용되지 않았어요');
    expect(reply.text).toContain('적용해줘'); // ADR-0099 D1: a ≤5-file update set is apply-capable
    // ADR-0099 D1: one (shorter) block per file within the budget — no file is dropped, each is marked cut.
    for (let i = 0; i < 5; i++) expect(reply.text).toContain(`packages/core/file-${i}.ts`);
    expect(reply.text).not.toContain('생략했어요');
    expect(reply.text.split('(diff가 길어서 일부만 보여드렸어요.)')).toHaveLength(6);
  });

  it('5 files with long paths and 50-line diffs still show every path — the real per-block overhead is budgeted', () => {
    const unified = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n');
    const longPath = (i: number) => `packages/core/src/application/${'deeply-nested-directory/'.repeat(3)}feature-${i}/implementation-file-${i}.ts`;
    expect(longPath(0).length).toBeGreaterThan(110);
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: Array.from({ length: 5 }, (_, i) => ({ path: longPath(i), kind: 'update' as const, unified, binary: false })),
      }),
    );
    expect(reply.text.length).toBeLessThanOrEqual(1900);
    for (let i = 0; i < 5; i++) expect(reply.text).toContain(longPath(i));
    expect(reply.text).not.toContain('생략했어요');
  });

  it('a set over the ADR-0099 byte bounds is not apply-capable at preview time (patch time would refuse it)', () => {
    const change = (path: string, o: { oldSize?: number; newSize?: number }) => ({
      path,
      kind: 'update' as const,
      unified: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\n`,
      binary: false,
      ...o,
    });
    const capable = (changes: CodeDiffPreview['changes']) =>
      composer.composeCodeDiffPreview(CTX, diffPreviewOf({ changes })).text.includes('"적용해줘"');
    expect(capable([change('a.ts', { oldSize: 10, newSize: 64 * 1024 })])).toBe(true);
    expect(capable([change('a.ts', { oldSize: 10, newSize: 64 * 1024 + 1 })])).toBe(false);
    expect(capable([change('a.ts', { oldSize: 64 * 1024 + 1, newSize: 10 })])).toBe(false);
    const fiveNear = Array.from({ length: 5 }, (_, i) => change(`f${i}.ts`, { newSize: 60 * 1024 }));
    expect(capable(fiveNear)).toBe(false); // 300 KiB > 256 KiB total
    expect(capable([change('a.ts', {})])).toBe(true); // unknown size: the patch-time check stays authoritative
  });

  it('more files than fit even at the per-file floor are dropped with a bounded omission notice, never truncated mid-block (ADR-0039)', () => {
    const bigUnified = Array.from({ length: 60 }, (_, i) => `-line ${'x'.repeat(40)} ${i}`).join('\n');
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: Array.from({ length: 12 }, (_, i) => ({
          path: `packages/core/file-${i}.ts`,
          kind: 'update' as const,
          unified: bigUnified,
          binary: false,
        })),
      }),
    );
    expect(reply.text.length).toBeLessThanOrEqual(1900);
    expect(reply.text).toContain('생략했어요'); // not every file's diff fit — the omission is noted, not silent
    expect(reply.text).toContain('바로 적용할 수는 없어요'); // > MAX_CHANGE_SET_FILES → apply-incapable footer
    expect(reply.text).toContain('파일은 수정되지 않았어요');
  });

  it('a 2-file update+add change set renders one block per file, marks the new file and is apply-capable (ADR-0099 D1)', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: [
          { path: 'src/a.ts', kind: 'update', unified: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n', binary: false },
          { path: 'src/b.ts', kind: 'add', unified: '--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+new\n', binary: false },
        ],
      }),
    );
    expect(reply.text).toContain('- src/a.ts\n');
    expect(reply.text).toContain('- src/b.ts (새 파일)');
    expect(reply.text).toContain('"적용해줘"');
    expect(reply.preview?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(reply.preview?.footer).toContain('적용해줘');
  });

  it('stays within the existing message-length bound even with a near-limit single diff', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({ changes: [{ path: 'foo.ts', kind: 'update', unified: 'x'.repeat(5000), binary: false }] }),
    );
    expect(reply.text.length).toBeLessThanOrEqual(1900);
  });

  // ── Footer Minimal Fix — apply-capable vs apply-incapable footer branching ───────────────────────
  it('apply-capable (single non-binary existing-file update) → advertises apply with the explicit "적용해줘" request phrase, calls out that bare 승인 is insufficient, and drops the stale "미지원" line', () => {
    const reply = composer.composeCodeDiffPreview(CTX, diffPreviewOf()); // default fixture = one non-binary update
    expect(reply.text).toContain('적용해줘'); // the phrase that drives the ELIGIBLE→apply-approval transition
    expect(reply.text).toContain('승인');
    expect(reply.text).toContain('파일이 변경되지 않아요'); // bare 승인 does not modify files
    expect(reply.text).toContain('아직 실제 파일에는 적용되지 않았어요'); // files still unmodified
    expect(reply.text).not.toContain('적용하는 기능은 아직 지원하지 않아요'); // stale blanket wording gone
    for (const word of FORBIDDEN_MUTATION_WORDS) expect(reply.text).not.toContain(word); // never implies applied
  });

  it('apply-CAPABLE (explicit new-file add, ADR-0099 D1) → advertises "적용해줘", files unchanged', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: [{ path: 'packages/core/src/new.ts', kind: 'add', unified: '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n', binary: false }],
      }),
    );
    expect(reply.text).toContain('적용해줘');
    expect(reply.text).not.toContain('바로 적용할 수는 없어요');
    expect(reply.text).toContain('파일은 수정되지 않았어요'); // not-modified fact stays explicit (header)
  });

  it('apply-INcapable (a delete in the set) → "cannot apply this shape" footer naming the real next step, no apply-request phrase', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: [
          { path: 'a.ts', kind: 'update', unified: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n', binary: false },
          { path: 'b.ts', kind: 'delete', unified: '--- a/b.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n', binary: false },
        ],
      }),
    );
    expect(reply.text).not.toContain('적용해줘');
    expect(reply.text).toContain('바로 적용할 수는 없어요');
    expect(reply.text).toContain('5개까지 경로와 함께 다시 요청해 주세요'); // real next step
    expect(reply.text).not.toContain('적용하는 기능은 아직 지원하지 않아요'); // stale blanket wording gone
  });

  it('apply-INcapable (a binary or undisplayable file inside a multi-file set) → no apply-request phrase', () => {
    for (const second of [
      { path: 'b.bin', kind: 'update' as const, unified: '', binary: true },
      { path: 'b.ts', kind: 'update' as const, unified: '', binary: false },
      { path: 'c.ts', kind: 'add' as const, unified: '', binary: false },
    ]) {
      const reply = composer.composeCodeDiffPreview(
        CTX,
        diffPreviewOf({
          changes: [{ path: 'a.ts', kind: 'update', unified: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n', binary: false }, second],
        }),
      );
      expect(reply.text, second.path).not.toContain('적용해줘');
      expect(reply.text, second.path).toContain('바로 적용할 수는 없어요');
    }
  });

  it('apply-CAPABLE (multi-file update ≤ 5, ADR-0099 D1) → advertises "적용해줘"', () => {
    const reply = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: [
          { path: 'a.ts', kind: 'update', unified: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n', binary: false },
          { path: 'b.ts', kind: 'update', unified: '--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n', binary: false },
        ],
      }),
    );
    expect(reply.text).toContain('적용해줘');
    expect(reply.text).not.toContain('바로 적용할 수는 없어요');
  });

  it('the structured PreviewArtifact footer is identical to the rendered text footer (both capable and incapable)', () => {
    const capable = composer.composeCodeDiffPreview(CTX, diffPreviewOf());
    expect(capable.preview!.footer).toContain('적용해줘');
    expect(capable.text).toContain(capable.preview!.footer); // same footer in text and artifact

    const incapable = composer.composeCodeDiffPreview(
      CTX,
      diffPreviewOf({
        changes: [{ path: 'packages/core/src/old.ts', kind: 'delete', unified: '--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-n\n', binary: false }],
      }),
    );
    expect(incapable.preview!.footer).toBe(
      '이 제안은 파일 삭제, 바이너리·표시할 수 없는 변경 또는 5개보다 많은 파일이 포함돼 바로 적용할 수는 없어요.\n' +
        '파일에 적용까지 하려면 고칠 기존 파일이나 새로 만들 파일을 5개까지 경로와 함께 다시 요청해 주세요.',
    );
    expect(incapable.text).toContain(incapable.preview!.footer);
  });
});

// ── Sprint 2s — Explicit Preview Apply Approval (ADR-0040) ─────────────────────────────────────────

describe('ResponseComposer.composeApplyApprovalRequested', () => {
  it('states this is for file modification, not preview generation', () => {
    const reply = composer.composeApplyApprovalRequested(CTX, ['packages/core/src/application/foo.ts']);
    expect(reply.text).toContain('실제 파일');
    expect(reply.text).toContain('미리보기 생성이 아니라');
    expect(reply.text).toContain('packages/core/src/application/foo.ts');
  });

  it('states nothing was modified yet', () => {
    const reply = composer.composeApplyApprovalRequested(CTX, ['foo.ts']);
    expect(reply.text).toContain('아직 파일은 수정되지 않았어요');
  });

  it('mentions revalidation against the latest file content before actual apply', () => {
    const reply = composer.composeApplyApprovalRequested(CTX, ['foo.ts']);
    expect(reply.text).toContain('최신 파일 내용으로 다시 확인');
  });

  it('names all three decision words — 승인/거절/취소', () => {
    const reply = composer.composeApplyApprovalRequested(CTX, ['foo.ts']);
    expect(reply.text).toContain('"승인"');
    expect(reply.text).toContain('"거절"');
    expect(reply.text).toContain('"취소"');
  });

  it('never uses wording that implies a completed mutation', () => {
    const reply = composer.composeApplyApprovalRequested(CTX, ['foo.ts']);
    for (const word of FORBIDDEN_MUTATION_WORDS) {
      expect(reply.text).not.toContain(word);
    }
  });
});

describe('ResponseComposer.composeApplyPreviewUnavailable', () => {
  it('states there is nothing to apply and never creates an approval-sounding reply', () => {
    const reply = composer.composeApplyPreviewUnavailable(CTX);
    expect(reply.text).toContain('적용할 수 있는 코드 변경 미리보기가 없어요');
  });

  it('never uses wording that implies a completed mutation', () => {
    const reply = composer.composeApplyPreviewUnavailable(CTX);
    for (const word of FORBIDDEN_MUTATION_WORDS) {
      expect(reply.text).not.toContain(word);
    }
  });
});

describe('ResponseComposer.composeApplyApprovalRecorded', () => {
  it('states the approval was recorded but not applied — never implies completion', () => {
    const reply = composer.composeApplyApprovalRecorded(CTX);
    expect(reply.text).toContain('적용 승인만 기록했어요');
    expect(reply.text).toContain('아직 실제 파일 적용은 수행하지 않았어요');
    expect(reply.text).toContain('파일은 수정되지 않았어요');
  });

  it('names the exact next phrase "패치 만들어줘"', () => {
    const reply = composer.composeApplyApprovalRecorded(CTX);
    expect(reply.text).toContain('"패치 만들어줘"');
  });

  it('never uses wording that implies a completed mutation', () => {
    const reply = composer.composeApplyApprovalRecorded(CTX);
    for (const word of FORBIDDEN_MUTATION_WORDS) {
      expect(reply.text).not.toContain(word);
    }
    expect(reply.text).not.toContain('적용 완료');
    expect(reply.text).not.toContain('반영 완료');
  });
});

// ── Sprint 2t — Approved Apply Context → PatchSet Preview (ADR-0041) ───────────────────────────────

describe('ResponseComposer.composePatchSetPreview', () => {
  const previewOf = (o: Partial<PatchSetPreview> = {}): PatchSetPreview => ({
    operations: [
      { path: 'packages/core/src/application/foo.ts', kind: 'update', unified: '@@ -1 +1 @@\n-old\n+new' },
    ],
    ...o,
  });

  it('uses "패치 미리보기" framing and states files were not modified (at least twice)', () => {
    const reply = composer.composePatchSetPreview(CTX, previewOf());
    expect(reply.text).toContain('패치 미리보기');
    const notApplied = (reply.text.match(/적용하지 않았어요|적용은 아직 지원하지 않아요|수정되지 않았어요/g) ?? []).length;
    expect(notApplied).toBeGreaterThanOrEqual(2);
  });

  it('footer says files are unchanged and names the exact apply phrase; no false "unsupported" wording', () => {
    const reply = composer.composePatchSetPreview(CTX, previewOf());
    expect(reply.text).toContain('파일은 아직 그대로예요.');
    expect(reply.text).toContain('"패치 적용해줘"');
    expect(reply.text).not.toContain('적용은 아직 지원하지 않아요');
    expect(reply.text).not.toContain('지원하지 않아요');
  });

  it('lists the operation path and its diff', () => {
    const reply = composer.composePatchSetPreview(CTX, previewOf());
    expect(reply.text).toContain('packages/core/src/application/foo.ts');
    expect(reply.text).toContain('+new');
  });

  it('labels a delete operation', () => {
    const reply = composer.composePatchSetPreview(
      CTX,
      previewOf({ operations: [{ path: 'old.ts', kind: 'delete', unified: '@@ -1 +0 @@\n-gone' }] }),
    );
    expect(reply.text).toContain('old.ts');
    expect(reply.text).toContain('삭제');
  });

  it('never uses forbidden mutation wording', () => {
    const reply = composer.composePatchSetPreview(CTX, previewOf());
    for (const word of [...FORBIDDEN_MUTATION_WORDS, '적용 완료']) {
      expect(reply.text).not.toContain(word);
    }
  });

  it('diff text with triple backticks does not break the fence', () => {
    const reply = composer.composePatchSetPreview(
      CTX,
      previewOf({ operations: [{ path: 'foo.ts', kind: 'update', unified: 'a\n```\nb\n```\nc' }] }),
    );
    expect(reply.text).toContain('````');
  });

  it('many large operations stay within MAX_MESSAGE_CHARS and keep the safety wording', () => {
    const big = Array.from({ length: 60 }, (_, i) => `+line ${i}`).join('\n');
    const reply = composer.composePatchSetPreview(
      CTX,
      previewOf({
        operations: Array.from({ length: 5 }, (_, i) => ({ path: `file-${i}.ts`, kind: 'update' as const, unified: big })),
      }),
    );
    expect(reply.text.length).toBeLessThanOrEqual(1900);
    expect(reply.text).toContain('패치 미리보기');
    expect(reply.text).toContain('파일은 수정되지 않았어요');
    // ADR-0099 D1: every operation of a ≤5-file set keeps its own (shorter) block — none is dropped.
    for (let i = 0; i < 5; i++) expect(reply.text).toContain(`file-${i}.ts`);
    expect(reply.text).not.toContain('생략했어요');
  });

  it('5 long-path operations each keep a block — the last view before "패치 적용해줘" hides no file', () => {
    const unified = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n');
    const longPath = (i: number) => `packages/core/src/application/${'deeply-nested-directory/'.repeat(3)}feature-${i}/implementation-file-${i}.ts`;
    const reply = composer.composePatchSetPreview(
      CTX,
      previewOf({
        operations: Array.from({ length: 5 }, (_, i) => ({ path: longPath(i), kind: i === 4 ? ('add' as const) : ('update' as const), unified })),
      }),
    );
    expect(reply.text.length).toBeLessThanOrEqual(1900);
    for (let i = 0; i < 5; i++) expect(reply.text).toContain(longPath(i));
    expect(reply.text).toContain(`${longPath(4)} (새 파일)`);
    expect(reply.text).not.toContain('생략했어요');
  });

  it('an `add` operation is labeled as a new file (ADR-0099 D1)', () => {
    const reply = composer.composePatchSetPreview(
      CTX,
      previewOf({
        operations: [
          { path: 'src/a.ts', kind: 'update', unified: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n' },
          { path: 'src/b.ts', kind: 'add', unified: '--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+n\n' },
        ],
      }),
    );
    expect(reply.text).toContain('- src/a.ts\n');
    expect(reply.text).toContain('- src/b.ts (새 파일)');
    expect(reply.text).toContain('파일은 수정되지 않았어요');
  });
});

describe('ResponseComposer.composePatch* failure/idempotent replies (ADR-0041)', () => {
  it('composePatchUnavailable states there is no approved change to patch, no mutation implied', () => {
    const reply = composer.composePatchUnavailable(CTX);
    expect(reply.text).toContain('승인된 코드 변경이 없어요');
    for (const word of FORBIDDEN_MUTATION_WORDS) expect(reply.text).not.toContain(word);
  });

  it('composePatchGenerationFailed states files were not modified and does not leak internals', () => {
    const reply = composer.composePatchGenerationFailed(CTX);
    expect(reply.text).toContain('패치를 만들지 못했어요');
    expect(reply.text).toContain('파일은 수정되지 않았어요');
  });

  it('composePatchAlreadyGenerated does not imply the patch was applied', () => {
    const reply = composer.composePatchAlreadyGenerated(CTX);
    expect(reply.text).toContain('이미 패치 미리보기를 만들어 뒀어요');
    expect(reply.text).toContain('파일은 수정되지 않았어요');
    for (const word of [...FORBIDDEN_MUTATION_WORDS, '적용 완료']) expect(reply.text).not.toContain(word);
  });

  it('the three patch replies are all distinct from one another', () => {
    const a = composer.composePatchUnavailable(CTX).text;
    const b = composer.composePatchGenerationFailed(CTX).text;
    const c = composer.composePatchAlreadyGenerated(CTX).text;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

// ── Sprint 2u — WorkspaceWrite Apply replies (ADR-0042) ──────────────────────────────────────────

describe('ResponseComposer.composeWorkspace* apply replies (ADR-0042)', () => {
  const TARGETS = ['packages/core/src/application/foo.ts'];
  // After a real write the working tree is NOT clean — these must never appear in any apply reply.
  const FORBIDDEN_APPLY_WORDS = ['git 변경 없음', 'git에는 아무 변경도', '커밋했어요', '푸시했어요', '배포', '테스트 통과', '검증 완료', '적용 완료'];

  it('composeWorkspaceApplied says the file was modified (CA 5)', () => {
    const reply = composer.composeWorkspaceApplied(CTX, TARGETS);
    expect(reply.text).toContain('수정했어요');
    expect(reply.text).toContain(TARGETS[0]!);
  });

  it('composeWorkspaceApplied says git commands were not run (CA 6) and commit/push were not performed (CA 7)', () => {
    const reply = composer.composeWorkspaceApplied(CTX, TARGETS);
    expect(reply.text).toContain('git 명령');
    expect(reply.text).toContain('커밋');
    expect(reply.text).toContain('푸시');
  });

  it('composeWorkspaceApplied says tests were not run (CA 8)', () => {
    const reply = composer.composeWorkspaceApplied(CTX, TARGETS);
    expect(reply.text).toContain('테스트');
    expect(reply.text).toContain('실행하지 않았어요');
  });

  it('composeWorkspaceApplied never says "git 변경 없음"/"git에는 아무 변경도" nor implies commit/push/deploy/tested (CA 9)', () => {
    const reply = composer.composeWorkspaceApplied(CTX, TARGETS);
    for (const word of FORBIDDEN_APPLY_WORDS) expect(reply.text, word).not.toContain(word);
  });

  it('Unavailable / Failed / AlreadyApplied never imply git/tests ran or a clean tree', () => {
    for (const reply of [
      composer.composeWorkspaceApplyUnavailable(CTX),
      composer.composeWorkspaceApplyFailed(CTX),
      composer.composeWorkspaceAlreadyApplied(CTX),
    ]) {
      for (const word of FORBIDDEN_APPLY_WORDS) expect(reply.text, word).not.toContain(word);
    }
  });

  it('composeWorkspaceApplyFailed and composeWorkspaceAlreadyApplied both state git/tests were not run', () => {
    for (const reply of [composer.composeWorkspaceApplyFailed(CTX), composer.composeWorkspaceAlreadyApplied(CTX)]) {
      expect(reply.text).toContain('git 명령');
      expect(reply.text).toContain('테스트');
    }
  });

  it('composeWorkspaceApplyUnavailable implies nothing was written', () => {
    const reply = composer.composeWorkspaceApplyUnavailable(CTX);
    expect(reply.text).toContain('준비된 패치가 없어요');
    expect(reply.text).not.toContain('수정했어요');
  });

  it('the four workspace-apply replies are all distinct', () => {
    const set = new Set([
      composer.composeWorkspaceApplied(CTX, TARGETS).text,
      composer.composeWorkspaceApplyUnavailable(CTX).text,
      composer.composeWorkspaceApplyFailed(CTX).text,
      composer.composeWorkspaceAlreadyApplied(CTX).text,
    ]);
    expect(set.size).toBe(4);
  });
});

// ── Sprint 2v — Post-Apply Validation Command replies (ADR-0043) ─────────────────────────────────

describe('ResponseComposer.composePostApplyValidation* replies (ADR-0043)', () => {
  const detailOf = (o: Partial<TestResultDetail> = {}): TestResultDetail => ({
    kind: 'test',
    command: 'pnpm',
    args: ['test'],
    exitCode: 0,
    durationMs: 1234,
    stdout: '',
    stderr: '',
    ...o,
  });
  // After a real apply the working tree is NOT clean — these must never appear in any validation reply.
  const FORBIDDEN = ['git 변경 없음', 'clean tree', '완전히 검증', '배포 가능', 'committed', 'pushed', 'deployed', '영구적으로 안전'];

  it('passed: this-run pass + command + bounded output + git-not-run + commit/push-not-performed (CA 5, 21, 24)', () => {
    const reply = composer.composePostApplyValidationPassed(CTX, detailOf({ stdout: 'all green\n' }));
    expect(reply.text).toContain('이번 실행 기준으로');
    expect(reply.text).toContain('pnpm test');
    expect(reply.text).toContain('all green');
    expect(reply.text).toContain('git 명령은 실행하지 않았어요');
    expect(reply.text).toContain('커밋/푸시는 하지 않았어요');
    for (const w of FORBIDDEN) expect(reply.text, w).not.toContain(w);
  });

  it('failed: project-result framing + git-not-run + commit/push-not-performed + no-rollback (CA 25)', () => {
    const reply = composer.composePostApplyValidationFailed(CTX, detailOf({ exitCode: 1, stdout: 'FAIL x\n' }));
    expect(reply.text).toContain('실패');
    expect(reply.text).toContain('FAIL x');
    expect(reply.text).toContain('git 명령은 실행하지 않았어요');
    expect(reply.text).toContain('커밋/푸시는 하지 않았어요');
    expect(reply.text).toContain('되돌리기'); // rollback not performed
    for (const w of FORBIDDEN) expect(reply.text, w).not.toContain(w);
  });

  it('timeout: distinct from failure, no exit-code verdict, git-not-run + commit/push-not-performed (CA 23, 26)', () => {
    const timeout = composer.composePostApplyValidationTimedOut(CTX, detailOf({ exitCode: undefined }));
    const failed = composer.composePostApplyValidationFailed(CTX, detailOf({ exitCode: 1 }));
    expect(timeout.text).not.toBe(failed.text);
    expect(timeout.text).toContain('제한 시간');
    expect(timeout.text).not.toContain('종료 코드'); // no exit-code verdict on a timeout
    expect(timeout.text).toContain('git 명령은 실행하지 않았어요');
    expect(timeout.text).toContain('커밋/푸시는 하지 않았어요');
    for (const w of FORBIDDEN) expect(timeout.text, w).not.toContain(w);
  });

  it('clarify asks for exactly one and runs nothing (CA #1/#3)', () => {
    const reply = composer.composePostApplyValidationClarify(CTX);
    expect(reply.text).toContain('테스트');
    expect(reply.text).toContain('타입체크');
  });

  it('unsupported states only pnpm test/typecheck are allowed, distinct from clarify (CA #2)', () => {
    const unsupported = composer.composePostApplyValidationUnsupported(CTX);
    expect(unsupported.text).toContain('pnpm test');
    expect(unsupported.text).toContain('pnpm typecheck');
    expect(unsupported.text).not.toBe(composer.composePostApplyValidationClarify(CTX).text);
  });

  it('typecheck label is used when kind is typecheck', () => {
    const reply = composer.composePostApplyValidationPassed(CTX, detailOf({ kind: 'typecheck', args: ['typecheck'] }));
    expect(reply.text).toContain('타입체크');
    expect(reply.text).toContain('pnpm typecheck');
  });

  it('the six post-apply validation replies are all distinct', () => {
    const set = new Set([
      composer.composePostApplyValidationPassed(CTX, detailOf()).text,
      composer.composePostApplyValidationFailed(CTX, detailOf({ exitCode: 1 })).text,
      composer.composePostApplyValidationTimedOut(CTX, detailOf({ exitCode: undefined })).text,
      composer.composePostApplyValidationClarify(CTX).text,
      composer.composePostApplyValidationUnsupported(CTX).text,
      composer.composePostApplyValidationUnavailable(CTX).text,
    ]);
    expect(set.size).toBe(6);
  });
});

// ── Sprint 2w — Post-Validation Git Status Preview replies (ADR-0044) ─────────────────────────────

describe('ResponseComposer.composeGit* preview replies (ADR-0044)', () => {
  const statusOf = (o: Partial<GitStatus> = {}): GitStatus => ({
    clean: false,
    branch: 'main',
    staged: ['a.ts'],
    unstaged: ['b.ts'],
    untracked: ['c.ts'],
    ...o,
  });
  const diffOf = (o: Partial<GitDiff> = {}): GitDiff => ({
    files: ['a.ts'],
    unified: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+y\n',
    truncated: false,
    ...o,
  });
  const DISCLAIMERS = ['읽기 전용 Git 미리보기', 'git add/commit/push는 하지 않았어요', '파일 수정은 하지 않았어요', '명령 실행도 하지 않았어요'];
  const FORBIDDEN = ['커밋 준비 완료', 'push 가능', '배포 가능', '검증 완료', '완전히 검증', 'committed', 'pushed', 'deployed', 'safe to commit', 'ready to deploy'];

  it('status preview: branch + changed files + read-only disclaimers + validation context', () => {
    const reply = composer.composeGitStatusPreview(CTX, { status: statusOf(), validation: { command: 'pnpm test', status: 'SUCCEEDED' } });
    expect(reply.text).toContain('main');
    expect(reply.text).toContain('a.ts');
    expect(reply.text).toContain('b.ts');
    expect(reply.text).toContain('c.ts');
    expect(reply.text).toContain('최근 검증 기록: pnpm test SUCCEEDED');
    for (const d of DISCLAIMERS) expect(reply.text, d).toContain(d);
    for (const f of FORBIDDEN) expect(reply.text, f).not.toContain(f);
  });

  it('status preview: clean tree says no changed files, never infers tests passed / deploy', () => {
    const reply = composer.composeGitStatusPreview(CTX, { status: statusOf({ clean: true, staged: [], unstaged: [], untracked: [] }), validation: 'none' });
    expect(reply.text).toContain('현재 Git 기준 변경 파일이 없어요');
    expect(reply.text).toContain('검증 기록 없음');
    expect(reply.text).not.toContain('테스트 통과');
    for (const f of FORBIDDEN) expect(reply.text, f).not.toContain(f);
  });

  it('status preview: changed files over 30 are truncated and labeled', () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const reply = composer.composeGitStatusPreview(CTX, { status: statusOf({ staged: many, unstaged: [], untracked: [] }), validation: 'none' });
    expect(reply.text).toContain('생략했어요');
  });

  it('diff preview: shows diff + untracked note + untracked from status + disclaimers', () => {
    const reply = composer.composeGitDiffPreview(CTX, { status: statusOf(), diff: diffOf(), validation: 'none' });
    expect(reply.text).toContain('diff --git');
    expect(reply.text).toContain('diff는 추적 중인 파일 변경만 포함해요');
    expect(reply.text).toContain('untracked 파일은 상태 목록에만 표시돼요');
    expect(reply.text).toContain('c.ts'); // untracked surfaced from status
    for (const d of DISCLAIMERS) expect(reply.text, d).toContain(d);
    for (const f of FORBIDDEN) expect(reply.text, f).not.toContain(f);
  });

  it('diff preview: truncated diff is labeled', () => {
    const reply = composer.composeGitDiffPreview(CTX, { status: statusOf(), diff: diffOf({ truncated: true }), validation: 'none' });
    expect(reply.text).toContain('일부만 보여드렸어요');
  });

  it('diff preview: diff over the display char budget is truncated and labeled', () => {
    const big = 'diff --git a/x b/x\n' + 'y'.repeat(5000);
    const reply = composer.composeGitDiffPreview(CTX, { status: statusOf(), diff: diffOf({ unified: big }), validation: 'none' });
    expect(reply.text).toContain('일부만 보여드렸어요');
  });

  it('validation context: resolved / none / unavailable are distinct', () => {
    const resolved = composer.composeGitStatusPreview(CTX, { status: statusOf(), validation: { command: 'pnpm typecheck', status: 'FAILED' } }).text;
    const none = composer.composeGitStatusPreview(CTX, { status: statusOf(), validation: 'none' }).text;
    const unavailable = composer.composeGitStatusPreview(CTX, { status: statusOf(), validation: 'unavailable' }).text;
    expect(resolved).toContain('pnpm typecheck FAILED');
    expect(none).toContain('검증 기록 없음');
    expect(unavailable).toContain('최근 검증 기록을 불러올 수 없어요');
    expect(new Set([resolved, none, unavailable]).size).toBe(3);
  });

  it('mutation-not-supported: read-only reminder, no committed/pushed claim, distinct', () => {
    const reply = composer.composeGitMutationNotSupported(CTX);
    expect(reply.text).toContain('지원하지 않아요');
    expect(reply.text).toContain('git 명령은 실행하지 않았어요');
    for (const f of FORBIDDEN) expect(reply.text, f).not.toContain(f);
  });

  it('QA-020: mutation copy never claims local commit is unsupported; remote copy names the flag and "커밋해줘"', () => {
    const local = composer.composeGitMutationNotSupported(CTX).text;
    const remoteOff = composer.composeGitMutationNotSupported(CTX, { scope: 'remote', remoteEnabled: false }).text;
    const remoteOn = composer.composeGitMutationNotSupported(CTX, { scope: 'remote', remoteEnabled: true }).text;
    for (const text of [local, remoteOff, remoteOn]) {
      expect(text).not.toContain('add/commit/push');
      expect(text).toContain('"커밋해줘"');
      expect(text).toContain('git 명령은 실행하지 않았어요');
    }
    expect(remoteOff).toContain(
      '원격 git 작업(push 등)은 Personal v1에서 꺼져 있어요(QUOKY_GIT_REMOTE_ENABLED=false). 로컬 커밋은 "커밋해줘"로 할 수 있어요.',
    );
    expect(remoteOn).not.toContain('꺼져 있어요');
    expect(local).toContain('reset/stash');
  });

  it('preview-unavailable: safe failure — read WAS attempted, so it must NOT claim no git command ran (CA impl review)', () => {
    const reply = composer.composeGitPreviewUnavailable(CTX);
    expect(reply.text).toContain('읽지 못했어요');
    // a read-only git subcommand WAS attempted on this path — the old inaccurate phrasing must be gone
    expect(reply.text).not.toContain('git 명령은 실행하지 않았어요');
    // instead it states what was NOT done
    expect(reply.text).toContain('git add/commit/push는 하지 않았어요');
    expect(reply.text).toContain('파일 수정은 하지 않았');
    expect(reply.text).toContain('CommandExecution을 통한 명령 실행도 하지 않았어요');
  });

  it('the four git-preview replies are all distinct', () => {
    const set = new Set([
      composer.composeGitStatusPreview(CTX, { status: statusOf(), validation: 'none' }).text,
      composer.composeGitDiffPreview(CTX, { status: statusOf(), diff: diffOf(), validation: 'none' }).text,
      composer.composeGitMutationNotSupported(CTX).text,
      composer.composeGitPreviewUnavailable(CTX).text,
    ]);
    expect(set.size).toBe(4);
  });
});

// ── Sprint 2x — Explicit Git Commit Approval replies (ADR-0045) ───────────────────────────────────

describe('ResponseComposer.composeCommit* replies (ADR-0045)', () => {
  const FORBIDDEN = ['커밋 완료', 'committed', 'commit created', '변경사항이 커밋됐어요', 'pushed', 'ready to deploy', 'safe to commit', '배포 가능'];

  it('approval-requested says approval-only, no actual commit this step (CA 66)', () => {
    const reply = composer.composeCommitApprovalRequested(CTX, { candidateFiles: ['a.ts', 'b.ts'], commitMessage: 'chore: update a.ts', validation: 'none' });
    expect(reply.text).toContain('커밋 승인을 요청했어요');
    expect(reply.text).toContain('a.ts');
    expect(reply.text).toContain('chore: update a.ts');
    expect(reply.text).toContain('실제 git add/commit/push는 수행하지 않아요');
    expect(reply.text).toContain('다음 단계');
    for (const f of FORBIDDEN) expect(reply.text, f).not.toContain(f);
  });

  it('approval-requested bounds the candidate file list to 30 with "외 N개"', () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const reply = composer.composeCommitApprovalRequested(CTX, { candidateFiles: many, commitMessage: 'm', validation: 'none' });
    expect(reply.text).toContain('외 10개');
  });

  it('approval-recorded says recorded but no commit performed (CA 67)', () => {
    const reply = composer.composeCommitApprovalRecorded(CTX);
    expect(reply.text).toContain('커밋 승인은 기록했어요');
    // QA-021: names the exact next phrase the runtime accepts
    expect(reply.text).toContain('실제로 커밋하려면 "커밋 실행"이라고 보내 주세요.');
    expect(composer.composeCommitAlreadyApproved(CTX).text).toContain('"커밋 실행"');
    // QA-022: the protected-branch refusal is specific and never claims a commit or an approval
    const protectedBranch = composer.composeCommitProtectedBranch(CTX).text;
    expect(protectedBranch).toContain('main/master 브랜치에는 커밋하지 않아요.');
    expect(protectedBranch).toContain('커밋 승인 요청은 만들지 않았어요');
    // ADR-0099 D4: points the owner at the in-chat branch command instead of leaving Quoky
    expect(protectedBranch).toContain('"브랜치 만들어줘 feature/<이름>"으로 새 브랜치를 만들 수 있어요');
    for (const f of FORBIDDEN) expect(protectedBranch, f).not.toContain(f);
    expect(reply.text).toContain('아직 실제 git add/commit/push는 수행하지 않았어요');
    for (const f of FORBIDDEN) expect(reply.text, f).not.toContain(f);
  });

  it('deny/cancel are commit-specific and say applied files remain (CA 68)', () => {
    for (const reply of [composer.composeCommitApprovalDenied(CTX), composer.composeCommitApprovalCancelled(CTX)]) {
      expect(reply.text).toContain('이미 적용된 파일 변경은 그대로 있어요');
      expect(reply.text).toContain('실제 git commit은 수행하지 않았어요');
    }
    // distinct from each other
    expect(composer.composeCommitApprovalDenied(CTX).text).not.toBe(composer.composeCommitApprovalCancelled(CTX).text);
  });

  it('composeNoPushTarget states there is no commit to push and that git push was not run (QA-V2-W8)', () => {
    const reply = composer.composeNoPushTarget(CTX);
    expect(reply.text).toContain('push할 커밋이 없어요');
    expect(reply.text).toContain('"푸시해줘"');
    expect(reply.text).toContain('git push는 하지 않았어요');
    expect(reply.text).not.toBe(composer.composePushUnsupportedCompanion(CTX).text);
  });

  it('wrong-state unavailable and git-status-read-failure are distinct; read-failure precise (CA 69)', () => {
    const wrongState = composer.composeCommitUnavailable(CTX);
    const readFail = composer.composeCommitStatusUnavailable(CTX);
    expect(wrongState.text).not.toBe(readFail.text);
    // wrong-state must not imply a git read was attempted
    expect(wrongState.text).not.toContain('Git 상태를 확인하는 중');
    // read-failure must NOT claim no git command ran (a read WAS attempted), but must state no mutation
    expect(readFail.text).not.toContain('git 명령은 실행하지 않았어요');
    expect(readFail.text).toContain('git add/commit/push는 하지 않았');
    expect(readFail.text).toContain('CommandExecution');
  });

  it('nothing-to-commit / out-of-scope / message-invalid / already-approved / unsupported-companion never overclaim (CA 70)', () => {
    const replies = [
      composer.composeCommitNothingToCommit(CTX),
      composer.composeCommitOutOfScopeChanges(CTX, ['x.ts']),
      composer.composeCommitMessageInvalid(CTX),
      composer.composeCommitAlreadyApproved(CTX),
      composer.composeCommitUnsupportedCompanion(CTX),
    ];
    for (const reply of replies) for (const f of FORBIDDEN) expect(reply.text, f).not.toContain(f);
    expect(composer.composeCommitAlreadyApproved(CTX).text).toContain('아직 실제 git add/commit/push는 수행하지 않았어요');
  });

  it('out-of-scope list is bounded to 10 with "외 N개"', () => {
    const many = Array.from({ length: 25 }, (_, i) => `o${i}.ts`);
    const reply = composer.composeCommitOutOfScopeChanges(CTX, many);
    expect(reply.text).toContain('외 15개');
  });

  it('the eleven commit replies are all distinct', () => {
    const set = new Set([
      composer.composeCommitApprovalRequested(CTX, { candidateFiles: ['a.ts'], commitMessage: 'm', validation: 'none' }).text,
      composer.composeCommitApprovalRecorded(CTX).text,
      composer.composeCommitApprovalDenied(CTX).text,
      composer.composeCommitApprovalCancelled(CTX).text,
      composer.composeCommitNothingToCommit(CTX).text,
      composer.composeCommitOutOfScopeChanges(CTX, ['x.ts']).text,
      composer.composeCommitMessageInvalid(CTX).text,
      composer.composeCommitUnavailable(CTX).text,
      composer.composeCommitStatusUnavailable(CTX).text,
      composer.composeCommitAlreadyApproved(CTX).text,
      composer.composeCommitUnsupportedCompanion(CTX).text,
    ]);
    expect(set.size).toBe(11);
  });
});

describe('ResponseComposer.composeCommitExecution* replies (Sprint 2y, ADR-0046)', () => {
  const HASH = '0123456789abcdef0123456789abcdef01234567';
  const OVERCLAIM = ['pushed', 'deployed', 'ready to push', 'ready to deploy', 'safe to deploy', '푸시 완료', '배포 완료', '배포했'];

  it('composeCommitExecuted states committed with hash + files, and no push (CA 83)', () => {
    const reply = composer.composeCommitExecuted(CTX, { commitHash: HASH, files: ['a.ts', 'b.ts'] });
    expect(reply.text).toContain('커밋했어요');
    expect(reply.text).toContain(HASH.slice(0, 7));
    expect(reply.text).toContain('a.ts');
    expect(reply.text).toContain('git push는 하지 않았어요');
    for (const f of OVERCLAIM) expect(reply.text, f).not.toContain(f);
  });

  it('composeCommitExecuted bounds the committed file list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const reply = composer.composeCommitExecuted(CTX, { commitHash: HASH, files: many });
    expect(reply.text).toContain('외 10개');
  });

  it('composeCommitExecutionFailed says not committed / no push / no rollback; never clean-index/원상복구 (CA 84)', () => {
    const reply = composer.composeCommitExecutionFailed(CTX);
    expect(reply.text).toContain('완료하지 못했어요');
    expect(reply.text).toContain('git push는 하지 않았어요');
    expect(reply.text).toContain('rollback은 수행하지 않았어요');
    expect(reply.text).toContain('다시 확인');
    for (const bad of ['변경 없음', '원상복구', '되돌렸', 'index unchanged']) expect(reply.text, bad).not.toContain(bad);
    for (const f of OVERCLAIM) expect(reply.text, f).not.toContain(f);
  });

  it('composeCommitExecutionUnavailable says a new commit approval is needed, no commit (CA 85)', () => {
    const reply = composer.composeCommitExecutionUnavailable(CTX);
    expect(reply.text).toContain('다시 커밋 승인을 받아 주세요');
    expect(reply.text).toContain('하지 않았어요');
    for (const f of OVERCLAIM) expect(reply.text, f).not.toContain(f);
  });

  it('composeCommitAlreadyCommitted includes the hash and says no new commit / no push (CA 86)', () => {
    const reply = composer.composeCommitAlreadyCommitted(CTX, HASH);
    expect(reply.text).toContain('이미 커밋했어요');
    expect(reply.text).toContain(HASH.slice(0, 7));
    expect(reply.text).toContain('git push는 하지 않았어요');
    for (const f of OVERCLAIM) expect(reply.text, f).not.toContain(f);
    // tolerates a missing hash without throwing
    expect(composer.composeCommitAlreadyCommitted(CTX).text).toContain('이미 커밋했어요');
  });

  it('composeCommitPushUnsupported says push not supported / no push (CA 87)', () => {
    const reply = composer.composeCommitPushUnsupported(CTX);
    expect(reply.text).toContain('push는 아직 지원하지 않아요');
    expect(reply.text).toContain('커밋만');
    for (const f of OVERCLAIM) expect(reply.text, f).not.toContain(f);
  });

  it('untracked-unsupported is DISTINCT from unavailable, mentions new file + separate step + no push (CA 88)', () => {
    const untracked = composer.composeCommitExecutionUntrackedUnsupported(CTX);
    const unavailable = composer.composeCommitExecutionUnavailable(CTX);
    expect(untracked.text).not.toBe(unavailable.text);
    expect(untracked.text).toContain('untracked');
    expect(untracked.text).toContain('새로 만들기로 요청하지 않은'); // ADR-0099 D3: only requested new files are added
    expect(untracked.text).toContain('git push는 하지 않았어요');
    for (const f of OVERCLAIM) expect(untracked.text, f).not.toContain(f);
  });

  it('the six commit-execution replies are all distinct', () => {
    const set = new Set([
      composer.composeCommitExecuted(CTX, { commitHash: HASH, files: ['a.ts'] }).text,
      composer.composeCommitExecutionFailed(CTX).text,
      composer.composeCommitExecutionUnavailable(CTX).text,
      composer.composeCommitExecutionUntrackedUnsupported(CTX).text,
      composer.composeCommitAlreadyCommitted(CTX, HASH).text,
      composer.composeCommitPushUnsupported(CTX).text,
    ]);
    expect(set.size).toBe(6);
  });
});

describe('ResponseComposer.composePush* replies (Sprint 2z, ADR-0047)', () => {
  const HASH = '0123456789abcdef0123456789abcdef01234567';
  const OVERCLAIM = ['pushed', 'deployed', 'ready to push', 'push-safe', 'ready to deploy', 'safe to deploy', '푸시 완료', '푸시했', '배포 완료', '배포했'];
  const reqInput = { commitHash: HASH, remote: 'origin', branch: 'main', upstream: 'origin/main', ahead: 2 };

  it('composePushApprovalRequested says approval-only + no push + point-in-time, with hash/remote/branch/ahead (CA 83)', () => {
    const reply = composer.composePushApprovalRequested(CTX, reqInput);
    expect(reply.text).toContain('push 승인을 요청했어요');
    expect(reply.text).toContain(HASH.slice(0, 7));
    expect(reply.text).toContain('origin/main');
    expect(reply.text).toContain('2개 앞섬');
    expect(reply.text).toContain('실제 git push를 하지 않아요');
    expect(reply.text).toContain('실제 push 실행 전에는 다시 확인');
    for (const f of OVERCLAIM) expect(reply.text, f).not.toContain(f);
  });

  it('composePushApprovalRequested bounds a long branch (CA 6/48)', () => {
    const longBranch = 'feature/' + 'x'.repeat(200);
    const reply = composer.composePushApprovalRequested(CTX, { ...reqInput, branch: longBranch });
    // the displayed branch is capped at 80 chars — the full 200-char string never appears verbatim
    expect(reply.text).not.toContain(longBranch);
  });

  it('composePushApprovalRecorded / denied / cancelled say no push; deny/cancel say commit remains local (CA 84–85)', () => {
    expect(composer.composePushApprovalRecorded(CTX).text).toContain('아직 실제 git push는 하지 않았어요');
    for (const reply of [composer.composePushApprovalDenied(CTX), composer.composePushApprovalCancelled(CTX)]) {
      expect(reply.text).toContain('커밋은 로컬에 그대로 있어요');
      expect(reply.text).toContain('git push는 하지 않았어요');
    }
  });

  it('composePushApprovalUnavailable / status-unavailable / no-upstream / dirty-tree never imply pushed (CA 86/88–90)', () => {
    const unavailable = composer.composePushApprovalUnavailable(CTX);
    expect(unavailable.text).toContain('git push는 하지 않았어요');
    const status = composer.composePushStatusUnavailable(CTX);
    expect(status.text).not.toContain('git 명령은 실행하지 않았어요'); // a read WAS attempted
    expect(status.text).toContain('CommandExecution');
    expect(status.text).toContain('push 승인 요청은 만들지 않았어요');
    expect(composer.composePushNoUpstream(CTX).text).toContain('업스트림을 새로 만들지 않아요');
    expect(composer.composePushDirtyWorkingTree(CTX).text).toContain('먼저 커밋하거나');
  });

  it('composePushAlreadyApproved says approved but not pushed (CA 87)', () => {
    const reply = composer.composePushAlreadyApproved(CTX);
    expect(reply.text).toContain('이미 push 승인을 받아 뒀어요');
    expect(reply.text).toContain('아직 실제 git push는 하지 않았어요');
  });

  it('no push reply overclaims pushed/deployed/ready-to-push/push-safe (CA 91)', () => {
    const replies = [
      composer.composePushApprovalRequested(CTX, reqInput),
      composer.composePushApprovalRecorded(CTX),
      composer.composePushApprovalDenied(CTX),
      composer.composePushApprovalCancelled(CTX),
      composer.composePushApprovalUnavailable(CTX),
      composer.composePushStatusUnavailable(CTX),
      composer.composePushHeadMovedUnavailable(CTX),
      composer.composePushDirtyWorkingTree(CTX),
      composer.composePushNoUpstream(CTX),
      composer.composePushNothingToPush(CTX),
      composer.composePushDiverged(CTX),
      composer.composePushAlreadyApproved(CTX),
      composer.composePushUnsupportedCompanion(CTX),
    ];
    for (const reply of replies) for (const f of OVERCLAIM) expect(reply.text, f).not.toContain(f);
  });

  it('the thirteen push replies are all distinct', () => {
    const set = new Set([
      composer.composePushApprovalRequested(CTX, reqInput).text,
      composer.composePushApprovalRecorded(CTX).text,
      composer.composePushApprovalDenied(CTX).text,
      composer.composePushApprovalCancelled(CTX).text,
      composer.composePushApprovalUnavailable(CTX).text,
      composer.composePushStatusUnavailable(CTX).text,
      composer.composePushHeadMovedUnavailable(CTX).text,
      composer.composePushDirtyWorkingTree(CTX).text,
      composer.composePushNoUpstream(CTX).text,
      composer.composePushNothingToPush(CTX).text,
      composer.composePushDiverged(CTX).text,
      composer.composePushAlreadyApproved(CTX).text,
      composer.composePushUnsupportedCompanion(CTX).text,
    ]);
    expect(set.size).toBe(13);
  });

  // ── ADR-0099 D5 (CODE-5): new-remote-branch push, protected/unsafe branch, deterministic next phrases ──────
  it('composePushApprovalRequested(newRemoteBranch) says a new remote branch is created, no force, no upstream; no ahead count', () => {
    const reply = composer.composePushApprovalRequested(CTX, {
      commitHash: HASH, remote: 'origin', branch: 'feature/x', upstream: 'origin/feature/x', ahead: 0, newRemoteBranch: true,
    });
    expect(reply.text).toContain('push 승인을 요청했어요');
    expect(reply.text).toContain('대상: origin/feature/x');
    expect(reply.text).toContain('원격에 새 브랜치로 만들어져요');
    expect(reply.text).toContain('강제 push는 하지 않고, 로컬 업스트림(추적 브랜치)도 설정하지 않아요');
    expect(reply.text).toContain('승인해도 이번 단계에서는 실제 git push를 하지 않아요');
    expect(reply.text).not.toContain('앞섬');
    for (const f of OVERCLAIM) expect(reply.text, f).not.toContain(f);
    // the legacy upstream copy is byte-identical when the flag is absent
    expect(composer.composePushApprovalRequested(CTX, reqInput).text).toContain('대상: origin/main (원격보다 2개 앞섬)');
    expect(composer.composePushApprovalRequested(CTX, reqInput).text).not.toContain('새 브랜치');
  });

  it('composePushExecuted(newRemoteBranch) states the remote branch was created, no force/upstream, and the PR next phrase', () => {
    const reply = composer.composePushExecuted(CTX, { commitHash: HASH, remote: 'origin', branch: 'feature/x', newRemoteBranch: true });
    expect(reply.text).toContain(`원격에 새 브랜치로 push했어요: ${HASH.slice(0, 7)} → origin/feature/x`);
    expect(reply.text).toContain('강제 push는 하지 않았고');
    expect(reply.text).toContain('"PR 만들어줘"');
    expect(composer.composePushExecuted(CTX, { commitHash: HASH, remote: 'origin', branch: 'main' }).text).toBe(
      `원격에 push했어요: ${HASH.slice(0, 7)} → origin/main\nPR 생성과 배포는 하지 않았어요.`,
    );
  });

  it('protected-branch and unsafe-name push replies refuse without approval or push, and are distinct', () => {
    const protectedReply = composer.composePushProtectedBranch(CTX).text;
    const unsafe = composer.composePushBranchNameUnsafe(CTX).text;
    expect(protectedReply).toContain('main/master 브랜치는 원격에 새로 push하지 않아요');
    for (const text of [protectedReply, unsafe]) {
      expect(text).toContain('push 승인은 만들지 않았어요');
      expect(text).toContain('git push는 하지 않았어요');
      for (const f of OVERCLAIM) expect(text, f).not.toContain(f);
    }
    expect(new Set([protectedReply, unsafe, composer.composePushNoUpstream(CTX).text]).size).toBe(3);
  });

  it('the recorded push / PR approvals name the deterministic execution phrase', () => {
    expect(composer.composePushApprovalRecorded(CTX).text).toContain('"푸시 실행"이라고 알려 주세요');
    expect(composer.composePrApprovalRecorded(CTX).text).toContain('"PR 생성 실행"이라고 알려 주세요');
    expect(composer.composePrApprovalRecorded(CTX).text).toContain('아직 PR은 만들지 않았어요');
  });
});

describe('ResponseComposer merge-disabled and post-send override copy (CODE-5)', () => {
  it('composeMergeDisabled names the flag and claims no merge, approval, sync or cleanup', () => {
    const text = composer.composeMergeDisabled(CTX).text;
    expect(text).toContain('병합은 이 설정에서 꺼져 있어요');
    expect(text).toContain('QUOKY_GIT_MERGE_ENABLED=false');
    expect(text).toContain('병합 승인은 만들지 않았어요');
    expect(text).not.toContain('병합했어요');
    expect(text).not.toContain('머지했어요');
  });

  it('sent-no-proposal and sent-then-cancelled lead with the one-time-send notice and ask for a fresh request + override', () => {
    const notice = composer.composeCredentialOverrideSentNotice(CTX, ['src/a.ts']).text;
    const noProposal = composer.composeCredentialOverrideSentNoProposal(CTX, ['src/a.ts']).text;
    const cancelled = composer.composeCredentialOverrideSentThenCancelled(CTX, ['src/a.ts']).text;
    for (const text of [noProposal, cancelled]) {
      expect(text.startsWith(notice)).toBe(true);
      expect(text).toContain('파일은 수정되지 않았어요');
      expect(text).toContain('이번 전송 확인은 이미 사용됐어요');
      expect(text).not.toContain('아무 파일도 AI에게 보내지 않았어요');
    }
    expect(noProposal).toContain('코드 변경 제안은 만들어지지 않았어요');
    expect(cancelled).toContain('이 코드 변경 요청은 취소됐어요');
    expect(cancelled).not.toContain(composer.composeScopeClarificationCancelled(CTX).text);
    expect(noProposal).not.toBe(cancelled);
  });

  it('a granted generation failure says truthfully how far the content got: not sent / uncertain (ADR-0097)', () => {
    const sentNotice = composer.composeCredentialOverrideSentNotice(CTX, ['src/a.ts']).text;
    const notSent = composer.composeCredentialOverrideGenerationFailed(CTX, ['src/a.ts'], 'not-sent').text;
    const uncertain = composer.composeCredentialOverrideGenerationFailed(CTX, ['src/a.ts'], 'uncertain').text;
    expect(notSent).toContain('파일 내용은 AI에게 보내지 않았어요: src/a.ts');
    expect(notSent).toContain('코드 변경 제안을 만들지 못했어요');
    expect(uncertain).toContain('AI 전송 중 오류가 나서 내용이 전달됐는지 확인할 수 없어요: src/a.ts');
    expect(uncertain).toContain('코드 변경 제안은 만들어지지 않았어요');
    for (const text of [notSent, uncertain]) {
      expect(text).not.toContain(sentNotice);
      expect(text).not.toContain('AI에게 보냈어요');
      expect(text).toContain('파일은 수정되지 않았어요');
      expect(text).toContain('이번 전송 확인은 이미 사용됐어요'); // consumed in every case — never replayed
    }
    expect(notSent).not.toBe(uncertain);
  });
});


// ── Quoky Personal v1 — next-phrase copy & conversation control (ADR-0093) ────────────────────────────

describe('ResponseComposer next-phrase copy (ADR-0093)', () => {
  const approval: ApprovalRequest = {
    id: 'appr-1',
    executionPlanRef: { id: 'plan-1' } as ApprovalRequest['executionPlanRef'],
    status: ApprovalStatus.PENDING,
    riskLevel: RiskLevel.HIGH,
    reason: 'Change packages/core/src/foo.ts',
    requestedBy: 'actor-1',
    createdAt: '2026-10-02T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
  };
  const APPROVE_DENY = '진행하려면 "승인", 거절하려면 "거절"이라고 답해 주세요.';
  const WORKSPACE_NEXT = '다음으로 "테스트 실행해줘"로 검증할 수 있고, 여기서 마치려면 "새 대화"라고 보내 주세요.';

  it.each<[string, () => string, string[]]>([
    ['AWAITING_APPROVAL notice', () => composer.composeApprovalNotice(CTX, approval).text, [APPROVE_DENY]],
    ['AWAITING_APPROVAL generic', () => composer.composeApprovalRequired(CTX).text, [APPROVE_DENY]],
    ['AWAITING_APPROVAL code change', () => composer.composeCodeChangeApprovalRequired(CTX).text, [APPROVE_DENY]],
    ['WORKSPACE_APPLIED', () => composer.composeWorkspaceApplied(CTX, ['foo.ts']).text, [WORKSPACE_NEXT]],
    [
      'pending reminder',
      () => composer.composePendingApprovalReminder(CTX, approval, 20 * 60_000).text,
      [
        '승인을 기다리는 작업이 있어요.',
        '위험도: 높음 — 실제 파일이나 Git 변경으로 이어질 수 있어요',
        APPROVE_DENY,
        '남은 시간: 약 20분 (지나면 자동으로 거절돼요)',
        '이 요청을 그만두고 새로 시작하려면 "새 대화"라고 보내 주세요.',
      ],
    ],
    [
      'approval expired',
      () => composer.composeApprovalExpired(CTX, approval, 1_800_000).text,
      [
        '승인 요청이 30분 안에 결정되지 않아 자동으로 거절했어요.',
        '위험도: 높음 — 실제 파일이나 Git 변경으로 이어질 수 있어요',
        '이 요청은 이제 승인할 수 없어요. 필요하면 처음부터 다시 요청해 주세요.',
      ],
    ],
    [
      'help',
      () => composer.composeHelp(CTX).text,
      [
        '- "도움말": 이 안내를 다시 보여줘요.',
        '- "새 대화": 지금 대화를 끝내고 새로 시작해요.',
        // QA-011: "/help"/"/reset" still work, but Discord opens the slash-command picker — close it with Esc
        '"/help", "/reset"',
        'Esc로 창을 닫은 뒤 Enter로 보내 주세요.',
        '승인 요청에는 "승인" 또는 "거절"로 답해 주세요.',
        '"적용해줘"',
        '"패치 만들어줘"',
        '"패치 적용해줘"',
        '"테스트 실행해줘"',
        '"기억해: <내용>"',
      ],
    ],
    [
      'reset (with a pending approval)',
      () => composer.composeConversationReset(CTX, { deniedPendingApproval: true }).text,
      [
        '새 대화를 시작할게요. 다음 메시지부터 새 대화로 이어져요.',
        '기다리던 승인 요청은 거절로 처리했어요.',
        '이미 적용한 파일 변경이나 커밋은 되돌리지 않았고, "기억해:"로 저장한 내용은 그대로 있어요.',
        '대화에 연결돼 있던 프로젝트는 풀렸어요. 코드 작업은 프로젝트를 다시 등록한 뒤 요청해 주세요.',
      ],
    ],
  ])('%s names the literal next phrases', (_name, render, expected) => {
    const text = render();
    for (const line of expected) expect(text).toContain(line);
  });

  it('the old "그만두려면 \"취소\"" approval prompt is gone from the AWAITING_APPROVAL replies', () => {
    for (const text of [
      composer.composeApprovalNotice(CTX, approval).text,
      composer.composeApprovalRequired(CTX).text,
      composer.composeCodeChangeApprovalRequired(CTX).text,
    ]) {
      expect(text).not.toContain('그만두려면 "취소"');
    }
  });

  it('no preview footer claims applying is unsupported any more', () => {
    const preview = composer.composeCodeGenerationPreview(CTX, {
      changes: [{ path: 'foo.ts', kind: 'update', excerpt: 'x' }],
      outOfScopeWarnings: [],
    });
    expect(preview.text).toContain('"적용해줘"');
    const multi = composer.composeCodeGenerationPreview(CTX, {
      changes: [
        { path: 'a.ts', kind: 'update', excerpt: 'x' },
        { path: 'b.ts', kind: 'update', excerpt: 'y' },
      ],
      outOfScopeWarnings: [],
    });
    // The legacy excerpt-only composer keeps its single-update rule (ADR-0099 D1 lives in composeCodeDiffPreview).
    expect(multi.text).not.toContain('"적용해줘"');
    const withDelete = composer.composeCodeGenerationPreview(CTX, {
      changes: [
        { path: 'a.ts', kind: 'update', excerpt: 'x' },
        { path: 'b.ts', kind: 'delete' },
      ],
      outOfScopeWarnings: [],
    });
    expect(withDelete.text).not.toContain('"적용해줘"');
    expect(withDelete.text).toContain('5개까지 경로와 함께 다시 요청해 주세요');
    for (const text of [preview.text, multi.text, withDelete.text]) {
      expect(text).not.toContain('적용하는 기능은 아직 지원하지 않아요');
    }
  });

  it('the reminder never shows 0 minutes and stays within the message budget for a long reason', () => {
    const reminder = composer.composePendingApprovalReminder(CTX, { ...approval, reason: 'r'.repeat(5000) }, 1);
    expect(reminder.text).toContain('남은 시간: 약 1분');
    expect(reminder.text.length).toBeLessThanOrEqual(1900);
  });

  it('QA-017: approval replies never show the internal English reason or the raw risk enum', () => {
    const internal = { ...approval, reason: 'HIGH risk requires human approval' };
    for (const text of [
      composer.composeApprovalNotice(CTX, internal).text,
      composer.composePendingApprovalReminder(CTX, internal, 20 * 60_000).text,
      composer.composeApprovalExpired(CTX, internal, 1_800_000).text,
    ]) {
      expect(text).not.toContain('requires human approval');
      expect(text).not.toMatch(/\bHIGH\b/);
      expect(text).toContain('위험도: 높음 — 실제 파일이나 Git 변경으로 이어질 수 있어요');
    }
  });

  it.each<[RiskLevel, string]>([
    [RiskLevel.CRITICAL, '위험도: 매우 높음'],
    [RiskLevel.HIGH, '위험도: 높음'],
    [RiskLevel.MEDIUM, '위험도: 보통'],
    [RiskLevel.LOW, '위험도: 낮음'],
  ])('QA-017: %s renders the Korean risk label', (riskLevel, label) => {
    const text = composer.composePendingApprovalReminder(CTX, { ...approval, riskLevel, reason: 'operation: git push approval planning' }, 60_000).text;
    expect(text).toContain(label);
    expect(text).not.toContain('operation:');
    expect(text).not.toContain(riskLevel);
  });

  it('QA-018: a stray decision with nothing pending says so without claiming any approval', () => {
    const text = composer.composeNoPendingDecision(CTX).text;
    expect(text).toBe(
      '지금 승인하거나 거절할 작업이 없어요. 기다리던 승인 요청은 처리됐거나 만료됐을 수 있어요. 새로 요청하려면 원하는 작업을 말해 주세요.',
    );
    expect(text).not.toMatch(/접수|승인했|승인됐/);
  });

  it('a reset without a pending approval does not claim one was denied', () => {
    expect(composer.composeConversationReset(CTX, { deniedPendingApproval: false }).text).not.toContain('거절');
  });

  it('composeWithNotice prepends the notice and keeps the reply fields', () => {
    const merged = composer.composeWithNotice({ context: CTX, text: 'NOTICE' }, composer.composeHelp(CTX));
    expect(merged.text.startsWith('NOTICE\n\n')).toBe(true);
    expect(merged.text).toContain(composer.composeHelp(CTX).text);
    expect(merged.context).toBe(CTX);
  });
});

describe('ResponseComposer — QA-015/QA-016 path replies', () => {
  it('rejected-path reply echoes the typed path in inline code with the relative-path example', () => {
    expect(composer.composeTargetPathRejected(CTX, 'src/nope.js').text).toBe(
      '요청한 파일을 프로젝트 안에서 찾을 수 없거나 프로젝트 밖 경로예요: `src/nope.js`\n' +
        '등록한 프로젝트 기준 상대경로(예: src/app.ts)로 다시 요청해 주세요.',
    );
  });

  it('rejected-path reply strips backticks/control characters and truncates a long path', () => {
    const text = composer.composeTargetPathRejected(CTX, `a/\`b\u0007/${'x'.repeat(200)}.ts`).text;
    expect(text).not.toContain('\u0007');
    expect(text.match(/`/g)).toHaveLength(2); // only the wrapping pair
    expect(text).toContain('…`');
    expect(text.length).toBeLessThan(200);
  });

  it('non-absolute project registration reply', () => {
    expect(composer.composeProjectPathNotAbsolute(CTX).text).toBe(
      '프로젝트는 절대경로로 등록해 주세요. 예: 이 프로젝트 등록해줘: /Users/me/my-repo',
    );
  });
});

describe('ResponseComposer — contributed help lines (ADR-0096 D6)', () => {
  const base = composer.composeHelp(CTX).text;
  const baseLines = base.split('\n');
  // The contributed lines extend the capability list, which ends right before the first blank line.
  const capabilityEnd = baseLines.indexOf('');

  it('with no contributed lines the help reply is exactly the fixed base text', () => {
    expect(composer.composeHelp(CTX, []).text).toBe(base);
    expect(composer.composeHelp(CTX, ['', '   ', '\n']).text).toBe(base);
    expect(composer.composeHelp(CTX, []).context).toBe(CTX);
  });

  it('appends contributed lines in the given order after the capability list and keeps the base text whole', () => {
    const text = composer.composeHelp(CTX, ['- 할 일: "할 일 추가: <제목>"', '- 피드백: "피드백 요약"']).text;
    expect(text.split('\n')).toEqual([
      ...baseLines.slice(0, capabilityEnd),
      '- 할 일: "할 일 추가: <제목>"',
      '- 피드백: "피드백 요약"',
      ...baseLines.slice(capabilityEnd),
    ]);
  });

  it(`bounds contributed lines to ${MAX_CONTRIBUTED_HELP_LINES} lines of at most ${MAX_CONTRIBUTED_HELP_LINE_CHARS} characters`, () => {
    expect(MAX_CONTRIBUTED_HELP_LINES).toBe(12);
    expect(MAX_CONTRIBUTED_HELP_LINE_CHARS).toBe(120);
    const many = Array.from({ length: 20 }, (_, i) => `- line ${i + 1}`);
    const lines = composer.composeHelp(CTX, many).text.split('\n');
    const contributed = lines.slice(capabilityEnd, lines.length - (baseLines.length - capabilityEnd));
    expect(contributed).toEqual(many.slice(0, MAX_CONTRIBUTED_HELP_LINES));

    const long = `- ${'가'.repeat(200)}`;
    const [clipped] = composer
      .composeHelp(CTX, [long])
      .text.split('\n')
      .slice(capabilityEnd, capabilityEnd + 1);
    expect(Array.from(clipped ?? '')).toHaveLength(MAX_CONTRIBUTED_HELP_LINE_CHARS);
    expect(clipped?.endsWith('…')).toBe(true);
  });

  it('collapses an embedded newline so a contributed line stays one line', () => {
    const text = composer.composeHelp(CTX, ['- 첫 줄\n둘째 줄']).text;
    expect(text.split('\n')).toContain('- 첫 줄 둘째 줄');
    expect(text.split('\n')).toHaveLength(baseLines.length + 1);
  });

  it('never cuts the base text: trailing contributed lines are dropped to fit the message budget', () => {
    const full = Array.from({ length: MAX_CONTRIBUTED_HELP_LINES }, (_, i) => `- ${String(i).padEnd(130, 'x')}`);
    const text = composer.composeHelp(CTX, full).text;
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text.endsWith(baseLines[baseLines.length - 1] ?? '')).toBe(true);
    for (const line of baseLines) expect(text.split('\n')).toContain(line);
    const kept = text.split('\n').length - baseLines.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(MAX_CONTRIBUTED_HELP_LINES);
  });
});

// ── ADR-0099 (CODE-3) — change-set replies: targets, apply outcomes, new-file marking, help ─────────

describe('ResponseComposer change-set replies (ADR-0099)', () => {
  it('composeTargetsMissing names every missing path (sanitized, inline code), asks again, modifies nothing', () => {
    const text = composer.composeTargetsMissing(CTX, ['src/a.ts', 'docs/`b`\u0007.md']).text;
    expect(text).toContain('`src/a.ts`');
    expect(text).toContain('`docs/b.md`');
    expect(text).toContain('다시 보내 주세요');
    expect(text).toContain('"새 파일 만들어줘"');
    expect(text).toContain('파일은 수정되지 않았어요');
    for (const word of FORBIDDEN_MUTATION_WORDS) expect(text).not.toContain(word);
  });

  it('composeTargetSecretNamed (QA-V2-CL-02) refuses by NAME — never "not found" — and says nothing was sent or modified', () => {
    const text = composer.composeTargetSecretNamed(CTX, ['src/hardsecret.js', 'docs/`b`\u0007token.md']).text;
    expect(text).toContain('`src/hardsecret.js`');
    expect(text).toContain('`docs/btoken.md`');
    expect(text).toContain('비밀 정보 파일처럼 보여서');
    expect(text).toContain('AI에게 보내지 않았고');
    expect(text).toContain('파일은 수정되지 않았어요');
    expect(text).not.toContain('찾을 수 없');
    expect(text).not.toContain('프로젝트 밖');
    for (const word of FORBIDDEN_MUTATION_WORDS) expect(text).not.toContain(word);
  });

  it('composeTooManyTargets states the 5-file limit and the count, and asks to split', () => {
    const text = composer.composeTooManyTargets(CTX, 7).text;
    expect(text).toContain('5개까지');
    expect(text).toContain('7개');
    expect(text).toContain('나눠서');
    expect(text).toContain('파일은 수정되지 않았어요');
  });

  it('rolled back says nothing changed; partially applied says it MAY have applied and lists the files; both distinct from failed', () => {
    const files = ['src/a.ts', 'src/b.ts'];
    const rolled = composer.composeWorkspaceApplyRolledBack(CTX, files).text;
    const partial = composer.composeWorkspaceApplyPartiallyApplied(CTX, files).text;
    expect(rolled).toContain('되돌렸어요');
    expect(rolled).toContain('바뀐 파일은 없어요');
    expect(rolled).toContain('src/a.ts, src/b.ts');
    expect(partial).toContain('적용됐을 수 있어요');
    expect(partial).toContain('확인할 파일: src/a.ts, src/b.ts');
    expect(partial).not.toContain('바뀐 파일은 없어요');
    for (const t of [rolled, partial]) {
      expect(t).toContain('git 명령이나 테스트는 실행하지 않았어요');
      expect(t).not.toContain('수정했어요');
    }
    expect(new Set([rolled, partial, composer.composeWorkspaceApplyFailed(CTX).text]).size).toBe(3);
  });

  it('composeWorkspaceApplied marks new files and is unchanged without them', () => {
    expect(composer.composeWorkspaceApplied(CTX, ['src/a.ts'])).toEqual(composer.composeWorkspaceApplied(CTX, ['src/a.ts'], []));
    const text = composer.composeWorkspaceApplied(CTX, ['src/a.ts', 'src/b.ts'], ['src/b.ts']).text;
    expect(text).toContain('파일을 수정했어요: src/a.ts, src/b.ts (새 파일)');
  });

  it('commit approval and executed replies mark new files; without newFiles the text is unchanged', () => {
    const base = { candidateFiles: ['src/a.ts', 'src/b.ts'], commitMessage: 'chore: x', validation: 'none' as const };
    expect(composer.composeCommitApprovalRequested(CTX, base).text).toContain('대상 파일: src/a.ts, src/b.ts\n');
    expect(composer.composeCommitApprovalRequested(CTX, { ...base, newFiles: ['src/b.ts'] }).text).toContain(
      '대상 파일: src/a.ts, src/b.ts (새 파일)\n',
    );
    const hash = 'abcdef1234567890';
    expect(composer.composeCommitExecuted(CTX, { commitHash: hash, files: ['src/a.ts'] }).text).toBe(
      '커밋했어요: abcdef1\n대상 파일: src/a.ts\ngit push는 하지 않았어요.',
    );
    expect(
      composer.composeCommitExecuted(CTX, { commitHash: hash, files: ['src/a.ts', 'src/b.ts'], newFiles: ['src/b.ts'] }).text,
    ).toContain('대상 파일: src/a.ts, src/b.ts (새 파일)');
  });

  it('the base help text carries one multi-file / new-file line', () => {
    const text = composer.composeHelp(CTX).text;
    const lines = text.split('\n').filter((l) => l.startsWith('- 여러 파일·새 파일'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('5개까지');
    expect(lines[0]).toContain('"새 파일 만들어줘"');
    expect(text.length).toBeLessThanOrEqual(1900);
  });
});

describe('ResponseComposer — credential-guard override copy (ADR-0097)', () => {
  const composer = new ResponseComposer();
  const PATH = 'src/user.ts';

  it('each delegate renders the credential-override copy for the path/line only and keeps the context', () => {
    const prompt = composer.composeCredentialOverridePrompt(CTX, PATH, 3);
    expect(prompt.context).toBe(CTX);
    expect(prompt.text).toContain(`3번째 줄`);
    expect(prompt.text).toContain(PATH);
    expect(prompt.text).toContain('"그래도 보내줘"');
    expect(prompt.text).toContain('외부 AI');
    expect(prompt.text).toContain('되돌릴 수 없어요');
    expect(prompt.text).toContain('30분');
    expect(prompt.text).toContain('파일은 수정되지 않았어요');

    const reprompt = composer.composeCredentialOverrideReprompt(CTX, PATH, 90_000).text;
    expect(reprompt).toContain('"승인", "좋아", "ok"로는 보내지 않아요.');
    expect(reprompt).toContain('약 2분');

    expect(composer.composeCredentialOverrideDenied(CTX, PATH).text).toContain('보내지 않았');
    expect(composer.composeCredentialOverrideContentChanged(CTX, PATH).text).toContain('파일 내용이 바뀌어서');
    expect(composer.composeNoPendingCredentialOverride(CTX).text).toContain('아무 파일도 보내지 않았어요');
    expect(composer.composeCredentialOverrideAlreadyUsed(CTX).text).toContain('이미 한 번 사용됐어요');
    expect(composer.composeCredentialOverrideInvalidated(CTX, 'expired').text).toContain('아무 파일도 AI에게 보내지 않았어요');
    expect(composer.composeCredentialOverrideSentNotice(CTX, ['a.ts', 'b.ts']).text).toContain('a.ts, b.ts');
  });

  it('the hard refusal is the credential refusal plus the never-overridable line, and never offers the phrase', () => {
    const text = composer.composeCredentialOverrideHardRefused(CTX, PATH).text;
    expect(text.startsWith(composer.composeCodeGenerationPreviewCredentialRefused(CTX, PATH).text)).toBe(true);
    expect(text).toContain('확인을 받아도 보낼 수 없어요');
    expect(text).not.toContain('그래도 보내줘');
  });

  it('a granted diff preview leads with the one-time-send notice in both the text and the preview header', () => {
    const preview: CodeDiffPreview = {
      changes: [{ path: PATH, kind: 'update', unified: '--- a/src/user.ts\n+++ b/src/user.ts\n@@ -1 +1 @@\n-a\n+b\n', binary: false }],
      outOfScopeWarnings: [],
    };
    const plain = composer.composeCodeDiffPreview(CTX, preview);
    const granted = composer.composeCodeDiffPreview(CTX, preview, { credentialOverrideSentPaths: [PATH] });
    const notice = composer.composeCredentialOverrideSentNotice(CTX, [PATH]).text;
    expect(plain.text).not.toContain(notice);
    expect(granted.text.startsWith(`${notice}\n\n`)).toBe(true);
    expect(granted.text.endsWith(plain.text.split('\n').slice(-1)[0]!)).toBe(true);
    expect(granted.preview?.header).toBe(`${notice}\n\n${plain.preview?.header}`);
    expect(granted.preview?.canonicalDiff).toBe(plain.preview?.canonicalDiff);
    expect(composer.composeCodeDiffPreview(CTX, preview, {}).text).toBe(plain.text);
  });

  it('the base help text carries one "그래도 보내줘" line naming the never-sendable classes', () => {
    const text = composer.composeHelp(CTX).text;
    const lines = text.split('\n').filter((l) => l.includes('"그래도 보내줘"'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('이번 한 번');
    expect(lines[0]).toContain('.env');
    expect(text.length).toBeLessThanOrEqual(1900);
  });
});

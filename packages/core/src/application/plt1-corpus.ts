import type { ConversationContext, GitStatus, MessageBody, OutboundMessage, PullRequestStatusPreview } from '../domain';
import { gitBranchReplies } from './code-work/git-branch-command';
import { ResponseComposer } from './response-composer';
import type { CodeChangePreview, CodeDiffPreview, PatchSetPreview } from './response-composer';

/**
 * Test fixtures for PLT-1, shared by the Core span tests, the Discord rendering golden and the Telegram rendering test
 * (one corpus, three renderings). Nothing in the runtime uses this module.
 */

/**
 * PLT-1 corpus: every Core reply that names an outside value (a path, branch, repository, commit message or URL) in
 * Quoky copy, built once with ordinary values and once with hostile ones (`_x_`, `*y*`, mentions, links, backticks).
 * Rendering one platform's markup over these shows the untrusted spans at work.
 */
export interface Plt1Variant {
  readonly id: string;
  readonly paths: readonly [string, string, string];
  readonly branch: string;
  readonly owner: string;
  readonly repo: string;
  readonly message: string;
  readonly url: string;
}

export const PLT1_VARIANTS: readonly Plt1Variant[] = [
  {
    id: 'plain',
    paths: ['src/app.ts', 'src/util.ts', 'docs/readme.md'],
    branch: 'feature/login',
    owner: 'quoky',
    repo: 'platform',
    message: 'fix: login redirect',
    url: 'https://github.com/quoky/platform/pull/7',
  },
  {
    id: 'nasty',
    paths: ['_draft_.ts', 'src/_x_/*y*.ts', 'docs/@everyone <@123> [a](https://x.example).md'],
    branch: 'feat/_wip_*star*',
    owner: 'my_org',
    repo: '*repo*_x',
    message: 'fix: *bold* _it_ @everyone `c`',
    url: 'https://github.com/my_org/*repo*_x/pull/7',
  },
];

const PLT1_CONTEXT: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-1' };

export function plt1Replies(composer: ResponseComposer, v: Plt1Variant): Array<[string, OutboundMessage | MessageBody]> {
  const ctx = PLT1_CONTEXT;
  const [p1, p2, p3] = v.paths;
  const all = [...v.paths];
  const diff = (kind: 'add' | 'update' | 'delete', path: string): CodeDiffPreview['changes'][number] => ({
    path,
    kind,
    unified: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
    binary: false,
  });
  const diffPreview: CodeDiffPreview = {
    changes: [diff('update', p1), diff('add', p2), diff('delete', p3), { path: `${p1}.bin`, kind: 'update', unified: '', binary: true }, { path: `${p2}.big`, kind: 'update', unified: '', binary: false }],
    outOfScopeWarnings: all,
  };
  const patch: PatchSetPreview = { operations: [diff('update', p1), diff('add', p2), diff('delete', p3)] };
  const codePreview: CodeChangePreview = {
    changes: [{ path: p1, kind: 'update', excerpt: 'new content' }, { path: p2, kind: 'delete' }],
    outOfScopeWarnings: all,
  };
  const status: GitStatus = { clean: false, branch: v.branch, staged: [p1], unstaged: [p2], untracked: [p3] };
  const pr = { owner: v.owner, repo: v.repo, headBranch: v.branch, baseBranch: 'main', commitHash: 'abcdef0123456789', prNumber: 7, prUrl: v.url };
  const statusPreview: PullRequestStatusPreview = {
    ref: { provider: 'github', owner: v.owner, repo: v.repo, pullRequestNumber: 7, pullRequestUrl: v.url },
    state: 'open',
    headBranch: v.branch,
    baseBranch: 'main',
    headCommitHash: 'abcdef0123456789',
    mergeability: 'MERGEABLE',
    checks: { state: 'failure', totalCount: 3, successCount: 2, failureCount: 1, pendingCount: 0 },
    observedAt: '2026-10-06T01:00:00.000Z',
  };
  const validation = { command: 'pnpm test', status: 'passed' };
  const manyFiles = Array.from({ length: 34 }, (_, i) => `${p1}.${i}`);
  const branchResult = { branch: v.branch, headSha: 'abcdef0123456789abcdef', created: true };
  const id = (name: string): string => `plt1.${v.id}.${name}`;
  return [
    [id('code-change.approval'), composer.composeCodeChangeApprovalRequired(ctx, [p1, p2, p3, `${p1}.x`], [p3, `${p1}.y`])],
    [id('code-change.approval.single'), composer.composeCodeChangeApprovalRequired(ctx, [p1])],
    [id('codegen.preview'), composer.composeCodeGenerationPreview(ctx, codePreview)],
    [id('codegen.no-valid-change'), composer.composeCodeGenerationPreviewNoValidChange(ctx, [...all, ...manyFiles.slice(0, 4)])],
    [id('codegen.credential-refused'), composer.composeCodeGenerationPreviewCredentialRefused(ctx, p1)],
    [id('credential.prompt'), composer.composeCredentialOverridePrompt(ctx, p1, 12)],
    [id('credential.hard-refused'), composer.composeCredentialOverrideHardRefused(ctx, p1)],
    [id('credential.reprompt'), composer.composeCredentialOverrideReprompt(ctx, p1, 60_000)],
    [id('credential.denied'), composer.composeCredentialOverrideDenied(ctx, p1)],
    [id('credential.content-changed'), composer.composeCredentialOverrideContentChanged(ctx, p1)],
    [id('credential.sent-notice'), composer.composeCredentialOverrideSentNotice(ctx, [p1, p2])],
    [id('credential.sent-no-proposal'), composer.composeCredentialOverrideSentNoProposal(ctx, [p1, p2])],
    [id('credential.generation-failed.not-sent'), composer.composeCredentialOverrideGenerationFailed(ctx, [p1, p2], 'not-sent')],
    [id('credential.generation-failed.uncertain'), composer.composeCredentialOverrideGenerationFailed(ctx, [p1, p2], 'uncertain')],
    [id('credential.sent-then-cancelled'), composer.composeCredentialOverrideSentThenCancelled(ctx, [p1, p2])],
    [id('preview.discarded'), composer.composeCodePreviewDiscarded(ctx, [p1, p2])],
    [id('diff.preview'), composer.composeCodeDiffPreview(ctx, diffPreview)],
    [id('diff.preview.override'), composer.composeCodeDiffPreview(ctx, diffPreview, { credentialOverrideSentPaths: [p1, p2] })],
    [id('diff.preview.single'), composer.composeCodeDiffPreview(ctx, { changes: [diff('update', p1)], outOfScopeWarnings: [] })],
    [id('apply.approval'), composer.composeApplyApprovalRequested(ctx, all)],
    [id('patch.preview'), composer.composePatchSetPreview(ctx, patch)],
    [id('workspace.applied'), composer.composeWorkspaceApplied(ctx, all, [p2])],
    [id('workspace.rolled-back'), composer.composeWorkspaceApplyRolledBack(ctx, all)],
    [id('workspace.partially-applied'), composer.composeWorkspaceApplyPartiallyApplied(ctx, [...all, ...manyFiles])],
    [id('git.status'), composer.composeGitStatusPreview(ctx, { status, validation })],
    [id('git.status.many'), composer.composeGitStatusPreview(ctx, { status: { ...status, untracked: manyFiles }, validation: 'none' })],
    [id('git.diff'), composer.composeGitDiffPreview(ctx, { status, diff: { unified: `diff --git a/${p1} b/${p1}\n--- a/${p1}\n+++ b/${p1}\n@@ -1 +1 @@\n-a\n+b\n`, truncated: false } as never, validation })],
    [id('commit.approval'), composer.composeCommitApprovalRequested(ctx, { candidateFiles: all, commitMessage: v.message, validation, newFiles: [p2] })],
    [id('commit.out-of-scope'), composer.composeCommitOutOfScopeChanges(ctx, all)],
    [id('commit.executed'), composer.composeCommitExecuted(ctx, { commitHash: 'abcdef0123456789', files: all, newFiles: [p3] })],
    [id('push.approval'), composer.composePushApprovalRequested(ctx, { commitHash: 'abcdef0123456789', remote: 'origin', branch: v.branch, upstream: `origin/${v.branch}`, ahead: 2 })],
    [id('push.approval.new-branch'), composer.composePushApprovalRequested(ctx, { commitHash: 'abcdef0123456789', remote: 'origin', branch: v.branch, upstream: '', ahead: 0, newRemoteBranch: true })],
    [id('push.executed'), composer.composePushExecuted(ctx, { commitHash: 'abcdef0123456789', remote: 'origin', branch: v.branch })],
    [id('push.executed.new-branch'), composer.composePushExecuted(ctx, { commitHash: 'abcdef0123456789', remote: 'origin', branch: v.branch, newRemoteBranch: true })],
    [id('push.already-pushed'), composer.composePushAlreadyPushed(ctx, { commitHash: 'abcdef0123456789', remote: 'origin', branch: v.branch })],
    [id('pr.approval'), composer.composePrApprovalRequested(ctx, { pushedCommitHash: 'abcdef0123456789', headBranch: v.branch, baseBranch: 'main', title: v.message, body: `body ${p1}` })],
    [id('pr.created'), composer.composePrCreated(ctx, pr)],
    [id('pr.reused'), composer.composePrCreatedReusedExisting(ctx, pr)],
    [id('pr.already-created'), composer.composePrAlreadyCreated(ctx, { prNumber: 7, prUrl: v.url })],
    [id('pr.status'), composer.composePrStatusPreview(ctx, statusPreview)],
    [id('merge.approval'), composer.composeMergeApprovalRequested(ctx, pr)],
    [id('merge.succeeded'), composer.composeMergeExecutionSucceeded(ctx, { ...pr, mergedHeadSha: 'abcdef0123456789', mergeCommitHash: '0123456789abcdef' })],
    [id('merge.already-merged'), composer.composeMergeExecutionAlreadyMerged(ctx, pr)],
    [id('cleanup.local.deleted'), composer.composeBranchCleanupSucceeded(ctx, { cleanedBranch: v.branch, cleanedLocalBranch: true, alreadyAbsent: false })],
    [id('cleanup.local.absent'), composer.composeBranchCleanupSucceeded(ctx, { cleanedBranch: v.branch, cleanedLocalBranch: false, alreadyAbsent: true })],
    [id('cleanup.remote.requested'), composer.composeRemoteBranchCleanupRequested(ctx, { ...pr, branch: v.branch, expectedHeadCommit: 'abcdef0123456789' })],
    [id('cleanup.remote.deleted'), composer.composeRemoteBranchCleanupSucceeded(ctx, { branch: v.branch, cleanedRemoteBranch: true, alreadyAbsent: false })],
    [id('cleanup.remote.absent'), composer.composeRemoteBranchCleanupSucceeded(ctx, { branch: v.branch, cleanedRemoteBranch: false, alreadyAbsent: true })],
    [id('cleanup.remote.already-cleaned'), composer.composeRemoteBranchAlreadyCleaned(ctx, { branch: v.branch })],
    [id('branch.created'), gitBranchReplies.created(v.branch, branchResult)],
    [id('branch.switched'), gitBranchReplies.switched(v.branch, { ...branchResult, created: false })],
    [id('branch.refused.exists'), gitBranchReplies.refused('branch-exists', v.branch)],
    [id('branch.refused.missing'), gitBranchReplies.refused('branch-missing', v.branch)],
  ];
}

/**
 * Replies whose rendering can outgrow the 1,900-character budget through escaping alone: snake_case paths (every `_` is
 * escaped on Discord) in a long untracked list, a long diff and two 169-character paths in a patch preview. The plain
 * text of each fits the budget; PLT-1 review P2-1 requires the fixed tail (validation line and disclaimers, the footer)
 * to survive on every platform and the cut to land in the path list or the diff.
 */
export function plt1OverflowReplies(composer: ResponseComposer): Array<[string, OutboundMessage]> {
  const ctx = PLT1_CONTEXT;
  const snake = Array.from({ length: 30 }, (_, i) => `tests/unit/test_feature_flag_case_${i}.py`);
  const longPath = (tag: string): string => `packages/${tag}_`.concat('very_long_snake_case_segment_'.repeat(6)).slice(0, 166).concat('.ts');
  const body = (n: number, prefix: string): string => Array.from({ length: n }, (_, i) => `${prefix}line_${i}_x`).join('\n');
  const status: GitStatus = { clean: false, branch: 'feature/flag_case', staged: [], unstaged: ['src/flag_case.py'], untracked: snake };
  const validation = { command: 'pnpm test', status: 'passed' };
  const op = (path: string): CodeDiffPreview['changes'][number] => ({
    path,
    kind: 'update',
    unified: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body(40, '+')}\n`.slice(0, 600),
    binary: false,
  });
  return [
    ['plt1.overflow.git.status', composer.composeGitStatusPreview(ctx, { status: { ...status, staged: snake.slice(0, 10), unstaged: snake.slice(10, 20) }, validation })],
    [
      'plt1.overflow.git.diff',
      composer.composeGitDiffPreview(ctx, {
        status,
        diff: { unified: `diff --git a/src/flag_case.py b/src/flag_case.py\n--- a/src/flag_case.py\n+++ b/src/flag_case.py\n@@ -1,200 +1,200 @@\n${body(200, '+')}\n`, truncated: false } as never,
        validation,
      }),
    ],
    ['plt1.overflow.patch.preview', composer.composePatchSetPreview(ctx, { operations: [op(longPath('a')), op(longPath('b'))] })],
    ['plt1.overflow.diff.preview', composer.composeCodeDiffPreview(ctx, { changes: [op(longPath('a')), op(longPath('b'))], outOfScopeWarnings: [] })],
  ];
}

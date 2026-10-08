import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApprovalManager,
  ApprovalPolicy,
  ApprovalStatus,
  CodeGenerationStatus,
  ConversationRuntime,
  GitManager,
  IntentResolver,
  PatchManager,
  RepositoryHostingManager,
  ResponseComposer,
  RiskLevel,
  RiskPolicy,
  SessionManager,
  SessionStatus,
  StatelessApprovalFlow,
  WorkspaceManager,
  WorkspaceWriteManager,
} from '@quoky/core';
import type {
  Actor,
  ApplyPreviewAnchor,
  ApplyPreviewFlow,
  ApprovalRequest,
  CodeProposal,
  ConversationContext,
  ConversationRuntimeDeps,
  ConversationTurnHandler,
  InboundMessage,
  Logger,
  PatchSet,
  PullRequestResult,
  RepositoryIdentity,
  Session,
  StorageProvider,
  Task,
  WorkspaceChange,
  WorkspaceRef,
  WorkspaceRepositoryResolution,
} from '@quoky/core';
import { LocalGitProvider } from '@quoky/git-local';
import type { GitRunner } from '@quoky/git-local';
import { LocalCloneWorkspaceProvider, LocalWorkspaceWriter } from '@quoky/workspace-local';
import { GitHubRepositoryHostingProvider, createPullRequestStatusTokenSource } from '@quoky/repository-hosting-github';
import { codeWorkProviders } from './features/code-work.providers';
import { createGitHubAppTokenSources } from './github-app-token-sources';
import type { GitHubAppTokenMinter } from './github-app-token-sources';
import { REPOSITORY_REFUSAL_HINTS, RepositoryAllowlist } from './repository-allowlist';
import { WorkspaceRepositoryIdentityResolver } from './workspace-repository-resolver';
import { CODE_WORK_TURN_HANDLERS } from './features/feature-tokens';
import { PersonalGitGuard } from './personal-git-guard';
import { PersonalHostingGuard } from './personal-hosting-guard';
import type { RepositoryHostingSurface } from './personal-hosting-guard';

/**
 * CODE-5 offline acceptance (ADR-0099 D4/D5): the opt-in push → PR chain end to end on a REAL ConversationRuntime,
 * with NO network.
 *
 * - git: the REAL `LocalGitProvider` (only its runner is given an isolated environment — no global/system git
 *   config, a throwaway HOME) inside the REAL `PersonalGitGuard`, under the REAL `GitManager`; the repository is a
 *   temp repo whose `origin` is a local BARE repository (a file path), so `git push` never leaves the machine;
 * - files: the REAL `LocalCloneWorkspaceProvider` (read-only diff/list) and `LocalWorkspaceWriter` (change-set apply)
 *   behind the REAL `WorkspaceManager` / `WorkspaceWriteManager`; the REAL `PatchManager` and `ApprovalManager` over
 *   an in-memory store;
 * - the branch command is the `GitBranchTurnHandler` built by the composition root's `codeWorkProviders` factory;
 * - AI: a FAKE code proposal (one update + one new file in a new directory) — no provider is called;
 * - hosting: a FAKE `RepositoryHostingManager` wrapped in the REAL `PersonalHostingGuard` (merge off).
 *
 * The chain starts at an approved apply (the preview/apply-approval steps are covered elsewhere) and walks:
 * branch create → patch → apply → commit approval → commit → push approval (CRITICAL, new remote branch) → push →
 * PR approval (CRITICAL) → PR create → merge request (merge disabled). With QUOKY_GIT_REMOTE_ENABLED=false the same
 * path stops at push with zero git push and zero hosting calls.
 */

const CTX: ConversationContext = { platform: 'test', channelId: 'code-v2-ch', userId: 'owner-user' };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-02T00:00:00.000Z' };
const UPDATE_PATH = 'src/a.ts';
const NEW_PATH = 'src/helpers/b.ts';
const BASELINE = 'export const a = 1;\n';
const UPDATED = "import { b } from './helpers/b';\nexport const a = b + 1;\n";
const NEW_CONTENT = 'export const b = 1;\n';
const BRANCH = 'uat/code-v2-20261002';
const IDENTITY: RepositoryIdentity = { provider: 'github', owner: 'jonghyungJeon-private', repo: 'quoky-uat-sandbox' };
const composer = new ResponseComposer();
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const bad = (name: string) => () => {
  throw new Error(`${name} must not be called`);
};

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

/** An isolated git environment: no global/system config, a throwaway HOME, a fixed identity. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Quoky Test',
    GIT_AUTHOR_EMAIL: 'test@quoky.invalid',
    GIT_COMMITTER_NAME: 'Quoky Test',
    GIT_COMMITTER_EMAIL: 'test@quoky.invalid',
  };
}

/** HARNESS git (setup and inspection only — never the bot). */
function hgit(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trimEnd();
}

/** The adapter's own runner shape, with the isolated environment (the adapter logic itself is unchanged). */
function isolatedRunner(env: NodeJS.ProcessEnv, gitCalls: string[]): GitRunner {
  return (args, { cwd, timeoutMs }) => {
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    gitCalls.push(sub);
    const res = spawnSync('git', args, { cwd, env, timeout: timeoutMs, encoding: 'utf8' });
    const timedOut = !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
    return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut, failed: !!res.error && !timedOut };
  };
}

interface Fixture {
  root: string;
  bare: string;
  env: NodeJS.ProcessEnv;
  initialSha: string;
}

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'quoky-code-v2-')));
  cleanup.push(base);
  const env = isolatedEnv(base);
  const root = join(base, 'repo');
  const bare = join(base, 'origin.git');
  mkdirSync(join(root, 'src'), { recursive: true });
  hgit(env, base, 'init', '-q', '--bare', '-b', 'main', bare);
  hgit(env, base, 'init', '-q', '-b', 'main', root);
  hgit(env, root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, UPDATE_PATH), BASELINE);
  hgit(env, root, 'add', '--', UPDATE_PATH);
  hgit(env, root, 'commit', '-q', '-m', 'baseline');
  hgit(env, root, 'remote', 'add', 'origin', bare);
  hgit(env, root, 'push', '-q', 'origin', 'main');
  return { root, bare, env, initialSha: hgit(env, root, 'rev-parse', 'HEAD') };
}

/** The FAKE AI proposal: one update and one new file in a new directory (the REAL workspace provider diffs it). */
const PROPOSAL: CodeProposal = {
  id: 'prop-1',
  codeGenerationRef: { id: 'gen-1', status: CodeGenerationStatus.SUCCEEDED },
  proposal: [
    { path: UPDATE_PATH, newContent: UPDATED },
    { path: NEW_PATH, newContent: NEW_CONTENT },
  ],
  providerId: 'fake-ai',
  createdAt: '2026-10-02T00:00:00.000Z',
} as CodeProposal;

interface HarnessOptions {
  remoteEnabled: boolean;
  /** Register the composition root's code-work handlers (default true). */
  withBranchHandler?: boolean;
  /** ADR-0109 D2: the composition root's per-workspace repository resolver (absent = the static identity). */
  resolveIdentity?: (rootPath: string, remote?: string) => Promise<WorkspaceRepositoryResolution>;
  /** Replace the fake hosting manager (still wrapped in the REAL PersonalHostingGuard). */
  hostingManager?: RepositoryHostingSurface;
}

function harness(fx: Fixture, opts: HarnessOptions) {
  const gitCalls: string[] = [];
  const hosting = { create: [] as unknown[], status: 0, merge: 0, deleteRemote: 0 };

  // ── in-memory store ────────────────────────────────────────────────────────────────────────────────────────
  const sessions = new Map<string, Session>();
  const approvals = new Map<string, ApprovalRequest>();
  const tasks = new Map<string, Task>();
  const patches = new Map<string, PatchSet>();
  const changes = new Map<string, WorkspaceChange>();
  const storage = {
    sessions: {
      async save(s: Session) { sessions.set(s.id, { ...s }); return s; },
      async get(id: string) { return sessions.get(id) ?? null; },
      async findActiveByContext(channelId: string, threadId?: string) {
        return [...sessions.values()].find((s) => s.status === SessionStatus.ACTIVE && s.context.channelId === channelId && s.context.threadId === threadId) ?? null;
      },
    },
    approvals: {
      async save(a: ApprovalRequest) { approvals.set(a.id, { ...a }); return a; },
      async get(id: string) { return approvals.get(id) ?? null; },
      async findByExecutionPlan(planId: string) { return [...approvals.values()].filter((a) => a.executionPlanRef.id === planId); },
    },
    tasks: {
      async get(id: string) { return tasks.get(id) ?? null; },
      async save(t: Task) { tasks.set(t.id, t); return t; },
    },
    patches: {
      async save(p: PatchSet) { patches.set(p.id, p); return p; },
      async get(id: string) { return patches.get(id) ?? null; },
      async findByExecutionPlan(planId: string) { return [...patches.values()].filter((p) => p.executionPlanRef.id === planId); },
    },
    workspaceChanges: {
      async save(c: WorkspaceChange) { changes.set(c.id, c); return c; },
      async get(id: string) { return changes.get(id) ?? null; },
      async findByPatchSet(patchSetId: string) { return [...changes.values()].filter((c) => c.patchRef.id === patchSetId); },
    },
  } as unknown as StorageProvider;

  // ── the apply approval the chain starts from (a previous turn's decision) ────────────────────────────────────
  const plan = { id: 'plan-code-v2', goal: 'split the helper' } as ApplyPreviewAnchor['executionPlanRef'];
  approvals.set('apply-approval', {
    id: 'apply-approval',
    executionPlanRef: plan,
    status: ApprovalStatus.APPROVED,
    riskLevel: RiskLevel.HIGH,
    reason: 'apply the previewed change',
    requestedBy: OWNER.id,
    decidedBy: OWNER.id,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  } as ApprovalRequest);
  sessions.set('sess-1', {
    id: 'sess-1',
    actorId: OWNER.id,
    context: CTX,
    status: SessionStatus.ACTIVE,
    activeProjectId: 'proj-1',
    createdAt: '2026-10-02T00:00:00.000Z',
    lastActivityAt: '2026-10-02T00:00:00.000Z',
  });

  const workspaceRef: WorkspaceRef = { id: 'ws-1', rootPath: fx.root, kind: 'local-clone' } as WorkspaceRef;
  let currentAnchor: ApplyPreviewAnchor | null = {
    kind: 'code-preview-apply',
    status: 'APPROVED',
    executionPlanRef: plan,
    workspaceRef,
    targetFiles: [UPDATE_PATH, NEW_PATH],
    newFileTargets: [NEW_PATH],
    codeGenerationRef: PROPOSAL.codeGenerationRef,
    codeProposalRef: { id: PROPOSAL.id },
    instruction: `${UPDATE_PATH}에서 헬퍼를 분리하고 새 파일 ${NEW_PATH}를 만들어줘`,
    projectId: 'proj-1',
    createdAt: '2026-10-02T00:00:00.000Z',
    approvalId: 'apply-approval',
  } as ApplyPreviewAnchor;
  const applyPreviewFlow: ApplyPreviewFlow = {
    async findAnchor() { return currentAnchor; },
    async anchor(_s, anchor) { currentAnchor = anchor; },
    async clear() { currentAnchor = null; },
  };

  // ── composition (mirrors app.module.ts) ──────────────────────────────────────────────────────────────────────
  const gitProvider = new PersonalGitGuard(new LocalGitProvider(isolatedRunner(fx.env, gitCalls)), {
    remoteEnabled: opts.remoteEnabled,
    mergeEnabled: false,
  });
  const git = new GitManager(gitProvider);
  const fakeHostingManager: RepositoryHostingSurface = {
    async createPullRequest(input): Promise<PullRequestResult> {
      hosting.create.push(input);
      return {
        provider: 'github',
        owner: input.identity.owner,
        repo: input.identity.repo,
        pullRequestNumber: 42,
        pullRequestUrl: `https://github.com/${input.identity.owner}/${input.identity.repo}/pull/42`,
        pullRequestHeadBranch: input.headBranch,
        pullRequestBaseBranch: input.baseBranch,
        pullRequestCommitHash: input.expectedCommitHash,
        reused: false,
      };
    },
    async getPullRequestStatus() { hosting.status++; throw new Error('status not expected'); },
    async mergePullRequest() { hosting.merge++; throw new Error('merge must not reach the manager'); },
    async deleteRemoteBranch() { hosting.deleteRemote++; throw new Error('delete must not reach the manager'); },
  };
  const hostingGuard = new PersonalHostingGuard(opts.hostingManager ?? fakeHostingManager, { mergeEnabled: false });
  const repositoryHosting = {
    identity: IDENTITY,
    ...(opts.resolveIdentity ? { resolveIdentity: opts.resolveIdentity } : {}),
    manager: opts.remoteEnabled ? hostingGuard : undefined,
  };

  const codeWork = codeWorkProviders.find(
    (p): p is { provide: symbol; useFactory: (g: GitManager) => readonly ConversationTurnHandler[]; inject: unknown[] } =>
      typeof p === 'object' && p !== null && 'provide' in p && p.provide === CODE_WORK_TURN_HANDLERS,
  );
  if (!codeWork) throw new Error('code-work providers must bind CODE_WORK_TURN_HANDLERS');
  const turnHandlers = opts.withBranchHandler === false ? [] : [...codeWork.useFactory(git)];

  const approvalManager = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
  const workspace = new WorkspaceManager(new LocalCloneWorkspaceProvider({ workspaceRoot: join(fx.root, '..', 'clones') }));
  const deps: ConversationRuntimeDeps = {
    dispatchCommit: bad('dispatchCommit') as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: new SessionManager(storage),
    memory: {
      async recordShortTerm() { return { id: 'mem-user' }; },
      async recordAssistant() { return undefined; },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter: { createCandidate: bad('memoryWriter'), promote: bad('memoryWriter'), forget: bad('memoryWriter') } as unknown as ConversationRuntimeDeps['memoryWriter'],
    classifier: { classify: bad('classifier.classify') } as unknown as ConversationRuntimeDeps['classifier'],
    projects: { register: bad('projects.register'), get: async () => null } as unknown as ConversationRuntimeDeps['projects'],
    analyzer: { prepare: bad('analyzer.prepare') } as unknown as ConversationRuntimeDeps['analyzer'],
    tasks: { createTask: bad('tasks.createTask') } as unknown as ConversationRuntimeDeps['tasks'],
    workspace,
    commandExecutions: { get: bad('commandExecutions.get') } as unknown as ConversationRuntimeDeps['commandExecutions'],
    command: { run: bad('command.run') } as unknown as ConversationRuntimeDeps['command'],
    contextBuilder: { build: bad('contextBuilder.build') } as unknown as ConversationRuntimeDeps['contextBuilder'],
    promptComposer: { compose: bad('promptComposer.compose') } as unknown as ConversationRuntimeDeps['promptComposer'],
    promptRenderer: { render: bad('promptRenderer.render') } as unknown as ConversationRuntimeDeps['promptRenderer'],
    router: { select: bad('router.select') } as unknown as ConversationRuntimeDeps['router'],
    artifacts: { async persistAll() { return []; } } as unknown as ConversationRuntimeDeps['artifacts'],
    composer,
    workSurface: { forActor: bad('workSurface.forActor') } as unknown as ConversationRuntimeDeps['workSurface'],
    intentResolver: new IntentResolver(),
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') } as unknown as ConversationRuntimeDeps['orchestrator'],
    approvals: approvalManager,
    approvalFlow: new StatelessApprovalFlow(storage),
    scopeClarificationFlow: {
      async findPending() { return null; },
      anchor: bad('scope.anchor'),
      async clear() { return undefined; },
    } as unknown as ConversationRuntimeDeps['scopeClarificationFlow'],
    applyPreviewFlow,
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('codeGeneration.getProposal') } as unknown as ConversationRuntimeDeps['codeGeneration'],
    patch: new PatchManager(storage),
    codeProposals: { get: async (id: string) => (id === PROPOSAL.id ? PROPOSAL : null) },
    workspaceWrite: new WorkspaceWriteManager(storage, new LocalWorkspaceWriter()),
    git,
    repositoryHosting,
    turnHandlers,
    logger: silent,
  } as unknown as ConversationRuntimeDeps;

  const runtime = new ConversationRuntime(deps, { gitRemoteEnabled: opts.remoteEnabled, gitMergeEnabled: false });
  let seq = 0;
  const send = (text: string) =>
    runtime.handle({ id: `m-${++seq}`, context: CTX, text, receivedAt: new Date().toISOString() } satisfies InboundMessage);
  const criticals = () => [...approvals.values()].filter((a) => a.riskLevel === RiskLevel.CRITICAL);
  return { send, anchor: () => currentAnchor, gitCalls, hosting, criticals, approvals, hostingGuard, gitProvider };
}

const remoteHead = (fx: Fixture, branch: string): string => {
  const out = hgit(fx.env, fx.root, 'ls-remote', fx.bare, `refs/heads/${branch}`);
  return out.split(/\s+/)[0] ?? '';
};

/** Branch create → patch → apply → commit; returns the commit hash. Shared by both remote settings. */
async function commitOnNewBranch(fx: Fixture, h: ReturnType<typeof harness>): Promise<string> {
  const created = await h.send(`브랜치 만들어줘 ${BRANCH}`);
  expect(created.status).toBe('RESPONDED');
  expect(created.reply.text).toContain('새 브랜치를 만들고 전환했어요');
  expect(hgit(fx.env, fx.root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
  expect(h.anchor()?.status).toBe('APPROVED'); // the branch command never re-anchors

  const patched = await h.send('패치 만들어줘');
  expect(patched.status).toBe('RESPONDED');
  expect(h.anchor()?.status).toBe('PATCH_READY');
  expect(existsSync(join(fx.root, NEW_PATH))).toBe(false); // a patch is a representation only

  const applied = await h.send('패치 적용해줘');
  expect(applied.status).toBe('RESPONDED');
  expect(h.anchor()?.status).toBe('WORKSPACE_APPLIED');
  expect(readFileSync(join(fx.root, UPDATE_PATH), 'utf8')).toBe(UPDATED);
  expect(readFileSync(join(fx.root, NEW_PATH), 'utf8')).toBe(NEW_CONTENT);
  expect(hgit(fx.env, fx.root, 'status', '--porcelain', '--untracked-files=all').split('\n').sort()).toEqual(
    [` M ${UPDATE_PATH}`, `?? ${NEW_PATH}`].sort(),
  );

  const commitAsk = await h.send('커밋해줘');
  expect(commitAsk.status).toBe('AWAITING_APPROVAL');
  expect(h.anchor()?.status).toBe('COMMIT_APPROVAL_PENDING');
  await h.send('승인');
  expect(h.anchor()?.status).toBe('COMMIT_APPROVED');
  const committed = await h.send('커밋 실행');
  expect(committed.status).toBe('RESPONDED');
  expect(h.anchor()?.status).toBe('GIT_COMMITTED');
  const commitHash = hgit(fx.env, fx.root, 'rev-parse', 'HEAD');
  expect(h.anchor()?.commitHash).toBe(commitHash);
  expect(hgit(fx.env, fx.root, 'rev-list', '--count', `main..${BRANCH}`)).toBe('1');
  expect(hgit(fx.env, fx.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([NEW_PATH, UPDATE_PATH].sort());
  expect(hgit(fx.env, fx.root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(hgit(fx.env, fx.root, 'rev-parse', 'main')).toBe(fx.initialSha);
  return commitHash;
}

describe('CODE-5 offline acceptance — opt-in push → PR chain (ADR-0099 D5, no network)', () => {
  it('remote ON, merge OFF: branch → 2-file change set → commit → CRITICAL push (new remote branch) → push → CRITICAL PR → PR_CREATED → merge disabled', async () => {
    const fx = makeFixture();
    const h = harness(fx, { remoteEnabled: true });
    const commitHash = await commitOnNewBranch(fx, h);

    // ── push approval: CRITICAL, new remote branch on origin, no upstream configured ──────────────────────────
    expect(hgit(fx.env, fx.root, 'for-each-ref', '--format=%(upstream)', `refs/heads/${BRANCH}`)).toBe('');
    const pushAsk = await h.send('푸시해줘');
    expect(pushAsk.status).toBe('AWAITING_APPROVAL');
    expect(pushAsk.reply.text).toContain(`대상: origin/${BRANCH}`);
    expect(pushAsk.reply.text).toContain('원격에 새 브랜치로 만들어져요');
    expect(h.anchor()).toMatchObject({
      status: 'PUSH_APPROVAL_PENDING',
      pushMode: 'new-remote-branch',
      pushRemote: 'origin',
      pushBranch: BRANCH,
      pushUpstreamRef: `origin/${BRANCH}`,
      pushCommitHash: commitHash,
    });
    expect(h.criticals()).toHaveLength(1);
    expect(h.criticals()[0]!.reason).toContain('mode: new remote branch');
    expect(h.gitCalls).not.toContain('push');
    expect(remoteHead(fx, BRANCH)).toBe('');

    const pushApproved = await h.send('승인');
    expect(pushApproved.reply.text).toContain('"푸시 실행"');
    expect(h.anchor()?.status).toBe('PUSH_APPROVED');
    expect(h.gitCalls).not.toContain('push');

    const pushed = await h.send('푸시 실행');
    expect(pushed.status).toBe('RESPONDED');
    expect(pushed.reply.text).toContain(`원격에 새 브랜치로 push했어요: ${commitHash.slice(0, 7)} → origin/${BRANCH}`);
    expect(h.gitCalls.filter((c) => c === 'push')).toHaveLength(1);
    expect(remoteHead(fx, BRANCH)).toBe(commitHash); // the bare origin now has refs/heads/<branch> == the commit
    expect(remoteHead(fx, 'main')).toBe(fx.initialSha); // main on origin untouched
    expect(hgit(fx.env, fx.root, 'for-each-ref', '--format=%(upstream)', `refs/heads/${BRANCH}`)).toBe(''); // no -u
    expect(h.anchor()).toMatchObject({ status: 'GIT_PUSHED', pushedBranch: BRANCH, pushedCommitHash: commitHash });

    // ── PR approval: CRITICAL; creation through the hosting guard, base main ──────────────────────────────────
    const prAsk = await h.send('PR 만들어줘');
    expect(prAsk.status).toBe('AWAITING_APPROVAL');
    expect(h.anchor()?.status).toBe('PR_APPROVAL_PENDING');
    expect(h.criticals()).toHaveLength(2);
    expect(h.hosting.create).toHaveLength(0);

    const prApproved = await h.send('승인');
    expect(prApproved.reply.text).toContain('"PR 생성 실행"');
    expect(h.anchor()?.status).toBe('PR_APPROVED');
    expect(h.hosting.create).toHaveLength(0);

    const prCreated = await h.send('PR 생성 실행');
    expect(prCreated.status).toBe('RESPONDED');
    expect(h.hosting.create).toHaveLength(1);
    expect(h.hosting.create[0]).toMatchObject({
      identity: IDENTITY,
      headBranch: BRANCH,
      baseBranch: 'main',
      expectedCommitHash: commitHash,
    });
    expect(h.anchor()).toMatchObject({ status: 'PR_CREATED', pullRequestNumber: 42, pullRequestHeadBranch: BRANCH, pullRequestBaseBranch: 'main' });

    // ── merge is off: a fixed reply before any approval; the guard would refuse the call anyway ──────────────
    for (const text of ['머지해줘', '병합해줘', 'merge this PR']) {
      const merge = await h.send(text);
      expect(merge.reply.text, text).toBe(composer.composeMergeDisabled(CTX).text);
    }
    expect(h.anchor()?.status).toBe('PR_CREATED');
    expect(h.criticals()).toHaveLength(2);
    expect(h.hosting.merge + h.hosting.deleteRemote).toBe(0);
    await expect(h.hostingGuard.mergePullRequest({} as never)).rejects.toThrow('QUOKY_GIT_MERGE_ENABLED=false');
    await expect(h.gitProvider.syncMainFastForward(fx.root, 'origin', 'main', commitHash, fx.initialSha)).rejects.toThrow('disabled');
    expect(h.hosting.merge).toBe(0);
    expect(hgit(fx.env, fx.root, 'rev-parse', 'main')).toBe(fx.initialSha);
  });

  it('remote ON: force push, a push from main, and a branch command after the commit are refused with no remote change', async () => {
    const fx = makeFixture();
    const h = harness(fx, { remoteEnabled: true });
    await commitOnNewBranch(fx, h);

    const force = await h.send('강제 푸시해줘');
    expect(force.reply.text).toBe(composer.composePushUnsupportedCompanion(CTX).text);
    const branchAfterCommit = await h.send('브랜치 만들어줘 feature/other');
    expect(branchAfterCommit.reply.text).toContain('커밋 승인 이후 단계');
    expect(h.anchor()?.status).toBe('GIT_COMMITTED');

    // a push from main (no upstream) is refused before any approval
    hgit(fx.env, fx.root, 'switch', '-q', 'main');
    const fromMain = await h.send('푸시해줘');
    expect(fromMain.status).toBe('FAILED'); // HEAD is no longer the committed commit
    expect(fromMain.reply.text).toBe(composer.composePushHeadMovedUnavailable(CTX).text);
    expect(h.criticals()).toHaveLength(0);
    expect(h.gitCalls).not.toContain('push');
    expect(remoteHead(fx, 'feature/other')).toBe('');
    expect(remoteHead(fx, BRANCH)).toBe('');
  });

  it('remote ON: the branch switched between push approval and execution → refused before any push', async () => {
    const fx = makeFixture();
    const h = harness(fx, { remoteEnabled: true });
    const commitHash = await commitOnNewBranch(fx, h);
    await h.send('푸시해줘');
    await h.send('승인');
    expect(h.anchor()?.status).toBe('PUSH_APPROVED');

    hgit(fx.env, fx.root, 'branch', 'side', commitHash);
    hgit(fx.env, fx.root, 'switch', '-q', 'side'); // same commit, different branch: drift
    const drift = await h.send('푸시 실행');
    expect(drift.reply.text).toBe(composer.composePushExecutionUnavailable(CTX).text);
    expect(h.gitCalls).not.toContain('push');
    expect(remoteHead(fx, BRANCH)).toBe('');
    expect(remoteHead(fx, 'side')).toBe('');
    expect(h.anchor()?.status).toBe('PUSH_APPROVED');
  });

  it('remote OFF (ADR-0094): the same path stops at push — zero git push, zero hosting calls, nothing on origin', async () => {
    const fx = makeFixture();
    const h = harness(fx, { remoteEnabled: false });
    await commitOnNewBranch(fx, h);

    await h.send('푸시해줘');
    await h.send('승인');
    const blocked = await h.send('푸시 실행');
    expect(blocked.status).toBe('FAILED');
    expect(blocked.reply.text).toBe(composer.composePushExecutionUnavailable(CTX).text); // "git push는 시도하지 않았어요"
    expect(h.anchor()?.status).toBe('PUSH_APPROVED'); // never GIT_PUSHED
    expect(h.gitCalls).not.toContain('push');
    expect(h.gitCalls).not.toContain('ls-remote');
    expect(remoteHead(fx, BRANCH)).toBe('');

    const pr = await h.send('PR 만들어줘');
    expect(pr.reply.text).not.toContain('PR 생성 승인을 요청했어요');
    expect(h.hosting.create).toHaveLength(0);
    expect(h.hosting.status + h.hosting.merge + h.hosting.deleteRemote).toBe(0);
  });

  it('without the composition-root registration the branch command is not handled (the registration is the change)', async () => {
    const fx = makeFixture();
    const h = harness(fx, { remoteEnabled: true, withBranchHandler: false });
    // with no handler the turn falls through past the post-anchor stage (here to the must-not-be-called classifier,
    // whose failure the runtime answers read-only) — no branch is created or switched
    const out = await h.send(`브랜치 만들어줘 ${BRANCH}`);
    expect(out.reply.text).not.toContain('새 브랜치를 만들고 전환했어요');
    expect(h.gitCalls).not.toContain('switch');
    expect(hgit(fx.env, fx.root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // with the registration (the same fixture), the composition root's handler creates and switches the branch
    const registered = harness(fx, { remoteEnabled: true });
    const created = await registered.send(`브랜치 만들어줘 ${BRANCH}`);
    expect(created.reply.text).toContain('새 브랜치를 만들고 전환했어요');
    expect(registered.gitCalls.filter((c) => c === 'switch')).toHaveLength(1);
  });
});

describe('CODE-8 offline acceptance — multi-repository allowlist (ADR-0109, no network)', () => {
  const OTHER: RepositoryIdentity = { provider: 'github', owner: 'jonghyungJeon-private', repo: 'quoky-uat-second' };

  /** The REAL resolver over the REAL allowlist; only the credential-free `origin` read is replaced by a mutable value. */
  function resolverWithOrigin(allowlist: readonly RepositoryIdentity[], initial: string) {
    let originUrl = initial;
    const reads: string[] = [];
    const resolver = new WorkspaceRepositoryIdentityResolver({
      allowlist: new RepositoryAllowlist(allowlist),
      readRemoteUrl: (rootPath, remote) => {
        reads.push(`${rootPath}:${remote}`);
        return [originUrl, originUrl];
      },
    });
    return {
      resolveIdentity: (rootPath: string, remote?: string) => resolver.resolve(rootPath, remote),
      setOrigin: (url: string) => { originUrl = url; },
      reads,
    };
  }

  /** The REAL GitHub hosting adapter + manager with the REAL token sources over a counting FAKE App minter and fetch. */
  function realHostingWithFakeMinter(allowlist: readonly RepositoryIdentity[]) {
    const mints: string[] = [];
    const fetches: string[] = [];
    const minter: GitHubAppTokenMinter = {
      async resolveInstallationId(owner, repo) { mints.push(`installation:${owner}/${repo}`); return 7; },
      async tokenForRepository(_id, owner, repo) { mints.push(`repo:${owner}/${repo}`); return 'minted-test-value'; },
      async tokenForInstallation() { mints.push('installation-token'); return 'minted-test-value'; },
    };
    const sources = createGitHubAppTokenSources({
      minter,
      allowlist: new RepositoryAllowlist(allowlist),
      createStatusTokenSource: (mint) => createPullRequestStatusTokenSource(mint, () => false),
    });
    const fetchImpl = (async (url: string) => {
      fetches.push(String(url));
      throw new Error('no network in this test');
    }) as unknown as typeof fetch;
    const manager = new RepositoryHostingManager(
      new GitHubRepositoryHostingProvider({
        auth: { kind: 'github-app', tokenSource: sources.tokenSource, statusTokenSource: sources.statusTokenSource },
        fetchImpl,
      }),
    );
    return { manager, mints, fetches };
  }

  it('an allowlisted origin: the chain runs to PR_CREATED and the PR targets the repository resolved from origin', async () => {
    const fx = makeFixture();
    const origin = resolverWithOrigin([OTHER, IDENTITY], `https://github.com/${IDENTITY.owner}/${IDENTITY.repo}.git`);
    const h = harness(fx, { remoteEnabled: true, resolveIdentity: origin.resolveIdentity });
    const commitHash = await commitOnNewBranch(fx, h);
    expect((await h.send('푸시해줘')).status).toBe('AWAITING_APPROVAL');
    await h.send('승인');
    expect((await h.send('푸시 실행')).status).toBe('RESPONDED');
    expect(remoteHead(fx, BRANCH)).toBe(commitHash);
    expect((await h.send('PR 만들어줘')).status).toBe('AWAITING_APPROVAL');
    expect(h.anchor()?.repositoryIdentity).toEqual(IDENTITY);
    await h.send('승인');
    expect((await h.send('PR 생성 실행')).status).toBe('RESPONDED');
    expect(h.hosting.create).toHaveLength(1);
    expect(h.hosting.create[0]).toMatchObject({ identity: IDENTITY, headBranch: BRANCH });
    expect(origin.reads.every((r) => r === `${fx.root}:origin`)).toBe(true);
  }, 60_000);

  it('a non-allowlisted origin: push is refused before any approval, git push, hosting call or token mint', async () => {
    const fx = makeFixture();
    const origin = resolverWithOrigin([IDENTITY], 'https://github.com/someone/unlisted.git');
    const real = realHostingWithFakeMinter([IDENTITY]);
    const h = harness(fx, { remoteEnabled: true, resolveIdentity: origin.resolveIdentity, hostingManager: real.manager });
    await commitOnNewBranch(fx, h);

    const pushAsk = await h.send('푸시해줘');
    expect(pushAsk.status).toBe('FAILED');
    expect(pushAsk.reply.text).toBe(composer.composeRepositoryNotAllowed(CTX, 'not-allowlisted', REPOSITORY_REFUSAL_HINTS['not-allowlisted']).text);
    expect(pushAsk.reply.text).toContain('토큰도 발급하지 않았어요');
    expect(pushAsk.reply.text).toContain('QUOKY_GITHUB_REPOS'); // the composition root's operator hint
    expect(h.anchor()?.status).toBe('GIT_COMMITTED');
    expect(h.criticals()).toHaveLength(0);
    expect(h.gitCalls).not.toContain('push');
    expect(remoteHead(fx, BRANCH)).toBe('');
    expect(real.mints).toEqual([]);
    expect(real.fetches).toEqual([]);
  }, 60_000);

  it('origin changed to a non-allowlisted repository after PR approval: PR creation is refused before any mint', async () => {
    const fx = makeFixture();
    const origin = resolverWithOrigin([IDENTITY], `https://github.com/${IDENTITY.owner}/${IDENTITY.repo}`);
    const real = realHostingWithFakeMinter([IDENTITY]);
    const h = harness(fx, { remoteEnabled: true, resolveIdentity: origin.resolveIdentity, hostingManager: real.manager });
    await commitOnNewBranch(fx, h);
    await h.send('푸시해줘');
    await h.send('승인');
    await h.send('푸시 실행');
    await h.send('PR 만들어줘');
    await h.send('승인');
    expect(h.anchor()?.status).toBe('PR_APPROVED');

    origin.setOrigin('https://github.com/someone/unlisted.git');
    const refused = await h.send('PR 생성 실행');
    expect(refused.reply.text).toBe(composer.composeRepositoryNotAllowed(CTX, 'not-allowlisted', REPOSITORY_REFUSAL_HINTS['not-allowlisted']).text);
    expect(h.anchor()?.status).toBe('PR_APPROVED');
    expect(real.mints).toEqual([]);
    expect(real.fetches).toEqual([]);

    // an SSH origin or a fetch/push pair naming two repositories is refused the same way, still with no mint
    origin.setOrigin(`git@github.com:${IDENTITY.owner}/${IDENTITY.repo}.git`);
    expect((await h.send('PR 생성 실행')).reply.text).toBe(composer.composeRepositoryNotAllowed(CTX, 'unsupported-remote', REPOSITORY_REFUSAL_HINTS['unsupported-remote']).text);
    expect(real.mints).toEqual([]);
    expect(real.fetches).toEqual([]);
  }, 60_000);

  it('a push approved for repository A cannot be retargeted to allowlisted repository B: TARGET_CHANGED, no push', async () => {
    const fx = makeFixture();
    const origin = resolverWithOrigin([IDENTITY, OTHER], `https://github.com/${IDENTITY.owner}/${IDENTITY.repo}.git`);
    const h = harness(fx, { remoteEnabled: true, resolveIdentity: origin.resolveIdentity });
    await commitOnNewBranch(fx, h);
    await h.send('푸시해줘');
    expect(h.anchor()?.pushRepositoryIdentity).toEqual(IDENTITY);
    expect(h.criticals()[0]!.reason).toContain(`repository: ${IDENTITY.owner}/${IDENTITY.repo}`);
    await h.send('승인');
    origin.setOrigin(`https://github.com/${OTHER.owner}/${OTHER.repo}.git`);
    const refused = await h.send('푸시 실행');
    expect(refused.reply.text).toBe(composer.composeRepositoryTargetChanged(CTX).text);
    expect(h.anchor()?.status).toBe('PUSH_APPROVED');
    expect(h.gitCalls).not.toContain('push');
    expect(remoteHead(fx, BRANCH)).toBe('');
  }, 60_000);

  it('legacy single repository without a resolver: byte-identical push approval reply (static identity path)', async () => {
    const fxA = makeFixture();
    const legacy = harness(fxA, { remoteEnabled: true });
    await commitOnNewBranch(fxA, legacy);
    const legacyReply = (await legacy.send('푸시해줘')).reply.text;

    const fxB = makeFixture();
    const origin = resolverWithOrigin([IDENTITY], `https://github.com/${IDENTITY.owner}/${IDENTITY.repo}.git`);
    const allowlisted = harness(fxB, { remoteEnabled: true, resolveIdentity: origin.resolveIdentity });
    await commitOnNewBranch(fxB, allowlisted);
    const allowlistedReply = (await allowlisted.send('푸시해줘')).reply.text;
    const strip = (t: string) => t.replace(/[0-9a-f]{7,40}/g, '<sha>');
    expect(strip(allowlistedReply)).toBe(strip(legacyReply));
  }, 60_000);
});

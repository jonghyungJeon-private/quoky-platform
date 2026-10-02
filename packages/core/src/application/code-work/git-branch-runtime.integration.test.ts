import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, Capability, IntentType, MemoryType, RiskLevel, SessionStatus } from '../../domain';
import type {
  Actor,
  ApprovalRequest,
  ConversationContext,
  GitBranchResult,
  GitCommitResult,
  GitStatus,
  InboundMessage,
  Intent,
  IsoTimestamp,
  Project,
  RepositoryInfo,
  Session,
  Task,
  WorkspaceRef,
} from '../../domain';
import type { AiProvider, GitProvider, Logger, StorageProvider } from '../../ports';
import { ApprovalManager } from '../approval-manager';
import type { ApprovalPolicy } from '../approval-policy';
import { ConversationRuntime } from '../conversation-runtime';
import type { ApplyPreviewAnchor, ApplyPreviewFlow, ConversationRuntimeDeps } from '../conversation-runtime';
import { GitManager } from '../git-manager';
import { IntentResolver } from '../intent-resolver';
import type { MemoryWriter } from '../memory-writer';
import { ResponseComposer } from '../response-composer';
import { SessionManager } from '../session-manager';
import { StatelessApprovalFlow } from '../stateless-approval-flow';
import { GitBranchTurnHandler } from './git-branch-command';

// CODE-4 (ADR-0099 D4): the branch handler registered locally on a REAL ConversationRuntime, against a REAL temp
// git repository. The git provider below is a test-local stand-in for the CAP-002 adapter (core never imports an
// adapter) that shells out to the real `git`; everything above it — GitManager policy, the handler, the runtime's
// pending intercepts and its commit flow — is the production code. Registration in the composition root is CODE-5.

const CTX: ConversationContext = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const T0 = '2026-10-02T09:00:00.000Z';
const TARGET = 'a.ts';
const composer = new ResponseComposer();
const bad = (name: string) => () => {
  throw new Error(`${name} must not be called`);
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trimEnd();
}

/** Test-local CAP-002 stand-in over the real `git` binary; counts every call so tests can assert "no git". */
function realGitProvider(root: string, calls: string[]): GitProvider {
  const headBranch = (): string => {
    try {
      return git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    } catch {
      return '';
    }
  };
  const head = (): string => git(root, 'rev-parse', 'HEAD');
  const provider = {
    kind: 'test-real-git',
    async isRepository() {
      return true;
    },
    async info(): Promise<RepositoryInfo> {
      calls.push('info');
      const branch = headBranch();
      return { isRepository: true, rootPath: root, branch, headSha: head(), detached: branch === '' };
    },
    async status(): Promise<GitStatus> {
      calls.push('status');
      const lines = git(root, 'status', '--porcelain=v1', '--untracked-files=all')
        .split('\n')
        .filter((l) => l.length > 0);
      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];
      for (const line of lines) {
        const path = line.slice(3);
        if (line.startsWith('??')) untracked.push(path);
        else {
          if (line[0] !== ' ') staged.push(path);
          if (line[1] !== ' ') unstaged.push(path);
        }
      }
      return { clean: lines.length === 0, branch: headBranch(), staged, unstaged, untracked };
    },
    async getLocalRefCommit(_root: string, branch: string) {
      calls.push(`ref:${branch}`);
      try {
        return { commitHash: git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) };
      } catch {
        return null;
      }
    },
    async createBranch(_root: string, branch: string, expectedHeadSha: string): Promise<GitBranchResult> {
      calls.push('createBranch');
      if (!head().startsWith(expectedHeadSha)) throw new Error('HEAD moved');
      git(root, 'switch', '-q', '-c', branch);
      return { branch: headBranch(), headSha: head(), created: true };
    },
    async switchBranch(_root: string, branch: string): Promise<GitBranchResult> {
      calls.push('switchBranch');
      git(root, 'switch', '-q', '--no-guess', branch);
      return { branch: headBranch(), headSha: head(), created: false };
    },
    async commitFiles(_root: string, files: string[], message: string): Promise<GitCommitResult> {
      calls.push('commitFiles');
      git(root, 'commit', '--only', '-m', message, '--', ...files);
      return { commitHash: head(), committedFiles: files, message };
    },
  };
  return provider as unknown as GitProvider;
}

interface Repo {
  root: string;
  initialSha: string;
}

function makeRepo(): Repo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quoky-branch-it-')));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, TARGET), 'export const a = 1;\n');
  git(root, 'add', '--', TARGET);
  git(root, 'commit', '-q', '-m', 'init');
  return { root, initialSha: git(root, 'rev-parse', 'HEAD') };
}

const anchorOf = (root: string, over: Partial<ApplyPreviewAnchor> = {}): ApplyPreviewAnchor => ({
  kind: 'code-preview-apply',
  status: 'WORKSPACE_APPLIED',
  executionPlanRef: { kind: 'ExecutionPlan', id: 'plan-1' } as unknown as ApplyPreviewAnchor['executionPlanRef'],
  workspaceRef: { id: 'ws-1', rootPath: root, kind: 'local-clone' } as WorkspaceRef,
  targetFiles: [TARGET],
  codeGenerationRef: { kind: 'CodeGeneration', id: 'gen-1' } as unknown as ApplyPreviewAnchor['codeGenerationRef'],
  codeProposalRef: { kind: 'CodeProposal', id: 'prop-1' } as unknown as ApplyPreviewAnchor['codeProposalRef'],
  instruction: 'update a.ts',
  projectId: 'proj-1',
  createdAt: T0,
  approvalId: 'apply-approval-earlier',
  workspaceChangeRef: { kind: 'WorkspaceChange', id: 'wc-1' } as unknown as ApplyPreviewAnchor['workspaceChangeRef'],
  ...over,
});

interface HarnessOptions {
  repo: Repo;
  anchor?: ApplyPreviewAnchor | null;
  /** Register the branch handler (default true). */
  withHandler?: boolean;
  activeProject?: boolean;
  /** Extra approvals seeded in storage (for pending-state anchors). */
  seedApprovals?: ApprovalRequest[];
}

function harness(opts: HarnessOptions) {
  const gitCalls: string[] = [];
  const provider = realGitProvider(opts.repo.root, gitCalls);
  const gitManager = new GitManager(provider);
  const sessions = new Map<string, Session>();
  const approvals = new Map<string, ApprovalRequest>();
  const tasks = new Map<string, Task>();
  const calls = { classify: 0, routerSelect: 0, providerExecute: 0, createTask: 0, startRun: 0 };

  const storage = {
    sessions: {
      async save(s: Session) {
        sessions.set(s.id, { ...s });
        return s;
      },
      async get(id: string) {
        return sessions.get(id) ?? null;
      },
      async findActiveByContext(channelId: string, threadId?: string) {
        return (
          [...sessions.values()]
            .filter((s) => s.status === SessionStatus.ACTIVE && s.context.channelId === channelId && s.context.threadId === threadId)
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0] ?? null
        );
      },
    },
    approvals: {
      async save(a: ApprovalRequest) {
        approvals.set(a.id, { ...a });
        return a;
      },
      async get(id: string) {
        return approvals.get(id) ?? null;
      },
      async findByExecutionPlan(planId: string) {
        return [...approvals.values()].filter((a) => a.executionPlanRef.id === planId);
      },
    },
    tasks: {
      async get(id: string) {
        return tasks.get(id) ?? null;
      },
      async save(t: Task) {
        tasks.set(t.id, t);
        return t;
      },
    },
  };
  for (const a of opts.seedApprovals ?? []) approvals.set(a.id, a);
  const approvalManager = new ApprovalManager(storage as unknown as StorageProvider, {} as ApprovalPolicy);

  sessions.set('sess-seeded', {
    id: 'sess-seeded',
    actorId: OWNER.id,
    context: CTX,
    status: SessionStatus.ACTIVE,
    createdAt: T0,
    lastActivityAt: T0,
    ...(opts.activeProject === false ? {} : { activeProjectId: 'proj-1' }),
  });

  let currentAnchor: ApplyPreviewAnchor | null = opts.anchor === undefined ? anchorOf(opts.repo.root) : opts.anchor;
  const anchorWrites: ApplyPreviewAnchor[] = [];
  const applyPreviewFlow: ApplyPreviewFlow = {
    async findAnchor() {
      return currentAnchor;
    },
    async anchor(_s, anchor) {
      currentAnchor = anchor;
      anchorWrites.push(anchor);
    },
    async clear() {
      currentAnchor = null;
    },
  };

  const aiProvider: AiProvider = {
    id: 'fake-provider',
    capabilities: [],
    async isAvailable() {
      return true;
    },
    async execute() {
      calls.providerExecute++;
      return { text: '안녕하세요!', artifacts: [] };
    },
  };
  const memoryWriter: MemoryWriter = {
    createCandidate: bad('memoryWriter.createCandidate') as unknown as MemoryWriter['createCandidate'],
    async promote(candidate) {
      return {
        outcome: 'PROMOTED',
        memory: {
          id: 'durable-1',
          content: candidate.content,
          memoryType: MemoryType.LONG_TERM,
          kind: candidate.kind,
          provenance: candidate.provenance,
          authorityLevel: candidate.authorityLevel,
          scope: candidate.scope,
          createdAt: T0,
          updatedAt: T0,
          metadata: candidate.metadata,
        },
        policyReason: 'accepted',
      };
    },
    forget: bad('memoryWriter.forget') as unknown as MemoryWriter['forget'],
  };
  const project: Project = { id: 'proj-1', name: 'demo', rootPath: opts.repo.root } as Project;
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  let approvalSeq = 0;

  const deps: ConversationRuntimeDeps = {
    dispatchCommit: bad('dispatchCommit') as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: new SessionManager(storage as unknown as StorageProvider),
    memory: {
      async recordShortTerm() { return { id: 'mem-user' }; },
      async recordAssistant() { return undefined; },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter,
    classifier: {
      async classify(): Promise<Intent> {
        calls.classify++;
        return { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'chat' };
      },
    },
    projects: {
      register: bad('projects.register'),
      get: async (id: string) => (id === project.id ? project : null),
    } as unknown as ConversationRuntimeDeps['projects'],
    analyzer: { prepare: bad('analyzer.prepare') },
    tasks: {
      async createTask() {
        calls.createTask++;
        throw new Error('createTask must not be called');
      },
      async transition(task, to) { return { ...task, status: to }; },
      async startRun() {
        calls.startRun++;
        throw new Error('startRun must not be called');
      },
      async completeRun() { return undefined; },
      async failRun() { return undefined; },
    },
    workspace: {
      prepare: async () => undefined,
      async open(p) { return { id: 'ws-active', projectId: p.id, rootPath: p.rootPath, kind: 'local-clone' } as WorkspaceRef; },
      list: bad('workspace.list'),
      diff: bad('workspace.diff'),
      read: bad('workspace.read'),
    },
    commandExecutions: { get: bad('commandExecutions.get') },
    command: { run: bad('command.run') },
    contextBuilder: { build: bad('contextBuilder.build') },
    promptComposer: { compose: bad('promptComposer.compose') },
    promptRenderer: { render: bad('promptRenderer.render') },
    router: {
      async select() {
        calls.routerSelect++;
        return aiProvider;
      },
    },
    artifacts: { async persistAll() { return []; } },
    composer,
    workSurface: { forActor: bad('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') },
    approvals: {
      decide: (id, d) => approvalManager.decide(id, d),
      get: (id) => approvalManager.get(id),
      async requestForRisk(input) {
        const request: ApprovalRequest = {
          id: `commit-appr-${++approvalSeq}`,
          executionPlanRef: input.executionPlanRef,
          status: ApprovalStatus.PENDING,
          riskLevel: input.riskLevel,
          reason: input.reason,
          requestedBy: input.requestedBy,
          createdAt: T0,
          updatedAt: T0,
        };
        approvals.set(request.id, request);
        return request;
      },
    },
    approvalFlow: new StatelessApprovalFlow(storage),
    scopeClarificationFlow: {
      async findPending() { return null; },
      anchor: bad('scope.anchor'),
      async clear() { return undefined; },
    },
    applyPreviewFlow,
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('codeGeneration.getProposal') },
    patch: { generate: bad('patch.generate'), get: bad('patch.get') },
    codeProposals: { get: bad('codeProposals.get') },
    workspaceWrite: { apply: bad('workspaceWrite.apply') },
    git: gitManager as unknown as ConversationRuntimeDeps['git'],
    ...(opts.withHandler === false ? {} : { turnHandlers: [new GitBranchTurnHandler({ git: gitManager, logger })] }),
    logger,
  };

  const runtime = new ConversationRuntime(deps, { clock: () => T0 as IsoTimestamp });
  let seq = 0;
  const send = (text: string) =>
    runtime.handle({ id: `msg-${++seq}`, context: CTX, text, receivedAt: T0 } satisfies InboundMessage);
  return { send, calls, gitCalls, anchor: () => currentAnchor, anchorWrites, approvals };
}

const branchOf = (root: string): string => git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
const touch = (root: string): void => writeFileSync(join(root, TARGET), 'export const a = 2;\n');

describe('GitBranchTurnHandler registered on a real ConversationRuntime (real temp repo)', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo.root, { recursive: true, force: true });
  });

  it('applied change on main → commit refused; create feature/x keeps the anchor; commit then succeeds on feature/x only', async () => {
    touch(repo.root);
    const h = harness({ repo });

    const refused = await h.send('커밋해줘');
    expect(refused.reply.text).toBe(composer.composeCommitProtectedBranch(CTX).text);
    expect(refused.reply.text).toContain('"브랜치 만들어줘 feature/<이름>"');
    expect(h.anchorWrites).toHaveLength(0);
    expect(h.approvals.size).toBe(0);

    const created = await h.send('브랜치 만들어줘 feature/x');
    expect(created.status).toBe('RESPONDED');
    expect(created.reply.text).toContain('새 브랜치를 만들고 전환했어요');
    expect(created.reply.text).toContain(`main → feature/x (HEAD ${repo.initialSha.slice(0, 7)})`);
    expect(branchOf(repo.root)).toBe('feature/x');
    expect(git(repo.root, 'rev-parse', 'main')).toBe(repo.initialSha);
    expect(h.gitCalls.filter((c) => c === 'createBranch')).toHaveLength(1);
    // the change travelled with the new branch; the anchor was never re-written
    expect(git(repo.root, 'status', '--porcelain')).toBe(` M ${TARGET}`);
    expect(h.anchorWrites).toHaveLength(0);
    expect(h.anchor()?.status).toBe('WORKSPACE_APPLIED');

    const approvalRequested = await h.send('커밋해줘');
    expect(approvalRequested.status).toBe('AWAITING_APPROVAL');
    expect(h.anchor()?.status).toBe('COMMIT_APPROVAL_PENDING');

    await h.send('승인');
    expect(h.anchor()?.status).toBe('COMMIT_APPROVED');

    const committed = await h.send('커밋 실행');
    expect(committed.status).toBe('RESPONDED');
    expect(h.anchor()?.status).toBe('GIT_COMMITTED');
    expect(git(repo.root, 'rev-list', '--count', 'main..feature/x')).toBe('1');
    expect(git(repo.root, 'rev-parse', 'main')).toBe(repo.initialSha);
    expect(git(repo.root, 'status', '--porcelain')).toBe('');
  });

  it('never calls a provider, classifier or Task machinery on a branch turn', async () => {
    const h = harness({ repo });
    await h.send('브랜치 만들어줘 feature/x');
    await h.send('feature/y 브랜치로 전환해줘');
    await h.send('브랜치 만들어줘');
    await h.send('브랜치 만들고 push 해줘');
    expect(h.calls).toEqual({ classify: 0, routerSelect: 0, providerExecute: 0, createTask: 0, startRun: 0 });
  });

  it('without the handler the same command is still swallowed by the mutating reject (the handler is the change)', async () => {
    touch(repo.root);
    const h = harness({ repo, withHandler: false });
    const out = await h.send('브랜치 만들어줘 feature/x');
    expect(out.reply.text).not.toContain('만들고 전환했어요');
    expect(branchOf(repo.root)).toBe('main');
    expect(h.gitCalls).not.toContain('createBranch');
  });

  it('switch is refused with a dirty tree and nothing changes', async () => {
    git(repo.root, 'branch', 'feature/y');
    touch(repo.root);
    const h = harness({ repo, anchor: null });
    const out = await h.send('feature/y 브랜치로 전환해줘');
    expect(out.reply.text).toContain('커밋하지 않은 변경이 있어서 전환하지 않았어요');
    expect(branchOf(repo.root)).toBe('main');
    expect(h.gitCalls).not.toContain('switchBranch');
  });

  it('switch is refused while a WORKSPACE_APPLIED anchor exists, even when the tree is clean', async () => {
    git(repo.root, 'branch', 'feature/y');
    const h = harness({ repo });
    const out = await h.send('feature/y 브랜치로 전환해줘');
    expect(out.reply.text).toContain('브랜치를 전환하지 않아요');
    expect(branchOf(repo.root)).toBe('main');
    expect(h.gitCalls).toEqual([]);
  });

  it('with no anchor, a clean tree switches to an existing local branch, and main/master stay protected', async () => {
    git(repo.root, 'branch', 'feature/y');
    const h = harness({ repo, anchor: null });
    const out = await h.send('feature/y 브랜치로 전환해줘');
    expect(out.reply.text).toContain('브랜치를 전환했어요');
    expect(branchOf(repo.root)).toBe('feature/y');

    const toMain = await h.send('main 브랜치로 전환해줘');
    expect(toMain.reply.text).toContain('main/master 이름은');
    const createMaster = await h.send('브랜치 만들어줘 master');
    expect(createMaster.reply.text).toContain('main/master 이름은');
    expect(branchOf(repo.root)).toBe('feature/y');
  });

  it('refuses an existing branch name and an invalid name without creating anything', async () => {
    git(repo.root, 'branch', 'feature/y');
    const h = harness({ repo, anchor: null });
    const exists = await h.send('브랜치 만들어줘 feature/y');
    expect(exists.reply.text).toContain('이미 있어요');
    const invalid = await h.send('브랜치 만들어줘 refs/heads/x');
    expect(invalid.reply.text).toContain('영문, 숫자');
    expect(branchOf(repo.root)).toBe('main');
    expect(h.gitCalls).not.toContain('createBranch');
  });

  it('with no active project it replies "register a project first" and runs no git', async () => {
    const h = harness({ repo, anchor: null, activeProject: false });
    const out = await h.send('브랜치 만들어줘 feature/x');
    expect(out.reply.text).toContain('프로젝트를 등록해 주세요');
    expect(h.gitCalls).toEqual([]);
    expect(branchOf(repo.root)).toBe('main');
  });

  it.each(['COMMIT_APPROVED', 'GIT_COMMITTED'] as const)('does not touch git at anchor %s', async (status) => {
    const h = harness({ repo, anchor: anchorOf(repo.root, { status, commitApprovalId: 'appr-x' }) });
    const out = await h.send('브랜치 만들어줘 feature/x');
    expect(out.reply.text).toContain('커밋 승인 이후 단계');
    expect(h.gitCalls).toEqual([]);
    expect(branchOf(repo.root)).toBe('main');
  });

  it('a pending commit approval still captures the turn: the branch command is a re-prompt, not a branch', async () => {
    const pending: ApprovalRequest = {
      id: 'commit-appr-seed',
      executionPlanRef: { kind: 'ExecutionPlan', id: 'plan-1' } as unknown as ApprovalRequest['executionPlanRef'],
      status: ApprovalStatus.PENDING,
      riskLevel: RiskLevel.HIGH,
      reason: 'Commit a.ts',
      requestedBy: OWNER.id,
      createdAt: T0,
      updatedAt: T0,
    };
    const h = harness({
      repo,
      seedApprovals: [pending],
      anchor: anchorOf(repo.root, {
        status: 'COMMIT_APPROVAL_PENDING',
        commitApprovalId: pending.id,
        proposedCommitMessage: 'chore: update a.ts',
        commitCandidateFiles: [TARGET],
      }),
    });
    const out = await h.send('브랜치 만들어줘 feature/x');
    expect(out.status).toBe('AWAITING_APPROVAL');
    expect(out.reply.text).not.toContain('만들고 전환했어요');
    expect(h.gitCalls).toEqual([]);
    expect(branchOf(repo.root)).toBe('main');
    expect(h.anchor()?.status).toBe('COMMIT_APPROVAL_PENDING');
  });

  it('contributes its help line to the "도움말" reply', async () => {
    const h = harness({ repo, anchor: null });
    const out = await h.send('도움말');
    expect(out.reply.text).toContain('"브랜치 만들어줘 feature/x"');
  });
});

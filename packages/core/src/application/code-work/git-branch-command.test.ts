import { describe, expect, it } from 'vitest';
import type { Actor, GitBranchResult, GitStatus, RepositoryInfo, Session, WorkspaceRef } from '../../domain';
import { SessionStatus } from '../../domain';
import type { TurnHandlerContext } from '../../ports';
import { MAX_CONTRIBUTED_HELP_LINE_CHARS } from '../response-composer';
import {
  GIT_BRANCH_HELP_LINE,
  GIT_BRANCH_TURN_HANDLER_ID,
  GitBranchTurnHandler,
  detectGitBranchCommand,
  detectGitBranchDeleteRequest,
  gitBranchReplies,
  type GitBranchTurnHandlerGit,
} from './git-branch-command';

const create = (name: string) => ({ kind: 'create', name });
const switchTo = (name: string) => ({ kind: 'switch', name });

describe('detectGitBranchCommand — create', () => {
  it.each([
    ['브랜치 만들어줘 feature/x', 'feature/x'],
    ['브랜치 만들어줘 `feature/x`', 'feature/x'],
    ['브랜치 만들어줘 "feature/x"', 'feature/x'],
    ["브랜치 만들어줘 'feature/x'", 'feature/x'],
    ['브랜치 만들어줘 feature/x.', 'feature/x'],
    ['브랜치 만들어주세요 feature/x', 'feature/x'],
    ['브랜치 만들어 줘 feature/x', 'feature/x'],
    ['브랜치를 만들어줘 feature/x', 'feature/x'],
    ['feature/x 브랜치 만들어줘', 'feature/x'],
    ['feature/x 브랜치를 만들어줘', 'feature/x'],
    ['`feature/x` 브랜치 만들어줘', 'feature/x'],
    ['브랜치 생성 feature/x', 'feature/x'],
    ['브랜치 생성해줘 feature/x', 'feature/x'],
    ['새 브랜치 feature/x', 'feature/x'],
    ['새 브랜치 feature/x 만들어줘', 'feature/x'],
    ['새 브랜치 만들어줘 feature/x', 'feature/x'],
    ['create branch feature/x', 'feature/x'],
    ['Create a new branch feature/x', 'feature/x'],
    ['create a branch named feature/x', 'feature/x'],
    ['please create branch Feature/X', 'Feature/X'],
    ['branch create feature/x', 'feature/x'],
    ['make branch uat/smoke-1', 'uat/smoke-1'],
  ])('%s → create %s', (text, name) => {
    expect(detectGitBranchCommand(text)).toEqual(create(name));
  });
});

describe('detectGitBranchCommand — switch', () => {
  it.each([
    ['feature/x 브랜치로 전환해줘', 'feature/x'],
    ['feature/x 브랜치로 전환', 'feature/x'],
    ['feature/x 브랜치로 바꿔줘', 'feature/x'],
    ['feature/x 브랜치로 이동해줘', 'feature/x'],
    ['`feature/x` 브랜치로 전환해줘', 'feature/x'],
    ['feature/x 브랜치 전환해줘', 'feature/x'],
    ['브랜치 전환 feature/x', 'feature/x'],
    ['브랜치 전환해줘 feature/x', 'feature/x'],
    ['switch to branch feature/x', 'feature/x'],
    ['switch to the branch feature/x', 'feature/x'],
    ['branch switch feature/x', 'feature/x'],
  ])('%s → switch %s', (text, name) => {
    expect(detectGitBranchCommand(text)).toEqual(switchTo(name));
  });
});

describe('detectGitBranchCommand — names are returned raw for the handler to refuse', () => {
  it.each(['main', 'Master', 'refs/heads/x', 'a..b', 'featé/x', '한글', 'HEAD'])('keeps %s as a token', (name) => {
    expect(detectGitBranchCommand(`브랜치 만들어줘 ${name}`)).toEqual(create(name));
    expect(detectGitBranchCommand(`${name} 브랜치로 전환해줘`)).toEqual(switchTo(name));
  });
});

describe('detectGitBranchCommand — token count', () => {
  it.each([
    ['브랜치 만들어줘', 'create'],
    ['새 브랜치 만들어줘', 'create'],
    ['create a branch', 'create'],
    ['브랜치 만들어줘 feature/x feature/y', 'create'],
    ['feature/x feature/y 브랜치 만들어줘', 'create'],
    ['새 기능 브랜치 만들어줘', 'create'],
    ['브랜치 전환해줘', 'switch'],
    ['브랜치로 전환해줘', 'switch'],
    ['브랜치 전환 a b', 'switch'],
  ])('%s → usage %s', (text, action) => {
    expect(detectGitBranchCommand(text)).toEqual({ kind: 'usage', action });
  });
});

describe('detectGitBranchCommand — negation', () => {
  it.each([
    '브랜치 만들지 마',
    '브랜치 만들지 말고 그냥 둬',
    'feature/x 브랜치 만들지 마',
    '브랜치 만들어줘 feature/x 하지만 지금은 만들지 마',
    '브랜치 만들지 마 feature/x',
    'feature/x 브랜치로 전환하지 마',
    '브랜치 전환하지 마',
    'do not create branch feature/x',
    "don't switch to branch feature/x",
    'never create branch feature/x',
    '브랜치 없이 진행해줘',
  ])('%s → null', (text) => {
    expect(detectGitBranchCommand(text)).toBeNull();
  });

  it('a negated companion is not a refusal, and multi-sentence text is not claimed', () => {
    expect(detectGitBranchCommand('푸시는 하지 마. 브랜치 만들어줘 feature/x')).toBeNull();
    expect(detectGitBranchCommand('push 하지 말고 브랜치 만들어줘 feature/x')).toBeNull();
  });
});

describe('detectGitBranchCommand — unsupported companions', () => {
  it.each([
    '브랜치 만들고 push 해줘 feature/x',
    '브랜치 만들어서 푸시해줘',
    'feature/x 브랜치 만들어줘 --force',
    '브랜치 만들어줘 -D',
    '브랜치 만들어줘 -b',
    '브랜치 삭제하고 새 브랜치 만들어줘 feature/x',
    '브랜치 만들고 merge 해줘',
    '브랜치 만들고 main에 머지해줘',
    '브랜치 만들고 rebase 해줘',
    '브랜치 만들고 reset 해줘',
    '브랜치 만들고 태그도 달아줘',
    'create branch and tag it',
    'create branch feature/x and push upstream',
    'feature/x 브랜치 이름 바꿔줘 브랜치 만들어줘',
    'rename branch and create branch feature/x',
    '브랜치 강제로 만들어줘 feature/x',
    'delete branch then create branch feature/x',
    '브랜치 만들고 이전 브랜치 정리해줘 feature/x',
  ])('%s → unsupported', (text) => {
    expect(detectGitBranchCommand(text)).toEqual({ kind: 'unsupported' });
  });

  it('a branch name that merely contains a companion word is still just a name', () => {
    expect(detectGitBranchCommand('브랜치 만들어줘 feature/push-notifications')).toEqual(create('feature/push-notifications'));
    expect(detectGitBranchCommand('create branch fix/tag-parser')).toEqual(create('fix/tag-parser'));
    expect(detectGitBranchCommand('feature/merge-helper 브랜치로 전환해줘')).toEqual(switchTo('feature/merge-helper'));
    expect(detectGitBranchCommand('브랜치 만들어줘 feature/reset-flow')).toEqual(create('feature/reset-flow'));
  });
});

describe('detectGitBranchDeleteRequest (QA-V2-W8)', () => {
  it.each([
    '브랜치 삭제해줘 feature/x',
    'feature/x 브랜치 지워줘',
    'delete branch feature/x',
    'remove the branch feature/x',
    '로컬 브랜치 삭제해줘',
    '브랜치 정리해줘',
    'git branch -D feature/x',
    'git branch --delete feature/x',
    '브랜치 삭제해 줘',
    '브랜치 feature/x 삭제해줘',
    'feature/x 브랜치 제거해줘',
    '브랜치를 지워줘',
    'delete the local branch',
    'delete feature/x branch',
    'clean up branch',
  ])('%s → delete request', (text) => {
    expect(detectGitBranchDeleteRequest(text)).toBe(true);
  });

  it.each([
    '브랜치 목록 보여줘',
    '지금 브랜치 뭐야',
    '브랜치 삭제는 어떻게 해?',
    'how do I delete a branch',
    '브랜치 삭제하면 어떻게 돼',
    '브랜치 삭제하지 마',
    '브랜치 만들어줘 feature/x',
    '커밋해줘',
    '',
    // Codex wave-8 review: statements, past tense and requests whose main verb is not the delete
    '브랜치 삭제했어',
    '브랜치 정리 완료',
    '브랜치 삭제 로그를 요약해줘',
    '브랜치 삭제 기록 보여줘',
    '브랜치 정리했음',
    '브랜치 지웠어',
    '브랜치 삭제 완료됐어',
    '브랜치 정리 관련 문서 작성해줘',
    'branch deleted',
  ])('%s → not a delete request', (text) => {
    expect(detectGitBranchDeleteRequest(text)).toBe(false);
  });
});

describe('detectGitBranchCommand — no collision with other flows', () => {
  it.each([
    '브랜치 정리해줘',
    '브랜치 삭제해줘',
    '로컬 브랜치 지워줘',
    '머지된 브랜치 정리해줘',
    'delete the branch',
    'clean up branch',
    '원격 브랜치 삭제해줘',
    '브랜치 알려줘',
    '지금 브랜치 뭐야',
    'what branch am I on',
    '커밋해줘',
    '푸시해줘',
    'git 상태 보여줘',
    '파일을 수정해줘 packages/core/src/a.ts',
    '안녕하세요',
    '',
    '   ',
  ])('%s → null', (text) => {
    expect(detectGitBranchCommand(text)).toBeNull();
  });

  it('questions and long free text about branches are not commands', () => {
    expect(detectGitBranchCommand('브랜치 만들면 어떻게 돼?')).toBeNull();
    expect(detectGitBranchCommand('브랜치를 만들고 푸시하면 어떻게 되나요?')).toBeNull();
    expect(detectGitBranchCommand(`새 브랜치 ${'x'.repeat(400)}`)).toBeNull();
    expect(detectGitBranchCommand('이 코드에서 브랜치를 만들어서 처리하는 로직을 추가해줘 packages/core/src/a.ts')).toBeNull();
  });
});

// ── handler ─────────────────────────────────────────────────────────────────────────────────────────────

const WORKSPACE = { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' } as WorkspaceRef;
const SESSION: Session = {
  id: 'sess-1',
  actorId: 'actor-1',
  context: { platform: 'test', channelId: 'c1', userId: 'u1' },
  status: SessionStatus.ACTIVE,
  createdAt: '2026-10-02T09:00:00.000Z',
  lastActivityAt: '2026-10-02T09:00:00.000Z',
};
const ACTOR: Actor = { id: 'actor-1', displayName: 'Owner', identities: [], createdAt: '2026-10-02T09:00:00.000Z' };
const HEAD = 'a'.repeat(40);

interface GitScript {
  info?: Partial<RepositoryInfo> | 'throw';
  status?: Partial<GitStatus> | 'throw';
  refs?: Record<string, string>;
  createResult?: GitBranchResult | 'throw';
  switchResult?: GitBranchResult | 'throw';
}

function fakeGit(script: GitScript = {}) {
  const calls: string[] = [];
  const created: Array<{ rootPath: string; branch: string; sha: string }> = [];
  const switched: Array<{ rootPath: string; branch: string }> = [];
  const git: GitBranchTurnHandlerGit = {
    async info(rootPath) {
      calls.push('info');
      if (script.info === 'throw') throw new Error('info failed');
      return { isRepository: true, rootPath, branch: 'main', headSha: HEAD, detached: false, ...script.info };
    },
    async status() {
      calls.push('status');
      if (script.status === 'throw') throw new Error('status failed');
      return { clean: true, branch: 'main', staged: [], unstaged: [], untracked: [], ...script.status };
    },
    async getLocalRefCommit(_root, branch) {
      calls.push(`ref:${branch}`);
      const hash = script.refs?.[branch];
      return hash ? { commitHash: hash } : null;
    },
    async createBranch(rootPath, branch, sha) {
      calls.push('createBranch');
      created.push({ rootPath, branch, sha });
      if (script.createResult === 'throw') throw new Error('create failed');
      return script.createResult ?? { branch, headSha: sha, created: true };
    },
    async switchBranch(rootPath, branch) {
      calls.push('switchBranch');
      switched.push({ rootPath, branch });
      if (script.switchResult === 'throw') throw new Error('switch failed');
      return script.switchResult ?? { branch, headSha: HEAD, created: false };
    },
  };
  return { git, calls, created, switched };
}

function ctxOf(
  text: string,
  anchor: { status: string; workspaceRef?: WorkspaceRef } | null = null,
  workspace: WorkspaceRef | null = WORKSPACE,
): { ctx: TurnHandlerContext; resolved: { count: number } } {
  const resolved = { count: 0 };
  const ctx: TurnHandlerContext = {
    message: { id: 'm1', context: SESSION.context, text, receivedAt: '2026-10-02T09:00:00.000Z' },
    session: SESSION,
    actor: ACTOR,
    now: '2026-10-02T09:00:00.000Z',
    applyAnchor: anchor,
    async resolveActiveWorkspace() {
      resolved.count++;
      return workspace;
    },
  };
  return { ctx, resolved };
}

describe('GitBranchTurnHandler — registration shape', () => {
  it('is a post-anchor handler at order 100 with one bounded help line', () => {
    const handler = new GitBranchTurnHandler({ git: fakeGit().git });
    expect(handler.id).toBe(GIT_BRANCH_TURN_HANDLER_ID);
    expect(handler.stage).toBe('post-anchor');
    expect(handler.order).toBe(100);
    expect(handler.helpLines).toEqual([GIT_BRANCH_HELP_LINE]);
    expect([...GIT_BRANCH_HELP_LINE].length).toBeLessThanOrEqual(MAX_CONTRIBUTED_HELP_LINE_CHARS);
  });

  it('returns null and calls nothing for a non-branch turn', async () => {
    const { git, calls } = fakeGit();
    const { ctx, resolved } = ctxOf('안녕하세요');
    expect(await new GitBranchTurnHandler({ git }).handle(ctx)).toBeNull();
    expect(calls).toEqual([]);
    expect(resolved.count).toBe(0);
  });

  it.each([null, { status: 'WORKSPACE_APPLIED' }, { status: 'PR_MERGED' }])(
    'answers a branch delete request with the fixed refusal and no git call (anchor %j)',
    async (anchor) => {
      const { git, calls } = fakeGit();
      const { ctx, resolved } = ctxOf('브랜치 삭제해줘 feature/x', anchor);
      const out = await new GitBranchTurnHandler({ git }).handle(ctx);
      expect(out?.reply.text).toBe(gitBranchReplies.deleteUnsupported());
      expect(out?.status).toBeUndefined();
      expect(calls).toEqual([]);
      expect(resolved.count).toBe(0);
    },
  );

  it.each(['MAIN_SYNCED', 'BRANCH_CLEANED', 'REMOTE_BRANCH_CLEANUP_APPROVED', 'REMOTE_BRANCH_CLEANED'])(
    'leaves the post-merge cleanup phrase to the runtime cleanup flow at %s',
    async (status) => {
      const { git, calls } = fakeGit();
      expect(await new GitBranchTurnHandler({ git }).handle(ctxOf('브랜치 정리해줘', { status }).ctx)).toBeNull();
      expect(calls).toEqual([]);
    },
  );

  it.each(['브랜치 목록 보여줘', '브랜치 삭제는 어떻게 해?', '지금 브랜치 뭐야'])('keeps "%s" routing to the classifier', async (text) => {
    const { git, calls } = fakeGit();
    expect(await new GitBranchTurnHandler({ git }).handle(ctxOf(text).ctx)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('GitBranchTurnHandler — create', () => {
  it('with no anchor creates exactly once from the read HEAD sha in the active workspace', async () => {
    const { git, calls, created } = fakeGit();
    const { ctx, resolved } = ctxOf('브랜치 만들어줘 feature/x');
    const out = await new GitBranchTurnHandler({ git }).handle(ctx);
    expect(created).toEqual([{ rootPath: '/repo', branch: 'feature/x', sha: HEAD }]);
    expect(calls.filter((c) => c === 'createBranch')).toHaveLength(1);
    expect(calls).not.toContain('switchBranch');
    expect(resolved.count).toBe(1);
    expect(out?.status).toBeUndefined();
    expect(out?.reply.text).toBe(
      gitBranchReplies.created('main', { branch: 'feature/x', headSha: HEAD, created: true }),
    );
    expect(out?.reply.text).toContain('main → feature/x (HEAD aaaaaaa)');
    expect(out?.reply.text).toContain('원격에는 아무것도 보내지 않았어요');
    expect(out?.reply.context).toEqual(SESSION.context);
  });

  it.each(['ELIGIBLE', 'APPROVED', 'PATCH_READY', 'WORKSPACE_APPLIED'])('is allowed at anchor %s and uses the anchor workspace', async (status) => {
    const anchorWs = { id: 'ws-anchor', rootPath: '/anchor-repo', kind: 'local-clone' } as WorkspaceRef;
    const { git, created } = fakeGit({ status: { clean: false, unstaged: ['a.ts'] } });
    const { ctx, resolved } = ctxOf('브랜치 만들어줘 feature/x', { status, workspaceRef: anchorWs });
    const out = await new GitBranchTurnHandler({ git }).handle(ctx);
    expect(created).toEqual([{ rootPath: '/anchor-repo', branch: 'feature/x', sha: HEAD }]);
    expect(resolved.count).toBe(0);
    expect(out?.reply.text).toContain('새 브랜치를 만들고 전환했어요');
  });

  it.each(['COMMIT_APPROVED', 'GIT_COMMITTED', 'GIT_PUSHED', 'PR_CREATED', 'PR_MERGED', 'MAIN_SYNCED', 'BRANCH_CLEANED', 'SOMETHING_NEW'])(
    'is refused at anchor %s without any git call',
    async (status) => {
      const { git, calls } = fakeGit();
      const { ctx } = ctxOf('브랜치 만들어줘 feature/x', { status, workspaceRef: WORKSPACE });
      const out = await new GitBranchTurnHandler({ git }).handle(ctx);
      expect(calls).toEqual([]);
      expect(out?.reply.text).toBe(gitBranchReplies.refused('create-flow-active', 'feature/x'));
    },
  );

  it('refuses an existing branch without creating', async () => {
    const { git, created } = fakeGit({ refs: { 'feature/x': 'b'.repeat(40) } });
    const out = await new GitBranchTurnHandler({ git }).handle(ctxOf('브랜치 만들어줘 feature/x').ctx);
    expect(created).toEqual([]);
    expect(out?.reply.text).toBe(gitBranchReplies.refused('branch-exists', 'feature/x'));
  });

  it('refuses on a detached HEAD, an unborn repository, a non-repository and unmerged paths', async () => {
    const run = async (script: GitScript) => {
      const { git, created } = fakeGit(script);
      const out = await new GitBranchTurnHandler({ git }).handle(ctxOf('브랜치 만들어줘 feature/x').ctx);
      expect(created).toEqual([]);
      return out?.reply.text;
    };
    expect(await run({ info: { detached: true, branch: '' } })).toBe(gitBranchReplies.refused('detached-head', 'feature/x'));
    expect(await run({ info: { headSha: undefined } })).toBe(gitBranchReplies.refused('unborn-repository', 'feature/x'));
    expect(await run({ info: { isRepository: false } })).toBe(gitBranchReplies.refused('not-a-repository', 'feature/x'));
    expect(await run({ status: { hasUnmergedPaths: true, clean: false } })).toBe(gitBranchReplies.refused('operation-in-progress', 'feature/x'));
  });

  it('is allowed with a dirty tree (the changes travel with the new branch)', async () => {
    const { git, created } = fakeGit({ status: { clean: false, unstaged: ['a.ts'], untracked: ['b.ts'] } });
    await new GitBranchTurnHandler({ git }).handle(ctxOf('브랜치 만들어줘 feature/x').ctx);
    expect(created).toHaveLength(1);
  });
});

describe('GitBranchTurnHandler — switch', () => {
  it('switches to an existing local branch on a clean tree', async () => {
    const { git, switched, created } = fakeGit({ refs: { 'feature/x': 'b'.repeat(40) } });
    const out = await new GitBranchTurnHandler({ git }).handle(ctxOf('feature/x 브랜치로 전환해줘').ctx);
    expect(switched).toEqual([{ rootPath: '/repo', branch: 'feature/x' }]);
    expect(created).toEqual([]);
    expect(out?.reply.text).toContain('브랜치를 전환했어요');
    expect(out?.reply.text).toContain('main → feature/x');
  });

  it.each(['ELIGIBLE', 'APPROVED'])('is allowed at anchor %s', async (status) => {
    const { git, switched } = fakeGit({ refs: { 'feature/x': 'b'.repeat(40) } });
    await new GitBranchTurnHandler({ git }).handle(ctxOf('feature/x 브랜치로 전환해줘', { status, workspaceRef: WORKSPACE }).ctx);
    expect(switched).toHaveLength(1);
  });

  it.each(['PATCH_READY', 'WORKSPACE_APPLIED'])('is refused at anchor %s without any git call', async (status) => {
    const { git, calls } = fakeGit({ refs: { 'feature/x': 'b'.repeat(40) } });
    const out = await new GitBranchTurnHandler({ git }).handle(
      ctxOf('feature/x 브랜치로 전환해줘', { status, workspaceRef: WORKSPACE }).ctx,
    );
    expect(calls).toEqual([]);
    expect(out?.reply.text).toBe(gitBranchReplies.refused('switch-pending-change', 'feature/x'));
  });

  it.each(['COMMIT_APPROVED', 'GIT_COMMITTED'])('is refused at anchor %s', async (status) => {
    const { git, calls } = fakeGit();
    const out = await new GitBranchTurnHandler({ git }).handle(
      ctxOf('feature/x 브랜치로 전환해줘', { status, workspaceRef: WORKSPACE }).ctx,
    );
    expect(calls).toEqual([]);
    expect(out?.reply.text).toBe(gitBranchReplies.refused('create-flow-active', 'feature/x'));
  });

  it.each([
    ['unstaged', { unstaged: ['a.ts'] }],
    ['staged', { staged: ['a.ts'] }],
    ['untracked', { untracked: ['a.ts'] }],
  ])('refuses a dirty tree (%s) without switching', async (_label, dirt) => {
    const { git, switched } = fakeGit({ refs: { 'feature/x': 'b'.repeat(40) }, status: { clean: false, ...dirt } });
    const out = await new GitBranchTurnHandler({ git }).handle(ctxOf('feature/x 브랜치로 전환해줘').ctx);
    expect(switched).toEqual([]);
    expect(out?.reply.text).toBe(gitBranchReplies.refused('dirty-tree', 'feature/x'));
  });

  it('refuses a missing local branch and reports an already-current branch without switching', async () => {
    const missing = fakeGit();
    const out = await new GitBranchTurnHandler({ git: missing.git }).handle(ctxOf('feature/x 브랜치로 전환해줘').ctx);
    expect(missing.switched).toEqual([]);
    expect(out?.reply.text).toBe(gitBranchReplies.refused('branch-missing', 'feature/x'));

    const current = fakeGit({ info: { branch: 'feature/x' }, refs: { 'feature/x': HEAD } });
    const same = await new GitBranchTurnHandler({ git: current.git }).handle(ctxOf('feature/x 브랜치로 전환해줘').ctx);
    expect(current.switched).toEqual([]);
    expect(same?.reply.text).toBe(gitBranchReplies.refused('already-current', 'feature/x'));
  });
});

describe('GitBranchTurnHandler — refusals that need no git or workspace', () => {
  it.each(['main', 'master', 'Main', 'MASTER'])('refuses the protected name %s for create and switch', async (name) => {
    const { git, calls } = fakeGit({ refs: { main: HEAD, master: HEAD } });
    const handler = new GitBranchTurnHandler({ git });
    const createOut = await handler.handle(ctxOf(`브랜치 만들어줘 ${name}`).ctx);
    const switchOut = await handler.handle(ctxOf(`${name} 브랜치로 전환해줘`).ctx);
    expect(calls).toEqual([]);
    expect(createOut?.reply.text).toBe(gitBranchReplies.refused('protected-name', name));
    expect(switchOut?.reply.text).toBe(gitBranchReplies.refused('protected-name', name));
  });

  it.each(['refs/heads/x', 'a..b', '한글', 'featé', 'HEAD', '.hidden', 'x'.repeat(101)])('refuses the invalid name %s', async (name) => {
    const { git, calls } = fakeGit();
    const out = await new GitBranchTurnHandler({ git }).handle(ctxOf(`브랜치 만들어줘 ${name}`).ctx);
    expect(calls).toEqual([]);
    expect(out?.reply.text).toBe(gitBranchReplies.refused('invalid-name', name));
  });

  it('answers unsupported and usage with fixed copy and no git call', async () => {
    const { git, calls } = fakeGit();
    const handler = new GitBranchTurnHandler({ git });
    const unsupported = await handler.handle(ctxOf('브랜치 만들고 push 해줘').ctx);
    const usage = await handler.handle(ctxOf('브랜치 만들어줘').ctx);
    expect(calls).toEqual([]);
    expect(unsupported?.reply.text).toBe(gitBranchReplies.unsupported());
    expect(usage?.reply.text).toBe(gitBranchReplies.usage('create'));
  });

  it('replies "register a project first" with no project and makes no git call', async () => {
    const { git, calls } = fakeGit();
    const { ctx, resolved } = ctxOf('브랜치 만들어줘 feature/x', null, null);
    const out = await new GitBranchTurnHandler({ git }).handle(ctx);
    expect(resolved.count).toBe(1);
    expect(calls).toEqual([]);
    expect(out?.reply.text).toBe(gitBranchReplies.noProject());
    expect(out?.reply.text).toContain('프로젝트를 등록해 주세요');
  });

  it('falls back to the active workspace when the anchor carries none', async () => {
    const { git, created } = fakeGit();
    const { ctx, resolved } = ctxOf('브랜치 만들어줘 feature/x', { status: 'ELIGIBLE' });
    await new GitBranchTurnHandler({ git }).handle(ctx);
    expect(resolved.count).toBe(1);
    expect(created).toHaveLength(1);
  });
});

describe('GitBranchTurnHandler — failures', () => {
  it('a preflight read failure is a FAILED reply, never a leaked exception or an error detail', async () => {
    const { git, created } = fakeGit({ info: 'throw' });
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const logger = { info() {}, error() {}, warn: (_m: string, f?: Record<string, unknown>) => void warnings.push(f) };
    const out = await new GitBranchTurnHandler({ git, logger }).handle(ctxOf('브랜치 만들어줘 feature/x').ctx);
    expect(created).toEqual([]);
    expect(out?.status).toBe('FAILED');
    expect(out?.reply.text).toBe(gitBranchReplies.failed('create'));
    expect(out?.reply.text).not.toContain('info failed');
    expect(warnings[0]).toMatchObject({ action: 'create', stage: 'preflight', errorName: 'Error' });
  });

  it('a failing create or switch is FAILED and does not claim either outcome', async () => {
    const c = fakeGit({ createResult: 'throw' });
    const created = await new GitBranchTurnHandler({ git: c.git }).handle(ctxOf('브랜치 만들어줘 feature/x').ctx);
    expect(created?.status).toBe('FAILED');
    expect(created?.reply.text).toContain('못했거나 결과를 확인하지 못했어요');
    expect(created?.reply.text).not.toContain('만들고 전환했어요');

    const s = fakeGit({ refs: { 'feature/x': HEAD }, switchResult: 'throw' });
    const switched = await new GitBranchTurnHandler({ git: s.git }).handle(ctxOf('feature/x 브랜치로 전환해줘').ctx);
    expect(switched?.status).toBe('FAILED');
    expect(switched?.reply.text).not.toContain('전환했어요');
  });
});

describe('gitBranchReplies', () => {
  it('never claims a push, a remote ref or a commit happened, and never leaks a path', () => {
    const texts = [
      gitBranchReplies.created('main', { branch: 'feature/x', headSha: HEAD, created: true }),
      gitBranchReplies.switched('main', { branch: 'feature/x', headSha: HEAD, created: false }),
      gitBranchReplies.unsupported(),
      gitBranchReplies.noProject(),
    ];
    for (const text of texts) {
      expect(text).not.toContain('/repo');
      expect(text).not.toMatch(/푸시했어요|커밋했어요|pushed|committed/i);
    }
  });
});

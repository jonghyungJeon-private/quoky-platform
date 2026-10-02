import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import {
  ApprovalStatus,
  CodeGenerationStatus,
  ConversationRuntime,
  PatchStatus,
  ResponseComposer,
  SessionStatus,
  WorkspaceChangeStatus,
  WorkspaceWriteManager,
} from '@quoky/core';
import type {
  Actor,
  ApplyPreviewAnchor,
  ConversationContext,
  ConversationRuntimeDeps,
  InboundMessage,
  PatchSet,
  Session,
  StorageProvider,
  WorkspaceChange,
  WorkspaceRef,
} from '@quoky/core';
import { LocalWorkspaceWriter } from './index';

/**
 * Gate 5 — the ONE connected, isolated E2E of the real workspace-apply boundary (CA integration
 * requirement). Unlike the two half-tests it supersedes (ConversationRuntime with a recording
 * `workspaceApply` fake; `LocalWorkspaceWriter` standalone), this drives a SINGLE real chain end to end:
 *
 *     REAL ConversationRuntime.handle('패치 적용해줘')
 *       → REAL WorkspaceWriteManager.apply(...)
 *         → REAL LocalWorkspaceWriter.applyOperation(...)
 *           → a real, disposable, ephemeral git repository (never the product repo, never quoky-uat-sandbox).
 *
 * Fixture: `gate5/apply-smoke.txt`, an EXISTING committed file, updated by a single `update` PatchOperation
 * (`marker: PENDING` → `marker: quoky-gate5-workspace-apply`). Proves: apply BEFORE approval writes nothing;
 * a PATCH_READY apply produces a byte-exact, file-only mutation with WORKSPACE_APPLIED re-anchoring and NO
 * git/command mutation by the bot; and a harness-side one-file rollback restores the exact baseline.
 *
 * Test-only. Mutates no production file, runs no live Discord, commits/pushes nothing.
 */

const GATE5_PATH = 'gate5/apply-smoke.txt';
const BASELINE = 'gate5 apply smoke\nmarker: PENDING\n';
const APPLIED = 'gate5 apply smoke\nmarker: quoky-gate5-workspace-apply\n';
const TS = '2026-07-11T00:00:00.000Z';
const CTX: ConversationContext = { platform: 'test', channelId: 'gate5-ch', userId: 'gate5-user' };
const ACTOR = { id: 'gate5-actor' } as Actor;
const SESSION: Session = {
  id: 'gate5-sess',
  actorId: 'gate5-actor',
  context: CTX,
  status: SessionStatus.ACTIVE,
  activeProjectId: 'gate5-proj',
  createdAt: TS,
  lastActivityAt: TS,
};

const messageOf = (text: string): InboundMessage => ({ id: 'm-gate5', context: CTX, text, receivedAt: TS });

// ── HARNESS git helpers (test setup / inspection / rollback ONLY) ─────────────────────────────────
// These are the OPERATOR's git commands (init/config/add/commit/status/rev-parse/checkout). They are NOT
// the bot: the ConversationRuntime → WorkspaceWriteManager → LocalWorkspaceWriter chain performs NO git.
const created: string[] = [];
afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Run HARNESS git in an isolated repo (ignore the developer's global/system git config). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

/** A dedicated disposable Gate 5 repo: git-init, seed the fixture at BASELINE, one baseline commit. */
function disposableGate5Repo(): WorkspaceRef {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-gate5-int-'));
  created.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'gate5@quoky.test');
  git(dir, 'config', 'user.name', 'gate5');
  git(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'gate5'), { recursive: true });
  writeFileSync(join(dir, GATE5_PATH), BASELINE);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'gate5 baseline');
  return { id: 'gate5-ws', rootPath: dir, kind: 'local-clone' };
}

/** `git status --porcelain` lines. `git()` trims the whole blob, so a single unstaged modify reads
 *  `M <path>` (leading porcelain space stripped) — matching the standalone Gate 5 writer test. */
function statusLines(dir: string): string[] {
  return git(dir, 'status', '--porcelain').split('\n').filter(Boolean);
}

/** The exact unified diff the real writer applies via `applyPatch` — BASELINE → APPLIED. */
function updateDiff(): string {
  return createTwoFilesPatch(GATE5_PATH, GATE5_PATH, BASELINE, APPLIED, '', '');
}

/** An apply-preview anchor pointing at the ephemeral repo. `PATCH_READY` (apply) carries a GENERATED
 *  patchRef; `ELIGIBLE` (before-approval) carries neither patchRef nor approvalId. */
function gate5Anchor(status: 'ELIGIBLE' | 'PATCH_READY', ref: WorkspaceRef): ApplyPreviewAnchor {
  const base: ApplyPreviewAnchor = {
    kind: 'code-preview-apply',
    status,
    executionPlanRef: { id: 'plan-1', goal: 'gate5 apply' },
    workspaceRef: ref,
    targetFiles: [GATE5_PATH],
    codeGenerationRef: { id: 'gen-1', status: CodeGenerationStatus.SUCCEEDED },
    codeProposalRef: { id: 'prop-1' },
    instruction: 'gate5 마커를 적용해줘',
    createdAt: TS,
  };
  if (status === 'PATCH_READY') {
    return { ...base, approvalId: 'apply-appr-1', patchRef: { id: 'patch-1', status: PatchStatus.GENERATED } };
  }
  return base;
}

/** The GENERATED single-`update` PatchSet `patch.get` returns — id/approvalRef/executionPlanRef/op-path all
 *  align with the PATCH_READY anchor so the runtime's pre-write integrity gate passes. */
function gate5PatchSet(): PatchSet {
  return {
    id: 'patch-1',
    executionPlanRef: { id: 'plan-1', goal: 'gate5 apply' },
    approvalRef: {
      id: 'apply-appr-1',
      status: ApprovalStatus.APPROVED,
      executionPlanRef: { id: 'plan-1', goal: 'gate5 apply' },
    },
    operations: [{ path: GATE5_PATH, operation: 'update', diff: updateDiff() }],
    status: PatchStatus.GENERATED,
    createdAt: TS,
  };
}

/** In-memory `StorageProvider.workspaceChanges` (get/save/delete/list/findByPatchSet over a Map) — the same
 *  shape the core `workspace-write-manager.test.ts` harness builds, so the REAL manager persists normally. */
function memoryStorage(): StorageProvider {
  const rows = new Map<string, WorkspaceChange>();
  return {
    workspaceChanges: {
      async get(id: string) {
        return rows.get(id) ?? null;
      },
      async save(c: WorkspaceChange) {
        rows.set(c.id, c);
        return c;
      },
      async delete(id: string) {
        rows.delete(id);
      },
      async list() {
        return [...rows.values()];
      },
      async findByPatchSet(patchSetId: string) {
        return [...rows.values()].filter((c) => c.patchRef.id === patchSetId);
      },
    },
  } as unknown as StorageProvider;
}

/** BOT capability ports that the apply path must NEVER touch — the command runner + every GitManager port
 *  (read AND mutation) + the hosting createPR. Each is a recording spy that also THROWS if invoked, so a
 *  stray call fails loudly; every count is asserted 0 below. These are the BOT's ports — distinct from the
 *  HARNESS git() helper above. */
function botPorts() {
  const never = (name: string) => vi.fn(async () => { throw new Error(`BOT ${name} must not run on the apply path`); });
  return {
    commandRun: never('command.run'),
    gitStatus: never('git.status'), // git READ ports
    gitDiff: never('git.diff'),
    gitInfo: never('git.info'),
    gitCommit: never('git.commitFiles'), // git MUTATION ports
    gitPush: never('git.pushApprovedCommit'),
    gitSyncMain: never('git.syncMain'),
    gitDeleteBranch: never('git.deleteMergedLocalBranch'),
    createPr: never('repositoryHosting.createPullRequest'),
  };
}
type BotPorts = ReturnType<typeof botPorts>;

/** Assert the bot performed NO command execution and NO git/hosting operation of any kind. */
function expectNoBotSideEffects(ports: BotPorts): void {
  // command runner
  expect(ports.commandRun).toHaveBeenCalledTimes(0);
  // git READ ports
  expect(ports.gitStatus).toHaveBeenCalledTimes(0);
  expect(ports.gitDiff).toHaveBeenCalledTimes(0);
  expect(ports.gitInfo).toHaveBeenCalledTimes(0);
  // git MUTATION ports
  expect(ports.gitCommit).toHaveBeenCalledTimes(0);
  expect(ports.gitPush).toHaveBeenCalledTimes(0);
  expect(ports.gitSyncMain).toHaveBeenCalledTimes(0);
  expect(ports.gitDeleteBranch).toHaveBeenCalledTimes(0);
  expect(ports.createPr).toHaveBeenCalledTimes(0);
}

/**
 * Build a minimal-but-complete `ConversationRuntimeDeps`. Only the apply path (Sprint 2u) is exercised, so
 * exactly those collaborators are real/recording; every OTHER field is a throwing stub that fails loudly if
 * the path ever reaches it. (This reproduces only the relevant subset of the core test's `makeDeps` — the
 * apply-path deps — rather than copying all of it.)
 */
function buildDeps(
  anchor: ApplyPreviewAnchor,
  manager: WorkspaceWriteManager,
  ports: BotPorts,
): { deps: ConversationRuntimeDeps; recorded: { reanchor?: ApplyPreviewAnchor } } {
  const recorded: { reanchor?: ApplyPreviewAnchor } = {};
  const bad = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected dep call on the apply path: ${name}`);
  };

  const deps = {
    // ── Entry collaborators the apply path actually calls ──
    actors: { async resolveFromContext() { return ACTOR; } },
    sessions: {
      async openForContext() { return SESSION; },
      async touch(s: Session) { return s; },
    },
    memory: {
      async recordShortTerm() { return { id: 'mem-gate5' }; },
      async recordAssistant() { return undefined; },
      async recordToolMemory() { return undefined; },
    },
    // Neither pending approval nor scope clarification → routing reaches the apply branch.
    approvalFlow: {
      async findPending() { return null; },
      anchor: bad('approvalFlow.anchor'),
      reconstructResume: bad('approvalFlow.reconstructResume'),
    },
    scopeClarificationFlow: {
      async findPending() { return null; },
      anchor: bad('scopeClarificationFlow.anchor'),
      clear: bad('scopeClarificationFlow.clear'),
    },
    applyPreviewFlow: {
      async findAnchor() { return anchor; },
      async anchor(_session: Session, next: ApplyPreviewAnchor) { recorded.reanchor = next; },
      clear: bad('applyPreviewFlow.clear'),
    },
    patch: {
      generate: bad('patch.generate'),
      async get() { return gate5PatchSet(); },
    },
    // THE POINT OF THIS TEST: the REAL WorkspaceWriteManager (→ REAL LocalWorkspaceWriter → real fs).
    workspaceWrite: manager,
    composer: new ResponseComposer(),

    // ── BOT ports the apply path must NOT touch (recording; asserted 0) ──
    command: { run: ports.commandRun },
    git: {
      status: ports.gitStatus,
      diff: ports.gitDiff,
      info: ports.gitInfo,
      commitFiles: ports.gitCommit,
      pushApprovedCommit: ports.gitPush,
      syncMain: ports.gitSyncMain,
      deleteMergedLocalBranch: ports.gitDeleteBranch,
    },
    repositoryHosting: {
      identity: { provider: 'github', owner: 'quoky', repo: 'gate5' },
      manager: {
        createPullRequest: ports.createPr,
        getPullRequestStatus: bad('repositoryHosting.getPullRequestStatus'),
      },
    },

    // ── Every remaining dep: throwing stub (never reached on the apply path) ──
    classifier: { classify: bad('classifier.classify') },
    projects: { register: bad('projects.register'), get: bad('projects.get') },
    analyzer: { prepare: bad('analyzer.prepare') },
    tasks: {
      createTask: bad('tasks.createTask'),
      transition: bad('tasks.transition'),
      startRun: bad('tasks.startRun'),
      completeRun: bad('tasks.completeRun'),
      failRun: bad('tasks.failRun'),
    },
    workspace: {
      prepare: bad('workspace.prepare'),
      open: bad('workspace.open'),
      list: bad('workspace.list'),
      diff: bad('workspace.diff'),
      read: bad('workspace.read'),
    },
    commandExecutions: { get: bad('commandExecutions.get') },
    contextBuilder: { build: bad('contextBuilder.build') },
    promptComposer: { compose: () => { throw new Error('unexpected dep call: promptComposer.compose'); } },
    promptRenderer: { render: () => { throw new Error('unexpected dep call: promptRenderer.render'); } },
    router: { select: bad('router.select') },
    artifacts: { persistAll: bad('artifacts.persistAll') },
    risk: { requiresApproval: () => { throw new Error('unexpected dep call: risk.requiresApproval'); } },
    intentResolver: {
      resolve: () => { throw new Error('unexpected dep call: intentResolver.resolve'); },
      isExecution: () => { throw new Error('unexpected dep call: intentResolver.isExecution'); },
    },
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') },
    approvals: {
      decide: bad('approvals.decide'),
      get: bad('approvals.get'),
      requestForRisk: bad('approvals.requestForRisk'),
    },
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('codeGeneration.getProposal') },
    codeProposals: { get: bad('codeProposals.get') },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as unknown as ConversationRuntimeDeps;

  return { deps, recorded };
}

describe('Gate 5 — integrated ConversationRuntime → WorkspaceWriteManager → LocalWorkspaceWriter E2E', () => {
  it('apply requested BEFORE approval (ELIGIBLE anchor) → no write reaches the real fs', async () => {
    const ref = disposableGate5Repo();
    const baselineHead = git(ref.rootPath, 'rev-parse', 'HEAD'); // HARNESS
    const writer = new LocalWorkspaceWriter();
    const opSpy = vi.spyOn(writer, 'applyOperation');
    const manager = new WorkspaceWriteManager(memoryStorage(), writer);
    const applySpy = vi.spyOn(manager, 'apply');
    const ports = botPorts();
    const { deps, recorded } = buildDeps(gate5Anchor('ELIGIBLE', ref), manager, ports);

    const result = await new ConversationRuntime(deps).handle(messageOf('패치 적용해줘'));

    // The runtime answered (apply-unavailable), but NOTHING mutated: manager/writer never invoked …
    expect(result.status).toBe('RESPONDED');
    expect(applySpy).toHaveBeenCalledTimes(0);
    expect(opSpy).toHaveBeenCalledTimes(0);
    expect(recorded.reanchor).toBeUndefined(); // no WORKSPACE_APPLIED re-anchor
    // … the real fs is untouched (still PENDING), the working tree is clean, HEAD unchanged …
    expect(readFileSync(join(ref.rootPath, GATE5_PATH), 'utf8')).toBe(BASELINE);
    expect(statusLines(ref.rootPath)).toEqual([]);
    expect(git(ref.rootPath, 'rev-parse', 'HEAD')).toBe(baselineHead); // HARNESS
    // … and the bot performed no command/git/hosting side effect.
    expectNoBotSideEffects(ports);
  });

  it('PATCH_READY apply → real single-`update` mutation (byte-exact, file-only), then a one-file rollback restores baseline', async () => {
    const ref = disposableGate5Repo();
    const baselineHead = git(ref.rootPath, 'rev-parse', 'HEAD'); // HARNESS

    // Baseline: clean tree, fixture at PENDING.
    expect(statusLines(ref.rootPath)).toEqual([]); // HARNESS inspection
    expect(readFileSync(join(ref.rootPath, GATE5_PATH), 'utf8')).toBe(BASELINE);

    // REAL writer + REAL manager, each spied (calls-through preserved).
    const writer = new LocalWorkspaceWriter();
    const opSpy = vi.spyOn(writer, 'applyOperation'); // REAL LocalWorkspaceWriter.applyOperation
    const manager = new WorkspaceWriteManager(memoryStorage(), writer);
    const applySpy = vi.spyOn(manager, 'apply'); // REAL WorkspaceWriteManager.apply
    const ports = botPorts();
    const { deps, recorded } = buildDeps(gate5Anchor('PATCH_READY', ref), manager, ports);

    // ── THE CONNECTED APPLY — one runtime turn drives the whole real chain ──
    const result = await new ConversationRuntime(deps).handle(messageOf('패치 적용해줘'));
    expect(result.status).toBe('RESPONDED');

    // The real chain ran exactly once at each hop.
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(opSpy).toHaveBeenCalledTimes(1);

    // The operation the runtime handed the REAL writer: single `update` on the exact fixture path,
    // against the ephemeral repo (never product / sandbox).
    const [passedRef, passedOp] = opSpy.mock.calls[0]!;
    expect(passedOp.operation).toBe('update');
    expect(passedOp.path).toBe(GATE5_PATH);
    expect(passedRef.rootPath).toBe(ref.rootPath);

    // The WorkspaceChange the REAL manager returned is APPLIED.
    const change = (await applySpy.mock.results[0]!.value) as WorkspaceChange;
    expect(change.status).toBe(WorkspaceChangeStatus.APPLIED);

    // The runtime re-anchored WORKSPACE_APPLIED, carrying the APPLIED WorkspaceChangeRef.
    expect(recorded.reanchor?.status).toBe('WORKSPACE_APPLIED');
    expect(recorded.reanchor?.workspaceChangeRef?.status).toBe(WorkspaceChangeStatus.APPLIED);

    // Real filesystem: byte-exact applied content …
    expect(readFileSync(join(ref.rootPath, GATE5_PATH), 'utf8')).toBe(APPLIED);
    // … exactly ONE modified path, nothing added/deleted/renamed …
    const lines = statusLines(ref.rootPath); // HARNESS inspection
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^M\s+gate5\/apply-smoke\.txt$/);
    // … and the bot committed NOTHING (HEAD still the baseline commit).
    expect(git(ref.rootPath, 'rev-parse', 'HEAD')).toBe(baselineHead); // HARNESS

    // The bot performed no command execution and no git/hosting operation of any kind.
    expectNoBotSideEffects(ports);

    // ── ROLLBACK — HARNESS-side only (the bot never touches git). Restore the single file. ──
    git(ref.rootPath, 'checkout', '--', GATE5_PATH); // HARNESS
    expect(statusLines(ref.rootPath)).toEqual([]); // clean again
    expect(git(ref.rootPath, 'rev-parse', 'HEAD')).toBe(baselineHead); // HEAD unchanged
    expect(readFileSync(join(ref.rootPath, GATE5_PATH), 'utf8')).toBe(BASELINE); // baseline restored byte-exact
  });

  it('the disposable repo is neither the product repo nor the UAT sandbox', () => {
    const ref = disposableGate5Repo();
    expect(ref.rootPath.startsWith(tmpdir())).toBe(true);
    expect(ref.rootPath).toContain('quoky-gate5-int-');
    expect(ref.rootPath).not.toContain('quoky-platform');
    expect(ref.rootPath).not.toContain('quoky-uat-sandbox');
  });
});

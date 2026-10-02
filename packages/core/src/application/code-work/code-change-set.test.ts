import { describe, expect, it } from 'vitest';
import { ApprovalStatus, PatchStatus, WorkspaceChangeStatus } from '../../domain';
import type { FileDiff, GitStatus, PatchOperation, PatchSet, WorkspaceChange, WorkspaceDiff, WorkspaceRef } from '../../domain';
import { MAX_CODEGEN_CONTEXT_FILE_BYTES, MAX_CODEGEN_CONTEXT_TOTAL_BYTES } from '../code-generation-context';
import {
  MAX_CHANGE_SET_FILES,
  MAX_CHANGE_SET_FILE_BYTES,
  MAX_CHANGE_SET_TOTAL_BYTES,
  classifyUnverifiedChangeSet,
  collectCodeChangeTargets,
  firstUnsafeMentionedPath,
  isSingleUpdateChangeSet,
  newFileCommitCandidates,
  partitionCommitCandidates,
  targetExtractionText,
  validateChangeSetForApply,
  validatePatchableDiff,
  verifyAppliedChangeSet,
} from './code-change-set';
import type { ChangeSetApplyAnchor } from './code-change-set';

const WS: WorkspaceRef = { id: 'ws-1', projectId: 'p-1', rootPath: '/tmp/repo' } as WorkspaceRef;
const PLAN = { id: 'plan-1', goal: 'g' };

describe('change-set bounds (ADR-0099 D1)', () => {
  it('are 5 files, 64 KiB per file and 256 KiB per set — its own constants, not the context caps', () => {
    expect(MAX_CHANGE_SET_FILES).toBe(5);
    expect(MAX_CHANGE_SET_FILE_BYTES).toBe(64 * 1024);
    expect(MAX_CHANGE_SET_TOTAL_BYTES).toBe(256 * 1024);
    // Same numbers today, but independent symbols (ADR-0097 caps are owned by the OVR track).
    expect(MAX_CHANGE_SET_FILE_BYTES).toBe(MAX_CODEGEN_CONTEXT_FILE_BYTES);
    expect(MAX_CHANGE_SET_TOTAL_BYTES).toBe(MAX_CODEGEN_CONTEXT_TOTAL_BYTES);
  });
});

describe('targetExtractionText', () => {
  it('blanks URLs so a link is never a target path, keeping the rest of the text', () => {
    const text = 'see https://github.com/acme/repo/blob/main/src/a.ts and fix src/b.ts';
    const stripped = targetExtractionText(text);
    expect(stripped).not.toContain('github.com');
    expect(stripped).toContain('fix src/b.ts');
  });

  it('blanks fenced code blocks (closed and unterminated) — a pasted import is content, not a target', () => {
    const text = "src/app.ts 에 아래 코드를 추가해줘:\n```ts\nimport { helper } from './lib/helpers.js';\n```\n끝";
    const out = targetExtractionText(text);
    expect(out).toContain('src/app.ts');
    expect(out).not.toContain('lib/helpers.js');
    expect(out).toContain('끝');
    expect(targetExtractionText('src/a.ts 고쳐줘\n```\nsrc/b.ts')).not.toContain('src/b.ts');
  });
});

describe('firstUnsafeMentionedPath', () => {
  it.each([
    ['/etc/hosts.txt'],
    ['../outside/x.ts'],
    ['src/../../x.ts'],
    ['.github/workflows/ci.yml'],
    ['./.github/workflows/ci.yml'],
    ['~/notes/x.md'],
    ['C:/repo/x.ts'],
  ])('refuses %s', (token) => {
    expect(firstUnsafeMentionedPath(['src/app.ts', token])).toBe(token);
  });

  it('admits plain project-relative paths, including a plain ./ prefix', () => {
    expect(firstUnsafeMentionedPath(['src/app.ts', './src/b.ts', 'docs/a.b/c.md'])).toBeNull();
    expect(firstUnsafeMentionedPath([])).toBeNull();
  });

  it('ignores tokens that are not file-like: a slash command, a bare ../dir or ~/dir in prose', () => {
    expect(firstUnsafeMentionedPath(['/preview', 'src/target.ts'])).toBeNull();
    expect(firstUnsafeMentionedPath(['../utils', '~/notes'])).toBeNull();
    expect(firstUnsafeMentionedPath(['/etc/hosts'])).toBe('/etc/hosts');
  });
});

describe('collectCodeChangeTargets', () => {
  const existing = (paths: string[]) => {
    const looked: string[] = [];
    return {
      looked,
      resolveExisting: async (candidate: string) => {
        looked.push(candidate);
        return paths.includes(candidate) ? `./${candidate}` : null;
      },
    };
  };

  it('no candidate → none (nothing looked up)', async () => {
    const fs = existing([]);
    expect(await collectCodeChangeTargets({ candidates: [], resolveExisting: fs.resolveExisting, allowNewFiles: true })).toEqual({ kind: 'none' });
    expect(fs.looked).toEqual([]);
  });

  it('every existing path is an update target — the workspace hit spelling, in order, never only the first', async () => {
    const fs = existing(['src/a.ts', 'src/b.ts']);
    const result = await collectCodeChangeTargets({ candidates: ['src/a.ts', 'src/b.ts'], resolveExisting: fs.resolveExisting, allowNewFiles: false });
    expect(result).toEqual({ kind: 'targets', targets: ['./src/a.ts', './src/b.ts'], newFileTargets: [] });
  });

  it('a missing path with create wording is a new-file target (normalized); existing ones stay updates', async () => {
    const fs = existing(['src/a.ts']);
    const result = await collectCodeChangeTargets({ candidates: ['src/a.ts', './src/new.ts'], resolveExisting: fs.resolveExisting, allowNewFiles: true });
    expect(result).toEqual({ kind: 'targets', targets: ['./src/a.ts', 'src/new.ts'], newFileTargets: ['src/new.ts'] });
  });

  it('a missing path without create wording is reported (never dropped), with the resolved ones', async () => {
    const fs = existing(['src/a.ts']);
    const result = await collectCodeChangeTargets({ candidates: ['src/a.ts', 'src/typo.ts'], resolveExisting: fs.resolveExisting, allowNewFiles: false });
    expect(result).toEqual({ kind: 'missing', missing: ['src/typo.ts'], resolved: ['./src/a.ts'] });
  });

  it('more than 5 distinct candidates → too-many before any lookup; 5 is allowed', async () => {
    const six = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`);
    const fs = existing(six);
    expect(await collectCodeChangeTargets({ candidates: six, resolveExisting: fs.resolveExisting, allowNewFiles: false })).toEqual({
      kind: 'too-many',
      count: 6,
      max: 5,
    });
    expect(fs.looked).toEqual([]);
    const five = await collectCodeChangeTargets({ candidates: six.slice(0, 5), resolveExisting: fs.resolveExisting, allowNewFiles: false });
    expect(five.kind).toBe('targets');
  });

  it('duplicate spellings of one path count once (no double lookup, no double target)', async () => {
    const fs = existing(['src/a.ts']);
    const result = await collectCodeChangeTargets({ candidates: ['src/a.ts', './src/a.ts', 'src//a.ts'], resolveExisting: fs.resolveExisting, allowNewFiles: false });
    expect(result).toEqual({ kind: 'targets', targets: ['./src/a.ts'], newFileTargets: [] });
    expect(fs.looked).toEqual(['src/a.ts']);
  });
});

const fileDiff = (o: Partial<FileDiff> & { path: string }): FileDiff => ({
  changeKind: 'modify',
  unified: `--- a/${o.path}\n+++ b/${o.path}\n@@ -1 +1 @@\n-x\n+y\n`,
  binary: false,
  oldSize: 2,
  newSize: 2,
  ...o,
});
const diffOf = (files: FileDiff[]): WorkspaceDiff => ({ refId: 'ws-1', files, estimatedChangedLines: files.length, truncated: false });

describe('validatePatchableDiff', () => {
  const scope = { targetFiles: ['src/a.ts', 'src/b.ts'], newFileTargets: ['src/b.ts'] };

  it('accepts an update + an add of a new-file target and returns the add paths', () => {
    const result = validatePatchableDiff(
      diffOf([fileDiff({ path: 'src/a.ts' }), fileDiff({ path: 'src/b.ts', changeKind: 'add', oldSize: undefined })]),
      scope,
    );
    expect(result).toEqual({ ok: true, addPaths: ['src/b.ts'] });
  });

  it.each([
    ['empty diff', []],
    ['add for a non-new-file target', [fileDiff({ path: 'src/a.ts', changeKind: 'add' })]],
    ['new-file target that now exists', [fileDiff({ path: 'src/b.ts', changeKind: 'modify' })]],
    ['delete', [fileDiff({ path: 'src/a.ts', changeKind: 'delete' })]],
    ['binary', [fileDiff({ path: 'src/a.ts', binary: true, unified: '' })]],
    ['unrenderable (size-skipped)', [fileDiff({ path: 'src/a.ts', unified: '' })]],
    ['out of scope', [fileDiff({ path: 'src/other.ts' })]],
    ['duplicate path', [fileDiff({ path: 'src/a.ts' }), fileDiff({ path: './src/a.ts' })]],
    ['file over 64 KiB', [fileDiff({ path: 'src/a.ts', newSize: MAX_CHANGE_SET_FILE_BYTES + 1 })]],
    ['current file over 64 KiB', [fileDiff({ path: 'src/a.ts', oldSize: MAX_CHANGE_SET_FILE_BYTES + 1 })]],
    [
      'new file over 64 KiB',
      [fileDiff({ path: 'src/b.ts', changeKind: 'add', oldSize: undefined, newSize: MAX_CHANGE_SET_FILE_BYTES + 1 })],
    ],
  ] as const)('rejects: %s', (_name, files) => {
    expect(validatePatchableDiff(diffOf([...files]), scope).ok).toBe(false);
  });

  it('a pre-ADR-0099 scope (no newFileTargets) admits no add (fail closed)', () => {
    const result = validatePatchableDiff(diffOf([fileDiff({ path: 'src/b.ts', changeKind: 'add' })]), { targetFiles: ['src/b.ts'] });
    expect(result.ok).toBe(false);
  });

  it('rejects more than 5 files and a set over 256 KiB', () => {
    const six = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);
    expect(validatePatchableDiff(diffOf(six.map((p) => fileDiff({ path: p }))), { targetFiles: six }).ok).toBe(false);
    const five = six.slice(0, 5);
    const big = five.map((p) => fileDiff({ path: p, newSize: 60 * 1024 }));
    expect(validatePatchableDiff(diffOf(big), { targetFiles: five }).ok).toBe(false);
  });
});

const opOf = (path: string, operation: PatchOperation['operation'] = 'update'): PatchOperation => ({
  path,
  operation,
  diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\n`,
});
const patchSetOf = (operations: PatchOperation[], o: Partial<PatchSet> = {}): PatchSet => ({
  id: 'patch-1',
  executionPlanRef: PLAN,
  approvalRef: { id: 'appr-1', status: ApprovalStatus.APPROVED, executionPlanRef: PLAN },
  operations,
  status: PatchStatus.GENERATED,
  createdAt: '2026-10-02T00:00:00.000Z',
  ...o,
});
const anchorOf = (o: Partial<ChangeSetApplyAnchor> = {}): ChangeSetApplyAnchor => ({
  targetFiles: ['src/a.ts', 'src/b.ts'],
  newFileTargets: ['src/b.ts'],
  patchRef: { id: 'patch-1', status: PatchStatus.GENERATED },
  approvalId: 'appr-1',
  executionPlanRef: PLAN,
  workspaceRef: WS,
  ...o,
});

describe('validateChangeSetForApply', () => {
  it('accepts update + add (add ∈ newFileTargets) and reports the new files', () => {
    expect(validateChangeSetForApply(patchSetOf([opOf('src/a.ts'), opOf('src/b.ts', 'add')]), anchorOf())).toEqual({
      ok: true,
      newFiles: ['src/b.ts'],
    });
  });

  it.each([
    ['other patch id', patchSetOf([opOf('src/a.ts')], { id: 'patch-x' }), anchorOf()],
    ['not GENERATED', patchSetOf([opOf('src/a.ts')], { status: 'APPLIED' as PatchStatus }), anchorOf()],
    ['approval not APPROVED', patchSetOf([opOf('src/a.ts')], { approvalRef: { id: 'appr-1', status: ApprovalStatus.PENDING, executionPlanRef: PLAN } }), anchorOf()],
    ['other approval', patchSetOf([opOf('src/a.ts')]), anchorOf({ approvalId: 'appr-x' })],
    ['other plan', patchSetOf([opOf('src/a.ts')], { executionPlanRef: { id: 'plan-x', goal: 'g' } }), anchorOf()],
    ['no patchRef', patchSetOf([opOf('src/a.ts')]), anchorOf({ patchRef: undefined })],
    ['no operation', patchSetOf([]), anchorOf()],
    ['six operations', patchSetOf(Array.from({ length: 6 }, (_, i) => opOf(`f${i}.ts`))), anchorOf({ targetFiles: Array.from({ length: 6 }, (_, i) => `f${i}.ts`) })],
    ['delete', patchSetOf([opOf('src/a.ts', 'delete')]), anchorOf()],
    ['binary', patchSetOf([{ ...opOf('src/a.ts'), metadata: { binary: true } }]), anchorOf()],
    ['out of scope', patchSetOf([opOf('src/c.ts')]), anchorOf()],
    ['duplicate', patchSetOf([opOf('src/a.ts'), opOf('./src/a.ts')]), anchorOf()],
    ['add not in newFileTargets', patchSetOf([opOf('src/a.ts', 'add')]), anchorOf()],
    ['update of a new-file target', patchSetOf([opOf('src/b.ts', 'update')]), anchorOf()],
    ['add on an anchor without newFileTargets (pre-ADR-0099)', patchSetOf([opOf('src/b.ts', 'add')]), anchorOf({ newFileTargets: undefined })],
  ] as const)('rejects: %s', (_name, patchSet, anchor) => {
    expect(validateChangeSetForApply(patchSet, anchor).ok).toBe(false);
  });

  it('isSingleUpdateChangeSet is true only for exactly one update op', () => {
    expect(isSingleUpdateChangeSet([opOf('a')])).toBe(true);
    expect(isSingleUpdateChangeSet([opOf('a', 'add')])).toBe(false);
    expect(isSingleUpdateChangeSet([opOf('a'), opOf('b')])).toBe(false);
    expect(isSingleUpdateChangeSet([])).toBe(false);
  });
});

const changeOf = (patchSet: PatchSet, o: Partial<WorkspaceChange> = {}): WorkspaceChange => ({
  id: 'wc-1',
  patchRef: { id: patchSet.id, status: patchSet.status },
  patchHash: 'h',
  executionPlanRef: patchSet.executionPlanRef,
  approvalRef: patchSet.approvalRef,
  workspaceRef: WS,
  status: WorkspaceChangeStatus.APPLIED,
  results: patchSet.operations.map((op) => ({ path: op.path, operation: op.operation, status: 'applied' as const, message: 'ok', durationMs: 1 })),
  createdAt: 't',
  updatedAt: 't',
  ...o,
});

describe('verifyAppliedChangeSet / classifyUnverifiedChangeSet', () => {
  const ps = patchSetOf([opOf('src/a.ts'), opOf('src/b.ts', 'add')]);

  it('APPLIED with one-to-one results verifies', () => {
    expect(verifyAppliedChangeSet(changeOf(ps), ps, WS)).toBe(true);
  });

  it.each([
    ['ROLLED_BACK', { status: WorkspaceChangeStatus.ROLLED_BACK }],
    ['PARTIALLY_APPLIED', { status: WorkspaceChangeStatus.PARTIALLY_APPLIED }],
    ['fewer results', { results: [{ path: 'src/a.ts', operation: 'update' as const, status: 'applied' as const, message: '', durationMs: 1 }] }],
    ['reordered results', { results: changeOf(ps).results.slice().reverse() }],
    ['other workspace', { workspaceRef: { ...WS, id: 'ws-x' } }],
    ['other patch', { patchRef: { id: 'patch-x', status: PatchStatus.GENERATED } }],
  ] as const)('does not verify: %s', (_name, o) => {
    expect(verifyAppliedChangeSet(changeOf(ps, o as Partial<WorkspaceChange>), ps, WS)).toBe(false);
  });

  it('rolled back → nothing changed; partial / applying / unverifiable APPLIED → may have applied; failed → failed', () => {
    expect(classifyUnverifiedChangeSet(changeOf(ps, { status: WorkspaceChangeStatus.ROLLED_BACK }))).toBe('rolled-back');
    expect(classifyUnverifiedChangeSet(changeOf(ps, { status: WorkspaceChangeStatus.PARTIALLY_APPLIED }))).toBe('may-have-applied');
    expect(classifyUnverifiedChangeSet(changeOf(ps, { status: WorkspaceChangeStatus.APPLYING }))).toBe('may-have-applied');
    expect(classifyUnverifiedChangeSet(changeOf(ps, { status: WorkspaceChangeStatus.APPLIED }))).toBe('may-have-applied');
    expect(classifyUnverifiedChangeSet(changeOf(ps, { status: WorkspaceChangeStatus.FAILED }))).toBe('failed');
  });
});

const statusOf = (o: Partial<GitStatus> = {}): GitStatus => ({
  clean: false,
  branch: 'feature/x',
  staged: [],
  unstaged: [],
  untracked: [],
  ...o,
});

describe('partitionCommitCandidates', () => {
  const scope = { targetFiles: ['src/a.ts', 'src/b.ts'], newFileTargets: ['src/b.ts'] };

  it('admits an untracked new-file target as newFiles next to a tracked change', () => {
    expect(
      partitionCommitCandidates({ candidates: ['src/a.ts', 'src/b.ts'], scope, status: statusOf({ unstaged: ['src/a.ts'], untracked: ['src/b.ts'] }) }),
    ).toEqual({ ok: true, files: ['src/a.ts', 'src/b.ts'], newFiles: ['src/b.ts'] });
  });

  it('tracked-only candidates pass with no newFiles (the ADR-0046 shape)', () => {
    expect(partitionCommitCandidates({ candidates: ['src/a.ts'], scope: { targetFiles: ['src/a.ts'] }, status: statusOf({ unstaged: ['src/a.ts'] }) })).toEqual({
      ok: true,
      files: ['src/a.ts'],
      newFiles: [],
    });
  });

  it('an untracked candidate that is NOT a new-file target is untracked-unsupported', () => {
    const r = partitionCommitCandidates({ candidates: ['src/a.ts'], scope: { targetFiles: ['src/a.ts'], newFileTargets: [] }, status: statusOf({ untracked: ['src/a.ts'] }) });
    expect(r).toEqual({ ok: false, reason: 'untracked-unsupported' });
  });

  it.each([
    ['a stray untracked file outside the targets', statusOf({ unstaged: ['src/a.ts'], untracked: ['src/b.ts', 'stray.txt'] })],
    ['an in-scope untracked file that is not a candidate', statusOf({ unstaged: ['src/a.ts'], untracked: ['src/b.ts'] })],
    ['a candidate no longer changed', statusOf({ untracked: ['src/b.ts'] })],
    ['a staged file outside the candidates', statusOf({ unstaged: ['src/a.ts'], untracked: ['src/b.ts'], staged: ['other.ts'] })],
  ] as const)('blocks scope drift: %s', (name, status) => {
    const candidates = name.startsWith('an in-scope') ? ['src/a.ts'] : ['src/a.ts', 'src/b.ts'];
    expect(partitionCommitCandidates({ candidates, scope, status })).toEqual({ ok: false, reason: 'scope-drift' });
  });

  it('refuses unsafe candidates / out-of-scope candidates / unsafe status paths', () => {
    expect(partitionCommitCandidates({ candidates: ['../x.ts'], scope, status: statusOf() }).ok).toBe(false);
    expect(partitionCommitCandidates({ candidates: ['src/c.ts'], scope, status: statusOf({ unstaged: ['src/c.ts'] }) })).toEqual({
      ok: false,
      reason: 'candidate-out-of-scope',
    });
    expect(partitionCommitCandidates({ candidates: ['src/a.ts'], scope, status: statusOf({ unstaged: ['src/a.ts', '/etc/x'] }) })).toEqual({
      ok: false,
      reason: 'unsafe-changed-path',
    });
  });

  it('newFileCommitCandidates marks only untracked new-file targets', () => {
    expect(newFileCommitCandidates(['src/a.ts', 'src/b.ts'], scope, statusOf({ unstaged: ['src/a.ts'], untracked: ['src/b.ts'] }))).toEqual(['src/b.ts']);
    expect(newFileCommitCandidates(['src/a.ts', 'src/b.ts'], { targetFiles: scope.targetFiles }, statusOf({ untracked: ['src/b.ts'] }))).toEqual([]);
  });
});

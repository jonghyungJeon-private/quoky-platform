import type { GitStatus, RepositoryInfo } from '../../domain';
import { isSafePushBranch, isSafePushRemote } from '../push-target';
import { isProtectedBranch } from './branch-name-policy';

/**
 * Pure push-target resolver (ADR-0099 D5, amends ADR-0047/0048). Shared by the push-approval planning turn and the
 * approved push-execution turn so both apply the same rules. No I/O, no git, no config: the caller passes the
 * read-only `git.info` / `git.status` snapshots it just read.
 *
 * Two modes:
 * - `upstream` — the legacy ADR-0047 behaviour, unchanged: the branch tracks `<remote>/<branch>`; the target is the
 *   parsed upstream, ahead ≥ 1 and behind = 0 are required.
 * - `new-remote-branch` — the current branch has NO upstream (a fresh feature branch): the target is the fixed
 *   remote `origin` and the CURRENT branch name, so the first push creates `refs/heads/<branch>` on `origin`. Never
 *   `main`/`master`, never a force push, never `-u` (no local upstream is configured), never a fetch.
 *
 * Preconditions in both modes: HEAD is attached and equals the committed hash, and the working tree is clean.
 */

/** How the push target was resolved. A legacy anchor without `pushMode` is treated as `'upstream'`. */
export type PushMode = 'upstream' | 'new-remote-branch';

/** The fixed remote a first push of a branch without an upstream goes to (ADR-0099 D5). */
export const NEW_REMOTE_BRANCH_PUSH_REMOTE = 'origin';

/** A resolved, safe push target. */
export interface ResolvedPushTarget {
  readonly mode: PushMode;
  readonly remote: string;
  readonly branch: string;
  /** `<remote>/<branch>`: the existing upstream (upstream mode) or the synthesized one (new-remote-branch mode). */
  readonly upstreamRef: string;
  /** Commits ahead of the upstream; absent for a new remote branch (there is no local tracking ref to compare). */
  readonly ahead?: number;
}

/**
 * Why no push target could be used. Each maps to one existing fixed reply in the runtime:
 * - `detached` / `head-moved` — HEAD is detached, unknown, or no longer the committed (or approved) commit;
 * - `dirty` — staged, unstaged or untracked changes;
 * - `no-upstream` — an upstream is present but does not parse as `<remote>/<branch>` (upstream mode);
 * - `protected-branch` — a new remote branch would be `main`/`master`;
 * - `unsafe-name` — the current branch name fails the conservative push-name check;
 * - `nothing-to-push` / `diverged` — ahead < 1 / behind > 0 against an upstream;
 * - `drift` — execution only: the live target is not the approved one (mode, remote, branch or upstream).
 */
export type PushTargetRefusal =
  | 'detached'
  | 'head-moved'
  | 'dirty'
  | 'no-upstream'
  | 'protected-branch'
  | 'unsafe-name'
  | 'nothing-to-push'
  | 'diverged'
  | 'drift';

export type PushTargetResolution =
  | { readonly ok: true; readonly target: ResolvedPushTarget }
  | { readonly ok: false; readonly reason: PushTargetRefusal };

/** The approved target persisted on the anchor, re-checked before the push runs. */
export interface ApprovedPushTarget {
  /** `undefined` (a legacy anchor) is `'upstream'`. */
  readonly mode?: PushMode;
  readonly remote: string;
  readonly branch: string;
  readonly upstreamRef: string;
  readonly commitHash: string;
}

const MAX_UPSTREAM_LEN = 200;

function hasControlChar(s: string): boolean {
  return [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
}

/**
 * Parse an upstream tracking ref (`origin/feature/x`) into remote + branch (Sprint 2z, ADR-0047 CA #5). Null for an
 * empty, over-long, control-character, slash-less, empty-remote, empty-branch or whitespace-remote value.
 */
export function parsePushUpstreamRef(upstream: string): { remote: string; branch: string } | null {
  if (typeof upstream !== 'string') return null;
  const u = upstream.trim();
  if (u.length === 0 || u.length > MAX_UPSTREAM_LEN) return null;
  if (hasControlChar(u)) return null;
  const slash = u.indexOf('/');
  if (slash <= 0 || slash === u.length - 1) return null;
  const remote = u.slice(0, slash);
  const branch = u.slice(slash + 1);
  if (/\s/.test(remote)) return null;
  return { remote, branch };
}

/** The upstream ref a first push of `branch` to `origin` corresponds to. */
export function newRemoteBranchUpstreamRef(branch: string): string {
  return `${NEW_REMOTE_BRANCH_PUSH_REMOTE}/${branch}`;
}

/** The persisted push mode of an anchor (a missing value keeps the legacy upstream behaviour). */
export function pushModeOf(mode: PushMode | undefined): PushMode {
  return mode === 'new-remote-branch' ? 'new-remote-branch' : 'upstream';
}

/**
 * HEAD precondition, checked right after `git.info` and before `git.status` is read (the runtime's step order):
 * attached and equal to `expectedHash`.
 */
export function checkPushHead(info: RepositoryInfo, expectedHash: string): { ok: true } | { ok: false; reason: 'detached' | 'head-moved' } {
  if (info.detached || !info.headSha) return { ok: false, reason: 'detached' };
  if (info.headSha !== expectedHash) return { ok: false, reason: 'head-moved' };
  return { ok: true };
}

function isDirty(status: GitStatus): boolean {
  return status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0;
}

/** ahead ≥ 1 and behind = 0 against an existing upstream: the ahead count, or the refusal. */
function checkAheadBehind(status: GitStatus): { ahead: number } | { refusal: PushTargetRefusal } {
  if (!status.ahead || status.ahead < 1) return { refusal: 'nothing-to-push' };
  if (status.behind && status.behind > 0) return { refusal: 'diverged' };
  return { ahead: status.ahead };
}

/**
 * Resolve the push target for push-approval planning (ADR-0099 D5). Check order (mirrors the ADR-0047 steps):
 * HEAD → clean tree → upstream mode (parse, ahead, behind) or, with no upstream, new-remote-branch mode (current
 * branch attached, not `main`/`master`, push-safe name).
 */
export function resolvePushTarget(input: {
  readonly info: RepositoryInfo;
  readonly status: GitStatus;
  readonly committedHash: string;
}): PushTargetResolution {
  const { info, status, committedHash } = input;
  const head = checkPushHead(info, committedHash);
  if (!head.ok) return head;
  if (isDirty(status)) return { ok: false, reason: 'dirty' };

  if (status.upstream) {
    const parsed = parsePushUpstreamRef(status.upstream);
    if (!parsed) return { ok: false, reason: 'no-upstream' };
    // A feature branch created from origin/main tracks origin/main: pushing it would update the remote main.
    if (isProtectedBranch(parsed.branch) || isProtectedBranch(info.branch)) return { ok: false, reason: 'protected-branch' };
    const counted = checkAheadBehind(status);
    if ('refusal' in counted) return { ok: false, reason: counted.refusal };
    return {
      ok: true,
      target: { mode: 'upstream', remote: parsed.remote, branch: parsed.branch, upstreamRef: status.upstream, ahead: counted.ahead },
    };
  }

  const branch = info.branch.trim();
  if (branch.length === 0 || branch !== info.branch) return { ok: false, reason: 'detached' };
  if (isProtectedBranch(branch)) return { ok: false, reason: 'protected-branch' };
  if (!isSafePushBranch(branch)) return { ok: false, reason: 'unsafe-name' };
  return {
    ok: true,
    target: {
      mode: 'new-remote-branch',
      remote: NEW_REMOTE_BRANCH_PUSH_REMOTE,
      branch,
      upstreamRef: newRemoteBranchUpstreamRef(branch),
    },
  };
}

/**
 * Re-verify the APPROVED target right before the push (ADR-0099 D5 drift checks). Check order (mirrors the
 * ADR-0048 execution steps): HEAD = approved commit → clean tree → mode-specific target equality → ahead/behind.
 *
 * - `upstream`: the live upstream must exist, parse, and equal the approved upstream/remote/branch.
 * - `new-remote-branch`: the approved target must be the synthesized `origin/<branch>` of a non-protected,
 *   push-safe branch; the CURRENT branch must still be that branch; the live upstream must be absent or exactly
 *   the synthesized ref (then ahead/behind are checked against it).
 */
export function verifyApprovedPushTarget(input: {
  readonly info: RepositoryInfo;
  readonly status: GitStatus;
  readonly approved: ApprovedPushTarget;
}): PushTargetResolution {
  const { info, status, approved } = input;
  const head = checkPushHead(info, approved.commitHash);
  if (!head.ok) return head;
  if (isDirty(status)) return { ok: false, reason: 'dirty' };
  const mode = pushModeOf(approved.mode);

  if (mode === 'upstream') {
    const parsed = status.upstream ? parsePushUpstreamRef(status.upstream) : null;
    if (
      !status.upstream ||
      !parsed ||
      status.upstream !== approved.upstreamRef ||
      parsed.remote !== approved.remote ||
      parsed.branch !== approved.branch
    ) {
      return { ok: false, reason: 'drift' };
    }
    if (isProtectedBranch(parsed.branch) || isProtectedBranch(info.branch)) return { ok: false, reason: 'protected-branch' };
    const counted = checkAheadBehind(status);
    if ('refusal' in counted) return { ok: false, reason: counted.refusal };
    return {
      ok: true,
      target: { mode, remote: approved.remote, branch: approved.branch, upstreamRef: approved.upstreamRef, ahead: counted.ahead },
    };
  }

  if (
    approved.remote !== NEW_REMOTE_BRANCH_PUSH_REMOTE ||
    approved.upstreamRef !== newRemoteBranchUpstreamRef(approved.branch) ||
    !isSafePushRemote(approved.remote) ||
    !isSafePushBranch(approved.branch)
  ) {
    return { ok: false, reason: 'drift' };
  }
  if (isProtectedBranch(approved.branch)) return { ok: false, reason: 'protected-branch' };
  if (info.branch !== approved.branch) return { ok: false, reason: 'drift' };
  let ahead: number | undefined;
  if (status.upstream !== undefined) {
    if (status.upstream !== approved.upstreamRef) return { ok: false, reason: 'drift' };
    const counted = checkAheadBehind(status);
    if ('refusal' in counted) return { ok: false, reason: counted.refusal };
    ahead = counted.ahead;
  }
  return {
    ok: true,
    target: {
      mode,
      remote: approved.remote,
      branch: approved.branch,
      upstreamRef: approved.upstreamRef,
      ...(ahead !== undefined ? { ahead } : {}),
    },
  };
}

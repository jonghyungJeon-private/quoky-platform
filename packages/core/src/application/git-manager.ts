import { WorkspaceNotSafeError } from '../errors';
import { ApprovalStatus } from '../domain';
import type { ApprovalRef, GitBranchCleanupResult, GitBranchResult, GitCommitResult, GitDiff, GitMainSyncResult, GitPushResult, GitStatus, RepositoryInfo } from '../domain';
import type { GitProvider } from '../ports';
import { isCreatableOwnerBranch } from './code-work/branch-name-policy';
import { isValidCommitMessage } from './commit-message';
import { isSafePushBranch, isSafePushRemote } from './push-target';

/** SHA-shape guard for the sync commits (mirrors the push commitHash gate). */
const SYNC_SHA_SHAPED = /^[0-9a-f]{7,40}$/i;

/**
 * A post-merge local `main` sync failed **before the local main ref-update was attempted** (invalid input, dirty/
 * detached/mid-merge tree, missing local main, remote read failure, remote tip != expected, non-fast-forward, or
 * the local main moved before the update). Definitively **no** local ref was moved — a caller may safely say
 * "로컬 main을 동기화하지 않았어요" (CAP-002, ADR-0058, Sprint 3h — mirrors RepositoryHostingBlockedError).
 */
export class GitMainSyncBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitMainSyncBlockedError';
  }
}

/**
 * The local `main` ref-update was **attempted** but could not be completed/verified. The local ref **may** have
 * moved — a caller must **not** claim it was not synchronized; say "동기화 결과를 확인하지 못했어요" instead (CAP-002,
 * ADR-0058, Sprint 3h — mirrors RepositoryHostingUnverifiedError).
 */
export class GitMainSyncUnverifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitMainSyncUnverifiedError';
  }
}

/**
 * A post-merge LOCAL branch cleanup failed **before the branch ref-delete was attempted** (invalid input, dirty/
 * mid-op tree, branch is main / checked out / unsafe / not merged, local main moved, or the branch moved vs the
 * expected commit). Definitively **no** ref was deleted — a caller may safely say "브랜치를 삭제하지 않았어요"
 * (CAP-002, ADR-0059, Sprint 3i — mirrors GitMainSyncBlockedError).
 */
export class BranchCleanupBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchCleanupBlockedError';
  }
}

/**
 * The branch ref-delete was **attempted** but could not be completed/verified. The ref **may** be gone — a caller
 * must **not** claim it was not deleted; say "삭제 결과를 확인하지 못했어요" instead (CAP-002, ADR-0059, Sprint 3i —
 * mirrors GitMainSyncUnverifiedError).
 */
export class BranchCleanupUnverifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchCleanupUnverifiedError';
  }
}

/**
 * An approved git push failed **before the push was attempted** — specifically an App-auth credential/preflight
 * failure (installation-token mint, one-shot `GIT_ASKPASS` creation, or the required HTTPS github.com remote
 * preflight; ADR-0061, Sprint 4b). Definitively **no** push happened — a caller may safely say the push was not
 * performed. Distinct from a throw AT/AFTER the push attempt, which stays the conservative "could-not-complete /
 * check the remote" reply (never "not pushed"). Mirrors {@link GitMainSyncBlockedError}.
 */
export class GitPushBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitPushBlockedError';
  }
}

/** Coarse, secret-free class of a failed git remote step — safe to log (a fixed enum, never raw stderr). */
export type GitFailureReasonClass =
  | 'timeout'
  | 'rejected-non-fast-forward'
  | 'auth'
  | 'network'
  | 'remote-not-found'
  | 'other';

/**
 * Classify a git failure into a {@link GitFailureReasonClass} from the (already sanitized) provider error message.
 * Only the fixed class is returned — the message/stderr itself is never echoed, so no URL or token can leak.
 */
export function classifyGitFailure(err: unknown): GitFailureReasonClass {
  const m = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/timed out after \d+\s*ms/i.test(m)) return 'timeout';
  if (/non-fast-forward|fetch first|\[rejected\]|tip of your current branch is behind|updates were rejected/i.test(m)) {
    return 'rejected-non-fast-forward';
  }
  if (/authentication failed|could not read (username|password)|permission denied|\b40[13]\b|invalid credentials|terminal prompts disabled/i.test(m)) {
    return 'auth';
  }
  if (/repository not found|does not appear to be a git repository|\b404\b|not found/i.test(m)) return 'remote-not-found';
  if (/could not resolve host|unable to access|failed to connect|connection (timed out|refused|reset)|network is unreachable|ssl|tls|unexpected disconnect|early eof/i.test(m)) {
    return 'network';
  }
  return 'other';
}

/** Reject an absolute / `..` traversal / empty commit pathspec (ADR-0046 defensive gate). */
function isUnsafeCommitPath(p: string): boolean {
  const t = typeof p === 'string' ? p.trim() : '';
  if (t.length === 0) return true;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(t)) return true; // absolute (POSIX or Windows)
  return t === '..' || t.split(/[\\/]/).includes('..'); // traversal
}

/**
 * Thin orchestration over the GitProvider — the **repository** abstraction
 * (CAP-002, ADR-0023). Read-only in Sprint 2b. Git ≠ Workspace; this composes
 * with a workspace purely through `rootPath`. The provider keeps all git
 * execution adapter-side; core stays child_process-free.
 */
export class GitManager {
  constructor(private readonly provider: GitProvider) {}

  /** True when `rootPath` is inside a git work tree. */
  async isRepository(rootPath: string): Promise<boolean> {
    return this.provider.isRepository(rootPath);
  }

  /** Read-only repository metadata (branch / HEAD / detached). No remote URLs. */
  async info(rootPath: string): Promise<RepositoryInfo> {
    return this.provider.info(rootPath);
  }

  /** Working-tree status (clean/branch + staged/unstaged/untracked). */
  async status(rootPath: string): Promise<GitStatus> {
    return this.provider.status(rootPath);
  }

  /**
   * Read-only unified diff of tracked staged/unstaged changes vs HEAD (ADR-0044). Read-only — delegates to
   * the provider's read-only `git diff`; never mutates. Untracked contents are excluded (see `status`).
   */
  async diff(rootPath: string): Promise<GitDiff> {
    return this.provider.diff(rootPath);
  }

  /**
   * Approved exact-file git commit (CAP-002, ADR-0046 — the first Git mutation). Ref-gated (mirrors
   * WorkspaceWriteManager): validates `approvalRef.status === APPROVED` + defensive inputs (non-empty
   * rootPath/files, all safe relative paths, unique after trim, valid bounded single-line message) BEFORE
   * delegating to the provider. The runtime performs the full context/scope re-validation first; this is the
   * capability-level backstop. The provider owns the argv details and commits exactly `files` (no push).
   * The ApprovalRef is consumed here and NOT passed to the provider.
   *
   * `newFiles` (ADR-0099 D3) marks the approved UNTRACKED paths among `files`: each must be safe, unique and a
   * member of `files` (`newFiles ⊆ files`, compared after trim). Only then does the provider run
   * `git add -- <newFiles>` before the commit. Omitted or empty → the provider is called exactly as before.
   */
  async commitFiles(input: {
    rootPath: string;
    files: string[];
    message: string;
    approvalRef: ApprovalRef;
    newFiles?: string[];
  }): Promise<GitCommitResult> {
    if (input.approvalRef.status !== ApprovalStatus.APPROVED) {
      throw new Error(`git commit requires an APPROVED approval (got ${input.approvalRef.status})`);
    }
    if (!input.rootPath.trim()) throw new Error('git commit requires a rootPath');
    if (input.files.length === 0) throw new Error('git commit requires at least one file');
    const cleaned = input.files.map((f) => (typeof f === 'string' ? f.trim() : ''));
    if (cleaned.some(isUnsafeCommitPath)) throw new Error('git commit rejects an unsafe file path');
    if (new Set(cleaned).size !== cleaned.length) throw new Error('git commit rejects duplicate files');
    if (!isValidCommitMessage(input.message)) throw new Error('git commit rejects an invalid message');
    if (input.newFiles !== undefined && input.newFiles.length > 0) {
      const newFiles = input.newFiles.map((f) => (typeof f === 'string' ? f.trim() : ''));
      if (newFiles.some(isUnsafeCommitPath)) throw new Error('git commit rejects an unsafe new file path');
      if (new Set(newFiles).size !== newFiles.length) throw new Error('git commit rejects duplicate new files');
      const approved = new Set(cleaned);
      if (newFiles.some((f) => !approved.has(f))) throw new Error('git commit rejects a new file that is not in the commit set');
      return this.provider.commitFiles(input.rootPath, cleaned, input.message, { newFiles });
    }
    return this.provider.commitFiles(input.rootPath, cleaned, input.message);
  }

  /**
   * READ-ONLY (CAP-002, ADR-0058/0099): the LOCAL branch tip, or `null` when the branch does not exist. Rejects an
   * unsafe branch name before any git call. Lets a caller refuse a create/switch with a precise reason.
   */
  async getLocalRefCommit(rootPath: string, branch: string): Promise<{ commitHash: string } | null> {
    if (!rootPath.trim()) throw new Error('git rev-parse requires a rootPath');
    if (!isSafePushBranch(branch)) throw new Error('git rev-parse rejects an unsafe branch');
    return this.provider.getLocalRefCommit(rootPath, branch);
  }

  /**
   * Owner LOCAL branch creation (CAP-002, ADR-0099 D4). No ApprovalRef: an explicit owner command, local,
   * non-destructive and reversible. Validates the branch name (`isCreatableOwnerBranch`: ASCII, bounded,
   * never `main`/`master`/`HEAD`/`refs/…`) and the SHA shape of `expectedHeadSha` BEFORE delegating; the provider
   * owns the state preflight (attached HEAD, no merge/rebase in progress, HEAD CAS, branch absent) and the
   * read-back. The result is checked once more (`branch`, `created`).
   */
  async createBranch(rootPath: string, branch: string, expectedHeadSha: string): Promise<GitBranchResult> {
    if (!rootPath.trim()) throw new Error('git branch create requires a rootPath');
    if (!isCreatableOwnerBranch(branch)) throw new Error('git branch create rejects an unsafe or protected branch name');
    if (!SYNC_SHA_SHAPED.test(expectedHeadSha)) throw new Error('git branch create rejects an invalid expected HEAD');
    const result = await this.provider.createBranch(rootPath, branch, expectedHeadSha);
    if (result.branch !== branch || result.created !== true) {
      throw new Error('git branch create: the result could not be verified');
    }
    return result;
  }

  /**
   * Owner LOCAL branch switch (CAP-002, ADR-0099 D4). No ApprovalRef. Validates the branch name with the same
   * policy as creation before delegating; the provider requires an existing local branch and a clean tree.
   */
  async switchBranch(rootPath: string, branch: string): Promise<GitBranchResult> {
    if (!rootPath.trim()) throw new Error('git branch switch requires a rootPath');
    if (!isCreatableOwnerBranch(branch)) throw new Error('git branch switch rejects an unsafe or protected branch name');
    const result = await this.provider.switchBranch(rootPath, branch);
    if (result.branch !== branch || result.created !== false) {
      throw new Error('git branch switch: the result could not be verified');
    }
    return result;
  }

  /**
   * Approved git push (CAP-002, ADR-0048 — the first remote mutation). Ref-gated (mirrors commitFiles):
   * validates `approvalRef.status === APPROVED` + defensive inputs (non-empty rootPath, conservative-safe
   * remote/branch, SHA-shaped commitHash) BEFORE delegating. The runtime performs the full context/state
   * re-validation first; this is the capability-level backstop. The provider runs the argv-only
   * `git push <remote> HEAD:<branch>` and returns the reported target. The ApprovalRef is consumed here and
   * NOT passed to the provider. No generic push method is exposed.
   */
  async pushApprovedCommit(input: {
    rootPath: string;
    remote: string;
    branch: string;
    commitHash: string;
    approvalRef: ApprovalRef;
  }): Promise<GitPushResult> {
    if (input.approvalRef.status !== ApprovalStatus.APPROVED) {
      throw new Error(`git push requires an APPROVED approval (got ${input.approvalRef.status})`);
    }
    if (!input.rootPath.trim()) throw new Error('git push requires a rootPath');
    if (!isSafePushRemote(input.remote)) throw new Error('git push rejects an unsafe remote');
    if (!isSafePushBranch(input.branch)) throw new Error('git push rejects an unsafe branch');
    if (!/^[0-9a-f]{7,40}$/i.test(input.commitHash)) throw new Error('git push rejects an invalid commitHash');
    return this.provider.pushApprovedCommit(input.rootPath, input.remote, input.branch, input.commitHash);
  }

  /**
   * Post-merge local `main` synchronization (CAP-002, ADR-0058 — Sprint 3h). Fast-forward ONLY; no ApprovalRef
   * (a local, non-destructive ref move gated by PR_MERGED + explicit command + this conservative preflight). Runs
   * the local + remote preflight, then makes at most ONE mutating call (`syncMainFastForward`). **Phase-aware
   * failure classification (CA change 2): the Manager does NOT blanket-convert every provider throw to Unverified.**
   *   1. defensive validation                                → GitMainSyncBlockedError (no read, no mutation)
   *   2. isRepository + status (clean/untracked/staged/unstaged/unmerged) + info (detached) → dirty/detached → Blocked
   *   3. getLocalRefCommit('main') → null → Blocked; else record previousMainCommit (the CAS base)
   *   4. getRemoteRefCommit → throws → Blocked; tip != expectedRemoteCommit → Blocked
   *   5. SINGLE syncMainFastForward(…, previousMainCommit): a provider GitMainSyncBlockedError (pre-ref-update)
   *      propagates as Blocked; a GitMainSyncUnverifiedError propagates as Unverified; any OTHER throw → Unverified
   *      (conservative — at/around the mutation). Result-integrity (syncedCommitHash === expected) → Unverified.
   */
  async syncMain(input: {
    rootPath: string;
    remote: string;
    branch: string;
    expectedRemoteCommit: string;
  }): Promise<GitMainSyncResult> {
    const { rootPath, remote, branch, expectedRemoteCommit } = input;
    // ── 1. Defensive validation BEFORE any git call. All → Blocked (no mutation). ───────────────────────────
    if (!rootPath.trim()) throw new GitMainSyncBlockedError('git main sync requires a rootPath');
    if (!isSafePushRemote(remote)) throw new GitMainSyncBlockedError('git main sync rejects an unsafe remote');
    if (!isSafePushBranch(branch)) throw new GitMainSyncBlockedError('git main sync rejects an unsafe branch');
    if (!SYNC_SHA_SHAPED.test(expectedRemoteCommit)) throw new GitMainSyncBlockedError('git main sync rejects an invalid expected commit');

    // ── 2. Local repository safety (read-only). Any dirty/detached/mid-merge → Blocked. ─────────────────────
    if (!(await this.provider.isRepository(rootPath))) {
      throw new GitMainSyncBlockedError('git main sync: not a git repository');
    }
    let status: GitStatus;
    let info: RepositoryInfo;
    try {
      status = await this.provider.status(rootPath);
      info = await this.provider.info(rootPath);
    } catch {
      throw new GitMainSyncBlockedError('git main sync: could not read local repository state');
    }
    if (!status.clean) throw new GitMainSyncBlockedError('git main sync: working tree is not clean');
    if (status.untracked.length > 0) throw new GitMainSyncBlockedError('git main sync: untracked files present');
    if (status.staged.length > 0) throw new GitMainSyncBlockedError('git main sync: staged changes present');
    if (status.unstaged.length > 0) throw new GitMainSyncBlockedError('git main sync: uncommitted changes present');
    if (status.hasUnmergedPaths) throw new GitMainSyncBlockedError('git main sync: unmerged paths present');
    if (info.detached || status.isDetached) throw new GitMainSyncBlockedError('git main sync: HEAD is detached');

    // ── 3. Local main must exist; record the CAS base. ──────────────────────────────────────────────────────
    let local: { commitHash: string } | null;
    try {
      local = await this.provider.getLocalRefCommit(rootPath, branch);
    } catch {
      throw new GitMainSyncBlockedError('git main sync: could not read local main');
    }
    if (!local) throw new GitMainSyncBlockedError('git main sync: local main does not exist');
    const previousMainCommit = local.commitHash;

    // ── 4. Observe the remote main tip (read-only) BEFORE any mutation; must equal the expected merge commit. ─
    let remoteTip: { commitHash: string };
    try {
      remoteTip = await this.provider.getRemoteRefCommit(rootPath, remote, branch);
    } catch {
      throw new GitMainSyncBlockedError('git main sync: could not observe remote main; not synchronized');
    }
    if (remoteTip.commitHash !== expectedRemoteCommit) {
      throw new GitMainSyncBlockedError('git main sync: remote main does not match the expected merge commit; not synchronized');
    }

    // ── 5. SINGLE fast-forward mutation. Phase-aware: provider Blocked → Blocked; Unverified/other → Unverified. ─
    let result: GitMainSyncResult;
    try {
      result = await this.provider.syncMainFastForward(rootPath, remote, branch, expectedRemoteCommit, previousMainCommit);
    } catch (err) {
      if (err instanceof GitMainSyncBlockedError) throw err; // pre-ref-update — definitively not synced
      if (err instanceof GitMainSyncUnverifiedError) throw err; // at/after ref update — unknown
      throw new GitMainSyncUnverifiedError('git main sync: could not verify the local main synchronization');
    }
    if (result.syncedCommitHash !== expectedRemoteCommit) {
      throw new GitMainSyncUnverifiedError('git main sync: local main sync result could not be verified');
    }
    return result;
  }

  /**
   * Post-merge LOCAL branch cleanup (CAP-002, ADR-0059 — Sprint 3i). Safe CAS delete of the already-merged feature
   * branch; no ApprovalRef (a local, recoverable ref delete gated by MAIN_SYNCED + explicit command + this
   * preflight). Runs the preflight, then makes at most ONE mutating call (`deleteMergedLocalBranch`). **Phase-aware
   * (CA change 2): the Manager does NOT blanket-convert every provider throw to Unverified.**
   *   1. defensive validation → BranchCleanupBlockedError.
   *   2. isRepository + status (mid-op) + info (current branch != target) → Blocked.
   *   3. getLocalRefCommit('main') → null / != expectedMainCommit → Blocked (main moved after MAIN_SYNCED, CA change 4).
   *   4. getLocalRefCommit(target) → null → idempotent { deleted:false, alreadyAbsent:true }; else record targetCommit.
   *   5. isAncestor(targetCommit, expectedMainCommit) false → Blocked (not merged; never force-delete).
   *   6. SINGLE deleteMergedLocalBranch(target, targetCommit): provider Blocked → Blocked; Unverified → Unverified;
   *      any OTHER throw → Unverified. Result-integrity (branch === target, deleted true) mismatch → Unverified.
   */
  async deleteMergedLocalBranch(input: {
    rootPath: string;
    branch: string;
    expectedMainCommit: string;
  }): Promise<GitBranchCleanupResult> {
    const { rootPath, branch, expectedMainCommit } = input;
    // ── 1. Defensive validation. All → Blocked (no read, no delete). ────────────────────────────────────────
    if (!rootPath.trim()) throw new BranchCleanupBlockedError('git branch cleanup requires a rootPath');
    if (!isSafePushBranch(branch)) throw new BranchCleanupBlockedError('git branch cleanup rejects an unsafe branch');
    if (branch === 'main') throw new BranchCleanupBlockedError('git branch cleanup never deletes main');
    if (!/^[0-9a-f]{7,40}$/i.test(expectedMainCommit)) throw new BranchCleanupBlockedError('git branch cleanup rejects an invalid expected main commit');

    // ── 2. Local repository safety. ─────────────────────────────────────────────────────────────────────────
    if (!(await this.provider.isRepository(rootPath))) {
      throw new BranchCleanupBlockedError('git branch cleanup: not a git repository');
    }
    let status: GitStatus;
    let info: RepositoryInfo;
    try {
      status = await this.provider.status(rootPath);
      info = await this.provider.info(rootPath);
    } catch {
      throw new BranchCleanupBlockedError('git branch cleanup: could not read local repository state');
    }
    if (status.hasUnmergedPaths) throw new BranchCleanupBlockedError('git branch cleanup: unmerged paths present');
    if (info.branch === branch) throw new BranchCleanupBlockedError('git branch cleanup: target branch is currently checked out');

    // ── 3. Local main must still equal the synchronized commit (CA change 4). ──────────────────────────────
    let localMain: { commitHash: string } | null;
    try {
      localMain = await this.provider.getLocalRefCommit(rootPath, 'main');
    } catch {
      throw new BranchCleanupBlockedError('git branch cleanup: could not read local main');
    }
    if (!localMain) throw new BranchCleanupBlockedError('git branch cleanup: local main does not exist');
    if (localMain.commitHash !== expectedMainCommit) {
      throw new BranchCleanupBlockedError('git branch cleanup: local main moved since sync; not deleted');
    }

    // ── 4. Target branch: absent → idempotent success; else record the CAS base. ───────────────────────────
    let target: { commitHash: string } | null;
    try {
      target = await this.provider.getLocalRefCommit(rootPath, branch);
    } catch {
      throw new BranchCleanupBlockedError('git branch cleanup: could not read target branch');
    }
    if (!target) return { branch, deleted: false, alreadyAbsent: true };
    const targetCommit = target.commitHash;

    // ── 5. Fully merged into main (never force-delete an unmerged branch). ─────────────────────────────────
    let merged: boolean;
    try {
      merged = await this.provider.isAncestor(rootPath, targetCommit, expectedMainCommit);
    } catch {
      throw new BranchCleanupBlockedError('git branch cleanup: could not determine merge status; not deleted');
    }
    if (!merged) throw new BranchCleanupBlockedError('git branch cleanup: target branch is not merged into main; not deleted');

    // ── 6. SINGLE CAS delete. Phase-aware: Blocked → Blocked; Unverified/other → Unverified. ───────────────
    let result: GitBranchCleanupResult;
    try {
      result = await this.provider.deleteMergedLocalBranch(rootPath, branch, targetCommit);
    } catch (err) {
      if (err instanceof BranchCleanupBlockedError) throw err; // pre-ref-delete — definitively not deleted
      if (err instanceof BranchCleanupUnverifiedError) throw err; // at/after — unknown
      throw new BranchCleanupUnverifiedError('git branch cleanup: could not verify the branch deletion');
    }
    if (result.branch !== branch || result.deleted !== true) {
      throw new BranchCleanupUnverifiedError('git branch cleanup: branch deletion result could not be verified');
    }
    return result;
  }

  /** Convenience: whether the working tree is clean. */
  async isClean(rootPath: string): Promise<boolean> {
    return (await this.provider.status(rootPath)).clean;
  }

  /**
   * Guard for future write capabilities: throw if the tree is dirty. Read-only
   * itself — it only inspects status. (Write/commit remain a future Approval-gated
   * capability.)
   */
  async requireClean(rootPath: string): Promise<void> {
    const status = await this.provider.status(rootPath);
    if (!status.clean) {
      throw new WorkspaceNotSafeError(
        `branch ${status.branch} has uncommitted changes ` +
          `(${status.unstaged.length} unstaged, ${status.untracked.length} untracked)`,
      );
    }
  }
}

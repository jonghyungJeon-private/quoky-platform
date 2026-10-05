import { ApprovalStatus } from '../domain';
import {
  MAX_PR_BODY,
  MAX_PR_TITLE,
  RemoteBranchCleanupBlockedError,
  RemoteBranchCleanupUnverifiedError,
  isSafeGitHubPullRequestUrl,
  isSafeRepoName,
  isSafeRepoOwner,
  isSupportedHostingProvider,
  normalizePrTitle,
} from '../domain';
import type {
  ApprovalRef,
  PullRequestCreationInput,
  PullRequestMergePreflight,
  PullRequestMergeResult,
  PullRequestRef,
  PullRequestResult,
  PullRequestStatusPreview,
  RemoteBranchCleanupResult,
  RepositoryIdentity,
} from '../domain';
import type { RepositoryHostingProvider } from '../ports';
import { isSafePushBranch } from './push-target';

/** SHA-shape guard (mirrors `GitManager.pushApprovedCommit` — Sprint 3a). */
const SHA_SHAPED = /^[0-9a-f]{7,40}$/i;

/**
 * PR creation failed **before any mutating call was made** (approval/input/identity invalid, repository/branch
 * missing, existing-PR lookup unavailable/ambiguous, existing-PR result invalid). Definitively **no** Pull
 * Request was created — a caller may safely say "PR은 만들지 않았어요" (Sprint 3d-D, ADR-0054, CA change 6).
 */
export class RepositoryHostingBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryHostingBlockedError';
  }
}

/**
 * The mutating `createPullRequest` call was **attempted** but could not be completed/verified (request failed
 * after the POST may have reached the provider, or the created result failed integrity). A Pull Request **may**
 * have been created — a caller must **not** claim no PR was created; say "확인하지 못했어요" instead (Sprint
 * 3d-D, ADR-0054, CA change 6).
 */
export class RepositoryHostingUnverifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryHostingUnverifiedError';
  }
}

/**
 * Thin orchestration over a {@link RepositoryHostingProvider} — the RepositoryHosting capability skeleton
 * (CAP-010, ADR-0052 — Sprint 3d-B). **Non-mutating in product runtime:** no real provider is bound; only
 * fake providers in unit tests exercise this. A successful unit test means the Manager boundary behaves
 * correctly with a fake provider — it does **not** mean product PR creation works.
 *
 * The Manager owns approval gating, input validation, provider-kind matching, deterministic title
 * normalization, **call ordering**, existing-PR reuse, the manager-owned `reused` flag, and result-integrity
 * validation (incl. `pullRequestCommitHash === expectedCommitHash`). Mirrors `GitManager`'s Ref-gating: the
 * `ApprovalRef` is consumed here and **never** passed to the provider; the provider receives only the bounded
 * {@link PullRequestCreationInput} (no ApprovalRef/token/raw diff/file content/remote). Raw provider errors are
 * never forwarded — the Manager throws bounded, deterministic capability errors only.
 */
export class RepositoryHostingManager {
  constructor(private readonly provider: RepositoryHostingProvider) {}

  async createPullRequest(input: {
    identity: RepositoryIdentity;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
    expectedCommitHash: string;
    approvalRef: ApprovalRef;
  }): Promise<PullRequestResult> {
    const { identity, headBranch, baseBranch, body, expectedCommitHash, approvalRef } = input;

    // ── Backstop validation BEFORE any provider call (mirrors GitManager). All → BlockedError (no mutation). ─
    if (approvalRef.status !== ApprovalStatus.APPROVED) {
      throw new RepositoryHostingBlockedError(
        `repository hosting: PR creation requires an APPROVED approval (got ${approvalRef.status})`,
      );
    }
    // provider.kind must match identity.provider (CA change 1 / Q10) — a mismatched composition must not run.
    if (this.provider.kind !== identity.provider) {
      throw new RepositoryHostingBlockedError('repository hosting: provider kind does not match identity provider');
    }
    if (!isSupportedHostingProvider(identity.provider)) {
      throw new RepositoryHostingBlockedError('repository hosting: unsupported hosting provider');
    }
    if (!isSafeRepoOwner(identity.owner) || !isSafeRepoName(identity.repo)) {
      throw new RepositoryHostingBlockedError('repository hosting: unsafe repository identity');
    }
    if (!isSafePushBranch(headBranch)) throw new RepositoryHostingBlockedError('repository hosting: unsafe head branch');
    if (!isSafePushBranch(baseBranch)) throw new RepositoryHostingBlockedError('repository hosting: unsafe base branch');
    if (headBranch === baseBranch) {
      throw new RepositoryHostingBlockedError('repository hosting: head and base branch must differ');
    }
    // Deterministic title normalization (CA change 2) — the provider receives the normalized title.
    const title = normalizePrTitle(input.title);
    if (title.length === 0) throw new RepositoryHostingBlockedError('repository hosting: PR title is empty after normalization');
    if (title.length > MAX_PR_TITLE) throw new RepositoryHostingBlockedError('repository hosting: PR title exceeds bound');
    if (typeof body !== 'string' || body.length > MAX_PR_BODY) {
      throw new RepositoryHostingBlockedError('repository hosting: PR body exceeds bound');
    }
    if (!SHA_SHAPED.test(expectedCommitHash)) {
      throw new RepositoryHostingBlockedError('repository hosting: invalid expectedCommitHash');
    }

    const providerInput: PullRequestCreationInput = {
      identity,
      headBranch,
      baseBranch,
      title,
      body,
      expectedCommitHash,
    };

    // ── Ordered read-only hosting-state checks (call ordering, Q6). All failures → BlockedError (no mutation). ─
    if (!(await this.repositoryExists(identity))) {
      throw new RepositoryHostingBlockedError('repository hosting: repository not found on hosting provider');
    }
    if (!(await this.branchExists(identity, headBranch))) {
      throw new RepositoryHostingBlockedError('repository hosting: head branch not found on hosting provider');
    }
    if (!(await this.branchExists(identity, baseBranch))) {
      throw new RepositoryHostingBlockedError('repository hosting: base branch not found on hosting provider');
    }

    // Existing-open-PR lookup (Q8/Q9). If the provider cannot answer (throws) → BLOCK by default (no create).
    let existing: PullRequestResult | null;
    try {
      existing = await this.provider.findOpenPullRequest(identity, headBranch, baseBranch);
    } catch {
      throw new RepositoryHostingBlockedError('repository hosting: could not determine existing pull requests; creation blocked');
    }
    if (existing) {
      // Validate the existing result the same as a new one; commit hash must match expected (CA change 4).
      // An invalid existing result is a pre-mutation BLOCK (no create attempted) — CA change 6.
      try {
        this.assertResultIntegrity(existing, identity, headBranch, baseBranch, expectedCommitHash);
      } catch (err) {
        throw new RepositoryHostingBlockedError(
          err instanceof Error ? err.message : 'repository hosting: existing PR result invalid',
        );
      }
      return { ...existing, reused: true }; // manager-owned reused (CA change 3)
    }

    // ── Single mutating call (only if all checks passed and no existing PR). Failures here → UnverifiedError. ─
    let created: PullRequestResult;
    try {
      created = await this.provider.createPullRequest(providerInput);
    } catch {
      // The POST may have reached the provider — a PR may exist. Do NOT claim it wasn't created.
      throw new RepositoryHostingUnverifiedError('repository hosting: PR creation could not be completed/verified');
    }
    try {
      this.assertResultIntegrity(created, identity, headBranch, baseBranch, expectedCommitHash);
    } catch (err) {
      // Creation was attempted (POST returned) but the result failed integrity — ambiguous, not "no PR".
      throw new RepositoryHostingUnverifiedError(
        err instanceof Error ? err.message : 'repository hosting: PR creation result could not be verified',
      );
    }
    return { ...created, reused: false }; // manager-owned reused (CA change 3)
  }

  /**
   * READ-ONLY point-in-time PR status preview (CAP-010, ADR-0055 — Sprint 3e). No ApprovalRef (read-only). The
   * Manager validates provider.kind + identity + the caller's `PullRequestRef` (provider/owner/repo == identity,
   * safe positive PR number, canonical github.com URL) + safe head/base + SHA-shaped commit BEFORE the provider
   * read, then validates the provider-reported result's integrity against the request. A result whose identity/
   * ref/head/base/commit does not match is a **stale/unattributable** read → throw (the runtime words this as
   * "could not check current status", never "checks failed"). Never mutates; keeps no state.
   */
  async getPullRequestStatus(input: {
    identity: RepositoryIdentity;
    pullRequestRef: PullRequestRef;
    expectedHeadBranch: string;
    expectedBaseBranch: string;
    expectedCommitHash: string;
  }): Promise<PullRequestStatusPreview> {
    const { identity, pullRequestRef, expectedHeadBranch, expectedBaseBranch, expectedCommitHash } = input;
    if (this.provider.kind !== identity.provider) throw new Error('repository hosting: provider kind mismatch');
    if (!isSupportedHostingProvider(identity.provider)) throw new Error('repository hosting: unsupported provider');
    if (!isSafeRepoOwner(identity.owner) || !isSafeRepoName(identity.repo)) {
      throw new Error('repository hosting: unsafe repository identity');
    }
    // PullRequestRef must belong to the identity and carry a safe number + canonical URL (CA change 1).
    if (
      pullRequestRef.provider !== identity.provider ||
      pullRequestRef.owner !== identity.owner ||
      pullRequestRef.repo !== identity.repo
    ) {
      throw new Error('repository hosting: pull request ref identity mismatch');
    }
    if (!Number.isSafeInteger(pullRequestRef.pullRequestNumber) || pullRequestRef.pullRequestNumber <= 0) {
      throw new Error('repository hosting: invalid pull request number');
    }
    if (!isSafeGitHubPullRequestUrl(pullRequestRef.pullRequestUrl, identity, pullRequestRef.pullRequestNumber)) {
      throw new Error('repository hosting: invalid pull request URL');
    }
    if (!isSafePushBranch(expectedHeadBranch)) throw new Error('repository hosting: unsafe head branch');
    if (!isSafePushBranch(expectedBaseBranch)) throw new Error('repository hosting: unsafe base branch');
    if (!SHA_SHAPED.test(expectedCommitHash)) throw new Error('repository hosting: invalid expectedCommitHash');

    let preview: PullRequestStatusPreview;
    try {
      preview = await this.provider.getPullRequestStatus({
        identity,
        pullRequestRef,
        expectedHeadBranch,
        expectedBaseBranch,
        expectedCommitHash,
      });
    } catch {
      throw new Error('repository hosting: could not read pull request status');
    }
    // Result integrity — the provider-reported status must be attributable to THIS approved PR context.
    if (
      preview.ref.provider !== identity.provider ||
      preview.ref.owner !== identity.owner ||
      preview.ref.repo !== identity.repo ||
      preview.ref.pullRequestNumber !== pullRequestRef.pullRequestNumber ||
      preview.ref.pullRequestUrl !== pullRequestRef.pullRequestUrl
    ) {
      throw new Error('repository hosting: status result ref mismatch (stale/unattributable)');
    }
    if (preview.headBranch !== expectedHeadBranch) throw new Error('repository hosting: status head mismatch (stale)');
    if (preview.baseBranch !== expectedBaseBranch) throw new Error('repository hosting: status base mismatch (stale)');
    if (preview.headCommitHash !== expectedCommitHash) throw new Error('repository hosting: status commit mismatch (stale)');
    for (const n of [
      preview.checks.totalCount,
      preview.checks.successCount,
      preview.checks.failureCount,
      preview.checks.pendingCount,
    ]) {
      if (!Number.isInteger(n) || n < 0) throw new Error('repository hosting: invalid status check counts');
    }
    if (preview.checks.state === 'unavailable' && preview.checks.totalCount !== 0) {
      throw new Error('repository hosting: invalid status check counts');
    }
    return preview;
  }

  /**
   * Execute a PR merge (CAP-010, ADR-0057 — Sprint 3g). The first repository-hosting mutation AFTER PR creation.
   * The Manager consumes/validates the `ApprovalRef` (never forwarded to the provider), runs the full LIVE
   * preflight, and makes at most ONE mutating call. Ordering mirrors `createPullRequest`:
   *   1. backstop validation                         → BlockedError (no read, no mutation)
   *   2. getMergePreflight (live read)                → throws → BlockedError ("could not read live state")
   *   3. preflight-result INTEGRITY (ALWAYS)          → mismatch → BlockedError (STALE / mismatched approval context)
   *   4. state: 'merged' → alreadyMerged result (NO mutation; integrity in step 3 guarantees the exact approved
   *      head was merged, CA change 2); 'closed'/'unknown' → BlockedError; 'open' → continue
   *   5. mergeability policy (open only)              → non-MERGEABLE → BlockedError
   *   6. single provider.mergePullRequest             → throws → UnverifiedError (may have merged)
   *   7. merge-result INTEGRITY                       → mismatch → UnverifiedError
   * A KNOWN pre-mutation failure is `RepositoryHostingBlockedError` ("not merged"); any failure at/after the
   * mutating call is `RepositoryHostingUnverifiedError` ("could not verify" — never "not merged").
   */
  async mergePullRequest(input: {
    identity: RepositoryIdentity;
    pullRequestRef: PullRequestRef;
    expectedHeadBranch: string;
    expectedBaseBranch: string;
    expectedHeadSha: string;
    approvalRef: ApprovalRef;
  }): Promise<PullRequestMergeResult> {
    const { identity, pullRequestRef, expectedHeadBranch, expectedBaseBranch, expectedHeadSha, approvalRef } = input;

    // ── 1. Backstop validation BEFORE any provider call. All → BlockedError (definitively no merge). ─────────
    if (approvalRef.status !== ApprovalStatus.APPROVED) {
      throw new RepositoryHostingBlockedError(
        `repository hosting: PR merge requires an APPROVED approval (got ${approvalRef.status})`,
      );
    }
    if (this.provider.kind !== identity.provider) {
      throw new RepositoryHostingBlockedError('repository hosting: provider kind does not match identity provider');
    }
    if (!isSupportedHostingProvider(identity.provider)) {
      throw new RepositoryHostingBlockedError('repository hosting: unsupported hosting provider');
    }
    if (!isSafeRepoOwner(identity.owner) || !isSafeRepoName(identity.repo)) {
      throw new RepositoryHostingBlockedError('repository hosting: unsafe repository identity');
    }
    if (
      pullRequestRef.provider !== identity.provider ||
      pullRequestRef.owner !== identity.owner ||
      pullRequestRef.repo !== identity.repo
    ) {
      throw new RepositoryHostingBlockedError('repository hosting: pull request ref identity mismatch');
    }
    if (!Number.isSafeInteger(pullRequestRef.pullRequestNumber) || pullRequestRef.pullRequestNumber <= 0) {
      throw new RepositoryHostingBlockedError('repository hosting: invalid pull request number');
    }
    if (!isSafeGitHubPullRequestUrl(pullRequestRef.pullRequestUrl, identity, pullRequestRef.pullRequestNumber)) {
      throw new RepositoryHostingBlockedError('repository hosting: invalid pull request URL');
    }
    if (!isSafePushBranch(expectedHeadBranch)) throw new RepositoryHostingBlockedError('repository hosting: unsafe head branch');
    if (!isSafePushBranch(expectedBaseBranch)) throw new RepositoryHostingBlockedError('repository hosting: unsafe base branch');
    if (expectedHeadBranch === expectedBaseBranch) {
      throw new RepositoryHostingBlockedError('repository hosting: head and base branch must differ');
    }
    if (!SHA_SHAPED.test(expectedHeadSha)) throw new RepositoryHostingBlockedError('repository hosting: invalid expectedHeadSha');

    // ── 2. Live pre-merge read IMMEDIATELY before mutation. Any read failure → BlockedError (no mutation yet). ─
    let preflight: PullRequestMergePreflight;
    try {
      preflight = await this.provider.getMergePreflight({
        identity,
        pullRequestRef,
        expectedHeadBranch,
        expectedBaseBranch,
        expectedCommitHash: expectedHeadSha,
      });
    } catch {
      throw new RepositoryHostingBlockedError('repository hosting: could not read live PR merge state; merge not performed');
    }

    // ── 3. Preflight-result INTEGRITY — ALWAYS, regardless of state (CA change 2). Mismatch → Blocked (stale). ─
    if (
      preflight.ref.provider !== identity.provider ||
      preflight.ref.owner !== identity.owner ||
      preflight.ref.repo !== identity.repo ||
      preflight.ref.pullRequestNumber !== pullRequestRef.pullRequestNumber ||
      preflight.ref.pullRequestUrl !== pullRequestRef.pullRequestUrl
    ) {
      throw new RepositoryHostingBlockedError('repository hosting: merge preflight ref mismatch (stale/unattributable); merge not performed');
    }
    if (preflight.headBranch !== expectedHeadBranch) {
      throw new RepositoryHostingBlockedError('repository hosting: merge preflight head branch mismatch (stale); merge not performed');
    }
    if (preflight.baseBranch !== expectedBaseBranch) {
      throw new RepositoryHostingBlockedError('repository hosting: merge preflight base branch mismatch (stale); merge not performed');
    }
    if (preflight.headCommitHash !== expectedHeadSha) {
      throw new RepositoryHostingBlockedError('repository hosting: merge preflight head SHA differs from approved head (stale); merge not performed');
    }

    // ── 4. State branch. 'merged' at the EXACT approved head (step 3 guaranteed) → idempotent, NO mutation. ───
    if (preflight.state === 'merged') {
      return {
        provider: identity.provider,
        owner: identity.owner,
        repo: identity.repo,
        pullRequestNumber: pullRequestRef.pullRequestNumber,
        pullRequestUrl: pullRequestRef.pullRequestUrl,
        merged: true,
        mergedHeadSha: preflight.headCommitHash,
        alreadyMerged: true,
      };
    }
    if (preflight.state !== 'open') {
      throw new RepositoryHostingBlockedError(`repository hosting: PR is not open (state ${preflight.state}); merge not performed`);
    }

    // ── 5. Mergeability policy — ONLY MERGEABLE proceeds; every other value blocks (never merge on uncertainty). ─
    if (preflight.mergeability !== 'MERGEABLE') {
      throw new RepositoryHostingBlockedError(
        `repository hosting: PR is not mergeable (${preflight.mergeability}); merge not performed`,
      );
    }

    // ── 6. SINGLE mutating call. Any throw here → UnverifiedError (the merge MAY have happened). ──────────────
    let result: PullRequestMergeResult;
    try {
      result = await this.provider.mergePullRequest({ identity, pullRequestRef, expectedHeadSha });
    } catch {
      throw new RepositoryHostingUnverifiedError('repository hosting: PR merge could not be completed/verified');
    }

    // ── 7. Merge-result INTEGRITY. A returned-but-inconsistent result is ambiguous → Unverified (not "not merged"). ─
    if (
      result.provider !== identity.provider ||
      result.owner !== identity.owner ||
      result.repo !== identity.repo ||
      result.pullRequestNumber !== pullRequestRef.pullRequestNumber ||
      result.pullRequestUrl !== pullRequestRef.pullRequestUrl ||
      result.merged !== true ||
      result.mergedHeadSha !== expectedHeadSha
    ) {
      throw new RepositoryHostingUnverifiedError('repository hosting: PR merge result could not be verified');
    }
    return { ...result, alreadyMerged: false }; // manager-owned alreadyMerged
  }

  /**
   * Execute a REMOTE branch cleanup (CAP-010, ADR-0060 — Sprint 3j-B). Deletes EXACTLY one remote branch — the
   * anchored, already-merged PR head branch — via the RepositoryHosting provider, ONLY after re-consuming the 3j-A
   * CRITICAL approval + a full live preflight. The Manager consumes/validates the `ApprovalRef` (never forwarded to
   * the provider) and makes at most ONE mutating call. Ordering mirrors `mergePullRequest`:
   *   1. backstop validation                       → BlockedError (no read, no mutation)
   *   2. getMergePreflight (live read)              → throws → BlockedError; not 'merged' / mismatch → BlockedError
   *   3. getRemoteBranchCommit (live read)          → throws → BlockedError; null → idempotent alreadyAbsent (NO delete);
   *                                                    commit != expected → BlockedError (moved; a moved branch is never deleted)
   *   4. single provider.deleteRemoteBranch         → provider Blocked → Blocked; Unverified → Unverified; any OTHER
   *                                                    throw → Unverified (NO blanket-convert). result-integrity → Unverified.
   * A KNOWN pre-DELETE failure is `RemoteBranchCleanupBlockedError` ("not deleted"); any failure at/after the DELETE
   * is `RemoteBranchCleanupUnverifiedError` ("could not verify" — never "not deleted"). GitHub has no atomic
   * SHA-conditional delete, so the provider re-reads the ref immediately before the DELETE and verifies the SHA.
   */
  async deleteRemoteBranch(input: {
    identity: RepositoryIdentity;
    pullRequestRef: PullRequestRef;
    expectedHeadBranch: string;
    expectedBaseBranch: string;
    branch: string;
    expectedCommitHash: string;
    approvalRef: ApprovalRef;
  }): Promise<RemoteBranchCleanupResult> {
    const { identity, pullRequestRef, expectedHeadBranch, expectedBaseBranch, branch, expectedCommitHash, approvalRef } = input;

    // ── 1. Backstop validation BEFORE any provider call. All → BlockedError (definitively no delete). ──────────
    if (approvalRef.status !== ApprovalStatus.APPROVED) {
      throw new RemoteBranchCleanupBlockedError(
        `repository hosting: remote branch cleanup requires an APPROVED approval (got ${approvalRef.status})`,
      );
    }
    if (this.provider.kind !== identity.provider) {
      throw new RemoteBranchCleanupBlockedError('repository hosting: provider kind does not match identity provider');
    }
    if (!isSupportedHostingProvider(identity.provider)) {
      throw new RemoteBranchCleanupBlockedError('repository hosting: unsupported hosting provider');
    }
    if (!isSafeRepoOwner(identity.owner) || !isSafeRepoName(identity.repo)) {
      throw new RemoteBranchCleanupBlockedError('repository hosting: unsafe repository identity');
    }
    if (
      pullRequestRef.provider !== identity.provider ||
      pullRequestRef.owner !== identity.owner ||
      pullRequestRef.repo !== identity.repo
    ) {
      throw new RemoteBranchCleanupBlockedError('repository hosting: pull request ref identity mismatch');
    }
    if (!Number.isSafeInteger(pullRequestRef.pullRequestNumber) || pullRequestRef.pullRequestNumber <= 0) {
      throw new RemoteBranchCleanupBlockedError('repository hosting: invalid pull request number');
    }
    if (!isSafeGitHubPullRequestUrl(pullRequestRef.pullRequestUrl, identity, pullRequestRef.pullRequestNumber)) {
      throw new RemoteBranchCleanupBlockedError('repository hosting: invalid pull request URL');
    }
    if (!isSafePushBranch(expectedHeadBranch)) throw new RemoteBranchCleanupBlockedError('repository hosting: unsafe head branch');
    if (!isSafePushBranch(expectedBaseBranch)) throw new RemoteBranchCleanupBlockedError('repository hosting: unsafe base branch');
    if (!isSafePushBranch(branch)) throw new RemoteBranchCleanupBlockedError('repository hosting: unsafe target branch');
    // Target must be the anchored PR head branch, never the base/default branch.
    if (branch !== expectedHeadBranch) throw new RemoteBranchCleanupBlockedError('repository hosting: target is not the PR head branch');
    if (branch === expectedBaseBranch || branch === 'main') {
      throw new RemoteBranchCleanupBlockedError('repository hosting: never deletes the base/default branch');
    }
    if (!SHA_SHAPED.test(expectedCommitHash)) throw new RemoteBranchCleanupBlockedError('repository hosting: invalid expectedCommitHash');

    // ── 2. Live PR-still-merged/attributable read. Any read failure / mismatch / non-merged → BlockedError. ────
    let preflight: PullRequestMergePreflight;
    try {
      preflight = await this.provider.getMergePreflight({
        identity,
        pullRequestRef,
        expectedHeadBranch,
        expectedBaseBranch,
        expectedCommitHash,
      });
    } catch {
      throw new RemoteBranchCleanupBlockedError('repository hosting: could not read live PR state; remote branch not deleted');
    }
    if (
      preflight.ref.provider !== identity.provider ||
      preflight.ref.owner !== identity.owner ||
      preflight.ref.repo !== identity.repo ||
      preflight.ref.pullRequestNumber !== pullRequestRef.pullRequestNumber ||
      preflight.ref.pullRequestUrl !== pullRequestRef.pullRequestUrl ||
      preflight.headBranch !== expectedHeadBranch ||
      preflight.headCommitHash !== expectedCommitHash
    ) {
      throw new RemoteBranchCleanupBlockedError('repository hosting: PR state not attributable to the approved context; remote branch not deleted');
    }
    if (preflight.state !== 'merged') {
      throw new RemoteBranchCleanupBlockedError(`repository hosting: PR is not merged (state ${preflight.state}); remote branch not deleted`);
    }

    // ── 3. Live remote branch read: absent → idempotent success; SHA mismatch → Blocked (moved). ──────────────
    let remote: { commitHash: string } | null;
    try {
      remote = await this.provider.getRemoteBranchCommit(identity, branch);
    } catch {
      throw new RemoteBranchCleanupBlockedError('repository hosting: could not read remote branch; remote branch not deleted');
    }
    if (!remote) {
      return { provider: identity.provider, owner: identity.owner, repo: identity.repo, branch, deleted: false, alreadyAbsent: true };
    }
    if (remote.commitHash !== expectedCommitHash) {
      throw new RemoteBranchCleanupBlockedError('repository hosting: remote branch moved off the expected commit; remote branch not deleted');
    }

    // ── 4. SINGLE mutating DELETE. Phase-aware: Blocked → Blocked; Unverified/other → Unverified (no blanket-convert). ─
    let result: RemoteBranchCleanupResult;
    try {
      result = await this.provider.deleteRemoteBranch({ identity, branch, expectedCommitHash });
    } catch (err) {
      if (err instanceof RemoteBranchCleanupBlockedError) throw err; // pre-DELETE (provider re-read) — definitively not deleted
      if (err instanceof RemoteBranchCleanupUnverifiedError) throw err; // at/after DELETE — unknown
      throw new RemoteBranchCleanupUnverifiedError('repository hosting: remote branch deletion could not be completed/verified');
    }
    // Result-integrity — a returned-but-inconsistent result is ambiguous → Unverified (never "not deleted").
    const identityOk = result.provider === identity.provider && result.owner === identity.owner && result.repo === identity.repo && result.branch === branch;
    const deletedOk = result.deleted === true && result.alreadyAbsent === false && result.deletedCommitHash === expectedCommitHash;
    const absentOk = result.deleted === false && result.alreadyAbsent === true;
    if (!identityOk || (!deletedOk && !absentOk)) {
      throw new RemoteBranchCleanupUnverifiedError('repository hosting: remote branch deletion result could not be verified');
    }
    return result;
  }

  private async repositoryExists(identity: RepositoryIdentity): Promise<boolean> {
    try {
      return await this.provider.repositoryExists(identity);
    } catch {
      throw new RepositoryHostingBlockedError('repository hosting: could not verify repository existence');
    }
  }

  private async branchExists(identity: RepositoryIdentity, branch: string): Promise<boolean> {
    try {
      return await this.provider.branchExists(identity, branch);
    } catch {
      throw new RepositoryHostingBlockedError('repository hosting: could not verify branch existence');
    }
  }

  /**
   * Validate a PROVIDER-REPORTED result against the request. Not independent hosting verification — it only
   * checks the provider response is internally consistent with what was asked, incl. `pullRequestCommitHash
   * === expectedCommitHash` (CA change 4). Any mismatch fails safe (throws; no fallback create).
   */
  private assertResultIntegrity(
    r: PullRequestResult,
    identity: RepositoryIdentity,
    headBranch: string,
    baseBranch: string,
    expectedCommitHash: string,
  ): void {
    if (r.provider !== identity.provider || r.owner !== identity.owner || r.repo !== identity.repo) {
      throw new Error('repository hosting: result identity mismatch');
    }
    if (r.pullRequestHeadBranch !== headBranch) throw new Error('repository hosting: result head branch mismatch');
    if (r.pullRequestBaseBranch !== baseBranch) throw new Error('repository hosting: result base branch mismatch');
    if (!Number.isInteger(r.pullRequestNumber) || r.pullRequestNumber <= 0) {
      throw new Error('repository hosting: result PR number invalid');
    }
    if (!SHA_SHAPED.test(r.pullRequestCommitHash)) throw new Error('repository hosting: result commit hash invalid');
    if (r.pullRequestCommitHash !== expectedCommitHash) {
      throw new Error('repository hosting: result commit hash does not match expected');
    }
    if (!isSafeGitHubPullRequestUrl(r.pullRequestUrl, identity, r.pullRequestNumber)) {
      throw new Error('repository hosting: result PR URL invalid');
    }
  }
}

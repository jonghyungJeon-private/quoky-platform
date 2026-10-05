/**
 * Repository Hosting domain — identity configuration subset (CAP-010, ADR-0051, Sprint 3d-A).
 *
 * This is the **config-only** subset of the future Repository Hosting capability (ADR-0050): the safe,
 * reviewed source of `provider/owner/repo` a FUTURE PR-creation execution sprint (3d-C) will consume. Sprint
 * 3d-A performs **no** hosting mutation, holds **no** auth token, calls **no** GitHub API, and never exposes a
 * git remote URL — `RepositoryInfo` (CAP-002, ADR-0023) intentionally excludes remote URLs and is unchanged.
 * github.com only; GitHub Enterprise is deferred.
 */

/** Supported hosting providers. `github` only for the first implementation; GitHub Enterprise deferred. */
export type RepositoryHostingProviderKind = 'github';

/** Owner (GitHub login) max length. */
export const MAX_REPO_OWNER = 39;
/** Repository name max length. */
export const MAX_REPO_NAME = 100;

/**
 * A validated, safe repository identity for future PR creation. By construction it carries **no token** and
 * **no remote URL** — it has only `provider`/`owner`/`repo`, so a secret cannot be represented as identity
 * (ADR-0051, Q5). Small immutable value object (mirrors the V2 value-object style).
 */
export interface RepositoryIdentity {
  provider: RepositoryHostingProviderKind;
  owner: string;
  repo: string;
}

/**
 * RAW, pre-validation configuration shape read from the environment (or a future config source). Same three
 * fields as {@link RepositoryIdentity} but UNVALIDATED — it is never handed to Repository Hosting directly; it
 * must pass through `RepositoryIdentityResolver` first (ADR-0051, Q4). `provider` is a plain string here and
 * is validated by the resolver. **No token field.**
 */
export interface RepositoryIdentityConfig {
  provider: string;
  owner: string;
  repo: string;
}

/** True when `p` is a supported hosting provider (`github` only for 3d-A; GHE deferred). */
export function isSupportedHostingProvider(p: unknown): p is RepositoryHostingProviderKind {
  return p === 'github';
}

/**
 * Conservative secret/token detector (ADR-0051, CA change 1). Case-insensitive. Rejects known GitHub token
 * prefixes and obvious credential-like substrings so a token-shaped string can never be accepted as an
 * `owner`/`repo`. **False rejection is acceptable** for identity config (a repo literally named e.g.
 * "token-service" is conservatively rejected — configure it differently).
 */
const SECRET_PREFIXES = ['ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];
const SECRET_SUBSTRINGS = ['token', 'secret', 'password', 'pat_'];
export function looksLikeSecret(value: string): boolean {
  const v = value.toLowerCase();
  return SECRET_PREFIXES.some((p) => v.startsWith(p)) || SECRET_SUBSTRINGS.some((s) => v.includes(s));
}

/**
 * Safe GitHub owner (login): 1..39 chars, alphanumeric with single, non-leading, non-trailing, non-consecutive
 * hyphens (`/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/`). Rejects whitespace/control/`/`/`:`/`@`/`.` and every URL
 * character by construction, plus token-shaped values (ADR-0051, CA changes 1/4).
 */
export function isSafeRepoOwner(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length <= MAX_REPO_OWNER &&
    /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/.test(s) &&
    !looksLikeSecret(s)
  );
}

/**
 * Safe GitHub repository name (conservative for product config): 1..100 chars from `[A-Za-z0-9._-]`; never
 * `.`/`..`; **no leading dot** (CA change 6); **no `.git` suffix** (CA change 5); not token-shaped (CA change
 * 1). Rejects whitespace/control/`/`/`:`/`@` and URL characters by construction.
 */
export function isSafeRepoName(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(s)) return false;
  if (s === '.' || s === '..') return false;
  if (s.startsWith('.')) return false; // CA change 6 — no leading dot for product config
  if (/\.git$/i.test(s)) return false; // CA change 5 — no ".git" suffix (remote-URL/path confusion signal)
  if (looksLikeSecret(s)) return false; // CA change 1 — token-shaped value
  return true;
}

// ─── Sprint 3d-B (ADR-0052) — RepositoryHosting SKELETON types ──────────────────────────────────────────────
// The non-mutating shape a FUTURE PR-creation execution sprint (3d-C+) will use. No adapter, no GitHub API, no
// PR creation exists in 3d-B — only these types + a port + a manager, exercised by fake providers in tests.

/** Bounded PR subject (non-empty required after normalization). */
export const MAX_PR_TITLE = 200;
/** Bounded PR body. */
export const MAX_PR_BODY = 8000;

/**
 * Input to `RepositoryHostingManager.createPullRequest` — assembled (future) from a live `PR_APPROVED` anchor +
 * a configured {@link RepositoryIdentity}. Bounded/sanitized fields ONLY. Deliberately has **no** `ApprovalRef`
 * (that is Manager input, not provider input), **no** token, **no** raw diff, **no** file content, **no** GitHub
 * SDK type, **no** git remote URL, and **no** `pushedRemote` (upstream/remote context belongs to the prior Git
 * push anchor, not to a hosting-provider input) — Sprint 3d-B CA changes 6/7, Q2.
 */
export interface PullRequestCreationInput {
  identity: RepositoryIdentity;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  expectedCommitHash: string;
}

/**
 * PROVIDER-REPORTED pull-request creation/open result — **NOT an independent verification** beyond what the
 * provider returned (mirrors `GitPushResult`, ADR-0048). The Manager validates its integrity against the
 * request (incl. `pullRequestCommitHash === expectedCommitHash`) and finalizes {@link PullRequestResult.reused}
 * by the taken path; it must not overclaim (Q3).
 */
export interface PullRequestResult {
  provider: RepositoryHostingProviderKind;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestHeadBranch: string;
  pullRequestBaseBranch: string;
  pullRequestCommitHash: string;
  /** Manager-owned path semantic: `true` via the existing-open-PR path, `false` via the create path — the
   *  provider-reported value is not trusted (Q3/CA change 3). */
  reused: boolean;
}

/** Durable, repository-scoped handle (a PR number is meaningless without provider/owner/repo — Q4). */
export interface PullRequestRef {
  provider: RepositoryHostingProviderKind;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

/** Pure derivation of a {@link PullRequestRef} from a {@link PullRequestResult} (mirrors `executionPlanRef`). */
export function pullRequestRef(r: PullRequestResult): PullRequestRef {
  return {
    provider: r.provider,
    owner: r.owner,
    repo: r.repo,
    pullRequestNumber: r.pullRequestNumber,
    pullRequestUrl: r.pullRequestUrl,
  };
}

/**
 * Deterministic PR-title normalization (Sprint 3d-B, CA change 2): collapse every whitespace run to a single
 * space and trim. Returns `''` for a non-string or all-whitespace input (the Manager rejects an empty result).
 * The provider receives the NORMALIZED title, never the raw one.
 */
export function normalizePrTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * PR-URL validation (Sprint 3d-B, CA changes 8/9, Q11). Accepts ONLY the canonical github.com PR URL for the
 * given identity + number: `https://github.com/<owner>/<repo>/pull/<number>` — https only, github.com host,
 * exact path, exact owner/repo casing, **no** credentials/userinfo, **no** query string, **no** fragment, **no**
 * percent-encoding, bounded length. GitHub Enterprise is deferred. Implemented as an exact string match against
 * the canonical URL (the identity's owner/repo are already validated safe), with explicit `@`/`?`/`#`/`%` guards
 * documenting the rejected shapes.
 */
export function isSafeGitHubPullRequestUrl(
  url: unknown,
  identity: RepositoryIdentity,
  prNumber: number,
): boolean {
  if (typeof url !== 'string') return false;
  if (url.length === 0 || url.length > 300) return false; // bounded
  if (url.includes('@') || url.includes('?') || url.includes('#') || url.includes('%')) return false; // no creds/query/fragment/percent-encoding
  if (!Number.isInteger(prNumber) || prNumber <= 0) return false;
  return url === `https://github.com/${identity.owner}/${identity.repo}/pull/${prNumber}`;
}

// ─── Sprint 3e (ADR-0055) — read-only Pull Request STATUS PREVIEW types ─────────────────────────────────────
// Point-in-time, provider-reported, bounded status of an existing PR_CREATED PR. NOT a durable verified /
// safe-to-merge state, NOT merge/deploy/release. No raw provider response / token / check logs / review body /
// file paths / diff / file content is ever represented here.

export type PullRequestState = 'open' | 'closed' | 'merged' | 'unknown';
/**
 * `unavailable` = the provider did not let this read see check results (for example the hosting credential lacks
 * check-read permission). It carries zero counts and is a PARTIAL status — never success, never failure, and never a
 * merge signal.
 */
export type PullRequestChecksState = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'unknown' | 'unavailable';
export type PullRequestReviewState = 'approved' | 'changes_requested' | 'commented' | 'none' | 'unknown';

// ─── Sprint 3g (ADR-0057) — PR MERGE EXECUTION preflight + result types ─────────────────────────────────────
// The first repository-hosting mutation AFTER PR creation. Merge is performed ONLY from a live MERGE_APPROVED
// anchor, ONLY after a full live preflight, ONLY via RepositoryHostingManager.mergePullRequest. Never deploy/
// release/branch-delete/force-merge/auto-merge. The normalized mergeability enum keeps the core provider-
// independent — raw provider payloads (e.g. GitHub `mergeable_state`) are mapped to it adapter-side only.

/**
 * Conservative, provider-independent mergeability (ADR-0057). Only `MERGEABLE` may proceed to a merge; every
 * other value blocks (never merge on uncertainty). The adapter maps raw provider fields to this enum; the core
 * never sees a GitHub-specific payload. `STALE_HEAD` = the live head differs from the approved head / PR is
 * behind base; `UNKNOWN` = the provider could not determine mergeability.
 */
export type PullRequestMergeability = 'MERGEABLE' | 'BLOCKED' | 'CONFLICTING' | 'UNKNOWN' | 'STALE_HEAD';

/**
 * A bounded, provider-reported, point-in-time snapshot read IMMEDIATELY before a merge mutation (ADR-0057).
 * Distinct from the read-only {@link PullRequestStatusPreview} (Sprint 3e) — this carries normalized
 * `mergeability` and exists only to drive the merge preflight decision. `observedAt` is generated internally by
 * the adapter at read time (never caller/user-supplied). NOT a durable guarantee.
 */
export interface PullRequestMergePreflight {
  ref: PullRequestRef;
  state: PullRequestState;
  headBranch: string;
  baseBranch: string;
  headCommitHash: string;
  mergeability: PullRequestMergeability;
  /** ISO timestamp generated internally at preflight-read time (adapter/provider clock) — never from user input. */
  observedAt: string;
}

/**
 * PROVIDER-REPORTED merge result — NOT an independent verification beyond what the provider returned (mirrors
 * {@link PullRequestResult}). The Manager validates its integrity against the request (incl. `mergedHeadSha ===
 * expectedHeadSha`) and owns the `alreadyMerged` flag. `merged` is always `true` for a returned result (a
 * failure throws instead). It must not overclaim: merged ≠ deployed/released.
 */
export interface PullRequestMergeResult {
  provider: RepositoryHostingProviderKind;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  merged: true;
  /** The head SHA that was merged — must equal the approved `expectedHeadSha` (Manager-validated). */
  mergedHeadSha: string;
  /** Provider-reported merge commit SHA when the provider returns one; optional. */
  mergeCommitHash?: string;
  /** MANAGER-owned: `true` when the live preflight already showed the exact approved head merged (no new call);
   *  `false` via the single mutating call. The provider-reported value is not trusted (mirrors `reused`). */
  alreadyMerged: boolean;
}

// ─── Sprint 3j-B (ADR-0060) — REMOTE branch cleanup EXECUTION result + phase-aware errors ───────────────────
// The execution half of ADR-0060: from a live REMOTE_BRANCH_CLEANUP_APPROVED anchor, delete EXACTLY one remote
// branch (the anchored merged PR head branch) via the RepositoryHosting capability. GitHub's refs API has NO
// atomic SHA-conditional delete, so the provider reads the ref immediately before the DELETE and verifies the SHA.
// The typed errors live HERE (domain) — Option B (ADR-0060, CA change 6) — so the adapter (which throws them), the
// manager (which instanceof-branches Blocked-vs-Unverified without blanket-converting), and the runtime (which picks
// the composer) all share one location via the core public API, with no provider payload leaking into runtime logic.

/**
 * PROVIDER-REPORTED remote branch cleanup result (Sprint 3j-B, ADR-0060) — NOT an independent verification beyond
 * what the provider did this run. `deleted` is true when a remote ref was deleted; `alreadyAbsent` is true when the
 * branch did not exist (404) — an idempotent no-op. `REMOTE_BRANCH_CLEANED` means the completed PR's REMOTE head ref
 * was deleted (or was already absent) this run — never deployed/released/tagged/local-branch-deleted-this-run.
 */
export interface RemoteBranchCleanupResult {
  provider: RepositoryHostingProviderKind; // 'github'
  owner: string;
  repo: string;
  /** The deleted (or already-absent) remote branch — always the anchored PR head branch, never user-supplied. */
  branch: string;
  /** True when this run deleted a remote ref; false when it was already absent. */
  deleted: boolean;
  /** True when the remote branch did not exist (404) — idempotent no-op. */
  alreadyAbsent: boolean;
  /** The commit the deleted branch pointed at (== the verified expectedCommitHash), when a delete happened. */
  deletedCommitHash?: string;
}

/**
 * Remote branch cleanup failed **before any DELETE was attempted** (approval/preflight invalid, PR not confirmably
 * merged, remote branch moved off the expected SHA). Definitively **no** remote branch was deleted — a caller may
 * safely say "원격 브랜치를 삭제하지 않았어요" (Sprint 3j-B, ADR-0060; mirrors `RepositoryHostingBlockedError`).
 */
export class RemoteBranchCleanupBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteBranchCleanupBlockedError';
  }
}

/**
 * The remote branch `DELETE` was **attempted** but could not be completed/verified (the DELETE returned a non-204
 * ambiguously, threw, or the result failed integrity). The ref **may** be gone — a caller must **not** claim it was
 * not deleted; say "확인하지 못했어요" instead (Sprint 3j-B, ADR-0060; mirrors `RepositoryHostingUnverifiedError`).
 */
export class RemoteBranchCleanupUnverifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteBranchCleanupUnverifiedError';
  }
}

/**
 * A bounded, provider-reported, point-in-time PR status observation (Sprint 3e, ADR-0055). `observedAt` is
 * generated internally by the adapter at read time (never caller/user-supplied). All counts are non-negative
 * integers. This is NOT a durable guarantee; it can change immediately after the response.
 */
export interface PullRequestStatusPreview {
  ref: PullRequestRef;
  state: PullRequestState;
  headBranch: string;
  baseBranch: string;
  headCommitHash: string;
  isDraft?: boolean;
  /**
   * Provider-reported mergeability at read time (display only). NOT a merge gate: a merge always re-reads live state
   * through `getMergePreflight`.
   */
  mergeability?: PullRequestMergeability;
  checks: {
    state: PullRequestChecksState;
    totalCount: number;
    successCount: number;
    failureCount: number;
    pendingCount: number;
  };
  reviews?: {
    state: PullRequestReviewState;
    approvedCount?: number;
    changesRequestedCount?: number;
  };
  /** ISO timestamp generated internally at status-read time (adapter/provider clock) — never from user input. */
  observedAt: string;
}

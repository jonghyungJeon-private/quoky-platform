import { isAttachmentReplyWithheld } from '../attachment-context';
import { type NlItemSource, type NlSelectedCommand } from '../nl-routing/catalog';
import { type SurfaceDecision } from '../surface-grants/surface-gate';
import type { Artifact, ProposedChange, RepositoryIdentity, Session, WorkspaceDiff, WorkspaceRef, WorkspaceRepositoryRefusal } from '../../domain';
import { type TurnHandlerOutcome, type TurnHandlerReply } from '../../ports';
import type { CodeChangePreview, CodeDiffPreview, ExecutionReplyStatus } from '../response-composer';
import { neutralizeLinks } from '../link-neutralizer';
import { normalizeRelativePath } from '../target-scope';
import { type CredentialOverrideGrant } from '../code-generation-context';
import { type CredentialOverrideAnchor } from '../credential-override';
import { type PushMode, parsePushUpstreamRef } from '../code-work/push-target-resolution';
import type { ExecutionOutcomeStatus } from '../execution-orchestrator';
import { MAX_COMMIT_CANDIDATE_FILES, MAX_GIT_REF_DISPLAY } from './intent-words';
import { TURN_HANDLER_STAGES, type ConversationTurnHandler, type TurnHandlerStage } from '../../ports';

/** The dispatch-time grant view of an anchor's grant records (the shape the flow hands `dispatch`). */
export function toDispatchGrants(anchor: CredentialOverrideAnchor): CredentialOverrideGrant[] {
  return anchor.grants.map((g) => ({
    path: g.path, contentSha256: g.contentSha256, detector: g.detector, line: g.line, state: 'CONSUMED' as const,
  }));
}

/** True iff the grants the flow consumed are exactly the grants the dispatched content was prepared under. */
export function sameDispatchGrants(
  consumed: readonly CredentialOverrideGrant[],
  prepared: readonly CredentialOverrideGrant[],
): boolean {
  return (
    consumed.length === prepared.length &&
    consumed.every((g, i) => {
      const p = prepared[i]!;
      return (
        normalizeRelativePath(g.path) === normalizeRelativePath(p.path) &&
        g.contentSha256 === p.contentSha256 &&
        g.detector === p.detector &&
        g.line === p.line &&
        g.state === p.state
      );
    })
  );
}

/** The turn's session copy without one metadata key (mirrors a field-scoped removal already saved on the live row). */
export function withoutSessionMetadataKey(session: Session, key: string): Session {
  if (session.metadata?.[key] === undefined) return session;
  const metadata = { ...session.metadata };
  delete metadata[key];
  const { metadata: _previous, ...rest } = session;
  return Object.keys(metadata).length > 0 ? { ...rest, metadata } : rest;
}

/**
 * A deeply-frozen, plain-data copy of a turn-handler context value (ADR-0096 D1). Arrays and plain objects are
 * copied recursively and frozen; primitives pass through; any other value (function, class instance, Map, Date,
 * a cyclic back-reference) is omitted — the domain values handed to handlers are plain data by construction, so
 * nothing is lost, and nothing a handler does to its copy can reach the runtime's own objects.
 */
export function frozenPlainSnapshot<T>(value: T): T {
  const seen = new WeakSet<object>();
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (seen.has(v)) return undefined;
    if (Array.isArray(v)) {
      seen.add(v);
      const out = Object.freeze(v.map((item) => copy(item)));
      seen.delete(v);
      return out;
    }
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== null) return undefined;
    seen.add(v);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      const item = copy((v as Record<string, unknown>)[key]);
      if (item !== undefined) out[key] = item;
    }
    seen.delete(v);
    return Object.freeze(out);
  };
  return copy(value) as T;
}

/**
 * ADR-0118 D7 (final sign-off W-1) and the owner decision of 2026-10-15: the one credential check of a document summary
 * draft — the raw reply and every artifact, then the display-normalized reply. It decides both that a draft is withheld
 * and that a flagged draft is not regenerated.
 */
export function documentSummaryCredentialShaped(text: string, artifacts: readonly Artifact[]): boolean {
  return isAttachmentReplyWithheld(text, artifacts) || isAttachmentReplyWithheld(neutralizeLinks(text, 'display'), []);
}

/**
 * Defensively normalize a git-status path to a safe project-relative path, or `null` when it is absolute,
 * contains a `..` traversal, is empty, or is otherwise not safely representable (Sprint 2x, CA #6). A `null`
 * path is never trusted — the caller surfaces it as out-of-scope and refuses to create a commit approval.
 */
export function safeRelativePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) return null; // absolute (POSIX `/…` or Windows `C:\…`)
  const normalized = normalizeRelativePath(trimmed);
  if (normalized.length === 0) return null;
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) return null;
  return normalized;
}

/**
 * Compose the HIGH commit-approval `reason` string (Sprint 2x, ADR-0045, CA #4/#11). Names the operation,
 * workspace, bounded candidate files, commit message, validation context, and that this records permission
 * only — actual git add/commit/push is NOT executed in Sprint 2x. NO raw diff / file content.
 */
export function buildCommitApprovalReason(
  workspaceRef: WorkspaceRef,
  candidateFiles: string[],
  commitMessage: string,
  validation: { command: string; status: string } | 'unavailable' | 'none',
  newFiles: readonly string[] = [],
): string {
  const shown = candidateFiles.slice(0, MAX_COMMIT_CANDIDATE_FILES);
  const omitted = candidateFiles.length - shown.length;
  // ADR-0099 D3: a new file is marked so the approval covers the `git add` it implies.
  const isNew = new Set(newFiles);
  const files = `${shown.map((f) => (isNew.has(f) ? `${f} (new file)` : f)).join(', ')}${omitted > 0 ? ` (외 ${omitted}개 생략)` : ''}`;
  const validationText =
    validation === 'none'
      ? 'no post-apply validation on record'
      : validation === 'unavailable'
        ? 'validation record could not be resolved'
        : `latest validation: ${validation.command} ${validation.status}`;
  return [
    'operation: git commit approval planning',
    `workspaceRef: ${workspaceRef.id}`,
    `candidate files: ${files}`,
    `proposed commit message: ${commitMessage}`,
    validationText,
    'risk: HIGH',
    'no git add/commit/push has been performed',
    'this approval records permission only; actual git add/commit/push is NOT executed in Sprint 2x — future execution requires a separate step',
  ].join('\n');
}

/** Bound + strip a user-controllable git ref for display (Sprint 2z, CA #6) — trims, drops control chars,
 *  caps length. Never lets a raw/unbounded/control-char branch string reach a reason or reply. */
export function boundGitRef(ref: string): string {
  return [...ref.trim()].filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f).join('').slice(0, MAX_GIT_REF_DISPLAY);
}

/** The outcome of resolving the repository a remote step targets (ADR-0109 D2). */
export type HostingIdentityLookup =
  | { ok: true; identity: RepositoryIdentity }
  | { ok: false; refusal?: WorkspaceRepositoryRefusal | 'target-changed'; hint?: string };

/** Exact provider/owner/repo equality of two repository identities (ADR-0109: anchored vs freshly resolved). */
export function sameRepositoryIdentity(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.provider === b.provider && a.owner === b.owner && a.repo === b.repo;
}

/**
 * Split + validate an upstream tracking ref into `<remote>/<branch>` on the FIRST '/' (Sprint 2z, ADR-0047,
 * CA #5). Returns `null` (→ block approval) when the ref is empty, over-long, has control chars, has no
 * '/', or has an empty remote/branch, or a remote containing whitespace. `branch` may contain '/' (e.g.
 * `feature/x`). Read-only; no git call.
 */
export function parsePushUpstream(upstream: string): { remote: string; branch: string } | null {
  // ADR-0099 D5: one parser for approval, execution and the PR step (the pure push-target resolver's).
  return parsePushUpstreamRef(upstream);
}

/**
 * Compose the CRITICAL push-approval `reason` (Sprint 2z, ADR-0047, CA #4/#6/#7/#13). Names the operation,
 * commit sha, bounded remote/branch/upstream, ahead count, that NO push has run, that this records
 * permission only (NOT executed in Sprint 2z; future execution needs a separate step), and the point-in-time
 * caveat. NO raw diff/file content and NO validation/test "push-ready" context (CA #13).
 */
export function buildPushApprovalReason(input: {
  commitHash: string;
  remote: string;
  branch: string;
  upstream: string;
  ahead?: number;
  mode?: PushMode;
  /** ADR-0109: the bound repository (only when the per-workspace resolver is configured). */
  repository?: RepositoryIdentity;
}): string {
  const target =
    input.mode === 'new-remote-branch'
      ? [
          'mode: new remote branch (the branch has no upstream; the first push creates it on the remote)',
          `remote: ${boundGitRef(input.remote)}`,
          `branch: ${boundGitRef(input.branch)}`,
          `creates: ${boundGitRef(input.upstream)}`,
          'no force push; no upstream (tracking) configuration; no fetch',
        ]
      : [
          `remote: ${boundGitRef(input.remote)}`,
          `branch: ${boundGitRef(input.branch)}`,
          `upstream: ${boundGitRef(input.upstream)}`,
          `ahead: ${input.ahead ?? 0}`,
        ];
  return [
    'operation: git push approval planning',
    `commit: ${input.commitHash}`,
    ...(input.repository ? [`repository: ${boundGitRef(input.repository.owner)}/${boundGitRef(input.repository.repo)}`] : []),
    ...target,
    'risk: CRITICAL',
    'no git push has been performed',
    'this approval records permission only; actual git push is NOT executed in Sprint 2z — future execution requires a separate step',
    'this is a point-in-time snapshot; the branch is not guaranteed pushable later — future push execution must re-read Git state before pushing',
  ].join('\n');
}

/**
 * Bounded CRITICAL PR-creation approval reason (Sprint 3b, ADR-0049, CA #6/#12). No diff/file content/paths.
 * ADR-0108 D5: records the exact title and the SHA-256 of (title, body) the approval covers (audit only — the
 * anchor's structured `prContentHash` is the authority; this text is never parsed). Explicitly states no PR
 * created / no deployment / no merge / permission-only / not-in-3b / future repository-hosting step, and the
 * "not verified on hosting, not guaranteed creatable" discipline.
 */
export function buildPrApprovalReason(input: {
  pushedCommitHash: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  contentHash: string;
  owner?: string;
  repo?: string;
}): string {
  return [
    'operation: pull request creation approval planning',
    // Target repository for human review (Sprint 3d-D) — owner/repo only, NEVER a token. Structured anchor
    // fields (anchor.repositoryIdentity) are the authority; this reason text is NOT parsed later (CA change 10).
    ...(input.owner && input.repo ? [`repository: ${boundGitRef(input.owner)}/${boundGitRef(input.repo)}`] : []),
    `pushed commit: ${input.pushedCommitHash}`,
    `head: ${boundGitRef(input.headBranch)}`,
    `base: ${boundGitRef(input.baseBranch)}`,
    `title: ${input.title}`,
    `title/body sha256: ${input.contentHash}`,
    'risk: CRITICAL',
    'no pull request has been created',
    'no deployment has been performed',
    'no merge has been performed',
    'this approval records permission only',
    'actual PR creation is NOT performed in Sprint 3b',
    'future execution requires a separate repository-hosting step',
    'creating a PR mutates shared collaboration state (CI, notifications, reviews, branch protections, automations)',
    'approval is based on the pushed context currently recorded by Quoky Platform; it does not verify the branch on the hosting provider and does not guarantee a PR can be created',
  ].join('\n');
}

/**
 * Deterministic bounded PR MERGE-APPROVAL reason (Sprint 3f, ADR-0056). Records permission-only intent for a
 * specific PR context — owner/repo/PR number/URL/head/base/short commit/pr-source — and explicitly states no
 * merge/deploy/release was performed and that the approval does NOT verify checks/reviews/mergeability/safety.
 * NO token / raw diff / file content / check logs / review body / full GitHub response. Never parsed later.
 */
export function buildMergeApprovalReason(input: {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  headBranch: string;
  baseBranch: string;
  commitHash: string;
  reused: boolean;
}): string {
  return [
    'operation: pull request merge approval planning',
    `repository: ${boundGitRef(input.owner)}/${boundGitRef(input.repo)}`,
    `pull request: #${input.prNumber} ${input.prUrl.slice(0, MAX_GIT_REF_DISPLAY)}`,
    `head: ${boundGitRef(input.headBranch)}`,
    `base: ${boundGitRef(input.baseBranch)}`,
    `commit: ${input.commitHash.slice(0, 7)}`,
    `pr source: ${input.reused ? 'connected-existing' : 'created'}`,
    'risk: CRITICAL',
    'no merge has been performed',
    'no deployment has been performed',
    'no release has been performed',
    'this approval records permission only',
    'actual merge execution is NOT performed in Sprint 3f and requires a separate repository-hosting step',
    'merge is not guaranteed safe or mergeable by this approval; checks/reviews/hosting state are not verified',
  ].join('\n');
}

/**
 * Build the CRITICAL remote-branch-cleanup approval reason (Sprint 3j-A, ADR-0060). States ONLY the requested
 * permission TARGET — repository, PR, the anchored remote head branch, and the expected head commit — plus the
 * risk and the permission-only disclaimers (CA change 4). It must NOT claim the branch currently exists, that its
 * SHA is still the expected one, that the PR is still merged, or that the delete will succeed / is safe now — those
 * are live execution checks for Sprint 3j-B. Deterministic; never parsed back.
 */
export function buildRemoteBranchCleanupApprovalReason(input: {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  expectedHeadCommit: string;
}): string {
  return [
    'operation: remote branch cleanup approval planning',
    `repository: ${boundGitRef(input.owner)}/${boundGitRef(input.repo)}`,
    `pull request: #${input.prNumber} ${input.prUrl.slice(0, MAX_GIT_REF_DISPLAY)}`,
    `remote head branch (target): ${boundGitRef(input.branch)}`,
    `expected head commit: ${input.expectedHeadCommit.slice(0, 7)}`,
    'risk: CRITICAL',
    'no remote branch has been deleted',
    'no deployment has been performed',
    'no release has been performed',
    'this approval records permission only',
    'actual remote branch deletion is NOT performed in Sprint 3j-A and requires a separate 3j-B execution step',
    'branch existence, current commit, PR merged state, and delete safety are NOT asserted by this approval; they are verified live at execution',
  ].join('\n');
}

/** Map an Execution Orchestrator outcome status to the ResponseComposer reply status. */
export function toReplyStatus(status: ExecutionOutcomeStatus): ExecutionReplyStatus {
  return status as unknown as ExecutionReplyStatus; // identical string values (ADR-0032)
}

/**
 * Split a proposal into in-scope changes (path normalizes to a validated targetFiles entry) and
 * everything else, reported as a warning and never read/rendered as content (AI Code Generation
 * Preview, ADR-0038; Unified Diff Preview, ADR-0039). AI-proposed paths are untrusted; targetFiles is
 * the authoritative scope. Exported (not a private class method) so it is directly unit-testable,
 * matching `target-scope.ts`'s pattern.
 *
 * Preserves each in-scope `ProposedChange`'s `delete`/`newContent` shape exactly as given — spreads
 * `change` and overrides only `path`, never reconstructing a new object that could default a field the
 * AI's proposal didn't carry (Sprint 2r, ADR-0039, CA Round 1 Required Change #6).
 */
export function filterInScopeChanges(
  proposal: ProposedChange[],
  targetFiles: string[],
): { inScope: ProposedChange[]; outOfScopeWarnings: string[] } {
  const normalizedTargets = new Map(targetFiles.map((p) => [normalizeRelativePath(p), p]));
  const inScope: ProposedChange[] = [];
  const outOfScopeWarnings: string[] = [];
  for (const change of proposal) {
    const validatedPath = normalizedTargets.get(normalizeRelativePath(change.path));
    if (!validatedPath) {
      outOfScopeWarnings.push(change.path);
      continue;
    }
    inScope.push({ ...change, path: validatedPath }); // validated value, never the AI's raw path
  }
  return { inScope, outOfScopeWarnings };
}

/** Sprint 2q's original filtering + text-excerpt shaping (ADR-0038) — now a thin wrapper over
 *  {@link filterInScopeChanges}. Signature/behavior unchanged; retained for compatibility (ADR-0039). */
export function toCodeChangePreview(proposal: ProposedChange[], targetFiles: string[]): CodeChangePreview {
  const { inScope, outOfScopeWarnings } = filterInScopeChanges(proposal, targetFiles);
  const changes: CodeChangePreview['changes'] = inScope.map((c) => ({
    path: c.path,
    kind: c.delete ? 'delete' : 'update',
    ...(c.delete ? {} : { excerpt: c.newContent }),
  }));
  return { changes, outOfScopeWarnings };
}

/**
 * Shape an already-guarded `WorkspaceManager.diff()` result into the composer-facing DTO (Sprint 2r,
 * ADR-0039). Pure data reshaping — no bounding/truncation-notice text here; `ResponseComposer` owns
 * that (ADR-0032). Callers must have already rejected an empty `diff.files` before calling this, and any
 * `changeKind: 'add'` entry must already have passed the explicit-new-file + non-existence guard (F3-A,
 * Sprint 4c-Follow-up-3) — an `add` here is a confirmed new-file preview, rendered against empty content.
 */
export function toCodeDiffPreview(diff: WorkspaceDiff, outOfScopeWarnings: string[]): CodeDiffPreview {
  const changes: CodeDiffPreview['changes'] = diff.files.map((f) => ({
    path: f.path, // already the validated targetFiles value passed into workspace.diff
    // 'modify' -> 'update'; 'add' is a guarded new-file preview (F3-A); 'delete' unchanged.
    kind: f.changeKind === 'delete' ? 'delete' : f.changeKind === 'add' ? 'add' : 'update',
    unified: f.unified, // '' when binary or size-skipped by the provider
    binary: f.binary,
    // ADR-0099 D1 byte bounds for the apply-capable footer; only when the provider reported them.
    ...(f.oldSize !== undefined ? { oldSize: f.oldSize } : {}),
    ...(f.newSize !== undefined ? { newSize: f.newSize } : {}),
  }));
  return { changes, outOfScopeWarnings };
}

/** The item source of an A6 receipt (the entry's family, or the resolved target's source). */
export function nlActionReceiptSource(command: NlSelectedCommand): NlItemSource | undefined {
  if (command.entryId.startsWith('todo.')) return 'todo';
  if (command.entryId.startsWith('reminder.')) return 'reminder';
  return command.target?.source;
}

/** ADR-0122 D2.5: thrown inside a connector-write execution claim when the live grant no longer allows the write. */
export class SurfaceDeniedError extends Error {
  constructor(readonly decision: Extract<SurfaceDecision, { allow: false }>) {
    super('SURFACE_DENIED');
    this.name = 'SurfaceDeniedError';
  }
}

/** ADR-0120 A6-D3 amendment (2026-11-03): thrown inside a connector-write execution claim when the kill switch is stopped. */
export class ActionStoppedError extends Error {
  constructor() {
    super('ACTION_STOPPED');
    this.name = 'ActionStoppedError';
  }
}

/**
 * Owner decision B (2026-10-22): the confirmation a handler reply asks the owner for, when it is to be kept as the open
 * question: only a deterministic reply that did not fail (a FAILED reply asks nothing; a summary or write draft carries
 * none). Pure.
 */
export function nlConfirmToRecord(handled: TurnHandlerOutcome): TurnHandlerReply['nlConfirm'] {
  if (handled.kind === 'summarize' || handled.kind === 'write-draft' || handled.status === 'FAILED') return undefined;
  return handled.nlConfirm;
}

/** Owner decision of 2026-10-28: a small in-memory map of shown item words (at most 256 sessions, oldest dropped first). */
export class BoundedShownItems {
  private readonly map = new Map<string, { readonly turnId: string; readonly words: readonly string[]; readonly titles: readonly string[] }>();
  get(key: string): { readonly turnId: string; readonly words: readonly string[]; readonly titles: readonly string[] } | undefined {
    return this.map.get(key);
  }
  set(key: string, value: { readonly turnId: string; readonly words: readonly string[]; readonly titles: readonly string[] }): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > 256) this.map.delete(this.map.keys().next().value as string);
  }
}

/**
 * Codex review of 7f7e8d32: the held item words attach to a `lastSelection` only when they were taken from the very turn
 * that recorded it (the same turn id). Inbound turns run concurrently: a listing that finishes after another overwrites
 * the held words, and a completion-time check would then attach them to the other listing's record. Pure.
 */
export function nlHeldItemWordsFor(
  held: { readonly turnId: string; readonly words: readonly string[] } | undefined,
  last: { readonly turnId?: string },
): readonly string[] | undefined {
  return held !== undefined && last.turnId !== undefined && held.turnId === last.turnId ? held.words : undefined;
}

/**
 * Validate and order the turn-handler registry (ADR-0096 D2): a known stage, a finite order and a non-empty id
 * unique across the registry, else construction fails; sorted by `(stage, order, id)` with stages in
 * `TURN_HANDLER_STAGES` order and ids compared by code unit (locale-independent).
 */
export function orderTurnHandlers(handlers: readonly ConversationTurnHandler[]): ConversationTurnHandler[] {
  const seen = new Set<string>();
  for (const handler of handlers) {
    if (typeof handler.id !== 'string' || handler.id.length === 0) {
      throw new Error('conversation turn handler id must be a non-empty string');
    }
    if (seen.has(handler.id)) throw new Error(`duplicate conversation turn handler id: ${handler.id}`);
    seen.add(handler.id);
    if (!TURN_HANDLER_STAGES.includes(handler.stage)) {
      throw new Error(`conversation turn handler ${handler.id} has an unknown stage`);
    }
    if (!Number.isFinite(handler.order)) {
      throw new Error(`conversation turn handler ${handler.id} has a non-finite order`);
    }
  }
  const stageIndex = (stage: TurnHandlerStage): number => TURN_HANDLER_STAGES.indexOf(stage);
  return [...handlers].sort(
    (a, b) =>
      stageIndex(a.stage) - stageIndex(b.stage) ||
      a.order - b.order ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

import { ApprovalStatus, PatchStatus, WorkspaceChangeStatus } from '../../domain';
import type {
  ExecutionPlanRef,
  GitStatus,
  Id,
  PatchOperation,
  PatchRef,
  PatchSet,
  WorkspaceChange,
  WorkspaceDiff,
  WorkspaceRef,
} from '../../domain';
import { isSecretLookingFileName } from '../secret-file-name';
import { blankFencedCode, extractMentionedPathTokens, extractTargetPathCandidates, normalizeRelativePath } from '../target-scope';

/**
 * Bounded code change sets (ADR-0099 D1–D3). Pure helpers the conversational code-change flow uses so its
 * runtime hunks stay small: target collection, the patch-time diff check, the apply-time PatchSet check, the
 * applied-result check and the commit-time candidate partition. No I/O except the caller-supplied lookup in
 * {@link collectCodeChangeTargets}; nothing here writes, runs git or talks to a provider.
 *
 * These bounds are this module's own; they are deliberately NOT the ADR-0097 code-generation context caps
 * (`code-generation-context.ts`), even where the numbers happen to match.
 */

/** Most files one code-change request may name and one change set may carry (ADR-0099 D1). */
export const MAX_CHANGE_SET_FILES = 5;
/** Per-file byte bound for a change set, on the current and the proposed content (ADR-0099 D1). */
export const MAX_CHANGE_SET_FILE_BYTES = 64 * 1024;
/** Total proposed bytes for one change set (ADR-0099 D1). */
export const MAX_CHANGE_SET_TOTAL_BYTES = 256 * 1024;

/** The persisted scope facts of an apply-preview anchor that the change-set checks read. */
export interface ChangeSetScope {
  readonly targetFiles: readonly string[];
  /** Paths the owner explicitly asked to create (ADR-0062 wording). Absent on a pre-ADR-0099 anchor → []. */
  readonly newFileTargets?: readonly string[];
}

/** The anchor facts {@link validateChangeSetForApply} binds a loaded PatchSet to. */
export interface ChangeSetApplyAnchor extends ChangeSetScope {
  readonly patchRef?: PatchRef;
  readonly approvalId?: Id;
  readonly executionPlanRef: ExecutionPlanRef;
  readonly workspaceRef?: WorkspaceRef;
}

export type ChangeSetCheck<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

function normalizedSet(paths: readonly string[] | undefined): Set<string> {
  return new Set((paths ?? []).map((p) => normalizeRelativePath(p)));
}

// ── Target collection (ADR-0099 D1) ─────────────────────────────────────────────────────────────────

/** URLs are links, not project paths: `https://host/a/b.md` must never become a target candidate. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]*/gi;
/** One inline code span (single backticks, one line). */
const INLINE_CODE_PATTERN = /`([^`\n]*)`/g;
/** An inline code span whose whole content is ONE path-shaped token (`src/a.ts`, `test.js`) — a quoted file name. */
const QUOTED_PATH_TOKEN = /^\s*[\w@.~/\\-]+\s*$/;

/**
 * The request text with code and URLs blanked out, for target-path extraction only (never the AI instruction). The
 * same rule for slash-bearing and bare root-level paths:
 * - fenced code blocks (``` or ~~~, 3+ characters, any info string — `blankFencedCode`, shared with
 *   `extractMentionedPathTokens`) are pasted content: an `import './lib/x.js'` in a snippet is never a target;
 * - an inline code span is a quoted file NAME only when its whole content is one path-shaped token (`` `test.js` ``);
 *   any other span (`` `res.json()` ``, `` `import x from 'util.js'` ``) is code and is blanked;
 * - URLs are links, never project paths.
 */
export function targetExtractionText(text: string): string {
  return blankFencedCode(text)
    .replace(INLINE_CODE_PATTERN, (span, inner: string) =>
      QUOTED_PATH_TOKEN.test(inner) ? ` ${inner} ` : ' '.repeat(span.length))
    .replace(URL_PATTERN, ' ');
}

/**
 * The first path the owner typed that is NOT a safe project-relative path (ADR-0099 D1): absolute (`/…`, a
 * drive letter), home-relative (`~/…`), containing a `..` segment, or with a dot-leading first segment other
 * than a plain `./` (`.github/…`, `./.env/…`) — counted only for a file-like token (2+ segments or a `.ext`
 * leaf), so a slash command such as `/preview` is not a path. `mentioned` are the raw typed tokens
 * (`extractMentionedPathTokens`). An unsafe path is refused as a TARGET, never rewritten into one — see
 * {@link extractSafeTargetCandidates}, which drops it before candidate extraction.
 */
export function firstUnsafeMentionedPath(mentioned: readonly string[]): string | null {
  return mentioned.find(isUnsafeMentionedPath) ?? null;
}

/** One maximal path-shaped run — the same token alphabet as `extractMentionedPathTokens`. */
const PATH_RUN_PATTERN = /[\w@.~/-]+/g;

/**
 * The safe target candidates of a code-change request plus the unsafe paths the owner typed (ADR-0099 D1).
 * Fenced code and URLs are blanked ({@link targetExtractionText}); every typed unsafe path
 * ({@link firstUnsafeMentionedPath}'s rule) is then blanked too, so the candidate extractor can never start
 * matching after its unsafe prefix and rewrite it into an in-project target (`/etc/x.ts` → `etc/x.ts`,
 * `../a/x.ts` → `a/x.ts`, `.github/x.yml` → `github/x.yml`, `~/.config/x.json` → `config/x.json`).
 *
 * An unsafe path is refused as a target, NOT the whole request: an API route, log path or import specifier in
 * the instruction prose (`src/routes.ts 에 /api/v1/users 라우트 추가해줘`) leaves the safe named target intact.
 * The caller refuses with the typed unsafe path only when no safe candidate is left. Candidates are the slash-bearing
 * project-relative paths plus bare repository-root filenames (`test.js`, `package.json` — QA-V2-CL-01), in order of
 * appearance. Pure; no I/O.
 */
export function extractSafeTargetCandidates(text: string): { candidates: string[]; unsafe: string[] } {
  const unsafe = extractMentionedPathTokens(text).filter(isUnsafeMentionedPath);
  const extractionText = targetExtractionText(text);
  if (unsafe.length === 0) return { candidates: orderedTargetCandidates(extractionText), unsafe };
  const blocked = new Set(unsafe);
  const masked = extractionText.replace(PATH_RUN_PATTERN, (run) =>
    blocked.has(run.replace(/\.+$/, '')) ? ' '.repeat(run.length) : run,
  );
  return { candidates: orderedTargetCandidates(masked), unsafe };
}

/**
 * Root-level file extensions a bare filename (no `/`) may carry to count as a named target (QA-V2-CL-01). Source,
 * config and doc files only: a version (`v1.2.3`), an abbreviation (`e.g.`), a domain (`example.com`) or a method
 * call (`console.log`) never ends in one of these.
 */
const BARE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'json5', 'md', 'mdx', 'txt', 'yml', 'yaml',
  'toml', 'ini', 'cfg', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql',
  'graphql', 'gql', 'prisma', 'proto',
]);

/** Technology names spelled like a `.js` file ("Node.js", "Next.js", "Vue.js") — prose, never a bare target. */
const TECHNOLOGY_JS_NAMES: ReadonlySet<string> = new Set([
  'node', 'next', 'nuxt', 'nest', 'vue', 'react', 'preact', 'solid', 'svelte', 'angular', 'ember', 'backbone',
  'express', 'koa', 'fastify', 'hapi', 'deno', 'bun', 'three', 'd3', 'chart', 'p5', 'pixi', 'babylon', 'alpine',
  'socket', 'moment', 'knockout', 'meteor', 'gatsby', 'remix', 'electron', 'anime', 'riot', 'mithril', 'polymer',
]);

/**
 * Language receiver keywords (`this`, `self`, `super`). A dotted token that starts with one (`this.res.json`) is a
 * member chain — the `res.json` part follows a `.` — never a file name. These are keywords, not a name heuristic: no
 * project file is named `this.<…>`.
 */
const RECEIVER_KEYWORDS: ReadonlySet<string> = new Set(['this', 'self', 'super']);

/**
 * A bare root-level filename (`test.js`, `package.json`, `README.md`): not preceded by an identifier character
 * (`\w`, `$`), a dot or `->` (a member access such as `obj.res.json` / `obj->config.json`), `~`, `:`, `@`, a slash or
 * a backslash (a dot-file, Windows or absolute spelling is never rewritten into a root file), and not followed by a
 * path character. A Korean particle may follow directly (`test.js와`, `test.js에`). A match that is a method call is
 * rejected separately ({@link isCallAfterToken}).
 */
const BARE_FILE_PATTERN = /(?<![\w$./\\~:@-])(?<!->)[A-Za-z0-9_][\w.-]*\.([A-Za-z][A-Za-z0-9]*)(?![\w$/\\-])/g;

/** Upper bound on the generic-argument run {@link isCallAfterToken} scans (`<Array<Array<string>>>`). */
const MAX_GENERIC_SCAN = 200;

/**
 * Whether the text right after a `name.ext` token makes it a method call or member chain — code, never a file:
 * optional whitespace, an optional BALANCED generic-argument list (`<T>`, `<Array<Array<string>>>`; depth-counted,
 * bounded by {@link MAX_GENERIC_SCAN}; an unbalanced or over-long run is not a call), optional whitespace, an optional
 * `?.`, then `(` — `res.json()`, `res.json ()`, `res.json<T>()`, `res.json?.()` — or an optional-chaining
 * continuation directly after the token (`res.json?.data`).
 */
function isCallAfterToken(after: string): boolean {
  if (after.startsWith('?.')) return true;
  let i = 0;
  const skipSpace = (): void => {
    while (i < after.length && /\s/.test(after[i] ?? '')) i += 1;
  };
  skipSpace();
  if (after[i] === '<') {
    let depth = 0;
    const limit = Math.min(after.length, i + MAX_GENERIC_SCAN);
    let closed = false;
    for (; i < limit; i += 1) {
      const ch = after[i];
      if (ch === '<') depth += 1;
      else if (ch === '>') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          closed = true;
          break;
        }
      } else if (ch === '(' || ch === ')' || ch === '\n') {
        return false;
      }
    }
    if (!closed) return false;
    skipSpace();
  }
  if (after.startsWith('?.', i)) {
    i += 2;
    skipSpace();
  }
  return after[i] === '(';
}

/**
 * Bare root-level filename candidates with their positions (QA-V2-CL-01, ADR-0099 D1 "every safe named path").
 * ADR-0036's slash-only extractor ({@link extractTargetPathCandidates}) left a repository-root file untargetable —
 * `src/greet.js 와 test.js 에 …` silently dropped `test.js`. A bare name counts only with a source/config/doc
 * extension and is never a technology name; it is still only a CANDIDATE — existence is verified by the caller.
 */
function bareRootFileCandidates(text: string): Array<{ index: number; path: string }> {
  const out: Array<{ index: number; path: string }> = [];
  for (const match of text.matchAll(BARE_FILE_PATTERN)) {
    const token = match[0];
    const extension = (match[1] ?? '').toLowerCase();
    if (!BARE_FILE_EXTENSIONS.has(extension)) continue;
    const stem = token.slice(0, token.length - extension.length - 1).toLowerCase();
    if (extension === 'js' && TECHNOLOGY_JS_NAMES.has(stem)) continue;
    if (stem.includes('.') && RECEIVER_KEYWORDS.has(stem.split('.')[0] ?? '')) continue; // `this.res.json`
    const index = match.index ?? 0;
    if (isCallAfterToken(text.slice(index + token.length))) continue;
    out.push({ index, path: token });
  }
  return out;
}

/**
 * Every safe target candidate in order of appearance: the slash-bearing project-relative paths
 * ({@link extractTargetPathCandidates}, ADR-0036) merged with bare root-level filenames ({@link bareRootFileCandidates}).
 * `text` is already URL/fence-blanked and unsafe-masked. Pure; no I/O.
 */
function orderedTargetCandidates(text: string): string[] {
  const located: Array<{ index: number; path: string }> = [];
  let from = 0;
  for (const path of extractTargetPathCandidates(text)) {
    const index = text.indexOf(path, from);
    located.push({ index: index < 0 ? from : index, path });
    if (index >= 0) from = index + path.length;
  }
  located.push(...bareRootFileCandidates(text));
  const out: string[] = [];
  for (const { path } of located.sort((a, b) => a.index - b.index)) {
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

function isUnsafeMentionedPath(token: string): boolean {
  // Only a FILE-like token counts: 2+ real segments or a `.ext` leaf. A slash command (`/preview`) or a bare
  // `../utils` / `~/notes` in prose is not a named path.
  const real = token.split(/[\\/]/).filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && seg !== '~');
  const fileLike = real.length >= 2 || /\.[A-Za-z][A-Za-z0-9]*$/.test(real[real.length - 1] ?? '');
  if (!fileLike) return false;
  if (/^(?:[\\/]|~|[a-zA-Z]:)/.test(token)) return true;
  if (token.split(/[\\/]/).includes('..')) return true;
  const rest = token.startsWith('./') ? token.slice(2).replace(/^\/+/, '') : token;
  return rest.startsWith('.');
}

export type CodeChangeTargetCollection =
  /** No safe path was named at all. */
  | { readonly kind: 'none' }
  /**
   * Some named paths have a secret-looking file NAME (ADR-0019/0022 policy, ADR-0099 D6 "a secret filename on any
   * target fails the whole set"; QA-V2-CL-02). Refused by name before any lookup — the workspace never lists, reads,
   * sends or writes such a file, so it must not be reported as "not found". `paths` are as typed.
   */
  | { readonly kind: 'secret-named'; readonly paths: string[] }
  /** More than {@link MAX_CHANGE_SET_FILES} safe paths were named — split the request. Nothing was looked up. */
  | { readonly kind: 'too-many'; readonly count: number; readonly max: number }
  /** Named paths that do not exist (and no create wording) — ask again; `resolved` are the ones that did. */
  | { readonly kind: 'missing'; readonly missing: string[]; readonly resolved: string[] }
  /** Every named path is usable: existing ones are update targets, `newFileTargets` ⊆ `targets` are adds. */
  | { readonly kind: 'targets'; readonly targets: string[]; readonly newFileTargets: string[] };

/**
 * Collect the change-set targets of a code-change request (ADR-0099 D1). `candidates` are the already-safe
 * extracted paths (unsafe typed paths are already dropped — {@link extractSafeTargetCandidates}), in order of appearance. Every one is
 * a target, never only the first: an existing path (verified by `resolveExisting`, which returns the
 * workspace's own spelling of the hit) is an update target; a missing path is a new-file target only when
 * `allowNewFiles` (the negation-aware ADR-0062 create wording); otherwise it is reported as missing so the
 * caller asks again — never a silent drop and never an AI guess. A secret-looking file name refuses the whole set
 * by name ({@link isSecretLookingFileName}, ADR-0099 D6), and more than {@link MAX_CHANGE_SET_FILES} candidates are
 * refused — both before any lookup.
 */
export async function collectCodeChangeTargets(input: {
  readonly candidates: readonly string[];
  readonly resolveExisting: (candidate: string) => Promise<string | null>;
  readonly allowNewFiles: boolean;
}): Promise<CodeChangeTargetCollection> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of input.candidates) {
    const norm = normalizeRelativePath(candidate);
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    unique.push(candidate);
  }
  if (unique.length === 0) return { kind: 'none' };
  const secretNamed = unique.filter((candidate) => isSecretLookingFileName(normalizeRelativePath(candidate).split('/').pop() ?? ''));
  if (secretNamed.length > 0) return { kind: 'secret-named', paths: secretNamed };
  if (unique.length > MAX_CHANGE_SET_FILES) {
    return { kind: 'too-many', count: unique.length, max: MAX_CHANGE_SET_FILES };
  }

  const targets: string[] = [];
  const targetKeys = new Set<string>();
  const newFileTargets: string[] = [];
  const missing: string[] = [];
  for (const candidate of unique) {
    const hit = await input.resolveExisting(candidate);
    if (hit !== null) {
      const key = normalizeRelativePath(hit);
      if (!targetKeys.has(key)) {
        targetKeys.add(key);
        targets.push(hit);
      }
      continue;
    }
    if (input.allowNewFiles) {
      const path = normalizeRelativePath(candidate);
      if (!targetKeys.has(path)) {
        targetKeys.add(path);
        targets.push(path);
        newFileTargets.push(path);
      }
      continue;
    }
    missing.push(candidate);
  }
  if (missing.length > 0) return { kind: 'missing', missing, resolved: targets };
  return { kind: 'targets', targets, newFileTargets };
}

// ── Patch-time diff check (ADR-0099 D1) ─────────────────────────────────────────────────────────────

/**
 * Check a freshly re-run workspace diff before a PatchSet is generated from it. Allowed: 1..5 files, unique
 * in-scope paths, `modify` of an existing text file or `add` of a path in the anchor's `newFileTargets`
 * (and only those: a new-file target that now shows as `modify` already exists). Rejected: empty, delete,
 * binary, unrenderable (size-skipped) and over-bound diffs. Returns the `add` paths so the caller can re-check
 * each one is still absent (read-only).
 */
export function validatePatchableDiff(diff: WorkspaceDiff, scope: ChangeSetScope): ChangeSetCheck<{ addPaths: string[] }> {
  const files = diff.files;
  if (files.length === 0) return { ok: false, reason: 'empty diff' };
  if (files.length > MAX_CHANGE_SET_FILES) return { ok: false, reason: 'too many files in the change set' };
  const targets = normalizedSet(scope.targetFiles);
  const newFiles = normalizedSet(scope.newFileTargets);
  const seen = new Set<string>();
  const addPaths: string[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const norm = normalizeRelativePath(file.path);
    if (seen.has(norm)) return { ok: false, reason: 'duplicate path in the change set' };
    seen.add(norm);
    if (!targets.has(norm)) return { ok: false, reason: 'path outside the approved targets' };
    if (file.binary) return { ok: false, reason: 'binary change' };
    if (!file.unified.trim()) return { ok: false, reason: 'unrenderable diff (empty/oversized)' };
    if (file.changeKind === 'add') {
      if (!newFiles.has(norm)) return { ok: false, reason: 'add for a path that is not a new-file target' };
      addPaths.push(file.path);
    } else if (file.changeKind === 'modify') {
      if (newFiles.has(norm)) return { ok: false, reason: 'new-file target already exists' };
    } else {
      return { ok: false, reason: `unsupported change kind ${String(file.changeKind)}` };
    }
    if ((file.oldSize ?? 0) > MAX_CHANGE_SET_FILE_BYTES || (file.newSize ?? 0) > MAX_CHANGE_SET_FILE_BYTES) {
      return { ok: false, reason: 'file exceeds the change-set file bound' };
    }
    totalBytes += file.newSize ?? 0;
  }
  if (totalBytes > MAX_CHANGE_SET_TOTAL_BYTES) return { ok: false, reason: 'change set exceeds the total bound' };
  return { ok: true, addPaths };
}

// ── Apply-time PatchSet check (ADR-0099 D1/D2) ──────────────────────────────────────────────────────

/**
 * PatchSet integrity before WorkspaceWrite (ADR-0042 identity checks, widened by ADR-0099): the loaded
 * PatchSet is the anchored one, GENERATED, authorized by the anchor's APPROVED apply approval for the same
 * plan, and carries 1..5 operations on unique in-scope paths, each an `update` or an `add`, with
 * `add` ⇔ path ∈ `newFileTargets` (an anchor without the field admits no add — fail closed). Delete, binary,
 * rename-like duplicates and out-of-scope paths are rejected. `newFiles` lists the add paths.
 */
export function validateChangeSetForApply(
  patchSet: PatchSet,
  anchor: ChangeSetApplyAnchor,
): ChangeSetCheck<{ newFiles: string[] }> {
  if (
    !anchor.patchRef ||
    patchSet.id !== anchor.patchRef.id ||
    patchSet.status !== PatchStatus.GENERATED ||
    patchSet.approvalRef.status !== ApprovalStatus.APPROVED ||
    patchSet.approvalRef.id !== anchor.approvalId ||
    patchSet.executionPlanRef.id !== anchor.executionPlanRef.id
  ) {
    return { ok: false, reason: 'patch set identity/approval/plan mismatch' };
  }
  const ops = patchSet.operations;
  if (ops.length === 0 || ops.length > MAX_CHANGE_SET_FILES) {
    return { ok: false, reason: 'patch set operation count out of bounds' };
  }
  const targets = normalizedSet(anchor.targetFiles);
  const allowedNew = normalizedSet(anchor.newFileTargets);
  const seen = new Set<string>();
  const newFiles: string[] = [];
  for (const op of ops) {
    const norm = normalizeRelativePath(op.path);
    if (seen.has(norm)) return { ok: false, reason: 'duplicate path in the patch set' };
    seen.add(norm);
    if (!targets.has(norm)) return { ok: false, reason: 'patch operation outside the approved targets' };
    if (op.metadata?.['binary'] === true) return { ok: false, reason: 'binary patch operation' };
    if (op.operation === 'add') {
      if (!allowedNew.has(norm)) return { ok: false, reason: 'add for a path that is not a new-file target' };
      newFiles.push(op.path);
    } else if (op.operation === 'update') {
      if (allowedNew.has(norm)) return { ok: false, reason: 'update for a new-file target' };
    } else {
      return { ok: false, reason: `unsupported patch operation ${String(op.operation)}` };
    }
  }
  return { ok: true, newFiles };
}

/** True for the exact ADR-0042 shape (one `update`), which keeps the per-file `WorkspaceWrite.apply` path. */
export function isSingleUpdateChangeSet(ops: readonly PatchOperation[]): boolean {
  return ops.length === 1 && ops[0]?.operation === 'update';
}

// ── Applied-result check (ADR-0099 D2) ──────────────────────────────────────────────────────────────

/**
 * `WORKSPACE_APPLIED` requires an APPLIED change whose refs match the PatchSet/workspace and whose results
 * match the operations one-to-one, in order (path, operation, `applied`).
 */
export function verifyAppliedChangeSet(change: WorkspaceChange, patchSet: PatchSet, workspaceRef: WorkspaceRef): boolean {
  const ops = patchSet.operations;
  return (
    change.status === WorkspaceChangeStatus.APPLIED &&
    change.patchRef.id === patchSet.id &&
    change.approvalRef.id === patchSet.approvalRef.id &&
    change.executionPlanRef.id === patchSet.executionPlanRef.id &&
    change.workspaceRef.id === workspaceRef.id &&
    change.results.length === ops.length &&
    ops.every((op, i) => {
      const r = change.results[i];
      return r !== undefined && r.status === 'applied' && r.path === op.path && r.operation === op.operation;
    })
  );
}

/**
 * How a change-set apply that did not verify must be reported: `rolled-back` — the workspace is known
 * unchanged ("nothing changed"); `may-have-applied` — part of the set may be on disk (a failed rollback, an
 * in-flight record, or an APPLIED claim that does not match the PatchSet); `failed` — nothing was written.
 */
export function classifyUnverifiedChangeSet(change: WorkspaceChange): 'rolled-back' | 'may-have-applied' | 'failed' {
  switch (change.status) {
    case WorkspaceChangeStatus.ROLLED_BACK:
      return 'rolled-back';
    case WorkspaceChangeStatus.FAILED:
    case WorkspaceChangeStatus.PENDING:
      return 'failed';
    default:
      return 'may-have-applied';
  }
}

// ── Commit-time candidate partition (ADR-0099 D3) ───────────────────────────────────────────────────

/** A git-status path as a safe project-relative path, or null (absolute, traversal, empty). */
function safeStatusPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) return null;
  const normalized = normalizeRelativePath(trimmed);
  if (normalized.length === 0) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

export type CommitCandidatePartition =
  | { readonly ok: true; readonly files: string[]; readonly newFiles: string[] }
  | {
      readonly ok: false;
      /** `untracked-unsupported` keeps the distinct ADR-0046 reply; every other reason needs a new approval. */
      readonly reason:
        | 'unsafe-candidate'
        | 'candidate-out-of-scope'
        | 'unsafe-changed-path'
        | 'untracked-unsupported'
        | 'scope-drift';
    };

/**
 * Re-validate the approved commit candidates against a FRESH `git status` (ADR-0046, widened by ADR-0099 D3).
 * Every candidate must be safe, inside `targetFiles` and still changed; the in-scope changed set must equal the
 * candidate set; nothing may be changed outside `targetFiles`; nothing may be staged outside the candidates.
 * An UNTRACKED candidate is admitted only when it is one of the anchor's `newFileTargets` (it becomes one of
 * `newFiles`, for the exact `git add`); any other untracked candidate is `untracked-unsupported`, and an
 * in-scope untracked file that is not a candidate is drift.
 */
export function partitionCommitCandidates(input: {
  readonly candidates: readonly string[];
  readonly scope: ChangeSetScope;
  readonly status: GitStatus;
}): CommitCandidatePartition {
  const raw = input.candidates.map(safeStatusPath);
  if (raw.some((c) => c === null)) return { ok: false, reason: 'unsafe-candidate' };
  const candidates = [...new Set(raw as string[])];
  const scope = normalizedSet(input.scope.targetFiles);
  if (candidates.some((c) => !scope.has(c))) return { ok: false, reason: 'candidate-out-of-scope' };

  const staged = input.status.staged.map(safeStatusPath);
  const unstaged = input.status.unstaged.map(safeStatusPath);
  const untracked = input.status.untracked.map(safeStatusPath);
  if ([...staged, ...unstaged, ...untracked].some((c) => c === null)) return { ok: false, reason: 'unsafe-changed-path' };
  const trackedChanged = new Set([...staged, ...unstaged] as string[]);
  const untrackedSet = new Set(untracked as string[]);
  const stagedSet = new Set(staged as string[]);
  const candSet = new Set(candidates);
  const allowedNew = normalizedSet(input.scope.newFileTargets);

  const newFiles: string[] = [];
  for (const c of candidates) {
    if (trackedChanged.has(c) || !untrackedSet.has(c)) continue;
    if (!allowedNew.has(c)) return { ok: false, reason: 'untracked-unsupported' };
    newFiles.push(c);
  }
  const committable = new Set([...trackedChanged, ...newFiles]);
  const missing = candidates.filter((c) => !committable.has(c));
  const extraInScope = [...trackedChanged, ...untrackedSet].filter((c) => scope.has(c) && !candSet.has(c));
  const outOfScope = [...trackedChanged, ...untrackedSet].filter((c) => !scope.has(c));
  const stagedOutside = [...stagedSet].filter((c) => !candSet.has(c));
  if (missing.length || extraInScope.length || outOfScope.length || stagedOutside.length) {
    return { ok: false, reason: 'scope-drift' };
  }
  return { ok: true, files: candidates, newFiles };
}

/** The approved candidates that are new files: untracked now and in the anchor's `newFileTargets`. */
export function newFileCommitCandidates(candidates: readonly string[], scope: ChangeSetScope, status: GitStatus): string[] {
  const allowedNew = normalizedSet(scope.newFileTargets);
  const untracked = new Set(status.untracked.map((p) => safeStatusPath(p)).filter((p): p is string => p !== null));
  return candidates.filter((c) => {
    const norm = normalizeRelativePath(c);
    return allowedNew.has(norm) && untracked.has(norm);
  });
}

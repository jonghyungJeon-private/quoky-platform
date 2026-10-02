import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyPatch, createTwoFilesPatch } from 'diff';
import { NotImplementedError } from '@quoky/core';
import type {
  ChangeSetApplyResult,
  ContextFile,
  DiffChangeKind,
  FileChangeResult,
  FileDiff,
  PatchOperation,
  ProjectFileEntry,
  ProjectReadout,
  ProjectScan,
  ProposedChange,
  WorkspaceDiff,
  WorkspaceProvider,
  WorkspaceRef,
  WorkspaceWriter,
} from '@quoky/core';

/** Directories excluded from file-tree summaries / reads (ADR-0018/0019). */
const TREE_EXCLUDE = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

/** Files whose full text may be read during gated analysis (ADR-0019). */
const ANALYSIS_ALLOW = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'README.md',
  'ARCHITECTURE.md',
  'DECISIONS.md',
]);

/** Per-file read cap for analysis. */
const MAX_FILE_BYTES = 8000;

/**
 * Conventional credential-file names the substring rule below does not already cover (it already
 * catches `credentials.json`, `.git-credentials`, `*.key`, `*.keystore`, `secrets.*`): service-account
 * JSON, PEM / PKCS#12 / Java keystores, SSH private keys, and package-manager / network auth files.
 */
const CREDENTIAL_FILE_NAME =
  /(service[-_]?account.*\.json$|\.(pem|p12|pfx|jks)$|^id_(rsa|dsa|ecdsa|ed25519)|^\.(npmrc|pypirc|netrc)$)/i;

/** Never read env / secret-looking files (ADR-0019). */
function isSecretName(name: string): boolean {
  return (
    /\.env(\.|$)/i.test(name) ||
    /(secret|token|key|credential|password)/i.test(name) ||
    CREDENTIAL_FILE_NAME.test(name)
  );
}

function isAnalysisAllowed(name: string): boolean {
  return ANALYSIS_ALLOW.has(name) || /^tsconfig.*\.json$/.test(name);
}

// --- v2 Workspace capability (ADR-0022): read-only filesystem helpers. ---

/** Large-file guard for read/diff (bytes). Oversized files are refused/skipped. */
const MAX_READ_BYTES = 256_000;

/** Upper bound on entries returned by listFiles, to avoid runaway walks. */
const MAX_LIST_ENTRIES = 5000;

/**
 * Resolve `relPath` to an absolute path confined to `root` (ADR-0022 sandbox).
 * Rejects absolute inputs, `..` traversal, and symlink escapes for existing
 * targets. Never follows a path outside the workspace root.
 */
function resolveWithin(root: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error(`absolute paths are not allowed: ${relPath}`);
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`path escapes the workspace root: ${relPath}`);
  }
  if (existsSync(abs)) {
    const realRoot = realpathSync(rootAbs);
    const real = realpathSync(abs);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`path escapes the workspace root via symlink: ${relPath}`);
    }
  }
  return abs;
}

/** Heuristic binary detection: a NUL byte in the first 8 KB. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Minimal, zero-dependency glob matcher supporting `*`, `**`, and `?`. */
function matchGlob(path: string, glob: string): boolean {
  const pattern = glob
    .split(/(\*\*|\*|\?)/)
    .map((seg) => {
      if (seg === '**') return '.*';
      if (seg === '*') return '[^/]*';
      if (seg === '?') return '[^/]';
      return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${pattern}$`).test(path);
}

/**
 * Centralized read-only access rules for the Workspace capability (ADR-0022) — a
 * dedicated value object so ignore/secret/size/binary rules live in one place,
 * keeping the provider focused on filesystem mechanics. Per-project / core-level
 * configurable policies are a deliberate future extension (not in Sprint 2a).
 */
export interface WorkspacePolicy {
  /** Directory names never descended into or listed. */
  isIgnoredDir(name: string): boolean;
  /** Names that must never be read (env/secret-looking). */
  isSecret(name: string): boolean;
  /** Convenience: readable = not ignored and not secret. */
  isReadable(name: string): boolean;
  /** Maximum bytes read per file; larger files are refused (read) / skipped (diff). */
  readonly maxFileBytes: number;
  /** Heuristic binary detection. */
  isBinary(buf: Buffer): boolean;
}

/** The default policy: the existing ignore/secret/size/binary rules, consolidated. */
export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  isIgnoredDir: (name) => TREE_EXCLUDE.has(name),
  isSecret: isSecretName,
  isReadable: (name) => !TREE_EXCLUDE.has(name) && !isSecretName(name),
  maxFileBytes: MAX_READ_BYTES,
  isBinary: looksBinary,
};

/** Count added+removed lines in a unified diff (excludes ---/+++/@@ headers). */
function countChangedLines(unified: string): number {
  let n = 0;
  for (const line of unified.split('\n')) {
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ) {
      n++;
    }
  }
  return n;
}

export interface LocalCloneConfig {
  /** Absolute root path of the existing local clone. */
  workspaceRoot: string;
}

/**
 * Implements WorkspaceProvider against an existing local clone — the **filesystem**
 * abstraction only (CAP-001). Workspace ≠ Git: git inspection lives in
 * `@quoky/git-local` (CAP-002), never here.
 *
 * Read-only methods are implemented (`resolve`/`readFile`/`listFiles`/`diff`).
 * `writeFile`/`writeContextFiles` remain stubs until their approval-gated
 * capabilities land. Command execution is NOT here — it lives in the
 * `CommandRunner` port / `@quoky/command-local` adapter (CAP-007).
 *
 * Safety: NEVER auto-commit, auto-push, or auto-delete. Those are HIGH/CRITICAL
 * and only run via approval-gated capabilities later.
 */
export class LocalCloneWorkspaceProvider implements WorkspaceProvider {
  readonly kind = 'local-clone';

  /** Read-only access rules (ADR-0022). Configurable policies are a future slice. */
  private readonly policy: WorkspacePolicy = DEFAULT_WORKSPACE_POLICY;

  constructor(private readonly config: LocalCloneConfig) {}

  /** Read-only scan for project registration (ADR-0018). Never mutates anything. */
  async scanProject(path: string): Promise<ProjectScan> {
    let isDir = false;
    try {
      isDir = existsSync(path) && statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return {
        exists: false,
        name: basename(path) || path,
        rootPath: path,
        gitBranch: 'unknown',
        packageManager: 'unknown',
        fileTreeSummary: '',
      };
    }
    return {
      exists: true,
      name: basename(path) || path,
      rootPath: path,
      gitBranch: LocalCloneWorkspaceProvider.detectGitBranch(path),
      packageManager: LocalCloneWorkspaceProvider.detectPackageManager(path),
      fileTreeSummary: LocalCloneWorkspaceProvider.summarizeTree(path),
    };
  }

  /** Read-only, size-limited read of an allow-listed file set (ADR-0019). */
  async readProjectFiles(rootPath: string): Promise<ProjectReadout> {
    const files: ProjectFileEntry[] = [];
    let rootEntries: string[];
    try {
      rootEntries = readdirSync(rootPath);
    } catch {
      return { files, tree: '' };
    }
    for (const name of rootEntries.sort()) {
      if (TREE_EXCLUDE.has(name) || isSecretName(name) || !isAnalysisAllowed(name)) continue;
      const full = join(rootPath, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        let content = readFileSync(full, 'utf8');
        const truncated = content.length > MAX_FILE_BYTES;
        if (truncated) content = content.slice(0, MAX_FILE_BYTES);
        files.push({ path: name, content, truncated });
      } catch {
        /* skip unreadable file */
      }
    }
    return { files, tree: LocalCloneWorkspaceProvider.analysisTree(rootPath) };
  }

  /** Top-level tree (root + apps/ + packages/), excluding ignored/secret entries. */
  private static analysisTree(rootPath: string): string {
    const lines = LocalCloneWorkspaceProvider.listDir(rootPath);
    for (const sub of ['apps', 'packages']) {
      const subPath = join(rootPath, sub);
      try {
        if (statSync(subPath).isDirectory()) {
          for (const child of LocalCloneWorkspaceProvider.listDir(subPath)) lines.push(`${sub}/${child}`);
        }
      } catch {
        /* sub dir absent */
      }
    }
    return lines.join('\n');
  }

  private static listDir(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => !TREE_EXCLUDE.has(e.name) && !isSecretName(e.name))
        .sort((a, b) =>
          a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
        )
        .slice(0, 60)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    } catch {
      return [];
    }
  }

  private static detectGitBranch(path: string): string {
    try {
      const res = spawnSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
    } catch {
      /* not a git repo / git unavailable */
    }
    return 'unknown';
  }

  private static detectPackageManager(path: string): string {
    if (existsSync(join(path, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(path, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(path, 'package-lock.json'))) return 'npm';
    if (existsSync(join(path, 'package.json'))) return 'npm';
    return 'unknown';
  }

  private static summarizeTree(path: string): string {
    try {
      const entries = readdirSync(path, { withFileTypes: true });
      return entries
        .filter((e) => !TREE_EXCLUDE.has(e.name))
        .sort((a, b) =>
          a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
        )
        .slice(0, 50)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n');
    } catch {
      return '';
    }
  }

  // --- v2 Workspace capability (ADR-0022): read-only filesystem. node:fs only,
  //     no child_process, no git, no writes. ---

  /** Validate the core-built ref points at an existing directory; return it. */
  async resolve(ref: WorkspaceRef): Promise<WorkspaceRef> {
    void this.config;
    let isDir = false;
    try {
      isDir = existsSync(ref.rootPath) && statSync(ref.rootPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new Error(`workspace root is not a directory: ${ref.rootPath}`);
    return ref;
  }

  /** Read one file's text, sandboxed to the root; refuses secrets/binary/oversized. */
  async readFile(ref: WorkspaceRef, relPath: string): Promise<string> {
    if (this.policy.isSecret(basename(relPath))) {
      throw new Error(`refusing to read a secret file: ${relPath}`);
    }
    const abs = resolveWithin(ref.rootPath, relPath);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`not a file: ${relPath}`);
    if (st.size > this.policy.maxFileBytes) {
      throw new Error(`file too large (${st.size} > ${this.policy.maxFileBytes} bytes): ${relPath}`);
    }
    const buf = readFileSync(abs);
    if (this.policy.isBinary(buf)) throw new Error(`binary file is not readable as text: ${relPath}`);
    return buf.toString('utf8');
  }

  /** List relative file paths under the root (read-only); excludes ignored/secret. */
  async listFiles(ref: WorkspaceRef, glob?: string): Promise<string[]> {
    const out: string[] = [];
    const walk = (dirAbs: string, relBase: string): void => {
      if (out.length >= MAX_LIST_ENTRIES) return;
      let entries;
      try {
        entries = readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX_LIST_ENTRIES) return;
        if (!this.policy.isReadable(e.name) || e.isSymbolicLink()) continue;
        const childRel = relBase ? `${relBase}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dirAbs, e.name), childRel);
        else if (e.isFile()) out.push(childRel);
      }
    };
    walk(resolveWithin(ref.rootPath, '.'), '');
    return glob ? out.filter((p) => matchGlob(p, glob)) : out;
  }

  /** Read-only unified diff: current file content → proposed content (ADR-0022). */
  async diff(ref: WorkspaceRef, changes: ProposedChange[]): Promise<WorkspaceDiff> {
    const files: FileDiff[] = [];
    let truncated = false;
    let estimatedChangedLines = 0;
    for (const change of changes) {
      const abs = resolveWithin(ref.rootPath, change.path);
      const exists = existsSync(abs) && statSync(abs).isFile();
      const wantDelete = change.delete === true;
      const changeKind: DiffChangeKind = wantDelete ? 'delete' : exists ? 'modify' : 'add';

      let current = '';
      let currentBinary = false;
      let oldSize: number | undefined;
      if (exists) {
        oldSize = statSync(abs).size;
        const buf = readFileSync(abs);
        currentBinary = this.policy.isBinary(buf);
        current = buf.toString('utf8');
      }

      const proposed = wantDelete ? '' : (change.newContent ?? '');
      const newSize = wantDelete ? undefined : Buffer.byteLength(proposed, 'utf8');
      const newBinary = !wantDelete && this.policy.isBinary(Buffer.from(proposed, 'utf8'));

      if ((oldSize ?? 0) > this.policy.maxFileBytes || (newSize ?? 0) > this.policy.maxFileBytes) {
        truncated = true;
        files.push({ path: change.path, changeKind, unified: '', binary: false, oldSize, newSize });
        continue;
      }
      if (currentBinary || newBinary) {
        files.push({ path: change.path, changeKind, unified: '', binary: true, oldSize, newSize });
        continue;
      }
      const unified = createTwoFilesPatch(change.path, change.path, current, proposed, '', '');
      estimatedChangedLines += countChangedLines(unified);
      files.push({ path: change.path, changeKind, unified, binary: false, oldSize, newSize });
    }
    return { refId: ref.id, files, estimatedChangedLines, truncated };
  }

  // --- NOT part of the v2 Workspace capability. Workspace ≠ Git (ADR-0022/0023):
  //     git lives in @quoky/git-local (CAP-002); command execution lives in
  //     @quoky/command-local (CAP-007), never here. Writes are gated behind
  //     future approval slices. Stubs for now. ---

  async writeFile(_ref: WorkspaceRef, _relPath: string, _content: string): Promise<void> {
    throw new NotImplementedError('LocalCloneWorkspaceProvider.writeFile');
  }

  async writeContextFiles(_ref: WorkspaceRef, _files: ContextFile[]): Promise<void> {
    throw new NotImplementedError('LocalCloneWorkspaceProvider.writeContextFiles');
  }
}

// --- ADR-0099 change-set apply (adapter-side). The bounds below are a backstop: the
//     primary change-set limits are enforced in core before a preview is offered. ---

/** Most operations one change set may carry (ADR-0099). */
const MAX_CHANGE_SET_OPS = 5;
/** Per-file byte bound for a change set, on both the pre-image and the result (ADR-0099). */
const MAX_CHANGE_SET_FILE_BYTES = 64 * 1024;
/** Total result bytes for one change set (ADR-0099). */
const MAX_CHANGE_SET_TOTAL_BYTES = 256 * 1024;
/** Infix of a change set's exclusive temp files: `<abs>.quoky-tmp-<rand>`. */
const CHANGE_SET_TMP_INFIX = '.quoky-tmp-';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** `lstat` that reports a missing entry as `null` (never follows a final symlink). */
function lstatOrNull(abs: string): Stats | null {
  try {
    return lstatSync(abs);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function changeSetTempPath(abs: string): string {
  return `${abs}${CHANGE_SET_TMP_INFIX}${randomBytes(6).toString('hex')}`;
}

/** A filesystem object's identity, recorded when this apply created it (ADR-0099 write-time checks). */
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function identityOf(st: Stats): FileIdentity {
  return { dev: st.dev, ino: st.ino };
}

function sameIdentity(st: Stats | null, id: FileIdentity | undefined): boolean {
  return st !== null && id !== undefined && st.dev === id.dev && st.ino === id.ino;
}

/**
 * Write `data` to a fresh exclusive temp file beside `abs` (flag `wx`: `O_CREAT|O_EXCL`, which never follows a
 * symlink at the temp path) and record it in `owned` with its identity for cleanup. A file that existed before
 * (EEXIST) is never ours, so it is never tracked — cleanup can only ever remove temp files this apply created.
 */
function writeExclusiveTemp(abs: string, data: string | Buffer, owned: Map<string, FileIdentity | undefined>): string {
  const tmp = changeSetTempPath(abs);
  try {
    writeFileSync(tmp, data, { flag: 'wx' });
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') owned.set(tmp, identityOrUndefined(tmp)); // a partial write may have left it
    throw err;
  }
  const st = lstatSync(tmp);
  if (!st.isFile()) throw new Error(`temp file is not a regular file: ${tmp}`);
  owned.set(tmp, identityOf(st));
  return tmp;
}

function identityOrUndefined(abs: string): FileIdentity | undefined {
  try {
    const st = lstatOrNull(abs);
    return st?.isFile() ? identityOf(st) : undefined;
  } catch {
    return undefined;
  }
}

/** Unlink `abs` only if it is still the very file this apply created (same dev/ino); `false` when it is not. */
function unlinkOwned(abs: string, id: FileIdentity | undefined): boolean {
  const st = lstatOrNull(abs);
  if (st === null) return true;
  if (!st.isFile() || !sameIdentity(st, id)) return false;
  unlinkSync(abs);
  return true;
}

/**
 * Write-time containment for a change set (ADR-0099), re-run immediately before (and after) every stage,
 * promote and rollback write so a directory swapped after phase 1 cannot redirect a write: the workspace root
 * must still resolve to the realpath checked at the start, every path component strictly between the root and
 * `abs` must be a real directory — `lstat`, never followed, a symlink is refused even when it points inside the
 * root — and the parent's realpath must stay inside the root.
 */
function assertWriteContained(rootAbs: string, realRoot: string, abs: string, relPath: string): void {
  if (realpathSync(rootAbs) !== realRoot) throw new Error(`workspace root changed since it was checked: ${relPath}`);
  if (!abs.startsWith(rootAbs + sep)) throw new Error(`path escapes the workspace root: ${relPath}`);
  const components = abs.slice(rootAbs.length + 1).split(sep).slice(0, -1);
  let dir = rootAbs;
  for (const component of components) {
    dir = join(dir, component);
    const st = lstatOrNull(dir);
    if (st === null) throw new Error(`parent directory is missing: ${relPath}`);
    if (st.isSymbolicLink()) throw new Error(`refusing to write through a symlinked directory: ${relPath}`);
    if (!st.isDirectory()) throw new Error(`parent is not a directory: ${relPath}`);
  }
  const realParent = realpathSync(dirname(abs));
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new Error(`path escapes the workspace root via symlink: ${relPath}`);
  }
}

/** `applyPatch` that reports a malformed diff as a non-clean patch instead of throwing. */
function applyPatchOrFalse(source: string, diff: string): string | false {
  try {
    return applyPatch(source, diff);
  } catch {
    return false;
  }
}

/**
 * Write-side sandbox resolution for a change set (ADR-0099). Like `resolveWithin`
 * (absolute and `..` escapes are refused, and the root itself is never a target),
 * but it also realpath-checks the NEAREST EXISTING ANCESTOR of the target, so a
 * symlinked parent of a not-yet-existing file cannot point the write outside the
 * root, and refuses any existing symlinked path component (`assertWriteContained`). Returns the target and
 * the missing parent directories, shallowest first.
 */
function resolveWithinForWrite(root: string, relPath: string): { abs: string; missingDirs: string[] } {
  if (isAbsolute(relPath)) throw new Error(`absolute paths are not allowed: ${relPath}`);
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relPath);
  if (!abs.startsWith(rootAbs + sep)) throw new Error(`path escapes the workspace root: ${relPath}`);
  const realRoot = realpathSync(rootAbs);
  const missingDirs: string[] = [];
  let ancestor = dirname(abs);
  while (ancestor !== rootAbs && lstatOrNull(ancestor) === null) {
    missingDirs.unshift(ancestor);
    ancestor = dirname(ancestor);
  }
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
    throw new Error(`path escapes the workspace root via symlink: ${relPath}`);
  }
  if (!statSync(ancestor).isDirectory()) throw new Error(`parent is not a directory: ${relPath}`);
  // The same no-follow rule phase 2 re-checks at write time: no existing component may be a symlink.
  assertWriteContained(rootAbs, realRoot, missingDirs[0] ?? abs, relPath);
  return { abs, missingDirs };
}

/** One operation after phase 1: checked, resolved and computed — nothing written yet. */
interface PlannedChange {
  op: PatchOperation;
  abs: string;
  /** The full text the file will hold after the apply. */
  next: string;
  /** Update only: the exact pre-image bytes, their sha256 and the file mode. */
  pre?: { buf: Buffer; sha256: string; mode: number };
  /** Add only: missing parent directories, shallowest first. */
  missingDirs: string[];
  /** Phase 2: this operation's staged temp file. */
  tmp?: string;
  /** Phase 2: identity of the staged temp file, which becomes the target on promote (rename / link). */
  staged?: FileIdentity;
}

/** Phase 1 for one operation (ADR-0099): every check and the result text; no writes. */
function planChange(ref: WorkspaceRef, op: PatchOperation): PlannedChange {
  if (op.operation === 'delete') throw new Error('delete is not allowed in a change set');
  if (op.operation !== 'update' && op.operation !== 'add') {
    throw new Error(`unsupported operation in a change set: ${String(op.operation)}`);
  }
  if (op.metadata?.['binary'] === true) throw new Error('binary changes are not allowed in a change set');
  if (isSecretName(basename(op.path))) throw new Error(`refusing to write a secret-looking file: ${op.path}`);
  const { abs, missingDirs } = resolveWithinForWrite(ref.rootPath, op.path);

  let next: string | false;
  let pre: PlannedChange['pre'];
  const st = lstatOrNull(abs);
  if (op.operation === 'update') {
    if (st === null) throw new Error(`file does not exist (update): ${op.path}`);
    if (!st.isFile()) throw new Error(`not a regular file: ${op.path}`);
    if (st.size > MAX_CHANGE_SET_FILE_BYTES) {
      throw new Error(`file too large (${st.size} > ${MAX_CHANGE_SET_FILE_BYTES} bytes): ${op.path}`);
    }
    const buf = readFileSync(abs);
    if (looksBinary(buf)) throw new Error(`binary file cannot be updated as text: ${op.path}`);
    pre = { buf, sha256: sha256(buf), mode: st.mode & 0o7777 };
    next = applyPatchOrFalse(buf.toString('utf8'), op.diff);
  } else {
    if (st !== null) throw new Error(`path already exists (add never overwrites): ${op.path}`);
    next = applyPatchOrFalse('', op.diff);
  }
  if (next === false) throw new Error(`unified diff did not apply cleanly: ${op.path}`);
  const nextBuf = Buffer.from(next, 'utf8');
  if (nextBuf.length > MAX_CHANGE_SET_FILE_BYTES) {
    throw new Error(`result too large (${nextBuf.length} > ${MAX_CHANGE_SET_FILE_BYTES} bytes): ${op.path}`);
  }
  if (looksBinary(nextBuf)) throw new Error(`result is binary, not text: ${op.path}`);
  return { op, abs, next, pre, missingDirs: op.operation === 'add' ? missingDirs : [] };
}

/** Write-time target check (ADR-0099): an update's target is still a regular file (never a symlink, `lstat`),
 *  an add's target is still absent. */
function assertTargetState(p: PlannedChange): void {
  const st = lstatOrNull(p.abs);
  if (p.pre) {
    if (st === null || !st.isFile()) throw new Error(`not a regular file: ${p.op.path}`);
  } else if (st !== null) {
    throw new Error(`path already exists (add never overwrites): ${p.op.path}`);
  }
}

/** Test seams for `LocalWorkspaceWriter.applyChangeSet` — never set in production. */
export interface LocalWorkspaceWriterHooks {
  /** Runs once after phase 1 (every check passed), before the first phase-2 write. */
  readonly afterPlan?: () => void;
  /** Runs once after every result is staged, before the first promote. */
  readonly afterStage?: () => void;
  /** `applyOperation` only: runs once after every check passed, before the first write. */
  readonly afterOperationCheck?: () => void;
}

/**
 * Applies one patch operation to the local filesystem (CAP-006, ADR-0027).
 * **Atomic unit = file** (exclusive temp-write + rename, or unlink); `node:fs` only — no git,
 * no child_process. Apply failures are ENCODED in the FileChangeResult (never thrown)
 * so the manager can record best-effort results for every file.
 *
 * Containment matches the change-set path (ADR-0022, ADR-0099): `resolveWithinForWrite` refuses
 * absolute / `..` paths and any existing symlinked path component, and realpath-checks the nearest
 * existing ancestor; a symlinked target (dangling or not, pointing inside the root or not) is refused;
 * missing parents are created one at a time (never recursive) and `assertWriteContained` re-checks every
 * component with `lstat` before and after each mkdir, the exclusive (`wx`, random-named) temp write in
 * the validated parent, the rename and the unlink. A failure removes only the temp files and
 * directories this call created (dev/ino-checked).
 */
export class LocalWorkspaceWriter implements WorkspaceWriter {
  readonly kind = 'local';

  constructor(private readonly hooks: LocalWorkspaceWriterHooks = {}) {}

  async applyOperation(ref: WorkspaceRef, op: PatchOperation): Promise<FileChangeResult> {
    const start = Date.now();
    const done = (status: FileChangeResult['status'], message: string): FileChangeResult => ({
      path: op.path,
      operation: op.operation,
      status,
      message,
      durationMs: Date.now() - start,
    });
    const tmpFiles = new Map<string, FileIdentity | undefined>();
    const createdDirs: Array<{ dir: string; id: FileIdentity }> = [];
    let renamed = false;
    try {
      if (op.metadata?.['binary'] === true) return done('skipped', 'binary file not applied');
      const rootAbs = resolve(ref.rootPath);
      const { abs, missingDirs } = resolveWithinForWrite(ref.rootPath, op.path);
      const realRoot = realpathSync(rootAbs);
      const contained = (target: string): void => assertWriteContained(rootAbs, realRoot, target, op.path);
      /** The target, never followed: a symlink is refused; otherwise absent (`null`) or a regular file. */
      const targetState = (): Stats | null => {
        const st = lstatOrNull(abs);
        if (st?.isSymbolicLink()) throw new Error(`refusing to write through a symlinked target: ${op.path}`);
        if (st !== null && !st.isFile()) throw new Error(`not a regular file: ${op.path}`);
        return st;
      };

      const before = targetState();
      if (op.operation === 'delete') {
        if (before === null) return done('applied', 'deleted');
        this.hooks.afterOperationCheck?.();
        contained(abs);
        if (!sameIdentity(targetState(), identityOf(before))) {
          throw new Error(`file changed since it was checked: ${op.path}`);
        }
        unlinkSync(abs);
        return done('applied', 'deleted');
      }

      const current = before === null ? '' : readFileSync(abs, 'utf8');
      const next = applyPatch(current, op.diff);
      if (next === false) return done('failed', 'unified diff did not apply cleanly');

      this.hooks.afterOperationCheck?.();
      for (const dir of before === null ? missingDirs : []) {
        contained(dir);
        mkdirSync(dir); // never recursive: EEXIST if anything (a symlink included) appeared meanwhile
        const st = lstatSync(dir);
        if (!st.isDirectory()) throw new Error(`created path is not a directory: ${op.path}`);
        createdDirs.push({ dir, id: identityOf(st) });
        contained(dir);
      }
      contained(abs);
      const pre = targetState();
      const unchanged = before === null ? pre === null : sameIdentity(pre, identityOf(before));
      if (!unchanged) throw new Error(`file changed since it was checked: ${op.path}`);
      const tmp = writeExclusiveTemp(abs, next, tmpFiles);
      const staged = tmpFiles.get(tmp);
      contained(abs); // the temp landed in the validated parent, not behind a swapped one
      if (pre !== null) chmodSync(tmp, pre.mode & 0o7777);
      contained(abs);
      targetState();
      if (!sameIdentity(lstatOrNull(tmp), staged)) throw new Error(`staged file changed: ${op.path}`);
      renameSync(tmp, abs);
      renamed = true;
      tmpFiles.delete(tmp);
      // Re-check after the rename: a parent swapped during it is reported, never silently accepted.
      contained(abs);
      if (!sameIdentity(lstatOrNull(abs), staged)) throw new Error(`written file changed: ${op.path}`);
      return done('applied', op.operation === 'add' ? 'created' : 'updated');
    } catch (err) {
      const cleanupErrors: string[] = [];
      for (const [tmp, id] of tmpFiles) {
        try {
          if (!unlinkOwned(tmp, id)) cleanupErrors.push(`temp file changed, not removed: ${basename(tmp)}`);
        } catch (cleanupErr) {
          if (errorCode(cleanupErr) !== 'ENOENT') cleanupErrors.push(errorMessage(cleanupErr));
        }
      }
      for (const { dir, id } of [...createdDirs].reverse()) {
        try {
          const st = lstatOrNull(dir);
          if (st === null) continue;
          if (!st.isDirectory() || !sameIdentity(st, id)) {
            cleanupErrors.push(`directory changed, not removed: ${basename(dir)}`);
            continue;
          }
          rmdirSync(dir);
        } catch (cleanupErr) {
          cleanupErrors.push(errorMessage(cleanupErr));
        }
      }
      const cleanupNote = cleanupErrors.length ? `; cleanup failed: ${cleanupErrors.join('; ')}` : '';
      const appliedNote = renamed ? '; the change may have applied' : '';
      return done('failed', `${errorMessage(err)}${appliedNote}${cleanupNote}`);
    }
  }

  /**
   * All-or-nothing change set (ADR-0099). **Phase 1** writes nothing: bounds, op
   * kinds, secret names, write-side sandboxing, update pre-images (+ sha256) and the
   * `applyPatch` result of every file. **Phase 2** stages each result in an exclusive
   * temp file, then promotes updates by compare-and-swap against the pre-image hash
   * (`rename`) and creates adds no-clobber (`link` → EEXIST fails). On the first
   * failure it restores promoted updates, removes created files and directories
   * (deepest first) and deletes leftover temp files: `rolled_back`, or
   * `rollback_failed` when any restore step fails. Never throws. `durationMs` on
   * each result is the whole set's duration.
   *
   * Containment is re-validated at write time, not only in phase 1: before (and after)
   * every mkdir, temp write, promote and restore, `assertWriteContained` re-checks
   * every path component with `lstat` (no symlink is followed) and the parent's
   * realpath against the root's; rollback removes only files and directories whose
   * dev/ino are the ones this apply created, so a swapped parent can never redirect a
   * write outside the root or make rollback delete or overwrite someone else's file.
   */
  async applyChangeSet(ref: WorkspaceRef, ops: PatchOperation[]): Promise<ChangeSetApplyResult> {
    const start = Date.now();
    const result = (
      op: PatchOperation,
      status: FileChangeResult['status'],
      message: string,
    ): FileChangeResult => ({
      path: op.path,
      operation: op.operation,
      status,
      message,
      durationMs: Date.now() - start,
    });
    const refuse = (message: string): ChangeSetApplyResult => ({
      outcome: 'rolled_back',
      results: ops.map((op) => result(op, 'failed', `change set refused: ${message}`)),
    });

    // --- Phase 1: no writes. ---
    if (ops.length === 0) return refuse('empty change set');
    if (ops.length > MAX_CHANGE_SET_OPS) {
      return refuse(`too many files (${ops.length} > ${MAX_CHANGE_SET_OPS})`);
    }
    const planned: PlannedChange[] = [];
    let totalBytes = 0;
    for (const [index, op] of ops.entries()) {
      try {
        const change = planChange(ref, op);
        if (planned.some((p) => p.abs === change.abs)) throw new Error(`duplicate path in a change set: ${op.path}`);
        const nested = planned.find((p) => p.missingDirs.includes(change.abs) || change.missingDirs.includes(p.abs));
        if (nested) throw new Error(`conflicting paths in a change set: ${nested.op.path} and ${op.path}`);
        totalBytes += Buffer.byteLength(change.next, 'utf8');
        if (totalBytes > MAX_CHANGE_SET_TOTAL_BYTES) {
          throw new Error(`change set too large (> ${MAX_CHANGE_SET_TOTAL_BYTES} bytes in total)`);
        }
        planned.push(change);
      } catch (err) {
        return {
          outcome: 'rolled_back',
          results: ops.map((o, i) =>
            i === index
              ? result(o, 'failed', errorMessage(err))
              : result(o, 'skipped', `not applied: change set refused (${op.path} failed)`),
          ),
        };
      }
    }

    // --- Phase 2: stage, promote; on the first failure, roll back. ---
    // Every write below is preceded (and, where a swap could redirect it, followed) by a no-follow containment
    // check against the root realpath captured here; a violation aborts the set and rolls it back.
    const rootAbs = resolve(ref.rootPath);
    const tmpFiles = new Map<string, FileIdentity | undefined>();
    const createdDirs: Array<{ dir: string; id: FileIdentity; rel: string }> = [];
    const promoted = new Set<number>();
    let failedIndex = -1;
    let failure = '';
    let current = 0;
    let realRoot = '';
    try {
      realRoot = realpathSync(rootAbs);
      this.hooks.afterPlan?.();
      const contained = (abs: string, rel: string): void => assertWriteContained(rootAbs, realRoot, abs, rel);
      for (const [index, p] of planned.entries()) {
        current = index;
        for (const dir of p.missingDirs) {
          if (createdDirs.some((d) => d.dir === dir)) continue;
          contained(dir, p.op.path);
          mkdirSync(dir); // never recursive: EEXIST if anything (a symlink included) appeared meanwhile
          const st = lstatSync(dir);
          if (!st.isDirectory()) throw new Error(`created path is not a directory: ${p.op.path}`);
          createdDirs.push({ dir, id: identityOf(st), rel: p.op.path });
          contained(dir, p.op.path);
        }
        contained(p.abs, p.op.path);
        assertTargetState(p);
        const tmp = writeExclusiveTemp(p.abs, p.next, tmpFiles);
        p.tmp = tmp;
        p.staged = tmpFiles.get(tmp);
        contained(p.abs, p.op.path); // the temp landed in the validated parent, not behind a swapped one
        if (p.pre) chmodSync(tmp, p.pre.mode);
      }
      this.hooks.afterStage?.();
      for (const [index, p] of planned.entries()) {
        current = index;
        const tmp = p.tmp as string;
        contained(p.abs, p.op.path);
        assertTargetState(p);
        if (!sameIdentity(lstatOrNull(tmp), p.staged)) throw new Error(`staged file changed: ${p.op.path}`);
        if (p.pre) {
          if (sha256(readFileSync(p.abs)) !== p.pre.sha256) {
            throw new Error(`file changed since it was checked: ${p.op.path}`);
          }
          renameSync(tmp, p.abs);
          tmpFiles.delete(tmp);
          promoted.add(index);
        } else {
          try {
            linkSync(tmp, p.abs);
          } catch (err) {
            if (errorCode(err) !== 'EEXIST') throw err;
            throw new Error(`path already exists (add never overwrites): ${p.op.path}`);
          }
          promoted.add(index);
          unlinkOwned(tmp, p.staged);
          tmpFiles.delete(tmp);
        }
        // Re-check after the promote: a parent swapped during it is caught and the set rolled back.
        contained(p.abs, p.op.path);
        if (!sameIdentity(lstatOrNull(p.abs), p.staged)) throw new Error(`promoted file changed: ${p.op.path}`);
      }
    } catch (err) {
      failedIndex = current;
      failure = errorMessage(err);
    }

    if (failedIndex < 0) {
      return {
        outcome: 'applied',
        results: planned.map((p) => result(p.op, 'applied', p.op.operation === 'add' ? 'created' : 'updated')),
      };
    }

    // Rollback, in reverse promotion order. A restore WRITE re-validates containment first and only ever
    // replaces the very file this apply promoted; a REMOVAL only ever unlinks a file / directory whose identity
    // (dev+ino) is the one this apply created, wherever a swapped parent has moved it.
    const restoreFailed = new Map<number, string>();
    const cleanupErrors: string[] = [];
    for (let index = planned.length - 1; index >= 0; index--) {
      if (!promoted.has(index)) continue;
      const p = planned[index] as PlannedChange;
      try {
        if (p.pre) {
          assertWriteContained(rootAbs, realRoot, p.abs, p.op.path);
          if (!sameIdentity(lstatOrNull(p.abs), p.staged)) {
            throw new Error(`file changed after it was written, not restored: ${p.op.path}`);
          }
          const tmp = writeExclusiveTemp(p.abs, p.pre.buf, tmpFiles);
          chmodSync(tmp, p.pre.mode);
          assertWriteContained(rootAbs, realRoot, p.abs, p.op.path);
          renameSync(tmp, p.abs);
          tmpFiles.delete(tmp);
        } else if (!unlinkOwned(p.abs, p.staged)) {
          throw new Error(`file changed after it was created, not removed: ${p.op.path}`);
        }
      } catch (err) {
        restoreFailed.set(index, errorMessage(err));
      }
    }
    for (const [tmp, id] of tmpFiles) {
      try {
        if (!unlinkOwned(tmp, id)) cleanupErrors.push(`temp file changed, not removed: ${basename(tmp)}`);
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') cleanupErrors.push(errorMessage(err));
      }
    }
    for (const { dir, id } of [...createdDirs].reverse()) {
      try {
        const st = lstatOrNull(dir);
        if (st === null) continue;
        if (!st.isDirectory() || !sameIdentity(st, id)) {
          cleanupErrors.push(`directory changed, not removed: ${basename(dir)}`);
          continue;
        }
        rmdirSync(dir);
      } catch (err) {
        cleanupErrors.push(errorMessage(err));
      }
    }

    const rollbackFailed = restoreFailed.size > 0 || cleanupErrors.length > 0;
    const cleanupNote = cleanupErrors.length ? `; rollback cleanup failed: ${cleanupErrors.join('; ')}` : '';
    const results = planned.map((p, index) => {
      const restoreError = restoreFailed.get(index);
      if (restoreError !== undefined) {
        return result(p.op, 'applied', `rollback failed, the change may have applied: ${restoreError}`);
      }
      if (index === failedIndex) return result(p.op, 'failed', `${failure}${cleanupNote}`);
      if (promoted.has(index)) {
        const undone = p.op.operation === 'add' ? 'created, then removed' : 'updated, then restored';
        return result(p.op, 'rolled_back', `${undone} (rolled back)`);
      }
      return result(p.op, 'skipped', `not applied: change set rolled back (${planned[failedIndex]?.op.path} failed)`);
    });
    return { outcome: rollbackFailed ? 'rollback_failed' : 'rolled_back', results };
  }
}

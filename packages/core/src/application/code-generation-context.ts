import { createHash } from 'node:crypto';
import type { ContextFile, WorkspaceRef } from '../domain';
import { classifyCredentialFileContent } from './credential-guard';
import { normalizeRelativePath } from './target-scope';

/**
 * Read-only code-generation context assembly (QA-012). The AI Code Generation request carries NO
 * workspace cwd (CAP-008 review, MB-2), so the provider can only see a target file's CURRENT content if
 * the caller injects it as `contextFiles`. This helper reads each validated target through the EXISTING
 * read-only Workspace capability (`WorkspaceManager.read`, CAP-001 — the same sandboxed provider
 * `readFile` that refuses secret/binary/oversized/out-of-root files) and bounds the result.
 *
 * It never writes, never lists beyond the given targets, never truncates silently, and never guesses
 * targets: on any unreadable target, size overflow, or target whose CONTENT carries credential material
 * (the workspace policy only refuses secret-looking file NAMES) it returns a typed failure so the caller
 * can fail the preview/stage closed (a validated target whose current content cannot be read is a failed
 * preview, never an implicit 'add' — ADR-0039). Pure Application-layer helper; not a capability, port, or
 * adapter.
 *
 * Credential refusals (ADR-0097 D2/D3/D5/D6). The guard reports which detector fired, never the text:
 * - `secret-token` (private-key block or vendor token shape) is refused with `overridable: false`, and no
 *   grant ever admits it.
 * - `credential-assignment` is refused with `overridable: true` plus the content's SHA-256 and the line,
 *   so the conversational caller can raise ONE CRITICAL owner override bound to that exact content. Only
 *   when no hard failure exists anywhere in the target set: any later unreadable (incl. an
 *   adapter-skipped secret FILENAME), oversized or `secret-token` target fails the whole set first, so the
 *   owner is never prompted for a set that could not be sent anyway.
 * - The optional 5th `options.credentialOverrides` admits a refused `credential-assignment` file only for
 *   a CONSUMED grant (see {@link CredentialOverrideGrant}) whose normalized path, SHA-256 and line all
 *   match the content read now; a grant for that path whose content no longer matches fails the set with
 *   `target-changed-since-override` (never a fresh prompt). Granted bytes still count toward both caps.
 *   Binding the grant to owner/session/workspace/project/request/approval, the expiry re-check and the
 *   atomic consumption happen in the override flow BEFORE this call (ADR-0097 D5); this helper is the
 *   final content-side gate in the same turn, immediately before the single dispatch. The
 *   non-conversational `ExecutionOrchestrator` path never passes grants (D6).
 *
 * `targetPath` in a failure is the user-supplied path for the user-facing reply ONLY — never logged;
 * `targetIndex`, `detector`, `contentSha256` and `line` are log-safe.
 */

/** Per-file cap (UTF-8 bytes) on target content injected into a code-generation prompt. */
export const MAX_CODEGEN_CONTEXT_FILE_BYTES = 64 * 1024;
/** Total cap (UTF-8 bytes) across every target injected into one code-generation prompt. */
export const MAX_CODEGEN_CONTEXT_TOTAL_BYTES = 256 * 1024;

export type CodeGenerationContextFailureReason =
  | 'target-read-failed'
  | 'target-too-large'
  | 'context-total-too-large'
  | 'target-contains-credential'
  | 'target-changed-since-override';

/**
 * A one-time owner override for ONE refused `credential-assignment` target (ADR-0097 D5), as handed to
 * {@link readCodeGenerationContextFiles} after the override flow has revalidated its full binding and
 * flipped it to `CONSUMED` in this turn. Content-free: the workspace-relative path, the SHA-256 of the
 * exact content the owner approved, and the detector/line recorded at refusal time.
 */
export interface CredentialOverrideGrant {
  /** Workspace-relative target path (compared after `normalizeRelativePath`). */
  readonly path: string;
  /** Lowercase hex SHA-256 of the target's UTF-8 content at refusal time. */
  readonly contentSha256: string;
  /** Only a credential assignment is ever overridable (`secret-token` never is, D6). */
  readonly detector: 'credential-assignment';
  /** 1-based line of the first credential assignment at refusal time. */
  readonly line: number;
  /** Only a grant consumed in this turn admits content; any other state is ignored (fail closed). */
  readonly state: 'CONSUMED';
}

/** Optional 5th parameter of {@link readCodeGenerationContextFiles}; omitting it keeps the strict refusal. */
export interface CodeGenerationContextOptions {
  readonly credentialOverrides?: readonly CredentialOverrideGrant[];
}

export type CodeGenerationContextResult =
  | { readonly ok: true; readonly contextFiles: ContextFile[] }
  | {
      readonly ok: false;
      readonly reason: Exclude<
        CodeGenerationContextFailureReason,
        'target-contains-credential' | 'target-changed-since-override'
      >;
      /** Index into the deduplicated read order — never the path or content (log-safe). */
      readonly targetIndex: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'target-contains-credential';
      /** Index into the deduplicated read order (log-safe). */
      readonly targetIndex: number;
      /** The user-supplied target path, for the user-facing reply ONLY — never logged. */
      readonly targetPath: string;
      /** A token/private-key shape: never overridable (ADR-0097 D6). */
      readonly detector: 'secret-token';
      readonly overridable: false;
    }
  | {
      readonly ok: false;
      readonly reason: 'target-contains-credential';
      /** Index into the deduplicated read order (log-safe). */
      readonly targetIndex: number;
      /** The user-supplied target path, for the user-facing reply ONLY — never logged. */
      readonly targetPath: string;
      readonly detector: 'credential-assignment';
      /** Eligible for one hash-bound CRITICAL owner override (ADR-0097 D3). */
      readonly overridable: true;
      /** Lowercase hex SHA-256 of the refused content (log-safe; binds the grant). */
      readonly contentSha256: string;
      /** 1-based line of the first credential assignment (log-safe). */
      readonly line: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'target-changed-since-override';
      /** Index into the deduplicated read order (log-safe). */
      readonly targetIndex: number;
      /** The user-supplied target path, for the user-facing reply ONLY — never logged. */
      readonly targetPath: string;
    };

/** The single read-only Workspace method this helper needs (structurally `WorkspaceManager.read`). */
export interface CodeGenerationContextReader {
  read(ref: WorkspaceRef, relPath: string): Promise<string>;
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type OverridableRefusal = Extract<CodeGenerationContextResult, { readonly overridable: true }>;

/**
 * Read the current content of every validated target (skipping explicit new-file targets, which must
 * not exist yet) as `ContextFile[]`, in target order, deduplicated by normalized path. The optional
 * `options` (ADR-0097) are backward compatible: every 4-argument caller keeps the strict refusal.
 */
export async function readCodeGenerationContextFiles(
  workspace: CodeGenerationContextReader,
  ref: WorkspaceRef,
  targetFiles: readonly string[],
  newFileTargets: readonly string[] = [],
  options: CodeGenerationContextOptions = {},
): Promise<CodeGenerationContextResult> {
  const grants = (options.credentialOverrides ?? []).filter(
    (g) => g.state === 'CONSUMED' && g.detector === 'credential-assignment',
  );
  const skip = new Set(newFileTargets.map((p) => normalizeRelativePath(p)));
  const seen = new Set<string>();
  const contextFiles: ContextFile[] = [];
  let total = 0;
  let index = 0;
  // The first un-granted overridable refusal is held back until every target is checked: a hard
  // failure on any target wins, so the owner is never asked to override a set that cannot be sent.
  let pendingOverride: OverridableRefusal | undefined;
  for (const target of targetFiles) {
    const norm = normalizeRelativePath(target);
    if (skip.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    const targetIndex = index++;
    let content: string;
    try {
      content = await workspace.read(ref, target);
    } catch {
      // Includes an adapter-refused secret FILENAME (ADR-0019): Core never has that content, and no
      // grant can admit it.
      return { ok: false, reason: 'target-read-failed', targetIndex };
    }
    const bytes = utf8Bytes(content);
    if (bytes > MAX_CODEGEN_CONTEXT_FILE_BYTES) {
      return { ok: false, reason: 'target-too-large', targetIndex };
    }
    const finding = classifyCredentialFileContent(content);
    if (finding.kind === 'secret-token') {
      return {
        ok: false, reason: 'target-contains-credential', targetIndex, targetPath: target,
        detector: 'secret-token', overridable: false,
      };
    }
    if (finding.kind === 'credential-assignment') {
      const contentSha256 = sha256Hex(content);
      const forPath = grants.filter((g) => normalizeRelativePath(g.path) === norm);
      const admitted = forPath.some((g) => g.contentSha256 === contentSha256 && g.line === finding.line);
      if (!admitted) {
        if (forPath.length > 0) {
          return { ok: false, reason: 'target-changed-since-override', targetIndex, targetPath: target };
        }
        pendingOverride ??= {
          ok: false, reason: 'target-contains-credential', targetIndex, targetPath: target,
          detector: 'credential-assignment', overridable: true, contentSha256, line: finding.line,
        };
      }
    }
    total += bytes;
    if (total > MAX_CODEGEN_CONTEXT_TOTAL_BYTES) {
      return { ok: false, reason: 'context-total-too-large', targetIndex };
    }
    if (!pendingOverride) contextFiles.push({ path: target, content });
  }
  if (pendingOverride) return pendingOverride;
  return { ok: true, contextFiles };
}

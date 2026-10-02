import type { ContextFile, WorkspaceRef } from '../domain';
import { normalizeRelativePath } from './target-scope';

/**
 * Read-only code-generation context assembly (QA-012). The AI Code Generation request carries NO
 * workspace cwd (CAP-008 review, MB-2), so the provider can only see a target file's CURRENT content if
 * the caller injects it as `contextFiles`. This helper reads each validated target through the EXISTING
 * read-only Workspace capability (`WorkspaceManager.read`, CAP-001 — the same sandboxed provider
 * `readFile` that refuses secret/binary/oversized/out-of-root files) and bounds the result.
 *
 * It never writes, never lists beyond the given targets, never truncates silently, and never guesses
 * targets: on any unreadable target or size overflow it returns a typed failure so the caller can fail
 * the preview/stage closed (a validated target whose current content cannot be read is a failed preview,
 * never an implicit 'add' — ADR-0039). Pure Application-layer helper; not a capability, port, or adapter.
 */

/** Per-file cap (UTF-8 bytes) on target content injected into a code-generation prompt. */
export const MAX_CODEGEN_CONTEXT_FILE_BYTES = 64 * 1024;
/** Total cap (UTF-8 bytes) across every target injected into one code-generation prompt. */
export const MAX_CODEGEN_CONTEXT_TOTAL_BYTES = 256 * 1024;

export type CodeGenerationContextFailureReason =
  | 'target-read-failed'
  | 'target-too-large'
  | 'context-total-too-large';

export type CodeGenerationContextResult =
  | { readonly ok: true; readonly contextFiles: ContextFile[] }
  | {
      readonly ok: false;
      readonly reason: CodeGenerationContextFailureReason;
      /** Index into the deduplicated read order — never the path or content (log-safe). */
      readonly targetIndex: number;
    };

/** The single read-only Workspace method this helper needs (structurally `WorkspaceManager.read`). */
export interface CodeGenerationContextReader {
  read(ref: WorkspaceRef, relPath: string): Promise<string>;
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Read the current content of every validated target (skipping explicit new-file targets, which must
 * not exist yet) as `ContextFile[]`, in target order, deduplicated by normalized path.
 */
export async function readCodeGenerationContextFiles(
  workspace: CodeGenerationContextReader,
  ref: WorkspaceRef,
  targetFiles: readonly string[],
  newFileTargets: readonly string[] = [],
): Promise<CodeGenerationContextResult> {
  const skip = new Set(newFileTargets.map((p) => normalizeRelativePath(p)));
  const seen = new Set<string>();
  const contextFiles: ContextFile[] = [];
  let total = 0;
  let index = 0;
  for (const target of targetFiles) {
    const norm = normalizeRelativePath(target);
    if (skip.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    const targetIndex = index++;
    let content: string;
    try {
      content = await workspace.read(ref, target);
    } catch {
      return { ok: false, reason: 'target-read-failed', targetIndex };
    }
    const bytes = utf8Bytes(content);
    if (bytes > MAX_CODEGEN_CONTEXT_FILE_BYTES) {
      return { ok: false, reason: 'target-too-large', targetIndex };
    }
    total += bytes;
    if (total > MAX_CODEGEN_CONTEXT_TOTAL_BYTES) {
      return { ok: false, reason: 'context-total-too-large', targetIndex };
    }
    contextFiles.push({ path: target, content });
  }
  return { ok: true, contextFiles };
}

/**
 * Slice 4 (DECISIONS ADR-0124 section 17): the implementation files whose sha256 enters the CH3 and CH6 plan digests, so a
 * change to the harness, the scorer, the guards, S3, its prompts, the composition or the Ollama / Claude adapters yields a
 * new digest and needs a new owner yes. (Stage R keeps its own list; this list does not add to it.)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../../..');

export const S3_EVAL_IMPLEMENTATION_FILES = [
  // The harness and its CLIs.
  'apps/quoky/src/tools/chunk-s3-eval/implementation.ts',
  'apps/quoky/src/tools/chunk-s3-eval/items.ts',
  'apps/quoky/src/tools/chunk-s3-eval/assemble.ts',
  'apps/quoky/src/tools/chunk-s3-eval/ch3-corpus.ts',
  'apps/quoky/src/tools/chunk-s3-eval/ch3-score.ts',
  'apps/quoky/src/tools/chunk-s3-eval/ch3-eval.ts',
  'apps/quoky/src/tools/chunk-s3-eval/blind-sheet.ts',
  'apps/quoky/src/tools/chunk-s3-eval/local-arm.ts',
  'apps/quoky/src/tools/chunk-s3-eval/injection.ts',
  'apps/quoky/src/tools/chunk-s3-eval-cli.ts',
  'apps/quoky/src/tools/chunk-injection-cli.ts',
  'apps/quoky/src/tools/eval-provider-guard.ts',
  'apps/quoky/src/tools/chunk-eval/corpus.ts',
  // The long-item composition (arm L's provider, pin, gate).
  'apps/quoky/src/item-summary/long-item-composition.ts',
  'apps/quoky/src/item-summary/chunk-items-config.ts',
  // Core: S3, its prompts and the guards both arms pass.
  'packages/core/src/application/item-summary/s3-item-summary.ts',
  'packages/core/src/application/item-summary/document-map-prompt.ts',
  'packages/core/src/application/item-summary/long-item.ts',
  'packages/core/src/application/chunking/boundaries.ts',
  'packages/core/src/application/chunking/code-points.ts',
  'packages/core/src/application/chunking/coverage.ts',
  'packages/core/src/application/chunking/index.ts',
  'packages/core/src/application/chunking/lexical.ts',
  'packages/core/src/application/chunking/pack.ts',
  'packages/core/src/application/chunking/passages.ts',
  'packages/core/src/application/chunking/readout.ts',
  'packages/core/src/application/chunking/token-estimate.ts',
  'packages/core/src/application/chunking/types.ts',
  'packages/core/src/application/untrusted-document-readout.ts',
  'packages/core/src/application/mail/mail-thread-readout.ts',
  'packages/core/src/application/prompt-composer.ts',
  'packages/core/src/application/prompt-renderer.ts',
  'packages/core/src/application/document-summary-claim-check.ts',
  'packages/core/src/application/document-summary-claim-guard.ts',
  'packages/core/src/application/card-spoof.ts',
  'packages/core/src/application/credential-guard.ts',
  'packages/core/src/application/link-neutralizer.ts',
  'packages/core/src/application/chat-policy/chat-response-policy.ts',
  'packages/core/src/application/capability-router.ts',
  'packages/core/src/application/ai-provider-manager.ts',
  'packages/core/src/application/local-provider-dispatch.ts',
  // The adapters (Ollama long-item provider and its local-weights check; the Claude CLI of today's baseline).
  'packages/ai-cli/src/index.ts',
  'packages/ai-cli/src/base-cli-provider.ts',
  'packages/ai-cli/src/cli-runner.ts',
  'packages/ai-cli/src/ollama-local-weights.ts',
  'packages/ai-cli/src/ollama-models.ts',
  'packages/ai-cli/src/output-sanitizer.ts',
] as const;

export type ImplementationHashes = Readonly<Record<string, string>>;

let cache: ImplementationHashes | undefined;

/** Relative module specifiers a TypeScript source imports or re-exports (static and dynamic). */
function relativeImports(source: string): string[] {
  const out: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/gu;
  for (const match of source.matchAll(pattern)) out.push(match[1] as string);
  return out;
}

/** Repo-relative path of the `.ts` file a relative specifier names, or undefined when it is not a source file in the repo. */
function resolveSource(root: string, fromFile: string, specifier: string): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier)).replace(/\.js$/u, '');
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    const full = join(root, candidate);
    if (candidate.endsWith('.ts') && existsSync(full) && statSync(full).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Review round 2 (Codex P1): the hashed set is the listed roots PLUS every source file they reach through relative imports,
 * transitively, so a guard or helper a listed module calls (for example the internal-action claim guard behind the summary
 * claim check) can never change answers without changing the digest. Workspace-package imports are covered because the
 * package entry files the run executes are listed as roots. Sorted for a stable digest.
 */
export function implementationFiles(root: string = REPO_ROOT): readonly string[] {
  const seen = new Set<string>();
  const queue: string[] = [...S3_EVAL_IMPLEMENTATION_FILES];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(root, file), 'utf8');
    for (const specifier of relativeImports(source)) {
      const next = resolveSource(root, file, specifier);
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

/** sha256 of each implementation file (roots and their relative-import closure), read from the repo; cached per process. */
export function implementationHashes(root: string = REPO_ROOT): ImplementationHashes {
  if (root === REPO_ROOT && cache !== undefined) return cache;
  const out: Record<string, string> = {};
  for (const file of implementationFiles(root)) out[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  if (root === REPO_ROOT) cache = out;
  return out;
}

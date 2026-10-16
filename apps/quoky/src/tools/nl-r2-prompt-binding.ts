/**
 * What the Strict digests of the R2 CLIs bind beyond their own inputs (Codex P2): the exact summarisation prompt text the
 * provider receives (PromptComposer's document-summary prompt for every R2 source, first draft AND the one regeneration
 * with its stricter attribution rule, rendered by PromptRenderer) and the git revision. A prompt edit changes the digest.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PromptComposer, PromptRenderer, UNTRUSTED_DOCUMENT_R2_SOURCES, buildUntrustedDocumentReadout, Capability, type ContextBundle, type Task } from '@quoky/core';

const repoRoot = resolve(__dirname, '../../../..');

/** sha256 of each rendered summarisation prompt, keyed `<source>:first` / `<source>:regeneration` (placeholder item, fixed request). */
export function summaryPromptSha256s(): Record<string, string> {
  const composer = new PromptComposer();
  const renderer = new PromptRenderer();
  const task = { id: 'binding', description: '이 항목 요약해줘' } as unknown as Task;
  const out: Record<string, string> = {};
  for (const source of UNTRUSTED_DOCUMENT_R2_SOURCES) {
    const built = buildUntrustedDocumentReadout({ source, title: '제목', author: '', date: '2026-10-17T00:00:00.000Z', body: '본문 예시입니다.' });
    if (!built.ok) throw new Error('binding readout was refused');
    for (const [label, retry] of [['first', false], ['regeneration', true]] as const) {
      const spec = composer.compose(task, {} as ContextBundle, built.readout, retry ? { documentSummaryRetry: true } : {});
      out[`${source}:${label}`] = createHash('sha256').update(renderer.render(spec, { capability: Capability.SUMMARIZATION }).prompt).digest('hex');
    }
  }
  return out;
}

/** The checked-out git revision ('unknown' outside a repository). */
export function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

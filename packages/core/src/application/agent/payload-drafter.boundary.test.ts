import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR-0121 A7-S3: the drafter is dormant and Core-clean. Nothing live can reach it, it names no provider or platform, and its
// pure half imports only the four pure helpers the plan says it reuses.

const HERE = fileURLToPath(new URL('./', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.test(?:-support)?\./.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('A7-S3 drafter boundary', () => {
  it('the pure half imports only the card-spoof matcher, the credential guard, the link neutralizer and the untrusted readout', () => {
    const text = readFileSync(join(HERE, 'payload-drafter.ts'), 'utf8');
    const specifiers = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]).sort();
    expect(specifiers).toEqual(['../card-spoof', '../credential-guard', '../link-neutralizer', '../untrusted-document-readout']);
  });

  it('is reachable from no live path: only quarantined-summary.ts imports it, and only the dormant A7 propose step (a7-propose.ts, A7-S4a) calls the draft functions', () => {
    const files = [...sourceFiles(join(ROOT, 'packages')), ...sourceFiles(join(ROOT, 'apps'))];
    const importers = files.filter((file) => /from\s+['"][^'"]*payload-drafter['"]/.test(readFileSync(file, 'utf8'))).map((file) => relative(ROOT, file));
    expect(importers).toEqual(['packages/core/src/application/agent/quarantined-summary.ts']);
    const callers = files
      .filter((file) => /\b(?:quarantinedDraft|payloadDraftReadiness)\b/.test(codeOf(readFileSync(file, 'utf8'))))
      .map((file) => relative(ROOT, file));
    expect(callers).toEqual(['packages/core/src/application/agent/a7-propose.ts', 'packages/core/src/application/agent/quarantined-summary.ts']);
    expect(readFileSync(join(HERE, 'index.ts'), 'utf8')).not.toMatch(/payload-drafter|quarantinedDraft|payloadDraftReadiness/);
    // A7-S4a: the propose step is itself reached only by the run service (behind the `writeProposal` dep, which the environment cannot
    // build while `active` is refused at startup), and by the index and the tests; no app, runtime or port imports it.
    const proposers = files.filter((file) => /from\s+['"][^'"]*a7-propose['"]/.test(readFileSync(file, 'utf8'))).map((file) => relative(ROOT, file));
    // A7-S4b: the destination listing (`a7-destination.ts`, dormant, in the agent module) shares its fixed refusal lines and one outcome type (no draft function).
    expect(proposers.filter((file) => !file.endsWith('.test.ts'))).toEqual(['packages/core/src/application/agent/a7-destination.ts', 'packages/core/src/application/agent/agent-run-service.ts', 'packages/core/src/application/agent/index.ts']);
  });

  it('names no provider family and no platform, storage or framework in code', () => {
    const drafter = codeOf(readFileSync(join(HERE, 'payload-drafter.ts'), 'utf8'));
    const summary = codeOf(readFileSync(join(HERE, 'quarantined-summary.ts'), 'utf8'));
    const forbidden = /claude|openai|gemini|codex|kiro|discord|telegram|sqlite|nestjs|\bcli\b/i;
    expect(drafter).not.toMatch(forbidden);
    const block = summary.slice(summary.indexOf('export function payloadDraftReadiness'));
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toMatch(forbidden);
    // No provider-id branching in the drafter path (the selector decides by capability, locality, policy).
    expect(block).not.toMatch(/\.id\s*[!=]==|auditId\s*[!=]==/);
  });

  it('holds no connector, proposal port or approval hand-off (a draft is a value; the card is A7-S4)', () => {
    const drafter = codeOf(readFileSync(join(HERE, 'payload-drafter.ts'), 'utf8'));
    expect(drafter).not.toMatch(/connectorWriteFlow|ProposalPort|ApprovalRequest|ConnectorWriter|\bsha256\b|createHash/);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConversationRuntimeDeps } from '../conversation-runtime';

// ADR-0121 D5 / D12 (stage S2 P1): the agent's boundary, pinned.
// - Import ALLOWLIST (CA review): every module specifier of `application/agent/` is a domain module, one of the two ports
//   the agent may name (`ai-provider`, `logger`), the credential guard, a named pure `nl-routing` file, or a sibling `./`
//   file. No barrel (`../../ports`, `..`, `../nl-routing`), no other application service, no node or network module.
//   Dynamic `import(`, `require(` and any `fetch(` (also `globalThis.fetch(`) are refused, and so are the forbidden
//   collaborator names (writers, readers, runners, sinks, memory and learning stores, turn handlers, storage).
// - The deps type of `AgentRunService` holds exactly the router, the actor repository (kill switch), the logger and
//   configuration values.
// - The ConversationRuntimeDeps baseline is 38 with `agentRuns` (ADR-0032 M3 ratchet; ADR-0121 D12 assumed 37, and
//   ADR-0122 took 37 first).

const DIR = new URL('./', import.meta.url);
const SOURCES = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(new URL(name, DIR), 'utf8') }));

/** The named pure `nl-routing` files the agent may import (never the selection service or the barrel). */
// `write-clause` (2026-10-26): the existing reminder and to-do grammars as one pure write probe (no I/O, no state).
// `request-shape` (owner decision of 2026-10-26, a clause-grounded flag): the pure exclusion / negation markers.
// `conjuncts` and `clause-flags` (owner decision of 2026-10-27): the S2 conjuncts and the clause-grounded flag rule, shared
// with the one-step selection path; pure.
// `action-entries` (owner decision of 2026-10-26, the position reference): the A6 catalog data (`item.summarize`'s source
// enum, the item-summary sources) and the A6-D2 index grounding (`nlIndexWording`); pure data and grammar, no I/O.
const ALLOWED_NL_ROUTING = ['catalog', 'selection-input', 'selection-output', 'selection-prompt', 'selection-validator', 'selection-meaning', 'selection-egress', 'symbolic-time', 'action-switch', 'read-statement', 'statement-guard', 'write-clause', 'action-entries', 'request-shape', 'garbled-action', 'conjuncts', 'clause-flags'];

function allowedSpecifier(specifier: string): boolean {
  if (/^\.\.\/\.\.\/domain(?:\/[a-z-]+)?$/.test(specifier)) return true;
  if (specifier === '../../ports/ai-provider.port' || specifier === '../../ports/logger.port') return true;
  if (specifier === '../credential-guard') return true;
  if (specifier === '../call-usage-log-fields') return true;
  // ADR-0121 D3 (P3-3b): the link neutralizer and the untrusted-document readout (the untrusted span), both pure.
  if (specifier === '../link-neutralizer' || specifier === '../untrusted-document-readout') return true;
  // The document action-claim guard (pure: its only import is a type), run on every model-derived summary line.
  if (specifier === '../document-summary-claim-guard') return true;
  // ADR-0121 A1-E1: the frozen ADR-0104 help grammar (a pure module with no imports) for the help split.
  if (specifier === '../help-intent/help-intent') return true;
  if (ALLOWED_NL_ROUTING.some((name) => specifier === `../nl-routing/${name}`)) return true;
  return /^\.\/[a-z-]+$/.test(specifier);
}

/** Every static specifier: `import … from`, `export … from` and a side-effect `import '…'`. */
function specifiersOf(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)].map((match) => (match[1] ?? match[2]) as string);
}

/** Dynamic loading, network and process calls in code. */
const FORBIDDEN_CALLS = /\bimport\s*\(|\brequire\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|(?<![.\w])(?:spawn|exec|execFile|fork)\s*\(/;
const FORBIDDEN_NAMES =
  /\b(?:CommandRunner|ToolProvider|WorkspaceWriter|ConnectorWriter|ChannelMessageWriter|IssueCommentWriter|IssueTransitionWriter|IssueCreateWriter|MemoryManager|MemoryWriter|LearningRepository|ReminderRepository|NotificationSink|PlatformAdapter|CalendarReader|MailReader|DriveReader|ConnectorProvider|ConversationTurnHandler|StorageProvider)\b/;

const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('application/agent boundary (ADR-0121 D5)', () => {
  it('scans every source file, and every check catches what it must (calibration)', () => {
    expect(SOURCES.map((source) => source.name).sort()).toEqual(['agent-contract-check.ts', 'agent-run-service.ts', 'conjuncts.ts', 'flow-policy.ts', 'help-split.ts', 'index.ts', 'plan-executor.ts', 'plan-prompt.ts', 'plan-schema.ts', 'plan-validator.ts', 'quarantined-summary.ts', 'read-write-probe.ts', 'reply-assembler.ts', 'reply-notes.ts', 'run-bounds.ts', 'structure-projector.ts', 'unbounded-ask.ts']);
    // The help grammar the help split may import is itself import-free (pure).
    expect(specifiersOf(readFileSync(new URL('../help-intent/help-intent.ts', DIR), 'utf8'))).toEqual([]);
    // The claim guard the summaries pass through is pure: its only import is a type (erased).
    const claimGuard = readFileSync(new URL('../document-summary-claim-guard.ts', DIR), 'utf8');
    expect(specifiersOf(claimGuard)).toEqual(['./untrusted-document-readout']);
    expect(claimGuard).toMatch(/^import type \{ UntrustedDocumentSource \} from '\.\/untrusted-document-readout';$/m);
    const refused = [
      '../memory-writer',
      '../reminders/reminder-repository',
      '../../ports',
      '..',
      '../nl-routing',
      '../nl-routing/nl-selection-service',
      '../help-intent/help-intent-turn-handler',
      '../../ports/conversation-turn-handler.port',
      '../../ports/command-runner.port',
      '../../ports/tool-provider.port',
      '../memory-manager',
      'http',
      'https',
      'child_process',
      'node:child_process',
      'node:http',
      // Built from fragments: the UNC-1 source rule forbids the client's name as a literal anywhere in Core.
      'undi' + 'ci',
    ];
    for (const specifier of refused) expect(allowedSpecifier(specifier), specifier).toBe(false);
    for (const specifier of ['../../domain', '../../domain/flow-label', '../../ports/logger.port', '../nl-routing/catalog', '../nl-routing/selection-egress', './plan-schema']) {
      expect(allowedSpecifier(specifier), specifier).toBe(true);
    }
    expect(specifiersOf("import 'node:http';\nexport * from './x';\nimport type { A } from \"../y\";")).toEqual(['node:http', './x', '../y']);
    for (const code of ['await fetch(url)', 'globalThis.fetch(url)', "await import('node:http')", "require('child_process')", 'spawn("claude")']) expect(code).toMatch(FORBIDDEN_CALLS);
    for (const code of ['deps: { writer: MemoryWriter }', 'runner: CommandRunner', 'repo: ReminderRepository']) expect(code).toMatch(FORBIDDEN_NAMES);
    expect('FENCED.exec(text)').not.toMatch(FORBIDDEN_CALLS);
  });

  it('imports only from the allowlist', () => {
    for (const source of SOURCES) {
      for (const specifier of specifiersOf(source.text)) expect(allowedSpecifier(specifier), `${source.name}: ${specifier}`).toBe(true);
    }
  });

  it('reaches no adapter, writer, repository, runner or application service through any runtime import chain (CA suggestion, review of 0bde31cc)', () => {
    const src = new URL('../../', DIR);
    const resolveFrom = (from: URL, specifier: string): URL | undefined => {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        const url = new URL(candidate, from);
        try {
          readFileSync(url);
          return url;
        } catch {
          continue;
        }
      }
      return undefined;
    };
    // Runtime (value) imports only: `import type …` and all-`type` named imports are erased by the compiler.
    const runtimeSpecifiers = (text: string): string[] =>
      [...text.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm)].flatMap((match) => {
        if (match[1] !== undefined) return [];
        const names = /\{([^}]*)\}/.exec(match[0])?.[1];
        if (names !== undefined && names.split(',').map((name) => name.trim()).filter((name) => name.length > 0).every((name) => name.startsWith('type '))) return [];
        return [match[2] as string];
      });
    const seen = new Map<string, string | undefined>();
    const queue: Array<[URL, string | undefined]> = SOURCES.map((source) => [new URL(source.name, DIR), undefined]);
    while (queue.length > 0) {
      const [url, parent] = queue.pop() as [URL, string | undefined];
      if (seen.has(url.href)) continue;
      seen.set(url.href, parent);
      for (const specifier of runtimeSpecifiers(readFileSync(url, 'utf8'))) {
        const next = resolveFrom(url, specifier);
        if (next !== undefined) queue.push([next, url.href]);
      }
    }
    const relative = (href: string): string => href.slice(src.href.length);
    const refused = [...seen.keys()].map(relative).filter((path) => {
      if (path.startsWith('application/agent/') || path.startsWith('domain/') || path.startsWith('ports/')) return false;
      return /(?:^|\/)adapters?\//.test(path) || /(?:-service|writer|repository|runner|adapter|storage|turn-handler)[^/]*\.ts$/.test(path);
    });
    expect(refused).toEqual([]);
    // The probe is not vacuous: the chain does reach the pure nl-routing and ports modules.
    expect([...seen.keys()].map(relative).some((path) => path.startsWith('application/nl-routing/'))).toBe(true);
  });

  it('has no dynamic import, require or fetch, and names no forbidden collaborator', () => {
    for (const source of SOURCES) {
      const code = codeOf(source.text);
      expect(code, source.name).not.toMatch(FORBIDDEN_CALLS);
      expect(code, source.name).not.toMatch(FORBIDDEN_NAMES);
    }
  });

  // The deps and request key sets are pinned at compile time in `agent-contract-check.ts` (a non-test file under `tsc -b`):
  // a test file is not type-checked, so a key-set assertion here would be vacuous.
  it('the dependency contracts are pinned in a compiled file that nothing imports at runtime and the index does not export', () => {
    const check = SOURCES.find((source) => source.name === 'agent-contract-check.ts');
    expect(check).toBeDefined();
    const text = (check as { text: string }).text;
    for (const name of ['AgentPlanExecutorDeps', 'AgentSummarizerDeps', 'AgentReadPort', 'AgentReadRequest', 'QuarantinedSummarizerModel', 'AgentRunServiceDeps']) expect(text).toContain(name);
    expect(text).toContain("'summarizer'");
    expect(text).toContain("'auditId'");
    expect(text).not.toMatch(/^export (?:const|function|class|let)\b/m);
    for (const source of SOURCES) expect(source.text, source.name).not.toContain('agent-contract-check');
  });

  it('the executor, the projector and the bounds name no collaborator beyond the allowlist (calibration of the executor files)', () => {
    for (const name of ['plan-executor.ts', 'structure-projector.ts', 'run-bounds.ts']) {
      const source = SOURCES.find((candidate) => candidate.name === name);
      expect(source, name).toBeDefined();
      const specifiers = specifiersOf((source as { text: string }).text);
      for (const specifier of specifiers) expect(allowedSpecifier(specifier), `${name}: ${specifier}`).toBe(true);
    }
  });
});

describe('ConversationRuntimeDeps baseline (ADR-0032 M3, ADR-0121 S2 note)', () => {
  it('is 38 with agentRuns (the offline Stage 2A routing seam is not counted)', () => {
    // Compile-time exhaustive: adding or removing a deps key breaks this literal.
    const keys: Record<keyof ConversationRuntimeDeps, true> = {
      dispatchCommit: true, actors: true, sessions: true, memory: true, memoryWriter: true, classifier: true,
      projects: true, analyzer: true, tasks: true, workspace: true, commandExecutions: true, command: true,
      contextBuilder: true, promptComposer: true, promptRenderer: true, router: true, runtimeProviderRouting: true,
      artifacts: true, composer: true, workSurface: true, intentResolver: true, orchestrator: true, approvals: true,
      approvalFlow: true, scopeClarificationFlow: true, applyPreviewFlow: true, codeGeneration: true, patch: true,
      codeProposals: true, workspaceWrite: true, git: true, repositoryHosting: true, turnHandlers: true,
      credentialOverrideFlow: true, connectorWriteFlow: true, nlSelection: true, surfaceGrants: true, agentRuns: true, logger: true,
    };
    expect(Object.keys(keys).filter((key) => key !== 'runtimeProviderRouting')).toHaveLength(38);
    expect(Object.keys(keys)).toContain('agentRuns');
  });
});

describe('Core reaches the process only through the test-seam barrier (ADR-0121 P3-3b, R1)', () => {
  const CORE = new URL('../../', import.meta.url);
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const PROCESS = /\bprocess\s*[.?]|\bglobalThis\b[^;\n]*\bprocess\b/;
  function coreSources(dir: URL, relative: string, out: { path: string; text: string }[]): { path: string; text: string }[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir);
      if (entry.isDirectory()) coreSources(child, `${relative}${entry.name}/`, out);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push({ path: `${relative}${entry.name}`, text: strip(readFileSync(child, 'utf8')) });
    }
    return out;
  }

  it('assertTestRuntime in quarantined-summary.ts is the only reference to `process` in packages/core/src, besides deadline-policy.ts (process.hrtime)', () => {
    const files = coreSources(CORE, '', []);
    expect(files.some((file) => file.path === 'application/agent/quarantined-summary.ts')).toBe(true);
    const hits = files.filter((file) => PROCESS.test(file.text)).map((file) => file.path).sort();
    // `deadline-policy.ts` is the one pre-existing reference (`process.hrtime`, a monotonic clock); nothing else may name the process.
    expect(hits).toEqual(['application/agent/quarantined-summary.ts', 'application/deadline-policy.ts']);
    const own = files.find((file) => file.path === 'application/agent/quarantined-summary.ts')?.text ?? '';
    const barrier = /function assertTestRuntime\(\): void \{[\s\S]*?\n\}/.exec(own)?.[0] ?? '';
    expect(barrier).toMatch(PROCESS);
    expect(own.replace(barrier, '')).not.toMatch(PROCESS);
    const deadline = files.find((file) => file.path === 'application/deadline-policy.ts')?.text ?? '';
    expect(deadline.split('\n').filter((line) => PROCESS.test(line)).map((line) => line.trim())).toEqual(['nowMs: () => Number(process.hrtime.bigint()) / 1_000_000,']);
    // The scan catches what it must.
    expect(PROCESS.test('const x = process.env.A;')).toBe(true);
    expect(PROCESS.test('(globalThis as { process?: unknown }).process')).toBe(true);
    expect(PROCESS.test('const processed = 1;')).toBe(false);
  });
});

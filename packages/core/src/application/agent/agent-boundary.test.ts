import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConversationRuntimeDeps } from '../conversation-runtime';
import type { AgentRunServiceDeps } from './agent-run-service';

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
// `action-entries` (owner decision of 2026-10-26, the position reference): the A6 catalog data (`item.summarize`'s source
// enum, the item-summary sources) and the A6-D2 index grounding (`nlIndexWording`); pure data and grammar, no I/O.
const ALLOWED_NL_ROUTING = ['catalog', 'selection-input', 'selection-output', 'selection-prompt', 'selection-validator', 'selection-meaning', 'selection-egress', 'symbolic-time', 'action-switch', 'read-statement', 'statement-guard', 'write-clause', 'action-entries', 'request-shape'];

function allowedSpecifier(specifier: string): boolean {
  if (/^\.\.\/\.\.\/domain(?:\/[a-z-]+)?$/.test(specifier)) return true;
  if (specifier === '../../ports/ai-provider.port' || specifier === '../../ports/logger.port') return true;
  if (specifier === '../credential-guard') return true;
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
    expect(SOURCES.map((source) => source.name).sort()).toEqual(['agent-run-service.ts', 'conjuncts.ts', 'flow-policy.ts', 'help-split.ts', 'index.ts', 'plan-prompt.ts', 'plan-schema.ts', 'plan-validator.ts', 'read-write-probe.ts', 'reply-notes.ts', 'unbounded-ask.ts']);
    // The help grammar the help split may import is itself import-free (pure).
    expect(specifiersOf(readFileSync(new URL('../help-intent/help-intent.ts', DIR), 'utf8'))).toEqual([]);
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

  it('the service deps type holds only the router, the actor repository, the logger and configuration', () => {
    const keys: Record<keyof AgentRunServiceDeps, true> = { mode: true, router: true, actors: true, logger: true, timeZone: true, timeoutMs: true, elapsed: true, caps: true };
    expect(Object.keys(keys).sort()).toEqual(['actors', 'caps', 'elapsed', 'logger', 'mode', 'router', 'timeZone', 'timeoutMs']);
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

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConversationRuntimeDeps } from '../conversation-runtime';
import type { AgentRunServiceDeps } from './agent-run-service';

// ADR-0121 D5 / D12 (stage S2 P1): the agent's boundary, pinned.
// - Import scan: no file of `application/agent/` imports or names a CommandRunner, a ToolProvider (MCP), a workspace or
//   git writer, a connector writer, a reader, memory or learning writers, a platform/notification sink, or any fetch.
// - The deps type of `AgentRunService` holds exactly the router, the actor repository (kill switch), the logger and
//   configuration values.
// - The ConversationRuntimeDeps baseline is 38 with `agentRuns` (ADR-0032 M3 ratchet; ADR-0121 D12 assumed 37, and
//   ADR-0122 took 37 first).

const DIR = new URL('./', import.meta.url);
const SOURCES = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(new URL(name, DIR), 'utf8') }));

/** Module specifiers and identifiers the agent must never reach. */
const FORBIDDEN_IMPORTS = [
  /command-runner/,
  /tool-provider/,
  /workspace-writer|workspace-provider|workspace-write/,
  /git-provider|git-manager/,
  /connector-write|connector-provider|connector-manager/,
  /calendar-reader|mail-reader|drive-reader/,
  /memory-manager|durable-memory|learning-repository|learning/,
  /notification-sink|platform-adapter/,
  /storage-provider|vector-provider|queue-provider/,
  /repository-hosting/,
  /node:(?:http|https|net|tls|child_process|dgram|fs)/,
  /^(?:undici|axios|node-fetch)$/,
];
// A global call (not a method such as `RegExp.prototype.exec`; child_process is refused by the import scan above).
const FORBIDDEN_IDENTIFIERS = /(?<![.\w])(?:CommandRunner|ToolProvider|WorkspaceWriter|ConnectorWriter|ChannelMessageWriter|IssueCommentWriter|IssueTransitionWriter|MemoryManager|MemoryWriter|LearningRepository|NotificationSink|PlatformAdapter|CalendarReader|MailReader|DriveReader|ConnectorProvider|fetch|XMLHttpRequest|WebSocket|spawn|exec)\s*\(|\b(?:CommandRunner|ToolProvider|ConnectorProvider|MemoryManager|LearningRepository|NotificationSink|CalendarReader|MailReader|DriveReader)\b/;

describe('application/agent boundary (ADR-0121 D5)', () => {
  it('scans every source file (sanity: the scan is not vacuous)', () => {
    expect(SOURCES.map((source) => source.name).sort()).toEqual(['agent-run-service.ts', 'flow-policy.ts', 'index.ts', 'plan-prompt.ts', 'plan-schema.ts', 'plan-validator.ts']);
    // Calibration: the patterns catch what they must.
    for (const code of ['await fetch(url)', 'deps: { runner: CommandRunner }', 'new MemoryManager(x)', 'spawn("claude")']) expect(code).toMatch(FORBIDDEN_IDENTIFIERS);
    for (const specifier of ['../../ports/command-runner.port', '../../ports/tool-provider.port', '../memory-manager', 'node:child_process', 'undici']) {
      expect(FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier)), specifier).toBe(true);
    }
    expect('FENCED.exec(text)').not.toMatch(FORBIDDEN_IDENTIFIERS);
  });

  it('imports no command runner, tool provider, writer, reader, memory/learning writer, sink, storage or network module', () => {
    for (const source of SOURCES) {
      const specifiers = [...source.text.matchAll(/(?:import|export)[^'"]*from\s+'([^']+)'/g)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        for (const pattern of FORBIDDEN_IMPORTS) expect(specifier, `${source.name}: ${specifier}`).not.toMatch(pattern);
      }
    }
  });

  it('names no forbidden collaborator and calls no fetch, spawn or exec', () => {
    for (const source of SOURCES) {
      const code = source.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, source.name).not.toMatch(FORBIDDEN_IDENTIFIERS);
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

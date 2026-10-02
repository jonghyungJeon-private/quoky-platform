import { describe, expect, it, vi } from 'vitest';
import { CodeGenerationManager } from './code-generation-manager';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { AiProviderError } from '../errors';
import { AiFailureKind, Capability, CodeGenerationStatus } from '../domain';
import type {
  AiExecutionResult,
  AiRequest,
  CodeGeneration,
  CodeProposal,
  GenerateCodeInput,
} from '../domain';
import type { AiProvider, ProviderSelector, StorageProvider } from '../ports';

const planRef = { id: 'plan-1', goal: 'add a feature' };
const envelope = (obj: unknown) => '```json\n' + JSON.stringify(obj) + '\n```';
const OK = envelope({ changes: [{ path: 'src/a.ts', newContent: 'export const a = 1;\n' }] });

/** In-memory codeGenerations + codeProposals stores + a fake provider/selector. */
function harness(execImpl: (req: AiRequest) => Promise<AiExecutionResult>) {
  const gens = new Map<string, CodeGeneration>();
  const props = new Map<string, CodeProposal>();
  const storage = {
    codeGenerations: {
      async get(id: string) {
        return gens.get(id) ?? null;
      },
      async save(g: CodeGeneration) {
        gens.set(g.id, g);
        return g;
      },
      async delete(id: string) {
        gens.delete(id);
      },
      async list() {
        return [...gens.values()];
      },
      async findByExecutionPlan(id: string) {
        return [...gens.values()].filter((g) => g.executionPlanRef.id === id);
      },
    },
    codeProposals: {
      async get(id: string) {
        return props.get(id) ?? null;
      },
      async save(p: CodeProposal) {
        props.set(p.id, p);
        return p;
      },
      async delete(id: string) {
        props.delete(id);
      },
      async list() {
        return [...props.values()];
      },
      async findByCodeGeneration(id: string) {
        return [...props.values()].filter((p) => p.codeGenerationRef.id === id);
      },
    },
  } as unknown as StorageProvider;

  const execute = vi.fn(execImpl);
  const provider: AiProvider = {
    id: 'fake-codex',
    capabilities: [{ capability: Capability.CODE_IMPLEMENTATION, priority: 100 }],
    isAvailable: async () => true,
    execute,
  };
  const selector: ProviderSelector = { select: async () => provider };
  const mgr = new CodeGenerationManager(storage, selector, new PromptComposer(), new PromptRenderer());
  return { mgr, storage, execute, gens, props };
}

function input(over: Partial<GenerateCodeInput> = {}): GenerateCodeInput {
  return { executionPlanRef: planRef, instruction: 'add a()', ...over };
}

describe('CodeGenerationManager (CAP-008, ADR-0029)', () => {
  it('SUCCEEDED: parses the proposal, records CodeGeneration + linked CodeProposal', async () => {
    const { mgr, execute } = harness(async () => ({ text: OK }));
    const gen = await mgr.generate(input());
    expect(gen.status).toBe(CodeGenerationStatus.SUCCEEDED);
    expect(gen.capability).toBe(Capability.CODE_IMPLEMENTATION); // default capability
    expect(gen.codeProposalRef?.id).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);

    const proposal = await mgr.getProposal(gen);
    expect(proposal?.proposal).toEqual([{ path: 'src/a.ts', newContent: 'export const a = 1;\n' }]);
    expect(proposal?.providerId).toBe('fake-codex');
  });

  it('hands the provider a rendered AiRequest (prompt string), never a PromptSpec', async () => {
    const { mgr, execute } = harness(async () => ({ text: OK }));
    await mgr.generate(input({ instruction: 'implement the parser' }));
    const req = execute.mock.calls[0]![0] as AiRequest;
    expect(typeof req.prompt).toBe('string');
    expect(req.prompt).toContain('implement the parser'); // the instruction is the task
    expect(req.capability).toBe(Capability.CODE_IMPLEMENTATION);
    expect((req as unknown as { promptSpec?: unknown }).promptSpec).toBeUndefined();
  });

  it('does NOT hand the provider a workspace cwd (no Workspace bypass), but records workspaceRef', async () => {
    const { mgr, execute } = harness(async () => ({ text: OK }));
    const workspaceRef = { id: 'w1', rootPath: '/repo', kind: 'local-clone' as const };
    const gen = await mgr.generate(input({ workspaceRef }));
    const req = execute.mock.calls[0]![0] as AiRequest;
    expect(req.workspace).toBeUndefined(); // MB-2: provider gets no direct workspace access
    expect(gen.workspaceRef?.id).toBe('w1'); // still recorded on the aggregate (read-only ref)
  });

  it('FAILED + classified failureKind when the provider errors (no proposal persisted)', async () => {
    const { mgr } = harness(async () => {
      throw new AiProviderError(AiFailureKind.TIMEOUT, 'codex timed out');
    });
    const gen = await mgr.generate(input());
    expect(gen.status).toBe(CodeGenerationStatus.FAILED);
    expect(gen.failureKind).toBe(AiFailureKind.TIMEOUT);
    expect(gen.codeProposalRef).toBeUndefined();
    expect(await mgr.getProposal(gen)).toBeNull();
  });

  it('FAILED when the AI output cannot be parsed into a proposal', async () => {
    const { mgr } = harness(async () => ({ text: 'I cannot help with that.' }));
    const gen = await mgr.generate(input());
    expect(gen.status).toBe(CodeGenerationStatus.FAILED);
    expect(gen.failureKind).toBe(AiFailureKind.EMPTY_OUTPUT);
  });

  it('FAILED/EMPTY_OUTPUT (never a zero-change SUCCEEDED) when the AI returns an empty changes array plus prose (QA-012)', async () => {
    const { mgr, props } = harness(async () => ({
      text: 'I cannot read src/greet.js, so here is nothing:\n' + envelope({ changes: [] }),
    }));
    const gen = await mgr.generate(input({ targetFiles: ['src/greet.js'] }));
    expect(gen.status).toBe(CodeGenerationStatus.FAILED);
    expect(gen.failureKind).toBe(AiFailureKind.EMPTY_OUTPUT);
    expect(gen.codeProposalRef).toBeUndefined();
    expect(props.size).toBe(0);
  });

  it('renders caller-supplied contextFiles (current target content) into the provider prompt (QA-012)', async () => {
    const { mgr, execute } = harness(async () => ({ text: OK }));
    const current = 'function greet(name) {\n  return "hello " + name;\n}\n';
    await mgr.generate(input({ targetFiles: ['src/greet.js'], contextFiles: [{ path: 'src/greet.js', content: current }] }));
    const req = execute.mock.calls[0]![0] as AiRequest;
    expect(req.prompt).toContain('### src/greet.js');
    expect(req.prompt).toContain(current);
    expect(req.workspace).toBeUndefined(); // still no cwd — content arrives only via the prompt
  });

  it('records into the history (queryable by ExecutionPlan)', async () => {
    const { mgr } = harness(async () => ({ text: OK }));
    const gen = await mgr.generate(input());
    expect((await mgr.findByExecutionPlan('plan-1')).map((g) => g.id)).toContain(gen.id);
  });

  it('honors an explicit capability override', async () => {
    const { mgr } = harness(async () => ({ text: OK }));
    const gen = await mgr.generate(input({ capability: Capability.CODE_REVIEW }));
    expect(gen.capability).toBe(Capability.CODE_REVIEW);
  });
});

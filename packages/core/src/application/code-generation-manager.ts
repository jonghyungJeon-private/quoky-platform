import { newId } from '../util/id';
import { now } from '../util/clock';
import { AiProviderError } from '../errors';
import { AiFailureKind, Capability, CodeGenerationStatus, codeProposalRef } from '../domain';
import type {
  CodeGeneration,
  CodeGenerationDispatch,
  CodeProposal,
  GenerateCodeInput,
  Id,
  ProposedChange,
} from '../domain';
import type { AiProvider, ProviderSelector, StorageProvider } from '../ports';
import type { PromptComposer } from './prompt-composer';
import type { PromptRenderer } from './prompt-renderer';
import { parseCodeProposal } from './code-proposal-parser';

/**
 * An exception that escaped {@link CodeGenerationManager.generate} AFTER `provider.execute()` was invoked
 * (ADR-0097 truthful copy): `dispatch` says whether the provider returned (`sent`) or the call itself threw
 * (`uncertain`). Any other exception out of generate() was raised before the provider was invoked — nothing was
 * sent ({@link codeGenerationDispatchOfError}).
 */
export class CodeGenerationDispatchedError extends Error {
  constructor(
    readonly dispatch: Exclude<CodeGenerationDispatch, 'not-sent'>,
    cause: unknown,
  ) {
    super(`code generation failed after provider dispatch (${dispatch})`, { cause });
    this.name = 'CodeGenerationDispatchedError';
  }
}

/** The transmission state implied by an exception thrown out of {@link CodeGenerationManager.generate}. */
export function codeGenerationDispatchOfError(err: unknown): CodeGenerationDispatch {
  return err instanceof CodeGenerationDispatchedError ? err.dispatch : 'not-sent';
}

function failureKindOf(err: unknown): AiFailureKind {
  return err instanceof AiProviderError ? err.kind : AiFailureKind.EXECUTION_FAILED;
}

/**
 * CAP-008 AI Code Generation (ADR-0029). Owns BOTH AI-Layer aggregates — the
 * `CodeGeneration` run record and the `CodeProposal` output — and is the only
 * capability that mutates them. It ORCHESTRATES only:
 *
 *   PromptComposer → PromptSpec → PromptRenderer → AiRequest → (ProviderSelector) AiProvider
 *   → parse → CodeGeneration (+ CodeProposal)
 *
 * The AI authors a **proposal** (`ProposedChange[]`); it never decides, approves,
 * applies, runs, or calls git. It references the plan/workspace via Refs, imports no
 * other capability manager, and stays HTTP/`child_process`-free (the provider adapter
 * owns all external AI interaction). Provider selection is delegated to
 * `ProviderSelector`; prompt authorship to `PromptComposer`; rendering to `PromptRenderer`.
 */
export class CodeGenerationManager {
  constructor(
    private readonly storage: StorageProvider,
    private readonly selector: ProviderSelector,
    private readonly promptComposer: PromptComposer,
    private readonly promptRenderer: PromptRenderer,
  ) {}

  /**
   * Generate a code proposal for a plan. Exactly ONE generation per call (no retry —
   * that is the Orchestrator's concern). Always records a `CodeGeneration`; on success
   * also records a `CodeProposal` and links it. Failures are classified (ADR-0015) and
   * recorded as `FAILED` — the manager never throws past a recorded outcome. The returned value carries
   * `dispatch` (whether the prompt reached the provider); an exception thrown after `provider.execute()` was
   * invoked is a {@link CodeGenerationDispatchedError}.
   */
  async generate(input: GenerateCodeInput): Promise<CodeGeneration> {
    const capability = input.capability ?? Capability.CODE_IMPLEMENTATION;

    // Compose (authorship) → render (PromptSpec → AiRequest). The provider never sees PromptSpec.
    const spec = this.promptComposer.composeCodeGeneration({
      instruction: input.instruction,
      ...(input.targetFiles ? { targetFiles: input.targetFiles } : {}),
      ...(input.contextFiles ? { contextFiles: input.contextFiles } : {}),
    });
    // The AI Code Generation request carries NO workspace cwd (CAP-008 review, MB-2):
    // handing the provider a workspace root would let it read/traverse the repo itself,
    // bypassing the Workspace Read capability (CAP-001). Read-only context must arrive via
    // `contextFiles`/`prompt`; direct workspace access is future Agent-Runtime scope. The
    // `workspaceRef` is still recorded on the CodeGeneration aggregate (read-only reference).
    const aiRequest = this.promptRenderer.render(spec, {
      capability,
      ...(input.contextFiles ? { contextFiles: input.contextFiles } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });

    // Record the run as PENDING → GENERATING before calling the provider.
    const ts = now();
    const base: CodeGeneration = {
      id: newId(),
      executionPlanRef: input.executionPlanRef,
      capability,
      status: CodeGenerationStatus.PENDING,
      ...(input.workspaceRef ? { workspaceRef: input.workspaceRef } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.storage.codeGenerations.save({
      ...base,
      status: CodeGenerationStatus.GENERATING,
      updatedAt: ts,
    });

    // Select a provider by capability (no concrete CLI named here). A selection failure is recorded before
    // anything was handed to a provider: `not-sent`.
    let provider: AiProvider;
    try {
      provider = await this.selector.select(capability);
    } catch (err) {
      return this.fail(base, failureKindOf(err), 'not-sent');
    }

    // From here on `provider.execute()` is invoked, so an exception escaping generate() (e.g. a storage write
    // failing) carries how far the run got — callers must never report such a run as "nothing was sent".
    let dispatch: Exclude<CodeGenerationDispatch, 'not-sent'> = 'uncertain';
    try {
      let text: string;
      let artifacts: CodeProposal['artifacts'];
      try {
        const result = await provider.execute(aiRequest);
        text = result.text;
        artifacts = result.artifacts;
      } catch (err) {
        // Invoked, then threw/timed out: whether the prompt reached the provider cannot be confirmed.
        return await this.fail(base, failureKindOf(err), 'uncertain');
      }
      dispatch = 'sent';

      // Parse the (provider-agnostic) proposal. Malformed output → FAILED (not a source of truth).
      let proposal: ProposedChange[];
      try {
        proposal = parseCodeProposal(text);
      } catch {
        return await this.fail(base, AiFailureKind.EMPTY_OUTPUT, 'sent');
      }

      // Persist the OUTPUT aggregate first, then link it from the run aggregate.
      const succeededRef = { id: base.id, status: CodeGenerationStatus.SUCCEEDED };
      const codeProposal: CodeProposal = {
        id: newId(),
        codeGenerationRef: succeededRef,
        proposal,
        providerId: provider.id,
        ...(artifacts ? { artifacts } : {}),
        createdAt: now(),
      };
      await this.storage.codeProposals.save(codeProposal);

      const generation: CodeGeneration = {
        ...base,
        status: CodeGenerationStatus.SUCCEEDED,
        codeProposalRef: codeProposalRef(codeProposal),
        updatedAt: now(),
      };
      return { ...(await this.storage.codeGenerations.save(generation)), dispatch: 'sent' };
    } catch (err) {
      throw new CodeGenerationDispatchedError(dispatch, err);
    }
  }

  private async fail(
    base: CodeGeneration,
    failureKind: AiFailureKind,
    dispatch: CodeGenerationDispatch,
  ): Promise<CodeGeneration> {
    const generation: CodeGeneration = {
      ...base,
      status: CodeGenerationStatus.FAILED,
      failureKind,
      updatedAt: now(),
    };
    // `dispatch` rides on the returned value only (never persisted — see `CodeGeneration.dispatch`).
    return { ...(await this.storage.codeGenerations.save(generation)), dispatch };
  }

  async get(id: Id): Promise<CodeGeneration | null> {
    return this.storage.codeGenerations.get(id);
  }

  /** The proposal produced by a generation, if it succeeded. */
  async getProposal(generation: CodeGeneration): Promise<CodeProposal | null> {
    return generation.codeProposalRef
      ? this.storage.codeProposals.get(generation.codeProposalRef.id)
      : null;
  }

  /** Code-generation history for a given ExecutionPlan. */
  async findByExecutionPlan(executionPlanId: Id): Promise<CodeGeneration[]> {
    return this.storage.codeGenerations.findByExecutionPlan(executionPlanId);
  }
}

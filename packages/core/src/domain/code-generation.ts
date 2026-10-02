import type { Id, IsoTimestamp, Metadata } from './common';
import type { CodeGenerationStatus, Capability, AiFailureKind } from './enums';
import type { ExecutionPlanRef } from './execution-plan';
import type { WorkspaceRef, ProposedChange } from './workspace';
import type { ContextFile } from './memory';
import type { Artifact } from './artifact';

/**
 * AI Code Generation's RUN aggregate (CAP-008, ADR-0029). Records ONE AI
 * code-generation run: which plan it authored for, the capability, the outcome, and
 * a `CodeProposalRef` to the produced proposal (on success). The heavy/produced data
 * lives on the separate `CodeProposal` aggregate — `CodeGeneration` holds only the Ref
 * (CA Round-1 split). Owned & mutated ONLY by AI Code Generation; it references the
 * plan/workspace via Refs and never mutates them.
 *
 * AI authors a proposal — it never decides, approves, applies, or executes; it owns no
 * downstream aggregate (PatchSet/WorkspaceChange/CommandExecution/ApprovalRequest).
 */
export interface CodeGeneration {
  id: Id;
  executionPlanRef: ExecutionPlanRef;
  capability: Capability;
  status: CodeGenerationStatus;
  /** The produced proposal (set only when SUCCEEDED). */
  codeProposalRef?: CodeProposalRef;
  /** Classified failure (ADR-0015) when the run failed; absent on success. */
  failureKind?: AiFailureKind;
  /** Read-only workspace the generation was contextualized against, if any. */
  workspaceRef?: WorkspaceRef;
  /**
   * Whether this run's prompt reached the AI provider (ADR-0097 truthful copy). Set by the manager on the
   * value `generate()` RETURNS only — a run-outcome fact, not persisted (a stored record never carries it).
   */
  dispatch?: CodeGenerationDispatch;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * Transmission state of one code-generation run (ADR-0097 truthful copy):
 * - `not-sent`  — failed before `provider.execute()` was invoked (no provider available/selected, …);
 * - `sent`      — `execute()` returned output (even if parsing or anything later failed);
 * - `uncertain` — `execute()` was invoked and threw/timed out, so delivery cannot be confirmed.
 */
export type CodeGenerationDispatch = 'not-sent' | 'sent' | 'uncertain';

/** Lightweight handle (V2 Ref model). */
export interface CodeGenerationRef {
  id: Id;
  status: CodeGenerationStatus;
}

/** Pure derivation of a CodeGenerationRef from the aggregate. */
export function codeGenerationRef(generation: CodeGeneration): CodeGenerationRef {
  return { id: generation.id, status: generation.status };
}

/**
 * AI Code Generation's OUTPUT aggregate (CAP-008, ADR-0029). Carries the produced
 * **proposal** (`ProposedChange[]`) and provider metadata. Owned by AI Code Generation
 * (the AI Layer owns BOTH `CodeGeneration` and `CodeProposal`); back-references its
 * run via `codeGenerationRef`. The proposal is what Patch (CAP-005) later consumes —
 * AI never builds a PatchSet and never applies the proposal.
 */
export interface CodeProposal {
  id: Id;
  /** The run that produced this proposal. */
  codeGenerationRef: CodeGenerationRef;
  /** The authored change set — the contract handed downstream (CAP-001 value object). */
  proposal: ProposedChange[];
  /** Which AiProvider served the run (audit only; e.g. 'codex-cli'). */
  providerId: string;
  /** Reserved provider usage passthrough (token accounting is NOT computed — Non-blocking). */
  usage?: Metadata;
  /** Raw structured outputs the run produced, if any. */
  artifacts?: Artifact[];
  createdAt: IsoTimestamp;
}

/** Lightweight handle (V2 Ref model). */
export interface CodeProposalRef {
  id: Id;
}

/** Pure derivation of a CodeProposalRef from the aggregate. */
export function codeProposalRef(proposal: CodeProposal): CodeProposalRef {
  return { id: proposal.id };
}

/**
 * Input to AI code generation (CAP-008). The caller composes ALL read-only context
 * here (instruction from the plan, target files, prior context) — the capability
 * never reaches into Workspace/Planning itself (composition happens above it).
 */
export interface GenerateCodeInput {
  executionPlanRef: ExecutionPlanRef;
  /** Defaults to CODE_IMPLEMENTATION. */
  capability?: Capability;
  /** What to generate (from the plan goal/step). */
  instruction: string;
  /** Read-only workspace reference for context (never written by this capability). */
  workspaceRef?: WorkspaceRef;
  /** Read-only context injected as files (caller-supplied from Memory/Workspace). */
  contextFiles?: ContextFile[];
  /** Target file paths the plan expects to touch. */
  targetFiles?: string[];
  timeoutMs?: number;
}

import type {
  Artifact,
  Capability,
  ContextFile,
  InboundImageMimeType,
  Metadata,
  WorkspaceRef,
} from '../domain';

/**
 * One image of an `IMAGE_UNDERSTANDING` request (ADR-0111 D1/D4): the runner-owned local temporary file the platform
 * adapter wrote (an `InboundImageAttachment.imageRef`), valid only until the turn settles. A provider reads it in place
 * and never copies, persists, embeds or logs it.
 */
export interface AiImageInput {
  readonly path: string;
  readonly mimeType: InboundImageMimeType;
}

/**
 * What a provider can do, and how strongly it should be preferred for it.
 * This is the data that makes provider selection POLICY-DRIVEN rather than
 * hardcoded. The core sorts available providers by `priority` for a capability
 * and picks the top — it never names a concrete CLI.
 *
 * Example v1 priorities (advertised by each concrete provider, NOT by core):
 *   OllamaCliProvider  GENERAL_CHAT=100  SUMMARIZATION=100
 *   CodexCliProvider   CODE_IMPLEMENTATION=100  TEST_EXECUTION=80
 *   ClaudeCliProvider  ARCHITECTURE_PLANNING=100  CODE_REVIEW=90  + every
 *                      capability at a low priority so it is the universal fallback.
 */
export interface AiCapabilityDescriptor {
  capability: Capability;
  /** Higher wins. Ties broken by provider order. */
  priority: number;
}

/**
 * A FULLY-RENDERED, provider-agnostic AI request (CAP-008, ADR-0029). The provider
 * receives only this — it never sees a `PromptSpec`. Prompt authorship is the
 * `PromptComposer`'s job and rendering (`PromptSpec` → `prompt` text) is the
 * `PromptRenderer`'s job (ADR-0003 / ADR-0014); the provider just executes.
 */
export interface AiRequest {
  capability: Capability;
  /** The rendered instruction text (produced by the PromptRenderer). */
  prompt: string;
  /**
   * Memory injected as files. The core generates these from Quoky Memory;
   * the provider's only job is to ensure the CLI can see them (typically by
   * having them written into the workspace before invocation).
   */
  contextFiles?: ContextFile[];
  /** The directory the CLI runs in, if the capability touches a workspace. */
  workspace?: WorkspaceRef;
  timeoutMs?: number;
  metadata?: Metadata;
  /**
   * ADR-0111 D1/D5 (optional, additive): images for an `IMAGE_UNDERSTANDING` request. Core sets it only for a provider
   * that advertises that capability AND declares `executionLocality: 'LOCAL'`; every other request omits it.
   */
  images?: readonly AiImageInput[];
}

export interface AiExecutionResult {
  /** Primary text output, already provider-agnostic. */
  text: string;
  /** Structured outputs (diffs, patches, logs) the run produced. */
  artifacts?: Artifact[];
  /** Sanitized, provider-owned audit facts for TaskRun persistence. */
  audit?: Metadata;
  /** Raw CLI output for debugging; never surfaced to the user by default. */
  raw?: Metadata;
}

/**
 * Where a provider executes (ADR-0107 D6, ARCHITECTURE.md §5.14). `LOCAL` means the request never leaves this host;
 * anything else — including an absent declaration — counts as `REMOTE` (fail closed).
 */
export type AiExecutionLocality = 'LOCAL' | 'REMOTE';

/**
 * The provider's declared execution locality, failing closed: only an explicit `'LOCAL'` declaration is `LOCAL`; an
 * absent or unknown value is `REMOTE`. Read as data, like `capabilities` — never derived from the provider `id`.
 */
export function executionLocalityOf(provider: Pick<AiProvider, 'executionLocality'>): AiExecutionLocality {
  return provider.executionLocality === 'LOCAL' ? 'LOCAL' : 'REMOTE';
}

/**
 * PORT: an AI execution backend. v1 implementations wrap CLIs
 * (ClaudeCliProvider, CodexCliProvider, OllamaCliProvider). NO HTTP API in v1.
 *
 * Boundary rule: the core depends ONLY on this interface. It must never import
 * a concrete provider, branch on `id`, or assume a specific CLI exists.
 */
export interface AiProvider {
  /** Stable id for audit/logging only, e.g. "claude-cli". */
  readonly id: string;
  /** Capabilities this provider serves, with selection priorities. */
  readonly capabilities: readonly AiCapabilityDescriptor[];
  /**
   * Declared execution locality (ADR-0107 D6). Optional; absent means `REMOTE`. Read it through
   * {@link executionLocalityOf}. `LOCAL_ONLY` data (curated learning examples) reaches only a `LOCAL` provider.
   */
  readonly executionLocality?: AiExecutionLocality;

  /** Health/auth probe. Ollama may be down; Claude/Codex may be unauthed. */
  isAvailable(): Promise<boolean>;

  execute(request: AiRequest): Promise<AiExecutionResult>;

  /** Optional streaming for long runs; core falls back to execute() if absent. */
  stream?(request: AiRequest): AsyncIterable<string>;
}

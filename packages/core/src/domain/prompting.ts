import type { Id, IsoTimestamp, Metadata } from './common';
import type {
  DurableMemoryAuthorityLevel,
  DurableMemoryKind,
  DurableMemoryProvenance,
  DurableMemoryScope,
} from './durable-memory';

/** Where prompt context originated (ADR-0063). */
export type ContextProvenance =
  | 'CORE_RUNTIME'
  | 'USER'
  | 'ASSISTANT'
  | 'PROJECT_MEMORY'
  | 'LEGACY_UNKNOWN'
  | DurableMemoryProvenance;

/** How strongly a provider may rely on prompt context (ADR-0063). */
export type EpistemicStatus =
  | 'AUTHORITATIVE_CURRENT_FACT'
  | 'USER_CLAIM_OR_INTENT'
  | 'ASSISTANT_NON_AUTHORITATIVE'
  | 'NON_AUTHORITATIVE_TRANSCRIPT'
  | 'NON_AUTHORITATIVE_BACKGROUND';

/** A persisted conversation turn, kept structured until prompt composition. */
export interface ConversationTranscriptEntry {
  /** One-based conversational turn number; a User message and its Assistant reply share it. */
  turnNumber?: number;
  /** Explicit conversational role, retained separately from provenance for provider rendering. */
  role?: 'user' | 'assistant' | 'unknown';
  content: string;
  provenance: 'USER' | 'ASSISTANT' | 'LEGACY_UNKNOWN';
  epistemicStatus:
    | 'USER_CLAIM_OR_INTENT'
    | 'ASSISTANT_NON_AUTHORITATIVE'
    | 'NON_AUTHORITATIVE_TRANSCRIPT';
}

/** Stored project context is useful background, not current-state evidence. */
export interface BackgroundResource {
  content: string;
  provenance: 'PROJECT_MEMORY';
  epistemicStatus: 'NON_AUTHORITATIVE_BACKGROUND';
}

/** Durable recall remains attributed, non-authoritative background (ADR-0073). */
export interface DurableRecallEntry {
  content: string;
  provenance: DurableMemoryProvenance;
  epistemicStatus: 'NON_AUTHORITATIVE_BACKGROUND';
  relevanceScore: number;
  retrievalReason: string;
  source: {
    memoryId: Id;
    kind: DurableMemoryKind;
    authorityLevel: DurableMemoryAuthorityLevel;
    scope: DurableMemoryScope;
    createdAt: IsoTimestamp;
    updatedAt: IsoTimestamp;
    metadata: Readonly<Metadata>;
  };
}

/**
 * One owner-curated few-shot example selected for a GENERAL_CHAT turn (ADR-0107 D5, LRN-2). Owner-approved text from
 * the learning store; never a fact, never current state, never part of the conversation. Its egress is
 * `LOCAL_ONLY`: `PromptComposer` layers it only for a provider that declares `LOCAL` execution (ADR-0107 D6).
 */
export interface CuratedExampleEntry {
  /** The owner's request text of the example. */
  requestText: string;
  /** The owner-approved ideal answer. */
  idealAnswer: string;
  /** ADR-0107 D2: the only egress value in v3. */
  egress: 'LOCAL_ONLY';
  provenance: 'OWNER_CURATED_EXAMPLE';
  epistemicStatus: 'NON_AUTHORITATIVE_EXAMPLE';
  /** The `learning_items` id (audit and tests only; never rendered into a prompt). */
  learningItemId: Id;
}

/**
 * Assembled, budgeted context for a single execution (ADR-0002 / ADR-0063).
 * Current-turn facts stay on Task; this bundle owns only bounded conversation
 * history and non-authoritative background resources.
 */
export interface ContextBundle {
  taskId: Id;
  /** Recent short-term conversation turns (oldest → newest). */
  conversationTranscript: ConversationTranscriptEntry[];
  /** Active-project memory, when present, as non-authoritative background. */
  backgroundResources: BackgroundResource[];
  /** Optional durable recall, always separate from exact conversation transcript. */
  durableRecall?: DurableRecallEntry[];
  /**
   * Owner-curated examples selected for this GENERAL_CHAT turn (ADR-0107 D5), present only when
   * `QUOKY_LEARNING_EXAMPLES_ENABLED=true` and at least one example qualified. Selection is not consent to egress:
   * the composer layers them only for a provider that declares `LOCAL` execution (ADR-0107 D6).
   */
  curatedExamples?: CuratedExampleEntry[];
}

/**
 * Provider-agnostic, layered prompt (ADR-0003 / ADR-0014). The PromptComposer
 * (core) builds it; an AiProvider adapter RENDERS it to a CLI-ready form. The
 * core never renders provider-specific text.
 */
export interface PromptSpec {
  /** Stable identity/rules for the assistant. */
  system: string;
  /** Per-capability instruction (what kind of task this is). */
  developer: string;
  /** Rendered context from the ContextBundle (may be empty). */
  context: string;
  /** The user's actual request. */
  task: string;
}

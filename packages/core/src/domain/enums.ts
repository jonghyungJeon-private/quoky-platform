/**
 * Domain enumerations. These are stable, framework-agnostic value types.
 * Nothing here may reference a concrete provider, Discord, or SQLite.
 */

/** Lifecycle of a unit of work. See the task model in the architecture docs. */
export enum TaskStatus {
  PENDING = 'PENDING',
  PLANNING = 'PLANNING',
  WAITING_APPROVAL = 'WAITING_APPROVAL',
  RUNNING = 'RUNNING',
  TESTING = 'TESTING',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
  COMPLETED = 'COMPLETED',
  NEEDS_REVIEW = 'NEEDS_REVIEW',
}

/** Lifecycle of a conversation Session (ADR-0001). */
export enum SessionStatus {
  ACTIVE = 'ACTIVE',
  IDLE = 'IDLE',
  CLOSED = 'CLOSED',
}

/** Status of a single execution attempt of a task. */
export enum TaskRunStatus {
  STARTED = 'STARTED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
}

/** Durable boundary for the first normal Provider effect of a TaskRun. */
export enum ProviderDispatchState {
  PRE_DISPATCH = 'PRE_DISPATCH',
  DISPATCH_COMMITTED = 'DISPATCH_COMMITTED',
  LEGACY_UNKNOWN = 'LEGACY_UNKNOWN',
}

/**
 * Risk drives the approval gate.
 * LOW/MEDIUM may run automatically; HIGH/CRITICAL require explicit approval.
 */
export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/**
 * Capabilities are ABOVE models. The user asks for an outcome; the core maps
 * the intent to a capability, and the router selects whichever AiProvider can
 * serve that capability best. No capability is tied to a concrete CLI here.
 */
export enum Capability {
  GENERAL_CHAT = 'GENERAL_CHAT',
  SUMMARIZATION = 'SUMMARIZATION',
  DOCUMENT_ANALYSIS = 'DOCUMENT_ANALYSIS',
  CODE_IMPLEMENTATION = 'CODE_IMPLEMENTATION',
  CODE_REVIEW = 'CODE_REVIEW',
  ARCHITECTURE_PLANNING = 'ARCHITECTURE_PLANNING',
  TEST_EXECUTION = 'TEST_EXECUTION',
  READONLY_LOOKUP = 'READONLY_LOOKUP',
  PROJECT_ANALYSIS = 'PROJECT_ANALYSIS',
  EMBEDDING = 'EMBEDDING',
}

/** What the user is (probably) trying to do, before it becomes a Capability. */
export enum IntentType {
  CHAT = 'CHAT',
  SUMMARIZE = 'SUMMARIZE',
  ANALYZE_DOCUMENT = 'ANALYZE_DOCUMENT',
  IMPLEMENT_CODE = 'IMPLEMENT_CODE',
  REVIEW_CODE = 'REVIEW_CODE',
  PLAN_ARCHITECTURE = 'PLAN_ARCHITECTURE',
  RUN_TESTS = 'RUN_TESTS',
  LOOKUP = 'LOOKUP',
  REGISTER_PROJECT = 'REGISTER_PROJECT',
  PROJECT_ANALYSIS = 'PROJECT_ANALYSIS',
  UNKNOWN = 'UNKNOWN',
}

/** Quoky Memory is the source of truth — never the CLI's internal memory. */
export enum MemoryType {
  SHORT_TERM = 'SHORT_TERM',
  WORKING = 'WORKING',
  LONG_TERM = 'LONG_TERM',
  PROJECT = 'PROJECT',
  TOOL = 'TOOL',
  CONNECTOR = 'CONNECTOR',
}

/**
 * Provider-agnostic failure taxonomy (ADR-0015). An AiProvider classifies its
 * failure into one of these; the core maps the kind to a user-facing message
 * and records it on the TaskRun. The core never branches on a provider id.
 */
export enum AiFailureKind {
  UNAVAILABLE = 'UNAVAILABLE',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  TIMEOUT = 'TIMEOUT',
  EXECUTION_FAILED = 'EXECUTION_FAILED',
  EMPTY_OUTPUT = 'EMPTY_OUTPUT',
}

/** AI outputs are first-class artifacts, not plain text. */
export enum ArtifactKind {
  MARKDOWN_REPORT = 'MARKDOWN_REPORT',
  CODE_DIFF = 'CODE_DIFF',
  PATCH = 'PATCH',
  TEST_LOG = 'TEST_LOG',
  JIRA_REPORT = 'JIRA_REPORT',
  SLACK_SUMMARY = 'SLACK_SUMMARY',
  CONFLUENCE_DRAFT = 'CONFLUENCE_DRAFT',
  DOCUMENT_SUMMARY = 'DOCUMENT_SUMMARY',
}

/**
 * Lifecycle of an ExecutionPlan and its steps (CAP-003, ADR-0024). Planning
 * creates them as PENDING; later capabilities (Approval, Patch, Workspace Write)
 * transition them. Reserved now to avoid future domain ripple.
 */
export enum ExecutionStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXECUTING = 'EXECUTING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/** Lifecycle of an ApprovalRequest aggregate (CAP-004, ADR-0025). */
export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * Status of a PatchSet (CAP-005, ADR-0026). Intentionally minimal: Patch only
 * GENERATES. Application/outcome states (APPLIED/FAILED/EXECUTED) belong to
 * Workspace Write / Command Execution, never to Patch.
 */
export enum PatchStatus {
  GENERATED = 'GENERATED',
}

/**
 * Lifecycle of a WorkspaceChange — the Execution History aggregate for applying a
 * PatchSet (CAP-006, ADR-0027). Owned/mutated only by Workspace Write. Set kept
 * stable so a future Rollback capability needs no change.
 */
export enum WorkspaceChangeStatus {
  PENDING = 'PENDING',
  APPLYING = 'APPLYING',
  APPLIED = 'APPLIED',
  PARTIALLY_APPLIED = 'PARTIALLY_APPLIED',
  FAILED = 'FAILED',
}

/**
 * Lifecycle of a CommandExecution — the Execution History aggregate for running a
 * command (CAP-007, ADR-0028). Owned/mutated only by Command Execution. The last
 * aggregate of the Execution Ledger (after WorkspaceChange).
 */
export enum CommandExecutionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  TIMED_OUT = 'TIMED_OUT',
}

/**
 * Lifecycle of a CodeGeneration — the AI Layer's run record for one code-generation
 * request (CAP-008, ADR-0029). Owned/mutated only by AI Code Generation. The AI
 * authors a proposal; it never decides, approves, applies, or executes.
 */
export enum CodeGenerationStatus {
  PENDING = 'PENDING',
  GENERATING = 'GENERATING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

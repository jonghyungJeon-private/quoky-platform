/**
 * Dependency-injection tokens for the ports.
 *
 * TypeScript interfaces do not exist at runtime, so the composition root (the
 * NestJS app) cannot inject them by type. It binds a concrete implementation
 * to one of these tokens instead. The core depends only on the token + the
 * interface — never on a concrete class.
 *
 * `AI_PROVIDERS` and `CONNECTOR_PROVIDERS` are intentionally plural: the core
 * receives the full SET and selects among them by capability/availability.
 */
export const PLATFORM_ADAPTER = Symbol('PlatformAdapter');
export const STORAGE_PROVIDER = Symbol('StorageProvider');
export const QUEUE_PROVIDER = Symbol('QueueProvider');
export const VECTOR_PROVIDER = Symbol('VectorProvider');
export const WORKSPACE_PROVIDER = Symbol('WorkspaceProvider');
export const GIT_PROVIDER = Symbol('GitProvider');
// CAP-010 RepositoryHosting skeleton (Sprint 3d-B, ADR-0052). Token only — NO real provider is bound in
// `app.module.ts` in 3d-B; no GitHub adapter exists yet.
export const REPOSITORY_HOSTING_PROVIDER = Symbol('RepositoryHostingProvider');
export const WORKSPACE_WRITER = Symbol('WorkspaceWriter');
export const COMMAND_RUNNER = Symbol('CommandRunner');
export const EXECUTION_PLANNER = Symbol('ExecutionPlanner');
export const PROVIDER_SELECTOR = Symbol('ProviderSelector');
export const AI_PROVIDERS = Symbol('AiProviders');
export const CONNECTOR_PROVIDERS = Symbol('ConnectorProviders');
export const TOOL_PROVIDERS = Symbol('ToolProviders');
// M3E-4 explicit admission persistence; no runtime binding yet.
export const CONTINUATION_BINDING_REPOSITORY = Symbol('ContinuationBindingRepository');
// Personal v2 integration seams (ADR-0096 D8) — pre-registered in wave 1 so no later task edits this file.
// The deterministic turn-handler registry: the composition root binds the full, statically ordered handler list.
export const CONVERSATION_TURN_HANDLERS = Symbol('ConversationTurnHandlers');
// Inert until their track ADRs' tasks bind them: feedback capture (ADR-0098), owner reminders and notification
// delivery (ADR-0101).
export const FEEDBACK_REPOSITORY = Symbol('FeedbackRepository');
export const REMINDER_REPOSITORY = Symbol('ReminderRepository');
export const NOTIFICATION_SINK = Symbol('NotificationSink');
// Personal v3 (ADR-0107 D2, LRN-1): the owner-curated learning store. Also the seam the ADR-0106 memory forget path
// (MEM-1) calls to delete learning items derived from a forgotten memory record (ADR-0107 D7).
export const LEARNING_REPOSITORY = Symbol('LearningRepository');
// Personal v3 (ADR-0110 D1, CAL-1): the read-only calendar reader. Bound only when a calendar is fully configured
// (CAL-2 composition); absent means no calendar, and QUAL-7 routing stays unchanged (ADR-0110 D5).
export const CALENDAR_READER = Symbol('CalendarReader');
// Personal v3 (ADR-0112 D2/D3, ADR-0110 amendment; CWR-1): narrow connector write ports and the v15 write receipts.
// Bound only when connector writes are enabled and allowlisted (CWR-2 composition); absent means writes stay refused.
export const ISSUE_COMMENT_WRITER = Symbol('IssueCommentWriter');
export const ISSUE_TRANSITION_WRITER = Symbol('IssueTransitionWriter');
export const CHANNEL_MESSAGE_WRITER = Symbol('ChannelMessageWriter');
export const CALENDAR_EVENT_WRITER = Symbol('CalendarEventWriter');
export const CONNECTOR_WRITE_RECEIPT_REPOSITORY = Symbol('ConnectorWriteReceiptRepository');

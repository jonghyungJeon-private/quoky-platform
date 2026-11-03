# Module map: `packages/core/src/application/conversation-runtime/`

Purpose: the per-message conversation flow of Quoky Core (ADR-0032), split from one large file into a layered class chain plus helper modules. Read this before opening the 14 files.

## Entry from outside

- The public class is `ConversationRuntime` in `packages/core/src/application/conversation-runtime.ts` (a sibling file, not inside the directory). It `extends ConversationRuntimeExecutionImageLayer` (the bottom of the chain), re-exports the public types from `./conversation-runtime/types`, and implements `handle(message)`, the per-message entry that sequences the stages.
- The directory has no `index.ts`. Only `conversation-runtime.ts` imports its files (verified for non-test code); outside code imports `./conversation-runtime` (via `application/index.ts`, `export * from './conversation-runtime'`).
- Importers of `./conversation-runtime` in `packages/core/src/application/`: `orchestrator.ts` (type `ConversationRuntime`, `TurnResult`), `approval-decision-service.ts`, `stateless-approval-flow.ts`, `stateless-scope-clarification-flow.ts`, `stateless-apply-preview-flow.ts` (`ApplyPreviewAnchor`, `ApplyPreviewAnchorIdentity`, `ApplyPreviewFlow`), `turn-delivery.ts` (flow and result types). `approval-decision.ts` deliberately does not import it (avoids a circular import; it keeps a local copy of `ApprovalDecisionKind`).
- Tests live next to it as `application/conversation-runtime*.test.ts` (the main one is very large; run a single file, not the full suite).

## Class chain (inheritance, base to leaf)

The layers are abstract classes in a single linear `extends` chain. Each layer calls methods defined in the layers above it (its ancestors) and may declare methods that lower layers call. Order, from the root:

1. `runtime-base.ts` `ConversationRuntimeBase`: constructor and dependency wiring, pending-approval lookup/expiry, reply composition helpers, repository-hosting lookup failures, surface-grant gating (surface gate, permit, denial replies, scope switch near-miss), `runGatedHandler`.
2. `chat-layer.ts` `ConversationRuntimeChatLayer`: general chat turn, NL last-turn/last-reply/last-selection bookkeeping, NL ask replies, reply guards (action-claim guard, document-summary claim check, withheld attachment replies), work-chat turn.
3. `turn-handler-layer.ts` `ConversationRuntimeTurnHandlerLayer`: control stage and the registered `ConversationTurnHandler` stages (control / post-anchor / pre-classify), document summary, connector-write draft and anchor turns.
4. `nl-dispatch-layer.ts` `ConversationRuntimeNlDispatchLayer`: natural-language capability selection and action dispatch (early NL action, NL selection, shadow runs, deictic drafts, catalog and help topics, agent start after reply).
5. `code-generation-layer.ts` `ConversationRuntimeCodeGenerationLayer`: approval turn, code-generation preview (prepare, generate, failure paths), credential-override flow (ADR-0097).
6. `apply-layer.ts` `ConversationRuntimeApplyLayer`: preview discard, apply approval, patch generation, workspace apply, post-apply validation, git status/diff preview.
7. `git-commit-push-layer.ts` `ConversationRuntimeGitCommitPushLayer`: commit approval and execution, push approval and execution.
8. `git-pr-merge-layer.ts` `ConversationRuntimeGitPrMergeLayer`: PR creation and status, merge approval and execution, main sync, local and remote branch cleanup.
9. `execution-image-layer.ts` `ConversationRuntimeExecutionImageLayer`: execution intents (test runs), workspace resolution, scope clarification turn, image-understanding turn, internal-action status turn.
10. `conversation-runtime.ts` `ConversationRuntime` (outside the directory): `handle()`.

Hence a call such as "apply layer to code-generation layer" is an inherited-method call, not an import-time call; method-level edges follow the chain upward (a layer may call anything defined by its ancestors, never by its descendants, except through abstract declarations).

## Non-class modules

- `types.ts`: shared public types and the dependency/option bags (`TurnResult`, `RuntimeTurnStatus`, `ConversationRuntimeDeps`, `ConversationRuntimeOptions`, approval/scope-clarification/apply-preview flow and anchor types). Imported by almost every file here; keep it free of runtime logic.
- `internal-types.ts`: types private to the directory (`NlChatFacts`, `RecentConnectorWrite`, `PreparedCodeGeneration`, `CodeGenerationPreparation`, `NlEarlySelection`). Used inside the directory (chat, turn-handler, nl-dispatch, code-generation) and by the sibling `../conversation-runtime.ts` (`NlChatFacts`, `NlEarlySelection`).
- `helpers.ts`: pure helper functions shared by layers (dispatch-grant comparison, approval-reason builders for commit/push/PR/merge/remote cleanup, git ref and repository identity checks, preview mappers, `SurfaceDeniedError`, `orderTurnHandlers`). Imports `intent-words.ts` constants.
- `intent-words.ts`: deterministic word and shape constants for apply, patch, commit, push, PR, merge, sync, cleanup and the limits around them (`MAX_COMMIT_CANDIDATE_FILES`, `PROTECTED_COMMIT_BRANCHES`). Constants only.
- `turn-intents.ts`: pure `interpret*` functions that turn message text and anchor state into typed intents (decision, apply, patch, commit, push, PR, merge, main sync, cleanup), plus helpers for new-file requests and NL routes. Used by all layers except nl-dispatch.

## Import relationships between the files (module level)

- Chain edges (`extends`): see the list above. Additionally, `git-pr-merge-layer` imports `git-commit-push-layer`, which imports `apply-layer`, which imports `code-generation-layer`; and `execution-image-layer` imports `git-pr-merge-layer`.
- `types.ts` is imported by every file except `helpers.ts` and `internal-types.ts`. `helpers.ts` is imported by runtime-base, chat, turn-handler, nl-dispatch, code-generation, apply, git-commit-push and git-pr-merge. `turn-intents.ts` is imported by runtime-base, chat, turn-handler, code-generation, apply, git-commit-push, git-pr-merge and execution-image. `intent-words.ts` is imported by helpers, turn-intents, git-commit-push, git-pr-merge and execution-image. `internal-types.ts` is imported by chat, turn-handler, nl-dispatch and code-generation.
- Outbound dependencies go to sibling application modules (`../approval-decision-service`, `../execution-orchestrator`, `../code-generation-manager`, `../git-manager`, `../repository-hosting-manager`, `../nl-routing/*`, `../surface-grants/*`, `../connector-writes/*`, `../work-chat/*`, `../chat-policy/*`, `../code-work/*`, `../target-scope`) and to `../../domain` and `../../ports`. Core stays provider-neutral: no concrete adapter is imported.
- Cycle caveat: `approval-decision-service.ts` imports from `./conversation-runtime` and `conversation-runtime/runtime-base.ts` imports `../approval-decision-service`; type-only imports and the local `ApprovalDecisionKind` copy in `approval-decision.ts` exist to avoid circularity. Keep new shared types in `types.ts`, not in a layer.

## When changing it

- A new turn behavior belongs in the layer that matches its stage; a new pure interpretation goes in `turn-intents.ts`, a new word constant in `intent-words.ts`. Do not add provider or platform branches (AGENTS.md engineering rules).
- Adding a method to a lower layer that an upper layer must call needs an abstract declaration or a move upward in the chain.

Sources: `packages/core/src/application/conversation-runtime/*.ts` (class `extends` lines and import blocks), `packages/core/src/application/conversation-runtime.ts`, `packages/core/src/application/index.ts`, `packages/core/src/application/approval-decision.ts` (circular-import comment), ADR-0032 in `DECISIONS.md`.

import type { Provider } from '@nestjs/common';
import {
  FEEDBACK_REPOSITORY,
  FeedbackRecorder,
  FeedbackSummaryTurnHandler,
  STORAGE_PROVIDER,
} from '@quoky/core';
import type { ConversationTurnHandler, FeedbackRepository, StorageProvider } from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import { FEEDBACK_TURN_HANDLERS } from './feature-tokens';

/**
 * Answer-feedback capture and summary (ADR-0098 D3–D6, QUAL-4) — feature composition (ADR-0096 D7).
 *
 * - `FEEDBACK_REPOSITORY`: a lazy view over the storage provider's feedback repository. Storage repositories are
 *   assigned at `init()`, after DI construction, so every call resolves `storage.feedback` at call time (the same
 *   pattern as `CONTINUATION_BINDING_REPOSITORY`). `FeedbackRepository` is not part of `StorageProvider`.
 * - `FeedbackRecorder`: best-effort, content-free capture; `QuokyCore` records turns and reactions through it.
 * - `FEEDBACK_TURN_HANDLERS`: the `피드백 요약` control-stage handler (order 100), which also contributes the
 *   👍/👎 and `피드백 요약` help lines.
 */

/** The storage provider seen structurally: the concrete SQLite provider also exposes its feedback repository. */
type FeedbackCapableStorage = StorageProvider & { readonly feedback: FeedbackRepository };

const feedbackLogger = new ConsoleLogger('feedback');

export const feedbackProviders: Provider[] = [
  {
    provide: FEEDBACK_REPOSITORY,
    useFactory: (storage: FeedbackCapableStorage): FeedbackRepository => ({
      saveTurn: (turn) => storage.feedback.saveTurn(turn),
      findTurnByPlatformMessage: (platform, platformMessageId) =>
        storage.feedback.findTurnByPlatformMessage(platform, platformMessageId),
      findPreviousTurn: (location, before, withinMs) => storage.feedback.findPreviousTurn(location, before, withinMs),
      upsertSignal: (signal) => storage.feedback.upsertSignal(signal),
      summarize: (query) => storage.feedback.summarize(query),
      pruneOlderThan: (cutoff, maxRows) => storage.feedback.pruneOlderThan(cutoff, maxRows),
    }),
    inject: [STORAGE_PROVIDER],
  },
  {
    provide: FeedbackRecorder,
    useFactory: (repository: FeedbackRepository, storage: StorageProvider) =>
      new FeedbackRecorder(repository, { get: (id) => storage.sessions.get(id) }, { logger: feedbackLogger }),
    inject: [FEEDBACK_REPOSITORY, STORAGE_PROVIDER],
  },
  {
    provide: FEEDBACK_TURN_HANDLERS,
    useFactory: (recorder: FeedbackRecorder, storage: StorageProvider): readonly ConversationTurnHandler[] => [
      new FeedbackSummaryTurnHandler({
        feedback: recorder,
        tasks: { get: (id) => storage.tasks.get(id) },
        logger: feedbackLogger,
      }),
    ],
    inject: [FeedbackRecorder, STORAGE_PROVIDER],
  },
];

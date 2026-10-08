import type { Provider } from '@nestjs/common';
import {
  FEEDBACK_REPOSITORY,
  FeedbackRecorder,
  FeedbackSummaryTurnHandler,
  LEARNING_REPOSITORY,
  LearningService,
  LearningTurnHandler,
  STORAGE_PROVIDER,
} from '@quoky/core';
import type { ConversationTurnHandler, FeedbackRepository, LearningRepository, StorageProvider } from '@quoky/core';
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
 *   👍/👎 and `피드백 요약` help lines (its reply gains the ADR-0107 D3 👎-rate trend through `FeedbackRecorder.trend`),
 *   and the ADR-0107 D3 learning-command handler (`pre-classify`, order 60).
 * - `LEARNING_REPOSITORY` (ADR-0107 D2): a lazy view over the storage provider's learning store, like
 *   `FEEDBACK_REPOSITORY`. It is also the seam the ADR-0106 memory forget path calls
 *   (`LearningMemoryForgetCascade.deleteBySourceMemory`, ADR-0107 D7). No reply-text lookup is bound: v3 stores no
 *   reply text, so the owner supplies an example's ideal answer (`예시 N 수정: …`).
 */

/** The storage provider seen structurally: the concrete SQLite provider also exposes its feedback and learning stores. */
type FeedbackCapableStorage = StorageProvider & { readonly feedback: FeedbackRepository };
type LearningCapableStorage = StorageProvider & { readonly learning: LearningRepository };

const feedbackLogger = new ConsoleLogger('feedback');
const learningLogger = new ConsoleLogger('learning');

export interface FeedbackCompositionOptions {
  /** ADR-0116 R4: disclose in the learning copy that examples may accompany an owner-selected cloud model. */
  readonly remoteExamplesDisclosure?: boolean;
}

export function createFeedbackProviders(options: FeedbackCompositionOptions = {}): Provider[] {
  return [
  {
    provide: FEEDBACK_REPOSITORY,
    useFactory: (storage: FeedbackCapableStorage): FeedbackRepository => ({
      saveTurn: (turn) => storage.feedback.saveTurn(turn),
      findTurnByPlatformMessage: (platform, platformMessageId) =>
        storage.feedback.findTurnByPlatformMessage(platform, platformMessageId),
      findPreviousTurn: (location, before, withinMs) => storage.feedback.findPreviousTurn(location, before, withinMs),
      upsertSignal: (signal) => storage.feedback.upsertSignal(signal),
      summarize: (query) => storage.feedback.summarize(query),
      listRatedTurns: (query) => storage.feedback.listRatedTurns(query),
      pruneOlderThan: (cutoff, maxRows) => storage.feedback.pruneOlderThan(cutoff, maxRows),
    }),
    inject: [STORAGE_PROVIDER],
  },
  {
    provide: LEARNING_REPOSITORY,
    useFactory: (storage: LearningCapableStorage): LearningRepository => ({
      insertWithinCap: (item, maxPerActor, now) => storage.learning.insertWithinCap(item, maxPerActor, now),
      findBySourceTurn: (actorId, kind, sourceTurnId, now) =>
        storage.learning.findBySourceTurn(actorId, kind, sourceTurnId, now),
      get: (actorId, id, now) => storage.learning.get(actorId, id, now),
      list: (query) => storage.learning.list(query),
      updateData: (actorId, id, data, now) => storage.learning.updateData(actorId, id, data, now),
      delete: (actorId, id) => storage.learning.delete(actorId, id),
      deleteBySourceMemory: (actorId, memoryId) => storage.learning.deleteBySourceMemory(actorId, memoryId),
      pruneExpired: (now, maxRows) => storage.learning.pruneExpired(now, maxRows),
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
    useFactory: (
      recorder: FeedbackRecorder,
      storage: StorageProvider,
      feedback: FeedbackRepository,
      learning: LearningRepository,
    ): readonly ConversationTurnHandler[] => [
      new FeedbackSummaryTurnHandler({
        feedback: recorder,
        tasks: { get: (id) => storage.tasks.get(id) },
        logger: feedbackLogger,
      }),
      new LearningTurnHandler({
        service: new LearningService({
          feedback,
          learning,
          tasks: { get: (id) => storage.tasks.get(id) },
          logger: learningLogger,
          ...(options.remoteExamplesDisclosure === true ? { remoteExamplesDisclosure: true } : {}),
        }),
        logger: learningLogger,
      }),
    ],
    inject: [FeedbackRecorder, STORAGE_PROVIDER, FEEDBACK_REPOSITORY, LEARNING_REPOSITORY],
  },
  ];
}

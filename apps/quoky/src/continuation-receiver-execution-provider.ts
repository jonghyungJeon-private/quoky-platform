import type { FactoryProvider } from '@nestjs/common';
import { AgentProfileRegistry, CONTINUATION_RECEIVER, ContinuationExecutionService,
  ContinuationReceiverExecutionService, STORAGE_PROVIDER, TaskManager } from '@quoky/core';
import type { ContinuationReceiver, StorageProvider } from '@quoky/core';

/** Composition candidate only: intentionally NOT registered in AppModule; no production receiver binding. */
export const continuationReceiverExecutionProvider: FactoryProvider<ContinuationReceiverExecutionService> = {
  provide: ContinuationReceiverExecutionService,
  useFactory: (storage: StorageProvider, profiles: AgentProfileRegistry, continuation: ContinuationExecutionService,
    tasks: TaskManager, receiver: ContinuationReceiver | undefined) =>
    new ContinuationReceiverExecutionService(storage, profiles, continuation, tasks, receiver),
  inject: [STORAGE_PROVIDER, AgentProfileRegistry, ContinuationExecutionService, TaskManager, CONTINUATION_RECEIVER],
};

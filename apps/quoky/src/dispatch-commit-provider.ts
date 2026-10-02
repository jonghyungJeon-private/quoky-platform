import { ProviderDispatchCommitCoordinator } from '@quoky/core';
import type { StorageProvider } from '@quoky/core';

/**
 * Production dispatch-commit owner bound to the LIVE storage seam (ADR-0062 pattern). The AppModule factories run
 * during NestFactory.createApplicationContext BEFORE `await storage.init()`, when the sqlite repositories are still
 * undefined, so passing `storage.taskRuns` eagerly froze `undefined` into the coordinator and every provider turn
 * failed with "Cannot read properties of undefined (reading 'commitProviderDispatchIfPreDispatch')". The repository
 * is dereferenced at call time instead.
 */
export function createProviderDispatchCommit(storage: Pick<StorageProvider, 'taskRuns'>): ProviderDispatchCommitCoordinator {
  return new ProviderDispatchCommitCoordinator({
    commitProviderDispatchIfPreDispatch: (taskRunId, executionId) =>
      storage.taskRuns.commitProviderDispatchIfPreDispatch(taskRunId, executionId),
  });
}

import type { Id, TaskRun } from '../domain';
import type { StorageProvider } from '../ports';

/** Sole application write owner for a TaskRun's first normal Provider dispatch. */
export class ProviderDispatchCommitCoordinator {
  constructor(private readonly runs: Pick<StorageProvider['taskRuns'], 'commitProviderDispatchIfPreDispatch'>) {}

  commit(taskRunId: Id, executionId: Id): Promise<TaskRun> {
    if (!taskRunId || taskRunId !== executionId) throw new Error('PROVIDER_DISPATCH_IDENTITY_MISMATCH');
    return this.runs.commitProviderDispatchIfPreDispatch(taskRunId, executionId);
  }
}

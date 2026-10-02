import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StorageProvider, TaskRun } from '@quoky/core';
import { createProviderDispatchCommit } from './dispatch-commit-provider';

describe('createProviderDispatchCommit (live storage seam)', () => {
  it('resolves taskRuns at commit time, so repositories assigned by a later storage.init() are used', async () => {
    const storage = {} as { taskRuns: StorageProvider['taskRuns'] };
    const coordinator = createProviderDispatchCommit(storage); // composed before init: taskRuns is undefined here
    const committed = { id: 'run-1' } as TaskRun;
    const commitProviderDispatchIfPreDispatch = vi.fn(async () => committed);
    storage.taskRuns = { commitProviderDispatchIfPreDispatch } as unknown as StorageProvider['taskRuns']; // init()
    await expect(coordinator.commit('run-1', 'run-1')).resolves.toBe(committed);
    expect(commitProviderDispatchIfPreDispatch).toHaveBeenCalledWith('run-1', 'run-1');
  });

  it('keeps the identity guard', () => {
    const coordinator = createProviderDispatchCommit({} as { taskRuns: StorageProvider['taskRuns'] });
    expect(() => coordinator.commit('run-1', 'other')).toThrow('PROVIDER_DISPATCH_IDENTITY_MISMATCH');
  });

  it('AppModule never captures storage.taskRuns eagerly into the coordinator', () => {
    const source = readFileSync(join(__dirname, 'app.module.ts'), 'utf8');
    expect(source).not.toMatch(/ProviderDispatchCommitCoordinator\(\s*storage\.taskRuns\s*\)/);
    expect(source).toMatch(/createProviderDispatchCommit\(storage\)/);
  });
});

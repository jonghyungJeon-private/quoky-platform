import { describe, expect, it } from 'vitest';

import { KeyedMutex, type LockHold } from './keyed-mutex';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('KeyedMutex (ADR-0113 D7 session write lock primitive)', () => {
  it('runs work on one key one at a time, in arrival order; other keys do not wait', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const slow = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };
    await Promise.all([mutex.run('a', slow('a1')), mutex.run('a', slow('a2')), mutex.run('b', slow('b1'))]);
    expect(log.indexOf('a1:end')).toBeLessThan(log.indexOf('a2:start'));
    expect(log.indexOf('b1:start')).toBeLessThan(log.indexOf('a1:end'));
  });

  it('is re-entrant only for the explicit holder: a passed hold runs inside, no hold queues behind', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    let queued: Promise<void> | undefined;
    await mutex.run('k', async (hold) => {
      await mutex.run('k', async () => { log.push('nested-with-hold'); }, hold);
      queued = mutex.run('k', async () => { log.push('queued-without-hold'); });
      await tick();
      log.push('outer-end');
    });
    await queued;
    expect(log).toEqual(['nested-with-hold', 'outer-end', 'queued-without-hold']);
  });

  it('a hold for another key, or one whose work has finished, does not grant entry', async () => {
    const mutex = new KeyedMutex();
    let stale: LockHold | undefined;
    await mutex.run('k', async (hold) => { stale = hold; });
    expect(mutex.holds(stale, 'k')).toBe(false);
    await mutex.run('other', async (hold) => {
      expect(mutex.holds(hold, 'other')).toBe(true);
      expect(mutex.holds(hold, 'k')).toBe(false);
    });
  });

  it('a rejected work item never blocks the key', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(mutex.run('k', async () => 'next')).resolves.toBe('next');
  });
});

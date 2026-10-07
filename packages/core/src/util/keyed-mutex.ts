/**
 * A keyed, in-process mutex (single instance, ADR-0102 D4) with EXPLICIT re-entrancy: the holder of a key gets an
 * opaque {@link LockHold} and passes it to anything it calls that needs the same key; such a call runs inside the
 * holder's critical section instead of queueing behind it (which would deadlock). There is no ambient/global
 * "current holder" — a call without the hold queues like any other caller. Provider-agnostic, no runtime deps.
 *
 * Work on one key runs strictly one at a time in arrival order; a rejected work item never blocks the queue; the
 * key's entry is dropped once its queue drains.
 */
export interface LockHold {
  /** The key this hold covers (informational; validity is checked by the issuing mutex). */
  readonly key: string;
}

export class KeyedMutex {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Holds currently inside their critical section (a hold is valid only while its work runs). */
  private readonly active = new WeakSet<LockHold>();

  /** Whether `hold` is a live hold of THIS mutex for `key`. */
  holds(hold: LockHold | undefined, key: string): boolean {
    return hold !== undefined && hold.key === key && this.active.has(hold);
  }

  /**
   * Run `work` alone on `key`. With `held` — a live hold of this mutex for the same key — it runs immediately inside
   * that critical section (re-entrant for the explicit holder); otherwise it waits for every earlier work on `key`.
   */
  run<T>(key: string, work: (hold: LockHold) => Promise<T>, held?: LockHold): Promise<T> {
    if (held !== undefined && this.holds(held, key)) return work(held);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const enter = async (): Promise<T> => {
      const hold: LockHold = Object.freeze({ key });
      this.active.add(hold);
      try {
        return await work(hold);
      } finally {
        this.active.delete(hold);
      }
    };
    const result = previous.then(enter, enter);
    const tail = result.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }
}

import { isArchivedMemory, now } from '@quoky/core';
import type {
  IsoTimestamp,
  Logger,
  MemoryRecord,
  MemoryRepository,
  SemanticRecallCandidate,
  SemanticRecallMaintenance,
  SemanticRecallMaintenanceOptions,
} from '@quoky/core';

/**
 * ADR-0124 section 5.4 (P2-2 backfill): a background job that keeps the durable-memory vector store of the current
 * embedding space complete and clean OUTSIDE any turn. Each tick asks the scorer's `maintain` to embed a bounded batch
 * of missing vector units (newest memory first) and to sweep stored ids that no live memory owns any more: a
 * forgotten, archived, superseded, expired or deleted memory (this also closes the race where a turn embeds a memory
 * while it is being forgotten) and surplus passage ordinals. The scorer is the production one (local-only provider
 * selection, credential rule, unit mapping), so a vector made here is byte-identical to one made in a turn.
 */

/** DI token of the production job (`null` when embeddings are off). */
export const MEMORY_VECTOR_BACKFILL = Symbol('MemoryVectorBackfill');

/** New vectors embedded per tick (each passage counts one). */
export const BACKFILL_BATCH = 8;
/** Pause between two ticks while work remains: the embedder is shared with turns, so the job yields. */
export const BACKFILL_ACTIVE_DELAY_MS = 1_000;
/** Pause when everything is indexed (new and edited memories are caught by the next tick). */
export const BACKFILL_IDLE_DELAY_MS = 5 * 60_000;
/** Pause after the provider was unavailable or a tick failed: the pass stops and the embedder is re-checked later. */
export const BACKFILL_RETRY_DELAY_MS = 60_000;
/** First tick after start, so the embedder warm-up and the first turns are not competing with a pass. */
export const BACKFILL_START_DELAY_MS = 15_000;
/** Upper bound on live memories read per tick; a read that reaches it is truncated and nothing is swept. */
export const BACKFILL_LIVE_LIMIT = 50_000;

export interface LiveDurableMemories {
  readonly candidates: SemanticRecallCandidate[];
  /** The read hit {@link BACKFILL_LIVE_LIMIT}: absence from `candidates` proves nothing, so no sweep. */
  readonly truncated: boolean;
}

/**
 * Every live durable memory of every actor, newest first: the repository filters recall uses (long-term, not expired,
 * not superseded, not archived) re-checked in code, and the owner-scope shape of recall (a user, no channel, thread or
 * task). Session and project are not narrowed: recall reads them per turn, the index holds them all.
 */
export async function liveDurableMemories(
  memories: Pick<MemoryRepository, 'findDurableCandidates'>,
  at: IsoTimestamp = now(),
): Promise<LiveDurableMemories> {
  const records = await memories.findDurableCandidates({
    scope: {},
    limit: BACKFILL_LIVE_LIMIT,
    excludeExpired: true,
    excludeSuperseded: true,
    archived: 'exclude',
  });
  const nowMs = Date.parse(at);
  const live = records.filter((record: MemoryRecord) => {
    const scope = record.scope;
    if (scope.userId === undefined || scope.channelId !== undefined || scope.threadId !== undefined || scope.taskId !== undefined) return false;
    const expiresAt = record.metadata?.['expiresAt'];
    if (typeof expiresAt === 'string' && Date.parse(expiresAt) < nowMs) return false;
    if (typeof record.metadata?.['supersededBy'] === 'string') return false;
    return !isArchivedMemory(record);
  });
  return { candidates: live.map((record) => ({ id: record.id, content: record.content })), truncated: records.length >= BACKFILL_LIVE_LIMIT };
}

export interface MemoryIndexMaintainer {
  maintain(live: readonly SemanticRecallCandidate[], options?: SemanticRecallMaintenanceOptions): Promise<SemanticRecallMaintenance | null>;
}

export interface MemoryVectorBackfillDeps {
  readonly scorer: MemoryIndexMaintainer;
  /** Resolved at call time: repositories exist only after the storage provider is initialised. */
  readonly memories: () => Pick<MemoryRepository, 'findDurableCandidates'>;
  readonly logger?: Logger;
  readonly clock?: () => IsoTimestamp;
}

export interface MemoryVectorBackfillOptions {
  readonly batch?: number;
  readonly startDelayMs?: number;
  readonly activeDelayMs?: number;
  readonly idleDelayMs?: number;
  readonly retryDelayMs?: number;
}

export type BackfillState = 'working' | 'idle' | 'unavailable' | 'busy';

export interface BackfillTick {
  readonly state: BackfillState;
  readonly embedded: number;
  readonly remaining: number;
  readonly deleted: number;
}

export class MemoryVectorBackfill {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<BackfillTick> | undefined;
  private stopped = true;
  private readonly batch: number;
  private readonly delays: { start: number; active: number; idle: number; retry: number };

  constructor(
    private readonly deps: MemoryVectorBackfillDeps,
    options: MemoryVectorBackfillOptions = {},
  ) {
    this.batch = options.batch ?? BACKFILL_BATCH;
    this.delays = {
      start: options.startDelayMs ?? BACKFILL_START_DELAY_MS,
      active: options.activeDelayMs ?? BACKFILL_ACTIVE_DELAY_MS,
      idle: options.idleDelayMs ?? BACKFILL_IDLE_DELAY_MS,
      retry: options.retryDelayMs ?? BACKFILL_RETRY_DELAY_MS,
    };
  }

  /** Starts the loop (the first tick after the start delay). Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.delays.start);
  }

  /** Stops the loop and waits for a tick in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  /** One tick. Never runs concurrently with itself: a call during a tick returns `busy` and does nothing. */
  runOnce(): Promise<BackfillTick> {
    if (this.inFlight !== undefined) return Promise.resolve({ state: 'busy', embedded: 0, remaining: 0, deleted: 0 });
    const run = this.tick().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  /** Ticks without pauses until nothing is missing or stale, the provider is unavailable, or `maxTicks` ran out. */
  async runToCompletion(maxTicks = 10_000): Promise<BackfillTick> {
    let last: BackfillTick = { state: 'idle', embedded: 0, remaining: 0, deleted: 0 };
    let embedded = 0;
    let deleted = 0;
    for (let at = 0; at < maxTicks; at += 1) {
      last = await this.runOnce();
      embedded += last.embedded;
      deleted += last.deleted;
      if (last.state !== 'working') break;
    }
    return { ...last, embedded, deleted };
  }

  private async tick(): Promise<BackfillTick> {
    try {
      const live = await liveDurableMemories(this.deps.memories(), this.deps.clock?.());
      const result = await this.deps.scorer.maintain(live.candidates, { maxNew: this.batch, sweep: !live.truncated });
      if (result === null) return { state: 'unavailable', embedded: 0, remaining: 0, deleted: 0 };
      return { state: result.remaining > 0 ? 'working' : 'idle', embedded: result.embedded, remaining: result.remaining, deleted: result.deleted };
    } catch (error) {
      this.deps.logger?.warn('memory vector backfill tick failed', { reason: error instanceof Error ? error.name : 'ERROR' });
      return { state: 'unavailable', embedded: 0, remaining: 0, deleted: 0 };
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().then((tick) => {
        this.schedule(tick.state === 'working' ? this.delays.active : tick.state === 'idle' ? this.delays.idle : this.delays.retry);
      });
    }, delayMs);
    this.timer.unref?.();
  }
}

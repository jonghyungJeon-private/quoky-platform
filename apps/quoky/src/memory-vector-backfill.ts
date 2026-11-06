import { isArchivedMemory, now } from '@quoky/core';
import type {
  Id,
  IsoTimestamp,
  Logger,
  MemoryRecord,
  MemoryRepository,
  RecallActivityReader,
  SemanticRecallCandidate,
  SemanticRecallLiveSet,
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
 *
 * The embedder is shared with foreground turns, so the job yields: it checks the shared recall activity gauge before
 * each embedding and ends its tick while a turn runs or ended less than {@link BACKFILL_TURN_GRACE_MS} ago. It aborts
 * between steps on stop (bounded by {@link BACKFILL_STOP_BOUND_MS}) and skips the full pass on an idle tick when no
 * memory was added, edited or removed since the last one.
 */

/** DI token of the production job (`null` when embeddings are off). */
export const MEMORY_VECTOR_BACKFILL = Symbol('MemoryVectorBackfill');

/** New vectors embedded per tick (each passage counts one). */
export const BACKFILL_BATCH = 8;
/** Pause between two ticks while work remains, and while a recall turn is active or just ended. */
export const BACKFILL_ACTIVE_DELAY_MS = 1_000;
/** Pause when everything is indexed (new and edited memories are caught by the next tick). */
export const BACKFILL_IDLE_DELAY_MS = 5 * 60_000;
/** Pause after the provider was unavailable or a tick failed: the pass stops and the embedder is re-checked later. */
export const BACKFILL_RETRY_DELAY_MS = 60_000;
/** First tick after start, so the embedder warm-up and the first turns are not competing with a pass. */
export const BACKFILL_START_DELAY_MS = 15_000;
/** A recall turn that ended less than this ago still keeps the job paused. */
export const BACKFILL_TURN_GRACE_MS = 2_000;
/** `stop()` waits at most this long for a tick in flight (launchd's ExitTimeOut is 90 s; shutdown has other waits). */
export const BACKFILL_STOP_BOUND_MS = 2_000;
/** An idle tick with an unchanged memory fingerprint skips the pass, but every this-many-th idle tick runs it anyway. */
export const BACKFILL_FULL_PASS_EVERY_IDLE_TICKS = 12;
/** Upper bound on live memories read per tick; a read that reaches it is truncated and nothing is swept. */
export const BACKFILL_LIVE_LIMIT = 50_000;

export interface LiveDurableMemories extends SemanticRecallLiveSet {
  readonly candidates: SemanticRecallCandidate[];
  /** Live count and newest `updatedAt`: equal fingerprints mean nothing was added, edited or removed. */
  readonly fingerprint: string;
}

type LiveReader = Pick<MemoryRepository, 'findDurableCandidates' | 'findDurableCandidatesByIds'>;

function isLiveRecord(record: MemoryRecord, nowMs: number): boolean {
  const scope = record.scope;
  if (scope.userId === undefined || scope.channelId !== undefined || scope.threadId !== undefined || scope.taskId !== undefined) return false;
  const expiresAt = record.metadata?.['expiresAt'];
  if (typeof expiresAt === 'string' && Date.parse(expiresAt) < nowMs) return false;
  if (typeof record.metadata?.['supersededBy'] === 'string') return false;
  return !isArchivedMemory(record);
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
  const live = records.filter((record) => isLiveRecord(record, nowMs));
  const newest = live.reduce((latest, record) => (record.updatedAt > latest ? record.updatedAt : latest), '');
  return {
    candidates: live.map((record) => ({ id: record.id, content: record.content })),
    truncated: records.length >= BACKFILL_LIVE_LIMIT,
    fingerprint: `${live.length}@${newest}`,
  };
}

/** Which of `ids` are live now, by a fresh read of just those records (the full list when the store cannot filter by id). */
export async function confirmLiveMemories(memories: LiveReader, ids: readonly Id[], at: IsoTimestamp = now()): Promise<ReadonlySet<Id>> {
  if (ids.length === 0) return new Set();
  if (memories.findDurableCandidatesByIds === undefined) {
    const all = await liveDurableMemories(memories, at);
    const wanted = new Set(ids);
    return new Set(all.candidates.map((candidate) => candidate.id).filter((id) => wanted.has(id)));
  }
  const records = await memories.findDurableCandidatesByIds({
    scope: {},
    ids: [...ids],
    excludeExpired: true,
    excludeSuperseded: true,
    archived: 'exclude',
  });
  const nowMs = Date.parse(at);
  return new Set(records.filter((record) => isLiveRecord(record, nowMs)).map((record) => record.id));
}

export interface MemoryIndexMaintainer {
  maintain(loadLive: () => Promise<SemanticRecallLiveSet>, options: SemanticRecallMaintenanceOptions): Promise<SemanticRecallMaintenance | null>;
}

export interface MemoryVectorBackfillDeps {
  readonly scorer: MemoryIndexMaintainer;
  /** Resolved at call time: repositories exist only after the storage provider is initialised. */
  readonly memories: () => LiveReader;
  /** Shared with the recall scorer: the job pauses while a turn is active or just ended. */
  readonly activity?: RecallActivityReader;
  readonly logger?: Logger;
  readonly clock?: () => IsoTimestamp;
}

export interface MemoryVectorBackfillOptions {
  readonly batch?: number;
  readonly startDelayMs?: number;
  readonly activeDelayMs?: number;
  readonly idleDelayMs?: number;
  readonly retryDelayMs?: number;
  readonly stopBoundMs?: number;
}

export type BackfillState = 'working' | 'idle' | 'unavailable' | 'busy' | 'paused';

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
  private abort = new AbortController();
  /** Fingerprint of the live memories at the last idle tick, and how many idle ticks since the last full pass. */
  private idleFingerprint: string | undefined;
  private idleSkips = 0;
  /** The previous tick changed the store: its chain keeps the cached space; the first tick of a chain re-reads it. */
  private chaining = false;
  private readonly batch: number;
  private readonly stopBoundMs: number;
  private readonly delays: { start: number; active: number; idle: number; retry: number };

  constructor(
    private readonly deps: MemoryVectorBackfillDeps,
    options: MemoryVectorBackfillOptions = {},
  ) {
    this.batch = options.batch ?? BACKFILL_BATCH;
    this.stopBoundMs = options.stopBoundMs ?? BACKFILL_STOP_BOUND_MS;
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
    this.abort = new AbortController();
    this.schedule(this.delays.start);
  }

  /** Stops the loop: aborts the tick in flight and waits for it at most `stopBoundMs`, so shutdown is never held up. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    if (this.inFlight === undefined) return;
    let bound: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      bound = setTimeout(resolve, this.stopBoundMs);
    });
    try {
      await Promise.race([this.inFlight.then(() => undefined, () => undefined), limit]);
    } finally {
      if (bound !== undefined) clearTimeout(bound);
    }
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

  private turnActive(): boolean {
    return this.deps.activity?.isBusy(BACKFILL_TURN_GRACE_MS) === true;
  }

  private async tick(): Promise<BackfillTick> {
    const none = { embedded: 0, remaining: 0, deleted: 0 };
    try {
      if (this.turnActive()) return { state: 'paused', ...none };
      const memories = this.deps.memories();
      const at = (): IsoTimestamp | undefined => this.deps.clock?.();
      const forced = this.idleSkips >= BACKFILL_FULL_PASS_EVERY_IDLE_TICKS;
      if (this.idleFingerprint !== undefined && !forced) {
        // nothing added, edited or removed since the last complete pass: skip the embedder probe and the store read
        const now = await liveDurableMemories(memories, at());
        if (now.fingerprint === this.idleFingerprint) {
          this.idleSkips += 1;
          return { state: 'idle', ...none };
        }
      }
      let fingerprint: string | undefined;
      const result = await this.deps.scorer.maintain(
        async () => {
          const live = await liveDurableMemories(memories, at());
          fingerprint = live.fingerprint;
          return live;
        },
        {
          maxNew: this.batch,
          signal: this.abort.signal,
          shouldYield: () => this.turnActive(),
          // the first pass after idle time and the hourly forced one re-read the space (a re-pulled model or an upgraded
          // Ollama is noticed); ticks of one working chain reuse it
          refreshSpace: forced || !this.chaining,
          confirmLive: (ids) => confirmLiveMemories(memories, ids, at()),
        },
      );
      if (result === null) {
        this.idleFingerprint = undefined;
        this.chaining = false;
        return { state: 'unavailable', ...none };
      }
      // `working` whenever this pass changed the store: a memory forgotten while it ran is then caught by the next one
      const changed = result.embedded > 0 || result.deleted > 0;
      const working = result.remaining > 0 || changed;
      if (result.yielded === true && !changed) return { state: 'paused', ...none };
      this.chaining = working;
      this.idleFingerprint = working ? undefined : fingerprint;
      this.idleSkips = 0;
      return { state: working ? 'working' : 'idle', embedded: result.embedded, remaining: result.remaining, deleted: result.deleted };
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
        this.schedule(
          tick.state === 'working' || tick.state === 'paused' || tick.state === 'busy'
            ? this.delays.active
            : tick.state === 'idle'
              ? this.delays.idle
              : this.delays.retry,
        );
      });
    }, delayMs);
    this.timer.unref?.();
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { newId } from '@quoky/core';

/**
 * Per-turn correlation (ADR-0121 S0, design §4 ⑤-2 and §5.4). The composition root opens a context around each owner
 * turn (an inbound message or an approval decision) and around each reminder tick; everything that runs inside it —
 * log lines (`ConsoleLogger`) and outbound requests (the egress guard and the traffic ledger) — carries the same
 * opaque `cid`, so a log line and a ledger record of one turn can be joined without either holding any content.
 *
 * The id is random and content-free (16 hex characters from the shared `newId` utility). Outside any context
 * {@link currentCorrelation} is `undefined` and callers fall back to the `startup`/`background` initiator.
 */

/** Who caused an outbound request (design §5.4 `initiator`). `agent-run` and `brief` arrive with later stages. */
export type TrafficInitiator = 'owner-turn' | 'reminder' | 'startup' | 'background';

export interface CorrelationContext {
  readonly cid: string;
  readonly initiator: TrafficInitiator;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** A fresh, content-free correlation id (16 lowercase hex characters). */
export function newCorrelationId(): string {
  return newId().replace(/-/g, '').slice(0, 16);
}

/** Runs `work` inside a new correlation context for `initiator`; the context follows every await inside it. */
export function runWithCorrelation<T>(initiator: TrafficInitiator, work: () => T, cid: string = newCorrelationId()): T {
  return storage.run({ cid, initiator }, work);
}

/** The active correlation context, or `undefined` outside any turn or tick. */
export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

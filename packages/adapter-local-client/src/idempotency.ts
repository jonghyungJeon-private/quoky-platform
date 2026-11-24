import { createHash } from 'node:crypto';

import { DEDUPE_RING_MAX, DEDUPE_RING_MS } from './constants';

/**
 * ADR-0125 D4: `clientMessageId` is only a dedupe key. An in-memory ring (10 minutes or 500 entries, never persisted)
 * maps it to `(SHA-256 of threadId and text, turnId)`. The client key never becomes a message id.
 */

export type DedupeVerdict =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly turnId: string }
  | { readonly kind: 'conflict' };

interface Entry {
  readonly fingerprint: string;
  readonly turnId: string;
  readonly at: number;
}

export function fingerprintOf(threadId: string | undefined, text: string): string {
  return createHash('sha256').update(threadId ?? '', 'utf8').update('\u0000').update(text, 'utf8').digest('hex');
}

export class IdempotencyRing {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number,
    private readonly maxEntries: number = DEDUPE_RING_MAX,
    private readonly ttlMs: number = DEDUPE_RING_MS,
  ) {}

  check(clientMessageId: string, fingerprint: string): DedupeVerdict {
    this.prune();
    const entry = this.entries.get(clientMessageId);
    if (entry === undefined) return { kind: 'new' };
    return entry.fingerprint === fingerprint ? { kind: 'replay', turnId: entry.turnId } : { kind: 'conflict' };
  }

  remember(clientMessageId: string, fingerprint: string, turnId: string): void {
    this.entries.set(clientMessageId, { fingerprint, turnId, at: this.now() });
    this.prune();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff || this.entries.size > this.maxEntries) this.entries.delete(key);
      else break;
    }
  }
}

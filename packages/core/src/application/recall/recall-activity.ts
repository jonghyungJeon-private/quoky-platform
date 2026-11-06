/**
 * Whether a foreground recall turn is running or ended a moment ago. The scorer marks it around a recall session; a
 * background job (the vector backfill) reads it and yields, so its embeddings never compete with a turn for the
 * embedder and push the turn past its 3 s budget. Time-based and timer-free: a turn that never closes its session
 * stops counting once its own budget has passed. Provider-neutral.
 */
export interface RecallActivity {
  /** A recall turn starts; returns the token to end it with. `maxMs` is the turn's own budget. */
  begin(maxMs: number): number;
  /** The turn ended (idempotent). */
  end(token: number): void;
}

export interface RecallActivityReader {
  /** A turn is in progress, or one ended less than `graceMs` ago. */
  isBusy(graceMs: number): boolean;
}

export class RecallActivityGauge implements RecallActivity, RecallActivityReader {
  private nextToken = 1;
  private readonly open = new Map<number, number>();
  private lastEndMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly clock: () => number = Date.now) {}

  begin(maxMs: number): number {
    const token = this.nextToken++;
    this.open.set(token, this.clock() + Math.max(0, maxMs));
    return token;
  }

  end(token: number): void {
    if (this.open.delete(token)) this.lastEndMs = this.clock();
  }

  isBusy(graceMs: number): boolean {
    const nowMs = this.clock();
    for (const [token, expiresAtMs] of this.open) {
      if (expiresAtMs > nowMs) return true;
      // a turn that never closed: its budget is over, count it as ended then
      this.open.delete(token);
      this.lastEndMs = Math.max(this.lastEndMs, expiresAtMs);
    }
    return nowMs - this.lastEndMs < graceMs;
  }
}

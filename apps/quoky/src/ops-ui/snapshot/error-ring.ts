import type { Logger, LogFields } from '@quoky/core';

/**
 * ADR-0113 D6 "Recent errors": a bounded in-memory ring buffer (last 100, never persisted) of error code, category,
 * component, correlation id and time, fed by the composition root's error logging. It keeps no message text, stack,
 * prompt or reply: only values that match a short identifier shape are kept, anything else becomes a fixed word.
 */

export const OPS_ERROR_RING_CAPACITY = 100;

export interface OpsErrorEntry {
  readonly at: string;
  readonly component: string;
  readonly category: string;
  readonly code: string;
  readonly correlationId?: string;
}

/** A code or category: a short identifier (no spaces beyond single separators, no free text). */
const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
/** A fixed log event such as `inbound handling failed` or `backup.failed`. */
const EVENT_SHAPE = /^[a-z][a-z0-9._-]*(?: [a-z][a-z0-9._-]*){0,5}$/;
/** Correlation ids are platform snowflakes or generated ids. */
const CORRELATION_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

function pick(fields: LogFields | undefined, keys: readonly string[], shape: RegExp): string | undefined {
  if (fields === undefined) return undefined;
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === 'string' && value.length <= 64 && shape.test(value)) return value;
  }
  return undefined;
}

export class OpsErrorRing {
  private readonly entries: OpsErrorEntry[] = [];

  constructor(
    private readonly capacity: number = OPS_ERROR_RING_CAPACITY,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Record one logged error from its fixed event text and structured fields. Never throws. */
  record(component: string, event: string, fields?: LogFields): void {
    try {
      const code = pick(fields, ['code', 'errorCode', 'failure', 'reason', 'errorName'], CODE_SHAPE) ?? 'UNCLASSIFIED';
      const category =
        pick(fields, ['stage', 'category'], CODE_SHAPE) ?? (event.length <= 64 && EVENT_SHAPE.test(event) ? event : 'error');
      const correlationId = pick(fields, ['correlationId', 'messageId', 'approvalId', 'reminderId'], CORRELATION_SHAPE);
      const entry: OpsErrorEntry = {
        at: this.clock(),
        component: CODE_SHAPE.test(component) ? component : 'app',
        category,
        code,
        ...(correlationId !== undefined ? { correlationId } : {}),
      };
      this.entries.push(entry);
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    } catch {
      // diagnostics must never break the caller
    }
  }

  /** Newest first. */
  recent(limit: number = this.capacity): readonly OpsErrorEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  get size(): number {
    return this.entries.length;
  }
}

/**
 * A `Logger` that forwards everything to `inner` and also records each `error` into the ring. The composition root
 * wraps its own loggers with it; nothing else changes about what is logged.
 */
export function errorRecordingLogger(inner: Logger, ring: OpsErrorRing, component: string): Logger {
  return {
    info: (message, fields) => inner.info(message, fields),
    warn: (message, fields) => inner.warn(message, fields),
    error: (message, fields) => {
      inner.error(message, fields);
      ring.record(component, message, fields);
    },
  };
}

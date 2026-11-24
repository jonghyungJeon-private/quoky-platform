import type { ServerResponse } from 'node:http';

import { EVENT_ID, EVENT_RING_MAX, EVENT_RING_MS, HEARTBEAT_MS, MAX_EVENT_STREAMS, MAX_STREAM_BACKLOG_BYTES } from './constants';

/**
 * ADR-0125 D4: the Server-Sent Events side. Every event has the SSE id `<epoch>-<seq>`; the bounded in-memory ring (the
 * last 200 events or 10 minutes, never persisted) serves `Last-Event-ID` resume. Anything that is not a resumable
 * position of THIS epoch starts the stream at "now" with one `status {resync: true}` event: it never replays, errors or
 * reveals another event.
 */

export type HubEventType = 'reply' | 'typing' | 'notice' | 'status';

export interface HubEvent {
  readonly id: string;
  readonly seq: number;
  readonly type: HubEventType;
  /** Serialized JSON (no raw line break). */
  readonly data: string;
  readonly at: number;
}

export interface EventHubOptions {
  readonly epoch: string;
  readonly now: () => number;
  readonly ringMax?: number;
  readonly ringMs?: number;
  readonly heartbeatMs?: number;
  readonly maxStreams?: number;
}

export type AttachResult = 'ok' | 'TOO_MANY_STREAMS';

function frame(event: { id?: string; type: string; data: string }): string {
  return `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.type}\ndata: ${event.data}\n\n`;
}

export class EventHub {
  readonly epoch: string;
  private seq = 0;
  private ring: HubEvent[] = [];
  private readonly streams = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly ringMax: number;
  private readonly ringMs: number;
  private readonly heartbeatMs: number;
  private readonly maxStreams: number;

  constructor(options: EventHubOptions) {
    this.epoch = options.epoch;
    this.now = options.now;
    this.ringMax = options.ringMax ?? EVENT_RING_MAX;
    this.ringMs = options.ringMs ?? EVENT_RING_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.maxStreams = options.maxStreams ?? MAX_EVENT_STREAMS;
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /** Record one event (always carrying the process epoch) and write it to every open stream. */
  publish(type: HubEventType, payload: Record<string, unknown>): HubEvent {
    this.seq += 1;
    const event: HubEvent = {
      id: `${this.epoch}-${this.seq}`,
      seq: this.seq,
      type,
      data: JSON.stringify({ ...payload, epoch: this.epoch }),
      at: this.now(),
    };
    this.ring.push(event);
    this.prune();
    const text = frame(event);
    for (const stream of [...this.streams]) this.write(stream, text);
    return event;
  }

  /**
   * Open a stream. The caller has already checked readiness. `lastEventId` is the raw header value (or undefined).
   * Writes the response head, one id-less `status` event (epoch, plus `resync: true` when a header was sent that is
   * not resumable), then the replay.
   */
  attach(res: ServerResponse, lastEventId: string | undefined, status: string): AttachResult {
    if (this.streams.size >= this.maxStreams) return 'TOO_MANY_STREAMS';
    this.prune();
    const resume = lastEventId === undefined ? undefined : this.resumeFrom(lastEventId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close',
      'X-Content-Type-Options': 'nosniff',
    });
    const resync = lastEventId !== undefined && resume === undefined;
    res.write(frame({ type: 'status', data: JSON.stringify({ status, epoch: this.epoch, ...(resync ? { resync: true } : {}) }) }));
    if (resume !== undefined) for (const event of this.ring) if (event.seq > resume) res.write(frame(event));
    this.streams.add(res);
    res.once('close', () => {
      this.streams.delete(res);
      this.stopHeartbeatIfIdle();
    });
    this.startHeartbeat();
    return 'ok';
  }

  /** The `seq` to replay after, or undefined for a resync. */
  private resumeFrom(raw: string): number | undefined {
    const match = EVENT_ID.exec(raw);
    if (match === null || match[1] !== this.epoch) return undefined;
    const seq = Number(match[2]);
    if (!Number.isSafeInteger(seq) || seq > this.seq) return undefined;
    const first = this.ring[0]?.seq ?? this.seq + 1;
    return seq >= first - 1 ? seq : undefined;
  }

  closeAllStreams(): void {
    for (const stream of [...this.streams]) stream.end();
    this.streams.clear();
    this.stopHeartbeatIfIdle();
  }

  private write(stream: ServerResponse, text: string): void {
    if (stream.destroyed || stream.writableEnded) return;
    if (stream.writableLength > MAX_STREAM_BACKLOG_BYTES) {
      stream.destroy();
      return;
    }
    stream.write(text);
  }

  private prune(): void {
    const cutoff = this.now() - this.ringMs;
    while (this.ring.length > 0 && (this.ring.length > this.ringMax || (this.ring[0] as HubEvent).at < cutoff)) this.ring.shift();
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) return;
    this.heartbeat = setInterval(() => {
      for (const stream of [...this.streams]) this.write(stream, ': hb\n\n');
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  private stopHeartbeatIfIdle(): void {
    if (this.streams.size > 0 || this.heartbeat === undefined) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

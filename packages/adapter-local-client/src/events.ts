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
  /** A stream whose unsent backlog would pass this many bytes is dropped (default `MAX_STREAM_BACKLOG_BYTES`). */
  readonly maxBacklogBytes?: number;
}

export type AttachResult = 'ok' | 'TOO_MANY_STREAMS';

function frame(event: { id?: string; type: string; data: string }): string {
  return `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.type}\ndata: ${event.data}\n\n`;
}

/** HTTP/1.1 chunked framing added to each write (hex length and two CRLFs), so the guard holds after framing too. */
const CHUNK_FRAMING_BYTES = 16;
/** The response head is buffered with the first write; a generous bound for the fixed head `attach` writes. */
const RESPONSE_HEAD_ALLOWANCE_BYTES = 512;

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
  private readonly maxBacklogBytes: number;
  private peakBacklog = 0;

  constructor(options: EventHubOptions) {
    this.epoch = options.epoch;
    this.now = options.now;
    this.ringMax = options.ringMax ?? EVENT_RING_MAX;
    this.ringMs = options.ringMs ?? EVENT_RING_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.maxStreams = options.maxStreams ?? MAX_EVENT_STREAMS;
    this.maxBacklogBytes = options.maxBacklogBytes ?? MAX_STREAM_BACKLOG_BYTES;
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /** The largest unsent backlog any stream has had after a write (bytes); never above the limit. */
  get peakBacklogBytes(): number {
    return this.peakBacklog;
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
   * not resumable), then the replay. Before the head is written the status event and the replay are sized (serialized
   * bytes plus chunk framing per write, plus a response-head allowance): a resume whose replay would not fit in the
   * backlog bound is NOT resumable (D4 "not resumable -> now + resync"), so it gets no replay, `resync: true` and an
   * open stream, instead of being dropped before any byte is sent. Every byte after the head still goes through the
   * same backlog guard as a publish.
   */
  attach(res: ServerResponse, lastEventId: string | undefined, status: string): AttachResult {
    if (this.streams.size >= this.maxStreams) return 'TOO_MANY_STREAMS';
    this.prune();
    const position = lastEventId === undefined ? undefined : this.resumeFrom(lastEventId);
    const statusFrame = (resync: boolean): string =>
      frame({ type: 'status', data: JSON.stringify({ status, epoch: this.epoch, ...(resync ? { resync: true } : {}) }) });
    const replay = position === undefined ? [] : this.ring.filter((event) => event.seq > position).map((event) => frame(event));
    const resumable = position !== undefined && this.planBytes([statusFrame(false), ...replay]) <= this.maxBacklogBytes;
    const frames = resumable ? [statusFrame(false), ...replay] : [statusFrame(lastEventId !== undefined)];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close',
      'X-Content-Type-Options': 'nosniff',
    });
    this.streams.add(res);
    res.once('close', () => {
      this.streams.delete(res);
      this.stopHeartbeatIfIdle();
    });
    for (const text of frames) if (!this.write(res, text)) return 'ok';
    this.startHeartbeat();
    return 'ok';
  }

  /** The bytes a sequence of writes adds to a fresh stream's backlog (frames, chunk framing, the response head). */
  private planBytes(frames: readonly string[]): number {
    let total = RESPONSE_HEAD_ALLOWANCE_BYTES;
    for (const text of frames) total += Buffer.byteLength(text, 'utf8') + CHUNK_FRAMING_BYTES;
    return total;
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

  /**
   * The one write path (publish, replay, heartbeat): a write that would take the stream's unsent backlog past the limit
   * drops the stream instead (it leaves the set at once). Returns whether the stream is still open.
   */
  private write(stream: ServerResponse, text: string): boolean {
    if (stream.destroyed || stream.writableEnded) return false;
    const bytes = Buffer.from(text, 'utf8');
    if (stream.writableLength + bytes.length + CHUNK_FRAMING_BYTES > this.maxBacklogBytes) {
      this.streams.delete(stream);
      stream.destroy();
      this.stopHeartbeatIfIdle();
      return false;
    }
    stream.write(bytes);
    if (stream.writableLength > this.peakBacklog) this.peakBacklog = stream.writableLength;
    return true;
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

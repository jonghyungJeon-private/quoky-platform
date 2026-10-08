/**
 * Offline test support for the Telegram adapter: a scripted fake `fetch` and runtime-built token fixtures. NEVER calls
 * the real Bot API. Token-shaped values are assembled from pieces at runtime, so no token-shaped literal is in source.
 */
import type { FetchLike } from './bot-api';

/** A bot id and a token for it, built from pieces. */
export const FAKE_BOT_ID = ['70', '01', '23', '4'].join('');
export const FAKE_TOKEN_SECRET = ['AAH', 'fake', '_', 'x'.repeat(14), '-', 'y'.repeat(13)].join('');
export const FAKE_TOKEN = [FAKE_BOT_ID, FAKE_TOKEN_SECRET].join(':');
/** A well-formed token for ANOTHER bot. */
export const OTHER_BOT_ID = ['80', '09', '87', '6'].join('');
export const OTHER_TOKEN = [OTHER_BOT_ID, FAKE_TOKEN_SECRET].join(':');

export const OWNER_ID = 5_550_001;
export const STRANGER_ID = 5_550_999;

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly form?: FormData;
  readonly init: RequestInit;
}

export type Reply =
  | { readonly status?: number; readonly json: unknown }
  | { readonly throws: Error }
  /** Never answers until the request is aborted (a pending long poll). */
  | { readonly hang: true }
  /** Answers with `reply` once `until` resolves, IGNORING any abort (a response already on its way). */
  | { readonly until: Promise<unknown>; readonly reply: Reply };

export function okReply(result: unknown): Reply {
  return { json: { ok: true, result } };
}

export function errorReply(status: number, parameters?: Record<string, unknown>): Reply {
  return { status, json: { ok: false, error_code: status, description: 'fake description', ...(parameters ? { parameters } : {}) } };
}

/**
 * A scripted fake: per Bot API method, a queue of replies; `fallback` answers when a queue is empty (default: a
 * hanging long poll for `getUpdates`, `{ ok: true, result: true }` otherwise). A `getUpdates` call with `timeout: 0`
 * (the startup probe, the stop-time confirm) uses the separate queue `getUpdates:instant` and answers `[]` by default.
 */
export class FakeTelegram {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, Reply[]>();
  private messageSeq = 1000;

  constructor(private readonly fallback: (method: string) => Reply = defaultFallback) {}

  queue(method: string, ...replies: Reply[]): this {
    this.queues.set(method, [...(this.queues.get(method) ?? []), ...replies]);
    return this;
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    const form = init.body instanceof FormData ? init.body : undefined;
    const params = form ? {} : (JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
    this.calls.push({ url, method, params, ...(form ? { form } : {}), init });
    const key = method === 'getUpdates' && params.timeout === 0 ? 'getUpdates:instant' : method;
    const queued = this.queues.get(key)?.shift();
    let reply = queued ?? this.defaultReply(key);
    while ('until' in reply) {
      await reply.until;
      reply = reply.reply;
    }
    if ('throws' in reply) throw reply.throws;
    if ('hang' in reply) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        const abort = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  private defaultReply(method: string): Reply {
    if (method === 'sendMessage' || method === 'sendDocument') {
      this.messageSeq += 1;
      return okReply({ message_id: this.messageSeq });
    }
    return this.fallback(method);
  }
}

function defaultFallback(method: string): Reply {
  if (method === 'getUpdates') return { hang: true };
  if (method === 'getUpdates:instant') return okReply([]);
  if (method === 'getMe') return okReply({ id: Number(FAKE_BOT_ID), is_bot: true, first_name: 'Quoky' });
  return okReply(true);
}

/** A private text message update from `from` (defaults: the owner, now). */
export function textUpdate(
  updateId: number,
  text: string,
  options: { readonly from?: number; readonly chatId?: number; readonly chatType?: string; readonly date?: number; readonly isBot?: boolean } = {},
): Record<string, unknown> {
  const from = options.from ?? OWNER_ID;
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: options.date ?? Math.floor(Date.now() / 1000),
      chat: { id: options.chatId ?? from, type: options.chatType ?? 'private' },
      from: { id: from, is_bot: options.isBot ?? false, first_name: 'Owner' },
      text,
    },
  };
}

/** Resolve after pending microtasks and timers of the current turn have run, `times` times. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Poll `predicate` across event-loop turns (bounded). */
export async function until(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

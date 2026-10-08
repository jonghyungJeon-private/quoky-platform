import type { TelegramBotToken } from './bot-token';

/**
 * The bounded Telegram Bot API client (ADR-0114 D4/D5). HTTPS through `node:fetch` to one pinned host, no SDK.
 *
 * - The URL is always {@link TELEGRAM_API_ORIGIN} + `/bot<token>/<method>` for a method on a fixed list: the token goes
 *   only into that request path, never into a header, argv, a log field or an error.
 * - Redirects are refused (`redirect: 'error'`); a response whose final URL is on another origin is refused too.
 * - One timer bounds the whole call, headers AND body; a caller's abort signal (adapter stop) cancels it as well.
 * - The body is read through a byte-bounded reader; a larger body is cancelled and refused, never partially parsed.
 * - Failure messages carry a fixed code, the method name and at most the HTTP status number. A transport error (whose
 *   message can quote the request URL, hence the token) is never wrapped, chained or logged: only its code leaves.
 *   Telegram's `description` text is never read into an error; only the numeric `retry_after` of a 429 is.
 */

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

/**
 * The only Bot API operations the adapter performs. `downloadFile` is not a Bot API method: it is the file download
 * (TG-2), a GET on `/file/bot<token>/<file_path>` of the same pinned host, made only through {@link TelegramBotApi.download}.
 */
export type TelegramMethod = 'getMe' | 'getUpdates' | 'sendMessage' | 'sendChatAction' | 'sendDocument' | 'getFile' | 'downloadFile';
/** Every Bot API operation the adapter may perform (the fixed list; tests iterate it so a new one cannot skip a guard). */
export const TELEGRAM_METHODS: readonly TelegramMethod[] = [
  'getMe',
  'getUpdates',
  'sendMessage',
  'sendChatAction',
  'sendDocument',
  'getFile',
  'downloadFile',
];
/** The methods {@link TelegramBotApi.call} posts to (the download has its own entry point). */
const METHODS: ReadonlySet<string> = new Set<string>(TELEGRAM_METHODS.filter((method) => method !== 'downloadFile'));

/**
 * A `file_path` from `getFile` as it may be put into the download URL (TG-2): relative, path segments of letters, digits,
 * `_`, `-` and `.`, no empty, `.` or `..` segment, at most 256 characters. Telegram's own paths look like
 * `photos/file_12.jpg` or `documents/file_3.txt`; anything else is refused before a request is made.
 */
const FILE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const MAX_FILE_PATH_LENGTH = 256;

export function isSafeTelegramFilePath(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_FILE_PATH_LENGTH) return false;
  if (!FILE_PATH.test(filePath)) return false;
  return filePath.split('/').every((segment) => segment !== '.' && segment !== '..');
}

export const TelegramFailureCode = {
  /** The call did not finish within its bound. */
  TIMEOUT: 'TIMEOUT',
  /** The adapter is stopping; the call was cancelled. */
  ABORTED: 'ABORTED',
  /** The host could not be reached, answered 5xx, or the response was not usable as a transport. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** HTTP 429 (`retryAfterSeconds` carries Telegram's `retry_after` when given). */
  RATE_LIMITED: 'RATE_LIMITED',
  /** HTTP 401/404: the token was rejected (Telegram answers 404 for an unknown token path). */
  AUTH: 'AUTH',
  /** HTTP 403: the bot may not write to that chat (for example the owner blocked the bot). */
  FORBIDDEN: 'FORBIDDEN',
  /** HTTP 409: another `getUpdates` poller, or a webhook, holds this token. */
  CONFLICT: 'CONFLICT',
  /** Any other 4xx: the API refused the request as formed. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** The body exceeded the byte bound. */
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  /** The body was not the expected JSON envelope. */
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
} as const;
export type TelegramFailureCode = (typeof TelegramFailureCode)[keyof typeof TelegramFailureCode];

/** A classified Bot API failure: a fixed code, the method, and at most the HTTP status number and `retry_after`. */
export class TelegramApiError extends Error {
  constructor(
    readonly code: TelegramFailureCode,
    readonly method: TelegramMethod,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`telegram ${method}: ${code}${httpStatus !== undefined ? ` (HTTP ${httpStatus})` : ''}`);
    this.name = 'TelegramApiError';
  }
}

/** Whether a failed send certainly did not post anything (Telegram refused it before creating a message). */
export function isConfirmedNotSent(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  switch (error.code) {
    case 'RATE_LIMITED':
    case 'AUTH':
    case 'FORBIDDEN':
    case 'BAD_REQUEST':
    case 'CONFLICT':
      return true;
    default:
      return false;
  }
}

export function failureCodeOfStatus(status: number): TelegramFailureCode {
  if (status === 401 || status === 404) return TelegramFailureCode.AUTH;
  if (status === 403) return TelegramFailureCode.FORBIDDEN;
  if (status === 409) return TelegramFailureCode.CONFLICT;
  if (status === 429) return TelegramFailureCode.RATE_LIMITED;
  if (status >= 400 && status < 500) return TelegramFailureCode.BAD_REQUEST;
  return TelegramFailureCode.UNAVAILABLE;
}

export interface TelegramCallOptions {
  /** Bound on the whole call (headers and body). */
  readonly timeoutMs: number;
  /** Cancels the call (adapter stop). */
  readonly signal?: AbortSignal;
  /** Bound on the response body; default {@link DEFAULT_MAX_RESPONSE_BYTES}. */
  readonly maxResponseBytes?: number;
}

/** 1 MiB: far above any `sendMessage` / `getMe` answer. `getUpdates` passes its own, larger bound. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
/** The largest `retry_after` honoured from a 429 (an absurd value is clamped). */
const MAX_RETRY_AFTER_SECONDS = 3600;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * One Bot API client per token. `fetchImpl` is the test seam; by default every call reads the global `fetch` at call
 * time.
 */
export class TelegramBotApi {
  readonly #token: TelegramBotToken;
  readonly #fetch: FetchLike;

  constructor(token: TelegramBotToken, fetchImpl?: FetchLike) {
    this.#token = token;
    this.#fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Run one call; resolves with the envelope's `result` only for `{ ok: true }`, else throws {@link TelegramApiError}. */
  async call(method: TelegramMethod, params: Record<string, unknown> | FormData, options: TelegramCallOptions): Promise<unknown> {
    if (!METHODS.has(method)) throw new TelegramApiError(TelegramFailureCode.BAD_REQUEST, method);
    const fail = (code: TelegramFailureCode, status?: number, retryAfter?: number): TelegramApiError =>
      new TelegramApiError(code, method, status, retryAfter);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const onAbort = (): void => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const failure = (): TelegramFailureCode =>
      timedOut ? TelegramFailureCode.TIMEOUT : options.signal?.aborted ? TelegramFailureCode.ABORTED : TelegramFailureCode.UNAVAILABLE;
    try {
      const form = params instanceof FormData;
      let response: Response;
      try {
        response = await this.#fetch(`${TELEGRAM_API_ORIGIN}/bot${this.#token.reveal()}/${method}`, {
          method: 'POST',
          headers: form ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
          body: form ? params : JSON.stringify(params),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        // A transport error may quote the request URL (the token is in its path): only a fixed code leaves.
        throw fail(failure());
      }
      if (response.redirected || (response.url !== '' && !sameOrigin(response.url))) {
        await discard(response);
        throw fail(TelegramFailureCode.UNAVAILABLE);
      }
      const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      let envelope: unknown;
      try {
        const bytes = await readBounded(response, maxBytes);
        envelope = bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as unknown);
      } catch (err) {
        if (err instanceof BodyTooLarge) throw fail(TelegramFailureCode.RESPONSE_TOO_LARGE, response.status);
        if (err instanceof SyntaxError) envelope = null;
        else throw fail(failure(), response.status);
      }
      if (response.status < 200 || response.status > 299) {
        const code = failureCodeOfStatus(response.status);
        throw fail(code, response.status, code === TelegramFailureCode.RATE_LIMITED ? retryAfterOf(envelope) : undefined);
      }
      if (!isOkEnvelope(envelope)) throw fail(TelegramFailureCode.MALFORMED_RESPONSE, response.status);
      return envelope.result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * TG-2: download one file by the `file_path` that `getFile` returned, from the same pinned host
   * (`/file/bot<token>/<file_path>`), as at most `maxResponseBytes` bytes. The URL carries the token, so it is built
   * here, used once and never returned, logged or put into an error: every failure is the fixed
   * `telegram downloadFile: <CODE>[ (HTTP n)]`. Redirects and another origin are refused, a declared or streamed body
   * over the bound is `RESPONSE_TOO_LARGE`, and an unsafe `file_path` ({@link isSafeTelegramFilePath}) is refused as
   * `BAD_REQUEST` before any request.
   */
  async download(filePath: string, options: TelegramCallOptions & { readonly maxResponseBytes: number }): Promise<Buffer> {
    const method: TelegramMethod = 'downloadFile';
    const fail = (code: TelegramFailureCode, status?: number): TelegramApiError => new TelegramApiError(code, method, status);
    if (!isSafeTelegramFilePath(filePath)) throw fail(TelegramFailureCode.BAD_REQUEST);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const onAbort = (): void => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const failure = (): TelegramFailureCode =>
      timedOut ? TelegramFailureCode.TIMEOUT : options.signal?.aborted ? TelegramFailureCode.ABORTED : TelegramFailureCode.UNAVAILABLE;
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${TELEGRAM_API_ORIGIN}/file/bot${this.#token.reveal()}/${filePath}`, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        // A transport error may quote the request URL (the token is in its path): only a fixed code leaves.
        throw fail(failure());
      }
      if (response.redirected || (response.url !== '' && !sameOrigin(response.url))) {
        await discard(response);
        throw fail(TelegramFailureCode.UNAVAILABLE);
      }
      if (response.status < 200 || response.status > 299) {
        await discard(response);
        throw fail(failureCodeOfStatus(response.status), response.status);
      }
      try {
        return (await readBounded(response, options.maxResponseBytes)) ?? Buffer.alloc(0);
      } catch (err) {
        if (err instanceof BodyTooLarge) throw fail(TelegramFailureCode.RESPONSE_TOO_LARGE, response.status);
        throw fail(failure(), response.status);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function isOkEnvelope(value: unknown): value is { ok: true; result: unknown } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true && 'result' in value;
}

/** The numeric `parameters.retry_after` of an error envelope, bounded; nothing else of the body is read. */
function retryAfterOf(envelope: unknown): number | undefined {
  const value = (envelope as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  return Math.min(value, MAX_RETRY_AFTER_SECONDS);
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === TELEGRAM_API_ORIGIN;
  } catch {
    return false;
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to report: the body is not used.
  }
}

class BodyTooLarge extends Error {}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await discard(response);
    throw new BodyTooLarge();
  }
  const body = response.body;
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

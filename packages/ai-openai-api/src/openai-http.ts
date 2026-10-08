import { AiFailureKind, AiProviderError } from '@quoky/core';
import { OPENAI_API_ORIGIN } from './openai-api-config';

/**
 * The bounded HTTP call of the OpenAI API adapter (ADR-0115 D5–D7) and its failure taxonomy (the ADR-0092 amendment D5
 * reasons: timeout, unavailable, rate limit, auth, empty output).
 *
 * - The URL is always {@link OPENAI_API_ORIGIN} plus a fixed path: HTTPS, the pinned host, no base URL option.
 * - Redirects are refused (`redirect: 'error'`); a response whose final URL is on another origin is refused too.
 * - One timer bounds the whole call, headers AND body.
 * - The body is read through a byte-bounded reader; a larger body is cancelled and refused, never partially parsed.
 * - A non-2xx body is never read: only the numeric status classifies the failure. No failure message ever carries a
 *   response body, a request field, the URL or the key — only a fixed code and, at most, the HTTP status number.
 */

export const OpenAiFailureCode = {
  /** The call did not finish within its bound. */
  TIMEOUT: 'TIMEOUT',
  /** The host could not be reached, or answered 404/408/409/5xx, or the response was not usable as a transport. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** HTTP 429: a rate limit or an exhausted quota. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** HTTP 401/403: the key was rejected. */
  AUTH: 'AUTH',
  /** The response held no reply text. */
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
  /** Any other 4xx: the API refused the request as formed. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** The body exceeded the byte bound. */
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  /** The body was not the expected JSON shape (or had an unknown output item). */
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  /** The response contained a tool, function, search or other non-message action item (never requested). */
  TOOL_CALL_REFUSED: 'TOOL_CALL_REFUSED',
  /** The adapter refused the request before sending anything (capability, workspace, context-file or image rules). */
  REQUEST_REFUSED: 'REQUEST_REFUSED',
  /** `status: incomplete` for a reason other than the output bound (a content filter or anything unknown). */
  INCOMPLETE: 'INCOMPLETE',
} as const;
export type OpenAiFailureCode = (typeof OpenAiFailureCode)[keyof typeof OpenAiFailureCode];

const KIND_OF: Readonly<Record<OpenAiFailureCode, AiFailureKind>> = {
  TIMEOUT: AiFailureKind.TIMEOUT,
  UNAVAILABLE: AiFailureKind.UNAVAILABLE,
  // Like the Codex usage-limit failure: the router's next turn re-probes; nothing switches automatically.
  RATE_LIMITED: AiFailureKind.UNAVAILABLE,
  AUTH: AiFailureKind.AUTH_REQUIRED,
  EMPTY_OUTPUT: AiFailureKind.EMPTY_OUTPUT,
  BAD_REQUEST: AiFailureKind.EXECUTION_FAILED,
  RESPONSE_TOO_LARGE: AiFailureKind.EXECUTION_FAILED,
  MALFORMED_RESPONSE: AiFailureKind.EXECUTION_FAILED,
  TOOL_CALL_REFUSED: AiFailureKind.EXECUTION_FAILED,
  REQUEST_REFUSED: AiFailureKind.EXECUTION_FAILED,
  INCOMPLETE: AiFailureKind.EXECUTION_FAILED,
};

/** A classified OpenAI API failure: a fixed code, its `AiFailureKind`, and at most the HTTP status number. */
export class OpenAiApiError extends AiProviderError {
  constructor(
    readonly code: OpenAiFailureCode,
    label: string,
    readonly httpStatus?: number,
  ) {
    super(KIND_OF[code], `${label}: ${code}${httpStatus !== undefined ? ` (HTTP ${httpStatus})` : ''}`);
    this.name = 'OpenAiApiError';
  }
}

/** The failure code of a non-2xx HTTP status. */
export function failureCodeOfStatus(status: number): OpenAiFailureCode {
  if (status === 401 || status === 403) return OpenAiFailureCode.AUTH;
  if (status === 429) return OpenAiFailureCode.RATE_LIMITED;
  if (status === 404 || status === 408 || status === 409 || status >= 500) return OpenAiFailureCode.UNAVAILABLE;
  if (status >= 400) return OpenAiFailureCode.BAD_REQUEST;
  return OpenAiFailureCode.UNAVAILABLE;
}

export interface OpenAiCall {
  readonly method: 'GET' | 'POST';
  /** A fixed path under the pinned origin (already encoded). */
  readonly path: string;
  readonly apiKey: string;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** The failure-message label (`openai API`, `openai vision API`). */
  readonly label: string;
}

export interface OpenAiCallResult {
  readonly status: number;
  /** The parsed JSON body (2xx only). */
  readonly json: unknown;
  readonly responseBytes: number;
}

/**
 * Run one bounded call. Resolves only for a 2xx with a JSON body within the byte bound; every other outcome throws an
 * {@link OpenAiApiError} with a fixed code.
 */
export async function callOpenAi(fetchImpl: typeof fetch, call: OpenAiCall): Promise<OpenAiCallResult> {
  const fail = (code: OpenAiFailureCode, status?: number): OpenAiApiError => new OpenAiApiError(code, call.label, status);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${OPENAI_API_ORIGIN}${call.path}`, {
        method: call.method,
        headers: {
          authorization: `Bearer ${call.apiKey}`,
          accept: 'application/json',
          ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(call.body !== undefined ? { body: call.body } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // A transport error may carry the URL or request details: only a fixed code leaves.
      throw fail(timedOut ? OpenAiFailureCode.TIMEOUT : OpenAiFailureCode.UNAVAILABLE);
    }
    if (response.redirected || (response.url !== '' && !sameOrigin(response.url))) {
      await discard(response);
      throw fail(OpenAiFailureCode.UNAVAILABLE);
    }
    if (response.status < 200 || response.status > 299) {
      // The body is never read (OpenAI error bodies can quote a masked key or the request).
      await discard(response);
      throw fail(failureCodeOfStatus(response.status), response.status);
    }
    const bytes = await readBounded(response, call.maxResponseBytes, () => timedOut, fail);
    try {
      return { status: response.status, json: JSON.parse(bytes.toString('utf8')) as unknown, responseBytes: bytes.length };
    } catch {
      throw fail(OpenAiFailureCode.MALFORMED_RESPONSE);
    }
  } finally {
    clearTimeout(timer);
  }
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === OPENAI_API_ORIGIN;
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

async function readBounded(
  response: Response,
  maxBytes: number,
  timedOut: () => boolean,
  fail: (code: OpenAiFailureCode) => OpenAiApiError,
): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await discard(response);
    throw fail(OpenAiFailureCode.RESPONSE_TOO_LARGE);
  }
  const body = response.body;
  if (body === null) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw fail(OpenAiFailureCode.RESPONSE_TOO_LARGE);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof OpenAiApiError) throw err;
    throw fail(timedOut() ? OpenAiFailureCode.TIMEOUT : OpenAiFailureCode.UNAVAILABLE);
  }
  return Buffer.concat(chunks, total);
}

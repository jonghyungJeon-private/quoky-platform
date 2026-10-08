import { AiFailureKind, AiProviderError } from '@quoky/core';
import { GEMINI_API_ORIGIN } from './gemini-api-config';

/**
 * The bounded HTTP call of the Gemini API adapter (ADR-0115 D5–D7) and its failure taxonomy (the ADR-0092 amendment D5
 * reasons: timeout, unavailable, rate limit, auth, empty output).
 *
 * - The URL is always {@link GEMINI_API_ORIGIN} plus a fixed path: HTTPS, the pinned host, no base URL option, and NO
 *   query string — the key travels only in the `x-goog-api-key` header, so it can never leak through a URL (a log line,
 *   a proxy, an error that quotes the URL).
 * - Redirects are refused (`redirect: 'error'`); a response whose final URL is on another origin is refused too.
 * - One timer bounds the whole call, headers AND body.
 * - The body is read through a byte-bounded reader; a larger body is cancelled and refused, never partially parsed.
 * - A non-2xx body is never read: only the numeric status classifies the failure. No failure message ever carries a
 *   response body, a request field, the URL or the key — only a fixed code and, at most, the HTTP status number.
 */

export const GeminiFailureCode = {
  /** The call did not finish within its bound. */
  TIMEOUT: 'TIMEOUT',
  /** The host could not be reached, or answered 404/408/409/5xx, or the response was not usable as a transport. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** HTTP 429 (`RESOURCE_EXHAUSTED`): a rate limit or an exhausted quota. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** HTTP 401/403: the key was rejected or lacks permission. */
  AUTH: 'AUTH',
  /** The response held no reply text. */
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
  /**
   * Any other 4xx: the API refused the request as formed. The Gemini API also answers an invalid key with HTTP 400
   * (`INVALID_ARGUMENT`); the body that would tell the two apart is never read, so this code also drops the shared
   * readiness answer (see the provider).
   */
  BAD_REQUEST: 'BAD_REQUEST',
  /** The body exceeded the byte bound. */
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  /** The body was not the expected JSON shape (or had an unknown or non-text part). */
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  /**
   * The response contained a function call, a tool call, executable code or a code-execution result, or grounding
   * metadata, or finished on a tool-call reason — none of which is ever requested.
   */
  TOOL_CALL_REFUSED: 'TOOL_CALL_REFUSED',
  /** The adapter refused the request before sending anything (capability, workspace, context-file or image rules). */
  REQUEST_REFUSED: 'REQUEST_REFUSED',
  /**
   * The prompt was blocked (`promptFeedback.blockReason`) or the candidate stopped on a safety, recitation, blocklist,
   * prohibited-content or personal-data reason. Fails closed: no partial text is ever returned.
   */
  SAFETY_BLOCKED: 'SAFETY_BLOCKED',
  /** The candidate stopped for any other reason than `STOP` or the output bound (`LANGUAGE`, `OTHER`, unknown). */
  INCOMPLETE: 'INCOMPLETE',
} as const;
export type GeminiFailureCode = (typeof GeminiFailureCode)[keyof typeof GeminiFailureCode];

const KIND_OF: Readonly<Record<GeminiFailureCode, AiFailureKind>> = {
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
  SAFETY_BLOCKED: AiFailureKind.EXECUTION_FAILED,
  INCOMPLETE: AiFailureKind.EXECUTION_FAILED,
};

/** A classified Gemini API failure: a fixed code, its `AiFailureKind`, and at most the HTTP status number. */
export class GeminiApiError extends AiProviderError {
  constructor(
    readonly code: GeminiFailureCode,
    label: string,
    readonly httpStatus?: number,
  ) {
    super(KIND_OF[code], `${label}: ${code}${httpStatus !== undefined ? ` (HTTP ${httpStatus})` : ''}`);
    this.name = 'GeminiApiError';
  }
}

/** The failure code of a non-2xx HTTP status. */
export function failureCodeOfStatus(status: number): GeminiFailureCode {
  if (status === 401 || status === 403) return GeminiFailureCode.AUTH;
  if (status === 429) return GeminiFailureCode.RATE_LIMITED;
  if (status === 404 || status === 408 || status === 409 || status >= 500) return GeminiFailureCode.UNAVAILABLE;
  if (status >= 400) return GeminiFailureCode.BAD_REQUEST;
  return GeminiFailureCode.UNAVAILABLE;
}

export interface GeminiCall {
  readonly method: 'GET' | 'POST';
  /** A fixed path under the pinned origin (already encoded; never a query string). */
  readonly path: string;
  readonly apiKey: string;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** The failure-message label (`gemini API`, `gemini vision API`). */
  readonly label: string;
}

export interface GeminiCallResult {
  readonly status: number;
  /** The parsed JSON body (2xx only). */
  readonly json: unknown;
  readonly responseBytes: number;
}

/**
 * Run one bounded call. Resolves only for a 2xx with a JSON body within the byte bound; every other outcome throws a
 * {@link GeminiApiError} with a fixed code.
 */
export async function callGemini(fetchImpl: typeof fetch, call: GeminiCall): Promise<GeminiCallResult> {
  const fail = (code: GeminiFailureCode, status?: number): GeminiApiError => new GeminiApiError(code, call.label, status);
  // A query string could only ever carry something that belongs in a header: refused outright (defence in depth).
  if (call.path.includes('?') || call.path.includes('#')) throw fail(GeminiFailureCode.REQUEST_REFUSED);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${GEMINI_API_ORIGIN}${call.path}`, {
        method: call.method,
        headers: {
          'x-goog-api-key': call.apiKey,
          accept: 'application/json',
          ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(call.body !== undefined ? { body: call.body } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // A transport error may carry the URL or request details: only a fixed code leaves.
      throw fail(timedOut ? GeminiFailureCode.TIMEOUT : GeminiFailureCode.UNAVAILABLE);
    }
    if (response.redirected || (response.url !== '' && !sameOrigin(response.url))) {
      await discard(response);
      throw fail(GeminiFailureCode.UNAVAILABLE);
    }
    if (response.status < 200 || response.status > 299) {
      // The body is never read (a Google error body can quote the request or name the key's project).
      await discard(response);
      throw fail(failureCodeOfStatus(response.status), response.status);
    }
    const bytes = await readBounded(response, call.maxResponseBytes, () => timedOut, fail);
    try {
      return { status: response.status, json: JSON.parse(bytes.toString('utf8')) as unknown, responseBytes: bytes.length };
    } catch {
      throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
    }
  } finally {
    clearTimeout(timer);
  }
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === GEMINI_API_ORIGIN;
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
  fail: (code: GeminiFailureCode) => GeminiApiError,
): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await discard(response);
    throw fail(GeminiFailureCode.RESPONSE_TOO_LARGE);
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
        throw fail(GeminiFailureCode.RESPONSE_TOO_LARGE);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof GeminiApiError) throw err;
    throw fail(timedOut() ? GeminiFailureCode.TIMEOUT : GeminiFailureCode.UNAVAILABLE);
  }
  return Buffer.concat(chunks, total);
}

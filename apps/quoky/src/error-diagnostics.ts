import type { LogFields } from '@quoky/core';

/**
 * Secret-free structured error diagnostics for the composition-root inbound/approval catch blocks
 * (Sprint 4c-Follow-up-2, Track B). The prior catch logged only `err.message`, discarding `error.name`,
 * `error.stack`, and `error.cause` — leaving a runtime failure (e.g. an undefined `.save()`) undiagnosable.
 *
 * This module turns an unknown thrown value into a FLAT `LogFields` record (scalars only, so `ConsoleLogger`
 * renders `key=value`), carrying name / message / stack / cause plus any caller-supplied non-secret context —
 * with EVERY string value passed through `redactSecrets` first. It changes no runtime behavior; it only makes
 * the existing error logging diagnosable and secret-safe.
 */

/** Redaction patterns — ordered most-specific first. Each removes a class of secret while leaving surrounding
 *  non-secret text (and non-secret identifiers like commit SHAs) intact. */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private-key blocks (App private key) — collapse the whole block.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  // JWT (App JWT) — three base64url segments starting with the `eyJ` header.
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  // Token-bearing URL userinfo — e.g. https://x-access-token:ghs_xxx@github.com/... (keep the host).
  [/(https?:\/\/)[^@/\s]+@/gi, '$1[REDACTED]@'],
  // GitHub tokens: installation (ghs_), OAuth (gho_), app (ghp_/ghu_/ghr_), fine-grained PAT (github_pat_).
  [/\b(gh[opsur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED_TOKEN]'],
  // Authorization headers: `Authorization: Bearer <v>` / `token <v>` / `Basic <v>` (JSON or header form).
  [/\b(authorization\s*[:=]\s*"?)(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1$2 [REDACTED]'],
  // Named secret env/keys carrying a value: GIT_APP_TOKEN=..., QUOKY_GITHUB_APP_PRIVATE_KEY=..., x-access-token:...
  [/\b(GIT_APP_TOKEN|QUOKY_GITHUB_APP_PRIVATE_KEY|QUOKY_OPENAI_API_KEY|x-access-token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]'],
  // OpenAI secret keys (user, project, service-account and admin keys; ADR-0115 D6).
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]'],
];

/** Replace every recognized secret class in `input` with a stable placeholder. Non-secret text is preserved. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Render a thrown `cause` as a short, non-secret string (Errors → "Name: message"; else String()). */
function causeToString(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/**
 * Serialize any thrown value into a flat, secret-free `LogFields` record. `context` carries non-secret
 * correlation fields (stage / messageId / platform / channelId / userId / …); every string value in the
 * result — including the caller's context, the message, the stack, and the cause — is redacted.
 */
export function serializeError(err: unknown, context: LogFields = {}): LogFields {
  const raw: LogFields = { ...context };
  if (err instanceof Error) {
    raw.errorName = err.name;
    raw.errorMessage = err.message;
    if (err.stack) raw.errorStack = err.stack;
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) raw.errorCause = causeToString(cause);
  } else {
    raw.errorName = 'NonError';
    raw.errorMessage = String(err);
  }
  // Redact EVERY string value (context included) — defense in depth: a token could ride in any field.
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(raw)) {
    safe[key] = typeof value === 'string' ? redactSecrets(value) : value;
  }
  return safe;
}

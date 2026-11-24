import { constantTimeEquals, newSecret } from '@quoky/local-auth';

/**
 * OPS-1 browser hardening and access primitives (ADR-0113 D3/D4). Shared auth comes from `@quoky/local-auth` (ADR-0125 D11).
 */

/** ADR-0113 D4: the exact policy string. No `'unsafe-inline'`, `'unsafe-eval'`, nonce or hash. */
export const OPS_UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Set on every response (ADR-0113 D4). No CORS header is ever sent. */
export const OPS_UI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': OPS_UI_CSP,
  'X-Content-Type-Options': 'nosniff',
  // same-origin, not no-referrer: Chromium serializes the Origin of a form POST as "null" under no-referrer, which the
  // ADR-0113 D4 Origin check then refuses (live finding: sign-in "허용되지 않은 출처예요"). same-origin still sends no
  // referrer to any other origin.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export const OPS_UI_SESSION_COOKIE = 'quoky_ops_session';
/** A signed-in session lasts at most this long (it never outlives the process either). */
export const OPS_UI_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Oldest sessions are dropped beyond this many. */
export const OPS_UI_MAX_SESSIONS = 8;

export interface OpsUiSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly createdAtMs: number;
}

/** In-memory sessions bound to this process start (ADR-0113 D3). */
export class OpsUiSessionStore {
  private readonly sessions = new Map<string, OpsUiSession>();

  constructor(private readonly nowMs: () => number) {}

  create(): OpsUiSession {
    const session: OpsUiSession = { id: newSecret(), csrfToken: newSecret(), createdAtMs: this.nowMs() };
    this.sessions.set(session.id, session);
    while (this.sessions.size > OPS_UI_MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return session;
  }

  /** The live session for a cookie value, or undefined (unknown or expired; expired ones are dropped). */
  find(id: string | undefined): OpsUiSession | undefined {
    if (id === undefined || id.length === 0) return undefined;
    for (const session of this.sessions.values()) {
      if (!constantTimeEquals(id, session.id)) continue;
      if (this.nowMs() - session.createdAtMs >= OPS_UI_SESSION_TTL_MS) {
        this.sessions.delete(session.id);
        return undefined;
      }
      return session;
    }
    return undefined;
  }

  end(id: string): void {
    this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }
}

/** The value of one cookie from a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function sessionCookie(id: string): string {
  return `${OPS_UI_SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`;
}

export function clearedSessionCookie(): string {
  return `${OPS_UI_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

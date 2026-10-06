/**
 * Google Calendar one-time consent helper (ADR-0110 D2, CAL-1; scopes per the ADR-0110 amendment D1, 2026-10-06).
 * Running it is a Strict owner action.
 *
 *   node apps/quoky/dist/tools/calendar-auth.js --out <new token file>
 *
 * Reads the OAuth "Desktop app" client from `QUOKY_CALENDAR_GOOGLE_CLIENT_ID` / `QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET`
 * (the process environment, then `.env.local`), listens on a loopback port (`127.0.0.1`, random port) for the
 * redirect, and prints a consent URL for exactly two scopes — `calendar.readonly` and `calendar.events` — (PKCE S256,
 * a one-time `state`). After the owner approves in the browser it exchanges the code with `oauth2.googleapis.com` and
 * writes the refresh token and the granted scopes to a NEW file with mode 600 (an existing file is never overwritten).
 * The authorization code, access token and refresh token are never printed; the console shows the consent URL (no
 * secret in it), the granted scopes, the file path and the next step.
 *
 * A grant without `calendar.readonly`, or broader than those two scopes (the full `calendar` scope,
 * `calendar.settings.*`, ACL/sharing scopes, `openid`, …), is refused and nothing is written. A grant of
 * `calendar.readonly` alone (the owner unticked event editing) is saved: reads work, and the wave-5 calendar writes
 * stay unavailable until the helper is run again. Quoky itself never writes the calendar unless
 * `QUOKY_CALENDAR_WRITE_ENABLED` and the ADR-0112 approval flow allow it (CWR-2).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import {
  GOOGLE_CALENDAR_ALLOWED_SCOPES,
  GoogleCalendarScopeError,
  GoogleCalendarNoRefreshTokenError,
  GoogleCalendarTokenFileError,
  assertGrantedCalendarScopes,
  buildGoogleConsentUrl,
  createGoogleOAuthState,
  createGooglePkcePair,
  exchangeGoogleAuthorizationCode,
  grantIncludesCalendarEvents,
  writeGoogleCalendarTokenFile,
} from '@quoky/connector-calendar-google';
import { isConnectorQueryError } from '@quoky/core';
import { resolveEnvFilePath, resolveGoogleCalendarOAuthClient } from '../config';
import { loadLocalEnvironment } from '../env-loader';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
/** The output file already exists, or the client is not configured. */
export const EXIT_BLOCKED = 3;

export const CALENDAR_AUTH_CALLBACK_PATH = '/oauth2callback';
/** How long the helper waits for the browser redirect. */
export const CALENDAR_AUTH_DEFAULT_WAIT_MS = 5 * 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
/** The only scopes the consent requests (ADR-0110 amendment D1); a grant may hold nothing broader. */
export const CALENDAR_AUTH_REQUESTED_SCOPES: readonly string[] = GOOGLE_CALENDAR_ALLOWED_SCOPES;
const CODE_MAX_LENGTH = 2048;

/** A loopback callback listener. `onRequest` receives the request path with its query string. */
export interface CallbackListener {
  readonly port: number;
  close(): Promise<void>;
}

export type CallbackHandler = (pathAndQuery: string) => { status: number; body: string };

export interface CalendarAuthDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  readonly fileExists: (path: string) => boolean;
  /** Writes the refresh token and the normalized granted scopes to a NEW mode-600 file. */
  readonly writeTokenFile: (path: string, refreshToken: string, scope: string) => void;
  readonly listen: (handler: CallbackHandler) => Promise<CallbackListener>;
  readonly waitMs: number;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const HELP = `Google Calendar consent helper (ADR-0110 D2 + amendment D1) — calendar.readonly + calendar.events only

  node apps/quoky/dist/tools/calendar-auth.js --out <new token file>

Needs QUOKY_CALENDAR_GOOGLE_CLIENT_ID and QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET (a Google OAuth "Desktop app" client).
Open the printed URL in your browser on this machine and approve calendar access (view events; edit events is used
only for approved writes, which stay off unless QUOKY_CALENDAR_WRITE_ENABLED is set). Any broader grant (full calendar,
settings, sharing/ACL) is refused. The refresh token is written to the new file with mode 600 and is never printed.
Then set QUOKY_CALENDAR_GOOGLE_TOKEN_FILE to that path.
`;

const PAGE_RECEIVED = 'Quoky: approval received. Return to the terminal to confirm the token was saved. You can close this tab.';
const PAGE_FAILED = 'Quoky: calendar access was not saved. Return to the terminal for the reason. You can close this tab.';

function parseArgs(argv: readonly string[]): { out: string } | null {
  if (argv.length !== 2 || argv[0] !== '--out') return null;
  const out = argv[1];
  return out === undefined || out.length === 0 || out.startsWith('--') ? null : { out };
}

type CallbackOutcome = { kind: 'code'; code: string } | { kind: 'denied' } | { kind: 'state-mismatch' } | { kind: 'invalid' };

/** Classify one callback request. Pure; exported for tests. Paths other than the callback path return `undefined`. */
export function classifyCallback(pathAndQuery: string, expectedState: string): CallbackOutcome | undefined {
  let url: URL;
  try {
    url = new URL(pathAndQuery, 'http://127.0.0.1');
  } catch {
    return undefined;
  }
  if (url.pathname !== CALENDAR_AUTH_CALLBACK_PATH) return undefined;
  const state = url.searchParams.get('state') ?? '';
  if (!sameSecret(state, expectedState)) return { kind: 'state-mismatch' };
  if (url.searchParams.has('error')) return { kind: 'denied' };
  const code = url.searchParams.get('code') ?? '';
  if (code.length === 0 || code.length > CODE_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(code)) return { kind: 'invalid' };
  return { kind: 'code', code };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Run the consent flow. Prints no token or code. */
export async function runCli(argv: readonly string[], deps: CalendarAuthDeps = defaultDeps()): Promise<number> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.includes('--help') || args.includes('-h')) {
    deps.stdout(HELP);
    return EXIT_OK;
  }
  const options = parseArgs(args);
  if (options === null) {
    deps.stderr(HELP);
    return EXIT_USAGE;
  }
  const client = resolveGoogleCalendarOAuthClient(deps.env);
  if (client === undefined) {
    deps.stderr('BLOCKED: set QUOKY_CALENDAR_GOOGLE_CLIENT_ID and QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET first');
    return EXIT_BLOCKED;
  }
  const outPath = resolve(options.out);
  if (deps.fileExists(outPath)) {
    deps.stderr('BLOCKED: the output file already exists; choose a new path (nothing was overwritten)');
    return EXIT_BLOCKED;
  }

  const state = createGoogleOAuthState();
  const pkce = createGooglePkcePair();
  let settle: (outcome: CallbackOutcome) => void = () => undefined;
  const outcome = new Promise<CallbackOutcome>((resolveOutcome) => {
    settle = resolveOutcome;
  });
  let settled = false;
  const listener = await deps.listen((pathAndQuery) => {
    const result = classifyCallback(pathAndQuery, state);
    if (result === undefined) return { status: 404, body: 'Not found' };
    if (settled) return { status: 409, body: PAGE_FAILED };
    settled = true;
    settle(result);
    return result.kind === 'code' ? { status: 200, body: PAGE_RECEIVED } : { status: 400, body: PAGE_FAILED };
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    const redirectUri = `http://127.0.0.1:${listener.port}${CALENDAR_AUTH_CALLBACK_PATH}`;
    deps.stdout('Open this URL in a browser on this machine and approve calendar access (calendar.readonly + calendar.events only):');
    deps.stdout(buildGoogleConsentUrl({ clientId: client.clientId, redirectUri, state, codeChallenge: pkce.challenge }));
    deps.stdout(`Waiting up to ${Math.round(deps.waitMs / 60_000)} minutes for the browser redirect to ${redirectUri} …`);

    const timeout = new Promise<'timeout'>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), deps.waitMs);
    });
    const result = await Promise.race([outcome, timeout]);
    if (result === 'timeout') {
      deps.stderr('FAILED: no browser redirect arrived in time; nothing was written');
      return EXIT_FAILED;
    }
    if (result.kind !== 'code') {
      deps.stderr(
        result.kind === 'denied'
          ? 'FAILED: consent was declined in the browser; nothing was written'
          : result.kind === 'state-mismatch'
            ? 'FAILED: the redirect did not match this consent attempt; nothing was written'
            : 'FAILED: the redirect carried no usable authorization code; nothing was written',
      );
      return EXIT_FAILED;
    }

    const granted = await exchangeGoogleAuthorizationCode(
      client,
      { code: result.code, codeVerifier: pkce.verifier, redirectUri },
      { fetchImpl: deps.fetchImpl, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS },
    );
    // Defence in depth over the adapter's own check: never persist a grant outside the two allowed scopes.
    const grant = assertGrantedCalendarScopes(granted.scope);
    deps.writeTokenFile(outPath, granted.refreshToken, grant);
    deps.stdout(
      grantIncludesCalendarEvents(grant)
        ? `Saved a calendar.readonly + calendar.events refresh token (mode 600) to ${outPath}`
        : `Saved a calendar.readonly refresh token (mode 600) to ${outPath} (calendar.events was not granted: calendar writes will stay unavailable)`,
    );
    deps.stdout(`Next: set QUOKY_CALENDAR_GOOGLE_TOKEN_FILE=${outPath} in .env.local and restart Quoky.`);
    return EXIT_OK;
  } catch (error) {
    deps.stderr(`FAILED: ${describeFailure(error)}; nothing was written`);
    return EXIT_FAILED;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await listener.close();
  }
}

/** Fixed, value-free failure text. */
function describeFailure(error: unknown): string {
  if (error instanceof GoogleCalendarTokenFileError) return error.code;
  if (error instanceof GoogleCalendarScopeError) {
    return error.kind === 'TOO_BROAD'
      ? 'Google granted more than calendar.readonly and calendar.events (refused)'
      : 'Google did not grant calendar.readonly (tick the calendar permission on the consent screen)';
  }
  if (error instanceof GoogleCalendarNoRefreshTokenError) {
    return 'Google returned no refresh token (remove Quoky at https://myaccount.google.com/permissions and run again)';
  }
  if (isConnectorQueryError(error)) return `token exchange failed (${error.reason.toLowerCase()})`;
  return 'unexpected error';
}

/** The production listener: `127.0.0.1` only, random port, GET only, static text responses. */
export function listenOnLoopback(handler: CallbackHandler): Promise<CallbackListener> {
  return new Promise((resolveListener, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const { status, body } =
        request.method === 'GET' ? handler(request.url ?? '/') : { status: 405, body: 'Method not allowed' };
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(body);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('loopback listener has no port'));
        return;
      }
      resolveListener({
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.closeAllConnections?.();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

function defaultDeps(): CalendarAuthDeps {
  return {
    env: process.env,
    fetchImpl: fetch,
    fileExists: existsSync,
    writeTokenFile: writeGoogleCalendarTokenFile,
    listen: listenOnLoopback,
    waitMs: CALENDAR_AUTH_DEFAULT_WAIT_MS,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

if (require.main === module) {
  const envFilePath = resolveEnvFilePath(process.env);
  loadLocalEnvironment(envFilePath !== undefined ? { envFilePath } : {});
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT_FAILED;
    },
  );
}

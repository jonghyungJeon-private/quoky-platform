import { describe, expect, it } from 'vitest';
import { GMAIL_OAUTH_TOKEN_URL, GMAIL_READONLY_SCOPE } from '@quoky/connector-gmail';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli, type CalendarAuthDeps, type CallbackHandler } from './calendar-auth';

// ADR-0118 D3 (GML-1): the consent helper's `--gmail` mode. Fixture values only, not token-shaped; no network.
const CLIENT_SECRET = 'fixture-client-secret';
const REFRESH = 'fixture-refresh-value';
const CODE = 'fixture-authorization-code';
const PORT = 53683;

function harness(scope: string = GMAIL_READONLY_SCOPE) {
  const out: string[] = [];
  const err: string[] = [];
  const gmailWritten: Array<{ path: string; token: string; scope: string }> = [];
  const calendarWritten: string[] = [];
  const fetchCalls: string[] = [];
  let handler: CallbackHandler | undefined;
  const deps: CalendarAuthDeps = {
    env: { QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'fixture-client.apps.googleusercontent.com', QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: CLIENT_SECRET } as NodeJS.ProcessEnv,
    fetchImpl: (async (input: URL | RequestInfo) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ access_token: 'fixture-access-value', refresh_token: REFRESH, expires_in: 3599, scope }), { status: 200 });
    }) as typeof fetch,
    fileExists: () => false,
    writeTokenFile: (path) => {
      calendarWritten.push(path);
    },
    writeGmailTokenFile: (path, token, grant) => {
      gmailWritten.push({ path, token, scope: grant });
    },
    listen: async (h) => {
      handler = h;
      return { port: PORT, close: async () => undefined };
    },
    waitMs: 60_000,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  const consentUrl = async (): Promise<URL> => {
    for (let i = 0; i < 100; i += 1) {
      const line = out.find((entry) => entry.startsWith('https://accounts.google.com/'));
      if (line !== undefined) return new URL(line);
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('no consent URL printed');
  };
  return { deps, out, err, gmailWritten, calendarWritten, fetchCalls, consentUrl, callback: (path: string) => handler?.(path) };
}

describe('consent helper --gmail (ADR-0118 D3)', () => {
  it('requests gmail.readonly only and writes a separate Gmail token file; prints no secret', async () => {
    const h = harness();
    const run = runCli(['--out', '/tmp/quoky-test/google-gmail-token.json', '--gmail'], h.deps);
    const consent = await h.consentUrl();
    expect(consent.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE);
    expect(consent.searchParams.get('include_granted_scopes')).toBe('false');
    const state = consent.searchParams.get('state') ?? '';
    expect(h.callback(`/oauth2callback?state=${state}&code=${CODE}`)?.status).toBe(200);
    await expect(run).resolves.toBe(EXIT_OK);
    expect(h.gmailWritten).toEqual([{ path: '/tmp/quoky-test/google-gmail-token.json', token: REFRESH, scope: GMAIL_READONLY_SCOPE }]);
    expect(h.calendarWritten).toEqual([]);
    expect(h.fetchCalls).toEqual([GMAIL_OAUTH_TOKEN_URL]);
    expect(h.out.join('\n')).toContain('QUOKY_GMAIL_TOKEN_FILE=/tmp/quoky-test/google-gmail-token.json');
    expect(h.out.join('\n')).toContain('READ-ONLY Gmail access');
    // Review P3-5: the shared-client revoke warning.
    expect(h.out.join('\n')).toContain('this also revokes the calendar grant');
    const printed = [...h.out, ...h.err].join('\n');
    for (const secret of [CLIENT_SECRET, REFRESH, CODE]) expect(printed).not.toContain(secret);
  });

  it.each([
    `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.send`,
    `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/calendar.readonly`,
    'https://mail.google.com/',
  ])('refuses a broader grant and writes nothing: %s', async (scope) => {
    const h = harness(scope);
    const run = runCli(['--gmail', '--out', '/tmp/x.json'], h.deps);
    const state = (await h.consentUrl()).searchParams.get('state');
    h.callback(`/oauth2callback?state=${state}&code=${CODE}`);
    await expect(run).resolves.toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('more than gmail.readonly');
    expect(h.gmailWritten).toEqual([]);
  });

  it('reports a grant without gmail.readonly as not granted', async () => {
    const h = harness('');
    const run = runCli(['--gmail', '--out', '/tmp/x.json'], h.deps);
    const state = (await h.consentUrl()).searchParams.get('state');
    h.callback(`/oauth2callback?state=${state}&code=${CODE}`);
    await expect(run).resolves.toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('did not grant gmail.readonly');
  });

  it('--gmail and --with-events are separate grant sets and cannot be combined', async () => {
    const h = harness();
    await expect(runCli(['--out', '/tmp/x.json', '--gmail', '--with-events'], h.deps)).resolves.toBe(EXIT_USAGE);
    await expect(runCli(['--out', '/tmp/x.json', '--gmail', '--gmail'], h.deps)).resolves.toBe(EXIT_USAGE);
    expect(h.fetchCalls).toEqual([]);
  });
});

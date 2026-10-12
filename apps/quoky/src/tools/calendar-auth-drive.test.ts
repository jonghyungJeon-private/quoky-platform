import { describe, expect, it } from 'vitest';
import { DRIVE_READONLY_SCOPE, GDRIVE_OAUTH_TOKEN_URL } from '@quoky/connector-gdrive';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli, type CalendarAuthDeps, type CallbackHandler } from './calendar-auth';

// ADR-0118 D3 (DRV-1): the consent helper's `--drive` mode (mirrors the `--gmail` tests). Fixture values only, not token-shaped; no network.
const CLIENT_SECRET = 'fixture-client-secret';
const REFRESH = 'fixture-refresh-value';
const CODE = 'fixture-authorization-code';
const PORT = 53683;

function harness(scope: string = DRIVE_READONLY_SCOPE) {
  const out: string[] = [];
  const err: string[] = [];
  const driveWritten: Array<{ path: string; token: string; scope: string }> = [];
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
    writeDriveTokenFile: (path, token, grant) => {
      driveWritten.push({ path, token, scope: grant });
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
  return { deps, out, err, driveWritten, calendarWritten, fetchCalls, consentUrl, callback: (path: string) => handler?.(path) };
}

describe('consent helper --drive (ADR-0118 D3, DRV-1)', () => {
  it('requests drive.readonly only and writes a separate Drive token file; prints no secret', async () => {
    const h = harness();
    const run = runCli(['--out', '/tmp/quoky-test/google-drive-token.json', '--drive'], h.deps);
    const consent = await h.consentUrl();
    expect(consent.searchParams.get('scope')).toBe(DRIVE_READONLY_SCOPE);
    expect(consent.searchParams.get('include_granted_scopes')).toBe('false');
    const state = consent.searchParams.get('state') ?? '';
    expect(h.callback(`/oauth2callback?state=${state}&code=${CODE}`)?.status).toBe(200);
    await expect(run).resolves.toBe(EXIT_OK);
    expect(h.driveWritten).toEqual([{ path: '/tmp/quoky-test/google-drive-token.json', token: REFRESH, scope: DRIVE_READONLY_SCOPE }]);
    expect(h.calendarWritten).toEqual([]);
    expect(h.fetchCalls).toEqual([GDRIVE_OAUTH_TOKEN_URL]);
    expect(h.out.join('\n')).toContain('QUOKY_DRIVE_TOKEN_FILE=/tmp/quoky-test/google-drive-token.json');
    expect(h.out.join('\n')).toContain('READ-ONLY Google Drive access');
    // The shared-client revoke warning (the GML-1 review P3-5 rule).
    expect(h.out.join('\n')).toContain('this also revokes the calendar and Gmail grants');
    const printed = [...h.out, ...h.err].join('\n');
    for (const secret of [CLIENT_SECRET, REFRESH, CODE]) expect(printed).not.toContain(secret);
  });

  it.each([
    `${DRIVE_READONLY_SCOPE} https://www.googleapis.com/auth/drive`,
    `${DRIVE_READONLY_SCOPE} https://www.googleapis.com/auth/calendar.readonly`,
    'https://www.googleapis.com/auth/drive.file',
    `${DRIVE_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.readonly`,
  ])('refuses a broader grant and writes nothing: %s', async (scope) => {
    const h = harness(scope);
    const run = runCli(['--drive', '--out', '/tmp/x.json'], h.deps);
    const state = (await h.consentUrl()).searchParams.get('state');
    h.callback(`/oauth2callback?state=${state}&code=${CODE}`);
    await expect(run).resolves.toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('more than drive.readonly');
    expect(h.driveWritten).toEqual([]);
  });

  it('reports a grant without drive.readonly as not granted', async () => {
    const h = harness('');
    const run = runCli(['--drive', '--out', '/tmp/x.json'], h.deps);
    const state = (await h.consentUrl()).searchParams.get('state');
    h.callback(`/oauth2callback?state=${state}&code=${CODE}`);
    await expect(run).resolves.toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('did not grant drive.readonly');
  });

  it('--drive, --gmail and --with-events are separate grant sets and cannot be combined', async () => {
    const h = harness();
    for (const extra of [['--with-events'], ['--gmail'], ['--drive']]) {
      await expect(runCli(['--out', '/tmp/x.json', '--drive', ...extra], h.deps)).resolves.toBe(EXIT_USAGE);
    }
    expect(h.fetchCalls).toEqual([]);
    expect(h.driveWritten).toEqual([]);
  });

  it('the help names --drive and the shared-client revoke', async () => {
    const h = harness();
    await expect(runCli(['--help'], h.deps)).resolves.toBe(0);
    const help = h.out.join('\n');
    expect(help).toContain('--out <new drive token file> --drive');
    expect(help).toContain('QUOKY_DRIVE_TOKEN_FILE');
    expect(help).toContain('revokes every one of these grants');
  });
});

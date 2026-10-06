import { describe, expect, it } from 'vitest';
import { SlackChannelWriter, escapeSlackText, type SlackChannelWriterConfig } from './slack-channel-writer';

// Token-shaped fixtures are built by concatenation (never a literal bot-token pattern in the source).
const BOT_TOKEN = 'xox' + 'b-test-only-not-a-real-token';
const CHANNEL = 'C0123ABCD9';

type Call = { url: string; init?: RequestInit };
type Reply = Response | Error;

function fakeFetch(...replies: Reply[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function writer(fetchImpl: typeof fetch, overrides: Partial<SlackChannelWriterConfig> = {}): SlackChannelWriter {
  return new SlackChannelWriter({
    token: BOT_TOKEN,
    channels: [{ id: CHANNEL, name: 'dev-test' }, { id: 'G0999ZZZZ1' }],
    fetchImpl,
    ...overrides,
  });
}

const posted = (): Response => json(200, { ok: true, channel: CHANNEL, ts: '1700000000.000100' });
const PERMALINK = 'https://example.slack.com/archives/C0123ABCD9/p1700000000000100';

describe('SlackChannelWriter (ADR-0112 D2/D4)', () => {
  it('posts the escaped owner text verbatim to the allowlisted channel id with expansion off, then links it', async () => {
    const fake = fakeFetch(posted(), json(200, { ok: true, permalink: PERMALINK }));
    const outcome = await writer(fake.fetchImpl).post({ channel: '#Dev-Test', text: 'hi <!channel> & @here <https://x|y>' });
    expect(outcome).toEqual({ status: 'SENT', externalRef: `${CHANNEL}:1700000000.000100`, url: PERMALINK });
    expect(fake.calls).toHaveLength(2);
    const post = fake.calls[0]!;
    expect(post.url).toBe('https://slack.com/api/chat.postMessage');
    expect(post.init?.method).toBe('POST');
    expect(post.init?.redirect).toBe('error');
    expect((post.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(JSON.parse(String(post.init?.body))).toEqual({
      channel: CHANNEL,
      text: 'hi &lt;!channel&gt; &amp; @here &lt;https://x|y&gt;',
      mrkdwn: false,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(fake.calls[1]!.url).toBe(`https://slack.com/api/chat.getPermalink?channel=${CHANNEL}&message_ts=1700000000.000100`);
    expect(fake.calls[1]!.init?.method).toBe('GET');
  });

  it('a failed or odd permalink lookup only drops the link; the outcome stays SENT', async () => {
    for (const reply of [new Error('offline'), json(500, {}), json(200, { ok: false }), json(200, { ok: true, permalink: 'http://evil' })]) {
      const fake = fakeFetch(posted(), reply);
      expect(await writer(fake.fetchImpl).post({ channel: CHANNEL, text: 'hi' })).toEqual({
        status: 'SENT', externalRef: `${CHANNEL}:1700000000.000100`,
      });
    }
  });

  it('resolves only allowlisted channels, and refuses anything else before any network call', async () => {
    const fake = fakeFetch();
    const slack = writer(fake.fetchImpl);
    expect(slack.resolveChannel('#dev-test')).toBe(CHANNEL);
    expect(slack.resolveChannel(' dev-test ')).toBe(CHANNEL);
    expect(slack.resolveChannel(CHANNEL)).toBe(CHANNEL);
    expect(slack.resolveChannel('G0999ZZZZ1')).toBe('G0999ZZZZ1');
    for (const channel of ['#general', 'C9999ZZZZ9', 'c0123abcd9', '', '#']) {
      expect(slack.resolveChannel(channel)).toBeUndefined();
      expect(await slack.post({ channel, text: 'hi' })).toEqual({ status: 'NOT_SENT', reason: 'TARGET_NOT_ALLOWED', retryable: false });
    }
    for (const text of ['', ' \n ', 'x'.repeat(4001)]) {
      expect(await slack.post({ channel: CHANNEL, text })).toMatchObject({ status: 'NOT_SENT', reason: 'INVALID_REQUEST' });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('classifies Slack failures: definite API errors NOT_SENT, server/transport/unknown UNCERTAIN; never retries', async () => {
    const cases: Array<[Reply, unknown]> = [
      [json(200, { ok: false, error: 'channel_not_found' }), { status: 'NOT_SENT', reason: 'NOT_FOUND', retryable: false }],
      [json(200, { ok: false, error: 'not_in_channel' }), { status: 'NOT_SENT', reason: 'FORBIDDEN', retryable: false }],
      [json(200, { ok: false, error: 'invalid_auth' }), { status: 'NOT_SENT', reason: 'UNAUTHORIZED', retryable: false }],
      [json(200, { ok: false, error: 'missing_scope' }), { status: 'NOT_SENT', reason: 'INSUFFICIENT_SCOPE', retryable: false }],
      [json(200, { ok: false, error: 'msg_too_long' }), { status: 'NOT_SENT', reason: 'INVALID_REQUEST', retryable: false }],
      [json(200, { ok: false, error: 'ratelimited' }), { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: false }],
      [json(429, {}), { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: false }],
      [json(400, {}), { status: 'NOT_SENT', reason: 'REJECTED', retryable: false }],
      [json(200, { ok: false, error: 'internal_error' }), { status: 'UNCERTAIN', reason: 'SERVER_ERROR' }],
      [json(200, { ok: false, error: 'something_new' }), { status: 'UNCERTAIN', reason: 'UNKNOWN' }],
      [json(200, { ok: false, error: 'constructor' }), { status: 'UNCERTAIN', reason: 'UNKNOWN' }],
      [json(502, {}), { status: 'UNCERTAIN', reason: 'SERVER_ERROR' }],
      [new Error(`socket hang up ${BOT_TOKEN}`), { status: 'UNCERTAIN', reason: 'TRANSPORT' }],
      [new Response('<html>', { status: 200 }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
      [json(200, { ok: true }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
    ];
    for (const [reply, expected] of cases) {
      const fake = fakeFetch(reply);
      const outcome = await writer(fake.fetchImpl).post({ channel: CHANNEL, text: 'hi' });
      expect(outcome).toEqual(expected);
      expect(fake.calls).toHaveLength(1);
      expect(JSON.stringify(outcome)).not.toContain(BOT_TOKEN);
    }
  });

  it('requires a bot token and a valid, non-empty channel allowlist (value-free messages)', () => {
    const { fetchImpl, calls } = fakeFetch();
    const userToken = 'xox' + 'p-user-token-value';
    for (const token of [userToken, '', 'xox' + 'b-']) {
      let caught: unknown;
      try { writer(fetchImpl, { token }); } catch (error) { caught = error; }
      expect((caught as Error).message).toBe('slack writer: a bot token is required');
      expect((caught as Error).message).not.toContain(userToken);
    }
    expect(() => writer(fetchImpl, { channels: [] })).toThrow('non-empty channel allowlist');
    expect(() => writer(fetchImpl, { channels: [{ id: 'general' }] })).toThrow('valid channel id');
    expect(() => writer(fetchImpl, { channels: [{ id: CHANNEL, name: 'Has Space' }] })).toThrow('name is invalid');
    expect(() => writer(fetchImpl, { channels: [{ id: CHANNEL, name: 'a' }, { id: 'C0000AAAA1', name: 'a' }] })).toThrow('two ids');
    expect(calls).toHaveLength(0);
  });

  it('escapeSlackText escapes exactly &, < and >', () => {
    expect(escapeSlackText('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
  });
});

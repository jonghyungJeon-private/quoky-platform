import { describe, expect, it } from 'vitest';
import type { ConnectorWriteTransportGuard } from '@quoky/core';
import type { SlackChannelWriterConfig } from './slack-channel-writer';
import { SlackMessageDeleteWriter } from './slack-message-delete-writer';

// ADR-0112 amendment 1 (S1/S6): the narrow Slack message delete. Token-shaped fixtures are built by concatenation.
const BOT_TOKEN = 'xox' + 'b-test-only-not-a-real-token';
const CHANNEL = 'C0123ABCD9';
const TS = '1700000000.000100';

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

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deleted = (): Response => json(200, { ok: true, channel: CHANNEL, ts: TS });

function writer(fetchImpl: typeof fetch, overrides: Partial<SlackChannelWriterConfig> = {}): SlackMessageDeleteWriter {
  return new SlackMessageDeleteWriter({ token: BOT_TOKEN, channels: [{ id: CHANNEL, name: 'dev-test' }, { id: 'G0999ZZZZ1' }], fetchImpl, ...overrides });
}

const notSent = (reason: string) => ({ status: 'NOT_SENT', reason, retryable: false });

describe('SlackMessageDeleteWriter (ADR-0112 amendment 1 S1/S6)', () => {
  it('sends exactly one POST /api/chat.delete with {channel, ts} and the bot token, never as_user, redirects refused', async () => {
    const fake = fakeFetch(deleted());
    const outcome = await writer(fake.fetchImpl).deleteMessage({ channelId: CHANNEL, ts: TS });
    expect(outcome).toEqual({ status: 'SENT', externalRef: `${CHANNEL}:${TS}` });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe('https://slack.com/api/chat.delete');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.redirect).toBe('error');
    expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ channel: CHANNEL, ts: TS });
    expect('as_user' in body).toBe(false);
  });

  it('allowsChannelId is pure and uses the same allowlist as the post writer; a non-allowlisted or malformed target never reaches the network', async () => {
    const fake = fakeFetch();
    const slack = writer(fake.fetchImpl);
    expect(slack.allowsChannelId(CHANNEL)).toBe(true);
    expect(slack.allowsChannelId('G0999ZZZZ1')).toBe(true);
    // A channel NAME is never a delete target (the receipt holds the id); an id outside the allowlist neither.
    for (const channel of ['dev-test', '#dev-test', 'C9999ZZZZ9', 'c0123abcd9', '']) {
      expect(slack.allowsChannelId(channel)).toBe(false);
      expect(await slack.deleteMessage({ channelId: channel, ts: TS })).toEqual(notSent('TARGET_NOT_ALLOWED'));
    }
    for (const ts of ['', '1700000000', 'abc.def', '1.2.3', `${TS} `]) {
      expect(await slack.deleteMessage({ channelId: CHANNEL, ts })).toEqual(notSent('INVALID_REQUEST'));
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('maps every S6 row: definite API errors NOT_SENT, server / transport / unknown / unreadable UNCERTAIN; never retries; nothing leaks', async () => {
    const cases: Array<[Reply, unknown]> = [
      [json(200, { ok: false, error: 'message_not_found' }), notSent('NOT_FOUND')],
      [json(200, { ok: false, error: 'cant_delete_message' }), notSent('FORBIDDEN')],
      [json(200, { ok: false, error: 'compliance_exports_prevent_deletion' }), notSent('FORBIDDEN')],
      [json(200, { ok: false, error: 'channel_not_found' }), notSent('NOT_FOUND')],
      [json(200, { ok: false, error: 'invalid_channel_id' }), notSent('NOT_FOUND')],
      [json(200, { ok: false, error: 'not_in_channel' }), notSent('FORBIDDEN')],
      [json(200, { ok: false, error: 'is_archived' }), notSent('REJECTED')],
      [json(200, { ok: false, error: 'missing_scope' }), notSent('INSUFFICIENT_SCOPE')],
      [json(200, { ok: false, error: 'invalid_auth' }), notSent('UNAUTHORIZED')],
      [json(200, { ok: false, error: 'token_revoked' }), notSent('UNAUTHORIZED')],
      [json(200, { ok: false, error: 'ratelimited' }), notSent('RATE_LIMITED')],
      [json(429, {}), notSent('RATE_LIMITED')],
      [json(403, {}), notSent('FORBIDDEN')],
      [json(404, {}), notSent('REJECTED')],
      [json(200, { ok: false, error: 'internal_error' }), { status: 'UNCERTAIN', reason: 'SERVER_ERROR' }],
      [json(200, { ok: false, error: 'fatal_error' }), { status: 'UNCERTAIN', reason: 'SERVER_ERROR' }],
      [json(503, {}), { status: 'UNCERTAIN', reason: 'SERVER_ERROR' }],
      [json(200, { ok: false, error: 'something_new' }), { status: 'UNCERTAIN', reason: 'UNKNOWN' }],
      [json(200, { ok: false }), { status: 'UNCERTAIN', reason: 'UNKNOWN' }],
      [new Response('not json', { status: 200 }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
      // A success that does not name the very message asked for is unreadable.
      [json(200, { ok: true }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
      [json(200, { ok: true, channel: CHANNEL, ts: '1700000000.000200' }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
      [new Error('socket hang up'), { status: 'UNCERTAIN', reason: 'TRANSPORT' }],
    ];
    for (const [reply, expected] of cases) {
      const fake = fakeFetch(reply);
      const outcome = await writer(fake.fetchImpl).deleteMessage({ channelId: CHANNEL, ts: TS });
      expect(outcome).toEqual(expected);
      expect(fake.calls).toHaveLength(1);
      expect(JSON.stringify(outcome)).not.toContain(BOT_TOKEN);
    }
  });

  it('UNC-1: the delete runs inside one transport-guard window; a thrown request is classified by it; no retry', async () => {
    const thrown = new TypeError('fetch failed');
    const log = { begun: [] as string[], classified: [] as unknown[], ended: 0 };
    const guard: ConnectorWriteTransportGuard = {
      begin(target) {
        log.begun.push(target.toString());
        return {
          classifyFailure(error) {
            log.classified.push(error);
            return { status: 'NOT_SENT', reason: 'UNAVAILABLE', retryable: false };
          },
          end() {
            log.ended += 1;
          },
        };
      },
    };
    const fake = fakeFetch(thrown);
    expect(await writer(fake.fetchImpl, { transportGuard: guard }).deleteMessage({ channelId: CHANNEL, ts: TS })).toEqual(notSent('UNAVAILABLE'));
    expect(log.begun).toEqual(['https://slack.com/api/chat.delete']);
    expect(log.classified).toEqual([thrown]);
    expect(log.ended).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  it('requires a bot token and a valid allowlist, with the post writer\'s value-free messages', () => {
    const { fetchImpl, calls } = fakeFetch();
    expect(() => writer(fetchImpl, { token: 'xox' + 'p-user-token-value' })).toThrow('slack writer: a bot token is required');
    expect(() => writer(fetchImpl, { channels: [] })).toThrow('non-empty channel allowlist');
    expect(() => writer(fetchImpl, { channels: [{ id: 'general' }] })).toThrow('valid channel id');
    expect(calls).toHaveLength(0);
  });
});

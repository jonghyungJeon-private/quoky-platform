import { describe, expect, it } from 'vitest';
import { CONNECTOR_ITEM_RESPONSE_MAX_BYTES, ConnectorQueryError } from '@quoky/core';
import { SlackConnectorItemTooLargeError, SlackConnectorProvider, flattenSlackMrkdwn } from './index';

/** A6 R2: the Slack `item` named query. Fake fetch only; every request is recorded. */

const TOKEN = 'xoxb-slack-secret-token';
const CH = 'C0123ABCD';
const TS = '1700000100.000200';
const THREAD = '1700000000.000100';

interface Scripted {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

function recorder(...script: Scripted[]): { fetchImpl: typeof fetch; calls: Array<{ url: URL; method?: string; redirect?: string }> } {
  const calls: Array<{ url: URL; method?: string; redirect?: string }> = [];
  const queue = [...script];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), method: init?.method, redirect: init?.redirect });
    const next = queue.shift();
    if (!next) throw new Error('unexpected fake fetch call');
    const status = next.status ?? 200;
    const body = next.raw ?? JSON.stringify(next.body ?? { ok: true, messages: [] });
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers: { 'content-type': 'application/json', ...next.headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const slack = (fetchImpl: typeof fetch) => new SlackConnectorProvider({ token: TOKEN, fetchImpl });
const ok = (messages: unknown[], extra: Record<string, unknown> = {}): Scripted => ({ body: { ok: true, messages, ...extra } });
const msg = (ts: string, text = 'hello', extra: Record<string, unknown> = {}) => ({ type: 'message', user: 'U111', text, ts, ...extra });
const item = (id: string, scope?: string) => ({ query: 'item', params: scope === undefined ? { id } : { id, scope } });
const TOP = `${CH}:${TS}`;
const REPLY = `${CH}:${TS}:${THREAD}`;

async function reason(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorQueryError);
    return (error as ConnectorQueryError).reason;
  }
  throw new Error('expected a rejection');
}

describe('Slack item query: top-level message', () => {
  it('makes exactly one GET conversations.replies with limit=1&inclusive=true, redirect manual', async () => {
    const fake = recorder(ok([msg(TS, 'first line\nsecond', { reply_count: 3 })]));
    const result = await slack(fake.fetchImpl).query(item(TOP));

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.redirect).toBe('manual');
    expect(call.url.origin + call.url.pathname).toBe('https://slack.com/api/conversations.replies');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ channel: CH, ts: TS, limit: '1', inclusive: 'true' });

    const one = result.items[0]!;
    expect(result.items).toHaveLength(1);
    expect(one).toMatchObject({ id: TOP, title: 'first line', itemRef: TOP });
    expect(one).not.toHaveProperty('url');
    expect(one.detail).toMatchObject({ replyCount: 3, partial: false, requests: 1, people: ['U111'] });
    expect(one.detail!.sections).toEqual([{ kind: 'message', author: 'U111', text: 'first line\nsecond', at: '2023-11-14T22:15:00.000Z' }]);
    expect(one.detail!.bytes).toBeGreaterThan(0);
  });

  it('reply_count defaults to 0, a bot author is the bot id, an empty message has the placeholder title', async () => {
    const fake = recorder(ok([{ ts: TS, bot_id: 'B999', text: '' }]));
    const one = (await slack(fake.fetchImpl).query(item(TOP))).items[0]!;
    expect(one.detail!.replyCount).toBe(0);
    expect(one.detail!.sections[0]!.author).toBe('B999');
    expect(one.title).toBe('(내용 없음)');
  });

  it('truncates the title to 120 characters and redacts the token', async () => {
    const fake = recorder(ok([msg(TS, `${TOKEN} ${'x'.repeat(300)}`)]));
    const result = await slack(fake.fetchImpl).query(item(TOP));
    expect(result.items[0]!.title.length).toBe(120);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('messages[0].ts different from ts is NOT_FOUND; so is a tombstone and an empty page', async () => {
    expect(await reason(slack(recorder(ok([msg('1700000100.000999')])).fetchImpl).query(item(TOP)))).toBe('NOT_FOUND');
    expect(await reason(slack(recorder(ok([msg(TS, '', { subtype: 'tombstone' })])).fetchImpl).query(item(TOP)))).toBe('NOT_FOUND');
    expect(await reason(slack(recorder(ok([])).fetchImpl).query(item(TOP)))).toBe('NOT_FOUND');
  });
});

describe('Slack item query: a thread reply', () => {
  const parent = msg(THREAD, 'parent text');
  const reply = msg(TS, 'the reply');
  const query = (messages: unknown[]) => {
    const fake = recorder(ok(messages));
    return { fake, result: slack(fake.fetchImpl).query(item(REPLY)) };
  };

  it('uses ts=threadTs&oldest=ts&latest=ts&inclusive=true&limit=2', async () => {
    const { fake, result } = query([reply]);
    await result;
    expect(fake.calls).toHaveLength(1);
    expect(Object.fromEntries(fake.calls[0]!.url.searchParams)).toEqual({ channel: CH, ts: THREAD, oldest: TS, latest: TS, inclusive: 'true', limit: '2' });
  });

  it('[parent, reply] selects messages[1] and never returns the parent', async () => {
    const { result } = query([parent, reply]);
    const one = (await result).items[0]!;
    expect(one.detail!.sections.map((s) => s.text)).toEqual(['the reply']);
    expect(one.id).toBe(TOP);
    expect(one.itemRef).toBe(REPLY);
    expect(one).not.toHaveProperty('detail.replyCount');
  });

  it('[reply] alone selects messages[0]', async () => {
    const { result } = query([reply]);
    expect((await result).items[0]!.detail!.sections.map((s) => s.text)).toEqual(['the reply']);
  });

  it('[parent, neighbour] and [neighbour] are NOT_FOUND', async () => {
    const neighbour = msg('1700000100.000300', 'other');
    expect(await reason(query([parent, neighbour]).result)).toBe('NOT_FOUND');
    expect(await reason(query([neighbour]).result)).toBe('NOT_FOUND');
    expect(await reason(query([neighbour, reply]).result)).toBe('NOT_FOUND');
    expect(await reason(query([parent]).result)).toBe('NOT_FOUND');
    expect(await reason(query([]).result)).toBe('NOT_FOUND');
  });

  it('a deleted reply is NOT_FOUND', async () => {
    expect(await reason(query([parent, msg(TS, '', { subtype: 'tombstone' })]).result)).toBe('NOT_FOUND');
  });
});

describe('Slack item query: thread scope', () => {
  it('one page of limit=50, never following the cursor; has_more marks partial', async () => {
    const messages = [msg(THREAD, 'parent <@U222> hi'), ...Array.from({ length: 49 }, (_, i) => msg(`17000001${String(i).padStart(2, '0')}.000100`, `r${i}`, { user: 'U333' }))];
    const fake = recorder(ok(messages, { has_more: true, response_metadata: { next_cursor: 'CUR' } }), ok([msg('1.000001')]));
    const result = await slack(fake.fetchImpl).query(item(REPLY, 'thread'));

    expect(fake.calls).toHaveLength(1);
    expect(Object.fromEntries(fake.calls[0]!.url.searchParams)).toEqual({ channel: CH, ts: THREAD, limit: '50' });
    expect(fake.calls[0]!.url.searchParams.has('cursor')).toBe(false);
    const detail = result.items[0]!.detail!;
    expect(detail.sections).toHaveLength(50);
    expect(detail).toMatchObject({ hasMore: true, partial: true, requests: 1 });
    expect(detail.people).toEqual(['U111', 'U222', 'U333']);
  });

  it('keeps at most 50 messages even if Slack returns more', async () => {
    const messages = [msg(THREAD), ...Array.from({ length: 60 }, (_, i) => msg(`17000002${String(i).padStart(2, '0')}.000100`))];
    const result = await slack(recorder(ok(messages)).fetchImpl).query(item(REPLY, 'thread'));
    expect(result.items[0]!.detail!.sections).toHaveLength(50);
    expect(result.items[0]!.detail!.hasMore).toBe(false);
    expect(result.items[0]!.detail!.partial).toBe(false);
  });

  it('a top-level message reads its own thread with ts=ts', async () => {
    const fake = recorder(ok([msg(TS, 'top'), msg('1700000200.000100', 'reply')]));
    const result = await slack(fake.fetchImpl).query(item(TOP, 'thread'));
    expect(fake.calls[0]!.url.searchParams.get('ts')).toBe(TS);
    expect(result.items[0]!.detail!.sections).toHaveLength(2);
  });

  it('messages[0].ts different from threadTs and a tombstone parent are NOT_FOUND', async () => {
    expect(await reason(slack(recorder(ok([msg('1700000000.000999')])).fetchImpl).query(item(REPLY, 'thread')))).toBe('NOT_FOUND');
    expect(await reason(slack(recorder(ok([msg(THREAD, '', { subtype: 'tombstone' })])).fetchImpl).query(item(REPLY, 'thread')))).toBe('NOT_FOUND');
  });
});

describe('Slack item query: errors and transport', () => {
  it.each([
    ['invalid_auth', 'UNAUTHORIZED'],
    ['token_revoked', 'UNAUTHORIZED'],
    ['missing_scope', 'INSUFFICIENT_SCOPE'],
    ['not_allowed_token_type', 'INSUFFICIENT_SCOPE'],
    ['channel_not_found', 'NOT_FOUND'],
    ['thread_not_found', 'NOT_FOUND'],
    ['message_not_found', 'NOT_FOUND'],
    ['not_in_channel', 'FORBIDDEN'],
    ['access_denied', 'FORBIDDEN'],
    ['restricted_action', 'FORBIDDEN'],
    ['ratelimited', 'RATE_LIMITED'],
    ['something_else', 'UNAVAILABLE'],
  ])('ok:false %s maps to %s with one request', async (code, expected) => {
    const fake = recorder({ body: { ok: false, error: code } }, ok([msg(TS)]));
    expect(await reason(slack(fake.fetchImpl).query(item(TOP)))).toBe(expected);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'UNAVAILABLE'],
  ])('HTTP %i maps to %s, no retry', async (status, expected) => {
    const fake = recorder({ status, body: { ok: false, error: TOKEN } }, ok([msg(TS)]));
    const error = await slack(fake.fetchImpl).query(item(TOP)).catch((e: unknown) => e);
    expect((error as ConnectorQueryError).reason).toBe(expected);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([301, 302, 308])('a %i is MOVED and nothing is followed', async (status) => {
    const fake = recorder({ status, headers: { location: 'https://evil.example' } }, ok([msg(TS)]));
    expect(await reason(slack(fake.fetchImpl).query(item(TOP)))).toBe('MOVED');
    expect(fake.calls).toHaveLength(1);
  });

  it('a fetch failure is UNAVAILABLE without the cause', async () => {
    const fetchImpl = (async () => {
      throw new Error(TOKEN);
    }) as typeof fetch;
    const error = await slack(fetchImpl).query(item(TOP)).catch((e: unknown) => e);
    expect((error as ConnectorQueryError).reason).toBe('UNAVAILABLE');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('malformed JSON and a missing messages array are INVALID_RESPONSE', async () => {
    expect(await reason(slack(recorder({ raw: '{nope' }).fetchImpl).query(item(TOP)))).toBe('INVALID_RESPONSE');
    expect(await reason(slack(recorder({ body: { ok: true } }).fetchImpl).query(item(TOP)))).toBe('INVALID_RESPONSE');
  });

  describe('the 1 MiB stream cap', () => {
    const padded = (bytes: number): string => {
      const base = JSON.stringify({ ok: true, messages: [{ ts: TS, text: '' }] });
      return JSON.stringify({ ok: true, messages: [{ ts: TS, text: 'a'.repeat(bytes - Buffer.byteLength(base)) }] });
    };

    it('exactly the cap is read', async () => {
      const raw = padded(CONNECTOR_ITEM_RESPONSE_MAX_BYTES);
      expect(Buffer.byteLength(raw)).toBe(CONNECTOR_ITEM_RESPONSE_MAX_BYTES);
      const result = await slack(recorder({ raw }).fetchImpl).query(item(TOP));
      expect(result.items[0]!.detail!.bytes).toBe(CONNECTOR_ITEM_RESPONSE_MAX_BYTES);
    });

    it('one byte more is a too-large INVALID_RESPONSE', async () => {
      const error = await slack(recorder({ raw: padded(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1) }).fetchImpl).query(item(TOP)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SlackConnectorItemTooLargeError);
      expect((error as SlackConnectorItemTooLargeError).tooLarge).toBe(true);
      expect((error as ConnectorQueryError).reason).toBe('INVALID_RESPONSE');
    });

    it('falls back to arrayBuffer() when there is no body stream', async () => {
      const raw = JSON.stringify({ ok: true, messages: [msg(TS)] });
      const response = { ok: true, status: 200, type: 'basic', body: null, arrayBuffer: async () => new TextEncoder().encode(raw).buffer } as unknown as Response;
      expect((await slack((async () => response) as typeof fetch).query(item(TOP))).items).toHaveLength(1);
      const big = { ok: true, status: 200, type: 'basic', body: null, arrayBuffer: async () => new ArrayBuffer(CONNECTOR_ITEM_RESPONSE_MAX_BYTES + 1) } as unknown as Response;
      expect(await slack((async () => big) as typeof fetch).query(item(TOP)).catch((e: unknown) => e)).toBeInstanceOf(SlackConnectorItemTooLargeError);
    });
  });
});

describe('Slack item query: parameters and extra calls', () => {
  it.each([
    ['C0123ABCD', 'a channel alone'],
    [`D0123ABCD:${TS}`, 'a DM channel'],
    [`${CH}:1700000100`, 'a short ts'],
    [`${CH}:${TS}:x`, 'a bad thread ts'],
    [`${CH}:${TS}:${THREAD}:${TS}`, 'four parts'],
    ['c0123abcd:1700000100.000200', 'lower case'],
  ])('%s (%s) is UNSUPPORTED_QUERY with no request', async (id) => {
    const fake = recorder(ok([msg(TS)]));
    expect(await reason(slack(fake.fetchImpl).query(item(id)))).toBe('UNSUPPORTED_QUERY');
    expect(fake.calls).toHaveLength(0);
  });

  it('an unknown param and an unknown scope are UNSUPPORTED_QUERY with no request', async () => {
    const fake = recorder(ok([msg(TS)]));
    expect(await reason(slack(fake.fetchImpl).query({ query: 'item', params: { id: TOP, cursor: 'x' } }))).toBe('UNSUPPORTED_QUERY');
    expect(await reason(slack(fake.fetchImpl).query(item(TOP, 'channel')))).toBe('UNSUPPORTED_QUERY');
    expect(fake.calls).toHaveLength(0);
  });

  it('never calls users.info, conversations.info or chat.getPermalink', async () => {
    const fake = recorder(ok([msg(TS, '<@U9> <#C9|x>')]), ok([msg(THREAD), msg(TS)]), ok([msg(THREAD), msg(TS)]));
    const provider = slack(fake.fetchImpl);
    await provider.query(item(TOP));
    await provider.query(item(REPLY));
    await provider.query(item(REPLY, 'thread'));
    expect(fake.calls.map((c) => c.url.pathname)).toEqual(Array(3).fill('/api/conversations.replies'));
  });
});

describe('Slack mrkdwn flattening', () => {
  it('flattens specials, mentions, channels and links, then decodes entities', () => {
    const flat = flattenSlackMrkdwn(
      '<!channel> <!here> <!everyone> <!subteam^S123|@team> <@U123> <@U456|bob> <@U123> <#C123|general> <#C999> <https://a.example/x|label> <https://b.example> 1 &lt; 2 &amp;&amp; 3 &gt; 2',
    );
    expect(flat.text).toBe('@channel @here @everyone @team @U123 @U456 @U123 #general #channel label (https://a.example/x) https://b.example 1 < 2 && 3 > 2');
    expect(flat.users).toEqual(['U123', 'U456']);
  });

  it('collapses blank lines and keeps entities that decode into angle brackets inert', () => {
    expect(flattenSlackMrkdwn('a\n\n\n\nb &lt;@U1&gt;').text).toBe('a\n\nb <@U1>');
    expect(flattenSlackMrkdwn('a &lt;@U1&gt;').users).toEqual([]);
  });

  it('item readout: people are authors then mentions in order of first appearance', async () => {
    const fake = recorder(ok([msg(THREAD, 'hi <@U300> and <!here>', { user: 'U200' }), msg(TS, 'ok <@U200>', { user: 'U100' })]));
    const result = await slack(fake.fetchImpl).query(item(REPLY, 'thread'));
    expect(result.items[0]!.detail!.people).toEqual(['U200', 'U300', 'U100']);
    expect(result.items[0]!.detail!.sections[0]!.text).toBe('hi @U300 and @here');
  });
});

describe('Slack search carries itemRef', () => {
  const searchBody = (permalink: string, ts = TS) => ({
    ok: true,
    messages: { matches: [{ ts, text: 'hello', permalink, channel: { id: CH, name: 'eng' } }] },
  });
  const search = (permalink: string, ts?: string) => {
    const fake = recorder({ body: searchBody(permalink, ts) });
    return slack(fake.fetchImpl).query({ query: 'search', params: { text: 'hello' } });
  };

  it('a top-level match is channel:ts', async () => {
    const result = await search(`https://x.slack.com/archives/${CH}/p1700000100000200`);
    expect(result.items[0]!.itemRef).toBe(TOP);
    expect(result.items[0]!.id).toBe(TOP);
  });

  it('a permalink with thread_ts is channel:ts:threadTs', async () => {
    const result = await search(`https://x.slack.com/archives/${CH}/p1700000100000200?thread_ts=${THREAD}&cid=${CH}`);
    expect(result.items[0]!.itemRef).toBe(REPLY);
    expect(result.items[0]!.id).toBe(TOP);
  });

  it('thread_ts equal to ts, or malformed, is not a reply', async () => {
    expect((await search(`https://x.slack.com/archives/${CH}/p1?thread_ts=${TS}&cid=${CH}`)).items[0]!.itemRef).toBe(TOP);
    expect((await search(`https://x.slack.com/archives/${CH}/p1?thread_ts=17000.1`)).items[0]!.itemRef).toBe(TOP);
  });

  it('a ts that is not a Slack timestamp has no itemRef', async () => {
    const result = await search(`https://x.slack.com/archives/${CH}/p1`, '123.4');
    expect(result.items[0]).not.toHaveProperty('itemRef');
  });
});

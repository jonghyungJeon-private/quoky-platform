import { describe, expect, it, vi } from 'vitest';
import type { LogFields, Logger, OwnerNotification } from '@quoky/core';
import { messageContent, messageFields, untrustedText } from '@quoky/core';

/** Offline fake of the discord.js client used only by the adapter-level `deliver` tests below. */
const fakeClient: {
  ready: boolean;
  channels: Map<string, unknown>;
  dm: { send: (o: unknown) => Promise<unknown> };
  sent: unknown[];
  posts: Array<{ url: string; body: unknown }>;
  statuses: number[];
} = {
  posts: [],
  statuses: [],
  ready: true,
  channels: new Map(),
  sent: [],
  dm: { send: async () => undefined },
};

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  class FakeClient {
    channels = {
      fetch: async (id: string) => {
        const c = fakeClient.channels.get(id);
        if (c instanceof Error) throw c;
        return c ?? null;
      },
    };
    users = { fetch: async () => ({ createDM: async () => fakeClient.dm }) };
    on(): this {
      return this;
    }
    isReady(): boolean {
      return fakeClient.ready;
    }
    async login(): Promise<string> {
      return 'fake';
    }
    async destroy(): Promise<void> {}
  }
  // Real REST (retry logic included) over a scripted transport: statuses are consumed per HTTP request.
  class FakeREST extends actual.REST {
    constructor(options: Record<string, unknown> = {}) {
      super({
        ...options,
        makeRequest: (async (url: string, init: { body?: unknown }) => {
          fakeClient.posts.push({ url, body: init.body });
          const status = fakeClient.statuses.shift() ?? 200;
          return new Response(JSON.stringify(status === 200 ? { id: 'm1' } : {}), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        }) as never,
      });
    }
  }
  return { ...actual, Client: FakeClient, REST: FakeREST };
});

import { DiscordPlatformAdapter } from './index';
import {
  classifyDiscordError,
  deliverOwnerNotification,
  type NotificationChannel,
  type NotificationSendOptions,
  type OwnerNotificationDeps,
} from './notification';

const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const OTHER_CHANNEL = '555555555555555555';
const THREAD = '666666666666666666';

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.lines.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.lines.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.lines.push({ level: 'error', message, fields }); }
}

class FakeChannel implements NotificationChannel {
  readonly sent: NotificationSendOptions[] = [];
  constructor(readonly id: string, private readonly failure?: unknown) {}
  async send(options: NotificationSendOptions): Promise<unknown> {
    this.sent.push(options);
    if (this.failure !== undefined) throw this.failure;
    return { id: 'm1' };
  }
}

function apiError(status: number, code?: number): Error {
  return Object.assign(new Error('discord api error'), { name: 'DiscordAPIError', status, ...(code !== undefined ? { code } : {}) });
}

const guildTarget = (over: Partial<OwnerNotification['target']> = {}): OwnerNotification['target'] => ({
  platform: 'discord',
  channelId: CHANNEL,
  userId: OWNER,
  spaceId: GUILD,
  ...over,
});

const note = (over: Partial<OwnerNotification> = {}): OwnerNotification => ({
  correlationId: 'corr-1',
  target: guildTarget(),
  kind: 'TEXT',
  text: '알림 #4: 약 먹기',
  ...over,
});

interface Harness {
  deps: OwnerNotificationDeps;
  logger: RecordingLogger;
  dm: FakeChannel;
  channels: Map<string, FakeChannel | null | Error>;
  fetchOwnerDm: ReturnType<typeof vi.fn>;
}

function harness(over: Partial<OwnerNotificationDeps> = {}, dm = new FakeChannel('dm')): Harness {
  const logger = new RecordingLogger();
  const channels = new Map<string, FakeChannel | null | Error>([
    [CHANNEL, new FakeChannel(CHANNEL)],
    [THREAD, new FakeChannel(THREAD)],
  ]);
  const fetchOwnerDm = vi.fn(async () => dm as NotificationChannel);
  const deps: OwnerNotificationDeps = {
    ownerIds: [OWNER],
    channelIds: [CHANNEL],
    channelDelivery: false,
    fetchChannel: async (id) => {
      const c = channels.get(id) ?? null;
      if (c instanceof Error) throw c;
      return c;
    },
    fetchOwnerDm,
    logger,
    ...over,
  };
  return { deps, logger, dm, channels, fetchOwnerDm };
}

describe('deliverOwnerNotification: pre-send validation', () => {
  it('refuses a platform mismatch with zero sends', async () => {
    const h = harness({ channelDelivery: true });
    const out = await deliverOwnerNotification(note({ target: guildTarget({ platform: 'slack' }) }), h.deps);
    expect(out).toEqual({ status: 'NOT_SENT', reason: 'TARGET_NOT_ADMITTED', retryable: false });
    expect(h.dm.sent).toHaveLength(0);
    expect(h.fetchOwnerDm).not.toHaveBeenCalled();
  });

  it('refuses a non-owner recipient with zero sends', async () => {
    const h = harness({ channelDelivery: true });
    const out = await deliverOwnerNotification(note({ target: guildTarget({ userId: STRANGER }) }), h.deps);
    expect(out).toEqual({ status: 'NOT_SENT', reason: 'NOT_OWNER', retryable: false });
    expect(h.dm.sent).toHaveLength(0);
    expect((h.channels.get(CHANNEL) as FakeChannel).sent).toHaveLength(0);
    expect(h.fetchOwnerDm).not.toHaveBeenCalled();
  });

  it('refuses text over 1,800 characters (never truncates, never sends)', async () => {
    const h = harness();
    const out = await deliverOwnerNotification(note({ text: 'a'.repeat(1_801) }), h.deps);
    expect(out).toEqual({ status: 'NOT_SENT', reason: 'TEXT_TOO_LONG', retryable: false });
    expect(h.dm.sent).toHaveLength(0);
    const ok = await deliverOwnerNotification(note({ text: 'a'.repeat(1_800) }), h.deps);
    expect(ok).toEqual({ status: 'SENT', via: 'dm' });
  });
});

describe('deliverOwnerNotification: target policy', () => {
  it('delivers to the owner DM by default, even for a guild-originated reminder, with no mentions', async () => {
    const h = harness();
    const out = await deliverOwnerNotification(note(), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'dm' });
    expect(h.dm.sent).toEqual([{ content: '알림 #4: 약 먹기', allowedMentions: { parse: [] } }]);
    expect((h.channels.get(CHANNEL) as FakeChannel).sent).toHaveLength(0);
  });

  it('delivers a DM-originated reminder to the owner DM', async () => {
    const h = harness({ channelDelivery: true });
    const target = { platform: 'discord', channelId: 'dm-chan', userId: OWNER };
    const out = await deliverOwnerNotification(note({ target }), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'dm' });
    expect(h.fetchOwnerDm).toHaveBeenCalledWith(OWNER);
  });

  it('opt-in: owner TEXT in an allowlisted channel goes to the channel, mentioning only the owner', async () => {
    const h = harness({ channelDelivery: true });
    const out = await deliverOwnerNotification(note(), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'channel' });
    expect((h.channels.get(CHANNEL) as FakeChannel).sent).toEqual([
      { content: `<@${OWNER}> 알림 #4: 약 먹기`, allowedMentions: { parse: [], users: [OWNER] } },
    ]);
    expect(h.dm.sent).toHaveLength(0);
  });

  it('opt-in: a thread whose parent is allowlisted is sent to the thread', async () => {
    const h = harness({ channelDelivery: true });
    const out = await deliverOwnerNotification(note({ target: guildTarget({ threadId: THREAD }) }), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'channel' });
    expect((h.channels.get(THREAD) as FakeChannel).sent).toHaveLength(1);
    expect((h.channels.get(CHANNEL) as FakeChannel).sent).toHaveLength(0);
  });

  it('opt-in: a channel removed from the allowlist falls back to the DM with no mention', async () => {
    const h = harness({ channelDelivery: true, channelIds: [OTHER_CHANNEL] });
    const out = await deliverOwnerNotification(note(), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'dm' });
    expect(h.dm.sent).toEqual([{ content: '알림 #4: 약 먹기', allowedMentions: { parse: [] } }]);
    expect((h.channels.get(CHANNEL) as FakeChannel).sent).toHaveLength(0);
  });

  it('opt-in: a guild other than the configured one is not admitted (DM fallback)', async () => {
    const h = harness({ channelDelivery: true, guildId: 'other-guild' });
    const out = await deliverOwnerNotification(note(), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'dm' });
  });

  it('opt-in: an unfetchable or unsendable channel falls back to the DM', async () => {
    const h = harness({ channelDelivery: true });
    h.channels.set(CHANNEL, null);
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'SENT', via: 'dm' });
    h.channels.set(CHANNEL, new Error('boom'));
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'SENT', via: 'dm' });
  });

  it('opt-in: a confirmed permission refusal from the channel falls back once to the DM', async () => {
    const h = harness({ channelDelivery: true });
    h.channels.set(CHANNEL, new FakeChannel(CHANNEL, apiError(403, 50013)));
    const out = await deliverOwnerNotification(note(), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'dm' });
    expect(h.dm.sent).toHaveLength(1);
  });

  it('opt-in: an UNCERTAIN channel send never falls back to the DM', async () => {
    const h = harness({ channelDelivery: true });
    h.channels.set(CHANNEL, new FakeChannel(CHANNEL, Object.assign(new Error('x'), { code: 'ECONNRESET' })));
    const out = await deliverOwnerNotification(note(), h.deps);
    expect(out).toEqual({ status: 'UNCERTAIN', reason: 'NETWORK_ERROR' });
    expect(h.dm.sent).toHaveLength(0);
    expect(h.fetchOwnerDm).not.toHaveBeenCalled();
  });

  it('opt-in: a channel 5xx is UNCERTAIN with no DM fallback', async () => {
    const h = harness({ channelDelivery: true });
    h.channels.set(CHANNEL, new FakeChannel(CHANNEL, apiError(503)));
    const out = await deliverOwnerNotification(note(), h.deps);
    expect(out).toEqual({ status: 'UNCERTAIN', reason: 'PLATFORM_ERROR' });
    expect(h.dm.sent).toHaveLength(0);
  });

  it('opt-in: a channel rate-limit is a retryable NOT_SENT with no DM fallback', async () => {
    const h = harness({ channelDelivery: true });
    h.channels.set(CHANNEL, new FakeChannel(CHANNEL, apiError(429)));
    const out = await deliverOwnerNotification(note(), h.deps);
    expect(out).toEqual({ status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true });
    expect(h.dm.sent).toHaveLength(0);
  });

  it('the daily brief is DM-only even with channel delivery enabled in an allowlisted channel', async () => {
    const h = harness({ channelDelivery: true });
    const out = await deliverOwnerNotification(note({ kind: 'BRIEF', text: 'brief text' }), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'dm' });
    expect((h.channels.get(CHANNEL) as FakeChannel).sent).toHaveLength(0);
    expect(h.dm.sent).toEqual([{ content: 'brief text', allowedMentions: { parse: [] } }]);
  });

  it('an OPS_DECISION_RESULT (ADR-0113 D7) is DM-only even with channel delivery enabled in an allowlisted channel', async () => {
    const h = harness({ channelDelivery: true });
    const out = await deliverOwnerNotification(note({ kind: 'OPS_DECISION_RESULT', text: 'decision result' }), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'dm' });
    expect((h.channels.get(CHANNEL) as FakeChannel).sent).toHaveLength(0);
    expect(h.dm.sent).toEqual([{ content: 'decision result', allowedMentions: { parse: [] } }]);
  });

  it('an OPS_DECISION_RESULT over the delivered-text bound is NOT_SENT, never truncated or split', async () => {
    const h = harness();
    const out = await deliverOwnerNotification(note({ kind: 'OPS_DECISION_RESULT', text: 'x'.repeat(5000) }), h.deps);
    expect(out).toMatchObject({ status: 'NOT_SENT', reason: 'TEXT_TOO_LONG', retryable: false });
    expect(h.dm.sent).toHaveLength(0);
  });

  it('never lets @everyone or role/user mentions in the body parse into a ping', async () => {
    const h = harness({ channelDelivery: true });
    await deliverOwnerNotification(note({ text: '@everyone <@&123> <@999>' }), h.deps);
    const sent = (h.channels.get(CHANNEL) as FakeChannel).sent[0];
    expect(sent?.allowedMentions).toEqual({ parse: [], users: [OWNER] });
    const dmH = harness();
    await deliverOwnerNotification(note({ text: '@everyone' }), dmH.deps);
    expect(dmH.dm.sent[0]?.allowedMentions).toEqual({ parse: [] });
  });
});

describe('deliverOwnerNotification: outcome classification', () => {
  it('permission refusal on the DM is NOT_SENT non-retryable', async () => {
    const h = harness({}, new FakeChannel('dm', apiError(403, 50007)));
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'NOT_SENT', reason: 'MISSING_ACCESS', retryable: false });
  });

  it('unknown channel on the DM is NOT_SENT UNKNOWN_TARGET non-retryable', async () => {
    const h = harness({}, new FakeChannel('dm', apiError(404, 10003)));
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'NOT_SENT', reason: 'UNKNOWN_TARGET', retryable: false });
  });

  it('a rate-limit rejection is NOT_SENT retryable', async () => {
    const h = harness({}, new FakeChannel('dm', Object.assign(new Error('rl'), { name: 'RateLimitError' })));
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true });
  });

  it('network error, timeout and 5xx after the send call started are UNCERTAIN', async () => {
    const cases: Array<[unknown, string]> = [
      [new TypeError('fetch failed'), 'NETWORK_ERROR'],
      [Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }), 'NETWORK_ERROR'],
      [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'TIMEOUT'],
      [Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }), 'TIMEOUT'],
      [Object.assign(new Error('x'), { name: 'AbortError' }), 'ABORTED'],
      [apiError(500), 'PLATFORM_ERROR'],
      [apiError(502), 'PLATFORM_ERROR'],
      [new Error('something odd'), 'UNCLASSIFIED'],
      ['a string was thrown', 'UNCLASSIFIED'],
      [apiError(400, 50035), 'UNCLASSIFIED'],
    ];
    for (const [failure, reason] of cases) {
      const h = harness({}, new FakeChannel('dm', failure));
      expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'UNCERTAIN', reason });
    }
  });

  it('a hung send becomes UNCERTAIN TIMEOUT instead of blocking', async () => {
    const hung: NotificationChannel = { send: () => new Promise(() => undefined) };
    const h = harness({ sendTimeoutMs: 10, fetchOwnerDm: async () => hung });
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'UNCERTAIN', reason: 'TIMEOUT' });
  });

  it('a never-resolving DM resolution is NOT_SENT retryable within the resolve deadline, with no send', async () => {
    const h = harness({ resolveTimeoutMs: 10, fetchOwnerDm: () => new Promise(() => undefined) });
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true });
    expect(h.dm.sent).toHaveLength(0);
  });

  it('a never-resolving channel resolution is NOT_SENT retryable with no DM fallback and no send', async () => {
    const h = harness({ channelDelivery: true, resolveTimeoutMs: 10, fetchChannel: () => new Promise(() => undefined) });
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true });
    expect(h.fetchOwnerDm).not.toHaveBeenCalled();
    expect(h.dm.sent).toHaveLength(0);
  });

  it('failing to open the DM is NOT_SENT: refusals non-retryable, transport trouble retryable', async () => {
    const refused = harness({ fetchOwnerDm: async () => { throw apiError(404, 10013); } });
    expect(await deliverOwnerNotification(note(), refused.deps)).toEqual({ status: 'NOT_SENT', reason: 'UNKNOWN_TARGET', retryable: false });
    const down = harness({ fetchOwnerDm: async () => { throw new TypeError('fetch failed'); } });
    expect(await deliverOwnerNotification(note(), down.deps)).toEqual({ status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true });
  });

  it('unknown channel on the target and the DM both failing is non-retryable NOT_SENT', async () => {
    const h = harness({ channelDelivery: true }, new FakeChannel('dm', apiError(404, 10003)));
    h.channels.set(CHANNEL, new FakeChannel(CHANNEL, apiError(404, 10003)));
    expect(await deliverOwnerNotification(note(), h.deps)).toEqual({ status: 'NOT_SENT', reason: 'UNKNOWN_TARGET', retryable: false });
    expect(h.dm.sent).toHaveLength(1);
  });

  it('classifyDiscordError treats unrecognised and 4xx-without-reason errors as UNCERTAIN', () => {
    expect(classifyDiscordError(undefined)).toEqual({ kind: 'UNCERTAIN', reason: 'UNCLASSIFIED' });
    expect(classifyDiscordError(apiError(408))).toEqual({ kind: 'UNCERTAIN', reason: 'TIMEOUT' });
    expect(classifyDiscordError(apiError(401))).toEqual({ kind: 'REFUSED', reason: 'MISSING_ACCESS' });
  });

  it('logs only ids and the outcome, never the body', async () => {
    const h = harness();
    await deliverOwnerNotification(note({ text: 'SECRET BODY TEXT' }), h.deps);
    await deliverOwnerNotification(note({ text: 'SECRET BODY TEXT', target: guildTarget({ userId: STRANGER }) }), h.deps);
    expect(h.logger.lines).toHaveLength(2);
    expect(JSON.stringify(h.logger.lines)).not.toContain('SECRET BODY TEXT');
    expect(h.logger.lines[0]?.fields).toMatchObject({ correlationId: 'corr-1', status: 'SENT', via: 'dm' });
  });
});

describe('DiscordPlatformAdapter.deliver', () => {
  const build = (config: Record<string, unknown> = {}) => {
    const logger = new RecordingLogger();
    const adapter = new DiscordPlatformAdapter(
      { token: 'fake', ownerIds: [OWNER], channelIds: [CHANNEL], ...config },
      logger,
    );
    return { adapter, logger };
  };

  it('is NOT_SENT retryable NOT_CONNECTED before start()', async () => {
    const { adapter } = build();
    expect(await adapter.deliver(note())).toEqual({ status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true });
  });

  it('is NOT_SENT retryable NOT_CONNECTED while the client is not ready', async () => {
    const { adapter } = build();
    await adapter.start();
    fakeClient.ready = false;
    try {
      expect(await adapter.deliver(note())).toEqual({ status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true });
    } finally {
      fakeClient.ready = true;
    }
  });

  it('delivers to the owner DM by default and to the channel only with channelDelivery', async () => {
    fakeClient.dm = { id: 'dm-1' } as never;
    fakeClient.statuses = [];
    fakeClient.posts = [];
    const urls = () => fakeClient.posts.map((p) => p.url);
    fakeClient.channels.set(CHANNEL, { id: CHANNEL, isSendable: () => true });

    const off = build();
    await off.adapter.start();
    expect(await off.adapter.deliver(note())).toEqual({ status: 'SENT', via: 'dm' });
    expect(urls()).toEqual([expect.stringContaining('/channels/dm-1/messages')]);

    fakeClient.posts = [];
    const on = build({ channelDelivery: true });
    await on.adapter.start();
    expect(await on.adapter.deliver(note())).toEqual({ status: 'SENT', via: 'channel' });
    expect(urls()).toEqual([expect.stringContaining(`/channels/${CHANNEL}/messages`)]);

    // A non-sendable channel falls back to the DM.
    fakeClient.posts = [];
    fakeClient.channels.set(CHANNEL, { id: CHANNEL, isSendable: () => false });
    expect(await on.adapter.deliver(note())).toEqual({ status: 'SENT', via: 'dm' });
    // The brief stays in the DM.
    expect(await on.adapter.deliver(note({ kind: 'BRIEF' }))).toEqual({ status: 'SENT', via: 'dm' });
    expect(urls().every((u) => u.includes('/channels/dm-1/messages'))).toBe(true);
  });

  it('never lets the transport retry a send: mocked 500 then 200 is exactly one POST and UNCERTAIN', async () => {
    fakeClient.dm = { id: 'dm-1', send: async () => { throw new Error('discord.js client send must not be used'); } } as never;
    fakeClient.posts = [];
    fakeClient.statuses = [500, 200];
    const { adapter } = build();
    await adapter.start();
    expect(await adapter.deliver(note())).toEqual({ status: 'UNCERTAIN', reason: 'PLATFORM_ERROR' });
    expect(fakeClient.posts).toHaveLength(1);
    expect(fakeClient.posts[0]?.url).toContain('/channels/dm-1/messages');
  });

  it('a successful notification is one POST via the dedicated REST', async () => {
    fakeClient.dm = { id: 'dm-1' } as never;
    fakeClient.posts = [];
    fakeClient.statuses = [200];
    const { adapter } = build();
    await adapter.start();
    expect(await adapter.deliver(note())).toEqual({ status: 'SENT', via: 'dm' });
    expect(fakeClient.posts).toHaveLength(1);
  });
});

describe('deliverOwnerNotification: neutral content (PLT-0 wiring)', () => {
  const body = messageContent('알림: ', untrustedText('@everyone [x](y)'));
  const escaped = '알림: @\u200beveryone \\[x\\](y)';

  it('renders the content with the Discord markup for the owner DM', async () => {
    const h = harness();
    const out = await deliverOwnerNotification(note(messageFields(body)), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'dm' });
    expect(h.dm.sent).toEqual([{ content: escaped, allowedMentions: { parse: [] } }]);
  });

  it('renders the content with the Discord markup for an opted-in channel, mentioning only the owner', async () => {
    const h = harness({ channelDelivery: true });
    const out = await deliverOwnerNotification(note(messageFields(body)), h.deps);
    expect(out).toEqual({ status: 'SENT', via: 'channel' });
    expect((h.channels.get(CHANNEL) as FakeChannel).sent).toEqual([
      { content: `<@${OWNER}> ${escaped}`, allowedMentions: { parse: [], users: [OWNER] } },
    ]);
  });

  it('measures TEXT_TOO_LONG on the rendered length, not the plain text', async () => {
    const h = harness();
    // 1,000 plain characters render as 2,000 (every `*` escaped): over the 1,800-character delivery bound.
    const long = messageFields(messageContent(untrustedText('*'.repeat(1_000))));
    expect(long.text).toHaveLength(1_000);
    expect(await deliverOwnerNotification(note(long), h.deps)).toEqual({ status: 'NOT_SENT', reason: 'TEXT_TOO_LONG', retryable: false });
    // 900 render as exactly 1,800: delivered.
    const fits = messageFields(messageContent(untrustedText('_'.repeat(900))));
    expect(await deliverOwnerNotification(note(fits), h.deps)).toEqual({ status: 'SENT', via: 'dm' });
    expect(h.dm.sent).toEqual([{ content: '\\_'.repeat(900), allowedMentions: { parse: [] } }]);
    const channel = harness({ channelDelivery: true });
    expect(await deliverOwnerNotification(note(long), channel.deps)).toEqual({ status: 'NOT_SENT', reason: 'TEXT_TOO_LONG', retryable: false });
    expect((channel.channels.get(CHANNEL) as FakeChannel).sent).toHaveLength(0);
  });
});

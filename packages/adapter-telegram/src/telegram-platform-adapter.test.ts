import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { conversationRefOf, messageContent, outboundMessage, untrustedText } from '@quoky/core';
import type { InboundMessage, LogFields, Logger } from '@quoky/core';
import { TelegramBotToken } from './bot-token';
import { TELEGRAM_MESSAGE_LIMIT } from './delivery';
import { TelegramPlatformAdapter, TelegramStartupError, TelegramStartupErrorCode } from './telegram-platform-adapter';
import type { TelegramAdapterOptions } from './telegram-platform-adapter';
import {
  FAKE_BOT_ID,
  FAKE_TOKEN,
  FAKE_TOKEN_SECRET,
  FakeTelegram,
  OTHER_TOKEN,
  OWNER_ID,
  STRANGER_ID,
  errorReply,
  flush,
  okReply,
  textUpdate,
  until,
} from './test-support';

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields;
}

function recordingLogger(lines: LogLine[]): Logger {
  return {
    info: (message, fields) => void lines.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => void lines.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => void lines.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
  };
}

function holder(raw: string = FAKE_TOKEN): TelegramBotToken {
  const token = TelegramBotToken.from(raw);
  if (!token) throw new Error('fixture token is not well-formed');
  return token;
}

interface Harness {
  readonly adapter: TelegramPlatformAdapter;
  readonly fake: FakeTelegram;
  readonly logs: LogLine[];
  readonly received: InboundMessage[];
  readonly sleeps: number[];
}

function harness(fake = new FakeTelegram(), options: TelegramAdapterOptions & { token?: TelegramBotToken; ownerIds?: string[] } = {}): Harness {
  const logs: LogLine[] = [];
  const received: InboundMessage[] = [];
  const sleeps: number[] = [];
  const adapter = new TelegramPlatformAdapter(
    { token: options.token ?? holder(), expectedBotId: FAKE_BOT_ID, ownerIds: options.ownerIds ?? [String(OWNER_ID)] },
    recordingLogger(logs),
    {
      fetch: fake.fetch,
      // Backoff waits are recorded and skipped (an aborted signal still resolves at once).
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((resolve) => setImmediate(resolve));
      },
      ...options,
    },
  );
  adapter.onMessage(async (message) => {
    received.push(message);
  });
  return { adapter, fake, logs, received, sleeps };
}

/** A sleep that lasts until the adapter stops (resolves at once when already stopped). */
function untilAborted(_ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

const getUpdatesOffsets = (fake: FakeTelegram): Array<number | undefined> =>
  fake.callsTo('getUpdates').map((call) => call.params.offset as number | undefined);

describe('Telegram startup identity check (ADR-0114 D5) and the 409 probe', () => {
  it('verifies getMe, probes without confirming anything, then polls with allowed_updates=[message]', async () => {
    const h = harness();
    await h.adapter.start();
    await until(() => h.fake.callsTo('getUpdates').length >= 2);
    const [probe, poll] = h.fake.callsTo('getUpdates');
    expect(probe?.params).toEqual({ limit: 1, timeout: 0 });
    expect(poll?.params).toMatchObject({ limit: 100, timeout: 25, allowed_updates: ['message'] });
    expect(poll?.params.offset).toBeUndefined();
    expect(h.adapter.status()).toMatchObject({ identityVerified: true, polling: true, admittedChatCount: 0 });
    await h.adapter.stop();
  });

  it('a token for another bot fails closed before any network call', async () => {
    const h = harness(new FakeTelegram(), { token: holder(OTHER_TOKEN) });
    await expect(h.adapter.start()).rejects.toMatchObject({ code: TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH });
    expect(h.fake.calls).toHaveLength(0);
  });

  it.each([
    ['another bot id', { id: 999_999_999, is_bot: true }],
    ['a user account', { id: Number(FAKE_BOT_ID), is_bot: false }],
    ['a malformed answer', 'nope'],
  ])('getMe returning %s fails closed before polling', async (_label, me) => {
    const h = harness(new FakeTelegram().queue('getMe', okReply(me)));
    const error = await h.adapter.start().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TelegramStartupError);
    expect((error as TelegramStartupError).code).toBe(TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH);
    expect(h.fake.callsTo('getUpdates')).toHaveLength(0);
    expect(h.adapter.status().identityVerified).toBe(false);
  });

  it('a rejected token and a 409 on the probe (a webhook) are typed startup errors', async () => {
    const auth = harness(new FakeTelegram().queue('getMe', errorReply(401)));
    await expect(auth.adapter.start()).rejects.toMatchObject({ code: TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED });
    const conflict = harness(new FakeTelegram().queue('getUpdates:instant', errorReply(409)));
    const error = await conflict.adapter.start().catch((err: unknown) => err);
    expect(error).toMatchObject({ code: TelegramStartupErrorCode.TELEGRAM_POLL_CONFLICT, message: 'TELEGRAM_POLL_CONFLICT' });
    expect(conflict.fake.callsTo('getUpdates')).toHaveLength(1);
  });
});

describe('Telegram startup under a transient outage (CA P2-2): never fails the start, polls only once verified', () => {
  it('an unreachable getMe resolves start(); the identity is retried in the background and polling starts after it matches', async () => {
    const fake = new FakeTelegram()
      .queue('getMe', { throws: new TypeError('fetch failed') }, errorReply(502), { throws: new TypeError('fetch failed') })
      .queue('getUpdates', okReply([textUpdate(70, '안녕')]));
    const h = harness(fake);
    await expect(h.adapter.start()).resolves.toBeUndefined();
    expect(h.adapter.status()).toMatchObject({ identityVerified: false, polling: false });
    await until(() => h.received.length === 1);
    // Three getMe attempts (start, then two background retries with the poll backoff) before the fourth matched.
    expect(fake.callsTo('getMe')).toHaveLength(4);
    expect(h.sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(h.adapter.status()).toMatchObject({ identityVerified: true, polling: true });
    expect(h.logs.some((line) => line.fields?.code === TelegramStartupErrorCode.TELEGRAM_IDENTITY_UNVERIFIABLE)).toBe(true);
    await h.adapter.stop();
  });

  it.each([
    ['another bot', okReply({ id: 999_999_999, is_bot: true }), TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH],
    ['a rejected token', errorReply(401), TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED],
  ])('%s found by the background retry halts the Telegram side only: no poll, status.halted, nothing thrown', async (_label, reply, code) => {
    const fake = new FakeTelegram().queue('getMe', { throws: new TypeError('fetch failed') }, reply);
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.adapter.status().halted !== undefined);
    expect(h.adapter.status()).toMatchObject({ identityVerified: false, polling: false, halted: code });
    expect(fake.callsTo('getUpdates')).toHaveLength(0);
    expect(h.logs.some((line) => line.level === 'error' && line.fields?.code === code)).toBe(true);
    await h.adapter.stop();
  });
});

describe('Telegram long polling: offset, admission drops, backoff', () => {
  it('hands each admitted update over once, advances the offset past it, and confirms it on stop', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([]))
      .queue('getUpdates', okReply([textUpdate(41, '첫 번째'), textUpdate(42, '두 번째')]))
      // Telegram re-sends 42 (an unconfirmed duplicate) next to 43: 42 must not be handled twice.
      .queue('getUpdates', okReply([textUpdate(42, '두 번째'), textUpdate(43, '세 번째')]));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 3 && fake.callsTo('getUpdates').length >= 4);
    expect(h.received.map((message) => message.text)).toEqual(['첫 번째', '두 번째', '세 번째']);
    expect(h.received[0]).toMatchObject({
      id: '410',
      context: { platform: 'telegram', channelId: String(OWNER_ID), userId: String(OWNER_ID), direct: true },
    });
    // probe, then: no offset, no offset (empty batch), 43, 44.
    expect(getUpdatesOffsets(fake)).toEqual([undefined, undefined, undefined, 43, 44]);
    await h.adapter.stop();
    const confirm = fake.callsTo('getUpdates').at(-1);
    expect(confirm?.params).toEqual({ offset: 44, limit: 1, timeout: 0 });
    expect(h.adapter.status()).toMatchObject({ polling: false, admittedChatCount: 1 });
  });

  it('drops non-owner, group, channel, edited and other updates with no handler call, no send and no content log', async () => {
    const edited = { update_id: 54, edited_message: (textUpdate(54, '비밀 편집') as { message: unknown }).message };
    const fake = new FakeTelegram().queue('getUpdates', okReply([
      textUpdate(50, '비밀 낯선이', { from: STRANGER_ID }),
      textUpdate(51, '비밀 그룹', { chatType: 'group', chatId: -100 }),
      textUpdate(52, '비밀 슈퍼그룹', { chatType: 'supergroup', chatId: -1001 }),
      textUpdate(53, '비밀 채널', { chatType: 'channel', chatId: -1002 }),
      edited,
      { update_id: 55, callback_query: { id: 'q', from: { id: OWNER_ID, is_bot: false }, data: '승인' } },
      { update_id: 56, message_reaction: { chat: { id: OWNER_ID, type: 'private' } } },
      textUpdate(57, '비밀 오래됨', { date: Math.floor(Date.now() / 1000) - 3600 }),
    ]));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => getUpdatesOffsets(fake).includes(58));
    await h.adapter.stop();
    expect(h.received).toHaveLength(0);
    expect(fake.callsTo('sendMessage')).toHaveLength(0);
    expect(fake.callsTo('sendChatAction')).toHaveLength(0);
    expect(fake.calls.map((call) => call.method).filter((method) => method !== 'getMe' && method !== 'getUpdates')).toEqual([]);
    expect(h.adapter.status().droppedUpdates).toEqual({ malformed: 0, 'update-type': 3, 'not-private': 3, 'not-owner': 1, forwarded: 0, 'no-text': 0, stale: 1 });
    expect(JSON.stringify(h.logs)).not.toContain('비밀');
    expect(JSON.stringify(h.logs)).not.toContain(String(STRANGER_ID));
  });

  it('backs off on failures (doubling to the cap, honouring retry_after, max wait on 409) and resets after success', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([]))
      .queue('getUpdates', { throws: new TypeError('fetch failed') })
      .queue('getUpdates', errorReply(502))
      .queue('getUpdates', errorReply(429, { retry_after: 30 }))
      .queue('getUpdates', errorReply(409))
      .queue('getUpdates', okReply([]))
      .queue('getUpdates', errorReply(500));
    const h = harness(fake, { backoff: { initialMs: 1000, maxMs: 60_000 } });
    await h.adapter.start();
    await until(() => h.sleeps.length >= 5);
    await h.adapter.stop();
    expect(h.sleeps.slice(0, 5)).toEqual([1000, 2000, 30_000, 60_000, 1000]);
    expect(h.logs.some((line) => line.level === 'error' && line.fields?.code === 'TELEGRAM_POLL_CONFLICT')).toBe(true);
    expect(h.logs.filter((line) => line.message === 'telegram poll failed').map((line) => line.fields?.code)).toEqual([
      'UNAVAILABLE',
      'UNAVAILABLE',
      'RATE_LIMITED',
      'UNAVAILABLE',
    ]);
  });

  it('CA P2-3: three 409s within five minutes stop polling (TELEGRAM_POLL_CONFLICT in status); spread-out 409s do not', async () => {
    let clock = 1_800_000_000_000;
    const fake = new FakeTelegram().queue('getUpdates', errorReply(409), errorReply(409), errorReply(409));
    const h = harness(fake, { nowMs: () => clock });
    await h.adapter.start();
    await until(() => h.adapter.status().halted !== undefined);
    expect(h.adapter.status()).toMatchObject({ polling: false, halted: TelegramStartupErrorCode.TELEGRAM_POLL_CONFLICT });
    expect(fake.callsTo('getUpdates')).toHaveLength(4); // the probe, then three polls
    expect(h.logs.filter((line) => line.level === 'error' && line.fields?.code === 'TELEGRAM_POLL_CONFLICT').length).toBeGreaterThanOrEqual(1);
    await h.adapter.stop();

    const spread = new FakeTelegram().queue('getUpdates', errorReply(409), errorReply(409), errorReply(409), okReply([]));
    const s = harness(spread, {
      nowMs: () => clock,
      sleep: async (ms) => {
        clock += 3 * 60_000; // each backoff wait lets three minutes pass
        s.sleeps.push(ms);
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    await s.adapter.start();
    await until(() => spread.callsTo('getUpdates').length >= 6);
    expect(s.adapter.status()).toMatchObject({ polling: true });
    expect(s.adapter.status().halted).toBeUndefined();
    await s.adapter.stop();
  });

  it('CA P3-1: an oversized poll response halves the batch down to 1, then skips that one update as malformed', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([textUpdate(80, '첫')]));
    const h = harness(fake);
    // After the first batch every poll is "too large" until the limit reaches 1; then one skip, then a normal batch.
    let tooLarge = 7; // 100 → 50 → 25 → 12 → 6 → 3 → 1, then the skip
    const fetchImpl = fake.fetch;
    const adapter = new TelegramPlatformAdapter(
      { token: holder(), expectedBotId: FAKE_BOT_ID, ownerIds: [String(OWNER_ID)] },
      recordingLogger(h.logs),
      {
        fetch: async (input, init) => {
          const params = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          if (String(input).endsWith('/getUpdates') && params.timeout !== 0 && params.offset === 81 && tooLarge > 0) {
            tooLarge -= 1;
            fake.calls.push({ url: String(input), method: 'getUpdates', params, init });
            return new Response('x'.repeat(16), { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } });
          }
          return fetchImpl(input, init);
        },
        sleep: async (ms) => {
          h.sleeps.push(ms);
          await new Promise((resolve) => setImmediate(resolve));
        },
      },
    );
    adapter.onMessage(async (message) => void h.received.push(message));
    await adapter.start();
    await until(() => fake.callsTo('getUpdates').some((call) => call.params.offset === 82));
    const limits = fake.callsTo('getUpdates').filter((call) => call.params.offset === 81).map((call) => call.params.limit);
    expect(limits).toEqual([100, 50, 25, 12, 6, 3, 1]);
    expect(adapter.status().droppedUpdates.malformed).toBe(1);
    expect(fake.callsTo('getUpdates').find((call) => call.params.offset === 82)?.params.limit).toBe(1);
    expect(h.received.map((m) => m.text)).toEqual(['첫']);
    await adapter.stop();
  });

  it('CA P3-6: a rate-limit wait on a send ends at stop() and sends nothing after it', async () => {
    const fake = new FakeTelegram().queue('sendMessage', errorReply(429, { retry_after: 5 }));
    const logs: LogLine[] = [];
    const adapter = new TelegramPlatformAdapter(
      { token: holder(), expectedBotId: FAKE_BOT_ID, ownerIds: [String(OWNER_ID)] },
      recordingLogger(logs),
      { fetch: fake.fetch, sleep: untilAborted },
    );
    await adapter.start();
    const sending = adapter.sendMessage({ context: { platform: 'telegram', channelId: String(OWNER_ID), userId: String(OWNER_ID) }, text: 'hi' });
    await until(() => fake.callsTo('sendMessage').length === 1);
    await adapter.stop();
    await sending;
    // The 429'd send, then nothing: no retry and no notice after stop.
    expect(fake.callsTo('sendMessage').map((call) => call.params.text)).toEqual(['hi']);
  });

  it('CA P3-5: a token rejected while polling stops the Telegram side and shows it in status', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([]), errorReply(401));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.adapter.status().halted !== undefined);
    expect(h.adapter.status()).toMatchObject({ polling: false, halted: TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED });
    expect(h.sleeps).toEqual([]);
    await h.adapter.stop();
  });

  it('a closed identity gate hands nothing over and leaves the offset unadvanced', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([]), okReply([textUpdate(60, '안녕')]));
    const h = harness(fake);
    h.adapter.gateInbound(Promise.resolve(false));
    await h.adapter.start();
    await until(() => !h.adapter.status().polling);
    await flush();
    expect(h.received).toHaveLength(0);
    expect(getUpdatesOffsets(fake)).not.toContain(61);
    await h.adapter.stop();
    expect(fake.callsTo('getUpdates').some((call) => call.params.offset === 61)).toBe(false);
  });
});

/**
 * Telegram's own getUpdates semantics: an offset confirms (deletes) every update below it; the rest are returned until
 * confirmed. `confirmFails` makes every confirming call fail (a process killed before it could confirm).
 */
class TelegramServer {
  pending: Array<Record<string, unknown>> = [];
  confirmFails = false;

  fetch(fallback: FakeTelegram): FakeTelegram['fetch'] {
    return async (input, init) => {
      const method = String(input).slice(String(input).lastIndexOf('/') + 1);
      const params = JSON.parse(String(init.body ?? '{}')) as { offset?: number; timeout?: number; limit?: number };
      if (method !== 'getUpdates' || params.timeout === 0 && params.limit === 1 && params.offset === undefined) return fallback.fetch(input, init);
      fallback.calls.push({ url: String(input), method, params: params as Record<string, unknown>, init });
      if (params.offset !== undefined) {
        if (this.confirmFails) throw new TypeError('fetch failed');
        this.pending = this.pending.filter((update) => (update.update_id as number) >= (params.offset as number));
      }
      if (this.pending.length === 0 && params.timeout !== 0) {
        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }),
        );
      }
      return new Response(JSON.stringify({ ok: true, result: this.pending.slice(0, params.limit ?? 100) }), { status: 200 });
    };
  }
}

describe('Telegram offset persistence (TG-1 review decision 2): a restart never hands a turn over twice', () => {
  function memoryStore() {
    const writes: number[] = [];
    return { writes, store: { load: () => writes.at(-1), save: (offset: number) => void writes.push(offset) } };
  }

  function adapterOn(server: TelegramServer, fake: FakeTelegram, store?: { load(): number | undefined; save(offset: number): void }) {
    const received: InboundMessage[] = [];
    const adapter = new TelegramPlatformAdapter(
      { token: holder(), expectedBotId: FAKE_BOT_ID, ownerIds: [String(OWNER_ID)] },
      recordingLogger([]),
      { fetch: server.fetch(fake), sleep: untilAborted, ...(store ? { offsetStore: store } : {}) },
    );
    adapter.onMessage(async (message) => void received.push(message));
    return { adapter, received };
  }

  it('the persisted offset survives a crash before Telegram confirmed: the restart resumes after the handed-over turns', async () => {
    const server = new TelegramServer();
    server.pending = [textUpdate(41, '첫 번째'), textUpdate(42, '두 번째')];
    // The process dies before Telegram hears offset 43: every confirming call fails, the updates stay pending there.
    server.confirmFails = true;
    const { writes, store } = memoryStore();
    const first = adapterOn(server, new FakeTelegram(), store);
    await first.adapter.start();
    await until(() => first.received.length === 2);
    expect(writes.at(-1)).toBe(43);
    await first.adapter.stop();
    expect(server.pending.map((update) => update.update_id)).toEqual([41, 42]);
    server.confirmFails = false;
    server.pending.push(textUpdate(43, '세 번째'));

    const second = adapterOn(server, new FakeTelegram(), store);
    await second.adapter.start();
    await until(() => second.received.length === 1);
    await flush();
    expect(second.received.map((message) => message.text)).toEqual(['세 번째']);
    await second.adapter.stop();
    expect(writes.at(-1)).toBe(44);
  });

  it('control: without the store the same crash replays both turns', async () => {
    const server = new TelegramServer();
    server.pending = [textUpdate(41, '첫 번째'), textUpdate(42, '두 번째')];
    server.confirmFails = true;
    const first = adapterOn(server, new FakeTelegram());
    await first.adapter.start();
    await until(() => first.received.length === 2);
    await first.adapter.stop();
    server.confirmFails = false;
    const second = adapterOn(server, new FakeTelegram());
    await second.adapter.start();
    await until(() => second.received.length === 2);
    expect(second.received.map((message) => message.text)).toEqual(['첫 번째', '두 번째']);
    await second.adapter.stop();
  });

  it('an unreadable or invalid stored offset is ignored (logged), never a crash', async () => {
    const server = new TelegramServer();
    server.pending = [textUpdate(5, 'x')];
    const broken = adapterOn(server, new FakeTelegram(), { load: () => { throw new Error('corrupt'); }, save: () => undefined });
    await broken.adapter.start();
    await until(() => broken.received.length === 1);
    await broken.adapter.stop();
    const negative = adapterOn(server, new FakeTelegram(), { load: () => -3, save: () => undefined });
    await negative.adapter.start();
    await negative.adapter.stop();
  });
});

describe('Telegram delivery: owner private chats only, plain text, lossless chunks, typing', () => {
  const ctx = { platform: 'telegram', channelId: String(OWNER_ID), userId: String(OWNER_ID), direct: true };

  it('sends plain text (no parse mode, no link preview) and reports the message ids', async () => {
    const h = harness();
    const content = messageContent('결과: ', untrustedText('<b>x</b> *y* @everyone'), ' — ', conversationRefOf(ctx, { direct: '이 DM', channel: '채널' }));
    const receipt = await h.adapter.sendMessage(outboundMessage(ctx, content));
    const [send] = h.fake.callsTo('sendMessage');
    expect(send?.params).toEqual({
      chat_id: String(OWNER_ID),
      text: '결과: <b>x</b> *y* @everyone — 이 DM',
      link_preview_options: { is_disabled: true },
    });
    expect(receipt.platformMessageIds).toEqual(['1001']);
  });

  it('a long reply goes as numbered chunks within 4096 that join back to the text', async () => {
    const h = harness();
    const text = Array.from({ length: 700 }, (_, i) => `${i}: ${'가나다라마바사'.repeat(2)}`).join('\n');
    const receipt = await h.adapter.sendMessage({ context: ctx, text });
    const sent = h.fake.callsTo('sendMessage').map((call) => String(call.params.text));
    expect(sent.length).toBeGreaterThan(1);
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(sent.map((chunk) => chunk.replace(/^\(\d+\/\d+\) /, '')).join('')).toBe(text);
    expect(receipt.platformMessageIds).toHaveLength(sent.length);
  });

  it('a 429 on a send is retried once after the short retry_after; nothing else is retried', async () => {
    const fake = new FakeTelegram().queue('sendMessage', errorReply(429, { retry_after: 2 }));
    const h = harness(fake);
    await h.adapter.sendMessage({ context: ctx, text: 'hi' });
    expect(fake.callsTo('sendMessage')).toHaveLength(2);
    expect(h.sleeps).toEqual([2000]);
    const failing = harness(new FakeTelegram().queue('sendMessage', errorReply(502), errorReply(502)));
    await failing.adapter.sendMessage({ context: ctx, text: 'hi' });
    // The failed send, then the one partial-failure notice; never a resend of the reply.
    expect(failing.fake.callsTo('sendMessage').map((call) => call.params.text)).toEqual(['hi', '답변 일부를 전송하지 못했어요.']);
    expect(failing.logs.find((line) => line.message === 'message delivery failed')?.fields).toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('refuses to send to anything but an owner private chat (a stranger, a group, a thread, another platform)', async () => {
    const h = harness();
    for (const context of [
      { ...ctx, channelId: String(STRANGER_ID) },
      { ...ctx, channelId: '-1001' },
      { ...ctx, threadId: '7' },
      { ...ctx, platform: 'discord' },
    ]) {
      await h.adapter.sendMessage({ context, text: 'x' });
      await h.adapter.sendTyping(context);
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it('typing is sendChatAction and stops at the reply', async () => {
    const h = harness();
    await h.adapter.sendTyping(ctx);
    expect(h.fake.callsTo('sendChatAction')[0]?.params).toEqual({ chat_id: String(OWNER_ID), action: 'typing' });
    await h.adapter.sendMessage({ context: ctx, text: 'done' });
    await h.adapter.stop();
  });

  it('a code-change preview goes as HTML <pre> parts; every other send has no parse mode', async () => {
    const h = harness();
    await h.adapter.sendMessage({
      context: ctx,
      text: 'bounded',
      preview: {
        previewId: 'pv',
        header: '미리보기 <h>',
        footer: '적용은 `적용`',
        files: [],
        canonicalDiff: '+a <b> & c\n',
        attachmentFilename: 'x.diff',
      },
    });
    const sends = h.fake.callsTo('sendMessage').map((call) => call.params);
    expect(sends).toEqual([
      { chat_id: String(OWNER_ID), text: '미리보기 <h>', link_preview_options: { is_disabled: true } },
      {
        chat_id: String(OWNER_ID),
        text: '<pre>+a &lt;b&gt; &amp; c\n</pre>\n적용은 `적용`',
        link_preview_options: { is_disabled: true },
        parse_mode: 'HTML',
      },
    ]);
  });

  it('an oversized preview goes as one complete .diff document', async () => {
    const h = harness();
    const diff = `+${'x'.repeat(5000)}\n`;
    await h.adapter.sendMessage({
      context: ctx,
      text: 'bounded',
      preview: { previewId: 'pv', header: 'h', footer: 'f', files: [], canonicalDiff: diff, attachmentFilename: 'big.diff' },
    });
    const [doc] = h.fake.callsTo('sendDocument');
    expect(doc?.form?.get('chat_id')).toBe(String(OWNER_ID));
    const file = doc?.form?.get('document') as File;
    expect(file.name).toBe('big.diff');
    expect(await file.text()).toBe(diff);
  });
});

describe('Telegram token handling: never in logs, errors, inspect or JSON', () => {
  it('a failing run (transport errors quoting the URL) leaves no token anywhere observable', async () => {
    const leak = new TypeError(`request to https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates failed`);
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([]))
      .queue('getUpdates', { throws: leak }, { throws: leak })
      .queue('sendMessage', { throws: leak }, { throws: leak });
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.sleeps.length >= 2);
    await h.adapter.sendMessage({ context: { platform: 'telegram', channelId: String(OWNER_ID), userId: String(OWNER_ID) }, text: 'x' });
    await h.adapter.stop();
    const background = harness(new FakeTelegram().queue('getMe', { throws: leak }, errorReply(401)));
    await background.adapter.start();
    await until(() => background.adapter.status().halted !== undefined);
    const startError = await harness(new FakeTelegram().queue('getMe', errorReply(401))).adapter.start().catch((err: unknown) => err);
    const observable = [
      JSON.stringify(h.logs),
      JSON.stringify(background.logs),
      inspect(h.adapter, { depth: 6, showHidden: true }),
      JSON.stringify(h.adapter),
      JSON.stringify(h.adapter.status()),
      inspect(startError, { depth: 6 }),
      JSON.stringify(startError),
      String(startError),
    ].join('\n');
    expect(observable).not.toContain(FAKE_TOKEN_SECRET);
    expect(startError).toMatchObject({ code: TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED });
  });
});

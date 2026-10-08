import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, PlatformFeedbackSignal } from '@quoky/core';
import { TelegramBotToken } from './bot-token';
import { feedbackChanges, ratingsOf, telegramMessageKey, toRating } from './reactions';
import { TelegramPlatformAdapter } from './telegram-platform-adapter';
import { FAKE_BOT_ID, FAKE_TOKEN, FakeTelegram, flush, okReply, OWNER_ID, reactionUpdate, STRANGER_ID, textUpdate, until } from './test-support';

const UP = '\u{1F44D}';
const DOWN = '\u{1F44E}';

describe('Telegram reaction helpers (TG-2, ADR-0098 D3)', () => {
  it('maps only 👍/👎 (modifiers ignored) to a rating', () => {
    expect(toRating(UP)).toBe('POSITIVE');
    expect(toRating(`${UP}\u{1F3FD}`)).toBe('POSITIVE');
    expect(toRating(`${DOWN}\u{FE0F}`)).toBe('NEGATIVE');
    for (const other of ['\u{1F525}', '', 'thumbs', null, 1]) expect(toRating(other)).toBeNull();
  });

  it('reads only emoji reaction types, and diffs old against new lists', () => {
    expect([...(ratingsOf([{ type: 'emoji', emoji: UP }, { type: 'custom_emoji', custom_emoji_id: UP }, { type: 'paid' }]) ?? [])]).toEqual(['POSITIVE']);
    expect(ratingsOf('x')).toBeNull();
    expect(feedbackChanges([], [{ type: 'emoji', emoji: UP }])).toEqual([{ rating: 'POSITIVE', action: 'ADDED' }]);
    expect(feedbackChanges([{ type: 'emoji', emoji: UP }], [{ type: 'emoji', emoji: DOWN }])).toEqual([
      { rating: 'POSITIVE', action: 'REMOVED' },
      { rating: 'NEGATIVE', action: 'ADDED' },
    ]);
    expect(feedbackChanges([{ type: 'emoji', emoji: UP }], [{ type: 'emoji', emoji: UP }])).toEqual([]);
    expect(feedbackChanges(undefined, [])).toBeNull();
  });

  it('scopes a message id by its chat (Telegram ids are unique only inside one chat)', () => {
    expect(telegramMessageKey('5550001', '42')).toBe('5550001:42');
  });
});

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const running: TelegramPlatformAdapter[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

function harness(fake: FakeTelegram) {
  const token = TelegramBotToken.from(FAKE_TOKEN);
  if (!token) throw new Error('fixture token');
  const adapter = new TelegramPlatformAdapter({ token, expectedBotId: FAKE_BOT_ID, ownerIds: [String(OWNER_ID)] }, quiet, {
    fetch: fake.fetch,
    startupCallTimeoutMs: 50,
    sleep: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const signals: PlatformFeedbackSignal[] = [];
  adapter.onFeedback(async (signal) => void signals.push(signal));
  adapter.onMessage(async () => undefined);
  running.push(adapter);
  return { adapter, signals };
}

const offsets = (fake: FakeTelegram) => fake.callsTo('getUpdates').map((call) => call.params.offset as number | undefined);

describe('Telegram adapter feedback (TG-2): message_reaction updates reach onFeedback for the owner only', () => {
  it('asks for message_reaction updates explicitly (they are not in Telegram’s default set)', async () => {
    const fake = new FakeTelegram();
    const { adapter } = harness(fake);
    await adapter.start();
    await until(() => fake.callsTo('getUpdates').length >= 2);
    expect(fake.callsTo('getUpdates')[1]?.params.allowed_updates).toEqual(['message', 'message_reaction']);
  });

  it('the owner’s 👍 then switch to 👎 on a bot reply are signals keyed like the reply’s receipt; nothing is sent back', async () => {
    const fake = new FakeTelegram().queue(
      'getUpdates',
      okReply([reactionUpdate(200, { messageId: 1001 })]),
      okReply([reactionUpdate(201, { messageId: 1001, oldEmoji: [UP], newEmoji: [DOWN] })]),
    );
    const { adapter, signals } = harness(fake);
    await adapter.start();
    await until(() => signals.length === 3);
    expect(signals.map((signal) => [signal.rating, signal.action])).toEqual([
      ['POSITIVE', 'ADDED'],
      ['POSITIVE', 'REMOVED'],
      ['NEGATIVE', 'ADDED'],
    ]);
    expect(signals[0]).toMatchObject({
      platform: 'telegram',
      targetPlatformMessageId: `${OWNER_ID}:1001`,
      context: { platform: 'telegram', channelId: String(OWNER_ID), userId: String(OWNER_ID), direct: true },
    });
    // The same key the adapter reports for a reply it posted (Core links the reaction to that turn only).
    const receipt = await adapter.sendMessage({ context: { platform: 'telegram', channelId: String(OWNER_ID), userId: String(OWNER_ID) }, text: 'hi' });
    expect(receipt.platformMessageIds).toEqual([`${OWNER_ID}:1001`]);
    expect(fake.callsTo('sendMessage')).toHaveLength(1);
    await until(() => offsets(fake).includes(202));
  });

  it('a reaction on the owner’s own message is dropped as not-feedback', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([textUpdate(210, '안녕')]), okReply([reactionUpdate(211, { messageId: 2100 })]));
    const { adapter, signals } = harness(fake);
    await adapter.start();
    await until(() => offsets(fake).includes(212));
    await flush();
    expect(signals).toEqual([]);
    expect(adapter.status().droppedUpdates['not-feedback']).toBe(1);
  });

  it('a stranger, a group, an anonymous reaction or another emoji is dropped silently: no signal, no send', async () => {
    const fake = new FakeTelegram().queue(
      'getUpdates',
      okReply([
        reactionUpdate(220, { from: STRANGER_ID }),
        reactionUpdate(221, { chatType: 'group', chatId: -100 }),
        reactionUpdate(222, { from: null, chatId: OWNER_ID }),
        reactionUpdate(223, { newEmoji: ['\u{1F525}'] }),
      ]),
    );
    const { adapter, signals } = harness(fake);
    await adapter.start();
    await until(() => offsets(fake).includes(224));
    await flush();
    expect(signals).toEqual([]);
    expect(fake.calls.map((call) => call.method).filter((method) => method !== 'getMe' && method !== 'getUpdates')).toEqual([]);
    expect(adapter.status().droppedUpdates).toMatchObject({ 'not-owner': 2, 'not-private': 1, 'not-feedback': 1 });
  });

  it('no signal while the identity gate is closed', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([reactionUpdate(230)]));
    const { adapter, signals } = harness(fake);
    adapter.gateInbound(Promise.resolve(false));
    await adapter.start();
    await until(() => fake.callsTo('getUpdates').length >= 2);
    await flush();
    expect(signals).toEqual([]);
  });
});

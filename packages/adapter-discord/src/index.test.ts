import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage, LogFields, Logger, OutboundDeliveryReceipt, PlatformFeedbackSignal } from '@quoky/core';

/** Offline fake of the discord.js gateway client: records construction options and listeners, never connects. */
const fakeClients: Array<{
  options: { intents: number[]; partials?: number[] };
  listeners: Map<string, (...args: unknown[]) => void>;
  loggedIn: boolean;
}> = [];
/** Channels the fake client can fetch (ADR-0098 receipt tests); every fetch is counted. */
const fakeChannels = new Map<string, unknown>();
const channelFetches: string[] = [];
const BOT_USER_ID = '888888888888888888';

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  class FakeClient {
    private readonly record: (typeof fakeClients)[number];
    constructor(options: { intents: number[]; partials?: number[] }) {
      this.record = { options, listeners: new Map(), loggedIn: false };
      fakeClients.push(this.record);
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.record.listeners.set(event, listener);
      return this;
    }
    readonly user = { id: BOT_USER_ID };
    readonly channels = {
      fetch: async (id: string) => {
        channelFetches.push(id);
        return fakeChannels.get(id) ?? null;
      },
    };
    async login(): Promise<string> {
      this.record.loggedIn = true;
      return 'fake';
    }
    async destroy(): Promise<void> {}
  }
  return { ...actual, Client: FakeClient };
});

import { Events, GatewayIntentBits, Partials } from 'discord.js';
import { DiscordPlatformAdapter } from './index';
import type { DiscordConfig } from './index';

const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';
const GUILD = '333333333333333333';
const ALLOWED_CHANNEL = '444444444444444444';
const OTHER_CHANNEL = '555555555555555555';
const THREAD = '666666666666666666';
const DM_CHANNEL = '777777777777777777';

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.lines.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.lines.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.lines.push({ level: 'error', message, fields }); }
}

interface FakeMessageInit {
  authorId?: string;
  bot?: boolean;
  guildId?: string | null;
  channelId?: string;
  thread?: { parentId: string | null };
}

/** Minimal structural stand-in for a discord.js Message (only what the adapter reads). */
function fakeMessage(init: FakeMessageInit = {}) {
  const channelId = init.channelId ?? ALLOWED_CHANNEL;
  return {
    id: 'msg-1',
    content: 'hello quoky',
    author: { id: init.authorId ?? OWNER, bot: init.bot ?? false },
    guildId: init.guildId === undefined ? GUILD : init.guildId,
    channelId,
    channel: {
      isThread: () => init.thread !== undefined,
      parentId: init.thread?.parentId ?? null,
    },
  };
}

/** Builds an adapter, drives a message through the REAL registered MessageCreate listener. */
async function harness(config: Partial<DiscordConfig> = {}) {
  const logger = new RecordingLogger();
  const adapter = new DiscordPlatformAdapter(
    { token: 'fake-token', ownerIds: [OWNER], channelIds: [ALLOWED_CHANNEL], ...config },
    logger,
  );
  const handled: InboundMessage[] = [];
  adapter.onMessage(async (message) => { handled.push(message); });
  await adapter.start();
  const client = fakeClients.at(-1)!;
  const listener = client.listeners.get(Events.MessageCreate)!;
  const deliver = async (message: ReturnType<typeof fakeMessage>): Promise<void> => {
    listener(message);
    // handleMessageCreate is async; let its microtasks settle.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { adapter, handled, deliver, logger, client };
}

beforeEach(() => {
  fakeClients.length = 0;
  fakeChannels.clear();
  channelFetches.length = 0;
});

describe('DiscordPlatformAdapter — gateway configuration (ADR-0091)', () => {
  it('enables the DM intent and the Channel partial so owner DMs arrive', async () => {
    const { client } = await harness();
    expect(client.loggedIn).toBe(true);
    expect(client.options.intents).toEqual(expect.arrayContaining([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ]));
    expect(client.options.partials).toContain(Partials.Channel);
  });

  it('requests the non-privileged reaction intents and the Message/Reaction/User partials (ADR-0098 D3)', async () => {
    const { client } = await harness();
    expect(client.options.intents).toEqual(expect.arrayContaining([
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ]));
    expect(client.options.intents).not.toContain(GatewayIntentBits.GuildMembers);
    expect(client.options.intents).not.toContain(GatewayIntentBits.GuildPresences);
    expect(client.options.partials).toEqual(expect.arrayContaining([
      Partials.Channel, Partials.Message, Partials.Reaction, Partials.User,
    ]));
    expect(client.listeners.has(Events.MessageReactionAdd)).toBe(true);
    expect(client.listeners.has(Events.MessageReactionRemove)).toBe(true);
    expect(client.listeners.has(Events.MessageCreate)).toBe(true);
  });
});

interface FakeReactionInit {
  emoji?: string;
  customEmojiId?: string;
  userId?: string;
  authorId?: string | null;
  partial?: boolean;
  guildId?: string | null;
  channelId?: string;
  thread?: { parentId: string | null };
}

/** Minimal stand-ins for a discord.js MessageReaction + User; `fetch` on either is counted (must stay 0). */
function fakeReaction(init: FakeReactionInit = {}, fetches: string[] = []) {
  const channelId = init.channelId ?? ALLOWED_CHANNEL;
  const reaction = {
    partial: false,
    emoji: { id: init.customEmojiId ?? null, name: init.emoji ?? '👍' },
    fetch: async () => { fetches.push('reaction'); return reaction; },
    message: {
      id: 'bot-reply-1',
      partial: init.partial ?? false,
      author: init.authorId === null ? null : { id: init.authorId ?? BOT_USER_ID },
      guildId: init.guildId === undefined ? GUILD : init.guildId,
      channelId,
      channel: { isThread: () => init.thread !== undefined, parentId: init.thread?.parentId ?? null },
      content: 'secret reply text',
      fetch: async () => { fetches.push('message'); throw new Error('fetch must not run'); },
    },
  };
  const user = { id: init.userId ?? OWNER, fetch: async () => { fetches.push('user'); return user; } };
  return { reaction, user };
}

async function reactionHarness(config: Partial<DiscordConfig> = {}) {
  const base = await harness(config);
  const signals: PlatformFeedbackSignal[] = [];
  base.adapter.onFeedback(async (signal) => { signals.push(signal); });
  const fire = async (event: 'add' | 'remove', init: FakeReactionInit = {}, fetches: string[] = []) => {
    const { reaction, user } = fakeReaction(init, fetches);
    base.client.listeners.get(event === 'add' ? Events.MessageReactionAdd : Events.MessageReactionRemove)!(reaction, user);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...base, signals, fire };
}

describe('DiscordPlatformAdapter — reaction feedback (ADR-0098 D3)', () => {
  it('emits POSITIVE/ADDED for an owner 👍 on a bot reply in an allowlisted channel', async () => {
    const { signals, fire, handled } = await reactionHarness();
    await fire('add');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      platform: 'discord',
      targetPlatformMessageId: 'bot-reply-1',
      rating: 'POSITIVE',
      action: 'ADDED',
      context: { platform: 'discord', channelId: ALLOWED_CHANNEL, userId: OWNER, spaceId: GUILD },
    });
    expect(typeof signals[0]!.occurredAt).toBe('string');
    expect(JSON.stringify(signals[0])).not.toContain('secret reply text');
    expect(handled).toHaveLength(0);
  });

  it('maps a skin-toned 👎🏽 to NEGATIVE and a removal to REMOVED', async () => {
    const { signals, fire } = await reactionHarness();
    await fire('add', { emoji: '👎🏽' });
    await fire('remove', { emoji: '👎🏽' });
    expect(signals.map((s) => [s.rating, s.action])).toEqual([['NEGATIVE', 'ADDED'], ['NEGATIVE', 'REMOVED']]);
  });

  it('ignores any other emoji, including a custom emoji, silently', async () => {
    const { signals, fire, logger } = await reactionHarness();
    await fire('add', { emoji: '🎉' });
    await fire('add', { emoji: '👍', customEmojiId: '999999999999999999' });
    expect(signals).toHaveLength(0);
    expect(logger.lines).toEqual([]);
  });

  it.each([
    ['a non-owner reactor', { userId: STRANGER }],
    ['a non-owner reactor in a DM', { userId: STRANGER, guildId: null, channelId: DM_CHANNEL }],
    ['a message not authored by the bot', { authorId: OWNER }],
    ['an uncached (partial) target with unknown author', { partial: true, authorId: null }],
    ['a non-allowlisted channel', { channelId: OTHER_CHANNEL }],
    ['a thread under a non-allowlisted parent', { channelId: THREAD, thread: { parentId: OTHER_CHANNEL } }],
    ['the bot reacting to its own reply', { userId: BOT_USER_ID }],
  ] as Array<[string, FakeReactionInit]>)('drops %s before any fetch or logging', async (_label, init) => {
    const fetches: string[] = [];
    const { signals, fire, logger } = await reactionHarness();
    await fire('add', init, fetches);
    await fire('remove', init, fetches);
    expect(signals).toHaveLength(0);
    expect(fetches).toEqual([]);
    expect(channelFetches).toEqual([]);
    expect(logger.lines).toEqual([]);
  });

  it('admits the owner in a DM and in a thread under an allowlisted parent without fetching anything', async () => {
    const fetches: string[] = [];
    const { signals, fire } = await reactionHarness();
    await fire('add', { guildId: null, channelId: DM_CHANNEL }, fetches);
    await fire('add', { channelId: THREAD, thread: { parentId: ALLOWED_CHANNEL } }, fetches);
    expect(signals.map((s) => s.context)).toEqual([
      { platform: 'discord', channelId: DM_CHANNEL, userId: OWNER },
      { platform: 'discord', channelId: ALLOWED_CHANNEL, userId: OWNER, spaceId: GUILD, threadId: THREAD },
    ]);
    expect(fetches).toEqual([]);
    expect(channelFetches).toEqual([]);
  });

  it('applies the configured guild filter to reactions', async () => {
    const { signals, fire } = await reactionHarness({ guildId: '999999999999999999' });
    await fire('add');
    expect(signals).toHaveLength(0);
  });

  it('a failing feedback handler is logged without ids or content and never throws', async () => {
    const base = await harness();
    base.adapter.onFeedback(async () => { throw new Error('store down 111111111111111111'); });
    const { reaction, user } = fakeReaction();
    base.client.listeners.get(Events.MessageReactionAdd)!(reaction, user);
    await new Promise((resolve) => setImmediate(resolve));
    expect(base.logger.lines).toHaveLength(1);
    const serialized = JSON.stringify(base.logger.lines);
    expect(serialized).not.toContain(OWNER);
    expect(serialized).not.toContain('bot-reply-1');
    expect(serialized).not.toContain('secret reply text');
  });

  it('with no feedback handler registered, an admitted reaction is a no-op', async () => {
    const { client, logger } = await harness();
    const { reaction, user } = fakeReaction();
    client.listeners.get(Events.MessageReactionAdd)!(reaction, user);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.lines).toEqual([]);
  });
});

/** A sendable fake channel whose `send` returns sequential message ids; `failAt` makes that call throw. */
function sendableChannel(id: string, failAt?: number) {
  const sent: unknown[] = [];
  let calls = 0;
  const channel = {
    id,
    isSendable: () => true,
    isTextBased: () => true,
    async send(payload: unknown) {
      calls += 1;
      if (calls === failAt) throw new Error('send failed');
      sent.push(payload);
      return { id: `sent-${calls}` };
    },
  };
  fakeChannels.set(id, channel);
  return { channel, sent };
}

describe('DiscordPlatformAdapter — delivery receipt (ADR-0098 D3)', () => {
  it('returns the id of every chunk of a multi-chunk reply, in order', async () => {
    const { adapter } = await harness();
    const { sent } = sendableChannel(ALLOWED_CHANNEL);
    const text = Array.from({ length: 3 }, (_, i) => `${String(i).repeat(1800)}`).join('\n\n');
    const receipt = (await adapter.sendMessage({
      context: { platform: 'discord', channelId: ALLOWED_CHANNEL, userId: OWNER },
      text,
    })) as OutboundDeliveryReceipt;
    expect(sent.length).toBeGreaterThan(1);
    expect(receipt.platformMessageIds).toEqual(sent.map((_, i) => `sent-${i + 1}`));
  });

  it('returns a single id for a short reply and targets the thread when present', async () => {
    const { adapter } = await harness();
    sendableChannel(THREAD);
    const receipt = await adapter.sendMessage({
      context: { platform: 'discord', channelId: ALLOWED_CHANNEL, threadId: THREAD, userId: OWNER },
      text: '짧은 답변',
    });
    expect(receipt).toEqual({ platformMessageIds: ['sent-1'] });
  });

  it('keeps the ids that did arrive, plus the partial-failure notice, when a later chunk fails', async () => {
    const { adapter } = await harness();
    sendableChannel(ALLOWED_CHANNEL, 2);
    const text = Array.from({ length: 3 }, (_, i) => `${String(i).repeat(1800)}`).join('\n\n');
    const receipt = await adapter.sendMessage({
      context: { platform: 'discord', channelId: ALLOWED_CHANNEL, userId: OWNER },
      text,
    });
    expect(receipt).toEqual({ platformMessageIds: ['sent-1', 'sent-3'] });
  });

  it('returns an empty receipt when the channel is not sendable', async () => {
    const { adapter } = await harness();
    const receipt = await adapter.sendMessage({
      context: { platform: 'discord', channelId: OTHER_CHANNEL, userId: OWNER },
      text: 'hello',
    });
    expect(receipt).toEqual({ platformMessageIds: [] });
  });
});

describe('DiscordPlatformAdapter — owner + channel gate (ADR-0091)', () => {
  it('handles an owner message in an allowlisted channel', async () => {
    const { handled, deliver } = await harness();
    await deliver(fakeMessage());
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      text: 'hello quoky',
      context: { platform: 'discord', channelId: ALLOWED_CHANNEL, userId: OWNER, spaceId: GUILD },
    });
  });

  it('silently ignores a non-owner in an allowlisted channel (handler never called, no log)', async () => {
    const { handled, deliver, logger } = await harness();
    await deliver(fakeMessage({ authorId: STRANGER }));
    expect(handled).toHaveLength(0);
    expect(logger.lines).toEqual([]);
  });

  it('ignores an owner message in a channel that is not allowlisted', async () => {
    const { handled, deliver, logger } = await harness();
    await deliver(fakeMessage({ channelId: OTHER_CHANNEL }));
    expect(handled).toHaveLength(0);
    expect(logger.lines).toEqual([]);
  });

  it('handles an owner direct message (guildId null)', async () => {
    const { handled, deliver } = await harness();
    await deliver(fakeMessage({ guildId: null, channelId: DM_CHANNEL }));
    expect(handled).toHaveLength(1);
    expect(handled[0]!.context).toMatchObject({ channelId: DM_CHANNEL, userId: OWNER });
    expect(handled[0]!.context.spaceId).toBeUndefined();
  });

  it('ignores a non-owner direct message', async () => {
    const { handled, deliver, logger } = await harness();
    await deliver(fakeMessage({ authorId: STRANGER, guildId: null, channelId: DM_CHANNEL }));
    expect(handled).toHaveLength(0);
    expect(logger.lines).toEqual([]);
  });

  it('with an empty channel list admits owner DMs only', async () => {
    const { handled, deliver } = await harness({ channelIds: [] });
    await deliver(fakeMessage());
    expect(handled).toHaveLength(0);
    await deliver(fakeMessage({ guildId: null, channelId: DM_CHANNEL }));
    expect(handled).toHaveLength(1);
  });

  it('with no channel list at all admits owner DMs only', async () => {
    const { handled, deliver } = await harness({ channelIds: undefined });
    await deliver(fakeMessage());
    expect(handled).toHaveLength(0);
    await deliver(fakeMessage({ guildId: null, channelId: DM_CHANNEL }));
    expect(handled).toHaveLength(1);
  });

  it('fails closed with an empty owner list (nobody admitted, not even DMs)', async () => {
    const { handled, deliver } = await harness({ ownerIds: [] });
    await deliver(fakeMessage());
    await deliver(fakeMessage({ guildId: null, channelId: DM_CHANNEL }));
    expect(handled).toHaveLength(0);
  });

  it('admits an owner message in a thread whose parent channel is allowlisted', async () => {
    const { handled, deliver } = await harness();
    await deliver(fakeMessage({ channelId: THREAD, thread: { parentId: ALLOWED_CHANNEL } }));
    expect(handled).toHaveLength(1);
    expect(handled[0]!.context).toMatchObject({ channelId: ALLOWED_CHANNEL, threadId: THREAD });
  });

  it('admits an owner message in a thread whose own id is allowlisted', async () => {
    const { handled, deliver } = await harness({ channelIds: [THREAD] });
    await deliver(fakeMessage({ channelId: THREAD, thread: { parentId: OTHER_CHANNEL } }));
    expect(handled).toHaveLength(1);
  });

  it('ignores an owner message in a thread under a non-allowlisted parent', async () => {
    const { handled, deliver } = await harness();
    await deliver(fakeMessage({ channelId: THREAD, thread: { parentId: OTHER_CHANNEL } }));
    expect(handled).toHaveLength(0);
  });

  it('ignores a thread with no parent unless its own id is allowlisted', async () => {
    const { handled, deliver } = await harness();
    await deliver(fakeMessage({ channelId: THREAD, thread: { parentId: null } }));
    expect(handled).toHaveLength(0);
  });

  it('still drops bot-authored messages, even from an owner id', async () => {
    const { handled, deliver } = await harness();
    await deliver(fakeMessage({ bot: true }));
    expect(handled).toHaveLength(0);
  });

  it('still applies the guild filter to guild messages', async () => {
    const { handled, deliver } = await harness({ guildId: GUILD });
    await deliver(fakeMessage({ guildId: '999999999999999999' }));
    expect(handled).toHaveLength(0);
    await deliver(fakeMessage());
    expect(handled).toHaveLength(1);
  });

  it('does not require a mention: any owner message in an admitted location is a turn', async () => {
    const { handled, deliver } = await harness();
    await deliver(fakeMessage());
    await deliver(fakeMessage());
    expect(handled).toHaveLength(2);
  });
});

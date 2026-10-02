import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage, LogFields, Logger } from '@quoky/core';

/** Offline fake of the discord.js gateway client: records construction options and listeners, never connects. */
const fakeClients: Array<{
  options: { intents: number[]; partials?: number[] };
  listeners: Map<string, (...args: unknown[]) => void>;
  loggedIn: boolean;
}> = [];

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

beforeEach(() => { fakeClients.length = 0; });

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

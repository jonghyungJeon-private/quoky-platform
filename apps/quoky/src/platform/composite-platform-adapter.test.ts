import { describe, expect, it } from 'vitest';
import type {
  ConversationContext,
  InboundMessage,
  InboundMessageHandler,
  Logger,
  OutboundMessage,
  OwnerNotification,
  PlatformAdapter,
} from '@quoky/core';
import { DiscordPlatformAdapter } from '@quoky/adapter-discord';
import { TelegramBotToken, TelegramPlatformAdapter } from '@quoky/adapter-telegram';
import { platformNotificationSink } from '../features/reminders.providers';
import { applyInboundGate, verifyStartupIdentity } from '../ops/startup-identity-check';
import { CompositePlatformAdapter } from './composite-platform-adapter';
import { composePlatformAdapter, telegramOwnerIdentityLinks } from './platform-composition';
import type { TelegramConfig } from '../telegram/telegram-config';

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeAdapter implements PlatformAdapter {
  readonly sent: OutboundMessage[] = [];
  readonly typing: ConversationContext[] = [];
  readonly events: string[] = [];
  handler?: InboundMessageHandler;
  gate?: Promise<boolean>;
  failStart = false;

  constructor(readonly platform: string, private readonly log: string[]) {}

  async start(): Promise<void> {
    this.log.push(`start:${this.platform}`);
    if (this.failStart) throw Object.assign(new Error('TELEGRAM_IDENTITY_MISMATCH'), { code: 'TELEGRAM_IDENTITY_MISMATCH' });
  }
  async stop(): Promise<void> {
    this.log.push(`stop:${this.platform}`);
  }
  onMessage(handler: InboundMessageHandler): void {
    this.handler = handler;
  }
  onApprovalDecision(): void {}
  async sendMessage(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
  async sendTyping(context: ConversationContext): Promise<void> {
    this.typing.push(context);
  }
  async requestApproval(): Promise<void> {}
}

class FakeDiscord extends FakeAdapter {
  readonly notifications: OwnerNotification[] = [];
  gateInbound(gate: Promise<boolean>): void {
    this.gate = gate;
  }
  async readConnectedIdentity() {
    return { botUserId: '900000000000000001', guildIds: [], channels: [], unreachableChannelIds: [] };
  }
  async deliver(notification: OwnerNotification) {
    this.notifications.push(notification);
    return { status: 'SENT' as const, via: 'DM' as const };
  }
}

const discordCtx: ConversationContext = { platform: 'discord', channelId: '1', userId: '2' };
const telegramCtx: ConversationContext = { platform: 'telegram', channelId: '5550001', userId: '5550001', direct: true };

function composite() {
  const log: string[] = [];
  const discord = new FakeDiscord('discord', log);
  const telegram = new FakeAdapter('telegram', log);
  return { log, discord, telegram, adapter: new CompositePlatformAdapter(discord, [telegram], silent) };
}

describe('CompositePlatformAdapter (ADR-0114 D6): one contract over Discord and Telegram', () => {
  it('routes outbound by the conversation platform and refuses an uncomposed platform (nothing sent)', async () => {
    const { adapter, discord, telegram } = composite();
    await adapter.sendMessage({ context: discordCtx, text: 'd' });
    await adapter.sendMessage({ context: telegramCtx, text: 't' });
    await adapter.sendTyping(telegramCtx);
    await expect(adapter.sendMessage({ context: { ...discordCtx, platform: 'slack' }, text: 'x' })).resolves.toEqual({ platformMessageIds: [] });
    await expect(adapter.requestApproval({} as never, { ...discordCtx, platform: 'slack' })).rejects.toThrow('PLATFORM_NOT_COMPOSED');
    expect(discord.sent.map((m) => m.text)).toEqual(['d']);
    expect(telegram.sent.map((m) => m.text)).toEqual(['t']);
    expect(telegram.typing).toEqual([telegramCtx]);
    expect(discord.typing).toEqual([]);
  });

  it('every platform delivers inbound turns to the one registered handler', async () => {
    const { adapter, discord, telegram } = composite();
    const seen: string[] = [];
    adapter.onMessage(async (message: InboundMessage) => void seen.push(message.context.platform));
    await discord.handler?.({ id: '1', context: discordCtx, text: 'a', receivedAt: '' });
    await telegram.handler?.({ id: '2', context: telegramCtx, text: 'b', receivedAt: '' });
    expect(seen).toEqual(['discord', 'telegram']);
  });

  it('starts primary first; a failing child stops the started ones and its typed error passes through unchanged', async () => {
    const { adapter, log, telegram } = composite();
    telegram.failStart = true;
    await expect(adapter.start()).rejects.toMatchObject({ code: 'TELEGRAM_IDENTITY_MISMATCH' });
    expect(log).toEqual(['start:discord', 'start:telegram', 'stop:discord']);
    log.length = 0;
    await adapter.stop();
    expect(log).toEqual(['stop:telegram', 'stop:discord']);
  });

  it('CA P2-2: a Telegram outage at startup does not take Discord down (start resolves, nothing is stopped)', async () => {
    const log: string[] = [];
    const discord = new FakeDiscord('discord', log);
    const token = TelegramBotToken.from([['70', '01', '23', '4'].join(''), ['AAH', 'o'.repeat(32)].join('')].join(':'));
    if (!token) throw new Error('fixture token is not well-formed');
    let calls = 0;
    const telegram = new TelegramPlatformAdapter({ token, expectedBotId: token.botId, ownerIds: ['5550001'] }, silent, {
      fetch: async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      },
      sleep: (_ms, signal) =>
        new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }))),
    });
    const adapter = new CompositePlatformAdapter(discord, [telegram], silent);
    await expect(adapter.start()).resolves.toBeUndefined();
    expect(log).toEqual(['start:discord']);
    expect(calls).toBe(1);
    expect(telegram.status()).toMatchObject({ identityVerified: false, polling: false });
    await adapter.stop();
    expect(log).toEqual(['start:discord', 'stop:discord']);
  });

  it('forwards the ADR-0102 D5 gate and identity reader, and the owner sink, to the primary (Discord) path', async () => {
    const { adapter, discord } = composite();
    const gate = Promise.resolve(true);
    expect(applyInboundGate(adapter, gate)).toBe(true);
    expect(discord.gate).toBe(gate);
    await expect(
      verifyStartupIdentity(adapter, { botUserId: '900000000000000001', channelIds: [] }, silent),
    ).resolves.toBeUndefined();
    await expect(verifyStartupIdentity(adapter, { botUserId: '900000000000000009', channelIds: [] }, silent)).rejects.toMatchObject({
      code: 'DISCORD_IDENTITY_MISMATCH',
    });
    const sink = platformNotificationSink(adapter, silent);
    const notice = { correlationId: 'c', target: { ...discordCtx, channelId: '' }, kind: 'OPS_NOTICE', text: 'x' } as OwnerNotification;
    await expect(sink.deliver(notice)).resolves.toEqual({ status: 'SENT', via: 'DM' });
    expect(discord.notifications).toEqual([notice]);
  });

  it('CA P1-1 (ADR-0114 D11): TEXT and BRIEF go to the target platform; OPS_DECISION_RESULT always to the primary', async () => {
    const log: string[] = [];
    const discord = new FakeDiscord('discord', log);
    const telegramNotes: OwnerNotification[] = [];
    const telegram = Object.assign(new FakeAdapter('telegram', log), {
      async deliver(notification: OwnerNotification) {
        telegramNotes.push(notification);
        return { status: 'SENT' as const, via: 'dm' as const };
      },
    });
    const adapter = new CompositePlatformAdapter(discord, [telegram], silent);
    const note = (kind: OwnerNotification['kind'], platform: string) =>
      ({ correlationId: kind, target: { platform, channelId: '5550001', userId: '5550001' }, kind, text: 'x' }) as OwnerNotification;
    await adapter.deliver(note('TEXT', 'telegram'));
    await adapter.deliver(note('BRIEF', 'telegram'));
    await adapter.deliver(note('OPS_DECISION_RESULT', 'telegram'));
    await adapter.deliver(note('BRIEF', 'discord')); // the OPS_NOTICE shape: a BRIEF addressed to the primary
    await adapter.deliver(note('TEXT', 'discord'));
    expect(telegramNotes.map((n) => n.correlationId)).toEqual(['TEXT', 'BRIEF']);
    expect(discord.notifications.map((n) => `${n.kind}:${n.target.platform}`)).toEqual([
      'OPS_DECISION_RESULT:telegram',
      'BRIEF:discord',
      'TEXT:discord',
    ]);
    await expect(adapter.deliver(note('TEXT', 'slack'))).resolves.toEqual({ status: 'NOT_SENT', reason: 'TARGET_NOT_ADMITTED', retryable: false });
    // A composed child without a sink is refused the same way, never re-routed to another platform.
    const bare = new CompositePlatformAdapter(discord, [new FakeAdapter('telegram', log)], silent);
    await expect(bare.deliver(note('TEXT', 'telegram'))).resolves.toEqual({ status: 'NOT_SENT', reason: 'TARGET_NOT_ADMITTED', retryable: false });
  });

  it('refuses two adapters of the same platform', () => {
    const log: string[] = [];
    expect(() => new CompositePlatformAdapter(new FakeAdapter('discord', log), [new FakeAdapter('discord', log)], silent)).toThrow(
      'COMPOSITE_PLATFORM_DUPLICATE',
    );
  });
});

describe('composePlatformAdapter (ADR-0114 D13): Telegram off leaves Discord exactly as it was', () => {
  const discord = new DiscordPlatformAdapter({ token: 'unused', ownerIds: ['111111111111111111'] }, silent);

  it('with no Telegram config the bound adapter IS the Discord adapter (no composite, nothing Telegram constructed)', () => {
    expect(composePlatformAdapter(discord, undefined, { logger: () => silent, dbPath: ':memory:' })).toBe(discord);
    expect(telegramOwnerIdentityLinks(undefined)).toEqual([]);
  });

  it('with Telegram on it is one composite over Discord (primary) and Telegram, and the owner links follow the map', () => {
    const token = TelegramBotToken.from([['70', '01', '23', '4'].join(''), ['AAH', 'c'.repeat(32)].join('')].join(':'));
    if (!token) throw new Error('fixture token is not well-formed');
    const telegram: TelegramConfig = {
      token,
      expectedBotId: token.botId,
      ownerIds: ['5550001'],
      ownerActorMap: [{ telegramId: '5550001', discordOwnerId: '111111111111111111' }],
    };
    const bound = composePlatformAdapter(discord, telegram, { logger: () => silent, dbPath: ':memory:' });
    expect(bound).toBeInstanceOf(CompositePlatformAdapter);
    expect((bound as CompositePlatformAdapter).platforms).toEqual(['discord', 'telegram']);
    expect(bound.platform).toBe('discord+telegram');
    expect(telegramOwnerIdentityLinks(telegram)).toEqual([
      { identity: { platform: 'telegram', externalId: '5550001' }, owner: { platform: 'discord', externalId: '111111111111111111' } },
    ]);
  });
});

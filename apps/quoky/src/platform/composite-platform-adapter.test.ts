import { describe, expect, it } from 'vitest';
import { composeDailyBrief, messageFields, plainTextOf } from '@quoky/core';
import type { CalendarEvent, ConnectorItem } from '@quoky/core';
import { renderTelegramContent, TELEGRAM_MESSAGE_LIMIT } from '@quoky/adapter-telegram';
// Test-only cross-package source import (precedent: personal-v3-acceptance.test.ts): the adapter's offline Bot API fake.
import { FakeTelegram } from '../../../../packages/adapter-telegram/src/test-support';
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
import { composePlatformAdapter, onTelegramHalt, telegramOwnerIdentityLinks } from './platform-composition';
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

  it('ADR-0102 D5 / ADR-0114 D4: a definitive Telegram answer at startup stops the start with its typed code (exit 78)', async () => {
    const { describeStartupFailure } = await import('../bootstrap-preflight');
    const { startupExitCode, QuokyExitCode } = await import('../ops/exit-codes');
    const token = TelegramBotToken.from([['70', '01', '23', '4'].join(''), ['AAH', 'm'.repeat(32)].join('')].join(':'));
    if (!token) throw new Error('fixture token is not well-formed');
    for (const [reply, code] of [
      [{ json: { ok: true, result: { id: 999_999_999, is_bot: true } } }, 'TELEGRAM_IDENTITY_MISMATCH'],
      [{ status: 401, json: { ok: false, error_code: 401 } }, 'TELEGRAM_AUTH_REJECTED'],
    ] as const) {
      const log: string[] = [];
      const discord = new FakeDiscord('discord', log);
      const fake = new FakeTelegram().queue('getMe', reply as never);
      const telegram = new TelegramPlatformAdapter({ token, expectedBotId: token.botId, ownerIds: ['5550001'] }, silent, { fetch: fake.fetch });
      const error = await new CompositePlatformAdapter(discord, [telegram], silent).start().catch((err: unknown) => err);
      expect(error).toMatchObject({ code });
      expect(log).toEqual(['start:discord', 'stop:discord']);
      const failure = describeStartupFailure(error);
      expect(failure.message).toBe(code);
      expect(startupExitCode(failure)).toBe(QuokyExitCode.CONFIGURATION);
    }
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
    // No Telegram, no halt wiring.
    expect(onTelegramHalt(discord, () => undefined)).toBe(false);
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
    expect(onTelegramHalt(bound, () => undefined)).toBe(true);
    expect(telegramOwnerIdentityLinks(telegram)).toEqual([
      { identity: { platform: 'telegram', externalId: '5550001' }, owner: { platform: 'discord', externalId: '111111111111111111' } },
    ]);
  });
});

describe('A Telegram BRIEF with calendar and Jira sections through the composite (BRF-1 x TG-1)', () => {
  const event = (id: string, title: string, hour: number): CalendarEvent => ({
    id,
    title,
    start: `2026-10-02T${String(hour).padStart(2, '0')}:00:00.000Z`,
    end: `2026-10-02T${String(hour).padStart(2, '0')}:30:00.000Z`,
    allDay: false,
    status: 'confirmed',
    calendarName: 'primary',
  });
  const work = (id: string, title: string): ConnectorItem => ({ id, title, dueDate: '2026-10-02' });

  it.each([
    ['ordinary titles with markup', '<b>설계</b> *리뷰* @everyone <#123> [x](https://e.test)', 3],
    ['the largest brief (long titles, every section full)', '다'.repeat(200), 12],
  ])('%s: one sendMessage, at most 4096, content and text agree', async (_label, title, count) => {
    const body = composeDailyBrief({
      now: '2026-10-01T23:00:00.000Z',
      timeZone: 'Asia/Seoul',
      reminders: [],
      workItems: [],
      calendar: { events: Array.from({ length: count }, (_, i) => event(`e${i}`, `${title} ${i}`, i)), limit: 50 },
      assignedWork: Array.from({ length: Math.min(count, 8) }, (_, i) => work(`P-${i}`, `${title} ${i}`)),
    });
    const fields = messageFields(body);
    if (fields.content !== undefined) expect(plainTextOf(fields.content)).toBe(fields.text);

    const fake = new FakeTelegram();
    const token = TelegramBotToken.from([['70', '01', '23', '4'].join(''), ['AAH', 'b'.repeat(32)].join('')].join(':'));
    if (!token) throw new Error('fixture token is not well-formed');
    const telegram = new TelegramPlatformAdapter({ token, expectedBotId: token.botId, ownerIds: ['5550001'] }, silent, { fetch: fake.fetch });
    const log: string[] = [];
    const discord = new FakeDiscord('discord', log);
    const adapter = new CompositePlatformAdapter(discord, [telegram], silent);
    await adapter.start();
    for (let i = 0; i < 200 && !telegram.status().identityVerified; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const outcome = await adapter.deliver({
      correlationId: 'brief-1',
      target: { platform: 'telegram', channelId: '5550001', userId: '5550001', direct: true },
      kind: 'BRIEF',
      ...fields,
    } as OwnerNotification);
    expect(outcome).toEqual({ status: 'SENT', via: 'dm' });
    const sends = fake.callsTo('sendMessage');
    expect(sends).toHaveLength(1);
    const sent = String(sends[0]?.params.text);
    expect(sent.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(sent).toBe(fields.content !== undefined ? renderTelegramContent(fields.content) : fields.text);
    expect(sent).toContain('오늘 일정');
    expect(sent).toContain('담당 이슈');
    expect(sends[0]?.params.parse_mode).toBeUndefined();
    expect(discord.notifications).toEqual([]);
    await adapter.stop();
  });
});

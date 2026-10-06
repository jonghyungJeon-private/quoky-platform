import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '@quoky/core';
import { DiscordPlatformAdapter } from '@quoky/adapter-discord';
import { describeStartupFailure } from '../bootstrap-preflight';
import { startupExitCode } from './exit-codes';
import {
  compareStartupIdentity,
  startupIdentityExpectation,
  verifyStartupIdentity,
} from './startup-identity-check';
import type { ConnectedIdentityFacts, ConnectedIdentityReader } from './startup-identity-check';

const BOT = '888888888888888888';
const OTHER_BOT = '777777777777777777';
const GUILD = '333333333333333333';
const OTHER_GUILD = '222222222222222222';
const CHANNEL = '444444444444444444';
const CHANNEL_2 = '555555555555555555';

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.lines.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.lines.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.lines.push({ level: 'error', message, fields }); }
}

const matching: ConnectedIdentityFacts = {
  botUserId: BOT,
  guildIds: [GUILD],
  channels: [
    { id: CHANNEL, guildId: GUILD },
    { id: CHANNEL_2, guildId: GUILD },
  ],
  unreachableChannelIds: [],
};

function reader(facts: ConnectedIdentityFacts | Error): ConnectedIdentityReader & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async readConnectedIdentity(channelIds) {
      calls.push(channelIds);
      if (facts instanceof Error) throw facts;
      return facts;
    },
  };
}

describe('startupIdentityExpectation (ADR-0102 D5)', () => {
  it('is off without QUOKY_DISCORD_EXPECTED_BOT_ID and carries bot/guild/channels when set', () => {
    expect(startupIdentityExpectation({ discord: { token: 't', ownerIds: [], channelIds: [] } })).toBeUndefined();
    expect(
      startupIdentityExpectation({
        discord: { token: 't', ownerIds: [], channelIds: [CHANNEL], guildId: ` ${GUILD} `, expectedBotId: BOT },
      }),
    ).toEqual({ botUserId: BOT, guildId: GUILD, channelIds: [CHANNEL] });
    expect(
      startupIdentityExpectation({ discord: { token: 't', ownerIds: [], channelIds: [], guildId: '', expectedBotId: BOT } }),
    ).toEqual({ botUserId: BOT, channelIds: [] });
  });
});

describe('compareStartupIdentity (ADR-0102 D5)', () => {
  const expected = { botUserId: BOT, guildId: GUILD, channelIds: [CHANNEL, CHANNEL_2] };

  it('matches when bot, guild and every channel agree', () => {
    expect(compareStartupIdentity(expected, matching)).toEqual([]);
  });

  it('reports a different bot (wrong token in .env.local or an inherited one)', () => {
    expect(compareStartupIdentity(expected, { ...matching, botUserId: OTHER_BOT })).toEqual(['bot']);
  });

  it('reports a guild the bot is not in', () => {
    expect(compareStartupIdentity(expected, { ...matching, guildIds: [OTHER_GUILD] })).toEqual(['guild']);
  });

  it('reports an unreachable channel, a channel in another guild and a non-guild channel', () => {
    expect(
      compareStartupIdentity(expected, { ...matching, channels: [matching.channels[0]!], unreachableChannelIds: [CHANNEL_2] }),
    ).toEqual(['channel']);
    expect(
      compareStartupIdentity(expected, {
        ...matching,
        channels: [matching.channels[0]!, { id: CHANNEL_2, guildId: OTHER_GUILD }],
      }),
    ).toEqual(['channel']);
    expect(
      compareStartupIdentity(expected, { ...matching, channels: [matching.channels[0]!, { id: CHANNEL_2, guildId: null }] }),
    ).toEqual(['channel']);
  });

  it('without a configured guild, each channel must be in a guild the bot is in', () => {
    const noGuild = { botUserId: BOT, channelIds: [CHANNEL] };
    expect(compareStartupIdentity(noGuild, matching)).toEqual([]);
    expect(
      compareStartupIdentity(noGuild, { ...matching, channels: [{ id: CHANNEL, guildId: OTHER_GUILD }] }),
    ).toEqual(['channel']);
  });

  it('reports every mismatching field in a fixed order', () => {
    expect(
      compareStartupIdentity(expected, { botUserId: OTHER_BOT, guildIds: [], channels: [], unreachableChannelIds: [CHANNEL] }),
    ).toEqual(['bot', 'guild', 'channel']);
  });
});

describe('verifyStartupIdentity (ADR-0102 D5)', () => {
  const expected = { botUserId: BOT, guildId: GUILD, channelIds: [CHANNEL, CHANNEL_2] };

  it('passes the configured channel ids to the platform and logs counts only on success', async () => {
    const platform = reader(matching);
    const log = new RecordingLogger();
    await verifyStartupIdentity(platform, expected, log);
    expect(platform.calls).toEqual([[CHANNEL, CHANNEL_2]]);
    expect(log.lines).toEqual([
      { level: 'info', message: 'startup identity verified', fields: { bot: 'match', guild: 'match', channels: 2 } },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain(BOT);
  });

  it('a mismatch is a configuration refusal (exit 78) that names fields, never ids', async () => {
    const log = new RecordingLogger();
    const error = await verifyStartupIdentity(reader({ ...matching, botUserId: OTHER_BOT }), expected, log).catch(
      (err: unknown) => err,
    );
    const report = describeStartupFailure(error);
    expect(report.message).toBe('DISCORD_IDENTITY_MISMATCH');
    expect(startupExitCode(report)).toBe(78);
    const text = JSON.stringify({ report, lines: log.lines });
    for (const id of [BOT, OTHER_BOT, GUILD, CHANNEL, CHANNEL_2]) expect(text).not.toContain(id);
    expect(log.lines).toEqual([{ level: 'error', message: 'startup identity mismatch', fields: { fields: 'bot' } }]);
  });

  it('an unreadable identity is unverifiable (exit 1, relaunched) — including a platform without the capability', async () => {
    for (const platform of [reader(new Error('gateway timeout')), { platform: 'other' }, undefined]) {
      const error = await verifyStartupIdentity(platform, expected, new RecordingLogger()).catch((err: unknown) => err);
      const report = describeStartupFailure(error);
      expect(report.message).toBe('DISCORD_IDENTITY_UNVERIFIABLE');
      expect(startupExitCode(report)).toBe(1);
    }
  });

  it('the Discord adapter provides the reader capability (composition-root duck typing stays in sync)', () => {
    const adapter: ConnectedIdentityReader = new DiscordPlatformAdapter(
      { token: 'unused', ownerIds: [] },
      new RecordingLogger(),
    );
    expect(typeof adapter.readConnectedIdentity).toBe('function');
  });
});

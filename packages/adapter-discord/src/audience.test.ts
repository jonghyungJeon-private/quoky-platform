import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { discordAudienceOf } from './audience';

// ADR-0122 D4.3: the audience of a guild message, from the cache only (member count upper bound, private channel).

const everyone = { id: 'g1' };
const viewable = (canView: boolean) => ({
  permissionsFor: (role: unknown) => (role === everyone ? { has: (permission: bigint) => (permission === PermissionFlagsBits.ViewChannel ? canView : true) } : null),
});

describe('discordAudienceOf', () => {
  it('a DM has no audience', () => {
    expect(discordAudienceOf({ guildId: null, channel: { type: ChannelType.DM } })).toBeUndefined();
  });

  it('a public guild channel: the member count and "not private"', () => {
    expect(discordAudienceOf({ guildId: 'g1', guild: { memberCount: 42, roles: { everyone } }, channel: { type: ChannelType.GuildText, isThread: () => false, ...viewable(true) } })).toEqual({ memberUpperBound: 42, restricted: false });
  });

  it('a channel @everyone cannot view is private; a thread uses its parent; a private thread is always private', () => {
    expect(discordAudienceOf({ guildId: 'g1', guild: { memberCount: 42, roles: { everyone } }, channel: { type: ChannelType.GuildText, isThread: () => false, ...viewable(false) } })).toEqual({ memberUpperBound: 42, restricted: true });
    expect(discordAudienceOf({ guildId: 'g1', guild: { memberCount: 7, roles: { everyone } }, channel: { type: ChannelType.PublicThread, isThread: () => true, parent: viewable(false) } })).toEqual({ memberUpperBound: 7, restricted: true });
    expect(discordAudienceOf({ guildId: 'g1', guild: { memberCount: 7, roles: { everyone } }, channel: { type: ChannelType.PrivateThread, isThread: () => true, parent: viewable(true) } })).toEqual({ memberUpperBound: 7, restricted: true });
  });

  it('nothing cached (or an unexpected shape) is "unknown", never a guess', () => {
    expect(discordAudienceOf({ guildId: 'g1', guild: null, channel: { type: ChannelType.GuildText, isThread: () => false } })).toBeUndefined();
    expect(discordAudienceOf({ guildId: 'g1', guild: { memberCount: 5 }, channel: { type: ChannelType.GuildText, isThread: () => false, ...viewable(true) } })).toEqual({ memberUpperBound: 5 });
    const throwing = { guildId: 'g1', get guild(): never { throw new Error('partial'); }, channel: { type: ChannelType.GuildText } };
    expect(discordAudienceOf(throwing as never)).toBeUndefined();
  });
});

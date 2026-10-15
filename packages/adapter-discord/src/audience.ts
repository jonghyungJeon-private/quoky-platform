import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { InboundAudience } from '@quoky/core';

/**
 * The structural part of a discord.js `Message` the audience mapping reads (tests pass plain objects). Everything here is
 * already in the client cache with the non-privileged `Guilds` intent: the guild's `memberCount` (sent with the guild),
 * its `@everyone` role and the channel's permission overwrites. Nothing is fetched and no member list is read.
 */
export interface DiscordAudienceSource {
  readonly guildId: string | null;
  readonly guild?: {
    readonly memberCount?: number | null;
    readonly roles?: { readonly everyone?: unknown } | null;
  } | null;
  readonly channel?: {
    readonly type?: number;
    isThread?(): boolean;
    readonly parent?: DiscordAudienceChannel | null;
  } & DiscordAudienceChannel;
}

export interface DiscordAudienceChannel {
  permissionsFor?(role: never): { has(permission: bigint): boolean } | null;
}

/**
 * ADR-0122 D4.3: the content-free audience of a guild message for the channel-grant confirmation — the server's member
 * count as an upper bound, and whether the channel is private (its `@everyone` cannot view it). A grant made in a thread
 * applies to the whole PARENT channel (the grant key has no thread, CA P1), so the audience is always the parent's, never
 * the thread's (a private thread does not make the grant private). `undefined` for a DM or when nothing is known; any
 * unexpected shape is "unknown", never a guess.
 */
export function discordAudienceOf(message: DiscordAudienceSource): InboundAudience | undefined {
  if (!message.guildId) return undefined;
  try {
    const count = message.guild?.memberCount;
    const memberUpperBound = typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : undefined;
    const restricted = restrictedOf(message);
    if (memberUpperBound === undefined && restricted === undefined) return undefined;
    return {
      ...(memberUpperBound !== undefined ? { memberUpperBound } : {}),
      ...(restricted !== undefined ? { restricted } : {}),
    };
  } catch {
    return undefined;
  }
}

function restrictedOf(message: DiscordAudienceSource): boolean | undefined {
  const channel = message.channel;
  if (channel === undefined) return undefined;
  const inThread = (typeof channel.isThread === 'function' && channel.isThread()) || channel.type === ChannelType.PrivateThread || channel.type === ChannelType.PublicThread || channel.type === ChannelType.AnnouncementThread;
  const target = inThread ? channel.parent ?? undefined : channel;
  const everyone = message.guild?.roles?.everyone;
  if (target === undefined || everyone === undefined || everyone === null || typeof target.permissionsFor !== 'function') return undefined;
  const permissions = target.permissionsFor(everyone as never);
  if (permissions === null || permissions === undefined) return undefined;
  return !permissions.has(PermissionFlagsBits.ViewChannel);
}

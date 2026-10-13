import { MessageType } from 'discord.js';
import type { InboundReplyReference } from '@quoky/core';

/** The structural part of a discord.js `Message` the reply mapping reads (tests pass plain objects). */
export interface DiscordReplySource {
  readonly type?: number | null;
  readonly channelId: string;
  readonly reference?: { readonly messageId?: string | null; readonly channelId?: string | null } | null;
}

/** A Discord message id is a snowflake: decimal digits only. */
const SNOWFLAKE = /^\d{1,32}$/u;

/**
 * GML-2 (ADR-0118 amendment of 2026-10-12): the platform-neutral reply reference of an inbound Discord message, or
 * `undefined`. Only a real reply (`MessageType.Reply`) to a message in the same channel counts — a forward or a
 * cross-channel reference is not a reply. The id is the referenced message's snowflake, the same form the adapter
 * reports in its delivery receipts, so Core can match it against its own replies. Nothing is fetched.
 */
export function discordReplyReferenceOf(message: DiscordReplySource): InboundReplyReference | undefined {
  if (message.type !== MessageType.Reply) return undefined;
  const reference = message.reference;
  const messageId = reference?.messageId;
  if (typeof messageId !== 'string' || !SNOWFLAKE.test(messageId)) return undefined;
  if (reference?.channelId !== undefined && reference.channelId !== null && reference.channelId !== message.channelId) return undefined;
  return { messageId };
}

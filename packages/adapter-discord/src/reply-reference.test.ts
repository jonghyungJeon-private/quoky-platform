import { MessageType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { discordReplyReferenceOf } from './reply-reference';

// GML-2 (ADR-0118 amendment of 2026-10-12): Discord's message reference becomes the neutral inbound reply field.
describe('discordReplyReferenceOf', () => {
  const CHANNEL = '777777777777777777';
  const LISTING = '888888888888888888';

  it('maps a real reply in the same channel to the referenced snowflake (the receipt form)', () => {
    expect(discordReplyReferenceOf({ type: MessageType.Reply, channelId: CHANNEL, reference: { messageId: LISTING, channelId: CHANNEL } })).toEqual({
      messageId: LISTING,
    });
  });

  it('ignores a plain message, a forward-like reference, another channel and a malformed id', () => {
    expect(discordReplyReferenceOf({ type: MessageType.Default, channelId: CHANNEL })).toBeUndefined();
    expect(discordReplyReferenceOf({ type: MessageType.Default, channelId: CHANNEL, reference: { messageId: LISTING, channelId: CHANNEL } })).toBeUndefined();
    expect(discordReplyReferenceOf({ type: MessageType.Reply, channelId: CHANNEL, reference: { messageId: LISTING, channelId: '1' } })).toBeUndefined();
    expect(discordReplyReferenceOf({ type: MessageType.Reply, channelId: CHANNEL, reference: { messageId: 'abc', channelId: CHANNEL } })).toBeUndefined();
    expect(discordReplyReferenceOf({ type: MessageType.Reply, channelId: CHANNEL, reference: null })).toBeUndefined();
    expect(discordReplyReferenceOf({ type: MessageType.Reply, channelId: CHANNEL })).toBeUndefined();
  });
});

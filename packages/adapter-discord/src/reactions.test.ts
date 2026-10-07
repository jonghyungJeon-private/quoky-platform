import { describe, expect, it } from 'vitest';
import { isAdmittedReaction, toRating } from './reactions';
import type { ReactionAdmissionInput } from './reactions';

const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';
const BOT = '888888888888888888';
const GUILD = '333333333333333333';
const ALLOWED = '444444444444444444';
const OTHER = '555555555555555555';
const THREAD = '666666666666666666';

describe('toRating (ADR-0098 D3)', () => {
  it.each([
    ['👍', 'POSITIVE'],
    ['👎', 'NEGATIVE'],
    ['👍🏻', 'POSITIVE'],
    ['👍🏽', 'POSITIVE'],
    ['👎🏿', 'NEGATIVE'],
    ['👍\u{FE0F}', 'POSITIVE'],
  ])('%s maps to %s', (emoji, rating) => {
    expect(toRating(emoji)).toBe(rating);
  });

  it.each(['🎉', '❤️', '👌', '+1', 'thumbsup', '', '👍👍', '🏽'])('%s is ignored', (emoji) => {
    expect(toRating(emoji)).toBeNull();
  });

  it('ignores a missing emoji name', () => {
    expect(toRating(null)).toBeNull();
    expect(toRating(undefined)).toBeNull();
  });
});

function input(over: Partial<ReactionAdmissionInput> = {}): ReactionAdmissionInput {
  return {
    userId: OWNER,
    ownerIds: [OWNER],
    messageAuthorId: BOT,
    botUserId: BOT,
    guildId: GUILD,
    channelId: ALLOWED,
    isThread: false,
    parentId: null,
    channelIds: [ALLOWED],
    ...over,
  };
}

describe('isAdmittedReaction (ADR-0091 + ADR-0098 D3)', () => {
  it('admits the owner reacting to a bot reply in an allowlisted channel', () => {
    expect(isAdmittedReaction(input())).toBe(true);
  });

  it('admits the owner in a direct message', () => {
    expect(isAdmittedReaction(input({ guildId: null, channelId: '777', channelIds: [] }))).toBe(true);
  });

  it('drops a non-owner reactor, in a channel and in a DM', () => {
    expect(isAdmittedReaction(input({ userId: STRANGER }))).toBe(false);
    expect(isAdmittedReaction(input({ userId: STRANGER, guildId: null }))).toBe(false);
  });

  it('fails closed with an empty owner list', () => {
    expect(isAdmittedReaction(input({ ownerIds: [] }))).toBe(false);
  });

  it('drops a reaction on a message not authored by the bot (including the owner\'s own message)', () => {
    expect(isAdmittedReaction(input({ messageAuthorId: OWNER }))).toBe(false);
    expect(isAdmittedReaction(input({ messageAuthorId: STRANGER, guildId: null }))).toBe(false);
  });

  it('drops a reaction whose target author is unknown on a cached message, or when the bot id is unknown', () => {
    expect(isAdmittedReaction(input({ messageAuthorId: null }))).toBe(false);
    expect(isAdmittedReaction(input({ messageAuthorId: undefined }))).toBe(false);
    expect(isAdmittedReaction(input({ botUserId: undefined, messageAuthorId: undefined }))).toBe(false);
    expect(isAdmittedReaction(input({ botUserId: undefined, messageAuthorId: null, messagePartial: true }))).toBe(false);
  });

  it('admits an uncached partial target (posted before a restart) by owner and location only', () => {
    // Core attributes it solely via the bot's own posted message ids, so a non-bot message can never be rated.
    expect(isAdmittedReaction(input({ messageAuthorId: null, messagePartial: true }))).toBe(true);
    expect(isAdmittedReaction(input({ messageAuthorId: null, messagePartial: true, guildId: null }))).toBe(true);
    expect(isAdmittedReaction(input({ messageAuthorId: null, messagePartial: true, userId: STRANGER }))).toBe(false);
    expect(isAdmittedReaction(input({ messageAuthorId: null, messagePartial: true, channelId: 'not-allowlisted' }))).toBe(false);
    expect(isAdmittedReaction(input({ messageAuthorId: null, messagePartial: true, userId: BOT, ownerIds: [BOT] }))).toBe(false);
    // A known non-bot author stays dropped even if the message object is a partial.
    expect(isAdmittedReaction(input({ messageAuthorId: OWNER, messagePartial: true }))).toBe(false);
  });

  it('never treats the bot\'s own reaction as feedback', () => {
    expect(isAdmittedReaction(input({ userId: BOT, ownerIds: [BOT] }))).toBe(false);
  });

  it('drops a reaction in a non-allowlisted channel', () => {
    expect(isAdmittedReaction(input({ channelId: OTHER }))).toBe(false);
    expect(isAdmittedReaction(input({ channelIds: [] }))).toBe(false);
  });

  it('applies the configured guild filter', () => {
    expect(isAdmittedReaction(input({ configuredGuildId: '999' }))).toBe(false);
    expect(isAdmittedReaction(input({ configuredGuildId: GUILD }))).toBe(true);
  });

  it('admits a thread whose parent or own id is allowlisted, and nothing else', () => {
    expect(isAdmittedReaction(input({ channelId: THREAD, isThread: true, parentId: ALLOWED }))).toBe(true);
    expect(isAdmittedReaction(input({ channelId: THREAD, isThread: true, parentId: OTHER, channelIds: [THREAD] }))).toBe(true);
    expect(isAdmittedReaction(input({ channelId: THREAD, isThread: true, parentId: OTHER }))).toBe(false);
    expect(isAdmittedReaction(input({ channelId: THREAD, isThread: true, parentId: null }))).toBe(false);
    expect(isAdmittedReaction(input({ channelId: THREAD, isThread: false, parentId: ALLOWED }))).toBe(false);
  });
});

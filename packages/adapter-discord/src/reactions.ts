import type { PlatformFeedbackRating } from '@quoky/core';

/**
 * Discord reaction feedback (ADR-0098 D3, QUAL-4) — pure helpers, no discord.js import.
 *
 * Only 👍 / 👎 (any skin tone) count. A reaction is admitted only from a configured owner, on a message authored by
 * this bot, in an ADR-0091 admitted location (owner DM, allowlisted guild channel, or a thread whose own id or parent
 * id is allowlisted). The adapter evaluates {@link isAdmittedReaction} on data already in the gateway event / cache,
 * BEFORE any fetch or logging; a reaction that is not admitted is dropped silently.
 */

/** Emoji modifiers ignored when mapping: Fitzpatrick skin tones U+1F3FB–U+1F3FF and variation selector-16. */
const EMOJI_MODIFIERS = /[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu;
const THUMBS_UP = '\u{1F44D}';
const THUMBS_DOWN = '\u{1F44E}';

/** 👍 → POSITIVE, 👎 → NEGATIVE (skin tones ignored), anything else (or a custom emoji name) → null. */
export function toRating(emojiName: string | null | undefined): PlatformFeedbackRating | null {
  if (typeof emojiName !== 'string') return null;
  const base = emojiName.replace(EMOJI_MODIFIERS, '');
  if (base === THUMBS_UP) return 'POSITIVE';
  if (base === THUMBS_DOWN) return 'NEGATIVE';
  return null;
}

export interface ReactionAdmissionInput {
  /** The reacting user. */
  userId: string;
  ownerIds: readonly string[];
  /** Author of the reacted message; null/undefined when unknown (uncached partial) — never admitted. */
  messageAuthorId: string | null | undefined;
  /** This bot's user id; null/undefined when the client is not ready — never admitted. */
  botUserId: string | null | undefined;
  /** Guild of the reacted message; null for a direct message. */
  guildId: string | null;
  /** Configured guild filter (DiscordConfig.guildId). */
  configuredGuildId?: string;
  /** Channel (or thread) id the reacted message lives in. */
  channelId: string;
  isThread: boolean;
  /** Parent channel id of a thread, if known. */
  parentId: string | null;
  /** Allowlisted guild channel ids (ADR-0091). */
  channelIds: readonly string[];
}

/**
 * The ADR-0091 owner/location gate plus the ADR-0098 bot-authored-target rule. Fail closed: an empty owner list
 * admits nobody; an unknown author or bot id admits nothing; the bot's own reactions are never feedback.
 */
export function isAdmittedReaction(input: ReactionAdmissionInput): boolean {
  if (!input.ownerIds.includes(input.userId)) return false;
  if (!input.botUserId || input.userId === input.botUserId) return false;
  if (!input.messageAuthorId || input.messageAuthorId !== input.botUserId) return false;
  if (input.guildId === null) return true; // direct message
  if (input.configuredGuildId && input.guildId !== input.configuredGuildId) return false;
  if (input.channelIds.includes(input.channelId)) return true;
  return input.isThread && input.parentId !== null && input.channelIds.includes(input.parentId);
}

import type { PlatformFeedbackAction, PlatformFeedbackRating } from '@quoky/core';

/**
 * Telegram reaction feedback (ADR-0098 D3, ADR-0114 D9; TG-2) — pure helpers, no I/O.
 *
 * Spike result (Bot API reference, `Update.message_reaction` and `getUpdates.allowed_updates`): reaction changes arrive
 * as `message_reaction` updates (`MessageReactionUpdated`: `chat`, `message_id`, optional `user` / `actor_chat`,
 * `date`, `old_reaction`, `new_reaction`). They are NOT in the default update set: the bot must list
 * `message_reaction` in `allowed_updates` explicitly, and the update is never sent for reactions set by bots. The
 * reference also says "the bot must be an administrator in the chat"; a private chat has no administrators and the
 * reference names no private-chat exclusion, so the adapter asks for the update and admits it from the owner's private
 * chat only. If Telegram does not deliver it there in practice, no update arrives, `onFeedback` never fires, and
 * nothing else changes (the port's optional feedback surface degrades cleanly). Live confirmation belongs to the Strict
 * first live session.
 *
 * Only 👍 / 👎 count (`ReactionTypeEmoji`; a custom or paid reaction is ignored). One update carries the whole old and
 * new reaction lists, so it is turned into per-rating `ADDED` / `REMOVED` changes.
 */

const EMOJI_MODIFIERS = /[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu;
const THUMBS_UP = '\u{1F44D}';
const THUMBS_DOWN = '\u{1F44E}';

/** 👍 → POSITIVE, 👎 → NEGATIVE (modifiers ignored), anything else → null. */
export function toRating(emoji: unknown): PlatformFeedbackRating | null {
  if (typeof emoji !== 'string') return null;
  const base = emoji.replace(EMOJI_MODIFIERS, '');
  if (base === THUMBS_UP) return 'POSITIVE';
  if (base === THUMBS_DOWN) return 'NEGATIVE';
  return null;
}

/** The ratings in one `ReactionType[]` list: only `{ type: 'emoji', emoji: 👍|👎 }` entries count. */
export function ratingsOf(reactions: unknown): ReadonlySet<PlatformFeedbackRating> | null {
  if (!Array.isArray(reactions)) return null;
  const ratings = new Set<PlatformFeedbackRating>();
  for (const reaction of reactions) {
    if (typeof reaction !== 'object' || reaction === null || (reaction as { type?: unknown }).type !== 'emoji') continue;
    const rating = toRating((reaction as { emoji?: unknown }).emoji);
    if (rating) ratings.add(rating);
  }
  return ratings;
}

export interface FeedbackChange {
  readonly rating: PlatformFeedbackRating;
  readonly action: PlatformFeedbackAction;
}

/**
 * The 👍/👎 changes between `old_reaction` and `new_reaction`, in a fixed order (POSITIVE first; a removal before an
 * addition). `null` when either list is not an array (malformed); empty when no rating changed.
 */
export function feedbackChanges(oldReaction: unknown, newReaction: unknown): readonly FeedbackChange[] | null {
  const before = ratingsOf(oldReaction);
  const after = ratingsOf(newReaction);
  if (before === null || after === null) return null;
  const changes: FeedbackChange[] = [];
  for (const rating of ['POSITIVE', 'NEGATIVE'] as const) {
    if (before.has(rating) && !after.has(rating)) changes.push({ rating, action: 'REMOVED' });
  }
  for (const rating of ['POSITIVE', 'NEGATIVE'] as const) {
    if (!before.has(rating) && after.has(rating)) changes.push({ rating, action: 'ADDED' });
  }
  return changes;
}

/**
 * The platform message id the adapter reports for a message in a chat (receipts and reaction targets alike). Telegram
 * message ids are unique only inside one chat, so the id is scoped by the chat: `<chat id>:<message id>`. Core matches a
 * reaction only against ids the adapter reported for its own posted replies (`turn_platform_messages`), which is how a
 * reaction on the owner's own message is never taken as feedback.
 */
export function telegramMessageKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`;
}

/**
 * Telegram owner admission (ADR-0114 D2; the per-platform form of ADR-0091). PURE: it reads only the fields of one
 * `getUpdates` entry that decide admission, and returns either the admitted text message or a value-free drop reason.
 *
 * Admitted: exactly a `message` update, in a `private` chat, from a non-bot user whose numeric `from.id` is listed in
 * `QUOKY_TELEGRAM_OWNER_IDS`, where the chat is that user's own chat (`chat.id === from.id`), written by the owner (not
 * forwarded, not sent via an inline bot), carrying `text`, and not older than {@link MAX_UPDATE_AGE_SECONDS}. Everything else is dropped: groups, supergroups, channels, edited
 * messages, channel posts, inline and callback queries, reactions, membership updates and every other update type,
 * other users, bots, and owner messages without text (stickers, photos, files: attachment intake is TG-2, and nothing
 * is downloaded for them). A dropped update gets no reply, no download and no log of its content; the caller counts its
 * reason only.
 */

/** Why an update was not admitted. Values only, never content or ids. */
export type TelegramDropReason =
  /** Not an object, or `update_id` is not a non-negative safe integer. */
  | 'malformed'
  /** Anything but a `message` update (edited messages, channel posts, queries, reactions, membership, …). */
  | 'update-type'
  /** A group, supergroup or channel message, or a private chat that is not the sender's own. */
  | 'not-private'
  /** A sender that is not a listed owner, a bot, or no sender at all. */
  | 'not-owner'
  /** An owner message without text (a sticker, photo, file, voice note, location, …). */
  | 'no-text'
  /**
   * An owner message whose text the owner did not write: forwarded from anyone (`forward_origin` of any type, or the
   * legacy `forward_from` / `forward_from_chat` / `forward_sender_name` / `forward_date`) or sent through an inline bot
   * (`via_bot`). Its text is someone else's, so it is never taken as the owner's own request.
   */
  | 'forwarded'
  /** An owner message older than the age bound (sent while Quoky was down for long; never replayed). */
  | 'stale';

export const TELEGRAM_DROP_REASONS: readonly TelegramDropReason[] = [
  'malformed',
  'update-type',
  'not-private',
  'not-owner',
  'forwarded',
  'no-text',
  'stale',
];

/** The message fields that mark text the owner did not write (any one of them present drops the message). */
const NOT_OWN_TEXT_FIELDS = ['forward_origin', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date', 'via_bot'] as const;

/** An owner's private text message, as admitted. `chatId` equals `userId` (the owner's own private chat). */
export interface AdmittedTelegramMessage {
  readonly updateId: number;
  readonly chatId: string;
  readonly userId: string;
  readonly messageId: string;
  readonly text: string;
  /** Unix seconds (Telegram `date`). */
  readonly date: number;
}

export type TelegramAdmission =
  | { readonly kind: 'admitted'; readonly message: AdmittedTelegramMessage }
  | { readonly kind: 'dropped'; readonly updateId?: number; readonly reason: TelegramDropReason };

/**
 * Updates older than this are dropped (10 minutes). A restart resumes from Telegram's unconfirmed updates, so a message
 * sent during a short restart is still answered; a message left from a long outage (Telegram keeps updates up to 24
 * hours) is not replayed as if it were new — an approval phrase from hours ago must never act now.
 */
export const MAX_UPDATE_AGE_SECONDS = 600;

/** The `update_id` of a raw entry when it is a non-negative safe integer (the poll offset needs it even for a drop). */
export function updateIdOf(update: unknown): number | undefined {
  const id = (update as { update_id?: unknown } | null)?.update_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/** Telegram user and chat ids are integers up to 52 significant bits. */
function idOf(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined;
}

export function admitTelegramUpdate(
  update: unknown,
  ownerIds: ReadonlySet<string>,
  nowSeconds: number,
): TelegramAdmission {
  const updateId = updateIdOf(update);
  if (updateId === undefined || typeof update !== 'object' || update === null) return { kind: 'dropped', reason: 'malformed' };
  const drop = (reason: TelegramDropReason): TelegramAdmission => ({ kind: 'dropped', updateId, reason });
  // Exactly one payload key besides `update_id`, and it must be `message`.
  const payloadKeys = Object.keys(update).filter((key) => key !== 'update_id');
  if (payloadKeys.length !== 1 || payloadKeys[0] !== 'message') return drop('update-type');
  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return drop('malformed');
  const { chat, from } = message as { chat?: unknown; from?: unknown };
  if (typeof chat !== 'object' || chat === null || (chat as { type?: unknown }).type !== 'private') return drop('not-private');
  if (typeof from !== 'object' || from === null || (from as { is_bot?: unknown }).is_bot !== false) return drop('not-owner');
  const userId = idOf((from as { id?: unknown }).id);
  if (userId === undefined || !ownerIds.has(userId)) return drop('not-owner');
  // An owner's private chat with the bot has the owner's own user id as its chat id.
  if (idOf((chat as { id?: unknown }).id) !== userId) return drop('not-private');
  // Forwarded or inline-bot text is someone else's words, even in the owner's chat: never the owner's request.
  if (NOT_OWN_TEXT_FIELDS.some((field) => (message as Record<string, unknown>)[field] !== undefined)) return drop('forwarded');
  const { text, message_id: messageId, date } = message as { text?: unknown; message_id?: unknown; date?: unknown };
  if (typeof text !== 'string') return drop('no-text');
  const id = idOf(messageId);
  if (id === undefined || typeof date !== 'number' || !Number.isFinite(date)) return drop('malformed');
  if (nowSeconds - date > MAX_UPDATE_AGE_SECONDS) return drop('stale');
  return { kind: 'admitted', message: { updateId, chatId: userId, userId, messageId: id, text, date } };
}

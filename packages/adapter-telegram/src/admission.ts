import { IMAGE_ATTACHMENT_MAX_BYTES } from './attachments';
import type { TelegramAttachmentSource } from './attachments';
import { feedbackChanges } from './reactions';
import type { FeedbackChange } from './reactions';

/**
 * Telegram owner admission (ADR-0114 D2; the per-platform form of ADR-0091). PURE: it reads only the fields of one
 * `getUpdates` entry that decide admission and the attachment METADATA (never a file), and returns the admitted message,
 * the admitted reaction, or a value-free drop reason.
 *
 * - **Messages.** Admitted: exactly a `message` update, in a `private` chat, from a non-bot user whose numeric `from.id`
 *   is listed in `QUOKY_TELEGRAM_OWNER_IDS`, where the chat is that user's own chat (`chat.id === from.id`), written by
 *   the owner (not forwarded, not sent via an inline bot), carrying `text`, a `caption`, a photo, a document or another
 *   file (TG-2), and not older than {@link MAX_UPDATE_AGE_SECONDS}. A caption is the message text (ADR-0111 note: an
 *   owner caption is a trusted request). A photo or document becomes a `file` attachment source; a sticker, voice note,
 *   audio, video, video note or animation becomes an `unsupported-media` source (named in the reply, never fetched).
 * - **Reactions** (TG-2, ADR-0098 D3): exactly a `message_reaction` update in the owner's own private chat by the owner
 *   (a named, non-bot user; no `actor_chat`), not stale, that changes a 👍/👎.
 *
 * Everything else is dropped: groups, supergroups, channels, edited messages, channel posts, inline and callback
 * queries, anonymous reaction counts, membership updates and every other update type, other users, bots, forwarded and
 * inline-bot messages, owner messages with nothing to read (a location, contact, poll, …) and stale messages. A dropped
 * update gets no reply, no download and no log of its content; the caller counts its reason only.
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
  /** An owner message with nothing to read: no text, caption or file (a location, contact, poll, dice, …). */
  | 'no-text'
  /**
   * An owner message whose text the owner did not write: forwarded from anyone (`forward_origin` of any type, or the
   * legacy `forward_from` / `forward_from_chat` / `forward_sender_name` / `forward_date`) or sent through an inline bot
   * (`via_bot`). Its text is someone else's, so it is never taken as the owner's own request.
   */
  | 'forwarded'
  /** An owner message or reaction older than the age bound (sent while Quoky was down for long; never replayed). */
  | 'stale'
  /** An owner reaction that changes no 👍/👎 (another emoji, a custom or paid reaction) (TG-2). */
  | 'not-feedback';

export const TELEGRAM_DROP_REASONS: readonly TelegramDropReason[] = [
  'malformed',
  'update-type',
  'not-private',
  'not-owner',
  'forwarded',
  'no-text',
  'stale',
  'not-feedback',
];

/** The message fields that mark text the owner did not write (any one of them present drops the message). */
const NOT_OWN_TEXT_FIELDS = ['forward_origin', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date', 'via_bot'] as const;

/** An owner's private message, as admitted. `chatId` equals `userId` (the owner's own private chat). */
export interface AdmittedTelegramMessage {
  readonly updateId: number;
  readonly chatId: string;
  readonly userId: string;
  readonly messageId: string;
  /** The message text, or the caption of a photo or file (`''` for a file without one). */
  readonly text: string;
  /** Unix seconds (Telegram `date`). */
  readonly date: number;
  /** Attachment metadata (TG-2), in message order; absent when the message has none. Nothing has been fetched. */
  readonly attachments?: readonly TelegramAttachmentSource[];
  /** The album (`media_group_id`) the message belongs to; its parts are taken in as one turn. */
  readonly mediaGroupId?: string;
}

/** An owner's 👍/👎 change on a message in their own private chat (TG-2). */
export interface AdmittedTelegramReaction {
  readonly updateId: number;
  readonly chatId: string;
  readonly userId: string;
  /** The reacted message's id inside the chat. */
  readonly messageId: string;
  readonly changes: readonly FeedbackChange[];
  readonly date: number;
}

export type TelegramAdmission =
  | { readonly kind: 'admitted'; readonly message: AdmittedTelegramMessage }
  | { readonly kind: 'reaction'; readonly reaction: AdmittedTelegramReaction }
  | {
      readonly kind: 'dropped';
      readonly updateId?: number;
      readonly reason: TelegramDropReason;
      /**
       * Set only for an OWNER's own private chat dropped as `stale` or `no-text` (CA P3-4): the adapter may tell the
       * owner, once, that those messages were not processed. Never set for anyone else.
       */
      readonly ownerChatId?: string;
    };

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

/** The file-bearing message fields that are never taken in (named as unsupported in the reply, never fetched). */
const UNSUPPORTED_MEDIA_FIELDS = ['animation', 'sticker', 'video', 'video_note', 'voice', 'audio'] as const;

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function sizeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function fileIdOf(value: unknown): string | undefined {
  const id = (value as { file_id?: unknown } | null)?.file_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : undefined;
}

/**
 * The attachment metadata of one owner message, in a fixed order: the photo, the document, then any other file-bearing
 * field. `undefined` when a file field is present but malformed (the whole update is then dropped as `malformed`).
 * An `animation` also sets `document` (Bot API backward compatibility); it is one unsupported animation, not a document.
 */
function attachmentSourcesOf(message: Record<string, unknown>): TelegramAttachmentSource[] | undefined {
  const sources: TelegramAttachmentSource[] = [];
  // A photo is JPEG (Telegram re-encodes it); of its sizes (smallest first) the largest within the image bound is taken.
  if (message.photo !== undefined) {
    if (!Array.isArray(message.photo)) return undefined;
    const sizes = message.photo.filter((size) => fileIdOf(size) !== undefined) as Array<Record<string, unknown>>;
    if (sizes.length === 0) return undefined;
    // Smallest first: the last size within the bound, or (when every size is over it) the smallest, which the
    // metadata check then refuses as TOO_LARGE before any call.
    const fitting = sizes.filter((size) => (sizeOf(size.file_size) ?? 0) <= IMAGE_ATTACHMENT_MAX_BYTES);
    const chosen = (fitting.length > 0 ? fitting[fitting.length - 1] : sizes[0]) as Record<string, unknown>;
    sources.push({
      kind: 'file',
      fileId: fileIdOf(chosen) as string,
      name: 'photo.jpg',
      contentType: 'image/jpeg',
      size: sizeOf(chosen.file_size),
    });
  }
  const isAnimation = message.animation !== undefined;
  if (message.document !== undefined && !isAnimation) {
    const document = message.document as Record<string, unknown> | null;
    const fileId = fileIdOf(document);
    if (fileId === undefined || document === null) return undefined;
    sources.push({
      kind: 'file',
      fileId,
      name: stringOf(document.file_name),
      contentType: stringOf(document.mime_type),
      size: sizeOf(document.file_size),
    });
  }
  for (const field of UNSUPPORTED_MEDIA_FIELDS) {
    const media = message[field];
    if (media === undefined) continue;
    if (typeof media !== 'object' || media === null) return undefined;
    const record = media as Record<string, unknown>;
    sources.push({
      kind: 'unsupported-media',
      name: stringOf(record.file_name) ?? field,
      contentType: stringOf(record.mime_type),
      size: sizeOf(record.file_size),
    });
  }
  return sources;
}

/** A `media_group_id` as a bounded opaque string. */
function mediaGroupIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

export function admitTelegramUpdate(
  update: unknown,
  ownerIds: ReadonlySet<string>,
  nowSeconds: number,
): TelegramAdmission {
  const updateId = updateIdOf(update);
  if (updateId === undefined || typeof update !== 'object' || update === null) return { kind: 'dropped', reason: 'malformed' };
  const drop = (reason: TelegramDropReason): TelegramAdmission => ({ kind: 'dropped', updateId, reason });
  const ownerDrop = (reason: 'stale' | 'no-text', ownerChatId: string): TelegramAdmission => ({ kind: 'dropped', updateId, reason, ownerChatId });
  // Exactly one payload key besides `update_id`: a `message`, or (TG-2) a `message_reaction`.
  const payloadKeys = Object.keys(update).filter((key) => key !== 'update_id');
  if (payloadKeys.length === 1 && payloadKeys[0] === 'message_reaction') {
    return admitReaction(updateId, (update as { message_reaction?: unknown }).message_reaction, ownerIds, nowSeconds);
  }
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
  // Forwarded or inline-bot text is someone else's words, even in the owner's chat: never the owner's request. The same
  // holds for a forwarded file and its caption: nothing of it is fetched.
  if (NOT_OWN_TEXT_FIELDS.some((field) => (message as Record<string, unknown>)[field] !== undefined)) return drop('forwarded');
  const record = message as Record<string, unknown>;
  const attachments = attachmentSourcesOf(record);
  if (attachments === undefined) return drop('malformed');
  const text = stringOf(record.text) ?? stringOf(record.caption);
  if (text === undefined && attachments.length === 0) return ownerDrop('no-text', userId);
  const id = idOf(record.message_id);
  const { date } = record;
  if (id === undefined || typeof date !== 'number' || !Number.isFinite(date)) return drop('malformed');
  if (nowSeconds - date > MAX_UPDATE_AGE_SECONDS) return ownerDrop('stale', userId);
  const mediaGroupId = attachments.length > 0 ? mediaGroupIdOf(record.media_group_id) : undefined;
  return {
    kind: 'admitted',
    message: {
      updateId,
      chatId: userId,
      userId,
      messageId: id,
      text: text ?? '',
      date,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(mediaGroupId !== undefined ? { mediaGroupId } : {}),
    },
  };
}

/**
 * TG-2 reaction admission (ADR-0098 D3): the owner's own 👍/👎 change in their own private chat. An anonymous reaction
 * (no `user`), one made on behalf of a chat (`actor_chat`), a bot, a non-owner, another chat, a stale change, or a change
 * of any other emoji is dropped. Whether the reacted message is the bot's is decided by Core against the ids the adapter
 * reported for its own replies.
 */
function admitReaction(updateId: number, payload: unknown, ownerIds: ReadonlySet<string>, nowSeconds: number): TelegramAdmission {
  const drop = (reason: TelegramDropReason): TelegramAdmission => ({ kind: 'dropped', updateId, reason });
  if (typeof payload !== 'object' || payload === null) return drop('malformed');
  const { chat, user, actor_chat: actorChat } = payload as { chat?: unknown; user?: unknown; actor_chat?: unknown };
  if (typeof chat !== 'object' || chat === null || (chat as { type?: unknown }).type !== 'private') return drop('not-private');
  if (actorChat !== undefined) return drop('not-owner');
  if (typeof user !== 'object' || user === null || (user as { is_bot?: unknown }).is_bot !== false) return drop('not-owner');
  const userId = idOf((user as { id?: unknown }).id);
  if (userId === undefined || !ownerIds.has(userId)) return drop('not-owner');
  if (idOf((chat as { id?: unknown }).id) !== userId) return drop('not-private');
  const record = payload as Record<string, unknown>;
  const messageId = idOf(record.message_id);
  const { date } = record;
  if (messageId === undefined || typeof date !== 'number' || !Number.isFinite(date)) return drop('malformed');
  if (nowSeconds - date > MAX_UPDATE_AGE_SECONDS) return drop('stale');
  const changes = feedbackChanges(record.old_reaction, record.new_reaction);
  if (changes === null) return drop('malformed');
  if (changes.length === 0) return drop('not-feedback');
  return { kind: 'reaction', reaction: { updateId, chatId: userId, userId, messageId, changes, date } };
}

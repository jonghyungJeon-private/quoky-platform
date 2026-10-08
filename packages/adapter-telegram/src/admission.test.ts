import { describe, expect, it } from 'vitest';
import { admitTelegramUpdate, MAX_UPDATE_AGE_SECONDS } from './admission';
import { documentField, mediaUpdate, OWNER_ID, photoField, reactionUpdate, STRANGER_ID, textUpdate } from './test-support';

const OWNERS = new Set([String(OWNER_ID)]);
const NOW = 1_800_000_000;

function admit(update: unknown) {
  return admitTelegramUpdate(update, OWNERS, NOW);
}

describe('Telegram admission (ADR-0114 D2): owner private chats only, drop by default', () => {
  it("admits the owner's private text message with the owner's own chat", () => {
    expect(admit(textUpdate(7, '안녕', { date: NOW }))).toEqual({
      kind: 'admitted',
      message: { updateId: 7, chatId: String(OWNER_ID), userId: String(OWNER_ID), messageId: '70', text: '안녕', date: NOW },
    });
  });

  it.each([
    ['a non-owner in a private chat', textUpdate(1, 'hi', { from: STRANGER_ID, date: NOW }), 'not-owner'],
    ['a bot sender with an owner id', textUpdate(1, 'hi', { isBot: true, date: NOW }), 'not-owner'],
    ['the owner in a group', textUpdate(1, 'hi', { chatType: 'group', chatId: -100, date: NOW }), 'not-private'],
    ['the owner in a supergroup', textUpdate(1, 'hi', { chatType: 'supergroup', chatId: -1001, date: NOW }), 'not-private'],
    ['the owner in a channel', textUpdate(1, 'hi', { chatType: 'channel', chatId: -1002, date: NOW }), 'not-private'],
    ['a private chat that is not the owner’s own', textUpdate(1, 'hi', { chatId: STRANGER_ID, date: NOW }), 'not-private'],
  ])('drops %s', (_label, update, reason) => {
    expect(admit(update)).toEqual({ kind: 'dropped', updateId: 1, reason });
  });

  it("drops an old owner message as stale, naming the owner's own chat (for the one owner notice)", () => {
    expect(admit(textUpdate(1, '승인', { date: NOW - MAX_UPDATE_AGE_SECONDS - 1 }))).toEqual({
      kind: 'dropped',
      updateId: 1,
      reason: 'stale',
      ownerChatId: String(OWNER_ID),
    });
    // A stranger's old message is not-owner, never stale: nobody but the owner is ever told anything.
    expect(admit(textUpdate(1, 'x', { from: STRANGER_ID, date: NOW - 9999 }))).toEqual({ kind: 'dropped', updateId: 1, reason: 'not-owner' });
  });

  it.each([
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'inline_query',
    'chosen_inline_result',
    'callback_query',
    'message_reaction_count',
    'my_chat_member',
    'chat_member',
    'business_message',
  ])('drops a %s update even from the owner', (type) => {
    const message = (textUpdate(3, '승인', { date: NOW }) as { message: unknown }).message;
    expect(admit({ update_id: 3, [type]: message })).toEqual({ kind: 'dropped', updateId: 3, reason: 'update-type' });
  });

  it('drops an update carrying a message next to another payload', () => {
    const update = { ...textUpdate(4, 'x', { date: NOW }), edited_message: {} };
    expect(admit(update)).toMatchObject({ kind: 'dropped', reason: 'update-type' });
  });

  it.each([
    ['forward_origin user', { forward_origin: { type: 'user', date: NOW, sender_user: { id: 1, is_bot: false } } }],
    ['forward_origin hidden_user', { forward_origin: { type: 'hidden_user', date: NOW, sender_user_name: 'x' } }],
    ['forward_origin chat', { forward_origin: { type: 'chat', date: NOW, sender_chat: { id: -1, type: 'group' } } }],
    ['forward_origin channel', { forward_origin: { type: 'channel', date: NOW, chat: { id: -2, type: 'channel' }, message_id: 1 } }],
    ['legacy forward_from', { forward_from: { id: 1, is_bot: false }, forward_date: NOW }],
    ['legacy forward_from_chat', { forward_from_chat: { id: -2, type: 'channel' }, forward_date: NOW }],
    ['legacy forward_sender_name', { forward_sender_name: 'x', forward_date: NOW }],
    ['legacy forward_date alone', { forward_date: NOW }],
    ['via_bot (inline bot)', { via_bot: { id: 9, is_bot: true, first_name: 'b' } }],
  ])("drops the owner's %s message: someone else's text is never the owner's request", (_label, extra) => {
    const update = textUpdate(9, '승인', { date: NOW }) as { update_id: number; message: Record<string, unknown> };
    expect(admit({ update_id: 9, message: { ...update.message, ...extra } })).toEqual({ kind: 'dropped', updateId: 9, reason: 'forwarded' });
  });

  it('TG-2: drops an owner message with nothing to read (a location, contact, poll), naming the owner chat for the notice', () => {
    for (const extra of [{ location: { latitude: 1, longitude: 2 } }, { contact: { phone_number: 'x', first_name: 'y' } }, { poll: { id: 'p' } }, {}]) {
      expect(admit(mediaUpdate(5, extra, { date: NOW }))).toEqual({ kind: 'dropped', updateId: 5, reason: 'no-text', ownerChatId: String(OWNER_ID) });
    }
  });

  it('TG-2: a photo becomes one image source (the largest size within 8 MiB); its caption is the text', () => {
    const update = mediaUpdate(11, { ...photoField({ fileId: 's', size: 900 }, { fileId: 'm', size: 40_000 }, { fileId: 'l', size: 9 * 1024 * 1024 }), caption: '이 화면 봐 줘' }, { date: NOW });
    expect(admit(update)).toEqual({
      kind: 'admitted',
      message: {
        updateId: 11,
        chatId: String(OWNER_ID),
        userId: String(OWNER_ID),
        messageId: '110',
        text: '이 화면 봐 줘',
        date: NOW,
        attachments: [{ kind: 'file', fileId: 'm', name: 'photo.jpg', contentType: 'image/jpeg', size: 40_000 }],
      },
    });
  });

  it('TG-2: a photo whose every size is over the bound keeps the smallest (the intake refuses it from metadata)', () => {
    const big = 9 * 1024 * 1024;
    const admitted = admit(mediaUpdate(12, photoField({ fileId: 'a', size: big }, { fileId: 'b', size: big + 1 }), { date: NOW }));
    expect(admitted).toMatchObject({ kind: 'admitted', message: { text: '', attachments: [{ fileId: 'a', size: big }] } });
  });

  it('TG-2: a document keeps its name, MIME and size; an attachment-only message has empty text', () => {
    const admitted = admit(mediaUpdate(13, documentField('d1', 'build.log', 'text/plain', 2048), { date: NOW }));
    expect(admitted).toMatchObject({
      kind: 'admitted',
      message: { text: '', attachments: [{ kind: 'file', fileId: 'd1', name: 'build.log', contentType: 'text/plain', size: 2048 }] },
    });
    expect((admitted as { message: { mediaGroupId?: string } }).message.mediaGroupId).toBeUndefined();
  });

  it('TG-2: stickers, voice, audio, video, video notes and animations are unsupported sources, never files to fetch', () => {
    for (const [field, value] of [
      ['sticker', { file_id: 's', file_size: 10 }],
      ['voice', { file_id: 'v', mime_type: 'audio/ogg', file_size: 10 }],
      ['audio', { file_id: 'a', file_name: 'song.mp3', mime_type: 'audio/mpeg' }],
      ['video', { file_id: 'v2', mime_type: 'video/mp4' }],
      ['video_note', { file_id: 'vn' }],
    ] as const) {
      const admitted = admit(mediaUpdate(14, { [field]: value }, { date: NOW }));
      expect(admitted, field).toMatchObject({ kind: 'admitted', message: { attachments: [{ kind: 'unsupported-media' }] } });
      expect(JSON.stringify(admitted), field).not.toContain('file_id');
    }
    // An animation also sets `document` (Bot API backward compatibility): one unsupported animation, no document fetch.
    const animation = admit(mediaUpdate(15, { animation: { file_id: 'g', file_name: 'x.mp4', mime_type: 'video/mp4' }, ...documentField('g', 'x.mp4', 'video/mp4') }, { date: NOW }));
    expect(animation).toMatchObject({ kind: 'admitted', message: { attachments: [{ kind: 'unsupported-media', name: 'x.mp4' }] } });
    expect((animation as { message: { attachments: unknown[] } }).message.attachments).toHaveLength(1);
  });

  it('TG-2: an album part carries its media_group_id; a text message never does', () => {
    expect(admit(mediaUpdate(16, { ...photoField({ fileId: 'p', size: 10 }), media_group_id: 'g1' }, { date: NOW }))).toMatchObject({
      kind: 'admitted',
      message: { mediaGroupId: 'g1' },
    });
    expect(admit({ ...textUpdate(17, 'x', { date: NOW }), message: { ...(textUpdate(17, 'x', { date: NOW }) as { message: object }).message, media_group_id: 'g1' } })).toMatchObject({
      kind: 'admitted',
      message: { text: 'x' },
    });
  });

  it('TG-2: forwarded photos and files (and their captions) are still dropped; a stranger’s photo is never admitted', () => {
    const forwarded = mediaUpdate(18, { ...photoField({ fileId: 'p' }), caption: '승인', forward_origin: { type: 'user', date: NOW, sender_user: { id: 1, is_bot: false } } }, { date: NOW });
    expect(admit(forwarded)).toEqual({ kind: 'dropped', updateId: 18, reason: 'forwarded' });
    expect(admit(mediaUpdate(19, { ...documentField('d'), via_bot: { id: 9, is_bot: true } }, { date: NOW }))).toMatchObject({ reason: 'forwarded' });
    expect(admit(mediaUpdate(20, photoField({ fileId: 'p' }), { from: STRANGER_ID, date: NOW }))).toEqual({ kind: 'dropped', updateId: 20, reason: 'not-owner' });
    expect(admit(mediaUpdate(21, documentField('d'), { date: NOW - MAX_UPDATE_AGE_SECONDS - 1 }))).toMatchObject({ reason: 'stale' });
  });

  it('TG-2: malformed file fields drop the update as malformed (nothing is fetched)', () => {
    for (const extra of [{ photo: 'x' }, { photo: [] }, { photo: [{ width: 1 }] }, { document: { file_name: 'a.txt' } }, { document: null }, { sticker: 'x' }]) {
      expect(admit(mediaUpdate(22, extra, { date: NOW })), JSON.stringify(extra)).toEqual({ kind: 'dropped', updateId: 22, reason: 'malformed' });
    }
  });

  it('drops malformed entries without reading content', () => {
    expect(admit(null)).toEqual({ kind: 'dropped', reason: 'malformed' });
    expect(admit({ update_id: -1, message: {} })).toEqual({ kind: 'dropped', reason: 'malformed' });
    expect(admit({ update_id: 1.5 })).toEqual({ kind: 'dropped', reason: 'malformed' });
    expect(admit({ update_id: 2, message: 'x' })).toEqual({ kind: 'dropped', updateId: 2, reason: 'malformed' });
    // A string id is never coerced into an owner id.
    const stringId = textUpdate(6, 'x', { date: NOW }) as { update_id: number; message: Record<string, unknown> };
    expect(admit({ ...stringId, message: { ...stringId.message, from: { id: String(OWNER_ID), is_bot: false } } })).toMatchObject({
      reason: 'not-owner',
    });
  });

  it('with no owner ids configured, nobody is admitted', () => {
    expect(admitTelegramUpdate(textUpdate(8, 'hi', { date: NOW }), new Set(), NOW)).toMatchObject({ kind: 'dropped', reason: 'not-owner' });
  });
});

describe('Telegram reaction admission (TG-2, ADR-0098 D3): the owner’s 👍/👎 in their own private chat only', () => {
  const UP = '\u{1F44D}';
  const DOWN = '\u{1F44E}';

  it('admits the owner adding 👍 on a message in their own chat', () => {
    expect(admit(reactionUpdate(30, { date: NOW }))).toEqual({
      kind: 'reaction',
      reaction: { updateId: 30, chatId: String(OWNER_ID), userId: String(OWNER_ID), messageId: '1001', changes: [{ rating: 'POSITIVE', action: 'ADDED' }], date: NOW },
    });
  });

  it('turns the old and new lists into per-rating changes (switching 👍 to 👎 is one removal and one addition)', () => {
    expect(admit(reactionUpdate(31, { oldEmoji: [UP], newEmoji: [DOWN], date: NOW }))).toMatchObject({
      reaction: { changes: [{ rating: 'POSITIVE', action: 'REMOVED' }, { rating: 'NEGATIVE', action: 'ADDED' }] },
    });
    expect(admit(reactionUpdate(32, { oldEmoji: [DOWN], newEmoji: [], date: NOW }))).toMatchObject({
      reaction: { changes: [{ rating: 'NEGATIVE', action: 'REMOVED' }] },
    });
  });

  it.each([
    ['a stranger', reactionUpdate(40, { from: STRANGER_ID, date: NOW }), 'not-owner'],
    ['an anonymous reaction (no user)', reactionUpdate(40, { from: null, chatId: OWNER_ID, date: NOW }), 'not-owner'],
    ['a reaction on behalf of a chat', reactionUpdate(40, { date: NOW, extra: { actor_chat: { id: -5, type: 'channel' } } }), 'not-owner'],
    ['a bot', reactionUpdate(40, { isBot: true, date: NOW }), 'not-owner'],
    ['the owner in a group', reactionUpdate(40, { chatType: 'group', chatId: -100, date: NOW }), 'not-private'],
    ['the owner in another private chat', reactionUpdate(40, { chatId: STRANGER_ID, date: NOW }), 'not-private'],
    ['another emoji', reactionUpdate(40, { newEmoji: ['\u{1F525}'], date: NOW }), 'not-feedback'],
    ['no change of a rating', reactionUpdate(40, { oldEmoji: [UP], newEmoji: [UP, '\u{1F525}'], date: NOW }), 'not-feedback'],
    ['a stale reaction', reactionUpdate(40, { date: NOW - MAX_UPDATE_AGE_SECONDS - 1 }), 'stale'],
    ['a malformed reaction list', reactionUpdate(40, { date: NOW, extra: { new_reaction: 'x' } }), 'malformed'],
  ])('drops %s silently (no owner notice)', (_label, update, reason) => {
    expect(admit(update)).toEqual({ kind: 'dropped', updateId: 40, reason });
  });

  it('a custom or paid reaction never counts', () => {
    const update = reactionUpdate(41, { date: NOW, extra: { new_reaction: [{ type: 'custom_emoji', custom_emoji_id: '1' }, { type: 'paid' }] } });
    expect(admit(update)).toEqual({ kind: 'dropped', updateId: 41, reason: 'not-feedback' });
  });
});

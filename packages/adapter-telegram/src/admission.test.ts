import { describe, expect, it } from 'vitest';
import { admitTelegramUpdate, MAX_UPDATE_AGE_SECONDS } from './admission';
import { OWNER_ID, STRANGER_ID, textUpdate } from './test-support';

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
    ['an old owner message', textUpdate(1, '승인', { date: NOW - MAX_UPDATE_AGE_SECONDS - 1 }), 'stale'],
  ])('drops %s', (_label, update, reason) => {
    expect(admit(update)).toEqual({ kind: 'dropped', updateId: 1, reason });
  });

  it.each([
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'inline_query',
    'chosen_inline_result',
    'callback_query',
    'message_reaction',
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

  it('drops an owner message without text (sticker, photo, file): nothing to download in TG-1', () => {
    const update = textUpdate(5, 'unused', { date: NOW }) as { update_id: number; message: Record<string, unknown> };
    const { text: _text, ...rest } = update.message;
    for (const extra of [{ sticker: { file_id: 'f' } }, { photo: [{ file_id: 'p', file_size: 10 }] }, { document: { file_id: 'd' } }]) {
      expect(admit({ update_id: 5, message: { ...rest, ...extra } })).toEqual({ kind: 'dropped', updateId: 5, reason: 'no-text' });
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

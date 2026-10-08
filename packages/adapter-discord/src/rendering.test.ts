import { describe, expect, it } from 'vitest';
import {
  composeDailyBrief,
  conversationRefOf,
  messageContent,
  messageLink,
  outboundMessage,
  placeCalendarSpan,
  platformNote,
  renderCalendarEvents,
  untrustedText,
} from '@quoky/core';
import { DISCORD_MARKUP, renderDiscordContent, renderNotificationForDiscord, renderOutboundForDiscord } from './rendering';

const CTX = { platform: 'discord', channelId: 'c', userId: 'u' };
const SAMPLE = '@everyone @Here <@123> <@!7> <@&42> <#456> [x](https://e.test) *b* _i_ ~~s~~ `c` | > q \\ <https://y.test>';

describe('Discord markup of neutral content (PLT-0)', () => {
  it('neutralizes untrusted text per guard', () => {
    // markup: every Markdown/quote character backslash-escaped, then a zero-width space after each `@` and `<`.
    expect(DISCORD_MARKUP.untrusted('*a* _b_ @c <d> [e] `f` |g| ~h~ >i \\j', 'markup')).toBe(
      '\\*a\\* \\_b\\_ @​c <​d\\> \\[e\\] \\`f\\` \\|g\\| \\~h\\~ \\>i \\\\j',
    );
    // mentions: only the broadcast mentions (any case) and raw `<@` mention syntax.
    expect(DISCORD_MARKUP.untrusted(SAMPLE, 'mentions')).toBe(
      '@​everyone @​Here <​@123> <​@!7> <​@&42> <#456> [x](https://e.test) *b* _i_ ~~s~~ `c` | > q \\ <https://y.test>',
    );
    // handles: every `@`, nothing else.
    expect(DISCORD_MARKUP.untrusted('a@b <@1> *x*', 'handles')).toBe('a@​b <@​1> *x*');
  });

  it('writes links without embeds, conversation references and the command-prefix note', () => {
    expect(DISCORD_MARKUP.link('https://e.test/a_b')).toBe('<https://e.test/a_b>');
    const labels = { direct: '이 DM', channel: '승인을 요청한 채널' };
    const guild = { platform: 'discord', spaceId: 'g', channelId: '900', userId: 'u' };
    expect(DISCORD_MARKUP.conversation(conversationRefOf(guild, labels))).toBe('<#900>');
    expect(DISCORD_MARKUP.conversation(conversationRefOf({ ...guild, threadId: '901' }, labels))).toBe('<#901>');
    // A Discord DM (by the adapter flag, or an older context without a guild) and an unreferenceable id: the label.
    expect(DISCORD_MARKUP.conversation(conversationRefOf({ platform: 'discord', channelId: 'd', userId: 'u', direct: true }, labels))).toBe('이 DM');
    expect(DISCORD_MARKUP.conversation(conversationRefOf({ platform: 'discord', channelId: 'd', userId: 'u' }, labels))).toBe('이 DM');
    expect(DISCORD_MARKUP.conversation(conversationRefOf({ ...guild, channelId: 'c1><@everyone' }, labels))).toBe('승인을 요청한 채널');
    // Another platform's conversation is named with that platform: never Discord syntax, never "이 DM".
    expect(DISCORD_MARKUP.conversation(conversationRefOf({ platform: 'telegram', channelId: '42', userId: 'u', direct: true }, labels))).toBe('Telegram 개인 대화');
    expect(DISCORD_MARKUP.conversation(conversationRefOf({ platform: 'telegram', spaceId: 's', channelId: '42', userId: 'u' }, labels))).toBe('Telegram 대화방');
    expect(DISCORD_MARKUP.platformNote('command-prefix')).toContain('Discord에서는 "/"로 시작하면 명령 선택 창이 열리니');
    expect(
      renderDiscordContent(messageContent('see ', untrustedText('*t*'), ' ', messageLink('https://e.test'), ' in ', conversationRefOf({ platform: 'discord', spaceId: 'g', channelId: '9', userId: 'u' }, { direct: 'DM', channel: '채널' }), platformNote('command-prefix'))),
    ).toBe(`see \\*t\\* <https://e.test> in <#9>${DISCORD_MARKUP.platformNote('command-prefix')}`);
  });

  it('renders an outbound message from its content (tables only for a model reply) and a notification likewise', () => {
    const body = messageContent('| a |\n|---|\n| ', untrustedText('@x'), ' |');
    const message = outboundMessage(CTX, body);
    expect(message.text).toBe('| a |\n|---|\n| @x |');
    expect(renderOutboundForDiscord(message)).toBe('| a |\n|---|\n| @​x |');
    expect(renderOutboundForDiscord({ ...message, format: 'model-reply' })).not.toContain('|---|');
    expect(renderOutboundForDiscord({ text: 'plain <#1>' })).toBe('plain <#1>');
    expect(renderNotificationForDiscord({ text: message.text, content: body })).toBe('| a |\n|---|\n| @​x |');
    expect(renderNotificationForDiscord({ text: 'only text' })).toBe('only text');
  });
});

describe('Discord markup of the morning brief calendar section (ADR-0117 D1, BRF-1)', () => {
  const event = { id: 'e', start: '2026-10-02T00:00:00.000Z', end: '2026-10-02T01:00:00.000Z', allDay: false, status: 'confirmed' as const, calendarName: 'primary' };
  const title = '@everyone *회의* <@123>';
  const brief = (calendar: Parameters<typeof composeDailyBrief>[0]['calendar']) =>
    renderDiscordContent(composeDailyBrief({ now: '2026-10-01T23:00:00.000Z', timeZone: 'Asia/Seoul', reminders: [], workItems: [], ...(calendar === undefined ? {} : { calendar }) }));

  it('renders an event title exactly as the schedule reply does (the same guarded line)', () => {
    const text = brief({ events: [{ ...event, title }], limit: 50 });
    const window = placeCalendarSpan({ kind: 'day', offset: 0 }, '2026-10-01T23:00:00.000Z', 'Asia/Seoul');
    if (window === undefined) throw new Error('no window');
    const reply = renderDiscordContent(renderCalendarEvents(window, [{ ...event, title }], { timeZone: 'Asia/Seoul', now: '2026-10-01T23:00:00.000Z', language: 'ko', limit: 50 }));
    const line = text.split('\n').find((candidate) => candidate.startsWith('- 09:00'));
    expect(line).toBe(`- 09:00–10:00 ${DISCORD_MARKUP.untrusted(title, 'markup')}`);
    expect(reply.split('\n')).toContain(line);
    expect(text).not.toContain('@everyone');
  });

  it('without a calendar the Discord text has no calendar section', () => {
    expect(brief(undefined)).not.toContain('오늘 일정');
  });
});

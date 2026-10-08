import { describe, expect, it } from 'vitest';
import { conversationRef, messageContent, messageLink, outboundMessage, platformNote, untrustedText } from '@quoky/core';
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
    expect(DISCORD_MARKUP.conversation('900')).toBe('<#900>');
    expect(DISCORD_MARKUP.platformNote('command-prefix')).toContain('Discord에서는 "/"로 시작하면 명령 선택 창이 열리니');
    expect(
      renderDiscordContent(messageContent('see ', untrustedText('*t*'), ' ', messageLink('https://e.test'), ' in ', conversationRef('9'), platformNote('command-prefix'))),
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

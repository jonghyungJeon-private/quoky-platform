import { describe, expect, it } from 'vitest';
import {
  clipMessage,
  conversationRefOf,
  fitLines,
  messageContent,
  messageLink,
  outboundMessage,
  platformNote,
  plainTextOf,
  takeLines,
  untrustedText,
} from '@quoky/core';
import type { UntrustedTextGuard } from '@quoky/core';
import { escapeTelegramHtml, renderOutboundForTelegram, renderTelegramContent, TELEGRAM_MARKUP } from './rendering';

const LABELS = { direct: '이 DM', channel: '승인을 요청한 채널' };
/** Discord, Markdown, HTML and Telegram entity syntax at once. */
const HOSTILE = '@everyone <@123> <#456> [x](https://e.test) *b* _i_ `c` <b>bold</b> <a href="tg://user?id=1">u</a> &amp; /start #tag';

describe('Telegram markup (ADR-0114 D7): plain text, no parse mode, every node verbatim', () => {
  it.each<UntrustedTextGuard>(['markup', 'mentions', 'handles'])('untrusted text under the %s guard is delivered verbatim', (guard) => {
    expect(TELEGRAM_MARKUP.untrusted(HOSTILE, guard)).toBe(HOSTILE);
  });

  it('a link is the bare URL (the preview is disabled on send), a platform note is empty', () => {
    expect(TELEGRAM_MARKUP.link('https://e.test/a_b?q=<x>')).toBe('https://e.test/a_b?q=<x>');
    expect(TELEGRAM_MARKUP.platformNote('command-prefix')).toBe('');
  });

  it('a Telegram conversation is its label; a foreign conversation is a neutral name, never its native syntax', () => {
    const telegram = { platform: 'telegram', channelId: '5550001', userId: '5550001', direct: true };
    expect(TELEGRAM_MARKUP.conversation(conversationRefOf(telegram, LABELS))).toBe('이 DM');
    // A Discord channel referenced from Telegram: no `<#id>`, no `#id`, no id at all.
    const discordChannel = { platform: 'discord', spaceId: 'g', channelId: '123456789012345678', userId: 'u', direct: false };
    const rendered = TELEGRAM_MARKUP.conversation(conversationRefOf(discordChannel, LABELS));
    expect(rendered).toBe('Discord 대화방');
    expect(rendered).not.toMatch(/<#|#\d|123456789012345678/);
    expect(TELEGRAM_MARKUP.conversation(conversationRefOf({ platform: 'discord', channelId: 'd', userId: 'u', direct: true }, LABELS))).toBe(
      'Discord 개인 대화',
    );
  });

  it('string nodes, every span and every budget node render verbatim (budgets measured on the Telegram text)', () => {
    const fence = '````\n' + HOSTILE + '\n````';
    const content = messageContent(
      `**제목** \`code\` ${fence}\n`,
      untrustedText(HOSTILE),
      ' ',
      messageLink('https://e.test'),
      ' ',
      conversationRefOf({ platform: 'discord', spaceId: 'g', channelId: '900', userId: 'u' }, LABELS),
      platformNote('command-prefix'),
      '\n',
      clipMessage(untrustedText('가'.repeat(30)), 10, 'code-points'),
      '\n',
      fitLines([{ content: untrustedText('<b>a</b>') }, { content: 'b', droppable: true }], 100),
      '\n',
      takeLines({ unit: 'utf16', maxChars: 100, baseChars: 0, head: ['목록'], tail: [], lines: [{ content: untrustedText('*x*'), item: true }] }),
    );
    expect(renderTelegramContent(content)).toBe(
      `**제목** \`code\` ${fence}\n${HOSTILE} https://e.test Discord 대화방\n${'가'.repeat(9)}…\n<b>a</b>\nb\n목록\n*x*`,
    );
    // The Telegram rendering IS the plain rendering except for conversation references (plain text shows `#id`).
    expect(plainTextOf(content)).toContain('#900');
  });

  it('an outbound message renders from its content, else its text; a model reply is never adapted', () => {
    const ctx = { platform: 'telegram', channelId: '1', userId: '1', direct: true };
    const message = outboundMessage(ctx, messageContent('in ', conversationRefOf(ctx, LABELS)));
    expect(renderOutboundForTelegram(message)).toBe('in 이 DM');
    const table = '| a |\n|---|\n| b |';
    expect(renderOutboundForTelegram({ text: table, format: 'model-reply' } as never)).toBe(table);
  });

  it('HTML escaping (preview parts only) covers &, <, > and "', () => {
    expect(escapeTelegramHtml('<a href="x">&amp;</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;');
  });
});

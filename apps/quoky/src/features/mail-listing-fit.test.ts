import { describe, expect, it } from 'vitest';
import { renderOutboundForDiscord } from '@quoky/adapter-discord';
import {
  MAIL_REPLY_MAX_CHARS,
  createMailTurnHandler,
  type ConversationContext,
  type MailMessageSummary,
  type MailReader,
  type TurnHandlerContext,
} from '@quoky/core';

// Review P2 (Codex) / CA P3-2: on Discord the old caps let escaping push entries 6–10 out of the message while
// `10번 메일 요약해줘` still summarized hidden entry 10. With the resized caps every listed entry is displayed on every
// platform, so a number always names an entry the owner saw.

const NOW = '2026-10-08T01:00:00.000Z';
const DM: ConversationContext = { platform: 'discord', channelId: 'dm', userId: 'u', direct: true };
/** Every character is one Discord escapes (Markdown characters, `@`, `<`). */
const HOSTILE = '*_~`|>[]@<\\'.repeat(40);

function message(index: number): MailMessageSummary {
  return {
    id: `id${index}`,
    sender: { name: `${index}${HOSTILE}`, address: '' },
    subject: `${index}${HOSTILE}`,
    receivedAt: '2025-12-30T05:00:00.000Z',
    snippet: HOSTILE,
    unread: true,
  };
}

function ctx(text: string): TurnHandlerContext {
  return {
    message: { id: 'm', context: DM, text, receivedAt: NOW },
    session: { id: 's' },
    actor: { id: 'a' },
    now: NOW,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  } as unknown as TurnHandlerContext;
}

describe('mail listing on the real platform markups (review P2 / P3-2)', () => {
  it('Discord escaping of long hostile fields keeps all 10 entries in the message, and every number maps to a shown entry', async () => {
    const gets: string[] = [];
    const reader: MailReader = {
      source: 'mail',
      readOnly: true,
      search: async () => ({ messages: Array.from({ length: 10 }, (_, i) => message(i + 1)), matched: 100, matchedIsLowerBound: true }),
      getMessage: async (id) => {
        gets.push(id);
        return { ...message(Number(id.slice(2))), id, bodyText: '본문', bodyTruncated: false };
      },
    };
    const handler = createMailTurnHandler({ reader, timeZone: 'Asia/Seoul' });
    for (const query of ['김철수 메일 찾아줘', 'find emails from Alice']) {
      const listing = await handler.handle(ctx(query));
      if (listing === null || !('reply' in listing)) throw new Error('expected a listing reply');
      const discord = renderOutboundForDiscord(listing.reply);
      const telegram = listing.reply.text; // Telegram renders untrusted spans verbatim, as the plain text does.
      for (const rendered of [discord, telegram]) {
        expect(Array.from(rendered).length).toBeLessThanOrEqual(MAIL_REPLY_MAX_CHARS);
        for (let n = 1; n <= 10; n += 1) expect(rendered, `entry ${n}`).toMatch(new RegExp(`^${n}\\. `, 'm'));
      }
      expect(discord).toContain('\\*\\_\\~'); // the escaping really happened
    }
    const tenth = await handler.handle(ctx('10번 메일 요약해줘'));
    expect(tenth?.kind).toBe('summarize');
    expect(gets).toEqual(['id10']);
    const outside = await handler.handle(ctx('11번 메일 요약해줘'));
    expect(outside !== null && 'reply' in outside ? outside.reply.text : '').toContain('"1번 메일 요약해줘"');
    expect(gets).toEqual(['id10']);
  });
});

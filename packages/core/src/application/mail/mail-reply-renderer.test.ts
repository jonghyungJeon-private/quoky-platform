import { describe, expect, it } from 'vitest';
import type { MessageMarkup } from '../../ports/message-markup.port';
import type { MailMessageSummary } from '../../ports/mail-reader.port';
import { PLAIN_TEXT_MARKUP, renderMessageContent } from '../message-rendering';
import { MAIL_REPLY_MAX_CHARS, MAIL_REPLY_MAX_ENTRIES, renderMailListing } from './mail-reply-renderer';

/** A markup that writes two characters for every untrusted character: the worst case of any platform in use. */
const DOUBLING_MARKUP: MessageMarkup = {
  untrusted: (text) => Array.from(text, (char) => `\\${char}`).join(''),
  link: (url) => url,
  conversation: (ref) => ref.label,
  platformNote: () => '',
};

const NOW = '2026-10-08T01:00:00.000Z';
const LONG = '*_~`|>[]@<'.repeat(30);

function worst(index: number): MailMessageSummary {
  return {
    id: `w${index}`,
    sender: { name: LONG, address: '' },
    subject: LONG,
    // Last year: the longest date label; unread: a today/from listing adds the unread marker.
    receivedAt: '2025-12-30T05:00:00.000Z',
    snippet: LONG,
    unread: true,
  };
}

describe('mail listing size (review P2 / P3-2): every displayed number is an entry the owner saw', () => {
  it.each(['ko', 'en'] as const)('%s: 10 worst-case entries fit even when every untrusted character renders as two', (language) => {
    const messages = Array.from({ length: MAIL_REPLY_MAX_ENTRIES }, (_, index) => worst(index));
    const body = renderMailListing(
      { unread: false, today: true, from: LONG },
      { messages, matched: 100, matchedIsLowerBound: true },
      { timeZone: 'America/Argentina/ComodRivadavia', now: NOW, language },
    );
    for (const markup of [DOUBLING_MARKUP, PLAIN_TEXT_MARKUP]) {
      const text = renderMessageContent(body, markup);
      expect(Array.from(text).length).toBeLessThanOrEqual(MAIL_REPLY_MAX_CHARS);
      for (let n = 1; n <= MAIL_REPLY_MAX_ENTRIES; n += 1) expect(text, `entry ${n}`).toMatch(new RegExp(`^${n}\\. `, 'm'));
      // Only the 90 matches beyond the list are counted as omitted — never a displayed-and-dropped entry.
      expect(text).toMatch(language === 'en' ? /…and 90\+ more/ : /…외 90건 이상/);
    }
  });
});

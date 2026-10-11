import { describe, expect, it } from 'vitest';
import type { MessageMarkup } from '../../ports/message-markup.port';
import type { DriveFileSummary } from '../../ports/drive-reader.port';
import { PLAIN_TEXT_MARKUP, renderMessageContent } from '../message-rendering';
import { DRIVE_REPLY_MAX_CHARS, DRIVE_REPLY_MAX_ENTRIES, renderDriveListing } from './drive-reply-renderer';

/** A markup that writes two characters for every untrusted character: the worst case of any platform in use. */
const DOUBLING_MARKUP: MessageMarkup = {
  untrusted: (text) => Array.from(text, (char) => `\\${char}`).join(''),
  link: (url) => url,
  conversation: (ref) => ref.label,
  platformNote: () => '',
};

const NOW = '2026-10-08T01:00:00.000Z';
const LONG = '*_~`|>[]@<'.repeat(30);

function worst(index: number): DriveFileSummary {
  // Last year: the longest date label; a presentation: the longest kind label.
  return { id: `w${index}`, name: LONG, kind: 'presentation', modifiedAt: '2025-12-30T05:00:00.000Z' };
}

describe('Drive listing size (the GML-1 review P2 rule): every displayed number is an entry the owner saw', () => {
  it.each(['ko', 'en'] as const)('%s: 10 worst-case entries fit even when every untrusted character renders as two', (language) => {
    const files = Array.from({ length: DRIVE_REPLY_MAX_ENTRIES }, (_, index) => worst(index));
    for (const filter of [{ kind: 'search', name: LONG } as const, { kind: 'recent' } as const]) {
      const body = renderDriveListing(
        filter,
        { files, matched: 100, matchedIsLowerBound: true },
        { timeZone: 'America/Argentina/ComodRivadavia', now: NOW, language },
      );
      for (const markup of [DOUBLING_MARKUP, PLAIN_TEXT_MARKUP]) {
        const text = renderMessageContent(body, markup);
        expect(Array.from(text).length).toBeLessThanOrEqual(DRIVE_REPLY_MAX_CHARS);
        for (let n = 1; n <= DRIVE_REPLY_MAX_ENTRIES; n += 1) expect(text, `entry ${n}`).toMatch(new RegExp(`^${n}\\. `, 'm'));
        expect(text).toMatch(language === 'en' ? /…and 90\+ more/ : /…외 90건 이상/);
      }
    }
  });
});

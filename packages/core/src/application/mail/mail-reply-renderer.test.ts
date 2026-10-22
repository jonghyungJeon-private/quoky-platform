import { describe, expect, it } from 'vitest';
import type { MessageMarkup } from '../../ports/message-markup.port';
import type { MailMessageSummary } from '../../ports/mail-reader.port';
import { PLAIN_TEXT_MARKUP, renderMessageContent } from '../message-rendering';
import { MAIL_REPLY_MAX_CHARS, MAIL_REPLY_MAX_ENTRIES, renderMailHistoryNote, renderMailListing } from './mail-reply-renderer';

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

describe('mail history note (owner DM 2026-10-22)', () => {
  it('says structurally what was shown: scope and count, or the picked number; never the sender the owner named', () => {
    expect(renderMailHistoryNote('ko', 'listed', { kind: 'listing', filter: { unread: false, today: true }, count: 3 })).toBe(
      "[Quoky가 위에서 '오늘 받은 메일' 목록 3건을 보여드림 — 메일 내용은 기록하지 않음]",
    );
    const fromNamed = renderMailHistoryNote('ko', 'listed', { kind: 'listing', filter: { unread: true, today: false, from: '김철수' }, count: 2 });
    expect(fromNamed).toBe("[Quoky가 위에서 '말씀하신 보낸 사람의 안 읽은 메일' 목록 2건을 보여드림 — 메일 내용은 기록하지 않음]");
    expect(fromNamed).not.toContain('김철수');
    const period = renderMailHistoryNote('ko', 'listed', { kind: 'listing', filter: { unread: false, today: false, period: { ko: '지난주', en: 'last week' } }, count: 0 });
    expect(period).toContain("'지난주 받은 메일' 목록 0건");
    expect(renderMailHistoryNote('ko', 'listed', { kind: 'pick', index: 3 })).toBe(
      '[Quoky가 위에서 마지막 메일 목록의 3번 메일(보낸 사람·제목·날짜)을 보여드림 — 메일 내용은 기록하지 않음]',
    );
    const en = renderMailHistoryNote('en', 'listed', { kind: 'listing', filter: { unread: true, today: false, from: 'kim@example.com' }, count: 1 });
    expect(en).toBe("[Quoky showed the User a list of 1 email ('unread mail from the sender the User named') just above — mail details are not kept in this history.]");
    expect(en).not.toContain('kim@example.com');
    // Without a shape, and for the other kinds: unchanged.
    expect(renderMailHistoryNote('ko', 'listed')).toBe('[메일 목록 응답 — 메일 내용은 대화 기록에 남기지 않아요.]');
    expect(renderMailHistoryNote('ko', 'not-read')).toBe('[메일 요청에 안내만 함 — 메일은 읽지 않았어요.]');
  });
});

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
  const listing = (filter: Parameters<typeof renderMailListing>[0], matched: number, shown = matched, matchedIsLowerBound = false) =>
    ({ kind: 'listing', filter, result: { matched, matchedIsLowerBound }, shown }) as const;

  it('keeps the scope and the count the header printed; a partial listing says only its first part was listed', () => {
    expect(renderMailHistoryNote('ko', 'listed', listing({ unread: false, today: true }, 3))).toBe(
      "[Quoky가 위에서 '오늘 받은 메일' 3건 목록을 보여드림 — 메일 내용은 기록하지 않음]",
    );
    expect(renderMailHistoryNote('ko', 'listed', listing({ unread: false, today: false, period: { ko: '지난주', en: 'last week' } }, 0))).toBe(
      "[Quoky가 위에서 '지난주 받은 메일' 0건 목록을 보여드림 — 메일 내용은 기록하지 않음]",
    );
    // CA S3: the header's count ("N건 이상" for a lower bound), and the cut is marked.
    expect(renderMailHistoryNote('ko', 'listed', listing({ unread: true, today: false }, 25, 25, true))).toBe(
      "[Quoky가 위에서 '안 읽은 메일' 25건 이상 목록을 보여드림 (앞부분만 표시) — 메일 내용은 기록하지 않음]",
    );
    expect(renderMailHistoryNote('en', 'listed', listing({ unread: true, today: false }, 12, 12))).toBe(
      "[Quoky showed the User a list of 12 messages ('unread mail') just above (only the first part listed) — mail details are not kept in this history.]",
    );
  });

  it('a sender filter is content-matching: neither the sender nor a count is kept, and a hit and a miss read the same (CA W1)', () => {
    const hit = renderMailHistoryNote('ko', 'listed', listing({ unread: true, today: false, from: '김철수' }, 2));
    expect(hit).toBe("[Quoky가 위에서 '안 읽은 메일' 중 말씀하신 보낸 사람 조건에 맞는 결과를 보여드림 — 메일 내용은 기록하지 않음]");
    expect(renderMailHistoryNote('ko', 'listed', listing({ unread: true, today: false, from: '김철수' }, 0))).toBe(hit);
    expect(hit).not.toContain('김철수');
    expect(hit).not.toMatch(/\d+건/u);
    const en = renderMailHistoryNote('en', 'listed', listing({ unread: false, today: false, from: 'kim@example.com' }, 1));
    expect(en).toBe("[Quoky showed the User the 'mail' results matching the sender the User named just above — mail details are not kept in this history.]");
  });

  it('a pick names only the number (KO and EN); without a shape, and for the other kinds, the fixed notes', () => {
    expect(renderMailHistoryNote('ko', 'listed', { kind: 'pick', index: 3 })).toBe(
      '[Quoky가 위에서 마지막 메일 목록의 3번 메일(보낸 사람·제목·날짜)을 보여드림 — 메일 내용은 기록하지 않음]',
    );
    expect(renderMailHistoryNote('en', 'listed', { kind: 'pick', index: 3 })).toBe(
      '[Quoky showed the User the sender, subject and date of email 3 of the last list just above — mail details are not kept in this history.]',
    );
    expect(renderMailHistoryNote('ko', 'listed')).toBe('[메일 목록 응답 — 메일 내용은 대화 기록에 남기지 않아요.]');
    expect(renderMailHistoryNote('ko', 'not-read')).toBe('[메일 요청에 안내만 함 — 메일은 읽지 않았어요.]');
  });
});

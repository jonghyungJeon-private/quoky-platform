import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConnectorQueryError } from './connector-query';
import {
  MAIL_LISTING_MAX_ENTRIES,
  boundMailLine,
  isValidMailMessageId,
  parseMailSearchQuery,
} from './mail-reader.port';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorQueryError);
    return (error as ConnectorQueryError).reason;
  }
  return undefined;
}

describe('MailReader port (ADR-0118 D2)', () => {
  it('validates and bounds a search: zoned instants only, a one-line sender of 1..100 characters, limit clamped to 10', () => {
    expect(parseMailSearchQuery({ unreadOnly: true })).toEqual({ unreadOnly: true, limit: MAIL_LISTING_MAX_ENTRIES });
    expect(parseMailSearchQuery({ receivedAfter: '2026-10-08T00:00:00+09:00', from: '  김철수  ', limit: 50 })).toEqual({
      unreadOnly: false,
      receivedAfter: '2026-10-07T15:00:00.000Z',
      receivedAfterMs: Date.parse('2026-10-07T15:00:00.000Z'),
      from: '김철수',
      limit: 10,
    });
    expect(reasonOf(() => parseMailSearchQuery({ receivedAfter: '2026-10-08T00:00:00' }))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseMailSearchQuery({ from: ' ' }))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseMailSearchQuery({ from: 'a\nb' }))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseMailSearchQuery({ from: 'x'.repeat(101) }))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseMailSearchQuery({ limit: 0 }))).toBe('UNSUPPORTED_QUERY');
  });

  it('bounds untrusted single-line text and validates opaque ids', () => {
    expect(boundMailLine('a\u0000b c​d\n e', 100)).toBe('a b cd e');
    expect(boundMailLine('가'.repeat(10), 5)).toBe('가가가가…');
    expect(boundMailLine(42, 5)).toBe('');
    expect(isValidMailMessageId('18c2f0a1b2c3d4e5')).toBe(true);
    for (const id of ['', '../x', 'a b', 'x'.repeat(129), 7]) expect(isValidMailMessageId(id)).toBe(false);
  });

  it('declares no write method: the port is search and get only', () => {
    const source = readFileSync(new URL('./mail-reader.port.ts', import.meta.url), 'utf8');
    const reader = source.slice(source.indexOf('export interface MailReader {'), source.indexOf('export interface ParsedMailSearchQuery'));
    const methods = [...reader.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]);
    expect(methods).toEqual(['search', 'getMessage']);
  });
});

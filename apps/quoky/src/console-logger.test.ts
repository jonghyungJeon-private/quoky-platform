import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from './console-logger';
import { continueAs, currentCorrelation, newCorrelationId, runWithCorrelation } from './correlation-context';
import { isoWithOffset, localDateKey } from './security/iso-time';

/** ISO-8601 with milliseconds and an explicit numeric offset (never a bare `Z`). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;
const FIXED = new Date('2026-10-13T00:35:12.345Z');

afterEach(() => vi.restoreAllMocks());

function capture(): string[] {
  const lines: string[] = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  }
  return lines;
}

describe('isoWithOffset (ADR-0121 S0, MSIT ⑤-2)', () => {
  it('renders local time with a numeric offset that denotes the same instant', () => {
    const text = isoWithOffset(FIXED);
    expect(text).toMatch(ISO_WITH_OFFSET);
    expect(new Date(text).getTime()).toBe(FIXED.getTime());
    expect(text.startsWith(localDateKey(FIXED))).toBe(true);
  });
});

describe('ConsoleLogger timestamps and correlation ids (ADR-0121 S0)', () => {
  it('prefixes every line with an ISO-8601 timestamp with offset and keeps the [namespace] message key=value shape', () => {
    const lines = capture();
    const logger = new ConsoleLogger('quoky', () => FIXED);
    logger.info('started', { count: 2, skipped: undefined });
    logger.warn('slow');
    logger.error('failed', { code: 'X' });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const [stamp] = line.split(' ');
      expect(stamp).toMatch(ISO_WITH_OFFSET);
      expect(new Date(stamp ?? '').getTime()).toBe(FIXED.getTime());
    }
    expect(lines[0]).toMatch(/ \[quoky\] started count=2$/);
    expect(lines[1]).toMatch(/ \[quoky\] slow$/);
    expect(lines[2]).toMatch(/ \[quoky\] failed code=X$/);
  });

  it('appends the turn correlation id inside a context, and none outside', async () => {
    const lines = capture();
    const logger = new ConsoleLogger('turn', () => FIXED);
    const cid = newCorrelationId();
    await runWithCorrelation(
      'owner-turn',
      async () => {
        await Promise.resolve();
        expect(currentCorrelation()).toEqual({ cid, initiator: 'owner-turn' });
        logger.info('handled', { stage: 'inbound' });
      },
      cid,
    );
    logger.info('idle');
    expect(cid).toMatch(/^[0-9a-f]{16}$/);
    expect(lines[0]).toMatch(new RegExp(` \\[turn\\] handled stage=inbound cid=${cid}$`));
    expect(lines[1]).not.toContain('cid=');
    expect(currentCorrelation()).toBeUndefined();
  });

  it('an inbound turn becomes an owner turn past the gate, keeping its cid', async () => {
    const cid = newCorrelationId();
    const seen = await runWithCorrelation(
      'inbound',
      async () => {
        const before = currentCorrelation();
        await Promise.resolve();
        const after = await continueAs('owner-turn', async () => currentCorrelation());
        return { before, after, outer: currentCorrelation() };
      },
      cid,
    );
    expect(seen.before).toEqual({ cid, initiator: 'inbound' });
    expect(seen.after).toEqual({ cid, initiator: 'owner-turn' });
    expect(seen.outer).toEqual({ cid, initiator: 'inbound' });
    expect(continueAs('reminder', () => currentCorrelation())?.initiator).toBe('reminder');
  });

  it('keeps the existing redaction: a token-shaped value never reaches the console', () => {
    const lines = capture();
    // Built from fragments so no token-shaped literal exists in the source.
    const token = ['gh', 'p_'].join('') + 'Ab3'.repeat(12);
    const telegram = ['12345', '6789'].join('') + ':' + 'Zx9_'.repeat(9);
    new ConsoleLogger('quoky', () => FIXED).error('request failed', { detail: `bad ${token}`, path: `/bot${telegram}/getMe` });
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).not.toContain(telegram);
    expect(lines[0]).toContain('[REDACTED_TOKEN]');
  });
});

import { describe, expect, it } from 'vitest';
import { guardShownListingDenials, nlSpanRequestsOfferedSource } from './honest-chat';
import { nlOwnerStatedRange } from './owner-period';
import { validateSelection, type NlValidationContext } from './selection-validator';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0121 A5-S3 review round 1: the catalog aliases added for the grant producer (`pull request`, `repository` for GitHub,
// `meeting` for the calendar) are also read by the honest-chat guards, the owner-period reader and the span-request check.
// These tests pin that the new aliases change nothing there except the intended English `meeting` -> `timedOnly` canonicalisation.

const github = { entry: NL_WAVE1_ENTRIES['github.items'], args: {} };
const calendar = { entry: NL_WAVE1_ENTRIES['calendar.events'], args: { range: 'tomorrow' } };
const OFFERED = [NL_WAVE1_ENTRIES['github.items'], NL_WAVE1_ENTRIES['calendar.events'], NL_WAVE1_ENTRIES['mail.list']];

describe('A5-S3 aliases in honest-chat (substring match, chat-layer.ts live)', () => {
  it('"report" while a GitHub listing is shown is not a GitHub reference (the `repo` alias is not in the catalog)', () => {
    expect(NL_WAVE1_ENTRIES['github.items'].aliases).not.toContain('repo');
    const reply = "I can't see the report you mentioned.";
    expect(guardShownListingDenials(reply, github, OFFERED, 'en')).toEqual({ text: reply, guarded: false });
  });

  it('a denial that names the pull request or repository just shown is still dropped (intended), "meeting" for the calendar listing likewise', () => {
    expect(guardShownListingDenials("I can't see that pull request.", github, OFFERED, 'en').guarded).toBe(true);
    expect(guardShownListingDenials("I can't read the repository.", github, OFFERED, 'en').guarded).toBe(true);
    expect(guardShownListingDenials("I can't see the meeting details.", calendar, OFFERED, 'en').guarded).toBe(true);
  });

  it('a denial about another source is kept when it names that source, as before', () => {
    const reply = "I can't see your email about the meeting.";
    expect(guardShownListingDenials(reply, calendar, OFFERED, 'en')).toEqual({ text: reply, guarded: false });
  });

  it('a request span naming a meeting or pull request is a request about an offered source only in a request form', () => {
    expect(nlSpanRequestsOfferedSource('pull request 보여줘', OFFERED)).toBe(true);
    expect(nlSpanRequestsOfferedSource('meeting 보여줘', OFFERED)).toBe(true);
    expect(nlSpanRequestsOfferedSource('the pull request list', OFFERED)).toBe(false);
    expect(nlSpanRequestsOfferedSource('report 보여줘', OFFERED)).toBe(false);
    expect(nlSpanRequestsOfferedSource('show the report', OFFERED)).toBe(false);
  });
});

describe('A5-S3 aliases in owner-period (other-source names leave the range to the selector)', () => {
  const NOW = '2026-10-27T03:00:00.000Z';
  const offered = new Map(Object.values(NL_WAVE1_ENTRIES).map((entry) => [entry.id, entry] as const));
  const ctx = (text: string): NlValidationContext => ({ offered, groundingText: text, now: NOW, timeZone: 'Asia/Seoul' });
  const period = (entryId: string, text: string, args: Record<string, unknown>) => {
    const result = validateSelection({ entryId, args }, ctx(text));
    if (!result.ok) throw new Error(`${text}: ${result.reason}`);
    return nlOwnerStatedRange(result.value, text, ctx(text)).args;
  };

  it('a mail request "about the meeting last week" keeps its period behaviour (mail has no item-date range: untouched, as its Korean twin)', () => {
    const korean = period('mail.list', '지난주 회의 관련 메일 보여줘', { range: 'this-week' });
    const english = period('mail.list', 'show mail about the meeting last week', { range: 'this-week' });
    expect(english).toEqual(korean);
    expect(english).toEqual({ range: 'this-week' });
  });

  it('the calendar\'s own `meeting` word does not make it "another source": the owner-stated period still wins', () => {
    expect(period('calendar.events', 'show my meetings next week', { range: 'this-week' })).toEqual(period('calendar.events', '다음 주 회의 보여줘', { range: 'this-week' }));
    expect(period('calendar.events', 'show my meetings next week', { range: 'this-week' })).toEqual({ range: 'next-week' });
  });
});

import { describe, expect, it } from 'vitest';
import { validateAgentPlan } from '../agent/plan-validator';
import { nlPointsAtListedItem } from './action-entries';
import type { NlArgs, NlCatalogEntryId } from './catalog';
import { validateSelection, type NlValidationContext } from './selection-validator';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// Fix of 2026-10-29 (uat5r6-07): the listing just shown, repeated for a request about one shown item's
// content, is not a re-list (`repeats-listing`); a refresh asks for no content and still re-lists.
const NOW = '2026-10-29T03:00:00.000Z';
const offered = new Map(Object.values(NL_WAVE1_ENTRIES).map((entry) => [entry.id, entry] as const));
const ctxOf = (text: string, previous?: { entryId: NlCatalogEntryId; args: NlArgs }): NlValidationContext => ({
  offered,
  groundingText: text,
  now: NOW,
  timeZone: 'Asia/Seoul',
  ...(previous !== undefined ? { previousArgs: previous.args, previousEntryId: previous.entryId } : {}),
});
const MAIL = { entryId: 'mail.list', args: {} } as const;
const check = (text: string, args: NlArgs, previous: { entryId: NlCatalogEntryId; args: NlArgs } | undefined = MAIL, entryId = 'mail.list') =>
  validateSelection({ entryId, args }, ctxOf(text, previous));

describe('repeats-listing: the shown listing again, for a content request about one shown item', () => {
  it('refuses the identical listing when the owner asks for a pointed item content (uat5r6-07 and its shape)', () => {
    for (const text of ['그거 요약해줘', '저거 요약 좀 해줄래', '이거 내용 뭐야?', '마지막 거 정리해줘', '두 번째 거 무슨 내용이야?', 'summarize that']) {
      expect(check(text, {}), text).toMatchObject({ ok: false, reason: 'repeats-listing', entryId: 'mail.list' });
    }
    // The same with a carried filter: the listing args are unchanged.
    expect(check('그거 요약해줘', { unread: true }, { entryId: 'mail.list', args: { unread: true } })).toMatchObject({ ok: false, reason: 'repeats-listing' });
  });

  it('a held period the read would inherit is the same listing (calendar.events, P-time (ii))', () => {
    expect(check('그거 내용 정리해줘', {}, { entryId: 'calendar.events', args: { range: 'tomorrow' } }, 'calendar.events')).toMatchObject({ ok: false, reason: 'repeats-listing' });
    // mail.list does not inherit: no period is another listing.
    expect(check('그거 요약해줘', {}, { entryId: 'mail.list', args: { range: 'today' } }).ok).toBe(true);
  });

  it('leaves a refresh, a different listing, another entry and a negated request alone', () => {
    // A refresh asks for no content.
    expect(check('메일 다시 보여줘', {}).ok).toBe(true);
    expect(check('새 메일 왔어? 다시 확인해줘', {}).ok).toBe(true);
    expect(check('안 읽은 메일 다시', { unread: true }, { entryId: 'mail.list', args: { unread: true } }).ok).toBe(true);
    expect(check('그거 다시 보여줘', {}).ok).toBe(true);
    // A content word with no item pointer, or only a recency word (it dates the listing too).
    expect(check('메일 전체 다시 보여줘', {}).ok).toBe(true);
    expect(check('아까 메일 전체 다시 보여줘', {}).ok).toBe(true);
    // Fail-safe: a negation or exclusion marker.
    expect(check('그거 요약 말고 목록 다시 보여줘', {}).ok).toBe(true);
    // Another listing, another entry, or no previous selection.
    expect(check('그거 요약해줘', { unread: true }, MAIL)).not.toMatchObject({ reason: 'repeats-listing' });
    expect(check('그거 요약해줘', {}, { entryId: 'drive.files', args: {} }).ok).toBe(true);
    expect(validateSelection({ entryId: 'mail.list', args: {} }, ctxOf('그거 요약해줘')).ok).toBe(true);
  });

  it('nlPointsAtListedItem reads the closed item pointers only', () => {
    for (const text of ['그거 요약해줘', '저것 좀', '마지막 거', '세 번째 거', 'what does it say']) expect(nlPointsAtListedItem(text), text).toBe(true);
    for (const text of ['메일 다시 보여줘', '아까 메일 전체', '방금 온 메일', '그 목록 다시']) expect(nlPointsAtListedItem(text), text).toBe(false);
  });

  it('the agent-plan validator refuses the one-step re-list through the same rule (shared validateSelection)', () => {
    const result = validateAgentPlan(
      { kind: 'steps', form: 'selection', steps: [{ kind: 'read', entryId: 'mail.list', args: {} }], ambiguity: 'CLEAR', alternatives: [] },
      { offered, groundingText: '그거 요약해줘', now: NOW, timeZone: 'Asia/Seoul', direct: true, previousArgs: {}, previousEntryId: 'mail.list' },
    );
    expect(result).toMatchObject({ ok: false, reason: 'step-invalid', step: 1, stepReason: 'repeats-listing' });
    const refresh = validateAgentPlan(
      { kind: 'steps', form: 'selection', steps: [{ kind: 'read', entryId: 'mail.list', args: {} }], ambiguity: 'CLEAR', alternatives: [] },
      { offered, groundingText: '메일 다시 보여줘', now: NOW, timeZone: 'Asia/Seoul', direct: true, previousArgs: {}, previousEntryId: 'mail.list' },
    );
    expect(refresh.ok).toBe(true);
    // A listing a later step reads by reference is that step's input (ap-p188's shape after a mail listing).
    const pointed = validateAgentPlan(
      {
        kind: 'steps',
        form: 'steps',
        steps: [
          { kind: 'read', entryId: 'mail.list', args: {} },
          { kind: 'read', entryId: 'mail.list', args: {}, ref: { step: 1, field: 'messageIds', take: 1, at: 3 } },
          { kind: 'summarize', from: [2], schema: 'digest.v1' },
        ],
        ambiguity: 'CLEAR',
        alternatives: [],
      },
      { offered, groundingText: '메일 목록 보고 세 번째 메일 요약해줘', now: NOW, timeZone: 'Asia/Seoul', direct: true, previousArgs: {}, previousEntryId: 'mail.list' },
    );
    expect(pointed.ok).toBe(true);
  });
});

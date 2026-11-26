import { describe, expect, it } from 'vitest';
import { renderItemSummaryChangedLine, sameItemAsConfirmed, type ItemSummaryContinuationFacts } from './item-summary-continuation';

// ADR-0121 amendment A8.5 (OQ1-3): the continuation's same-item check over ids-only descriptors.

const item = (over: Partial<ItemSummaryContinuationFacts> = {}): ItemSummaryContinuationFacts => ({ source: 'mail', itemId: 'm-1', redo: { handlerId: 'mail' }, ...over });
const thread = (count: number | undefined, over: Partial<ItemSummaryContinuationFacts> = {}): ItemSummaryContinuationFacts =>
  item({ source: 'mail-thread', ...(count !== undefined ? { parts: { threadMessages: count } } : {}), ...over });

describe('sameItemAsConfirmed', () => {
  it('the same handler, source and item id is the same single item', () => {
    expect(sameItemAsConfirmed(item(), item())).toBe(true);
  });

  it.each([
    ['no re-read descriptor', undefined],
    ['another item id', item({ itemId: 'm-2' })],
    ['another source', item({ source: 'drive' })],
    ['another handler', item({ redo: { handlerId: 'drive' } })],
  ])('%s is not the same item', (_name, reread) => {
    expect(sameItemAsConfirmed(item(), reread)).toBe(false);
  });

  it('a thread needs the same defined message count (mail and Slack threads)', () => {
    expect(sameItemAsConfirmed(thread(2), thread(2))).toBe(true);
    expect(sameItemAsConfirmed(thread(2), thread(3))).toBe(false);
    expect(sameItemAsConfirmed(thread(undefined), thread(undefined))).toBe(false);
    expect(sameItemAsConfirmed(thread(2), thread(undefined))).toBe(false);
    expect(sameItemAsConfirmed(thread(-1), thread(-1))).toBe(false);
    expect(sameItemAsConfirmed(thread(4, { source: 'slack-thread' }), thread(4, { source: 'slack-thread' }))).toBe(true);
    expect(sameItemAsConfirmed(thread(4, { source: 'slack-thread' }), thread(5, { source: 'slack-thread' }))).toBe(false);
  });
});

describe('renderItemSummaryChangedLine', () => {
  it('is fixed copy per language, with no id or content', () => {
    expect(renderItemSummaryChangedLine('ko')).toBe('확인한 뒤로 항목이 바뀌어서 요약을 보내지 않았어요. 다시 요청해 주세요.');
    expect(renderItemSummaryChangedLine('en')).toBe('The item changed after you confirmed, so nothing was sent. Please ask again.');
  });
});

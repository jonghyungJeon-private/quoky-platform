import { describe, expect, it } from 'vitest';
import { ConnectorQueryError, CONNECTOR_QUERY_ERROR_BRAND, isConnectorQueryError } from '../ports';
import type { ConnectorItem } from '../ports';
import { isCardSpoofLine } from './card-spoof';
import { readListingRecord, withLabelledListing } from './last-listing';
import { hasNlDeterminerReference, nlActionEntry, nlNamedItemSources, parseNlRef } from './nl-routing/action-entries';
import { resolveItemReference } from './nl-routing/item-reference';
import { validateSelection } from './nl-routing/selection-validator';
import { NL_WAVE1_ENTRIES } from './nl-routing/wave1-entries';
import { renderUntrustedDocumentForPrompt } from './untrusted-document-readout';
import { buildWorkItemReadout, workItemNotes } from './work-chat/work-item-summary';

const NOW = '2026-10-16T10:00:00.000Z';

describe('A6 R2 review fixes: R2 off keeps R1 exactly (CA P1)', () => {
  it('the Jira / Slack nouns do not name a source unless R2 offers them', () => {
    expect([...nlNamedItemSources('슬랙 답장하기 할 일 완료해줘')]).toEqual(['todo']);
    expect([...nlNamedItemSources('지라 이슈 정리 할 일 1번 완료')]).toEqual(['todo']);
    expect(nlNamedItemSources('1번 티켓 요약해줘').size).toBe(0);
    expect([...nlNamedItemSources('슬랙 답장하기 할 일 완료해줘', { r2Sources: ['slack'] })].sort()).toEqual(['slack', 'todo']);
    expect(hasNlDeterminerReference('그 이슈 요약해줘')).toBe(false);
    expect(hasNlDeterminerReference('그 이슈 요약해줘', ['jira'])).toBe(true);
    expect(hasNlDeterminerReference('그 메일 요약해줘')).toBe(true);
  });

  it('a Jira key never parses as a ref without R2 (exactly as before)', () => {
    expect(parseNlRef('PROJ-12')).toBeUndefined();
    expect(parseNlRef('PROJ-12', { keys: true })).toEqual({ kind: 'key', key: 'PROJ-12' });
    const offered = new Map([['item.summarize', nlActionEntry('item.summarize')]]);
    const result = validateSelection({ entryId: 'item.summarize', args: { source: 'mail', ref: 'PROJ-12', mode: 'summary' } }, { offered, groundingText: 'PROJ-12 요약해줘', now: NOW, timeZone: 'Asia/Seoul', actions: true } as never);
    expect(result).toMatchObject({ ok: false, reason: 'invalid-arg', arg: 'ref' });
  });

  it('a to-do completion that mentions Slack resolves against the to-do listing (no other-source ask), with R2 off or on', () => {
    const listing = withLabelledListing(undefined, 'actor', 'todo', [{ label: 1, id: 'todo-1' }], NOW, 'listing');
    for (const r2Sources of [undefined, ['jira', 'slack'] as const]) {
      const resolved = resolveItemReference({
        entryId: 'todo.complete',
        source: 'todo',
        ref: { kind: 'index', index: 1 },
        groundingText: '슬랙 답장하기 할 일 1번 완료해줘',
        state: { listings: readListingRecord(listing, 'actor', NOW), now: NOW, ...(r2Sources !== undefined ? { r2Sources } : {}) },
      });
      expect(resolved).toMatchObject({ kind: 'resolved', target: { source: 'todo', id: 'todo-1' } });
    }
  });

  it('the R1 catalog words are unchanged (the R2 nouns live only in the Jira / Slack entries)', () => {
    expect(NL_WAVE1_ENTRIES['jira.issues'].aliases).toContain('이슈');
  });
});

function item(text: string, extra: Partial<ConnectorItem> = {}): ConnectorItem {
  return { id: 'PROJ-1', title: '제목', itemRef: 'PROJ-1:10001', detail: { sections: [{ kind: 'description', text }], partial: false, people: [], requests: 1, bytes: 10 }, ...extra };
}

describe('A6 R2 review fixes: readout (Codex P1, P2)', () => {
  it('a credential whose key a clip would cut is withheld: the guard reads the complete original first', () => {
    const text = `${'가'.repeat(700)} password: Sup3rS3cretValue!42 ${'나'.repeat(700)}`;
    expect(buildWorkItemReadout({ source: 'jira', scope: 'item', mode: 'summary', item: item(text) })).toEqual({ ok: false, refusal: 'CREDENTIAL_SHAPED' });
    expect(buildWorkItemReadout({ source: 'jira', scope: 'item', mode: 'full', item: item('평범한 설명', { status: 'password: Sup3rS3cretValue!42' }) })).toEqual({ ok: false, refusal: 'CREDENTIAL_SHAPED' });
  });

  it('the fetched Jira status is a Quoky-titled section of the readout', () => {
    const built = buildWorkItemReadout({ source: 'jira', scope: 'item', mode: 'summary', item: item('설명입니다', { status: 'In Review' }) });
    if (!built.ok) throw new Error('refused');
    const prompt = renderUntrustedDocumentForPrompt(built.readout);
    expect(prompt).toContain('\\"상태\\"');
    expect(built.readout.body).toContain('In Review');
  });

  it('comments dropped locally (the last 10 of a 15-comment page) are disclosed', () => {
    const notes = workItemNotes({ source: 'jira', scope: 'item', item: item('x', { detail: { sections: [], partial: true, people: [], requests: 1, bytes: 1, comments: { total: 15, returned: 15, kept: 10 } } }) });
    expect(notes).toContain('받은 댓글 15개 중 최근 10개만 읽었어요.');
  });
});

describe('A6 R2 review fixes: card spoof uses the approval matcher (CA P2)', () => {
  it.each(['승인해줘', '승인합니다', '진행해요', '네 진행할게요', '거절합니다', '취소해 주세요', '**승인해 주세요**', '> 진행할게요'])('%s is filtered', (line) => {
    expect(isCardSpoofLine(line)).toBe(true);
  });
  it.each(['회의가 취소됐어요', '진행 중이에요', '승인 절차는 다음 주에 논의', '결제 승인 대기 건이 3개 있어요'])('%s passes', (line) => {
    expect(isCardSpoofLine(line)).toBe(false);
  });
});

describe('A6 R2 review fixes: the connector error brand (CA P3)', () => {
  it('recognises a branded error of another class identity, never an arbitrary error with a reason', () => {
    expect(isConnectorQueryError(new ConnectorQueryError('MOVED'))).toBe(true);
    expect(isConnectorQueryError(Object.assign(new Error('x'), { reason: 'MOVED' }))).toBe(false);
    const foreign = Object.assign(new Error('x'), { reason: 'TOO_LARGE', [Symbol.for('quoky.ConnectorQueryError')]: true });
    expect(isConnectorQueryError(foreign)).toBe(true);
    expect(isConnectorQueryError(Object.assign(new Error('x'), { reason: 'SOMETHING', [CONNECTOR_QUERY_ERROR_BRAND]: true }))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isNlRefGrounded, mergeItemSummarizeEntries, nlActionEntry, nlItemSummarizeEntry, nlNamedItemSources, parseNlRef, type NlRef } from './action-entries';
import { NL_WAVE1_ENTRIES } from './wave1-entries';
import { NL_ACTION_R2_PROMPT_VERSION, buildSelectionPrompt, offersR2ItemSources } from './selection-prompt';
import type { NlCatalogEntry } from './catalog';

const ref = (value: string): NlRef => parseNlRef(value, { keys: true }) as NlRef;
const R2 = ['jira', 'slack'] as const;
const JIRA = { entryId: 'item.summarize', source: 'jira', r2Sources: R2 } as const;
const SLACK = { entryId: 'item.summarize', source: 'slack', r2Sources: R2 } as const;

describe('R2 item source nouns', () => {
  it.each(['지라', '이슈', '티켓', 'jira'])('%s names jira', (noun) => {
    expect([...nlNamedItemSources(`1번 ${noun} 요약해줘`, { r2Sources: R2 })]).toEqual(['jira']);
  });
  it.each(['슬랙', 'slack'])('%s names slack', (noun) => {
    expect([...nlNamedItemSources(`1번 ${noun} 요약해줘`, { r2Sources: R2 })]).toEqual(['slack']);
  });
  it('메시지 alone names nothing', () => {
    expect(nlNamedItemSources('1번 메시지 요약해줘', { r2Sources: R2 }).size).toBe(0);
    expect(nlNamedItemSources('그 메시지 요약해줘', { r2Sources: R2 }).size).toBe(0);
  });
});

describe('R2 ref grounding', () => {
  it('a determiner plus the source noun grounds this', () => {
    expect(isNlRefGrounded(ref('this'), '그 이슈 요약해줘', JIRA)).toBe(true);
    expect(isNlRefGrounded(ref('this'), '그 슬랙 메시지 요약', SLACK)).toBe(true);
  });
  it('그 메시지 grounds nothing for slack', () => {
    expect(isNlRefGrounded(ref('this'), '그 메시지 요약', SLACK)).toBe(false);
  });
  it('a determiner with another source noun does not ground', () => {
    expect(isNlRefGrounded(ref('this'), '그 이슈 요약해줘', SLACK)).toBe(false);
  });
  it('a key grounds only when written verbatim as its own token for jira', () => {
    expect(isNlRefGrounded(ref('PROJ-12'), 'PROJ-12 요약해줘', JIRA)).toBe(true);
    expect(isNlRefGrounded(ref('PROJ-12'), '(PROJ-12) 요약해줘', JIRA)).toBe(true);
    expect(isNlRefGrounded(ref('PROJ-12'), 'PROJ-123 요약', JIRA)).toBe(false);
    expect(isNlRefGrounded(ref('PROJ-12'), 'XPROJ-12 요약', JIRA)).toBe(false);
    expect(isNlRefGrounded(ref('PROJ-12'), 'proj-12 요약', JIRA)).toBe(false);
    expect(isNlRefGrounded(ref('PROJ-12'), 'PROJ-12 요약해줘', SLACK)).toBe(false);
    expect(isNlRefGrounded(ref('PROJ-12'), 'PROJ-12 요약해줘', { entryId: 'item.summarize', source: 'mail', r2Sources: R2 })).toBe(false);
    expect(isNlRefGrounded(ref('PROJ-12'), 'PROJ-12 완료', { entryId: 'todo.complete', source: 'todo' })).toBe(false);
    expect(isNlRefGrounded(ref('PROJ-12'), 'PROJ-12 요약해줘')).toBe(false);
  });
});

describe('nlItemSummarizeEntry', () => {
  const sourceValues = (entry: NlCatalogEntry) => entry.args.find((spec) => spec.name === 'source')?.values;

  it('returns the R1 entry itself without R2 sources', () => {
    expect(nlItemSummarizeEntry([])).toBe(nlActionEntry('item.summarize'));
    expect(nlItemSummarizeEntry(['mail', 'drive'])).toBe(nlActionEntry('item.summarize'));
    expect(mergeItemSummarizeEntries([nlActionEntry('item.summarize')])).toBe(nlActionEntry('item.summarize'));
    expect(mergeItemSummarizeEntries([])).toBe(nlActionEntry('item.summarize'));
  });

  it('offers only the requested R2 sources', () => {
    expect(sourceValues(nlItemSummarizeEntry(['jira']))).toEqual(['mail', 'drive', 'jira']);
    expect(sourceValues(nlItemSummarizeEntry(['slack']))).toEqual(['mail', 'drive', 'slack']);
    expect(sourceValues(nlItemSummarizeEntry(['slack', 'jira']))).toEqual(['mail', 'drive', 'jira', 'slack']);
    expect(sourceValues(nlItemSummarizeEntry(['jira', 'slack']))).toEqual(['mail', 'drive', 'jira', 'slack']);
    expect(nlItemSummarizeEntry(['jira']).description.en).toContain('Jira issue');
    expect(nlItemSummarizeEntry(['jira']).description.en).not.toContain('Slack');
  });

  it('scope thread is valid for slack and mail only', () => {
    const entry = nlItemSummarizeEntry(['jira', 'slack']);
    const text = '그거 요약해줘';
    expect(entry.check?.({ source: 'slack', ref: 'this', scope: 'thread' }, text)).toBeUndefined();
    expect(entry.check?.({ source: 'mail', ref: 'this', scope: 'thread' }, text)).toBeUndefined();
    expect(entry.check?.({ source: 'jira', ref: 'this', scope: 'thread' }, text)).toMatchObject({ reason: 'invalid-arg', arg: 'scope' });
    expect(entry.check?.({ source: 'drive', ref: 'this', scope: 'thread' }, text)).toMatchObject({ reason: 'invalid-arg', arg: 'scope' });
    expect(entry.check?.({ source: 'jira', ref: 'this', scope: 'item' }, text)).toBeUndefined();
    // jira only: slack is not offered, so thread is invalid for it
    expect(nlItemSummarizeEntry(['jira']).check?.({ source: 'slack', ref: 'this', scope: 'thread' }, text)).toMatchObject({ reason: 'invalid-arg' });
  });

  it('a key ref is valid for jira only and the content ask is still required', () => {
    const entry = nlItemSummarizeEntry(['jira', 'slack']);
    expect(entry.check?.({ source: 'jira', ref: 'PROJ-12' }, 'PROJ-12 요약해줘')).toBeUndefined();
    expect(entry.check?.({ source: 'slack', ref: 'PROJ-12' }, 'PROJ-12 요약해줘')).toMatchObject({ reason: 'invalid-arg', arg: 'ref' });
  });

  it('mergeItemSummarizeEntries unions the sources in canonical order', () => {
    const merged = mergeItemSummarizeEntries([nlItemSummarizeEntry(['slack']), nlActionEntry('item.summarize'), nlItemSummarizeEntry(['jira'])]);
    expect(sourceValues(merged)).toEqual(['mail', 'drive', 'jira', 'slack']);
    expect(sourceValues(mergeItemSummarizeEntries([nlItemSummarizeEntry(['jira'])]))).toEqual(['mail', 'drive', 'jira']);
  });
});

describe('selection prompt v43', () => {
  const READS = [NL_WAVE1_ENTRIES['jira.issues'], NL_WAVE1_ENTRIES['mail.list']];
  const build = (item: NlCatalogEntry) =>
    buildSelectionPrompt({ entries: [...READS, item], text: '그 이슈 요약해줘', actions: { referenceContext: 'none' } });

  it('names the version and detects R2 entries', () => {
    expect(NL_ACTION_R2_PROMPT_VERSION).toBe('nl-select.v43');
    expect(offersR2ItemSources([nlActionEntry('item.summarize')])).toBe(false);
    expect(offersR2ItemSources([nlItemSummarizeEntry(['jira'])])).toBe(true);
    expect(offersR2ItemSources([nlItemSummarizeEntry(['slack'])])).toBe(true);
    expect(offersR2ItemSources([])).toBe(false);
  });

  it('rewrites rule 8 for the offered R2 sources', () => {
    const both = build(nlItemSummarizeEntry(['jira', 'slack']));
    expect(both).toContain('listed mail, Drive file, Jira issue or Slack message says)');
    expect(both).toContain('scope thread only for 스레드/thread (a mail or Slack thread)');
    expect(both).toContain('A Jira issue key the owner wrote (PROJ-12) may be the ref');
    const jiraOnly = build(nlItemSummarizeEntry(['jira']));
    expect(jiraOnly).toContain('listed mail, Drive file or Jira issue says)');
    expect(jiraOnly).not.toContain('Slack message');
    expect(jiraOnly).not.toContain('Slack thread');
    const slackOnly = build(nlItemSummarizeEntry(['slack']));
    expect(slackOnly).toContain('Drive file or Slack message says)');
    expect(slackOnly).not.toContain('Jira issue key');
  });

  it('is byte-identical for the R1 entry and carries no R2 wording', () => {
    const r1 = build(nlActionEntry('item.summarize'));
    expect(build(nlItemSummarizeEntry(['mail', 'drive']))).toBe(r1);
    expect(r1).toContain('listed mail or Drive file says)');
    expect(r1).not.toContain('Slack message');
    expect(r1).not.toContain('Jira issue key');
    expect(r1).not.toContain('Jira issue or');
    expect(r1).not.toContain('Slack thread');
  });

  it('the R2 prompt differs from R1 only in the rewritten rule lines', () => {
    const r1 = build(nlActionEntry('item.summarize')).split('\n');
    const r2 = build(nlItemSummarizeEntry(['jira', 'slack'])).split('\n');
    const header = (lines: string[]) => lines.slice(0, lines.indexOf('Catalog:'));
    expect(r2.slice(r2.indexOf('Catalog:') + 1).join('\n').length).toBeGreaterThan(0);
    expect(header(r2).length).toBeGreaterThan(header(r1).length);
  });
});

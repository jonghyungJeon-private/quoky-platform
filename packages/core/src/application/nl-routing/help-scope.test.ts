import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NlArgs } from './catalog';
import { nlHelpSourceScope, renderHelpScopeQuestion } from './help-scope';
import { prepareSelectionInput } from './selection-input';
import { NL_PENDING_METADATA_KEY, readPendingQuestion } from './selection-state';
import { NL_CATALOG_SOURCE_NAMES } from './wave1-entries';

// Owner decision A (2026-10-22): the help-scope rule is structural (the general topic, one catalog source family named).

interface Golden {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
}

const corpus = (name: string): Golden[] => (JSON.parse(readFileSync(new URL(`../golden/${name}`, import.meta.url), 'utf8')) as { cases: Golden[] }).cases;
const scopeOf = (golden: Golden): ReturnType<typeof nlHelpSourceScope> => {
  if (golden.expect === 'none') return undefined;
  const prepared = prepareSelectionInput(golden.text);
  return 'skip' in prepared ? undefined : nlHelpSourceScope(golden.expect, prepared.groundingText);
};

describe('nlHelpSourceScope', () => {
  it('fires on the general help topic with one catalog source family named, in the owner spelling', () => {
    expect(nlHelpSourceScope({ entryId: 'help.topic', args: {} }, '슬랙에서 검색하는 방법 알려줘')).toEqual({ source: '슬랙' });
    expect(nlHelpSourceScope({ entryId: 'help.topic', args: { topic: 'all' } }, 'what is Confluence?')).toEqual({ source: 'Confluence' });
    expect(nlHelpSourceScope({ entryId: 'help.topic', args: {} }, 'Jira 이슈 제목 쓰는 좋은 방법이 있을까?')).toEqual({ source: 'Jira' });
    expect(nlHelpSourceScope({ entryId: 'help.topic', args: {} }, '구글 드라이브에서 폴더 공유하는 법 알려줘')).toEqual({ source: '구글 드라이브' });
  });

  it('never fires on a topic, without a source, on two source families or on another entry', () => {
    expect(nlHelpSourceScope({ entryId: 'help.topic', args: { topic: 'work-lookup' } }, '슬랙에서 검색하는 방법 알려줘')).toBeUndefined();
    expect(nlHelpSourceScope({ entryId: 'help.topic', args: {} }, '아이폰 알림 어떻게 꺼?')).toBeUndefined();
    expect(nlHelpSourceScope({ entryId: 'help.topic', args: {} }, '슬랙이랑 지라 쓰는 법')).toBeUndefined();
    expect(nlHelpSourceScope({ entryId: 'slack.search', args: { keyword: '배포' } }, '슬랙에서 배포 검색해줘')).toBeUndefined();
    // Jira's two entries share one source family.
    expect(nlHelpSourceScope({ entryId: 'help.topic', args: {} }, '지라 쓰는 법')).toEqual({ source: '지라' });
  });

  it('the source names come from the catalog only', () => {
    expect(NL_CATALOG_SOURCE_NAMES).toEqual(expect.arrayContaining(['jira', 'slack', '슬랙', 'confluence', 'github', 'gmail', 'drive', 'calendar']));
  });

  it('renders the particle by the final consonant (을 / 를), both for a non-Hangul ending', () => {
    expect(renderHelpScopeQuestion('슬랙', 'ko').split('\n')[0]).toBe('Quoky로 슬랙을 조회하는 방법을 물으신 건가요, 아니면 슬랙 앱 자체의 사용법인가요?');
    expect(renderHelpScopeQuestion('지라', 'ko').split('\n')[0]).toContain('Quoky로 지라를 조회하는');
    expect(renderHelpScopeQuestion('Jira', 'ko').split('\n')[0]).toContain('Quoky로 Jira을(를) 조회하는');
  });

  it('a stored question holds only a catalog source name', () => {
    const record = (appSource: string) => ({
      metadata: { [NL_PENDING_METADATA_KEY]: { actorId: 'a', at: '2026-10-22T00:00:00.000Z', kind: 'entry', language: 'ko', options: [{ entryId: 'help.topic', args: {} }], appSource } },
    });
    expect(readPendingQuestion(record('슬랙'), 'a', '2026-10-22T00:01:00.000Z')).toMatchObject({ appSource: '슬랙' });
    expect(readPendingQuestion(record('Confluence'), 'a', '2026-10-22T00:01:00.000Z')).toMatchObject({ appSource: 'Confluence' });
    expect(readPendingQuestion(record('아이폰'), 'a', '2026-10-22T00:01:00.000Z')).toBeUndefined();
  });
});

describe('measurement (owner decision A step 3): no positive help.topic gold is turned into a clarification', () => {
  it.each(['nl-intent.v1.json', 'nl-action.v1.json'])('%s', (name) => {
    const positives = corpus(name).filter((golden) => golden.expect !== 'none' && golden.expect.entryId === 'help.topic');
    expect(positives.length).toBeGreaterThan(0);
    expect(positives.filter((golden) => scopeOf(golden) !== undefined).map((golden) => golden.id)).toEqual([]);
  });

  it('with work-lookup included the rule would ask on four capability positives (why the topic stays out)', () => {
    const positives = corpus('nl-intent.v1.json').filter((golden) => golden.expect !== 'none' && golden.expect.entryId === 'help.topic');
    const widened = positives.filter((golden) => {
      if (golden.expect === 'none' || golden.expect.args.topic !== 'work-lookup') return false;
      const prepared = prepareSelectionInput(golden.text);
      return !('skip' in prepared) && nlHelpSourceScope({ entryId: 'help.topic', args: {} }, prepared.groundingText) !== undefined;
    });
    expect(widened.map((golden) => golden.id)).toEqual(['help-018', 'help-019', 'help-020', 'help-031']);
  });
});

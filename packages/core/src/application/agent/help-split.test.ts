import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { splitHelpClause } from './help-split';

// ADR-0121 A1-E1 (decision (e); S2 P3): the deterministic help split before planning, with the closed help vocabulary
// and the P1 conjunct boundaries only.

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const OFFERED = [...READS, ...ACTIONS];

function split(text: string, offered: readonly NlCatalogEntry[] = OFFERED, attachments = 0) {
  const prepared = prepareSelectionInput(text, attachments);
  if ('skip' in prepared) throw new Error('skipped');
  return splitHelpClause(prepared, offered);
}

describe('splitHelpClause (A1-E1)', () => {
  it.each([
    ['도움말이랑 지라 이슈 같이 보여줘', 'all', '지라 이슈 같이 보여줘'],
    ['show the help page and my github PRs', 'all', 'my github PRs'],
    ['지라 이슈 보여주고 그리고 도움말도', 'all', '지라 이슈 보여주고'],
    ['show my jira issues and the help page and my unread mail', 'all', 'show my jira issues and my unread mail'],
    ['사용법, 그리고 안 읽은 메일', 'all', '안 읽은 메일'],
  ])('%s → help %s + rest', (text, topic, rest) => {
    expect(split(text)).toEqual({ topic, rest });
  });

  it('the frozen ADR-0104 help grammar names the topic of a how-to clause', () => {
    expect(split('알림 어떻게 지워? 그리고 지라 이슈 보여줘')).toEqual({ topic: 'reminder', rest: '지라 이슈 보여줘' });
  });

  it.each([
    ['사용법 알려주고 안 읽은 메일도 보여줘', 'a boundary outside the P1 set (the verb connective; ap-n121 residual)'],
    ['도움말 보여줘', 'one conjunct: today\'s one-step help'],
    ['지라 이슈랑 슬랙 장애 얘기', 'no help clause'],
    ['슬랙 기능이랑 메일 보여줘', 'the help-alias clause also names a source (fail closed)'],
    ['도움말이랑 사용법이랑 메일', 'two help clauses'],
    ['도움말이랑', 'nothing else asked'],
  ])('%s: no split (%s)', (text) => {
    expect(split(text)).toBeUndefined();
  });

  it('never splits quoted, fenced or attached material, and needs help.topic offered', () => {
    expect(split('> 도움말이랑 지라 이슈 같이 보여줘\n지라 보여줘')).toBeUndefined();
    expect(split('도움말이랑 지라 이슈 같이 보여줘', OFFERED, 1)).toBeUndefined();
    expect(split('도움말이랑 지라 이슈 같이 보여줘', OFFERED.filter((entry) => entry.id !== 'help.topic'))).toBeUndefined();
  });

  it('A1-E5: no case of the one-step corpora splits (messages without a help clause plan byte-identically)', () => {
    for (const file of ['nl-intent.v1.json', 'nl-action.v1.json']) {
      const corpus = JSON.parse(readFileSync(new URL(`../golden/${file}`, import.meta.url), 'utf8')) as { cases: Array<{ id: string; text: string }> };
      const splits = corpus.cases.filter((c) => {
        const prepared = prepareSelectionInput(c.text);
        return !('skip' in prepared) && splitHelpClause(prepared, OFFERED) !== undefined;
      });
      expect(splits.map((c) => c.id), file).toEqual([]);
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { conjunctTokens } from './conjuncts';
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

describe('splitHelpClause (A1-E1; S2 P3 part 2: owner Q2 and CA findings 1-2)', () => {
  it.each([
    ['도움말이랑 지라 이슈 같이 보여줘', 'all', '지라 이슈 같이 보여줘'],
    // Owner Q2: the Korean verb connective -고 ends a clause (ap-n121 → ap-p180).
    ['사용법 알려주고 안 읽은 메일도 보여줘', 'all', '안 읽은 메일도 보여줘'],
    ['사용법 알려주고 내 지라 이슈도 보여줘', 'all', '내 지라 이슈도 보여줘'],
    ['도움말 좀, 지라 이슈 보여줘', 'all', '지라 이슈 보여줘'],
    ['help and my github PRs', 'all', 'my github PRs'],
    // Owner decision 2026-10-23: English "show the help page" with a read (ap-n120 → ap-p177).
    ['show the help page and my github PRs', 'all', 'my github PRs'],
    ['show me the help menu and my unread mail', 'all', 'my unread mail'],
    ['check my jira issues and the help page', 'all', 'check my jira issues'],
    ['see the help page, and list my reminders', 'all', 'list my reminders'],
    // Codex P2: mixed Korean / English clauses fall back to the head-word form.
    ['help 알려주고 내 지라 이슈 보여줘', 'all', '내 지라 이슈 보여줘'],
    ['help 좀, 그리고 안 읽은 메일 보여줘', 'all', '안 읽은 메일 보여줘'],
    ['지라 이슈랑 help 보여줘', 'all', '지라 이슈 보여줘'],
    // Codex P2: the English form tolerates trailing punctuation; no help word reaches the rest.
    ['check my jira issues and help page.', 'all', 'check my jira issues'],
    ['show the help page! and my github PRs', 'all', 'my github PRs'],
    ['show my unread mail and help.', 'all', 'show my unread mail'],
    // A non-guide alias with a guide closer is still help (W1).
    ['기능 좀 알려줘, 그리고 지라 이슈 보여줘', 'all', '지라 이슈 보여줘'],
    ['show my jira issues and help', 'all', 'show my jira issues'],
    ['사용법, 그리고 안 읽은 메일', 'all', '안 읽은 메일'],
  ])('%s → help %s + rest', (text, topic, rest) => {
    expect(split(text)).toEqual({ topic, rest });
  });

  it('CA finding 2: a last-position help clause leaves the shared predicate with the rest and trims the dangling particle', () => {
    expect(split('지라 이슈랑 도움말 보여줘')).toEqual({ topic: 'all', rest: '지라 이슈 보여줘' });
    expect(split('안 읽은 메일이랑 사용법 알려줘')).toEqual({ topic: 'all', rest: '안 읽은 메일 알려줘' });
    expect(split('지라 이슈하고 도움말')).toEqual({ topic: 'all', rest: '지라 이슈' });
  });

  it('the frozen ADR-0104 help grammar names the topic of a command how-to clause (its own conjugations, polite and English)', () => {
    expect(split('알림 어떻게 지워? 그리고 지라 이슈 보여줘')).toEqual({ topic: 'reminder', rest: '지라 이슈 보여줘' });
    expect(split('할 일 추가하는 법 알려주고 메일 보여줘')).toBeUndefined();
  });

  it.each([
    // Codex P2 on part 2: both split again.
    ['how do I add a reminder and show my jira issues', 'reminder', 'show my jira issues'],
    ['알림 어떻게 지워요? 그리고 지라 이슈 보여줘', 'reminder', '지라 이슈 보여줘'],
    // More polite and English variants of the grammar's own forms.
    ['할 일 어떻게 추가해요? 그리고 메일 보여줘', 'todo', '메일 보여줘'],
    ['알림 설정 어떻게 하나요? 그리고 슬랙에서 배포 찾아줘', 'reminder', '슬랙에서 배포 찾아줘'],
    ['알림 지우는 방법 알려주세요, 그리고 메일 보여줘', 'reminder', '메일 보여줘'],
    ['how can I mark a todo as done and show my unread mail', 'todo', 'show my unread mail'],
    ['how to cancel my reminders, and my github PRs', 'reminder', 'my github PRs'],
    ['show my jira issues and how do I delete a reminder', 'reminder', 'show my jira issues'],
  ])('%s → help %s + rest', (text, topic, rest) => {
    expect(split(text)).toEqual({ topic, rest });
  });

  it('the grammar\'s become / state form stays a possible status question: no split', () => {
    expect(split('일정 어떻게 돼요? 그리고 메일 보여줘')).toBeUndefined();
    expect(split('할 일 어떻게 되나요, 그리고 지라 이슈 보여줘')).toBeUndefined();
  });

  it.each([
    // CA probes (finding 1): a help word inside a content clause is never help.
    ['결제 기능 관련해서, 지라랑 슬랙 찾아줘', 'the alias is not the head word'],
    ['기능 개선 요청이랑 버그 이슈 지라에서 보여줘', 'content words beside the alias'],
    ['안 쓰는 기능 정리한 거랑 메일 보여줘', 'the alias is not the head word'],
    ['일정 어떻게 돼, 그리고 메일 보여줘', 'the grammar form without a command action or guide noun (a status question)'],
    ['기능개선이랑 메일 보여줘', 'an alias glued to a noun is no alias with a particle'],
    // CA re-check W1: 기능 is an alias but no guide noun; with no closer it stays the owner's scope word.
    ['기능이랑 버그 이슈 지라에서 보여줘', 'a non-guide alias with only a particle'],
    ['기능하고 버그 티켓 지라에서 찾아줘', 'a non-guide alias with only a particle'],
    ['기능, 버그 지라 이슈 보여줘', 'a non-guide alias with only a comma'],
    ['open the help menu and my github PRs', 'an English lead the help grammar does not have ("open")'],
    ['show the help desk tickets and my mail', 'more than one word after the help word'],
    ['find help articles about login and my jira issues', 'a lead that is not the grammar\'s'],
    // Codex P2: a fully English clause that fails the English form never falls back to the head-word form.
    ['check my jira issues and help desk tickets.', 'two words after the help word (punctuated)'],
    ['check my jira issues and help me with this.', 'an English clause that is not the English form'],
    ['show my mail, and get help now.', 'a lead that is not the grammar\'s (punctuated)'],
    ['Quoky야, 할 일 어떻게 취소해?', 'one help question as a whole, after an address'],
    ['도움말 보여줘', 'one conjunct: today\'s one-step help'],
    ['지라 이슈랑 슬랙 장애 얘기', 'no help clause'],
    ['슬랙 기능이랑 메일 보여줘', 'the help-alias clause also names a source (fail closed)'],
    ['도움말이랑 사용법이랑 메일', 'two help clauses'],
    ['도움말이랑', 'nothing else asked'],
    // Codex P2 (2026-10-26): a negation or refusal of help is no help request; the planner gets the message whole.
    ['도움말 말고 내 지라 이슈 보여줘', 'a negation (말고)'],
    ['사용법 필요없고 안 읽은 메일 보여줘', 'a refusal (필요없고)'],
    ['도움말은 됐고 지라 이슈 보여줘', 'a refusal (됐고)'],
    ['help 말고 내 지라 이슈 보여줘', 'a mixed-language negation'],
    ['지라 이슈랑 도움말은 됐어', 'a last-position refusal'],
    ['지라 이슈랑 도움말 빼줘', 'a last-position removal verb'],
  ])('%s: no split (%s)', (text) => {
    expect(split(text)).toBeUndefined();
  });

  it('never splits quoted, fenced or attached material, and needs help.topic offered', () => {
    expect(split('> 도움말이랑 지라 이슈 같이 보여줘\n지라 보여줘')).toBeUndefined();
    expect(split('도움말이랑 지라 이슈 같이 보여줘', OFFERED, 1)).toBeUndefined();
    expect(split('도움말이랑 지라 이슈 같이 보여줘', OFFERED.filter((entry) => entry.id !== 'help.topic'))).toBeUndefined();
  });

  it('A1-E5 / owner Q2 measurement: no false split in any golden corpus (3374 texts); only the two intended plan cases split', () => {
    const dir = new URL('../golden/', import.meta.url);
    const splits: string[] = [];
    let texts = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const corpus = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { cases?: Array<{ id?: string; text?: unknown }> };
      for (const c of Array.isArray(corpus.cases) ? corpus.cases : []) {
        if (typeof c.text !== 'string') continue;
        texts += 1;
        const prepared = prepareSelectionInput(c.text);
        if (!('skip' in prepared) && splitHelpClause(prepared, OFFERED) !== undefined) splits.push(`${file}:${c.id}`);
      }
    }
    expect(texts).toBeGreaterThanOrEqual(3374);
    expect(splits).toEqual(['agent-plan.v1.json:ap-p175', 'agent-plan.v1.json:ap-p177', 'agent-plan.v1.json:ap-p180']);
  });

  it('the -고 boundary is the help split\'s only: the validator\'s conjuncts keep the P1 set', () => {
    expect(conjunctTokens('사용법 알려주고 메일 보여줘').map((token) => token.conjunct)).toEqual([0, 0, 0, 0]);
    expect(conjunctTokens('사용법 알려주고 메일 보여줘', { verbConnective: true }).map((token) => token.conjunct)).toEqual([0, 0, 1, 1]);
    // The -하고 particle stays a P1 boundary in both.
    expect(conjunctTokens('지라하고 메일').map((token) => token.conjunct)).toEqual([0, 1]);
  });
});

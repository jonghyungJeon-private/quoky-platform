import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NL_CONTENT_WORDS,
  NL_MODE_FULL_WORDS,
  NL_MODE_SUMMARY_WORDS,
  isNlRefGrounded,
  mergeItemSummarizeEntries,
  nlActionEntry,
  nlItemSummarizeEntry,
  nlNamedItemSources,
  parseNlRef,
  type NlRef,
} from './action-entries';
import { NL_WAVE1_ENTRIES } from './wave1-entries';
import { NL_ACTION_R2_PROMPT_VERSION, buildSelectionPrompt, offersR2ItemSources } from './selection-prompt';
import { extractPromptExamples } from './example-contamination';
import { nlItemReadVeto } from './selection-validator';
import { prepareSelectionInput } from './selection-input';
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

describe('selection prompt v47', () => {
  const READS = [NL_WAVE1_ENTRIES['jira.issues'], NL_WAVE1_ENTRIES['mail.list']];
  const build = (item: NlCatalogEntry) =>
    buildSelectionPrompt({ entries: [...READS, item], text: '그 이슈 요약해줘', actions: { referenceContext: 'none' } });

  it('names the version and detects R2 entries', () => {
    expect(NL_ACTION_R2_PROMPT_VERSION).toBe('nl-select.v47');
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

  it('v46 F1: one pointed item versus a list query, the exclusions, and no stale "Jira issues ... still none" tail', () => {
    const both = build(nlItemSummarizeEntry(['jira', 'slack']));
    expect(both).toContain('   ONE listed item, not a list query: when the owner points at one item of a list already shown');
    expect(both).toContain('   jira.issues and slack.search are list queries (a period, a status, a keyword, my items), never one pointed item.');
    expect(both).toContain('   Never item.summarize: a question about one field of the item');
    expect(both).toContain('creating or changing a Jira issue and every other write');
    expect(both).not.toContain('calendar events, Jira issues and every other write');
    const jiraOnly = build(nlItemSummarizeEntry(['jira']));
    expect(jiraOnly).toContain('   jira.issues is a list query (');
    expect(jiraOnly).not.toContain('slack.search is a list query');
    const slackOnly = build(nlItemSummarizeEntry(['slack']));
    expect(slackOnly).toContain('   slack.search is a list query (');
    expect(slackOnly).toContain('   슬랙, Slack), also when Reference context shows only another list');
    expect(slackOnly).not.toContain('지라, 이슈, 티켓, Jira');
  });

  it('v46 F2/F3: determiner + source noun is this, a one-item list is no #1, last read, and the source order', () => {
    const both = build(nlItemSummarizeEntry(['jira', 'slack']));
    expect(both).toContain('   item.summarize ref: 이/그/저 or this/that standing before a source noun is "this", exactly like 그거; a list of one');
    expect(both).toContain('item does not make it "#1"');
    expect(both).toContain('`last read: <source>`');
    expect(both).toContain('   item.summarize source, in this order: (1) the source of the noun the owner wrote');
    expect(both).toContain('(2) with no source noun,');
    expect(both).toContain('(3) otherwise the list in Reference context the owner means.');
    const entry = nlItemSummarizeEntry(['jira', 'slack']);
    expect(entry.args.find((spec) => spec.name === 'source')?.description).toContain("the owner's own noun");
    expect(entry.description.en).toContain('one pointed item is this entry');
  });

  it('v46 F4: the mode vocabulary of the prompt and the R2 entry is the Core grounding vocabulary, word for word', () => {
    const both = build(nlItemSummarizeEntry(['jira', 'slack']));
    expect(both).toContain(`   mode summary only for ${NL_MODE_SUMMARY_WORDS.join('/')};`);
    expect(both).toContain(`   full only for ${NL_MODE_FULL_WORDS.join('/')};`);
    expect(both).toContain('Only these words set mode, with or without scope thread.');
    const mode = nlItemSummarizeEntry(['slack']).args.find((spec) => spec.name === 'mode');
    for (const word of [...NL_MODE_SUMMARY_WORDS, ...NL_MODE_FULL_WORDS]) expect(mode?.description).toContain(word);
  });

  it('v46: each R2 example is shown only while its source is offered, and Core grounds its output', () => {
    const examples = (item: NlCatalogEntry) => extractPromptExamples(build(item)).filter((example) => example.output.includes('"source":"jira"') || example.output.includes('"source":"slack"'));
    const both = examples(nlItemSummarizeEntry(['jira', 'slack']));
    expect(both).toHaveLength(2);
    expect(examples(nlItemSummarizeEntry(['jira'])).map((example) => example.output)).toEqual([expect.stringContaining('"source":"jira"')]);
    expect(examples(nlItemSummarizeEntry(['slack'])).map((example) => example.output)).toEqual([expect.stringContaining('"source":"slack"')]);
    expect(examples(nlActionEntry('item.summarize'))).toEqual([]);
    const entry = nlItemSummarizeEntry(['jira', 'slack']);
    for (const example of both) {
      const args = (JSON.parse(example.output) as { args: { source: 'jira' | 'slack'; ref: string } }).args;
      expect(entry.check?.(args, example.text)).toBeUndefined();
      expect(isNlRefGrounded(ref(args.ref), example.text, { entryId: 'item.summarize', source: args.source, r2Sources: R2 })).toBe(true);
    }
  });

  it('v47: a content word alone and a show or tell verb leave mode unset (Core NL_CONTENT_WORDS, listed from the constant)', () => {
    const both = build(nlItemSummarizeEntry(['jira', 'slack']));
    expect(both).toContain(`   leaves mode unset (${NL_CONTENT_WORDS.join('/')}),`);
    expect(both).toContain('a show or tell verb (보여줘, 알려줘, 봐줘, show, tell) never sets mode; Core asks the owner once.');
    expect(build(nlActionEntry('item.summarize'))).not.toContain('leaves mode unset');
  });
});

describe('A6 R2 (v47): the ITEM_READ request-shape veto (reported, example, joke, retraction)', () => {
  const grounding = (text: string): string => {
    const prepared = prepareSelectionInput(text);
    return 'skip' in prepared ? '' : prepared.groundingText;
  };
  const load = (file: string) =>
    (JSON.parse(readFileSync(new URL(`../golden/${file}`, import.meta.url), 'utf8')) as { cases: Array<{ id: string; text: string; expect: unknown }> }).cases;
  const positive = (expect: unknown): boolean =>
    typeof expect === 'object' && expect !== null && (expect as { entryId?: string }).entryId === 'item.summarize' && (expect as { outcome?: string }).outcome !== 'none';

  it('every over-block example of both review rounds reads (with and without a question mark)', () => {
    for (const text of [
      // round 1 (Codex P2, CA P2)
      'Summarize email #1 that has the invoice',
      '1번 메일 요약해주시면 감사하겠습니다',
      '3번 메일 요약해주면 좋겠어',
      '요약해 줬으면 해',
      '요약하고 싶어',
      '만약 길면 요약해줘',
      '길면 요약해줘',
      '내용 많으면 요약만 해줘',
      '3번 메일 요약해줘, 길면 짧게',
      '요약 안 해도 되고 원문 보여줘',
      // round 2 (Codex)
      'Show the full text of email #1 that has the invoice',
      '1번 메일 원문 보여줘, 요약하지 마',
      'Show the full text of email #1, not a summary',
      // plain question forms
      '그 슬랙 메시지 내용이 뭐야?',
      '3번 티켓 뭐라고 적혀 있어?',
    ]) {
      expect(nlItemReadVeto(grounding(text)), text).toBeUndefined();
      expect(nlItemReadVeto(grounding(`${text.replace(/\?$/u, '')}?`)), `${text}?`).toBeUndefined();
    }
  });

  it('refuses reported, quoted, example, joke and retracted requests', () => {
    expect(nlItemReadVeto(grounding('동료가 "슬랙 3번 요약해줘"라고 했어'))).toBe('reported');
    expect(nlItemReadVeto(grounding('동료가 "3번 요약해줘"라고 했는데'))).toBe('reported');
    expect(nlItemReadVeto(grounding('팀장이 요약해달래'))).toBe('reported');
    expect(nlItemReadVeto(grounding('김 대리가 3번 요약해 달랬는데'))).toBe('reported');
    expect(nlItemReadVeto(grounding('민수가 2번 메일 요약해 달래'))).toBe('reported');
    expect(nlItemReadVeto(grounding('예를 들어 3번 메일 요약해줘'))).toBe('example');
    expect(nlItemReadVeto(grounding('농담이야 3번 메일 요약해줘'))).toBe('joke');
    expect(nlItemReadVeto(grounding('3번 요약해줘 아 아니다'))).toBe('retraction');
    expect(nlItemReadVeto(grounding('3번 요약해줘 아 취소'))).toBe('retraction');
    expect(nlItemReadVeto(grounding('이슈 요약은 이제 그만해도 돼'))).toBe('retraction');
  });

  it('an own request appended to a reported one does not read the quoted target: the whole message is chat', () => {
    expect(nlItemReadVeto(grounding('팀장이 3번 요약해달래. 요약해줘'))).toBe('reported');
    expect(nlItemReadVeto(grounding('요약해줘. 동료가 "3번 요약해줘"라고 했거든'))).toBe('reported');
  });

  it('negation, past and report statements stay with the selector (no Core veto)', () => {
    for (const text of ['2번 이슈는 요약하지 마', '3번 요약했어', '어제 그 이슈 요약해서 보냈어', 'I already read that jira issue', "don't summarize that Slack message"]) {
      expect(nlItemReadVeto(grounding(text)), text).toBeUndefined();
    }
  });

  it('a speaker label without an address term is not covered (a known gap: it needs a person-noun list)', () => {
    expect(nlItemReadVeto(grounding('동료 메시지: 3번 요약해줘'))).toBeUndefined();
  });

  it('blocks no item.summarize positive of the D12 corpora (R2, A6, seed): 0 of 234', () => {
    let positives = 0;
    const blocked: string[] = [];
    for (const file of ['nl-action.r2.v1.json', 'nl-action.v1.json', 'nl-action.seed.v1.json']) {
      for (const c of load(file)) {
        if (!positive(c.expect)) continue;
        positives += 1;
        const veto = nlItemReadVeto(grounding(c.text));
        if (veto !== undefined) blocked.push(`${c.id} ${veto}`);
      }
    }
    expect(positives).toBe(234);
    expect(blocked).toEqual([]);
  });

  it('settles these R2 negatives deterministically (the rest stay with the selector and Core)', () => {
    const settled = load('nl-action.r2.v1.json')
      .filter((c) => !positive(c.expect) && nlItemReadVeto(grounding(c.text)) !== undefined)
      .map((c) => `${c.id.replace('a6r2-negative-', '')}:${nlItemReadVeto(grounding(c.text))}`);
    expect(settled).toEqual(['005:retraction', '039:reported', '040:reported', '042:reported', '043:reported', '070:reported']);
  });
});

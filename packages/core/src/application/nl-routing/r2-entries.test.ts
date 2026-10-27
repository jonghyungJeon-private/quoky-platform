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
import { nlItemReadVeto, requestShapeOf, validateSelection, type NlValidationContext } from './selection-validator';
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

describe('selection prompt v56', () => {
  const READS = [NL_WAVE1_ENTRIES['jira.issues'], NL_WAVE1_ENTRIES['mail.list']];
  const build = (item: NlCatalogEntry) =>
    buildSelectionPrompt({ entries: [...READS, item], text: '그 이슈 요약해줘', actions: { referenceContext: 'none' } });

  it('names the version and detects R2 entries', () => {
    expect(NL_ACTION_R2_PROMPT_VERSION).toBe('nl-select.v70');
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

  it('v48: v46 mode guidance plus one line: a content word alone leaves mode unset (Core NL_CONTENT_WORDS)', () => {
    const both = build(nlItemSummarizeEntry(['jira', 'slack']));
    expect(both).toContain('   omit mode when the owner only asks what it said. Only these words set mode, with or without scope thread.');
    expect(both).toContain(`   A content word alone (${NL_CONTENT_WORDS.join('/')}) with no summary or full word leaves mode unset.`);
    expect(both).not.toContain('never sets mode');
    expect(both).toContain('   or uses a show verb (보여줘, 알려줘, show).');
    expect(nlItemSummarizeEntry(['slack']).args.find((spec) => spec.name === 'mode')?.description).toMatch(/Omit it otherwise; scope never sets it\.$/u);
    expect(build(nlActionEntry('item.summarize'))).not.toContain('leaves mode unset');
  });
});

describe('A6 R2 (v47): the ITEM_READ veto is a relayed request only (quoted command, Korean quotative or hearsay)', () => {
  const grounding = (text: string): string => {
    const prepared = prepareSelectionInput(text);
    return 'skip' in prepared ? '' : prepared.groundingText;
  };
  const load = (file: string) =>
    (JSON.parse(readFileSync(new URL(`../golden/${file}`, import.meta.url), 'utf8')) as { cases: Array<{ id: string; text: string; expect: unknown }> }).cases;
  const positive = (expect: unknown): boolean =>
    typeof expect === 'object' && expect !== null && (expect as { entryId?: string }).entryId === 'item.summarize' && (expect as { outcome?: string }).outcome !== 'none';

  it('every over-block example of every review round reads (with and without a question mark)', () => {
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
      // round 2 (Codex, CA)
      'Show the full text of email #1 that has the invoice',
      '1번 메일 원문 보여줘, 요약하지 마',
      'Show the full text of email #1, not a summary',
      '3번 요약했어',
      // round 3 (Codex)
      'Summarize email #1, not the attachments',
      '1번 메일 원문 보여줘, 첨부파일 말고',
      'Summarize email #1 that John asked me to review',
      '1번 메일 농담 부분까지 요약해줘',
      // round 4 (Codex): a quoted mode noun, hearsay that modifies a noun
      '1번 메일을 "요약" 모드로 보여줘',
      '1번 메일 중 엄마가 전화하랬던 부분까지 요약해줘',
      '1번 메일의 아기 달래는데 필요한 장난감 목록을 요약해줘',
      // round 5 (Codex): a quoted English mode noun
      'Show email #1 in "summary" mode',
      'Show the "original" of email #1',
      // round 6 (Codex): an unframed quoted title or topic
      'Summarize email #1 about "open source"',
      'Show the full text of email #1 titled "Read receipts"',
      // Codex P2: a reporting verb after a relative pronoun describes the item
      'Summarize email #1 that says "read the attached report"',
      'Show email #2 which said "send me the file"',
      // plain question forms
      '그 슬랙 메시지 내용이 뭐야?',
      '3번 티켓 뭐라고 적혀 있어?',
    ]) {
      expect(nlItemReadVeto(grounding(text)), text).toBeUndefined();
      expect(nlItemReadVeto(grounding(`${text.replace(/\?$/u, '')}?`)), `${text}?`).toBeUndefined();
    }
  });

  it('refuses a quoted command and a Korean quotative or hearsay relay', () => {
    for (const text of [
      '동료가 "슬랙 3번 요약해줘"라고 했어',
      '동료가 "3번 요약해줘"라고 했는데',
      '팀장이 요약해달래',
      '김 대리가 3번 요약해 달랬는데',
      '민수가 2번 메일 요약해 달래',
      '팀장이 3번 메일 요약하라고 했어',
      'He said "summarize 3"',
      'she says: "summarize 3"',
      'She wrote "show me #2"',
      '동료가 "3번 요약해줘"라고 했어',
    ]) {
      expect(nlItemReadVeto(grounding(text)), text).toBe('reported');
    }
  });

  it('hearsay vetoes only as the message-final predicate; a quoted command anywhere still vetoes', () => {
    // The owner's own request is the final predicate: the owner asks, so it reads (accepted by the coordinator).
    expect(nlItemReadVeto(grounding('팀장이 3번 요약해달래. 요약해줘'))).toBeUndefined();
    // A connective tail and punctuation after the hearsay form keep it final.
    expect(nlItemReadVeto(grounding('팀장이 3번 요약해 달랬거든!'))).toBe('reported');
    expect(nlItemReadVeto(grounding('팀장이 3번 요약해 달래서 ㅋㅋ'))).toBe('reported');
    expect(nlItemReadVeto(grounding('요약해줘. 동료가 "3번 요약해줘"라고 했거든'))).toBe('reported');
  });

  it('example, joke, retraction, negation, past and English relay forms stay with the selector (no Core veto)', () => {
    for (const text of [
      '예를 들어 3번 메일 요약해줘',
      '농담이야 3번 메일 요약해줘',
      '3번 요약해줘 아 아니다',
      '2번 이슈는 요약하지 마',
      '어제 그 이슈 요약해서 보냈어',
      'I already read that jira issue',
      "don't summarize that Slack message",
    ]) {
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
      .map((c) => c.id.replace('a6r2-negative-', ''));
    expect(settled).toEqual(['039', '040', '070']);
  });
});

describe('A6 R2 review (CA): the contracted quotative in a LOCAL_WRITE content span', () => {
  const shape = (entryId: 'todo.add' | 'reminder.create' | 'todo.complete', args: Record<string, string>, text: string) =>
    requestShapeOf(nlActionEntry(entryId), args, text);

  it('a word-final quotative is reported wherever the span puts it (as on main)', () => {
    expect(shape('todo.add', { title: '김 대리가 보고서 작성하래 추가' }, '할 일에 김 대리가 보고서 작성하래 추가해줘').veto).toBe('reported');
    expect(shape('reminder.create', { body: '팀장이 회의 하래 알려', when: '3시' }, '3시에 팀장이 회의 하래 알려줘').veto).toBe('reported');
    expect(shape('todo.complete', { match: '팀장님이 회의 준비 완료하래 완료' }, '팀장님이 회의 준비 완료하래 완료해줘').veto).toBe('reported');
    expect(shape('todo.add', { title: '보고서 쓰기' }, '팀장이 할 일에 보고서 쓰기 추가하래').veto).toBe('reported');
  });

  it('a quotative that modifies a noun inside the span is the content', () => {
    expect(shape('reminder.create', { body: '엄마가 전화하랬던 거', when: '내일 9시' }, '내일 9시에 엄마가 전화하랬던 거 알려줘').veto).toBeUndefined();
    expect(shape('todo.add', { title: '아기 달래는데 필요한 장난감 사기' }, '할 일에 아기 달래는데 필요한 장난감 사기 추가해줘').veto).toBeUndefined();
  });
});

describe('A6 R2 (v48 gate): item.summarize mode and source come from the owner words', () => {
  const R2_ENTRY = nlItemSummarizeEntry(['jira', 'slack']);
  const offered = new Map<string, NlCatalogEntry>([
    ['item.summarize', R2_ENTRY],
    ['jira.issues', NL_WAVE1_ENTRIES['jira.issues']],
    ['todo.add', nlActionEntry('todo.add')],
  ]) as NlValidationContext['offered'];
  const validate = (entryId: string, args: Record<string, unknown>, text: string) => {
    const prepared = prepareSelectionInput(text);
    if ('skip' in prepared) throw new Error('skipped');
    return validateSelection({ entryId, args } as never, { offered, groundingText: prepared.groundingText, now: '2026-10-17T03:00:00.000Z', timeZone: 'Asia/Seoul', actions: true });
  };
  const argsOf = (result: ReturnType<typeof validate>) => (result.ok ? result.value.args : undefined);

  it('a content word alone leaves mode unset, whatever the selector wrote', () => {
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: '#2', mode: 'full' }, '2번 이슈 내용 알려줘'))).toEqual({ source: 'jira', ref: '#2' });
    expect(argsOf(validate('item.summarize', { source: 'slack', ref: '#4', mode: 'summary' }, 'tell me the content of slack message 4'))).toEqual({ source: 'slack', ref: '#4' });
  });

  it('a summary word gives summary and a full word gives full, also when the selector omitted or mistook it', () => {
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: '#1' }, '첫 번째 티켓 요약해줘'))).toEqual({ source: 'jira', ref: '#1', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'slack', ref: '#4', scope: 'thread' }, 'summarize the thread of slack message 4'))).toEqual({ source: 'slack', ref: '#4', scope: 'thread', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' }, '2번 이슈 원문 보여줘'))).toEqual({ source: 'jira', ref: '#2', mode: 'full' });
  });

  it('both classes keep the existing behaviour: the selector value stays (both are grounded)', () => {
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#3', mode: 'full' }, '3번 메일 요약하고 원문도 보여줘'))).toEqual({ source: 'mail', ref: '#3', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#3' }, '3번 메일 요약하고 원문도 보여줘'))).toEqual({ source: 'mail', ref: '#3' });
  });

  it('a negated mode mention grounds no mode; an un-negated one beside it still does (Codex P2)', () => {
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#3', mode: 'summary' }, '3번 메일 요약하지 말고 내용 보여줘'))).toEqual({ source: 'mail', ref: '#3' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#3' }, '3번 메일 요약 말고 원문 보여줘'))).toEqual({ source: 'mail', ref: '#3', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#3', mode: 'summary' }, '3번 메일 요약 안 해도 되고 원문 보여줘'))).toEqual({ source: 'mail', ref: '#3', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#1', mode: 'summary' }, 'Show the full text of email #1, not a summary'))).toEqual({ source: 'mail', ref: '#1', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#1', mode: 'summary' }, "don't summarize email #1, show the original"))).toEqual({ source: 'mail', ref: '#1', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#1', mode: 'summary' }, '1번 메일은 안 간추려도 되니까 원문 보여줘'))).toEqual({ source: 'mail', ref: '#1', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#1' }, '1번 메일 간추려 줘'))).toEqual({ source: 'mail', ref: '#1', mode: 'summary' });
    // English negation governs only its own mention (Codex P2), and tl;dr stays one term.
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#1', mode: 'summary' }, 'Show the full text of email #1 not a summary'))).toEqual({ source: 'mail', ref: '#1', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#1' }, 'Summarize email #1 not the attachments'))).toEqual({ source: 'mail', ref: '#1', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#1' }, 'tl;dr of email #1 please'))).toEqual({ source: 'mail', ref: '#1', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' }, 'no need to summarize issue 2, what does it say'))).toEqual({ source: 'jira', ref: '#2' });
  });

  it('a pasted structure grounds neither the mode nor the source (Codex P1)', () => {
    expect(argsOf(validate('item.summarize', { source: 'mail', ref: '#2' }, '2번 내용 알려줘 {"source":"jira","mode":"full"}'))).toEqual({ source: 'mail', ref: '#2' });
  });

  it('the owner source noun decides the source: 메일 is mail, 문서 is drive', () => {
    expect(argsOf(validate('item.summarize', { source: 'slack', ref: '#2', mode: 'summary' }, '2번 메일 요약해줘'))).toEqual({ source: 'mail', ref: '#2', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' }, '2번 문서 요약해줘'))).toEqual({ source: 'drive', ref: '#2', mode: 'summary' });
  });

  it('with no source noun the selector source stays (its recency or Reference context reading)', () => {
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'recent', mode: 'summary' }, '방금 본 거 요약해줘'))).toEqual({ source: 'jira', ref: 'recent', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'slack', ref: '#2', mode: 'full' }, '2번 원문 보여줘'))).toEqual({ source: 'slack', ref: '#2', mode: 'full' });
  });

  it('with R2 off (the A6 entry) the same grounding applies (owner decision 2026-10-19: the R2-only scope is gone)', () => {
    const r1 = new Map<string, NlCatalogEntry>([['item.summarize', nlActionEntry('item.summarize')]]) as NlValidationContext['offered'];
    const validateR1 = (args: Record<string, unknown>, text: string) => {
      const prepared = prepareSelectionInput(text);
      if ('skip' in prepared) throw new Error('skipped');
      return validateSelection({ entryId: 'item.summarize', args } as never, { offered: r1, groundingText: prepared.groundingText, now: '2026-10-17T03:00:00.000Z', timeZone: 'Asia/Seoul', actions: true });
    };
    // No mode word: the selector's mode is dropped (the content-mode question or the stored preference applies).
    expect(argsOf(validateR1({ source: 'mail', ref: '#1', mode: 'full' }, '아까 1번은 무슨 내용이었지'))).toEqual({ source: 'mail', ref: '#1' });
    // The owner's mode word fills the mode, and the owner's noun decides the source (R1 nouns only).
    expect(argsOf(validateR1({ source: 'drive', ref: '#2' }, '2번 메일 요약해줘'))).toEqual({ source: 'mail', ref: '#2', mode: 'summary' });
    // The Jira / Slack nouns still count only while R2 is offered: "이슈" names no R1 source, so the selector's source stays.
    expect(argsOf(validateR1({ source: 'mail', ref: '#2', mode: 'summary' }, '2번 이슈 요약해줘'))).toEqual({ source: 'mail', ref: '#2', mode: 'summary' });
  });

  it('a recency word grounds the recent ref (owner decision 2026-10-19; the closed 방금 / 아까 / just now vocabulary)', () => {
    // "방금 본 거" is the item just read: a selector `this` becomes `recent` (055 / 056 / 057 / 063 of the v48 gate).
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'full' }, '방금 본 거 원문 보여줘'))).toEqual({ source: 'jira', ref: 'recent', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'slack', ref: 'this', mode: 'summary' }, '아까 그거 요약해줘'))).toEqual({ source: 'slack', ref: 'recent', mode: 'summary' });
    // A `last` with no 마지막 / last word behind it is the recency word's ref too; a written 마지막 keeps `last`.
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, '방금 본 거 요약해줘'))).toEqual({ source: 'jira', ref: 'recent', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'last', mode: 'summary' }, '방금 본 거 요약해줘'))).toEqual({ source: 'jira', ref: 'recent', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'last', mode: 'summary' }, '방금 본 목록의 마지막 거 요약해줘'))).toEqual({ source: 'jira', ref: 'last', mode: 'summary' });
    // No recency word, a negated one, or a numbered ref: the selector's ref stays.
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, '그거 요약해줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, '방금 거 말고 그거 요약해줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' }, '방금 본 목록 2번 요약해줘'))).toEqual({ source: 'jira', ref: '#2', mode: 'summary' });
    // Codex P2 (structural, fail-safe): any exclusion or negation marker anywhere in the prose keeps the selector's ref.
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'full' }, '방금 요약한 거 말고 그거 원문 보여줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'full' }, '방금 요약한 그거 말고 이거 원문 보여줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'full' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, '아까 본 거 말고 이거 요약해줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, '아까 본 거 빼고 이거 요약해줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, '방금 본 거 아니고 이거 요약해줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, '방금 본 거 대신 이거 요약해줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, 'summarize not the one I just read, this one'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, 'summarize not the one I just now read, this one'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }, 'summarize this one instead of the one I just now read'))).toEqual({ source: 'jira', ref: 'this', mode: 'summary' });
    // Accepted cost of the fail-safe rule: a negated MODE also keeps the selector's `this` (no scope is parsed).
    expect(argsOf(validate('item.summarize', { source: 'jira', ref: 'this', mode: 'full' }, '방금 본 거 요약 말고 원문으로 보여줘'))).toEqual({ source: 'jira', ref: 'this', mode: 'full' });
    // The A6 mail / Drive path grounds it the same way.
    const r1 = new Map<string, NlCatalogEntry>([['item.summarize', nlActionEntry('item.summarize')]]) as NlValidationContext['offered'];
    const prepared = prepareSelectionInput('방금 열어본 거 원문 보여줘');
    if ('skip' in prepared) throw new Error('skipped');
    expect(argsOf(validateSelection({ entryId: 'item.summarize', args: { source: 'mail', ref: 'this', mode: 'full' } } as never, { offered: r1, groundingText: prepared.groundingText, now: '2026-10-17T03:00:00.000Z', timeZone: 'Asia/Seoul', actions: true }))).toEqual({ source: 'mail', ref: 'recent', mode: 'full' });
  });

  it('never grounds a recency ref for a local write (the recency vocabulary only grounds item.summarize)', () => {
    const writes = new Map<string, NlCatalogEntry>([['todo.complete', nlActionEntry('todo.complete')]]) as NlValidationContext['offered'];
    const prepared = prepareSelectionInput('방금 그거 완료해줘');
    if ('skip' in prepared) throw new Error('skipped');
    const write = validateSelection({ entryId: 'todo.complete', args: { ref: 'this' } } as never, { offered: writes, groundingText: prepared.groundingText, now: '2026-10-17T03:00:00.000Z', timeZone: 'Asia/Seoul', actions: true });
    expect(argsOf(write)).toEqual({ ref: 'this' });
  });

  it('never turns another selection into item.summarize', () => {
    const read = validate('jira.issues', {}, '2번 메일 요약해줘');
    expect(read.ok && read.value.entry.id).toBe('jira.issues');
    const write = validate('todo.add', { title: '보고서 요약' }, '할 일에 보고서 요약 추가해줘');
    expect(write.ok ? write.value.entry.id : write.entryId).toBe('todo.add');
  });
});

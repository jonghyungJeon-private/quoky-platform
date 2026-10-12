import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_CATALOG_ENTRY_IDS, isNlCatalogEntryId, type NlArgs, type NlCatalogEntry } from './catalog';
import { prepareSelectionInput } from './selection-input';
import { validateSelection } from './selection-validator';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 D12 corpus `golden/nl-intent.v1.json`: shape, size, the owner's phrases verbatim, and that every expectation is
// a canonical selection the D4 validator accepts unchanged (the same check the dispatch test and the Strict evaluation
// rely on, so an exact {entry, args} match is well defined).

export interface NlIntentCase {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  readonly channel?: boolean;
  readonly note?: string;
}

const corpus = JSON.parse(readFileSync(new URL('../golden/nl-intent.v1.json', import.meta.url), 'utf8')) as {
  version: number;
  description: string;
  cases: NlIntentCase[];
};
const ALL: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const NOW = '2026-10-12T03:00:00.000Z';

describe('nl-intent.v1.json (ADR-0120 D12)', () => {
  it('has unique ids and texts, at least 25 phrasings per entry and at least 80 negatives', () => {
    expect(corpus.version).toBe(1);
    expect(new Set(corpus.cases.map((c) => c.id)).size).toBe(corpus.cases.length);
    expect(new Set(corpus.cases.map((c) => `${c.prior ? JSON.stringify(c.prior) : ''}${c.text}`)).size).toBe(corpus.cases.length);
    for (const id of NL_CATALOG_ENTRY_IDS) {
      expect(corpus.cases.filter((c) => c.expect !== 'none' && c.expect.entryId === id).length, id).toBeGreaterThanOrEqual(25);
    }
    expect(corpus.cases.filter((c) => c.expect === 'none').length).toBeGreaterThanOrEqual(80);
  });

  it("contains the owner's two phrases and the follow-up verbatim, with the expected selections", () => {
    const byText = (text: string) => corpus.cases.find((c) => c.text === text);
    expect(byText('오늘 jira 이슈 등록된거 브리핑해줘')?.expect).toEqual({ entryId: 'jira.issues', args: { window: 'created', range: 'today' } });
    expect(byText('오늘 나한테 할당된 jira 이슈가 있을텐데 ?')?.expect).toEqual({ entryId: 'jira.issues', args: {} });
    expect(byText('그 중에 위클리카만')).toMatchObject({ prior: { entryId: 'jira.issues' }, expect: { entryId: 'jira.issues', args: { keyword: '위클리카' } } });
  });

  it('every expectation is a canonical selection the validator accepts unchanged (grounded keywords, closed values)', () => {
    const offered = new Map(ALL.map((entry) => [entry.id, entry] as const));
    const problems: string[] = [];
    for (const golden of corpus.cases) {
      if (golden.prior !== undefined && !isNlCatalogEntryId(golden.prior.entryId)) problems.push(`${golden.id}: prior entry`);
      if (golden.expect === 'none') continue;
      const prepared = prepareSelectionInput(golden.text);
      if ('skip' in prepared) {
        problems.push(`${golden.id}: skipped (${prepared.skip})`);
        continue;
      }
      const result = validateSelection(golden.expect, {
        offered,
        groundingText: prepared.groundingText,
        ...(golden.prior !== undefined ? { previousArgs: golden.prior.args } : {}),
        now: NOW,
        timeZone: 'Asia/Seoul',
      });
      if (!result.ok) problems.push(`${golden.id}: ${result.reason} ${result.arg ?? ''}`);
      else if (JSON.stringify(sorted(result.value.args)) !== JSON.stringify(sorted(golden.expect.args))) {
        problems.push(`${golden.id}: not canonical ${JSON.stringify(golden.expect.args)} -> ${JSON.stringify(result.value.args)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps every negative and positive within the selection input bound (no case is skipped as too long)', () => {
    for (const golden of corpus.cases) expect(prepareSelectionInput(golden.text)).not.toEqual({ skip: 'too-long' });
  });
});

function sorted(args: NlArgs): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

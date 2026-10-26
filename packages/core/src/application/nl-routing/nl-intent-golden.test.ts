import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_CATALOG_ENTRY_IDS, isNlCatalogEntryId, type NlArgs, type NlCatalogEntry } from './catalog';
import { prepareSelectionInput } from './selection-input';
import { buildSelectionPrompt } from './selection-prompt';
import { validateSelection } from './selection-validator';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 D12 corpus `golden/nl-intent.v1.json`: shape, size, the owner's phrases verbatim, and that every expectation is
// a canonical selection the D4 validator accepts unchanged (the same check the dispatch test and the Strict evaluation
// rely on, so an exact {entry, args} match is well defined).

export interface NlIntentCase {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
  readonly prior?: {
    readonly entryId: string;
    readonly args: NlArgs;
    /** Owner decision D1: chat turns since the previous listing. */
    readonly turns?: number;
    /** P7: the latest selection of each other source. */
    readonly earlier?: readonly { readonly entryId: string; readonly args: NlArgs; readonly turns: number }[];
  };
  /** Owner decision D4: the help-scope question shown, and the option a worded reply means (`expect` stays `none`). */
  readonly openQuestion?: { readonly sources: string | readonly string[]; readonly language: 'ko' | 'en' };
  readonly expectAnswer?: number;
  readonly channel?: boolean;
  readonly note?: string;
  /** S1: the frozen Class B grammar that answers it in Phase A (production flags); checked by the app dispatch test. */
  readonly grammar?: string;
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

  it('S1 (ADR-0121, ADR-0120 D6 Phase C): every entry with a frozen Class B grammar has >= 25 phrasings that grammar answers today', () => {
    const classB = ['jira.issues', 'github.items', 'slack.search', 'confluence.search', 'calendar.events', 'mail.list', 'drive.files', 'todo.list', 'help.topic'];
    for (const id of classB) {
      expect(corpus.cases.filter((c) => c.grammar !== undefined && c.expect !== 'none' && c.expect.entryId === id).length, id).toBeGreaterThanOrEqual(25);
    }
    // Narrowing follow-ups with no previous selection are negatives (a clarification is not wrong, a capture is).
    expect(corpus.cases.filter((c) => c.prior === undefined && c.expect === 'none' && /^(?:그\s?중에|among those)/.test(c.text)).length).toBeGreaterThanOrEqual(5);
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
      // P7: a gold for an earlier selection's entry is grounded against that earlier selection, as the runtime does.
      const base = golden.prior?.entryId === golden.expect.entryId ? golden.prior : (golden.prior?.earlier?.find((item) => item.entryId === golden.expect.entryId) ?? golden.prior);
      const result = validateSelection(golden.expect, {
        offered,
        groundingText: prepared.groundingText,
        ...(base !== undefined ? { previousArgs: base.args } : {}),
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

  it('the selection prompt quotes no corpus phrase verbatim (the evaluation measures generalization, not recall)', () => {
    const prompt = buildSelectionPrompt({ entries: ALL, text: '' });
    const leaked = corpus.cases.filter((golden) => golden.text.trim().length >= 8 && prompt.includes(golden.text.trim())).map((golden) => golden.id);
    expect(leaked).toEqual([]);
  });

  it('keeps every negative and positive within the selection input bound (no case is skipped as too long)', () => {
    for (const golden of corpus.cases) expect(prepareSelectionInput(golden.text)).not.toEqual({ skip: 'too-long' });
  });
});

function sorted(args: NlArgs): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

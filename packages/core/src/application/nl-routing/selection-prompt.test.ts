import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES, NL_CATALOG_ENTRY_IDS, NL_WAVE1_ENTRIES } from './index';
import { NL_RETRIEVED_EXAMPLES_HEADER, buildSelectionPrompt, renderRetrievedBlock, retrievalPromptVersion, type NlRetrievedExample } from './selection-prompt';
import type { NlCatalogEntry } from './catalog';

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);

const SLICE: readonly NlRetrievedExample[] = [
  { text: '이번 주 안에 끝내야 하는 지라 일 보여줘', output: '{"entryId":"jira.issues","args":{},"ambiguity":"CLEAR","alternatives":[]}' },
  { text: '그거 말고 다음 걸로', output: '{"entryId":"none","args":{},"ambiguity":"CLEAR","alternatives":[]}', previous: '{"entryId":"jira.issues","args":{}}', context: 'last listing: todo (3 items, 1 min ago)' },
];

describe('ADR-0123 D8 retrievedExamples slot', () => {
  it('is byte-identical when the slot is absent, empty or only a swap flag (read and A6 prompts)', () => {
    const read = buildSelectionPrompt({ entries: READS, text: '지라 이슈 보여줘' });
    const a6 = buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text: '그거 완료해줘', actions: { referenceContext: 'none' } });
    expect(buildSelectionPrompt({ entries: READS, text: '지라 이슈 보여줘', retrievedExamples: [] })).toBe(read);
    expect(buildSelectionPrompt({ entries: READS, text: '지라 이슈 보여줘', retrievedExamples: [], replaceStaticExamples: true })).toBe(read);
    expect(buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text: '그거 완료해줘', actions: { referenceContext: 'none' }, retrievedExamples: [] })).toBe(a6);
  });

  it('keeps the static prefix intact and inserts the block after the static examples, before Previous selection', () => {
    const base = buildSelectionPrompt({ entries: READS, text: 'x' });
    const withSlot = buildSelectionPrompt({ entries: READS, text: 'x', retrievedExamples: SLICE });
    const cut = base.indexOf('\n\nPrevious selection: none');
    expect(cut).toBeGreaterThan(0);
    expect(withSlot.startsWith(base.slice(0, cut))).toBe(true);
    expect(withSlot.slice(cut)).toBe(`\n\n${renderRetrievedBlock(SLICE)}${base.slice(cut)}`);
    expect(renderRetrievedBlock(SLICE).startsWith(NL_RETRIEVED_EXAMPLES_HEADER)).toBe(true);
  });

  it('renders the same for the A6 prompt, and replaceStaticExamples swaps the static set out (A0-swap)', () => {
    const input = { entries: [...READS, ...ACTIONS], text: 'x', actions: { referenceContext: 'none' } } as const;
    const base = buildSelectionPrompt(input);
    const slotted = buildSelectionPrompt({ ...input, retrievedExamples: SLICE });
    expect(slotted).toContain(`\n\n${renderRetrievedBlock(SLICE)}\n\nPrevious selection: none`);
    expect(slotted.length).toBeGreaterThan(base.length);
    const swapped = buildSelectionPrompt({ ...input, retrievedExamples: SLICE, replaceStaticExamples: true });
    expect(swapped).not.toContain(NL_RETRIEVED_EXAMPLES_HEADER);
    expect(swapped).toContain('Examples:\nMessage: 이번 주 안에 끝내야 하는 지라 일 보여줘');
    expect(swapped.length).toBeLessThan(base.length);
  });

  it('pins the rendered block for a fixed slice (golden/nl-select.retrieved-block.v1.json)', () => {
    const golden = JSON.parse(readFileSync(new URL('../golden/nl-select.retrieved-block.v1.json', import.meta.url), 'utf8')) as { header: string; examples: NlRetrievedExample[]; block: string };
    expect(golden.header).toBe(NL_RETRIEVED_EXAMPLES_HEADER);
    expect(renderRetrievedBlock(golden.examples)).toBe(golden.block);
    expect(renderRetrievedBlock(undefined)).toBe('');
  });

  it('adds the +rkN suffix to the prompt version', () => {
    expect(retrievalPromptVersion('nl-select.v37', 3)).toBe('nl-select.v37+rk3');
  });
});

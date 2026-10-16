import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES, NL_CATALOG_ENTRY_IDS, NL_WAVE1_ENTRIES, buildSelectionPrompt, normalize, type NlCatalogEntry } from '@quoky/core';
import { armsFor, buildSchedule } from './arms';
import { A6_ENTRY_IDS, READ_ENTRY_IDS, staticExamples } from './audit';
import type { PoolEntry } from './pool';
import { outputEntryId, type PoolVector } from './retrieve';
import { renderArmPrompt, runExperiment, staticCountsOf, type ArmRenderInput, type ExperimentCase } from './selector-rag-eval';

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);

const out = (entryId: string): string => `{"entryId":"${entryId}","args":{},"ambiguity":"CLEAR","alternatives":[]}`;
const entry = (id: string, text: string, entryId: string, needs: string[] = []): PoolEntry => ({ id, text, output: out(entryId), needs, source: 'drafted', batch: 1, language: 'ko' });
const vec = (x: number, y: number): PoolVector['vector'] => [x, y];
const pv = (e: PoolEntry, v: PoolVector['vector']): PoolVector => ({ entry: e, entryId: outputEntryId(e), vector: v });

const pool: PoolVector[] = [
  pv(entry('p-01', '비밀문구알파 지라 목록', 'jira.issues', ['jira.issues']), vec(1, 0)),
  pv(entry('p-02', '비밀문구베타 지라 개수', 'jira.issues', ['jira.issues']), vec(0.9, 0.1)),
  pv(entry('p-03', '비밀문구감마 해야 할 일 추가', 'todo.add', ['todo.add']), vec(0.8, 0.2)),
  pv(entry('p-04', '비밀문구델타 잡담', 'none'), vec(0.1, 0.9)),
  pv(entry('p-05', '비밀문구엡실론 드라이브', 'drive.files', ['drive.files']), vec(0.7, 0.3)),
  pv(entry('p-06', '비밀문구제타 메일', 'mail.messages', ['mail.messages']), vec(0.6, 0.4)),
];
const statics = staticExamples();
const baseInput = (over: Partial<ArmRenderInput>): ArmRenderInput => ({
  arm: { id: 'A1@m', kind: 'A1', embeddingModel: 'm' },
  run: 1,
  caseId: 'case-1',
  context: { entries: READS, text: '지라 이슈 보여줘' },
  offered: READ_ENTRY_IDS,
  staticTexts: statics.texts,
  pool,
  poolDigest: 'pd',
  spaceId: 'space-1',
  queryVector: vec(1, 0),
  baseVersion: 'nl-select.v39',
  k: 3,
  ...over,
});

describe('ADR-0123 RAG-2 arm rendering', () => {
  it('A0 renders the unchanged static prompt with no slot', () => {
    const { prompt, record } = renderArmPrompt(baseInput({ arm: { id: 'A0', kind: 'A0' } }));
    expect(prompt).toBe(buildSelectionPrompt({ entries: READS, text: '지라 이슈 보여줘' }));
    expect(record.blockSha256).toBeNull();
    expect(record.retrievedIds).toEqual([]);
  });

  it('A1 renders the slot with the top-k by cosine, one per entry, and only entries the prompt mode offers', () => {
    const { prompt, record } = renderArmPrompt(baseInput({}));
    // read mode offers only the reads: todo.add (an action) is filtered out; the 80% subsample may drop more
    expect(record.promptVersion).toBe('nl-select.v39+rk3');
    expect(record.retrievedIds.length).toBeGreaterThan(0);
    for (const id of record.retrievedIds) expect(['p-01', 'p-02', 'p-04', 'p-05', 'p-06']).toContain(id);
    expect(record.retrievedIds).not.toContain('p-03');
    const ids = record.retrievedIds.map((id) => outputEntryId(pool.find((c) => c.entry.id === id)?.entry as PoolEntry));
    expect(new Set(ids).size).toBe(ids.length);
    expect(prompt).toContain('More examples');
    const a6 = renderArmPrompt(baseInput({ offered: A6_ENTRY_IDS, context: { entries: [...READS, ...ACTIONS], text: 'x', actions: { referenceContext: 'none' } }, run: 2 }));
    expect(a6.record.promptVersion).toBe('nl-select.v39+rk3');
  });

  it('never retrieves a duplicate of a static example', () => {
    const [firstStatic] = [...statics.texts];
    const dup = pv(entry('p-99', firstStatic as string, 'none'), vec(1, 0));
    const { record } = renderArmPrompt(baseInput({ pool: [dup, ...pool] }));
    expect(record.retrievedIds).not.toContain('p-99');
    expect(normalize(firstStatic as string)).toBe(firstStatic);
  });

  it('A2 is deterministic for the same seed and differs across runs or cases', () => {
    const a2 = { id: 'A2', kind: 'A2' } as const;
    const one = renderArmPrompt(baseInput({ arm: a2 }));
    const again = renderArmPrompt(baseInput({ arm: a2 }));
    expect(again.prompt).toBe(one.prompt);
    expect(again.record).toEqual(one.record);
    expect(one.record.scores).toEqual([]);
    const variants = new Set([1, 2, 3, 4, 5, 6].map((run) => renderArmPrompt(baseInput({ arm: a2, run })).record.retrievedIds.join(',')));
    expect(variants.size).toBeGreaterThan(1);
  });

  it('A0-swap replaces the static examples with a frozen draw, identical for a run and different across runs', () => {
    const swap = { id: 'A0-swap', kind: 'A0-swap' } as const;
    const one = renderArmPrompt(baseInput({ arm: swap }));
    expect(renderArmPrompt(baseInput({ arm: swap })).prompt).toBe(one.prompt);
    expect(one.prompt).not.toBe(buildSelectionPrompt({ entries: READS, text: '지라 이슈 보여줘' }));
    expect(one.prompt).not.toContain('More examples');
    expect(one.record.promptVersion).toBe('nl-select.v39+swap');

  });

  it('records hashes, ids and rounded scores only: no owner or pool text', () => {
    const { prompt, record } = renderArmPrompt(baseInput({}));
    const serialized = JSON.stringify(record);
    for (const candidate of pool) expect(serialized).not.toContain(candidate.entry.text);
    expect(serialized).not.toContain('지라 이슈 보여줘');
    expect(record.blockSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.promptSha256).toBe(createHash('sha256').update(prompt).digest('hex'));
    for (const score of record.scores) expect(Math.round(score * 100) / 100).toBe(score);
    // the block hash binds the exact rendered block: the same input hashes the same, another query changes it
    expect(renderArmPrompt(baseInput({})).record.blockSha256).toBe(record.blockSha256);
    expect(renderArmPrompt(baseInput({ queryVector: vec(0, 1) })).record.blockSha256).not.toBe(record.blockSha256);
  });
});

describe('ADR-0123 RAG-2 A0-swap scoping and hashing', () => {
  const swap = { id: 'A0-swap', kind: 'A0-swap' } as const;
  const big: PoolVector[] = Array.from({ length: 40 }, (_, i) => [
    pv(entry(`j-${i}`, `젯${i} 지라`, 'jira.issues', ['jira.issues']), vec(1, i / 100)),
    pv(entry(`t-${i}`, `투${i} 투두`, 'todo.add', ['todo.add']), vec(0.5, i / 100)),
    pv(entry(`n-${i}`, `엔${i} 잡담`, 'none'), vec(0, i / 100)),
  ]).flat();

  it('derives the target counts from the current mode and draws only offered entries (read mode never gets an action example)', () => {
    const readPrompt = buildSelectionPrompt({ entries: READS, text: 'x' });
    const a6Prompt = buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text: 'x', actions: { referenceContext: 'none' } });
    const readCounts = staticCountsOf(readPrompt);
    expect(Object.keys(readCounts).some((id) => id.startsWith('todo.add'))).toBe(false);
    expect(staticCountsOf(a6Prompt)['todo.add']).toBeGreaterThan(0);
    const { record } = renderArmPrompt(baseInput({ arm: swap, pool: big }));
    expect(record.retrievedIds.length).toBe(Object.entries(readCounts).reduce((sum, [id, n]) => sum + Math.min(n, big.filter((c) => c.entryId === id).length), 0));
    expect(record.retrievedIds.some((id) => id.startsWith('t-'))).toBe(false);
    const a6 = renderArmPrompt(baseInput({ arm: swap, pool: big, offered: A6_ENTRY_IDS, context: { entries: [...READS, ...ACTIONS], text: 'x', actions: { referenceContext: 'none' } } }));
    expect(a6.record.retrievedIds.some((id) => id.startsWith('t-'))).toBe(true);
  });

  it('hashes the block as rendered under Examples:, not the More examples block', () => {
    const { prompt, record } = renderArmPrompt(baseInput({ arm: swap, pool: big }));
    const tail = prompt.slice(prompt.indexOf('\nExamples:\n') + 1, prompt.indexOf('\n\nPrevious selection:'));
    expect(record.blockSha256).toBe(createHash('sha256').update(tail).digest('hex'));
  });
});

describe('ADR-0123 RAG-2 experiment walk (stubbed transport, no call)', () => {
  it('renders every arm of every scheduled unit through the slot and scores entry-level', async () => {
    const arms = armsFor(['m']);
    const cases = new Map<string, ExperimentCase>([
      ['c1', { id: 'c1', entry: 'jira.issues', context: { entries: READS, text: 'a' }, offered: READ_ENTRY_IDS, queryVector: vec(1, 0) }],
      ['c2', { id: 'c2', entry: 'none', context: { entries: READS, text: 'b' }, offered: READ_ENTRY_IDS, queryVector: vec(0, 1) }],
    ]);
    const schedule = buildSchedule({ caseIds: ['c1', 'c2'], arms, runs: 2, sessions: 1, seed: 's' });
    const prompts: string[] = [];
    const results = await runExperiment({
      schedule,
      arms,
      cases,
      pool,
      poolDigest: 'pd',
      spaceId: 's',
      staticTexts: statics.texts,
      baseVersion: () => 'nl-select.v39',
      select: async (prompt) => {
        prompts.push(prompt);
        return 'jira.issues';
      },
      parseEntry: (raw) => raw,
    });
    expect(results).toHaveLength(2 * 2 * arms.length);
    expect(prompts.filter((prompt) => prompt.includes('More examples'))).toHaveLength(2 * 2 * 2);
    expect(results.filter((result) => result.record.arm === 'A1@m' && result.record.caseId === 'c1').every((result) => result.entryCorrect)).toBe(true);
  });
});

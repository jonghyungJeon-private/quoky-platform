import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_RECORD_PATH, type AuditRecord } from '../selector-rag-cli';
import { calibrateTau, recordId, spaceIdOf } from './embed';
import { loadGold } from './gold';
import { approvedEntries, checkPool, coverageOf, entryProblems, identifierProblems, loadPoolFile, poolDigest, type PoolEntry } from './pool';
import { drawSwap, retrieveRandomK, retrieveTopK, subsample, type PoolVector } from './retrieve';
import { splitCases } from './split';

const gold = loadGold();
const pool = loadPoolFile();

const entry = (over: Partial<PoolEntry> = {}): PoolEntry => ({
  id: 'x-001',
  text: '앞으로 일주일간 받을 예정인 소포가 있는지 알려줘',
  output: '{"entryId":"none","args":{},"ambiguity":"CLEAR","alternatives":[]}',
  needs: [],
  source: 'drafted',
  batch: 1,
  language: 'ko',
  ...over,
});

describe('ADR-0123 pool batch 1', () => {
  it('has the documented status: pending the owner, never self-approved', () => {
    expect(pool.batches).toEqual([expect.objectContaining({ batch: 1, status: 'pending-owner-approval', drafter: 'agent', approvedBy: null })]);
    expect(approvedEntries(pool)).toEqual([]);
  });

  it('passes the schema, identifier, credential, duplicate and n-gram lint against every gold case', () => {
    const report = checkPool(pool.entries, gold.cases);
    expect({ schema: report.schemaProblems, duplicates: report.duplicates, findings: report.findings }).toEqual({ schema: [], duplicates: [], findings: [] });
    expect(report.ok).toBe(true);
  });

  it('covers the read and the A6 entries and holds a share of negatives', () => {
    const coverage = coverageOf(pool.entries);
    expect(coverage.total).toBeGreaterThanOrEqual(60);
    expect(coverage.total).toBeLessThanOrEqual(100);
    expect(Object.entries(coverage.perEntry).filter(([, count]) => count < 3)).toEqual([]);
    expect(coverage.negativeShare).toBeGreaterThanOrEqual(0.15);
  });

  it('the committed audit record is fresh for this pool, gold and split (a stale audit fails the suite)', () => {
    const audit = JSON.parse(readFileSync(AUDIT_RECORD_PATH, 'utf8')) as AuditRecord;
    const split = splitCases(gold.cases.map((golden) => ({ id: golden.id, entry: golden.entry })));
    expect(audit.poolDigest).toBe(poolDigest(pool.entries));
    expect(audit.goldDigest).toBe(gold.sha256);
    expect(audit.splitSha256).toBe(createHash('sha256').update(JSON.stringify(split)).digest('hex'));
    expect(audit.models.map((model) => model.model)).toEqual(['nomic-embed-text', 'nomic-embed-text-v2-moe']);
    for (const model of audit.models) expect(model.spaceId).toMatch(/^nomic-embed-text(?:-v2-moe)?@[0-9a-f]{12}@ollama\d+\.\d+\.\d+$/);
  });
});

describe('pool admission rules', () => {
  it('rejects real identifiers and accepts placeholders', () => {
    expect(identifierProblems('OPS-4412 이슈 보여줘')).toHaveLength(1);
    expect(identifierProblems('ABC-123 이슈 보여줘')).toEqual([]);
    expect(identifierProblems('mail me at kim@corp.com')).toHaveLength(1);
    expect(identifierProblems('user@example.com')).toEqual([]);
    expect(identifierProblems('https://wiki.corp.net/x')).toHaveLength(1);
    expect(identifierProblems('https://example.invalid/x')).toEqual([]);
    expect(identifierProblems('#ops-oncall 에 올려줘')).toHaveLength(1);
    expect(identifierProblems('#channel-a 에 올려줘')).toEqual([]);
    expect(identifierProblems('@jeon 에게 전달')).toHaveLength(1);
  });

  it('checks the output against the closed catalog and its args', () => {
    const ok = entry({ text: '내 할 일에 빨래 개기 추가', output: '{"entryId":"todo.add","args":{"title":"빨래 개기"},"ambiguity":"CLEAR","alternatives":[]}', needs: ['todo.add'] });
    expect(entryProblems(ok)).toEqual([]);
    expect(entryProblems({ ...ok, output: ok.output.replace('todo.add', 'slack.post') }).join(' ')).toContain('not in the offered catalog');
    expect(entryProblems({ ...ok, output: ok.output.replace('빨래 개기', '설거지') }).join(' ')).toContain('not verbatim');
    expect(entryProblems({ ...ok, output: ok.output.replace('"title"', '"heading"') }).join(' ')).toContain('unknown arg');
    expect(entryProblems({ ...ok, output: '{"entryId":"jira.issues","args":{"range":"someday"},"ambiguity":"CLEAR","alternatives":[]}', needs: ['jira.issues'] }).join(' ')).toContain('range');
    expect(entryProblems(entry({ text: 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })).join(' ')).toContain('credential');
  });

  it('rejects an exact copy of a gold case (the lint has no ratchet)', () => {
    const copy = entry({ id: 'x-002', text: gold.cases.find((golden) => golden.text.length > 8)?.text ?? 'x' });
    expect(checkPool([copy], gold.cases).findings.some((finding) => finding.kind === 'exact')).toBe(true);
  });

  it('only owner-approved batches are usable', () => {
    const approved = { ...pool, batches: [{ ...pool.batches[0]!, status: 'approved' as const, approvedBy: 'owner', approvedOn: '2026-10-17' }] };
    expect(approvedEntries(approved)).toHaveLength(pool.entries.length);
    expect(approvedEntries({ ...approved, batches: [{ ...approved.batches[0]!, approvedBy: null }] })).toEqual([]);
  });

  it('the drafter cannot approve its own batch', () => {
    const base = pool.batches[0]!;
    const make = (approvedBy: string | null) => ({ ...pool, batches: [{ ...base, status: 'approved' as const, approvedBy }] });
    expect(approvedEntries(make('agent'))).toEqual([]);
    expect(approvedEntries(make(' Agent '))).toEqual([]);
    expect(approvedEntries(make(''))).toEqual([]);
    expect(approvedEntries(make('owner'))).toHaveLength(pool.entries.length);
  });

  it('validates the output through Core parseSelectionOutput', () => {
    const ok = entry({ text: '내 할 일에 빨래 개기 추가', output: '{"entryId":"todo.add","args":{"title":"빨래 개기"},"ambiguity":"CLEAR","alternatives":[]}', needs: ['todo.add'] });
    expect(entryProblems(ok)).toEqual([]);
    expect(entryProblems({ ...ok, output: ok.output.replace('"alternatives":[]', '"alternatives":[],"extra":1') }).join(' ')).toContain('parseSelectionOutput');
    const alt = (candidate: string) => entryProblems({ ...ok, output: ok.output.replace('"alternatives":[]', `"alternatives":[${candidate}]`), needs: ['todo.add', 'todo.complete'] }).join(' ');
    expect(alt('{"entryId":"todo.complete","args":{"ref":"#2"}}')).toBe('');
    expect(alt('{"entryId":"todo.complete","args":{"ref":"#2"},"junk":true}')).toContain('parseSelectionOutput');
    expect(alt('{"entryId":"slack.post","args":{}}')).toContain('alternative 1');
    expect(alt('{"entryId":"todo.complete","args":{"ref":"soon"}}')).toContain('alternative 1: arg ref');
    expect(alt('"todo.complete"')).toContain('parseSelectionOutput');
    expect(entryProblems({ ...ok, needs: [] }).join(' ')).toContain('needs');
  });

  it('the pool digest ignores the batch status', () => {
    expect(poolDigest(pool.entries)).toBe(poolDigest([...pool.entries]));
  });
});

describe('embedding helpers', () => {
  it('space id carries the model digest and the Ollama version', () => {
    expect(spaceIdOf('nomic-embed-text:latest', '0a109f422b47', '0.40.5')).toBe('nomic-embed-text@0a109f422b47@ollama0.40.5');
  });

  it('record id is stable and depends on previous and context', () => {
    expect(recordId('안녕 ', undefined, undefined)).toBe(recordId('안녕', undefined, undefined));
    expect(recordId('안녕', 'p')).not.toBe(recordId('안녕'));
    expect(recordId('안녕')).toHaveLength(32);
  });

  it('tau is the minimum positive minus the margin, with the false-positive rate of the negatives', () => {
    const result = calibrateTau({ positives: [0.99, 0.9, 0.95], negatives: [0.5, 0.6, 0.89, 0.7] });
    expect(result.tau).toBeCloseTo(0.88, 10);
    expect(result.falsePositiveRate).toBe(0.25);
    expect(() => calibrateTau({ positives: [], negatives: [] })).toThrow();
  });
});

describe('retrieval arms', () => {
  const mk = (id: string, entryId: string, vector: number[]): PoolVector => ({
    entry: entry({ id, text: id, output: `{"entryId":"${entryId}","args":{},"ambiguity":"CLEAR","alternatives":[]}`, needs: entryId === 'none' ? [] : [entryId] }),
    entryId,
    vector,
  });
  const vectors = [mk('a1', 'todo.list', [1, 0]), mk('a2', 'todo.list', [0.99, 0.1]), mk('b1', 'mail.list', [0.8, 0.6]), mk('c1', 'none', [0, 1]), mk('d1', 'drive.files', [-1, 0])];

  it('top-k takes at most one per entry, ordered by cosine with an id tie-break', () => {
    const picked = retrieveTopK([1, 0], vectors, 3);
    expect(picked.map((p) => p.entry.id)).toEqual(['a1', 'b1', 'c1']);
    expect(retrieveTopK([1, 0], [mk('z', 'todo.list', [1, 0]), mk('y', 'todo.list', [1, 0])], 2).map((p) => p.entry.id)).toEqual(['y']);
  });

  it('random-k is seeded and one per entry', () => {
    expect(retrieveRandomK(vectors, 'seed', 3).map((p) => p.entry.id)).toEqual(retrieveRandomK(vectors, 'seed', 3).map((p) => p.entry.id));
    expect(new Set(retrieveRandomK(vectors, 'seed', 4).map((p) => p.entryId)).size).toBe(retrieveRandomK(vectors, 'seed', 4).length);
  });

  it('the 80% subsample is seeded by the run', () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(`p${i}`, 'none', [1, 0]));
    expect(subsample(many, 'run-1')).toHaveLength(40);
    expect(subsample(many, 'run-1').map((p) => p.entry.id)).toEqual(subsample(many, 'run-1').map((p) => p.entry.id));
    expect(subsample(many, 'run-2').map((p) => p.entry.id)).not.toEqual(subsample(many, 'run-1').map((p) => p.entry.id));
  });

  it('A0-swap keeps the static per-entry counts and reports a shortfall', () => {
    const draw = drawSwap(vectors.map((v) => v.entry), { 'todo.list': 2, 'mail.list': 3 }, 'A0-swap:run-1');
    expect(draw.chosen).toHaveLength(3);
    expect(draw.shortfall).toEqual({ 'mail.list': 2 });
  });
});

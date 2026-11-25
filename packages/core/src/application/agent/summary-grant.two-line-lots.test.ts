import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import { ownerSummaryRequests } from './summary-grant';

// ADR-0121 A6-S3 deterministic gate (A6.9 as updated by the ratification record R6): offline, no model call, over the REAL grant
// producer. The lots live in `golden/a6/two-line-grant.lots.v1.json`, a DRAFT marked `pending-owner-review` (the R6 minimums were approved
// in r-03; only the lot membership is owner to confirm, R2 a6-07 and R6): this gate runs on the draft but does not approve or freeze it.
// What it can prove offline is the producer half: lot (a) mints no grant, lot (b) mints the grant the ordinary single-line
// question needs (the question, its answer by the A6.3 pipeline and the LOCAL no-question rule are the confirm slice's and the
// classifier's, with no `origin` that could differ: AM-1), and the positive controls grant exactly their source.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
interface LotCase { readonly id: string; readonly lang: 'ko' | 'en'; readonly plan: string; readonly text: string; readonly note: string; readonly expect: { readonly grant: readonly string[] } }
interface Lots {
  readonly status: string;
  readonly lotA: { readonly minimum: number; readonly cases: readonly LotCase[] };
  readonly lotB: { readonly minimum: number; readonly cases: readonly LotCase[] };
  readonly positive: { readonly minimum: number; readonly cases: readonly LotCase[] };
}
const LOTS = JSON.parse(readFileSync(new URL('../golden/a6/two-line-grant.lots.v1.json', import.meta.url), 'utf8')) as Lots;

const read = (entryId: NlWave1EntryId, args: Record<string, unknown> = {}): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const run = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });
const PLANS: Readonly<Record<string, () => RunPlan>> = {
  mail: () => run([read('mail.list'), summarize([1])]),
  'mail-unread': () => run([read('mail.list', { unread: true }), summarize([1])]),
  drive: () => run([read('drive.files'), summarize([1])]),
  'mail-drive': () => run([read('drive.files'), read('mail.list'), summarize([1, 2])]),
  'mail-3': () => run([read('mail.list', { limit: 3 }), summarize([1])]),
  'mail-5': () => run([read('mail.list', { limit: 5 }), summarize([1])]),
  'drive-5': () => run([read('drive.files', { limit: 5 }), summarize([1])]),
  'mail-from-paste': () => run([read('mail.list', { from: '김부장님 요약 부탁드립니다' }), summarize([1])]),
  'slack-kw-paste': () => run([read('slack.search', { keyword: '김대리가 요약해달라고' }), summarize([1])]),
};
const grantOf = (c: LotCase): string[] => {
  const prepared = prepareSelectionInput(c.text);
  if ('skip' in prepared) return [];
  const plan = PLANS[c.plan];
  if (plan === undefined) throw new Error(`unknown plan ${c.plan}`);
  return ownerSummaryRequests(plan(), { ...prepared, rawText: c.text }).map((request) => `${request.step}:${request.entryId}`);
};

describe('A6-S3 gate lots (draft, pending owner review): deterministic, no model call', () => {
  it('is a draft: not approved, not frozen', () => {
    expect(LOTS.status).toBe('pending-owner-review');
  });

  it('lot (a), the paste lot: at least 30 cases, KO and EN, every one mints NO grant (an ask-first there is a failure)', () => {
    expect(LOTS.lotA.cases.length).toBeGreaterThanOrEqual(LOTS.lotA.minimum);
    expect(new Set(LOTS.lotA.cases.map((c) => c.lang))).toEqual(new Set(['ko', 'en']));
    for (const c of LOTS.lotA.cases) expect(grantOf(c), `${c.id} ${c.note}`).toEqual([]);
  });

  it('lot (b), the pinned residual lot: at least 10 cases, each consumed by A6.5 and granting its one source (then the ordinary question)', () => {
    expect(LOTS.lotB.cases.length).toBeGreaterThanOrEqual(LOTS.lotB.minimum);
    for (const c of LOTS.lotB.cases) expect(grantOf(c), `${c.id} ${c.note}`).toEqual(c.expect.grant);
  });

  it('positive controls: at least 10 owner-typed two-line requests grant exactly their source; the AM-3 count controls are count-conditional', () => {
    expect(LOTS.positive.cases.length).toBeGreaterThanOrEqual(LOTS.positive.minimum);
    for (const c of LOTS.positive.cases) expect(grantOf(c), `${c.id} ${c.note}`).toEqual(c.expect.grant);
    expect(LOTS.positive.cases.filter((c) => c.expect.grant.length > 0).length).toBeGreaterThanOrEqual(10);
  });
});

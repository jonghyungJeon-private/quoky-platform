import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { flowLabel, type FlowLabel } from '../../domain/flow-label';

/**
 * ADR-0121 amendment A5 (owner decision 2026-11-18; clause and constitution amendments PROPOSED, Strict ratification pending):
 * an owner-requested summary of calendar, Jira, Slack, Confluence and GitHub items follows rule ① like mail and Drive. This
 * test models ONLY the proposed summary-readout label of those five sources (`REMOTE_ON_SUMMARY_REQUEST`, `OWNER_DM_ONLY`)
 * so that the REAL grant producer says which SR-1 cases the decision changes. It pins that the corpus marks exactly those
 * cases `approved-awaiting-implementation` with the target grant the producer would mint, and nothing else. No product
 * code reads this label yet (slice A5-S1).
 */
const A5_SOURCES = ['calendar', 'jira', 'slack', 'confluence', 'github'];

// The mock replaces `readOutputLabel` for EVERY importer of `flow-policy` in this file's module graph, not only the grant
// producer. That is safe here because the only other code this test runs is `validateAgentPlan`, which does not read the label
// (asserted below from its source), and `structure-projector` / `quarantined-summary` (the other readers) are never called.
vi.mock('./flow-policy', async (importOriginal) => {
  const real = await importOriginal<typeof import('./flow-policy')>();
  return {
    ...real,
    readOutputLabel: (entryId: Parameters<typeof real.readOutputLabel>[0]): FlowLabel => {
      const source = real.AGENT_READ_SOURCES[entryId].source;
      return A5_SOURCES.includes(source) ? flowLabel('UNTRUSTED', 'REMOTE_ON_SUMMARY_REQUEST', 'OWNER_DM_ONLY', [source]) : real.readOutputLabel(entryId);
    },
  };
});

const { NL_ACTION_ENTRIES } = await import('../nl-routing/action-entries');
const { NL_CATALOG_ENTRY_IDS } = await import('../nl-routing/catalog');
const { prepareSelectionInput } = await import('../nl-routing/selection-input');
const { NL_WAVE1_ENTRIES } = await import('../nl-routing/wave1-entries');
const { AGENT_READ_SOURCES } = await import('./flow-policy');
const { validateAgentPlan } = await import('./plan-validator');
const { ownerSummaryRequests } = await import('./summary-grant');

interface PlannerStep {
  readonly entryId?: string;
  readonly args?: Record<string, unknown>;
  readonly ref?: Record<string, unknown>;
  readonly summarize?: readonly number[];
  readonly schema?: string;
}

interface Case {
  readonly id: string;
  readonly status: string;
  readonly text: string;
  readonly channel?: string;
  readonly planner?: readonly PlannerStep[];
  readonly expect: { readonly grant?: readonly string[] };
  readonly awaiting?: { readonly decided: string; readonly knownGap?: { readonly kind: string; readonly closedBy: string }; readonly expect: { readonly grant?: readonly string[] } };
}

const CORPUS = JSON.parse(readFileSync(new URL('../golden/agent-redteam.s2-read.v1.json', import.meta.url), 'utf8')) as {
  readonly fixture: { readonly now: string; readonly timeZone: string };
  readonly cases: readonly Case[];
};

/**
 * A5 known gaps (review round 1): owner-intent summaries the producer cannot ground even under the proposed label. Their
 * target is set by hand to the summarize step's covered work-source reads and waits for A5-S3, which closes the gap
 * structurally (catalog source names; the separable particle of the existing word "sum up"), never with a phrase list.
 */
const KNOWN_GAPS: Readonly<Record<string, 'source-alias' | 'split-particle'>> = {
  'rt-s2r-002': 'source-alias',
  'rt-s2r-204': 'split-particle',
  'rt-s2r-232': 'split-particle',
  'rt-s2r-244': 'source-alias',
  'rt-s2r-246': 'split-particle',
  'rt-s2r-248': 'source-alias',
  'rt-s2r-250': 'source-alias',
  'rt-s2r-255': 'source-alias',
  'rt-s2r-257': 'source-alias',
  'rt-s2r-414': 'source-alias',
};

/** The 112 SR-1 cases the owner's 2026-11-18 decision changes (DECISIONS.md "ADR-0121 amendment A5", A5.6). */
const A5_CASES = [
  6, 11, 128, 129, 130, 131, 134, 136, 137, 141, 201, 202, 203, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222,
  223, 224, 225, 226, 227, 228, 229, 230, 231, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 245, 247, 249, 251, 252, 253, 254, 256, 258, 259,
  260, 261, 262, 263, 264, 265, 266, 274, 277, 279, 281, 332, 333, 348, 349, 350, 352, 353, 355, 356, 357, 358, 361, 362, 363, 364, 365, 368, 369, 370,
  371, 372, 375, 376, 377, 378, 379, 409, 410, 411, 412, 413, 415, 416, 418, 419, 426, 432, 443, 492, 493,
].map((n) => `rt-s2r-${String(n).padStart(3, '0')}`);

const OFFERED = new Map(
  [...NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]), ...Object.values(NL_ACTION_ENTRIES).filter((entry) => entry !== undefined)].map((entry) => [entry.id, entry] as const),
);

/** The grant pairs the real producer mints for the answer turn under the proposed A5 label (`[]` unless the plan runs). */
function a5Grant(c: Case): string[] {
  const prepared = prepareSelectionInput(c.text);
  if ('skip' in prepared) return [];
  const steps = (c.planner ?? []).map((step) =>
    step.summarize !== undefined
      ? { kind: 'summarize' as const, from: step.summarize, schema: step.schema ?? '' }
      : { kind: 'read' as const, entryId: step.entryId ?? '', args: step.args ?? {}, ...(step.ref !== undefined ? { ref: step.ref } : {}) },
  );
  const result = validateAgentPlan({ kind: 'steps', form: 'steps', steps, ambiguity: 'CLEAR', alternatives: [] } as never, {
    offered: OFFERED,
    groundingText: prepared.groundingText,
    now: CORPUS.fixture.now as never,
    timeZone: CORPUS.fixture.timeZone,
    direct: (c.channel ?? 'owner-dm') === 'owner-dm',
  });
  if (!result.ok || result.plan.kind !== 'run') return [];
  return ownerSummaryRequests(result.plan, prepared).map((request) => `${request.step}:${request.entryId}`);
}

const isWork = (pair: string): boolean => A5_SOURCES.includes(AGENT_READ_SOURCES[pair.split(':')[1] as keyof typeof AGENT_READ_SOURCES]?.source ?? '');

describe('ADR-0121 amendment A5: the SR-1 cases the work-source summary decision changes', () => {
  it('are exactly the cases whose grant gains a work-source pair under the proposed label, and they carry that grant as the target', () => {
    const changed = CORPUS.cases.filter((c) => a5Grant(c).some(isWork)).map((c) => c.id);
    expect(changed).toEqual(A5_CASES);
    const marked = CORPUS.cases.filter((c) => c.awaiting?.decided === '2026-11-18' && c.awaiting.knownGap === undefined).map((c) => c.id);
    expect(marked).toEqual(A5_CASES);
    for (const c of CORPUS.cases.filter((x) => A5_CASES.includes(x.id))) {
      expect(c.status, c.id).toBe('approved-awaiting-implementation');
      expect(c.awaiting?.expect.grant, c.id).toEqual(a5Grant(c));
    }
  });

  it('pins the known gaps: the producer still mints no work-source pair, and the target is the step\'s covered work-source reads', () => {
    const gaps = CORPUS.cases.filter((c) => c.awaiting?.knownGap !== undefined);
    expect(gaps.map((c) => c.id)).toEqual(Object.keys(KNOWN_GAPS));
    for (const c of gaps) {
      expect(c.awaiting?.decided, c.id).toBe('2026-11-18');
      expect(c.awaiting?.knownGap, c.id).toEqual({ kind: KNOWN_GAPS[c.id], closedBy: 'A5-S3' });
      // Still a gap: when A5-S3 lands this flips, and its PR moves the case to A5_CASES.
      expect(a5Grant(c).some(isWork), c.id).toBe(false);
      const planner = c.planner ?? [];
      const step = planner.findIndex((s) => s.summarize !== undefined) + 1;
      const covered = (planner[step - 1]?.summarize ?? []).map((from) => `${step}:${planner[from - 1]?.entryId ?? ''}`).filter(isWork);
      expect(covered.length, c.id).toBeGreaterThan(0);
      expect(c.awaiting?.expect.grant, c.id).toEqual([...new Set(covered)].sort());
    }
  });

  it('the label mock reaches only the grant producer: the plan validator does not read the label', () => {
    const validator = readFileSync(new URL('./plan-validator.ts', import.meta.url), 'utf8');
    expect(validator).not.toMatch(/readOutputLabel|from '\.\/(?:structure-projector|quarantined-summary|summary-grant)'/u);
  });

  it('models the label only: without the work-source pairs the producer mints exactly today\'s pinned grant', () => {
    for (const c of CORPUS.cases) {
      if (c.expect.grant === undefined) continue;
      expect(a5Grant(c).filter((pair) => !isWork(pair)), c.id).toEqual(c.expect.grant);
    }
  });
});

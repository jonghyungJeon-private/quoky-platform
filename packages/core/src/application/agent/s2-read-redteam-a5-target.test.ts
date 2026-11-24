import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0121 amendment A5 (owner decision 2026-11-18, ratified 2026-11-23): an owner-requested summary of calendar, Jira, Slack,
 * Confluence and GitHub items follows rule ① like mail and Drive. Since A5-S3 the REAL grant producer reads the summary-readout
 * label (no mock here): this test pins that the corpus marks exactly the cases whose grant gains a work-source pair
 * `approved-awaiting-implementation` with the grant the producer mints, and nothing else.
 */
const A5_SOURCES = ['calendar', 'jira', 'slack', 'confluence', 'github'];

const { NL_ACTION_ENTRIES } = await import('../nl-routing/action-entries');
const { NL_CATALOG_ENTRY_IDS } = await import('../nl-routing/catalog');
const { prepareSelectionInput } = await import('../nl-routing/selection-input');
const { NL_WAVE1_ENTRIES } = await import('../nl-routing/wave1-entries');
const { AGENT_READ_SOURCES } = await import('./flow-policy');
const { validateAgentPlan } = await import('./plan-validator');
const { ownerSummaryConsentSources, ownerSummaryRequests } = await import('./summary-grant');

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
  readonly awaiting?: { readonly decided: string; readonly knownGap?: { readonly kind: string; readonly closedBy: string }; readonly expect: { readonly grant?: readonly string[]; readonly consentSources?: readonly string[] } };
}

const CORPUS = JSON.parse(readFileSync(new URL('../golden/agent-redteam.s2-read.v1.json', import.meta.url), 'utf8')) as {
  readonly fixture: { readonly now: string; readonly timeZone: string };
  readonly cases: readonly Case[];
};

/**
 * The 8 cases that were known gaps before A5-S3 and are closed there (catalog source names, the separable particle of
 * "sum up"). Review round 1 removed the `repo` alias (substring hazard: "report"), so `rt-s2r-244` and `rt-s2r-250` ("my repo")
 * stay open known gaps (`source-alias`); a new word is a catalog change reviewed with its D12 gate.
 */
const CLOSED_GAPS = [2, 204, 232, 246, 248, 255, 257, 414].map((n) => `rt-s2r-${String(n).padStart(3, '0')}`);

/** The 112 derived SR-1 cases the owner's 2026-11-18 decision changes (DECISIONS.md "ADR-0121 amendment A5", A5.6), then the 8 closed gaps, in corpus order. */
const A5_CASES = [
  6, 11, 128, 129, 130, 131, 134, 136, 137, 141, 201, 202, 203, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222,
  223, 224, 225, 226, 227, 228, 229, 230, 231, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 245, 247, 249, 251, 252, 253, 254, 256, 258, 259,
  260, 261, 262, 263, 264, 265, 266, 274, 277, 279, 281, 332, 333, 348, 349, 350, 352, 353, 355, 356, 357, 358, 361, 362, 363, 364, 365, 368, 369, 370,
  371, 372, 375, 376, 377, 378, 379, 409, 410, 411, 412, 413, 415, 416, 418, 419, 426, 432, 443, 492, 493,
].map((n) => `rt-s2r-${String(n).padStart(3, '0')}`);
const OPEN_GAPS: Readonly<Record<string, 'source-alias'>> = { 'rt-s2r-244': 'source-alias', 'rt-s2r-250': 'source-alias' };
const A5_ALL = new Set([...A5_CASES, ...CLOSED_GAPS]);

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
  it('are exactly the 120 cases whose grant gains a work-source pair (plus the 2 open gaps, which carry their target by hand)', () => {
    const inCorpus = CORPUS.cases.map((c) => c.id).filter((id) => A5_ALL.has(id));
    expect(A5_ALL.size).toBe(120);
    expect(CORPUS.cases.filter((c) => a5Grant(c).some(isWork)).map((c) => c.id)).toEqual(inCorpus);
    expect(CORPUS.cases.filter((c) => c.awaiting?.decided === '2026-11-18').map((c) => c.id)).toEqual([...A5_ALL, ...Object.keys(OPEN_GAPS)].sort((a, b) => CORPUS.cases.findIndex((c) => c.id === a) - CORPUS.cases.findIndex((c) => c.id === b)));
    for (const c of CORPUS.cases.filter((x) => A5_ALL.has(x.id))) {
      expect(c.status, c.id).toBe('approved-awaiting-implementation');
      expect(c.awaiting?.expect.grant, c.id).toEqual(a5Grant(c));
    }
  });

  it('A5-S3 closed 8 known gaps (each now mints its covered work-source reads); the 2 "my repo" cases stay open known gaps', () => {
    const open = CORPUS.cases.filter((c) => c.awaiting?.knownGap !== undefined);
    expect(open.map((c) => c.id)).toEqual(Object.keys(OPEN_GAPS));
    for (const c of open) {
      expect(c.awaiting?.knownGap?.kind, c.id).toBe(OPEN_GAPS[c.id]);
      // Still a gap: the producer mints no work-source pair without a `repo` alias.
      expect(a5Grant(c).some(isWork), c.id).toBe(false);
    }
    for (const id of CLOSED_GAPS) {
      const c = CORPUS.cases.find((x) => x.id === id)!;
      expect(c.awaiting?.decided, id).toBe('2026-11-18');
      expect(a5Grant(c).some(isWork), id).toBe(true);
      const planner = c.planner ?? [];
      const step = planner.findIndex((s) => s.summarize !== undefined) + 1;
      const covered = (planner[step - 1]?.summarize ?? []).map((from) => `${step}:${planner[from - 1]?.entryId ?? ''}`).filter(isWork);
      expect(c.awaiting?.expect.grant, id).toEqual([...new Set(covered)].sort());
    }
  });

  it('the one consent question names every granted source: the producer\'s consentSources equal the gold\'s, case by case', () => {
    for (const c of CORPUS.cases.filter((x) => A5_ALL.has(x.id))) {
      const prepared = prepareSelectionInput(c.text);
      if ('skip' in prepared) continue;
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
      if (!result.ok || result.plan.kind !== 'run') throw new Error(`${c.id}: plan did not validate`);
      const named = [...new Set(ownerSummaryConsentSources(result.plan, prepared).flatMap((entry) => entry.sources))].sort();
      expect(named, c.id).toEqual(c.awaiting?.expect.consentSources);
    }
  });

  it('the plan validator does not read the label or the grant producer', () => {
    const validator = readFileSync(new URL('./plan-validator.ts', import.meta.url), 'utf8');
    expect(validator).not.toMatch(/readOutputLabel|summaryReadoutLabel|from '\.\/(?:structure-projector|quarantined-summary|summary-grant)'/u);
  });

  it('the built floor is untouched: every case\'s `expect` still holds the pre-A5 listing-only behaviour for the work-source part', () => {
    for (const c of CORPUS.cases.filter((x) => A5_ALL.has(x.id))) {
      const built = c.expect.grant ?? [];
      expect(built.filter(isWork), c.id).toEqual([]);
      expect(a5Grant(c).filter((pair) => !isWork(pair)), c.id).toEqual(built);
    }
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { routeCrossWrite, type AgentCrossWriteContext, type AgentCrossWriteReceipt, type CrossWriteRoute } from './cross-write';
import { AGENT_PLAN_PROMPT_VERSION, buildAgentPlanPrompt } from './plan-prompt';
import { parseAgentPlanOutput } from './plan-schema';
import { validateAgentPlan } from './plan-validator';

/**
 * ADR-0121 A7, slice A7-S1: the plan-form share of the A7.9 plan gold (`golden/agent-plan.a7.v1.json`), pinned against the REAL
 * validator and the REAL step 0 router. Every case is `pending-owner-approval` (A7.9: the owner reviews every batch), never
 * scored by a model, and no planner prompt names the A7 form yet. This test proves the data follows the rules, not the other
 * way round: a case whose expectation the code does not give fails here, and the case is not "fixed" by editing the code to fit.
 */

interface GoldCase {
  readonly id: string;
  readonly batch: string;
  readonly status: string;
  readonly category: string;
  readonly lang: 'ko' | 'en';
  readonly text: string;
  readonly context: string;
  readonly plan?: unknown;
  readonly expect?: { readonly outcome: 'cross-write' | 'refused'; readonly reason?: string } & Record<string, unknown>;
  readonly route?: CrossWriteRoute;
  readonly note?: string;
}
interface Gold {
  readonly version: number;
  readonly contexts: Readonly<Record<string, string>>;
  readonly fixture: { readonly now: string; readonly timeZone: string; readonly direct: boolean };
  readonly cases: readonly GoldCase[];
}

const gold = JSON.parse(readFileSync(new URL('../golden/agent-plan.a7.v1.json', import.meta.url), 'utf8')) as Gold;
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const OFFERED = new Map([...READS, ...ACTIONS].map((entry) => [entry.id, entry] as const));

const ON: AgentCrossWriteContext = {
  active: { jira: true, slack: true, calendar: true },
  writers: { jira: true, slack: true, calendar: true },
  jiraProjects: ['BE'],
  slackChannels: ['quoky-test'],
  sources: ['slack.search', 'jira.issues', 'jira.release'],
};
const receipt = (over: Partial<AgentCrossWriteReceipt> = {}): AgentCrossWriteContext => ({ ...ON, receipt: { fresh: true, sourceEntryId: 'slack.search', items: 3, hostOnly: false, handoffBuilt: false, ...over } });
const CONTEXTS: Readonly<Record<string, AgentCrossWriteContext | undefined>> = {
  on: ON,
  off: undefined,
  'jira-inactive': { ...ON, active: { jira: false, slack: true, calendar: true } },
  'jira-writer-off': { ...ON, writers: { ...ON.writers, jira: false } },
  'slack-writer-off': { ...ON, writers: { ...ON.writers, slack: false } },
  'slack-source-off': { ...ON, sources: ['jira.issues', 'jira.release'] },
  'two-projects': { ...ON, jiraProjects: ['BE', 'FE'] },
  'receipt-slack': receipt(),
  'receipt-jira': receipt({ sourceEntryId: 'jira.issues' }),
  'receipt-stale': receipt({ fresh: false }),
  'receipt-empty': receipt({ items: 0 }),
  'receipt-hostonly': receipt({ hostOnly: true }),
  'receipt-handoff': receipt({ handoffBuilt: true }),
  'receipt-mail': receipt({ sourceEntryId: 'mail.list' }),
  'receipt-source-off': { ...receipt({ sourceEntryId: 'jira.release' }), sources: ['slack.search', 'jira.issues'] },
};
const CATEGORIES = ['one-message', 'calendar-destination', 'followup', 'destination-pick', 'two-literals', 'literal-roles', 'unsuitable', 'inapplicable', 'verbatim-payload', 'literal-post-a6', 'routing-precedence', 'receipt-followup-route'];

describe('A7-S1 plan gold (agent-plan.a7.v1.json)', () => {
  it('is well formed: unique ids, pending-owner-approval, closed categories and contexts, KO at least 60 percent', () => {
    expect(gold.version).toBe(1);
    expect(new Set(gold.cases.map((golden) => golden.id)).size).toBe(gold.cases.length);
    for (const golden of gold.cases) {
      expect(golden.status, golden.id).toBe('pending-owner-approval');
      expect(golden.batch, golden.id).toMatch(/^A7-\d+$/u);
      expect(CATEGORIES, golden.id).toContain(golden.category);
      expect(Object.keys(CONTEXTS), golden.id).toContain(golden.context);
      expect(Object.keys(gold.contexts).sort()).toEqual(Object.keys(CONTEXTS).sort());
      expect(golden.plan !== undefined || golden.route !== undefined, golden.id).toBe(true);
      expect(golden.id.startsWith('a7p-'), golden.id).toBe(golden.expect?.outcome === 'cross-write');
    }
    expect(gold.cases.filter((golden) => golden.lang === 'ko').length / gold.cases.length).toBeGreaterThanOrEqual(0.6);
  });

  it('holds the plan-form share of the A7.9 minimums', () => {
    const count = (category: string): number => gold.cases.filter((golden) => golden.category === category).length;
    expect(count('one-message')).toBeGreaterThanOrEqual(15);
    expect(count('calendar-destination')).toBeGreaterThanOrEqual(6);
    expect(count('followup')).toBeGreaterThanOrEqual(10);
    expect(count('destination-pick')).toBeGreaterThanOrEqual(10);
    expect(count('two-literals') + count('literal-roles')).toBeGreaterThanOrEqual(20);
    expect(count('unsuitable')).toBeGreaterThanOrEqual(20);
    expect(count('inapplicable')).toBeGreaterThanOrEqual(7);
    expect(count('verbatim-payload')).toBeGreaterThanOrEqual(10);
    expect(count('literal-post-a6')).toBeGreaterThanOrEqual(10);
    expect(count('routing-precedence')).toBeGreaterThanOrEqual(10);
    expect(count('receipt-followup-route')).toBeGreaterThanOrEqual(10);
  });

  it('every case with a plan gets exactly its expected result from the real validator', () => {
    const problems: string[] = [];
    for (const golden of gold.cases) {
      if (golden.plan === undefined) continue;
      const parsed = parseAgentPlanOutput(JSON.stringify(golden.plan));
      if (parsed === null || parsed.kind !== 'steps') {
        problems.push(`${golden.id}: does not parse`);
        continue;
      }
      const crossWrite = CONTEXTS[golden.context];
      const verdict = validateAgentPlan(parsed, {
        offered: OFFERED,
        groundingText: prepareSelectionInput(golden.text).groundingText,
        now: gold.fixture.now as never,
        timeZone: gold.fixture.timeZone,
        direct: gold.fixture.direct,
        ...(crossWrite !== undefined ? { crossWrite } : {}),
      });
      const want = golden.expect as NonNullable<GoldCase['expect']>;
      const got = JSON.stringify(verdict, (key, value) => (key === 'entry' || key === 'provenance' || key === 'source' ? undefined : value));
      if (want.outcome === 'refused') {
        if (verdict.ok || verdict.reason !== want.reason) problems.push(`${golden.id} (${golden.text}): want refused ${want.reason}, got ${got}`);
        continue;
      }
      const { outcome: _outcome, ...subset } = want;
      try {
        expect(verdict).toMatchObject({ ok: true, plan: { kind: 'cross-write', ...subset } });
      } catch {
        problems.push(`${golden.id} (${golden.text}): want ${JSON.stringify(subset)}, got ${got}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every case with a route gets exactly its expected route from the real step 0 router', () => {
    const problems: string[] = [];
    for (const golden of gold.cases) {
      if (golden.route === undefined) continue;
      const got = routeCrossWrite({ groundingText: prepareSelectionInput(golden.text).groundingText, context: CONTEXTS[golden.context], offered: OFFERED });
      if (JSON.stringify(got) !== JSON.stringify(golden.route)) problems.push(`${golden.id} (${golden.text}) [${golden.context}]: want ${JSON.stringify(golden.route)}, got ${JSON.stringify(got)}`);
    }
    expect(problems).toEqual([]);
  });

  it('uses synthetic names only (no real person or organisation) and holds no token-shaped literal', () => {
    const text = JSON.stringify(gold.cases.map((golden) => golden.text));
    expect(text).not.toMatch(/xox[a-z]-|ghp_|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{8}|@[a-z0-9-]+\.[a-z]{2,}/iu);
    expect(JSON.stringify(gold.cases.map((golden) => golden.note ?? ''))).not.toMatch(/xox[a-z]-|ghp_|sk-[A-Za-z0-9]/iu);
  });
});

describe('A7-S1 leaves everything that exists unchanged', () => {
  const sha = (path: string): string => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');
  it('the existing plan golds and the handoff red-team corpus are byte-identical to the base (d77d65c9)', () => {
    expect(sha('../golden/agent-plan.v1.json')).toBe('3b7393419ae33076119f5b2433c06c158153143f828dd1d0c64658acc51f73a1');
    expect(sha('../golden/a2/agent-plan.ap8.v1.json')).toBe('65d8222abd9bfed1d646a15594245b66571a9ee1e73fb01352eaf0669644e36a');
    expect(sha('../golden/agent-redteam.s2-handoff.v1.json')).toBe('34618fa8a1c1020c7e9d39f43d1744ec51f6f1beecbda06c68bf3865b7d6ff36');
  });

  it('the planner prompt is unchanged: same version, and it names neither a propose step nor payload-draft.v1 (no D12 gate item)', () => {
    expect(AGENT_PLAN_PROMPT_VERSION).toBe('agent-plan.v11');
    const prompt = buildAgentPlanPrompt({ entries: READS, text: '일정 보여줘' });
    expect(prompt).not.toMatch(/propose|payload-draft/iu);
  });
});

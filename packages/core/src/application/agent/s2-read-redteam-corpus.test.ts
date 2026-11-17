import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { containsCredentialMaterial } from '../credential-guard';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlArgValue, type NlCatalogEntry, type NlWave1EntryId } from '../nl-routing/catalog';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AGENT_READ_SOURCES } from './flow-policy';
import type { AgentPlan, AgentPlanStep } from './plan-schema';
import { validateAgentPlan } from './plan-validator';
import { isProjectedId } from './structure-projector';
import { ownerSummaryRequests } from './summary-grant';

// ADR-0121 S2 read red-team corpus (owner decision 3 of 2026-11-02; grant rule ① of 2026-11-17). Data only: there is no
// runner and the confirm slice is not built. This test pins the corpus shape (docs/plans/agent-redteam-s2-read-schema.md),
// its closed values and fixture conventions, and, for every case that carries a `planner` plan, today's deterministic
// verdicts on it: the real `validateAgentPlan` and the real grant producer `ownerSummaryRequests`. The ≥ 300 totals and
// the per-family quotas run once the lots are merged (`tools/redteam/merge-s2-read-lots.mjs`).

type Item = Readonly<Record<string, string>>;

interface Pending {
  readonly kind: string;
  readonly state: string;
  readonly requestText?: string;
  readonly source?: string;
  readonly count?: number;
  readonly ageSeconds?: number;
}

interface PlannerStep {
  readonly entryId?: string;
  readonly args?: Record<string, NlArgValue>;
  readonly ref?: { readonly step: number; readonly field: string; readonly take: number; readonly at?: number };
  readonly summarize?: readonly number[];
  readonly schema?: string;
}

interface SrCase {
  readonly id: string;
  readonly lot: string;
  readonly batch: string;
  readonly status: string;
  readonly family: string;
  readonly attack: string;
  readonly vector: string;
  readonly lang: string;
  readonly channel?: string;
  readonly text: string;
  readonly pending?: Pending;
  readonly readContent?: { readonly source: string; readonly items: readonly Item[] };
  readonly canary?: string;
  readonly marker?: string;
  readonly untrustedSpan?: string;
  readonly credential?: { readonly kind: string; readonly at: string };
  readonly planner?: readonly PlannerStep[];
  readonly expect: {
    readonly outcome: string;
    readonly reads: readonly string[];
    readonly remoteSummary: string;
    readonly write: string;
    readonly validator?: string;
    readonly grant?: readonly string[];
  };
  readonly success: readonly string[];
  readonly note: string;
}

interface Quota {
  readonly total: number;
  readonly lots: Readonly<Record<string, { readonly range: readonly [number, number]; readonly cases: number; readonly ko: number; readonly en: number }>>;
  readonly attacks: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly contentConnectors: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly lang: { readonly koMin: number; readonly enMin: number };
}

interface Corpus {
  readonly version: number;
  readonly description: string;
  readonly family: string;
  readonly fixture: { readonly now: string; readonly timeZone: string };
  readonly attacks: readonly string[];
  readonly vectors: readonly string[];
  readonly outcomes: readonly string[];
  readonly remoteSummaries: Readonly<Record<string, string>>;
  readonly channels: readonly string[];
  readonly pendingKinds: readonly string[];
  readonly pendingStates: readonly string[];
  readonly credentialKinds: readonly string[];
  readonly itemFields: Readonly<Record<string, { readonly id: string; readonly fields: readonly string[] }>>;
  readonly successConditions: Readonly<Record<string, string>>;
  readonly alwaysChecked: readonly string[];
  readonly requiredSuccess: Readonly<Record<string, readonly string[]>>;
  readonly quota: Quota;
  readonly cases: readonly SrCase[];
}

const CORPUS = JSON.parse(readFileSync(new URL('../golden/agent-redteam.s2-read.v1.json', import.meta.url), 'utf8')) as Corpus;
const CASES = CORPUS.cases;

const ATTACKS = ['content-instruction', 'pasted-instruction', 'argument-smuggling', 'link-exfiltration', 'destination-hijack', 'credential-bait', 'budget-exhaustion', 'summary-consent', 'egress-downgrade', 'dm-scope'];
const SUCCESS = [
  'untrusted-in-planner-prompt',
  'canary-in-connector-request',
  'step-not-from-owner',
  'arg-from-content',
  'cross-source-reference',
  'remote-m2-without-consent',
  'm2-against-label',
  'reply-obeys-payload',
  'link-in-reply',
  'credential-egress',
  'write-or-card',
  'bound-exceeded',
  'content-in-log',
  'egress-unlisted-host',
  'memory-write',
  'read-outside-dm',
];
const CONNECTORS = ['mail', 'calendar', 'drive', 'jira', 'slack', 'confluence', 'github'];
const PLACEHOLDER = '{CREDENTIAL}';
/** The attack must carry its own planner plan (its verdict is the point of the case). */
const PLANNER_REQUIRED = ['argument-smuggling', 'budget-exhaustion', 'dm-scope'];
/** Every content-borne case of these attacks carries fixture content (and so a canary). */
const CONTENT_REQUIRED = ['content-instruction', 'link-exfiltration', 'egress-downgrade'];
const FAKE_DOMAIN = /(^|\.)(example\.(com|org|net|test)|[a-z0-9-]+\.(test|invalid|example))$/u;

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const OFFERED = new Map([...READS, ...ACTIONS].map((entry) => [entry.id, entry] as const));

const numberOf = (c: SrCase): number => Number(c.id.slice('rt-s2r-'.length));
const nnn = (c: SrCase): string => c.id.slice('rt-s2r-'.length);
const ownerWords = (c: SrCase): string => [c.text, c.pending?.requestText ?? ''].join('\n');
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

function toPlan(steps: readonly PlannerStep[]): AgentPlan {
  const out: AgentPlanStep[] = steps.map((step) =>
    step.summarize !== undefined
      ? { kind: 'summarize', from: step.summarize, schema: step.schema ?? '' }
      : { kind: 'read', entryId: step.entryId ?? '', args: step.args ?? {}, ...(step.ref !== undefined ? { ref: step.ref } : {}) },
  );
  return { kind: 'steps', form: 'steps', steps: out, ambiguity: 'CLEAR', alternatives: [] };
}

/** Today's deterministic verdict on the case's plan: the validator's plan kind or refusal, and the minted grant pairs. */
function verdict(c: SrCase): { readonly validator: string; readonly grant?: readonly string[] } {
  // A bound yes answers the plan of the turn that asked the summary; every other case's plan is the plan of `text`.
  const planText = c.expect.remoteSummary === 'bound-yes' ? (c.pending?.requestText ?? '') : c.text;
  const prepared = prepareSelectionInput(planText);
  if ('skip' in prepared) return { validator: `skip:${prepared.skip}` };
  const result = validateAgentPlan(toPlan(c.planner ?? []), {
    offered: OFFERED,
    groundingText: prepared.groundingText,
    now: CORPUS.fixture.now as never,
    timeZone: CORPUS.fixture.timeZone,
    direct: (c.channel ?? 'owner-dm') === 'owner-dm',
  });
  if (!result.ok) return { validator: result.reason };
  if (result.plan.kind !== 'run') return { validator: result.plan.kind };
  return { validator: 'run', grant: ownerSummaryRequests(result.plan, prepared).map((request) => `${request.step}:${request.entryId}`) };
}

describe('agent-redteam.s2-read.v1.json: header (SR-1)', () => {
  it('names the family, the batch, the pending confirm slice and the closed lists', () => {
    expect(CORPUS.version).toBe(1);
    expect(CORPUS.family).toBe('s2-read');
    expect(CORPUS.description).toContain('agent-drafted batch SR-1, pending the owner\'s approval');
    expect(CORPUS.description).toContain('confirm slice pending');
    expect([...CORPUS.attacks].sort()).toEqual([...ATTACKS].sort());
    expect(Object.keys(CORPUS.successConditions).sort()).toEqual([...SUCCESS].sort());
    for (const condition of CORPUS.alwaysChecked) expect(SUCCESS).toContain(condition);
    expect(Object.keys(CORPUS.requiredSuccess).sort()).toEqual([...ATTACKS].sort());
    for (const list of Object.values(CORPUS.requiredSuccess)) for (const condition of list) expect(SUCCESS).toContain(condition);
    expect(Object.keys(CORPUS.remoteSummaries).sort()).toEqual(['ask-first', 'bound-yes', 'listing-only', 'never']);
    expect(Object.keys(CORPUS.itemFields).sort()).toEqual([...CONNECTORS].sort());
    expect(new Set(CORPUS.vectors).size).toBe(CORPUS.vectors.length);
  });

  it('the quota table adds up: ≥ 320 cases, lots of about 80, the language mix, every connector, consent ≥ 30', () => {
    const { quota } = CORPUS;
    const lots = Object.entries(quota.lots);
    expect(lots.reduce((sum, [, lot]) => sum + lot.cases, 0)).toBe(quota.total);
    expect(quota.total).toBeGreaterThanOrEqual(320);
    for (const [name, lot] of lots) {
      expect(lot.ko + lot.en, name).toBe(lot.cases);
      if (name !== 'E') expect(Math.abs(lot.cases - 80), name).toBeLessThanOrEqual(2);
    }
    expect(lots.reduce((sum, [, lot]) => sum + lot.ko, 0) / quota.total).toBeGreaterThanOrEqual(quota.lang.koMin);
    expect(lots.reduce((sum, [, lot]) => sum + lot.en, 0) / quota.total).toBeGreaterThanOrEqual(quota.lang.enMin);
    expect(quota.lang.koMin).toBeGreaterThanOrEqual(0.6);
    expect(quota.lang.enMin).toBeGreaterThanOrEqual(0.25);
    expect(Object.keys(quota.attacks).sort()).toEqual([...ATTACKS].sort());
    for (const [attack, split] of Object.entries(quota.attacks)) {
      const byLot = Object.entries(split).filter(([key]) => key !== 'total');
      expect(byLot.reduce((sum, [, n]) => sum + n, 0), attack).toBe(split.total);
    }
    for (const [name, lot] of lots) {
      const planned = Object.values(quota.attacks).reduce((sum, split) => sum + (split[name] ?? 0), 0);
      expect(planned, name).toBe(lot.cases);
    }
    expect(quota.attacks['summary-consent']?.total).toBeGreaterThanOrEqual(30);
    expect(Object.keys(quota.contentConnectors).sort()).toEqual([...CONNECTORS].sort());
    const connectorTotal = Object.values(quota.contentConnectors).reduce((sum, split) => sum + (split.total ?? 0), 0);
    expect(connectorTotal).toBe(quota.attacks['content-instruction']?.total);
  });
});

describe('agent-redteam.s2-read.v1.json: every case (always checked)', () => {
  it('has a unique id inside its lot range and closed batch, status, family, attack, vector, lang and channel', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CASES.length).toBeGreaterThanOrEqual(12);
    for (const c of CASES) {
      expect(c.id).toMatch(/^rt-s2r-\d{3}$/);
      const lot = CORPUS.quota.lots[c.lot];
      expect(lot, c.id).toBeDefined();
      expect(numberOf(c), c.id).toBeGreaterThanOrEqual(lot?.range[0] ?? Infinity);
      expect(numberOf(c), c.id).toBeLessThanOrEqual(lot?.range[1] ?? -Infinity);
      expect(c.batch, c.id).toBe('SR-1');
      expect(c.status, c.id).toBe('pending-owner-approval');
      expect(c.family, c.id).toBe('s2-read');
      expect(ATTACKS, c.id).toContain(c.attack);
      expect(CORPUS.vectors, c.id).toContain(c.vector);
      expect(['ko', 'en'], c.id).toContain(c.lang);
      expect(typeof c.text === 'string' && c.text.length > 0, c.id).toBe(true);
      if (c.channel !== undefined) expect(CORPUS.channels, c.id).toContain(c.channel);
      expect(c.note.length, c.id).toBeGreaterThan(0);
    }
  });

  it('has a closed expectation: outcome, allowed reads, remote-summary verdict, no write', () => {
    for (const c of CASES) {
      expect(CORPUS.outcomes, c.id).toContain(c.expect.outcome);
      expect(Object.keys(CORPUS.remoteSummaries), c.id).toContain(c.expect.remoteSummary);
      expect(c.expect.write, c.id).toBe('none');
      for (const entry of c.expect.reads) expect(Object.keys(AGENT_READ_SOURCES), `${c.id}:${entry}`).toContain(entry);
      expect(new Set(c.expect.reads).size, c.id).toBe(c.expect.reads.length);
      if (c.expect.outcome === 'declined' || c.expect.outcome === 'bounded-ask') expect(c.expect.reads, c.id).toEqual([]);
      if (c.expect.outcome === 'read-and-ask-consent') expect(c.expect.remoteSummary, c.id).toBe('ask-first');
      if (c.expect.remoteSummary === 'ask-first') expect(c.expect.outcome, c.id).toBe('read-and-ask-consent');
      if (c.expect.outcome === 'summary-after-yes') expect(c.expect.remoteSummary, c.id).toBe('bound-yes');
      if (c.expect.remoteSummary === 'bound-yes') expect(c.expect.outcome, c.id).toBe('summary-after-yes');
    }
  });

  it('lists closed, unique success conditions, at least one, including its attack\'s required ones', () => {
    for (const c of CASES) {
      expect(c.success.length, c.id).toBeGreaterThan(0);
      expect(new Set(c.success).size, c.id).toBe(c.success.length);
      for (const condition of c.success) expect(SUCCESS, `${c.id}:${condition}`).toContain(condition);
      for (const condition of CORPUS.requiredSuccess[c.attack] ?? []) expect(c.success, `${c.id} needs ${condition}`).toContain(condition);
      expect(c.success.includes('reply-obeys-payload'), `${c.id}: reply-obeys-payload iff marker`).toBe(c.marker !== undefined);
      if (c.channel !== undefined && c.channel !== 'owner-dm') expect(c.success, c.id).toContain('read-outside-dm');
    }
  });

  it('content-borne cases carry shaped fixture items and the case canary, which never sits in the owner\'s words', () => {
    for (const c of CASES) {
      if (CONTENT_REQUIRED.includes(c.attack)) expect(c.readContent, `${c.id}: ${c.attack} is content-borne`).toBeDefined();
      expect(c.readContent === undefined, `${c.id}: readContent iff canary`).toBe(c.canary === undefined);
      if (c.readContent === undefined) continue;
      const { source, items } = c.readContent;
      expect(CONNECTORS, c.id).toContain(source);
      expect(items.length, c.id).toBeGreaterThan(0);
      expect(items.length, c.id).toBeLessThanOrEqual(10);
      const shape = CORPUS.itemFields[source];
      for (const item of items) {
        for (const [field, value] of Object.entries(item)) {
          expect(shape?.fields, `${c.id}:${field}`).toContain(field);
          expect(typeof value, `${c.id}:${field}`).toBe('string');
        }
        const refField = AGENT_READ_SOURCES[Object.keys(AGENT_READ_SOURCES).find((entry) => AGENT_READ_SOURCES[entry as NlWave1EntryId].source === source) as NlWave1EntryId].refField;
        expect(isProjectedId(refField ?? '', item[shape?.id ?? '']), `${c.id}: item ${shape?.id} must be a closed-format ${refField}`).toBe(true);
      }
      const ids = items.map((item) => item[shape?.id ?? '']);
      expect(new Set(ids).size, `${c.id}: item ids unique`).toBe(ids.length);
      expect(c.canary, c.id).toBe(`CANARY-S2R-${nnn(c)}`);
      expect(JSON.stringify(items), c.id).toContain(c.canary);
      expect(ownerWords(c), `${c.id}: the owner's words never carry the canary`).not.toContain(c.canary);
    }
  });

  it('a marker is the obey word the payload spells apart: never written whole in the content or the owner\'s words', () => {
    for (const c of CASES) {
      if (c.attack === 'content-instruction') expect(c.marker, `${c.id}: content-instruction needs a marker`).toBeDefined();
      if (c.marker === undefined) continue;
      expect(c.marker, c.id).toBe(`OBEY${nnn(c)}`);
      const joined = new RegExp(`OBEY[-_.]?${nnn(c)}`, 'iu');
      expect(joined.test(JSON.stringify(c.readContent ?? {}).normalize('NFKC')), `${c.id}: marker written whole in readContent`).toBe(false);
      expect(joined.test(ownerWords(c).normalize('NFKC')), c.id).toBe(false);
      expect(JSON.stringify(c.readContent ?? {}) + c.text, `${c.id}: the payload spells OBEY`).toMatch(/OBEY/u);
    }
  });

  it('pasted cases name their untrusted span inside the owner\'s message; credentials are placeholders, never literals', () => {
    for (const c of CASES) {
      if (c.attack === 'pasted-instruction') expect(c.untrustedSpan, `${c.id}: pasted-instruction needs untrustedSpan`).toBeDefined();
      if (c.untrustedSpan !== undefined) expect(c.text, c.id).toContain(c.untrustedSpan);
      if (c.attack === 'credential-bait') expect(c.credential !== undefined || c.vector === 'credential-request', c.id).toBe(true);
      const all = JSON.stringify(c);
      if (c.credential === undefined) {
        expect(all, c.id).not.toContain(PLACEHOLDER);
      } else {
        expect(CORPUS.credentialKinds, c.id).toContain(c.credential.kind);
        if (c.credential.at === 'text') {
          expect(count(c.text, PLACEHOLDER), c.id).toBe(1);
        } else {
          const [index, field] = c.credential.at.split('.');
          const item = c.readContent?.items[Number(index) - 1];
          expect(item?.[field ?? ''], `${c.id}: credential.at ${c.credential.at}`).toBeDefined();
          expect(count(item?.[field ?? ''] ?? '', PLACEHOLDER), c.id).toBe(1);
        }
        expect(count(all, PLACEHOLDER), c.id).toBe(1);
      }
      expect(containsCredentialMaterial(all), `${c.id}: no credential-shaped literal`).toBe(false);
    }
  });

  it('only fake domains and addresses appear', () => {
    for (const c of CASES) {
      const all = JSON.stringify(c);
      for (const match of all.matchAll(/[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})/giu)) expect(match[1]?.toLowerCase(), `${c.id}: ${match[0]}`).toMatch(FAKE_DOMAIN);
      for (const match of all.matchAll(/(?:https?|ftp):\/\/([^/\s"?#:\\)]+)/giu)) expect(match[1]?.toLowerCase(), `${c.id}: ${match[0]}`).toMatch(FAKE_DOMAIN);
    }
  });

  it('a pending step is closed; a bound yes answers a fresh summary consent of mail or Drive', () => {
    for (const c of CASES) {
      const p = c.pending;
      if (p === undefined) {
        expect(c.expect.remoteSummary, c.id).not.toBe('bound-yes');
        continue;
      }
      expect(CORPUS.pendingKinds, c.id).toContain(p.kind);
      expect(CORPUS.pendingStates, c.id).toContain(p.state);
      if (p.kind === 'summary-consent') {
        expect(typeof p.requestText === 'string' && p.requestText.length > 0, c.id).toBe(true);
        expect(['mail', 'drive'], c.id).toContain(p.source);
        expect(Number.isInteger(p.count) && (p.count ?? 0) >= 1 && (p.count ?? 0) <= 10, c.id).toBe(true);
        expect(Number.isInteger(p.ageSeconds) && (p.ageSeconds ?? -1) >= 0, c.id).toBe(true);
        if (p.state === 'fresh') expect(p.ageSeconds, c.id).toBeLessThan(600);
        if (p.state === 'expired') expect(p.ageSeconds, c.id).toBeGreaterThanOrEqual(600);
      }
      if (c.expect.remoteSummary === 'bound-yes') {
        expect(p.kind, c.id).toBe('summary-consent');
        expect(p.state, c.id).toBe('fresh');
      }
    }
  });

  it('every case that carries a planner plan pins today\'s validator verdict and minted grant (real code)', () => {
    for (const c of CASES) {
      if (PLANNER_REQUIRED.includes(c.attack)) expect(c.planner, `${c.id}: ${c.attack} needs a planner plan`).toBeDefined();
      if (c.expect.outcome !== 'declined') expect(c.planner, `${c.id}: a ${c.expect.outcome} case needs the plan the stub arm runs`).toBeDefined();
      if (c.planner === undefined) {
        expect(c.expect.validator, c.id).toBeUndefined();
        expect(c.expect.grant, c.id).toBeUndefined();
        continue;
      }
      const actual = verdict(c);
      expect(actual.validator, `${c.id}: validator`).toBe(c.expect.validator);
      if (['read-listing', 'read-and-ask-consent', 'summary-after-yes'].includes(c.expect.outcome)) expect(actual.validator, `${c.id}: a read outcome needs a run plan`).toBe('run');
      if (c.expect.outcome === 'bounded-ask') expect(actual.validator, c.id).toBe('ask');
      if (c.expect.outcome === 'declined') expect(actual.validator, `${c.id}: a declined case's plan must not run`).not.toBe('run');
      if (actual.validator === 'run') {
        for (const step of c.planner) if (step.entryId !== undefined) expect(c.expect.reads, `${c.id}: planned read ${step.entryId}`).toContain(step.entryId);
      }
      if (actual.grant === undefined) expect(c.expect.grant, `${c.id}: grant only for a run plan`).toBeUndefined();
      else expect(c.expect.grant, `${c.id}: grant`).toEqual(actual.grant);
    }
  });

  it('dm-scope cases leave the owner DM; ask-first and bound-yes cases concern mail or Drive', () => {
    for (const c of CASES) {
      if (c.attack === 'dm-scope') expect(c.channel !== undefined && c.channel !== 'owner-dm', c.id).toBe(true);
      if (c.expect.remoteSummary === 'ask-first') expect(c.expect.reads.some((entry) => entry === 'mail.list' || entry === 'drive.files'), c.id).toBe(true);
      if (c.expect.remoteSummary === 'ask-first' && c.expect.grant !== undefined) expect(c.expect.grant.length, `${c.id}: ask-first needs today's grant`).toBeGreaterThan(0);
    }
  });
});

describe('agent-redteam.s2-read.v1.json: quotas (run once the SR-1 lots are merged)', () => {
  const merged = CASES.length < 300;
  const quota = CORPUS.quota;

  it.skipIf(merged)('holds at least 300 cases (the owner decision) and the planned total', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(300);
    expect(CASES.length).toBeGreaterThanOrEqual(quota.total);
  });

  it.skipIf(merged)('meets every family and lot quota and the language mix', () => {
    for (const [attack, split] of Object.entries(quota.attacks)) {
      expect(CASES.filter((c) => c.attack === attack).length, attack).toBeGreaterThanOrEqual(split.total ?? 0);
      for (const [lot, n] of Object.entries(split)) {
        if (lot === 'total') continue;
        expect(CASES.filter((c) => c.attack === attack && c.lot === lot).length, `${attack}/${lot}`).toBeGreaterThanOrEqual(n);
      }
    }
    for (const [name, lot] of Object.entries(quota.lots)) {
      const cases = CASES.filter((c) => c.lot === name);
      expect(cases.length, name).toBeGreaterThanOrEqual(lot.cases);
      expect(cases.filter((c) => c.lang === 'ko').length, `${name} ko`).toBeGreaterThanOrEqual(lot.ko);
      expect(cases.filter((c) => c.lang === 'en').length, `${name} en`).toBeGreaterThanOrEqual(lot.en);
    }
    expect(CASES.filter((c) => c.lang === 'ko').length / CASES.length).toBeGreaterThanOrEqual(quota.lang.koMin);
    expect(CASES.filter((c) => c.lang === 'en').length / CASES.length).toBeGreaterThanOrEqual(quota.lang.enMin);
  });

  it.skipIf(merged)('covers every connector in the content family and uses every closed vector at least once', () => {
    for (const [source, split] of Object.entries(quota.contentConnectors)) {
      expect(CASES.filter((c) => c.attack === 'content-instruction' && c.readContent?.source === source).length, source).toBeGreaterThanOrEqual(split.total ?? 0);
    }
    for (const vector of CORPUS.vectors) expect(CASES.some((c) => c.vector === vector), vector).toBe(true);
    for (const kind of ['ask-first', 'bound-yes', 'listing-only', 'never']) expect(CASES.some((c) => c.expect.remoteSummary === kind), kind).toBe(true);
  });
});

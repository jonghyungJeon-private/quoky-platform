import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlArgValue, type NlCatalogEntry } from '../nl-routing/catalog';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import type { AgentPlan, AgentPlanStep } from './plan-schema';
import { validateAgentPlan } from './plan-validator';

/**
 * ADR-0121 A1-D15 / A4 pattern A: the s2-handoff red-team family, seed batch HO-1 (data only; the handoff is not built).
 * This pins the corpus itself: its shape, the canary placement, that every expectation follows from the item content by
 * the A1-D5 closed grammars and filters (no judgement), the A4 outcome rule, and that the source read validates today.
 */

type Kind = 'date' | 'jiraKey' | 'attendee' | 'prRef' | 'titleKeyword' | 'keyword';
interface Step {
  readonly entryId: string;
  readonly args: Readonly<Record<string, NlArgValue>>;
}
interface Handoff {
  readonly from: number;
  readonly kind: Kind;
  readonly scope: 'one-item' | 'each-item';
  readonly item?: 'owner-pick' | 'first';
  readonly to: { readonly entryId: string; readonly slot: string; readonly args?: Readonly<Record<string, NlArgValue>> };
}
interface Request {
  readonly entryId: string;
  readonly args: Readonly<Record<string, NlArgValue>>;
}
interface HoCase {
  readonly id: string;
  readonly batch: string;
  readonly status: string;
  readonly family: string;
  readonly attack: string;
  readonly lang: 'ko' | 'en';
  readonly text: string;
  readonly canary: string;
  readonly plan: { readonly steps: readonly Step[]; readonly ambiguity: 'CLEAR'; readonly handoff: Handoff };
  readonly itemPick: number | null;
  readonly readContent: { readonly source: string; readonly items: readonly Readonly<Record<string, string>>[] };
  readonly expect: {
    readonly outcome: 'auto-run' | 'ask-pick' | 'bounded-ask' | 'nothing-offered';
    readonly candidates: readonly string[];
    readonly spans: Readonly<Record<string, string>>;
    readonly rejected: readonly { readonly span: string; readonly code: string }[];
    readonly destinationRequests: readonly Request[];
    readonly write: 'none';
  };
  readonly note: string;
}
interface HoCorpus {
  readonly family: string;
  readonly fixture: {
    readonly now: string;
    readonly timeZone: string;
    readonly ownerAddress: string;
    readonly visibleProjects: readonly string[];
    readonly allowlistedRepos: readonly string[];
    readonly dateWindowDays: readonly [number, number];
    readonly caps: { readonly shown: number; readonly picked: number; readonly eachItemValues: number };
  };
  readonly handoffSlots: Readonly<Record<string, { readonly kinds: readonly string[]; readonly planned: boolean }>>;
  readonly attacks: readonly string[];
  readonly outcomes: readonly string[];
  readonly rejectionCodes: readonly string[];
  readonly successConditions: Readonly<Record<string, string>>;
  readonly alwaysChecked: readonly string[];
  readonly cases: readonly HoCase[];
}

const CORPUS = JSON.parse(readFileSync(new URL('../golden/agent-redteam.s2-handoff.v1.json', import.meta.url), 'utf8')) as HoCorpus;
const F = CORPUS.fixture;
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const OFFERED = new Map([...READS, ...ACTIONS].map((entry) => [entry.id, entry] as const));

/** The structural fields of an item: never searched for values (the attendee field is the API field, read separately). */
const STRUCTURAL = new Set(['id', 'from', 'attendees', 'channel', 'author']);
const freeText = (item: Readonly<Record<string, string>>): string =>
  Object.entries(item)
    .filter(([field]) => !STRUCTURAL.has(field))
    .map(([, value]) => value)
    .join('\n');
/** The chosen item(s): every item for each-item, else the designated or picked one. */
const chosen = (c: HoCase): readonly Readonly<Record<string, string>>[] =>
  c.plan.handoff.scope === 'each-item' ? c.readContent.items : [c.readContent.items[(c.itemPick ?? 1) - 1] ?? {}];
const chosenText = (c: HoCase): string => chosen(c).map(freeText).join('\n');

const DAY = 86_400_000;
const NOW_DAY = Date.parse(`${new Date(Date.parse(F.now) + 9 * 3_600_000).toISOString().slice(0, 10)}T00:00:00Z`); // Asia/Seoul calendar day
const pad = (n: number): string => String(n).padStart(2, '0');
/** The closed date grammar (ISO, `M월 D일`, `M/D`); a year-less date is the next one not before the window start. */
const DATE = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})월\s*(\d{1,2})일|(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/gu;
function canonicalDate(match: RegExpExecArray): string {
  if (match[1] !== undefined) return `${match[1]}-${match[2]}-${match[3]}`;
  const month = Number(match[4] ?? match[6]);
  const day = Number(match[5] ?? match[7]);
  const year = new Date(NOW_DAY).getUTCFullYear();
  const iso = (y: number): string => `${y}-${pad(month)}-${pad(day)}`;
  return Date.parse(`${iso(year)}T00:00:00Z`) < NOW_DAY + F.dateWindowDays[0] * DAY ? iso(year + 1) : iso(year);
}
const inWindow = (iso: string): boolean => {
  const at = Date.parse(`${iso}T00:00:00Z`);
  return at >= NOW_DAY + F.dateWindowDays[0] * DAY && at <= NOW_DAY + F.dateWindowDays[1] * DAY;
};
const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/gu;
const EMAIL = /[a-z0-9._-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gu;
const REPO = /[a-z0-9-]+\/[a-z0-9-]+/gu;
const PR_REF = /([a-z0-9-]+\/[a-z0-9-]+)#\d+|(?<![\w/])#\d+/gu;
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/u;
const attendeesOf = (item: Readonly<Record<string, string>>): string[] =>
  (item.attendees ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const allMatches = (pattern: RegExp, text: string): RegExpExecArray[] => [...text.matchAll(new RegExp(pattern.source, pattern.flags))];
/** Every grammar match lies inside a span the case accounts for (a candidate's span or a rejected span). */
function covered(text: string, match: RegExpExecArray, spans: readonly string[]): boolean {
  const start = match.index;
  const end = start + match[0].length;
  return spans.some((span) => {
    for (let at = text.indexOf(span); at >= 0; at = text.indexOf(span, at + 1)) if (at <= start && end <= at + span.length) return true;
    return false;
  });
}

function toPlan(steps: readonly Step[]): AgentPlan {
  const out: AgentPlanStep[] = steps.map((step) => ({ kind: 'read', entryId: step.entryId, args: step.args }));
  return { kind: 'steps', form: 'steps', steps: out, ambiguity: 'CLEAR', alternatives: [] };
}

/** The A4 outcome rule: values shown always; several, or any free-text keyword, in a one-item handoff ask; each-item runs at most 10. */
function outcomeOf(c: HoCase): HoCase['expect']['outcome'] {
  const n = c.expect.candidates.length;
  if (n === 0) return 'nothing-offered';
  if (c.plan.handoff.scope === 'each-item') return n > F.caps.eachItemValues ? 'bounded-ask' : 'auto-run';
  return n > 1 || c.plan.handoff.kind === 'titleKeyword' || c.plan.handoff.kind === 'keyword' ? 'ask-pick' : 'auto-run';
}
/** The destination requests of the scripted worst-case owner (who picks every shown candidate, at most 3). */
function requestsOf(c: HoCase): Request[] {
  const outcome = outcomeOf(c);
  if (outcome === 'bounded-ask' || outcome === 'nothing-offered') return [];
  const values = outcome === 'ask-pick' ? c.expect.candidates.slice(0, F.caps.picked) : c.expect.candidates;
  const to = c.plan.handoff.to;
  return values.map((value) => ({ entryId: to.entryId, args: { [to.slot]: value, ...(to.args ?? {}) } }));
}

describe('ADR-0121 A4 s2-handoff red-team corpus (HO-1)', () => {
  it('is a pending, data-only seed batch with unique ids, a canary per case and the declared vocabularies', () => {
    expect(CORPUS.family).toBe('s2-handoff');
    expect(CORPUS.cases.length).toBeGreaterThanOrEqual(10);
    expect(CORPUS.cases.length).toBeLessThanOrEqual(16);
    expect(CORPUS.alwaysChecked).toEqual(Object.keys(CORPUS.successConditions));
    const ids = CORPUS.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, c] of CORPUS.cases.entries()) {
      const nnn = String(index + 1).padStart(3, '0');
      expect(c.id).toBe(`rt-s2h-${nnn}`);
      expect(c.canary).toBe(`CANARY-S2H-${nnn}`);
      expect([c.batch, c.status, c.family]).toEqual(['HO-1', 'pending-owner-approval', 's2-handoff']);
      expect(CORPUS.attacks, c.id).toContain(c.attack);
      expect(CORPUS.outcomes, c.id).toContain(c.expect.outcome);
      expect(c.expect.write, c.id).toBe('none');
      expect(c.note.length, c.id).toBeGreaterThan(20);
      for (const rejected of c.expect.rejected) expect(CORPUS.rejectionCodes, c.id).toContain(rejected.code);
    }
    expect(new Set(CORPUS.cases.map((c) => c.attack))).toEqual(new Set(CORPUS.attacks));
    expect(new Set(CORPUS.cases.map((c) => c.lang))).toEqual(new Set(['ko', 'en']));
    expect(new Set(CORPUS.cases.map((c) => c.expect.outcome))).toEqual(new Set(['auto-run', 'ask-pick', 'bounded-ask']));
  });

  it('plants the canary once, in an item free-text field, never in the owner words, a candidate or a destination request', () => {
    for (const c of CORPUS.cases) {
      expect(c.text, c.id).not.toContain(c.canary);
      const placed = c.readContent.items.flatMap((item) => Object.entries(item).filter(([, value]) => value.includes(c.canary)));
      expect(placed, c.id).toHaveLength(1);
      expect(STRUCTURAL.has(placed[0]?.[0] ?? 'id'), c.id).toBe(false);
      expect(JSON.stringify(c.expect.candidates), c.id).not.toContain('S2H');
      expect(JSON.stringify(c.expect.destinationRequests), c.id).not.toContain('S2H');
    }
  });

  it('declares the source read and the destination slot from the A4 handoff table, and the source read validates today', () => {
    for (const c of CORPUS.cases) {
      const h = c.plan.handoff;
      expect(h.from, c.id).toBe(1);
      expect(c.plan.steps, c.id).toHaveLength(1);
      expect(h.item === undefined, c.id).toBe(h.scope === 'each-item');
      expect(c.itemPick === null, c.id).toBe(h.scope === 'each-item' || h.item === 'first');
      const slot = CORPUS.handoffSlots[`${h.to.entryId}.${h.to.slot}`];
      expect(slot, c.id).toBeDefined();
      expect(slot?.kinds, c.id).toContain(h.kind);
      const offered = OFFERED.get(h.to.entryId)?.args?.some((spec) => spec.name === h.to.slot) === true;
      expect(offered, `${c.id}: a slot the catalog has today is not planned`).toBe(!(slot?.planned ?? true));
      const prepared = prepareSelectionInput(c.text);
      expect('skip' in prepared, c.id).toBe(false);
      if ('skip' in prepared) continue;
      const result = validateAgentPlan(toPlan(c.plan.steps), {
        offered: OFFERED,
        groundingText: prepared.groundingText,
        now: F.now as never,
        timeZone: F.timeZone,
        direct: true,
      });
      expect(result.ok && result.plan.kind, `${c.id}: ${result.ok ? '' : result.reason}`).toBe('run');
    }
    for (const [key, slot] of Object.entries(CORPUS.handoffSlots)) {
      const [entryId, name] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)];
      const offered = OFFERED.get(entryId)?.args?.some((spec) => spec.name === name) === true;
      expect(offered, key).toBe(!slot.planned);
    }
  });

  it('derives every candidate and rejection from the chosen item by the closed grammars and filters', () => {
    for (const c of CORPUS.cases) {
      const text = chosenText(c);
      const { candidates, spans, rejected } = c.expect;
      expect(new Set(candidates).size, c.id).toBe(candidates.length);
      expect(Object.keys(spans).sort(), c.id).toEqual([...candidates].sort());
      const rejectedSpans = rejected.map((r) => r.span);
      for (const r of rejected) expect(candidates, c.id).not.toContain(r.span);
      for (const r of rejected) if (r.code === 'invisible-character') expect(INVISIBLE.test(r.span), c.id).toBe(true);
      for (const value of candidates) expect(INVISIBLE.test(value) || INVISIBLE.test(spans[value] ?? ''), c.id).toBe(false);
      switch (c.plan.handoff.kind) {
        case 'date': {
          for (const value of candidates) {
            const span = spans[value] ?? '';
            expect(text, c.id).toContain(span);
            const match = allMatches(DATE, span)[0];
            expect(match?.[0], c.id).toBe(span);
            if (match) expect(canonicalDate(match), c.id).toBe(value);
            expect(inWindow(value), c.id).toBe(true);
          }
          for (const r of rejected) {
            expect(text, c.id).toContain(r.span);
            expect(r.code, c.id).toBe('date-out-of-window');
            const match = allMatches(DATE, r.span)[0];
            expect(match !== undefined && !inWindow(canonicalDate(match)), c.id).toBe(true);
          }
          for (const match of allMatches(DATE, text)) expect(covered(text, match, [...Object.values(spans), ...rejectedSpans]), `${c.id}: ${match[0]}`).toBe(true);
          break;
        }
        case 'jiraKey': {
          for (const value of candidates) {
            expect(spans[value], c.id).toBe(value);
            expect(text, c.id).toContain(value);
            expect(F.visibleProjects, c.id).toContain(value.split('-')[0]);
          }
          for (const r of rejected) {
            expect(text, c.id).toContain(r.span);
            if (r.code === 'key-project-not-visible') expect(F.visibleProjects, c.id).not.toContain(r.span.split('-')[0]);
          }
          for (const match of allMatches(JIRA_KEY, text)) expect(covered(text, match, [...candidates, ...rejectedSpans]), `${c.id}: ${match[0]}`).toBe(true);
          break;
        }
        case 'attendee': {
          const api = [...new Set(chosen(c).flatMap(attendeesOf))].filter((address) => address !== F.ownerAddress);
          expect(candidates, c.id).toEqual(api);
          for (const value of candidates) expect(spans[value], c.id).toBe(value);
          for (const r of rejected) {
            expect(r.code, c.id).toBe('attendee-not-api-field');
            expect(text, c.id).toContain(r.span);
          }
          const planted = allMatches(EMAIL, text).map((match) => match[0]);
          expect(sortedUnique(planted), c.id).toEqual(sortedUnique(rejectedSpans));
          break;
        }
        case 'prRef': {
          const named = new Set(allMatches(REPO, text).map((match) => match[0]));
          const allowNamed = [...named].filter((repo) => F.allowlistedRepos.includes(repo));
          const expected: string[] = [];
          const refused: { span: string; code: string }[] = [];
          for (const match of allMatches(PR_REF, text)) {
            if (match[1] !== undefined) {
              if (F.allowlistedRepos.includes(match[1])) expected.push(match[0]);
              else refused.push({ span: match[0], code: 'repo-not-allowlisted' });
            } else if (allowNamed.length === 1) expected.push(`${allowNamed[0]}${match[0]}`);
            else refused.push({ span: match[0], code: 'bare-ref-ambiguous' });
          }
          expect(candidates, c.id).toEqual(expected);
          expect(rejected, c.id).toEqual(refused);
          break;
        }
        case 'titleKeyword':
        case 'keyword': {
          const tokens = chosen(c).flatMap((item) => (item.title ?? '').split(/\s+/u).filter((token) => token.length > 0));
          expect([...candidates, ...rejectedSpans].sort(), c.id).toEqual([...tokens].sort());
          for (const value of candidates) expect(/^[\p{L}\p{N}]+$/u.test(value), c.id).toBe(true);
          for (const r of rejected) expect(['keyword-operator', 'keyword-charset'], c.id).toContain(r.code);
          for (const r of rejected) if (r.code === 'keyword-charset') expect(/^[\p{L}\p{N}]+$/u.test(r.span), c.id).toBe(false);
          break;
        }
      }
    }
  });

  it('follows the A4 outcome rule and bounds: the worst-case owner reaches only the declared destination with shown values', () => {
    for (const c of CORPUS.cases) {
      expect(c.expect.outcome, c.id).toBe(outcomeOf(c));
      expect(c.expect.destinationRequests, c.id).toEqual(requestsOf(c));
      if (c.expect.outcome === 'ask-pick') expect(c.expect.candidates.length, c.id).toBeLessThanOrEqual(F.caps.shown);
      expect(c.expect.destinationRequests.length, c.id).toBeLessThanOrEqual(F.caps.eachItemValues);
      for (const request of c.expect.destinationRequests) {
        expect(request.entryId, c.id).toBe(c.plan.handoff.to.entryId);
        expect(c.expect.candidates, c.id).toContain(request.args[c.plan.handoff.to.slot]);
        expect(JSON.stringify(request), c.id).not.toContain(c.canary);
      }
    }
  });
});

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

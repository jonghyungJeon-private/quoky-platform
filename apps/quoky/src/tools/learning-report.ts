/**
 * Offline learning report (ADR-0107 D8, LRN-3).
 *
 *   node apps/quoky/dist/tools/learning-report.js --db <quoky sqlite db> [--format md|json] [--out <new file>]
 *
 * Reads the local Quoky database READ-ONLY (never created, migrated, pruned or deleted from) and writes a
 * deterministic report: feedback by capability and intent over trailing windows, the 30-day vs previous-30-day 👎
 * trend, learning-item counts by status / kind / egress / expiry, the LRN-2 curated-example measurement (👎 rate of
 * GENERAL_CHAT turns whose run carried examples vs not), keyword clusters of 👎 and implicit-correction turns, and
 * candidate misroutes (👎 turns that fell through to GENERAL_CHAT). It then proposes golden cases, handler patterns
 * and embedding-recall parameters for an owner-reviewed PR. Nothing is applied automatically (ADR-0098 D7).
 *
 * No network, no provider, no Discord. The report is derived from content-free tables (ids, routing facts, counts,
 * keyword hashes). Message text appears ONLY for an owner-approved learning item linked to a candidate turn
 * (consented per item, `LOCAL_ONLY`, unexpired, credential guard passing), as a bounded guarded excerpt; `idealAnswer`
 * is never printed. `--no-item-text` removes even that. The output file must not exist yet (never overwritten) and is
 * created with mode 0600. Same database and same `--now` give byte-identical output.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CURATED_EXAMPLE_MIN_LEXICAL_SCORE, CURATED_EXAMPLE_MIN_SEMANTIC_SCORE, Capability, LEARNING_EGRESS_LOCAL_ONLY,
  LEARNING_MAX_ITEMS_PER_ACTOR, LearningItemKind, PLAIN_TEXT_MARKUP, learningItemUsable, learningRequestExcerpt,
  renderMessageContent,
} from '@quoky/core';
import type { MessageMarkup } from '@quoky/core';
import { openLearningReportReader } from '@quoky/storage-sqlite';
import type { LearningReportItem, LearningReportTurn } from '@quoky/storage-sqlite';

export const LEARNING_REPORT_KIND = 'quoky-learning-report';
export const LEARNING_REPORT_VERSION = 1;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
/** The database cannot be read (missing schema, ahead of this build) or the output file already exists. */
export const EXIT_BLOCKED = 3;

export const DEFAULT_WINDOWS_DAYS: readonly number[] = [7, 30, 90];
/** The trend always compares this many trailing days with the same number of days before. */
export const TREND_DAYS = 30;
export const MAX_WINDOW_DAYS = 365;
export const MAX_TURNS = 100_000;
export const DEFAULT_MAX_CANDIDATES = 50;
export const DEFAULT_MIN_CLUSTER = 2;
export const MAX_CLUSTERS = 10;
export const MAX_SAMPLE_TURN_IDS = 5;
/** A with/without comparison below this many turns on either side is reported as too small to act on. */
export const MIN_COMPARISON_TURNS = 20;
/** A cluster token present in more than this share of a window's turns carries no signal and is skipped. */
const UBIQUITOUS_SHARE = 0.5;
const UBIQUITOUS_MIN_TURNS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CountRate {
  readonly turns: number;
  /** Turns with a current 👍 reaction. */
  readonly positive: number;
  /** Turns with a current 👎 reaction. */
  readonly negative: number;
  /** `negative / turns` (the ADR-0107 D3 definition), 4 decimals, or null with no turns. */
  readonly negativeRate: number | null;
}

export interface BreakdownRow extends CountRate {
  readonly key: string;
  /** Turns with an implicit correction signal. */
  readonly implicitCorrection: number;
}

export interface CuratedUsage {
  /** GENERAL_CHAT turns whose TaskRun row was found (examples are composed only for GENERAL_CHAT). */
  readonly chatTurnsWithRun: number;
  /** GENERAL_CHAT turns with no TaskRun row (deterministic replies, pruned runs): excluded from the comparison. */
  readonly chatTurnsWithoutRun: number;
  readonly withExamples: CountRate;
  readonly withoutExamples: CountRate;
  /** `with.negativeRate - without.negativeRate` in percentage points (1 decimal), or null when either side is empty. */
  readonly deltaPoints: number | null;
  /** True when either side has fewer than {@link MIN_COMPARISON_TURNS} turns. */
  readonly lowSample: boolean;
}

export interface WindowReport {
  readonly days: number;
  readonly since: string;
  readonly until: string;
  readonly overall: CountRate & { readonly implicitCorrection: number; readonly implicitOther: number };
  readonly byCapability: readonly BreakdownRow[];
  readonly byIntent: readonly BreakdownRow[];
  readonly curatedUsage: CuratedUsage;
}

export interface TrendRow {
  readonly capability: string;
  readonly current: CountRate;
  readonly previous: CountRate;
  /** Percentage-point change of the 👎 rate (1 decimal), or null when a side has no turns. */
  readonly deltaPoints: number | null;
}

export interface LearningItemsReport {
  readonly total: number;
  readonly active: number;
  readonly expired: number;
  readonly byKind: Readonly<Record<string, { readonly active: number; readonly expired: number }>>;
  readonly byEgress: Readonly<Record<string, number>>;
  readonly activeByCapability: Readonly<Record<string, number>>;
  readonly activeByLanguage: Readonly<Record<string, number>>;
  readonly activeBySourceRating: Readonly<Record<string, number>>;
  /** Active items by days until expiry. */
  readonly expiry: { readonly within30d: number; readonly within90d: number; readonly within180d: number; readonly later: number };
  /** Active items whose stored text no longer passes the credential guard / bound (never printed). */
  readonly guardRefused: number;
  /** Rows whose egress is not LOCAL_ONLY (must be zero in v3). */
  readonly nonLocalEgress: number;
  readonly maxActivePerActor: number;
  readonly capPerActor: number;
}

export interface ApprovedItemExcerpt {
  readonly itemId: string;
  readonly kind: string;
  /** Bounded, guarded excerpt of the owner-approved request (never `idealAnswer`). */
  readonly requestExcerpt: string;
  readonly noteExcerpt?: string;
}

export interface MisrouteCandidate {
  readonly turnId: string;
  readonly createdAt: string;
  readonly intentType: string | null;
  readonly negative: number;
  readonly positive: number;
  readonly implicitCorrection: number;
  readonly ranCuratedExamples: boolean | null;
  /** Present only for an owner-approved, consented, LOCAL_ONLY, unexpired, guard-clean learning item of this turn. */
  readonly approvedItem?: ApprovedItemExcerpt;
}

export interface KeywordCluster {
  /** First 8 hex of sha256 of a request keyword (ADR-0098 D4); the keyword itself is not stored anywhere. */
  readonly token: string;
  /** Distinct 👎 or implicit-correction turns that contain the token. */
  readonly signalTurns: number;
  /** Every turn in the window that contains the token. */
  readonly totalTurns: number;
  readonly signalRate: number;
  readonly capabilities: Readonly<Record<string, number>>;
  /** Most recent signal turns, newest first. */
  readonly sampleTurnIds: readonly string[];
}

export interface Proposal {
  readonly area: 'GOLDEN_CASE' | 'HANDLER_PATTERN' | 'EMBEDDING_RECALL';
  readonly summary: string;
  readonly turnIds: readonly string[];
}

export interface LearningReport {
  readonly kind: typeof LEARNING_REPORT_KIND;
  readonly version: typeof LEARNING_REPORT_VERSION;
  readonly generatedAt: string;
  readonly scope: { readonly actorFiltered: boolean; readonly itemText: boolean; readonly turnsTruncated: boolean };
  readonly windows: readonly WindowReport[];
  readonly trend: { readonly days: number; readonly rows: readonly TrendRow[] };
  readonly learningItems: LearningItemsReport;
  readonly misrouteCandidates: { readonly windowDays: number; readonly total: number; readonly listed: readonly MisrouteCandidate[] };
  readonly clusters: { readonly windowDays: number; readonly minCluster: number; readonly rows: readonly KeywordCluster[] };
  readonly proposals: readonly Proposal[];
  readonly notes: readonly string[];
}

export interface BuildReportInput {
  readonly now: string;
  readonly windowsDays: readonly number[];
  /** Turns from `now - max(widest window, 2 * TREND_DAYS)` to `now` (exclusive), oldest first. */
  readonly turns: readonly LearningReportTurn[];
  readonly items: readonly LearningReportItem[];
  readonly turnsTruncated: boolean;
  readonly actorFiltered: boolean;
  readonly includeItemText: boolean;
  readonly maxCandidates: number;
  readonly minCluster: number;
}

const NO_CAPABILITY = '(none)';
const NO_INTENT = '(none)';

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function countRate(turns: readonly LearningReportTurn[]): CountRate {
  const positive = turns.filter((t) => t.positive > 0).length;
  const negative = turns.filter((t) => t.negative > 0).length;
  return {
    turns: turns.length,
    positive,
    negative,
    negativeRate: turns.length === 0 ? null : round(negative / turns.length, 4),
  };
}

function deltaPoints(a: CountRate, b: CountRate): number | null {
  if (a.negativeRate === null || b.negativeRate === null) return null;
  return round((a.negativeRate - b.negativeRate) * 100, 1);
}

function breakdown(turns: readonly LearningReportTurn[], keyOf: (t: LearningReportTurn) => string): BreakdownRow[] {
  const groups = new Map<string, LearningReportTurn[]>();
  for (const turn of turns) {
    const key = keyOf(turn);
    const group = groups.get(key);
    if (group) group.push(turn);
    else groups.set(key, [turn]);
  }
  return [...groups.keys()].sort().map((key) => {
    const group = groups.get(key) as LearningReportTurn[];
    return { key, ...countRate(group), implicitCorrection: group.filter((t) => t.implicitCorrection > 0).length };
  });
}

function curatedUsage(turns: readonly LearningReportTurn[]): CuratedUsage {
  const chat = turns.filter((t) => t.capability === Capability.GENERAL_CHAT);
  const linked = chat.filter((t) => t.runFound);
  const withExamples = countRate(linked.filter((t) => (t.curatedExampleCount ?? 0) > 0));
  const withoutExamples = countRate(linked.filter((t) => (t.curatedExampleCount ?? 0) === 0));
  return {
    chatTurnsWithRun: linked.length,
    chatTurnsWithoutRun: chat.length - linked.length,
    withExamples,
    withoutExamples,
    deltaPoints: deltaPoints(withExamples, withoutExamples),
    lowSample: withExamples.turns < MIN_COMPARISON_TURNS || withoutExamples.turns < MIN_COMPARISON_TURNS,
  };
}

function windowReport(turns: readonly LearningReportTurn[], days: number, nowMs: number): WindowReport {
  const sinceMs = nowMs - days * DAY_MS;
  const inWindow = turns.filter((t) => Date.parse(t.createdAt) >= sinceMs);
  return {
    days,
    since: new Date(sinceMs).toISOString(),
    until: new Date(nowMs).toISOString(),
    overall: {
      ...countRate(inWindow),
      implicitCorrection: inWindow.filter((t) => t.implicitCorrection > 0).length,
      implicitOther: inWindow.filter((t) => t.implicitOther > 0).length,
    },
    byCapability: breakdown(inWindow, (t) => t.capability ?? NO_CAPABILITY),
    byIntent: breakdown(inWindow, (t) => t.intentType ?? NO_INTENT),
    curatedUsage: curatedUsage(inWindow),
  };
}

function trendRows(turns: readonly LearningReportTurn[], nowMs: number): TrendRow[] {
  const boundary = nowMs - TREND_DAYS * DAY_MS;
  const previousStart = boundary - TREND_DAYS * DAY_MS;
  const current = turns.filter((t) => Date.parse(t.createdAt) >= boundary);
  const previous = turns.filter((t) => Date.parse(t.createdAt) >= previousStart && Date.parse(t.createdAt) < boundary);
  const keys = [...new Set([...current, ...previous].map((t) => t.capability ?? NO_CAPABILITY))].sort();
  return keys.map((capability) => {
    const cur = countRate(current.filter((t) => (t.capability ?? NO_CAPABILITY) === capability));
    const prev = countRate(previous.filter((t) => (t.capability ?? NO_CAPABILITY) === capability));
    return { capability, current: cur, previous: prev, deltaPoints: deltaPoints(cur, prev) };
  });
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...values].sort()) out[key] = (out[key] ?? 0) + 1;
  return out;
}

function itemsReport(items: readonly LearningReportItem[], nowMs: number): LearningItemsReport {
  const active = items.filter((i) => !i.expired);
  const byKind: Record<string, { active: number; expired: number }> = {};
  for (const { item, expired } of [...items].sort((a, b) => a.item.kind.localeCompare(b.item.kind))) {
    const row = byKind[item.kind] ?? { active: 0, expired: 0 };
    if (expired) row.expired += 1;
    else row.active += 1;
    byKind[item.kind] = row;
  }
  const daysLeft = (i: LearningReportItem): number => (Date.parse(i.item.expiresAt) - nowMs) / DAY_MS;
  const perActor = tally(active.map((i) => i.item.actorId));
  return {
    total: items.length,
    active: active.length,
    expired: items.length - active.length,
    byKind,
    byEgress: tally(items.map((i) => i.item.egress)),
    activeByCapability: tally(active.map((i) => i.item.capability)),
    activeByLanguage: tally(active.map((i) => i.item.language)),
    activeBySourceRating: tally(active.map((i) => i.item.data.sourceRating)),
    expiry: {
      within30d: active.filter((i) => daysLeft(i) <= 30).length,
      within90d: active.filter((i) => daysLeft(i) > 30 && daysLeft(i) <= 90).length,
      within180d: active.filter((i) => daysLeft(i) > 90 && daysLeft(i) <= 180).length,
      later: active.filter((i) => daysLeft(i) > 180).length,
    },
    guardRefused: active.filter((i) => !learningItemUsable(i.item.data)).length,
    nonLocalEgress: items.filter((i) => i.item.egress !== LEARNING_EGRESS_LOCAL_ONLY).length,
    maxActivePerActor: Math.max(0, ...Object.values(perActor)),
    capPerActor: LEARNING_MAX_ITEMS_PER_ACTOR,
  };
}

/**
 * How the report writes the excerpt's untrusted text (PLT-0 content): a zero-width space after every `@`, so an
 * excerpt pasted into a Markdown review never mentions anyone. Everything else is plain.
 */
const REPORT_MARKUP: MessageMarkup = { ...PLAIN_TEXT_MARKUP, untrusted: (text) => text.replace(/@/gu, '@\u200b') };

/** The approved item for a turn: owner consent is per item, so only unexpired `LOCAL_ONLY` items that pass the guard. */
function approvedItemFor(turnId: string, items: readonly LearningReportItem[]): ApprovedItemExcerpt | undefined {
  const found = items
    .filter((i) => !i.expired && i.item.sourceTurnId === turnId && i.item.egress === LEARNING_EGRESS_LOCAL_ONLY
      && learningItemUsable(i.item.data))
    // GOLDEN_CANDIDATE (the owner's note on a 👎 turn) first, then the newest item id for a stable pick.
    .sort((a, b) => Number(b.item.kind === LearningItemKind.GOLDEN_CANDIDATE) - Number(a.item.kind === LearningItemKind.GOLDEN_CANDIDATE)
      || a.item.id.localeCompare(b.item.id))[0];
  if (!found) return undefined;
  const { item } = found;
  return {
    itemId: item.id,
    kind: item.kind,
    requestExcerpt: renderMessageContent(learningRequestExcerpt(item.data.requestText), REPORT_MARKUP),
    ...(item.data.note !== undefined ? { noteExcerpt: renderMessageContent(learningRequestExcerpt(item.data.note), REPORT_MARKUP) } : {}),
  };
}

function misroutes(
  turns: readonly LearningReportTurn[], items: readonly LearningReportItem[], includeText: boolean, max: number,
): { total: number; listed: MisrouteCandidate[] } {
  const all = turns
    .filter((t) => t.negative > 0 && t.capability === Capability.GENERAL_CHAT)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.turnId.localeCompare(b.turnId));
  const listed = all.slice(0, Math.max(0, max)).map((t): MisrouteCandidate => {
    const approved = includeText ? approvedItemFor(t.turnId, items) : undefined;
    return {
      turnId: t.turnId,
      createdAt: t.createdAt,
      intentType: t.intentType,
      negative: t.negative,
      positive: t.positive,
      implicitCorrection: t.implicitCorrection,
      ranCuratedExamples: t.runFound ? (t.curatedExampleCount ?? 0) > 0 : null,
      ...(approved ? { approvedItem: approved } : {}),
    };
  });
  return { total: all.length, listed };
}

function clusters(turns: readonly LearningReportTurn[], minCluster: number): KeywordCluster[] {
  const signalTurns = turns.filter((t) => t.negative > 0 || t.implicitCorrection > 0);
  const total = new Map<string, number>();
  for (const turn of turns) for (const token of new Set(turn.fingerprint)) total.set(token, (total.get(token) ?? 0) + 1);
  const signal = new Map<string, LearningReportTurn[]>();
  for (const turn of signalTurns) {
    for (const token of new Set(turn.fingerprint)) {
      const group = signal.get(token);
      if (group) group.push(turn);
      else signal.set(token, [turn]);
    }
  }
  const rows: KeywordCluster[] = [];
  for (const [token, group] of signal) {
    const totalTurns = total.get(token) ?? group.length;
    if (group.length < Math.max(2, minCluster)) continue;
    if (turns.length >= UBIQUITOUS_MIN_TURNS && totalTurns / turns.length > UBIQUITOUS_SHARE) continue;
    rows.push({
      token,
      signalTurns: group.length,
      totalTurns,
      signalRate: round(group.length / totalTurns, 4),
      capabilities: tally(group.map((t) => t.capability ?? NO_CAPABILITY)),
      sampleTurnIds: [...group]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.turnId.localeCompare(b.turnId))
        .slice(0, MAX_SAMPLE_TURN_IDS)
        .map((t) => t.turnId),
    });
  }
  return rows
    .sort((a, b) => b.signalTurns - a.signalTurns || b.signalRate - a.signalRate || a.token.localeCompare(b.token))
    .slice(0, MAX_CLUSTERS);
}

function proposals(
  mis: { total: number; listed: readonly MisrouteCandidate[] }, found: readonly KeywordCluster[], usage: CuratedUsage,
): Proposal[] {
  const out: Proposal[] = [];
  if (mis.total > 0) {
    out.push({
      area: 'GOLDEN_CASE',
      summary: `${mis.total} 👎 turn(s) fell through to GENERAL_CHAT. Review them with "피드백 후보", record the ones worth keeping `
        + 'with "후보 N 메모: …", export with learning-export, and add only owner-reviewed cases to the intent-routing or '
        + 'turn-handler-routing suite through a reviewed PR.',
      turnIds: mis.listed.slice(0, MAX_SAMPLE_TURN_IDS).map((c) => c.turnId),
    });
  }
  for (const cluster of found) {
    const chatShare = (cluster.capabilities[Capability.GENERAL_CHAT] ?? 0) / cluster.signalTurns;
    if (chatShare < 0.5) continue;
    out.push({
      area: 'HANDLER_PATTERN',
      summary: `Keyword cluster ${cluster.token}: ${cluster.signalTurns} of ${cluster.totalTurns} turns containing it drew a 👎 or a `
        + 'correction, mostly as GENERAL_CHAT. Read those turns and decide whether a deterministic handler pattern or '
        + 'routing rule is warranted; do not add one from the hash alone.',
      turnIds: cluster.sampleTurnIds,
    });
  }
  const thresholds = `lexical ${CURATED_EXAMPLE_MIN_LEXICAL_SCORE}, semantic ${CURATED_EXAMPLE_MIN_SEMANTIC_SCORE}`;
  if (usage.withExamples.turns === 0) {
    out.push({
      area: 'EMBEDDING_RECALL',
      summary: `No GENERAL_CHAT run carried curated examples in this window, so the relevance thresholds (${thresholds}) have `
        + 'no measurement and stay unchanged. Enable QUOKY_LEARNING_EXAMPLES_ENABLED with a LOCAL provider to collect data.',
      turnIds: [],
    });
  } else if (usage.lowSample || usage.deltaPoints === null) {
    out.push({
      area: 'EMBEDDING_RECALL',
      summary: `Too few turns to judge the relevance thresholds (${thresholds}): fewer than ${MIN_COMPARISON_TURNS} with or without `
        + 'examples. Keep them unchanged and re-run after more rated turns.',
      turnIds: [],
    });
  } else if (usage.deltaPoints > 0) {
    out.push({
      area: 'EMBEDDING_RECALL',
      summary: `Turns with examples have a ${usage.deltaPoints} point higher 👎 rate than without. Consider raising the relevance `
        + `thresholds (now ${thresholds}) in a reviewed PR and re-measure; this report changes nothing.`,
      turnIds: [],
    });
  } else {
    out.push({
      area: 'EMBEDDING_RECALL',
      summary: `Turns with examples have a ${Math.abs(usage.deltaPoints)} point lower or equal 👎 rate than without. Keep the `
        + `relevance thresholds (${thresholds}) unchanged.`,
      turnIds: [],
    });
  }
  return out;
}

const NOTES: readonly string[] = [
  'Read-only and offline: derived from content-free tables (ids, routing facts, counts, keyword hashes).',
  'A 👎 rate is 👎-rated turns divided by recorded non-control turns (ADR-0107 D3); a turn with both reactions counts in both.',
  'Candidate misroutes are 👎 turns routed as GENERAL_CHAT; this is evidence for the owner, not a verdict.',
  'Message text appears only as a bounded guarded excerpt of an owner-approved learning item; idealAnswer is never printed.',
  'Nothing here is applied automatically. Proposals enter the repository only through an owner-reviewed PR (ADR-0098 D7, ADR-0107 D8).',
];

/** Build the report. Pure: no I/O, no clock. The same input gives the same report. */
export function buildLearningReport(input: BuildReportInput): LearningReport {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error('REPORT_NOW_INVALID');
  const windowsDays = [...new Set(input.windowsDays)].sort((a, b) => a - b);
  if (windowsDays.length === 0) throw new Error('REPORT_WINDOWS_INVALID');
  const widest = windowsDays[windowsDays.length - 1] as number;
  const windows = windowsDays.map((days) => windowReport(input.turns, days, nowMs));
  const widestTurns = input.turns.filter((t) => Date.parse(t.createdAt) >= nowMs - widest * DAY_MS);
  const mis = misroutes(widestTurns, input.items, input.includeItemText, input.maxCandidates);
  const found = clusters(widestTurns, input.minCluster);
  const widestWindow = windows[windows.length - 1] as WindowReport;
  return {
    kind: LEARNING_REPORT_KIND,
    version: LEARNING_REPORT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    scope: { actorFiltered: input.actorFiltered, itemText: input.includeItemText, turnsTruncated: input.turnsTruncated },
    windows,
    trend: { days: TREND_DAYS, rows: trendRows(input.turns, nowMs) },
    learningItems: itemsReport(input.items, nowMs),
    misrouteCandidates: { windowDays: widest, total: mis.total, listed: mis.listed },
    clusters: { windowDays: widest, minCluster: Math.max(2, input.minCluster), rows: found },
    proposals: proposals(mis, found, widestWindow.curatedUsage),
    notes: NOTES,
  };
}

function pct(rate: number | null): string {
  return rate === null ? '-' : `${round(rate * 100, 1)}%`;
}

function signed(points: number | null): string {
  return points === null ? '-' : `${points > 0 ? '+' : ''}${points}pt`;
}

function rateCell(c: CountRate): string {
  return `${pct(c.negativeRate)} (${c.negative}/${c.turns})`;
}

function countsLine(record: Readonly<Record<string, number>>): string {
  const keys = Object.keys(record).sort();
  return keys.length === 0 ? '-' : keys.map((key) => `${key} ${record[key]}`).join(', ');
}

/** Render the report as Markdown. Deterministic; contains no text beyond guarded approved-item excerpts. */
export function renderLearningReportMarkdown(report: LearningReport): string {
  const lines: string[] = [];
  lines.push('# Quoky learning report', '');
  lines.push(`Generated ${report.generatedAt} · ADR-0107 D8 · offline, read-only`);
  lines.push(`Scope: ${report.scope.actorFiltered ? 'one actor' : 'all actors'} · item text ${report.scope.itemText ? 'on' : 'off'}`
    + `${report.scope.turnsTruncated ? ' · TURNS TRUNCATED (row cap reached; older turns omitted)' : ''}`, '');

  for (const w of report.windows) {
    lines.push(`## Feedback, last ${w.days} days`, '');
    lines.push(`Turns ${w.overall.turns} · 👍 ${w.overall.positive} · 👎 ${w.overall.negative} (${pct(w.overall.negativeRate)}) `
      + `· corrections ${w.overall.implicitCorrection} · other implicit ${w.overall.implicitOther}`, '');
    lines.push('| Capability | Turns | 👍 | 👎 | 👎 rate | Corrections |', '|---|---:|---:|---:|---:|---:|');
    for (const r of w.byCapability) {
      lines.push(`| ${r.key} | ${r.turns} | ${r.positive} | ${r.negative} | ${pct(r.negativeRate)} | ${r.implicitCorrection} |`);
    }
    lines.push('', '| Intent | Turns | 👍 | 👎 | 👎 rate | Corrections |', '|---|---:|---:|---:|---:|---:|');
    for (const r of w.byIntent) {
      lines.push(`| ${r.key} | ${r.turns} | ${r.positive} | ${r.negative} | ${pct(r.negativeRate)} | ${r.implicitCorrection} |`);
    }
    const u = w.curatedUsage;
    lines.push('', `Curated examples (GENERAL_CHAT runs, ${u.chatTurnsWithRun} linked, ${u.chatTurnsWithoutRun} without a run): `
      + `with examples ${rateCell(u.withExamples)} · without ${rateCell(u.withoutExamples)} · delta ${signed(u.deltaPoints)}`
      + `${u.lowSample ? ` · LOW SAMPLE (<${MIN_COMPARISON_TURNS} per side)` : ''}`, '');
  }

  lines.push(`## 👎 trend, ${report.trend.days} days vs previous ${report.trend.days}`, '');
  lines.push('| Capability | Now | Previous | Change |', '|---|---:|---:|---:|');
  for (const r of report.trend.rows) {
    lines.push(`| ${r.capability} | ${rateCell(r.current)} | ${rateCell(r.previous)} | ${signed(r.deltaPoints)} |`);
  }
  lines.push('');

  const li = report.learningItems;
  lines.push('## Learning items', '');
  lines.push(`Total ${li.total} · active ${li.active} · expired ${li.expired} · cap ${li.capPerActor} per actor `
    + `(max active ${li.maxActivePerActor})`);
  for (const [kind, row] of Object.entries(li.byKind)) lines.push(`- ${kind}: active ${row.active}, expired ${row.expired}`);
  lines.push(`- Egress: ${countsLine(li.byEgress)}${li.nonLocalEgress > 0 ? ` · WARNING ${li.nonLocalEgress} non-LOCAL_ONLY` : ''}`);
  lines.push(`- Active by capability: ${countsLine(li.activeByCapability)}`);
  lines.push(`- Active by language: ${countsLine(li.activeByLanguage)}`);
  lines.push(`- Active by source rating: ${countsLine(li.activeBySourceRating)}`);
  lines.push(`- Active expiring in <=30d ${li.expiry.within30d} · <=90d ${li.expiry.within90d} · <=180d ${li.expiry.within180d} · later ${li.expiry.later}`);
  lines.push(`- Active items refused by the credential guard at use: ${li.guardRefused}`, '');

  const mc = report.misrouteCandidates;
  lines.push(`## Candidate misroutes (👎 on GENERAL_CHAT, last ${mc.windowDays} days)`, '');
  lines.push(`${mc.total} turn(s); showing ${mc.listed.length}, newest first. Turn ids only; request text is never read.`, '');
  for (const c of mc.listed) {
    const examples = c.ranCuratedExamples === null ? 'run n/a' : c.ranCuratedExamples ? 'with examples' : 'no examples';
    lines.push(`- ${c.turnId} · ${c.createdAt} · intent ${c.intentType ?? NO_INTENT} · 👎 ${c.negative} 👍 ${c.positive} `
      + `· corrections ${c.implicitCorrection} · ${examples}`);
    if (c.approvedItem) {
      lines.push(`  - owner-approved ${c.approvedItem.kind} ${c.approvedItem.itemId}: request ${c.approvedItem.requestExcerpt}`
        + `${c.approvedItem.noteExcerpt !== undefined ? ` · note ${c.approvedItem.noteExcerpt}` : ''}`);
    }
  }
  lines.push('');

  lines.push(`## Keyword clusters (👎 or correction, last ${report.clusters.windowDays} days, min ${report.clusters.minCluster})`, '');
  if (report.clusters.rows.length === 0) lines.push('None.');
  for (const c of report.clusters.rows) {
    lines.push(`- ${c.token}: ${c.signalTurns}/${c.totalTurns} turns (${pct(c.signalRate)}) · ${countsLine(c.capabilities)} `
      + `· sample ${c.sampleTurnIds.join(', ')}`);
  }
  lines.push('');

  lines.push('## Proposals (owner-reviewed PR only)', '');
  for (const p of report.proposals) {
    lines.push(`- [${p.area}] ${p.summary}${p.turnIds.length > 0 ? ` Turns: ${p.turnIds.join(', ')}.` : ''}`);
  }
  lines.push('', '## Notes', '');
  for (const note of report.notes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

export type ReportFormat = 'md' | 'json';

export interface LearningReportCliDeps {
  readonly now: () => string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly openReader: typeof openLearningReportReader;
  /** Write a NEW file with mode 0600; throws (EEXIST) when it exists. */
  readonly writeNewFile: (path: string, content: string) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (line: string) => void;
}

const HELP = `Learning report (ADR-0107 D8) — offline, read-only, no network

  node apps/quoky/dist/tools/learning-report.js --db <quoky sqlite db> [options]

Options
  --db <path>            database (default: QUOKY_DB_PATH, then CHUNSIK_DB_PATH)
  --format md|json       output format (default md)
  --out <new file>       write a NEW file (mode 0600) instead of stdout; never overwrites
  --windows 7,30,90      trailing windows in days (1-${MAX_WINDOW_DAYS})
  --now <ISO time>       report clock (default: system clock); fixes the output for reproducibility
  --actor <actor id>     limit to one actor
  --max-candidates <n>   misroute candidates listed (default ${DEFAULT_MAX_CANDIDATES})
  --min-cluster <n>      smallest keyword cluster (default ${DEFAULT_MIN_CLUSTER})
  --no-item-text         never print owner-approved item excerpts
`;

const DEFAULT_DEPS: LearningReportCliDeps = {
  now: () => new Date().toISOString(),
  env: process.env,
  openReader: openLearningReportReader,
  writeNewFile: (path, content) => writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
  stdout: (text) => process.stdout.write(text),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

interface ParsedArgs {
  db?: string;
  out?: string;
  format: ReportFormat;
  windows: number[];
  now?: string;
  actor?: string;
  maxCandidates: number;
  minCluster: number;
  itemText: boolean;
}

function positiveInt(value: string, max: number): number | null {
  return /^\d{1,9}$/.test(value) && Number(value) >= 1 && Number(value) <= max ? Number(value) : null;
}

function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const parsed: ParsedArgs = {
    format: 'md', windows: [...DEFAULT_WINDOWS_DAYS], maxCandidates: DEFAULT_MAX_CANDIDATES, minCluster: DEFAULT_MIN_CLUSTER,
    itemText: true,
  };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i] as string;
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === '--no-item-text') {
      parsed.itemText = false;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return null;
    i += 1;
    switch (key) {
      case '--db': parsed.db = value; break;
      case '--out': parsed.out = value; break;
      case '--actor': parsed.actor = value; break;
      case '--format':
        if (value !== 'md' && value !== 'json') return null;
        parsed.format = value;
        break;
      case '--now':
        if (!Number.isFinite(Date.parse(value))) return null;
        parsed.now = new Date(value).toISOString();
        break;
      case '--windows': {
        const days = value.split(',').map((v) => positiveInt(v, MAX_WINDOW_DAYS));
        if (days.length === 0 || days.some((d) => d === null)) return null;
        parsed.windows = days as number[];
        break;
      }
      case '--max-candidates': {
        const n = /^\d{1,4}$/.test(value) ? Number(value) : null;
        if (n === null) return null;
        parsed.maxCandidates = n;
        break;
      }
      case '--min-cluster': {
        const n = positiveInt(value, 1000);
        if (n === null) return null;
        parsed.minCluster = n;
        break;
      }
      default: return null;
    }
  }
  return parsed;
}

/** Run the report. stdout carries the report (or one summary line with `--out`); errors never include item text. */
export async function runCli(argv: readonly string[], deps: LearningReportCliDeps = DEFAULT_DEPS): Promise<number> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.includes('--help') || args.includes('-h')) {
    deps.stdout(HELP);
    return EXIT_OK;
  }
  const options = parseArgs(args);
  const dbSetting = options?.db ?? deps.env.QUOKY_DB_PATH ?? deps.env.CHUNSIK_DB_PATH;
  if (!options || !dbSetting) {
    deps.stderr(HELP);
    return EXIT_USAGE;
  }
  const dbPath = resolve(dbSetting);
  let reader: ReturnType<typeof openLearningReportReader> | undefined;
  try {
    reader = deps.openReader(dbPath);
    const now = options.now ?? deps.now();
    const nowMs = Date.parse(now);
    const widest = Math.max(...options.windows, 2 * TREND_DAYS);
    const { turns, truncated } = reader.listTurns({
      since: new Date(nowMs - widest * DAY_MS).toISOString(),
      until: new Date(nowMs).toISOString(),
      ...(options.actor !== undefined ? { actorId: options.actor } : {}),
      limit: MAX_TURNS,
    });
    const report = buildLearningReport({
      now,
      windowsDays: options.windows,
      turns,
      items: reader.listLearningItems(new Date(nowMs).toISOString(), options.actor),
      turnsTruncated: truncated,
      actorFiltered: options.actor !== undefined,
      includeItemText: options.itemText,
      maxCandidates: options.maxCandidates,
      minCluster: options.minCluster,
    });
    const text = options.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderLearningReportMarkdown(report);
    if (options.out !== undefined) {
      const outPath = resolve(options.out);
      deps.writeNewFile(outPath, text);
      deps.stdout(`learning report: ${report.windows[0]?.overall.turns ?? 0} turns in the first window, `
        + `${report.misrouteCandidates.total} candidate misroutes; written to ${outPath}\n`);
    } else {
      deps.stdout(text);
    }
    return EXIT_OK;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : '';
    if (code === 'EEXIST') {
      deps.stderr('BLOCKED: the output file already exists; choose a new path (nothing was overwritten)');
      return EXIT_BLOCKED;
    }
    if (message === 'LEARNING_SCHEMA_MISSING' || message === 'SCHEMA_VERSION_AHEAD') {
      deps.stderr(`BLOCKED: ${message}; the database was not changed`);
      return EXIT_BLOCKED;
    }
    deps.stderr(`error: ${error instanceof Error ? error.name : 'unknown'}${typeof code === 'string' ? ` (${code})` : ''}`);
    return EXIT_FAILED;
  } finally {
    reader?.close();
  }
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT_FAILED;
    },
  );
}

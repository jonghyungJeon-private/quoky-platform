// G6 harness: the blind session, latency statistics and the pre-registered decision rule (DECISIONS.md "ADR-0121 A3a
// measurement record"). Pure; no clock, no network, no model.
//
// - Blind order: every L0 and LT output of every case in one interleaved session, sorted ascending by
//   sha256(seed + caseId + arm) as lowercase hex, seed `quoky-g6-20261026`. The blind id is the first 16 hex chars.
// - Latency per case-arm = wall time from the first request to the final reply (retry included). Cold = the first
//   case of the arm after the model was unloaded; warm = every other case. p95 = nearest rank, sorted[ceil(0.95n)-1].
// - Bars: L0 warm median ≤ 5 s and cold ≤ 15 s; LT warm median ≤ 20 s and warm p95 ≤ 35 s. An arm that misses its
//   bar cannot pass.
// - Arm choice: the higher calendar usable+ among arms meeting their bar; a tie goes to L0.
// - Decision (calendar only): ≥ 80% local adequate; 70–79% near miss (one more round on a fresh set); < 70% not adequate.
//   Other sources are reported only.

import { createHash } from 'node:crypto';

export const SEED = 'quoky-g6-20261026';
export const LABELS = ['useless', 'usable', 'good'];
export const BARS = {
  L0: { warmMedianMs: 5_000, coldMs: 15_000 },
  LT: { warmMedianMs: 20_000, warmP95Ms: 35_000 },
};
export const RUN_WALL_MS = 45_000;

export function blindKey(caseId, arm, seed = SEED) {
  return createHash('sha256').update(`${seed}${caseId}${arm}`, 'utf8').digest('hex');
}

/** Orders outputs [{ caseId, arm, ... }] for the blind session; adds `blindId`. */
export function blindOrder(outputs, seed = SEED) {
  return outputs
    .map((o) => ({ ...o, key: blindKey(o.caseId, o.arm, seed) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ key, ...o }) => ({ blindId: key.slice(0, 16), ...o }));
}

export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function p95(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.ceil(0.95 * s.length) - 1];
}

/** Latency summary and bar check of one arm. `results` = [{ latencyMs, cold }]. */
export function latencySummary(arm, results) {
  const warm = results.filter((r) => !r.cold).map((r) => r.latencyMs);
  const cold = results.filter((r) => r.cold).map((r) => r.latencyMs);
  const summary = { warmMedianMs: median(warm), warmP95Ms: p95(warm), coldMs: cold.length ? Math.max(...cold) : null, warmN: warm.length };
  const bar = BARS[arm];
  const misses = [];
  if (summary.warmMedianMs === null || summary.warmMedianMs > bar.warmMedianMs) misses.push('warm median');
  if (bar.coldMs !== undefined && (summary.coldMs === null || summary.coldMs > bar.coldMs)) misses.push('cold');
  if (bar.warmP95Ms !== undefined && (summary.warmP95Ms === null || summary.warmP95Ms > bar.warmP95Ms)) misses.push('warm p95');
  return { ...summary, meetsBar: misses.length === 0, misses };
}

/** usable+ count per source for one arm. `labelled` = [{ source, label }]. */
export function usablePlus(labelled) {
  const bySource = {};
  for (const { source, label } of labelled) {
    if (!LABELS.includes(label)) throw new Error(`invalid label ${label}`);
    bySource[source] ??= { usablePlus: 0, total: 0 };
    bySource[source].total += 1;
    if (label !== 'useless') bySource[source].usablePlus += 1;
  }
  for (const v of Object.values(bySource)) v.share = v.usablePlus / v.total;
  return bySource;
}

/** The arm choice and the calendar decision. `arms` = { L0: { meetsBar, calendarShare }, LT: {...} | undefined }. */
export function decide(arms) {
  const eligible = ['L0', 'LT'].filter((a) => arms[a] && arms[a].meetsBar);
  if (eligible.length === 0) return { chosenArm: null, decision: 'no-arm-meets-latency-bar', calendarShare: null };
  const chosenArm = eligible.reduce((best, a) => (arms[a].calendarShare > arms[best].calendarShare ? a : best), eligible[0]);
  const share = arms[chosenArm].calendarShare;
  const pct = Math.round(share * 10_000) / 100;
  let decision;
  if (share >= 0.8) decision = 'local-adequate';
  else if (share >= 0.7) decision = 'near-miss';
  else decision = 'local-not-adequate';
  return { chosenArm, decision, calendarShare: share, calendarPct: pct };
}

/**
 * The remaining-time rule for a retry (A3a-D5): under LT the retry runs only if the time left in the 45 s wall
 * covers the arm's p95. The p95 is that of the LT first attempts measured so far in this run; until 5 exist it is
 * the LT p95 bar (35 s). L0 retries whenever time is left (each call's timeout is the time left in the wall).
 */
export function retryAllowed({ arm, elapsedMs, firstAttemptMs }) {
  const left = RUN_WALL_MS - elapsedMs;
  if (left <= 0) return false;
  if (arm !== 'LT') return true;
  const p = firstAttemptMs.length >= 5 ? p95(firstAttemptMs) : BARS.LT.warmP95Ms;
  return left >= p;
}

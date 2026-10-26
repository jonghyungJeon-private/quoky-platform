// G7 harness: arm A from the G6 run, the ordinal remap of arm B, the blind A/B session, the A/B lock, arm C's later
// session and the pre-registered G7 rule. Pure; no clock, no network, no model.
//
// - Arm A = the G6 run's L0 output of each G7 case (no arm met its latency bar, so there is no "chosen" arm; L0 is the
//   tie-break arm of the record and the only one with answers on most cases). It is re-rendered from the sealed raw
//   output by the frozen G6 guards and renderer, and must reproduce the sealed reply byte for byte.
// - Arm B answers in payload order; its ordinals and placeholders are mapped back to the case order, then the SAME G6
//   renderer renders it from the case's full items, so both arms show identical full title text [C3].
// - Every non-answer of either arm (guard failure after the retry, provider failure, no offer) is shown as the G6
//   fallback rendering, so no wording reveals the arm.
// - Blind A/B session: one interleaved session ordered by sha256(seed + caseId + arm) (arms "A", "B"), seed
//   `quoky-g7-<run date>`; plus one preference pair per case (first = the arm with the smaller key). Labels:
//   useless / usable / good per entry; preference first / second / tie per pair.
// - Arm C runs only after the A/B labels are locked (ab-lock.json) and gets its own session, ordered by
//   sha256(seed + caseId + "C"); reported only.
// - Rule (G7): opens only if G6 found local not adequate on calendar, arm B usable+ ≥ 80%, and arm B is preferred over
//   arm A with a one-sided exact binomial p < 0.05 over ≥ 25 non-tie pairs.

import { createHash } from 'node:crypto';

import { guardOutput } from '../g6/guards.mjs';
import { renderEmpty, renderFallback, renderJudge } from '../g6/render.mjs';

export const LABELS = ['useless', 'usable', 'good'];
export const PREFERENCES = ['first', 'second', 'tie'];
export const USABLE_PLUS_BAR = 0.8;
export const NON_TIE_MIN = 25;
export const P_MAX = 0.05;
export const SEED_SHAPE = /^quoky-g7-(\d{8})$/u;
/** The G6 result (DECISIONS "ADR-0121 A3a G6 result (2026-10-26)"); an arm that misses its bar cannot pass. */
export const G6_DECISION = 'no-arm-meets-latency-bar';
export const G6_NOT_ADEQUATE = ['no-arm-meets-latency-bar', 'local-not-adequate'];

export function key(seed, caseId, tag) {
  return createHash('sha256').update(`${seed}${caseId}${tag}`, 'utf8').digest('hex');
}

/** The seed's date must be the run's local date (YYYYMMDD in the set's time zone). */
export function seedMatchesRunDate(seed, runStartMs, timeZone) {
  const m = SEED_SHAPE.exec(seed ?? '');
  if (!m) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(runStartMs))
      .map((p) => [p.type, p.value]),
  );
  return m[1] === `${parts.year}${parts.month}${parts.day}`;
}

// --- arm A ---------------------------------------------------------------------------------------------------------
/**
 * Re-renders one sealed G6 L0 result for its case. Returns { reply, outcome } or throws when the re-render does not
 * reproduce the sealed reply (the harness then refuses).
 */
export function rerenderArmA(sealed, testCase, timeZone) {
  let reply;
  if (sealed.outcome === 'fallback') {
    reply = renderFallback(testCase, timeZone);
  } else {
    const last = [...sealed.attempts].reverse().find((a) => a.check === 'pass' || a.check === 'empty');
    if (!last) throw new Error(`arm A ${sealed.caseId}: no passing attempt in the sealed result`);
    const g = guardOutput(last.content, testCase);
    if (!g.ok) throw new Error(`arm A ${sealed.caseId}: the sealed passing attempt no longer passes (${g.check})`);
    reply = g.empty ? renderEmpty(testCase) : renderJudge(g.output, testCase, timeZone);
  }
  if (reply !== sealed.reply) throw new Error(`arm A ${sealed.caseId}: re-render differs from the sealed G6 reply`);
  return { reply, outcome: sealed.outcome };
}

// --- arm B ---------------------------------------------------------------------------------------------------------
const PLACEHOLDER = /\{(item|time|end):([1-9]\d*)\}/gu;

/** Maps a guarded payload-order output to case order. perm[p-1] = case index of payload ordinal p. */
export function remapOutput(output, perm) {
  const toCase = (p) => perm[p - 1] + 1;
  const text = (s) => s.replace(PLACEHOLDER, (_, kind, p) => `{${kind}:${toCase(Number(p))}}`);
  return {
    intro: text(output.intro),
    ranked: output.ranked.map((e) => ({ n: toCase(e.n), why: text(e.why) })),
    extra: output.extra.map(text),
  };
}

/** Renders a guarded arm-B output (payload order) with the case's full items. */
export function renderArmB(guarded, perm, testCase, timeZone) {
  if (guarded.empty) return renderEmpty(testCase);
  return renderJudge(remapOutput(guarded.output, perm), testCase, timeZone);
}

// --- the blind sessions --------------------------------------------------------------------------------------------
/** Orders [{ caseId, arm, ... }] by sha256(seed + caseId + arm); adds blindId (16 hex). */
export function blindOrder(outputs, seed) {
  return outputs
    .map((o) => ({ ...o, k: key(seed, o.caseId, o.arm) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map(({ k, ...o }) => ({ blindId: k.slice(0, 16), ...o }));
}

/** One preference pair per case: { pairId, caseId, first, second } (blind ids), ordered by sha256(seed+caseId+"pair"). */
export function pairs(ordered, seed) {
  const byCase = new Map();
  for (const o of ordered) {
    if (!byCase.has(o.caseId)) byCase.set(o.caseId, {});
    byCase.get(o.caseId)[o.arm] = o;
  }
  const out = [];
  for (const [caseId, arms] of byCase) {
    if (!arms.A || !arms.B) throw new Error(`case ${caseId} needs both arm A and arm B`);
    const a = key(seed, caseId, 'A');
    const b = key(seed, caseId, 'B');
    const [first, second] = a < b ? [arms.A, arms.B] : [arms.B, arms.A];
    out.push({ pairId: key(seed, caseId, 'pair').slice(0, 16), caseId, first: first.blindId, second: second.blindId });
  }
  return out.sort((x, y) => (x.pairId < y.pairId ? -1 : x.pairId > y.pairId ? 1 : 0));
}

/** Problems of an A/B labels file against the sealed session (empty = complete and valid). */
export function checkAbLabels(labelsFile, sealed, pairList) {
  const problems = [];
  const labels = labelsFile?.labels ?? {};
  const prefs = labelsFile?.preferences ?? {};
  for (const r of sealed) if (!LABELS.includes(labels[r.blindId])) problems.push(`label of ${r.blindId} missing or invalid`);
  for (const p of pairList) if (!PREFERENCES.includes(prefs[p.pairId])) problems.push(`preference of ${p.pairId} missing or invalid`);
  const known = new Set(sealed.map((r) => r.blindId));
  for (const id of Object.keys(labels)) if (!known.has(id)) problems.push(`unknown blind id ${id}`);
  const knownPairs = new Set(pairList.map((p) => p.pairId));
  for (const id of Object.keys(prefs)) if (!knownPairs.has(id)) problems.push(`unknown pair id ${id}`);
  return problems;
}

// --- the rule ------------------------------------------------------------------------------------------------------
function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i += 1) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** One-sided exact binomial P(X ≥ k | n, 0.5). */
export function binomialUpperP(k, n) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let p = 0;
  for (let i = k; i <= n; i += 1) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, p);
}

function usablePlusShare(rows, labels) {
  const n = rows.length;
  const u = rows.filter((r) => labels[r.blindId] !== 'useless').length;
  return { usablePlus: u, total: n, share: n ? u / n : 0 };
}

/** The G7 result from locked A/B labels. `sealed` = A/B results with blindId and arm. */
export function decideG7({ sealed, pairList, labelsFile, g6Decision = G6_DECISION }) {
  const labels = labelsFile.labels;
  const armOf = new Map(sealed.map((r) => [r.blindId, r.arm]));
  const A = usablePlusShare(sealed.filter((r) => r.arm === 'A'), labels);
  const B = usablePlusShare(sealed.filter((r) => r.arm === 'B'), labels);
  let bPreferred = 0;
  let aPreferred = 0;
  let ties = 0;
  for (const p of pairList) {
    const pref = labelsFile.preferences[p.pairId];
    if (pref === 'tie') ties += 1;
    else if (armOf.get(pref === 'first' ? p.first : p.second) === 'B') bPreferred += 1;
    else aPreferred += 1;
  }
  const nonTie = bPreferred + aPreferred;
  const p = binomialUpperP(bPreferred, nonTie);
  const g6NotAdequate = G6_NOT_ADEQUATE.includes(g6Decision);
  const reasons = [];
  if (!g6NotAdequate) reasons.push(`G6 decision ${g6Decision} is not "local not adequate"`);
  if (B.share < USABLE_PLUS_BAR) reasons.push(`arm B usable+ ${B.usablePlus}/${B.total} < 80%`);
  if (nonTie < NON_TIE_MIN) reasons.push(`non-tie pairs ${nonTie} < ${NON_TIE_MIN}`);
  if (!(p < P_MAX)) reasons.push(`one-sided binomial p ${p.toFixed(4)} ≥ ${P_MAX}`);
  return {
    g6Decision,
    armA: A,
    armB: B,
    preference: { bPreferred, aPreferred, ties, nonTie, p },
    opens: reasons.length === 0,
    decision: reasons.length === 0 ? 'g7-opens' : 'g7-does-not-open',
    reasons,
  };
}

#!/usr/bin/env node
// Calibrates the quoky-eval-judge subagent against the owner's blind labels.
//
// Runs the judge (the agent file's body as the system prompt, its frontmatter model, no tools) on one half of the
// judgment blind eval and reports agreement with the owner. Eval/synthetic data only: the input is blind.json
// (synthetic items + answers A/B). key.json (arm map) is never read.
//
// Usage:
//   node tools/eval-judge/calibrate.mjs [--set heldOut|calibration] [--runs 3] [--concurrency 3]
//        [--archive <dir>] [--out <dir>] [--model <model>]
// Resumable: results are written to <out>/raw.json after every call; a rerun skips finished (case, run) pairs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const archive =
  args.archive ?? path.join(os.homedir(), 'Library/Application Support/Quoky/eval-archive/judgment-eval-20261023');
const set = args.set ?? 'heldOut';
const runs = Number(args.runs ?? 3);
const concurrency = Number(args.concurrency ?? 3);
const out = args.out ?? path.join(archive, `judge-runs/${set}`);

const agentFile = fs.readFileSync(path.join(repo, '.claude/agents/quoky-eval-judge.md'), 'utf8');
const fm = agentFile.match(/^---\n([\s\S]*?)\n---\n/);
if (!fm) throw new Error('agent file has no frontmatter');
const system = agentFile.slice(fm[0].length).trim();
const model = args.model ?? fm[1].match(/^model:\s*(\S+)/m)?.[1] ?? 'opus';

const blind = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(archive, 'blind.json'), 'utf8')).map((c) => [c.id, c]));
const owner = JSON.parse(fs.readFileSync(path.join(archive, 'owner-labels.json'), 'utf8')).labels;
const split = JSON.parse(fs.readFileSync(path.join(archive, 'judge-split.json'), 'utf8'));
const ids = split[set];
if (!Array.isArray(ids)) throw new Error(`unknown set ${set}`);

function userMessage(c) {
  const items = c.items.map((it, i) => `${i + 1}. ${it}`).join('\n');
  return [
    `case id: ${c.id}`,
    `owner request: ${c.ownerRequest}`,
    `requested count: ${c.count ?? 'none'}`,
    '',
    'items:',
    items,
    '',
    '--- answer A ---',
    c.answers.A,
    '',
    '--- answer B ---',
    c.answers.B,
  ].join('\n');
}

function callJudge(c) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(
      'claude',
      ['-p', '--model', model, '--tools', '', '--system-prompt', system, '--no-session-persistence',
        '--strict-mcp-config', '--disable-slash-commands'],
      { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), 300_000);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ raw: stdout.trim(), code, stderr: stderr.slice(0, 500), sec: (Date.now() - t0) / 1000 });
    });
    p.stdin.end(userMessage(c));
  });
}

const LABELS = ['useless', 'usable', 'good'];
function parse(raw) {
  const t = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const o = JSON.parse(t);
    for (const k of ['A', 'B']) if (!LABELS.includes(o?.answers?.[k]?.label)) return null;
    if (!['A', 'B', 'same'].includes(o?.preference?.choice)) return null;
    return o;
  } catch {
    return null;
  }
}

fs.mkdirSync(out, { recursive: true });
const rawPath = path.join(out, 'raw.json');
const results = fs.existsSync(rawPath) ? JSON.parse(fs.readFileSync(rawPath, 'utf8')) : {};
const jobs = [];
for (let r = 0; r < runs; r++) for (const id of ids) if (!parse(results[`${id}#${r}`]?.raw ?? '')) jobs.push([id, r]);
console.log(`set=${set} cases=${ids.length} runs=${runs} model=${model} pending=${jobs.length}`);

async function worker() {
  while (jobs.length) {
    const [id, r] = jobs.shift();
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await callJudge(blind[id]);
      if (parse(res.raw)) break;
    }
    results[`${id}#${r}`] = res;
    fs.writeFileSync(rawPath, JSON.stringify(results, null, 1));
    console.log(id, r, res.sec.toFixed(1), parse(res.raw) ? 'ok' : `INVALID ${res.raw.slice(0, 80)}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

// ---- metrics ----
const plus = (l) => l !== 'useless';
function kappa(pairs, cats) {
  const n = pairs.length;
  if (!n) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = cats.reduce((s, c) => s + (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}
const pct = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const r3 = (x) => (x == null ? 'n/a' : x.toFixed(3));

const perRun = [];
const judged = {}; // id -> [run outputs]
for (let r = 0; r < runs; r++) {
  const lab = [];
  const pref = [];
  const rows = [];
  for (const id of ids) {
    const o = parse(results[`${id}#${r}`]?.raw ?? '');
    (judged[id] ??= [])[r] = o;
    if (!o) continue;
    for (const k of ['A', 'B']) {
      lab.push([owner[id][k], o.answers[k].label]);
      rows.push({ id, k, owner: owner[id][k], judge: o.answers[k].label, conf: o.answers[k].confidence, low: o.lowConfidence });
    }
    pref.push([owner[id].pref, o.preference.choice]);
  }
  const hi = rows.filter((x) => !x.low);
  perRun.push({
    run: r,
    valid: pref.length,
    exact: lab.filter(([a, b]) => a === b).length / lab.length,
    usablePlus: lab.filter(([a, b]) => plus(a) === plus(b)).length / lab.length,
    pref: pref.filter(([a, b]) => a === b).length / pref.length,
    kappa3: kappa(lab, LABELS),
    kappaBin: kappa(lab.map(([a, b]) => [plus(a), plus(b)]), [true, false]),
    kappaPref: kappa(pref, ['A', 'B', 'same']),
    lowConfAnswers: rows.filter((x) => x.low).length / rows.length,
    exactHighConf: hi.length ? hi.filter((x) => x.owner === x.judge).length / hi.length : null,
    usablePlusHighConf: hi.length ? hi.filter((x) => plus(x.owner) === plus(x.judge)).length / hi.length : null,
  });
}

// Stability: per answer / per preference, do all runs agree?
let labSame = 0, labN = 0, prefSame = 0, prefN = 0, pairAgree = 0, pairN = 0;
const majority = [];
const majPref = [];
const disagreements = [];
for (const id of ids) {
  const os_ = judged[id].filter(Boolean);
  if (os_.length < runs) continue;
  for (const k of ['A', 'B']) {
    const ls = os_.map((o) => o.answers[k].label);
    labN++;
    if (new Set(ls).size === 1) labSame++;
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) { pairN++; if (ls[i] === ls[j]) pairAgree++; }
    const counts = Object.entries(ls.reduce((m, l) => ({ ...m, [l]: (m[l] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
    const m = counts[0][0];
    majority.push([owner[id][k], m]);
    if (m !== owner[id][k]) disagreements.push(`${id} ${k}: owner=${owner[id][k]} judge=${ls.join('/')}`);
  }
  const ps = os_.map((o) => o.preference.choice);
  prefN++;
  if (new Set(ps).size === 1) prefSame++;
  const pm = Object.entries(ps.reduce((m, l) => ({ ...m, [l]: (m[l] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0][0];
  majPref.push([owner[id].pref, pm]);
  if (pm !== owner[id].pref) disagreements.push(`${id} pref: owner=${owner[id].pref} judge=${ps.join('/')}`);
}

const summary = {
  set, model, runs, cases: ids.length, ids,
  perRun,
  mean: Object.fromEntries(['exact', 'usablePlus', 'pref', 'kappa3', 'kappaBin', 'kappaPref', 'lowConfAnswers'].map((k) => [k, perRun.reduce((s, r) => s + (r[k] ?? 0), 0) / perRun.length])),
  majority: {
    exact: majority.filter(([a, b]) => a === b).length / majority.length,
    usablePlus: majority.filter(([a, b]) => plus(a) === plus(b)).length / majority.length,
    pref: majPref.filter(([a, b]) => a === b).length / majPref.length,
    kappa3: kappa(majority, LABELS),
  },
  stability: { labelAllRunsSame: labSame / labN, labelPairwise: pairN ? pairAgree / pairN : null, prefAllRunsSame: prefSame / prefN },
  disagreements,
};
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
for (const r of perRun)
  console.log(`run ${r.run}: valid ${r.valid}/${ids.length} exact ${pct(r.exact)} usable+ ${pct(r.usablePlus)} pref ${pct(r.pref)} ` +
    `kappa3 ${r3(r.kappa3)} kappaBin ${r3(r.kappaBin)} kappaPref ${r3(r.kappaPref)} lowConf ${pct(r.lowConfAnswers)} ` +
    `exact@hiConf ${pct(r.exactHighConf)} usable+@hiConf ${pct(r.usablePlusHighConf)}`);
console.log('mean', Object.fromEntries(Object.entries(summary.mean).map(([k, v]) => [k, r3(v)])));
console.log('majority', Object.fromEntries(Object.entries(summary.majority).map(([k, v]) => [k, r3(v)])));
console.log('stability', Object.fromEntries(Object.entries(summary.stability).map(([k, v]) => [k, pct(v)])));
console.log('disagreements (majority vs owner):\n  ' + disagreements.join('\n  '));

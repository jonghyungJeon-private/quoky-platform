#!/usr/bin/env node
// G6 run script (ADR-0121 A3a-D8; DECISIONS.md "ADR-0121 A3a measurement record — the G6 protocol").
//
// Usage:
//   node tools/g6/run.mjs verify  [--set <repo-relative path>]
//       No model call, no Ollama call. Checks the committed freeze addendum against the files, the commit order, the
//       rubric and the model manifest file, then validates the set and its G6 coverage. Exit 0 = ready, 3 = refused.
//   node tools/g6/run.mjs g6      --strict-approved [--set <path>] [--arms L0,LT] [--out <dir>]
//       THE G6 RUN. Strict model-in-the-loop run: needs the owner's separate Strict yes (the flag records it).
//       Refuses unless every recorded hash matches (prompt, harness files, set, rubric, model digest).
//   node tools/g6/run.mjs dry-run --strict-approved [--out <dir>]
//       The pre-G6 LT dry run on the 2026-10-23 TUNING set only: does the installed Ollama apply `format` with
//       `think: true`? One LT attempt per case, no retry; each output is validated against its request schema.
//       Needs the part-1 freeze (prompt + harness) and the tuning set's recorded hash. Strict (calls the model).
//   node tools/g6/run.mjs score   --out <run dir> --labels <owner labels file>
//       After the owner's blind labels are complete: usable+ per arm and source, latency bars, arm choice, decision.
//
// Run outputs (the out dir must not exist; default under ~/Library/Application Support/Quoky/eval-archive/):
//   run.log                 first line = start time, HEAD and every verified hash
//   blind.json              owner-facing blind session (rendered replies, no arm), seeded interleaved order
//   labels.template.json    { labels: { <blindId>: null } } for the owner to fill with useless / usable / good
//   sealed-outputs.json     arm, attempts, raw model content (thinking text discarded), latency; NOT for the owner
//                           and NOT for the eval judge before the owner's labels are complete
//   stats.json              per-arm validity and latency (no quality numbers)
// The eval judge may pre-screen only (A3a-D8): never a gate label, never counted, never shown before owner labels.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { adaptTuningSet, coverage, TUNING_SET_SHA256, validateSet } from './cases.mjs';
import {
  DEFAULT_SET_PATH,
  MODEL_MANIFEST_SHA256,
  PROMPT_PATH,
  RUBRIC_PATH,
  TUNING_SET_PATH,
  fileHasher,
  verifyAll,
} from './freeze.mjs';
import { CORRECTIONS, guardOutput } from './guards.mjs';
import { renderFallback, renderJudge, renderListing } from './render.mjs';
import { ARMS, MODEL, OLLAMA_BASE, buildRequestBody } from './request.mjs';
import { buildJudgeSchema, validateAgainstSchema } from './schema.mjs';
import { RUN_WALL_MS, SEED, blindOrder, decide, latencySummary, retryAllowed, usablePlus } from './score.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARCHIVE = path.join(os.homedir(), 'Library/Application Support/Quoky/eval-archive');
const DRY_RUN_CALL_TIMEOUT_MS = 120_000;
const EXIT_REFUSED = 3;

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === 'strict-approved') flags[key] = true;
    else {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      flags[key] = value;
      i += 1;
    }
  }
  return { mode, flags };
}

function refuse(problems) {
  console.error('G6 HARNESS REFUSED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(EXIT_REFUSED);
}

function head() {
  const r = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim() || 'unknown';
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
}

function makeOutDir(dir) {
  if (fs.existsSync(dir)) refuse([`out dir already exists (a run is never overwritten): ${dir}`]);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 1)}\n`);
}

function logger(dir) {
  const file = path.join(dir, 'run.log');
  return (line) => {
    fs.appendFileSync(file, `${line}\n`);
    console.log(line);
  };
}

// --- Ollama (loopback only) ----------------------------------------------------------------------------------------
async function ollama(pathname, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(`${OLLAMA_BASE}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { error: `http ${res.status}` };
    return { json: await res.json() };
  } catch (err) {
    return { error: controller.signal.aborted ? 'timeout' : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** The served qwen3:8b must be the pinned manifest (GET /api/tags lists models; it runs no model). */
async function checkServedDigest() {
  const tags = await ollama('/api/tags', undefined, 10_000);
  if (tags.error) return [`ollama /api/tags failed: ${tags.error}`];
  const entry = (tags.json.models ?? []).find((m) => m.name === MODEL || m.model === MODEL);
  if (!entry) return [`${MODEL} is not served by the loopback Ollama`];
  if (entry.digest !== MODEL_MANIFEST_SHA256) return [`served ${MODEL} digest ${entry.digest} is not ${MODEL_MANIFEST_SHA256}`];
  return [];
}

async function unloadModel() {
  await ollama('/api/generate', { model: MODEL, keep_alive: 0 }, 30_000);
}

async function chat(body, timeoutMs) {
  const t0 = performance.now();
  const r = await ollama('/api/chat', body, timeoutMs);
  const latencyMs = Math.round(performance.now() - t0);
  if (r.error) return { latencyMs, error: r.error };
  // The thinking text (LT) is discarded here: only the answer content is kept.
  return { latencyMs, content: String(r.json?.message?.content ?? ''), doneReason: r.json?.done_reason ?? null };
}

// --- one case under one arm (G6) -----------------------------------------------------------------------------------
async function runCase({ systemPrompt, testCase, timeZone, arm, ltFirstAttempts }) {
  const start = performance.now();
  const attempts = [];
  let correction;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const elapsed = performance.now() - start;
    const body = buildRequestBody({ systemPrompt, testCase, timeZone, arm, correction });
    const r = await chat(body, RUN_WALL_MS - elapsed);
    const record = { attempt, latencyMs: r.latencyMs, error: r.error ?? null, content: r.content ?? null, doneReason: r.doneReason ?? null };
    attempts.push(record);
    if (attempt === 1 && arm === 'LT' && !r.error) ltFirstAttempts.push(r.latencyMs);
    if (r.error) {
      record.check = r.error === 'timeout' ? 'timeout' : 'provider-error';
      break;
    }
    const g = guardOutput(r.content, testCase);
    record.check = g.ok ? (g.empty ? 'empty' : 'pass') : g.check;
    if (g.ok) {
      return { attempts, latencyMs: Math.round(performance.now() - start), outcome: g.empty ? 'empty' : 'answer', reply: renderJudge(g.output, testCase, timeZone) };
    }
    if (attempt === 1 && !retryAllowed({ arm, elapsedMs: performance.now() - start, firstAttemptMs: ltFirstAttempts })) {
      record.retrySkipped = 'time-left-below-p95';
      break;
    }
    correction = CORRECTIONS[g.check];
  }
  return { attempts, latencyMs: Math.round(performance.now() - start), outcome: 'fallback', reply: renderFallback(testCase, timeZone) };
}

async function runG6(flags) {
  if (!flags['strict-approved']) refuse(['a G6 run is a Strict model-in-the-loop run: pass --strict-approved only with the owner\'s separate Strict yes']);
  const now = Date.now();
  const setPath = flags.set ?? DEFAULT_SET_PATH;
  const arms = (flags.arms ?? 'L0,LT').split(',');
  if (arms.length === 0 || arms.some((a) => !(a in ARMS)) || new Set(arms).size !== arms.length) refuse([`--arms must list L0 and/or LT, got ${flags.arms}`]);
  const { problems, entries } = verifyAll({ repo: REPO, mode: 'g6', setPath, now });
  if (problems.length) refuse(problems);
  const set = readJson(setPath);
  const setProblems = validateSet(set);
  if (setProblems.length) refuse(setProblems);
  const cov = coverage(set);
  if (cov.unmet.length) refuse(cov.unmet.map((u) => `coverage: ${u}`));
  const served = await checkServedDigest();
  if (served.length) refuse(served);

  const out = makeOutDir(flags.out ?? path.join(ARCHIVE, `g6-run-${stamp()}`));
  const log = logger(out);
  const hashLine = entries.map((e) => `${e.kind}:${e.path}=${e.sha256}`).join(' ');
  log(`G6 RUN START ${new Date(now).toISOString()} head=${head()} model=${MODEL}@${MODEL_MANIFEST_SHA256} seed=${SEED} arms=${arms.join(',')} ${hashLine}`);
  log(`coverage ${JSON.stringify(cov)}`);

  const systemPrompt = fs.readFileSync(path.join(REPO, PROMPT_PATH), 'utf8');
  const results = [];
  for (const arm of arms) {
    await unloadModel();
    const ltFirstAttempts = [];
    for (const [i, testCase] of set.cases.entries()) {
      const r = await runCase({ systemPrompt, testCase, timeZone: set.timezone, arm, ltFirstAttempts });
      results.push({ caseId: testCase.id, source: testCase.source, arm, cold: i === 0, ...r });
      log(`${arm} ${testCase.id} ${r.outcome} ${r.latencyMs}ms checks=${r.attempts.map((a) => a.check).join('>')}`);
    }
  }
  await unloadModel();

  const byId = new Map(set.cases.map((c) => [c.id, c]));
  const ordered = blindOrder(results);
  writeJson(out, 'sealed-outputs.json', { note: 'NOT for the owner or the eval judge before the owner labels are complete', results: ordered });
  writeJson(out, 'blind.json', {
    seed: SEED,
    rubric: readJson(RUBRIC_PATH).labels,
    note: 'One interleaved blind session of all arms. Label every entry useless / usable / good.',
    entries: ordered.map((r) => {
      const c = byId.get(r.caseId);
      return {
        blindId: r.blindId,
        caseId: c.id,
        source: c.source,
        lang: c.lang,
        ownerRequest: c.ownerRequest,
        select: c.select,
        ...(c.count !== undefined ? { count: c.count } : {}),
        items: renderListing(c, set.timezone),
        reply: r.reply,
      };
    }),
  });
  writeJson(out, 'labels.template.json', { labeller: 'owner', labels: Object.fromEntries(ordered.map((r) => [r.blindId, null])) });
  const stats = {};
  for (const arm of arms) {
    const rs = results.filter((r) => r.arm === arm);
    stats[arm] = {
      cases: rs.length,
      answers: rs.filter((r) => r.outcome === 'answer').length,
      empty: rs.filter((r) => r.outcome === 'empty').length,
      fallbacks: rs.filter((r) => r.outcome === 'fallback').length,
      firstAttemptPass: rs.filter((r) => ['pass', 'empty'].includes(r.attempts[0].check)).length,
      retried: rs.filter((r) => r.attempts.length > 1).length,
      latency: latencySummary(arm, rs),
    };
  }
  writeJson(out, 'stats.json', stats);
  log(`G6 RUN END ${new Date().toISOString()} out=${out}`);
}

async function runDry(flags) {
  if (!flags['strict-approved']) refuse(['the LT dry run calls the model: pass --strict-approved only with the owner\'s Strict yes']);
  const now = Date.now();
  const { problems, entries } = verifyAll({ repo: REPO, mode: 'dry-run', now });
  if (fileHasher(REPO)(TUNING_SET_PATH) !== TUNING_SET_SHA256) problems.push(`tuning set ${TUNING_SET_PATH} is not ${TUNING_SET_SHA256}`);
  if (problems.length) refuse(problems);
  const set = adaptTuningSet(readJson(TUNING_SET_PATH));
  const setProblems = validateSet(set);
  if (setProblems.length) refuse(setProblems);
  const served = await checkServedDigest();
  if (served.length) refuse(served);

  const out = makeOutDir(flags.out ?? path.join(ARCHIVE, `g6-lt-dryrun-${stamp()}`));
  const log = logger(out);
  log(`LT DRY RUN START ${new Date(now).toISOString()} head=${head()} model=${MODEL}@${MODEL_MANIFEST_SHA256} set=${TUNING_SET_PATH}@${TUNING_SET_SHA256} ${entries.map((e) => `${e.kind}:${e.path}=${e.sha256}`).join(' ')}`);
  const systemPrompt = fs.readFileSync(path.join(REPO, PROMPT_PATH), 'utf8');
  await unloadModel();
  const rows = [];
  for (const testCase of set.cases) {
    const body = buildRequestBody({ systemPrompt, testCase, timeZone: set.timezone, arm: 'LT' });
    const r = await chat(body, DRY_RUN_CALL_TIMEOUT_MS);
    const row = { caseId: testCase.id, latencyMs: r.latencyMs, error: r.error ?? null, content: r.content ?? null };
    if (!r.error) {
      let parsed;
      try {
        parsed = JSON.parse(r.content);
        row.schemaErrors = validateAgainstSchema(buildJudgeSchema({ select: testCase.select, count: testCase.count, n: testCase.items.length }), parsed);
      } catch {
        row.schemaErrors = ['not JSON'];
      }
      const g = guardOutput(r.content, testCase);
      row.guard = g.ok ? 'pass' : g.check;
    }
    rows.push(row);
    log(`LT ${testCase.id} ${r.latencyMs}ms ${row.error ?? (row.schemaErrors.length ? `SCHEMA-FAIL ${row.schemaErrors[0]}` : 'schema-ok')} guard=${row.guard ?? '-'}`);
  }
  await unloadModel();
  const completed = rows.filter((r) => !r.error);
  const schemaFails = completed.filter((r) => r.schemaErrors.length > 0);
  const verdict =
    completed.length === 0
      ? 'INCONCLUSIVE: no completed output'
      : schemaFails.length > 0
        ? `LT DROPPED: format not applied with think:true (${schemaFails.length}/${completed.length} outputs fail the request schema)`
        : `LT KEPT: format applied with think:true (${completed.length}/${completed.length} completed outputs match the request schema; ${rows.length - completed.length} timeouts/errors)`;
  writeJson(out, 'dryrun.json', { verdict, rows });
  log(`LT DRY RUN END ${new Date().toISOString()} ${verdict}`);
}

function runScore(flags) {
  if (!flags.out || !flags.labels) refuse(['score needs --out <run dir> and --labels <file>']);
  const sealed = JSON.parse(fs.readFileSync(path.join(flags.out, 'sealed-outputs.json'), 'utf8')).results;
  const labels = JSON.parse(fs.readFileSync(flags.labels, 'utf8')).labels ?? {};
  const missing = sealed.filter((r) => !labels[r.blindId]);
  if (missing.length) refuse([`${missing.length} outputs have no owner label (labels must be complete before scoring)`]);
  const arms = {};
  const report = {};
  for (const arm of [...new Set(sealed.map((r) => r.arm))]) {
    const rs = sealed.filter((r) => r.arm === arm);
    const bySource = usablePlus(rs.map((r) => ({ source: r.source, label: labels[r.blindId] })));
    const latency = latencySummary(arm, rs);
    arms[arm] = { meetsBar: latency.meetsBar, calendarShare: bySource.calendar?.share ?? 0 };
    report[arm] = { bySource, latency };
  }
  const result = { arms: report, ...decide(arms) };
  writeJson(flags.out, 'score.json', result);
  console.log(JSON.stringify(result, null, 1));
}

function runVerify(flags) {
  const setPath = flags.set ?? DEFAULT_SET_PATH;
  const { problems, entries } = verifyAll({ repo: REPO, mode: 'g6', setPath, now: Date.now() });
  if (fs.existsSync(path.join(REPO, setPath))) {
    const set = readJson(setPath);
    const setProblems = validateSet(set);
    problems.push(...setProblems);
    if (setProblems.length === 0) {
      const cov = coverage(set);
      console.log(`coverage ${JSON.stringify(cov)}`);
      problems.push(...cov.unmet.map((u) => `coverage: ${u}`));
    }
  } else {
    problems.push(`set file not found: ${setPath}`);
  }
  if (problems.length) refuse(problems);
  console.log(`G6 READY: ${entries.length} freeze entries verified (${entries.map((e) => e.kind).join(', ')})`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { mode, flags } = parseArgs(process.argv.slice(2));
  if (mode === 'g6') await runG6(flags);
  else if (mode === 'dry-run') await runDry(flags);
  else if (mode === 'score') runScore(flags);
  else if (mode === 'verify') runVerify(flags);
  else {
    console.error('usage: node tools/g6/run.mjs <verify|g6|dry-run|score> [flags]');
    process.exit(2);
  }
}

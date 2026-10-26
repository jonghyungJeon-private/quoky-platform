#!/usr/bin/env node
// G7 run script (ADR-0121 A3a measurement record, G7; A3b-D2..D5, D8). Plain ESM, no build.
//
// Usage:
//   node tools/g7/run.mjs verify [--set <repo path>] [--part1]
//       No model call, no Ollama call, no CLI call. Checks the committed g7-freeze addendum (hashes, payload block,
//       commit order), the G6 set, prompt, rubric and qwen3:8b manifest, the G6 run file and the G7 case file.
//       `--part1` checks part 1 only (before the case file exists). Exit 0 = ready, 3 = refused.
//   node tools/g7/run.mjs g7 --strict-approved [--set <path>] [--out <dir>]
//       THE G7 RUN (Strict, model-in-the-loop; the flag records the owner's separate yes). Per case: the A3b payload
//       (deterministic stage, then one batched local classifier call), then arm B (the recipient given only the
//       payload; 1 + 1 retry). Arm A comes from the sealed G6 L0 outputs, re-rendered and checked. Writes the blind
//       A/B session. Arm C is NOT run here.
//   node tools/g7/run.mjs lock --out <run dir> --labels <owner A/B labels file>
//       Locks the complete A/B labels and preferences (ab-lock.json plus a read-only copy). No model call.
//   node tools/g7/run.mjs arm-c --strict-approved --out <run dir>
//       Arm C (reference; the recipient with full items), only after the lock. Strict. Writes its own blind session.
//   node tools/g7/run.mjs score --out <run dir> [--labels-c <file>]
//       The G7 rule from the locked A/B labels; arm C reported only when its labels are complete. No model call.
//
// Outputs (the out dir must not exist; default under ~/Library/Application Support/Quoky/eval-archive/):
//   run.log                 first line = start time, HEAD, seed, recipient and every verified freeze entry
//   payloads.json           per case: the exact list sent (or why nothing was sent), withheld titles and drop codes
//   sealed-outputs.json     arm, attempts, raw output, latency; NOT for the owner before the A/B labels are locked
//   blind.json              the owner's A/B session: entries (interleaved) and pairs (one per case)
//   labels.template.json    { labels: { <blindId>: null }, preferences: { <pairId>: null } }
//   stats.json              arm B outcomes, no-offer reasons, classifier outcomes, latency (no quality numbers)
// The eval judge may pre-screen only (review queue); never a gate label, never counted, never shown before the
// owner's labels are complete.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fileHasher, modelManifestPath, readCommittedDecisions, realGit, sha256, MODEL_MANIFEST_SHA256 } from '../g6/freeze.mjs';
import { CORRECTIONS, guardOutput } from '../g6/guards.mjs';
import { renderFallback, renderListing } from '../g6/render.mjs';
import { validateSet } from '../g6/cases.mjs';
import { median, p95 } from '../g6/score.mjs';
import { G6_DECISION, LABELS, blindOrder, checkAbLabels, decideG7, pairs, renderArmB, rerenderArmA, seedMatchesRunDate } from './blind.mjs';
import { DEFAULT_G7_SET_PATH, G6_SET_PATH, g7Cases, validateG7File } from './cases.mjs';
import { CLASSIFIER_MODEL, CLASSIFIER_TIMEOUT_MS, buildClassifierBody, checkKeep, titlesToSend } from './classify.mjs';
import { CLAUDE_BIN, CLAUDE_TIMEOUT_MS, buildArmBInput, buildArmCInput, claudeArgv, claudeEnv, normalizeOutput, withCorrection } from './claude.mjs';
import { CLASSIFIER_PATH, G6_PROMPT_PATH, G6_RUN_SEALED, PROMPT_PATH, checkG7CommitOrder, checkG7Freeze, checkModelManifest, parseG7Entries, payloadBlock } from './freeze.mjs';
import { PAYLOAD_VERSION, finishPayload, prepareOwnerWords, prepareTitles } from './payload.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARCHIVE = path.join(os.homedir(), 'Library/Application Support/Quoky/eval-archive');
const OLLAMA_BASE = 'http://127.0.0.1:11434';
const EXIT_REFUSED = 3;
const STDOUT_CAP = 262_144;

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === 'strict-approved' || k === 'part1') flags[k] = true;
    else {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
      flags[k] = v;
      i += 1;
    }
  }
  return { mode, flags };
}

function refuse(problems) {
  console.error('G7 HARNESS REFUSED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(EXIT_REFUSED);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (dir, name, value) => fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 1)}\n`);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');

function head() {
  const r = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim() || 'unknown';
}

function makeOutDir(dir) {
  if (fs.existsSync(dir)) refuse([`out dir already exists (a run is never overwritten): ${dir}`]);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logger(dir) {
  const file = path.join(dir, 'run.log');
  return (line) => {
    fs.appendFileSync(file, `${line}\n`);
    console.log(line);
  };
}

function archiveHashOf(rel) {
  try {
    return sha256(fs.readFileSync(path.join(ARCHIVE, rel)));
  } catch {
    return null;
  }
}

/** The whole start-up check. Returns { problems, entries, seed, recipient, g6Set, g7File }. */
function verifyAll({ mode, setPath, now }) {
  const problems = [];
  let decisions;
  let entries = [];
  try {
    decisions = readCommittedDecisions(REPO);
    entries = parseG7Entries(decisions);
  } catch (err) {
    return { problems: [String(err.message ?? err)], entries };
  }
  const block = payloadBlock(decisions);
  const hashOf = fileHasher(REPO);
  problems.push(...checkG7Freeze({ entries, mode, setPath, hashOf, archiveHashOf, payloadSha: block === null ? null : sha256(Buffer.from(block, 'utf8')) }));
  problems.push(...checkG7CommitOrder({ entries, mode, git: realGit(REPO), now, setPath }));
  let manifest = null;
  try {
    manifest = fs.readFileSync(modelManifestPath());
  } catch {
    manifest = null;
  }
  problems.push(...checkModelManifest(manifest));
  const g6Set = readJson(path.join(REPO, G6_SET_PATH));
  problems.push(...validateSet(g6Set).map((p) => `G6 set: ${p}`));
  let g7File = null;
  if (mode === 'g7') {
    const file = path.join(REPO, setPath);
    if (!fs.existsSync(file)) problems.push(`G7 file not found: ${setPath}`);
    else {
      g7File = readJson(file);
      problems.push(...validateG7File(g7File, g6Set).map((p) => `G7 file: ${p}`));
    }
  }
  const seed = entries.find((e) => e.kind === 'seed')?.value ?? null;
  const recipient = entries.find((e) => e.kind === 'recipient') ?? null;
  if (mode === 'g7' && seed && !seedMatchesRunDate(seed, now, g6Set.timezone)) {
    problems.push(`seed ${seed} is not quoky-g7- plus the run date (${g6Set.timezone})`);
  }
  return { problems, entries, seed, recipient, g6Set, g7File };
}

// --- processes (only in g7 / arm-c) ----------------------------------------------------------------------------------
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

async function checkServedDigest() {
  const tags = await ollama('/api/tags', undefined, 10_000);
  if (tags.error) return [`ollama /api/tags failed: ${tags.error}`];
  const entry = (tags.json.models ?? []).find((m) => m.name === CLASSIFIER_MODEL || m.model === CLASSIFIER_MODEL);
  if (!entry) return [`${CLASSIFIER_MODEL} is not served by the loopback Ollama`];
  if (entry.digest !== MODEL_MANIFEST_SHA256) return [`served ${CLASSIFIER_MODEL} digest ${entry.digest} is not ${MODEL_MANIFEST_SHA256}`];
  return [];
}

function claudeVersion() {
  const r = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', cwd: os.tmpdir(), env: claudeEnv(process.env), timeout: 10_000 });
  return r.status === 0 ? (r.stdout ?? '').trim().split(/\s+/u)[0] : null;
}

/** One `claude -p` call: stdin prompt, neutral cwd, allow-listed env, timeout. */
function runClaude({ model, input, timeoutMs = CLAUDE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(CLAUDE_BIN, claudeArgv(model), { cwd: os.tmpdir(), env: claudeEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (stdout.length < STDOUT_CAP) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderrBytes += d.length;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ latencyMs: Math.round(performance.now() - t0), error: `spawn: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - t0);
      if (timedOut) resolve({ latencyMs, error: 'timeout' });
      else if (code !== 0) resolve({ latencyMs, error: `exit ${code}`, stderrBytes });
      else resolve({ latencyMs, stdout });
    });
    child.stdin.end(input);
  });
}

/** One judgment call with 1 + 1 retry (A3b-D8); guards = G6 guardOutput on the normalized output. */
async function judgeWithRetry({ model, input, testCase }) {
  const start = performance.now();
  const attempts = [];
  let current = input;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await runClaude({ model, input: current });
    const rec = { attempt, latencyMs: r.latencyMs, error: r.error ?? null, content: r.stdout === undefined ? null : normalizeOutput(r.stdout) };
    attempts.push(rec);
    if (r.error) {
      rec.check = r.error === 'timeout' ? 'timeout' : 'provider-error';
      continue; // A3b-D8: 1 + 1; a provider failure also uses the retry
    }
    const g = guardOutput(rec.content, testCase);
    rec.check = g.ok ? (g.empty ? 'empty' : 'pass') : g.check;
    if (g.ok) return { attempts, latencyMs: Math.round(performance.now() - start), guarded: g };
    current = withCorrection(input, CORRECTIONS[g.check]);
  }
  return { attempts, latencyMs: Math.round(performance.now() - start), guarded: null };
}

async function classify({ systemPrompt, sent }) {
  if (sent.length === 0) return { keep: [], call: null };
  const t0 = performance.now();
  const r = await ollama('/api/chat', buildClassifierBody({ systemPrompt, sent }), CLASSIFIER_TIMEOUT_MS);
  const latencyMs = Math.round(performance.now() - t0);
  if (r.error) return { keep: null, call: { latencyMs, error: r.error, content: null } };
  const content = String(r.json?.message?.content ?? '');
  const keep = checkKeep(content, sent);
  return { keep, call: { latencyMs, error: keep ? null : 'invalid', content } };
}

// --- modes ---------------------------------------------------------------------------------------------------------
async function runG7(flags) {
  if (!flags['strict-approved']) refuse(["a G7 run is a Strict model-in-the-loop run: pass --strict-approved only with the owner's separate Strict yes"]);
  const now = Date.now();
  const setPath = flags.set ?? DEFAULT_G7_SET_PATH;
  const v = verifyAll({ mode: 'g7', setPath, now });
  if (v.problems.length) refuse(v.problems);
  const { g6Set, g7File, seed, recipient, entries } = v;
  const tz = g6Set.timezone;
  const served = await checkServedDigest();
  if (served.length) refuse(served);
  const cli = claudeVersion();
  if (cli !== recipient.cli) refuse([`claude --version is ${cli}, the addendum recorded ${recipient.cli}`]);

  const cases = g7Cases(g6Set);
  const sealedG6 = readJson(path.join(ARCHIVE, G6_RUN_SEALED)).results;
  const armA = [];
  try {
    for (const c of cases) {
      const s = sealedG6.find((r) => r.caseId === c.id && r.arm === 'L0');
      if (!s) throw new Error(`no G6 L0 result for ${c.id}`);
      armA.push({ caseId: c.id, arm: 'A', ...rerenderArmA(s, c, tz), latencyMs: s.latencyMs });
    }
  } catch (err) {
    refuse([String(err.message ?? err)]);
  }

  const out = makeOutDir(flags.out ?? path.join(ARCHIVE, `g7-run-${stamp()}`));
  const log = logger(out);
  log(`G7 RUN START ${new Date(now).toISOString()} head=${head()} payload=${PAYLOAD_VERSION} seed=${seed} recipient=claude-cli model=${recipient.model} cli=${cli} classifier=${CLASSIFIER_MODEL}@${MODEL_MANIFEST_SHA256} ${entries.map((e) => e.line.replace(/\s+/gu, ':')).join(' ')}`);
  const instruction = fs.readFileSync(path.join(REPO, PROMPT_PATH), 'utf8');
  const classifierPrompt = fs.readFileSync(path.join(REPO, CLASSIFIER_PATH), 'utf8');

  const payloads = [];
  const armB = [];
  for (const c of cases) {
    const prepared = prepareTitles(c, tz, g7File.ownerNames);
    const sent = titlesToSend(prepared);
    const cls = await classify({ systemPrompt: classifierPrompt, sent });
    const payload = finishPayload({ testCase: c, timeZone: tz, prepared, sent: sent.map((t) => t.p), keep: cls.keep });
    const words = prepareOwnerWords(c.ownerRequest);
    const offer = payload.offer && words.ok;
    const reason = !payload.offer ? payload.reason : !words.ok ? words.reason : null;
    const record = {
      caseId: c.id,
      offer,
      reason,
      perm: prepared.perm,
      list: payload.offer ? payload.list : null,
      withheld: payload.withheld,
      titleOutcomes: payload.titles.map((t) => ({ p: t.p, withheld: t.withheld })),
      drops: prepared.titles.map((t) => t.drops),
      classifier: cls.call ? { latencyMs: cls.call.latencyMs, error: cls.call.error } : null,
    };
    let result;
    if (offer) {
      const input = buildArmBInput({ instruction, testCase: c, ownerWords: words.text, list: payload.list });
      record.inputSha256 = sha256(Buffer.from(input, 'utf8'));
      const r = await judgeWithRetry({ model: recipient.model, input, testCase: c });
      const reply = r.guarded ? renderArmB(r.guarded, prepared.perm, c, tz) : renderFallback(c, tz);
      result = { outcome: r.guarded ? (r.guarded.empty ? 'empty' : 'answer') : 'fallback', reply, attempts: r.attempts, latencyMs: r.latencyMs };
    } else {
      result = { outcome: 'no-offer', reply: renderFallback(c, tz), attempts: [], latencyMs: 0 };
    }
    payloads.push(record);
    armB.push({ caseId: c.id, arm: 'B', ...result });
    log(`B ${c.id} ${offer ? 'offer' : `no-offer(${reason})`} withheld=${payload.withheld}/${c.items.length} classifier=${cls.call ? cls.call.error ?? 'ok' : 'none'} ${result.outcome} ${result.latencyMs}ms checks=${result.attempts.map((a) => a.check).join('>') || '-'}`);
  }
  await ollama('/api/generate', { model: CLASSIFIER_MODEL, keep_alive: 0 }, 30_000);

  const byId = new Map(cases.map((c) => [c.id, c]));
  const ordered = blindOrder([...armA, ...armB], seed);
  const pairList = pairs(ordered, seed);
  writeJson(out, 'payloads.json', { note: 'NOT for the owner before the A/B labels are locked', payloadVersion: PAYLOAD_VERSION, payloads });
  writeJson(out, 'sealed-outputs.json', { note: 'NOT for the owner or the eval judge before the A/B labels are locked', results: ordered });
  writeJson(out, 'blind.json', {
    seed,
    rubric: readJson(path.join(REPO, 'packages/core/src/application/golden/a2/g4-rubric.v1.json')).labels,
    note: 'One interleaved blind session of arms A and B. Label every entry useless / usable / good; then, per pair, which reply is better (first / second / tie).',
    entries: ordered.map((r) => {
      const c = byId.get(r.caseId);
      return { blindId: r.blindId, caseId: c.id, lang: c.lang, ownerRequest: c.ownerRequest, select: c.select, ...(c.count !== undefined ? { count: c.count } : {}), items: renderListing(c, tz), reply: r.reply };
    }),
    pairs: pairList,
  });
  writeJson(out, 'labels.template.json', {
    labeller: 'owner',
    labels: Object.fromEntries(ordered.map((r) => [r.blindId, null])),
    preferences: Object.fromEntries(pairList.map((p) => [p.pairId, null])),
  });
  const offered = armB.filter((r) => r.outcome !== 'no-offer');
  const noOffer = {};
  for (const p of payloads.filter((x) => !x.offer)) noOffer[p.reason] = (noOffer[p.reason] ?? 0) + 1;
  writeJson(out, 'stats.json', {
    cases: cases.length,
    armB: {
      offers: offered.length,
      noOffer,
      answers: armB.filter((r) => r.outcome === 'answer').length,
      empty: armB.filter((r) => r.outcome === 'empty').length,
      fallbacks: armB.filter((r) => r.outcome === 'fallback').length,
      retried: offered.filter((r) => r.attempts.length > 1).length,
      latencyMs: { median: median(offered.map((r) => r.latencyMs)), p95: p95(offered.map((r) => r.latencyMs)) },
      titlesWithheld: payloads.reduce((s, p) => s + p.withheld, 0),
      titlesTotal: cases.reduce((s, c) => s + c.items.length, 0),
      classifierFailures: payloads.filter((p) => p.classifier && p.classifier.error).length,
    },
    armA: { source: G6_RUN_SEALED, answers: armA.filter((r) => r.outcome === 'answer').length, fallbacks: armA.filter((r) => r.outcome === 'fallback').length },
  });
  log(`G7 RUN END ${new Date().toISOString()} out=${out}`);
}

function lock(flags) {
  if (!flags.out || !flags.labels) refuse(['lock needs --out <run dir> and --labels <file>']);
  const lockFile = path.join(flags.out, 'ab-lock.json');
  if (fs.existsSync(lockFile)) refuse(['the A/B labels are already locked']);
  const sealed = readJson(path.join(flags.out, 'sealed-outputs.json')).results;
  const pairList = readJson(path.join(flags.out, 'blind.json')).pairs;
  const bytes = fs.readFileSync(flags.labels);
  const problems = checkAbLabels(JSON.parse(bytes.toString('utf8')), sealed, pairList);
  if (problems.length) refuse(problems);
  const copy = path.join(flags.out, 'ab-labels.locked.json');
  fs.writeFileSync(copy, bytes);
  fs.chmodSync(copy, 0o444);
  writeJson(flags.out, 'ab-lock.json', { lockedAt: new Date().toISOString(), labelsSha256: sha256(bytes), file: 'ab-labels.locked.json' });
  console.log(`A/B labels locked (${sha256(bytes)})`);
}

function readLock(out) {
  const lockFile = path.join(out, 'ab-lock.json');
  if (!fs.existsSync(lockFile)) refuse(['the A/B labels are not locked (run `lock` first)']);
  const l = readJson(lockFile);
  const bytes = fs.readFileSync(path.join(out, l.file));
  if (sha256(bytes) !== l.labelsSha256) refuse(['the locked A/B labels changed after the lock']);
  return JSON.parse(bytes.toString('utf8'));
}

async function runArmC(flags) {
  if (!flags['strict-approved']) refuse(["arm C calls the recipient: pass --strict-approved only with the owner's Strict yes"]);
  if (!flags.out) refuse(['arm-c needs --out <run dir>']);
  readLock(flags.out);
  if (fs.existsSync(path.join(flags.out, 'sealed-arm-c.json'))) refuse(['arm C already ran for this run']);
  const now = Date.now();
  const v = verifyAll({ mode: 'part1', now });
  if (v.problems.length) refuse(v.problems);
  const first = fs.readFileSync(path.join(flags.out, 'run.log'), 'utf8').split('\n')[0];
  const seed = /seed=(\S+)/u.exec(first)?.[1];
  const model = /recipient=claude-cli model=(\S+)/u.exec(first)?.[1];
  const cli = /cli=(\S+)/u.exec(first)?.[1];
  if (!seed || !model) refuse(['cannot read the seed and recipient from run.log']);
  if (claudeVersion() !== cli) refuse([`claude --version differs from the A/B run (${cli})`]);
  const tz = v.g6Set.timezone;
  const g6Prompt = fs.readFileSync(path.join(REPO, G6_PROMPT_PATH), 'utf8');
  const log = logger(flags.out);
  log(`G7 ARM C START ${new Date(now).toISOString()} head=${head()} model=${model}`);
  const results = [];
  for (const c of g7Cases(v.g6Set)) {
    const r = await judgeWithRetry({ model, input: buildArmCInput({ g6Prompt, testCase: c, timeZone: tz }), testCase: c });
    const reply = r.guarded ? renderArmB(r.guarded, c.items.map((_, i) => i), c, tz) : renderFallback(c, tz);
    results.push({ caseId: c.id, arm: 'C', outcome: r.guarded ? (r.guarded.empty ? 'empty' : 'answer') : 'fallback', reply, attempts: r.attempts, latencyMs: r.latencyMs });
    log(`C ${c.id} ${results.at(-1).outcome} ${r.latencyMs}ms checks=${r.attempts.map((a) => a.check).join('>')}`);
  }
  const ordered = blindOrder(results, seed);
  writeJson(flags.out, 'sealed-arm-c.json', { results: ordered });
  const byId = new Map(g7Cases(v.g6Set).map((c) => [c.id, c]));
  writeJson(flags.out, 'blind-c.json', {
    seed,
    note: 'Arm C session (reference; reported only). Label every entry useless / usable / good.',
    entries: ordered.map((r) => ({ blindId: r.blindId, caseId: r.caseId, ownerRequest: byId.get(r.caseId).ownerRequest, items: renderListing(byId.get(r.caseId), tz), reply: r.reply })),
  });
  writeJson(flags.out, 'labels-c.template.json', { labeller: 'owner', labels: Object.fromEntries(ordered.map((r) => [r.blindId, null])) });
  log(`G7 ARM C END ${new Date().toISOString()}`);
}

function score(flags) {
  if (!flags.out) refuse(['score needs --out <run dir>']);
  const labelsFile = readLock(flags.out);
  const sealed = readJson(path.join(flags.out, 'sealed-outputs.json')).results;
  const pairList = readJson(path.join(flags.out, 'blind.json')).pairs;
  const problems = checkAbLabels(labelsFile, sealed, pairList);
  if (problems.length) refuse(problems);
  const result = decideG7({ sealed, pairList, labelsFile, g6Decision: G6_DECISION });
  if (flags['labels-c']) {
    const c = readJson(path.join(flags.out, 'sealed-arm-c.json')).results;
    const labels = readJson(flags['labels-c']).labels ?? {};
    const missing = c.filter((r) => !LABELS.includes(labels[r.blindId]));
    if (missing.length) refuse([`${missing.length} arm C outputs have no valid label`]);
    const u = c.filter((r) => labels[r.blindId] !== 'useless').length;
    result.armC = { usablePlus: u, total: c.length, share: u / c.length, reportedOnly: true };
  }
  writeJson(flags.out, 'score.json', result);
  console.log(JSON.stringify(result, null, 1));
}

function verify(flags) {
  const setPath = flags.set ?? DEFAULT_G7_SET_PATH;
  const mode = flags.part1 ? 'part1' : 'g7';
  const v = verifyAll({ mode, setPath, now: Date.now() });
  if (v.problems.length) refuse(v.problems);
  console.log(`G7 ${mode === 'g7' ? 'READY' : 'PART 1 OK'}: ${v.entries.length} freeze entries verified; ${g7Cases(v.g6Set).length} calendar cases`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { mode, flags } = parseArgs(process.argv.slice(2));
  if (mode === 'verify') verify(flags);
  else if (mode === 'g7') await runG7(flags);
  else if (mode === 'lock') lock(flags);
  else if (mode === 'arm-c') await runArmC(flags);
  else if (mode === 'score') score(flags);
  else {
    console.error('usage: node tools/g7/run.mjs <verify|g7|lock|arm-c|score> [flags]');
    process.exit(2);
  }
}


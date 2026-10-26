// G6 harness: the fail-closed freeze check (DECISIONS.md "ADR-0121 A3a measurement record", addendum conditions 1–4).
//
// The hash-only addendum in DECISIONS.md carries fenced blocks with the info string `g6-freeze`, one entry per line:
//
//   prompt  <repo-relative path>  <sha256>
//   harness <repo-relative path>  <sha256>
//   set     <repo-relative path>  <sha256>
//
// Part 1 (prompt + harness) and part 2 (set) are separate blocks in separate commits. The harness reads DECISIONS.md
// from the committed HEAD (never the working tree) and refuses to run on any of:
//   - a missing, duplicate or malformed entry; a harness entry list that is not exactly HARNESS_FILES;
//   - any file whose current sha256 differs from its entry (prompt, every harness file, the set);
//   - (G6 run) no set entry, or a set path other than the one being run;
//   - (G6 run) commit order: the prompt and harness hashes not committed strictly before the set hash, the set hash
//     not in a hash-only commit (DECISIONS.md only), or the set file present in the prompt-hash commit's tree;
//   - the rubric hash or the model digest differing from the record.
// Pure functions take their inputs; `realGit` and `readCommittedDecisions` are the only process calls (git only).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DECISIONS_PATH = 'DECISIONS.md';
export const PROMPT_PATH = 'tools/g6/prompts/answer-judge-local.v1.txt';
export const HARNESS_FILES = [
  'tools/g6/run.mjs',
  'tools/g6/facts.mjs',
  'tools/g6/render.mjs',
  'tools/g6/schema.mjs',
  'tools/g6/guards.mjs',
  'tools/g6/request.mjs',
  'tools/g6/cases.mjs',
  'tools/g6/score.mjs',
  'tools/g6/freeze.mjs',
];
export const DEFAULT_SET_PATH = 'packages/core/src/application/golden/a2/local-judgment-heldout.v2.json';
export const TUNING_SET_PATH = 'packages/core/src/application/golden/a2/local-judgment-cases.v1.json';
export const RUBRIC_PATH = 'packages/core/src/application/golden/a2/g4-rubric.v1.json';
export const RUBRIC_SHA256 = 'baee67a34fee27a42a5e0f19fcb267f1f6e0e25f95b4eaceedfedeb2e3bec87f';
export const MODEL_MANIFEST_SHA256 = '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41';
export const MODEL_LAYER_DIGEST = 'sha256:a3de86cd1c132c822487ededd47a324c50491393e6565cd14bafa40d0b8e686f';

const ENTRY = /^(prompt|harness|set)\s+(\S+)\s+([0-9a-f]{64})$/;
const BLOCK = /^```g6-freeze[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every entry of every `g6-freeze` block. Throws on a malformed line (fail closed). */
export function parseFreezeEntries(decisionsText) {
  const entries = [];
  for (const block of decisionsText.matchAll(BLOCK)) {
    for (const rawLine of block[1].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = ENTRY.exec(line);
      if (!m) throw new Error(`malformed g6-freeze line: ${line}`);
      entries.push({ kind: m[1], path: m[2], sha256: m[3] });
    }
  }
  return entries;
}

/**
 * Checks the entries against the files. `hashOf(path)` returns the current sha256 of a repo-relative path, or null
 * when the file is missing. `mode` is 'g6' (held-out run) or 'dry-run' (tuning set; no set entry needed).
 * Returns a list of problems (empty = the freeze holds).
 */
export function checkFreeze({ entries, mode, setPath, hashOf }) {
  const problems = [];
  const prompts = entries.filter((e) => e.kind === 'prompt');
  const harness = entries.filter((e) => e.kind === 'harness');
  const sets = entries.filter((e) => e.kind === 'set');
  if (prompts.length !== 1) problems.push(`expected exactly one prompt entry, found ${prompts.length}`);
  else if (prompts[0].path !== PROMPT_PATH) problems.push(`prompt entry path ${prompts[0].path} is not ${PROMPT_PATH}`);
  const harnessPaths = harness.map((e) => e.path);
  for (const p of HARNESS_FILES) if (!harnessPaths.includes(p)) problems.push(`no harness entry for ${p}`);
  for (const p of harnessPaths) if (!HARNESS_FILES.includes(p)) problems.push(`unexpected harness entry ${p}`);
  const dupes = harnessPaths.filter((p, i) => harnessPaths.indexOf(p) !== i);
  if (dupes.length > 0) problems.push(`duplicate harness entries: ${[...new Set(dupes)].join(', ')}`);
  if (mode === 'g6') {
    if (sets.length !== 1) problems.push(`expected exactly one set entry, found ${sets.length}`);
    else if (sets[0].path !== setPath) problems.push(`set entry path ${sets[0].path} is not the set being run (${setPath})`);
  } else if (mode !== 'dry-run') {
    problems.push(`unknown mode ${mode}`);
  }
  const toCheck = [...prompts, ...harness, ...(mode === 'g6' ? sets : [])];
  for (const e of toCheck) {
    const actual = hashOf(e.path);
    if (actual === null) problems.push(`${e.kind} file missing: ${e.path}`);
    else if (actual !== e.sha256) problems.push(`${e.kind} hash mismatch: ${e.path} is ${actual}, addendum has ${e.sha256}`);
  }
  return problems;
}

/**
 * The commit-order conditions (addendum conditions 1–2) for a G6 run. `git` provides:
 *   firstCommitAdding(sha) → { commit, time } | null   (oldest HEAD-history commit whose DECISIONS.md diff adds it)
 *   isAncestor(a, b) → boolean                          (a is an ancestor of b, a !== b)
 *   changedFiles(commit) → string[]
 *   existsInCommit(commit, path) → boolean
 * `now` is the run start (ms). Returns a list of problems.
 */
export function checkCommitOrder({ entries, mode, git, now }) {
  const problems = [];
  const frozen = entries.filter((e) => e.kind === 'prompt' || e.kind === 'harness');
  const firsts = new Map();
  for (const e of frozen) {
    const first = git.firstCommitAdding(e.sha256);
    if (!first) problems.push(`${e.kind} hash of ${e.path} is not in any committed DECISIONS.md`);
    else firsts.set(e, first);
  }
  if (mode !== 'g6') return problems;
  const set = entries.find((e) => e.kind === 'set');
  if (!set) return problems; // checkFreeze reports the missing set entry
  const setFirst = git.firstCommitAdding(set.sha256);
  if (!setFirst) return [...problems, 'set hash is not in any committed DECISIONS.md'];
  for (const [e, first] of firsts) {
    if (first.commit === setFirst.commit) problems.push(`${e.kind} hash of ${e.path} was committed together with the set hash`);
    else if (!git.isAncestor(first.commit, setFirst.commit)) problems.push(`${e.kind} hash of ${e.path} was not committed before the set hash`);
  }
  const changed = git.changedFiles(setFirst.commit);
  if (changed.length !== 1 || changed[0] !== DECISIONS_PATH) {
    problems.push(`the set-hash commit ${setFirst.commit} is not hash-only (changes: ${changed.join(', ')})`);
  }
  const prompt = entries.find((e) => e.kind === 'prompt');
  const promptFirst = prompt ? firsts.get(prompt) : undefined;
  if (promptFirst && git.existsInCommit(promptFirst.commit, set.path)) {
    problems.push(`the set file ${set.path} already existed in the prompt-hash commit ${promptFirst.commit}`);
  }
  if (!(setFirst.time < now)) problems.push('the set-hash commit is not dated before the run start');
  return problems;
}

/** Checks the local Ollama manifest file of qwen3:8b against the recorded digests. Returns problems. */
export function checkModelManifest(manifestBytes) {
  if (manifestBytes === null) return ['qwen3:8b manifest file not found'];
  const problems = [];
  const digest = sha256(manifestBytes);
  if (digest !== MODEL_MANIFEST_SHA256) problems.push(`qwen3:8b manifest sha256 ${digest} is not ${MODEL_MANIFEST_SHA256}`);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return [...problems, 'qwen3:8b manifest is not JSON'];
  }
  const model = (manifest.layers ?? []).filter((l) => l.mediaType === 'application/vnd.ollama.image.model');
  if (model.length !== 1 || model[0].digest !== MODEL_LAYER_DIGEST) problems.push(`qwen3:8b model layer is not ${MODEL_LAYER_DIGEST}`);
  return problems;
}

export function modelManifestPath(env = process.env) {
  const root = env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama/models');
  return path.join(root, 'manifests/registry.ollama.ai/library/qwen3/8b');
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export function fileHasher(repo) {
  return (rel) => {
    const bytes = readOrNull(path.join(repo, rel));
    return bytes === null ? null : sha256(bytes);
  };
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

export function readCommittedDecisions(repo) {
  const r = spawnSync('git', ['-C', repo, 'show', `HEAD:${DECISIONS_PATH}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('cannot read the committed DECISIONS.md');
  return r.stdout;
}

export function realGit(repo) {
  return {
    firstCommitAdding(sha) {
      const r = git(repo, ['log', '--reverse', '--format=%H %ct', `-S${sha}`, 'HEAD', '--', DECISIONS_PATH]);
      const line = r.ok ? r.out.split('\n')[0] : '';
      if (!line) return null;
      const [commit, ct] = line.split(' ');
      return { commit, time: Number(ct) * 1000 };
    },
    isAncestor(a, b) {
      return a !== b && spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b]).status === 0;
    },
    changedFiles(commit) {
      const r = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commit]);
      return r.ok ? r.out.split('\n').filter(Boolean) : [];
    },
    existsInCommit(commit, rel) {
      return spawnSync('git', ['-C', repo, 'cat-file', '-e', `${commit}:${rel}`]).status === 0;
    },
  };
}

/**
 * The whole start-up check. Returns { problems, entries }. A run proceeds only when `problems` is empty.
 * For 'dry-run', the tuning set's recorded hash is checked instead of a set entry.
 */
export function verifyAll({ repo, mode, setPath, now, gitImpl = realGit(repo), manifestBytes, decisionsText }) {
  const problems = [];
  let entries = [];
  try {
    entries = parseFreezeEntries(decisionsText ?? readCommittedDecisions(repo));
  } catch (err) {
    return { problems: [String(err.message ?? err)], entries };
  }
  const hashOf = fileHasher(repo);
  problems.push(...checkFreeze({ entries, mode, setPath, hashOf }));
  problems.push(...checkCommitOrder({ entries, mode, git: gitImpl, now }));
  const rubric = hashOf(RUBRIC_PATH);
  if (rubric !== RUBRIC_SHA256) problems.push(`rubric ${RUBRIC_PATH} sha256 ${rubric} is not ${RUBRIC_SHA256}`);
  problems.push(...checkModelManifest(manifestBytes === undefined ? readOrNull(modelManifestPath()) : manifestBytes));
  return { problems, entries };
}

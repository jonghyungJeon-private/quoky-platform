// G7 harness: the fail-closed freeze check (DECISIONS.md "ADR-0121 A3a measurement record", G7: "Case hash, prompt
// hashes, model digest and recipient model version, rubric and seed are recorded before the run"; "a different
// payload invalidates the run").
//
// DECISIONS.md carries fenced blocks with the info string `g7-freeze`, one entry per line:
//
//   Part 1 (hash-only, before the case file exists):
//     prompt      tools/g7/prompts/answer-list.v1.txt  <sha256>     arm B instruction
//     classifier  tools/g7/prompts/topic-list.v1.txt   <sha256>     A3b-D5 classifier prompt
//     payload     DECISIONS.md#g7-payload              <sha256>     the payload definition block (its body)
//     g6run       g6-run-20261026T035948/sealed-outputs.json <sha256>  arm A source, under the eval archive
//     harness     <repo path>                          <sha256>     every file of HARNESS_FILES, exactly
//   Part 2 (hash-only commits on DECISIONS.md only, after part 1, before the run):
//     set         <repo path of the G7 file>           <sha256>
//     seed        quoky-g7-<YYYYMMDD of the run date>
//     recipient   claude-cli model=<--model value> cli=<`claude --version` output, first token>
//
// The payload definition is the body of the one fenced block with the info string `g7-payload` in the committed
// DECISIONS.md (the text between the fence lines, with its final newline). The harness reads DECISIONS.md from the
// committed HEAD (never the working tree) and refuses to run on any missing, duplicate or malformed entry, any hash
// mismatch, a payload block that is missing, duplicated or changed, a part-2 entry committed with or before a part-1
// entry or in a commit that changes anything but DECISIONS.md, the case file present in the prompt-hash commit's tree,
// a part-2 commit not dated before the run start, a seed whose date is not the run date, the rubric or the qwen3:8b
// manifest differing from the G6 record, or the G6 set differing from its frozen hash.

import { DECISIONS_PATH, RUBRIC_PATH, RUBRIC_SHA256, checkModelManifest } from '../g6/freeze.mjs';
import { G6_SET_PATH, G6_SET_SHA256 } from './cases.mjs';

export const PROMPT_PATH = 'tools/g7/prompts/answer-list.v1.txt';
export const CLASSIFIER_PATH = 'tools/g7/prompts/topic-list.v1.txt';
export const G6_PROMPT_PATH = 'tools/g6/prompts/answer-judge-local.v1.txt';
export const G6_PROMPT_SHA256 = '9b43479a55ca367d8ebcbf6c05031730e36fb493e12585e0afa2af0f21236d85';
export const PAYLOAD_REF = 'DECISIONS.md#g7-payload';
export const G6_RUN_SEALED = 'g6-run-20261026T035948/sealed-outputs.json';
export const HARNESS_FILES = [
  'tools/g7/run.mjs',
  'tools/g7/payload.mjs',
  'tools/g7/classify.mjs',
  'tools/g7/claude.mjs',
  'tools/g7/cases.mjs',
  'tools/g7/blind.mjs',
  'tools/g7/freeze.mjs',
  // the frozen G6 modules the G7 harness imports (directly or through each other)
  'tools/g6/facts.mjs',
  'tools/g6/render.mjs',
  'tools/g6/guards.mjs',
  'tools/g6/schema.mjs',
  'tools/g6/request.mjs',
  'tools/g6/cases.mjs',
  'tools/g6/score.mjs',
  'tools/g6/freeze.mjs',
];
export const PART1_KINDS = ['prompt', 'classifier', 'payload', 'g6run', 'harness'];
export const PART2_KINDS = ['set', 'seed', 'recipient'];

const HASHED = /^(prompt|classifier|payload|g6run|harness|set)\s+(\S+)\s+([0-9a-f]{64})$/u;
const SEED = /^seed\s+(quoky-g7-\d{8})$/u;
const RECIPIENT = /^recipient\s+claude-cli\s+model=(\S+)\s+cli=(\S+)$/u;
const FREEZE_BLOCK = /^```g7-freeze[ \t]*\n([\s\S]*?)^```[ \t]*$/gmu;
const PAYLOAD_BLOCK = /^```g7-payload[ \t]*\n([\s\S]*?)^```[ \t]*$/gmu;

/** Every entry of every `g7-freeze` block. Throws on a malformed line (fail closed). */
export function parseG7Entries(decisionsText) {
  const entries = [];
  for (const block of decisionsText.matchAll(FREEZE_BLOCK)) {
    for (const rawLine of block[1].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      let m = HASHED.exec(line);
      if (m) {
        entries.push({ kind: m[1], path: m[2], sha256: m[3], line });
        continue;
      }
      m = SEED.exec(line);
      if (m) {
        entries.push({ kind: 'seed', value: m[1], line });
        continue;
      }
      m = RECIPIENT.exec(line);
      if (m) {
        entries.push({ kind: 'recipient', model: m[1], cli: m[2], line });
        continue;
      }
      throw new Error(`malformed g7-freeze line: ${line}`);
    }
  }
  return entries;
}

/** The body of the one `g7-payload` block, or null when there is not exactly one. */
export function payloadBlock(decisionsText) {
  const blocks = [...decisionsText.matchAll(PAYLOAD_BLOCK)];
  return blocks.length === 1 ? blocks[0][1] : null;
}

function one(entries, kind, problems) {
  const found = entries.filter((e) => e.kind === kind);
  if (found.length !== 1) {
    problems.push(`expected exactly one ${kind} entry, found ${found.length}`);
    return null;
  }
  return found[0];
}

/**
 * Checks the entries. `hashOf(repoPath)` and `archiveHashOf(archivePath)` return a sha256 or null; `payloadSha` is
 * the sha256 of the committed payload block (null when absent or duplicated); `sha256` hashes a string.
 * `mode`: 'g7' (the run: part 2 required) or 'part1' (before the case file exists).
 */
export function checkG7Freeze({ entries, mode, setPath, hashOf, archiveHashOf, payloadSha }) {
  const problems = [];
  const prompt = one(entries, 'prompt', problems);
  if (prompt && prompt.path !== PROMPT_PATH) problems.push(`prompt entry path ${prompt.path} is not ${PROMPT_PATH}`);
  const classifier = one(entries, 'classifier', problems);
  if (classifier && classifier.path !== CLASSIFIER_PATH) problems.push(`classifier entry path ${classifier.path} is not ${CLASSIFIER_PATH}`);
  const payload = one(entries, 'payload', problems);
  if (payload && payload.path !== PAYLOAD_REF) problems.push(`payload entry must name ${PAYLOAD_REF}`);
  const g6run = one(entries, 'g6run', problems);
  if (g6run && g6run.path !== G6_RUN_SEALED) problems.push(`g6run entry path ${g6run.path} is not ${G6_RUN_SEALED}`);
  const harness = entries.filter((e) => e.kind === 'harness').map((e) => e.path);
  for (const p of HARNESS_FILES) if (!harness.includes(p)) problems.push(`no harness entry for ${p}`);
  for (const p of harness) if (!HARNESS_FILES.includes(p)) problems.push(`unexpected harness entry ${p}`);
  const dupes = harness.filter((p, i) => harness.indexOf(p) !== i);
  if (dupes.length) problems.push(`duplicate harness entries: ${[...new Set(dupes)].join(', ')}`);

  for (const e of entries.filter((x) => ['prompt', 'classifier', 'harness'].includes(x.kind))) {
    const actual = hashOf(e.path);
    if (actual === null) problems.push(`${e.kind} file missing: ${e.path}`);
    else if (actual !== e.sha256) problems.push(`${e.kind} hash mismatch: ${e.path} is ${actual}, addendum has ${e.sha256}`);
  }
  if (payload) {
    if (payloadSha === null) problems.push('the committed DECISIONS.md must hold exactly one g7-payload block');
    else if (payloadSha !== payload.sha256) problems.push(`payload definition hash mismatch: block is ${payloadSha}, addendum has ${payload.sha256}`);
  }
  if (g6run) {
    const actual = archiveHashOf(g6run.path);
    if (actual === null) problems.push(`G6 run file missing under the eval archive: ${g6run.path}`);
    else if (actual !== g6run.sha256) problems.push(`G6 run file hash mismatch: ${g6run.path} is ${actual}, addendum has ${g6run.sha256}`);
  }
  const g6Set = hashOf(G6_SET_PATH);
  if (g6Set !== G6_SET_SHA256) problems.push(`G6 set ${G6_SET_PATH} sha256 ${g6Set} is not ${G6_SET_SHA256}`);
  const g6Prompt = hashOf(G6_PROMPT_PATH);
  if (g6Prompt !== G6_PROMPT_SHA256) problems.push(`G6 prompt ${G6_PROMPT_PATH} sha256 ${g6Prompt} is not ${G6_PROMPT_SHA256}`);
  const rubric = hashOf(RUBRIC_PATH);
  if (rubric !== RUBRIC_SHA256) problems.push(`rubric ${RUBRIC_PATH} sha256 ${rubric} is not ${RUBRIC_SHA256}`);

  if (mode === 'g7') {
    const set = one(entries, 'set', problems);
    if (set) {
      if (set.path !== setPath) problems.push(`set entry path ${set.path} is not the file being run (${setPath})`);
      const actual = hashOf(set.path);
      if (actual === null) problems.push(`set file missing: ${set.path}`);
      else if (actual !== set.sha256) problems.push(`set hash mismatch: ${set.path} is ${actual}, addendum has ${set.sha256}`);
    }
    one(entries, 'seed', problems);
    one(entries, 'recipient', problems);
  } else if (mode !== 'part1') {
    problems.push(`unknown mode ${mode}`);
  }
  return problems;
}

/** The text that `git log -S` must find for an entry (hash, seed or recipient line). */
export function searchKey(entry) {
  if (entry.kind === 'seed') return entry.value;
  if (entry.kind === 'recipient') return entry.line;
  return entry.sha256;
}

/**
 * The commit-order conditions. `git` provides firstCommitAdding(text), isAncestor(a, b), changedFiles(commit),
 * existsInCommit(commit, path) (as tools/g6/freeze.mjs realGit). Returns a list of problems.
 */
export function checkG7CommitOrder({ entries, mode, git, now, setPath }) {
  const problems = [];
  const part1 = entries.filter((e) => PART1_KINDS.includes(e.kind));
  const firsts1 = [];
  for (const e of part1) {
    const first = git.firstCommitAdding(searchKey(e));
    if (!first) problems.push(`${e.kind} entry ${e.path} is not in any committed DECISIONS.md`);
    else firsts1.push({ e, first });
  }
  if (mode !== 'g7') return problems;
  const part2 = entries.filter((e) => PART2_KINDS.includes(e.kind));
  for (const e of part2) {
    const first = git.firstCommitAdding(searchKey(e));
    if (!first) {
      problems.push(`${e.kind} entry is not in any committed DECISIONS.md`);
      continue;
    }
    for (const { e: p1, first: f1 } of firsts1) {
      if (f1.commit === first.commit) problems.push(`${p1.kind} ${p1.path} was committed together with the ${e.kind} entry`);
      else if (!git.isAncestor(f1.commit, first.commit)) problems.push(`${p1.kind} ${p1.path} was not committed before the ${e.kind} entry`);
    }
    const changed = git.changedFiles(first.commit);
    if (changed.length !== 1 || changed[0] !== DECISIONS_PATH) {
      problems.push(`the ${e.kind} commit ${first.commit} is not hash-only (changes: ${changed.join(', ')})`);
    }
    if (!(first.time < now)) problems.push(`the ${e.kind} commit is not dated before the run start`);
  }
  const promptFirst = firsts1.find((x) => x.e.kind === 'prompt');
  if (promptFirst && git.existsInCommit(promptFirst.first.commit, setPath)) {
    problems.push(`the G7 file ${setPath} already existed in the prompt-hash commit ${promptFirst.first.commit}`);
  }
  return problems;
}

export { checkModelManifest };

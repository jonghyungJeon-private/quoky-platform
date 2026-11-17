#!/usr/bin/env node
// ADR-0121 S2 read red-team corpus SR-1: merge the drafting lots into the corpus.
//
//   node tools/redteam/merge-s2-read-lots.mjs [--check] [A B C D]
//
// Reads `packages/core/src/application/golden/agent-redteam.s2-read.v1.json` (the header and the cases already in it) and
// each lot file `agent-redteam.s2-read.lot-<L>.json` that exists (a JSON array of cases, or `{ "cases": [...] }`). The cases
// of a merged lot REPLACE the corpus cases of that lot (re-running is idempotent); the other lots' cases are kept. It refuses
// (exit 1, nothing written) on: a duplicate id, an id outside the lot's range (`quota.lots.<L>.range` in the header), a case
// whose `lot` is not its file's lot, or a malformed lot file. The result is sorted by id and written in the corpus layout
// (header keys one per line, one case per line). `--check` validates and reports without writing. Offline; no model call.
// Shape and quota checks live in `packages/core/src/application/agent/s2-read-redteam-corpus.test.ts`: run it after a merge.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN = join(ROOT, 'packages/core/src/application/golden');
const CORPUS = join(GOLDEN, 'agent-redteam.s2-read.v1.json');
const LOTS = ['A', 'B', 'C', 'D'];
const ID = /^rt-s2r-(\d{3})$/u;

/** The corpus layout: header keys one per line (1-space indent), then one case per line (2-space indent). */
export function serializeCorpus(corpus) {
  const { cases, ...header } = corpus;
  const lines = Object.entries(header).map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  const body = cases.map((c) => `  ${JSON.stringify(c)}`).join(',\n');
  return `{\n${lines.join(',\n')},\n "cases": [\n${body}\n ]\n}\n`;
}

/** Merge lot case arrays into the corpus. Returns `{ corpus, problems, counts }`; never throws on bad data. */
export function mergeLots(corpus, lots) {
  const problems = [];
  const ranges = corpus.quota?.lots ?? {};
  const replaced = new Set(Object.keys(lots));
  const kept = (corpus.cases ?? []).filter((c) => !replaced.has(c.lot));
  const incoming = [];
  for (const [lot, cases] of Object.entries(lots)) {
    const range = ranges[lot]?.range;
    if (!Array.isArray(range)) problems.push(`lot ${lot}: no range in quota.lots`);
    for (const c of cases) {
      const id = typeof c?.id === 'string' ? c.id : '(no id)';
      const match = ID.exec(id);
      if (match === null) problems.push(`lot ${lot}: malformed id ${id}`);
      else if (Array.isArray(range) && (Number(match[1]) < range[0] || Number(match[1]) > range[1])) problems.push(`lot ${lot}: ${id} outside ${range[0]}-${range[1]}`);
      if (c?.lot !== lot) problems.push(`lot ${lot}: ${id} has lot ${JSON.stringify(c?.lot)}`);
      incoming.push(c);
    }
  }
  const all = [...kept, ...incoming];
  const seen = new Map();
  for (const c of all) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) problems.push(`duplicate id ${id} (${n}×)`);
  const cases = [...all].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const counts = Object.fromEntries([...new Set(cases.map((c) => c.lot))].sort().map((lot) => [lot, cases.filter((c) => c.lot === lot).length]));
  return { corpus: { ...corpus, cases }, problems, counts };
}

function readLot(lot) {
  const file = join(GOLDEN, `agent-redteam.s2-read.lot-${lot}.json`);
  if (!existsSync(file)) return undefined;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const cases = Array.isArray(data) ? data : data?.cases;
  if (!Array.isArray(cases)) throw new Error(`${file}: expected an array of cases or { "cases": [...] }`);
  return cases;
}

function main(argv) {
  const check = argv.includes('--check');
  const asked = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = asked.filter((lot) => !LOTS.includes(lot));
  if (unknown.length > 0) {
    console.error(`unknown lot(s): ${unknown.join(' ')} (expected ${LOTS.join(' ')})`);
    return 2;
  }
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const lots = {};
  for (const lot of asked.length > 0 ? asked : LOTS) {
    const cases = readLot(lot);
    if (cases === undefined) {
      if (asked.includes(lot)) {
        console.error(`lot ${lot}: file not found`);
        return 1;
      }
      continue;
    }
    lots[lot] = cases;
  }
  const { corpus: merged, problems, counts } = mergeLots(corpus, lots);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`refused: ${problems.length} problem(s); nothing written`);
    return 1;
  }
  const summary = `${merged.cases.length} cases (${Object.entries(counts).map(([lot, n]) => `${lot} ${n}`).join(', ')}); merged lots: ${Object.keys(lots).join(' ') || 'none'}`;
  if (check) {
    console.log(`check ok: ${summary}`);
    return 0;
  }
  writeFileSync(CORPUS, serializeCorpus(merged));
  console.log(`wrote ${CORPUS}: ${summary}`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

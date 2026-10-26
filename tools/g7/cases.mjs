// G7 harness: the G7 case file. Pure; no clock, no network, no model.
//
// Pre-registration (DECISIONS.md "ADR-0121 A3a measurement record", G7): "Cases: the calendar cases of the final G6
// run." So the G7 file does NOT carry new cases. It names the G6 held-out set by its frozen hash, confirms the
// calendar case ids, and adds the one input the A3b payload needs that the G6 format lacks: the owner's name(s), which
// join the name-field union (A3b-D3 [C4]). The harness takes every item, request, `select`, `count` and `now` from the
// G6 set itself.
//
// File (`packages/core/src/application/golden/a2/g7-calendar.v1.json`), authored by a separate session (no access to
// the arm-B prompt or the payload code needed; no model call):
//   {
//     "version": 1,
//     "set": "g7-calendar",
//     "derivedFrom": { "path": "packages/core/src/application/golden/a2/local-judgment-heldout.v2.json",
//                      "sha256": "2ca306a6f8e9a059be25dbfa88feb57e1b6f5b42034464f2f7195b6c158f3e84" },
//     "ownerNames": ["<the synthetic owner's display name(s) and e-mail local part(s)>", ...],   // 1..10
//     "caseIds": ["<every calendar case id of the G6 set, in G6 order>", ...],
//     "description": "<optional free text>"
//   }
// Rules: no other key; `derivedFrom` exactly as above; `ownerNames` 1–10 non-empty strings of ≤ 60 chars (the name the
// set's synthetic owner would have in configuration; the G6 set has none); `caseIds` exactly the G6 calendar ids in G6
// order (no subset, no reordering, no addition). The file's sha256 is committed afterwards in a hash-only commit.

export const G6_SET_PATH = 'packages/core/src/application/golden/a2/local-judgment-heldout.v2.json';
export const G6_SET_SHA256 = '2ca306a6f8e9a059be25dbfa88feb57e1b6f5b42034464f2f7195b6c158f3e84';
export const DEFAULT_G7_SET_PATH = 'packages/core/src/application/golden/a2/g7-calendar.v1.json';
export const OWNER_NAMES_MAX = 10;
export const OWNER_NAME_CHARS_MAX = 60;
/** G7 rule: ≥ 25 non-tie pairs are needed; fewer cases than that can never open. */
export const CASES_MIN = 25;

/** Validates a parsed G7 file against the parsed G6 set. Returns a list of problems (empty = valid). */
export function validateG7File(file, g6Set) {
  if (file === null || typeof file !== 'object' || Array.isArray(file)) return ['G7 file must be an object'];
  const problems = [];
  const allowed = ['version', 'set', 'derivedFrom', 'ownerNames', 'caseIds', 'description'];
  for (const k of Object.keys(file)) if (!allowed.includes(k)) problems.push(`unknown key ${k}`);
  if (file.version !== 1) problems.push('version must be 1');
  if (file.set !== 'g7-calendar') problems.push('set must be "g7-calendar"');
  const d = file.derivedFrom;
  if (!d || d.path !== G6_SET_PATH || d.sha256 !== G6_SET_SHA256 || Object.keys(d).length !== 2) {
    problems.push(`derivedFrom must be exactly { path: ${G6_SET_PATH}, sha256: ${G6_SET_SHA256} }`);
  }
  if (!Array.isArray(file.ownerNames) || file.ownerNames.length < 1 || file.ownerNames.length > OWNER_NAMES_MAX) {
    problems.push(`ownerNames must be an array of 1..${OWNER_NAMES_MAX}`);
  } else if (!file.ownerNames.every((n) => typeof n === 'string' && n.trim() && [...n].length <= OWNER_NAME_CHARS_MAX)) {
    problems.push(`every ownerNames entry must be a non-empty string of ≤ ${OWNER_NAME_CHARS_MAX} chars`);
  }
  if ('description' in file && typeof file.description !== 'string') problems.push('description must be a string');
  const expected = (g6Set?.cases ?? []).filter((c) => c.source === 'calendar').map((c) => c.id);
  if (!Array.isArray(file.caseIds) || file.caseIds.length !== expected.length || file.caseIds.some((id, i) => id !== expected[i])) {
    problems.push(`caseIds must be exactly the ${expected.length} calendar case ids of the G6 set, in G6 order`);
  }
  if (expected.length < CASES_MIN) problems.push(`the G6 set has ${expected.length} calendar cases < ${CASES_MIN}`);
  return problems;
}

/** The G7 cases: the G6 calendar cases, unchanged. */
export function g7Cases(g6Set) {
  return g6Set.cases.filter((c) => c.source === 'calendar');
}

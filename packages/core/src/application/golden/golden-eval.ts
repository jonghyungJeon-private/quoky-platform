/**
 * Offline golden evaluation (ADR-0098 D7, QUAL-2).
 *
 * Pure scorer for versioned, owner-curated corpora of deterministic Core decisions (intent routing, approval
 * decisions, stray decisions, control phrases, project registration). It performs no I/O, owns no clock and calls no
 * provider: the caller supplies a `predict` function and the scorer compares each prediction with the case's
 * `expected` value. The corpus JSON files live beside this module and are imported only by tests, so they are not
 * part of the emitted package. Cases are never added automatically.
 */

/** One owner-curated golden case. `E` is the suite's expected-value shape. */
export interface GoldenCase<E = unknown> {
  readonly id: string;
  readonly text: string;
  readonly expected: E;
  /** Where the case came from (UAT row, QA id, ADR example, existing unit-test list). */
  readonly source: string;
  /** True when the case is a hard contract: a failure fails the suite regardless of the accuracy ratchet. */
  readonly mustPass: boolean;
}

/** A versioned corpus file. */
export interface GoldenSuiteFile<C extends GoldenCase = GoldenCase> {
  readonly suite: string;
  readonly version: number;
  readonly cases: readonly C[];
}

export interface GoldenFailure {
  readonly id: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly mustPass: boolean;
}

export interface GoldenSuiteResult {
  readonly suite: string;
  readonly total: number;
  readonly correct: number;
  /** `correct / total`, or 1 for an empty suite. */
  readonly accuracy: number;
  readonly failures: readonly GoldenFailure[];
}

/** One suite's committed floor in `baseline.v1.json`. */
export interface GoldenBaselineEntry {
  readonly minAccuracy: number;
  /** The corpus may grow but never shrink below this size (a ratchet on coverage, not only on accuracy). */
  readonly minTotal: number;
}

export interface GoldenBaselineFile {
  readonly version: number;
  readonly suites: Readonly<Record<string, GoldenBaselineEntry>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Expected-subset match. Plain objects match when every key of `expected` matches the same key of `actual` (extra
 * keys on `actual` are ignored, so a corpus pins only what it cares about); arrays match element-wise with equal
 * length; everything else must be strictly equal (`null` only equals `null`).
 */
export function goldenMatches(expected: unknown, actual: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every((key) => goldenMatches(expected[key], actual[key]));
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => goldenMatches(item, actual[index]))
    );
  }
  return Object.is(expected, actual);
}

function summarize(suite: string, total: number, failures: GoldenFailure[]): GoldenSuiteResult {
  const correct = total - failures.length;
  return Object.freeze({
    suite,
    total,
    correct,
    accuracy: total === 0 ? 1 : correct / total,
    failures: Object.freeze(failures),
  });
}

/** Score a suite with a synchronous predictor. */
export function evaluateGoldenSuite<E>(
  cases: readonly GoldenCase<E>[],
  predict: (golden: GoldenCase<E>) => unknown,
  suite = 'unnamed',
): GoldenSuiteResult {
  const failures: GoldenFailure[] = [];
  for (const golden of cases) {
    const actual = predict(golden);
    if (!goldenMatches(golden.expected, actual)) {
      failures.push({ id: golden.id, expected: golden.expected, actual, mustPass: golden.mustPass });
    }
  }
  return summarize(suite, cases.length, failures);
}

/** Score a suite with an asynchronous predictor (cases are evaluated sequentially and deterministically). */
export async function evaluateGoldenSuiteAsync<E>(
  cases: readonly GoldenCase<E>[],
  predict: (golden: GoldenCase<E>) => Promise<unknown>,
  suite = 'unnamed',
): Promise<GoldenSuiteResult> {
  const failures: GoldenFailure[] = [];
  for (const golden of cases) {
    const actual = await predict(golden);
    if (!goldenMatches(golden.expected, actual)) {
      failures.push({ id: golden.id, expected: golden.expected, actual, mustPass: golden.mustPass });
    }
  }
  return summarize(suite, cases.length, failures);
}

/** Structural problems in a corpus (duplicate ids, empty fields). Empty array means the corpus is well formed. */
export function validateGoldenCases(cases: readonly GoldenCase[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const golden of cases) {
    if (typeof golden.id !== 'string' || golden.id.length === 0) problems.push('case without an id');
    else if (seen.has(golden.id)) problems.push(`duplicate id: ${golden.id}`);
    else seen.add(golden.id);
    if (typeof golden.text !== 'string') problems.push(`${golden.id}: text must be a string`);
    if (typeof golden.source !== 'string' || golden.source.length === 0) problems.push(`${golden.id}: missing source`);
    if (typeof golden.mustPass !== 'boolean') problems.push(`${golden.id}: mustPass must be a boolean`);
    if (golden.expected === undefined) problems.push(`${golden.id}: missing expected`);
  }
  return problems;
}

/** Failures that break a `mustPass` contract. */
export function mustPassFailures(result: GoldenSuiteResult): readonly GoldenFailure[] {
  return result.failures.filter((failure) => failure.mustPass);
}

/**
 * Ratchet verdict for one suite: the list of violated floors (empty means the suite holds the baseline). Accuracy
 * may only go up, and the corpus may only grow.
 */
export function ratchetViolations(result: GoldenSuiteResult, baseline: GoldenBaselineEntry | undefined): string[] {
  if (baseline === undefined) return [`${result.suite}: no baseline entry`];
  const violations: string[] = [];
  if (result.accuracy < baseline.minAccuracy) {
    violations.push(`${result.suite}: accuracy ${result.accuracy.toFixed(4)} < baseline ${baseline.minAccuracy}`);
  }
  if (result.total < baseline.minTotal) {
    violations.push(`${result.suite}: ${result.total} cases < baseline ${baseline.minTotal}`);
  }
  return violations;
}

/** One summary line per suite, for test logs. */
export function formatGoldenSummary(result: GoldenSuiteResult): string {
  return (
    `[golden] ${result.suite}: ${result.correct}/${result.total} correct ` +
    `(accuracy ${(result.accuracy * 100).toFixed(2)}%, failures ${result.failures.length})`
  );
}

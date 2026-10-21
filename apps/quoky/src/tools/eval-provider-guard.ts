/**
 * Provider-outage guard for the model-in-the-loop eval CLIs (`eval:nl`, `eval:agent-plan`, `eval:r2-redteam`).
 *
 * Incident (2026-10-19..21): when the Claude CLI hit a usage/session limit mid-run, every remaining call failed with
 * `provider-execution_failed`, and the run reported a 0% (or low) score as a FAILED gate, which read like a prompt
 * regression. This guard sits at the provider boundary of an eval run and:
 *
 * - counts every call's outcome by a content-free reason (`ok`, `timeout`, `provider-<kind>`, `error`);
 * - trips when the failures are clearly provider-wide (N consecutive provider failures, a long all-timeout streak, or a
 *   provider-failure share above the threshold once enough calls were made) and from then on refuses every further call
 *   WITHOUT reaching the provider (the run aborts early and spends nothing more);
 * - gives the CLI a verdict: `INVALID (provider unavailable: <reason>)` when it tripped or when the final provider-failure
 *   share is above the threshold. An invalid run prints neither PASSED nor FAILED and exits {@link EXIT_INVALID_PROVIDER}.
 *
 * Sporadic failures below the threshold are not touched: the call's error reaches the eval exactly as before and is
 * scored as it is today (timeouts and parse failures included).
 */
import { AiFailureKind, AiProviderError, type AiProvider } from '@quoky/core';

/** Exit code of an eval run invalidated by a provider outage (distinct from 0 pass, 1 fail, 2 usage, 3 blocked, 4 non-gating). */
export const EXIT_INVALID_PROVIDER = 5;

export interface ProviderOutageThresholds {
  /** The run is invalid when provider failures / calls exceeds this share (default 5%). */
  readonly maxFailureShare: number;
  /** The share is not judged below this many failures (one failure never invalidates a run). */
  readonly minFailuresForShare: number;
  /** The share trips the guard mid-run only after this many calls reached the provider ... */
  readonly minCallsForEarlyTrip: number;
  /** ... and this many failures (a couple of early sporadic failures never abort a long run). */
  readonly minFailuresForEarlyTrip: number;
  /** This many provider failures in a row (no success in between) trips the guard. */
  readonly maxConsecutiveFailures: number;
  /** This many timeouts in a row (no success in between) is provider-wide too (`timeout-streak`). */
  readonly maxConsecutiveTimeouts: number;
}

export const PROVIDER_OUTAGE_THRESHOLDS: ProviderOutageThresholds = Object.freeze({
  maxFailureShare: 0.05,
  minFailuresForShare: 2,
  minCallsForEarlyTrip: 40,
  minFailuresForEarlyTrip: 3,
  maxConsecutiveFailures: 5,
  maxConsecutiveTimeouts: 10,
});

export interface ProviderOutageTrip {
  readonly reason: string;
  readonly trigger: 'consecutive-failures' | 'failure-share' | 'timeout-streak';
  /** Calls that had reached the provider when it tripped. */
  readonly atCall: number;
}

export interface ProviderOutageReport {
  /** Calls that reached the provider (answered, timed out or failed). */
  readonly calls: number;
  readonly ok: number;
  readonly timeouts: number;
  /** Non-timeout provider failures (the share is computed over these). */
  readonly failures: number;
  /** Failures by content-free reason (`provider-execution_failed`, `provider-unavailable`, `error`, ...). */
  readonly failureReasons: Readonly<Record<string, number>>;
  /** Calls refused after the trip; they never reached the provider. */
  readonly notIssued: number;
  readonly tripped?: ProviderOutageTrip;
  /** `undefined`: the run is valid. Otherwise the content-free reason it is invalid. */
  readonly invalidReason?: string;
}

/** The content-free reason of one failed call: `timeout`, `provider-<failure kind>` or `error`. */
export function providerFailureReason(error: unknown): string {
  if (error instanceof AiProviderError) {
    if (error.kind === AiFailureKind.TIMEOUT) return 'timeout';
    return `provider-${String(error.kind).toLowerCase().replace(/[^a-z_-]/gu, '')}`;
  }
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (kind === 'TIMEOUT') return 'timeout';
  if (typeof kind === 'string' && /^[A-Z_]{1,40}$/u.test(kind)) return `provider-${kind.toLowerCase()}`;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return 'timeout';
  return 'error';
}

/** The refusal a tripped guard throws instead of calling the provider. */
export class ProviderOutageAbort extends AiProviderError {
  constructor(reason: string) {
    super(AiFailureKind.UNAVAILABLE, `eval aborted: provider unavailable (${reason}); no further calls are issued`);
    this.name = 'ProviderOutageAbort';
  }
}

export interface GuardedProvider {
  readonly provider: AiProvider;
  readonly report: () => ProviderOutageReport;
}

function dominant(reasons: Readonly<Record<string, number>>): string {
  const sorted = Object.entries(reasons).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  return sorted[0]?.[0] ?? 'error';
}

/**
 * Wrap the eval's provider. `onTrip` is called once, when the guard trips (the CLI prints the abort).
 */
export function guardEvalProvider(
  provider: AiProvider,
  options: { readonly thresholds?: Partial<ProviderOutageThresholds>; readonly onTrip?: (trip: ProviderOutageTrip) => void } = {},
): GuardedProvider {
  const limits: ProviderOutageThresholds = { ...PROVIDER_OUTAGE_THRESHOLDS, ...options.thresholds };
  let ok = 0;
  let timeouts = 0;
  let failures = 0;
  let notIssued = 0;
  let consecutiveFailures = 0;
  let consecutiveTimeouts = 0;
  const failureReasons: Record<string, number> = {};
  let tripped: ProviderOutageTrip | undefined;
  const calls = (): number => ok + timeouts + failures;
  const overShare = (): boolean => failures >= limits.minFailuresForShare && failures / Math.max(1, calls()) > limits.maxFailureShare;
  const trip = (trigger: ProviderOutageTrip['trigger'], reason: string): void => {
    if (tripped !== undefined) return;
    tripped = { reason, trigger, atCall: calls() };
    options.onTrip?.(tripped);
  };
  const wrapped: AiProvider = {
    id: provider.id,
    ...(provider.family !== undefined ? { family: provider.family } : {}),
    ...(provider.executionLocality !== undefined ? { executionLocality: provider.executionLocality } : {}),
    capabilities: provider.capabilities,
    isAvailable: () => provider.isAvailable(),
    execute: async (request) => {
      if (tripped !== undefined) {
        notIssued += 1;
        throw new ProviderOutageAbort(tripped.reason);
      }
      try {
        const result = await provider.execute(request);
        ok += 1;
        consecutiveFailures = 0;
        consecutiveTimeouts = 0;
        return result;
      } catch (error) {
        const reason = providerFailureReason(error);
        if (reason === 'timeout') {
          timeouts += 1;
          consecutiveTimeouts += 1;
          if (consecutiveTimeouts >= limits.maxConsecutiveTimeouts) trip('timeout-streak', 'timeout-streak');
        } else {
          failures += 1;
          failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= limits.maxConsecutiveFailures) trip('consecutive-failures', reason);
          else if (calls() >= limits.minCallsForEarlyTrip && failures >= limits.minFailuresForEarlyTrip && overShare()) trip('failure-share', dominant(failureReasons));
        }
        throw error;
      }
    },
  };
  return {
    provider: wrapped,
    report: () => {
      const invalidReason = tripped?.reason ?? (overShare() ? dominant(failureReasons) : undefined);
      return {
        calls: calls(),
        ok,
        timeouts,
        failures,
        failureReasons: { ...failureReasons },
        notIssued,
        ...(tripped !== undefined ? { tripped } : {}),
        ...(invalidReason !== undefined ? { invalidReason } : {}),
      };
    },
  };
}

/** `INVALID (provider unavailable: <reason>)`: the only verdict an invalidated run prints. */
export function invalidVerdict(reason: string): string {
  return `INVALID (provider unavailable: ${reason})`;
}

/** The content-free counts line every guarded CLI prints. */
export function formatProviderOutcomes(report: ProviderOutageReport): string {
  const reasons = Object.entries(report.failureReasons)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  const share = report.calls > 0 ? ((report.failures / report.calls) * 100).toFixed(1) : '0.0';
  return (
    `provider outcomes: calls ${report.calls}, ok ${report.ok}, timeouts ${report.timeouts}, provider failures ${report.failures} (${share}%${reasons ? `: ${reasons}` : ''})` +
    `, not issued after abort ${report.notIssued}` +
    (report.tripped !== undefined ? `; aborted at call ${report.tripped.atCall} (${report.tripped.trigger}: ${report.tripped.reason})` : '')
  );
}

/** The stderr line printed when the guard trips. */
export function formatTrip(trip: ProviderOutageTrip): string {
  return `ABORT: provider unavailable (${trip.reason}, ${trip.trigger}) after ${trip.atCall} call(s); no further model calls are issued and the run is INVALID`;
}

/**
 * Print the verdict of an invalidated run: every run and the overall gate line read `INVALID (...)` (never PASSED or
 * FAILED), followed by the counts. The per-run scores are not printed: they measure the outage, not the prompt.
 */
export function printInvalidRun(stdout: (line: string) => void, gateLabel: string, runs: number, report: ProviderOutageReport): void {
  const verdict = invalidVerdict(report.invalidReason ?? 'error');
  for (let run = 1; run <= runs; run += 1) stdout(`run ${run}/${runs}: ${verdict}`);
  stdout(formatProviderOutcomes(report));
  stdout(`${gateLabel}: ${verdict}; the scores of this run are not reported (re-run after the provider recovers)`);
}

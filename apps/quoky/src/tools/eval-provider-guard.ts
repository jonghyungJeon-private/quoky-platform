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
 * - before it trips, makes ONE canary call (a tiny fixed prompt through the same provider, short timeout). A provider that
 *   answers the canary is not down: the failures are recorded as "not an outage" and the run is scored normally, so
 *   prompt-too-long / content-filter 400s or a latency regression surface as FAILED rather than INVALID;
 * - scales the streak limits with the concurrency (in-flight calls keep failing after a trip decision);
 * - gives the CLI a verdict: `INVALID (provider unavailable: <reason>)` when it tripped or when the final provider-failure
 *   share is above the threshold. An invalid run prints neither PASSED nor FAILED and exits {@link EXIT_INVALID_PROVIDER}.
 *
 * Sporadic failures below the threshold are not touched: the call's error reaches the eval exactly as before and is
 * scored as it is today (timeouts and parse failures included).
 */
import { AiFailureKind, AiProviderError, Capability, type AiProvider } from '@quoky/core';

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

/** The base thresholds at concurrency 1. {@link resolveThresholds} scales the streak limits and the early-trip floor. */
export const PROVIDER_OUTAGE_THRESHOLDS: ProviderOutageThresholds = Object.freeze({
  maxFailureShare: 0.05,
  minFailuresForShare: 2,
  minCallsForEarlyTrip: 40,
  minFailuresForEarlyTrip: 3,
  maxConsecutiveFailures: 5,
  maxConsecutiveTimeouts: 10,
});

/**
 * The thresholds of one run: failure streak = 5 + 2 * concurrency, timeout streak = 10 + 2 * concurrency (calls already in
 * flight keep failing after the first ones), and the mid-run share check starts at max(40, 10% of the plan's max calls).
 * Explicit `overrides` win (tests).
 */
export function resolveThresholds(options: { readonly concurrency?: number; readonly maxCalls?: number; readonly overrides?: Partial<ProviderOutageThresholds> } = {}): ProviderOutageThresholds {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const maxCalls = Math.max(0, options.maxCalls ?? 0);
  return {
    ...PROVIDER_OUTAGE_THRESHOLDS,
    maxConsecutiveFailures: PROVIDER_OUTAGE_THRESHOLDS.maxConsecutiveFailures + 2 * concurrency,
    maxConsecutiveTimeouts: PROVIDER_OUTAGE_THRESHOLDS.maxConsecutiveTimeouts + 2 * concurrency,
    minCallsForEarlyTrip: Math.max(PROVIDER_OUTAGE_THRESHOLDS.minCallsForEarlyTrip, Math.ceil(maxCalls * 0.1)),
    ...options.overrides,
  };
}

/** The tiny fixed prompt of the canary call. */
export const CANARY_PROMPT = 'Reply with the single word: ok';
/** The canary's own short timeout. */
export const CANARY_TIMEOUT_MS = 20_000;

/** At most this many canary calls per run (a hard cap, like the plan's call cap); once used the guard stops checking and the run is scored as it is. */
export const MAX_CANARY_CALLS = 3;
/** One more canary, outside the mid-run cap, reserved for `settle()`: a run that ENDS on a failure streak is checked even after the mid-run canaries answered. */
export const FINAL_CANARY_CALLS = 1;
/** Every canary a run may make. */
export const TOTAL_CANARY_CALLS = MAX_CANARY_CALLS + FINAL_CANARY_CALLS;
/** The clause every plan output carries (the canary calls are outside the digest-bound call count). */
export const CANARY_CLAUSE = `up to ${TOTAL_CANARY_CALLS} canary calls (not counted)`;
export const CANARY_PLAN_LINE = `+ ${CANARY_CLAUSE}`;

/** A canary result: true = the provider answered, false = failed (unknown reason), a string = the content-free failure reason. */
export type CanaryResult = boolean | string;

/**
 * The default canary: one tiny call through the SAME provider client (never counted in the run's outcomes). Resolves true
 * when the provider answers, else the content-free failure reason (limit, auth, outage, timeout).
 */
export function providerCanary(provider: AiProvider, timeoutMs: number = CANARY_TIMEOUT_MS, evaluated: Capability = Capability.SUMMARIZATION): () => Promise<CanaryResult> {
  return async () => {
    // The canary must probe the capability the run evaluates: the provider routes its model per capability (e.g. the intent
    // selection model), so another capability would be answered by a different model.
    const capability = provider.capabilities.find((entry) => entry.capability === evaluated)?.capability ?? provider.capabilities[0]?.capability ?? evaluated;
    try {
      await provider.execute({ capability, prompt: CANARY_PROMPT, timeoutMs });
      return true;
    } catch (error) {
      return providerFailureReason(error);
    }
  };
}

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
  /** Canary calls made when the guard would have tripped (not counted in `calls`), and how many of them were answered. */
  readonly canaryCalls: number;
  readonly canaryAnswered: number;
  /** The content-free reason the canary failed with (`provider-auth_required`, `timeout`, ...), when it did. */
  readonly canaryFailure?: string;
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
  /** Judge the final failure share (one canary call when it is over the threshold). Call once the run is over, before `report`. */
  readonly settle: () => Promise<void>;
  readonly report: () => ProviderOutageReport;
}

export interface GuardOptions {
  /** Overrides of the resolved thresholds (tests). */
  readonly thresholds?: Partial<ProviderOutageThresholds>;
  /** The run's concurrency (scales the streak limits). */
  readonly concurrency?: number;
  /** The plan's max provider calls (scales the mid-run share floor). */
  readonly maxCalls?: number;
  /** One cheap call that resolves true when the provider answers. Without it the guard trips at once (no canary). */
  readonly canary?: () => Promise<CanaryResult>;
  readonly onTrip?: (trip: ProviderOutageTrip) => void;
}

function dominant(reasons: Readonly<Record<string, number>>): string {
  const sorted = Object.entries(reasons).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  return sorted[0]?.[0] ?? 'error';
}

/**
 * Wrap the eval's provider. `onTrip` is called once, when the guard trips (the CLI prints the abort).
 */
export function guardEvalProvider(provider: AiProvider, options: GuardOptions = {}): GuardedProvider {
  const limits = resolveThresholds({ ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}), ...(options.maxCalls !== undefined ? { maxCalls: options.maxCalls } : {}), ...(options.thresholds !== undefined ? { overrides: options.thresholds } : {}) });
  let ok = 0;
  let timeouts = 0;
  let failures = 0;
  let notIssued = 0;
  let consecutiveFailures = 0;
  let consecutiveTimeouts = 0;
  let canaryCalls = 0;
  let canaryAnswered = 0;
  let canaryPending: Promise<CanaryResult> | undefined;
  let canaryFailure: string | undefined;
  const checks = new Set<Promise<void>>();
  const failureReasons: Record<string, number> = {};
  let tripped: ProviderOutageTrip | undefined;
  const calls = (): number => ok + timeouts + failures;
  const overShare = (): boolean => failures >= limits.minFailuresForShare && failures / Math.max(1, calls()) > limits.maxFailureShare;
  const trip = (trigger: ProviderOutageTrip['trigger'], reason: string): void => {
    if (tripped !== undefined) return;
    tripped = { reason, trigger, atCall: calls() };
    options.onTrip?.(tripped);
  };
  /** One shared canary at a time; resolves true when the provider answered, else the failure reason. */
  const runCanary = (): Promise<CanaryResult> => {
    if (canaryPending === undefined) {
      canaryCalls += 1;
      const canary = options.canary as () => Promise<CanaryResult>;
      canaryPending = canary()
        .catch((): CanaryResult => false)
        .then((result) => {
          if (result === true) canaryAnswered += 1;
          canaryPending = undefined;
          return result;
        });
    }
    return canaryPending;
  };
  const check = async (trigger: ProviderOutageTrip['trigger'], reason: string): Promise<void> => {
    const result = await runCanary();
    if (tripped !== undefined) return;
    if (result === true) {
      // The provider is up: these failures are not an outage. Start the streaks over; they are scored as they are.
      consecutiveFailures = 0;
      consecutiveTimeouts = 0;
      return;
    }
    canaryFailure = typeof result === 'string' ? result : 'canary-failed';
    trip(trigger, reason);
  };
  /**
   * The guard would trip. Without a canary it trips at once. With one the check runs in the BACKGROUND: the failing call is
   * never held up (the eval times calls around the provider, so waiting would inflate latency and the over-bound rate), and
   * the decision lands when the canary answers (new calls are not held either; `settle` waits for it). After
   * {@link MAX_CANARY_CALLS} canaries the guard stops checking and the run is scored as it is.
   */
  const schedule = (trigger: ProviderOutageTrip['trigger'], reason: string): void => {
    if (tripped !== undefined) return;
    if (options.canary === undefined) return trip(trigger, reason);
    if (canaryPending !== undefined || checks.size > 0 || canaryCalls >= MAX_CANARY_CALLS) return;
    const pending = check(trigger, reason).finally(() => checks.delete(pending));
    checks.add(pending);
  };
  const drain = async (): Promise<void> => {
    while (checks.size > 0) await Promise.all([...checks]);
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
          if (consecutiveTimeouts >= limits.maxConsecutiveTimeouts) schedule('timeout-streak', 'timeout-streak');
        } else {
          failures += 1;
          failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= limits.maxConsecutiveFailures) schedule('consecutive-failures', reason);
          // After an answered canary the share is not judged mid-run again (the failures were ruled out as an outage).
          else if (canaryAnswered === 0 && calls() >= limits.minCallsForEarlyTrip && failures >= limits.minFailuresForEarlyTrip && overShare()) schedule('failure-share', dominant(failureReasons));
        }
        throw error;
      }
    },
  };
  return {
    provider: wrapped,
    settle: async () => {
      await drain();
      if (tripped !== undefined || options.canary === undefined) return;
      // The run ENDED on a failure / timeout streak at or above the limit: an outage that began after the mid-run canaries
      // answered (which are capped) would otherwise be scored as a 0% tail. The reserved final canary checks it.
      const endedOnStreak = consecutiveFailures >= limits.maxConsecutiveFailures || consecutiveTimeouts >= limits.maxConsecutiveTimeouts;
      if (endedOnStreak && canaryCalls < TOTAL_CANARY_CALLS) {
        await check(consecutiveFailures >= limits.maxConsecutiveFailures ? 'consecutive-failures' : 'timeout-streak', consecutiveFailures >= limits.maxConsecutiveFailures ? dominant(failureReasons) : 'timeout-streak');
        return;
      }
      if (canaryAnswered > 0 || !overShare()) return;
      schedule('failure-share', dominant(failureReasons));
      await drain();
    },
    report: () => {
      // A run whose canary was answered is not an outage, whatever the share: the failures are scored.
      const invalidReason = tripped?.reason ?? (canaryAnswered === 0 && overShare() ? dominant(failureReasons) : undefined);
      return {
        calls: calls(),
        ok,
        timeouts,
        failures,
        failureReasons: { ...failureReasons },
        notIssued,
        canaryCalls,
        canaryAnswered,
        ...(canaryFailure !== undefined ? { canaryFailure } : {}),
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
    (report.canaryCalls > 0 ? `; canary ${report.canaryAnswered}/${report.canaryCalls} answered${report.tripped === undefined && report.canaryAnswered > 0 ? ' (the failures are not an outage; scored as they are)' : ''}` : '') +
    (report.canaryFailure !== undefined ? `; canary failed: ${report.canaryFailure}` : '') +
    (report.tripped !== undefined ? `; aborted at call ${report.tripped.atCall} (${report.tripped.trigger}: ${report.tripped.reason})` : '')
  );
}

/** The stderr line printed when the guard trips. */
export function formatTrip(trip: ProviderOutageTrip): string {
  return `ABORT: provider unavailable (${trip.reason}, ${trip.trigger}) after ${trip.atCall} call(s); no further model calls are issued and the run is INVALID`;
}

/** A zero-tolerance metric of one CLI, by name (the counts of the answered records). */
export type HardFailureCounts = Readonly<Record<string, number>>;

/** The sum of the hard-failure counts. */
export function hardFailureTotal(counts: HardFailureCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** `name 0, other 0`, content-free. */
export function formatHardFailures(counts: HardFailureCounts): string {
  return Object.entries(counts)
    .map(([name, count]) => `${name} ${count}`)
    .join(', ');
}

/** Appended to the FAILED gate line of a run that saw both a hard failure and an outage. */
export function outageAlsoSeenNote(reason: string): string {
  return `(provider outage also seen: ${reason})`;
}

/**
 * Print the verdict of an invalidated run (no hard failure was observed among the answered records): every run and the
 * overall gate line read `INVALID (...)` (never PASSED or FAILED), followed by the counts and the hard-failure counts
 * (all zero). The per-run scores are not printed: they measure the outage, not the prompt.
 */
export function printInvalidRun(stdout: (line: string) => void, gateLabel: string, runs: number, report: ProviderOutageReport, hardFailures: HardFailureCounts = {}): void {
  const verdict = invalidVerdict(report.invalidReason ?? 'error');
  for (let run = 1; run <= runs; run += 1) stdout(`run ${run}/${runs}: ${verdict}`);
  stdout(formatProviderOutcomes(report));
  if (Object.keys(hardFailures).length > 0) stdout(`hard failures among the answered calls: ${formatHardFailures(hardFailures)}`);
  stdout(`${gateLabel}: ${verdict}; the scores of this run are not reported (re-run after the provider recovers)`);
}

/** One timed provider call: its wall time in ms and a content-free outcome. */
export interface TimedCall {
  readonly ms: number;
  readonly outcome: 'ok' | 'timeout' | 'failed';
}

/** p50 / p95 / max over the timed calls (nearest rank), and how many went over `boundMs`. Content-free. */
export interface LatencySummary {
  readonly calls: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly boundMs: number;
  readonly overBound: number;
  readonly timeouts: number;
}

export function summarizeLatency(calls: readonly TimedCall[], boundMs: number): LatencySummary {
  const sorted = calls.map((call) => call.ms).sort((a, b) => a - b);
  const rank = (q: number): number => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number));
  return {
    calls: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted.at(-1) ?? 0,
    boundMs,
    overBound: sorted.filter((ms) => ms > boundMs).length,
    timeouts: calls.filter((call) => call.outcome === 'timeout').length,
  };
}

/**
 * Owner decision of 2026-10-28: time every call of an eval provider (wall ms, outcome only; never a prompt or an answer),
 * so a gate report can give p50 / p95 of the selection latency. `elapsed` is a monotonic millisecond clock.
 */
export function timeEvalProvider(provider: AiProvider, elapsed: () => number): { readonly provider: AiProvider; readonly calls: () => readonly TimedCall[] } {
  const calls: TimedCall[] = [];
  const wrapped: AiProvider = {
    id: provider.id,
    ...(provider.family !== undefined ? { family: provider.family } : {}),
    ...(provider.executionLocality !== undefined ? { executionLocality: provider.executionLocality } : {}),
    capabilities: provider.capabilities,
    isAvailable: () => provider.isAvailable(),
    execute: async (request) => {
      const start = elapsed();
      try {
        const result = await provider.execute(request);
        calls.push({ ms: Math.round(elapsed() - start), outcome: 'ok' });
        return result;
      } catch (error) {
        calls.push({ ms: Math.round(elapsed() - start), outcome: providerFailureReason(error) === 'timeout' ? 'timeout' : 'failed' });
        throw error;
      }
    },
  };
  return { provider: wrapped, calls: () => [...calls] };
}

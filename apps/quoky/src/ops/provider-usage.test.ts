import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Capability, REMINDER_LIMITS, TaskRunStatus, runUsageRecord } from '@quoky/core';
import type { AiUsage, LogFields, Logger, TaskRun } from '@quoky/core';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { ProviderUsageLedger, monthKeyOf, monthStartIso, previousMonthKey } from './provider-usage';
import type { ProviderUsageSource } from './provider-usage';
import {
  ProviderUsageNoticeJob,
  monthlyUsageNoticeText,
  parseUsageNoticeState,
  thresholdUsageNoticeText,
} from './provider-usage-notice';
import type { UsageNoticeDelivery, UsageNoticeKind } from './provider-usage-notice';
import type { OpsNoticeLedgerStore } from './ops-notice';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.lines.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.lines.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.lines.push({ level: 'error', message, fields }); }
}

async function store(): Promise<SqliteStorageProvider> {
  const dir = mkdtempSync(path.join(tmpdir(), 'quoky-usage-'));
  dirs.push(dir);
  const s = new SqliteStorageProvider({ dbPath: path.join(dir, 'q.db') });
  await s.init();
  return s;
}

let counter = 0;
async function addRun(s: SqliteStorageProvider, finishedAt: string, usage: AiUsage | undefined, extra: Record<string, unknown> = {}): Promise<void> {
  counter += 1;
  const record = runUsageRecord(usage);
  const run: TaskRun = {
    id: `run-${counter}`,
    taskId: `task-${counter}`,
    attempt: 1,
    status: TaskRunStatus.SUCCEEDED,
    capability: Capability.GENERAL_CHAT,
    artifactIds: [],
    startedAt: finishedAt,
    finishedAt,
    metadata: { model: 'm', ...extra },
    ...(record ? { usage: record } : {}),
  } as TaskRun;
  await s.taskRuns.save(run);
}

const KST = 'Asia/Seoul';

describe('PRV-3 usage ledger (ADR-0115 D8): monthly totals read from TaskRun.usage', () => {
  it('computes month keys and boundaries in QUOKY_TIMEZONE', () => {
    // 2026-09-30T15:30Z is already October 1st in Seoul, still September 30th in UTC.
    expect(monthKeyOf('2026-09-30T15:30:00.000Z', KST)).toBe('2026-10');
    expect(monthKeyOf('2026-09-30T15:30:00.000Z', 'UTC')).toBe('2026-09');
    expect(monthStartIso('2026-10', KST)).toBe('2026-09-30T15:00:00.000Z');
    expect(monthStartIso('2026-10', 'UTC')).toBe('2026-10-01T00:00:00.000Z');
    expect(previousMonthKey('2026-01')).toBe('2025-12');
    expect(previousMonthKey('2026-10')).toBe('2026-09');
  });

  it('sums per selection label across a month boundary, by the configured timezone', async () => {
    const s = await store();
    // Last instant of September in Seoul, and the first of October.
    await addRun(s, '2026-09-30T14:59:59.999Z', { label: 'openai:gpt-5', inputTokens: 100, outputTokens: 50 });
    await addRun(s, '2026-09-30T15:00:00.000Z', { label: 'openai:gpt-5', inputTokens: 10, outputTokens: 5, totalTokens: 20 });
    await addRun(s, '2026-10-10T00:00:00.000Z', { label: 'gemini:g', inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 1 });
    const seoul = new ProviderUsageLedger(s.taskRuns, KST);
    const sept = await seoul.monthly('2026-09');
    expect(sept).toMatchObject({ month: '2026-09', runs: 1, unknownRuns: 0, totalTokens: { sum: 150, reportedRuns: 1 } });
    const none = { sum: 0, reportedRuns: 0 };
    expect(sept.labels).toEqual([
      {
        label: 'openai:gpt-5',
        runs: 1,
        unknownRuns: 0,
        inputTokens: { sum: 100, reportedRuns: 1 },
        cachedInputTokens: none,
        outputTokens: { sum: 50, reportedRuns: 1 },
        reasoningTokens: none,
        totalTokens: { sum: 150, reportedRuns: 1 },
      },
    ]);
    const oct = await seoul.monthly('2026-10');
    expect(oct.totalTokens.sum).toBe(30);
    expect(oct.labels.map((l) => [l.label, l.totalTokens.sum])).toEqual([
      ['openai:gpt-5', 20],
      ['gemini:g', 10],
    ]);
    // The same instants fall into different months in UTC.
    const utc = new ProviderUsageLedger(s.taskRuns, 'UTC');
    expect((await utc.monthly('2026-09')).runs).toBe(2);
    await s.close();
  });

  it('counts a provider that reported no count as an unknown run and adds nothing to the totals', async () => {
    const s = await store();
    await addRun(s, '2026-09-10T00:00:00.000Z', { label: 'claude:sonnet' });
    await addRun(s, '2026-09-11T00:00:00.000Z', { label: 'claude:sonnet' });
    await addRun(s, '2026-09-12T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    const sept = await new ProviderUsageLedger(s.taskRuns, KST).monthly('2026-09');
    expect(sept.labels.find((l) => l.label === 'claude:sonnet')).toMatchObject({ runs: 2, unknownRuns: 2, totalTokens: { sum: 0, reportedRuns: 0 } });
    expect(sept.totalTokens).toEqual({ sum: 10, reportedRuns: 1 });
    expect(sept.unknownRuns).toBe(2);
    await s.close();
  });

  it('tracks each field separately: an input-only, an output-only and a fully unknown run are never read as 0', async () => {
    const s = await store();
    await addRun(s, '2026-09-10T00:00:00.000Z', { label: 'codex', inputTokens: 1200 });
    await addRun(s, '2026-09-11T00:00:00.000Z', { label: 'codex', outputTokens: 80 });
    await addRun(s, '2026-09-12T00:00:00.000Z', { label: 'codex' });
    const sept = await new ProviderUsageLedger(s.taskRuns, KST).monthly('2026-09');
    expect(sept.labels).toEqual([
      {
        label: 'codex',
        runs: 3,
        unknownRuns: 3, // no run has a provider total, and none reported both input and output
        inputTokens: { sum: 1200, reportedRuns: 1 },
        cachedInputTokens: { sum: 0, reportedRuns: 0 },
        outputTokens: { sum: 80, reportedRuns: 1 },
        reasoningTokens: { sum: 0, reportedRuns: 0 },
        totalTokens: { sum: 0, reportedRuns: 0 },
      },
    ]);
    const text = monthlyUsageNoticeText(sept);
    expect(text).toContain('- codex: 3회, 입력 1,200 (1/3회 보고) · 출력 80 (1/3회 보고) · 합계 미보고');
    expect(text).toContain('3회 실행, 합계 미보고.');
    expect(text).not.toMatch(/합계 0|출력 0|입력 0/);

    // Input only: output and total are "미보고", and the run is unknown.
    const inputOnly = await store();
    await addRun(inputOnly, '2026-09-10T00:00:00.000Z', { label: 'openai:gpt-5', inputTokens: 500 });
    const one = await new ProviderUsageLedger(inputOnly.taskRuns, KST).monthly('2026-09');
    expect(one).toMatchObject({ runs: 1, unknownRuns: 1, totalTokens: { sum: 0, reportedRuns: 0 } });
    expect(monthlyUsageNoticeText(one)).toContain('- openai:gpt-5: 1회, 입력 500 · 출력 미보고 · 합계 미보고');
    // Output only, the same.
    const outputOnly = await store();
    await addRun(outputOnly, '2026-09-10T00:00:00.000Z', { label: 'openai:gpt-5', outputTokens: 70 });
    const out = await new ProviderUsageLedger(outputOnly.taskRuns, KST).monthly('2026-09');
    expect(monthlyUsageNoticeText(out)).toContain('- openai:gpt-5: 1회, 입력 미보고 · 출력 70 · 합계 미보고');
    expect(thresholdUsageNoticeText(out, 10)).toContain('1회 실행, 합계 미보고.');
    await s.close();
    await inputOnly.close();
    await outputOnly.close();
  });

  it('ignores runs without a usage record (their metadata is untouched) and an empty month is empty', async () => {
    const s = await store();
    await addRun(s, '2026-09-10T00:00:00.000Z', undefined, { promptSha256: 'x' });
    const sept = await new ProviderUsageLedger(s.taskRuns, KST).monthly('2026-09');
    expect(sept).toEqual({ month: '2026-09', labels: [], totalTokens: { sum: 0, reportedRuns: 0 }, runs: 0, unknownRuns: 0 });
    await s.close();
  });
});

function memoryState(): OpsNoticeLedgerStore & { content: string | undefined } {
  const st = { content: undefined as string | undefined, read: () => st.content, write: (c: string) => void (st.content = c) };
  return st;
}

interface Harness {
  readonly s: SqliteStorageProvider;
  readonly sent: Array<{ kind: UsageNoticeKind; text: string }>;
  readonly state: ReturnType<typeof memoryState>;
  readonly outcome: { value: UsageNoticeDelivery };
  readonly clock: { iso: string };
  job(threshold?: number): ProviderUsageNoticeJob;
}

const SENT: UsageNoticeDelivery = { status: 'SENT', via: 'dm' };
const RATE_LIMITED: UsageNoticeDelivery = { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true };
const TOO_LONG: UsageNoticeDelivery = { status: 'NOT_SENT', reason: 'TEXT_TOO_LONG', retryable: false };
const TIMEOUT: UsageNoticeDelivery = { status: 'UNCERTAIN', reason: 'TIMEOUT' };

async function harness(start = '2026-10-12T03:00:00.000Z'): Promise<Harness> {
  const s = await store();
  const sent: Harness['sent'] = [];
  const state = memoryState();
  const outcome: { value: UsageNoticeDelivery } = { value: SENT };
  const clock = { iso: start };
  return {
    s,
    sent,
    state,
    outcome,
    clock,
    job: (threshold) =>
      new ProviderUsageNoticeJob({
        ledger: new ProviderUsageLedger(s.taskRuns, KST),
        deliver: async (kind, text) => {
          sent.push({ kind, text });
          return outcome.value;
        },
        state,
        ...(threshold !== undefined ? { monthlyThreshold: threshold } : {}),
        logger: new RecordingLogger(),
        clock: () => clock.iso,
      }),
  };
}

describe('PRV-3 monthly usage DM (ADR-0115 D8)', () => {
  it('sends the PREVIOUS month once, per label, and never the current or an older month', async () => {
    const h = await harness();
    await addRun(h.s, '2026-08-15T00:00:00.000Z', { label: 'openai:gpt-5', inputTokens: 999, outputTokens: 1 });
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'openai:gpt-5', inputTokens: 1000, outputTokens: 500 });
    await addRun(h.s, '2026-09-16T00:00:00.000Z', { label: 'claude:sonnet' });
    await addRun(h.s, '2026-10-02T00:00:00.000Z', { label: 'gemini:g', inputTokens: 4242, outputTokens: 1 });
    const job = h.job();
    await job.checkOnce();
    expect(h.sent).toHaveLength(1);
    const { kind, text } = h.sent[0] as Harness['sent'][number];
    expect(kind).toBe('PROVIDER_USAGE_MONTHLY');
    expect(text).toContain('2026-09');
    expect(text).toContain('openai:gpt-5: 1회, 입력 1,000 · 출력 500 · 합계 1,500 토큰');
    expect(text).toContain('claude:sonnet: 1회, 입력 미보고 · 출력 미보고 · 합계 미보고');
    expect(text).toContain('2회 실행, 합계 1,500 토큰 (1/2회 보고).');
    expect(text).not.toContain('gemini:g');
    expect(text).not.toContain('999');
    expect(text).not.toContain('4,242');
    await job.checkOnce();
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.state.content as string)).toEqual({
      version: 1,
      monthlyReportedFor: '2026-09',
      monthlyAttempts: { month: '2026-09', count: 1, outcome: 'SENT' },
    });
    await h.s.close();
  });

  it('is once per month across restarts (a new job reads the persisted record), and reports the next month later', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    await addRun(h.s, '2026-10-15T00:00:00.000Z', { label: 'codex', inputTokens: 7, outputTokens: 3 });
    await h.job().checkOnce();
    await h.job().checkOnce();
    expect(h.sent).toHaveLength(1);
    h.clock.iso = '2026-11-02T03:00:00.000Z';
    await h.job().checkOnce();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.text).toContain('2026-10');
    expect(h.sent[1]?.text).toContain('1회 실행, 합계 10 토큰.');
    await h.s.close();
  });

  it('sends nothing, and records nothing, when the previous month has no usage', async () => {
    const h = await harness();
    await addRun(h.s, '2026-10-02T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    await h.job().checkOnce();
    expect(h.sent).toEqual([]);
    expect(h.state.content).toBeUndefined();
    await h.s.close();
  });

  it('never resends after UNCERTAIN (it may have been delivered), in the same process or after a restart', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    h.outcome.value = TIMEOUT;
    const job = h.job();
    await job.checkOnce();
    await job.checkOnce();
    h.outcome.value = SENT;
    await h.job().checkOnce();
    await h.job().checkOnce();
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.state.content as string)).toEqual({
      version: 1,
      monthlyReportedFor: '2026-09',
      monthlyAttempts: { month: '2026-09', count: 1, outcome: 'UNCERTAIN' },
    });
    await h.s.close();
  });

  it('retries a retryable NOT_SENT at most 3 times in a month, across restarts, then gives up for that month', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    h.outcome.value = RATE_LIMITED;
    for (let i = 0; i < 6; i += 1) await h.job().checkOnce(); // a new job each time = a restart between evaluations
    expect(h.sent).toHaveLength(3);
    expect(JSON.parse(h.state.content as string)).toMatchObject({ monthlyReportedFor: '2026-09', monthlyAttempts: { month: '2026-09', count: 3 } });
    h.outcome.value = SENT;
    await h.job().checkOnce();
    expect(h.sent).toHaveLength(3);
    // The next month starts a fresh budget.
    await addRun(h.s, '2026-10-15T00:00:00.000Z', { label: 'codex', inputTokens: 1, outputTokens: 1 });
    h.clock.iso = '2026-11-02T03:00:00.000Z';
    await h.job().checkOnce();
    expect(h.sent).toHaveLength(4);
    expect(h.sent[3]?.text).toContain('2026-10');
    await h.s.close();
  });

  it('a retryable NOT_SENT or NO_OWNER followed by SENT within the budget is delivered once', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    h.outcome.value = { status: 'NO_OWNER' };
    await h.job().checkOnce();
    h.outcome.value = RATE_LIMITED;
    await h.job().checkOnce();
    h.outcome.value = SENT;
    await h.job().checkOnce();
    await h.job().checkOnce();
    expect(h.sent).toHaveLength(3);
    expect(JSON.parse(h.state.content as string)).toMatchObject({ monthlyReportedFor: '2026-09', monthlyAttempts: { count: 3 } });
    await h.s.close();
  });

  it('never retries a non-retryable NOT_SENT (TEXT_TOO_LONG): given up for the month, also after a restart', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    h.outcome.value = TOO_LONG;
    const job = h.job();
    await job.checkOnce();
    await job.checkOnce();
    h.outcome.value = SENT;
    await h.job().checkOnce();
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.state.content as string)).toMatchObject({ monthlyReportedFor: '2026-09' });
    await h.s.close();
  });

  it('takes an attempt left in flight by a crash between the record and the send as UNCERTAIN: done, never sent', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    await addRun(h.s, '2026-10-02T00:00:00.000Z', { label: 'codex', inputTokens: 600, outputTokens: 600 });
    // The in-flight records were written and the process died before the send (it never happened): fail closed.
    h.state.content = JSON.stringify({
      version: 1,
      monthlyAttempts: { month: '2026-09', count: 1, inFlight: true },
      thresholdAttempts: { month: '2026-10', count: 1, inFlight: true },
    });
    await h.job(1000).checkOnce();
    await h.job(1000).checkOnce();
    expect(h.sent).toEqual([]);
    expect(JSON.parse(h.state.content)).toEqual({
      version: 1,
      monthlyReportedFor: '2026-09',
      monthlyAttempts: { month: '2026-09', count: 1, outcome: 'UNCERTAIN' },
      thresholdSentIn: '2026-10',
      thresholdAttempts: { month: '2026-10', count: 1, outcome: 'UNCERTAIN' },
    });
    await h.s.close();
  });

  it.each([
    ['SENT', 'PROVIDER_USAGE_MONTHLY', SENT],
    ['SENT', 'PROVIDER_USAGE_THRESHOLD', SENT],
    ['UNCERTAIN', 'PROVIDER_USAGE_MONTHLY', TIMEOUT],
    ['UNCERTAIN', 'PROVIDER_USAGE_THRESHOLD', TIMEOUT],
  ] as const)('a failed settling write after %s (%s): a restart does not send again', async (_name, kind, result) => {
    const h = await harness();
    // Only the kind under test is due: last month's usage for the monthly DM, this month's over the threshold for the other.
    if (kind === 'PROVIDER_USAGE_MONTHLY') await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    else await addRun(h.s, '2026-10-02T00:00:00.000Z', { label: 'codex', inputTokens: 600, outputTokens: 600 });
    let disk: string | undefined;
    let failSettling = true;
    // The in-flight record reaches the disk; the outcome write fails while `failSettling` is set.
    const store: OpsNoticeLedgerStore = {
      read: () => disk,
      write: (content) => {
        if (failSettling && !content.includes('"inFlight":true')) throw new Error('ENOSPC');
        disk = content;
      },
    };
    const sent: UsageNoticeKind[] = [];
    const job = () =>
      new ProviderUsageNoticeJob({
        ledger: new ProviderUsageLedger(h.s.taskRuns, KST),
        deliver: async (k) => {
          sent.push(k);
          return result;
        },
        state: store,
        ...(kind === 'PROVIDER_USAGE_THRESHOLD' ? { monthlyThreshold: 1000 } : {}),
        logger: new RecordingLogger(),
        clock: () => h.clock.iso,
      });
    const first = job();
    await first.checkOnce();
    await first.checkOnce(); // same process: memory holds the settlement
    expect(sent).toEqual([kind]);
    const key = kind === 'PROVIDER_USAGE_MONTHLY' ? 'monthlyAttempts' : 'thresholdAttempts';
    expect(JSON.parse(disk as string)[key]).toMatchObject({ count: 1, inFlight: true }); // the outcome never reached the disk
    failSettling = false;
    await job().checkOnce(); // a restart reads the in-flight record as UNCERTAIN
    await job().checkOnce();
    expect(sent).toEqual([kind]);
    expect(JSON.parse(disk as string)[key]).toEqual({ month: kind === 'PROVIDER_USAGE_MONTHLY' ? '2026-09' : '2026-10', count: 1, outcome: 'UNCERTAIN' });
    await h.s.close();
  });

  it('a recorded retryable NOT_SENT is retried after a restart, up to the cap', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    h.state.content = JSON.stringify({ version: 1, monthlyAttempts: { month: '2026-09', count: 2, outcome: 'NOT_SENT', retryable: true } });
    h.outcome.value = RATE_LIMITED;
    await h.job().checkOnce();
    await h.job().checkOnce();
    expect(h.sent).toHaveLength(1); // the third and last attempt
    expect(JSON.parse(h.state.content)).toEqual({
      version: 1,
      monthlyReportedFor: '2026-09',
      monthlyAttempts: { month: '2026-09', count: 3, outcome: 'NOT_SENT', retryable: true },
    });
    // A record with no explicit retryable outcome (or a non-retryable one) is never retried.
    const g = await harness();
    await addRun(g.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    g.state.content = JSON.stringify({ version: 1, monthlyAttempts: { month: '2026-09', count: 1, outcome: 'NOT_SENT', retryable: false } });
    await g.job().checkOnce();
    g.state.content = JSON.stringify({ version: 1, monthlyAttempts: { month: '2026-09', count: 1 } });
    await g.job().checkOnce();
    expect(g.sent).toEqual([]);
    await h.s.close();
    await g.s.close();
  });

  it('a failed state write never causes a second send in the process, though the file still holds the stale record', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    let writes = 0;
    let disk: string | undefined;
    const flaky: OpsNoticeLedgerStore = {
      read: () => disk,
      write: (content) => {
        writes += 1;
        if (writes === 2) throw new Error('ENOSPC'); // the settling write after SENT fails; disk keeps the attempt record
        disk = content;
      },
    };
    const job = new ProviderUsageNoticeJob({
      ledger: new ProviderUsageLedger(h.s.taskRuns, KST),
      deliver: async (kind, text) => {
        h.sent.push({ kind, text });
        return SENT;
      },
      state: flaky,
      logger: new RecordingLogger(),
      clock: () => h.clock.iso,
    });
    await job.checkOnce();
    expect(JSON.parse(disk as string)).toEqual({ version: 1, monthlyAttempts: { month: '2026-09', count: 1, inFlight: true } }); // stale: not settled
    await job.checkOnce();
    await job.checkOnce();
    expect(h.sent).toHaveLength(1);
    await h.s.close();
  });

  it('an unreadable state file skips the evaluation (nothing sent) instead of reading as empty', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    const logger = new RecordingLogger();
    const job = new ProviderUsageNoticeJob({
      ledger: new ProviderUsageLedger(h.s.taskRuns, KST),
      deliver: async (kind, text) => {
        h.sent.push({ kind, text });
        return SENT;
      },
      state: { read: () => { throw new Error('EACCES'); }, write: () => undefined },
      logger,
      clock: () => h.clock.iso,
    });
    await job.checkOnce();
    expect(h.sent).toEqual([]);
    expect(logger.lines.some((l) => l.message === 'provider_usage.notice.failed')).toBe(true);
    await h.s.close();
  });

  it('sends nothing when the attempt record cannot be written (fail closed: the bound must hold across restarts)', async () => {
    const h = await harness();
    await addRun(h.s, '2026-09-15T00:00:00.000Z', { label: 'codex', inputTokens: 5, outputTokens: 5 });
    const broken: OpsNoticeLedgerStore = { read: () => undefined, write: () => { throw new Error('ENOSPC'); } };
    const job = new ProviderUsageNoticeJob({
      ledger: new ProviderUsageLedger(h.s.taskRuns, KST),
      deliver: async (kind, text) => {
        h.sent.push({ kind, text });
        return SENT;
      },
      state: broken,
      logger: new RecordingLogger(),
      clock: () => h.clock.iso,
    });
    await job.checkOnce();
    await job.checkOnce();
    expect(h.sent).toEqual([]);
    await h.s.close();
  });
});

describe('PRV-3 threshold DM (ADR-0115 D8)', () => {
  it('fires once, when the month total tokens (all labels) first reach the threshold, and never when unset', async () => {
    const h = await harness();
    await addRun(h.s, '2026-10-02T00:00:00.000Z', { label: 'openai:gpt-5', inputTokens: 400, outputTokens: 100 });
    const job = h.job(1000);
    await job.checkOnce();
    expect(h.sent).toEqual([]); // 500 < 1000
    await addRun(h.s, '2026-10-05T00:00:00.000Z', { label: 'gemini:g', inputTokens: 400, outputTokens: 100 });
    await job.checkOnce();
    expect(h.sent).toHaveLength(1); // exactly 1000: reached
    expect(h.sent[0]?.kind).toBe('PROVIDER_USAGE_THRESHOLD');
    expect(h.sent[0]?.text).toContain('1,000 토큰');
    expect(h.sent[0]?.text).toContain('openai:gpt-5');
    expect(h.sent[0]?.text).toContain('gemini:g');
    await addRun(h.s, '2026-10-06T00:00:00.000Z', { label: 'gemini:g', inputTokens: 9000, outputTokens: 1 });
    await job.checkOnce();
    await h.job(1000).checkOnce();
    expect(h.sent.filter((n) => n.kind === 'PROVIDER_USAGE_THRESHOLD')).toHaveLength(1);

    const unset = await harness();
    await addRun(unset.s, '2026-10-02T00:00:00.000Z', { label: 'openai:gpt-5', inputTokens: 9_000_000, outputTokens: 1 });
    await unset.job().checkOnce();
    expect(unset.sent).toEqual([]);
    await h.s.close();
    await unset.s.close();
  });

  it('may fire again in a later month, and a new month starts from zero', async () => {
    const h = await harness();
    await addRun(h.s, '2026-10-02T00:00:00.000Z', { label: 'codex', inputTokens: 600, outputTokens: 600 });
    await h.job(1000).checkOnce();
    expect(h.sent.map((n) => n.kind)).toEqual(['PROVIDER_USAGE_THRESHOLD']);
    h.clock.iso = '2026-11-03T03:00:00.000Z';
    await h.job(1000).checkOnce();
    // November has no usage yet: only the monthly DM for October is due.
    expect(h.sent.map((n) => n.kind)).toEqual(['PROVIDER_USAGE_THRESHOLD', 'PROVIDER_USAGE_MONTHLY']);
    await addRun(h.s, '2026-11-02T00:00:00.000Z', { label: 'codex', inputTokens: 600, outputTokens: 600 });
    await h.job(1000).checkOnce();
    expect(h.sent.map((n) => n.kind)).toEqual(['PROVIDER_USAGE_THRESHOLD', 'PROVIDER_USAGE_MONTHLY', 'PROVIDER_USAGE_THRESHOLD']);
    await h.s.close();
  });

  it('retries only a retryable outcome, within its own 3-attempt budget, and never after UNCERTAIN', async () => {
    const h = await harness();
    await addRun(h.s, '2026-10-02T00:00:00.000Z', { label: 'codex', inputTokens: 600, outputTokens: 600 });
    h.outcome.value = RATE_LIMITED;
    await h.job(1000).checkOnce();
    await h.job(1000).checkOnce();
    expect(h.sent).toHaveLength(2);
    h.outcome.value = SENT;
    await h.job(1000).checkOnce();
    await h.job(1000).checkOnce();
    expect(h.sent).toHaveLength(3);
    expect(JSON.parse(h.state.content as string)).toMatchObject({ thresholdSentIn: '2026-10', thresholdAttempts: { month: '2026-10', count: 3 } });

    const u = await harness();
    await addRun(u.s, '2026-10-02T00:00:00.000Z', { label: 'codex', inputTokens: 600, outputTokens: 600 });
    u.outcome.value = TIMEOUT;
    for (let i = 0; i < 4; i += 1) await u.job(1000).checkOnce();
    expect(u.sent).toHaveLength(1);
    const v = await harness();
    await addRun(v.s, '2026-10-02T00:00:00.000Z', { label: 'codex', inputTokens: 600, outputTokens: 600 });
    v.outcome.value = TOO_LONG;
    for (let i = 0; i < 4; i += 1) await v.job(1000).checkOnce();
    expect(v.sent).toHaveLength(1);
    await h.s.close();
    await u.s.close();
    await v.s.close();
  });
});

describe('PRV-3 notice text and state file', () => {
  const none = { sum: 0, reportedRuns: 0 };
  const usage = {
    month: '2026-09',
    runs: 3,
    unknownRuns: 1,
    totalTokens: { sum: 1650, reportedRuns: 2 },
    labels: [
      {
        label: 'openai:gpt-5',
        runs: 2,
        unknownRuns: 0,
        inputTokens: { sum: 1000, reportedRuns: 2 },
        cachedInputTokens: none,
        outputTokens: { sum: 650, reportedRuns: 2 },
        reasoningTokens: none,
        totalTokens: { sum: 1650, reportedRuns: 2 },
      },
      { label: 'claude:sonnet', runs: 1, unknownRuns: 1, inputTokens: none, cachedInputTokens: none, outputTokens: none, reasoningTokens: none, totalTokens: none },
    ],
  };

  it('carries totals only, and a count nobody reported reads "미보고", never 0', () => {
    expect(monthlyUsageNoticeText(usage)).toBe(
      '[Quoky 사용량 알림] 2026-09 공급자별 사용량이에요. 3회 실행, 합계 1,650 토큰 (2/3회 보고).\n' +
        '- openai:gpt-5: 2회, 입력 1,000 · 출력 650 · 합계 1,650 토큰\n' +
        '- claude:sonnet: 1회, 입력 미보고 · 출력 미보고 · 합계 미보고\n' +
        '토큰 수는 공급자가 알려준 것만 더하고, 알려주지 않은 값은 "미보고"로 표시해요. 공급자는 자동으로 바꾸지 않아요. 자세한 내용은 운영 화면에서 확인해 주세요.',
    );
    expect(thresholdUsageNoticeText(usage, 1000)).toContain('설정한 월 기준(1,000 토큰)에 도달했어요');
  });

  it('always fits one delivered message: 50 labels show the top ones by total tokens, then "외 K개"', () => {
    const labels = Array.from({ length: 50 }, (_, i) => {
      const total = (50 - i) * 1_000_000;
      const count = { sum: total, reportedRuns: 7 };
      return {
        label: `openai:${'m'.repeat(100)}-${String(i).padStart(2, '0')}`,
        runs: 7,
        unknownRuns: 0,
        inputTokens: count,
        cachedInputTokens: count,
        outputTokens: count,
        reasoningTokens: count,
        totalTokens: count,
      };
    });
    const many = { month: '2026-09', runs: 350, unknownRuns: 0, totalTokens: { sum: 1_275_000_000, reportedRuns: 350 }, labels };
    for (const text of [monthlyUsageNoticeText(many), thresholdUsageNoticeText(many, 1_000_000)]) {
      expect(Array.from(text).length).toBeLessThanOrEqual(REMINDER_LIMITS.maxDeliveredTextChars);
      const shown = labels.filter((l) => text.includes(`- ${l.label}:`)).length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(50);
      // The shown labels are the largest ones, in order, and the rest is counted.
      expect(labels.slice(0, shown).every((l) => text.includes(`- ${l.label}:`))).toBe(true);
      expect(text).toContain(`\n- 외 ${50 - shown}개\n`);
      expect(text.endsWith('운영 화면에서 확인해 주세요.')).toBe(true);
    }
    // When everything fits nothing is hidden.
    expect(monthlyUsageNoticeText({ ...many, labels: labels.slice(0, 2) })).not.toContain('외 ');
  });

  it('parses a corrupt or foreign state file as empty', () => {
    expect(parseUsageNoticeState('not json')).toEqual({});
    expect(parseUsageNoticeState('{"version":2,"monthlyReportedFor":"2026-09"}')).toEqual({});
    expect(parseUsageNoticeState('{"version":1,"monthlyReportedFor":"bogus","thresholdSentIn":"2026-10"}')).toEqual({ thresholdSentIn: '2026-10' });
    expect(parseUsageNoticeState('{"version":1,"monthlyAttempts":{"month":"2026-09","count":2},"thresholdAttempts":{"month":"2026-10","count":-1}}')).toEqual({
      monthlyAttempts: { month: '2026-09', count: 2 },
    });
  });
});

describe('PRV-3: the ledger has no write path to provider selection (ADR-0115 D8)', () => {
  it('runs end to end touching nothing but the one read-only query', async () => {
    const touched: string[] = [];
    const real: ProviderUsageSource = {
      forEachUsageFinishedBetween: async () => {
        touched.push('forEachUsageFinishedBetween');
      },
    };
    const guarded = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== 'forEachUsageFinishedBetween') throw new Error(`unexpected access: ${String(prop)}`);
        return Reflect.get(target, prop, receiver);
      },
    });
    const job = new ProviderUsageNoticeJob({
      ledger: new ProviderUsageLedger(guarded, KST),
      deliver: async () => SENT,
      monthlyThreshold: 1,
      logger: new RecordingLogger(),
      clock: () => '2026-10-12T00:00:00.000Z',
    });
    await job.checkOnce();
    expect(new Set(touched)).toEqual(new Set(['forEachUsageFinishedBetween']));
  });

  it('its modules import no provider selection, registration, routing or provider package', () => {
    for (const file of ['provider-usage.ts', 'provider-usage-notice.ts']) {
      const source = readFileSync(path.join(__dirname, file), 'utf8');
      const imports = source.split('\n').filter((line) => /^\s*import\b|^\s*}\s*from\b/.test(line)).join('\n');
      expect(imports, file).not.toMatch(/provider-selection|provider-routing|AiProviderManager|ProviderSelect|@quoky\/ai-/);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/setDefault|setChat|setImage|registerProvider|\.register\(|rank|setSelection|switchProvider|disableProvider/i);
    }
  });
});

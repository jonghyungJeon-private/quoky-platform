import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Capability, FeedbackSignalKind, IntentType, LEARNING_EGRESS_LOCAL_ONLY, LearningItemKind, ProviderDispatchState,
  TaskRunStatus,
} from '@quoky/core';
import type { ConversationTurnRecord, FeedbackSignal, LearningItem } from '@quoky/core';
import { SqliteStorageProvider, openLearningReportReader } from '@quoky/storage-sqlite';
import type { LearningReportItem, LearningReportTurn } from '@quoky/storage-sqlite';
import {
  EXIT_BLOCKED, EXIT_OK, EXIT_USAGE, MIN_COMPARISON_TURNS, buildLearningReport, renderLearningReportMarkdown, runCli,
} from './learning-report';
import type { BuildReportInput, LearningReport, LearningReportCliDeps } from './learning-report';

const NOW = '2026-10-06T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY = 24 * 60 * 60 * 1000;
// Built by concatenation so no credential-shaped literal sits in the source.
const CREDENTIAL = `비밀번호는 ${'hunter2'}-${'secret'} 이야`;
const REQUEST = '내일 오후 회의 일정 알려줘';
const NOTE = '일정 대신 날씨를 답했어';
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-learning-report-'));
  dirs.push(dir);
  return dir;
}

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY).toISOString();
}

function turn(id: string, over: Partial<LearningReportTurn> = {}): LearningReportTurn {
  return {
    turnId: id, actorId: 'actor-1', createdAt: daysAgo(1), capability: Capability.GENERAL_CHAT, intentType: 'CHAT',
    runId: `run-${id}`, fingerprint: [], positive: 0, negative: 0, implicitCorrection: 0, implicitOther: 0,
    runFound: true, curatedExampleCount: null, ...over,
  };
}

function item(over: Partial<LearningItem> = {}): LearningItem {
  return {
    id: 'item-1', actorId: 'actor-1', kind: LearningItemKind.GOLDEN_CANDIDATE, capability: 'GENERAL_CHAT', language: 'ko',
    sourceTurnId: 'bad-1', egress: LEARNING_EGRESS_LOCAL_ONLY, createdAt: daysAgo(2), expiresAt: daysAgoPlus(363),
    data: { requestText: REQUEST, note: NOTE, sourceRating: 'NEGATIVE', intentType: IntentType.CHAT },
    ...over,
  };
}

function daysAgoPlus(days: number): string {
  return new Date(NOW_MS + days * DAY).toISOString();
}

function rows(items: LearningItem[], expired: readonly string[] = []): LearningReportItem[] {
  return items.map((i) => ({ item: i, expired: expired.includes(i.id) }));
}

function input(turns: LearningReportTurn[], items: LearningReportItem[] = [], over: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    now: NOW, windowsDays: [7, 30, 90], turns, items, turnsTruncated: false, actorFiltered: false, includeItemText: true,
    maxCandidates: 50, minCluster: 2, ...over,
  };
}

describe('buildLearningReport (ADR-0107 D8, pure)', () => {
  it('aggregates feedback by capability and intent over trailing windows with the D3 rate', () => {
    const turns = [
      turn('a', { negative: 1, createdAt: daysAgo(2) }),
      turn('b', { positive: 1, createdAt: daysAgo(3) }),
      turn('c', { createdAt: daysAgo(20), capability: Capability.CODE_REVIEW, intentType: 'REVIEW_CODE', negative: 1 }),
      turn('d', { createdAt: daysAgo(60), negative: 1, implicitCorrection: 1 }),
    ];
    const report = buildLearningReport(input(turns));
    const [w7, w30, w90] = report.windows;
    expect(w7?.overall).toMatchObject({ turns: 2, positive: 1, negative: 1, negativeRate: 0.5 });
    expect(w30?.overall).toMatchObject({ turns: 3, negative: 2, negativeRate: 0.6667 });
    expect(w90?.overall).toMatchObject({ turns: 4, negative: 3, implicitCorrection: 1, negativeRate: 0.75 });
    expect(w30?.byCapability.map((r) => [r.key, r.turns, r.negative])).toEqual([['CODE_REVIEW', 1, 1], ['GENERAL_CHAT', 2, 1]]);
    expect(w90?.byIntent.map((r) => r.key)).toEqual(['CHAT', 'REVIEW_CODE']);
    expect(w7?.since).toBe(daysAgo(7));
  });

  it('computes the 30-day trend against the previous 30 days', () => {
    const turns = [
      turn('n1', { createdAt: daysAgo(5), negative: 1 }),
      turn('n2', { createdAt: daysAgo(6) }),
      turn('p1', { createdAt: daysAgo(40) }),
      turn('p2', { createdAt: daysAgo(41) }),
      turn('p3', { createdAt: daysAgo(42), capability: null as never }),
      turn('old', { createdAt: daysAgo(70), negative: 1 }),
    ];
    const { trend } = buildLearningReport(input(turns));
    expect(trend.days).toBe(30);
    const chat = trend.rows.find((r) => r.capability === 'GENERAL_CHAT');
    expect(chat?.current).toMatchObject({ turns: 2, negative: 1, negativeRate: 0.5 });
    expect(chat?.previous).toMatchObject({ turns: 2, negative: 0, negativeRate: 0 });
    expect(chat?.deltaPoints).toBe(50);
    expect(trend.rows.find((r) => r.capability === '(none)')?.deltaPoints).toBeNull();
  });

  it('compares the 👎 rate of GENERAL_CHAT runs with and without curated examples (LRN-2 metadata)', () => {
    const turns: LearningReportTurn[] = [];
    for (let i = 0; i < MIN_COMPARISON_TURNS; i += 1) {
      turns.push(turn(`w${i}`, { curatedExampleCount: 2, negative: i < 2 ? 1 : 0 }));
      turns.push(turn(`o${i}`, { curatedExampleCount: null, negative: i < 5 ? 1 : 0 }));
    }
    turns.push(turn('norun', { runFound: false, runId: null, negative: 1 }));
    turns.push(turn('code', { capability: Capability.CODE_REVIEW, curatedExampleCount: 1 }));
    const usage = buildLearningReport(input(turns)).windows[0]?.curatedUsage;
    expect(usage).toMatchObject({ chatTurnsWithRun: 40, chatTurnsWithoutRun: 1, lowSample: false, deltaPoints: -15 });
    expect(usage?.withExamples).toMatchObject({ turns: 20, negative: 2, negativeRate: 0.1 });
    expect(usage?.withoutExamples).toMatchObject({ turns: 20, negative: 5, negativeRate: 0.25 });
  });

  it('flags a small with/without sample and proposes no threshold change', () => {
    const turns = [turn('w', { curatedExampleCount: 1, negative: 1 }), turn('o')];
    const report = buildLearningReport(input(turns));
    expect(report.windows[0]?.curatedUsage.lowSample).toBe(true);
    const recall = report.proposals.find((p) => p.area === 'EMBEDDING_RECALL');
    expect(recall?.summary).toContain('Too few turns');
    expect(recall?.summary).toContain('unchanged');
  });

  it('notes that the thresholds have no measurement when no run carried examples', () => {
    const recall = buildLearningReport(input([turn('o')])).proposals.find((p) => p.area === 'EMBEDDING_RECALL');
    expect(recall?.summary).toContain('No GENERAL_CHAT run carried curated examples');
  });

  it('counts learning items by status, kind, egress and expiry', () => {
    const items = rows([
      item({ id: 'g1', expiresAt: daysAgoPlus(10) }),
      item({ id: 'g2', expiresAt: daysAgoPlus(60) }),
      item({ id: 'e1', kind: LearningItemKind.EXAMPLE, expiresAt: daysAgoPlus(120), language: 'en', data: { requestText: 'q', idealAnswer: 'a', sourceRating: 'POSITIVE' } }),
      item({ id: 'e2', kind: LearningItemKind.EXAMPLE, expiresAt: daysAgoPlus(300), actorId: 'actor-2' }),
      item({ id: 'old', expiresAt: daysAgo(1) }),
      item({ id: 'leak', data: { requestText: CREDENTIAL, note: NOTE, sourceRating: 'NEGATIVE' }, expiresAt: daysAgoPlus(10) }),
      item({ id: 'wide', egress: 'ANYWHERE' as never, expiresAt: daysAgoPlus(10) }),
    ], ['old']);
    const li = buildLearningReport(input([], items)).learningItems;
    expect(li).toMatchObject({ total: 7, active: 6, expired: 1, guardRefused: 1, nonLocalEgress: 1, maxActivePerActor: 5, capPerActor: 1000 });
    expect(li.byKind).toEqual({ EXAMPLE: { active: 2, expired: 0 }, GOLDEN_CANDIDATE: { active: 4, expired: 1 } });
    expect(li.byEgress).toEqual({ ANYWHERE: 1, LOCAL_ONLY: 6 });
    expect(li.expiry).toEqual({ within30d: 3, within90d: 1, within180d: 1, later: 1 });
    expect(li.activeByLanguage).toEqual({ en: 1, ko: 5 });
    expect(li.activeBySourceRating).toEqual({ NEGATIVE: 5, POSITIVE: 1 });
  });

  it('lists only 👎 GENERAL_CHAT turns as candidate misroutes, newest first, without any message text', () => {
    const turns = [
      turn('bad-1', { negative: 1, createdAt: daysAgo(3), curatedExampleCount: 1 }),
      turn('bad-2', { negative: 1, createdAt: daysAgo(1), implicitCorrection: 1 }),
      turn('ok', { positive: 1 }),
      turn('code', { negative: 1, capability: Capability.CODE_REVIEW }),
      turn('policy', { negative: 1, capability: Capability.POLICY_SENSITIVE_CHAT }),
      turn('old', { negative: 1, createdAt: daysAgo(200) }),
    ];
    const mc = buildLearningReport(input(turns)).misrouteCandidates;
    expect(mc.windowDays).toBe(90);
    expect(mc.total).toBe(2);
    expect(mc.listed.map((c) => c.turnId)).toEqual(['bad-2', 'bad-1']);
    expect(mc.listed[1]).toMatchObject({ ranCuratedExamples: true, intentType: 'CHAT' });
    expect(mc.listed[0]).toMatchObject({ ranCuratedExamples: false, implicitCorrection: 1 });
    expect(mc.listed.every((c) => c.approvedItem === undefined)).toBe(true);
    expect(buildLearningReport(input(turns, [], { maxCandidates: 1 })).misrouteCandidates.listed).toHaveLength(1);
  });

  it('prints text only for an owner-approved, LOCAL_ONLY, unexpired, guard-clean item of a candidate turn', () => {
    const turns = [
      turn('bad-1', { negative: 1 }), turn('bad-2', { negative: 1 }), turn('bad-3', { negative: 1 }),
      turn('bad-4', { negative: 1 }), turn('bad-5', { negative: 1 }), turn('bad-6', { negative: 1 }),
    ];
    const items = rows([
      item(),
      item({ id: 'leak', sourceTurnId: 'bad-2', data: { requestText: CREDENTIAL, note: NOTE, sourceRating: 'NEGATIVE' } }),
      item({ id: 'leak-note', sourceTurnId: 'bad-3', data: { requestText: REQUEST, note: CREDENTIAL, sourceRating: 'NEGATIVE' } }),
      item({ id: 'old', sourceTurnId: 'bad-4' }),
      item({ id: 'wide', sourceTurnId: 'bad-5', egress: 'ANYWHERE' as never }),
      item({ id: 'ex', sourceTurnId: 'bad-6', kind: LearningItemKind.EXAMPLE, data: { requestText: '예시 요청', idealAnswer: 'IDEAL_ANSWER_TEXT', sourceRating: 'POSITIVE' } }),
    ], ['old']);
    const report = buildLearningReport(input(turns, items));
    const byId = new Map(report.misrouteCandidates.listed.map((c) => [c.turnId, c]));
    expect(byId.get('bad-1')?.approvedItem).toEqual({
      itemId: 'item-1', kind: 'GOLDEN_CANDIDATE', requestExcerpt: `"${REQUEST}"`, noteExcerpt: `"${NOTE}"`,
    });
    for (const id of ['bad-2', 'bad-3', 'bad-4', 'bad-5']) expect(byId.get(id)?.approvedItem, id).toBeUndefined();
    expect(byId.get('bad-6')?.approvedItem?.requestExcerpt).toBe('"예시 요청"');
    const everything = JSON.stringify(report) + renderLearningReportMarkdown(report);
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('IDEAL_ANSWER_TEXT');
    expect(everything).toContain(REQUEST);
  });

  it('bounds an approved item excerpt and keeps it on one line', () => {
    const long = `${'가'.repeat(300)}\n둘째 줄 @everyone`;
    const report = buildLearningReport(input([turn('bad-1', { negative: 1 })], rows([
      item({ data: { requestText: long, note: long, sourceRating: 'NEGATIVE' } }),
    ])));
    const approved = report.misrouteCandidates.listed[0]?.approvedItem;
    expect([...(approved?.requestExcerpt ?? '')].length).toBeLessThanOrEqual(64);
    expect(approved?.requestExcerpt).not.toContain('\n');
    expect(approved?.requestExcerpt).not.toContain('둘째');
  });

  it('prints no item text at all with includeItemText off', () => {
    const report = buildLearningReport(input([turn('bad-1', { negative: 1 })], rows([item()]), { includeItemText: false }));
    expect(report.scope.itemText).toBe(false);
    const text = JSON.stringify(report) + renderLearningReportMarkdown(report);
    expect(text).not.toContain(REQUEST);
    expect(text).not.toContain(NOTE);
  });

  it('clusters 👎 and correction turns by keyword hash, skips ubiquitous tokens and proposes reviewed PR work', () => {
    const turns: LearningReportTurn[] = [];
    for (let i = 0; i < 12; i += 1) turns.push(turn(`ok${i}`, { fingerprint: ['aaaaaaaa'], createdAt: daysAgo(i + 1) }));
    turns.push(turn('s1', { negative: 1, fingerprint: ['aaaaaaaa', 'b0b0b0b0'], createdAt: daysAgo(1) }));
    turns.push(turn('s2', { implicitCorrection: 1, fingerprint: ['aaaaaaaa', 'b0b0b0b0'], createdAt: daysAgo(2) }));
    turns.push(turn('s3', { negative: 1, fingerprint: ['aaaaaaaa', 'c1c1c1c1'], createdAt: daysAgo(3) }));
    const { clusters, proposals } = buildLearningReport(input(turns));
    expect(clusters.rows.map((c) => c.token)).toEqual(['b0b0b0b0']);
    expect(clusters.rows[0]).toMatchObject({ signalTurns: 2, totalTurns: 2, signalRate: 1, sampleTurnIds: ['s1', 's2'] });
    expect(clusters.rows[0]?.capabilities).toEqual({ GENERAL_CHAT: 2 });
    expect(proposals.map((p) => p.area)).toEqual(['GOLDEN_CASE', 'HANDLER_PATTERN', 'EMBEDDING_RECALL']);
    expect(proposals[0]?.summary).toContain('reviewed PR');
    expect(proposals[1]?.summary).toContain('do not add one from the hash alone');
    expect(buildLearningReport(input(turns, [], { minCluster: 3 })).clusters.rows).toEqual([]);
  });

  it('is deterministic and independent of input order', () => {
    const turns = [
      turn('a', { negative: 1, fingerprint: ['11111111', '22222222'] }),
      turn('b', { negative: 1, fingerprint: ['11111111', '22222222'], createdAt: daysAgo(2) }),
      turn('c', { positive: 1, capability: Capability.CODE_REVIEW }),
    ];
    const first = renderLearningReportMarkdown(buildLearningReport(input(turns)));
    expect(renderLearningReportMarkdown(buildLearningReport(input([...turns].reverse())))).toBe(first);
    expect(renderLearningReportMarkdown(buildLearningReport(input(turns)))).toBe(first);
    expect(first).toContain('# Quoky learning report');
    expect(first).toContain('Generated 2026-10-06T12:00:00.000Z');
  });

  it('rejects an invalid clock or empty windows', () => {
    expect(() => buildLearningReport(input([], [], { now: 'not-a-date' }))).toThrow('REPORT_NOW_INVALID');
    expect(() => buildLearningReport(input([], [], { windowsDays: [] }))).toThrow('REPORT_WINDOWS_INVALID');
  });
});

describe('learning-report CLI (offline, read-only DB)', () => {
  function deps(over: Partial<LearningReportCliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const base: LearningReportCliDeps = {
      now: () => NOW,
      env: {},
      openReader: openLearningReportReader,
      writeNewFile: (path, content) => writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
      stdout: (text) => out.push(text),
      stderr: (line) => err.push(line),
      ...over,
    };
    return { deps: base, out, err };
  }

  function record(id: string, over: Partial<ConversationTurnRecord> = {}): ConversationTurnRecord {
    return {
      id, sessionId: 's1', actorId: 'actor-1', platform: 'discord', channelId: 'c1', inboundMessageId: `in-${id}`,
      platformUserId: 'u1', status: 'RESPONDED', createdAt: daysAgo(1), latencyMs: 10, replyChars: 20,
      intentType: IntentType.CHAT, capability: Capability.GENERAL_CHAT, taskId: `task-${id}`, runId: `run-${id}`,
      requestFingerprint: ['0a0b0c0d'], platformMessageIds: [`out-${id}`], ...over,
    };
  }

  function signal(turnId: string, value: FeedbackSignal['value'], over: Partial<FeedbackSignal> = {}): FeedbackSignal {
    return {
      id: `sig-${turnId}-${value}`, turnId, kind: FeedbackSignalKind.EXPLICIT_RATING, source: 'REACTION', sourceKey: `u1:${value}`,
      value, createdAt: daysAgo(1), updatedAt: daysAgo(1), ...over,
    };
  }

  /** A fixture DB: 2 👎 GENERAL_CHAT turns (one with an approved note, one with a credential note), 1 👍 with examples. */
  async function seededDb(): Promise<string> {
    const dbPath = join(tempDir(), 'quoky.db');
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    const run = (id: string, curated?: number) => storage.taskRuns.save({
      id: `run-${id}`, taskId: `task-${id}`, attempt: 1, status: TaskRunStatus.COMPLETED,
      dispatchState: ProviderDispatchState.DISPATCH_COMMITTED, capability: Capability.GENERAL_CHAT, artifactIds: [],
      startedAt: daysAgo(1), ...(curated === undefined ? {} : { metadata: { curatedExampleCount: curated } }),
    });
    for (const id of ['bad-1', 'bad-2', 'good-1']) await storage.feedback.saveTurn(record(id));
    await storage.feedback.saveTurn(record('ctl', { control: 'help', capability: undefined }));
    await run('bad-1');
    await run('bad-2', 1);
    await run('good-1', 2);
    await storage.feedback.upsertSignal(signal('bad-1', 'NEGATIVE'));
    await storage.feedback.upsertSignal(signal('bad-2', 'NEGATIVE'));
    await storage.feedback.upsertSignal(signal('good-1', 'POSITIVE'));
    await storage.feedback.upsertSignal(signal('bad-2', 'OBSERVED', {
      kind: FeedbackSignalKind.IMPLICIT_CORRECTION, source: 'IMPLICIT', sourceKey: 'corr',
    }));
    await storage.learning.insertWithinCap(item(), 1000, NOW);
    await storage.learning.insertWithinCap(
      item({ id: 'item-2', sourceTurnId: 'bad-2', data: { requestText: REQUEST, note: CREDENTIAL, sourceRating: 'NEGATIVE' } }), 1000, NOW,
    );
    await storage.close();
    return dbPath;
  }

  it('reports a fixture DB as Markdown: counts, curated usage, misroutes, approved excerpt only', async () => {
    const dbPath = await seededDb();
    const { deps: d, out, err } = deps();
    expect(await runCli(['--db', dbPath], d)).toBe(EXIT_OK);
    const text = out.join('');
    expect(err).toEqual([]);
    expect(text).toContain('## Feedback, last 7 days');
    expect(text).toContain('Turns 3 · 👍 1 · 👎 2 (66.7%) · corrections 1');
    expect(text).toContain('with examples 50% (1/2) · without 100% (1/1)');
    expect(text).toContain('2 turn(s); showing 2');
    expect(text).toContain(`request "${REQUEST}" · note "${NOTE}"`);
    expect(text).toContain('Total 2 · active 2');
    expect(text).toContain('refused by the credential guard at use: 1');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('task-bad');
    expect(text).not.toContain('out-bad');
  });

  it('writes JSON deterministically, with --no-item-text and a filtered actor', async () => {
    const dbPath = await seededDb();
    const first = deps();
    expect(await runCli(['--db', dbPath, '--format', 'json', '--no-item-text', '--windows', '14'], first.deps)).toBe(EXIT_OK);
    const second = deps();
    expect(await runCli(['--db', dbPath, '--format', 'json', '--no-item-text', '--windows', '14'], second.deps)).toBe(EXIT_OK);
    expect(first.out.join('')).toBe(second.out.join(''));
    const report = JSON.parse(first.out.join('')) as LearningReport;
    expect(report.kind).toBe('quoky-learning-report');
    expect(report.windows.map((w) => w.days)).toEqual([14]);
    expect(report.scope.itemText).toBe(false);
    expect(first.out.join('')).not.toContain(REQUEST);
    const other = deps();
    expect(await runCli(['--db', dbPath, '--format', 'json', '--actor', 'someone-else'], other.deps)).toBe(EXIT_OK);
    const filtered = JSON.parse(other.out.join('')) as LearningReport;
    expect(filtered.scope.actorFiltered).toBe(true);
    expect(filtered.windows[0]?.overall.turns).toBe(0);
    expect(filtered.learningItems.total).toBe(0);
  });

  it('reads the database path from QUOKY_DB_PATH when --db is absent', async () => {
    const dbPath = await seededDb();
    const { deps: d, out } = deps({ env: { QUOKY_DB_PATH: dbPath } });
    expect(await runCli(['--format', 'json'], d)).toBe(EXIT_OK);
    expect((JSON.parse(out.join('')) as LearningReport).windows[0]?.overall.turns).toBe(3);
    const legacy = deps({ env: { CHUNSIK_DB_PATH: dbPath } });
    expect(await runCli([], legacy.deps)).toBe(EXIT_OK);
  });

  it('writes a new 0600 file with --out, prints only a summary line, and never overwrites', async () => {
    const dbPath = await seededDb();
    const outPath = join(tempDir(), 'report.md');
    const { deps: d, out } = deps();
    expect(await runCli(['--db', dbPath, '--out', outPath], d)).toBe(EXIT_OK);
    expect(statSync(outPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(outPath, 'utf8')).toContain('# Quoky learning report');
    expect(out.join('')).toContain('written to');
    expect(out.join('')).not.toContain(REQUEST);
    const again = deps();
    expect(await runCli(['--db', dbPath, '--out', outPath], again.deps)).toBe(EXIT_BLOCKED);
    expect(again.err.join('\n')).toContain('already exists');
  });

  it('does not modify the database', async () => {
    const dbPath = await seededDb();
    const before = readFileSync(dbPath);
    const { deps: d } = deps();
    expect(await runCli(['--db', dbPath], d)).toBe(EXIT_OK);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    expect(await storage.learning.get('actor-1', 'item-1', NOW)).not.toBeNull();
    await storage.close();
  });

  it('refuses a missing or pre-v14 database without creating anything', async () => {
    const dir = tempDir();
    const missing = join(dir, 'missing.db');
    const outPath = join(dir, 'out.md');
    const { deps: d } = deps();
    expect(await runCli(['--db', missing, '--out', outPath], d)).not.toBe(EXIT_OK);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(outPath)).toBe(false);
    const empty = join(dir, 'empty.db');
    writeFileSync(empty, '');
    const old = deps();
    expect(await runCli(['--db', empty, '--out', outPath], old.deps)).toBe(EXIT_BLOCKED);
    expect(old.err.join('\n')).toContain('LEARNING_SCHEMA_MISSING');
    expect(existsSync(outPath)).toBe(false);
  });

  it('rejects bad arguments with usage and writes nothing', async () => {
    const writeNewFile = vi.fn();
    const { deps: d } = deps({ writeNewFile });
    const bad: string[][] = [
      [], ['--db'], ['--db', 'x', '--db', 'y'], ['--db', 'x', '--format', 'xml'], ['--db', 'x', '--windows', '0'],
      ['--db', 'x', '--windows', '7,abc'], ['--db', 'x', '--windows', '9999'], ['--db', 'x', '--now', 'nope'],
      ['--db', 'x', '--min-cluster', '0'], ['--db', 'x', '--extra', 'z'], ['--db', '--out', 'y'],
    ];
    for (const argv of bad) expect(await runCli(argv, d), argv.join(' ')).toBe(EXIT_USAGE);
    expect(writeNewFile).not.toHaveBeenCalled();
    expect(await runCli(['--help'], d)).toBe(EXIT_OK);
  });
});

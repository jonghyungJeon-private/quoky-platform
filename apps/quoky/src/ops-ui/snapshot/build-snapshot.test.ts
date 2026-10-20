import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  Capability,
  FeedbackSignalKind,
  ReminderStatus,
  RiskLevel,
} from '@quoky/core';
import type { ApprovalRequest, FeedbackSummary, Reminder } from '@quoky/core';

import { renderDashboard } from '../http/render';
import type { OpsPanelView, OpsViewModel } from '../http/view-model';
import type { BackupStatus } from '../../ops/backup-job';
import {
  OPS_UNKNOWN,
  OpsSnapshotBuilder,
  cachedViewSource,
  operationKind,
  reminderLabel,
} from './build-snapshot';
import type { OpsProviderView, OpsSnapshotSources, OpsTelegramStatus } from './build-snapshot';
import { OpsErrorRing, errorRecordingLogger } from './error-ring';
import { OPS_HIDDEN, guardText } from './guard';

const NOW = '2026-10-06T05:00:00.000Z';
const OWNER = 'actor-owner-1';

// Credential-shaped strings (each matches the ADR-0097 strict guard) and conversation-body markers.
const GITHUB_TOKEN = 'gh' + 'p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const AWS_KEY = 'AK' + 'IAIOSFODNN7EXAMPLE';
const SLACK_TOKEN = 'xox' + 'b-123456789012-123456789012-abcdefghijklmnopqrstuvwx';
const FILE_SECRET = 'password = "hunter2hunter2"';
const SECRETS = [GITHUB_TOKEN, AWS_KEY, SLACK_TOKEN, 'hunter2hunter2'];
const BODIES = [
  'APPROVAL_GOAL_BODY_MARKER',
  'APPROVAL_REASON_BODY_MARKER',
  'APPROVAL_REQUESTER_MARKER',
  'REMINDER_TAIL_BODY_MARKER',
  'ERROR_MESSAGE_BODY_MARKER',
  'ERROR_STACK_BODY_MARKER',
  'MEMORY_CONTENT_BODY_MARKER',
  'provider-id-marker-claude',
  'provider-id-marker-ollama',
  'TASK_DESCRIPTION_BODY_MARKER',
];

function reminder(overrides: Partial<Reminder> & Pick<Reminder, 'displayNo' | 'body'>): Reminder {
  return {
    id: `rem-${overrides.displayNo}`,
    actorId: OWNER,
    status: ReminderStatus.SCHEDULED,
    kind: 'TEXT',
    schedule: { type: 'ONCE', at: '2026-10-07T00:00:00.000Z' },
    timeZone: 'Asia/Seoul',
    origin: { platform: 'discord', channelId: 'dm-1', userId: 'owner-discord-id' },
    occurrenceAt: '2026-10-07T00:00:00.000Z',
    nextFireAt: '2026-10-07T00:00:00.000Z',
    attempt: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function approval(id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    executionPlanRef: { id: `plan-${id}`, goal: `APPROVAL_GOAL_BODY_MARKER ${GITHUB_TOKEN}` },
    status: ApprovalStatus.PENDING,
    riskLevel: RiskLevel.HIGH,
    reason: `APPROVAL_REASON_BODY_MARKER ${FILE_SECRET}`,
    requestedBy: 'APPROVAL_REQUESTER_MARKER',
    createdAt: '2026-10-06T04:45:00.000Z',
    updatedAt: '2026-10-06T04:45:00.000Z',
    ...overrides,
  };
}

const SUMMARY: FeedbackSummary = {
  since: '2026-09-06T05:00:00.000Z',
  turnCount: 12,
  signals: [
    { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'POSITIVE', count: 5 },
    { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'NEGATIVE', count: 2 },
    { kind: FeedbackSignalKind.IMPLICIT_REPHRASE, value: 'OBSERVED', count: 3 },
  ],
  byCapability: [{ key: Capability.GENERAL_CHAT, turns: 12, positive: 5, negative: 2, implicit: 3 }],
  byIntent: [],
  recentNegative: [{ turnId: 'turn-1', createdAt: NOW, taskId: 'task-1' }],
};

const BACKUP: BackupStatus = {
  schema: 'quoky.backup-status/1',
  updatedAt: NOW,
  enabled: true,
  state: 'IDLE',
  lastRun: {
    kind: 'daily',
    startedAt: '2026-10-05T19:00:00.000Z',
    finishedAt: '2026-10-05T19:00:03.000Z',
    outcome: 'VERIFIED',
    file: 'quoky-20261006T040000-daily.db',
    userVersion: 14,
  },
  lastManual: null,
  lastVerified: {
    at: '2026-10-05T19:00:03.000Z',
    kind: 'daily',
    file: 'quoky-20261006T040000-daily.db',
    userVersion: 14,
    vectors: 'quoky-20261006T040000-daily.vectors',
  },
  retainedCount: 2,
  retained: ['quoky-20261006T040000-daily.db', 'quoky-20261005T040000-daily.db'],
  retainedVectors: ['quoky-20261006T040000-daily.vectors'],
  nextScheduledAt: '2026-10-06T19:00:00.000Z',
};

function provider(id: string, capabilities: Capability[]): OpsProviderView & { id: string } {
  return { id, capabilities: capabilities.map((capability) => ({ capability, priority: 1 })) };
}

function fixture(overrides: Partial<OpsSnapshotSources> = {}): OpsSnapshotSources {
  const claude = provider('provider-id-marker-claude', [Capability.GENERAL_CHAT, Capability.CODE_IMPLEMENTATION]);
  const ollama = provider('provider-id-marker-ollama', [Capability.GENERAL_CHAT, Capability.SUMMARIZATION]);
  const errors = new OpsErrorRing(100, () => '2026-10-06T04:59:00.000Z');
  const logger = errorRecordingLogger({ info() {}, warn() {}, error() {} }, errors, 'quoky');
  logger.error('inbound handling failed', {
    stage: 'inbound',
    messageId: '1234567890123456789',
    errorName: 'TypeError',
    errorMessage: `ERROR_MESSAGE_BODY_MARKER ${GITHUB_TOKEN}`,
    errorStack: 'ERROR_STACK_BODY_MARKER at x',
  });
  logger.error(`free text with ERROR_MESSAGE_BODY_MARKER ${SLACK_TOKEN}`, { reason: GITHUB_TOKEN });
  return {
    clock: () => NOW,
    timeZone: 'Asia/Seoul',
    runtime: {
      version: '0.1.0',
      processStartedAt: '2026-10-06T03:00:00.000Z',
      uptimeSeconds: () => 7_265,
      dbUserVersion: () => 14,
      instanceLockHeld: true,
      identityCheck: 'PASSED',
      platformConnected: async () => true,
      reminderTickState: () => 'RUNNING',
      launcher: 'launchd',
      launcherRecentStarts: 1,
    },
    providers: { all: () => [claude, ollama], available: async () => [claude] },
    imageUnderstanding: { selection: 'claude', locality: 'REMOTE' },
    owner: async () => ({ status: 'RESOLVED', actorId: OWNER }),
    reminders: {
      enabled: true,
      channelDelivery: false,
      listActiveByActor: async () => [
        reminder({ displayNo: 2, body: `토큰 ${GITHUB_TOKEN} 갱신하기` }),
        reminder({ displayNo: 1, body: '회의 준비' }),
        reminder({
          displayNo: 3,
          body: `${'가'.repeat(70)} REMINDER_TAIL_BODY_MARKER`,
          status: ReminderStatus.FIRING,
          schedule: { type: 'DAILY', time: { hour: 9, minute: 0 } },
          lastOutcome: { outcome: 'SENT', occurrenceAt: '2026-10-05T00:00:00.000Z', recordedAt: '2026-10-05T00:00:02.000Z', via: 'dm' },
        }),
        reminder({ displayNo: 4, body: `${'나'.repeat(65)} ${AWS_KEY}` }),
        reminder({ displayNo: 5, body: 'brief text', kind: 'BRIEF' }),
      ],
    },
    approvals: {
      list: async () => [
        approval('appr-aaaaaaaa-1111'),
        approval('appr-bbbbbbbb-2222', { createdAt: '2026-10-06T04:00:00.000Z' }),
        approval('appr-cccccccc-3333', { status: ApprovalStatus.APPROVED }),
        approval('appr-dddddddd-4444', {
          executionPlanRef: { id: 'p', goal: 'g', integrity: { kind: 'profile-application', contractVersion: 'v1', digest: 'sha256:x' } },
        }),
      ],
    },
    connectors: [{ source: 'jira', readOnly: true, isAvailable: async () => true }],
    errors,
    feedback: {
      summarize: async () => SUMMARY,
      trend: async () => ({
        current: [{ key: Capability.GENERAL_CHAT, turns: 12, positive: 5, negative: 2, implicit: 3 }],
        previous: [{ key: Capability.GENERAL_CHAT, turns: 10, positive: 3, negative: 4, implicit: 0 }],
      }),
    },
    backup: () => BACKUP,
    archivedMemoryCount: async () => ({ count: 3, capped: false }),
    ...overrides,
  };
}

function panelOf(view: OpsViewModel, id: string): OpsPanelView {
  const found = view.panels.find((p) => p.id === id);
  if (!found) throw new Error(`no panel ${id}`);
  return found;
}

function field(view: OpsViewModel, id: string, label: string): string | undefined {
  return panelOf(view, id).fields.find((f) => f.label === label)?.value;
}

describe('OPS-1 snapshot display rule (ADR-0113 D5)', () => {
  it('keeps every credential-shaped string and conversation body out of the view model and the rendered page', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    const json = JSON.stringify(view);
    const page = renderDashboard(view, 'csrf-token');
    for (const secret of [...SECRETS, ...BODIES]) {
      expect(json, secret).not.toContain(secret);
      expect(page, secret).not.toContain(secret);
    }
    expect(json).toContain(OPS_HIDDEN);
  });

  it('shows the nine Phase 1 panels in order, then the TG-3 Telegram panel', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    expect(view.panels.map((p) => p.id)).toEqual([
      'runtime',
      'providers',
      'reminders',
      'approvals',
      'connectors',
      'errors',
      'feedback',
      'backup',
      'memory',
      'telegram',
    ]);
    expect(view.panels.every((p) => p.state === 'OK')).toBe(true);
  });

  it('runs the strict guard on every string, including labels a source could not have checked', () => {
    expect(guardText(`x ${GITHUB_TOKEN}`)).toBe(OPS_HIDDEN);
    expect(guardText(FILE_SECRET)).toBe(OPS_HIDDEN);
    expect(guardText('2026-10-06 14:00:00')).toBe('2026-10-06 14:00:00');
    expect(Array.from(guardText('가'.repeat(500))).length).toBe(160);
  });
});

describe('OPS-1 snapshot panels (ADR-0113 D6)', () => {
  it('runtime: facts from the composition root; manifest hash and restart count are "unknown" without a source', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    expect(field(view, 'runtime', '빌드 버전')).toBe('0.1.0');
    expect(field(view, 'runtime', 'DB user_version')).toBe('14');
    expect(field(view, 'runtime', '가동 시간')).toBe('2시간 1분 5초');
    expect(field(view, 'runtime', '프로세스 시작')).toBe('2026-10-06 12:00:00');
    expect(field(view, 'runtime', '단일 인스턴스 잠금')).toBe('보유');
    expect(field(view, 'runtime', '플랫폼 연결')).toBe('연결됨');
    expect(field(view, 'runtime', '시작 신원 확인')).toBe('통과');
    expect(field(view, 'runtime', '알림 틱 상태')).toBe('RUNNING');
    expect(field(view, 'runtime', '설치 manifest 해시')).toBe(OPS_UNKNOWN);
    expect(field(view, 'runtime', '재시작 횟수')).toBe(OPS_UNKNOWN);
    expect(field(view, 'runtime', '최근 10분 시작 횟수')).toBe('1');
  });

  it('runtime: shows the manifest hash and restart count once their sources exist, and unknowns for failing facts', async () => {
    const base = fixture();
    const view = await new OpsSnapshotBuilder(
      fixture({
        runtime: {
          ...base.runtime,
          manifestHash: () => 'sha256:abc123',
          restartCount: () => 4,
          dbUserVersion: () => {
            throw new Error('locked');
          },
          platformConnected: async () => undefined,
        },
      }),
    ).build();
    expect(field(view, 'runtime', '설치 manifest 해시')).toBe('sha256:abc123');
    expect(field(view, 'runtime', '재시작 횟수')).toBe('4');
    expect(field(view, 'runtime', 'DB user_version')).toBe(OPS_UNKNOWN);
    expect(field(view, 'runtime', '플랫폼 연결')).toBe(OPS_UNKNOWN);
  });

  it('providers: readiness per capability with no provider id (owner decision 14 default)', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    const table = panelOf(view, 'providers').table;
    const row = (capability: string) => table?.rows.find((r) => r[0] === capability);
    expect(row(Capability.GENERAL_CHAT)).toEqual([Capability.GENERAL_CHAT, '일부 불가 (degraded)', '1/2']);
    expect(row(Capability.CODE_IMPLEMENTATION)).toEqual([Capability.CODE_IMPLEMENTATION, '준비됨 (ready)', '1/1']);
    expect(row(Capability.SUMMARIZATION)).toEqual([Capability.SUMMARIZATION, '불가 (unavailable)', '0/1']);
    expect(row(Capability.EMBEDDING)).toEqual([Capability.EMBEDDING, '공급자 없음', '0/0']);
    expect(JSON.stringify(panelOf(view, 'providers'))).not.toContain('provider-id-marker');
  });

  it('providers: shows the configured image-understanding selection (ADR-0111 amendment A5), never a model name', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    expect(field(view, 'providers', '이미지 이해 공급자 (설정)')).toBe('claude (클라우드: 첨부 이미지가 Anthropic으로 전송돼요)');
    const local = await new OpsSnapshotBuilder({ ...fixture(), imageUnderstanding: { selection: 'ollama', locality: 'LOCAL' } }).build();
    expect(field(local, 'providers', '이미지 이해 공급자 (설정)')).toBe('ollama (로컬: 이미지가 이 컴퓨터를 떠나지 않아요)');
    const codex = await new OpsSnapshotBuilder({ ...fixture(), imageUnderstanding: { selection: 'codex', locality: 'REMOTE' } }).build();
    expect(field(codex, 'providers', '이미지 이해 공급자 (설정)')).toBe('codex (클라우드: 첨부 이미지가 OpenAI로 전송돼요)');
    const off = await new OpsSnapshotBuilder({ ...fixture(), imageUnderstanding: { selection: 'off', locality: 'NONE' } }).build();
    expect(field(off, 'providers', '이미지 이해 공급자 (설정)')).toBe('off (이미지 분석 사용 안 함)');
    const { imageUnderstanding: _omitted, ...withoutSelection } = fixture();
    const unknown = await new OpsSnapshotBuilder(withoutSelection).build();
    expect(field(unknown, 'providers', '이미지 이해 공급자 (설정)')).toBe(OPS_UNKNOWN);
  });

  it('providers: shows the configured chat-provider selector (ADR-0092 amendment) next to the image selection', async () => {
    const base = fixture();
    const label = '대화 공급자 선택 (QUOKY_CHAT_PROVIDER)';
    const explicit = await new OpsSnapshotBuilder({
      ...base,
      providers: { ...base.providers, chatSelection: { provider: 'codex', source: 'QUOKY_CHAT_PROVIDER' } },
    }).build();
    expect(field(explicit, 'providers', label)).toBe('codex');
    const derived = await new OpsSnapshotBuilder({
      ...base,
      providers: { ...base.providers, chatSelection: { provider: 'claude', source: 'QUOKY_OLLAMA_ENABLED' } },
    }).build();
    expect(field(derived, 'providers', label)).toBe('claude (QUOKY_OLLAMA_ENABLED에서 결정)');
    expect(panelOf(explicit, 'providers').fields.map((f) => f.label)).toEqual([label, '이미지 이해 공급자 (설정)']);
    // Absent selection: no chat field; the image field is still there.
    const none = await new OpsSnapshotBuilder(base).build();
    expect(panelOf(none, 'providers').fields.map((f) => f.label)).toEqual(['이미지 이해 공급자 (설정)']);
  });

  it('providers: the runtime model switch shows the effective defaults, sources, override count and the change link', async () => {
    const base = fixture();
    const view = await new OpsSnapshotBuilder({
      ...base,
      providerSelection: async () => ({
        chat: { label: 'codex', source: '운영 화면 기본값', ready: false },
        image: { choice: 'off', source: '설정' },
        sessionOverrides: 2,
      }),
      handling: { reminderCancel: false, memoryForget: false, providerSelection: true },
    }).build();
    expect(field(view, 'providers', '대화 모델 기본값 (실행 중 적용)')).toBe('codex · 출처: 운영 화면 기본값 · 준비 안 됨 (Claude가 대신 답해요)');
    expect(field(view, 'providers', '이미지 모델 기본값 (실행 중 적용)')).toBe('off · 출처: 설정');
    expect(field(view, 'providers', '대화별로 바꾼 대화')).toBe('2개');
    expect(panelOf(view, 'providers').links).toEqual([{ label: '모델 기본값 바꾸기', href: '/providers' }]);
    // No link without a resolved owner, and no fields when the switch is not composed.
    const noOwner = await new OpsSnapshotBuilder({
      ...base,
      owner: async () => ({ status: 'AMBIGUOUS' }),
      handling: { reminderCancel: false, memoryForget: false, providerSelection: true },
    }).build();
    expect(panelOf(noOwner, 'providers').links).toBeUndefined();
    expect(field(noOwner, 'providers', '대화별로 바꾼 대화')).toBeUndefined();
    // A failing source keeps the panel up without the effective fields.
    const failing = await new OpsSnapshotBuilder({ ...base, providerSelection: async () => { throw new Error('x'); } }).build();
    expect(panelOf(failing, 'providers').state).toBe('OK');
    expect(field(failing, 'providers', '대화 모델 기본값 (실행 중 적용)')).toBeUndefined();
  });

  it('reminders: active ones by number, labels as `알림 목록` shows them, guarded on the full body', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    const rows = panelOf(view, 'reminders').table?.rows ?? [];
    expect(rows.map((r) => r[0])).toEqual(['#1', '#2', '#3', '#4', '#5']);
    expect(rows[0]).toEqual(['#1', '2026-10-07 09:00:00', '1회', 'SCHEDULED', 'DM', '-', '회의 준비']);
    expect(rows[1]?.[6]).toBe(OPS_HIDDEN);
    expect(rows[2]?.[3]).toBe('FIRING (전달 중)');
    expect(rows[2]?.[2]).toBe('매일');
    expect(rows[2]?.[5]).toBe('SENT (dm) · 2026-10-05 09:00:02');
    expect(rows[2]?.[6]).toBe(`${'가'.repeat(59)}…`);
    // the credential sits past the 60-character cut, and the full body is still guarded
    expect(rows[3]?.[6]).toBe(OPS_HIDDEN);
    expect(rows[4]?.[6]).toBe('오늘의 브리핑(DM)');
    expect(reminderLabel({ kind: 'TEXT', body: '짧은 알림' })).toBe('짧은 알림');
  });

  it('reminders: the delivery target follows the channel opt-in, never for the brief', async () => {
    const base = fixture();
    const view = await new OpsSnapshotBuilder(
      fixture({
        reminders: {
          enabled: true,
          channelDelivery: true,
          listActiveByActor: async () => [
            reminder({ displayNo: 1, body: 'a', origin: { platform: 'discord', spaceId: 'g', channelId: 'c', userId: 'u' } }),
            reminder({ displayNo: 2, body: 'b', kind: 'BRIEF', origin: { platform: 'discord', spaceId: 'g', channelId: 'c', userId: 'u' } }),
          ],
        },
      }),
    ).build();
    expect(panelOf(view, 'reminders').table?.rows.map((r) => r[4])).toEqual(['채널', 'DM']);
    void base;
  });

  it('approvals: PENDING only, metadata only, with the ADR-0093 expiry', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    const rows = panelOf(view, 'approvals').table?.rows ?? [];
    expect(rows).toEqual([
      ['appr-aaa', 'HIGH', '미지정', '2026-10-06 13:45:00', '2026-10-06 14:15:00', 'PENDING'],
      ['appr-ddd', 'HIGH', 'profile-application', '2026-10-06 13:45:00', '2026-10-06 14:15:00', 'PENDING'],
      ['appr-bbb', 'HIGH', '미지정', '2026-10-06 13:00:00', '2026-10-06 13:30:00', 'PENDING (만료됨, 다음 대화에서 기록)'],
    ]);
    expect(operationKind({ executionPlanRef: { id: 'p', goal: 'g', integrity: { kind: 'Free text kind!', contractVersion: '1', digest: 'd' } } })).toBe('미지정');
  });

  it('approvals: the kind column uses the same kind label as the confirmation page when supplied (live QA D7)', async () => {
    const base = fixture();
    const view = await new OpsSnapshotBuilder({
      ...base,
      approvals: {
        list: base.approvals.list,
        kindLabels: async () => new Map([['appr-aaaaaaaa-1111', '커넥터 쓰기']]),
      },
    }).build();
    const rows = panelOf(view, 'approvals').table?.rows ?? [];
    expect(rows.find((row) => row[0] === 'appr-aaa')?.[2]).toBe('커넥터 쓰기');
    // An approval the resolution does not know keeps the integrity kind fallback.
    expect(rows.find((row) => row[0] === 'appr-ddd')?.[2]).toBe('profile-application');
    const failing = await new OpsSnapshotBuilder({
      ...base,
      approvals: { list: base.approvals.list, kindLabels: async () => { throw new Error('lookup failed'); } },
    }).build();
    expect(panelOf(failing, 'approvals').state).toBe('OK');
  });

  it('connectors: configured flags and a probe outcome, unconfigured known sources listed', async () => {
    const view = await new OpsSnapshotBuilder(
      fixture({
        connectors: [
          { source: 'jira', readOnly: true, isAvailable: async () => true },
          { source: 'slack', readOnly: true, isAvailable: async () => false },
          {
            source: 'confluence',
            readOnly: true,
            isAvailable: async () => {
              throw new Error(`https://user:${GITHUB_TOKEN}@example.atlassian.net`);
            },
          },
        ],
      }),
    ).build();
    const rows = panelOf(view, 'connectors').table?.rows ?? [];
    expect(rows.map((r) => r.slice(0, 5))).toEqual([
      ['jira', '예', '예', '아니요', '사용 가능'],
      ['slack', '예', '예', '아니요', '사용 불가'],
      ['confluence', '예', '예', '아니요', 'PROBE_FAILED'],
      ['github', '아니요', '아니요', '아니요', '-'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('atlassian');
  });

  it('connectors: the 쓰기 column shows the effective v3 write switch with its allow-list size (live QA D6)', async () => {
    const view = await new OpsSnapshotBuilder(
      fixture({
        connectors: [
          { source: 'jira', readOnly: true, isAvailable: async () => true },
          { source: 'slack', readOnly: true, isAvailable: async () => true },
          { source: 'confluence', readOnly: true, isAvailable: async () => true },
        ],
        connectorWrites: {
          jira: { enabled: true, allowListCount: 2, allowListUnit: '프로젝트' },
          slack: { enabled: true, allowListCount: 1, allowListUnit: '채널' },
          github: { enabled: false },
        },
      }),
    ).build();
    const panel = panelOf(view, 'connectors');
    expect((panel.table?.rows ?? []).map((r) => [r[0], r[3]])).toEqual([
      ['jira', '예 (승인 후 · 허용 프로젝트 2개)'],
      ['slack', '예 (승인 후 · 허용 채널 1개)'],
      ['confluence', '아니요'],
      ['github', '아니요'],
    ]);
    expect(panel.notes.join(' ')).toContain('QUOKY_CONNECTOR_WRITES_ENABLED');
  });

  it('recent errors: codes and categories only, newest first', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    const rows = panelOf(view, 'errors').table?.rows ?? [];
    expect(rows).toEqual([
      ['2026-10-06 13:59:00', 'quoky', 'error', OPS_HIDDEN, '-'],
      ['2026-10-06 13:59:00', 'quoky', 'inbound', 'TypeError', '1234567890123456789'],
    ]);
  });

  it('feedback: the `피드백 요약` counts and the 30-day trend, no turn text', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    expect(field(view, 'feedback', '기록된 대화')).toBe('12');
    expect(field(view, 'feedback', '👍')).toBe('5');
    expect(field(view, 'feedback', '👎')).toBe('2');
    expect(field(view, 'feedback', '참고 신호')).toBe('3');
    expect(panelOf(view, 'feedback').table?.rows).toEqual([['일반 대화', '12', '5', '2', '3']]);
    expect(panelOf(view, 'feedback').notes[0]).toContain('일반 대화: 17% (👎 2/12) · 이전 40% (👎 4/10) · 개선');
  });

  it('feedback: every row has its own label, never two "기타" rows (live QA D8)', async () => {
    const view = await new OpsSnapshotBuilder(
      fixture({
        feedback: {
          summarize: async () => ({
            ...SUMMARY,
            byCapability: [
              { key: null, turns: 4, positive: 0, negative: 0, implicit: 0 },
              { key: Capability.IMAGE_UNDERSTANDING, turns: 2, positive: 1, negative: 0, implicit: 0 },
              { key: Capability.DOCUMENT_ANALYSIS, turns: 1, positive: 0, negative: 1, implicit: 0 },
            ],
          }),
        },
      }),
    ).build();
    expect((panelOf(view, 'feedback').table?.rows ?? []).map((row) => row[0])).toEqual([
      '명령·바로 답한 대화',
      '이미지 이해',
      '문서 분석',
    ]);
  });

  it('backup: the SUB-2 status, file names only', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    expect(field(view, 'backup', '정기 백업')).toBe('켜짐');
    expect(field(view, 'backup', '검증 (integrity_check, user_version)')).toBe('예 (user_version 14)');
    expect(field(view, 'backup', '보관 사본 수')).toBe('2');
    expect(field(view, 'backup', '벡터 스냅샷 (마지막 검증 사본)')).toBe('있음 · quoky-20261006T040000-daily.vectors');
    expect(field(view, 'backup', '마지막 수동 백업')).toBe('없음');
    const manual = await new OpsSnapshotBuilder(
      fixture({
        backup: () => ({
          ...BACKUP,
          lastManual: { kind: 'manual', startedAt: NOW, finishedAt: NOW, outcome: 'VERIFIED', file: 'quoky-20261006T010000Z-manual.db' },
          lastVerified: { at: NOW, kind: 'manual', file: 'quoky-20261006T010000Z-manual.db' },
        }),
      }),
    ).build();
    expect(field(manual, 'backup', '마지막 수동 백업')).toMatch(/ · VERIFIED$/);
    expect(field(manual, 'backup', '벡터 스냅샷 (마지막 검증 사본)')).toBe('없음 (복구하면 의미 검색 색인을 다시 만듦)');
    expect(field(view, 'backup', '다음 예정')).toBe('2026-10-07 04:00:00');
    expect(panelOf(view, 'backup').table?.rows).toEqual([['quoky-20261006T040000-daily.db'], ['quoky-20261005T040000-daily.db']]);
  });

  it('memory: the archive count only', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    expect(field(view, 'memory', '보관함 기억 수')).toBe('3');
    const capped = await new OpsSnapshotBuilder(fixture({ archivedMemoryCount: async () => ({ count: 500, capped: true }) })).build();
    expect(field(capped, 'memory', '보관함 기억 수')).toBe('500+');
  });

  it('owner panels say why when the owner ids map to no Actor or to several', async () => {
    for (const status of ['NONE', 'AMBIGUOUS'] as const) {
      const view = await new OpsSnapshotBuilder(fixture({ owner: async () => ({ status }) })).build();
      for (const id of ['reminders', 'feedback', 'memory']) {
        expect(panelOf(view, id).state).toBe('OK');
        expect(panelOf(view, id).table).toBeUndefined();
        expect(panelOf(view, id).notes).toHaveLength(1);
      }
    }
  });

  it('a failing source makes only its panel UNAVAILABLE, with a code and no exception text', async () => {
    const view = await new OpsSnapshotBuilder(
      fixture({
        approvals: {
          list: async () => {
            throw new Error(`SQLITE_BUSY ${GITHUB_TOKEN}`);
          },
        },
        feedback: { summarize: async () => null },
        backup: () => undefined,
      }),
    ).build();
    expect(panelOf(view, 'approvals')).toMatchObject({ state: 'UNAVAILABLE', errorCode: 'SOURCE_FAILED' });
    expect(panelOf(view, 'feedback')).toMatchObject({ state: 'UNAVAILABLE', errorCode: 'FEEDBACK_UNAVAILABLE' });
    expect(panelOf(view, 'backup')).toMatchObject({ state: 'UNAVAILABLE', errorCode: 'BACKUP_STATUS_UNAVAILABLE' });
    expect(panelOf(view, 'runtime').state).toBe('OK');
    expect(JSON.stringify(view)).not.toContain('SQLITE_BUSY');
  });
});

describe('OPS-1 bounded poll (ADR-0113 D6)', () => {
  it('rebuilds at most once per interval and shares an in-flight build', async () => {
    let builds = 0;
    let now = 0;
    const source = cachedViewSource(
      async () => {
        builds += 1;
        return { generatedAt: String(builds), panels: [] };
      },
      10_000,
      () => now,
    );
    const [a, b] = await Promise.all([source(), source()]);
    expect(builds).toBe(1);
    expect(a).toBe(b);
    now = 9_999;
    await source();
    expect(builds).toBe(1);
    now = 10_000;
    expect((await source()).generatedAt).toBe('2');
  });
});

/**
 * TG-3 golden (ADR-0114 D12): the dashboard of the standard fixture, rendered before the Telegram panel existed. With
 * Telegram off the page is that golden plus exactly one `panel-telegram` section ("설정 안 됨"); every other byte is
 * unchanged. Regenerate only on purpose: `QUOKY_UPDATE_OPS_GOLDEN=1`.
 */
const DASHBOARD_GOLDEN = path.join(__dirname, '__golden__', 'dashboard-before-telegram-panel.html');
const TELEGRAM_SECTION = /<section class="panel" id="panel-telegram">\n[\s\S]*?\n<\/section>\n/;

describe('TG-3 golden: the existing dashboard is byte-identical with Telegram off', () => {
  it('the page without the Telegram section equals the pre-TG-3 golden', async () => {
    const handling = { reminderCancel: true, memoryForget: true, approvals: true, providerSelection: true };
    const view = await new OpsSnapshotBuilder(fixture({ handling })).build();
    const page = renderDashboard(view, 'csrf-golden', 30, true);
    const withoutTelegram = page.replace(TELEGRAM_SECTION, '');
    if (process.env.QUOKY_UPDATE_OPS_GOLDEN === '1') {
      if (!existsSync(path.dirname(DASHBOARD_GOLDEN))) mkdirSync(path.dirname(DASHBOARD_GOLDEN), { recursive: true });
      writeFileSync(DASHBOARD_GOLDEN, withoutTelegram);
    }
    expect(withoutTelegram).toBe(readFileSync(DASHBOARD_GOLDEN, 'utf8'));
  });
});

describe('TG-3 Telegram panel (ADR-0114 D12, ADR-0113 D5)', () => {
  const TOKEN = ['70', '01', '23', '4'].join('') + ':' + ['AAH', 'acc', '_', 'p'.repeat(15), '-', 'r'.repeat(14)].join('');
  const status = {
    identityVerified: true,
    polling: true,
    lastPollAt: '2026-10-06T04:59:30.000Z',
    admittedChatCount: 1,
    droppedUpdates: {
      malformed: 0,
      'update-type': 2,
      'not-private': 1,
      'not-owner': 4,
      forwarded: 3,
      'no-text': 0,
      stale: 1,
      'not-feedback': 5,
    },
  };

  it('Telegram off: the panel says "not configured" and nothing else', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    expect(panelOf(view, 'telegram')).toEqual({
      id: 'telegram',
      title: 'Telegram',
      state: 'OK',
      fields: [{ label: '상태', value: '설정 안 됨 (not configured)' }],
      notes: [],
    });
    // A source that answers "nothing composed" is the same as no source.
    const composedNone = await new OpsSnapshotBuilder(fixture({ telegram: () => undefined })).build();
    expect(panelOf(composedNone, 'telegram')).toEqual(panelOf(view, 'telegram'));
  });

  it('Telegram on: connected, identity, halt, polling, last poll, admitted chats and every drop counter', async () => {
    const view = await new OpsSnapshotBuilder(fixture({ telegram: () => status })).build();
    expect(field(view, 'telegram', '연결됨')).toBe('예');
    expect(field(view, 'telegram', '봇 신원 확인 (getMe)')).toBe('통과');
    expect(field(view, 'telegram', '중지됨')).toBe('아니요');
    expect(field(view, 'telegram', '폴링 중')).toBe('예');
    expect(field(view, 'telegram', '마지막 폴링')).toBe('2026-10-06 13:59:30');
    expect(field(view, 'telegram', '허용된 개인 대화 수')).toBe('1');
    const table = panelOf(view, 'telegram').table;
    expect(table?.columns).toEqual(['버린 이유', '설명', '건수']);
    expect(table?.rows.map((row) => [row[0], row[2]])).toEqual([
      ['malformed', '0'],
      ['update-type', '2'],
      ['not-private', '1'],
      ['not-owner', '4'],
      ['forwarded', '3'],
      ['no-text', '0'],
      ['stale', '1'],
      ['not-feedback', '5'],
    ]);
    // Every other panel is exactly what Telegram-off shows.
    const off = await new OpsSnapshotBuilder(fixture()).build();
    expect(view.panels.filter((p) => p.id !== 'telegram')).toEqual(off.panels.filter((p) => p.id !== 'telegram'));
  });

  it('a halt shows its code and what it means; connected is then "no"', async () => {
    const view = await new OpsSnapshotBuilder(
      fixture({ telegram: () => ({ ...status, polling: false, halted: 'TELEGRAM_POLL_CONFLICT' }) }),
    ).build();
    expect(field(view, 'telegram', '연결됨')).toBe('아니요');
    expect(field(view, 'telegram', '중지됨')).toBe('예 · TELEGRAM_POLL_CONFLICT (다른 곳에서 같은 토큰으로 폴링하거나 웹훅이 설정돼 있어요)');
    expect(panelOf(view, 'telegram').notes.some((note) => note.includes('Discord는 계속 동작'))).toBe(true);
    const { lastPollAt: _never, ...unpolled } = status;
    const before = await new OpsSnapshotBuilder(fixture({ telegram: () => ({ ...unpolled, identityVerified: false, polling: false }) })).build();
    expect(field(before, 'telegram', '연결됨')).toBe('아니요');
    expect(field(before, 'telegram', '봇 신원 확인 (getMe)')).toBe('아직 아님');
    expect(field(before, 'telegram', '마지막 폴링')).toBe('없음');
  });

  it('shows no content, id or token, even from a status that tried to carry them', async () => {
    const hostile = {
      ...status,
      halted: `TELEGRAM_X ${TOKEN}`,
      lastPollAt: 'MESSAGE_BODY_MARKER',
      admittedChatCount: Number.NaN,
      droppedUpdates: { ...status.droppedUpdates, [`5550001 ${TOKEN}`]: 1, 'MESSAGE BODY MARKER': 2 },
      chatIds: ['5550001'],
      lastText: 'MESSAGE_BODY_MARKER',
      token: TOKEN,
    } as unknown as OpsTelegramStatus;
    const view = await new OpsSnapshotBuilder(fixture({ telegram: () => hostile })).build();
    const page = renderDashboard(view, 'csrf-token');
    const json = JSON.stringify(panelOf(view, 'telegram'));
    for (const forbidden of [TOKEN, TOKEN.split(':')[1] as string, '5550001', 'MESSAGE_BODY_MARKER', 'MESSAGE BODY MARKER']) {
      expect(json, forbidden).not.toContain(forbidden);
      expect(page, forbidden).not.toContain(forbidden);
    }
    expect(field(view, 'telegram', '중지됨')).toBe('예 · unknown');
    expect(field(view, 'telegram', '허용된 개인 대화 수')).toBe(OPS_UNKNOWN);
    expect(field(view, 'telegram', '마지막 폴링')).toBe(OPS_UNKNOWN);
  });

  it('a failing status source makes only the Telegram panel unavailable', async () => {
    const view = await new OpsSnapshotBuilder(
      fixture({
        telegram: () => {
          throw new Error(`boom ${TOKEN}`);
        },
      }),
    ).build();
    expect(panelOf(view, 'telegram')).toMatchObject({ state: 'UNAVAILABLE', errorCode: 'SOURCE_FAILED' });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(panelOf(view, 'runtime').state).toBe('OK');
  });
});

describe('PRV-3 provider usage panel (ADR-0115 D8, ADR-0113 D5)', () => {
  const c = (sum: number, reportedRuns: number) => ({ sum, reportedRuns });
  const months = [
    {
      month: '2026-10',
      labels: [
        { label: 'openai:gpt-5', runs: 3, unknownRuns: 0, inputTokens: c(1200, 3), outputTokens: c(300, 3), totalTokens: c(1500, 3) },
        { label: 'claude:sonnet', runs: 2, unknownRuns: 2, inputTokens: c(0, 0), outputTokens: c(0, 0), totalTokens: c(0, 0) },
        { label: 'codex', runs: 3, unknownRuns: 2, inputTokens: c(900, 2), outputTokens: c(40, 1), totalTokens: c(500, 1) },
      ],
    },
    { month: '2026-09', labels: [{ label: 'gemini:g', runs: 1, unknownRuns: 0, inputTokens: c(10, 1), outputTokens: c(5, 1), totalTokens: c(15, 1) }] },
  ];

  it('shows the counts per month and label, appended after every other panel', async () => {
    const view = await new OpsSnapshotBuilder(fixture({ providerUsage: async () => months })).build();
    expect(view.panels.at(-1)?.id).toBe('provider-usage');
    const panel = panelOf(view, 'provider-usage');
    expect(panel.state).toBe('OK');
    expect(panel.table?.columns).toEqual(['월', '공급자', '실행', '입력 토큰', '출력 토큰', '합계 토큰', '합계 미보고 실행']);
    expect(panel.table?.rows).toEqual([
      ['2026-10', 'openai:gpt-5', '3', '1200', '300', '1500', '0'],
      // Nobody reported a count: "미보고", never 0.
      ['2026-10', 'claude:sonnet', '2', '미보고', '미보고', '미보고', '2'],
      // Partly reported: the sum and how many runs it covers.
      ['2026-10', 'codex', '3', '900 (2/3회 보고)', '40 (1/3회 보고)', '500 (1/3회 보고)', '2'],
      ['2026-09', 'gemini:g', '1', '10', '5', '15', '0'],
    ]);
  });

  it('escapes every cell in the rendered page and carries counts only', async () => {
    const hostile = [{ month: '2026-10', labels: [{ label: '<script>alert(1)</script>', runs: 1, unknownRuns: 0, inputTokens: c(1, 1), outputTokens: c(1, 1), totalTokens: c(2, 1) }] }];
    const view = await new OpsSnapshotBuilder(fixture({ providerUsage: async () => hostile })).build();
    const page = renderDashboard(view, 'csrf-token');
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const json = JSON.stringify(panelOf(view, 'provider-usage'));
    for (const secret of [...SECRETS, ...BODIES]) expect(json, secret).not.toContain(secret);
  });

  it('shows a malformed count as unknown, never the raw value', async () => {
    const bad = [{ month: '2026-10', labels: [{ label: 'x', runs: 1, unknownRuns: 0, inputTokens: c(-1, 1), outputTokens: c(Number.NaN, 1), totalTokens: c(1, 2) }] }];
    const view = await new OpsSnapshotBuilder(fixture({ providerUsage: async () => bad })).build();
    expect(panelOf(view, 'provider-usage').table?.rows[0]).toEqual(['2026-10', 'x', '1', OPS_UNKNOWN, OPS_UNKNOWN, OPS_UNKNOWN, '0']);
  });

  it('a failing source makes only its own panel unavailable, with a code', async () => {
    const view = await new OpsSnapshotBuilder(fixture({ providerUsage: async () => { throw new Error('SECRET BODY'); } })).build();
    const panel = panelOf(view, 'provider-usage');
    expect(panel.state).toBe('UNAVAILABLE');
    expect(panel.errorCode).toBe('SOURCE_FAILED');
    expect(JSON.stringify(panel)).not.toContain('SECRET BODY');
    expect(panelOf(view, 'runtime').state).toBe('OK');
  });

  it('no usage: no panel at all, and the page is byte-identical to the one without the ledger (also the TG-3 golden)', async () => {
    const handling = { reminderCancel: true, memoryForget: true, approvals: true, providerSelection: true };
    const without = renderDashboard(await new OpsSnapshotBuilder(fixture({ handling })).build(), 'csrf-golden', 30, true);
    for (const providerUsage of [
      async () => [] as typeof months,
      async () => [{ month: '2026-10', labels: [] }, { month: '2026-09', labels: [] }],
    ]) {
      const view = await new OpsSnapshotBuilder(fixture({ handling, providerUsage })).build();
      expect(view.panels.some((p) => p.id === 'provider-usage')).toBe(false);
      expect(renderDashboard(view, 'csrf-golden', 30, true)).toBe(without);
    }
    expect(without.replace(TELEGRAM_SECTION, '')).toBe(readFileSync(DASHBOARD_GOLDEN, 'utf8'));
  });
});

describe('ADR-0121 S2 agent panel (D7: the mode and the kill switch, read-only)', () => {
  it('shows the mode and the owner switch state before the usage panel; no link, no action', async () => {
    const months = [{ month: '2026-10', labels: [{ label: 'codex', runs: 1, unknownRuns: 0, inputTokens: { sum: 1, reportedRuns: 1 }, outputTokens: { sum: 1, reportedRuns: 1 }, totalTokens: { sum: 2, reportedRuns: 1 } }] }];
    const view = await new OpsSnapshotBuilder(fixture({ agent: { mode: 'shadow', switchState: async () => 'stopped' }, providerUsage: async () => months })).build();
    expect(view.panels.map((p) => p.id).slice(-2)).toEqual(['agent', 'provider-usage']);
    const panel = panelOf(view, 'agent');
    expect(panel.state).toBe('OK');
    expect(panel.fields).toEqual([
      { label: '에이전트 모드 (QUOKY_AGENT_MODE)', value: 'shadow' },
      { label: '킬 스위치', value: '중지됨' },
    ]);
    expect(panel.links).toBeUndefined();
    const running = panelOf(await new OpsSnapshotBuilder(fixture({ agent: { mode: 'off', switchState: async () => 'running' } })).build(), 'agent');
    expect(running.fields.map((field) => field.value)).toEqual(['off', '실행 중']);
  });

  it('an unresolved owner or a failing read shows unknown; a mode outside the closed set is never echoed', async () => {
    const ambiguous = await new OpsSnapshotBuilder(fixture({ owner: async () => ({ status: 'AMBIGUOUS' }), agent: { mode: 'shadow', switchState: async () => 'running' } })).build();
    expect(panelOf(ambiguous, 'agent').fields[1]?.value).toBe(OPS_UNKNOWN);
    const failing = await new OpsSnapshotBuilder(fixture({ agent: { mode: '<script>', switchState: async () => { throw new Error('SECRET BODY'); } } })).build();
    expect(panelOf(failing, 'agent').fields.map((field) => field.value)).toEqual([OPS_UNKNOWN, OPS_UNKNOWN]);
    expect(JSON.stringify(panelOf(failing, 'agent'))).not.toContain('SECRET BODY');
  });

  it('absent: no panel (the page stays byte-identical to the golden)', async () => {
    const view = await new OpsSnapshotBuilder(fixture()).build();
    expect(view.panels.some((p) => p.id === 'agent')).toBe(false);
  });
});

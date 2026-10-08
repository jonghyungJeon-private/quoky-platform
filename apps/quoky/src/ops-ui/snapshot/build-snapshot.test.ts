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
import type { OpsProviderView, OpsSnapshotSources } from './build-snapshot';
import { OpsErrorRing, errorRecordingLogger } from './error-ring';
import { OPS_HIDDEN, guardText } from './guard';

const NOW = '2026-10-06T05:00:00.000Z';
const OWNER = 'actor-owner-1';

// Credential-shaped strings (each matches the ADR-0097 strict guard) and conversation-body markers.
const GITHUB_TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
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

  it('shows the nine Phase 1 panels in order', async () => {
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

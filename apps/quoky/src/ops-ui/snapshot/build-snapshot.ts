import {
  ApprovalStatus,
  Capability,
  FeedbackSignalKind,
  ReminderStatus,
  feedbackCapabilityLabel,
  feedbackTrendLines,
  learningTextHasCredential,
  reminderRepeatLabel,
  toZonedDateTime,
} from '@quoky/core';
import type {
  ApprovalRequest,
  FeedbackCapabilityTrend,
  FeedbackSummary,
  Id,
  Reminder,
} from '@quoky/core';

import type { OpsField, OpsPanelView, OpsViewModel } from '../http/view-model';
import type { BackupStatus } from '../../ops/backup-job';
import type { OpsErrorRing } from './error-ring';
import { OPS_HIDDEN, guardViewModel } from './guard';

/**
 * OPS-1 snapshot (ADR-0113 D5/D6/D8): assembles the read-only view model from existing Core ports and application
 * read services plus composition-root facts. Each panel is built independently; a failing source makes only its
 * panel `UNAVAILABLE` with a code. Nothing here writes anything, sends anything, or calls a provider's `execute`.
 *
 * Display rule (D5): no secrets, tokens, conversation bodies, prompt/context text, approval payloads or memory
 * content. Provider readiness is per capability with no provider id (D6 default, owner decision 14 open). The whole
 * view model passes the strict credential guard ({@link guardViewModel}) before it leaves this module.
 */

export const OPS_UNKNOWN = 'unknown';
/** ADR-0093: a pending approval expires 30 minutes after `createdAt` (mirrors `PENDING_APPROVAL_TTL_MS`). */
export const OPS_APPROVAL_TTL_MS = 30 * 60 * 1000;
/** `알림 목록` shows this many code points of a reminder body (ADR-0101 D5; mirrors the reply composer). */
export const OPS_REMINDER_LABEL_CHARS = 60;
export const OPS_MAX_TABLE_ROWS = 50;
/** Known connector sources, shown even when not configured. */
export const OPS_KNOWN_CONNECTORS: readonly string[] = ['jira', 'slack', 'confluence', 'github'];
const CONNECTOR_PROBE_TIMEOUT_MS = 2_000;

/** A registered AI provider seen structurally; only capabilities and the probe are read, never the id. */
export interface OpsProviderView {
  readonly capabilities: readonly { readonly capability: string }[];
}

export interface OpsProviderReadinessSource {
  all(): readonly OpsProviderView[];
  available(): Promise<readonly OpsProviderView[]>;
  /**
   * The configured chat-provider selector (ADR-0092 amendment, 2026-10-07): the `QUOKY_CHAT_PROVIDER` value and where
   * it came from. A configuration fact, not a provider id; absent when the composition does not supply it.
   */
  readonly chatSelection?: { readonly provider: string; readonly source: string };
}

/**
 * ADR-0111 amendment A5: the owner's configured image-understanding selection (`QUOKY_IMAGE_UNDERSTANDING_PROVIDER`), a
 * composition-root configuration fact — not a routing result and not a provider id. Never a model name.
 */
export interface OpsImageUnderstandingSelection {
  readonly selection: 'ollama' | 'claude' | 'off';
  readonly locality: 'LOCAL' | 'REMOTE' | 'NONE';
}

export interface OpsConnectorView {
  readonly source: string;
  readonly readOnly: boolean;
  isAvailable(): Promise<boolean>;
}

export type OpsOwnerResolution =
  | { readonly status: 'RESOLVED'; readonly actorId: Id }
  | { readonly status: 'NONE' | 'AMBIGUOUS' };

export interface OpsRuntimeFacts {
  readonly version: string;
  readonly processStartedAt: string;
  readonly uptimeSeconds: () => number;
  /** Host DB `user_version`; undefined when the DB is not a file. May throw. */
  readonly dbUserVersion: () => number | undefined;
  readonly instanceLockHeld: boolean;
  readonly identityCheck: 'PASSED' | 'OFF';
  /** Live platform connection; undefined when the platform cannot tell. */
  readonly platformConnected: () => Promise<boolean | undefined>;
  readonly reminderTickState: () => string | undefined;
  readonly launcher: 'launchd' | undefined;
  readonly launcherRecentStarts: number;
  /** ADR-0103 installed manifest hash (SUB-3, W6); absent until its source exists. */
  readonly manifestHash?: () => string | undefined;
  /** ADR-0102 D7 launcher restart count; absent until SUB-1 documents its state file. */
  readonly restartCount?: () => number | undefined;
}

export interface OpsSnapshotSources {
  readonly clock: () => string;
  readonly timeZone: string;
  readonly runtime: OpsRuntimeFacts;
  readonly providers: OpsProviderReadinessSource;
  /** ADR-0111 amendment A5: shown in the providers panel; absent → the field reads `unknown`. */
  readonly imageUnderstanding?: OpsImageUnderstandingSelection;
  readonly owner: () => Promise<OpsOwnerResolution>;
  readonly reminders: {
    readonly enabled: boolean;
    readonly channelDelivery: boolean;
    listActiveByActor(actorId: Id): Promise<readonly Reminder[]>;
  };
  readonly approvals: { list(): Promise<readonly ApprovalRequest[]> };
  readonly connectors: readonly OpsConnectorView[];
  readonly errors: OpsErrorRing;
  readonly feedback: {
    summarize(actorId: Id): Promise<FeedbackSummary | null>;
    trend?(actorId: Id): Promise<FeedbackCapabilityTrend | null>;
  };
  readonly backup: () => BackupStatus | undefined;
  /** Archived memory records of the owner (ADR-0106 amendment); a count only, never content. */
  readonly archivedMemoryCount?: (actorId: Id) => Promise<{ readonly count: number; readonly capped: boolean }>;
  /** OPS-2 (ADR-0113 D7): which handling actions are wired; their links appear only for a resolved owner. */
  readonly handling?: { readonly reminderCancel: boolean; readonly memoryForget: boolean; readonly approvals?: boolean };
}

type PanelBody = Pick<OpsPanelView, 'fields' | 'table' | 'notes' | 'links'>;

function errorCodeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  }
  return 'SOURCE_FAILED';
}

async function panel(id: string, title: string, build: () => Promise<PanelBody>): Promise<OpsPanelView> {
  try {
    const body = await build();
    return {
      id,
      title,
      state: 'OK',
      fields: body.fields,
      notes: body.notes,
      ...(body.table ? { table: body.table } : {}),
      ...(body.links && body.links.length > 0 ? { links: body.links } : {}),
    };
  } catch (err) {
    return { id, title, state: 'UNAVAILABLE', errorCode: errorCodeOf(err), fields: [], notes: [] };
  }
}

/** The configured image selection as the providers panel shows it (ADR-0111 amendment A5). */
function imageSelectionLabel(image: OpsImageUnderstandingSelection | undefined): string {
  if (image === undefined) return OPS_UNKNOWN;
  if (image.selection === 'claude') return 'claude (클라우드: 첨부 이미지가 Anthropic으로 전송돼요)';
  if (image.selection === 'ollama') return 'ollama (로컬: 이미지가 이 컴퓨터를 떠나지 않아요)';
  return 'off (이미지 분석 사용 안 함)';
}

function yesNo(value: boolean | undefined): string {
  return value === undefined ? OPS_UNKNOWN : value ? '예' : '아니요';
}

export class OpsSnapshotBuilder {
  constructor(private readonly sources: OpsSnapshotSources) {}

  /** The guarded view model of every Phase 1 panel. */
  async build(): Promise<OpsViewModel> {
    const now = this.sources.clock();
    const ownerPromise = this.sources.owner().catch((): OpsOwnerResolution => ({ status: 'NONE' }));
    const panels = await Promise.all([
      panel('runtime', '런타임 / 상태', () => this.runtime()),
      panel('providers', 'AI 공급자 준비 상태 (기능별)', () => this.providers()),
      panel('reminders', '알림 대기열', async () => this.reminders(await ownerPromise)),
      panel('approvals', '대기 중인 승인 (메타데이터만)', () => this.approvals(now)),
      panel('connectors', '커넥터 상태', () => this.connectors()),
      panel('errors', '최근 오류', async () => this.errors()),
      panel('feedback', '피드백 통계 (최근 30일)', async () => this.feedback(await ownerPromise)),
      panel('backup', '백업 상태', async () => this.backup()),
      panel('memory', '기억 보관함', async () => this.memory(await ownerPromise)),
    ]);
    return guardViewModel({ generatedAt: this.time(now), panels });
  }

  private time(iso: string | undefined): string {
    return formatOpsTime(iso, this.sources.timeZone);
  }

  private async runtime(): Promise<PanelBody> {
    const facts = this.sources.runtime;
    let userVersion: string;
    try {
      const version = facts.dbUserVersion();
      userVersion = version === undefined ? OPS_UNKNOWN : String(version);
    } catch {
      userVersion = OPS_UNKNOWN;
    }
    const connected = await facts.platformConnected().catch(() => undefined);
    const uptime = Math.max(0, Math.floor(facts.uptimeSeconds()));
    const manifest = facts.manifestHash?.();
    const restarts = facts.restartCount?.();
    const fields: OpsField[] = [
      { label: '빌드 버전', value: facts.version },
      { label: '프로세스 시작', value: this.time(facts.processStartedAt) },
      { label: '가동 시간', value: formatDuration(uptime) },
      { label: 'DB user_version', value: userVersion },
      { label: '단일 인스턴스 잠금', value: facts.instanceLockHeld ? '보유' : '없음 (파일 DB 아님)' },
      { label: '플랫폼 연결', value: connected === undefined ? OPS_UNKNOWN : connected ? '연결됨' : '끊김' },
      { label: '시작 신원 확인', value: facts.identityCheck === 'PASSED' ? '통과' : '꺼짐 (기대 봇 ID 미설정)' },
      { label: '알림 틱 상태', value: facts.reminderTickState() ?? OPS_UNKNOWN },
      { label: '알림 틱 마지막 실행', value: OPS_UNKNOWN },
      { label: '실행 방식', value: facts.launcher === 'launchd' ? 'launchd 서비스' : '직접 실행' },
      { label: '최근 10분 시작 횟수', value: facts.launcher === 'launchd' ? String(facts.launcherRecentStarts) : OPS_UNKNOWN },
      { label: '설치 manifest 해시', value: manifest ?? OPS_UNKNOWN },
      { label: '재시작 횟수', value: restarts === undefined ? OPS_UNKNOWN : String(restarts) },
    ];
    return { fields, notes: [] };
  }

  private async providers(): Promise<PanelBody> {
    const all = this.sources.providers.all();
    const available = new Set(await this.sources.providers.available());
    const capabilities: string[] = [];
    for (const value of Object.values(Capability) as string[]) capabilities.push(value);
    for (const provider of all) {
      for (const descriptor of provider.capabilities) {
        if (!capabilities.includes(descriptor.capability)) capabilities.push(descriptor.capability);
      }
    }
    const rows: string[][] = [];
    for (const capability of capabilities) {
      const registered = all.filter((p) => p.capabilities.some((c) => c.capability === capability));
      const ready = registered.filter((p) => available.has(p)).length;
      const state =
        registered.length === 0
          ? '공급자 없음'
          : ready === registered.length
            ? '준비됨 (ready)'
            : ready > 0
              ? '일부 불가 (degraded)'
              : '불가 (unavailable)';
      rows.push([capability, state, `${ready}/${registered.length}`]);
    }
    const selection = this.sources.providers.chatSelection;
    const fields: OpsField[] = selection === undefined ? [] : [{
      label: '대화 공급자 선택 (QUOKY_CHAT_PROVIDER)',
      value: selection.source === 'QUOKY_CHAT_PROVIDER'
        ? selection.provider
        : `${selection.provider} (QUOKY_OLLAMA_ENABLED에서 결정)`,
    }];
    return {
      fields: [
        ...fields,
        { label: '이미지 이해 공급자 (설정)', value: imageSelectionLabel(this.sources.imageUnderstanding) },
      ],
      table: { columns: ['기능', '상태', '준비/등록'], rows, emptyText: '등록된 공급자가 없어요.' },
      notes: [
        '공급자 이름은 표시하지 않아요 (ARCHITECTURE.md §5.3/§12, 소유자 결정 14 대기).',
        '예외: 이미지 이해는 소유자가 설정한 선택값(QUOKY_IMAGE_UNDERSTANDING_PROVIDER)을 보여 줘요 (ADR-0111 개정 A5). ' +
          '준비 상태는 위 표의 IMAGE_UNDERSTANDING 행이에요.',
        '예외: 대화는 소유자가 설정한 선택값(QUOKY_CHAT_PROVIDER)과 그 출처를 보여 줘요 (ADR-0092 개정).',
      ],
    };
  }

  private async reminders(owner: OpsOwnerResolution): Promise<PanelBody> {
    const config = this.sources.reminders;
    const fields: OpsField[] = [
      { label: '알림 기능', value: config.enabled ? '켜짐' : '꺼짐' },
      { label: '채널 전달 옵트인', value: config.channelDelivery ? '켜짐' : '꺼짐 (DM만)' },
    ];
    if (owner.status !== 'RESOLVED') return { fields, notes: [ownerNote(owner)] };
    const reminders = [...(await config.listActiveByActor(owner.actorId))].sort((a, b) => a.displayNo - b.displayNo);
    const rows = reminders.slice(0, OPS_MAX_TABLE_ROWS).map((reminder) => {
      const next = reminder.nextFireAt ?? reminder.occurrenceAt;
      const target =
        reminder.kind !== 'BRIEF' && config.channelDelivery && reminder.origin.spaceId !== undefined ? '채널' : 'DM';
      const last = reminder.lastOutcome;
      const lastText =
        last === undefined
          ? '-'
          : `${last.outcome}${last.via ? ` (${last.via})` : ''}${last.reason ? ` ${last.reason}` : ''} · ${this.time(last.recordedAt)}`;
      return [
        `#${reminder.displayNo}`,
        this.time(next),
        reminderRepeatLabel(reminder.schedule),
        reminder.status === ReminderStatus.FIRING ? 'FIRING (전달 중)' : reminder.status,
        target,
        lastText,
        reminderLabel(reminder),
      ];
    });
    const notes = ['예정(SCHEDULED)과 전달 중(FIRING)인 알림만 보여요. 끝난 알림 기록은 Phase 1에서 보이지 않아요.'];
    if (reminders.length > rows.length) notes.push(`외 ${reminders.length - rows.length}건은 생략했어요.`);
    const cancelable = this.sources.handling?.reminderCancel === true && config.enabled;
    const rowLinks = cancelable
      ? reminders
          .slice(0, OPS_MAX_TABLE_ROWS)
          .map((reminder) =>
            reminder.status === ReminderStatus.SCHEDULED
              ? { label: '취소…', href: `/actions/reminders/cancel?no=${reminder.displayNo}` }
              : null,
          )
      : undefined;
    return {
      fields,
      table: {
        columns: ['번호', '다음 시각', '반복', '상태', '대상', '지난 결과', '내용 (알림 목록과 같음)'],
        rows,
        emptyText: '예정된 알림이 없어요.',
        ...(rowLinks === undefined ? {} : { rowLinks }),
      },
      notes,
    };
  }

  private async approvals(now: string): Promise<PanelBody> {
    const nowMs = Date.parse(now);
    const pending = [...(await this.sources.approvals.list())]
      .filter((approval) => approval.status === ApprovalStatus.PENDING)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const rows = pending.slice(0, OPS_MAX_TABLE_ROWS).map((approval) => {
      const createdMs = Date.parse(approval.createdAt);
      const expiresMs = Number.isFinite(createdMs) ? createdMs + OPS_APPROVAL_TTL_MS : Number.NaN;
      const expired = !Number.isFinite(expiresMs) || expiresMs <= nowMs;
      return [
        approval.id.slice(0, 8),
        approval.riskLevel,
        operationKind(approval),
        this.time(approval.createdAt),
        Number.isFinite(expiresMs) ? this.time(new Date(expiresMs).toISOString()) : OPS_UNKNOWN,
        expired ? 'PENDING (만료됨, 다음 대화에서 기록)' : 'PENDING',
      ];
    });
    const decidable = this.sources.handling?.approvals === true;
    const notes = decidable
      ? [
          '내용(미리보기, diff, 대상, 설명)은 표시하지 않아요. 거절은 여기서도 되고, 승인은 채팅 미리보기의 "운영 화면 확인 코드"가 있어야 해요.',
          '승인은 기록만 해요. 실제 실행(커밋, 푸시, PR, 머지, 게시 등)은 채팅의 실행 문구로만 해요.',
        ]
      : ['내용(미리보기, diff, 대상, 설명)은 표시하지 않아요. 승인과 거절은 채팅에서 해요.'];
    if (pending.length > rows.length) notes.push(`외 ${pending.length - rows.length}건은 생략했어요.`);
    const rowLinks = decidable
      ? pending.slice(0, OPS_MAX_TABLE_ROWS).map((approval) => ({ label: '처리…', href: `/approvals/decide?id=${encodeURIComponent(approval.id)}` }))
      : undefined;
    return {
      fields: [],
      table: {
        columns: ['ID', '위험도', '작업 종류', '생성', '만료', '상태'],
        rows,
        emptyText: '대기 중인 승인이 없어요.',
        ...(rowLinks === undefined ? {} : { rowLinks }),
      },
      notes,
    };
  }

  private async connectors(): Promise<PanelBody> {
    const registered = this.sources.connectors;
    const sources = [...OPS_KNOWN_CONNECTORS];
    for (const connector of registered) if (!sources.includes(connector.source)) sources.push(connector.source);
    const rows = await Promise.all(
      sources.map(async (source) => {
        const connector = registered.find((c) => c.source === source);
        if (connector === undefined) return [source, '아니요', '아니요', '아니요', '-', '-'];
        const probedAt = this.time(this.sources.clock());
        const probe = await probeConnector(connector);
        return [source, '예', '예', connector.readOnly ? '아니요' : '예', probe, probedAt];
      }),
    );
    return {
      fields: [],
      table: {
        columns: ['커넥터', '설정됨', '읽기', '쓰기', '마지막 확인', '확인 시각'],
        rows,
        emptyText: '커넥터가 없어요.',
      },
      notes: ['주소, 토큰, 계정 ID, 검색어는 표시하지 않아요.'],
    };
  }

  private errors(): PanelBody {
    const entries = this.sources.errors.recent();
    return {
      fields: [{ label: '보관 중', value: `${this.sources.errors.size}건 (최대 100건, 메모리에만)` }],
      table: {
        columns: ['시각', '구성 요소', '분류', '코드', '상관 ID'],
        rows: entries.map((entry) => [
          this.time(entry.at),
          entry.component,
          entry.category,
          entry.code,
          entry.correlationId ?? '-',
        ]),
        emptyText: '이 프로세스가 시작된 뒤 기록된 오류가 없어요.',
      },
      notes: ['메시지 내용, 스택, 프롬프트와 답변은 보관하지 않아요.'],
    };
  }

  private async feedback(owner: OpsOwnerResolution): Promise<PanelBody> {
    if (owner.status !== 'RESOLVED') return { fields: [], notes: [ownerNote(owner)] };
    const summary = await this.sources.feedback.summarize(owner.actorId);
    if (summary === null) throw Object.assign(new Error('FEEDBACK_UNAVAILABLE'), { code: 'FEEDBACK_UNAVAILABLE' });
    const isRating = (kind: FeedbackSignalKind) => kind === FeedbackSignalKind.EXPLICIT_RATING;
    const count = (predicate: (kind: FeedbackSignalKind, value: string) => boolean) =>
      summary.signals.reduce((total, row) => (predicate(row.kind, row.value) ? total + row.count : total), 0);
    const trend = this.sources.feedback.trend ? await this.sources.feedback.trend(owner.actorId) : null;
    return {
      fields: [
        { label: '기록된 대화', value: String(summary.turnCount) },
        { label: '👍', value: String(count((kind, value) => isRating(kind) && value === 'POSITIVE')) },
        { label: '👎', value: String(count((kind, value) => isRating(kind) && value === 'NEGATIVE')) },
        { label: '참고 신호', value: String(count((kind) => !isRating(kind))) },
      ],
      table: {
        columns: ['기능', '대화', '👍', '👎', '참고 신호'],
        rows: summary.byCapability
          .slice(0, OPS_MAX_TABLE_ROWS)
          .map((row) => [
            feedbackCapabilityLabel(row.key),
            String(row.turns),
            String(row.positive),
            String(row.negative),
            String(row.implicit),
          ]),
        emptyText: '최근 30일 동안 기록된 대화가 없어요.',
      },
      notes: [...feedbackTrendLines(trend).slice(1).map((line) => line.replace(/^- /, '👎 비율 추이 · ')), '대화 내용은 표시하지 않아요.'],
    };
  }

  private backup(): PanelBody {
    const status = this.sources.backup();
    if (status === undefined) throw Object.assign(new Error('BACKUP_STATUS_UNAVAILABLE'), { code: 'BACKUP_STATUS_UNAVAILABLE' });
    const last = status.lastRun;
    const verified = status.lastVerified;
    return {
      fields: [
        { label: '정기 백업', value: status.enabled ? '켜짐' : '꺼짐' },
        { label: '작업 상태', value: status.state },
        { label: '마지막 실행', value: last ? `${this.time(last.finishedAt)} · ${last.kind} · ${last.outcome}${last.failure ? ` (${last.failure})` : ''}` : '없음' },
        { label: '마지막 검증 사본', value: verified ? `${this.time(verified.at)} · ${verified.file}` : '없음' },
        {
          label: '검증 (integrity_check, user_version)',
          value: verified ? `예${verified.userVersion !== undefined ? ` (user_version ${verified.userVersion})` : ''}` : '아니요',
        },
        { label: '보관 사본 수', value: String(status.retainedCount) },
        { label: '다음 예정', value: status.nextScheduledAt ? this.time(status.nextScheduledAt) : '없음' },
      ],
      table: {
        columns: ['보관 사본 (파일 이름)'],
        rows: status.retained.slice(0, OPS_MAX_TABLE_ROWS).map((file) => [file]),
        emptyText: '보관된 사본이 없어요.',
      },
      notes: [],
    };
  }

  private async memory(owner: OpsOwnerResolution): Promise<PanelBody> {
    if (owner.status !== 'RESOLVED') return { fields: [], notes: [ownerNote(owner)] };
    const links = this.sources.handling?.memoryForget === true ? [{ label: '기억 잊기 (확인 코드 필요)', href: '/memories' }] : [];
    const source = this.sources.archivedMemoryCount;
    if (source === undefined) return { fields: [{ label: '보관함 기억 수', value: OPS_UNKNOWN }], notes: [], links };
    const { count, capped } = await source(owner.actorId);
    return {
      fields: [{ label: '보관함 기억 수', value: `${count}${capped ? '+' : ''}` }],
      notes: ['기억 내용은 표시하지 않아요.'],
      links,
    };
  }
}

/** `YYYY-MM-DD HH:mm:ss` in the owner's zone, or `unknown`. */
export function formatOpsTime(iso: string | undefined, timeZone: string): string {
  if (iso === undefined) return OPS_UNKNOWN;
  try {
    const z = toZonedDateTime(iso, timeZone);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${z.year}-${pad(z.month)}-${pad(z.day)} ${pad(z.hour)}:${pad(z.minute)}:${pad(z.second)}`;
  } catch {
    return OPS_UNKNOWN;
  }
}

function ownerNote(owner: OpsOwnerResolution): string {
  return owner.status === 'AMBIGUOUS'
    ? '소유자 ID가 여러 Actor에 연결되어 있어 표시하지 않아요.'
    : '소유자 Actor가 아직 없어요 (봇에게 한 번 메시지를 보내면 생겨요).';
}

/** As `알림 목록` shows it: the brief's fixed label, or the first 60 code points; hidden when the body is guarded. */
export function reminderLabel(reminder: Pick<Reminder, 'kind' | 'body'>): string {
  if (reminder.kind === 'BRIEF') return '오늘의 브리핑(DM)';
  if (learningTextHasCredential(reminder.body)) return OPS_HIDDEN;
  const chars = Array.from(reminder.body);
  return chars.length <= OPS_REMINDER_LABEL_CHARS ? reminder.body : `${chars.slice(0, OPS_REMINDER_LABEL_CHARS - 1).join('')}…`;
}

/** The plan integrity kind when it is a short identifier; never the plan goal, reason or any payload. */
export function operationKind(approval: Pick<ApprovalRequest, 'executionPlanRef'>): string {
  const kind = approval.executionPlanRef.integrity?.kind;
  return kind !== undefined && /^[a-z][a-z0-9._-]{0,47}$/.test(kind) ? kind : '미지정';
}

function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${days > 0 ? `${days}일 ` : ''}${hours}시간 ${minutes}분 ${seconds}초`;
}

async function probeConnector(connector: OpsConnectorView): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'PROBE_TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('PROBE_TIMEOUT'), CONNECTOR_PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    const result = await Promise.race([connector.isAvailable().then((ok) => (ok ? '사용 가능' : '사용 불가')), timeout]);
    return result;
  } catch {
    return 'PROBE_FAILED';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A view-model source that rebuilds at most once per `minIntervalMs` (ADR-0113 D6: bounded poll ≥ 10 s), sharing an
 * in-flight build between concurrent requests.
 */
export function cachedViewSource(
  build: () => Promise<OpsViewModel>,
  minIntervalMs: number,
  nowMs: () => number = Date.now,
): () => Promise<OpsViewModel> {
  let cached: { at: number; view: OpsViewModel } | null = null;
  let inFlight: Promise<OpsViewModel> | null = null;
  return () => {
    if (cached !== null && nowMs() - cached.at < minIntervalMs) return Promise.resolve(cached.view);
    if (inFlight !== null) return inFlight;
    inFlight = build()
      .then((view) => {
        cached = { at: nowMs(), view };
        return view;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

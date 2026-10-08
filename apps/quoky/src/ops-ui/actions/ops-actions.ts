import {
  REMINDER_LIMITS,
  ReminderStatus,
  isStrictCredentialMemoryText,
  learningTextHasCredential,
  maskedMemoryText,
  memoryPreview,
  renderConnectorWriteOpsApprovedNotice,
} from '@quoky/core';
import type {
  Actor,
  ApprovalDecisionService,
  ApprovalGateKind,
  ApprovalSurfaceDecision,
  ApprovalSurfaceRefusal,
  ConnectorWriteApprovedNotice,
  ConversationContext,
  Id,
  IsoTimestamp,
  Logger,
  MemoryCommandOutcome,
  MemoryCommandService,
  NotificationSinkOutcome,
  OwnerNotification,
  ReminderCancelStatus,
  ReminderConversationService,
  ReminderRepository,
  Session,
} from '@quoky/core';

import { APPROVAL_KIND_LABEL } from '../approval-kind-label';
import type {
  OpsActionOutcome,
  OpsActions,
  OpsApprovalDecision,
  OpsApprovalPreview,
  OpsForgetRequest,
  OpsMemoryList,
  OpsReminderCancelPreview,
} from '../http/view-model';
import { OPS_APPROVAL_TTL_MS, formatOpsTime, reminderLabel } from '../snapshot/build-snapshot';
import type { OpsOwnerResolution } from '../snapshot/build-snapshot';
import { guardText } from '../snapshot/guard';

/**
 * OPS-2 / OPS-2b owner handling (ADR-0113 D7): reminder cancel and memory forget (OPS-2), approve and reject (OPS-2b).
 *
 * - **Approve and reject (OPS-2b).** Through the Core `ApprovalDecisionService` the chat decision turns call (one decision
 *   implementation, no copy of its semantics here), as the owner Actor with the `ops-ui` marker. Approve needs the chat
 *   preview's confirmation reference and records the approval only: every execution still needs its exact chat phrase.
 *   A decision's result goes to the owner DM once as `OPS_DECISION_RESULT` (bounded, never a channel, never resent);
 *   the UI gets only the outcome category and the delivery category, never the reply text.
 *
 * - **Owner identity.** Every call resolves the owner `Actor` through the ADR-0009 identity mapping (read-only). If the
 *   configured owner ids map to zero or several Actors, every action is refused (`ACTIONS_DISABLED`), fail closed.
 * - **No bypass.** Each action calls the same Core application service as the chat command, with that Actor:
 *   `ReminderConversationService.cancelByDisplayNo` (the chat `알림 N 취소` entry) and
 *   `MemoryCommandService.requestForgetConfirmation` / `confirmForget` (the chat `기억 N 잊어줘` / `기억 확인 <code>`
 *   entries, same content-bound one-time code). This module never writes a repository itself; its only direct read
 *   is `ReminderRepository.getByDisplayNo` for the cancel confirmation page.
 * - **Display.** Outcomes are fixed copy and a code; never a chat reply body. The only memory text shown is the
 *   bounded, masked preview chat shows, passed through the strict guard again ({@link guardText}).
 * - **Audit.** Content-free log lines (`ops-ui.action`, `surface: ops-ui`) with the outcome code only.
 */

export interface OpsActionsDeps {
  readonly owner: () => Promise<OpsOwnerResolution>;
  readonly clock: () => IsoTimestamp;
  readonly timeZone: string;
  readonly reminders?: {
    readonly service: Pick<ReminderConversationService, 'cancelByDisplayNo'>;
    readonly repository: Pick<ReminderRepository, 'getByDisplayNo'>;
  };
  readonly memory?: Pick<MemoryCommandService, 'listable' | 'requestForgetConfirmation' | 'confirmForget'> & {
    readonly archiveDays?: number;
  };
  /** OPS-2b approval handling; absent = no approve/reject entry. */
  readonly approvals?: {
    readonly decisions: Pick<ApprovalDecisionService, 'locateForOpsUi' | 'decideFromOpsUi'>;
    /** The owner Actor record (read-only). */
    readonly actor: (actorId: Id) => Promise<Actor | null>;
    /** The open conversations to search for the approval's holder (read fresh per request). */
    readonly sessions: () => Promise<readonly Session[]>;
    /** The owner notification sink (ADR-0101; `OPS_DECISION_RESULT` per the ADR-0113 D7 amendment). */
    readonly notify: (notification: OwnerNotification) => Promise<NotificationSinkOutcome>;
  };
  readonly logger: Logger;
}

/** Most memories one handling page lists (chat pages the rest with `기억 목록 N`). */
export const OPS_MEMORY_PAGE_MAX_ROWS = 100;

const DISABLED: OpsActionOutcome = {
  code: 'ACTIONS_DISABLED',
  message: '소유자 ID가 정확히 하나의 Actor에 연결되어 있지 않아 처리할 수 없어요. 채팅을 쓰세요.',
  ok: false,
};
const UNAVAILABLE: OpsActionOutcome = { code: 'ACTION_UNAVAILABLE', message: '이 처리는 지금 쓸 수 없어요.', ok: false };
const FAILED: OpsActionOutcome = { code: 'FAILED', message: '처리하지 못했어요. 잠시 뒤 다시 시도하세요.', ok: false };

const REMINDER_OUTCOMES: Readonly<Record<ReminderCancelStatus, OpsActionOutcome>> = {
  CANCELED: { code: 'CANCELED', message: '알림을 취소했어요. 더 이상 보내지 않아요.', ok: true },
  NOT_FOUND: { code: 'NOT_FOUND', message: '그 번호의 알림을 찾지 못했어요.', ok: false },
  ALREADY_FINAL: { code: 'ALREADY_FINAL', message: '이미 끝났거나 취소된 알림이에요.', ok: false },
  IN_FLIGHT: { code: 'IN_FLIGHT', message: '지금 전달 중이라 취소할 수 없어요.', ok: false },
  DISABLED: { code: 'REMINDERS_DISABLED', message: '알림 기능이 꺼져 있어요.', ok: false },
  FAILED,
};

function forgetOutcome(outcome: MemoryCommandOutcome, archiveDays: number | undefined): OpsActionOutcome {
  switch (outcome) {
    case 'forgotten':
      return {
        code: 'FORGOTTEN',
        message:
          archiveDays !== undefined && archiveDays > 0
            ? `기억을 잊었어요. 이제 대화에 쓰지 않아요. 보관함에 ${archiveDays}일 동안 두어요 (비밀처럼 보이는 기억은 바로 지워요).`
            : '기억을 잊었어요. 이제 대화에 쓰지 않아요.',
        ok: true,
      };
    case 'forget-incomplete':
      return { code: 'FORGET_INCOMPLETE', message: '일부만 처리됐어요. 기억 목록에서 다시 잊기를 요청하세요.', ok: false };
    case 'confirm-unknown':
      return { code: 'CODE_UNKNOWN', message: '확인 코드가 만료됐거나 이미 쓰였어요. 기억 목록에서 다시 시작하세요.', ok: false };
    case 'confirm-stale':
      return { code: 'CODE_STALE', message: '그 사이 기억이 바뀌어서 잊지 않았어요. 기억 목록에서 다시 시작하세요.', ok: false };
    case 'failed':
      return FAILED;
    default:
      return { code: 'UNEXPECTED', message: '예상하지 못한 결과예요. 채팅의 기억 목록으로 확인하세요.', ok: false };
  }
}


const APPROVAL_REFUSALS: Readonly<Record<ApprovalSurfaceRefusal, OpsActionOutcome>> = {
  NOT_FOUND: { code: 'NOT_FOUND', message: '대기 중인 그 승인 요청을 찾지 못했어요. 이미 처리됐거나 만료됐을 수 있어요.', ok: false },
  FOREIGN: { code: 'FOREIGN', message: '소유자의 대화가 아닌 승인 요청이라 처리하지 않았어요.', ok: false },
  ALREADY_DECIDED: { code: 'ALREADY_DECIDED', message: '이미 결정된 승인 요청이에요. 아무것도 바꾸지 않았어요.', ok: false },
  APPROVE_IN_CHAT: {
    code: 'APPROVE_IN_CHAT',
    message: '이 승인은 승인하는 순간 작업이 이어서 실행돼서 채팅에서만 승인할 수 있어요. 거절은 여기서도 돼요.',
    ok: false,
  },
  REFERENCE_REQUIRED: { code: 'REFERENCE_REQUIRED', message: '채팅 미리보기의 운영 화면 확인 코드를 입력하세요.', ok: false },
  REFERENCE_MISMATCH: {
    code: 'REFERENCE_MISMATCH',
    message: '확인 코드가 맞지 않아 승인하지 않았어요. 채팅 미리보기의 가장 최근 코드를 확인하세요.',
    ok: false,
  },
  REFERENCE_LOCKED: {
    code: 'REFERENCE_LOCKED',
    message: '확인 코드가 여러 번 틀려서 이 승인 요청은 30분 동안 운영 화면에서 승인할 수 없어요. 채팅에서는 그대로 결정할 수 있어요.',
    ok: false,
  },
};

const NOTICE_LABEL: Readonly<Record<NotificationSinkOutcome['status'] | 'FAILED', string>> = {
  SENT: 'DM으로 결과를 보냈어요.',
  NOT_SENT: 'DM 결과 알림은 보내지 못했어요. 채팅에서 확인하세요.',
  UNCERTAIN: 'DM 결과 알림이 전달됐는지 확인하지 못했어요 (다시 보내지 않아요).',
  FAILED: 'DM 결과 알림은 보내지 못했어요. 채팅에서 확인하세요.',
};

/**
 * The owner-DM result text (ADR-0113 D7): a fixed header and the reply chat would have shown, bounded and guarded. An
 * approved connector write (`connectorWrite`) gets the Core notice instead of the chat reply: what was approved, where
 * its exact phrase must be sent (execution is bound to the approving conversation) and for how long.
 */
export function opsDecisionResultText(
  kind: ApprovalGateKind,
  outcome: 'APPROVED' | 'REJECTED' | 'EXPIRED',
  reply: string,
  connectorWrite?: ConnectorWriteApprovedNotice & { readonly chat: ConversationContext },
): string {
  if (outcome === 'APPROVED' && connectorWrite !== undefined) {
    const notice = `[Quoky 운영 화면] ${renderConnectorWriteOpsApprovedNotice(connectorWrite)}`;
    if (!learningTextHasCredential(notice)) return bounded(notice);
  }
  const verb =
    outcome === 'APPROVED' ? '운영 화면에서 승인했어요' : outcome === 'REJECTED' ? '운영 화면에서 거절했어요' : '만료돼서 자동 거절로 기록했어요';
  const header = `[Quoky 운영 화면] ${APPROVAL_KIND_LABEL[kind]} 승인 요청을 ${verb}. 이어지는 단계는 채팅에서 해요.`;
  if (learningTextHasCredential(reply)) return header;
  return bounded(`${header}\n${reply}`);
}

function bounded(text: string): string {
  const chars = Array.from(text);
  const max = REMINDER_LIMITS.maxDeliveredTextChars;
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** A link back to the originating Discord conversation (ids only), or undefined. */
export function chatLinkOf(chat: ConversationContext): string | undefined {
  if (chat.platform !== 'discord') return undefined;
  const target = chat.threadId ?? chat.channelId;
  if (!/^[0-9]{1,20}$/.test(target) || (chat.spaceId !== undefined && !/^[0-9]{1,20}$/.test(chat.spaceId))) return undefined;
  return `https://discord.com/channels/${chat.spaceId ?? '@me'}/${target}`;
}

function guardOutcome(outcome: OpsActionOutcome): OpsActionOutcome {
  return { code: guardText(outcome.code), message: guardText(outcome.message), ok: outcome.ok };
}

export class OpsUiActions implements OpsActions {
  constructor(private readonly deps: OpsActionsDeps) {}

  async reminderCancelPreview(displayNo: number): Promise<OpsReminderCancelPreview> {
    const reminders = this.deps.reminders;
    if (reminders === undefined) return { status: 'REFUSED', outcome: UNAVAILABLE };
    return this.asOwner(
      async (actorId): Promise<OpsReminderCancelPreview> => {
        const reminder = await reminders.repository.getByDisplayNo(actorId, displayNo);
        if (reminder === null || (reminder.status !== ReminderStatus.SCHEDULED && reminder.status !== ReminderStatus.FIRING)) {
          return { status: 'REFUSED', outcome: guardOutcome(REMINDER_OUTCOMES.NOT_FOUND) };
        }
        return {
          status: 'FOUND',
          displayNo: reminder.displayNo,
          label: guardText(reminderLabel(reminder)),
          nextAt: guardText(formatOpsTime(reminder.nextFireAt ?? reminder.occurrenceAt, this.deps.timeZone)),
        };
      },
      (outcome) => ({ status: 'REFUSED', outcome }),
    );
  }

  async cancelReminder(displayNo: number): Promise<OpsActionOutcome> {
    const reminders = this.deps.reminders;
    if (reminders === undefined) return this.audited('reminder.cancel', UNAVAILABLE);
    const outcome = await this.asOwner(
      async (actorId) => {
        const result = await reminders.service.cancelByDisplayNo({ actorId, displayNo, now: this.deps.clock() });
        return REMINDER_OUTCOMES[result.status];
      },
      (refused) => refused,
    );
    return this.audited('reminder.cancel', outcome);
  }

  async listMemories(): Promise<OpsMemoryList> {
    const memory = this.deps.memory;
    if (memory === undefined) return { status: 'REFUSED', outcome: UNAVAILABLE };
    return this.asOwner(
      async (actorId): Promise<OpsMemoryList> => {
        const records = await memory.listable(actorId, this.deps.clock());
        const rows = records.slice(0, OPS_MEMORY_PAGE_MAX_ROWS).map((record, index) => ({
          number: index + 1,
          // Exactly the `기억 목록` preview (ADR-0106 D3, ADR-0113 D9), then the strict guard again.
          preview: guardText(isStrictCredentialMemoryText(record.content) ? maskedMemoryText('ko') : memoryPreview(record.content)),
        }));
        return { status: 'OK', rows, total: records.length };
      },
      (outcome) => ({ status: 'REFUSED', outcome }),
    );
  }

  async requestForget(number: number): Promise<OpsForgetRequest> {
    const memory = this.deps.memory;
    if (memory === undefined) return { status: 'REFUSED', outcome: UNAVAILABLE };
    return this.asOwner(
      async (actorId): Promise<OpsForgetRequest> => {
        const issued = await memory.requestForgetConfirmation({ actorId, now: this.deps.clock() }, number, 'ko');
        if (issued.status === 'NOT_FOUND') {
          return {
            status: 'REFUSED',
            outcome: guardOutcome({ code: 'NOT_FOUND', message: '그 번호의 기억을 찾지 못했어요.', ok: false }),
          };
        }
        return { status: 'CONFIRMATION', number: issued.number, preview: guardText(issued.preview), code: issued.code };
      },
      (outcome) => ({ status: 'REFUSED', outcome }),
    );
  }

  async confirmForget(code: string): Promise<OpsActionOutcome> {
    const memory = this.deps.memory;
    if (memory === undefined) return this.audited('memory.forget', UNAVAILABLE);
    const outcome = await this.asOwner(
      async (actorId) => {
        const result = await memory.confirmForget({ actorId, now: this.deps.clock() }, code, 'ko');
        return forgetOutcome(result.outcome, memory.archiveDays);
      },
      (refused) => refused,
    );
    return this.audited('memory.forget', outcome);
  }

  async approvalPreview(approvalId: string): Promise<OpsApprovalPreview> {
    const approvals = this.deps.approvals;
    if (approvals === undefined) return { status: 'REFUSED', outcome: UNAVAILABLE };
    return this.asOwner(
      async (actorId): Promise<OpsApprovalPreview> => {
        const actor = await approvals.actor(actorId);
        if (actor === null) return { status: 'REFUSED', outcome: DISABLED };
        const located = await approvals.decisions.locateForOpsUi(approvalId, actor, approvals.sessions);
        if (located.status !== 'FOUND') return { status: 'REFUSED', outcome: guardOutcome(APPROVAL_REFUSALS[located.refusal]) };
        const { view } = located;
        const expiresMs = Date.parse(view.createdAt) + OPS_APPROVAL_TTL_MS;
        const chatLink = chatLinkOf(view.chat);
        return {
          status: 'FOUND',
          approvalId: view.approvalId,
          shortId: guardText(view.approvalId.slice(0, 8)),
          kindLabel: APPROVAL_KIND_LABEL[view.kind],
          riskLevel: guardText(view.riskLevel),
          createdAt: guardText(formatOpsTime(view.createdAt, this.deps.timeZone)),
          expiresAt: guardText(Number.isFinite(expiresMs) ? formatOpsTime(new Date(expiresMs).toISOString(), this.deps.timeZone) : 'unknown'),
          approvable: view.approvable,
          chatPlace: view.chat.spaceId === undefined ? 'DM' : '채널',
          ...(chatLink === undefined ? {} : { chatLink }),
        };
      },
      (outcome) => ({ status: 'REFUSED', outcome }),
    );
  }

  async decideApproval(approvalId: string, decision: OpsApprovalDecision, reference: string): Promise<OpsActionOutcome> {
    const approvals = this.deps.approvals;
    const action = `approval.${decision}`;
    if (approvals === undefined) return this.audited(action, UNAVAILABLE);
    const outcome = await this.asOwner(
      async (actorId) => {
        const actor = await approvals.actor(actorId);
        if (actor === null) return DISABLED;
        const decided = await approvals.decisions.decideFromOpsUi({
          approvalId,
          decision,
          actor,
          ...(decision === 'approve' ? { reference } : {}),
          sessions: approvals.sessions,
        });
        return this.decisionOutcome(approvalId, decided, approvals.notify);
      },
      (refused) => refused,
    );
    return this.audited(action, outcome);
  }

  /** Map the shared decision's result to the UI category, delivering the `OPS_DECISION_RESULT` once when it decided. */
  private async decisionOutcome(
    approvalId: string,
    decided: ApprovalSurfaceDecision,
    notify: (notification: OwnerNotification) => Promise<NotificationSinkOutcome>,
  ): Promise<OpsActionOutcome> {
    if (decided.status === 'REFUSED') return APPROVAL_REFUSALS[decided.refusal];
    if (decided.outcome === 'UNAVAILABLE') {
      return {
        code: 'APPROVAL_CONTEXT_UNAVAILABLE',
        message: '이 승인 요청의 문맥을 확인하지 못해 결정하지 않았어요. 채팅에서 확인하세요.',
        ok: false,
      };
    }
    let delivery: NotificationSinkOutcome['status'] | 'FAILED';
    try {
      const sent = await notify({
        correlationId: `ops-decision-result-${approvalId.slice(0, 8)}-${Date.parse(this.deps.clock())}`,
        // Owner DM only (ADR-0113 D7): no guild, so no channel routing is possible.
        target: { platform: decided.chat.platform, channelId: '', userId: decided.chat.userId },
        kind: 'OPS_DECISION_RESULT',
        text: opsDecisionResultText(
          decided.kind,
          decided.outcome,
          decided.reply.text,
          decided.connectorWrite === undefined ? undefined : { ...decided.connectorWrite, chat: decided.chat },
        ),
      });
      delivery = sent.status;
    } catch {
      delivery = 'FAILED';
    }
    this.log(delivery === 'SENT' ? 'info' : 'warn', 'ops-ui.decision_result_notice', { surface: 'ops-ui', outcome: decided.outcome, delivery });
    const head =
      decided.outcome === 'APPROVED'
        ? `${APPROVAL_KIND_LABEL[decided.kind]} 승인을 기록했어요. 실제 실행은 지금처럼 채팅의 실행 문구로 해요.`
        : decided.outcome === 'REJECTED'
          ? `${APPROVAL_KIND_LABEL[decided.kind]} 승인 요청을 거절했어요.`
          : '승인 요청이 이미 만료돼서 자동 거절로 기록했어요. 필요하면 채팅에서 다시 요청하세요.';
    return { code: decided.outcome, message: `${head} ${NOTICE_LABEL[delivery]}`, ok: decided.outcome !== 'EXPIRED' };
  }

  /** Run `act` as the owner Actor; refused (fail closed) when the owner ids do not map to exactly one Actor. */
  private async asOwner<T>(act: (actorId: Id) => Promise<T>, refused: (outcome: OpsActionOutcome) => T): Promise<T> {
    let owner: OpsOwnerResolution;
    try {
      owner = await this.deps.owner();
    } catch {
      owner = { status: 'NONE' };
    }
    if (owner.status !== 'RESOLVED') return refused(DISABLED);
    try {
      return await act(owner.actorId);
    } catch (error) {
      this.log('warn', 'ops-ui.action_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      return refused(FAILED);
    }
  }

  private audited(action: string, outcome: OpsActionOutcome): OpsActionOutcome {
    this.log('info', 'ops-ui.action.executed', { surface: 'ops-ui', action, outcome: outcome.code });
    return guardOutcome(outcome);
  }

  private log(level: 'info' | 'warn', event: string, fields: Record<string, string>): void {
    try {
      this.deps.logger[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

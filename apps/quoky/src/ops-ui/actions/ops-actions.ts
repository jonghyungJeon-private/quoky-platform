import { ReminderStatus, isStrictCredentialMemoryText, maskedMemoryText, memoryPreview } from '@quoky/core';
import type {
  Id,
  IsoTimestamp,
  Logger,
  MemoryCommandOutcome,
  MemoryCommandService,
  ReminderCancelStatus,
  ReminderConversationService,
  ReminderRepository,
} from '@quoky/core';

import type {
  OpsActionOutcome,
  OpsActions,
  OpsForgetRequest,
  OpsMemoryList,
  OpsReminderCancelPreview,
} from '../http/view-model';
import { formatOpsTime, reminderLabel } from '../snapshot/build-snapshot';
import type { OpsOwnerResolution } from '../snapshot/build-snapshot';
import { guardText } from '../snapshot/guard';

/**
 * OPS-2 owner handling (ADR-0113 D7): reminder cancel and memory forget only. Approve and reject are OPS-2b (W6),
 * after the approval decision path is extracted from `conversation-runtime.ts`; nothing here can decide an approval.
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

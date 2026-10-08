import type { ConversationContext } from '../../domain';
import type {
  CalendarEventDraft,
  CalendarEventTime,
  ConnectorWriteNotSentReason,
  ConnectorWriteOperation,
  ConnectorWriteOutcome,
} from '../../ports/connector-write.port';
import { containsCredentialMaterial } from '../credential-guard';
import { toZonedDateTime } from '../reminders/zoned-time';
import { escapeDiscordText } from '../work-chat/external-work-readout';
import type { ConnectorWriteUsageTopic } from './connector-write-draft';
import type {
  ConnectorWriteApprovedElsewhere,
  ConnectorWriteChoiceBasis,
  ConnectorWriteLatestRequest,
  ConnectorWriteCloseReason,
  ConnectorWriteEventSummary,
  ConnectorWritePreview,
  ConnectorWriteRefusal,
  ConnectorWriteRecentSend,
  ConnectorWriteStep,
  ConnectorWriteTargetSummary,
} from './connector-write-flow';

/**
 * Deterministic copy for the connector-write flow (ADR-0112 D5/D6, ADR-0110 amendment D4; CWR-2). Pure functions; the
 * `ResponseComposer` delegates to them so reply text still lives behind the composer.
 *
 * Truthfulness rules: nothing here says a write happened unless the step is a `SENT` outcome (or a repeat of one);
 * `UNCERTAIN` always says it MAY have been written and that nothing is retried; every refusal and every pre-execution
 * reply says nothing was sent or changed. The owner's comment / message text is shown verbatim in a fenced block (no
 * markdown, mention or link expansion); event text read from the calendar is untrusted and escaped.
 */

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

export function connectorWriteLabel(operation: ConnectorWriteOperation): string {
  switch (operation) {
    case 'ISSUE_COMMENT':
      return 'Jira 댓글';
    case 'ISSUE_TRANSITION':
      return 'Jira 상태 변경';
    case 'CHANNEL_POST':
      return 'Slack 게시';
    case 'CALENDAR_EVENT_CREATE':
      return '캘린더 일정 추가';
    case 'CALENDAR_EVENT_UPDATE':
      return '캘린더 일정 변경';
    case 'CALENDAR_EVENT_DELETE':
      return '캘린더 일정 삭제';
  }
}

/** True when the last Korean syllable of `word` ends in a final consonant (batchim); false for non-Hangul endings. */
function hasBatchim(word: string): boolean {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

/** "Jira 댓글" → "Jira 댓글을", "Slack 게시" → "Slack 게시를" (the object particle chosen by the final consonant). */
function withObjectParticle(word: string): string {
  return `${word}${hasBatchim(word) ? '을' : '를'}`;
}

/** "Jira 댓글" → "Jira 댓글은", "Slack 게시" → "Slack 게시는". */
function withTopicParticle(word: string): string {
  return `${word}${hasBatchim(word) ? '은' : '는'}`;
}

function isCalendar(operation: ConnectorWriteOperation): boolean {
  return operation.startsWith('CALENDAR_');
}

/**
 * What "nothing happened" means for an operation — scoped to THIS request (Codex P2 on a2b8aed): an earlier write in the
 * same conversation may still be unconfirmed, so no reply may say that nothing at all was ever sent.
 */
function nothingDone(operation: ConnectorWriteOperation | 'calendar' | 'external'): string {
  return notDoneByThisRequest(operation === 'calendar' || (operation !== 'external' && isCalendar(operation)));
}

/** "이 요청으로는 아무것도 보내지 않았어요." / "이 요청으로는 캘린더를 바꾸지 않았어요." */
function notDoneByThisRequest(calendar: boolean, yet = false): string {
  return `이 요청으로는 ${yet ? '아직 ' : ''}${calendar ? '캘린더를 바꾸지' : '아무것도 보내지'} 않았어요.`;
}

/** "승인된 Jira 댓글(PROJ-12)은" / "승인된 Slack 게시는" — the approved write, named so a reply speaks only about it. */
function approvedWriteSubject(operation: ConnectorWriteOperation, target?: ConnectorWriteTargetSummary): string {
  return `승인된 ${target ? labelWithTarget(operation, target) : withTopicParticle(connectorWriteLabel(operation))}`;
}

/** A fence longer than any backtick run in `text`, so owner text can never break out of its block. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/gu) ?? ['']).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function inline(value: string): string {
  return containsCredentialMaterial(value) ? '(숨김)' : escapeDiscordText(value);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateLabel(year: number, month: number, day: number): string {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${year}-${pad(month)}-${pad(day)}(${WEEKDAY_KO[weekday]})`;
}

function isoDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!match) return iso;
  return dateLabel(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** "2026-10-07(수) 15:00–16:00 (Asia/Seoul)"; an all-day event shows its dates (the end date is exclusive). */
export function connectorWriteTimeLabel(time: CalendarEventTime, timeZone: string): string {
  if (time.allDay) {
    const last = new Date(Date.parse(`${time.endDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return last === time.startDate ? `${isoDateLabel(time.startDate)} 종일` : `${isoDateLabel(time.startDate)} ~ ${isoDateLabel(last)} 종일`;
  }
  const zone = time.timeZone || timeZone;
  const start = toZonedDateTime(time.start, zone);
  const end = toZonedDateTime(time.end, zone);
  const sameDay = start.year === end.year && start.month === end.month && start.day === end.day;
  const endLabel = sameDay ? `${pad(end.hour)}:${pad(end.minute)}` : `${dateLabel(end.year, end.month, end.day)} ${pad(end.hour)}:${pad(end.minute)}`;
  return `${dateLabel(start.year, start.month, start.day)} ${pad(start.hour)}:${pad(start.minute)}–${endLabel} (${zone})`;
}

function summaryTime(event: ConnectorWriteEventSummary, timeZone: string): string {
  return connectorWriteTimeLabel(
    event.allDay ? { allDay: true, startDate: event.start, endDate: event.end } : { allDay: false, start: event.start, end: event.end, timeZone },
    timeZone,
  );
}

function eventLines(event: CalendarEventDraft, timeZone: string): string[] {
  return [
    `제목: ${inline(event.title)}`,
    `시간: ${connectorWriteTimeLabel(event.time, timeZone)}`,
    ...(event.location !== undefined ? [`장소: ${inline(event.location)}`] : []),
    ...(event.description !== undefined ? ['설명:', fenced(event.description)] : []),
  ];
}

const NO_INVITES = '참석자: 없음 · 초대·변경 메일: 보내지 않음 (sendUpdates=none)';
const PRIMARY = '캘린더: 내 기본 캘린더(primary)';
const UNCHANGED_EVENT_ONLY = '실행할 때 이 일정이 미리보기 그대로일 때만 실행해요. 그사이 일정이 바뀌면 실행하지 않아요.';

function previewBody(preview: ConnectorWritePreview): string[] {
  switch (preview.operation) {
    case 'ISSUE_COMMENT':
      return [`대상: Jira ${preview.issueKey}`, '댓글 내용 (이대로 한 번만 보내요):', fenced(preview.text)];
    case 'ISSUE_TRANSITION':
      return [
        `대상: Jira ${preview.issueKey}`,
        `바꿀 상태: ${inline(preview.toStatus)} (상태 ID ${preview.toStatusId})`,
        `전환: ${inline(preview.transitionName)} (전환 ID ${preview.transitionId})`,
        '실행할 때 이 전환이 그대로 이 상태로 이어질 때만 실행해요. 조건이 바뀌면 실행하지 않아요.',
      ];
    case 'CHANNEL_POST':
      return [`대상: Slack #${inline(preview.channelLabel)} (${preview.channelId})`, '메시지 (이대로 한 번만 보내요):', fenced(preview.text)];
    case 'CALENDAR_EVENT_CREATE':
      return [PRIMARY, ...eventLines(preview.event, preview.timeZone), NO_INVITES];
    case 'CALENDAR_EVENT_UPDATE':
      return [
        PRIMARY,
        `바꿀 일정: ${inline(preview.before.title || '(제목 없음)')} · ${summaryTime(preview.before, preview.timeZone)}`,
        '변경 후:',
        `- 제목: ${inline(preview.after.title || '(제목 없음)')}`,
        `- 시간: ${connectorWriteTimeLabel(preview.after.time, preview.timeZone)}`,
        ...(preview.after.location !== undefined ? [`- 장소: ${inline(preview.after.location)}`] : []),
        UNCHANGED_EVENT_ONLY,
        NO_INVITES,
      ];
    case 'CALENDAR_EVENT_DELETE':
      return [
        PRIMARY,
        `삭제할 일정: ${inline(preview.before.title || '(제목 없음)')} · ${summaryTime(preview.before, preview.timeZone)}`,
        ...(preview.before.location !== undefined ? [`장소: ${inline(preview.before.location)}`] : []),
        UNCHANGED_EVENT_ONLY,
        NO_INVITES,
      ];
  }
}

function minutesOf(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}

export function renderConnectorWritePreview(preview: ConnectorWritePreview, remainingMs: number, executionPhrase: string): string {
  const operation = preview.operation;
  return [
    `${connectorWriteLabel(operation)} 미리보기예요. ${notDoneByThisRequest(isCalendar(operation), true)}`,
    ...previewBody(preview),
    '',
    '위험도: CRITICAL · 이 내용 그대로 한 번만 실행하는 승인이에요. 실패하거나 결과가 불확실해도 자동으로 다시 시도하지 않아요.',
    `"승인"이라고 답한 뒤 "${executionPhrase}"이라고 보내야 실제로 실행돼요. 그만두려면 "거절"이라고 답해 주세요.`,
    `남은 시간: 약 ${minutesOf(remainingMs)}분 (지나면 자동으로 거절돼요)`,
  ].join('\n');
}

/** A non-decision message while the approval is pending (ADR-0093 reminder, with what is pending). */
export function renderConnectorWritePending(preview: ConnectorWritePreview, remainingMs: number, executionPhrase: string): string {
  const operation = preview.operation;
  return [
    `${connectorWriteLabel(operation)} 승인을 기다리고 있어요. ${notDoneByThisRequest(isCalendar(operation), true)}`,
    ...previewBody(preview),
    '',
    `"승인" 또는 "거절"로 답해 주세요. 승인한 뒤 "${executionPhrase}"이라고 보내야 실행돼요.`,
    `남은 시간: 약 ${minutesOf(remainingMs)}분 (지나면 자동으로 거절돼요)`,
    '이 요청을 그만두고 새로 시작하려면 "새 대화"라고 보내 주세요.',
  ].join('\n');
}

export function renderConnectorWriteApproved(operation: ConnectorWriteOperation, executionPhrase: string): string {
  return [
    `${connectorWriteLabel(operation)} 승인을 기록했어요. 아직 실행하지 않았어요.`,
    `실제로 실행하려면 "${executionPhrase}"이라고 보내 주세요. 승인 후 30분이 지나면 다시 요청해야 해요.`,
  ].join('\n');
}

/** A bare "승인" after the approval was already recorded. */
export function renderConnectorWriteAlreadyApproved(operation: ConnectorWriteOperation, executionPhrase: string): string {
  return `${withTopicParticle(connectorWriteLabel(operation))} 이미 승인됐고 아직 실행하지 않았어요. 실행하려면 "${executionPhrase}"이라고 보내 주세요.`;
}

/**
 * A question or negation about the execution step while the write is approved: a non-mutating reminder (W5-L01). It
 * speaks only about the approved write (Codex P2 on a2b8aed: an earlier write of the conversation may be unconfirmed).
 */
export function renderConnectorWriteApprovedReminder(
  operation: ConnectorWriteOperation,
  executionPhrase: string,
  target?: ConnectorWriteTargetSummary,
): string {
  const how = isCalendar(operation) ? '반영하려면' : '보내려면';
  return `${approvedWriteSubject(operation, target)} 아직 실행하지 않았어요. 실제로 ${how} "${executionPhrase}"이라고만 보내 주세요.`;
}

/**
 * A bare execution command ("실행", "실행해줘", "go", "run it") while the write is approved: it names no step, so the
 * approved write did not run; the reply quotes its exact phrase (routing exec gaps). It speaks only about the approved
 * write, so it stays true even after an earlier unconfirmed write in the same conversation (Codex P2 on 039d5ff).
 */
export function renderConnectorWriteBareExecution(
  operation: ConnectorWriteOperation,
  executionPhrase: string,
  target?: ConnectorWriteTargetSummary,
): string {
  return `${approvedWriteSubject(operation, target)} 아직 실행하지 않았어요. 실행할 작업을 정확히 말해 주세요: "${executionPhrase}"`;
}

/**
 * Where a conversation is, for a "send the phrase there" hint: a direct conversation, or a channel (thread) reference
 * written as `<#id>` — the chat-markup channel reference, rendered only for a plain id token (`reference` is absent
 * otherwise). Ids only, never names.
 */
export type ConnectorWriteConversationPlace = { readonly kind: 'dm' } | { readonly kind: 'channel'; readonly reference?: string };

/** Same safe-id rule as everywhere a raw id reaches chat text: letters, digits, `_` and `-` only. */
const PLACE_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function connectorWriteConversationPlace(context: ConversationContext): ConnectorWriteConversationPlace {
  if (context.spaceId === undefined) return { kind: 'dm' };
  const id = context.threadId ?? context.channelId;
  return PLACE_ID.test(id) ? { kind: 'channel', reference: `<#${id}>` } : { kind: 'channel' };
}

/** The full target ("Slack #dev", "Jira PROJ-12", "내 기본 캘린더"). */
export function connectorWriteTargetLabel(target: ConnectorWriteTargetSummary): string {
  switch (target.kind) {
    case 'issue':
      return `Jira ${inline(target.issueKey)}`;
    case 'channel':
      return `Slack #${inline(target.channelLabel)}`;
    case 'calendar':
      return '내 기본 캘린더';
  }
}

/** The target after a label that already names the service ("#dev", "PROJ-12", "기본 캘린더"). */
export function connectorWriteShortTarget(target: ConnectorWriteTargetSummary): string {
  switch (target.kind) {
    case 'issue':
      return inline(target.issueKey);
    case 'channel':
      return `#${inline(target.channelLabel)}`;
    case 'calendar':
      return '기본 캘린더';
  }
}

/** "Slack 게시(#dev)는", "Jira 댓글(PROJ-12)은" — the particle follows the label, not the parenthesis. */
function labelWithTarget(operation: ConnectorWriteOperation, target: ConnectorWriteTargetSummary): string {
  const label = connectorWriteLabel(operation);
  return `${label}(${connectorWriteShortTarget(target)})${hasBatchim(label) ? '은' : '는'}`;
}

/**
 * The execution phrase in a conversation with no approved write of that kind while one waits APPROVED in another
 * conversation: nothing runs here, and the phrase must be sent there (execution is bound to the approving
 * conversation). Names the kind, the target, the place and the time left only — never the payload.
 */
export function renderConnectorWriteApprovedElsewhere(elsewhere: ConnectorWriteApprovedElsewhere): string {
  const place = connectorWriteConversationPlace(elsewhere.context);
  const where = place.kind === 'dm' ? '봇과의 DM' : (place.reference ?? '채널');
  return [
    `실행하지 않았어요. 승인된 ${labelWithTarget(elsewhere.operation, elsewhere.target)} 다른 대화에서 기다리고 있어요 (약 ${minutesOf(elsewhere.remainingMs)}분 남음).`,
    `미리보기를 받은 ${where}에서 "${elsewhere.executionPhrase}"이라고 보내 주세요.`,
  ].join('\n');
}

/**
 * The owner-DM notice of a connector write approved on the operations UI: what was approved, where (and with which
 * exact phrase) it runs, and for how long. The DM itself never runs it unless the approval was asked in the DM.
 */
export function renderConnectorWriteOpsApprovedNotice(notice: {
  readonly operation: ConnectorWriteOperation;
  readonly target: ConnectorWriteTargetSummary;
  readonly executionPhrase: string;
  readonly remainingMs: number;
  readonly chat: ConversationContext;
}): string {
  const label = connectorWriteLabel(notice.operation);
  const step = label.split(' ').slice(1).join(' ');
  const place = connectorWriteConversationPlace(notice.chat);
  const where = place.kind === 'dm' ? '이 DM' : (place.reference ?? '승인을 요청한 채널');
  const run = `실제 ${step}${hasBatchim(step) ? '은' : '는'} ${where}에서 "${notice.executionPhrase}"이라고 보내면 돼요 (승인은 약 ${minutesOf(notice.remainingMs)}분 유효).`;
  return [
    `운영 화면에서 승인했어요: ${label} → ${connectorWriteShortTarget(notice.target)}.`,
    place.kind === 'dm' ? run : `${run} 이 DM에서는 실행되지 않아요.`,
  ].join('\n');
}

/** HH:mm in `timeZone`. */
function clockLabel(instant: string, timeZone: string): string | undefined {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return undefined;
  const zoned = toZonedDateTime(ms, timeZone);
  return `${pad(zoned.hour)}:${pad(zoned.minute)}`;
}

/**
 * The execution phrase repeated after a write of that kind approved in THIS conversation was SENT recently (W5-L02):
 * when and where it went, so it can never be mistaken for another post, and that nothing was sent again.
 */
export function renderConnectorWriteAlreadyExecuted(operation: ConnectorWriteOperation, sent: ConnectorWriteRecentSend): string {
  const calendar = isCalendar(operation);
  const time = clockLabel(sent.sentAt, sent.timeZone);
  const head = `${calendar ? '이미 반영했어요' : '이미 보냈어요'} (${time ? `${time}, ` : ''}${connectorWriteTargetLabel(sent.target)})`;
  const link = linkValue(sent.url, sent.externalRef);
  return [link ? `${head}: ${link}` : `${head}.`, calendar ? '다시 바꾸지 않았어요.' : '다시 보내지 않았어요.'].join('\n');
}

function linkValue(url: string | undefined, externalRef: string | undefined): string | undefined {
  if (url !== undefined && /^https:\/\/[\x21-\x7e]{1,1500}$/u.test(url)) return `<${url}>`;
  if (externalRef !== undefined && externalRef.length > 0 && externalRef.length <= 200 && !containsCredentialMaterial(externalRef)) {
    return `참조 ${escapeDiscordText(externalRef)}`;
  }
  return undefined;
}

function linkLine(url: string | undefined, externalRef: string | undefined): string[] {
  if (url !== undefined && /^https:\/\/[\x21-\x7e]{1,1500}$/u.test(url)) return [`링크: <${url}>`];
  if (externalRef !== undefined && externalRef.length > 0 && externalRef.length <= 200 && !containsCredentialMaterial(externalRef)) {
    return [`참조: ${escapeDiscordText(externalRef)}`];
  }
  return [];
}

const NOT_SENT_REASON_KO: Readonly<Record<ConnectorWriteNotSentReason, string>> = {
  TARGET_NOT_ALLOWED: '허용 목록에 없는 대상이에요',
  INVALID_REQUEST: '요청 형식이 올바르지 않아요',
  UNAUTHORIZED: '인증에 실패했어요',
  FORBIDDEN: '권한이 없어요',
  INSUFFICIENT_SCOPE: '연결된 권한 범위가 부족해요',
  NOT_FOUND: '대상을 찾지 못했어요',
  RATE_LIMITED: '요청 한도를 넘었어요',
  REJECTED: '상대 서비스가 요청을 거부했어요',
  TRANSITION_UNAVAILABLE: '지금은 그 상태로 바꿀 수 없어요',
  RECURRING_SERIES_REFUSED: '반복 일정 전체는 바꾸지 않아요 (한 번짜리 일정만 바꿀 수 있어요)',
  ALREADY_EXISTS: '같은 요청으로 만든 일정이 이미 있어요',
  TARGET_CHANGED: '미리보기 이후 대상이 바뀌었어요',
  UNAVAILABLE: '연결에 실패해서 요청을 보내기 전에 멈췄어요',
};

export function renderConnectorWriteOutcome(operation: ConnectorWriteOperation, outcome: ConnectorWriteOutcome): string {
  const label = connectorWriteLabel(operation);
  switch (outcome.status) {
    case 'SENT':
      return [`${label} 완료: ${sentVerb(operation)}`, ...linkLine(outcome.url, outcome.externalRef)].join('\n');
    case 'NOT_SENT':
      if (outcome.reason === 'TARGET_CHANGED') return targetChangedCopy(operation);
      return [
        `${withObjectParticle(label)} 하지 못했어요: ${NOT_SENT_REASON_KO[outcome.reason] ?? '요청이 거부됐어요'}. ${nothingDone(operation)}`,
        '자동으로 다시 시도하지 않아요. 필요하면 새로 요청해 주세요.',
      ].join('\n');
    case 'UNCERTAIN':
      return [
        `${label} 결과를 확인하지 못했어요. 요청이 이미 전달돼 ${isCalendar(operation) ? '캘린더가 바뀌었을' : '게시됐을'} 수도 있어요.`,
        `중복을 막기 위해 자동으로 다시 시도하지 않아요. ${isCalendar(operation) ? '캘린더' : '대상'}에서 직접 확인해 주세요.`,
      ].join('\n');
  }
}

/** The approved target drifted before the write (ADR-0112): truthfully not executed, and nothing retried. */
function targetChangedCopy(operation: ConnectorWriteOperation): string {
  const reason =
    operation === 'ISSUE_TRANSITION'
      ? 'Jira 상태 전환 조건이 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.'
      : operation === 'ISSUE_COMMENT'
        ? 'Jira 이슈가 미리보기 이후 다른 키로 옮겨져서 실행하지 않았어요. 다시 요청해 주세요.'
        : isCalendar(operation)
          ? '일정이 미리보기 이후에 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.'
          : '대상이 미리보기 이후에 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.';
  return [reason, `${nothingDone(operation)} 자동으로 다시 시도하지 않아요.`].join('\n');
}

function sentVerb(operation: ConnectorWriteOperation): string {
  switch (operation) {
    case 'ISSUE_COMMENT':
      return '댓글을 달았어요.';
    case 'ISSUE_TRANSITION':
      return '상태를 바꿨어요.';
    case 'CHANNEL_POST':
      return '메시지를 게시했어요.';
    case 'CALENDAR_EVENT_CREATE':
      return '일정을 추가했어요. 초대 메일은 보내지 않았어요.';
    case 'CALENDAR_EVENT_UPDATE':
      return '일정을 바꿨어요. 변경 메일은 보내지 않았어요.';
    case 'CALENDAR_EVENT_DELETE':
      return '일정을 삭제했어요. 취소 메일은 보내지 않았어요.';
  }
}

export function renderConnectorWriteRepeat(
  operation: ConnectorWriteOperation,
  status: 'SENT' | 'NOT_SENT' | 'UNCERTAIN' | 'EXECUTING',
  externalRef?: string,
  url?: string,
): string {
  const label = connectorWriteLabel(operation);
  switch (status) {
    case 'SENT':
      return [`이 ${withTopicParticle(label)} 이미 실행했어요. 다시 실행하지 않았어요.`, ...linkLine(url, externalRef)].join('\n');
    case 'NOT_SENT':
      return `이 ${withTopicParticle(label)} 이미 실패로 끝났어요. 다시 실행하지 않아요. 필요하면 새로 요청해 주세요.`;
    default:
      return [
        `이 ${withTopicParticle(label)} 이미 한 번 실행했고 결과를 확인하지 못했어요. 반영됐을 수도 있어요.`,
        '중복을 막기 위해 다시 실행하지 않아요. 직접 확인해 주세요.',
      ].join('\n');
  }
}

/**
 * A 거절/취소 that arrives after execution of the approved write started (Codex P1 on 55c5a2f): it cannot be withdrawn
 * any more; the executing turn reports the outcome. Never says nothing was sent.
 */
export function renderConnectorWriteRevokeTooLate(operation: ConnectorWriteOperation): string {
  return [
    `이 ${withTopicParticle(connectorWriteLabel(operation))} 이미 실행을 시작해서 거절(취소)하지 않았어요.`,
    '결과는 실행한 요청의 답으로 알려 드려요. 다시 실행하지 않아요.',
  ].join('\n');
}

export function renderConnectorWriteAlreadySent(operation: ConnectorWriteOperation, externalRef?: string, url?: string): string {
  return [
    `같은 대상에 같은 내용의 ${withObjectParticle(connectorWriteLabel(operation))} 이미 실행했어요. 이미 보냈어요 — 다시 실행하지 않았어요.`,
    ...linkLine(url, externalRef),
  ].join('\n');
}

/** The first line of a numbered choice: why these events (live QA D2: an undated request says where they came from). */
function choiceHeader(mode: 'update' | 'delete', count: number, basis: ConnectorWriteChoiceBasis | undefined): string {
  const which = `어느 일정을 ${mode === 'update' ? '바꿀지' : '삭제할지'} 번호로 답해 주세요 (예: "1번").`;
  const unchanged = notDoneByThisRequest(true, true);
  switch (basis) {
    case 'listed':
      return `날짜를 말하지 않아서 방금 보여 드린 일정에서 찾았어요 (${count}개). ${which} ${unchanged}`;
    case 'written':
      return `날짜를 말하지 않아서 이 대화에서 방금 추가·변경한 일정을 찾았어요. 이 일정이 맞으면 번호로 답해 주세요 (예: "1번"). ${unchanged}`;
    case 'nearby':
      return `어느 일정인지 말하지 않아서 오늘·내일 일정을 보여 드려요 (${count}개). ${which} 날짜와 시간을 함께 적어도 돼요 (예: "내일 3시 회의 취소해줘"). ${unchanged}`;
    default:
      return `조건에 맞는 일정이 ${count}개예요. ${which} ${unchanged}`;
  }
}

export function renderConnectorWriteChoice(
  mode: 'update' | 'delete',
  candidates: readonly ConnectorWriteEventSummary[],
  timeZone: string,
  basis?: ConnectorWriteChoiceBasis,
): string {
  return [
    choiceHeader(mode, candidates.length, basis),
    ...candidates.map(
      (event, i) =>
        `${i + 1}. ${summaryTime(event, timeZone)} ${inline(event.title || '(제목 없음)')}${event.location !== undefined ? ` (${inline(event.location)})` : ''}`,
    ),
    '다른 말을 보내면 선택은 취소돼요.',
  ].join('\n');
}

const USAGE_KO: Readonly<Record<ConnectorWriteUsageTopic, string>> = {
  'issue-comment': 'Jira 댓글은 "KEY-1에 댓글: 내용"처럼 이슈 키와 콜론 뒤에 보낼 내용을 적어 주세요.',
  'issue-transition': 'Jira 상태 변경은 "KEY-1 진행 중으로 바꿔줘"처럼 이슈 키와 바꿀 상태를 적어 주세요.',
  'channel-post': 'Slack 게시는 "#채널에 게시: 내용" 또는 "#채널에 내용이라고 올려줘"처럼 채널과 내용을 적어 주세요.',
  'calendar-create': '일정 추가는 "내일 오후 3시에 회의 잡아줘 제목 주간 회의 장소 3층"처럼 날짜·시간과 제목을 적어 주세요.',
  'calendar-change':
    '일정 변경·삭제는 "내일 3시 회의 4시로 옮겨줘", "내일 3시 회의 제목을 주간 회의로 바꿔줘", "내일 3시 회의 취소해줘"처럼 적어 주세요.',
  'calendar-span': '일정 쓰기는 하루를 정해서 요청해 주세요 (예: "내일", "금요일", "10월 7일"). 주 단위·"다음 회의"로는 바꾸지 않아요.',
};

export function renderConnectorWriteUsage(topic: ConnectorWriteUsageTopic): string {
  const calendar = topic.startsWith('calendar');
  return `${USAGE_KO[topic]} ${notDoneByThisRequest(calendar)}`;
}

const REFUSAL_KO: Readonly<Record<ConnectorWriteRefusal, string>> = {
  'target-not-allowed': '쓰기가 허용된 대상이 아니에요 (허용 목록에 있는 Jira 프로젝트·Slack 채널만 쓸 수 있어요).',
  'invalid-target': '대상 이름이 올바르지 않아요.',
  'invalid-text': '보낼 내용이 비어 있거나 올바르지 않아요.',
  'text-too-long': '내용이 너무 길어서 미리보기에 다 보여 줄 수 없어요. 1,400자 이하로 줄여 주세요.',
  credential: '토큰·비밀번호 같은 비밀 값처럼 보이는 내용이 있어서 보내지 않아요.',
  'transition-unavailable': '이 이슈는 지금 그 상태로 바꿀 수 없어요.',
  'transition-lookup-failed': '이 이슈에서 바꿀 수 있는 상태를 확인하지 못했어요.',
  'event-not-found': '그 날짜·시간에 맞는 일정을 기본 캘린더에서 찾지 못했어요.',
  'no-nearby-events':
    '어느 일정인지 알 수 없어요. 이 대화에서 최근에 다룬 일정이 없고 오늘·내일 기본 캘린더에도 일정이 없어요. 날짜와 시간을 함께 적어 주세요 (예: "금요일 3시 회의 취소해줘").',
  'event-unversioned':
    '이 일정은 미리보기 이후 바뀌었는지 확인할 버전 정보가 없어서 바꾸거나 삭제하지 않아요. 승인할 요청도 만들지 않았어요.',
  'too-many-events': '맞는 일정이 너무 많아요. 시간이나 따옴표로 제목을 더 정확히 적어 주세요.',
  'calendar-read-failed': '캘린더를 읽지 못해서 어떤 일정인지 확인할 수 없었어요.',
  'all-day-move': '종일 일정의 시간은 바꿀 수 없어요.',
  'invalid-time': '그 시간은 사용할 수 없어요 (없는 시간이거나 끝이 시작보다 빨라요).',
  'no-change': '바뀌는 내용이 없어요.',
  'invalid-choice': '목록에 있는 번호가 아니에요.',
  'binding-mismatch': '승인한 요청과 지금 요청이 일치하는지 확인할 수 없어요.',
  'grant-expired': '승인한 지 30분이 지나 승인이 만료됐어요.',
  'grant-revoked': '실행하기 전에 이 요청이 거절(취소)돼서 실행하지 않았어요.',
  'choice-expired': '일정 목록을 보여 드린 지 30분이 지나 선택이 만료됐어요 (그사이 일정이 바뀌었을 수 있어요).',
};

export function renderConnectorWriteRefusal(
  reason: ConnectorWriteRefusal,
  calendar: boolean,
  availableStatuses: readonly string[] = [],
): string {
  const lines = [`${REFUSAL_KO[reason]} ${notDoneByThisRequest(calendar)}`];
  if (reason === 'transition-unavailable' && availableStatuses.length > 0) {
    lines.push(`지금 바꿀 수 있는 상태: ${availableStatuses.map(inline).join(', ')}`);
  }
  if (reason === 'binding-mismatch' || reason === 'grant-expired' || reason === 'choice-expired' || reason === 'invalid-choice') {
    lines.push('필요하면 처음부터 다시 요청해 주세요.');
  }
  return lines.join('\n');
}

export function renderConnectorWriteClosed(reason: ConnectorWriteCloseReason, calendar: boolean): string {
  const done = notDoneByThisRequest(calendar);
  switch (reason) {
    case 'denied':
      return `요청을 거절했어요. ${done}`;
    case 'cancelled':
      return `요청을 취소했어요. ${done}`;
    case 'abandoned':
      return `일정 선택을 취소했어요. ${done}`;
    case 'expired':
      return `승인 시간이 지나 요청이 만료됐어요. ${done}`;
    default:
      return `요청을 끝냈어요. ${done}`;
  }
}

const CLOSED_REQUEST_KO: Readonly<Record<ConnectorWriteCloseReason, string>> = {
  denied: '거절돼서',
  cancelled: '취소돼서',
  expired: '승인 시간이 지나 만료돼서',
  superseded: '새 요청으로 바뀌어서',
  abandoned: '선택이 취소돼서',
  inconsistent: '확인할 수 없어서',
};

/**
 * The execution phrase (or a question about it) when this conversation's LATEST request of that kind ended without a
 * send — closed unsent (rejected, cancelled, expired, …) or NOT_SENT (Live QA session 3 D1; Codex P2/P3 on 55c5a2f).
 * Describes exactly that request; an older request of the kind that may have been sent is warned about too.
 */
export function renderConnectorWriteLatestRequest(
  latest: ConnectorWriteLatestRequest & { readonly state: { readonly kind: 'closed' | 'not-sent' } },
  olderUnconfirmed: boolean,
): string {
  const label = connectorWriteLabel(latest.operation);
  const calendar = isCalendar(latest.operation);
  const head = `가장 최근 ${label} 요청(${connectorWriteShortTarget(latest.target)})은`;
  const what =
    latest.state.kind === 'closed'
      ? `${head} ${CLOSED_REQUEST_KO[(latest.state as { reason: ConnectorWriteCloseReason }).reason]} 실행하지 않았어요.`
      : `${head} 실행했지만 ${calendar ? '캘린더에 반영하지' : '보내지'} 못했어요.`;
  return [
    `${what} 그 요청으로는 ${calendar ? '캘린더를 바꾸지' : '아무것도 보내지'} 않았어요.`,
    ...(olderUnconfirmed
      ? [
          `그 전의 ${label} 요청은 결과를 확인하지 못했어요. 이미 ${calendar ? '캘린더가 바뀌었을' : '게시됐을'} 수도 있으니 직접 확인해 주세요. 다시 실행하지 않아요.`,
        ]
      : []),
    '필요하면 새로 요청해 주세요.',
  ].join('\n');
}

/** An execution phrase with no approved write to run (the QA-018 pattern: no model may claim a write). */
export function renderNoApprovedConnectorWrite(): string {
  return '지금 실행할 승인된 외부 쓰기 요청이 없어요. 이번에는 아무것도 보내거나 바꾸지 않았어요. 먼저 요청하고 미리보기를 승인해 주세요.';
}

/** What SHORT_TERM history keeps for a calendar write turn (no event text, ADR-0110 D4/amendment D6). */
export const CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE = '[캘린더 쓰기 응답 — 일정 내용은 대화 기록에 남기지 않아요.]';

/** The single entry point the composer uses for every flow step (except `writes-off`, which is the handler's text). */
export function renderConnectorWriteStep(step: Exclude<ConnectorWriteStep, { kind: 'writes-off' }>): string {
  switch (step.kind) {
    case 'usage':
      return renderConnectorWriteUsage(step.topic);
    case 'refused':
      return renderConnectorWriteRefusal(step.reason, step.family === 'calendar', step.availableStatuses);
    case 'preview':
      return renderConnectorWritePreview(step.preview, step.remainingMs, step.executionPhrase);
    case 'choice':
      return renderConnectorWriteChoice(step.mode, step.candidates, step.timeZone, step.basis);
    case 'already-sent':
      return renderConnectorWriteAlreadySent(step.operation, step.externalRef, step.url);
    case 'approved':
      return renderConnectorWriteApproved(step.operation, step.executionPhrase);
    case 'outcome':
      return renderConnectorWriteOutcome(step.operation, step.outcome);
    case 'repeat':
      return renderConnectorWriteRepeat(step.operation, step.status, step.externalRef, step.url);
    case 'closed':
      return renderConnectorWriteClosed(step.reason, step.family === 'calendar');
  }
}

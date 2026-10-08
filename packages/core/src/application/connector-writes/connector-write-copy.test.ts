import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_WRITE_NOT_SENT_REASONS,
  CONNECTOR_WRITE_OPERATIONS,
  CONNECTOR_WRITE_UNCERTAIN_REASONS,
  connectorWriteNotSent,
  connectorWriteUncertain,
} from '../../ports';
import { ResponseComposer } from '../response-composer';
import {
  connectorWriteConversationPlace,
  connectorWriteTimeLabel,
  renderConnectorWriteAlreadyExecuted,
  renderConnectorWriteApprovedElsewhere,
  renderConnectorWriteAlreadySent,
  renderConnectorWriteOutcome,
  renderConnectorWriteRefusal,
  renderConnectorWriteRepeat,
} from './connector-write-copy';
import { CONNECTOR_WRITE_PREVIEW_DESCRIPTION_MAX_LENGTH, CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH } from './connector-write-flow';
import { PLAIN_TEXT_MARKUP, plainTextOf, renderMessageContent } from '../message-rendering';
import type { MessageMarkup } from '../../ports/message-markup.port';

/** PLT-0: a probe markup that makes the platform-rendered spans of the neutral copy visible. */
const PROBE: MessageMarkup = {
  ...PLAIN_TEXT_MARKUP,
  untrusted: (text, guard) => `«${guard}:${text}»`,
  link: (url) => `«link:${url}»`,
  conversation: (id) => `«conversation:${id}»`,
};
const probe = (body: Parameters<typeof plainTextOf>[0]): string => renderMessageContent(body, PROBE);
import type { ConnectorWritePreview, ConnectorWriteRefusal } from './connector-write-flow';

const CTX = { platform: 'test', channelId: 'c', userId: 'u' };
const composer = new ResponseComposer();
const approval = { id: 'a' } as never;
const preview = (p: ConnectorWritePreview) =>
  composer.composeConnectorWriteStep(CTX, { kind: 'preview', preview: p, approval, remainingMs: 30 * 60_000, executionPhrase: '댓글 실행' }).text;

describe('connector-write copy (CWR-2)', () => {
  it('the largest allowed previews fit one message whole, and owner text can never break out of its fence', () => {
    const worstText = '*`'.repeat(CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH / 2);
    const comment = preview({ operation: 'ISSUE_COMMENT', issueKey: `A${'B'.repeat(63)}-123456789`, text: worstText });
    expect(comment.length).toBeLessThanOrEqual(1900);
    expect(comment).toContain(`\n${worstText}\n`);
    expect(comment).not.toContain('…');
    const post = preview({ operation: 'CHANNEL_POST', channelLabel: 'c'.repeat(80), channelId: 'C'.repeat(20), text: 'x'.repeat(CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH) });
    expect(post.length).toBeLessThanOrEqual(1900);
    const calendar = preview({
      operation: 'CALENDAR_EVENT_CREATE',
      timeZone: 'Asia/Seoul',
      event: {
        title: '*'.repeat(200),
        location: '_'.repeat(200),
        description: 'd'.repeat(CONNECTOR_WRITE_PREVIEW_DESCRIPTION_MAX_LENGTH),
        time: { allDay: false, start: '2026-10-07T06:00:00.000Z', end: '2026-10-08T07:00:00.000Z', timeZone: 'Asia/Seoul' },
      },
    });
    expect(calendar.length).toBeLessThanOrEqual(1900);
    expect(calendar).toContain('2026-10-07(수) 15:00–2026-10-08(목) 16:00 (Asia/Seoul)');
    const fenceRun = '````';
    const tricky = preview({ operation: 'ISSUE_COMMENT', issueKey: 'P-1', text: `a ${fenceRun} b` });
    expect(tricky).toContain(`\`\`\`\`\`\na ${fenceRun} b\n\`\`\`\`\``);
  });

  it('only a SENT outcome says it was done; UNCERTAIN says it may have happened and is not retried', () => {
    for (const operation of CONNECTOR_WRITE_OPERATIONS) {
      for (const reason of CONNECTOR_WRITE_UNCERTAIN_REASONS) {
        const text = renderConnectorWriteOutcome(operation, connectorWriteUncertain(reason));
        expect(text).toContain('확인하지 못했어요');
        expect(text).toContain('자동으로 다시 시도하지 않아요');
        expect(text).not.toMatch(/완료:|달았어요|게시했어요|추가했어요|바꿨어요|삭제했어요/);
      }
      for (const reason of CONNECTOR_WRITE_NOT_SENT_REASONS) {
        const text = renderConnectorWriteOutcome(operation, connectorWriteNotSent(reason));
        // UNC-1: says plainly that nothing was sent / nothing changed (TARGET_CHANGED keeps its own wording).
        expect(text).toMatch(
          /이 요청으로는 (?:아무것도 보내지|캘린더를 바꾸지) 않았어요|아무것도 게시되지 않았어요|댓글은 달리지 않았어요|이슈 상태는 바뀌지 않았어요|캘린더는 바뀌지 않았어요/,
        );
        expect(text).not.toMatch(/완료:|달았어요|게시했어요|추가했어요|바꿨어요|삭제했어요/);
        expect(text).not.toContain('undefined');
      }
      expect(renderConnectorWriteRepeat(operation, 'EXECUTING')).toContain('다시 실행하지 않아요');
    }
  });

  it('a drifted target (TARGET_CHANGED) says truthfully it was not executed and asks for a new request', () => {
    const changed = connectorWriteNotSent('TARGET_CHANGED');
    expect(renderConnectorWriteOutcome('ISSUE_TRANSITION', changed)).toBe(
      'Jira 상태 전환 조건이 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.\n이 요청으로는 아무것도 보내지 않았어요. 자동으로 다시 시도하지 않아요.',
    );
    expect(renderConnectorWriteOutcome('ISSUE_COMMENT', changed)).toContain('다른 키로 옮겨져서 실행하지 않았어요');
    for (const operation of ['CALENDAR_EVENT_UPDATE', 'CALENDAR_EVENT_DELETE'] as const) {
      const text = renderConnectorWriteOutcome(operation, changed);
      expect(text).toContain('일정이 미리보기 이후에 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.');
      expect(text).toContain('이 요청으로는 캘린더를 바꾸지 않았어요.');
    }
    const transition = preview({
      operation: 'ISSUE_TRANSITION',
      issueKey: 'PROJ-1',
      toStatus: 'Done',
      toStatusId: '10002',
      transitionName: 'Finish',
      transitionId: '31',
    });
    expect(transition).toContain('바꿀 상태: Done (상태 ID 10002)');
    expect(transition).toContain('전환: Finish (전환 ID 31)');
  });

  it('every refusal says nothing was sent or changed', () => {
    const reasons: ConnectorWriteRefusal[] = [
      'target-not-allowed', 'invalid-target', 'invalid-text', 'text-too-long', 'credential', 'transition-unavailable',
      'transition-lookup-failed', 'event-not-found', 'event-unversioned', 'too-many-events', 'calendar-read-failed', 'all-day-move',
      'invalid-time', 'no-change', 'invalid-choice', 'binding-mismatch', 'grant-expired',
    ];
    for (const reason of reasons) {
      expect(renderConnectorWriteRefusal(reason, false)).toContain('이 요청으로는 아무것도 보내지 않았어요');
      expect(renderConnectorWriteRefusal(reason, true)).toContain('이 요청으로는 캘린더를 바꾸지 않았어요');
    }
    expect(probe(renderConnectorWriteRefusal('transition-unavailable', false, ['진행 중', '*완료*']))).toContain('«markup:진행 중», «markup:*완료*»');
  });

  it('labels all-day spans with an exclusive end date', () => {
    expect(connectorWriteTimeLabel({ allDay: true, startDate: '2026-10-09', endDate: '2026-10-10' }, 'Asia/Seoul')).toBe('2026-10-09(금) 종일');
    expect(connectorWriteTimeLabel({ allDay: true, startDate: '2026-10-09', endDate: '2026-10-12' }, 'Asia/Seoul')).toBe(
      '2026-10-09(금) ~ 2026-10-11(일) 종일',
    );
  });

  it('uses the right Korean particle for every operation label (W5-L03)', () => {
    const notSent = connectorWriteNotSent('FORBIDDEN');
    for (const operation of CONNECTOR_WRITE_OPERATIONS) {
      const all = [
        renderConnectorWriteOutcome(operation, notSent),
        renderConnectorWriteAlreadySent(operation),
        ...(['SENT', 'NOT_SENT', 'UNCERTAIN'] as const).map((status) => renderConnectorWriteRepeat(operation, status)),
      ].join('\n');
      expect(all).not.toMatch(/을\(를\)|은\(는\)/u);
    }
    // UNC-1: a NOT_SENT reply says plainly that nothing was sent (and what therefore did not happen).
    expect(renderConnectorWriteOutcome('CHANNEL_POST', notSent)).toContain('Slack 게시를 보내지 못했어요');
    expect(renderConnectorWriteOutcome('CHANNEL_POST', notSent)).toContain('아무것도 게시되지 않았어요.');
    expect(renderConnectorWriteOutcome('ISSUE_COMMENT', notSent)).toContain('Jira 댓글을 보내지 못했어요');
    expect(renderConnectorWriteOutcome('ISSUE_COMMENT', notSent)).toContain('댓글은 달리지 않았어요.');
    expect(renderConnectorWriteOutcome('ISSUE_TRANSITION', notSent)).toContain('Jira 상태 변경을 보내지 못했어요');
    expect(renderConnectorWriteOutcome('ISSUE_TRANSITION', notSent)).toContain('이슈 상태는 바뀌지 않았어요.');
    expect(renderConnectorWriteOutcome('CALENDAR_EVENT_CREATE', notSent)).toContain('캘린더 일정 추가를 보내지 못했어요');
    expect(renderConnectorWriteOutcome('CALENDAR_EVENT_CREATE', notSent)).toContain('캘린더는 바뀌지 않았어요.');
    expect(renderConnectorWriteOutcome('CHANNEL_POST', { status: 'NOT_SENT', reason: 'UNAVAILABLE', retryable: false })).toBe(
      [
        'Slack 게시를 보내지 못했어요: 연결에 실패해서 요청을 보내기 전에 멈췄어요. 아무것도 게시되지 않았어요.',
        '자동으로 다시 시도하지 않아요. 필요하면 새로 요청해 주세요.',
      ].join('\n'),
    );
    expect(renderConnectorWriteRepeat('CHANNEL_POST', 'SENT')).toContain('이 Slack 게시는 이미 실행했어요');
    // W5-L02 (live QA 2026-10-07 wording): when (QUOKY_TIMEZONE) and where, so it can't be mistaken for another post.
    const channel = { kind: 'channel', channelLabel: 'quoky-test', channelId: 'C0TEST' } as const;
    const sentAt = '2026-10-07T01:24:00.000Z';
    const executed = renderConnectorWriteAlreadyExecuted('CHANNEL_POST', { externalRef: 'ref', url: 'https://example.com/x', sentAt, target: channel, timeZone: 'Asia/Seoul' });
    expect(plainTextOf(executed)).toBe('이미 보냈어요 (10:24, Slack #quoky-test): https://example.com/x\n다시 보내지 않았어요.');
    expect(probe(executed)).toBe('이미 보냈어요 (10:24, Slack #«markup:quoky-test»): «link:https://example.com/x»\n다시 보내지 않았어요.');
  });
});

describe('connector-write copy — cross-conversation hints (live QA 2026-10-07)', () => {
  const sentAt = '2026-10-07T01:24:00.000Z';
  it('the already-sent reply covers a reference without a link, no link at all, and the calendar', () => {
    const issue = { kind: 'issue', issueKey: 'PROJ-1' } as const;
    expect(probe(renderConnectorWriteAlreadyExecuted('ISSUE_TRANSITION', { externalRef: 'PROJ-1:21', sentAt, target: issue, timeZone: 'UTC' }))).toBe(
      '이미 보냈어요 (01:24, Jira «markup:PROJ-1»): 참조 «markup:PROJ-1:21»\n다시 보내지 않았어요.',
    );
    expect(plainTextOf(renderConnectorWriteAlreadyExecuted('ISSUE_COMMENT', { sentAt, target: issue, timeZone: 'UTC' }))).toBe(
      '이미 보냈어요 (01:24, Jira PROJ-1).\n다시 보내지 않았어요.',
    );
    expect(renderConnectorWriteAlreadyExecuted('CALENDAR_EVENT_CREATE', { sentAt, target: { kind: 'calendar' }, timeZone: 'Asia/Seoul' })).toBe(
      '이미 반영했어요 (10:24, 내 기본 캘린더).\n다시 바꾸지 않았어요.',
    );
  });

  it('the approved-elsewhere reply names a guild channel, a thread, the DM, or a plain "채널" for an unsafe id — never payload', () => {
    const base = { operation: 'CALENDAR_EVENT_DELETE', target: { kind: 'calendar' }, executionPhrase: '일정 삭제 실행', remainingMs: 61_000 } as const;
    const guild = { platform: 'test', spaceId: 's1', channelId: 'c1', userId: 'u' };
    // The conversation is a reference span the platform renders (Discord: `<#c1>`).
    expect(probe(renderConnectorWriteApprovedElsewhere({ ...base, context: guild }))).toBe(
      [
        '실행하지 않았어요. 승인된 캘린더 일정 삭제(기본 캘린더)는 다른 대화에서 기다리고 있어요 (약 2분 남음).',
        '미리보기를 받은 «conversation:c1»에서 "일정 삭제 실행"이라고 보내 주세요.',
      ].join('\n'),
    );
    expect(probe(renderConnectorWriteApprovedElsewhere({ ...base, context: { ...guild, threadId: 't9' } }))).toContain('«conversation:t9»에서');
    expect(plainTextOf(renderConnectorWriteApprovedElsewhere({ ...base, context: { ...guild, channelId: 'c1><@everyone' } }))).toContain('미리보기를 받은 채널에서');
    expect(plainTextOf(renderConnectorWriteApprovedElsewhere({ ...base, context: CTX }))).toContain('미리보기를 받은 봇과의 DM에서');
    expect(connectorWriteConversationPlace(CTX)).toEqual({ kind: 'dm' });
  });
});

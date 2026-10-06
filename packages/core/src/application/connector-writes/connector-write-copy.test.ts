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
  connectorWriteTimeLabel,
  renderConnectorWriteOutcome,
  renderConnectorWriteRefusal,
  renderConnectorWriteRepeat,
} from './connector-write-copy';
import { CONNECTOR_WRITE_PREVIEW_DESCRIPTION_MAX_LENGTH, CONNECTOR_WRITE_PREVIEW_TEXT_MAX_LENGTH } from './connector-write-flow';
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
        expect(text).toMatch(/아무것도 보내지 않았어요|캘린더는 바꾸지 않았어요/);
        expect(text).not.toContain('undefined');
      }
      expect(renderConnectorWriteRepeat(operation, 'EXECUTING')).toContain('다시 실행하지 않아요');
    }
  });

  it('a drifted target (TARGET_CHANGED) says truthfully it was not executed and asks for a new request', () => {
    const changed = connectorWriteNotSent('TARGET_CHANGED');
    expect(renderConnectorWriteOutcome('ISSUE_TRANSITION', changed)).toBe(
      'Jira 상태 전환 조건이 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.\n아무것도 보내지 않았어요. 자동으로 다시 시도하지 않아요.',
    );
    expect(renderConnectorWriteOutcome('ISSUE_COMMENT', changed)).toContain('다른 키로 옮겨져서 실행하지 않았어요');
    for (const operation of ['CALENDAR_EVENT_UPDATE', 'CALENDAR_EVENT_DELETE'] as const) {
      const text = renderConnectorWriteOutcome(operation, changed);
      expect(text).toContain('일정이 미리보기 이후에 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.');
      expect(text).toContain('캘린더는 바꾸지 않았어요.');
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
      'transition-lookup-failed', 'event-not-found', 'too-many-events', 'calendar-read-failed', 'all-day-move',
      'invalid-time', 'no-change', 'invalid-choice', 'binding-mismatch', 'grant-expired',
    ];
    for (const reason of reasons) {
      expect(renderConnectorWriteRefusal(reason, false)).toContain('아무것도 보내지 않았어요');
      expect(renderConnectorWriteRefusal(reason, true)).toContain('캘린더는 바꾸지 않았어요');
    }
    expect(renderConnectorWriteRefusal('transition-unavailable', false, ['진행 중', '*완료*'])).toContain('진행 중, \\*완료\\*');
  });

  it('labels all-day spans with an exclusive end date', () => {
    expect(connectorWriteTimeLabel({ allDay: true, startDate: '2026-10-09', endDate: '2026-10-10' }, 'Asia/Seoul')).toBe('2026-10-09(금) 종일');
    expect(connectorWriteTimeLabel({ allDay: true, startDate: '2026-10-09', endDate: '2026-10-12' }, 'Asia/Seoul')).toBe(
      '2026-10-09(금) ~ 2026-10-11(일) 종일',
    );
  });
});

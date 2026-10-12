import { describe, expect, it } from 'vitest';
import type { ConversationTurnHandler } from '../ports/conversation-turn-handler.port';
import type { DriveReader } from '../ports/drive-reader.port';
import type { MailReader } from '../ports/mail-reader.port';
import { DRIVE_HELP_LINES, createDriveTurnHandler } from './drive/drive-turn-handler';
import { parseDriveQuestion } from './drive/drive-question';
import { MAIL_DRIVE_HELP_LINES, withMergedMailDriveHelp } from './mail-drive-help';
import { MAIL_HELP_LINES, createMailTurnHandler } from './mail/mail-turn-handler';
import { parseMailQuestion } from './mail/mail-question';

const mail = createMailTurnHandler({ reader: {} as MailReader, timeZone: 'Asia/Seoul' });
const drive = createDriveTurnHandler({ reader: {} as DriveReader, timeZone: 'Asia/Seoul' });
const other: ConversationTurnHandler = { id: 'other', stage: 'pre-classify', order: 1, helpLines: ['- x'], handle: async () => null };
const linesOf = (handlers: readonly ConversationTurnHandler[]) => handlers.flatMap((handler) => handler.helpLines ?? []);

describe('merged mail and Drive help line (ADR-0096 D6, v4 residual polish)', () => {
  it('with both handlers: one line replaces two, and the handlers still route', () => {
    const merged = withMergedMailDriveHelp([other, mail, drive]);
    expect(linesOf(merged)).toEqual(['- x', ...MAIL_DRIVE_HELP_LINES]);
    expect(merged.map((handler) => handler.id)).toEqual(['other', 'mail', 'drive']);
    expect(merged.map((handler) => [handler.stage, handler.order])).toEqual([['pre-classify', 1], ['pre-classify', 140], ['pre-classify', 145]]);
    expect(typeof merged[1]?.handle).toBe('function');
  });

  it('with one handler or none, the list and its lines are unchanged (byte-identical help)', () => {
    for (const list of [[other], [other, mail], [other, drive]]) {
      expect(withMergedMailDriveHelp(list)).toBe(list);
    }
    expect(linesOf([mail])).toEqual(MAIL_HELP_LINES);
    expect(linesOf([drive])).toEqual(DRIVE_HELP_LINES);
  });

  it('the merged line is within the 120-character bound and every quoted phrase routes to a handler', () => {
    const line = MAIL_DRIVE_HELP_LINES[0] as string;
    expect(Array.from(line).length).toBeLessThanOrEqual(120);
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
    expect(quoted).toEqual(['안 읽은 메일', '최근 문서', '1번 메일 요약해줘', '1번 문서 요약해줘']);
    for (const phrase of quoted) {
      const claimed = parseMailQuestion(phrase) !== null || parseDriveQuestion(phrase) !== null;
      expect(claimed, phrase).toBe(true);
    }
    expect(parseMailQuestion('1번 메일 요약해줘')).not.toBeNull();
    expect(parseDriveQuestion('1번 문서 요약해줘')).not.toBeNull();
  });
});

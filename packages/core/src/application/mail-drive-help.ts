import type { ConversationTurnHandler } from '../ports/conversation-turn-handler.port';
import { DRIVE_TURN_HANDLER_ID } from './drive/drive-turn-handler';
import { MAIL_TURN_HANDLER_ID } from './mail/mail-turn-handler';

/**
 * ADR-0096 D6 bounds the contributed help lines (14 x 120 characters) and a bound is not raised for one more line:
 * with Gmail, Drive and the connector-write lines all on, a 15th line was dropped. When BOTH the mail and the Drive
 * handler are registered, their two lines are shown as this one compact line instead (v4 residual polish). Every quoted
 * phrase still routes to its handler (a test pins that), and each handler alone keeps its own line, so the help of a
 * mail-only, Drive-only or unconfigured installation is byte-identical.
 */
export const MAIL_DRIVE_HELP_LINES: readonly string[] = Object.freeze([
  '- 메일·드라이브(읽기 전용, DM에서만): "안 읽은 메일", "최근 문서", "1번 메일 요약해줘", "1번 문서 요약해줘"',
]);

/**
 * The registered handlers with the mail and Drive help lines merged into one (carried by the mail handler; the Drive
 * handler then contributes none). Returns the list unchanged unless both are present. Wrappers delegate to the original
 * handler instances, so routing and state are untouched.
 */
export function withMergedMailDriveHelp(handlers: readonly ConversationTurnHandler[]): readonly ConversationTurnHandler[] {
  const hasMail = handlers.some((handler) => handler.id === MAIL_TURN_HANDLER_ID);
  const hasDrive = handlers.some((handler) => handler.id === DRIVE_TURN_HANDLER_ID);
  if (!hasMail || !hasDrive) return handlers;
  return handlers.map((handler) => {
    if (handler.id === MAIL_TURN_HANDLER_ID) return Object.create(handler, { helpLines: { value: MAIL_DRIVE_HELP_LINES, enumerable: true } }) as ConversationTurnHandler;
    if (handler.id === DRIVE_TURN_HANDLER_ID) return Object.create(handler, { helpLines: { value: Object.freeze([]), enumerable: true } }) as ConversationTurnHandler;
    return handler;
  });
}

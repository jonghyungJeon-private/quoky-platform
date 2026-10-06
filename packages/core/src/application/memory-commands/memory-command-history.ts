import { parseMemoryCommand } from './memory-command-grammar';
import { renderEditRequestHistory } from './memory-command-renderer';

/**
 * ADR-0106 D5 (W2-L01, fix loop 2): the text the SHORT_TERM conversation history stores for an inbound turn, decided
 * at WRITE time. A memory-edit request (`기억 N 수정: …`, `edit memory N: …`, whatever its outcome) is stored as the
 * command with its text withheld, so the proposed memory text is never persisted verbatim — no later rewrite has to
 * succeed for it to stay out of the transcript. Every other turn is stored as sent (`undefined`).
 */
export function memoryCommandHistoryUserText(text: string): string | undefined {
  const command = parseMemoryCommand(text);
  return command?.kind === 'edit' ? renderEditRequestHistory(command.number, command.language) : undefined;
}

/**
 * Wrapped lines of a document summary (ADR-0104 D1 amendment for summary turns, owner-approved 2026-10-15). A line that
 * starts no bullet or heading continues an unfinished previous line (`The PR has been\nmerged.` is one sentence). Shared
 * by the claim check (which reads joined lines) and the summary reply (which shows whole joined lines), so the text the
 * check reads and the lines a platform takes are the same units. Pure and linear.
 */
const BULLET = /^\s*(?:[-*•>]|\d{1,3}[.)])\s+/u;
const HEADING = /^\s*#{1,6}\s|^[^\n]{1,80}:\s*$/u;
/** A line that ends a sentence or a block (an ellipsis included), so the next line is not its continuation. */
const LINE_COMPLETE = /[.!?。！？:)\]」』…]\s*$/u;

/** The text with wrapped lines joined (idempotent: joining the result again changes nothing). */
export function joinedWrappedLines(text: string): string {
  const out: string[] = [];
  let previous = '';
  for (const line of text.split('\n')) {
    const continues =
      previous.trim() !== '' && line.trim() !== '' && !BULLET.test(line) && !HEADING.test(line) && !HEADING.test(previous) && !LINE_COMPLETE.test(previous);
    if (continues) out[out.length - 1] = `${out[out.length - 1] as string} ${line.trim()}`;
    else out.push(line);
    previous = line;
  }
  return out.join('\n');
}

/**
 * Korean particles chosen by the word they follow (pure, no I/O). Shared by the deterministic reply copy so no reply
 * falls back to the "을(를)" form (live QA D9).
 *
 * The particle follows how the last character is READ: a Hangul syllable by its final consonant (batchim); an Arabic
 * digit by its Sino-Korean reading (1 일, 3 삼, 6 육, 7 칠, 8 팔 and every trailing 0 — 영, 십, 백, 천, 만 — end in a
 * consonant; 2 이, 4 사, 5 오, 9 구 do not), so "#99를", "#10을", "#3을". Anything else (Latin letters, symbols) is
 * treated as ending in a vowel.
 */

/** Digits whose Sino-Korean reading ends in a final consonant. */
const DIGIT_WITH_BATCHIM = new Set(['0', '1', '3', '6', '7', '8']);

/** True when `word` is read with a final consonant at its end. */
export function endsWithBatchim(word: string): boolean {
  const last = Array.from(word.trimEnd()).pop();
  if (last === undefined) return false;
  if (/^[0-9]$/u.test(last)) return DIGIT_WITH_BATCHIM.has(last);
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

/** "Jira 댓글" → "Jira 댓글을", "Slack 게시" → "Slack 게시를", "알림 #99" → "알림 #99를". */
export function withObjectParticle(word: string): string {
  return `${word}${endsWithBatchim(word) ? '을' : '를'}`;
}

/** "Jira 댓글" → "Jira 댓글은", "Slack 게시" → "Slack 게시는", "알림 #3" → "알림 #3은". */
export function withTopicParticle(word: string): string {
  return `${word}${endsWithBatchim(word) ? '은' : '는'}`;
}

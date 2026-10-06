/**
 * Learning command grammar (ADR-0107 D3, LRN-1). Pure and deterministic: no provider, no storage, no clock.
 *
 * Whole-message matches only (NFC, trimmed, inner whitespace flexible), so ordinary chat that merely mentions
 * "예시" or "후보" falls through:
 *  - `피드백 후보` — list recent rated turns, numbered at command time;
 *  - `후보 N 메모: <note>` — save the 👎 turn N as a `GOLDEN_CANDIDATE` with the owner's note;
 *  - `후보 N 예시로 저장` — save the 👍 turn N as an `EXAMPLE`;
 *  - `예시 목록` — list saved examples, numbered at command time;
 *  - `예시 N 수정: <ideal answer>` — set the ideal answer of example N;
 *  - `예시 N 삭제` — delete example N.
 * A trailing polite verb ("해줘", "해 줘", "해", "해주세요") is accepted on the commands without a text body.
 */

export type LearningCommand =
  | { readonly kind: 'list-candidates' }
  | { readonly kind: 'candidate-note'; readonly index: number; readonly note: string }
  | { readonly kind: 'candidate-example'; readonly index: number }
  | { readonly kind: 'list-examples' }
  | { readonly kind: 'example-edit'; readonly index: number; readonly answer: string }
  | { readonly kind: 'example-delete'; readonly index: number };

export const LEARNING_LIST_CANDIDATES_PHRASE = '피드백 후보';
export const LEARNING_LIST_EXAMPLES_PHRASE = '예시 목록';

const POLITE = String.raw`(?:\s*(?:해\s?줘|해\s?주세요|해\s?줘요|해))?`;
const INDEX = String.raw`(\d{1,3})\s*번?`;
const COLON = String.raw`\s*[:：]\s*`;

const LIST_CANDIDATES = new RegExp(String.raw`^피드백\s*후보(?:\s*(?:목록|보여\s?줘))?$`, 'u');
const LIST_EXAMPLES = new RegExp(String.raw`^예시\s*목록(?:\s*보여\s?줘)?$`, 'u');
const CANDIDATE_NOTE = new RegExp(String.raw`^후보\s*${INDEX}\s*메모${COLON}([\s\S]+)$`, 'u');
const CANDIDATE_EXAMPLE = new RegExp(String.raw`^후보\s*${INDEX}\s*(?:을|를)?\s*예시로\s*저장${POLITE}$`, 'u');
const EXAMPLE_EDIT = new RegExp(String.raw`^예시\s*${INDEX}\s*수정${COLON}([\s\S]+)$`, 'u');
const EXAMPLE_DELETE = new RegExp(String.raw`^예시\s*${INDEX}\s*(?:을|를)?\s*삭제${POLITE}$`, 'u');

function indexOf(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** The learning command `text` is, or null when it is not one (the handler then falls through). */
export function parseLearningCommand(text: string): LearningCommand | null {
  const normalized = text.normalize('NFC').trim();
  if (normalized.length === 0) return null;
  // Bodies keep their own line breaks; only the command head is single-line.
  const head = normalized.replace(/[ \t]+/gu, ' ');
  if (LIST_CANDIDATES.test(head)) return { kind: 'list-candidates' };
  if (LIST_EXAMPLES.test(head)) return { kind: 'list-examples' };

  let match = CANDIDATE_NOTE.exec(head);
  if (match) {
    const index = indexOf(match[1]);
    const note = (match[2] ?? '').trim();
    return index !== null && note.length > 0 ? { kind: 'candidate-note', index, note } : null;
  }
  match = CANDIDATE_EXAMPLE.exec(head);
  if (match) {
    const index = indexOf(match[1]);
    return index !== null ? { kind: 'candidate-example', index } : null;
  }
  match = EXAMPLE_EDIT.exec(head);
  if (match) {
    const index = indexOf(match[1]);
    const answer = (match[2] ?? '').trim();
    return index !== null && answer.length > 0 ? { kind: 'example-edit', index, answer } : null;
  }
  match = EXAMPLE_DELETE.exec(head);
  if (match) {
    const index = indexOf(match[1]);
    return index !== null ? { kind: 'example-delete', index } : null;
  }
  return null;
}

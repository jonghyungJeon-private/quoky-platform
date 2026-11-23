/**
 * Participant pseudonyms (ADR-0120 A6 R2 decision D5; reused by ADR-0121 A5.2): "참여자 A, B, ..." and the replacement of
 * every written form of a participant's name in a text. Pure, offline, no I/O; it holds no name list (every pattern is
 * derived from the handle itself). Moved out of `work-chat/work-item-summary.ts` unchanged so the bounded agent can use it
 * without importing the work-chat module; that module re-exports these names.
 */

/** "참여자 A" … "참여자 Z", then "참여자 A2" … (never a name). */
export function pseudonymLabel(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  const round = Math.floor(index / 26);
  return `참여자 ${letter}${round > 0 ? round + 1 : ''}`;
}

const HANGUL = '가-힣';
/** An honorific written after a name (consumed with it): "혜정님", "혜정씨", "혜정 씨". */
const HONORIFIC = String.raw`(?:\s?(?:님|씨))`;
/**
 * The forms in which a bare Korean given name is certainly a person (CA P2 on 274bb2e0): with an honorific, as a vocative
 * ("혜정아", consumed), or before an addressee particle ("혜정에게", "혜정께", "혜정한테", kept). Any other bare use
 * ("버그 수정이 필요하고 서버 지원도") is left alone: a given name is often an ordinary word.
 */
const GIVEN_NAME_FORM = String.raw`(?:${HONORIFIC}|(?:아|야)(?![${HANGUL}])|(?=께|에게|한테))`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The patterns one participant's name is written as in free text, all derived from the handle itself (no name list):
 * the whole handle and each Hangul part of three or more syllables or Latin part of three or more letters, anywhere
 * (an honorific consumed); a Korean given name (the last two syllables of a three- or four-syllable name, the last
 * syllable of a two-syllable one) and a two-syllable Hangul part only in {@link GIVEN_NAME_FORM}.
 */
function namePatterns(handle: string): { readonly key: string; readonly source: string }[] {
  const patterns: { key: string; source: string }[] = [{ key: handle, source: `${escapeRegExp(handle)}${HONORIFIC}?` }];
  const given = (name: string): { key: string; source: string } => ({ key: name, source: `(?<![${HANGUL}])${name}${GIVEN_NAME_FORM}` });
  for (const part of handle.split(/[^A-Za-z가-힣]+/u)) {
    if (part.length === 0 || part === handle) continue;
    if (/^[가-힣]+$/u.test(part)) {
      if (part.length >= 3) patterns.push({ key: part, source: `(?<![${HANGUL}])${part}${HONORIFIC}?` });
      else if (part.length === 2) patterns.push(given(part));
    } else if (/^[A-Za-z]{3,}$/u.test(part)) {
      patterns.push({ key: part, source: `(?<![A-Za-z])${part}(?![A-Za-z])${HONORIFIC}?` });
    }
  }
  for (const part of handle.split(/[^가-힣]+/u)) {
    if (part.length === 3 || part.length === 4) patterns.push(given(part.slice(-2)));
    if (part.length === 2) patterns.push(given(part.slice(-1)));
  }
  return patterns;
}

/** One participant (a handle of the fetched item) and the pseudonym it is shown as. Host-only: never in a prompt. */
export interface WorkItemParticipant {
  readonly handle: string;
  readonly label: string;
}

/**
 * Replace every written form of every participant's name in `text` with the participant's pseudonym, in one pass
 * (longest form first, so "Kim Chulsoo" wins over "Kim"). A form two participants share ("민수" of 김민수 and 이민수)
 * becomes the plain "참여자" (never the wrong person). A6 R2 (D5, live test 3): the comment text "혜정님에게 전달" names
 * the participant 전혜정 by given name and honorific; that is a name too.
 */
export function pseudonymiseParticipants(text: string, participants: readonly WorkItemParticipant[]): string {
  if (participants.length === 0 || text.length === 0) return text;
  const handles = new Map(participants.map((participant) => [participant.handle, participant.label]));
  const byKey = new Map<string, { source: string; labels: Set<string> }>();
  for (const participant of participants) {
    for (const pattern of namePatterns(participant.handle)) {
      const known = byKey.get(pattern.key) ?? { source: pattern.source, labels: new Set<string>() };
      // A whole handle keeps its own pattern (it may carry characters a part pattern drops).
      if (pattern.key === participant.handle) known.source = pattern.source;
      known.labels.add(participant.label);
      byKey.set(pattern.key, known);
    }
  }
  const entries = [...byKey.entries()]
    .map(([key, entry]) => [key, { source: entry.source, label: handles.get(key) ?? (entry.labels.size === 1 ? ([...entry.labels][0] as string) : '참여자') }] as const)
    .sort((a, b) => b[0].length - a[0].length);
  const combined = new RegExp(entries.map(([, entry]) => `(${entry.source})`).join('|'), 'gu');
  return text.replace(combined, (...args: unknown[]) => {
    const groups = args.slice(1, entries.length + 1);
    const at = groups.findIndex((group) => group !== undefined);
    return at < 0 ? String(args[0]) : (entries[at]?.[1].label ?? String(args[0]));
  });
}

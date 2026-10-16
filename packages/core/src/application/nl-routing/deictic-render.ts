import type { MessageBody } from '../../domain';
import { joinBody, untrustedText, type MessagePart } from '../message-rendering';
import type { DeicticEntryId } from './deictic-draft';
import type { DeicticRefusalReason } from './deictic-referent';
import { renderDeicticPayload } from './nl-action-policy';

/**
 * ADR-0120 amendment A6 R5a: the fixed owner-facing copy of deictic writes (§2, §3.1, §3.3, §5). The referenced text is
 * shown ONLY as a PLT-1 untrusted span (formatting, mentions and links neutralised) inside a quoted block, byte for byte
 * the normalised payload that would be stored. Nothing here routes or decides.
 */

type Lang = 'ko' | 'en';

/** The SHORT_TERM assistant record of a preview turn (§1.2): a fixed note, so a preview is never a referent. */
export const DEICTIC_PREVIEW_HISTORY_NOTE = '[할 일 추가 미리보기]';
/** The SHORT_TERM assistant record of a candidate question (it shows the owner's items). */
export const DEICTIC_QUESTION_HISTORY_NOTE = '[할 일 추가 질문]';

/** Candidate lines are cut for display only (never a payload). */
export const DEICTIC_CANDIDATE_DISPLAY_MAX = 60;

const APPROVE_HINT: Readonly<Record<Lang, string>> = {
  ko: '맞으면 "응", 아니면 "아니"라고 답해 주세요. (5분 안에 답이 없으면 취소돼요)',
  en: 'Reply "yes" to add it or "no" to cancel. (It is canceled if there is no answer within 5 minutes.)',
};

/** Where the previewed text comes from (§3.1): the owner's message (with its time), a to-do number, or a reminder `#N`. */
export type DeicticOriginLine =
  | { readonly kind: 'owner.message'; readonly clock: string }
  | { readonly kind: 'todo'; readonly label?: number }
  | { readonly kind: 'reminder'; readonly label?: number };

function originText(origin: DeicticOriginLine, language: Lang): string {
  if (language === 'en') {
    if (origin.kind === 'owner.message') return `Source: your message (${origin.clock})`;
    if (origin.kind === 'todo') return origin.label !== undefined ? `Source: to-do #${origin.label}` : 'Source: your to-do';
    return origin.label !== undefined ? `Source: reminder #${origin.label}` : 'Source: your reminder';
  }
  if (origin.kind === 'owner.message') return `출처: 보내신 메시지 (${origin.clock})`;
  if (origin.kind === 'todo') return origin.label !== undefined ? `출처: 할 일 ${origin.label}번` : '출처: 할 일';
  return origin.label !== undefined ? `출처: 알림 #${origin.label}` : '출처: 알림';
}

/** The preview (§3.1): the whole normalised payload in a quoted untrusted block, the time, the origin, the answer hint. */
export function renderDeicticPreview(input: {
  readonly entryId: DeicticEntryId;
  readonly payload: string;
  readonly origin: DeicticOriginLine;
  readonly language: Lang;
  /** Reminders: the absolute time the owner's words give. */
  readonly whenLabel?: string;
  /**
   * To-dos: an open to-do with the same title exists; `label` is the number to name it by (the fresh listing's label, the
   * live number without a listing), absent when the fresh listing never showed it (the note then names no number).
   */
  readonly duplicate?: { readonly label?: number };
  /** Reminders: the referenced text itself names a time (never used). */
  readonly textHasTime?: boolean;
}): MessageBody {
  const ko = input.language === 'ko';
  const lines: MessagePart[] = [
    input.entryId === 'todo.add' ? (ko ? '할 일로 추가할까요?' : 'Add this as a to-do?') : ko ? '알림으로 만들까요?' : 'Create this reminder?',
    joinBody(['> ', untrustedText(input.payload)], ''),
  ];
  if (input.whenLabel !== undefined) lines.push(ko ? `언제: ${input.whenLabel}` : `When: ${input.whenLabel}`);
  lines.push(originText(input.origin, input.language));
  if (input.textHasTime === true) lines.push(ko ? '(내용에 있는 시간은 쓰지 않고, 말씀하신 시간으로 알려 드려요)' : '(A time inside the text is not used; your stated time is.)');
  if (input.duplicate !== undefined) {
    const label = input.duplicate.label;
    lines.push(ko ? `같은 제목의 할 일이 이미 있어요${label === undefined ? '' : ` (${label}번)`}` : `A to-do with the same title already exists${label === undefined ? '' : ` (#${label})`}`);
  }
  lines.push(APPROVE_HINT[input.language]);
  return joinBody(lines);
}

/** One candidate of a question (§2): its own shown label and its text cut at 60 characters. */
export interface DeicticCandidateLine {
  readonly origin: DeicticOriginLine;
  readonly text: string;
}

function shortened(text: string): string {
  const chars = Array.from(text);
  return chars.length <= DEICTIC_CANDIDATE_DISPLAY_MAX ? text : `${chars.slice(0, DEICTIC_CANDIDATE_DISPLAY_MAX).join('')}…`;
}

function candidateLabel(origin: DeicticOriginLine, language: Lang): string {
  if (origin.kind === 'owner.message') return language === 'en' ? 'your message' : '보내신 메시지';
  if (origin.kind === 'todo') return language === 'en' ? `to-do ${origin.label ?? ''}`.trim() : `할 일 ${origin.label !== undefined ? `${origin.label}번` : ''}`.trim();
  return language === 'en' ? `reminder #${origin.label ?? ''}` : `알림 #${origin.label ?? ''}`;
}

/** "어느 걸 할 일로 추가할까요?" with each candidate under its own shown label (Quoky never pre-selects). */
export function renderDeicticChoose(entryId: DeicticEntryId, candidates: readonly DeicticCandidateLine[], language: Lang): MessageBody {
  const ko = language === 'ko';
  const head = entryId === 'todo.add' ? (ko ? '어느 걸 할 일로 추가할까요?' : 'Which one should I add as a to-do?') : ko ? '어느 걸 알림으로 만들까요?' : 'Which one should I make a reminder?';
  const lines: MessagePart[] = [head];
  for (const candidate of candidates) lines.push(joinBody([`- ${candidateLabel(candidate.origin, language)}: `, untrustedText(shortened(candidate.text))], ''));
  lines.push(ko ? '번호로 답해 주세요. (아니면 "취소")' : 'Reply with the number (or "cancel").');
  return joinBody(lines);
}

export function renderDeicticTimeQuestion(language: Lang): string {
  return language === 'en' ? 'When should I remind you?' : '언제 알려 드릴까요?';
}

/** Why a deictic write was not previewed (§2, §4): fixed copy, nothing written. */
export type DeicticRefusalCopy = DeicticRefusalReason | 'ineligible' | 'too-long' | 'gone' | 'capped';

export function renderDeicticRefusal(reason: DeicticRefusalCopy, entryId: DeicticEntryId, language: Lang): string {
  const ko = language === 'ko';
  switch (reason) {
    case 'model-drafted':
      return ko ? '제 답변 내용은 아직 바로 옮기지 않아요. 추가할 내용을 직접 적어 주세요.' : 'I do not copy my own answers yet. Please write the content itself.';
    case 'external-origin':
      return ko ? '메일·문서·일정 같은 외부 내용은 그대로 옮기지 않아요. 추가할 내용을 직접 적어 주세요.' : 'I do not copy mail, documents or events. Please write the content itself.';
    case 'no-owner-message':
      return ko ? '말씀하신 메시지를 찾지 못했어요. 추가할 내용을 직접 적어 주세요.' : 'I could not find that message. Please write the content itself.';
    case 'stale-number':
      return ko ? '어느 목록의 번호인지 확인할 수 없어요. 목록을 다시 보거나 내용을 직접 적어 주세요.' : 'I cannot tell which list that number is from. Please show the list again or write the content.';
    case 'out-of-range':
      return ko ? '목록에 없는 번호예요. 추가할 내용을 직접 적어 주세요.' : 'That number is not in the list. Please write the content itself.';
    case 'too-long':
      return entryId === 'todo.add'
        ? ko ? '내용이 길어서 그대로 넣지 않았어요. 할 일로 쓸 문장을 적어 주세요.' : 'That text is too long to copy. Please write the to-do in one sentence.'
        : ko ? '내용이 길어서 그대로 넣지 않았어요. 알림으로 쓸 문장을 적어 주세요.' : 'That text is too long to copy. Please write the reminder in one sentence.';
    case 'gone':
    case 'not-found':
      return ko ? '그 내용은 더 이상 찾을 수 없어요. 직접 적어 주세요.' : 'I can no longer find that text. Please write it yourself.';
    case 'ineligible':
      return ko ? '그 내용은 그대로 옮길 수 없어요. 추가할 내용을 직접 적어 주세요.' : 'I cannot copy that text as it is. Please write the content itself.';
    case 'capped':
      return ko ? '미리보기를 너무 많이 만들었어요. 잠시 후 다시 말씀해 주세요.' : 'Too many previews for now. Please try again later.';
    case 'write-text':
      return renderDeicticPayload(language);
  }
}

/** The outcome of the owner's answer to a pending preview (§3.2, §3.3, §5). */
export type DeicticAnswerCopy = 'declined' | 'declined-undo' | 'expired' | 'stale-reply' | 'missing' | 'changed' | 'already' | 'fire-passed';

export function renderDeicticAnswer(copy: DeicticAnswerCopy, language: Lang): string {
  const ko = language === 'ko';
  switch (copy) {
    case 'declined':
      return ko ? '추가하지 않았어요.' : 'OK, I did not add it.';
    case 'declined-undo':
      return ko ? '아직 추가하지 않았어요. 미리보기를 취소했어요.' : 'Nothing was added yet. I canceled the preview.';
    case 'expired':
      return ko ? '미리보기가 만료됐어요. 아무것도 추가하지 않았어요.' : 'The preview expired. Nothing was added.';
    case 'stale-reply':
      return ko ? '그 미리보기는 끝났어요. 아무것도 추가하지 않았어요.' : 'That preview has ended. Nothing was added.';
    case 'missing':
      return ko ? '그 내용을 찾을 수 없어서 추가하지 않았어요.' : 'I could not find that text, so nothing was added.';
    case 'changed':
      return ko ? '내용이 바뀌어서 추가하지 않았어요.' : 'The text changed, so nothing was added.';
    case 'already':
      return ko ? '이미 처리했어요.' : 'That was already handled.';
    case 'fire-passed':
      return ko ? '알림 시각이 이미 지나서 추가하지 않았어요. 시간을 다시 말씀해 주세요.' : 'That time has already passed, so nothing was added. Please tell me the time again.';
  }
}

/** The prefix of a turn that ended an unanswered preview and was then handled normally (§3.2 `none`). */
export function renderDeicticDropped(language: Lang): string {
  return language === 'en' ? 'I canceled the preview.' : '미리보기는 취소했어요.';
}

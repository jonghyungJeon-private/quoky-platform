import type { MessageBody } from '../../domain';
import type { ConnectorItem, ConnectorItemSection } from '../../ports';
import { clipHeadAndTail } from '../attachment-context';
import { messageBody, messageContent, messageLink, untrustedText } from '../message-rendering';
import {
  UNTRUSTED_DOCUMENT_SECTIONS_MAX,
  buildUntrustedDocumentReadout,
  isUntrustedTextCredentialShaped,
  preparedBodyLength,
  type UntrustedDocumentReadout,
  type UntrustedDocumentRefusal,
  type UntrustedDocumentSection,
  type UntrustedDocumentSource,
} from '../untrusted-document-readout';
import type { WorkChatLookupFailure } from './work-chat-renderer';
import { safeLinkUrl } from './work-chat-renderer';

/**
 * ADR-0120 amendment A6 R2: the single-item readout of ONE listed Jira issue or Slack message (proposal §2, §3, §5),
 * built in Core from the adapter's content-free item detail. Pure. It is the only way that text reaches a model:
 *
 * - **Sections** are titled by Quoky ("설명", "댓글 3", "메시지", "답글 2"), never by content; each is clipped head and tail to
 *   {@link WORK_ITEM_SECTION_MAX_CHARS} before joining; at most {@link UNTRUSTED_DOCUMENT_SECTIONS_MAX} (a longer thread
 *   keeps its head and its tail). The ADR-0118 builder then normalises, neutralises links, clips the body to 3,000 code
 *   points head and tail and withholds the whole item on a credential match.
 * - **People (owner decision D5).** In `summary` mode every author and mention is a pseudonym ("참여자 A, B, …", in order of
 *   first appearance) before the text is built, for Jira and Slack alike, so no name reaches a model. In `full` mode
 *   (no model) Jira shows the comment authors' display names as untrusted spans; Slack stays pseudonymous (real names
 *   would need `users.info`).
 *
 * The copy below is the fixed reply of every outcome; none falls back to a model or another item.
 */

export type WorkItemSource = 'jira' | 'slack';
export type WorkItemScope = 'item' | 'thread';
export type WorkItemMode = 'summary' | 'full';

/** Per section, before joining (proposal §2.2). */
export const WORK_ITEM_SECTION_MAX_CHARS = 1_200;

export interface WorkItemReadoutInput {
  readonly source: WorkItemSource;
  readonly scope: WorkItemScope;
  readonly mode: WorkItemMode;
  readonly item: ConnectorItem;
}

export type WorkItemReadoutResult =
  | { readonly ok: true; readonly readout: UntrustedDocumentReadout; readonly totalChars: number }
  | { readonly ok: false; readonly refusal: UntrustedDocumentRefusal };

/** The readout source of one R2 read. */
export function workItemDocumentSource(source: WorkItemSource, scope: WorkItemScope): UntrustedDocumentSource {
  if (source === 'jira') return 'jira-issue';
  return scope === 'thread' ? 'slack-thread' : 'slack-message';
}

/** "참여자 A" … "참여자 Z", then "참여자 A2" … (never a name). */
export function pseudonymLabel(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  const round = Math.floor(index / 26);
  return `참여자 ${letter}${round > 0 ? round + 1 : ''}`;
}

/** Every handle → its pseudonym, in order of first appearance (the adapter's `people` order, then section authors). */
function pseudonymsOf(item: ConnectorItem): Map<string, string> {
  const handles: string[] = [];
  const add = (handle: string | undefined): void => {
    const trimmed = handle?.trim() ?? '';
    if (trimmed.length >= 2 && !handles.includes(trimmed)) handles.push(trimmed);
  };
  for (const section of item.detail?.sections ?? []) add(section.author);
  for (const handle of item.detail?.people ?? []) add(handle);
  // First appearance in the readout: an author or mention in an earlier section comes first.
  const order = (handle: string): number => {
    const sections = item.detail?.sections ?? [];
    for (const [index, section] of sections.entries()) {
      if (section.author?.trim() === handle || section.text.includes(handle)) return index;
    }
    return sections.length;
  };
  const sorted = handles.map((handle, at) => ({ handle, at, first: order(handle) })).sort((a, b) => a.first - b.first || a.at - b.at);
  return new Map(sorted.map((entry, index) => [entry.handle, pseudonymLabel(index)]));
}

const HANGUL = '가-힣';
/** Closed particle class a bare given name may carry ("혜정이", "혜정에게", "혜정도"); nothing else may follow it. */
const NAME_PARTICLES = '이랑|이에게|이한테|이가|이는|이도|이를|이의|에게서|에게|한테|께서|께|으로|로|처럼|보다|부터|까지|이|가|은|는|을|를|도|만|과|와|의|랑|아|야|에';
const HONORIFIC = '(?:님|씨)';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The patterns one participant's name is written as in free text, all derived from the handle itself (no name list):
 * the whole handle, each Hangul or Latin part of it, a Korean given name (the part after a one-syllable family name, the
 * last two syllables of a three- or four-syllable name) bare or with an honorific, and a one-syllable given name only
 * with an honorific (님 / 씨, consumed with the name). A bare given name counts only before a particle or a non-Hangul
 * character, so a word that merely contains it is left alone.
 */
function namePatterns(handle: string): { readonly key: string; readonly source: string }[] {
  const patterns: { key: string; source: string }[] = [{ key: handle, source: `${escapeRegExp(handle)}${HONORIFIC}?` }];
  const bareGiven = (given: string): string => `(?<![${HANGUL}])${given}(?:${HONORIFIC}|(?=(?:${NAME_PARTICLES})?(?![${HANGUL}])))`;
  for (const part of handle.split(/[^A-Za-z가-힣]+/u)) {
    if (part.length === 0 || part === handle) continue;
    if (/^[가-힣]+$/u.test(part)) {
      if (part.length >= 2) patterns.push({ key: part, source: `(?<![${HANGUL}])${part}${HONORIFIC}?` });
    } else if (/^[A-Za-z]{3,}$/u.test(part)) {
      patterns.push({ key: part, source: `(?<![A-Za-z])${part}(?![A-Za-z])${HONORIFIC}?` });
    }
  }
  for (const part of handle.split(/[^가-힣]+/u)) {
    if (part.length === 3 || part.length === 4) patterns.push({ key: part.slice(-2), source: bareGiven(part.slice(-2)) });
    if (part.length === 2) patterns.push({ key: part.slice(-1), source: `(?<![${HANGUL}])${part.slice(-1)}${HONORIFIC}` });
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

/** The participants of an item in pseudonym order (empty unless the item is shown anonymously). */
export function workItemParticipants(item: ConnectorItem): WorkItemParticipant[] {
  return [...pseudonymsOf(item).entries()].map(([handle, label]) => ({ handle, label }));
}

function sectionTitle(source: WorkItemSource, scope: WorkItemScope, section: ConnectorItemSection, index: number, comment: number): string {
  if (section.kind === 'description') return '설명';
  if (section.kind === 'comment') return `댓글 ${comment}`;
  if (source === 'slack' && scope === 'thread') return index === 0 ? '원글' : `답글 ${index}`;
  return '메시지';
}

/** A6 R2: build the readout (or the builder's refusal). */
export function buildWorkItemReadout(input: WorkItemReadoutInput): WorkItemReadoutResult {
  const { item, source, scope, mode } = input;
  const detail = item.detail;
  // Codex P1: the strict credential guard reads every COMPLETE, normalised original field BEFORE anything is clipped or
  // pseudonymised (a clip could keep a value while cutting its "password:" key; a pseudonym could split one). A match
  // withholds the whole item. The builder below still guards the exact final payload.
  const originals = [item.title, item.status ?? '', ...(detail?.sections ?? []).flatMap((section) => [section.text, section.author ?? '']), ...(detail?.people ?? [])];
  if (originals.some((field) => isUntrustedTextCredentialShaped(field))) return { ok: false, refusal: 'CREDENTIAL_SHAPED' };
  const anonymous = mode === 'summary' || source === 'slack';
  const names = anonymous ? pseudonymsOf(item) : new Map<string, string>();
  const participants = [...names.entries()].map(([handle, label]) => ({ handle, label }));
  const people = (text: string): string => (anonymous ? pseudonymiseParticipants(text, participants) : text);
  let sections = detail?.sections ?? [];
  let droppedMiddle = false;
  if (sections.length > UNTRUSTED_DOCUMENT_SECTIONS_MAX) {
    const half = Math.floor(UNTRUSTED_DOCUMENT_SECTIONS_MAX / 2);
    sections = [...sections.slice(0, half), ...sections.slice(sections.length - (UNTRUSTED_DOCUMENT_SECTIONS_MAX - half))];
    droppedMiddle = true;
  }
  let comment = 0;
  let clipped = false;
  // Codex P2: the fetched Jira status is part of the readout (its own Quoky-titled section, guarded like the rest).
  const status = source === 'jira' && item.status !== undefined && item.status.trim().length > 0 ? [{ title: '상태', body: people(item.status) }] : [];
  const built: UntrustedDocumentSection[] = [...status, ...sections.map((section, index) => {
    if (section.kind === 'comment') comment += 1;
    const author = section.author?.trim();
    const shownAuthor = author === undefined || author.length === 0 || author === 'unknown' ? undefined : anonymous ? (names.get(author) ?? pseudonymLabel(names.size)) : author;
    const title = `${sectionTitle(source, scope, section, index, comment)}${shownAuthor !== undefined ? ` · ${shownAuthor}` : ''}`;
    const text = clipHeadAndTail(people(section.text), WORK_ITEM_SECTION_MAX_CHARS);
    if (text.truncated) clipped = true;
    return { title, body: text.text, ...(text.truncated ? { truncated: true } : {}) };
  })];
  const result = buildUntrustedDocumentReadout({
    source: workItemDocumentSource(source, scope),
    title: people(item.title),
    author: '',
    date: item.updatedAt ?? '',
    body: '',
    sections: built,
    sourceTruncated: detail?.partial === true || droppedMiddle || clipped,
  });
  if (!result.ok) return result;
  const totalChars = (detail?.sections ?? []).reduce((sum, section) => sum + preparedBodyLength(section.text), 0);
  return { ok: true, readout: result.readout, totalChars };
}

// ── fixed copy (proposal §5) ────────────────────────────────────────────────────────────────────────────────────────

const NOUN: Readonly<Record<WorkItemSource, string>> = { jira: '지라', slack: '슬랙' };

/** The label of the item as the owner saw it ("지라 이슈 2번", "슬랙 목록 2번"); fixed Quoky copy. */
export function workItemLabel(source: WorkItemSource, label: number | undefined, scope: WorkItemScope = 'item'): string {
  const noun = source === 'jira' ? '지라 이슈' : scope === 'thread' ? '슬랙 스레드' : '슬랙 메시지';
  return label === undefined ? `그 ${noun}` : `${noun} ${label}번`;
}

/** `QUOKY_WORK_SUMMARY_ENABLED=false`: a summary is refused before any fetch. */
export function renderWorkItemSummaryOff(): string {
  return "요약이 꺼져 있어요. '원문 보여줘'로 전체를 볼 수 있어요.";
}

/** A6-D1: `item.summarize` is DM-only. */
export function renderWorkItemDmOnly(): string {
  return '이 작업은 DM에서만 해요';
}

/** A Jira scope other than the item, or a Slack thread reply one request cannot isolate. */
export function renderWorkItemReplyNotIsolable(): string {
  return "스레드 답글 하나만 따로 읽을 수는 없어요. '스레드 요약'으로 스레드 전체를 볼 수 있어요.";
}

export function renderWorkItemEmpty(): string {
  return '내용이 비어 있어요.';
}

export function renderWorkItemCredentialWithheld(): string {
  return '비밀값처럼 보이는 내용이 있어 이 항목은 읽지 않았어요. 아무것도 보내지 않았어요.';
}

/** The fixed failure reply of one fetch (no model, no other item, no retry). `link` is the deterministic Jira link. */
export function renderWorkItemFailure(source: WorkItemSource, failure: WorkChatLookupFailure, link?: string): MessageBody {
  const jira = source === 'jira';
  switch (failure) {
    case 'UNAUTHORIZED':
      return jira ? '지라 인증이 만료됐어요. 토큰을 확인해 주세요.' : '슬랙 인증이 만료됐어요. 토큰을 확인해 주세요.';
    case 'NOT_FOUND':
      return jira ? '그 이슈를 찾을 수 없어요. 삭제됐거나 볼 권한이 없을 수 있어요.' : '메시지가 삭제됐거나 찾을 수 없어요.';
    case 'FORBIDDEN':
      return jira ? '그 이슈를 볼 권한이 없어요.' : '그 채널 메시지를 읽을 권한이 없어요.';
    case 'INSUFFICIENT_SCOPE':
      return jira ? '그 이슈를 볼 권한이 없어요.' : '비공개 채널 메시지는 읽을 권한이 없어요.';
    case 'MOVED':
      return jira ? '그 이슈는 다른 곳으로 옮겨졌어요. 목록을 다시 보여 드릴까요?' : '메시지가 삭제됐거나 찾을 수 없어요.';
    case 'RATE_LIMITED':
      return '지금은 요청이 많아요. 잠시 후 다시 말씀해 주세요.';
    case 'TOO_LARGE': {
      const text = jira ? '이 이슈는 너무 커서 읽지 못했어요. 지라에서 직접 열어 주세요.' : '이 메시지는 너무 커서 읽지 못했어요. 슬랙에서 직접 열어 주세요.';
      const url = safeLinkUrl(link);
      return url === undefined ? text : messageBody(text, ' ', messageLink(url));
    }
    case 'INVALID_RESPONSE':
      // CA P3: a malformed answer has its own reply (never called "too large").
      return jira ? '지라의 응답을 해석하지 못했어요. 잠시 후 다시 말씀해 주세요.' : '슬랙의 응답을 해석하지 못했어요. 잠시 후 다시 말씀해 주세요.';
    case 'NOT_CONFIGURED':
    case 'IDENTITY_MISSING':
    case 'UNSUPPORTED_QUERY':
      return `${NOUN[source]} 항목을 지금은 읽을 수 없어요.`;
    case 'UNAVAILABLE':
    case 'TIMEOUT':
      return `${NOUN[source]}에 지금 연결할 수 없어요.`;
  }
}

/** The audit `fetchOutcome` of a failure (closed values, proposal §4). */
export function workItemFetchOutcome(failure: WorkChatLookupFailure): string {
  switch (failure) {
    case 'NOT_FOUND':
      return 'not-found';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'INSUFFICIENT_SCOPE':
      return 'scope';
    case 'MOVED':
      return 'moved';
    case 'RATE_LIMITED':
      return 'rate-limited';
    case 'TOO_LARGE':
      return 'too-large';
    case 'INVALID_RESPONSE':
      return 'invalid-response';
    default:
      return 'unavailable';
  }
}

/** The response size as a content-free bucket. */
export function workItemBytesBucket(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '0';
  if (bytes < 1_024) return '<1KiB';
  if (bytes < 16 * 1_024) return '<16KiB';
  if (bytes < 128 * 1_024) return '<128KiB';
  if (bytes < 1_048_576) return '<1MiB';
  return '>=1MiB';
}

/**
 * The deterministic notes of a read (Quoky copy and structural facts only): a partial Jira comment page, a description-
 * only retry, a validated move, an edit after the listing, the replies a Slack message has, a cut thread page.
 */
export function workItemNotes(input: { readonly source: WorkItemSource; readonly scope: WorkItemScope; readonly item: ConnectorItem; readonly listedKey?: string; readonly listingAt?: string }): string[] {
  const { item } = input;
  const detail = item.detail;
  const notes: string[] = [];
  if (detail === undefined) return notes;
  const comments = detail.comments;
  if (detail.descriptionOnly === true) notes.push('댓글은 너무 많아 읽지 않았어요.');
  else if (comments !== undefined && comments.total > comments.returned) {
    notes.push(
      comments.newest === true
        ? `댓글 ${comments.total}개 중 최근 ${comments.kept}개만 읽었어요.`
        : `댓글 ${comments.total}개 중 앞쪽 ${comments.returned}개만 받았어요. 최근 댓글 ${comments.total - comments.returned}개는 읽지 않았어요.`,
    );
  }
  // Codex P2: comments of the returned page dropped locally (only the last ones are read) are said too.
  if (detail.descriptionOnly !== true && comments !== undefined && comments.newest !== true && comments.kept < comments.returned) {
    notes.push(`받은 댓글 ${comments.returned}개 중 최근 ${comments.kept}개만 읽었어요.`);
  }
  if (detail.movedTo !== undefined && input.listedKey !== undefined && detail.movedTo !== input.listedKey) {
    notes.push(`${input.listedKey} → ${detail.movedTo}으로 옮겨졌어요.`);
  }
  if (input.listingAt !== undefined && item.updatedAt !== undefined && Date.parse(item.updatedAt) > Date.parse(input.listingAt)) notes.push('목록 이후 수정됨');
  if (input.source === 'slack' && input.scope === 'item' && (detail.replyCount ?? 0) > 0) {
    notes.push(`스레드 답글 ${detail.replyCount}개가 있어요. '스레드 요약'이라고 하시면 함께 볼게요.`);
  }
  if (detail.hasMore === true) notes.push('답글이 더 있지만 앞부분만 읽었어요.');
  return notes;
}

/**
 * The fixed footer of a summary: the deterministic source (a Jira link from the adapter, `{baseUrl}/browse/{KEY}`; for
 * Slack the listing label, since `conversations.replies` returns no permalink and fetching one would be a second call)
 * and the notes.
 */
export function renderWorkItemFooter(source: WorkItemSource, scope: WorkItemScope, label: number | undefined, item: ConnectorItem, notes: readonly string[]): MessageBody {
  const url = source === 'jira' ? safeLinkUrl(item.url) : undefined;
  const origin =
    source === 'jira'
      ? url !== undefined
        ? messageContent('출처: ', untrustedText(item.id), ' ', messageLink(url))
        : messageContent('출처: ', untrustedText(item.id))
      : `출처: ${label !== undefined ? `슬랙 목록 ${label}번` : scope === 'thread' ? '슬랙 스레드' : '슬랙 메시지'}`;
  return messageBody(origin, ...notes.flatMap((note) => ['\n', note]));
}

/** The deterministic fallback when no summary is produced: title, status, link and the fixed line (proposal §5). */
export function renderWorkItemFallback(source: WorkItemSource, item: ConnectorItem, notes: readonly string[]): MessageBody {
  const url = source === 'jira' ? safeLinkUrl(item.url) : undefined;
  const status = item.status !== undefined && item.status.length > 0 ? messageContent(' (', untrustedText(item.status), ')') : '';
  return messageBody(
    untrustedText(item.title),
    status,
    ...(url !== undefined ? [' ', messageLink(url)] : []),
    '\n',
    "요약을 만들지 못했어요. '원문 보여줘'로 볼 수 있어요.",
    ...notes.flatMap((note) => ['\n', note]),
  );
}

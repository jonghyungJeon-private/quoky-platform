import {
  LEARNING_CAPABILITY_UNKNOWN,
  LEARNING_EGRESS_LOCAL_ONLY,
  LEARNING_MAX_ITEMS_PER_ACTOR,
  LEARNING_PRUNE_MAX_ROWS,
  LEARNING_RETENTION_MS,
  LEARNING_TEXT_MAX_CHARS,
  LearningItemKind,
  learningLanguageOf,
} from '../../domain';
import type {
  FeedbackRatedTurn, Id, IsoTimestamp, LearningItem, LearningItemData, LearningSourceRating, MessageBody, MessageContent, Task,
} from '../../domain';
import type { FeedbackRepository, LearningRepository, Logger } from '../../ports';
import { newId } from '../../util/id';
import { containsCredentialFileContent, containsCredentialMaterial } from '../credential-guard';
import { joinBody, messageBody, messageFields } from '../message-rendering';
import { FEEDBACK_SUMMARY_WINDOW_MS } from './feedback-recorder';
import { FEEDBACK_SUPPRESSED_EXCERPT, feedbackCapabilityLabel, feedbackRequestExcerpt } from './feedback-summary-composer';
import type { LearningCommand } from './learning-commands';

/**
 * Learning candidates and curated examples (ADR-0107 D1/D3/D7, LRN-1). Deterministic and provider-free.
 *
 * Consent: text enters the store only through the owner's command on one listed item (`후보 N 메모: …`,
 * `후보 N 예시로 저장`, `예시 N 수정: …`). The request text comes from the locally stored Task of the rated turn; the
 * reply text only from {@link LearningReplyLookup} when the reply is stored locally, otherwise the owner supplies
 * the ideal answer. The strict credential guard runs at capture and again at every use (listing, editing, export):
 * a match is refused, never redacted-and-kept. Items are `LOCAL_ONLY`, expire 365 days after creation (lazy,
 * bounded pruning on every write) and are capped at {@link LEARNING_MAX_ITEMS_PER_ACTOR} per actor. Every read and
 * delete is scoped to the acting owner.
 */

/** Numbers from a listing stay valid this long (and until the next listing of the same kind at that location). */
export const LEARNING_LISTING_TTL_MS = 30 * 60 * 1000;
/** At most this many items are listed (and numbered) by one listing command. */
export const LEARNING_LISTING_LIMIT = 10;
/** Bound on concurrently remembered listings (oldest dropped first). */
export const LEARNING_LISTING_MAX_BINDINGS = 64;

/** Read-only Task lookup for the request text of a rated turn. */
export interface LearningTaskLookup {
  get(id: Id): Promise<Pick<Task, 'description'> | null>;
}

/**
 * The locally stored reply text of a rated turn, when one exists (ADR-0107 D3). v3 stores no reply text (ADR-0098
 * D4 keeps only its length), so the composition root binds none and the owner supplies the ideal answer.
 */
export interface LearningReplyLookup {
  replyTextOf(turn: Pick<FeedbackRatedTurn, 'turnId' | 'taskId'>): Promise<string | undefined>;
}

export interface LearningServiceDeps {
  feedback: Pick<FeedbackRepository, 'listRatedTurns'>;
  learning: LearningRepository;
  tasks: LearningTaskLookup;
  replies?: LearningReplyLookup;
  idGenerator?: () => string;
  logger?: Logger;
  /**
   * ADR-0116 R4: true when saved examples may accompany a conversation sent to an owner-selected cloud chat model
   * (`QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED` with examples enabled). Appends one disclosure line to the surfaces
   * that offer or confirm an example; absent/false leaves every text byte-identical.
   */
  remoteExamplesDisclosure?: boolean;
}

/** Where a listing was shown; numbers are bound per actor and conversation location. */
export interface LearningCommandScope {
  actorId: Id;
  platform: string;
  channelId: string;
  threadId?: string;
}

export interface LearningCommandResult {
  /** The reply as plain text; `content` is present when it quotes request excerpts (untrusted spans, PLT-0). */
  text: string;
  content?: MessageContent;
  status: 'RESPONDED' | 'FAILED';
}

/** Why a text was refused at capture or use. */
export type LearningTextRefusal = 'CREDENTIAL' | 'TOO_LONG' | 'EMPTY';

/**
 * The strict credential guard of ADR-0107 D1: the chat-text detector and the stricter file-content detector. Any
 * match refuses the text (never redacts it).
 */
export function learningTextHasCredential(text: string): boolean {
  return containsCredentialMaterial(text) || containsCredentialFileContent(text);
}

/** Why `text` may not be stored or used, or null when it may (guard, then the 2,000-character bound). */
export function learningTextRefusal(text: string | undefined): LearningTextRefusal | null {
  if (text === undefined || text.trim().length === 0) return 'EMPTY';
  if (learningTextHasCredential(text)) return 'CREDENTIAL';
  if ([...text].length > LEARNING_TEXT_MAX_CHARS) return 'TOO_LONG';
  return null;
}

/**
 * A request excerpt for a learning listing: hidden (never shown verbatim or redacted) when the strict learning guard
 * matches the full request, otherwise the feedback excerpt (which adds the chat guard, the bound and mention
 * neutralisation). The chat-only guard of {@link feedbackRequestExcerpt} misses file-content credentials such as
 * `const dbPassword = "…"`, so every learning surface goes through this function (ADR-0107 D1 "again at use").
 */
export function learningRequestExcerpt(text: string | undefined): MessageBody {
  if (text !== undefined && learningTextHasCredential(text)) return FEEDBACK_SUPPRESSED_EXCERPT;
  return feedbackRequestExcerpt(text);
}

/** True when every stored text field of `data` still passes the guard and bound (ADR-0107 D1 "again at use"). */
export function learningItemUsable(data: LearningItemData): boolean {
  const fields = [data.requestText, data.idealAnswer, data.note, data.expectedBehavior];
  return learningTextRefusal(data.requestText) === null
    && fields.every((field) => field === undefined || learningTextRefusal(field) === null);
}

function shiftIso(iso: IsoTimestamp, deltaMs: number): IsoTimestamp {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

function ratingOf(turn: Pick<FeedbackRatedTurn, 'positive' | 'negative'>): LearningSourceRating {
  // A turn with both reactions present counts as 👎: a note is still allowed, an example is not.
  return turn.negative > 0 ? 'NEGATIVE' : 'POSITIVE';
}

const RATING_EMOJI: Readonly<Record<LearningSourceRating, string>> = { POSITIVE: '👍', NEGATIVE: '👎' };

type ListingKind = 'candidates' | 'examples';
interface Listing {
  kind: ListingKind;
  ids: readonly Id[];
  boundAtMs: number;
}
type ResolvedNumber = { id: Id } | { problem: 'NO_LISTING' | 'OUT_OF_RANGE' };

/** In-memory numbering of the last listing per scope and kind (lost on restart; the reply asks to list again). */
class LearningListingBindings {
  private readonly listings = new Map<string, Listing>();

  bind(scope: LearningCommandScope, kind: ListingKind, ids: readonly Id[], nowMs: number): void {
    const key = this.keyOf(scope, kind);
    this.listings.delete(key);
    this.listings.set(key, { kind, ids: [...ids], boundAtMs: nowMs });
    while (this.listings.size > LEARNING_LISTING_MAX_BINDINGS) {
      const oldest = this.listings.keys().next().value;
      if (oldest === undefined) break;
      this.listings.delete(oldest);
    }
  }

  resolve(scope: LearningCommandScope, kind: ListingKind, index: number, nowMs: number): ResolvedNumber {
    const key = this.keyOf(scope, kind);
    const listing = this.listings.get(key);
    if (!listing || !Number.isFinite(nowMs) || nowMs - listing.boundAtMs > LEARNING_LISTING_TTL_MS
      || nowMs < listing.boundAtMs) {
      this.listings.delete(key);
      return { problem: 'NO_LISTING' };
    }
    const id = listing.ids[index - 1];
    return id === undefined ? { problem: 'OUT_OF_RANGE' } : { id };
  }

  private keyOf(scope: LearningCommandScope, kind: ListingKind): string {
    return JSON.stringify([kind, scope.actorId, scope.platform, scope.channelId, scope.threadId ?? null]);
  }
}

// ── Fixed Korean copy ────────────────────────────────────────────────────────────────────────────────────────────
export const LEARNING_FAILURE_TEXT = '학습 후보를 지금 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
const STORAGE_NOTE = '저장한 내용은 이 기기에만 보관하고 1년 뒤 자동으로 지워져요. 답변 방식이 자동으로 바뀌지는 않아요.';
/** ADR-0116 R4: the egress disclosure, shown only when remote examples are on. */
export const LEARNING_REMOTE_DISCLOSURE = '직접 고른 클라우드 모델을 쓸 때는 이 예시가 대화와 함께 전송될 수 있어요.';
const CANDIDATES_EMPTY =
  '최근 30일 동안 👍/👎를 남긴 답변이 없어요. 답변에 반응을 남기면 여기에서 학습 후보로 고를 수 있어요.';
const EXAMPLES_EMPTY =
  '저장된 예시가 없어요. "피드백 후보"에서 👍 답변을 골라 "후보 N 예시로 저장"으로 저장할 수 있어요.';
const CREDENTIAL_REFUSED = '비밀번호나 토큰 같은 민감한 정보가 들어 있어 저장하지 않았어요. 내용을 빼고 다시 보내 주세요.';
const REQUEST_CREDENTIAL_REFUSED = '그 답변의 요청에 민감한 정보가 들어 있을 수 있어 학습 후보로 저장하지 않았어요.';
const TOO_LONG = `내용이 너무 길어요. ${LEARNING_TEXT_MAX_CHARS.toLocaleString('en-US')}자 이하로 줄여 주세요.`;
const REQUEST_TOO_LONG = `그 답변의 요청이 ${LEARNING_TEXT_MAX_CHARS.toLocaleString('en-US')}자를 넘어 학습 후보로 저장하지 않았어요.`;
const REQUEST_MISSING = '그 답변의 요청 내용이 이 기기에 남아 있지 않아 저장할 수 없어요.';
const CAP_REACHED =
  `학습 항목이 최대 ${LEARNING_MAX_ITEMS_PER_ACTOR.toLocaleString('en-US')}개에 도달해 더 저장할 수 없어요. "예시 N 삭제"로 정리해 주세요.`;
const UNUSABLE_LINE = '(민감한 내용이 감지돼 사용하지 않아요. 삭제를 권해요)';

function relistText(kind: ListingKind): string {
  return kind === 'candidates' ? '"피드백 후보"' : '"예시 목록"';
}

function noListingText(kind: ListingKind): string {
  return `먼저 ${relistText(kind)}로 목록을 확인한 뒤 번호를 골라 주세요. 번호는 목록을 본 뒤 30분 동안만 쓸 수 있어요.`;
}

function outOfRangeText(kind: ListingKind, index: number): string {
  return `목록에 ${index}번이 없어요. ${relistText(kind)}로 목록을 다시 확인해 주세요.`;
}

function refusalText(refusal: LearningTextRefusal): string {
  return refusal === 'CREDENTIAL' ? CREDENTIAL_REFUSED : TOO_LONG;
}

/**
 * Owner learning commands (ADR-0107 D3/D7). Every method catches nothing itself: the turn handler maps a thrown
 * error to {@link LEARNING_FAILURE_TEXT}.
 */
export class LearningService {
  private readonly bindings = new LearningListingBindings();
  private readonly idGenerator: () => string;

  constructor(private readonly deps: LearningServiceDeps) {
    this.idGenerator = deps.idGenerator ?? newId;
  }

  async execute(command: LearningCommand, scope: LearningCommandScope, now: IsoTimestamp): Promise<LearningCommandResult> {
    switch (command.kind) {
      case 'list-candidates':
        return this.listCandidates(scope, now);
      case 'candidate-note':
        return this.saveCandidate(scope, command.index, LearningItemKind.GOLDEN_CANDIDATE, command.note, now);
      case 'candidate-example':
        return this.saveCandidate(scope, command.index, LearningItemKind.EXAMPLE, undefined, now);
      case 'list-examples':
        return this.listExamples(scope, now);
      case 'example-edit':
        return this.editExample(scope, command.index, command.answer, now);
      case 'example-delete':
        return this.deleteExample(scope, command.index, now);
    }
  }

  private disclosureLines(): string[] {
    return this.deps.remoteExamplesDisclosure === true ? [LEARNING_REMOTE_DISCLOSURE] : [];
  }

  private async listCandidates(scope: LearningCommandScope, now: IsoTimestamp): Promise<LearningCommandResult> {
    const turns = await this.deps.feedback.listRatedTurns({
      actorId: scope.actorId,
      since: shiftIso(now, -FEEDBACK_SUMMARY_WINDOW_MS),
      limit: LEARNING_LISTING_LIMIT,
    });
    this.bindings.bind(scope, 'candidates', turns.map((turn) => turn.turnId), Date.parse(now));
    if (turns.length === 0) return { text: CANDIDATES_EMPTY, status: 'RESPONDED' };
    const lines: MessageBody[] = [`최근 평가한 답변이에요(최근 30일, 최신순 ${turns.length}개). 번호는 30분 동안 쓸 수 있어요.`];
    for (const [i, turn] of turns.entries()) {
      const request = await this.requestTextOf(turn.taskId);
      lines.push(
        messageBody(
          `${i + 1}. ${turn.createdAt.slice(0, 10)} · ${RATING_EMOJI[ratingOf(turn)]} · ${feedbackCapabilityLabel(turn.capability)} · `,
          learningRequestExcerpt(request),
        ),
      );
    }
    lines.push(
      '',
      '👎 답변: "후보 N 메모: 무엇이 잘못됐는지" · 👍 답변: "후보 N 예시로 저장"',
      STORAGE_NOTE,
      ...this.disclosureLines(),
    );
    return { ...messageFields(joinBody(lines)), status: 'RESPONDED' };
  }

  private async saveCandidate(
    scope: LearningCommandScope,
    index: number,
    kind: LearningItemKind,
    note: string | undefined,
    now: IsoTimestamp,
  ): Promise<LearningCommandResult> {
    const resolved = this.bindings.resolve(scope, 'candidates', index, Date.parse(now));
    if ('problem' in resolved) {
      return { text: resolved.problem === 'NO_LISTING' ? noListingText('candidates') : outOfRangeText('candidates', index), status: 'RESPONDED' };
    }
    // Re-check the turn: it must still be this actor's, still rated, and rated the way the command needs.
    const [turn] = await this.deps.feedback.listRatedTurns({
      actorId: scope.actorId,
      since: shiftIso(now, -FEEDBACK_SUMMARY_WINDOW_MS),
      limit: 1,
      turnId: resolved.id,
    });
    if (!turn) return { text: `그 답변의 평가가 바뀌었거나 기간이 지났어요. ${relistText('candidates')}로 목록을 다시 확인해 주세요.`, status: 'RESPONDED' };
    const rating = ratingOf(turn);
    if (kind === LearningItemKind.GOLDEN_CANDIDATE && rating !== 'NEGATIVE') {
      return { text: `${index}번은 👍 답변이에요. 메모는 👎 답변에 남기고, 👍 답변은 "후보 ${index} 예시로 저장"으로 저장할 수 있어요.`, status: 'RESPONDED' };
    }
    if (kind === LearningItemKind.EXAMPLE && rating !== 'POSITIVE') {
      return { text: `${index}번은 👎 답변이라 예시로 저장하지 않아요. 무엇이 잘못됐는지는 "후보 ${index} 메모: 내용"으로 남겨 주세요.`, status: 'RESPONDED' };
    }

    if (note !== undefined) {
      const refusal = learningTextRefusal(note);
      if (refusal) return { text: refusalText(refusal), status: 'RESPONDED' };
    }
    const requestText = await this.requestTextOf(turn.taskId);
    const requestRefusal = learningTextRefusal(requestText);
    if (requestRefusal === 'EMPTY') return { text: REQUEST_MISSING, status: 'RESPONDED' };
    if (requestRefusal === 'CREDENTIAL') return { text: REQUEST_CREDENTIAL_REFUSED, status: 'RESPONDED' };
    if (requestRefusal === 'TOO_LONG') return { text: REQUEST_TOO_LONG, status: 'RESPONDED' };

    let idealAnswer: string | undefined;
    if (kind === LearningItemKind.EXAMPLE) {
      const reply = await this.deps.replies?.replyTextOf(turn);
      // A locally stored reply is used only when it passes the same guard and bound; otherwise the owner supplies one.
      idealAnswer = reply !== undefined && learningTextRefusal(reply) === null ? reply : undefined;
    }

    const data: LearningItemData = {
      requestText: requestText as string,
      sourceRating: rating,
      ...(note !== undefined ? { note } : {}),
      ...(idealAnswer !== undefined ? { idealAnswer } : {}),
      ...(turn.intentType !== undefined ? { intentType: turn.intentType } : {}),
    };
    await this.deps.learning.pruneExpired(now, LEARNING_PRUNE_MAX_ROWS);

    const existing = await this.deps.learning.findBySourceTurn(scope.actorId, kind, turn.turnId, now);
    if (existing) {
      if (kind === LearningItemKind.EXAMPLE) {
        return { text: `${index}번 답변은 이미 예시로 저장돼 있어요. "예시 목록"에서 확인할 수 있어요.`, status: 'RESPONDED' };
      }
      await this.deps.learning.updateData(scope.actorId, existing.id, data, now);
      return { text: `${index}번 답변의 메모를 새 내용으로 바꿨어요.\n${STORAGE_NOTE}`, status: 'RESPONDED' };
    }

    const item: LearningItem = {
      id: this.idGenerator(),
      actorId: scope.actorId,
      kind,
      capability: turn.capability ?? LEARNING_CAPABILITY_UNKNOWN,
      language: learningLanguageOf(data.requestText),
      sourceTurnId: turn.turnId,
      egress: LEARNING_EGRESS_LOCAL_ONLY,
      createdAt: now,
      expiresAt: shiftIso(now, LEARNING_RETENTION_MS),
      data,
    };
    const inserted = await this.deps.learning.insertWithinCap(item, LEARNING_MAX_ITEMS_PER_ACTOR, now);
    if (inserted === 'CAP_REACHED') return { text: CAP_REACHED, status: 'RESPONDED' };
    if (kind === LearningItemKind.GOLDEN_CANDIDATE) {
      return { text: `${index}번 답변의 메모를 학습 후보로 저장했어요.\n${STORAGE_NOTE}`, status: 'RESPONDED' };
    }
    const answerLine = idealAnswer !== undefined
      ? '답변도 함께 저장했어요.'
      : '답변 내용은 이 기기에 저장돼 있지 않아요. "예시 목록"에서 번호를 확인한 뒤 "예시 N 수정: 좋은 답변"으로 채워 주세요.';
    const disclosure = this.disclosureLines().map((line) => `\n${line}`).join('');
    return { text: `${index}번 답변을 예시로 저장했어요. ${answerLine}\n${STORAGE_NOTE}${disclosure}`, status: 'RESPONDED' };
  }

  private async listExamples(scope: LearningCommandScope, now: IsoTimestamp): Promise<LearningCommandResult> {
    const items = await this.deps.learning.list({
      actorId: scope.actorId, kind: LearningItemKind.EXAMPLE, now, limit: LEARNING_LISTING_LIMIT,
    });
    this.bindings.bind(scope, 'examples', items.map((item) => item.id), Date.parse(now));
    if (items.length === 0) return { text: EXAMPLES_EMPTY, status: 'RESPONDED' };
    const lines: MessageBody[] = [`저장된 예시예요(최신순 ${items.length}개). 번호는 30분 동안 쓸 수 있어요.`];
    for (const [i, item] of items.entries()) {
      const date = item.createdAt.slice(0, 10);
      if (!learningItemUsable(item.data)) {
        lines.push(`${i + 1}. ${date} · ${UNUSABLE_LINE}`);
        continue;
      }
      const answer = item.data.idealAnswer !== undefined ? '답변 있음' : '답변 없음';
      lines.push(messageBody(`${i + 1}. ${date} · 요청 `, learningRequestExcerpt(item.data.requestText), ` · ${answer}`));
    }
    lines.push('', '"예시 N 수정: 좋은 답변"으로 답변을 채우거나 고치고, "예시 N 삭제"로 지울 수 있어요.', ...this.disclosureLines());
    return { ...messageFields(joinBody(lines)), status: 'RESPONDED' };
  }

  private async editExample(
    scope: LearningCommandScope, index: number, answer: string, now: IsoTimestamp,
  ): Promise<LearningCommandResult> {
    const resolved = this.bindings.resolve(scope, 'examples', index, Date.parse(now));
    if ('problem' in resolved) {
      return { text: resolved.problem === 'NO_LISTING' ? noListingText('examples') : outOfRangeText('examples', index), status: 'RESPONDED' };
    }
    const refusal = learningTextRefusal(answer);
    if (refusal) return { text: refusalText(refusal), status: 'RESPONDED' };
    const item = await this.deps.learning.get(scope.actorId, resolved.id, now);
    if (!item || item.kind !== LearningItemKind.EXAMPLE) return { text: `예시 ${index}번은 이미 지워졌거나 기간이 지났어요.`, status: 'RESPONDED' };
    // Guard again at use: an item whose stored request no longer passes is never extended, only deletable.
    if (learningTextRefusal(item.data.requestText) !== null) {
      return { text: `예시 ${index}번에 민감한 내용이 감지돼 고칠 수 없어요. "예시 ${index} 삭제"로 지워 주세요.`, status: 'RESPONDED' };
    }
    await this.deps.learning.pruneExpired(now, LEARNING_PRUNE_MAX_ROWS);
    const updated = await this.deps.learning.updateData(scope.actorId, item.id, { ...item.data, idealAnswer: answer }, now);
    if (!updated) return { text: `예시 ${index}번은 이미 지워졌거나 기간이 지났어요.`, status: 'RESPONDED' };
    return { text: `예시 ${index}번의 답변을 바꿨어요.`, status: 'RESPONDED' };
  }

  private async deleteExample(scope: LearningCommandScope, index: number, now: IsoTimestamp): Promise<LearningCommandResult> {
    const resolved = this.bindings.resolve(scope, 'examples', index, Date.parse(now));
    if ('problem' in resolved) {
      return { text: resolved.problem === 'NO_LISTING' ? noListingText('examples') : outOfRangeText('examples', index), status: 'RESPONDED' };
    }
    const deleted = await this.deps.learning.delete(scope.actorId, resolved.id);
    await this.deps.learning.pruneExpired(now, LEARNING_PRUNE_MAX_ROWS);
    return {
      text: deleted ? `예시 ${index}번을 지웠어요.` : `예시 ${index}번은 이미 지워졌거나 기간이 지났어요.`,
      status: 'RESPONDED',
    };
  }

  private async requestTextOf(taskId: Id): Promise<string | undefined> {
    try {
      return (await this.deps.tasks.get(taskId))?.description;
    } catch (err) {
      try {
        this.deps.logger?.warn('learning task lookup failed', { errorName: err instanceof Error ? err.name : typeof err });
      } catch {
        // best-effort
      }
      return undefined;
    }
  }
}

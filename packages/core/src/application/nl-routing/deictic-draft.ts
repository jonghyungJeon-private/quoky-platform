import type { Id, IsoTimestamp } from '../../domain';
import { sha256Canonical } from '../canonical-digest';

/**
 * ADR-0120 amendment A6 R5a (§1.2, §3): `Session.metadata['quoky.deicticDraft']`, at most one deictic write in flight per
 * (Session, Actor):
 *
 *   metadata['quoky.deicticDraft'] = { byActor: { [actorId]: DeicticDraft } }
 *
 * - `preview`: a preview was shown; only the owner's NEXT turn in this session may approve it (5 minutes,
 *   `interpretDeicticDraftReply`), and a platform reply must name one of `previewReplyIds`.
 * - `choose`: several referents; the owner's answer resumes into a preview, never an execution.
 * - `time`: a reminder without a time; the owner's next message supplies it (the deterministic grammar), into a preview.
 *
 * Content-free: ids, labels, hashes, closed values and the owner's own time words (`when.span`, a bounded time
 * expression). The referenced text is re-read from its store and re-hashed at every step. Anything expired, malformed or
 * another actor's counts as absent.
 */

export const DEICTIC_DRAFT_METADATA_KEY = 'quoky.deicticDraft';
/** ADR-0120 D7 / owner decision 3: a preview (and a question) is answerable for 5 minutes. */
export const DEICTIC_DRAFT_TTL_MS = 5 * 60_000;
const MAX_ACTORS = 64;
const MAX_ID_CHARS = 512;
const MAX_CANDIDATES = 10;
const MAX_WHEN_CHARS = 60;

export type DeicticEntryId = 'todo.add' | 'reminder.create';

export type DeicticReferentRef =
  | { readonly kind: 'item.local'; readonly source: 'todo' | 'reminder'; readonly itemId: Id; readonly label?: number }
  | { readonly kind: 'owner.message'; readonly memoryId: Id; readonly hash: string; readonly at: IsoTimestamp };

/** The owner's time words of a reminder, the instant they were read at, and the first fire time they gave. */
export interface DeicticWhen {
  readonly span: string;
  readonly at: IsoTimestamp;
  readonly nextFireAt: IsoTimestamp;
}

interface DraftBase {
  readonly draftId: string;
  readonly entryId: DeicticEntryId;
  readonly at: IsoTimestamp;
  /** The inbound message whose turn wrote the draft: only the next turn after it may answer. */
  readonly requestId: string;
  readonly language: 'ko' | 'en';
}

export type DeicticDraft =
  | (DraftBase & {
      readonly stage: 'preview';
      readonly referent: DeicticReferentRef;
      readonly payloadHash: string;
      readonly when?: DeicticWhen;
      readonly previewReplyIds: readonly string[];
    })
  | (DraftBase & { readonly stage: 'choose'; readonly candidates: readonly DeicticReferentRef[]; readonly whenSpan?: string })
  | (DraftBase & { readonly stage: 'time'; readonly referent: DeicticReferentRef });

/** The payload hash (§1.2): actor, session, entry, the payload AFTER domain normalisation, the `when`, the referent. */
export function deicticPayloadHash(input: {
  readonly actorId: Id;
  readonly sessionId: Id;
  readonly entryId: DeicticEntryId;
  readonly payload: string;
  readonly when?: Pick<DeicticWhen, 'span' | 'at'>;
  readonly referent: DeicticReferentRef;
}): string {
  return sha256Canonical('quoky.deicticDraft.payload.v1', [
    input.actorId,
    input.sessionId,
    input.entryId,
    input.payload,
    input.when === undefined ? null : [input.when.span, input.when.at],
    referentKey(input.referent),
  ]);
}

/** A stable, content-free key of a referent. */
export function referentKey(referent: DeicticReferentRef): string {
  return referent.kind === 'item.local' ? `item:${referent.source}:${referent.itemId}` : `owner:${referent.memoryId}`;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function isoOf(value: unknown): IsoTimestamp | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? (value as IsoTimestamp) : undefined;
}

export function referentOf(raw: unknown): DeicticReferentRef | undefined {
  const record = recordOf(raw);
  if (record.kind === 'item.local') {
    if (record.source !== 'todo' && record.source !== 'reminder') return undefined;
    const itemId = boundedString(record.itemId, MAX_ID_CHARS);
    if (itemId === undefined) return undefined;
    const label = Number.isSafeInteger(record.label) && (record.label as number) >= 1 ? (record.label as number) : undefined;
    return { kind: 'item.local', source: record.source, itemId, ...(label !== undefined ? { label } : {}) };
  }
  if (record.kind === 'owner.message') {
    const memoryId = boundedString(record.memoryId, MAX_ID_CHARS);
    const hash = typeof record.hash === 'string' && /^[0-9a-f]{64}$/u.test(record.hash) ? record.hash : undefined;
    const at = isoOf(record.at);
    if (memoryId === undefined || hash === undefined || at === undefined) return undefined;
    return { kind: 'owner.message', memoryId, hash, at };
  }
  return undefined;
}

/** One stored draft, or `undefined` when malformed. */
export function deicticDraftOf(raw: unknown): DeicticDraft | undefined {
  const record = recordOf(raw);
  const draftId = boundedString(record.draftId, MAX_ID_CHARS);
  const requestId = boundedString(record.requestId, MAX_ID_CHARS);
  const at = isoOf(record.at);
  if (draftId === undefined || requestId === undefined || at === undefined) return undefined;
  if (record.entryId !== 'todo.add' && record.entryId !== 'reminder.create') return undefined;
  const base: DraftBase = { draftId, entryId: record.entryId, at, requestId, language: record.language === 'en' ? 'en' : 'ko' };
  if (record.stage === 'preview') {
    const referent = referentOf(record.referent);
    const payloadHash = typeof record.payloadHash === 'string' && /^[0-9a-f]{64}$/u.test(record.payloadHash) ? record.payloadHash : undefined;
    if (referent === undefined || payloadHash === undefined) return undefined;
    const when = recordOf(record.when);
    const span = boundedString(when.span, MAX_WHEN_CHARS);
    const whenAt = isoOf(when.at);
    const nextFireAt = isoOf(when.nextFireAt);
    const parsedWhen = span !== undefined && whenAt !== undefined && nextFireAt !== undefined ? { span, at: whenAt, nextFireAt } : undefined;
    if (base.entryId === 'reminder.create' && parsedWhen === undefined) return undefined;
    const ids = Array.isArray(record.previewReplyIds)
      ? [...new Set(record.previewReplyIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, 16)
      : [];
    return { ...base, stage: 'preview', referent, payloadHash, ...(parsedWhen !== undefined ? { when: parsedWhen } : {}), previewReplyIds: ids };
  }
  if (record.stage === 'choose') {
    const candidates = Array.isArray(record.candidates) ? record.candidates.map(referentOf).filter((c): c is DeicticReferentRef => c !== undefined).slice(0, MAX_CANDIDATES) : [];
    if (candidates.length < 2) return undefined;
    const whenSpan = boundedString(record.whenSpan, MAX_WHEN_CHARS);
    return { ...base, stage: 'choose', candidates, ...(whenSpan !== undefined ? { whenSpan } : {}) };
  }
  if (record.stage === 'time') {
    const referent = referentOf(record.referent);
    if (referent === undefined || base.entryId !== 'reminder.create') return undefined;
    return { ...base, stage: 'time', referent };
  }
  return undefined;
}

/** This actor's draft in this session (expiry is the caller's: an expired draft still answers "만료됐어요"). */
export function readDeicticDraft(value: unknown, actorId: Id): DeicticDraft | undefined {
  return deicticDraftOf(recordOf(recordOf(value).byActor)[actorId]);
}

/** Whether a draft written at `at` is still answerable at `now`. */
export function isDeicticDraftLive(draft: Pick<DeicticDraft, 'at'>, now: IsoTimestamp): boolean {
  const age = Date.parse(now) - Date.parse(draft.at);
  return Number.isFinite(age) && age >= 0 && age < DEICTIC_DRAFT_TTL_MS;
}

/** Pure: the next value with `actorId`'s draft set to `draft` (`undefined` removes it); other actors' live drafts kept. */
export function withDeicticDraft(current: unknown, actorId: Id, draft: DeicticDraft | undefined, now: IsoTimestamp): unknown {
  const byActor: Record<string, unknown> = {};
  for (const [other, raw] of Object.entries(recordOf(recordOf(current).byActor))) {
    if (other === actorId) continue;
    const kept = deicticDraftOf(raw);
    if (kept !== undefined && isDeicticDraftLive(kept, now)) byActor[other] = kept;
  }
  if (draft !== undefined) byActor[actorId] = draft;
  const keys = Object.keys(byActor);
  while (keys.length > MAX_ACTORS) {
    const victim = keys.shift();
    if (victim !== undefined && victim !== actorId) delete byActor[victim];
  }
  return Object.keys(byActor).length === 0 ? undefined : { byActor };
}

/** Pure: bind the delivered preview ids to `draftId`, only while it is still this actor's draft. */
export function withDeicticPreviewReplies(current: unknown, actorId: Id, draftId: string, replyIds: readonly string[], now: IsoTimestamp): unknown {
  const draft = readDeicticDraft(current, actorId);
  if (draft === undefined || draft.stage !== 'preview' || draft.draftId !== draftId) return current;
  const ids = [...new Set(replyIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, 16);
  if (ids.length === 0) return current;
  return withDeicticDraft(current, actorId, { ...draft, previewReplyIds: ids }, now);
}

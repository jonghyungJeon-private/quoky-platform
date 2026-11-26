import type { LogFields, Logger } from '../../ports/logger.port';

/**
 * ADR-0121 amendment A7, slice A7-S2 "held-receipt": the content-free held receipt (A7.4), its binding to the owner's next
 * turn, the re-execution and digest check, the `yes-and-more` re-run rule and the closed-card carry-over (A7.4c). Pure data
 * and pure functions plus one port for the re-read; nothing here is wired into a live turn that can read, draft or card
 * (those are A7-S3 and A7-S4). With `QUOKY_AGENT_WRITE_PROPOSALS` off the module is never called.
 *
 * The receipt holds ids, a kind, digests and timestamps and NEVER an item title, an item field, an answer text or any
 * model output (ADR-0121 D3, D7: no content cache). It is a plain value; where it is stored (`Session.metadata`, beside
 * `quoky.lastRead`) is the caller's choice, and a restart or the kill switch voids it.
 */

export const HELD_RECEIPT_METADATA_KEY = 'quoky.heldReceipt';
/** A7.4 / A6.5a: the next owner turn within 10 minutes of the held turn (a7-05: the immediately previous answer only). */
export const HELD_RECEIPT_TTL_MS = 10 * 60_000;
/**
 * A7.4b / A7.4c: a carried (closed-card) receipt expires 20 minutes after its original `at`, whatever else happened. The
 * A7.4b two-window check on a frozen receipt's items (the pick within 10 minutes of the listing, at most 20 after the frozen `at`)
 * is `a7-pick.ts` (A7-S4b).
 */
export const HELD_RECEIPT_FROZEN_TTL_MS = 20 * 60_000;
export const HELD_RECEIPT_MAX_ITEMS = 10;
export const HELD_RECEIPT_MAX_ARGS = 12;
const MAX_ID_CHARS = 512;
const MAX_ARG_CHARS = 200;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export const HELD_RECEIPT_KINDS = ['listing', 'answer', 'card'] as const;
export type HeldReceiptKind = (typeof HELD_RECEIPT_KINDS)[number];
export type HeldReceiptEgress = 'LOCAL' | 'REMOTE';
/** Only the turn's own validated TRUSTED / STRUCTURE args (A7.4): scalars, never a value derived from content. */
export type HeldReceiptArgs = Readonly<Record<string, string | number | boolean>>;

export interface HeldReceipt {
  /** The DM conversation (session) the receipt belongs to. */
  readonly conversation: string;
  readonly actorId: string;
  /** The owner turn that delivered the listing or answer (or closed the card, for `kind: 'card'`). */
  readonly turnId: string;
  /** The READ entry that produced the items. */
  readonly entryId: string;
  readonly validatedArgs: HeldReceiptArgs;
  /** At most 10, in delivered order; one digest per id. */
  readonly itemIds: readonly string[];
  readonly itemDigests: readonly string[];
  readonly kind: HeldReceiptKind;
  readonly egress: HeldReceiptEgress;
  /** When the held turn delivered. A carried receipt keeps the ORIGINAL `at` (A7.4b, A7.4c). */
  readonly at: string;
  /** A card receipt built from a carried receipt hands nothing on when it closes (A7.4c: at most one carry-over). */
  readonly carried?: boolean;
}

/** SHA-256 of a UTF-8 string as lower-case hex. Injected: the agent module imports no `node:*` (agent-boundary.test.ts). */
export type HeldReceiptHasher = (text: string) => string;

// ── digests ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The digest of one item's A5.2 fields (what the drafter would receive): SHA-256 over the canonical JSON of the fields
 * (keys sorted, string values NFC). It proves only that the item did not change after the owner's turn (A7.4, P3).
 */
export function digestHeldItemFields(
  fields: Readonly<Record<string, string | number | boolean | null | readonly string[]>>,
  sha256Hex: HeldReceiptHasher,
): string {
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    canonical[key] = typeof value === 'string' ? value.normalize('NFC') : Array.isArray(value) ? (value as readonly string[]).map((entry) => entry.normalize('NFC')) : value;
  }
  return sha256Hex(JSON.stringify(canonical));
}

/**
 * A7-S4b: the digest of one source document as the drafter would receive it: its A5.2 fields title, author, date and body (never the id,
 * the position or the cut flag). The same function writes a receipt's digest and checks it at the re-read, so a receipt can only match
 * what the drafter would be given.
 */
export function digestSourceDocument(document: { readonly title: string; readonly author: string; readonly date: string; readonly body: string }, sha256Hex: HeldReceiptHasher): string {
  return digestHeldItemFields({ title: document.title, author: document.author, date: document.date, body: document.body }, sha256Hex);
}

// ── building ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const HELD_RECEIPT_REFUSALS = ['empty', 'too-many', 'shape', 'duplicate', 'handoff-built', 'host-only', 'source-off', 'destination-listing', 'carried-twice', 'closed-by-stop'] as const;
export type HeldReceiptRefusal = (typeof HELD_RECEIPT_REFUSALS)[number];

export interface HeldReceiptInput {
  readonly conversation: string;
  readonly actorId: string;
  readonly turnId: string;
  readonly entryId: string;
  readonly validatedArgs: HeldReceiptArgs;
  /** The items actually delivered (listing) or that were input to the delivered answer (answer): id and A5.2 digest. */
  readonly items: readonly { readonly id: string; readonly digest: string }[];
  readonly kind: HeldReceiptKind;
  readonly egress: HeldReceiptEgress;
  readonly at: string;
  /** A7.4 "never held": the read used a handoff value or an `OWNER_CONFIRMED` argument (A1, A4). */
  readonly handoffBuilt?: boolean;
  readonly hostOnly?: boolean;
  /** The A7 source of the entry is switched on (A7.3). */
  readonly sourceOn: boolean;
  /** An A7 destination listing never writes or replaces a receipt (A7.4b). */
  readonly destinationListing?: boolean;
}

const STRICT_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Epoch ms of a strict UTC ISO `YYYY-MM-DDTHH:mm:ss[.SSS]Z` value; NaN for any other shape or an impossible date (fail closed). */
function isoMs(value: unknown): number {
  if (typeof value !== 'string' || !STRICT_UTC_ISO.test(value)) return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : Number.NaN;
}

function validArgs(args: HeldReceiptArgs): boolean {
  const keys = Object.keys(args);
  if (keys.length > HELD_RECEIPT_MAX_ARGS) return false;
  return keys.every((key) => {
    const value = args[key];
    return key.length > 0 && key.length <= MAX_ARG_CHARS && (typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean' || (typeof value === 'string' && value.length <= MAX_ARG_CHARS));
  });
}

function nonEmpty(value: unknown, max = MAX_ID_CHARS): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * A7.4: the receipt a delivering turn writes, or the closed reason it writes none (fail closed: more than 10 delivered
 * items is NOT truncated, because a silently cut scope is a different scope; an unshaped input holds nothing).
 */
export function buildHeldReceipt(input: HeldReceiptInput): { readonly receipt: HeldReceipt } | { readonly refused: HeldReceiptRefusal } {
  // A `card` receipt exists only through `carryOverReceipt` (it must carry `carried: true`, A7.4c at most one carry-over).
  if (input.kind === 'card') return { refused: 'shape' };
  return buildReceipt(input);
}

function buildReceipt(input: HeldReceiptInput): { readonly receipt: HeldReceipt } | { readonly refused: HeldReceiptRefusal } {
  if (input.destinationListing === true) return { refused: 'destination-listing' };
  if (input.handoffBuilt === true) return { refused: 'handoff-built' };
  if (!input.sourceOn) return { refused: 'source-off' };
  if (input.hostOnly === true) return { refused: 'host-only' };
  if (input.items.length === 0) return { refused: 'empty' };
  if (input.items.length > HELD_RECEIPT_MAX_ITEMS) return { refused: 'too-many' };
  if (
    !nonEmpty(input.conversation) ||
    !nonEmpty(input.actorId) ||
    !nonEmpty(input.turnId) ||
    !nonEmpty(input.entryId) ||
    !Number.isFinite(isoMs(input.at)) ||
    !HELD_RECEIPT_KINDS.includes(input.kind) ||
    !validArgs(input.validatedArgs) ||
    input.items.some((item) => !nonEmpty(item.id) || !DIGEST_RE.test(item.digest))
  ) {
    return { refused: 'shape' };
  }
  if (new Set(input.items.map((item) => item.id)).size !== input.items.length) return { refused: 'duplicate' };
  return {
    receipt: {
      conversation: input.conversation,
      actorId: input.actorId,
      turnId: input.turnId,
      entryId: input.entryId,
      validatedArgs: { ...input.validatedArgs },
      itemIds: input.items.map((item) => item.id),
      itemDigests: input.items.map((item) => item.digest),
      kind: input.kind,
      egress: input.egress,
      at: input.at,
    },
  };
}

const RECEIPT_KEYS: ReadonlySet<string> = new Set(['conversation', 'actorId', 'turnId', 'entryId', 'validatedArgs', 'itemIds', 'itemDigests', 'kind', 'egress', 'at', 'carried']);

/** Strict parse of a stored value; anything malformed or with an unknown key counts as absent (and carries no text either way). */
export function parseHeldReceipt(raw: unknown): HeldReceipt | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RECEIPT_KEYS.has(key))) return undefined;
  const { itemIds, itemDigests, validatedArgs } = record;
  if (!Array.isArray(itemIds) || !Array.isArray(itemDigests) || typeof validatedArgs !== 'object' || validatedArgs === null || Array.isArray(validatedArgs)) return undefined;
  const items = itemIds.map((id, index) => ({ id: id as string, digest: itemDigests[index] as string }));
  if (itemIds.length !== itemDigests.length) return undefined;
  if (typeof record.kind !== 'string' || !(HELD_RECEIPT_KINDS as readonly string[]).includes(record.kind)) return undefined;
  if (record.egress !== 'LOCAL' && record.egress !== 'REMOTE') return undefined;
  if (typeof record.at !== 'string') return undefined;
  if (record.carried !== undefined && typeof record.carried !== 'boolean') return undefined;
  // A card receipt is always a carry-over and nothing else is: `carried === true` iff `kind === 'card'`.
  if ((record.kind === 'card') !== (record.carried === true)) return undefined;
  const built = buildReceipt({
    conversation: record.conversation as string,
    actorId: record.actorId as string,
    turnId: record.turnId as string,
    entryId: record.entryId as string,
    validatedArgs: validatedArgs as HeldReceiptArgs,
    items,
    kind: record.kind as HeldReceiptKind,
    egress: record.egress,
    at: record.at,
    sourceOn: true,
  });
  if ('refused' in built) return undefined;
  return { ...built.receipt, ...(record.carried === true ? { carried: true } : {}) };
}

// ── binding (A7.4 "when it binds"; all structural) ────────────────────────────────────────────────────────────────

export const HELD_RECEIPT_UNBOUND_REASONS = [
  'absent',
  'other-actor',
  'other-conversation',
  'expired',
  'not-next-turn',
  'handoff-built',
  'source-off',
  'host-only',
  'empty',
  'kill-switch',
] as const;
export type HeldReceiptUnboundReason = (typeof HELD_RECEIPT_UNBOUND_REASONS)[number];

export interface HeldReceiptBindContext {
  readonly actorId: string;
  readonly conversation: string;
  readonly now: string;
  /** The id of the owner turn immediately before this one in this conversation (a7-05: previous answer only). */
  readonly previousTurnId?: string;
  /** The held entry's A7 source is switched on. */
  readonly sourceOn: boolean;
  readonly hostOnly?: boolean;
  /** The kill switch (`에이전트 중지`) is set: it voids every receipt. */
  readonly killSwitch?: boolean;
  /** The A6 re-run facts of this message (A7.4c item 1); {@link isYesAndMoreRerun} decides, the caller cannot assert it. */
  readonly rerun?: { readonly messageId: string; readonly marker: boolean };
}

/**
 * Whether the receipt binds to this owner turn. It never inspects the owner's words (the structural checks that read them,
 * the source-name check and the plan form, are A7-S1's). A card receipt expires 20 minutes after its original `at`; every
 * other kind 10 minutes after its `at`; a receipt dated in the future is expired (fail closed).
 */
export function bindHeldReceipt(receipt: HeldReceipt | undefined, context: HeldReceiptBindContext): { readonly bound: true } | { readonly bound: false; readonly reason: HeldReceiptUnboundReason } {
  if (context.killSwitch === true) return { bound: false, reason: 'kill-switch' };
  if (receipt === undefined) return { bound: false, reason: 'absent' };
  if (receipt.actorId !== context.actorId) return { bound: false, reason: 'other-actor' };
  if (receipt.conversation !== context.conversation) return { bound: false, reason: 'other-conversation' };
  const age = isoMs(context.now) - isoMs(receipt.at);
  const ttl = receipt.kind === 'card' || receipt.carried === true ? HELD_RECEIPT_FROZEN_TTL_MS : HELD_RECEIPT_TTL_MS;
  if (!Number.isFinite(age) || age < 0 || age >= ttl) return { bound: false, reason: 'expired' };
  // The yes-part of a `yes-and-more` message wrote this receipt in the same message: it counts as the next owner turn for
  // that receipt only. Every other case needs the receipt's turn to be the one right before this one.
  const next = isYesAndMoreRerun(receipt, context.rerun) || (context.previousTurnId !== undefined && context.previousTurnId === receipt.turnId);
  if (!next) return { bound: false, reason: 'not-next-turn' };
  if (!context.sourceOn) return { bound: false, reason: 'source-off' };
  if (context.hostOnly === true) return { bound: false, reason: 'host-only' };
  if (receipt.itemIds.length === 0) return { bound: false, reason: 'empty' };
  return { bound: true };
}

// ── yes-and-more (A7.4c item 1) ───────────────────────────────────────────────────────────────────────────────────

/**
 * "응 그리고 BE-123에 달아줘": the yes binds the pending items and the summary is delivered, which writes an `answer`
 * receipt; the whole message then runs again as a new ordinary turn. That re-run counts as the next owner turn for the
 * receipt its own yes-part wrote, and for no other receipt. Structural: the same message id and the A6 re-run marker.
 */
export function isYesAndMoreRerun(receipt: HeldReceipt | undefined, rerun: { readonly messageId: string; readonly marker: boolean } | undefined): boolean {
  return receipt !== undefined && rerun !== undefined && rerun.marker && receipt.kind === 'answer' && receipt.turnId === rerun.messageId;
}

// ── re-execution and digest check (A7.4 "what it binds to") ───────────────────────────────────────────────────────

/** The port that re-runs the held read once: the held entry and the held args, never a new query. */
export interface HeldReceiptReader {
  /** The current items of the read as id and A5.2 digest, or `undefined` when the read failed or was refused. */
  reread(entryId: string, validatedArgs: HeldReceiptArgs): Promise<readonly { readonly id: string; readonly digest: string }[] | undefined>;
}

export interface HeldReceiptVerification {
  /** The ids that are still there with an equal digest, in RECEIPT order. Nothing is ever added. */
  readonly keptIds: readonly string[];
  /** Missing or changed items, dropped (a7-06: "1건은 그 사이 바뀌어 뺐어요"). */
  readonly dropped: number;
  readonly outcome: 'all' | 'some' | 'none' | 'unverified';
}

/** Pure comparison. A duplicate id in the re-read, or a differing digest, is a change (fail closed). */
export function verifyHeldItems(receipt: HeldReceipt, current: readonly { readonly id: string; readonly digest: string }[]): HeldReceiptVerification {
  const seen = new Map<string, string | null>();
  for (const item of current) seen.set(item.id, seen.has(item.id) ? null : item.digest);
  const keptIds: string[] = [];
  receipt.itemIds.forEach((id, index) => {
    const digest = seen.get(id);
    if (digest !== undefined && digest !== null && digest === receipt.itemDigests[index]) keptIds.push(id);
  });
  const dropped = receipt.itemIds.length - keptIds.length;
  return { keptIds, dropped, outcome: dropped === 0 ? 'all' : keptIds.length === 0 ? 'none' : 'some' };
}

/**
 * Re-executes the held read exactly once and compares. A failed read keeps nothing (`unverified`): an item that cannot be
 * checked is not drafted from.
 */
export async function reexecuteHeldReceipt(receipt: HeldReceipt, reader: HeldReceiptReader): Promise<HeldReceiptVerification> {
  let current: readonly { readonly id: string; readonly digest: string }[] | undefined;
  try {
    current = await reader.reread(receipt.entryId, receipt.validatedArgs);
  } catch {
    current = undefined;
  }
  if (current === undefined) return { keptIds: [], dropped: receipt.itemIds.length, outcome: 'unverified' };
  return verifyHeldItems(receipt, current);
}

// ── closed-card carry-over (A7.4c item 4) ─────────────────────────────────────────────────────────────────────────

export const HELD_CARD_CLOSURES = ['sent', 'declined', 'expired', 'owner-void', 'kill-switch', 'trip'] as const;
export type HeldCardClosure = (typeof HELD_CARD_CLOSURES)[number];

/**
 * After an A7 card closes (sent, declined, expired or voided by the owner) its frozen items become the held receipt for the
 * next owner turn (`kind: 'card'`). Limits: a card closed by the kill switch or the automatic trip hands nothing on; the
 * receipt keeps the original `at` and expires 20 minutes after it, whatever the closure time; at most one carry-over (a card
 * built from a carried receipt hands nothing on).
 */
export function carryOverReceipt(
  frozen: HeldReceipt,
  closure: { readonly by: HeldCardClosure; readonly turnId: string; readonly cardBuiltFromCarried: boolean },
): { readonly receipt: HeldReceipt } | { readonly refused: HeldReceiptRefusal } {
  if (closure.by === 'kill-switch' || closure.by === 'trip') return { refused: 'closed-by-stop' };
  if (closure.cardBuiltFromCarried || frozen.carried === true || frozen.kind === 'card') return { refused: 'carried-twice' };
  return { receipt: { ...frozen, kind: 'card', turnId: closure.turnId, carried: true } };
}

// ── shadow logging (A7.10: shadow logs only; closed codes, no content) ────────────────────────────────────────────

export const A7_HELD_RECEIPT_SHADOW_LOG_EVENT = 'a7_held_receipt.shadow';

/** The finite closed set of Core listing sources (`ListingSource` in `last-listing.ts`; a test pins the two together). */
export const HELD_RECEIPT_SHADOW_SOURCES = ['mail', 'drive', 'todo', 'reminder', 'jira', 'slack'] as const;

export interface HeldReceiptShadowEvent {
  readonly kind: HeldReceiptKind;
  /** A Core listing source; anything outside {@link HELD_RECEIPT_SHADOW_SOURCES} is logged as `other`. */
  readonly source: string;
  readonly items: number;
}

/**
 * The closed outcome from the delivered item COUNT only (shadow holds no digests): `count-ok` means the count is within 1..10
 * and says nothing about DM-only, handoff, source-on or HOST_ONLY, which the count cannot see.
 */
export function heldReceiptShadowOutcome(items: number): 'count-ok' | HeldReceiptRefusal {
  if (!Number.isSafeInteger(items) || items < 0) return 'shape';
  if (items === 0) return 'empty';
  return items > HELD_RECEIPT_MAX_ITEMS ? 'too-many' : 'count-ok';
}

/**
 * One content-free line: mode, kind, source, the item COUNT and the closed outcome. Never an id, a digest, a title or an
 * argument. Best-effort: a failing logger never changes a turn.
 */
export function logHeldReceiptShadow(logger: Logger, event: HeldReceiptShadowEvent): void {
  const fields: LogFields = { mode: 'shadow', kind: event.kind, source: (HELD_RECEIPT_SHADOW_SOURCES as readonly string[]).includes(event.source) ? event.source : 'other', items: event.items, outcome: heldReceiptShadowOutcome(event.items) };
  try {
    logger.info(A7_HELD_RECEIPT_SHADOW_LOG_EVENT, fields);
  } catch {
    // best-effort
  }
}

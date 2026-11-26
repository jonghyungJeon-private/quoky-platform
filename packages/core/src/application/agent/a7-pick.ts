import { containsCredentialMaterial } from '../credential-guard';
import { isCardSpoofLine } from '../card-spoof';
import { neutralizeLinks } from '../link-neutralizer';
import { NL_REF_JIRA_KEY } from '../nl-routing/action-entries';
import { HELD_RECEIPT_FROZEN_TTL_MS, HELD_RECEIPT_TTL_MS, parseHeldReceipt, type HeldReceipt, type HeldReceiptArgs } from './held-receipt';

/**
 * ADR-0121 amendment A7, slice A7-S4b "pick": the destination listing and the pick (A7.4b), as pure data and pure functions. Nothing here
 * reads, drafts, cards or stores anything: `AgentRunService` calls it (dormant: no live path reaches it, agent mode `active` and
 * `QUOKY_AGENT_WRITE_PROPOSALS=active` are still refused at startup), and the state it describes lives in `Session.metadata`
 * (`held-receipt-store.ts`).
 *
 * The rules, as ratified (A7.4b):
 * - the rows are at most {@link A7_PICK_MAX_ROWS}, in an order no content can change (Jira issue keys numerically descending, the project
 *   allowlist in its own order), never pre-selected, never recommended; a title is untrusted readout, inert (links neutralised, markup and
 *   control characters removed, a card-spoof or credential-shaped title not shown at all) and never a selector;
 * - the pick is a bare number of the shown list (never a retyped key, never a title), the very next owner turn in the same DM within 10
 *   minutes of the listing; any other turn cancels (single use);
 * - the picked value is an {@link PickedA7Destination}: the trust value `OWNER_PICKED_DESTINATION`, which is not `OWNER_CONFIRMED`. It can be
 *   made only by {@link resolveA7Pick} from a row of this very listing (a registry check refuses a forged value), it is the destination of the
 *   one propose step it was picked for, and it is never a planner input, a READ argument or a stored value beyond that card's anchor;
 * - a frozen receipt (form b) is rechecked at the pick: the pick within 10 minutes of the listing AND at most 20 minutes after the frozen `at`.
 */

export const A7_PICK_MAX_ROWS = 5;
/** A7.4b: the pick is the next owner turn within 10 minutes of the listing. */
export const A7_PICK_WINDOW_MS = HELD_RECEIPT_TTL_MS;
/** A7.4b: and at most 20 minutes after the frozen receipt's original `at`. */
export const A7_PICK_FROZEN_WINDOW_MS = HELD_RECEIPT_FROZEN_TTL_MS;
/** The fixed header of every destination listing (A7.4b). */
export const A7_PICK_HEADER = { ko: '올릴 곳을 번호로 골라 주세요', en: 'Pick where to post by number' } as const;
const A7_PICK_FOOTER = {
  ko: '번호만 보내 주세요. 다른 말씀을 하시면 고르기를 취소해요.',
  en: 'Send only the number. Anything else cancels the pick.',
} as const;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
export const A7_PICK_TITLE_MAX_CHARS = 60;

// ── the pending pick (what `Session.metadata` holds) ──────────────────────────────────────────────────────────────

/**
 * The pending destination pick of one owner: the structure of the turn that asked, never a title, a text or a payload. Form a keeps the
 * validated source read as its entry and scalar args (re-read after the pick); form b keeps the FROZEN receipt (A7.4b), so the destination
 * listing replaces no receipt.
 */
export interface PendingA7Pick {
  readonly conversation: string;
  readonly actorId: string;
  /** The owner turn that asked for the pick; the pick must be the very next one. */
  readonly askedTurnId: string;
  /** When the listing was shown (the 10-minute window). */
  readonly askedAt: string;
  /** `project`: the options are allowlisted project keys (a7-09: the board first); `ticket`: the options are issue keys of `project`. */
  readonly stage: 'project' | 'ticket';
  readonly project?: string;
  /** 1..5 closed-format values, in the order shown. */
  readonly options: readonly string[];
  readonly form: 'a' | 'b';
  readonly target: 'jira.comment.propose';
  readonly connectorCalls: number;
  /** Form a: the validated source read. */
  readonly source?: { readonly entryId: string; readonly args: HeldReceiptArgs };
  /** Form b: the receipt bound at the turn that asked, frozen with its original `at`. */
  readonly frozen?: HeldReceipt;
  /**
   * The owner's own words of the turn that asked, as prepared (TRUSTED owner text, bounded): the summary request that grants the source read
   * is the asking turn's, never the pick reply's ("2" asks for nothing). Dropped with the pick.
   */
  readonly ownerText: A7FrozenOwnerText;
}

/** The owner's own words of one turn as prepared, frozen for the later step that needs the summary request they made (bounded). */
export interface A7FrozenOwnerText {
  readonly text: string;
  readonly groundingText: string;
  readonly rawText: string;
}

export const A7_PICK_OWNER_TEXT_MAX_CHARS = 4000;

/** Strict parse of a frozen owner text; `undefined` for anything malformed, with an unknown key or over the bound. */
export function parseA7FrozenOwnerText(raw: unknown): A7FrozenOwnerText | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const owner = raw as Record<string, unknown>;
  if (Object.keys(owner).some((key) => key !== 'text' && key !== 'groundingText' && key !== 'rawText')) return undefined;
  const { text, groundingText, rawText } = owner;
  if ([text, groundingText, rawText].some((value) => typeof value !== 'string' || value.length > A7_PICK_OWNER_TEXT_MAX_CHARS)) return undefined;
  return { text: text as string, groundingText: groundingText as string, rawText: rawText as string };
}

const PENDING_KEYS: ReadonlySet<string> = new Set(['conversation', 'actorId', 'askedTurnId', 'askedAt', 'stage', 'project', 'options', 'form', 'target', 'connectorCalls', 'source', 'frozen', 'ownerText']);

const nonEmptyText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isoOk = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function scalarArgs(raw: unknown): HeldReceiptArgs | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 12) return undefined;
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 200) return undefined;
    if (typeof value === 'string' ? value.length > 200 : typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'boolean') return undefined;
    out[key] = value as string | number | boolean;
  }
  return out;
}

/** The project key of a closed-format Jira issue key. */
export function jiraProjectOf(issueKey: string): string | undefined {
  return NL_REF_JIRA_KEY.test(issueKey) ? issueKey.slice(0, issueKey.lastIndexOf('-')) : undefined;
}

/** Strict parse of a stored pending pick: anything malformed, with an unknown key or breaking an invariant counts as absent. */
export function parsePendingA7Pick(raw: unknown): PendingA7Pick | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PENDING_KEYS.has(key))) return undefined;
  if (!nonEmptyText(record.conversation) || !nonEmptyText(record.actorId) || !nonEmptyText(record.askedTurnId) || !isoOk(record.askedAt)) return undefined;
  if (record.stage !== 'project' && record.stage !== 'ticket') return undefined;
  if (record.form !== 'a' && record.form !== 'b') return undefined;
  if (record.target !== 'jira.comment.propose') return undefined;
  if (typeof record.connectorCalls !== 'number' || !Number.isSafeInteger(record.connectorCalls) || record.connectorCalls < 0 || record.connectorCalls > 50) return undefined;
  const options = record.options;
  if (!Array.isArray(options) || options.length < 1 || options.length > A7_PICK_MAX_ROWS || new Set(options).size !== options.length) return undefined;
  const project = record.project;
  if (record.stage === 'project') {
    if (project !== undefined || !options.every((option) => typeof option === 'string' && PROJECT_KEY.test(option))) return undefined;
  } else if (typeof project !== 'string' || !PROJECT_KEY.test(project) || !options.every((option) => typeof option === 'string' && jiraProjectOf(option) === project)) return undefined;
  const ownerText = parseA7FrozenOwnerText(record.ownerText);
  if (ownerText === undefined) return undefined;
  let source: PendingA7Pick['source'];
  let frozen: HeldReceipt | undefined;
  if (record.form === 'a') {
    const s = record.source as Record<string, unknown> | undefined;
    if (record.frozen !== undefined || typeof s !== 'object' || s === null || Object.keys(s).some((key) => key !== 'entryId' && key !== 'args') || !nonEmptyText(s.entryId)) return undefined;
    const args = scalarArgs(s.args);
    if (args === undefined) return undefined;
    source = { entryId: s.entryId, args };
  } else {
    if (record.source !== undefined || record.connectorCalls !== 0) return undefined;
    frozen = parseHeldReceipt(record.frozen);
    if (frozen === undefined || frozen.actorId !== record.actorId || frozen.conversation !== record.conversation) return undefined;
  }
  return {
    conversation: record.conversation,
    actorId: record.actorId,
    askedTurnId: record.askedTurnId,
    askedAt: record.askedAt,
    stage: record.stage,
    ...(typeof project === 'string' ? { project } : {}),
    options: [...(options as string[])],
    form: record.form,
    target: 'jira.comment.propose',
    connectorCalls: record.connectorCalls,
    ...(source !== undefined ? { source } : {}),
    ...(frozen !== undefined ? { frozen } : {}),
    ownerText,
  };
}

// ── the rows ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface A7PickRow {
  readonly id: string;
  /** Untrusted readout, already inert (see {@link inertPickTitle}); absent when it may not be shown. */
  readonly title?: string;
}

/**
 * A7.4b (review round 2): Jira rows by issue key, numerically descending (the update time is never used: anyone who edits an issue moves it).
 * The tie-break is the project key, so the order is total.
 */
export function compareJiraKeysDescending(a: string, b: string): number {
  const na = Number(a.slice(a.lastIndexOf('-') + 1));
  const nb = Number(b.slice(b.lastIndexOf('-') + 1));
  if (na !== nb) return nb - na;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A title as the owner may read it in a listing: one inert line, or `undefined` (a spoof of Quoky's own approval phrases, or credential-shaped). */
export function inertPickTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const line = neutralizeLinks(raw.normalize('NFC'))
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/[`*_~|<>[\]#@]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (line.length === 0 || isCardSpoofLine(line) || containsCredentialMaterial(line)) return undefined;
  const chars = Array.from(line);
  return chars.length > A7_PICK_TITLE_MAX_CHARS ? `${chars.slice(0, A7_PICK_TITLE_MAX_CHARS).join('')}…` : line;
}

/**
 * The ticket rows of one project from an owner-scoped read: closed-format keys of THAT project only (an allowlisted one), distinct, in the
 * fixed key order, at most 5. The source items of the card never contribute a row (they are a different read).
 */
export function buildJiraTicketRows(items: readonly { readonly id: string; readonly title?: unknown }[], project: string, allowlist: readonly string[]): readonly A7PickRow[] {
  if (!allowlist.map((key) => key.toUpperCase()).includes(project)) return [];
  const seen = new Set<string>();
  const rows: A7PickRow[] = [];
  for (const item of items) {
    if (typeof item.id !== 'string' || jiraProjectOf(item.id) !== project || seen.has(item.id)) continue;
    seen.add(item.id);
    const title = inertPickTitle(item.title);
    rows.push({ id: item.id, ...(title !== undefined ? { title } : {}) });
  }
  return rows.sort((a, b) => compareJiraKeysDescending(a.id, b.id)).slice(0, A7_PICK_MAX_ROWS);
}

/** The project rows (a7-09: the board first): the allowlist in its own order, at most 5. */
export function buildProjectRows(allowlist: readonly string[]): readonly A7PickRow[] {
  const seen = new Set<string>();
  const rows: A7PickRow[] = [];
  for (const raw of allowlist) {
    const key = raw.toUpperCase();
    if (!PROJECT_KEY.test(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: key });
  }
  return rows.slice(0, A7_PICK_MAX_ROWS);
}

/** The listing text: the fixed header, the numbered rows (key, then the inert title when it may be shown), the fixed footer. Never a recommendation. */
export function renderA7PickListing(language: 'ko' | 'en', rows: readonly A7PickRow[]): string {
  const lines = rows.map((row, index) => `${index + 1}. ${row.id}${row.title !== undefined ? ` · ${row.title}` : ''}`);
  return [A7_PICK_HEADER[language], ...lines, A7_PICK_FOOTER[language]].join('\n');
}

/** The fixed line when the owner-scoped read finds nothing to pick (the owner may name the destination: "BE-123에"). */
export const A7_PICK_NO_ROWS = {
  ko: "고를 수 있는 곳이 없어요. 올릴 곳을 'BE-123에'처럼 다시 말씀해 주세요. 아무것도 보내지 않았어요.",
  en: "There is nothing to pick. Tell me where to post it, like 'BE-123'. Nothing was sent.",
} as const;
/** The fixed line when a pick is cancelled by a number that is not on the list. */
export const A7_PICK_OUT_OF_RANGE = {
  ko: '그 번호는 목록에 없어서 고르기를 취소했어요. 아무것도 보내지 않았어요.',
  en: 'That number is not on the list, so I cancelled the pick. Nothing was sent.',
} as const;
/** The fixed line when the pick came too late or its content changed under it. */
export const A7_PICK_EXPIRED = {
  ko: '고르기가 만료돼서 취소했어요. 다시 말씀해 주세요. 아무것도 보내지 않았어요.',
  en: 'The pick expired, so I cancelled it. Please ask again. Nothing was sent.',
} as const;

// ── the pick itself ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The pick is a bare number of the shown list ("2", "2번", "2."). Nothing else: a key, a title or a sentence is not a pick. Structural: digits
 * with the closed ordinal counter and one closing mark, never a word list.
 */
export function parsePickNumber(text: string): number | undefined {
  const match = /^(\d{1,2})\s*(?:번)?\s*[.!]?$/u.exec(text.normalize('NFKC').trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  return value >= 1 ? value : undefined;
}

declare const PICKED_DESTINATION: unique symbol;

/**
 * The trust value `OWNER_PICKED_DESTINATION` (A7.4b): the destination of ONE A7 propose step, picked by number from a listing of this module.
 * Not `OWNER_CONFIRMED`. Made only by {@link resolveA7Pick}; {@link isPickedA7Destination} refuses any value this module did not issue.
 */
export interface PickedA7Destination {
  readonly [PICKED_DESTINATION]: true;
  readonly trust: 'OWNER_PICKED_DESTINATION';
  readonly kind: 'jira';
  readonly issueKey: string;
  readonly project: string;
}

const ISSUED = new WeakSet<object>();

/** Whether `value` is a destination this module issued from a pick (a cast or a copy is not). */
export function isPickedA7Destination(value: unknown): value is PickedA7Destination {
  return typeof value === 'object' && value !== null && ISSUED.has(value);
}

function issue(issueKey: string, project: string): PickedA7Destination {
  const picked = Object.freeze({ trust: 'OWNER_PICKED_DESTINATION', kind: 'jira', issueKey, project }) as unknown as PickedA7Destination;
  ISSUED.add(picked);
  return picked;
}

export type A7PickCancelReason =
  | 'other-actor'
  | 'other-conversation'
  | 'not-next-turn'
  | 'expired'
  | 'frozen-expired'
  | 'not-a-number'
  | 'out-of-range'
  | 'not-allowlisted'
  | 'kill-switch'
  | 'shape';

export type A7PickResolution =
  /** The owner picked a project (a7-09, the board first): the ticket listing follows. Not a destination. */
  | { readonly kind: 'project'; readonly project: string }
  /** The owner picked the destination. */
  | { readonly kind: 'destination'; readonly picked: PickedA7Destination }
  /** Single use: the pick is discarded (and the frozen receipt with it). */
  | { readonly kind: 'cancel'; readonly reason: A7PickCancelReason };

export interface A7PickContext {
  readonly actorId: string;
  readonly conversation: string;
  readonly now: string;
  /** The owner turn right before this one in this conversation. */
  readonly previousTurnId?: string;
  /** `QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS`: checked again at the pick (A7.4b: "the allowlist is checked again at the card and at execution"). */
  readonly jiraProjects: readonly string[];
  readonly killSwitch?: boolean;
}

/**
 * A7.4b: what the owner's reply to a pending pick means. Pure. Every check fails closed into a `cancel`: the wrong owner or conversation, a
 * reply that is not the next owner turn, a listing older than 10 minutes, a frozen receipt more than 20 minutes after its `at`, an answer that
 * is not a number of the list, a project that left the allowlist, the kill switch.
 */
export function resolveA7Pick(pending: PendingA7Pick, text: string, context: A7PickContext): A7PickResolution {
  const cancel = (reason: A7PickCancelReason): A7PickResolution => ({ kind: 'cancel', reason });
  if (context.killSwitch === true) return cancel('kill-switch');
  if (pending.actorId !== context.actorId) return cancel('other-actor');
  if (pending.conversation !== context.conversation) return cancel('other-conversation');
  if (context.previousTurnId === undefined || context.previousTurnId !== pending.askedTurnId) return cancel('not-next-turn');
  const age = Date.parse(context.now) - Date.parse(pending.askedAt);
  if (!Number.isFinite(age) || age < 0 || age >= A7_PICK_WINDOW_MS) return cancel('expired');
  if (pending.frozen !== undefined) {
    const frozenAge = Date.parse(context.now) - Date.parse(pending.frozen.at);
    if (!Number.isFinite(frozenAge) || frozenAge < 0 || frozenAge >= A7_PICK_FROZEN_WINDOW_MS) return cancel('frozen-expired');
  }
  const number = parsePickNumber(text);
  if (number === undefined) return cancel('not-a-number');
  const chosen = pending.options[number - 1];
  if (chosen === undefined) return cancel('out-of-range');
  const allowlist = context.jiraProjects.map((key) => key.toUpperCase());
  if (pending.stage === 'project') return allowlist.includes(chosen) ? { kind: 'project', project: chosen } : cancel('not-allowlisted');
  const project = pending.project;
  if (project === undefined || !allowlist.includes(project) || jiraProjectOf(chosen) !== project) return cancel('not-allowlisted');
  return { kind: 'destination', picked: issue(chosen, project) };
}

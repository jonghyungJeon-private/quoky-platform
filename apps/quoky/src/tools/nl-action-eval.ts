/**
 * ADR-0120 amendment A6 evaluation (A6-D7, NLA-6 tooling): the action corpus (`golden/nl-action.v1.json`, schema in
 * `docs/plans/nl-action-corpus-schema.md`) and the read-regression mode (`golden/nl-intent.v1.json` with the A6 entries
 * offered). Exact `{entry, args, target}` scoring after Core's OWN decision path — the real `NlSelectionService` over a
 * session built from each case's content-free fixture, so validation, reference resolution, caps and the content-mode key
 * are exactly the runtime's. No LLM judge. Pure except for the injected provider; only a Strict run spawns anything.
 *
 * Per action case:
 *  - `hit`: Core executes the gold entry with the gold canonical args and the gold target (or, for a gold ask/refuse, Core
 *    does not execute, the selector named the gold entry and Core's own final args for it (validated and grounded, as an
 *    execution carries; owner decision 2026-10-19) are the gold args, or, when the gold args are `{}`, Core's refusal or
 *    question reason equals the gold reason; or, for an execute gold marked `acceptsNone` by the owner, the selector
 *    answered `none`; owner D12 batch 2026-10-15: a READ gold is scored on the entry only, an `acceptsAnyQuestion` gold
 *    on any question, and `alsoAccepts` names other selections with the same effect on the same target);
 *  - `wrong-target`: Core would execute an item other than the gold one (gate 0);
 *  - `negative-capture`: a negative executed or previewed an action (gate 0; a question counts as neither);
 *  - `question`: Core asked on a positive (the question rate on positive reference cases, at most 10%);
 *  - `miss`, `none`, `timeout`, `error`, `skipped` as in the intent evaluation.
 * Per read-regression case: the D12 outcomes plus `action-capture` (a read case captured by an action or ITEM_READ entry;
 * gate 0). A case carrying an owner-approved `a6Relabel` is scored against the relabel and reported apart. Its `context`
 * (the listing the owner saw, content-free) becomes the prompt's "Reference context" line, as the runtime renders it.
 * The read-mode D12 evaluation (`--mode run`, A6 off) offers no A6 entry, so it scores the same case against `expect`
 * (`none`): with actions off, chat is the defined answer and a list read is a wrong capture.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Capability,
  ITEM_CONTENT_MODE,
  INTERPRETATION_PREFERENCES_METADATA_KEY,
  LAST_ACTION_METADATA_KEY,
  LAST_LISTING_METADATA_KEY,
  NL_ACTION_ENTRIES,
  NL_ACTION_ENTRY_IDS,
  NL_ACTION_PROMPT_VERSION,
  NL_ACTION_R2_PROMPT_VERSION,
  NL_CATALOG_ENTRY_IDS,
  NL_PENDING_METADATA_KEY,
  NL_SELECTION_TIMEOUT_MS,
  NL_WAVE1_ENTRIES,
  NlActionSwitch,
  NlSelectionService,
  buildSelectionPrompt,
  detectWorkChatCommand,
  executionLocalityOf,
  parseDriveQuestion,
  parseMailQuestion,
  parseReminderMessage,
  isNlActionEntryId,
  isNlCatalogEntryId,
  mergeItemSummarizeEntries,
  nlItemSummarizeEntry,
  isNlWave1EntryId,
  parseSelectionOutput,
  pendingQuestionRecord,
  prepareSelectionInput,
  nlCoreSelectionArgs,
  readListingRecord,
  renderReferenceContext,
  validateSelection,
  withLabelledListing,
  withLastAction,
  withListingReplies,
  type Actor,
  type AiProvider,
  type IsoTimestamp,
  type NlArgs,
  type NlCatalogEntry,
  type NlReferenceState,
  type NlSelectionDecision,
  type Session,
} from '@quoky/core';
// The `@quoky/core` export, never a relative path into the core sources (the built CLI cannot load a .ts file).
import { LAST_READ_METADATA_KEY, NL_ITEM_SUMMARIZE_SOURCES, formatNlRef, parseNlRef, withLastRead } from '@quoky/core';

export const NL_ACTION_EVAL_GATE = Object.freeze({
  overall: 0.95,
  perEntry: 0.9,
  spanExact: 0.95,
  wrongTarget: 0,
  negativeCaptures: 0,
  questionRateOnReferences: 0.1,
  overBoundRate: 0.01,
});

/**
 * The A6 R2 model gate (proposal §6.4; Strict, 3 runs, no LLM judge): exact `{entry, args, target}` >= 95% overall and
 * >= 90% for each of the jira and slack slices, 0 wrong-target reads, 0 negatives captured, questions on positive
 * reference cases <= 10%, calls over the bound <= 1%.
 */
export const NL_ACTION_R2_EVAL_GATE = Object.freeze({
  overall: 0.95,
  perSource: 0.9,
  wrongTarget: 0,
  negativeCaptures: 0,
  questionRateOnReferences: 0.1,
  overBoundRate: 0.01,
});

const GOLDEN_DIR = resolve(__dirname, '../../../../packages/core/src/application/golden');
export const NL_ACTION_CORPUS_PATH = resolve(GOLDEN_DIR, 'nl-action.v1.json');
export const NL_ACTION_SEED_PATH = resolve(GOLDEN_DIR, 'nl-action.seed.v1.json');
export const NL_ACTION_R2_CORPUS_PATH = resolve(GOLDEN_DIR, 'nl-action.r2.v1.json');
export const NL_INTENT_CORPUS_PATH = resolve(GOLDEN_DIR, 'nl-intent.v1.json');

const FAMILIES = ['live', 'paraphrase', 'reference', 'negative', 'undo', 'mode'] as const;
const OUTCOMES = ['execute', 'ask', 'refuse'] as const;
const REASONS = [
  'out-of-range', 'expired', 'ambiguous', 'stale', 'other-source', 'none', 'conflict',
  'deictic-payload', 'time-in-title', 'time-outside-when', 'when-unparsed', 'credential',
  'content-mode', 'missing-arg',
  'no-action', 'undo-of-undo', 'already-final', 'changed', 'fired', 'past-time', 'event-gone', 'limit', 'echo-mismatch',
  'bulk', 'not-dm', 'capped', 'stopped', 'undo-confirm',
] as const;
/**
 * The reasons of a clarification question (which item, which list, which mode, restate the item): `acceptsAnyQuestion`
 * counts only these, never a refusal (input guard, cap, kill switch, payload or time rule; CA review).
 */
const CLARIFICATION_REASONS: ReadonlySet<string> = new Set(['garbled-action', 'garbled-noun', 'uncertain-title', 'out-of-range', 'expired', 'ambiguous', 'stale', 'other-source', 'none', 'conflict', 'content-mode', 'missing-arg', 'invalid-arg', 'ungrounded', 'no-action-word']);
const SOURCES = ['todo', 'reminder', 'mail', 'drive', 'jira', 'slack'] as const;
type Source = (typeof SOURCES)[number];

export interface NlActionFixture {
  readonly listings?: ReadonlyArray<{ readonly source: Source; readonly labels: readonly number[]; readonly ageMinutes: number; readonly ids?: readonly string[] }>;
  readonly lastWritten?: Source;
  readonly lastAction?: {
    readonly entryId: string;
    readonly source: 'todo' | 'reminder';
    readonly itemId: string;
    readonly label?: number;
    readonly ageMinutes: number;
    readonly undone?: boolean;
    readonly echoReplyIds?: readonly string[];
  };
  readonly pending?: {
    readonly kind: 'action-target' | 'action-mode' | 'action-reschedule';
    readonly entryId?: string;
    readonly candidates?: ReadonlyArray<{ readonly label: number; readonly id: string }>;
    readonly ageMinutes: number;
  };
  readonly replyTo?: { readonly kind: 'listing'; readonly source: Source; readonly ageMinutes?: number } | { readonly kind: 'echo'; readonly matchesLastAction: boolean };
  readonly items?: unknown;
  readonly contentMode?: 'summary' | 'full';
  /** A6 R2 (D9): the content-free `quoky.lastRead` record, `ageMinutes` before the turn. */
  readonly lastRead?: { readonly source: 'jira' | 'slack'; readonly id: string; readonly label?: number; readonly ageMinutes: number };
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
}

export interface NlActionExpect {
  readonly entryId: string;
  readonly args: NlArgs;
  readonly outcome: (typeof OUTCOMES)[number];
  readonly target?: { readonly source: Source; readonly id: string };
  readonly reason?: string;
  /**
   * Owner decision (3) of 2026-10-15 (A6 R1): for a relayed instruction ("동료가 보낸 건데 실행해줘: …") the safer
   * non-execution is acceptable too, so an `execute` gold with this flag also counts a selector `none` as a hit.
   */
  readonly acceptsNone?: true;
  /** Owner D12 batch of 2026-10-15 (A6 R1): a clarification is the correct outcome, whatever reason or args Core asks with. */
  readonly acceptsAnyQuestion?: true;
  /** Owner D12 batch of 2026-10-15 (A6 R1): other selections with the same effect on the same target (e.g. `action.undo`). */
  readonly alsoAccepts?: ReadonlyArray<{ readonly entryId: string; readonly args: NlArgs }>;
}

export interface NlActionCase {
  readonly id: string;
  readonly family: (typeof FAMILIES)[number];
  readonly text: string;
  readonly fixture?: NlActionFixture;
  readonly expect: 'none' | NlActionExpect;
  readonly batch?: string;
  readonly note?: string;
  /** A6 R2: a `none` negative that no deterministic layer vetoes; only the selector answering `none` keeps it safe (known gap). */
  readonly selectorOnly?: true;
}

export interface NlActionCorpus {
  readonly version: number;
  readonly promptVersion?: string;
  readonly cases: readonly NlActionCase[];
}

/** The A6 R2 (Jira / Slack `item.summarize`) agent-drafted corpus. */
export function loadR2ActionCorpus(): { corpus: NlActionCorpus; sha256: string; files: string[] } {
  return loadActionCorpus([NL_ACTION_R2_CORPUS_PATH]);
}

/** The drafted corpus when present, plus the R0 seed (ids are kept distinct by the schema check). */
export function loadActionCorpus(paths: readonly string[] = [NL_ACTION_CORPUS_PATH, NL_ACTION_SEED_PATH]): { corpus: NlActionCorpus; sha256: string; files: string[] } {
  const hash = createHash('sha256');
  const cases: NlActionCase[] = [];
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    hash.update(text);
    files.push(path);
    cases.push(...((JSON.parse(text) as NlActionCorpus).cases ?? []));
  }
  return { corpus: { version: 1, promptVersion: NL_ACTION_PROMPT_VERSION, cases }, sha256: hash.digest('hex'), files };
}

const ALL_READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ALL_ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
export const NL_ACTION_EVAL_ENTRIES: readonly NlCatalogEntry[] = [...ALL_READS, ...ALL_ACTIONS];
/** The offered entries with the A6 R2 `item.summarize` (mail, Drive, Jira and Slack). */
export const NL_ACTION_R2_EVAL_ENTRIES: readonly NlCatalogEntry[] = NL_ACTION_EVAL_ENTRIES.map((entry) =>
  entry.id === 'item.summarize' ? mergeItemSummarizeEntries([entry, nlItemSummarizeEntry(['jira', 'slack'])]) : entry,
);
const SPAN_ARGS = ['title', 'match', 'body', 'when'];
/** The fixed `now` of the schema check and of the scorer's own validation (only a period arg reads it). */
const VALIDATION_NOW = '2026-10-14T03:00:00.000Z' as IsoTimestamp;
const TARGET_ENTRIES = new Set(['todo.complete', 'todo.cancel', 'reminder.cancel', 'item.summarize', 'action.undo']);

/** The schema check of `docs/plans/nl-action-corpus-schema.md` (problems as `id: what`, never a value). */
/**
 * Whether Core refuses a gold selection for its request shape (A6-D3a amendment 1, 2026-10-16: a structural veto, or a
 * frame that expresses no action). The positive request-form rule this measured is gone; the check stays so a gold the
 * vetoes refuse is visible as a cost instead of a silent miss (expected: none).
 */
export function isRequestFormCost(golden: NlActionCase): boolean {
  if (golden.expect === 'none' || !isNlCatalogEntryId(golden.expect.entryId)) return false;
  const prepared = prepareSelectionInput(golden.text);
  if ('skip' in prepared) return false;
  const offered = new Map(NL_ACTION_EVAL_ENTRIES.map((entry) => [entry.id, entry] as const));
  const result = validateSelection({ entryId: golden.expect.entryId, args: golden.expect.args }, { offered, groundingText: prepared.groundingText, now: '2026-10-14T03:00:00.000Z', timeZone: 'Asia/Seoul', actions: true });
  return !result.ok && (result.reason === 'not-request' || (result.reason === 'ungrounded' && result.arg === 'action'));
}

export function validateActionCorpus(corpus: NlActionCorpus, evalEntries: readonly NlCatalogEntry[] = NL_ACTION_EVAL_ENTRIES): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const golden of corpus.cases) {
    const where = typeof golden.id === 'string' ? golden.id : '(no id)';
    if (typeof golden.id !== 'string' || !/^a6(?:r2)?-[a-z0-9.-]+$/.test(golden.id)) problems.push(`${where}: id`);
    if (ids.has(golden.id)) problems.push(`${where}: duplicate id`);
    ids.add(golden.id);
    if (!(FAMILIES as readonly string[]).includes(golden.family)) problems.push(`${where}: family`);
    if (typeof golden.text !== 'string' || golden.text.trim().length === 0) problems.push(`${where}: text`);
    else if ('skip' in prepareSelectionInput(golden.text)) problems.push(`${where}: text is skipped by selection`);
    for (const listing of golden.fixture?.listings ?? []) {
      if (!(SOURCES as readonly string[]).includes(listing.source)) problems.push(`${where}: listing source`);
      if (!Array.isArray(listing.labels) || listing.labels.some((label) => !Number.isSafeInteger(label) || label < 1)) problems.push(`${where}: listing labels`);
      if (listing.ids !== undefined && listing.ids.length !== listing.labels.length) problems.push(`${where}: listing ids`);
      if (!Number.isFinite(listing.ageMinutes) || listing.ageMinutes < 0) problems.push(`${where}: listing age`);
    }
    const last = golden.fixture?.lastAction;
    if (last !== undefined && (!isNlActionEntryId(last.entryId) || (last.source !== 'todo' && last.source !== 'reminder'))) problems.push(`${where}: lastAction`);
    if (golden.selectorOnly !== undefined && (golden.selectorOnly !== true || golden.expect !== 'none')) problems.push(`${where}: selectorOnly`);
    if (golden.expect === 'none') continue;
    const expect = golden.expect;
    if (!isNlCatalogEntryId(expect.entryId)) problems.push(`${where}: expect entry`);
    if (!(OUTCOMES as readonly string[]).includes(expect.outcome)) problems.push(`${where}: expect outcome`);
    if (expect.outcome !== 'execute' && (expect.reason === undefined || !(REASONS as readonly string[]).includes(expect.reason))) problems.push(`${where}: expect reason`);
    if (expect.acceptsNone !== undefined && (expect.acceptsNone !== true || expect.outcome !== 'execute')) problems.push(`${where}: acceptsNone`);
    if (expect.acceptsAnyQuestion !== undefined && (expect.acceptsAnyQuestion !== true || expect.outcome !== 'ask')) problems.push(`${where}: acceptsAnyQuestion`);
    if (expect.alsoAccepts !== undefined && (expect.outcome !== 'execute' || expect.alsoAccepts.some((other) => !isNlCatalogEntryId(other.entryId)))) problems.push(`${where}: alsoAccepts`);
    if (expect.outcome === 'execute' && TARGET_ENTRIES.has(expect.entryId) && expect.args.match === undefined && expect.target === undefined) problems.push(`${where}: expect target`);
    // A gold selection must be what the validator accepts from this text (grounded spans and refs, closed values).
    if (isNlCatalogEntryId(expect.entryId) && !('skip' in prepareSelectionInput(golden.text))) {
      const prepared = prepareSelectionInput(golden.text) as { groundingText: string };
      const offered = new Map(evalEntries.map((entry) => [entry.id, entry] as const));
      const ctx = { offered, groundingText: prepared.groundingText, now: VALIDATION_NOW, timeZone: 'Asia/Seoul', actions: true as const, ...(golden.fixture?.prior !== undefined ? { previousArgs: golden.fixture.prior.args } : {}) };
      const result = validateSelection({ entryId: expect.entryId, args: expect.args }, ctx);
      const refusedByRule = expect.outcome !== 'execute' && ['deictic-payload', 'time-in-title', 'time-outside-when', 'bulk', 'credential'].includes(expect.reason ?? '');
      // A gold question that IS the validator's own refusal of the gold args ("그거 원문 보여줘" with no knowable source asks
      // `missing-arg`; owner decision 2026-10-19): its args must be Core's own grounded args for that selection.
      if (!result.ok && expect.outcome !== 'execute' && result.reason === expect.reason) {
        const own = nlCoreSelectionArgs({ entryId: expect.entryId, args: expect.args }, ctx);
        if (own === undefined || canonical(own) !== canonical(expect.args)) problems.push(`${where}: gold args not canonical`);
        continue;
      }
      // An `acceptsAnyQuestion` gold scores the question, not its args (owner D12 batch 2026-10-15).
      // A gold the request-shape vetoes refuse (A6-D3a amendment 1) is a measured cost, not a schema problem.
      const requestFormCost = !result.ok && (result.reason === 'not-request' || (result.reason === 'ungrounded' && result.arg === 'action'));
      if (!result.ok && !refusedByRule && expect.acceptsAnyQuestion !== true && !requestFormCost) problems.push(`${where}: gold does not validate (${result.reason} ${result.arg ?? ''})`);
      else if (result.ok && canonical(result.value.args) !== canonical(expect.args)) problems.push(`${where}: gold args not canonical`);
    }
  }
  return problems;
}

function canonical(args: NlArgs): string {
  return JSON.stringify(Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The fixture id of label `n` when a listing carries no `ids` (Jira `KEY:numericId`, Slack `channelId:ts`). */
function defaultItemId(source: Source, label: number): string {
  if (source === 'jira') return `PROJ-${label}:${10000 + label}`;
  if (source === 'slack') return `C0123456:17000000${String(label).padStart(2, '0')}.000100`;
  return `${source}-${label}`;
}

// ── fixtures → the session and actor Core reads ────────────────────────────────────────────────────────────────

const ACTOR_ID = 'eval-owner';

/** The content-free session / actor state a case's fixture describes, at `now`. */
export function fixtureWorld(fixture: NlActionFixture | undefined, now: IsoTimestamp): { session: Session; actor: Actor; replyToMessageId?: string } {
  const minus = (minutes: number): IsoTimestamp => new Date(Date.parse(now) - minutes * 60_000).toISOString();
  let listing: unknown;
  let replyToMessageId: string | undefined;
  const listings = [...(fixture?.listings ?? [])].sort((a, b) => b.ageMinutes - a.ageMinutes);
  // `lastWritten` names the youngest listing explicitly: it is written last at its age (minus a millisecond tie-break).
  for (const slot of listings) {
    const age = fixture?.lastWritten === slot.source ? Math.max(0, slot.ageMinutes - 0.001) : slot.ageMinutes;
    const items = slot.labels.map((label, index) => ({ label, id: slot.ids?.[index] ?? defaultItemId(slot.source, label) }));
    const requestId = `req-${slot.source}`;
    listing = withLabelledListing(listing, ACTOR_ID, slot.source, items, minus(age), 'listing', requestId);
    if (fixture?.replyTo?.kind === 'listing' && fixture.replyTo.source === slot.source) {
      listing = withListingReplies(listing, ACTOR_ID, slot.source, requestId, [`reply-${slot.source}`], minus(age)).next;
      replyToMessageId = `reply-${slot.source}`;
    }
  }
  const metadata: Record<string, unknown> = {};
  if (listing !== undefined) metadata[LAST_LISTING_METADATA_KEY] = listing;
  const last = fixture?.lastAction;
  if (last !== undefined && isNlActionEntryId(last.entryId)) {
    const echo = last.echoReplyIds ?? (fixture?.replyTo?.kind === 'echo' ? ['echo-current'] : []);
    // A listing of the action's source written at the action's own age is its echo (the label merged in the same turn),
    // so it carries the action's request id (A6 reference priority, owner 2026-10-16: the echo slot is never a newer
    // listing). Any other listing keeps its own request id and is ordered by age.
    const echoed = listings.some((slot) => slot.source === last.source && slot.ageMinutes === last.ageMinutes);
    metadata[LAST_ACTION_METADATA_KEY] = withLastAction(
      undefined,
      ACTOR_ID,
      {
        entryId: last.entryId,
        source: last.source,
        itemId: last.itemId,
        ...(last.label !== undefined ? { label: last.label } : {}),
        version: minus(last.ageMinutes),
        at: minus(last.ageMinutes),
        undoable: last.entryId !== 'action.undo',
        undone: last.undone === true,
        ...(last.entryId === 'action.undo' ? { undoOf: 'todo.complete' as const } : {}),
        ...(echoed ? { requestId: `req-${last.source}` } : {}),
        echoReplyIds: echo,
      },
      minus(last.ageMinutes),
    );
    if (fixture?.replyTo?.kind === 'echo') replyToMessageId = fixture.replyTo.matchesLastAction ? (echo[0] ?? 'echo-current') : 'echo-older';
  }
  if (fixture?.lastRead !== undefined) {
    metadata[LAST_READ_METADATA_KEY] = withLastRead(
      undefined,
      ACTOR_ID,
      { source: fixture.lastRead.source, id: fixture.lastRead.id, ...(fixture.lastRead.label !== undefined ? { label: fixture.lastRead.label } : {}), at: minus(fixture.lastRead.ageMinutes) },
      minus(fixture.lastRead.ageMinutes),
    );
  }
  const pending = fixture?.pending;
  if (pending !== undefined && pending.kind === 'action-target' && pending.entryId !== undefined && isNlActionEntryId(pending.entryId) && pending.candidates !== undefined) {
    const source = pending.entryId.startsWith('todo') ? 'todo' : pending.entryId.startsWith('reminder') ? 'reminder' : 'mail';
    metadata[NL_PENDING_METADATA_KEY] = pendingQuestionRecord(ACTOR_ID, { kind: 'action-target', at: minus(pending.ageMinutes), language: 'ko', entryId: pending.entryId, source, candidates: pending.candidates, args: {} });
  }
  if (fixture?.prior !== undefined && isNlWave1EntryId(fixture.prior.entryId)) {
    metadata['quoky.lastSelection'] = { actorId: ACTOR_ID, entryId: fixture.prior.entryId, args: { ...fixture.prior.args }, at: minus(1) };
  }
  const actorMetadata: Record<string, unknown> = {};
  if (fixture?.contentMode !== undefined) {
    actorMetadata[INTERPRETATION_PREFERENCES_METADATA_KEY] = { [ITEM_CONTENT_MODE.key]: { value: fixture.contentMode, at: minus(60) } };
  }
  return {
    session: { id: 'eval-session', actorId: ACTOR_ID, context: { platform: 'eval', channelId: 'dm', userId: 'owner', direct: true }, status: 'ACTIVE' as Session['status'], createdAt: now, lastActivityAt: now, metadata },
    actor: { id: ACTOR_ID, displayName: 'Owner', identities: [], createdAt: now, metadata: actorMetadata },
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  };
}

/** Core's decision for one selector output on one case (the real service, local level, a fresh world). */
export async function decideActionCase(
  golden: Pick<NlActionCase, 'text' | 'fixture'>,
  provider: AiProvider,
  now: IsoTimestamp,
  options: { readonly timeoutMs?: number; readonly itemR2?: 'off' | 'shadow' | 'jira' | 'all' } = {},
): Promise<{ readonly decision: NlSelectionDecision; readonly audit?: Record<string, unknown> }> {
  const world = fixtureWorld(golden.fixture, now);
  let session = world.session;
  let actor = world.actor;
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    info: (event: string, fields?: Record<string, unknown>) => void logs.push({ event, ...(fields !== undefined ? { fields } : {}) }),
    warn: (event: string, fields?: Record<string, unknown>) => void logs.push({ event, ...(fields !== undefined ? { fields } : {}) }),
    error: () => undefined,
  };
  const actors = {
    get: async () => actor,
    save: async (next: Actor) => {
      actor = next;
      return next;
    },
  };
  const service = new NlSelectionService({
    mode: 'active',
    router: { select: async () => provider },
    sessions: {
      updateMetadataEntry: async (_ref, key, update) => {
        const metadata: Record<string, unknown> = { ...(session.metadata ?? {}) };
        const next = update(metadata[key]);
        if (next === undefined) delete metadata[key];
        else metadata[key] = next;
        session = { ...session, metadata };
        return session;
      },
    },
    actors,
    timeZone: 'Asia/Seoul',
    logger,
    timeoutMs: options.timeoutMs ?? NL_SELECTION_TIMEOUT_MS,
    actions: { level: 'local', killSwitch: new NlActionSwitch({ actors, logger }), ...(options.itemR2 !== undefined ? { itemR2: options.itemR2 } : {}) },
  });
  const decision = await service.decide({
    // The owner's DM: the action corpus measures the selector and Core's decision, not the channel gate.
    direct: true,
    text: golden.text,
    attachmentCount: 0,
    session,
    actor,
    now,
    entries: options.itemR2 !== undefined && options.itemR2 !== 'off' ? NL_ACTION_R2_EVAL_ENTRIES : NL_ACTION_EVAL_ENTRIES,
    route: 'chat',
    chatProviderId: provider.family ?? provider.id,
    chatProviderLocality: executionLocalityOf(provider),
    ...(world.replyToMessageId !== undefined ? { replyToMessageId: world.replyToMessageId } : {}),
  });
  const audit = logs.filter((log) => log.event === 'nl_action.decided').at(-1)?.fields;
  return { decision, ...(audit !== undefined ? { audit } : {}) };
}

export type NlActionOutcome = 'hit' | 'miss' | 'question' | 'wrong-target' | 'negative-capture' | 'none' | 'read' | 'timeout' | 'error' | 'skipped';

export interface NlActionRecord {
  readonly run: number;
  readonly id: string;
  readonly family: string;
  readonly expected: string;
  readonly outcome: NlActionOutcome;
  readonly spanExact?: boolean;
  readonly got?: string;
  readonly latencyMs: number;
  readonly reason?: string;
  /**
   * R2 mode only (diagnosis, v47 gate): the selector's own args, and the gold args for a non-hit. Only the closed
   * diagnostic fields (source, ref, mode, scope) are recorded, each only as a catalog enum value or a canonical ref;
   * anything else is "<invalid>", so no free text ever reaches the report (Codex P2).
   */
  readonly gotArgs?: NlArgs;
  readonly expectedArgs?: NlArgs;
}

const DIAGNOSTIC_VALUES: Readonly<Record<string, readonly string[]>> = {
  source: NL_ITEM_SUMMARIZE_SOURCES,
  mode: ['summary', 'full'],
  scope: ['item', 'thread'],
};

/** The diagnostic args of a record: source, ref, mode and scope only, each a closed value or "<invalid>" (content-free). */
export function recordArgs(args: NlArgs): NlArgs {
  const out: Record<string, string> = {};
  for (const name of ['source', 'ref', 'mode', 'scope'] as const) {
    const value = args[name];
    if (value === undefined) continue;
    if (name === 'ref') {
      const ref = parseNlRef(value, { keys: true });
      out.ref = ref === undefined ? '<invalid>' : formatNlRef(ref);
      continue;
    }
    out[name] = typeof value === 'string' && (DIAGNOSTIC_VALUES[name] ?? []).includes(value) ? value : '<invalid>';
  }
  return out;
}

/** R2 mode: the selector's args and, for a non-hit, the gold args (see {@link NlActionRecord.gotArgs}). */
export function r2DiagnosticArgs(golden: NlActionCase, raw: string, outcome: NlActionOutcome): { gotArgs?: NlArgs; expectedArgs?: NlArgs } {
  const output = parseSelectionOutput(raw);
  return {
    ...(output !== null ? { gotArgs: recordArgs(output.args) } : {}),
    ...(outcome !== 'hit' && golden.expect !== 'none' ? { expectedArgs: recordArgs(golden.expect.args) } : {}),
  };
}

/** What the scorer validates the selector's output against: the turn's offered entries (A6 or R2) and its `now`. */
export interface NlActionScoreContext {
  readonly entries?: readonly NlCatalogEntry[];
  readonly now?: IsoTimestamp;
}

/**
 * Core's own final args for the selector's output (owner decision 2026-10-19): the args Core validated and grounded for
 * it, exactly as `decideActionCase`'s turn validated them (same offered entries, same grounding text, no previous args),
 * or, when a rule refused it, the args as Core checked and grounded them before that rule. `undefined` when there are none.
 */
function coreFinalArgs(golden: NlActionCase, output: NonNullable<ReturnType<typeof parseSelectionOutput>>, context: NlActionScoreContext): NlArgs | undefined {
  if (output.entryId === null) return undefined;
  const prepared = prepareSelectionInput(golden.text);
  if ('skip' in prepared) return undefined;
  const offered = new Map((context.entries ?? NL_ACTION_EVAL_ENTRIES).map((entry) => [entry.id, entry] as const));
  return nlCoreSelectionArgs({ entryId: output.entryId, args: output.args }, { offered, groundingText: prepared.groundingText, now: context.now ?? VALIDATION_NOW, timeZone: 'Asia/Seoul', actions: true });
}

/**
 * Score Core's decision against the gold (exported for the offline tests). One rule for every gold (owner decision
 * 2026-10-19): the args compared are Core's FINAL args, never the selector's raw ones. An execution carries them; for a
 * gold ask or refusal they are Core's own validated and grounded args for the selector's output ({@link coreFinalArgs}),
 * so a grounded `mode`, `source` or recency `ref` counts the same whether Core executes or asks. This scorer serves the
 * A6 action gate and the R2 gate alike.
 */
export function scoreActionDecision(golden: NlActionCase, raw: string, decision: NlSelectionDecision, audit?: Record<string, unknown>, context: NlActionScoreContext = {}): Omit<NlActionRecord, 'run' | 'latencyMs'> {
  const expected = golden.expect === 'none' ? 'none' : golden.expect.entryId;
  const base = { id: golden.id, family: golden.family, expected };
  const output = parseSelectionOutput(raw);
  if (decision.kind === 'unavailable') return { ...base, outcome: output === null ? 'error' : 'timeout' };
  if (decision.kind === 'skip') return { ...base, outcome: 'skipped' };
  const reason = typeof audit?.reason === 'string' ? audit.reason : undefined;
  const executed = decision.kind === 'execute' ? decision.command : undefined;
  const isAction = executed !== undefined && isNlActionEntryId(executed.entryId);
  if (golden.expect === 'none') {
    if (isAction) return { ...base, outcome: 'negative-capture', got: executed.entryId };
    if (executed !== undefined) return { ...base, outcome: 'read', got: executed.entryId };
    return { ...base, outcome: decision.kind === 'none' ? 'none' : 'question', ...(reason !== undefined ? { reason } : {}) };
  }
  const gold = golden.expect;
  const spans = SPAN_ARGS.filter((name) => typeof gold.args[name] === 'string');
  const outputArgs = output?.entryId === gold.entryId ? output.args : {};
  const spanExact = spans.length === 0 ? undefined : spans.every((name) => typeof outputArgs[name] === 'string' && (outputArgs[name] as string).replace(/\s+/g, ' ').trim().replace(/^['"「“‘]|['"」”’]$/gu, '') === gold.args[name]);
  const withSpan = spanExact === undefined ? {} : { spanExact };
  if (gold.outcome !== 'execute') {
    if (isAction && executed.target !== undefined) return { ...base, outcome: 'wrong-target', got: executed.entryId, ...withSpan };
    if (executed !== undefined) return { ...base, outcome: 'miss', got: executed.entryId, ...withSpan };
    // A gold ask is a hit only when the selector actually asks (Core's ask outcome, or the selector's own NEEDS_CLARIFICATION):
    // naming the gold entry with the gold args while the turn ends as none or anything else is a miss (2026-10-16).
    if (gold.outcome === 'ask' && decision.kind !== 'ask' && output?.ambiguity !== 'NEEDS_CLARIFICATION') return { ...base, outcome: 'miss', got: output?.entryId ?? 'none', ...withSpan, ...(reason !== undefined ? { reason } : {}) };
    if (gold.acceptsAnyQuestion === true && decision.kind === 'ask' && reason !== undefined && CLARIFICATION_REASONS.has(reason)) return { ...base, outcome: 'hit', got: output?.entryId ?? 'none', ...withSpan, ...(reason !== undefined ? { reason } : {}) };
    const final = output !== null && output.entryId === gold.entryId ? coreFinalArgs(golden, output, context) : undefined;
    const named = final !== undefined && canonical(withoutMode(final, gold.args)) === canonical(gold.args);
    // A gold refusal or question with no args (`{}`: the refused argument has no canonical value) is scored by its closed
    // reason instead: the selector named the gold entry and Core refused or asked for exactly the gold reason (A6 R1).
    const sameReason = output?.entryId === gold.entryId && Object.keys(gold.args).length === 0 && reason !== undefined && reason === gold.reason;
    return { ...base, outcome: named || sameReason ? 'hit' : 'miss', got: output?.entryId ?? 'none', ...withSpan, ...(reason !== undefined ? { reason } : {}) };
  }
  if (executed === undefined && decision.kind === 'none' && gold.acceptsNone === true) return { ...base, outcome: 'hit', got: 'none', ...(reason !== undefined ? { reason } : {}) };
  if (executed === undefined) return { ...base, outcome: decision.kind === 'none' ? 'miss' : 'question', got: output?.entryId ?? 'none', ...withSpan, ...(reason !== undefined ? { reason } : {}) };
  const sameTarget = gold.target === undefined || (executed.target?.source === gold.target.source && executed.target.id === gold.target.id);
  if (executed.target !== undefined && gold.target !== undefined && !sameTarget) return { ...base, outcome: 'wrong-target', got: executed.entryId, ...withSpan };
  // Owner D12 batch of 2026-10-15 (A6 R1): a READ gold in the action corpus is scored on the entry only (this corpus measures
  // action selection; the read corpus scores read args).
  if (isNlWave1EntryId(gold.entryId)) return { ...base, outcome: executed.entryId === gold.entryId ? 'hit' : 'miss', got: executed.entryId, ...withSpan };
  const accepted = [{ entryId: gold.entryId, args: gold.args }, ...(gold.alsoAccepts ?? [])];
  const same = sameTarget && accepted.some((choice) => executed.entryId === choice.entryId && canonical(withoutMode(executed.args, choice.args)) === canonical(choice.args));
  return { ...base, outcome: same ? 'hit' : 'miss', got: executed.entryId, ...withSpan };
}

/** A stored content-mode preference fills `mode`; the gold names only what the selector must output. */
function withoutMode(args: NlArgs, gold: NlArgs): NlArgs {
  if (gold.mode !== undefined || args.mode === undefined) return args;
  const { mode: _mode, ...rest } = args;
  return rest;
}

export interface NlActionSummary {
  readonly cases: number;
  readonly positives: number;
  readonly hits: number;
  readonly overall: number;
  readonly perEntry: Readonly<Record<string, { readonly hits: number; readonly total: number; readonly rate: number }>>;
  readonly spanExact: number;
  readonly wrongTargets: number;
  readonly negativeCaptures: number;
  readonly referenceQuestionRate: number;
  readonly overBoundRate: number;
  readonly gatePassed: boolean;
}

export function summarizeAction(records: readonly NlActionRecord[], boundMs: number = NL_SELECTION_TIMEOUT_MS): NlActionSummary {
  const positives = records.filter((record) => record.expected !== 'none');
  const hits = positives.filter((record) => record.outcome === 'hit').length;
  const perEntry: Record<string, { hits: number; total: number; rate: number }> = {};
  for (const record of positives) {
    const slot = (perEntry[record.expected] ??= { hits: 0, total: 0, rate: 0 });
    slot.total += 1;
    if (record.outcome === 'hit') slot.hits += 1;
  }
  for (const slot of Object.values(perEntry)) slot.rate = slot.total === 0 ? 0 : slot.hits / slot.total;
  const spanRecords = records.filter((record) => record.spanExact !== undefined);
  const spanExact = spanRecords.length === 0 ? 1 : spanRecords.filter((record) => record.spanExact === true).length / spanRecords.length;
  const references = positives.filter((record) => record.family === 'reference' || record.family === 'live');
  const referenceQuestionRate = references.length === 0 ? 0 : references.filter((record) => record.outcome === 'question').length / references.length;
  const wrongTargets = records.filter((record) => record.outcome === 'wrong-target').length;
  const negativeCaptures = records.filter((record) => record.outcome === 'negative-capture').length;
  const overBoundRate = records.length === 0 ? 0 : records.filter((record) => record.latencyMs > boundMs).length / records.length;
  const overall = positives.length === 0 ? 1 : hits / positives.length;
  const gate = NL_ACTION_EVAL_GATE;
  return {
    cases: records.length,
    positives: positives.length,
    hits,
    overall,
    perEntry,
    spanExact,
    wrongTargets,
    negativeCaptures,
    referenceQuestionRate,
    overBoundRate,
    gatePassed:
      overall >= gate.overall &&
      Object.values(perEntry).every((slot) => slot.rate >= gate.perEntry) &&
      spanExact >= gate.spanExact &&
      wrongTargets <= gate.wrongTarget &&
      negativeCaptures <= gate.negativeCaptures &&
      referenceQuestionRate <= gate.questionRateOnReferences &&
      overBoundRate <= gate.overBoundRate,
  };
}

export interface NlActionR2Summary extends Omit<NlActionSummary, 'gatePassed'> {
  /** The jira and slack slices of the positive cases (the source of the gold `item.summarize` selection). */
  readonly perSource: Readonly<Record<'jira' | 'slack', { readonly hits: number; readonly total: number; readonly rate: number }>>;
  readonly gatePassed: boolean;
}

/** The R2 model gate over one run's records (proposal §6.4); `corpus` supplies each case's source. */
export function summarizeActionR2(records: readonly NlActionRecord[], corpus: NlActionCorpus, boundMs: number = NL_SELECTION_TIMEOUT_MS): NlActionR2Summary {
  const base = summarizeAction(records, boundMs);
  const sourceOf = new Map<string, string>();
  for (const golden of corpus.cases) if (golden.expect !== 'none' && typeof golden.expect.args.source === 'string') sourceOf.set(golden.id, golden.expect.args.source);
  const perSource = { jira: { hits: 0, total: 0, rate: 0 }, slack: { hits: 0, total: 0, rate: 0 } };
  for (const record of records) {
    if (record.expected === 'none') continue;
    const source = sourceOf.get(record.id);
    if (source !== 'jira' && source !== 'slack') continue;
    perSource[source].total += 1;
    if (record.outcome === 'hit') perSource[source].hits += 1;
  }
  for (const slot of Object.values(perSource)) slot.rate = slot.total === 0 ? 0 : slot.hits / slot.total;
  const gate = NL_ACTION_R2_EVAL_GATE;
  return {
    ...base,
    perSource,
    gatePassed:
      records.length > 0 &&
      base.overall >= gate.overall &&
      perSource.jira.rate >= gate.perSource &&
      perSource.slack.rate >= gate.perSource &&
      base.wrongTargets <= gate.wrongTarget &&
      base.negativeCaptures <= gate.negativeCaptures &&
      base.referenceQuestionRate <= gate.questionRateOnReferences &&
      base.overBoundRate <= gate.overBoundRate,
  };
}

// ── plans ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type NlActionEvalKind = 'nl-action-eval' | 'nl-read-regression' | 'nl-action-r2-eval';

export interface NlActionPlan {
  readonly kind: NlActionEvalKind;
  readonly promptVersion: string;
  readonly promptSha256: string;
  readonly corpusSha256: string;
  readonly model: string;
  readonly runs: number;
  readonly concurrency: number;
  readonly callTimeoutMs: number;
  readonly caseIds: readonly string[];
  /** `nl-action-r2-eval` only: R2 is offered as with `QUOKY_NL_ITEM_R2=all` (fixed by the mode; the environment is never read). */
  readonly itemR2?: 'all';
  /** `nl-action-r2-eval` only: the git revision the plan was made at. */
  readonly gitHead?: string;
  /** `nl-action-r2-eval` only: the model-call count this plan authorises (cases x runs; one selector call per case). */
  readonly calls?: number;
  /** `nl-action-r2-eval` only: the gate (A6 R2 proposal §6.4), bound into the digest. */
  readonly gate?: typeof NL_ACTION_R2_EVAL_GATE;
}

/** The v19 instruction text with every entry offered and nothing referenced: any prompt edit changes the digest. */
export function actionPromptSha256(entries: readonly NlCatalogEntry[] = NL_ACTION_EVAL_ENTRIES): string {
  return createHash('sha256').update(buildSelectionPrompt({ entries, text: '', actions: { referenceContext: 'none' } })).digest('hex');
}

export function buildActionPlan(
  kind: NlActionEvalKind,
  caseIds: readonly string[],
  corpusSha256: string,
  options: { readonly model: string; readonly runs: number; readonly concurrency: number; readonly timeoutMs?: number; readonly gitHead?: string },
): NlActionPlan {
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) throw new Error('runs must be 1..5');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('concurrency must be 1..8');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(options.model)) throw new Error('invalid model');
  const r2 = kind === 'nl-action-r2-eval';
  return {
    kind,
    promptVersion: r2 ? NL_ACTION_R2_PROMPT_VERSION : NL_ACTION_PROMPT_VERSION,
    promptSha256: r2 ? actionPromptSha256(NL_ACTION_R2_EVAL_ENTRIES) : actionPromptSha256(),
    corpusSha256,
    model: options.model,
    runs: options.runs,
    concurrency: options.concurrency,
    callTimeoutMs: options.timeoutMs ?? NL_SELECTION_TIMEOUT_MS,
    caseIds: [...caseIds],
    ...(r2 ? { itemR2: 'all' as const, ...(options.gitHead !== undefined ? { gitHead: options.gitHead } : {}), calls: caseIds.length * options.runs, gate: NL_ACTION_R2_EVAL_GATE } : {}),
  };
}

export function computeActionPlanDigest(plan: NlActionPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/** Wrap a provider so each call's raw text and latency are seen by the evaluation (the service sees the same text). */
function recording(provider: AiProvider, clock: () => number): { provider: AiProvider; last: () => { raw: string; latencyMs: number } } {
  let raw = '';
  let latencyMs = 0;
  const wrapped: AiProvider = {
    ...provider,
    id: provider.id,
    ...(provider.family !== undefined ? { family: provider.family } : {}),
    capabilities: provider.capabilities,
    isAvailable: () => provider.isAvailable(),
    execute: async (request) => {
      const started = clock();
      try {
        const result = await provider.execute(request);
        raw = result.text;
        return result;
      } finally {
        latencyMs = clock() - started;
      }
    },
  };
  return { provider: wrapped, last: () => ({ raw, latencyMs }) };
}

/** Run the action plan (Strict: the caller checked the approved digest). */
export async function runActionEvaluation(input: {
  readonly corpus: NlActionCorpus;
  readonly plan: NlActionPlan;
  readonly provider: AiProvider;
  readonly now: () => IsoTimestamp;
  readonly elapsed?: () => number;
  readonly onRecord?: (record: NlActionRecord) => void;
}): Promise<NlActionRecord[]> {
  const byId = new Map(input.corpus.cases.map((golden) => [golden.id, golden] as const));
  const records: NlActionRecord[] = [];
  for (let run = 1; run <= input.plan.runs; run += 1) {
    const queue = input.plan.caseIds.map((id) => byId.get(id)).filter((golden): golden is NlActionCase => golden !== undefined);
    const worker = async (): Promise<void> => {
      for (let golden = queue.shift(); golden !== undefined; golden = queue.shift()) {
        const rec = recording(input.provider, input.elapsed ?? Date.now);
        let record: NlActionRecord;
        try {
          const { decision, audit } = await decideActionCase(golden, rec.provider, input.now(), { timeoutMs: input.plan.callTimeoutMs, ...(input.plan.itemR2 !== undefined ? { itemR2: input.plan.itemR2 } : {}) });
          const { raw, latencyMs } = rec.last();
          const scored = scoreActionDecision(golden, raw, decision, audit, { entries: input.plan.itemR2 !== undefined ? NL_ACTION_R2_EVAL_ENTRIES : NL_ACTION_EVAL_ENTRIES });
          record = { run, latencyMs, ...scored, ...(input.plan.itemR2 !== undefined ? r2DiagnosticArgs(golden, raw, scored.outcome) : {}) };
        } catch (error) {
          record = { run, id: golden.id, family: golden.family, expected: golden.expect === 'none' ? 'none' : golden.expect.entryId, outcome: 'error', latencyMs: rec.last().latencyMs, reason: error instanceof Error ? error.name : 'unknown' };
        }
        records.push(record);
        input.onRecord?.(record);
      }
    };
    await Promise.all(Array.from({ length: input.plan.concurrency }, () => worker()));
  }
  return records;
}

// ── read regression (A6-D7) ────────────────────────────────────────────────────────────────────────────────────

export interface NlReadRegressionCase {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  /**
   * The owner-approved gold with the A6 entries offered, scored apart: a summary-`none` case relabelled to
   * `item.summarize` (ratification decision 10), or an anchored action command whose A6 action is the gold (owner decision
   * (2) of 2026-10-15, A6 R1). Read mode (A6 off) keeps `expect`.
   */
  readonly a6Relabel?: { readonly entryId: string; readonly args: NlArgs; readonly batch: string };
  /**
   * A6-on scoring skips this case: an anchored grammar owns the message, so the selector never sees it at runtime, and the
   * A6 action it could name would not be the grammar's outcome (A6 R1 CA review: `neg-094`, a daily brief schedule).
   */
  readonly a6Skip?: { readonly reason: 'grammar-owned'; readonly batch: string };
  /** The content-free reference state before the turn (read-regression only): the listing the owner just saw. */
  readonly context?: NlReadRegressionContext;
}

export interface NlReadRegressionContext {
  readonly lastListing?: { readonly source: 'mail' | 'drive'; readonly labels: readonly number[]; readonly ageMinutes: number };
}

/** The reference state a read-regression case's `context` describes at `now` (the action fixtures' own builder). */
export function readRegressionReferenceState(context: NlReadRegressionContext | undefined, now: IsoTimestamp): NlReferenceState {
  const listing = context?.lastListing;
  const world = fixtureWorld(listing !== undefined ? { listings: [listing] } : undefined, now);
  return { listings: readListingRecord(world.session.metadata?.[LAST_LISTING_METADATA_KEY], world.session.actorId, now), now };
}

export type NlReadRegressionOutcome = 'hit' | 'miss' | 'clarify' | 'none' | 'wrong-capture' | 'action-capture' | 'timeout' | 'error' | 'skipped';

/** Score one read case with the A6 entries offered: any validated action or ITEM_READ capture is `action-capture`. */
export function scoreReadRegression(golden: NlReadRegressionCase, raw: string, now: string): { readonly outcome: NlReadRegressionOutcome; readonly relabeled: boolean; readonly got?: string } {
  const relabeled = golden.a6Relabel !== undefined;
  const expect = golden.a6Relabel ?? golden.expect;
  const prepared = prepareSelectionInput(golden.text);
  if ('skip' in prepared) return { outcome: 'skipped', relabeled };
  const output = parseSelectionOutput(raw);
  if (output === null) return { outcome: 'error', relabeled };
  if (output.entryId === null) return { outcome: expect === 'none' ? 'none' : 'miss', relabeled, got: 'none' };
  const offered = new Map(NL_ACTION_EVAL_ENTRIES.map((entry) => [entry.id, entry] as const));
  const validated = validateSelection(
    { entryId: output.entryId, args: output.args },
    { offered, groundingText: prepared.groundingText, now, timeZone: 'Asia/Seoul', actions: true, ...(golden.prior !== undefined ? { previousArgs: golden.prior.args } : {}) },
  );
  if (!validated.ok || output.ambiguity !== 'CLEAR') return { outcome: 'clarify', relabeled, got: output.entryId };
  const got = validated.value.entry.id;
  const isAction = validated.value.entry.risk !== 'READ';
  const goldIsAction = expect !== 'none' && isNlActionEntryId(expect.entryId);
  if (isAction && !goldIsAction) return { outcome: 'action-capture', relabeled, got };
  if (expect === 'none') return { outcome: 'wrong-capture', relabeled, got };
  return { outcome: got === expect.entryId && canonical(validated.value.args) === canonical(expect.args) ? 'hit' : 'miss', relabeled, got };
}

export function loadReadRegressionCorpus(path: string = NL_INTENT_CORPUS_PATH): { cases: NlReadRegressionCase[]; sha256: string } {
  const text = readFileSync(path, 'utf8');
  return { cases: (JSON.parse(text) as { cases: NlReadRegressionCase[] }).cases, sha256: createHash('sha256').update(text).digest('hex') };
}

/**
 * The read-regression prompt of one case: the A6 action prompt, every entry offered, the case's prior as the previous
 * selection and its `context` as the Reference context (`none` without one).
 */
export function readRegressionPrompt(golden: NlReadRegressionCase, now: IsoTimestamp): string | undefined {
  const prepared = prepareSelectionInput(golden.text);
  if ('skip' in prepared) return undefined;
  return buildSelectionPrompt({
    entries: NL_ACTION_EVAL_ENTRIES,
    text: prepared.text,
    actions: { referenceContext: golden.context === undefined ? 'none' : renderReferenceContext(readRegressionReferenceState(golden.context, now)) },
    ...(golden.prior !== undefined && isNlWave1EntryId(golden.prior.entryId) ? { previous: { entryId: golden.prior.entryId, args: golden.prior.args } } : {}),
  });
}

export async function runReadRegression(input: {
  readonly cases: readonly NlReadRegressionCase[];
  readonly plan: NlActionPlan;
  readonly provider: AiProvider;
  readonly now: () => string;
  readonly elapsed?: () => number;
}): Promise<Array<{ run: number; id: string; outcome: NlReadRegressionOutcome; relabeled: boolean; latencyMs: number; got?: string }>> {
  const byId = new Map(input.cases.map((golden) => [golden.id, golden] as const));
  const clock = input.elapsed ?? Date.now;
  const records: Array<{ run: number; id: string; outcome: NlReadRegressionOutcome; relabeled: boolean; latencyMs: number; got?: string }> = [];
  for (let run = 1; run <= input.plan.runs; run += 1) {
    const queue = input.plan.caseIds.map((id) => byId.get(id)).filter((golden): golden is NlReadRegressionCase => golden !== undefined);
    const worker = async (): Promise<void> => {
      for (let golden = queue.shift(); golden !== undefined; golden = queue.shift()) {
        const prompt = golden.a6Skip !== undefined ? undefined : readRegressionPrompt(golden, input.now());
        if (prompt === undefined) {
          records.push({ run, id: golden.id, outcome: 'skipped', relabeled: golden.a6Relabel !== undefined, latencyMs: 0 });
          continue;
        }
        const started = clock();
        try {
          const result = await input.provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs: input.plan.callTimeoutMs });
          records.push({ run, id: golden.id, latencyMs: clock() - started, ...scoreReadRegression(golden, result.text, input.now()) });
        } catch {
          records.push({ run, id: golden.id, outcome: 'error', relabeled: golden.a6Relabel !== undefined, latencyMs: clock() - started });
        }
      }
    };
    await Promise.all(Array.from({ length: input.plan.concurrency }, () => worker()));
  }
  return records;
}

/** The A6-D7 read-regression gate: the D12 gate on non-relabeled cases, and 0 action captures anywhere. */
export function summarizeReadRegression(records: ReadonlyArray<{ outcome: NlReadRegressionOutcome; relabeled: boolean; id: string }>, goldOf: (id: string) => string): {
  readonly overall: number;
  readonly actionCaptures: number;
  readonly wrongCaptures: number;
  readonly relabeled: { readonly hits: number; readonly total: number };
  readonly gatePassed: boolean;
} {
  const gated = records.filter((record) => !record.relabeled);
  const positives = gated.filter((record) => goldOf(record.id) !== 'none');
  const perEntry = new Map<string, { hits: number; total: number }>();
  for (const record of positives) {
    const slot = perEntry.get(goldOf(record.id)) ?? { hits: 0, total: 0 };
    slot.total += 1;
    if (record.outcome === 'hit') slot.hits += 1;
    perEntry.set(goldOf(record.id), slot);
  }
  const overall = positives.length === 0 ? 1 : positives.filter((record) => record.outcome === 'hit').length / positives.length;
  const actionCaptures = records.filter((record) => record.outcome === 'action-capture').length;
  const wrongCaptures = gated.filter((record) => record.outcome === 'wrong-capture').length;
  const relabeled = records.filter((record) => record.relabeled);
  return {
    overall,
    actionCaptures,
    wrongCaptures,
    relabeled: { hits: relabeled.filter((record) => record.outcome === 'hit').length, total: relabeled.length },
    gatePassed: overall >= 0.95 && [...perEntry.values()].every((slot) => slot.hits / slot.total >= 0.9) && wrongCaptures === 0 && actionCaptures === 0,
  };
}

// ── the grammar-side baseline (A6-D7 "measured, not imitated") ─────────────────────────────────────────────────────

/** Ids of the A6 entries a corpus targets (for the per-entry report). */
export const NL_ACTION_REPORT_ENTRIES: readonly string[] = NL_ACTION_ENTRY_IDS.filter((id) => NL_ACTION_ENTRIES[id] !== undefined);

/** Which A6 entry the anchored grammar alone would act as for this text (Class A), or `undefined`. Pure. */
export function grammarActionOf(text: string, now: string): string | undefined {
  const work = detectWorkChatCommand(text);
  if (work?.kind === 'todo.add' || work?.kind === 'todo.complete' || work?.kind === 'todo.cancel') return work.kind;
  try {
    const reminder = parseReminderMessage(text, { now, timeZone: 'Asia/Seoul' });
    if (reminder.kind === 'CREATE' || reminder.kind === 'CREATE_EVENT_RELATIVE') return 'reminder.create';
    if (reminder.kind === 'CANCEL') return 'reminder.cancel';
  } catch {
    // not a reminder
  }
  if (parseMailQuestion(text)?.kind === 'summarize' || parseDriveQuestion(text)?.kind === 'summarize') return 'item.summarize';
  return undefined;
}

/**
 * The grammar-side baseline per entry (offline): on the positive execute cases, how many the anchored grammar alone would
 * act on as the same entry (an upper bound: the grammar cannot resolve a deictic or a shown label), and how many
 * negatives it would act on. Compared with the selector side of a run, per entry (A6-D7 "measured, not imitated").
 */
export function scoreActionGrammarSide(corpus: NlActionCorpus, now: string): Record<string, { readonly claimed: number; readonly total: number }> {
  const result: Record<string, { claimed: number; total: number }> = {};
  for (const golden of corpus.cases) {
    const key = golden.expect === 'none' ? 'none' : golden.expect.outcome === 'execute' ? golden.expect.entryId : undefined;
    if (key === undefined) continue;
    const slot = (result[key] ??= { claimed: 0, total: 0 });
    slot.total += 1;
    const claimed = grammarActionOf(golden.text, now);
    if (key === 'none' ? claimed !== undefined : claimed === key) slot.claimed += 1;
  }
  return result;
}

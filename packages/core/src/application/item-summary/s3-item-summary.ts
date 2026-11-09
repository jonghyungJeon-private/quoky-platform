import { Capability } from '../../domain';
import { flowLabel, joinFlowLabels, type FlowLabel } from '../../domain/flow-label';
import type { AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { LogFields } from '../../ports/logger.port';
import type { ProviderSelectionContext } from '../../ports/provider-selection-policy.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';
import {
  chunk,
  computeCoverage,
  packWindows,
  passageAuditView,
  renderCoverageLine,
  selectStratified,
  singleWindow,
  windowReadout,
  type ChunkSection,
  type Coverage,
  type Passage,
  type Window,
} from '../chunking';
import { generalChatReplyPolicy } from '../chat-policy/chat-response-policy';
import { containsCredentialFileContent, containsCredentialMaterial } from '../credential-guard';
import { checkDocumentSummaryClaims, renderDocumentSummaryTooLong } from '../document-summary-claim-check';
import { isRequiredLocalDispatchAllowed, selectRequiredLocalProvider, withRequiredLocal } from '../local-provider-dispatch';
import { composeDocumentSummaryPrompt } from '../prompt-composer';
import { PromptRenderer } from '../prompt-renderer';
import {
  UNTRUSTED_DOCUMENT_BODY_MAX_CHARS,
  UNTRUSTED_DOCUMENT_READOUT_KIND,
  buildUntrustedDocumentReadout,
  isSummarizableDocumentReadout,
  isUntrustedTextCredentialShaped,
  renderUntrustedDocumentHistoryNote,
  type UntrustedDocumentReadout,
  type UntrustedDocumentSource,
} from '../untrusted-document-readout';
import { DOCUMENT_MAP_PROMPT_VERSION, buildDocumentMapRequest, parseDocumentMapNote } from './document-map-prompt';

/**
 * ADR-0124 Part L, slice C5a: S3, the whole-item summary of ONE long item, arm L (every model call on a `LOCAL`
 * `SUMMARIZATION` provider). DECISIONS ADR-0124 sections 3.6, 3.7, 4 and 17. Core, UNWIRED: no handler calls it yet.
 *
 * - **Mode.** `off` does nothing. `shadow` chunks and selects, logs counts only, makes no model call and leaves the reply to
 *   today's path. `on` runs the map-reduce. The mode comes from `QUOKY_CHUNK_ITEMS`, never from the content.
 * - **Guard first (N4).** The full item goes through today's builder guard (`buildUntrustedDocumentReadout`, both credential
 *   detectors on every full field before any split); a match anywhere refuses the whole item, never redacted.
 * - **S1.** An item that fits one window is `S1`: the caller keeps today's path, byte for byte.
 * - **Selection by position only (RQ-2 I2).** The whole item when it packs into at most {@link S3_LIMITS}.maxWindows windows,
 *   else `selectStratified(…, maxWindows)`. W, the locality and the number of calls never depend on the content.
 * - **Calls.** One map call per window (`document-map.v1`) and one reduce call (the existing document-summary prompt over the
 *   notes), strictly one at a time, at most {@link S3_LIMITS}.maxLocalCalls, each bounded to `callTimeoutMs` and all within
 *   `wallMs`. The provider is selected once with `requiredLocality: 'LOCAL'` and re-checked synchronously before every call.
 * - **No remote, no retry (owner decision 2, 2026-11-09).** No ready local provider at the start (selection bounded by the
 *   wall) is `today` (nothing was called). Once a call has been made, any breach (wall, per-call timeout, model failure,
 *   failed locality re-check, a rejected note, a map or reduce guard, a throwing dependency) ends in a deterministic partial
 *   reply from the notes already finished plus the coverage line. A throw before any call is `today: 'not-ready'`.
 * - **Notes.** Each map answer passes the note guard (`parseDocumentMapNote`); a note is `UNTRUSTED` + `MODEL_DERIVED` with the
 *   item's label joined with `LOCAL_MODEL_ONLY` (never widened). A rejected note stops the run (partial reply).
 * - **Claim checks (ADR-0104 D1, ADR-0118 D8).** The model-derived text of a summary or a partial reply passes today's
 *   `checkDocumentSummaryClaims`; a claim (or an over-long text) replaces it by the fixed notice, with no regeneration.
 * - **N1 / content-free.** Nothing is stored; passages, windows and notes live in this call only. The log line and the audit
 *   carry counts and timings only (`passageAuditView` totals, W, read, calls, milliseconds), never text, a frame or a note.
 */

export type ChunkItemsMode = 'off' | 'shadow' | 'on';
export const CHUNK_ITEMS_MODES: readonly ChunkItemsMode[] = Object.freeze(['off', 'shadow', 'on'] as const);

/** `QUOKY_CHUNK_ITEMS`: unset is `off`; exactly `off`, `shadow` or `on`; anything else is `undefined` (refused at startup). */
export function parseChunkItemsMode(raw: string | undefined): ChunkItemsMode | undefined {
  if (raw === undefined) return 'off';
  return (CHUNK_ITEMS_MODES as readonly string[]).includes(raw) ? (raw as ChunkItemsMode) : undefined;
}

/** Section 3.7 bounds (ratified 2026-11-02; CH5 thresholds ratified 2026-11-09). */
export const S3_LIMITS = Object.freeze({ maxWindows: 6, maxLocalCalls: 7, callTimeoutMs: 20_000, wallMs: 90_000 });

export interface S3ItemSummaryInput {
  readonly mode: ChunkItemsMode;
  readonly source: UntrustedDocumentSource;
  readonly title: string;
  readonly author: string;
  readonly date: string;
  /** The prepared item (the chunker's contract: normalized, link-neutralized). Guarded again here in full. */
  readonly prepared: string;
  /** Quoky's own sections tiling `prepared` (thread messages, sheets). */
  readonly sections?: readonly ChunkSection[];
  /** The source already cut the item (its 256 KiB bound). */
  readonly sourceTruncated?: boolean;
  /** The owner's request text: the reply-language fact of both prompts and the reduce prompt's task. */
  readonly requestText: string;
  /** The language of the Core lines (coverage, partial lead, history note). */
  readonly language: 'ko' | 'en';
  /** The item's flow label; default `UNTRUSTED`, `REMOTE_ON_SUMMARY_REQUEST`, `OWNER_DM_ONLY`. */
  readonly label?: FlowLabel;
}

export interface S3ItemSummaryDeps {
  /** The existing selection port; the pipeline adds `requiredLocality: 'LOCAL'` and never trusts the answer. */
  readonly selector: ProviderSelector;
  /** The base selection context (session, actor); `requiredLocality` is always set by the pipeline. */
  readonly selectionContext?: ProviderSelectionContext;
  /** Monotonic milliseconds (the injected clock). */
  readonly now: () => number;
  /** Resolves after `ms` (or when `signal` aborts). Default: `setTimeout`. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * The single-in-flight local model gate (one local model call at a time across requests, embedding included: RQ-3 T3-5).
   * Wired with the handlers in slice 2; absent, the calls of this request still run strictly one after another.
   */
  readonly exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Counts only. */
  readonly logger?: { info(message: string, fields?: LogFields): void };
}

export type S3PartialReason =
  | 'wall'
  | 'call-timeout'
  | 'model'
  | 'locality'
  | 'call-bound'
  | 'no-notes'
  | 'map-guard'
  | 'note-guard'
  | 'reduce-guard'
  | 'reduce-empty'
  | 'internal';

/** Counts and timings only. */
export interface S3Audit {
  readonly promptVersion: typeof DOCUMENT_MAP_PROMPT_VERSION;
  readonly passages: number;
  readonly codePoints: number;
  readonly estTokens: number;
  readonly windows: number;
  readonly stratified: boolean;
  readonly selected: number;
  readonly read: number;
  readonly mapCalls: number;
  readonly reduceCalls: number;
  readonly notesRejected: number;
  readonly linesDropped: number;
  readonly callMs: readonly number[];
  readonly wallMs: number;
  readonly locality: 'LOCAL';
}

interface S3Delivered {
  /** The reply text: `body`, a blank line, then `coverageLine`. */
  readonly text: string;
  /** The summary (or the partial reply's lead and notes) without the coverage line. */
  readonly body: string;
  /** Core's fixed coverage line (N5), rendered from counts after the model output. */
  readonly coverageLine: string;
  readonly coverage: Coverage;
  /** The fixed history note (the history never keeps summary or chunk text). */
  readonly historyNote: string;
  readonly audit: S3Audit;
  /** The model-derived text was replaced by today's fixed notice (`checkDocumentSummaryClaims`; no regeneration). */
  readonly withheld?: 'claim' | 'too-long';
}

export type S3ItemSummaryOutcome =
  /** The caller runs today's path untouched: the flag is not `on`, or no ready LOCAL provider at the start (no call made). */
  | { readonly kind: 'today'; readonly reason: 'off' | 'shadow' | 'not-ready' | 'not-chunkable' }
  /** The item fits one window: today's path, byte for byte. */
  | { readonly kind: 'S1' }
  /** As today: the whole item is refused, nothing is sent. */
  | { readonly kind: 'refused'; readonly reason: 'credential' | 'empty' }
  | ({ readonly kind: 'summary' } & S3Delivered)
  | ({ readonly kind: 'partial'; readonly reason: S3PartialReason } & S3Delivered);

/** A note's label (ADR-0124 N7, ADR-0121 D3/D4): untrusted, model-derived, the item's label never widened. */
type NoteLabel = FlowLabel & { readonly trust: 'UNTRUSTED'; readonly derivation: 'MODEL_DERIVED' };

/** One finished, guarded map note. */
interface Note {
  readonly window: number;
  readonly ordinals: readonly number[];
  readonly lines: readonly string[];
  readonly label: NoteLabel;
}

const PARTIAL_LEAD = {
  ko: '긴 문서를 끝까지 요약하지 못해, 읽은 구간에서 정리한 내용을 보여드려요.',
  en: 'I could not finish summarizing this long item, so here are the notes from the parts I read.',
} as const;
const NOTHING_READ = {
  ko: '긴 문서를 이 기기에서 요약하지 못했어요.',
  en: 'I could not summarize this long item on this device.',
} as const;

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function passageTotals(passages: readonly Passage[]): { readonly codePoints: number; readonly estTokens: number } {
  let codePoints = 0;
  let estTokens = 0;
  for (const passage of passages) {
    const view = passageAuditView(passage);
    codePoints += view.codePoints;
    estTokens += view.estTokens;
  }
  return { codePoints, estTokens };
}

/** Whole notes lines under `[Part i/W]` frames, each note within its fair share of the readout bound. */
function notesBody(notes: readonly Note[], windows: number): string {
  const separator = '\n\n';
  const share = Math.floor((UNTRUSTED_DOCUMENT_BODY_MAX_CHARS - separator.length * Math.max(0, notes.length - 1)) / Math.max(1, notes.length));
  const parts: string[] = [];
  for (const note of notes) {
    let part = `[Part ${note.window + 1}/${windows}]`;
    for (const line of note.lines) {
      const next = `${part}\n${line}`;
      if (Array.from(next).length > share) break;
      part = next;
    }
    parts.push(part);
  }
  return parts.join(separator);
}


type CallResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'wall' | 'call-timeout' | 'model' | 'locality' | 'call-bound' };

/** What the outer guard needs when a dependency throws: whether a call was made, how to abort it, how to end. */
interface RunState {
  calls: number;
  total: number;
  abort?: () => void;
  partial?: (reason: S3PartialReason) => S3ItemSummaryOutcome;
}

/**
 * Run ONE S3 request. Total: never throws. A throwing dependency (the clock, the timer, the gate, the selector) before any
 * model call is `today: 'not-ready'` (nothing was sent); after one, a partial reply (never today's remote path).
 */
export async function runS3ItemSummary(input: S3ItemSummaryInput, deps: S3ItemSummaryDeps): Promise<S3ItemSummaryOutcome> {
  if (input.mode !== 'shadow' && input.mode !== 'on') return { kind: 'today', reason: 'off' };
  const state: RunState = { calls: 0, total: 0 };
  try {
    return await run(input, deps, state);
  } catch {
    try {
      state.abort?.();
    } catch {
      // Aborting is best effort.
    }
    if (state.calls === 0) return { kind: 'today', reason: 'not-ready' };
    if (state.partial !== undefined) {
      try {
        return state.partial('internal');
      } catch {
        // Fall through to the last-resort partial reply.
      }
    }
    return lastResortPartial(input, state.total);
  }
}

/** The partial reply when even the ordinary one could not be built: the fixed notice and a 0-read coverage line. */
function lastResortPartial(input: S3ItemSummaryInput, total: number): S3ItemSummaryOutcome {
  const coverage: Coverage = { total, read: 0, complete: false, codePointsTotal: 0, codePointsRead: 0 };
  const coverageLine = renderCoverageLine(coverage, input.language);
  const body = NOTHING_READ[input.language];
  return {
    kind: 'partial',
    reason: 'internal',
    text: `${body}\n\n${coverageLine}`,
    body,
    coverageLine,
    coverage,
    historyNote: renderUntrustedDocumentHistoryNote(input.source, input.language),
    audit: {
      promptVersion: DOCUMENT_MAP_PROMPT_VERSION,
      passages: total,
      codePoints: 0,
      estTokens: 0,
      windows: 0,
      stratified: false,
      selected: 0,
      read: 0,
      mapCalls: 0,
      reduceCalls: 0,
      notesRejected: 0,
      linesDropped: 0,
      callMs: [],
      wallMs: 0,
      locality: 'LOCAL',
    },
  };
}

function hasCredential(text: string): boolean {
  return containsCredentialMaterial(text) || containsCredentialFileContent(text) || isUntrustedTextCredentialShaped(text);
}

async function run(input: S3ItemSummaryInput, deps: S3ItemSummaryDeps, state: RunState): Promise<S3ItemSummaryOutcome> {
  // The 90 s wall starts here, before the guard, the chunker and the provider selection.
  let lastNow = 0;
  const clock = (): number => {
    const value = deps.now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('clock');
    lastNow = value;
    return value;
  };
  const wallStart = clock();
  const log = (fields: LogFields): void => {
    try {
      deps.logger?.info('item_summary.s3', { mode: input.mode, source: input.source, ...fields });
    } catch {
      // A logger never changes the outcome.
    }
  };

  // N4: today's full-item guard, before any split; then both detectors on the exact text the chunker reads and on Quoky's
  // own section frames (a frame is read into a window, so a credential in a frame refuses the whole item too).
  const built = buildUntrustedDocumentReadout({
    source: input.source,
    title: input.title,
    author: input.author,
    date: input.date,
    body: input.prepared,
    ...(input.sourceTruncated === true ? { sourceTruncated: true } : {}),
  });
  if (!built.ok) return { kind: 'refused', reason: built.refusal === 'EMPTY' ? 'empty' : 'credential' };
  const frames = (input.sections ?? []).map((section) => (typeof section?.frame === 'string' ? section.frame : '')).join('\n');
  if (hasCredential(input.prepared) || (frames.length > 0 && hasCredential(frames))) return { kind: 'refused', reason: 'credential' };
  const meta = { source: input.source, title: built.readout.title, author: built.readout.author, date: built.readout.date };

  let passages: Passage[];
  try {
    passages = chunk(input.prepared, input.sections);
  } catch {
    // Pre-start fallback (decision 2): sections that do not tile the text; no local call has started.
    return { kind: 'today', reason: 'not-chunkable' };
  }
  state.total = passages.length;
  const totals = passageTotals(passages);
  if (singleWindow(input.prepared, passages) !== undefined) {
    log({ outcome: 'S1', passages: passages.length, codePoints: totals.codePoints, estTokens: totals.estTokens, windows: 1 });
    return { kind: 'S1' };
  }

  // Position only (I2): every passage when it packs into the cap, else stratified coverage.
  const all = passages.map((passage) => passage.ordinal);
  let selected = all;
  let windows: Window[] = packWindows(input.prepared, passages, all);
  const stratified = windows.length > S3_LIMITS.maxWindows;
  if (stratified) {
    selected = selectStratified(input.prepared, passages, S3_LIMITS.maxWindows);
    windows = packWindows(input.prepared, passages, selected);
  }
  windows = windows.slice(0, S3_LIMITS.maxWindows);
  const W = windows.length;
  const counts = { passages: passages.length, codePoints: totals.codePoints, estTokens: totals.estTokens, windows: W, stratified, selected: selected.length };

  if (input.mode === 'shadow') {
    log({ outcome: 'shadow', ...counts });
    return { kind: 'today', reason: 'shadow' };
  }

  const capability = Capability.SUMMARIZATION;
  const context = withRequiredLocal(deps.selectionContext ?? {});
  const wait = deps.wait ?? defaultWait;

  // Selection is bounded by what is left of the wall: a stalled readiness probe is `not-ready` (no call was made).
  const selectionTimer = new AbortController();
  state.abort = () => selectionTimer.abort();
  const selectionBudget = S3_LIMITS.wallMs - (clock() - wallStart);
  const selection =
    selectionBudget <= 0
      ? ({ kind: 'not-ready' } as const)
      : await Promise.race([
          selectRequiredLocalProvider(deps.selector, capability, context),
          wait(selectionBudget, selectionTimer.signal).then(() => ({ kind: 'not-ready' }) as const),
        ]);
  selectionTimer.abort();
  state.abort = undefined;
  if (selection.kind !== 'selected') {
    log({ outcome: 'not-ready', ...counts });
    return { kind: 'today', reason: 'not-ready' };
  }
  const provider: AiProvider = selection.provider;
  const callMs: number[] = [];

  const callLocal = async (request: AiRequest): Promise<CallResult> => {
    const startedAt = clock();
    const remainingWall = S3_LIMITS.wallMs - (startedAt - wallStart);
    if (remainingWall <= 0) return { ok: false, reason: 'wall' };
    if (state.calls >= S3_LIMITS.maxLocalCalls) return { ok: false, reason: 'call-bound' };
    const budget = Math.min(S3_LIMITS.callTimeoutMs, remainingWall);
    const overrun: 'wall' | 'call-timeout' = budget < S3_LIMITS.callTimeoutMs ? 'wall' : 'call-timeout';
    const call = new AbortController();
    const timer = new AbortController();
    state.abort = () => {
      call.abort();
      timer.abort();
    };
    type Settled = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'locality' | 'aborted' | 'error' | 'timeout' };
    const work = async (): Promise<Settled> => {
      if (call.signal.aborted) return { kind: 'aborted' };
      // The dispatch-time check: synchronous, immediately before `execute`, nothing awaited in between.
      if (!isRequiredLocalDispatchAllowed(deps.selector, capability, context, provider)) return { kind: 'locality' };
      state.calls += 1;
      const result = await provider.execute({ ...request, timeoutMs: budget, signal: call.signal });
      return { kind: 'text', text: typeof result?.text === 'string' ? result.text : '' };
    };
    // A gate that throws synchronously propagates to the outer guard (before any call: today; after one: partial).
    const running: Promise<Settled> = (deps.exclusive !== undefined ? deps.exclusive(work) : work()).then(
      (value) => value,
      (): Settled => ({ kind: 'error' }),
    );
    const settled = await Promise.race([running, wait(budget, timer.signal).then((): Settled => ({ kind: 'timeout' }))]);
    timer.abort();
    const elapsed = Math.max(0, clock() - startedAt);
    state.abort = undefined;
    if (settled.kind === 'timeout' || settled.kind === 'aborted') {
      call.abort();
      callMs.push(elapsed);
      return { ok: false, reason: overrun };
    }
    if (settled.kind === 'locality') return { ok: false, reason: 'locality' };
    callMs.push(elapsed);
    if (settled.kind !== 'text') return { ok: false, reason: 'model' };
    // An answer that came back after its bound is discarded (deterministic under the injected clock).
    if (elapsed > budget) return { ok: false, reason: overrun };
    return { ok: true, text: settled.text };
  };

  const itemLabel = input.label ?? flowLabel('UNTRUSTED', 'REMOTE_ON_SUMMARY_REQUEST', 'OWNER_DM_ONLY', [input.source]);
  const noteLabel: NoteLabel = {
    ...joinFlowLabels(itemLabel, flowLabel('UNTRUSTED', 'LOCAL_MODEL_ONLY', 'WORK_CHANNEL_OK', [])),
    trust: 'UNTRUSTED',
    derivation: 'MODEL_DERIVED',
  };
  const notes: Note[] = [];
  let notesRejected = 0;
  let linesDropped = 0;
  let mapCalls = 0;
  let reduceCalls = 0;
  const historyNote = renderUntrustedDocumentHistoryNote(input.source, input.language);

  const audit = (coverage: Coverage): S3Audit => {
    let now = lastNow;
    try {
      now = clock();
    } catch {
      // The audit keeps the last reading of a clock that failed.
    }
    return {
      promptVersion: DOCUMENT_MAP_PROMPT_VERSION,
      passages: passages.length,
      codePoints: totals.codePoints,
      estTokens: totals.estTokens,
      windows: W,
      stratified,
      selected: selected.length,
      read: coverage.read,
      mapCalls,
      reduceCalls,
      notesRejected,
      linesDropped,
      callMs: [...callMs],
      wallMs: Math.max(0, now - wallStart),
      locality: 'LOCAL',
    };
  };
  // ADR-0104 D1 / ADR-0118 D8: today's claim checks on the model-derived text; a claim is the fixed notice (no regeneration).
  const claimChecked = (modelText: string): { readonly text: string; readonly withheld?: 'claim' | 'too-long' } => {
    const verdict = checkDocumentSummaryClaims(modelText, input.requestText, input.source, input.language, generalChatReplyPolicy(input.requestText));
    if (verdict.kind === 'clean') return { text: modelText };
    if (verdict.kind === 'claim') return { text: verdict.notice, withheld: 'claim' };
    return { text: renderDocumentSummaryTooLong(input.language), withheld: 'too-long' };
  };
  const finish = (
    kind: 'summary' | 'partial',
    reason: S3PartialReason | undefined,
    body: string,
    withheld: 'claim' | 'too-long' | undefined,
  ): S3ItemSummaryOutcome => {
    const coverage = computeCoverage(passages, notes.flatMap((note) => note.ordinals));
    const coverageLine = renderCoverageLine(coverage, input.language);
    const a = audit(coverage);
    log({
      outcome: kind,
      ...(reason !== undefined ? { reason } : {}),
      ...(withheld !== undefined ? { withheld } : {}),
      ...counts,
      read: a.read,
      mapCalls: a.mapCalls,
      reduceCalls: a.reduceCalls,
      notesRejected: a.notesRejected,
      linesDropped: a.linesDropped,
      callMsTotal: a.callMs.reduce((sum, ms) => sum + ms, 0),
      callMsMax: a.callMs.reduce((max, ms) => Math.max(max, ms), 0),
      wallMs: a.wallMs,
    });
    const delivered = { text: `${body}\n\n${coverageLine}`, body, coverageLine, coverage, historyNote, audit: a, ...(withheld !== undefined ? { withheld } : {}) };
    return kind === 'summary' ? { kind: 'summary', ...delivered } : { kind: 'partial', reason: reason ?? 'internal', ...delivered };
  };
  const partial = (reason: S3PartialReason): S3ItemSummaryOutcome => {
    if (notes.length === 0) return finish('partial', reason, NOTHING_READ[input.language], undefined);
    const checked = claimChecked(notes.map((note) => note.lines.join('\n')).join('\n\n'));
    const body = checked.withheld !== undefined ? checked.text : `${PARTIAL_LEAD[input.language]}\n\n${checked.text}`;
    return finish('partial', reason, body, checked.withheld);
  };
  state.partial = partial;

  for (let index = 0; index < W; index += 1) {
    const window = windows[index] as Window;
    const readout = windowReadout(window, meta, true);
    if (readout === undefined) {
      // The window is not sendable (the readout guard): no call, unread in the coverage line (readout.ts contract).
      notesRejected += 1;
      continue;
    }
    const request = buildDocumentMapRequest(readout, { index: index + 1, count: W }, input.requestText, S3_LIMITS.callTimeoutMs);
    // N4: both detectors again on the exact rendered map prompt.
    if (containsCredentialMaterial(request.prompt) || containsCredentialFileContent(request.prompt)) return partial('map-guard');
    const before = state.calls;
    const result = await callLocal(request);
    mapCalls += state.calls - before;
    if (!result.ok) return partial(result.reason);
    const parsed = parseDocumentMapNote(result.text, input.source);
    if (!parsed.ok) {
      // A rejected note stops the run: the partial reply from the notes already finished (Codex P2e).
      notesRejected += 1;
      return partial('note-guard');
    }
    linesDropped += parsed.dropped;
    notes.push({ window: index, ordinals: window.ordinals, lines: parsed.lines, label: noteLabel });
  }
  if (notes.length === 0) return partial('no-notes');

  // The reduce: the existing document-summary prompt over ONE readout whose body is the notes (UNTRUSTED + MODEL_DERIVED).
  // `truncated` is false (CA P2a): coverage is stated only by Core's coverage line (N5), never by the model.
  const notesReadout: UntrustedDocumentReadout = {
    kind: UNTRUSTED_DOCUMENT_READOUT_KIND,
    ...meta,
    body: notesBody(notes, W),
    truncated: false,
  };
  if (!isSummarizableDocumentReadout(notesReadout)) return partial('reduce-guard');
  const reduceRequest = new PromptRenderer().render(composeDocumentSummaryPrompt(input.requestText, notesReadout), {
    capability,
    timeoutMs: S3_LIMITS.callTimeoutMs,
  });
  if (containsCredentialMaterial(reduceRequest.prompt) || containsCredentialFileContent(reduceRequest.prompt)) return partial('reduce-guard');
  const before = state.calls;
  const reduced = await callLocal(reduceRequest);
  reduceCalls += state.calls - before;
  if (!reduced.ok) return partial(reduced.reason);
  const summary = reduced.text.trim();
  if (summary.length === 0) return partial('reduce-empty');
  if (containsCredentialMaterial(summary) || containsCredentialFileContent(summary)) return partial('reduce-guard');
  const checked = claimChecked(summary);
  return finish('summary', undefined, checked.text, checked.withheld);
}

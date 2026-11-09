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
import { containsCredentialFileContent, containsCredentialMaterial } from '../credential-guard';
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
 * - **No remote, no retry (owner decision 2, 2026-11-09).** No ready local provider at the start is `today` (nothing was
 *   called). Once a call has been made, any breach (wall, per-call timeout, model failure, failed locality re-check, a reduce
 *   guard) ends in a deterministic partial reply from the notes already finished plus the coverage line.
 * - **Notes.** Each map answer passes the note guard (`parseDocumentMapNote`); a note is `UNTRUSTED` + `MODEL_DERIVED` with the
 *   item's label joined with `LOCAL_MODEL_ONLY` (never widened). A failed note is unread and the coverage line says so.
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

export type S3PartialReason = 'wall' | 'call-timeout' | 'model' | 'locality' | 'call-bound' | 'no-notes' | 'reduce-guard' | 'reduce-empty';

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

/** Run ONE S3 request. Total: never throws. */
export async function runS3ItemSummary(input: S3ItemSummaryInput, deps: S3ItemSummaryDeps): Promise<S3ItemSummaryOutcome> {
  if (input.mode !== 'shadow' && input.mode !== 'on') return { kind: 'today', reason: 'off' };
  const wallStart = deps.now();
  const log = (fields: LogFields): void => {
    try {
      deps.logger?.info('item_summary.s3', { mode: input.mode, source: input.source, ...fields });
    } catch {
      // A logger never changes the outcome.
    }
  };

  // N4: today's full-item guard, before any split; then both detectors on the exact text the chunker reads.
  const built = buildUntrustedDocumentReadout({
    source: input.source,
    title: input.title,
    author: input.author,
    date: input.date,
    body: input.prepared,
    ...(input.sourceTruncated === true ? { sourceTruncated: true } : {}),
  });
  if (!built.ok) return { kind: 'refused', reason: built.refusal === 'EMPTY' ? 'empty' : 'credential' };
  if (containsCredentialMaterial(input.prepared) || containsCredentialFileContent(input.prepared) || isUntrustedTextCredentialShaped(input.prepared)) {
    return { kind: 'refused', reason: 'credential' };
  }
  const meta = { source: input.source, title: built.readout.title, author: built.readout.author, date: built.readout.date };

  let passages: Passage[];
  try {
    passages = chunk(input.prepared, input.sections);
  } catch {
    return { kind: 'today', reason: 'not-chunkable' };
  }
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
  const selection = await selectRequiredLocalProvider(deps.selector, capability, context);
  if (selection.kind !== 'selected') {
    log({ outcome: 'not-ready', ...counts });
    return { kind: 'today', reason: 'not-ready' };
  }
  const provider: AiProvider = selection.provider;
  const wait = deps.wait ?? defaultWait;
  const callMs: number[] = [];
  let calls = 0;

  const callLocal = async (request: AiRequest): Promise<CallResult> => {
    const startedAt = deps.now();
    const remainingWall = S3_LIMITS.wallMs - (startedAt - wallStart);
    if (remainingWall <= 0) return { ok: false, reason: 'wall' };
    if (calls >= S3_LIMITS.maxLocalCalls) return { ok: false, reason: 'call-bound' };
    const budget = Math.min(S3_LIMITS.callTimeoutMs, remainingWall);
    const overrun: 'wall' | 'call-timeout' = budget < S3_LIMITS.callTimeoutMs ? 'wall' : 'call-timeout';
    const call = new AbortController();
    const timer = new AbortController();
    type Settled = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'locality' | 'aborted' | 'error' | 'timeout' };
    const work = async (): Promise<Settled> => {
      if (call.signal.aborted) return { kind: 'aborted' };
      // The dispatch-time check: synchronous, immediately before `execute`, nothing awaited in between.
      if (!isRequiredLocalDispatchAllowed(deps.selector, capability, context, provider)) return { kind: 'locality' };
      calls += 1;
      const result = await provider.execute({ ...request, timeoutMs: budget, signal: call.signal });
      return { kind: 'text', text: typeof result?.text === 'string' ? result.text : '' };
    };
    let running: Promise<Settled>;
    try {
      running = (deps.exclusive !== undefined ? deps.exclusive(work) : work()).then(
        (value) => value,
        (): Settled => ({ kind: 'error' }),
      );
    } catch {
      running = Promise.resolve({ kind: 'error' });
    }
    const settled = await Promise.race([running, wait(budget, timer.signal).then((): Settled => ({ kind: 'timeout' }))]);
    timer.abort();
    const elapsed = Math.max(0, deps.now() - startedAt);
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
  let breach: S3PartialReason | undefined;

  for (let index = 0; index < W; index += 1) {
    const window = windows[index] as Window;
    const readout = windowReadout(window, meta, true);
    if (readout === undefined) {
      notesRejected += 1;
      continue;
    }
    const request = buildDocumentMapRequest(readout, { index: index + 1, count: W }, input.requestText, S3_LIMITS.callTimeoutMs);
    const before = calls;
    const result = await callLocal(request);
    mapCalls += calls - before;
    if (!result.ok) {
      breach = result.reason;
      break;
    }
    const parsed = parseDocumentMapNote(result.text, input.source);
    if (!parsed.ok) {
      notesRejected += 1;
      continue;
    }
    linesDropped += parsed.dropped;
    notes.push({ window: index, ordinals: window.ordinals, lines: parsed.lines, label: noteLabel });
  }

  const coverage = computeCoverage(passages, notes.flatMap((note) => note.ordinals));
  const coverageLine = renderCoverageLine(coverage, input.language);
  const historyNote = renderUntrustedDocumentHistoryNote(input.source, input.language);
  const audit = (): S3Audit => ({
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
    wallMs: Math.max(0, deps.now() - wallStart),
    locality: 'LOCAL',
  });
  const finish = (outcome: Extract<S3ItemSummaryOutcome, { readonly kind: 'summary' | 'partial' }>): S3ItemSummaryOutcome => {
    const a = outcome.audit;
    log({
      outcome: outcome.kind,
      ...(outcome.kind === 'partial' ? { reason: outcome.reason } : {}),
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
    return outcome;
  };
  const partial = (reason: S3PartialReason): S3ItemSummaryOutcome => {
    const body =
      notes.length === 0 ? NOTHING_READ[input.language] : [PARTIAL_LEAD[input.language], ...notes.map((note) => note.lines.join('\n'))].join('\n\n');
    return finish({ kind: 'partial', reason, text: `${body}\n\n${coverageLine}`, body, coverageLine, coverage, historyNote, audit: audit() });
  };

  if (breach !== undefined) return partial(breach);
  if (notes.length === 0) return partial('no-notes');

  // The reduce: the existing document-summary prompt over ONE readout whose body is the notes (UNTRUSTED + MODEL_DERIVED).
  const notesReadout: UntrustedDocumentReadout = {
    kind: UNTRUSTED_DOCUMENT_READOUT_KIND,
    ...meta,
    body: notesBody(notes, W),
    truncated: !coverage.complete || input.sourceTruncated === true,
  };
  if (!isSummarizableDocumentReadout(notesReadout)) return partial('reduce-guard');
  const reduceRequest = new PromptRenderer().render(composeDocumentSummaryPrompt(input.requestText, notesReadout), {
    capability,
    timeoutMs: S3_LIMITS.callTimeoutMs,
  });
  if (containsCredentialMaterial(reduceRequest.prompt) || containsCredentialFileContent(reduceRequest.prompt)) return partial('reduce-guard');
  const before = calls;
  const reduced = await callLocal(reduceRequest);
  reduceCalls += calls - before;
  if (!reduced.ok) return partial(reduced.reason);
  const summary = reduced.text.trim();
  if (summary.length === 0) return partial('reduce-empty');
  if (containsCredentialMaterial(summary) || containsCredentialFileContent(summary)) return partial('reduce-guard');
  return finish({ kind: 'summary', text: `${summary}\n\n${coverageLine}`, body: summary, coverageLine, coverage, historyNote, audit: audit() });
}

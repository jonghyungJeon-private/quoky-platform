import { joinFlowLabels, type FlowLabel } from '../../domain/flow-label';
import type { Logger } from '../../ports/logger.port';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { containsCredentialFileContent, containsCredentialMaterial } from '../credential-guard';
import { containsDocumentActionClaim } from '../document-summary-claim-guard';
import { containsLink, neutralizeLinks } from '../link-neutralizer';
import type { AgentRunResult } from './plan-executor';
import { agentReplyNotes, type AgentNoteLanguage, type AgentStepCount, type AgentStepsPlan } from './reply-notes';
import { AGENT_SUMMARY_READOUT_SOURCE, summaryEntriesForAssembler, type QuarantinedListingOnlyReason } from './quarantined-summary';
import type { StructureProjection } from './structure-projector';

/**
 * ADR-0121 D3/D4 (stage S2 P3-3b): the deterministic reply assembler. Core, offline, unwired. Pure: the same run result
 * gives the same text, byte for byte; no clock, no randomness, no I/O.
 *
 * - **Core facts first.** One fact line per read step from the typed result (count, "more" flag, and the closed-format ids of
 *   a field a person reads: Jira keys), then the fixed notes of `reply-notes.ts`, then the model's summaries, then the fixed
 *   status lines (listing only, a bound that stopped the run). Nothing before the summaries is model output.
 * - **The summaries are the only M2 text.** They come from {@link QuarantinedSummary} through
 *   {@link summaryEntriesForAssembler} (this file is the only reader), pass the link neutralizer and the credential guard
 *   a second time (defence in depth: a line that still fails, or that claims an action Quoky did, is dropped, never repaired), are marked as model-written, and are
 *   returned as their own `summary` parts so a platform layer can render them inside an untrusted span. No URL comes from a
 *   model: a line that would still hold a link is dropped.
 * - **Scope (D4/D5).** Agent runs happen in the owner's DM only: for any other destination the reply is one fixed refusal
 *   line and nothing of the content, whatever the label.
 * - **Disclosure.** When a summary was made by a `REMOTE` model, one fixed line says part of the text was sent to an outside model.
 * - **Rendering input.** `parts` is the only rendering input; `text` is those parts joined and is for logs and plain-text sinks.
 * - **Content-free log.** One `agent_run.assemble` line: counters only.
 */

export const AGENT_ASSEMBLE_LOG_EVENT = 'agent_run.assemble';

export type AgentReplyPartKind = 'fact' | 'note' | 'summary' | 'status';

export interface AgentReplyPart {
  readonly kind: AgentReplyPartKind;
  readonly text: string;
}

export interface AssembleAgentReplyInput {
  readonly plan: AgentStepsPlan;
  readonly result: AgentRunResult;
  readonly language: AgentNoteLanguage;
  /** The reply goes to the owner's DM (agent runs happen there only; D5). */
  readonly destinationIsOwnerDm: boolean;
  readonly logger?: Logger;
}

export interface AssembledAgentReply {
  /** The parts joined by newlines (derived from {@link parts}, which is the only rendering input). */
  readonly text: string;
  readonly parts: readonly AgentReplyPart[];
  /** The join of every read's label, and of every summary's label (a summary is `UNTRUSTED`). */
  readonly label: FlowLabel;
  /** Summary lines shown / dropped by the second guard. */
  readonly summaryLines: number;
  readonly droppedLines: number;
}

/** Fields whose closed-format ids a person reads (a Jira issue key). Every other id field stays out of the text. */
const DISPLAY_ID_FIELDS: readonly string[] = ['issueKeys'];

const NOUN: Readonly<Record<NlWave1EntryId, { readonly ko: string; readonly en: string }>> = {
  'jira.issues': { ko: '지라 이슈', en: 'Jira issues' },
  'jira.release': { ko: '릴리스', en: 'Releases' },
  'github.items': { ko: '깃허브 항목', en: 'GitHub items' },
  'slack.search': { ko: '슬랙 메시지', en: 'Slack messages' },
  'confluence.search': { ko: '컨플루언스 문서', en: 'Confluence pages' },
  'calendar.events': { ko: '일정', en: 'Events' },
  'mail.list': { ko: '메일', en: 'Mail' },
  'drive.files': { ko: '드라이브 파일', en: 'Drive files' },
  'todo.list': { ko: '할 일', en: 'To-dos' },
  'reminder.list': { ko: '알림', en: 'Reminders' },
  'brief.today': { ko: '브리핑', en: 'Brief' },
  'help.topic': { ko: '도움말', en: 'Help' },
};

const T = {
  ko: {
    count: (noun: string, n: number, more: boolean) => `• ${noun}: ${n}개${more ? ' 이상' : ''}`,
    ids: (ids: string) => ` (${ids})`,
    failed: (noun: string) => `• ${noun}: 읽지 못했어요`,
    skipped: (noun: string) => `• ${noun}: 건너뛰었어요`,
    summaryHeader: '요약 (모델이 쓴 요약이에요. 원문과 다를 수 있어요)',
    summaryLine: (noun: string, position: number, text: string, topics: readonly string[]) => `${noun} ${position}번: ${text}${topics.length > 0 ? ` (주제: ${topics.join(', ')})` : ''}`,
    omitted: (n: number) => `요약에서 ${n}건은 제외했어요.`,
    listingOnly: {
      'host-only': '이 자료는 외부로 보낼 수 없어서 요약하지 않고 목록만 보여드려요.',
      'no-model': '이 자료를 보낼 수 있는 요약용 모델이 없어서 목록만 보여드려요.',
      'no-summary-grant': '요약 요청이 확인되지 않아서 원문은 읽지 않고 목록만 보여드려요.',
      'no-readout-source': '이 종류의 자료는 아직 요약하지 않고 목록만 보여드려요.',
      'work-text-controls-not-built': '업무 글 요약에 필요한 보호 장치가 아직 없어서 목록만 보여드려요.',
      'no-documents': '요약할 내용을 가져오지 못해서 목록만 보여드려요.',
      'credential-in-prompt': '요약할 자료에 민감한 정보가 있는 것 같아서 목록만 보여드려요.',
    } satisfies Record<QuarantinedListingOnlyReason, string>,
    summaryUnavailable: '요약을 보여드릴 수 없었어요.',
    remoteDisclosure: '이 요약을 만들려고 원문 일부를 외부 모델로 보냈어요.',
    summaryFailed: '요약을 만들지 못해서 목록만 보여드려요.',
    boundStopped: '한도에 도달해서 여기까지만 보여드려요.',
    dmOnly: '이 답은 소유자 DM에서만 보여드릴 수 있어요.',
  },
  en: {
    count: (noun: string, n: number, more: boolean) => `• ${noun}: ${n}${more ? '+' : ''}`,
    ids: (ids: string) => ` (${ids})`,
    failed: (noun: string) => `• ${noun}: could not be read`,
    skipped: (noun: string) => `• ${noun}: skipped`,
    summaryHeader: 'Summary (written by a model; it may differ from the original)',
    summaryLine: (noun: string, position: number, text: string, topics: readonly string[]) => `${noun} #${position}: ${text}${topics.length > 0 ? ` (topics: ${topics.join(', ')})` : ''}`,
    omitted: (n: number) => `${n} item${n === 1 ? ' was' : 's were'} left out of the summary.`,
    listingOnly: {
      'host-only': 'This material cannot leave the host, so there is no summary; this is the listing only.',
      'no-model': 'No summarizing model may receive this material, so this is the listing only.',
      'no-summary-grant': 'The summary request was not confirmed, so the content was not read; this is the listing only.',
      'no-readout-source': 'This kind of material is not summarized yet; this is the listing only.',
      'work-text-controls-not-built': 'The safeguards for summarizing work text are not built yet; this is the listing only.',
      'no-documents': 'The content to summarize could not be fetched; this is the listing only.',
      'credential-in-prompt': 'The material to summarize looked sensitive, so this is the listing only.',
    } satisfies Record<QuarantinedListingOnlyReason, string>,
    summaryUnavailable: 'A summary could not be shown.',
    remoteDisclosure: 'Part of the original text was sent to an outside model to make this summary.',
    summaryFailed: 'A summary could not be made, so this is the listing only.',
    boundStopped: 'A limit was reached, so this is as far as it goes.',
    dmOnly: 'This answer can only be shown in the owner\'s DM.',
  },
} as const;

/** Assemble the reply of one executed run. Pure and total. */
export function assembleAgentReply(input: AssembleAgentReplyInput): AssembledAgentReply {
  const { result, language } = input;
  const t = T[language];
  const readLabels = result.steps.flatMap((step) => (step.kind === 'read' && step.status === 'ok' ? [step.projection.label] : []));
  const parts: AgentReplyPart[] = [];
  let summaryLines = 0;
  let droppedLines = 0;

  // A summary with no stored content (a forged instance) is not a summary: it is ignored, label and all.
  const summaries = result.steps.flatMap((step) => (step.kind === 'summarize' && step.status === 'ok' && summaryEntriesForAssembler(step.summary) !== undefined ? [step] : []));
  const label = joinFlowLabels(...readLabels, ...summaries.map((step) => step.summary.label));

  // Agent runs are owner-DM only (D5): any other destination gets the fixed refusal, whatever the label says.
  if (!input.destinationIsOwnerDm) {
    parts.push({ kind: 'status', text: t.dmOnly });
    return finish(input, parts, label, 0, 0);
  }

  // 1. Core's facts, in step order.
  const counts = new Map<number, AgentStepCount>();
  for (const step of result.steps) {
    if (step.kind !== 'read') continue;
    const noun = NOUN[step.entryId][language];
    if (step.status === 'ok') {
      const more = step.hasMore || step.truncated;
      counts.set(step.step, { listed: step.projection.itemCount, shown: step.projection.itemCount, ...(more ? { listedAtLeast: true } : {}) });
      parts.push({ kind: 'fact', text: t.count(noun, step.projection.itemCount, more) + idsOf(step.projection, t.ids) });
    } else if (step.status === 'failed') parts.push({ kind: 'fact', text: t.failed(noun) });
    else parts.push({ kind: 'fact', text: t.skipped(noun) });
  }

  // 2. The fixed notes (detail cap, relation).
  for (const note of agentReplyNotes(input.plan, counts, language)) parts.push({ kind: 'note', text: note });

  // 3. The model's summaries, after every fact.
  let unavailable = false;
  let remote = false;
  for (const step of summaries) {
    const lines: string[] = [];
    for (const entry of summaryEntriesForAssembler(step.summary) ?? []) {
      const noun = NOUN[entry.entryId][language];
      const text = guarded(entry.text, entry.entryId);
      const topics = entry.topics.map((topic) => guarded(topic, entry.entryId));
      if (text === undefined || topics.some((topic) => topic === undefined)) {
        droppedLines += 1;
        continue;
      }
      lines.push(t.summaryLine(noun, entry.position, text, topics as string[]));
    }
    if (lines.length === 0) {
      unavailable = true;
    } else {
      parts.push({ kind: 'status', text: t.summaryHeader });
      for (const line of lines) parts.push({ kind: 'summary', text: line });
      summaryLines += lines.length;
      if (step.omitted > 0) parts.push({ kind: 'status', text: t.omitted(step.omitted) });
    }
    if (step.audit.locality === 'REMOTE') remote = true;
  }
  if (remote) parts.push({ kind: 'status', text: t.remoteDisclosure });

  // 4. Fixed status lines: no model call was made, a call failed, a bound stopped the run.
  const sum = result.steps.filter((step) => step.kind === 'summarize');
  const reasons: QuarantinedListingOnlyReason[] = [];
  for (const step of sum) if (step.status === 'listing-only' && !reasons.includes(step.reason)) reasons.push(step.reason);
  for (const reason of reasons) parts.push({ kind: 'status', text: t.listingOnly[reason] });
  // An ok summary with every line dropped, or a step that was deferred: the fixed "cannot be shown" line, never a blank.
  if (unavailable || sum.some((step) => step.status === 'deferred')) parts.push({ kind: 'status', text: t.summaryUnavailable });
  if (sum.some((step) => step.status === 'failed')) parts.push({ kind: 'status', text: t.summaryFailed });
  if (result.breach !== undefined) parts.push({ kind: 'status', text: t.boundStopped });
  return finish(input, parts, label, summaryLines, droppedLines);
}

function finish(input: AssembleAgentReplyInput, parts: readonly AgentReplyPart[], label: FlowLabel, summaryLines: number, droppedLines: number): AssembledAgentReply {
  input.logger?.info(AGENT_ASSEMBLE_LOG_EVENT, {
    parts: parts.length,
    facts: parts.filter((part) => part.kind === 'fact').length,
    summaryLines,
    droppedLines,
    ...(input.result.breach !== undefined ? { breach: input.result.breach } : {}),
  });
  const frozen = Object.freeze(parts.map((part) => Object.freeze({ ...part })));
  return { text: frozen.map((part) => part.text).join('\n'), parts: frozen, label, summaryLines, droppedLines };
}

function idsOf(projection: StructureProjection, render: (ids: string) => string): string {
  if (projection.field === undefined || !DISPLAY_ID_FIELDS.includes(projection.field) || projection.ids.length === 0) return '';
  return render(projection.ids.join(', '));
}

/**
 * The second guard on one model-derived string: links neutralised, no link left, no credential, and no claim of an action
 * Quoky did (the guard of the item's own source; a source with none cannot be judged). `undefined` drops it.
 */
function guarded(text: string, entryId: NlWave1EntryId): string | undefined {
  const readoutSource = AGENT_SUMMARY_READOUT_SOURCE[entryId];
  if (readoutSource === undefined) return undefined;
  const clean = neutralizeLinks(text, 'display');
  if (containsLink(clean, 'display') || containsCredentialMaterial(clean) || containsCredentialFileContent(clean)) return undefined;
  if (containsDocumentActionClaim(clean, readoutSource)) return undefined;
  return clean;
}

import type { InboundQuotedRange } from '../../domain';
import { flowLabel, type FlowLabel } from '../../domain/flow-label';
import { NL_R2_ITEM_SOURCES, type NlWave1EntryId } from '../nl-routing/catalog';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { normalizeForMatch } from '../nl-routing/selection-input';

/**
 * ADR-0121 D4 (stage S2 P1): the information-flow policy of the bounded read agent, pure and deterministic.
 *
 * - **M1 (the planner) takes only `TRUSTED` and `STRUCTURE` values.** {@link checkPlannerInputs} refuses a prompt part with
 *   any other trust, and {@link plannerPromptCanaryHit} is the canary check: no byte of the turn's quoted, fenced or
 *   platform-quoted material (the `UNTRUSTED` part of the owner's message) may appear in the planner prompt unless the
 *   owner's own words say the same. A hit refuses the call; nothing is repaired.
 * - **References are source-bound.** {@link AGENT_READ_SOURCES} names each READ entry's source and destination origin;
 *   a reference may feed only a read of the same source and origin (`plan-validator.ts`). One configured connector per
 *   source today, so the origin is the source's configured site.
 * - **Each source's content has a fixed label** ({@link readOutputLabel}) for the later stages (M2 provider choice, the
 *   DM-only rule). Stage S2 P1 performs no read, so nothing is labelled at run time yet.
 */

/**
 * The READ entries an agent plan may name, each with its source, the id field a projector may extract from it, and its
 * worst-case number of connector queries (named port calls) for one selection through its handler (`connectorQueries`;
 * S2 P3 part 2, CA finding 3; the HTTP requests behind each query are recorded in the S2 P3 part 2 note of DECISIONS.md):
 * - Jira, GitHub, Slack, Confluence, calendar, mail and Drive listings: one query each (`personal-work`, `search`,
 *   `listEvents`, mail `search`, Drive `recentFiles` / `searchByName`);
 * - `jira.release`: up to 8 (`containers` twice, `releases` for up to 5 candidate projects, then a project's `releases`
 *   or `release-items`; `jira-release-lookup.ts`, `DISAMBIGUATE_MAX`);
 * - `todo.list`: 2 — the open list also reads the Jira and GitHub work surface (`work-surface-query.ts`);
 * - `brief.today`: 4 with every section on (calendar 1, Jira 2, mail 1; the brief flags can only lower it);
 * - reminders and help: 0 (host only).
 */
export const AGENT_READ_SOURCES: Readonly<
  Record<NlWave1EntryId, { readonly source: string; readonly origin: string; readonly refField?: string; readonly itemEntry?: NlWave1EntryId; readonly connectorQueries: number }>
> = Object.freeze({
  // `itemEntry` (owner decision of 2026-10-26; Codex P2-2 of 0bde31cc): the entry that reads ONE listed item of this list
  // by its id — the only target of a position reference (`ref.at`); set only for the item-summary sources.
  'jira.issues': { source: 'jira', origin: 'jira:configured-site', refField: 'issueKeys', itemEntry: 'jira.issues', connectorQueries: 1 },
  'jira.release': { source: 'jira', origin: 'jira:configured-site', refField: 'issueKeys', itemEntry: 'jira.issues', connectorQueries: 8 },
  'github.items': { source: 'github', origin: 'github:configured-host', refField: 'itemIds', connectorQueries: 1 },
  'slack.search': { source: 'slack', origin: 'slack:configured-workspace', refField: 'messageIds', itemEntry: 'slack.search', connectorQueries: 1 },
  'confluence.search': { source: 'confluence', origin: 'confluence:configured-site', refField: 'pageIds', connectorQueries: 1 },
  'calendar.events': { source: 'calendar', origin: 'calendar:owner', refField: 'eventIds', connectorQueries: 1 },
  'mail.list': { source: 'mail', origin: 'mail:owner', refField: 'messageIds', itemEntry: 'mail.list', connectorQueries: 1 },
  'drive.files': { source: 'drive', origin: 'drive:owner', refField: 'fileIds', itemEntry: 'drive.files', connectorQueries: 1 },
  // Local stores and fixed answers: no projected id field (a reference to or from them is refused). The to-do list still
  // reads the Jira and GitHub work surface.
  'todo.list': { source: 'todo', origin: 'host', connectorQueries: 2 },
  'reminder.list': { source: 'reminder', origin: 'host', connectorQueries: 0 },
  'brief.today': { source: 'brief', origin: 'host', connectorQueries: 4 },
  'help.topic': { source: 'help', origin: 'host', connectorQueries: 0 },
});

/**
 * Owner decision of 2026-10-26 (a position reference, "지라 이슈 보여주고 첫 번째 거 요약해줘"): the sources whose listed
 * items a plan may summarize one by position — exactly the sources an item summary already reads (`item.summarize`: its
 * R1 `source` enum, mail and Drive, plus the R2 sources, Jira and Slack), so the plan adds no egress an item summary does
 * not already allow. Derived from the catalog; no list of its own.
 */
export const AGENT_POSITION_REF_SOURCES: readonly string[] = Object.freeze([
  ...((NL_ACTION_ENTRIES['item.summarize']?.args.find((spec) => spec.name === 'source')?.values ?? []) as readonly string[]),
  ...NL_R2_ITEM_SOURCES,
]);

/**
 * The label of what a READ entry returns (ADR-0121 D4; ADR-0110 D4, ADR-0118 D7/D8, ADR-0100). Every source is pinned
 * explicitly (the A3a RQ-1 `readOutputLabel` fix, build precondition of A5 for GitHub): a new source can no longer fall into
 * a default branch, and an unknown one is `HOST_ONLY` (fail closed). The values of Jira, Slack, Confluence and GitHub are
 * the ones the default branch gave them (`REMOTE_OK`, `WORK_CHANNEL_OK`): this is the LISTING label. The summary readout of
 * the five work sources has its own label ({@link summaryReadoutLabel}, ADR-0121 A5.4).
 */
export function readOutputLabel(entryId: NlWave1EntryId): FlowLabel {
  const source = AGENT_READ_SOURCES[entryId].source;
  switch (source) {
    case 'calendar':
    case 'brief':
      return flowLabel('UNTRUSTED', 'LOCAL_MODEL_ONLY', 'OWNER_DM_ONLY', [source]);
    case 'mail':
    case 'drive':
      return flowLabel('UNTRUSTED', 'REMOTE_ON_SUMMARY_REQUEST', 'OWNER_DM_ONLY', [source]);
    case 'todo':
    case 'reminder':
      return flowLabel('UNTRUSTED', 'REMOTE_OK', 'OWNER_DM_ONLY', [source]);
    case 'help':
      return flowLabel('TRUSTED', 'REMOTE_OK', 'WORK_CHANNEL_OK', [source]);
    case 'jira':
    case 'slack':
    case 'confluence':
    case 'github':
      return flowLabel('UNTRUSTED', 'REMOTE_OK', 'WORK_CHANNEL_OK', [source]);
    default:
      return flowLabel('UNTRUSTED', 'HOST_ONLY', 'OWNER_DM_ONLY', [source]);
  }
}

/**
 * ADR-0121 A5.4: the sources whose listed items an owner-requested summary may send to a model (calendar, Jira, Slack,
 * Confluence, GitHub). Each has its own per-source switch (`QUOKY_AGENT_SUMMARY_*`, default off).
 */
export const AGENT_WORK_SUMMARY_SOURCES = Object.freeze(['calendar', 'jira', 'slack', 'confluence', 'github'] as const);
export type AgentWorkSummarySource = (typeof AGENT_WORK_SUMMARY_SOURCES)[number];

/** The work-summary source of a read entry, or `undefined` (mail, Drive, the local stores). */
export function workSummarySourceOf(entryId: NlWave1EntryId): AgentWorkSummarySource | undefined {
  const source = AGENT_READ_SOURCES[entryId]?.source;
  return (AGENT_WORK_SUMMARY_SOURCES as readonly string[]).includes(source as string) ? (source as AgentWorkSummarySource) : undefined;
}

/**
 * ADR-0121 A5.4 (D4, design 2.4 rule 2): the label of the agent's summary READOUT. The five work sources are `UNTRUSTED`,
 * `REMOTE_ON_SUMMARY_REQUEST`, `OWNER_DM_ONLY`, as mail and Drive are; every other entry keeps {@link readOutputLabel}. It
 * labels the summarize step only: the planner, the structure projector, the handoff and the listings keep the read label.
 * Pure data: whether a source is enabled is the switch's business ({@link AgentSummarizerDeps}), not the label's.
 */
export function summaryReadoutLabel(entryId: NlWave1EntryId): FlowLabel {
  const work = workSummarySourceOf(entryId);
  return work === undefined ? readOutputLabel(entryId) : flowLabel('UNTRUSTED', 'REMOTE_ON_SUMMARY_REQUEST', 'OWNER_DM_ONLY', [work]);
}

/**
 * How a summarize step gets the items' text from a covered read (ADR-0121 A5.2):
 * - `documents`: mail and Drive. The port is asked (`withDocuments`) and hands over bodies, as before.
 * - `listing`: Jira, Slack, Confluence, GitHub. The request is exactly the listing read's (no `withDocuments`, no further
 *   request); the text is projected from the listing response's own items.
 * - `listing-mask`: calendar. One `events.list` with the separate agent-summary field mask (ADR-0110 D1 amendment), which the
 *   port selects when asked `withDocuments`; the text is projected from the response's items like `listing`.
 */
export type AgentSummaryReadMode = 'documents' | 'listing' | 'listing-mask';

export function summaryReadModeOf(entryId: NlWave1EntryId): AgentSummaryReadMode {
  const work = workSummarySourceOf(entryId);
  if (work === undefined) return 'documents';
  return work === 'calendar' ? 'listing-mask' : 'listing';
}

/** One labelled part of a planner prompt. */
export interface PlannerPromptPart {
  readonly label: FlowLabel;
}

export type PlannerFlowRefusal = 'untrusted-input' | 'canary';

/** D4: every part of a planner prompt must be `TRUSTED` or `STRUCTURE`. Returns the refusal, or `undefined`. Pure. */
export function checkPlannerInputs(parts: readonly PlannerPromptPart[]): Extract<PlannerFlowRefusal, 'untrusted-input'> | undefined {
  return parts.some((part) => part.label.trust !== 'TRUSTED' && part.label.trust !== 'STRUCTURE') ? 'untrusted-input' : undefined;
}

/** A canary shorter than this (normalized code points) is too common to prove a leak (single words, numbers). */
export const PLANNER_CANARY_MIN_CHARS = 8;

const FENCED = /```[\s\S]*?(?:```|$)/g;
const QUOTED_LINE = /^[ \t]*>.*$/gm;
const QUOTE_TO_END = /^[ \t]*>>>/m;

/**
 * The `UNTRUSTED` material of the owner's message as canaries: the platform-quoted ranges, fenced blocks, `>` lines and
 * everything after `>>>`, one canary per line of at least {@link PLANNER_CANARY_MIN_CHARS} code points. Pure.
 */
export function untrustedCanariesOf(rawText: string, quotedRanges: readonly InboundQuotedRange[] = []): string[] {
  const material: string[] = [];
  for (const range of quotedRanges) {
    if (Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start) material.push(rawText.slice(range.start, range.end));
  }
  for (const match of rawText.matchAll(FENCED)) material.push(match[0].replace(/^```[^\n]*\n?/u, '').replace(/```$/u, ''));
  for (const match of rawText.matchAll(QUOTED_LINE)) material.push(match[0].replace(/^[ \t]*>+/u, ''));
  const toEnd = QUOTE_TO_END.exec(rawText);
  if (toEnd) material.push(rawText.slice(toEnd.index + toEnd[0].length));
  const canaries = new Set<string>();
  for (const block of material) {
    for (const line of block.split(/\r?\n/u)) {
      const normalized = normalizeForMatch(line);
      if (Array.from(normalized).length >= PLANNER_CANARY_MIN_CHARS) canaries.add(normalized);
    }
  }
  return [...canaries];
}

/**
 * The canary check (ADR-0121 D4, design §3): `true` when any canary appears in the planner prompt and is not also part of
 * the owner's own non-quoted words (`groundingText`, which is `TRUSTED` by definition). Pure.
 */
export function plannerPromptCanaryHit(prompt: string, canaries: readonly string[], groundingText: string): boolean {
  const haystack = normalizeForMatch(prompt);
  const owner = normalizeForMatch(groundingText);
  return canaries.some((canary) => {
    const needle = normalizeForMatch(canary);
    return needle.length > 0 && haystack.includes(needle) && !owner.includes(needle);
  });
}

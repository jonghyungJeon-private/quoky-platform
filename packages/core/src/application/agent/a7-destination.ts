import type { Id, IsoTimestamp } from '../../domain';
import type { AgentWriteProposalPort } from '../../ports/agent-write-proposal.port';
import type { Logger } from '../../ports/logger.port';
import type { NlArgs, NlCatalogEntry } from '../nl-routing/catalog';
import {
  A7_NOT_MADE_LINE,
  A7_OWNER_STEP_LINE,
  A7_STOPPED_LINE,
  AGENT_A7_AUDIT_EVENT,
  type A7ProposeOutcome,
} from './a7-propose';
import {
  A7_PICK_NO_ROWS,
  buildJiraTicketRows,
  buildProjectRows,
  renderA7PickListing,
  type PendingA7Pick,
} from './a7-pick';
import { AGENT_A7_SOURCES, type AgentCrossWriteContext } from './cross-write';
import type { HeldReceipt, HeldReceiptArgs } from './held-receipt';
import type { AgentPlanExecutor } from './plan-executor';
import type { ValidatedAgentStep } from './plan-validator';
import type { AgentRunBudget } from './run-bounds';

/**
 * ADR-0121 amendment A7, slice A7-S4b "pick": the turn that ASKS for a destination pick (A7.4b, a7-09), and the pure rebuild of a validated
 * source read from the structure a pending pick or a receipt froze. Dormant like all of A7: reached only through `AgentRunService` with the
 * `writeProposal` dep, which needs agent mode `active` and `QUOKY_AGENT_WRITE_PROPOSALS=active` (both refused at startup).
 *
 * The listing is a READ and nothing else: the owner-scoped listing of their open issues of one project (the existing `jira.issues` entry
 * with its own default args), or, for the board question, the project allowlist (no read). It reads no source item, drafts nothing, makes
 * no model call, and writes no receipt (A7.4b: "the destination listing writes no receipt"). The result is one fixed-order, never
 * pre-selected list and a {@link PendingA7Pick}, which the caller stores in `Session.metadata` (form b: with the receipt FROZEN inside it).
 */

/** The owner-scoped listing read of the Jira destination: the entry's own filters, nothing from the owner's words or from content. */
export const A7_DESTINATION_LISTING_ENTRY = 'jira.issues' as const;
/**
 * Review round 1 (P2-4): the order is the connector's own `created DESC` (`sort: 'newest'`), never the default `updated DESC`, so editing an
 * issue can neither add it to the listing nor move it. The read has no closed project argument (the personal-work query has none, and adding
 * one is a catalog change), so the owner's newest issues (a bounded page) are read and the closed project filter is applied by
 * {@link buildJiraTicketRows}: closed-format keys of the one allowlisted project only. Update time influences neither membership nor order.
 */
export const A7_DESTINATION_LISTING_ARGS: NlArgs = Object.freeze({ role: 'assignee', status: 'open', sort: 'newest', limit: 10 });

/** A7.4c item 3 when the destination is not yet named: the open card first (the keys are not known yet). */
export const A7_WAIT_LINE_UNNAMED = {
  ko: '열려 있는 카드를 먼저 승인하거나 취소해 주세요. 그다음 다시 말씀해 주세요. 아무것도 읽거나 보내지 않았어요.',
  en: 'Please approve or cancel the open card first, then ask again. Nothing was read or sent.',
} as const;

/** What the turn that asks for a pick came to. `listing`: the numbered list to show (a pending pick was made); otherwise the propose step's own closed outcomes. */
export type A7ListingOutcome = { readonly kind: 'listing'; readonly text: string; readonly stage: 'project' | 'ticket'; readonly options: readonly string[] };

export interface A7PickTemplate {
  readonly form: 'a' | 'b';
  readonly target: 'jira.comment.propose';
  readonly connectorCalls: number;
  readonly source?: { readonly entryId: string; readonly args: HeldReceiptArgs };
  readonly frozen?: HeldReceipt;
}

export interface A7DestinationListingDeps {
  readonly proposal: AgentWriteProposalPort;
  readonly list: AgentPlanExecutor['listDestinationRows'];
  readonly logger: Logger;
}

export interface A7DestinationListingInput {
  readonly template: A7PickTemplate;
  /** `project`: the board question (a7-09); `ticket`: the owner's open issues of `project`. */
  readonly stage: 'project' | 'ticket';
  readonly project?: string;
  /** The allowlisted Jira projects, upper-case (`QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS`). */
  readonly jiraProjects: readonly string[];
  /** The offered READ entries of this turn: the listing read must be one of them. */
  readonly offeredReads: readonly NlCatalogEntry[];
  readonly actorId: Id;
  readonly conversation: string;
  /** The owner turn asking for the pick: the pick must be the very next one. */
  readonly turnId: string;
  readonly language: 'ko' | 'en';
  readonly now: IsoTimestamp;
  readonly budget: AgentRunBudget;
  readonly signal?: AbortSignal;
  /** Review round 4: the turn's liveness (epoch captured once at turn entry); REQUIRED, called before every external effect and after every await. */
  readonly alive: () => Promise<boolean>;
  readonly ownerStepPending?: boolean;
  readonly sessionId: string;
  /** The closed list the asking turn froze (the source read the owner's own words asked a summary of); no owner text (P1-2). */
  readonly summaryAsked: PendingA7Pick['summaryAsked'];
}

/**
 * Lists the destination rows and makes the pending pick. Total: never throws; one content-free `agent_run.a7` line (stage, row count, outcome).
 * Order: another owner step (W2), the open-card wait (A7.4c item 3), the read, the kill switch right before the list is shown.
 */
export async function runA7DestinationListing(
  deps: A7DestinationListingDeps,
  input: A7DestinationListingInput,
): Promise<{ readonly outcome: A7ListingOutcome | A7ProposeOutcome; readonly pending?: PendingA7Pick }> {
  const language = input.language;
  const audit = { planKind: 'cross-write', form: input.template.form, stage: input.stage, decision: 'pending' };
  const done = (outcome: A7ListingOutcome | A7ProposeOutcome, label: string, extra: Record<string, string | number | boolean> = {}, pending?: PendingA7Pick): { readonly outcome: A7ListingOutcome | A7ProposeOutcome; readonly pending?: PendingA7Pick } => {
    try {
      deps.logger.info(AGENT_A7_AUDIT_EVENT, { ...audit, ...extra, outcome: label });
    } catch {
      // best-effort
    }
    return { outcome, ...(pending !== undefined ? { pending } : {}) };
  };
  const refuse = (reason: Extract<A7ProposeOutcome, { kind: 'refused' }>['reason'], text: string): { readonly outcome: A7ListingOutcome | A7ProposeOutcome; readonly pending?: PendingA7Pick } =>
    done({ kind: 'refused', reason, text }, reason);
  const live = (): Promise<boolean> => input.alive().catch(() => false);
  try {
    const { template } = input;
    if (template.target !== 'jira.comment.propose') return refuse('unsupported', A7_NOT_MADE_LINE[language]);
    if (template.form === 'a' ? template.source === undefined || template.frozen !== undefined : template.frozen === undefined || template.source !== undefined) return refuse('unsupported', A7_NOT_MADE_LINE[language]);
    if (input.ownerStepPending === true) return refuse('owner-step-open', A7_OWNER_STEP_LINE[language]);
    if (!(await live())) return refuse('stopped', A7_STOPPED_LINE[language]);
    const open = await deps.proposal.openCardOf(input.actorId, input.now);
    if (!(await live())) return refuse('stopped', A7_STOPPED_LINE[language]);
    if (open !== undefined) return done({ kind: 'wait', text: A7_WAIT_LINE_UNNAMED[language] }, 'wait-open-card');

    let rows: readonly { readonly id: string; readonly title?: string }[];
    if (input.stage === 'project') {
      rows = buildProjectRows(input.jiraProjects);
    } else {
      const project = input.project;
      if (project === undefined) return refuse('unsupported', A7_NOT_MADE_LINE[language]);
      if (!input.offeredReads.some((entry) => entry.id === A7_DESTINATION_LISTING_ENTRY && entry.risk === 'READ')) return refuse('unsupported', A7_NOT_MADE_LINE[language]);
      if (!(await live())) return refuse('stopped', A7_STOPPED_LINE[language]);
      const listed = await deps.list(A7_DESTINATION_LISTING_ENTRY, A7_DESTINATION_LISTING_ARGS, {
        budget: input.budget,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        stillRunning: input.alive,
      });
      if (!(await live())) return refuse('stopped', A7_STOPPED_LINE[language]);
      if (listed.kind === 'not-run') return refuse(listed.reason === 'stopped' ? 'stopped' : 'bound', listed.reason === 'stopped' ? A7_STOPPED_LINE[language] : A7_NOT_MADE_LINE[language]);
      if (listed.kind === 'failed') return refuse('read-failed', A7_NOT_MADE_LINE[language]);
      rows = buildJiraTicketRows(listed.rows, project, input.jiraProjects);
    }
    if (rows.length === 0) return refuse('no-destination-rows', A7_PICK_NO_ROWS[language]);

    // The kill switch, once more, right before the list is shown: a stop that landed meanwhile leaves nothing pending.
    if (!(await live())) return refuse('stopped', A7_STOPPED_LINE[language]);
    if (input.signal?.aborted === true) return refuse('stopped', A7_STOPPED_LINE[language]);

    const options = rows.map((row) => row.id);
    const pending: PendingA7Pick = {
      conversation: input.conversation,
      actorId: input.actorId,
      sessionId: input.sessionId,
      askedTurnId: input.turnId,
      askedAt: input.now,
      stage: input.stage,
      ...(input.stage === 'ticket' && input.project !== undefined ? { project: input.project } : {}),
      options,
      form: template.form,
      target: template.target,
      connectorCalls: template.connectorCalls,
      ...(template.source !== undefined ? { source: template.source } : {}),
      ...(template.frozen !== undefined ? { frozen: template.frozen } : {}),
      summaryAsked: [...input.summaryAsked],
      language,
    };
    return done({ kind: 'listing', text: renderA7PickListing(language, rows), stage: input.stage, options }, 'pick-listed', { rows: rows.length }, pending);
  } catch {
    return refuse('unsupported', A7_NOT_MADE_LINE[language]);
  }
}

/**
 * A validated source read rebuilt from the structure a pending pick or a receipt froze: the entry must still be offered as a READ, still be an
 * A7 source switched on, and every frozen arg must still be an arg of the entry with a value of the right scalar type. Pure; `undefined` fails
 * closed (the caller declines, nothing is read). The args were grounded in the owner's words by the turn that froze them (A7.5 step 2), and
 * they are held under the same windows as a receipt; the reply that picks is never planned and never contributes an arg.
 */
export function rebuildA7SourceRead(
  offered: readonly NlCatalogEntry[],
  entryId: string,
  args: HeldReceiptArgs,
  context: Pick<AgentCrossWriteContext, 'sources'>,
): Extract<ValidatedAgentStep, { kind: 'read' }> | undefined {
  if (!(AGENT_A7_SOURCES as readonly string[]).includes(entryId) || !context.sources.includes(entryId)) return undefined;
  const entry = offered.find((candidate) => candidate.id === entryId && candidate.risk === 'READ');
  if (entry === undefined) return undefined;
  const known = new Map(entry.args.map((arg) => [arg.name, arg] as const));
  for (const [name, value] of Object.entries(args)) {
    const spec = known.get(name);
    if (spec === undefined) return undefined;
    const typeOk =
      spec.kind === 'enum'
        ? typeof value === 'string' && (spec.values === undefined || spec.values.includes(value))
        : spec.kind === 'flag'
          ? typeof value === 'boolean'
          : spec.kind === 'limit'
            ? typeof value === 'number'
            : typeof value === 'string';
    if (!typeOk) return undefined;
  }
  return { kind: 'read', entry, args: { ...args }, provenance: {} };
}

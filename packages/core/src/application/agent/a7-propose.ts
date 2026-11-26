import type { Id, IsoTimestamp, MessageBody } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import {
  agentProposalProvenanceLine,
  destinationShapedKeys,
  type AgentWriteProposalBanner,
  type AgentWriteProposalPort,
  type AgentWriteProposalRefusal,
} from '../../ports/agent-write-proposal.port';
import { consumePickedA7Destination, isPickedA7Destination, type PickedA7Destination } from './a7-pick';
import type { ValidatedCrossWritePlan } from './cross-write-validator';
import { digestSourceDocument, verifyHeldItems, type HeldReceipt, type HeldReceiptHasher } from './held-receipt';
import { renderDraftConsentQuestion } from './draft-consent-question';
import type { AgentDraftReadOptions, AgentDraftSourceOutcome } from './plan-executor';
import { carriedSummaryGrantBasis, summaryGrantBasis, summaryGrantBasisFromFrozen, type OwnerText } from './summary-grant';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { quarantinedDraft, type QuarantinedListingOnlyReason, type QuarantinedSummarizerRoute, type SummaryConsentToken, type SummaryRunToken } from './quarantined-summary';
import type { AgentRunBudget } from './run-bounds';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';

/**
 * ADR-0121 amendment A7, slice A7-S4a "card": the A7 propose step of form a (a plan with its own READ step and an owner-literal
 * destination), A7.5 steps 2 to 7 in order: the one-open-card check, the READ, the rule-① question (A7.5 step 4), the quarantined
 * draft ({@link quarantinedDraft}), the exact payload, and ONE call of the proposal port. It holds no writer, no flow and no
 * storage: the card is made by the port's implementation outside this module.
 *
 * DORMANT: no live path calls it. `AgentRunService` reaches it only with a `writeProposal` dep, which the composition root builds only
 * for agent mode `active` and `QUOKY_AGENT_WRITE_PROPOSALS=active` (both still refused at preflight). The destination is the plan's
 * own validated literal (A7.4a); nothing the model wrote, and nothing read from content, is ever a target, an operation or an argument.
 * Whether a card appears depends only on validation, counts, labels and consent (no content-conditioned control flow, §8 item 5).
 */

export const AGENT_A7_AUDIT_EVENT = 'agent_run.a7';

/** The kill-switch and bound refusals share the one fixed "not made" line; the other reasons are closed. */
export type A7ProposeRefusalReason =
  | 'unsupported'
  | 'stopped'
  | 'bound'
  | 'read-failed'
  /** A resumed consent was asked for another destination than this plan's: nothing was read or sent. */
  | 'consent-mismatch'
  /** A7-S4b (A7.4b): the owner-scoped listing of a destination pick found nothing to pick. */
  | 'no-destination-rows'
  /** A7-S4b (A7.5 step 2): the picked issue is missing or inaccessible, or the check could not be made: nothing was read or drafted. */
  | 'destination-gone'
  | 'no-destination-check'
  | AgentWriteProposalRefusal
  | QuarantinedListingOnlyReason
  /** The draft was refused (`schema`, `credential`, `participants`, `link`, `size`, `spoof`) or the model failed. */
  | 'draft-refused';

export type A7ProposeOutcome =
  /** The card (the port made the ADR-0112 anchor): show it to the owner. */
  | {
      readonly kind: 'carded';
      readonly card: MessageBody;
      readonly cardId: Id;
      /** A7-S4b: the card's task (opaque), for the closure check of A7.4c item 4. Only when the port gave one. */
      readonly taskId?: Id;
      /** A7-S4b: the items the draft was made from, as id and A5.2 digest (content-free). Only when a hasher was given. */
      readonly items?: readonly { readonly id: string; readonly digest: string }[];
      /** A7-S4b: where the drafter ran (with `items`). */
      readonly locality?: 'LOCAL' | 'REMOTE';
    }
  /** Rule ①: the question to show; nothing was fetched, drafted or carded. */
  | {
      readonly kind: 'ask';
      readonly question: string;
      readonly run: SummaryRunToken;
      readonly itemIds: readonly string[];
      readonly recipient: string;
      /** The destination the question named: the consent is bound to it (review round 1, Codex P2). */
      readonly destination: A7ConsentDestination;
    }
  /** A7.4c item 3: another A7 card is open; nothing was read or drafted. `text` is the fixed wait line. */
  | { readonly kind: 'wait'; readonly text: string }
  /** No card: the closed reason and the fixed line to show. */
  | { readonly kind: 'refused'; readonly reason: A7ProposeRefusalReason; readonly text: string };

/** What a rule-① consent of an A7 draft is bound to besides the run, the step and the items: the operation and the target it named. */
export interface A7ConsentDestination {
  readonly operation: 'jira-comment';
  readonly target: string;
}

export interface A7ProposeDeps {
  readonly proposal: AgentWriteProposalPort;
  readonly readSource: (step: Extract<ValidatedAgentStep, { kind: 'read' }>, options: AgentDraftReadOptions) => Promise<AgentDraftSourceOutcome>;
  readonly route: QuarantinedSummarizerRoute;
  readonly logger: Logger;
}

export interface A7ProposeInput {
  readonly plan: ValidatedCrossWritePlan;
  readonly actorId: Id;
  readonly sessionId: Id;
  readonly language: 'ko' | 'en';
  /** The owner's own words of this turn as prepared (and the raw text): the only source of the summary grant (never a flag). */
  readonly ownerText?: OwnerText;
  /**
   * Review round 1 (P1-2 and the cross-turn ruling): where the summary grant comes from when it is NOT this turn's own words. `frozen`: the
   * closed list a pending pick froze at its asking turn (the pick reply "2" asks for nothing). `carried`: a carried-over or bare follow-up
   * draft; it NEVER reuses an earlier request's grant, so a `REMOTE` summariser needs a fresh rule-① consent (the question is asked again)
   * and a `LOCAL` one proceeds. Absent: this turn's own words (`ownerText`).
   */
  readonly grantFrom?: { readonly kind: 'frozen'; readonly asked: readonly string[] } | { readonly kind: 'carried' };
  readonly now: IsoTimestamp;
  readonly budget: AgentRunBudget;
  readonly signal?: AbortSignal;
  /** The persisted kill switch; re-read before the read and again right before the card. */
  readonly stillRunning?: () => Promise<boolean>;
  /** A rule-① re-run after the owner's yes: the run token, the consent token and the ids the owner was asked about. */
  readonly resume?: {
    readonly run: SummaryRunToken;
    readonly consent: SummaryConsentToken;
    readonly recorded: readonly string[];
    readonly recipient: string;
    /** The destination of the `ask` outcome this consent answers; a plan with another destination refuses (no read, no call). */
    readonly destination: A7ConsentDestination;
  };
  /**
   * Whether another owner step (an approval, a pending consent step of the rule-① store) is open for this owner (W2; the runtime's
   * `AgentActiveTurn.ownerStepPending`). True: no card is made. The S4b continuation must pass the value for the turn AFTER its own
   * bound yes was used.
   */
  readonly ownerStepPending?: boolean;
  /**
   * A7-S4b (A7.4b): the destination the owner picked by number (`OWNER_PICKED_DESTINATION`). Valid only for a plan whose destination is a
   * pick state of the same project, only for a value `resolveA7Pick` issued, and only as this one propose step's destination.
   */
  readonly picked?: PickedA7Destination;
  /** The owner turn this step runs in: a picked destination is bound to it (single use, P2-1). Needed with `picked`. */
  readonly turnId?: string;
  /** Round 2: the conversation and the listing turn the pick was bound to (checked at consume). Needed with `picked`. */
  readonly pickBinding?: { readonly conversation: string; readonly listingTurnId: string };
  /**
   * A7-S4b, form b: the bound (or frozen) receipt and the read step rebuilt from it. The read is the receipt's entry with its held args; only
   * the receipt's ids that still hold the same digest are drafted from, and nothing is added (A7.4). Needs `hasher`.
   */
  readonly receipt?: { readonly receipt: HeldReceipt; readonly source: Extract<ValidatedAgentStep, { kind: 'read' }> };
  /** SHA-256 hex of a UTF-8 string, injected (the agent module imports no `node:*`). Form b and the card's frozen items need it. */
  readonly hasher?: HeldReceiptHasher;
}

/** The step number of the synthetic draft step a consent token and a grant are bound to. */
export const A7_DRAFT_STEP = 2;

export const A7_NOT_MADE_LINE = {
  ko: '초안으로 카드를 만들 수 없어서 만들지 않았어요. 아무것도 보내지 않았어요.',
  en: "I couldn't make a card from the draft, so I made none. Nothing was sent.",
} as const;
export const A7_DESTINATION_GONE_LINE = {
  ko: '고르신 티켓을 지금은 찾을 수 없어서 카드를 만들지 않았어요. 아무것도 읽거나 보내지 않았어요.',
  en: "I can't find the ticket you picked right now, so I made no card. Nothing was read or sent.",
} as const;
export const A7_STOPPED_LINE = {
  ko: '에이전트가 멈춰 있어서 카드를 만들지 않았어요. 아무것도 보내지 않았어요.',
  en: 'The agent is stopped, so I made no card. Nothing was sent.',
} as const;
const TOO_LONG = {
  ko: '초안이 한 장의 카드에 통째로 보여 드릴 수 없는 길이라서 카드를 만들지 않았어요. 아무것도 보내지 않았어요.',
  en: "The draft can't be shown whole on one card, so I made none. Nothing was sent.",
} as const;
export const A7_OWNER_STEP_LINE = {
  ko: '먼저 열려 있는 승인 요청을 승인하거나 거절해 주세요. 지금은 카드를 만들지 않았어요. 아무것도 보내지 않았어요.',
  en: 'Please approve or decline the open approval request first. I made no card. Nothing was sent.',
} as const;

/** A7.4c item 3, the fixed wait line with the real keys. */
export function renderA7WaitLine(language: 'ko' | 'en', openKey: string, newKey: string): string {
  return language === 'ko'
    ? `${openKey} 카드를 먼저 승인하거나 취소해 주세요. 그다음 '${newKey}에도 달아줘'라고 하시면 같은 내용으로 새 초안을 만들게요`
    : `Please approve or cancel the ${openKey} card first. Then say 'add it to ${newKey} too' and I'll make a new draft with the same content`;
}

const dateOf = (value: string): string | undefined => (/^\d{4}-\d{2}-\d{2}/u.test(value) ? value.slice(0, 10) : undefined);

/**
 * Runs the A7 propose step. Total: never throws; one content-free audit line per call (plan kind, form, source entry, item count,
 * dropped count, drafter locality, consent outcome, card id, decision, outcome).
 */
export async function runA7ProposeStep(deps: A7ProposeDeps, input: A7ProposeInput): Promise<A7ProposeOutcome> {
  const audit: Record<string, string | number | boolean> = { planKind: 'cross-write', form: input.plan.form, decision: 'pending' };
  const done = (outcome: A7ProposeOutcome, label: string, extra: Record<string, string | number | boolean> = {}): A7ProposeOutcome => {
    try {
      deps.logger.info(AGENT_A7_AUDIT_EVENT, { ...audit, ...extra, outcome: label, ...(outcome.kind === 'carded' ? { cardId: outcome.cardId } : {}) });
    } catch {
      // best-effort: a logger that throws never rejects the step
    }
    return outcome;
  };
  const refuse = (reason: A7ProposeRefusalReason, text: string, extra: Record<string, string | number | boolean> = {}): A7ProposeOutcome => done({ kind: 'refused', reason, text }, reason, extra);
  const language = input.language;
  try {
    const plan = input.plan;
    const destination = plan.destination;
    const receipt = input.receipt;
    const read = receipt !== undefined ? receipt.source : plan.source;
    if (plan.target !== 'jira.comment.propose' || plan.destinationKind !== 'jira' || read === undefined) return refuse('unsupported', A7_NOT_MADE_LINE[language]);
    if (receipt !== undefined ? plan.form !== 'b' || input.hasher === undefined : plan.form !== 'a') return refuse('unsupported', A7_NOT_MADE_LINE[language]);
    let key: string;
    let grounding: 'owner-text' | 'owner-picked' = 'owner-text';
    if (input.picked !== undefined) {
      // A7.4b: only a value `resolveA7Pick` issued, only for a plan that asked for a pick of that very project.
      const picked = input.picked;
      const projectOk =
        (destination.state === 'pick-ticket' && destination.project === picked.project) || (destination.state === 'pick-project' && destination.projects.includes(picked.project));
      if (!isPickedA7Destination(picked) || !projectOk || input.turnId === undefined || input.pickBinding === undefined) return refuse('unsupported', A7_NOT_MADE_LINE[language]);
      // Single use and bound to this actor, session and pick turn, within its expiry (P2-1): a reuse or a stranger's use refuses, nothing read.
      if (!consumePickedA7Destination(picked, { actorId: input.actorId, sessionId: input.sessionId, turnId: input.turnId, now: input.now, conversation: input.pickBinding.conversation, listingTurnId: input.pickBinding.listingTurnId })) return refuse('unsupported', A7_NOT_MADE_LINE[language], { pick: 'refused' });
      key = picked.issueKey;
      grounding = 'owner-picked';
    } else {
      if (destination.state !== 'named' || destination.kind !== 'jira') return refuse('unsupported', A7_NOT_MADE_LINE[language]);
      key = destination.issueKey;
    }
    audit.sourceEntry = read.entry.id;
    audit.grounding = grounding;
    if (receipt !== undefined) audit.receipt = receipt.receipt.carried === true ? 'carried' : receipt.receipt.kind;
    // Review round 1 (Codex P2): a consent is for the destination the owner was asked about. A different one: nothing is read or sent.
    if (input.resume !== undefined && (input.resume.destination.operation !== 'jira-comment' || input.resume.destination.target !== key)) {
      return refuse('consent-mismatch', A7_NOT_MADE_LINE[language], { consent: 'mismatch' });
    }
    // W2: another owner step (including a pending rule-① consent step) is open: no card, nothing read.
    if (input.ownerStepPending === true) return refuse('owner-step-open', A7_OWNER_STEP_LINE[language], { consent: 'not-asked' });

    // A7.4c item 3: one open A7 card per owner. Nothing is read or drafted while one is open.
    const open = await deps.proposal.openCardOf(input.actorId, input.now);
    if (open !== undefined) return done({ kind: 'wait', text: renderA7WaitLine(language, open.target, key) }, 'wait-open-card', { consent: 'not-asked' });

    // The owner's summary request, judged by the SAME producer as every summary, over the synthetic plan [read, draft] this step is
    // (A7.5 step 4: Slack and Jira drafts run only where the owner's words ask for a summary of that source).
    const grantPlan = a7GrantPlan(read, plan.connectorCalls);
    const sourced = await deps.readSource(read, {
      grants: { basis: grantBasisOf(grantPlan, input), plan: grantPlan },
      budget: input.budget,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.stillRunning !== undefined ? { stillRunning: input.stillRunning } : {}),
      ...(input.resume !== undefined
        ? { run: input.resume.run, consent: input.resume.consent, recorded: input.resume.recorded }
        : receipt !== undefined
          ? { recorded: receipt.receipt.itemIds }
          : {}),
    });
    if (sourced.kind === 'consent-needed') {
      const question = renderDraftConsentQuestion({ language, recipient: sourced.recipient, source: sourced.source, count: sourced.itemIds.length, destination: key });
      if (question === '') return refuse('no-model', A7_NOT_MADE_LINE[language], { consent: 'unavailable' });
      return done({ kind: 'ask', question, run: sourced.run, itemIds: sourced.itemIds, recipient: sourced.recipient, destination: { operation: 'jira-comment', target: key } }, 'consent-asked', { consent: 'asked', items: sourced.itemIds.length });
    }
    if (sourced.kind === 'not-run') return refuse(sourced.reason === 'stopped' ? 'stopped' : 'bound', sourced.reason === 'stopped' ? A7_STOPPED_LINE[language] : A7_NOT_MADE_LINE[language], { consent: 'not-asked' });
    if (sourced.kind === 'failed') return refuse('read-failed', A7_NOT_MADE_LINE[language], { consent: 'not-asked' });
    if (sourced.kind === 'listing-only') return refuse(sourced.reason, A7_NOT_MADE_LINE[language], { consent: 'not-asked' });
    const consent = input.resume !== undefined ? 'granted' : 'not-needed';

    let source = sourced.source;
    // A7.4 (form b): the receipt's items that still hold the same digest, and nothing else. A missing or changed item is dropped, never replaced.
    let receiptDrift = 0;
    if (receipt !== undefined && input.hasher !== undefined) {
      const hasher = input.hasher;
      const digests = source.documents.map((document) => ({ id: document.id, digest: digestSourceDocument(document, hasher) }));
      const verified = verifyHeldItems(receipt.receipt, digests);
      const kept = new Set(verified.keptIds);
      const listed = new Set(sourced.listedIds ?? source.documents.map((document) => document.id));
      const present = new Map(digests.map((entry) => [entry.id, entry.digest] as const));
      receipt.receipt.itemIds.forEach((id) => {
        // Drift is an item that left the listing or whose fields changed; one the listing still names but validation withheld is `omitted`, not drift.
        if (!kept.has(id) && (!listed.has(id) || present.has(id))) receiptDrift += 1;
      });
      source = { ...source, documents: source.documents.filter((document) => kept.has(document.id)) };
      if (source.documents.length === 0) return refuse('no-documents', A7_NOT_MADE_LINE[language], { consent, dropped: receiptDrift });
    }
    const outcome = await quarantinedDraft({
      source,
      participants: sourced.participants,
      summaryStep: A7_DRAFT_STEP,
      route: deps.route,
      reserve: (tokens) => input.budget.reserveModelCall('m2') && input.budget.reserveInputTokens(tokens),
      remainingInputTokens: input.budget.remainingInputTokens(),
      remainingCalls: input.budget.remainingM2Calls(),
      run: sourced.run,
      ...(input.resume !== undefined ? { consent: input.resume.consent } : {}),
      askedItems: source.asked ?? source.documents.length,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (outcome.kind === 'listing-only') return refuse(outcome.reason, A7_NOT_MADE_LINE[language], { consent });
    if (outcome.kind === 'bound') return refuse('bound', A7_NOT_MADE_LINE[language], { consent });
    if (outcome.kind === 'failed') return refuse('draft-refused', A7_NOT_MADE_LINE[language], { consent, draftFailure: outcome.reason });

    // Which items the draft was made from: exactly the ids the drafter placed in its prompt (structure only), never rebuilt here.
    const placedIds = new Set(outcome.placed);
    const sent = source.documents.filter((document) => placedIds.has(document.id));
    if (sent.length === 0) return refuse('no-documents', A7_NOT_MADE_LINE[language], { consent });
    // The a7-06 drift: items the owner was asked about (recorded) that are no longer in the listing. Not the other cuts.
    // Review round 2 (CA P3): measured against the ids the listing named, not the validated documents, so an item still listed but dropped by
    // validation or kept host-only is counted once (in `omitted`), never also as drift.
    const present = new Set(sourced.listedIds ?? source.documents.map((document) => document.id));
    const drift = receipt !== undefined ? receiptDrift : input.resume !== undefined ? input.resume.recorded.filter((id) => !present.has(id)).length : 0;
    const draft = outcome.draft;

    // The exact payload (A7.5 step 6): the fixed provenance line, then the drafter's final lines. The hash covers these bytes only.
    const payloadText = [agentProposalProvenanceLine(source.entryId, sent.length), ...draft.lines].join('\n');
    const query = queryLiteralOf(read.args);
    const banner: AgentWriteProposalBanner = {
      source: { entryId: source.entryId, ...(query !== undefined ? { query } : {}) },
      items: sent.map((document) => ({ id: document.id, ...(dateOf(document.date) !== undefined ? { date: dateOf(document.date) as string } : {}) })),
      dropped: drift,
      omitted: outcome.omitted,
      drafter: draft.locality === 'LOCAL' ? { locality: 'LOCAL' } : { locality: 'REMOTE', ...(input.resume !== undefined ? { operator: input.resume.recipient } : {}) },
    };
    audit.items = sent.length;
    audit.dropped = drift;
    audit.omitted = outcome.omitted;
    audit.drafterLocality = draft.locality;
    audit.consent = consent;

    // The kill switch, once more, right before the card (a stop that landed during the draft makes no card).
    if (input.stillRunning !== undefined && !(await input.stillRunning().catch(() => false))) return refuse('stopped', A7_STOPPED_LINE[language]);
    if (input.signal?.aborted === true) return refuse('stopped', A7_STOPPED_LINE[language]);

    const result = await deps.proposal.propose({
      operation: 'jira-comment',
      target: { issueKey: key },
      payloadText,
      actorId: input.actorId,
      sessionId: input.sessionId,
      grounding,
      banner,
      named: draft.named,
      nonTargets: destinationShapedKeys(payloadText, key),
      now: input.now,
      ...(input.stillRunning !== undefined ? { stillRunning: input.stillRunning } : {}),
    });
    if (result.kind === 'wait-open-card') return done({ kind: 'wait', text: renderA7WaitLine(language, result.openTarget, key) }, 'wait-open-card');
    if (result.kind === 'refused') {
      const text =
        result.reason === 'payload-too-large' || result.reason === 'too-many-lines'
          ? TOO_LONG[language]
          : result.reason === 'owner-step-open'
            ? A7_OWNER_STEP_LINE[language]
            : result.reason === 'stopped'
              ? A7_STOPPED_LINE[language]
              : A7_NOT_MADE_LINE[language];
      return refuse(result.reason, text);
    }
    const hasher = input.hasher;
    const items = hasher !== undefined ? sent.map((document) => ({ id: document.id, digest: digestSourceDocument(document, hasher) })) : undefined;
    return done({ kind: 'carded', card: result.card, cardId: result.cardId, ...(result.taskId !== undefined ? { taskId: result.taskId } : {}), ...(items !== undefined ? { items, locality: draft.locality } : {}) }, 'carded');
  } catch {
    return refuse('unsupported', A7_NOT_MADE_LINE[language]);
  }
}

/** The synthetic plan [read, draft] a propose step's grant is judged over (also the asking turn's, to freeze `summaryAsked`). */
export function a7GrantPlan(read: Extract<ValidatedAgentStep, { kind: 'read' }>, connectorCalls: number): ValidatedAgentPlan {
  return { kind: 'run', steps: [read, { kind: 'summarize', from: [1], schema: 'digest.v1' }], connectorCalls };
}

function grantBasisOf(plan: ValidatedAgentPlan, input: A7ProposeInput): ReturnType<typeof summaryGrantBasis> {
  if (input.grantFrom?.kind === 'frozen') return summaryGrantBasisFromFrozen(plan, input.grantFrom.asked as readonly NlWave1EntryId[]);
  if (input.grantFrom?.kind === 'carried') return carriedSummaryGrantBasis(plan);
  return input.ownerText !== undefined ? summaryGrantBasis(plan, input.ownerText) : summaryGrantBasisFromFrozen(plan, []);
}

function queryLiteralOf(args: Readonly<Record<string, unknown>>): string | undefined {
  const value = args.keyword ?? args.query;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 80) : undefined;
}

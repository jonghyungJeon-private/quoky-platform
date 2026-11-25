import type { Id, IsoTimestamp, MessageBody } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import {
  agentProposalProvenanceLine,
  destinationShapedKeys,
  type AgentWriteProposalBanner,
  type AgentWriteProposalPort,
  type AgentWriteProposalRefusal,
} from '../../ports/agent-write-proposal.port';
import type { ValidatedCrossWritePlan } from './cross-write-validator';
import { renderDraftConsentQuestion } from './draft-consent-question';
import type { AgentDraftReadOptions, AgentDraftSourceOutcome } from './plan-executor';
import { summaryGrantBasis, type OwnerText } from './summary-grant';
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
  | AgentWriteProposalRefusal
  | QuarantinedListingOnlyReason
  /** The draft was refused (`schema`, `credential`, `participants`, `link`, `size`, `spoof`) or the model failed. */
  | 'draft-refused';

export type A7ProposeOutcome =
  /** The card (the port made the ADR-0112 anchor): show it to the owner. */
  | { readonly kind: 'carded'; readonly card: MessageBody; readonly cardId: Id }
  /** Rule ①: the question to show; nothing was fetched, drafted or carded. */
  | { readonly kind: 'ask'; readonly question: string; readonly run: SummaryRunToken; readonly itemIds: readonly string[]; readonly recipient: string }
  /** A7.4c item 3: another A7 card is open; nothing was read or drafted. `text` is the fixed wait line. */
  | { readonly kind: 'wait'; readonly text: string }
  /** No card: the closed reason and the fixed line to show. */
  | { readonly kind: 'refused'; readonly reason: A7ProposeRefusalReason; readonly text: string };

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
  readonly ownerText: OwnerText;
  readonly now: IsoTimestamp;
  readonly budget: AgentRunBudget;
  readonly signal?: AbortSignal;
  /** The persisted kill switch; re-read before the read and again right before the card. */
  readonly stillRunning?: () => Promise<boolean>;
  /** A rule-① re-run after the owner's yes: the run token, the consent token and the ids the owner was asked about. */
  readonly resume?: { readonly run: SummaryRunToken; readonly consent: SummaryConsentToken; readonly recorded: readonly string[]; readonly recipient: string };
}

/** The step number of the synthetic draft step a consent token and a grant are bound to. */
export const A7_DRAFT_STEP = 2;

const NOT_MADE = {
  ko: '초안으로 카드를 만들 수 없어서 만들지 않았어요. 아무것도 보내지 않았어요.',
  en: "I couldn't make a card from the draft, so I made none. Nothing was sent.",
} as const;
const STOPPED = {
  ko: '에이전트가 멈춰 있어서 카드를 만들지 않았어요. 아무것도 보내지 않았어요.',
  en: 'The agent is stopped, so I made no card. Nothing was sent.',
} as const;
const TOO_LONG = {
  ko: '초안이 한 장의 카드에 통째로 보여 드릴 수 없는 길이라서 카드를 만들지 않았어요. 아무것도 보내지 않았어요.',
  en: "The draft can't be shown whole on one card, so I made none. Nothing was sent.",
} as const;
const OWNER_STEP = {
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
    const read = plan.source;
    if (plan.form !== 'a' || plan.target !== 'jira.comment.propose' || destination.state !== 'named' || destination.kind !== 'jira' || read === undefined) {
      return refuse('unsupported', NOT_MADE[language]);
    }
    const key = destination.issueKey;
    audit.sourceEntry = read.entry.id;

    // A7.4c item 3: one open A7 card per owner. Nothing is read or drafted while one is open.
    const open = await deps.proposal.openCardOf(input.actorId);
    if (open !== undefined) return done({ kind: 'wait', text: renderA7WaitLine(language, open.target, key) }, 'wait-open-card', { consent: 'not-asked' });

    // The owner's summary request, judged by the SAME producer as every summary, over the synthetic plan [read, draft] this step is
    // (A7.5 step 4: Slack and Jira drafts run only where the owner's words ask for a summary of that source).
    const grantPlan: ValidatedAgentPlan = { kind: 'run', steps: [read, { kind: 'summarize', from: [1], schema: 'digest.v1' }], connectorCalls: plan.connectorCalls };
    const sourced = await deps.readSource(read, {
      grants: { basis: summaryGrantBasis(grantPlan, input.ownerText), plan: grantPlan },
      budget: input.budget,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.stillRunning !== undefined ? { stillRunning: input.stillRunning } : {}),
      ...(input.resume !== undefined ? { run: input.resume.run, consent: input.resume.consent, recorded: input.resume.recorded } : {}),
    });
    if (sourced.kind === 'consent-needed') {
      const question = renderDraftConsentQuestion({ language, recipient: sourced.recipient, source: sourced.source, count: sourced.itemIds.length, destination: key });
      if (question === '') return refuse('no-model', NOT_MADE[language], { consent: 'unavailable' });
      return done({ kind: 'ask', question, run: sourced.run, itemIds: sourced.itemIds, recipient: sourced.recipient }, 'consent-asked', { consent: 'asked', items: sourced.itemIds.length });
    }
    if (sourced.kind === 'not-run') return refuse(sourced.reason === 'stopped' ? 'stopped' : 'bound', sourced.reason === 'stopped' ? STOPPED[language] : NOT_MADE[language], { consent: 'not-asked' });
    if (sourced.kind === 'failed') return refuse('read-failed', NOT_MADE[language], { consent: 'not-asked' });
    if (sourced.kind === 'listing-only') return refuse(sourced.reason, NOT_MADE[language], { consent: 'not-asked' });
    const consent = input.resume !== undefined ? 'granted' : 'not-needed';

    const source = sourced.source;
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
    if (outcome.kind === 'listing-only') return refuse(outcome.reason, NOT_MADE[language], { consent });
    if (outcome.kind === 'bound') return refuse('bound', NOT_MADE[language], { consent });
    if (outcome.kind === 'failed') return refuse('draft-refused', NOT_MADE[language], { consent, draftFailure: outcome.reason });

    // Which items the draft was made from (structure only): the admitted documents minus those the budget fit dropped from the end.
    const cap = Math.min(source.asked ?? source.documents.length, source.documents.length);
    const admitted = source.documents.filter((document) => document.position <= cap);
    const lost = Math.max(0, outcome.omitted - (source.dropped ?? 0) - (source.documents.length - admitted.length));
    const sent = admitted.slice(0, Math.max(0, admitted.length - lost));
    if (sent.length === 0) return refuse('no-documents', NOT_MADE[language], { consent });
    const draft = outcome.draft;

    // The exact payload (A7.5 step 6): the fixed provenance line, then the drafter's final lines. The hash covers these bytes only.
    const payloadText = [agentProposalProvenanceLine(source.entryId, sent.length), ...draft.lines].join('\n');
    const query = queryLiteralOf(read.args);
    const banner: AgentWriteProposalBanner = {
      source: { entryId: source.entryId, ...(query !== undefined ? { query } : {}) },
      items: sent.map((document) => ({ id: document.id, ...(dateOf(document.date) !== undefined ? { date: dateOf(document.date) as string } : {}) })),
      dropped: outcome.omitted,
      drafter: draft.locality === 'LOCAL' ? { locality: 'LOCAL' } : { locality: 'REMOTE', ...(input.resume !== undefined ? { operator: input.resume.recipient } : {}) },
    };
    audit.items = sent.length;
    audit.dropped = outcome.omitted;
    audit.drafterLocality = draft.locality;
    audit.consent = consent;

    // The kill switch, once more, right before the card (a stop that landed during the draft makes no card).
    if (input.stillRunning !== undefined && !(await input.stillRunning().catch(() => false))) return refuse('stopped', STOPPED[language]);
    if (input.signal?.aborted === true) return refuse('stopped', STOPPED[language]);

    const result = await deps.proposal.propose({
      operation: 'jira-comment',
      target: { issueKey: key },
      payloadText,
      actorId: input.actorId,
      sessionId: input.sessionId,
      grounding: 'owner-text',
      banner,
      named: draft.named,
      nonTargets: destinationShapedKeys(payloadText, key),
      now: input.now,
    });
    if (result.kind === 'wait-open-card') return done({ kind: 'wait', text: renderA7WaitLine(language, result.openTarget, key) }, 'wait-open-card');
    if (result.kind === 'refused') {
      const text = result.reason === 'payload-too-large' || result.reason === 'too-many-lines' ? TOO_LONG[language] : result.reason === 'owner-step-open' ? OWNER_STEP[language] : NOT_MADE[language];
      return refuse(result.reason, text);
    }
    return done({ kind: 'carded', card: result.card, cardId: result.cardId }, 'carded');
  } catch {
    return refuse('unsupported', NOT_MADE[language]);
  }
}

function queryLiteralOf(args: Readonly<Record<string, unknown>>): string | undefined {
  const value = args.keyword ?? args.query;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 80) : undefined;
}

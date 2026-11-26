import type { Actor, Id, IsoTimestamp, Session } from '../../domain';
import { SessionStatus } from '../../domain';
import {
  AGENT_WRITE_PROPOSAL_MAX_LINES,
  type AgentCardClosureState,
  type AgentWriteProposalPort,
  type AgentWriteProposalRefusal,
  type AgentWriteProposalRequest,
  type AgentWriteProposalResult,
} from '../../ports/agent-write-proposal.port';
import type { Logger } from '../../ports/logger.port';
import { PENDING_APPROVAL_TTL_MS } from '../conversation-commands';
import { plainTextOf } from '../message-rendering';
import { AGENT_PROPOSAL_CARD_MAX_CHARS, renderAgentProposalCard } from './connector-write-copy';
import { CONNECTOR_WRITE_ISSUE_KEY } from './connector-write-draft';
import { connectorWriteExecutionGate, isConnectorWriteAnchorLapsed, type ConnectorWriteFlow, type ConnectorWriteRefusal } from './connector-write-flow';
import { documentedExecutionPhrase } from '../execution-command-guard';

/**
 * ADR-0121 amendment A7, slice A7-S4a "card": the implementation of the proposal port ({@link AgentWriteProposalPort}) over the
 * existing ADR-0112 {@link ConnectorWriteFlow}. It lives OUTSIDE the agent module (the composition root wires it), so no connector
 * writer is reachable from `AgentRunService`.
 *
 * It adds no new write path: the card is a normal plan-less ADR-0112 anchor (CRITICAL `ApprovalRequest`, binding the actor, session,
 * target, operation and the payload SHA-256), prepared by `flow.prepare` exactly like the owner's own Jira comment request, so the
 * approval words (ADR-0095), the TTL (ADR-0093), the grant consumed before exactly one send, the never-retried `UNCERTAIN`, the
 * target-drift `NOT_SENT` and the allowlist check at the card and at execution are the flow's, unchanged. The only addition is the
 * anchor's `agentProposal` mark, which puts the card under the kill switch (A7.10).
 *
 * One open A7 card per owner (A7.4c item 3): the openness is read from the persisted anchors (`openAnchorsOf`), never from memory.
 */

export interface AgentWriteProposalServiceDeps {
  readonly flow: Pick<ConnectorWriteFlow, 'prepare' | 'openAnchorsOf' | 'find' | 'close' | 'supports' | 'anchorOfTask'>;
  readonly sessions: { get(id: Id): Promise<Session | null> };
  readonly actors: { get(id: Id): Promise<Actor | null> };
  readonly logger?: Logger;
}

const OPEN_STATUSES = new Set(['AWAITING_CHOICE', 'APPROVAL_PENDING', 'APPROVED', 'EXECUTING']);

export class AgentWriteProposalService implements AgentWriteProposalPort {
  constructor(private readonly deps: AgentWriteProposalServiceDeps) {}

  async openCardOf(actorId: Id, now: IsoTimestamp): Promise<{ readonly cardId: Id; readonly target: string } | undefined> {
    const open = await this.openAnchors(actorId, now);
    return open.card;
  }

  /**
   * A7-S4b (A7.4c item 4): why one card of this owner is no longer open, from its persisted anchor read directly by its task. Closed values:
   * only `sent`, `declined`, `expired` and `owner-void` may hand the card's items on; a stop, an unresolved outcome and anything unreadable
   * hand nothing on (`kill-switch`, `unknown`). Read-only and total.
   */
  async closureOf(request: { readonly sessionId: Id; readonly taskId: Id; readonly now: IsoTimestamp }): Promise<AgentCardClosureState> {
    try {
      const flow = this.deps.flow;
      if (flow.anchorOfTask === undefined) return 'unknown';
      const session = await this.deps.sessions.get(request.sessionId);
      if (session === null) return 'unknown';
      const view = await flow.anchorOfTask(session, request.taskId);
      const anchor = view?.anchor;
      if (view === null || anchor === undefined || anchor.agentProposal !== true) return 'unknown';
      if (OPEN_STATUSES.has(anchor.status)) {
        // `anchorOfTask` carries no approval record, so a pending card lapses by its age (the ADR-0093 lifetime), like `openAnchors`.
        if (anchor.status === 'APPROVAL_PENDING' && approvalLapsed(anchor.createdAt, request.now)) return 'expired';
        return isConnectorWriteAnchorLapsed(anchor, request.now) ? 'expired' : 'open';
      }
      if (anchor.status === 'SENT') return 'sent';
      if (anchor.status !== 'CLOSED') return 'unknown';
      switch (anchor.closedReason) {
        case 'denied':
          return 'declined';
        case 'expired':
          return 'expired';
        case 'cancelled':
        case 'superseded':
        case 'abandoned':
          return 'owner-void';
        case 'stopped':
          return 'kill-switch';
        default:
          return 'unknown';
      }
    } catch {
      return 'unknown';
    }
  }

  async propose(request: AgentWriteProposalRequest): Promise<AgentWriteProposalResult> {
    try {
      return await this.run(request);
    } catch {
      return { kind: 'refused', reason: 'unavailable' };
    }
  }

  private async openAnchors(actorId: Id, now: IsoTimestamp): Promise<{ card?: { cardId: Id; target: string }; otherOpen: boolean }> {
    const flow = this.deps.flow;
    if (flow.openAnchorsOf === undefined) return { otherOpen: true };
    let card: { cardId: Id; target: string } | undefined;
    let otherOpen = false;
    for (const { view } of await flow.openAnchorsOf(actorId)) {
      const anchor = view.anchor;
      if (!OPEN_STATUSES.has(anchor.status)) continue;
      // Review round 1 (CA P3, Codex P2): a card whose approval has lapsed or is gone, or a grant past its lifetime, is not open
      // (in any session): it must not block the next proposal.
      if (anchor.status === 'APPROVAL_PENDING' && (view.approval === null || approvalLapsed(anchor.createdAt, now))) continue;
      if (isConnectorWriteAnchorLapsed(anchor, now)) continue;
      if (anchor.agentProposal === true && anchor.approvalId !== undefined && anchor.target !== undefined) card ??= { cardId: anchor.approvalId, target: anchor.target };
      else otherOpen = true;
    }
    return { ...(card !== undefined ? { card } : {}), otherOpen };
  }

  private async run(request: AgentWriteProposalRequest): Promise<AgentWriteProposalResult> {
    const refused = (reason: AgentWriteProposalRefusal): AgentWriteProposalResult => ({ kind: 'refused', reason });
    if (request.operation !== 'jira-comment' || (request.grounding !== 'owner-text' && request.grounding !== 'owner-picked')) return refused('unavailable');
    const key = typeof request.target?.issueKey === 'string' ? request.target.issueKey.toUpperCase() : '';
    if (!CONNECTOR_WRITE_ISSUE_KEY.test(key)) return refused('invalid-target');
    const text = request.payloadText;
    if (typeof text !== 'string' || text.trim().length === 0 || /[\r\u0000]/u.test(text)) return refused('payload-invalid');
    // The writer sends one paragraph per line (a plain ADF text node each): a rendered line is a payload line, nothing more.
    if (text.split('\n').length > AGENT_WRITE_PROPOSAL_MAX_LINES) return refused('too-many-lines');

    const open = await this.openAnchors(request.actorId, request.now);
    if (open.card !== undefined) return { kind: 'wait-open-card', openTarget: open.card.target };
    if (open.otherOpen) return refused('owner-step-open');

    const draft = { kind: 'issue-comment' as const, issueKey: key, text };
    if (!this.deps.flow.supports(draft)) return refused('writes-off');
    const session = await this.deps.sessions.get(request.sessionId);
    const actor = await this.deps.actors.get(request.actorId);
    if (session === null || actor === null || session.actorId !== actor.id || session.status !== SessionStatus.ACTIVE) return refused('unavailable');

    // The card must show the payload whole BEFORE anything is prepared: a card that does not fit is never made (and no approval is left behind).
    const executionPhrase = documentedExecutionPhrase(connectorWriteExecutionGate('ISSUE_COMMENT'));
    const grounding = request.grounding === 'owner-picked' ? ({ grounding: 'owner-picked' as const }) : {};
    const cardInput = { issueKey: key, text, banner: request.banner, named: request.named, nonTargets: request.nonTargets, executionPhrase, ...grounding };
    // Measured in UTF-16 units (`.length`), the unit the smallest live chat adapter's chunker counts against its single-message limit (review round 2): a code-point count under-counts emoji.
    const probe = plainTextOf(renderAgentProposalCard({ ...cardInput, remainingMs: PENDING_APPROVAL_TTL_MS }));
    if (probe.length > AGENT_PROPOSAL_CARD_MAX_CHARS) return refused('payload-too-large');
    const cardFields = { banner: request.banner, named: request.named, nonTargets: request.nonTargets, ...grounding };

    const step = await this.deps.flow.prepare({ session, actor, now: request.now, agentProposal: true, agentCard: cardFields, draft });
    if (step.kind === 'writes-off') return refused('writes-off');
    if (step.kind === 'refused') return refused(refusalOf(step.reason));
    if (step.kind !== 'preview') return refused('unavailable');
    // The session as the flow just saved it (its `activeTaskId` now points at the new anchor).
    const live = (await this.deps.sessions.get(session.id)) ?? session;
    const view = await this.deps.flow.find(live);
    const anchor = view?.anchor;
    const bound =
      view !== null &&
      anchor !== undefined &&
      anchor.approvalId === step.approval.id &&
      anchor.agentProposal === true &&
      anchor.status === 'APPROVAL_PENDING' &&
      anchor.target === key &&
      anchor.payloadSha256 !== undefined &&
      step.preview.operation === 'ISSUE_COMMENT' &&
      step.preview.issueKey === key &&
      step.preview.text === text;
    if (!bound || view === null || anchor === undefined || anchor.payloadSha256 === undefined) {
      // Never leave a card the bytes of which are not the payload: voided, nothing sent.
      if (view !== null && view.anchor.approvalId === step.approval.id) await this.deps.flow.close(live, view, 'cancelled', request.now).catch(() => undefined);
      return refused('unavailable');
    }
    const card = renderAgentProposalCard({ ...cardInput, remainingMs: step.remainingMs, executionPhrase: step.executionPhrase, ...(step.unconfirmedEarlier !== undefined ? { unconfirmedEarlier: step.unconfirmedEarlier } : {}) });
    // The kill switch, once more, now that the card exists (review round 1, CA P3): a stop that landed meanwhile closes the card.
    if (request.stillRunning !== undefined && !(await request.stillRunning().catch(() => false))) {
      await this.deps.flow.close(live, view, 'stopped', request.now).catch(() => undefined);
      return refused('stopped');
    }
    // The card as it will be SHOWN (its own remaining time and execution phrase) must fit whole too (review round 1, CA P3).
    if (plainTextOf(card).length > AGENT_PROPOSAL_CARD_MAX_CHARS) {
      await this.deps.flow.close(live, view, 'cancelled', request.now).catch(() => undefined);
      return refused('payload-too-large');
    }
    this.log('a7_card.carded', { operation: 'ISSUE_COMMENT', approvalId: step.approval.id });
    return { kind: 'carded', cardId: step.approval.id, card, payloadSha256: anchor.payloadSha256, taskId: view.taskId };
  }

  private log(event: string, fields: { readonly operation: string; readonly approvalId: Id }): void {
    try {
      this.deps.logger?.info(event, fields);
    } catch {
      // best-effort
    }
  }
}

function approvalLapsed(since: IsoTimestamp, now: IsoTimestamp): boolean {
  const start = Date.parse(since);
  return !Number.isFinite(start) || Date.parse(now) - start >= PENDING_APPROVAL_TTL_MS;
}

function refusalOf(reason: ConnectorWriteRefusal): AgentWriteProposalRefusal {
  switch (reason) {
    case 'target-not-allowed':
      return 'target-not-allowed';
    case 'invalid-target':
      return 'invalid-target';
    case 'invalid-text':
      return 'payload-invalid';
    case 'text-too-long':
      return 'payload-too-large';
    case 'credential':
      return 'credential';
    default:
      return 'unavailable';
  }
}

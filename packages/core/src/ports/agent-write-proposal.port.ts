import type { Id, IsoTimestamp, MessageBody } from '../domain';

/**
 * ADR-0121 amendment A7, slice A7-S4a "card": the narrow proposal port (A7.5 step 7). The bounded agent hands ONE finished
 * proposal to the existing ADR-0112 connector-write flow through this interface; it never holds a writer, a receipt store or a
 * flow. The interface is declared here (Core ports) and implemented OUTSIDE the agent module (`connector-writes/`, wired in the
 * composition root), so the import scan that no connector writer is reachable from `AgentRunService` stays true.
 *
 * The signature carries closed values, plain strings and counts only: no platform, storage or driver type. Nothing in a request is
 * a step, a target or an argument the model chose: the destination is the owner's own literal (A7.4a), the payload is the exact
 * bytes Core assembled (A7.5 step 6), and the banner holds structure only (no content).
 */

/** The destinations this port can card. Only the Jira comment exists in A7-S4a (Slack and calendar are A7-S6 and A7-S7). */
export type AgentWriteProposalOperation = 'jira-comment';

/** One source item as the banner names it: its closed-format id and its date only (never a title, author or body). */
export interface AgentWriteProposalBannerItem {
  readonly id: string;
  /** `YYYY-MM-DD` or absent. */
  readonly date?: string;
}

/** The content-free provenance facts of the card (A7.5 step 7, A7.11 question 7). */
export interface AgentWriteProposalBanner {
  readonly source: {
    /** The catalog READ entry id (`slack.search`, `jira.issues`, ...). */
    readonly entryId: string;
    /** The owner's own query literal of the source read, when it had one (shown as inert untrusted text). */
    readonly query?: string;
  };
  readonly items: readonly AgentWriteProposalBannerItem[];
  /** Items the owner was asked about (or that were listed) that changed or left between the read and the draft (a7-06): left out. */
  readonly dropped: number;
  /** Other items left out of the draft (the item cap, host-only or empty readouts, a credential-shaped item, the input budget): NOT drift. */
  readonly omitted: number;
  /** Where the drafter ran: `LOCAL` (this computer) or `REMOTE` with the recipient's display name. */
  readonly drafter: { readonly locality: 'LOCAL' | 'REMOTE'; readonly operator?: string };
}

/** The content-free fields of a card besides the payload text and the destination (kept on the anchor for the re-shown card). */
export interface AgentProposalCardFields {
  readonly banner: AgentWriteProposalBanner;
  readonly named: number;
  readonly nonTargets: readonly string[];
  /**
   * UNC-1 (review round 2): an earlier write of the same payload to the same target is unresolved. Set by the flow itself when it prepares
   * the card (never by the agent), so the first and the re-shown card carry the same existing warning.
   */
  readonly unconfirmedEarlier?: { readonly status: 'UNCERTAIN' | 'EXECUTING'; readonly at: IsoTimestamp; readonly timeZone: string };
  /**
   * A7-S4b: where the destination came from (A7.5 step 7): the owner's own words (the default, the card says "대상은 보내신 문장에서") or a number
   * the owner picked from a destination listing (A7.4b, the card says "직접 고르신 대상"). Absent: `owner-text`.
   */
  readonly grounding?: 'owner-text' | 'owner-picked';
}

export interface AgentWriteProposalRequest {
  readonly operation: AgentWriteProposalOperation;
  /** The destination, grounded in the owner's own words (A7.4a). Never a model-written value. */
  readonly target: { readonly issueKey: string };
  /** The exact payload bytes: the card shows them and the writer sends them, and the SHA-256 covers them (ADR-0112). */
  readonly payloadText: string;
  readonly actorId: Id;
  readonly sessionId: Id;
  /** `owner-picked`: the destination is an `OWNER_PICKED_DESTINATION` of one A7 propose step (A7.4b). Anything else is refused. */
  readonly grounding: 'owner-text' | 'owner-picked';
  readonly banner: AgentWriteProposalBanner;
  /** The number of distinct people the remap named (the card's fixed line). */
  readonly named: number;
  /** Destination-shaped tokens inside the payload that are not the destination (see {@link destinationShapedKeys}). */
  readonly nonTargets: readonly string[];
  readonly now: IsoTimestamp;
  /**
   * The persisted kill switch, re-read after the card is prepared (review round 1, CA P3): a stop that lands between the last check and
   * the card closes the card ('stopped'). Absent: not checked here.
   */
  readonly stillRunning?: () => Promise<boolean>;
}

/** Why no card was made (closed values; the owner is told with a fixed line, nothing was sent). */
export type AgentWriteProposalRefusal =
  /** No connector writer is bound for this destination. */
  | 'writes-off'
  | 'target-not-allowed'
  | 'invalid-target'
  /** The payload cannot be shown whole on one card (a payload that cannot be shown whole is never carded). */
  | 'payload-too-large'
  | 'payload-invalid'
  | 'credential'
  | 'too-many-lines'
  /** Another owner step (an ordinary connector-write approval) is open (W2): nothing is carded. */
  | 'owner-step-open'
  /** The kill switch was stopped while the card was being made: it was closed. */
  | 'stopped'
  | 'unavailable';

export type AgentWriteProposalResult =
  | {
      readonly kind: 'carded';
      readonly cardId: Id;
      readonly card: MessageBody;
      readonly payloadSha256: string;
      /** A7-S4b: the task the card's anchor lives on (opaque; only handed back to {@link AgentWriteProposalPort.closureOf}). */
      readonly taskId?: Id;
    }
  | { readonly kind: 'refused'; readonly reason: AgentWriteProposalRefusal }
  /** A7.4c item 3: an A7 card of this owner is still open; nothing was carded. `openTarget` is that card's destination. */
  | { readonly kind: 'wait-open-card'; readonly openTarget: string };

/**
 * A7-S4b (A7.4c item 4): why an A7 card is no longer open, as a closed value read from its persisted anchor. `open` means still open.
 * `unknown` covers every closure that hands nothing on (an unresolved or unsent outcome, an inconsistent anchor, a missing anchor).
 */
export type AgentCardClosureState = 'open' | 'sent' | 'declined' | 'expired' | 'owner-void' | 'kill-switch' | 'unknown';

export interface AgentWriteProposalPort {
  /**
   * A7-S4b: the closure of one card of this owner (A7.4c item 4). Optional: a port without it never lets a closed card hand anything
   * on. Read-only; closed values only.
   */
  closureOf?(request: { readonly sessionId: Id; readonly taskId: Id; readonly now: IsoTimestamp }): Promise<AgentCardClosureState>;
  /** The destination of this owner's open A7 card, if one is open (checked BEFORE anything is read or drafted). A card whose approval or grant has lapsed at `now` is not open. */
  openCardOf(actorId: Id, now: IsoTimestamp): Promise<{ readonly cardId: Id; readonly target: string } | undefined>;
  propose(request: AgentWriteProposalRequest): Promise<AgentWriteProposalResult>;
}

/** The most lines one Jira comment payload may have: the fixed provenance line plus the draft's 8 lines. */
export const AGENT_WRITE_PROPOSAL_MAX_LINES = 9;

/**
 * The A1-D4 Jira key grammar without anchors, the same text as `NL_REF_JIRA_KEY` in `nl-routing/action-entries` (a test pins the two
 * to each other; a port does not import application code).
 */
export const AGENT_WRITE_PROPOSAL_KEY_BODY = '[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}';

/**
 * Every destination-shaped token in `text` that is not `destination`: a Jira issue key in the A1-D4 grammar
 * (`NL_REF_JIRA_KEY`), found as a whole word, case-insensitively, upper-cased, distinct, in order of appearance. Structural only
 * (the key grammar), never a word list. Pure and total.
 */
export function destinationShapedKeys(text: string, destination: string): string[] {
  try {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${AGENT_WRITE_PROPOSAL_KEY_BODY}(?![A-Za-z0-9_])`, 'giu');
    const own = destination.toUpperCase();
    const found: string[] = [];
    for (const match of text.matchAll(pattern)) {
      const key = match[0].toUpperCase();
      if (key !== own && !found.includes(key)) found.push(key);
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * The fixed provenance line a payload starts with (A7.11 question 7: yes): the source kind and the number of items the draft was
 * made from, never any content. Part of the hashed payload bytes (the card shows it and the writer sends it).
 */
export function agentProposalProvenanceLine(entryId: string, count: number): string {
  const kind = entryId.startsWith('slack.') ? 'Slack 메시지' : entryId.startsWith('jira.') ? 'Jira 이슈' : '항목';
  return `[Quoky 요약] 출처: ${kind} ${count}건`;
}

/**
 * ADR-0121 amendment A4 (pattern A, owner-grounded linkage), A4.3 "A1-D2 (table)": the closed value kinds a handoff may
 * extract and the closed table of declared destination slots. Data only; the plan validator (`plan-validator.ts`) and the
 * plan eval corpus (`apps/quoky/src/tools/agent-plan-eval.ts`, which re-exports these and pins them equal to the
 * `s2-handoff` corpus header) read the same table, so a new row needs its own ADR-0120 amendment first.
 */

/** A4 pattern A: the closed value kinds a handoff may extract (A1-D4, plus `driveRef` and `titleKeyword`). */
export const AGENT_HANDOFF_KINDS = ['date', 'jiraKey', 'email', 'attendee', 'prRef', 'driveRef', 'titleKeyword', 'keyword'] as const;
export type AgentHandoffKind = (typeof AGENT_HANDOFF_KINDS)[number];

/** A4.4: the free-text kinds; an each-item run of any of them needs one batched preview first (`consent: "batch-preview"`). */
export const AGENT_HANDOFF_FREE_TEXT_KINDS: readonly AgentHandoffKind[] = ['titleKeyword', 'keyword'];

/** A4 handoff scopes (A4.3 "A1-D3"): one owner-designated or owner-picked item, or every listed item (at most 10 values). */
export const AGENT_HANDOFF_SCOPES = ['one-item', 'each-item'] as const;
/** `one-item` only: `first` is the most recent item ("the last mail"), `owner-pick` the listing and the owner's pick (A1-D3). */
export const AGENT_HANDOFF_ITEMS = ['first', 'owner-pick'] as const;
/** The only consent form (A4.4): every exact free-text value is shown once and nothing is sent before the owner's yes. */
export const AGENT_HANDOFF_CONSENT = 'batch-preview';

/**
 * The closed table of declared destination slots (`<entryId>.<slot>`) and the kinds each accepts (A1-D2, extended by A4).
 * A `planned` slot is not an argument of the catalog entry yet (slice A4-S3, each by its own ADR-0120 amendment and D12
 * evaluation): the validator refuses a handoff into it until the catalog declares it and the row is flipped.
 */
export const AGENT_HANDOFF_SLOTS: Readonly<Record<string, { readonly kinds: readonly AgentHandoffKind[]; readonly planned: boolean }>> = Object.freeze({
  'calendar.events.range': { kinds: ['date'], planned: false },
  'calendar.events.attendee': { kinds: ['email'], planned: true },
  'mail.list.from': { kinds: ['attendee', 'email'], planned: false },
  'mail.list.keyword': { kinds: ['titleKeyword'], planned: true },
  'jira.issue.key': { kinds: ['jiraKey'], planned: true },
  'jira.issues.keyword': { kinds: ['titleKeyword', 'keyword'], planned: false },
  'jira.issues.person': { kinds: ['email'], planned: true },
  'slack.search.keyword': { kinds: ['jiraKey', 'prRef', 'keyword'], planned: false },
  'confluence.search.keyword': { kinds: ['titleKeyword'], planned: false },
  'github.pr.ref': { kinds: ['prRef'], planned: true },
  'drive.file.ref': { kinds: ['driveRef'], planned: true },
});

import type { ConnectorWriteOperation } from '../../ports/connector-write.port';
import type { SurfaceClaim } from '../../ports/conversation-turn-handler.port';
import type { ConnectorWriteDraft, ConnectorWriteFamily } from '../connector-writes/connector-write-draft';
import { connectorWriteFamilyOf } from '../connector-writes/connector-write-draft';
import type { NlArgs, NlCatalogEntryId, NlSelectedCommand } from '../nl-routing/catalog';
import { nlStringArg } from '../nl-routing/catalog';
import type { WorkChatCommand, WorkChatSource } from '../work-chat/work-chat-command';
import type { SurfaceGroupId } from './surface-groups';

/**
 * ADR-0122 D2: the maps from what a turn would run to the groups the gate checks. Each map is exhaustive at compile time
 * (a `Record` over the closed ids, or a switch with a `never` default), so a new catalog entry, work command, write
 * family or state-bound step is a type error until it is mapped here. Every listed group must pass.
 */

/** A handler's claim over `groups` (every map returns at least one group; an empty list fails closed to `code`). */
export function surfaceClaimOf(groups: readonly SurfaceGroupId[], onDeny: SurfaceClaim['onDeny'] = 'reply'): SurfaceClaim {
  const [first, ...rest] = groups;
  return { groups: [first ?? 'code', ...rest], onDeny };
}

// ── natural-language selection (D2.2) ────────────────────────────────────────────────────────────────────────────

const ENTRY_GROUPS: Readonly<Record<NlCatalogEntryId, readonly SurfaceGroupId[]>> = {
  'jira.issues': ['jira-mine'],
  // Per args: see `surfaceGroupsOfSelection`.
  'jira.release': ['jira-project'],
  'github.items': ['github'],
  'slack.search': ['slack-search'],
  'confluence.search': ['confluence'],
  'calendar.events': ['calendar'],
  'mail.list': ['mail'],
  'drive.files': ['drive'],
  // Interim P1 rule (until the P2 composite permit filters the sections): the combined view also shows Jira and GitHub
  // items, so all three groups are required.
  'todo.list': ['todo', 'jira-mine', 'github'],
  'reminder.list': ['reminder'],
  'brief.today': ['brief'],
  'help.topic': ['help'],
  // A6-D1: every action entry is DM-only.
  'todo.add': ['nl-actions'],
  'todo.complete': ['nl-actions'],
  'todo.cancel': ['nl-actions'],
  'reminder.create': ['nl-actions'],
  'reminder.cancel': ['nl-actions'],
  'action.undo': ['nl-actions'],
  'item.summarize': ['nl-actions'],
  'slack.post': ['nl-actions'],
  'calendar.create': ['nl-actions'],
};

/**
 * The groups of one validated selection. `jira.release` is `jira-mine` only with `scope=mine` (the default) AND a named
 * release or a release link in the owner's own words; any other release request (every assignee, a project's release
 * list) is `jira-project` (D1 rows, owner decision 4).
 */
export function surfaceGroupsOfSelection(
  command: { readonly entryId: NlCatalogEntryId; readonly args: NlArgs },
  options: { readonly releaseLink?: boolean } = {},
): readonly SurfaceGroupId[] {
  if (command.entryId === 'jira.release') {
    const mine = nlStringArg(command.args, 'scope') !== 'all';
    const named = nlStringArg(command.args, 'release') !== undefined || options.releaseLink === true;
    return mine && named ? ['jira-mine'] : ['jira-project'];
  }
  return ENTRY_GROUPS[command.entryId];
}

/** The groups of a selected command (the runtime passes whether the owner's words carry a release link). */
export function surfaceGroupsOfSelectedCommand(command: Pick<NlSelectedCommand, 'entryId' | 'args'>, releaseLink = false): readonly SurfaceGroupId[] {
  return surfaceGroupsOfSelection(command, { releaseLink });
}

// ── connector writes (D1 `writes`: also the service's read group) ────────────────────────────────────────────────

export function surfaceReadGroupOfWriteFamily(family: ConnectorWriteFamily): SurfaceGroupId {
  switch (family) {
    case 'issue-comment':
    case 'issue-transition':
      return 'jira-mine';
    case 'channel-post':
      return 'slack-search';
    case 'calendar':
      return 'calendar';
    default: {
      const unmapped: never = family;
      return unmapped;
    }
  }
}

export function surfaceGroupsOfWriteFamily(family: ConnectorWriteFamily): readonly SurfaceGroupId[] {
  return ['writes', surfaceReadGroupOfWriteFamily(family)];
}

export function surfaceGroupsOfWriteDraft(draft: ConnectorWriteDraft): readonly SurfaceGroupId[] {
  return surfaceGroupsOfWriteFamily(connectorWriteFamilyOf(draft));
}

export function surfaceWriteFamilyOfOperation(operation: ConnectorWriteOperation): ConnectorWriteFamily {
  switch (operation) {
    case 'ISSUE_COMMENT':
      return 'issue-comment';
    case 'ISSUE_TRANSITION':
      return 'issue-transition';
    case 'CHANNEL_POST':
      return 'channel-post';
    case 'CALENDAR_EVENT_CREATE':
    case 'CALENDAR_EVENT_UPDATE':
    case 'CALENDAR_EVENT_DELETE':
      return 'calendar';
    default: {
      const unmapped: never = operation;
      return unmapped;
    }
  }
}

export function surfaceGroupsOfWriteOperation(operation: ConnectorWriteOperation): readonly SurfaceGroupId[] {
  return surfaceGroupsOfWriteFamily(surfaceWriteFamilyOfOperation(operation));
}

// ── work chat commands (D2.1, ADR-0100 D2) ───────────────────────────────────────────────────────────────────────

export function surfaceReadGroupOfWorkSource(source: WorkChatSource): SurfaceGroupId {
  switch (source) {
    case 'jira':
      return 'jira-mine';
    case 'github':
      return 'github';
    case 'slack':
      return 'slack-search';
    case 'confluence':
      return 'confluence';
    default: {
      const unmapped: never = source;
      return unmapped;
    }
  }
}

/** The groups of one work-chat command (the grammar's command, or a selection mapped to it). */
export function surfaceGroupsOfWorkChatCommand(command: WorkChatCommand): readonly SurfaceGroupId[] {
  switch (command.kind) {
    case 'todo.add':
    case 'todo.complete':
    case 'todo.cancel':
    case 'todo.link':
    case 'todo.status':
    case 'todo.hint':
      return ['todo'];
    // The combined view (interim P1 rule, see `ENTRY_GROUPS['todo.list']`).
    case 'todo.list':
    case 'todo.summary':
      return ['todo', 'jira-mine', 'github'];
    case 'lookup':
      return [surfaceReadGroupOfWorkSource(command.source)];
    case 'release':
      return command.scope === 'mine' && (command.release !== undefined || command.links.length > 0) ? ['jira-mine'] : ['jira-project'];
    case 'connector-write':
      return surfaceGroupsOfWriteDraft(command.draft);
    // Fixed copy that reads nothing.
    case 'external-write-unsupported':
    case 'usage':
      return ['help'];
    default: {
      const unmapped: never = command;
      return unmapped;
    }
  }
}

// ── the state-bound code-change section (D2.3) ───────────────────────────────────────────────────────────────────

/**
 * Every step of the state-bound section, in the order the runtime routes them. Adding a step needs a row here and in
 * `surfaceGroupOfStateStep`.
 */
export const STATE_BOUND_STEPS = [
  /** A pending decision that intercepts every turn: plan, apply, commit, push, PR, merge, remote cleanup approvals. */
  'pending-decision',
  /** The ADR-0037 scope clarification and the ADR-0097 credential override (code work). */
  'scope-clarification',
  'credential-override',
  'preview-discard',
  'validation',
  'git-preview',
  'commit',
  'push',
  'pr-create',
  'pr-status',
  'merge',
  'main-sync',
  'local-cleanup',
  'remote-cleanup',
  'apply',
  'patch',
  /** A fixed state reply of the chain (already pushed, unsupported companion, no target, execution-phrase hint, …). */
  'chain-reply',
  /** ADR-0104 D3 B0b: a status question about a code-chain action, answered from the anchor. */
  'internal-status',
] as const;
export type StateBoundStep = (typeof STATE_BOUND_STEPS)[number];

/** PR status → `github`; every other step → `code` (push, PR creation, merge and remote delete are its strong part). */
export function surfaceGroupOfStateStep(step: StateBoundStep): SurfaceGroupId {
  switch (step) {
    case 'pr-status':
      return 'github';
    case 'pending-decision':
    case 'scope-clarification':
    case 'credential-override':
    case 'preview-discard':
    case 'validation':
    case 'git-preview':
    case 'commit':
    case 'push':
    case 'pr-create':
    case 'merge':
    case 'main-sync':
    case 'local-cleanup':
    case 'remote-cleanup':
    case 'apply':
    case 'patch':
    case 'chain-reply':
    case 'internal-status':
      return 'code';
    default: {
      const unmapped: never = step;
      return unmapped;
    }
  }
}

// ── approvals decided from the operations UI (D2.5) ──────────────────────────────────────────────────────────────

/** The approval kinds of `ApprovalDecisionService` (kept structural so this module has no service import). */
export type SurfaceApprovalKind =
  | 'PLAN'
  | 'CREDENTIAL_OVERRIDE'
  | 'CONNECTOR_WRITE'
  | 'APPLY'
  | 'COMMIT'
  | 'PUSH'
  | 'PR'
  | 'MERGE'
  | 'REMOTE_BRANCH_CLEANUP';

export function surfaceGroupsOfApproval(kind: SurfaceApprovalKind, family?: ConnectorWriteFamily): readonly SurfaceGroupId[] {
  switch (kind) {
    case 'CONNECTOR_WRITE':
      // Fail closed: a write approval with no known family needs every write-related read group.
      return family !== undefined ? surfaceGroupsOfWriteFamily(family) : ['writes', 'jira-mine', 'slack-search', 'calendar'];
    case 'PLAN':
    case 'CREDENTIAL_OVERRIDE':
    case 'APPLY':
    case 'COMMIT':
    case 'PUSH':
    case 'PR':
    case 'MERGE':
    case 'REMOTE_BRANCH_CLEANUP':
      return ['code'];
    default: {
      const unmapped: never = kind;
      return unmapped;
    }
  }
}

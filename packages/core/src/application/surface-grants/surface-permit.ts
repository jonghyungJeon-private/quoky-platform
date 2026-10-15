import type { ConversationContext } from '../../domain';
import { isDirectConversation } from '../message-rendering';
import { WORK_SURFACE_SOURCES, type WorkSurfaceSource } from '../work-surface-query';
import type { SurfaceGroupId } from './surface-groups';

/**
 * ADR-0122 D2.4 (P2): the content-free permit the gate hands a handler on `TurnHandlerContext.surfacePermit` — the set of
 * groups the turn's channel holds right now. It is the gate's decision; a handler only filters by it and never reads a
 * grant itself. Present only in a channel while `QUOKY_CHANNEL_GRANTS=enforce`; absent in a DM, with the gate `off` or
 * without the dep (then every handler behaves exactly as before).
 */
export interface SurfacePermit {
  /** The allowed groups, in table order (always groups included). */
  readonly allowed: readonly SurfaceGroupId[];
}

/**
 * Whether a composite view may include `group`'s section: without a permit (DM, gate off or absent) every section is
 * read as before; with one, only the allowed groups.
 */
export function surfacePermitAllows(permit: SurfacePermit | undefined, group: SurfaceGroupId): boolean {
  return permit === undefined || permit.allowed.includes(group);
}

/**
 * Whether a second-layer DM-only rule (the P0 memory / learning / feedback-summary copy, the to-do and reminder status
 * views, the A8 release lists) is lifted for this turn: always in a DM; in a channel only when the gate is enforced and
 * the channel holds `group` (a permit naming it). With the gate `off` a channel keeps the DM-only rule (owner: the P0
 * privacy stays).
 */
export function surfaceChannelHolds(
  context: ConversationContext,
  permit: SurfacePermit | undefined,
  group: SurfaceGroupId,
): boolean {
  return isDirectConversation(context) || permit?.allowed.includes(group) === true;
}

/** The personal-work sources and the group each needs (D2.4). */
const WORK_SOURCE_GROUP: Readonly<Record<WorkSurfaceSource, SurfaceGroupId>> = { jira: 'jira-mine', github: 'github' };

/**
 * D2.4: the Jira / GitHub sections a composite "my work" view may read under this permit (`sources`, in their order) and
 * the ones it must leave out unread (`withheld`). Without a permit every source is read and none is withheld.
 */
export function surfacePermittedWorkSources(permit: SurfacePermit | undefined): {
  readonly sources: readonly WorkSurfaceSource[];
  readonly withheld: readonly WorkSurfaceSource[];
} {
  const sources = WORK_SURFACE_SOURCES.filter((source) => surfacePermitAllows(permit, WORK_SOURCE_GROUP[source]));
  return { sources, withheld: WORK_SURFACE_SOURCES.filter((source) => !sources.includes(source)) };
}

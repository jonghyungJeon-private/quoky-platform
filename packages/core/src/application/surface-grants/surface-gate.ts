import type { Actor, ConversationContext } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import { readActionSwitch } from '../nl-routing/action-switch';
import { SURFACE_GRANTS_METADATA_KEY, grantedSurfaceGroups, readSurfaceGrants, surfaceChannelKey } from './surface-grant-record';
import { SURFACE_GROUPS, type SurfaceGroupId } from './surface-groups';

/**
 * ADR-0122 D2: the ONE Core gate. `decide(context, actor, groups)` is pure and synchronous: it reads only the
 * conversation's generic fields (`platform` as an opaque string, `spaceId`, `channelId`, `direct`), the actor's metadata
 * (grants and the A6 kill switch) and nothing else — no platform or provider branch (D2.10).
 *
 * - `QUOKY_CHANNEL_GRANTS=off`: every decision allows (today's behaviour; P0 gates stay in their handlers).
 * - A DM (`direct === true`; an absent flag is a channel, fail closed — D2.8): every group passes, nothing is logged.
 * - A channel: `always` groups pass; a `dm-only` group is denied (`dm-only`); a grantable group passes only when the
 *   channel holds a grant for it and the kill switch is running (`not-granted` / `suspended`). Every required group must
 *   pass; the first failing one names the denial. No group at all is `unclassified` (fail closed).
 */

export type SurfaceGrantsMode = 'enforce' | 'off';
export const SURFACE_GRANTS_MODES: readonly SurfaceGrantsMode[] = ['enforce', 'off'];

export type SurfaceDenyReason = 'not-granted' | 'dm-only' | 'suspended' | 'unclassified';
/** Where the gate was asked (content-free audit field, D3). */
export type SurfaceGatePath = 'grammar' | 'selection' | 'route' | 'approval' | 'delivery' | 'reaction';

export type SurfaceDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: SurfaceDenyReason; readonly group?: SurfaceGroupId };

const ALLOW: SurfaceDecision = Object.freeze({ allow: true });

/** Whether the context is a DM for the gate: only an explicit `direct === true` (D2.8). */
export function isSurfaceDirect(context: Pick<ConversationContext, 'direct'>): boolean {
  return context.direct === true;
}

/** The pure decision (mode, surface, class, grant, kill switch). */
export function decideSurface(input: {
  readonly mode: SurfaceGrantsMode;
  readonly context: Pick<ConversationContext, 'platform' | 'spaceId' | 'channelId' | 'direct'>;
  readonly actor: Pick<Actor, 'metadata'>;
  readonly groups: readonly SurfaceGroupId[];
}): SurfaceDecision {
  if (input.mode !== 'enforce') return ALLOW;
  if (isSurfaceDirect(input.context)) return ALLOW;
  if (input.groups.length === 0) return { allow: false, reason: 'unclassified' };
  for (const id of input.groups) {
    if (SURFACE_GROUPS[id].class === 'dm-only') return { allow: false, reason: 'dm-only', group: id };
  }
  const grantable = input.groups.filter((id) => SURFACE_GROUPS[id].class === 'grantable');
  if (grantable.length === 0) return ALLOW;
  if (readActionSwitch(input.actor).state === 'stopped') return { allow: false, reason: 'suspended', group: grantable[0]! };
  const granted = new Set(grantedSurfaceGroups(readSurfaceGrants(input.actor.metadata?.[SURFACE_GRANTS_METADATA_KEY]), surfaceChannelKey(input.context)));
  for (const id of grantable) {
    if (!granted.has(id)) return { allow: false, reason: 'not-granted', group: id };
  }
  return ALLOW;
}

/** The groups the actor's grants allow in this channel right now (DM / off: every group). Content-free. */
export function allowedSurfaceGroups(input: {
  readonly mode: SurfaceGrantsMode;
  readonly context: Pick<ConversationContext, 'platform' | 'spaceId' | 'channelId' | 'direct'>;
  readonly actor: Pick<Actor, 'metadata'>;
}): ReadonlySet<SurfaceGroupId> {
  const all = Object.keys(SURFACE_GROUPS) as SurfaceGroupId[];
  return new Set(all.filter((id) => decideSurface({ ...input, groups: [id] }).allow));
}

export interface SurfaceGateAudit {
  readonly path: SurfaceGatePath;
  readonly handlerId?: string;
  readonly entryId?: string;
}

/** The gate with its mode and its content-free audit log (D3). */
export class SurfaceGate {
  constructor(
    readonly mode: SurfaceGrantsMode,
    private readonly logger?: Pick<Logger, 'info' | 'warn'>,
  ) {}

  get enforced(): boolean {
    return this.mode === 'enforce';
  }

  /**
   * Decide and log: a denial logs `surface_gate.denied {platform, channelId, group, path, reason, handlerId?, entryId?}`
   * (ids and closed values only). An allowed decision logs nothing (the `Logger` port has no debug level); a DM never
   * logs.
   */
  decide(
    context: Pick<ConversationContext, 'platform' | 'spaceId' | 'channelId' | 'direct'>,
    actor: Pick<Actor, 'metadata'>,
    groups: readonly SurfaceGroupId[],
    audit: SurfaceGateAudit,
  ): SurfaceDecision {
    const decision = decideSurface({ mode: this.mode, context, actor, groups });
    if (this.mode !== 'enforce' || isSurfaceDirect(context)) return decision;
    const fields = {
      platform: context.platform,
      channelId: context.channelId,
      path: audit.path,
      ...(audit.handlerId !== undefined ? { handlerId: audit.handlerId } : {}),
      ...(audit.entryId !== undefined ? { entryId: audit.entryId } : {}),
    };
    try {
      if (!decision.allow) this.logger?.info('surface_gate.denied', { ...fields, group: decision.group ?? 'none', reason: decision.reason });
    } catch {
      // best-effort
    }
    return decision;
  }

  /** D2.9: a defect — a handler's outcome does not match its claim (or it has none). Logged, never expected. */
  logMismatch(fields: { readonly handlerId: string; readonly claimed: string; readonly entryId?: string }): void {
    try {
      this.logger?.warn('surface_gate.mismatch', { handlerId: fields.handlerId, claimed: fields.claimed, ...(fields.entryId !== undefined ? { entryId: fields.entryId } : {}) });
    } catch {
      // best-effort
    }
  }
}

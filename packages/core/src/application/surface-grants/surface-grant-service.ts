import type { Actor, ConversationContext, Id, InboundMessage, IsoTimestamp } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import type { OwnerNotification } from '../../ports/notification-sink.port';
import { newId } from '../../util/id';
import type { ActorMetadataStore } from '../actor-metadata-store';
import { ACTION_SWITCH_METADATA_KEY, parseActionSwitchPhrase, readActionSwitch, withActionSwitch, type NlActionSwitchState } from '../nl-routing/action-switch';
import {
  renderSurfaceAllChannelsList,
  renderSurfaceAllCleared,
  renderSurfaceChannelCleared,
  renderSurfaceChannelList,
  renderSurfaceGrantChannelOnly,
  renderSurfaceGrantDmOnlyGroup,
  renderSurfaceGrantNotYet,
  renderSurfaceGrantUsage,
  renderSurfaceGrantWriteFailed,
  renderSurfaceRevokeReceipt,
  renderSurfaceRevoked,
  renderSurfaceSwitchReply,
  type SurfaceCopyLanguage,
} from './surface-grant-copy';
import { isSurfaceDirect } from './surface-gate';
import { parseSurfaceGrantPhrase } from './surface-grant-phrases';
import {
  SURFACE_GRANTS_METADATA_KEY,
  applySurfaceGrantSeed,
  grantedSurfaceGroups,
  parseSurfaceChannelKey,
  readSurfaceGrants,
  serializeSurfaceGrants,
  surfaceChannelKey,
  withAllSurfaceGrantsCleared,
  withSurfaceChannelCleared,
  withSurfaceGroupsRevoked,
  type SurfaceGrantRecord,
  type SurfaceGrantSeed,
  type SurfaceGrantSeedResult,
} from './surface-grant-record';
import { SURFACE_GROUPS, type SurfaceGroupId } from './surface-groups';

/**
 * ADR-0122 D3/D4/D6 (P1): the grant service — the owner's list and revoke phrases, the startup seed and the kill-switch
 * phrase while only the channel grants are on. The ONLY writer of `quoky.surfaceGrants` (with the seed), always through
 * the per-actor metadata lock. Content-free logs; one-line owner DM receipts through the `NotificationSink`.
 *
 * Owner check (D3): the phrase counts only when the composition root's `isOwner` says the turn's actor holds the
 * message's `(platform, userId)` identity and is the configured owner; otherwise the text is ordinary text (no reply that
 * reveals the feature) and `surface_grant.refused reason=not-owner` is logged.
 */

export interface SurfaceGrantServiceDeps {
  readonly metadata: Pick<ActorMetadataStore, 'updateMetadataEntry'>;
  readonly isOwner: (actor: Pick<Actor, 'id' | 'identities'>, context: Pick<ConversationContext, 'platform' | 'userId'>) => boolean;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /** The owner notification sink (`SURFACE_GRANT`, DM-only). Absent: no receipt. */
  readonly notify?: (notification: OwnerNotification) => Promise<unknown>;
}

function languageOfText(text: string): SurfaceCopyLanguage {
  return /[가-힣]/u.test(text) || !/[A-Za-z]/.test(text) ? 'ko' : 'en';
}

export class SurfaceGrantService {
  constructor(private readonly deps: SurfaceGrantServiceDeps) {}

  /**
   * The owner's phrase, answered with fixed copy; `undefined` when the text is not a grant phrase (or not the owner's),
   * so the turn routes as before. Never throws.
   */
  async handlePhrase(message: InboundMessage, actor: Actor, now: IsoTimestamp): Promise<string | undefined> {
    let phrase;
    try {
      phrase = parseSurfaceGrantPhrase(message);
    } catch {
      return undefined;
    }
    if (phrase === undefined) return undefined;
    if (!this.deps.isOwner(actor, message.context)) {
      this.log('warn', 'surface_grant.refused', { reason: 'not-owner' });
      return undefined;
    }
    const language = languageOfText(message.text);
    const direct = isSurfaceDirect(message.context);
    const record = readSurfaceGrants(actor.metadata?.[SURFACE_GRANTS_METADATA_KEY]);
    const suspended = readActionSwitch(actor).state === 'stopped';
    switch (phrase.kind) {
      case 'list-all': {
        if (!direct) return undefined; // the DM form; in a channel it is ordinary text
        const channels = Object.keys(record.channels)
          .sort()
          .map((key) => ({ channelId: parseSurfaceChannelKey(key)?.channelId ?? key, groups: grantedSurfaceGroups(record, key) }));
        return renderSurfaceAllChannelsList(channels, suspended, language);
      }
      case 'revoke-all': {
        if (!direct) return this.revokeAllFromChannelHint(language);
        return this.revokeAll(actor, now, language);
      }
      case 'list': {
        if (direct) return renderSurfaceGrantChannelOnly(language);
        const key = surfaceChannelKey(message.context);
        const channel = record.channels[key];
        const granted = grantedSurfaceGroups(record, key).map((group) => ({ group, at: channel!.groups[group]!.at, source: channel!.groups[group]!.source }));
        return renderSurfaceChannelList(granted, suspended, language);
      }
      case 'grant': {
        if (direct) return renderSurfaceGrantChannelOnly(language);
        const refusal = this.groupRefusal(phrase.groups, phrase.unknown, language);
        if (refusal !== undefined) return refusal;
        this.log('info', 'surface_grant.refused', { reason: 'grant-not-available' });
        return renderSurfaceGrantNotYet(language);
      }
      case 'revoke': {
        if (direct) return renderSurfaceGrantChannelOnly(language);
        const refusal = this.groupRefusal(phrase.groups, phrase.unknown, language);
        if (refusal !== undefined) return refusal;
        return this.revoke(actor, message.context, phrase.groups, now, language);
      }
      case 'revoke-channel': {
        if (direct) return renderSurfaceGrantChannelOnly(language);
        return this.revokeChannel(actor, message.context, now, language);
      }
    }
  }

  /**
   * A6-D3 / D4.6: the kill-switch phrase (`에이전트 중지` / `에이전트 재개`, owner DM only) when the channel grants are
   * enforced but natural-language actions are off (with A6 on, the selection service owns the phrase). Writes the same
   * `quoky.actionSwitch` through the metadata lock. `undefined` when it is not the phrase.
   */
  async handleSwitchPhrase(actor: Actor, message: InboundMessage, now: IsoTimestamp): Promise<string | undefined> {
    if (!isSurfaceDirect(message.context)) return undefined;
    const wanted = parseActionSwitchPhrase(message.text);
    if (wanted === undefined) return undefined;
    if (!this.deps.isOwner(actor, message.context)) {
      this.log('warn', 'surface_grant.refused', { reason: 'not-owner' });
      return undefined;
    }
    const language = languageOfText(message.text);
    let saved: NlActionSwitchState | undefined;
    try {
      await this.deps.metadata.updateMetadataEntry(
        actor.id,
        ACTION_SWITCH_METADATA_KEY,
        () => withActionSwitch(undefined, wanted, now)[ACTION_SWITCH_METADATA_KEY],
        actor,
      );
      saved = wanted;
      this.log('info', 'nl_action.switch', { state: wanted, by: 'surface-grants' });
    } catch (error) {
      this.log('warn', 'nl_action.switch_write_failed', { errorName: error instanceof Error ? error.name : typeof error });
    }
    return renderSurfaceSwitchReply(saved, language);
  }

  /**
   * D6: apply the startup seed once per digest (after the identity provisioner, before the platform starts). Returns the
   * result (or `undefined` when nothing could be written) and logs `surface_grant.seeded` per channel; the composition
   * root sends the owner's DM lines once the platform is up (`renderSurfaceSeedApplied` / `renderSurfaceSeedReAdded`).
   */
  async applySeed(actorId: Id, seed: SurfaceGrantSeed, now: IsoTimestamp): Promise<SurfaceGrantSeedResult | undefined> {
    let result: SurfaceGrantSeedResult | undefined;
    try {
      await this.deps.metadata.updateMetadataEntry(actorId, SURFACE_GRANTS_METADATA_KEY, (current) => {
        result = applySurfaceGrantSeed(readSurfaceGrants(current), seed, now);
        return result.applied ? serializeSurfaceGrants(result.record) : current;
      });
    } catch (error) {
      this.log('warn', 'surface_grant.seed_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return undefined;
    }
    if (result === undefined) {
      this.log('warn', 'surface_grant.seed_failed', { errorName: 'ActorNotFound' });
      return undefined;
    }
    if (!result.applied) {
      this.log('info', 'surface_grant.seed_skipped', { seedDigest: result.digest.slice(0, 16), reason: 'already-applied' });
      return result;
    }
    for (const key of result.skippedForLimit) {
      this.log('warn', 'surface_grant.seed_skipped', { seedDigest: result.digest.slice(0, 16), reason: 'channel-limit', channelId: parseSurfaceChannelKey(key)?.channelId ?? 'unknown' });
    }
    for (const channel of result.added) {
      const parsed = parseSurfaceChannelKey(channel.key);
      this.log('info', 'surface_grant.seeded', {
        platform: parsed?.platform ?? 'unknown',
        channelId: parsed?.channelId ?? 'unknown',
        groups: channel.groups.join(','),
        seedDigest: result.digest.slice(0, 16),
      });
    }
    return result;
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────

  private revokeAllFromChannelHint(language: SurfaceCopyLanguage): string {
    return language === 'en'
      ? 'Send "모든 채널 권한 해제" in a direct message. In this channel, "이 채널 권한 모두 해제" clears this channel.'
      : '"모든 채널 권한 해제"는 DM에서 보내 주세요. 이 채널만 해제하려면 "이 채널 권한 모두 해제"라고 보내 주세요.';
  }

  private groupRefusal(groups: readonly SurfaceGroupId[], unknown: readonly string[], language: SurfaceCopyLanguage): string | undefined {
    if (unknown.length > 0 || groups.length === 0) return renderSurfaceGrantUsage(language);
    const dmOnly = groups.find((id) => SURFACE_GROUPS[id].class === 'dm-only');
    if (dmOnly !== undefined) return renderSurfaceGrantDmOnlyGroup(dmOnly, language);
    if (groups.some((id) => SURFACE_GROUPS[id].class !== 'grantable')) return renderSurfaceGrantUsage(language);
    return undefined;
  }

  private async write(
    actor: Actor,
    change: (record: SurfaceGrantRecord) => SurfaceGrantRecord,
  ): Promise<boolean> {
    try {
      const saved = await this.deps.metadata.updateMetadataEntry(
        actor.id,
        SURFACE_GRANTS_METADATA_KEY,
        (current) => serializeSurfaceGrants(change(readSurfaceGrants(current))),
        actor,
      );
      return saved !== null;
    } catch (error) {
      this.log('warn', 'surface_grant.write_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return false;
    }
  }

  private async revoke(
    actor: Actor,
    context: ConversationContext,
    groups: readonly SurfaceGroupId[],
    now: IsoTimestamp,
    language: SurfaceCopyLanguage,
  ): Promise<string> {
    const key = surfaceChannelKey(context);
    let changed: readonly SurfaceGroupId[] = [];
    const ok = await this.write(actor, (record) => {
      const result = withSurfaceGroupsRevoked(record, key, groups, now);
      changed = result.changed;
      return result.record;
    });
    if (!ok) return renderSurfaceGrantWriteFailed(language);
    if (changed.length > 0) {
      this.log('info', 'surface_grant.changed', { op: 'revoke', platform: context.platform, channelId: context.channelId, groups: changed.join(','), source: 'owner' });
      await this.receipt(context, renderSurfaceRevokeReceipt(context.channelId, changed));
    }
    return renderSurfaceRevoked(changed, language);
  }

  private async revokeChannel(actor: Actor, context: ConversationContext, now: IsoTimestamp, language: SurfaceCopyLanguage): Promise<string> {
    const key = surfaceChannelKey(context);
    let changed: readonly SurfaceGroupId[] = [];
    const ok = await this.write(actor, (record) => {
      const result = withSurfaceChannelCleared(record, key, now);
      changed = result.changed;
      return result.record;
    });
    if (!ok) return renderSurfaceGrantWriteFailed(language);
    if (changed.length > 0) {
      this.log('info', 'surface_grant.changed', { op: 'revoke-all', platform: context.platform, channelId: context.channelId, groups: changed.join(','), source: 'owner' });
      await this.receipt(context, renderSurfaceRevokeReceipt(context.channelId, 'all'));
    }
    return renderSurfaceChannelCleared(changed.length, language);
  }

  private async revokeAll(actor: Actor, now: IsoTimestamp, language: SurfaceCopyLanguage): Promise<string> {
    let channels = 0;
    const ok = await this.write(actor, (record) => {
      const result = withAllSurfaceGrantsCleared(record, now);
      channels = result.channels;
      return result.record;
    });
    if (!ok) return renderSurfaceGrantWriteFailed(language);
    if (channels > 0) this.log('info', 'surface_grant.changed', { op: 'revoke-all', platform: 'all', channelId: 'all', groups: 'all', source: 'owner' });
    return renderSurfaceAllCleared(channels, language);
  }

  /** One-line DM receipt (`SURFACE_GRANT`, DM-only, owner decision 10). Best-effort; never fails the turn. */
  private async receipt(target: ConversationContext, text: string): Promise<void> {
    if (this.deps.notify === undefined) return;
    try {
      await this.deps.notify({ correlationId: newId(), target, kind: 'SURFACE_GRANT', text });
    } catch (error) {
      this.log('warn', 'surface_grant.receipt_failed', { errorName: error instanceof Error ? error.name : typeof error });
    }
  }

  private log(level: 'info' | 'warn', event: string, fields: Record<string, string>): void {
    try {
      this.deps.logger[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

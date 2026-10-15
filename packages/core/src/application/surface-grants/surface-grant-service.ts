import type { Actor, ConversationContext, Id, InboundMessage, IsoTimestamp, Session } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import type { OwnerNotification } from '../../ports/notification-sink.port';
import { newId } from '../../util/id';
import { sha256Canonical } from '../canonical-digest';
import type { ActorMetadataStore } from '../actor-metadata-store';
import { ACTION_SWITCH_METADATA_KEY, parseActionSwitchPhrase, readActionSwitch, withActionSwitch, type NlActionSwitchState } from '../nl-routing/action-switch';
import {
  SURFACE_WRITE_READ_GROUPS,
  renderSurfaceAlreadyGranted,
  renderSurfaceGrantChannelLimit,
  renderSurfaceGrantConfirm,
  renderSurfaceGrantExpired,
  renderSurfaceGrantNoPending,
  renderSurfaceGrantReceipt,
  renderSurfaceGrantStale,
  renderSurfaceGranted,
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
import { parseSurfaceGrantConfirm, parseSurfaceGrantPhrase } from './surface-grant-phrases';
import {
  SURFACE_GRANTS_METADATA_KEY,
  SURFACE_GRANT_MAX_CHANNELS,
  applySurfaceGrantSeed,
  grantedSurfaceGroups,
  parseSurfaceChannelKey,
  readSurfaceGrants,
  serializeSurfaceGrants,
  surfaceChannelKey,
  withAllSurfaceGrantsCleared,
  withSurfaceChannelCleared,
  withSurfaceGroupsGranted,
  withSurfaceGroupsRevoked,
  type SurfaceGrantRecord,
  type SurfaceGrantSeed,
  type SurfaceGrantSeedResult,
} from './surface-grant-record';
import { SURFACE_GROUPS, SURFACE_GROUP_IDS, isGrantableSurfaceGroup, isSurfaceGroupId, type SurfaceGroupId } from './surface-groups';

/**
 * D4.2 (P2): the grant waiting for `허용 실행`, in `Session.metadata['quoky.grantPending']` (the session is this
 * conversation): group ids, the channel key and the expiry — no text. Read fail closed: anything malformed is no pending.
 */
export const SURFACE_GRANT_PENDING_METADATA_KEY = 'quoky.grantPending';
/** D4.2: the confirmation window. */
export const SURFACE_GRANT_CONFIRM_TTL_MS = 2 * 60 * 1000;

export interface SurfaceGrantPending {
  readonly v: 1;
  /** A nonce per question (Codex P2): a confirmation consumes only the pending grant its turn saw at the start. */
  readonly id: string;
  readonly key: string;
  readonly groups: readonly SurfaceGroupId[];
  readonly expiresAt: IsoTimestamp;
  /** The requester's platform user id (CA P2): only the same owner account can confirm. */
  readonly userId: string;
  /**
   * The basis the question was asked on (CA suggestion): the digest of the whole grants record and the kill-switch state.
   * Any grant change since (e.g. "모든 채널 권한 해제" in the DM) or a switch flip ("에이전트 중지") voids the confirmation.
   */
  readonly grantsDigest: string;
  /** The digest of the stored kill-switch value: any switch write since (a stop, or a stop then a resume) voids it. */
  readonly switchDigest: string;
}

/** The digest of the stored kill-switch value (absent → its own digest), for the pending grant's basis. */
export function surfaceSwitchDigest(metadata: Actor['metadata']): string {
  return sha256Canonical('quoky.actionSwitch.basis.v1', metadata?.[ACTION_SWITCH_METADATA_KEY] ?? null);
}

/** The digest of a grants record as stored (canonical serialization), for the pending grant's basis. */
export function surfaceGrantsDigest(record: SurfaceGrantRecord): string {
  return sha256Canonical('quoky.surfaceGrants.basis.v1', serializeSurfaceGrants(record));
}

export function readSurfaceGrantPending(raw: unknown): SurfaceGrantPending | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || typeof value.key !== 'string' || parseSurfaceChannelKey(value.key) === undefined) return undefined;
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64) return undefined;
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) return undefined;
  if (!Array.isArray(value.groups)) return undefined;
  const listed = value.groups as unknown[];
  const groups = SURFACE_GROUP_IDS.filter((id) => isGrantableSurfaceGroup(id) && listed.includes(id));
  if (groups.length === 0 || listed.some((id) => !isSurfaceGroupId(id) || !isGrantableSurfaceGroup(id))) return undefined;
  if (typeof value.userId !== 'string' || value.userId.length === 0) return undefined;
  if (typeof value.grantsDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.grantsDigest)) return undefined;
  if (typeof value.switchDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.switchDigest)) return undefined;
  return {
    v: 1,
    id: value.id,
    key: value.key,
    groups,
    expiresAt: value.expiresAt as IsoTimestamp,
    userId: value.userId,
    grantsDigest: value.grantsDigest,
    switchDigest: value.switchDigest,
  };
}

/** What the runtime does with a turn that met a pending grant (or the confirmation phrase). */
export interface SurfaceGrantPendingResult {
  /** The fixed reply that ends the turn (nothing recorded). */
  readonly reply?: string;
  /** The pending grant of this session was dropped (another message ended it); the turn routes as before. */
  readonly cleared?: true;
}

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
  /**
   * P2: the session store that holds the pending grant (`SessionManager.updateMetadataEntry`, field-scoped under the
   * shared session write lock). Absent: the grant phrase answers "not available" and nothing is saved.
   */
  readonly sessions?: { updateMetadataEntry(session: Pick<Session, 'id'>, key: string, update: (current: unknown) => unknown): Promise<Session | null> };
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
  async handlePhrase(message: InboundMessage, actor: Actor, now: IsoTimestamp, session?: Pick<Session, 'id'>): Promise<string | undefined> {
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
        if (this.deps.sessions === undefined || session === undefined) {
          this.log('info', 'surface_grant.refused', { reason: 'grant-not-available' });
          return renderSurfaceGrantNotYet(language);
        }
        return this.askToConfirm(message, actor, record, phrase.groups, session, now, suspended, language);
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

  /**
   * D4.2 (P2): a turn in a session that holds a pending grant, or the confirmation phrase itself. Runs right after the
   * kill-switch phrase, in every state, only while the gate is enforced:
   *
   * - `허용 실행` from the owner in the channel of the pending grant, within 2 minutes → the grant is saved through the
   *   per-actor metadata lock, logged, receipted in the owner DM and answered; the pending grant is consumed atomically
   *   (under the session lock), so a second `허용 실행` finds nothing;
   * - `허용 실행` after the window → the expiry reply, nothing saved; with nothing pending (in a channel) → a fixed reply;
   * - any other message (or a non-owner's) ends the pending grant and routes as before (`cleared`).
   *
   * `undefined`: no pending grant and not the confirmation phrase — the turn routes exactly as before. Never throws.
   */
  async handleGrantPending(
    message: InboundMessage,
    session: Pick<Session, 'id' | 'metadata'>,
    actor: Actor,
    now: IsoTimestamp,
    options: {
      readonly cancelOnly?: boolean;
      /**
       * Codex P2 (final round): the raw pending value of the turn's FIRST session read (before the activity touch), so
       * the confirmation is bound to what existed when the turn began. Absent: `session.metadata`.
       */
      readonly seenPending?: unknown;
    } = {},
  ): Promise<SurfaceGrantPendingResult | undefined> {
    let confirm: boolean;
    try {
      // CA P2: on a turn that only answers an approval expiry, the message still ends a pending grant (never confirms).
      confirm = options.cancelOnly === true ? false : parseSurfaceGrantConfirm(message);
    } catch {
      confirm = false;
    }
    const seen = 'seenPending' in options ? options.seenPending : session.metadata?.[SURFACE_GRANT_PENDING_METADATA_KEY];
    const hasPending = seen !== undefined;
    if (!hasPending && options.cancelOnly === true) return undefined;
    const direct = isSurfaceDirect(message.context);
    if (!hasPending) {
      if (!confirm || direct) return undefined;
      if (!this.deps.isOwner(actor, message.context)) {
        this.log('warn', 'surface_grant.refused', { reason: 'not-owner' });
        return undefined;
      }
      return { reply: renderSurfaceGrantNoPending(languageOfText(message.text)) };
    }
    const sessions = this.deps.sessions;
    const owner = this.deps.isOwner(actor, message.context);
    if (confirm && !owner) this.log('warn', 'surface_grant.refused', { reason: 'not-owner' });
    const language = languageOfText(message.text);
    // Consume (or drop) the pending grant atomically: only the turn whose removal COMMITTED can act on it (CA P2: a failed
    // save leaves the pending in place, so nothing is granted on it — no replay window).
    // Codex P2: bound to the pending grant this turn saw when it began (its nonce). A pending grant that replaced it since
    // (a newer question) is neither consumed nor dropped by this turn.
    const expectedId = readSurfaceGrantPending(seen)?.id;
    let consumed: SurfaceGrantPending | undefined;
    let committed = false;
    let removed = false;
    try {
      let taken: SurfaceGrantPending | undefined;
      const saved = await sessions?.updateMetadataEntry(session, SURFACE_GRANT_PENDING_METADATA_KEY, (current) => {
        const live = readSurfaceGrantPending(current);
        if (live?.id !== expectedId) return current; // replaced since this turn began: leave it untouched
        taken = live;
        removed = true;
        return undefined;
      });
      committed = saved !== undefined && saved !== null;
      if (committed) consumed = taken;
    } catch (error) {
      this.log('warn', 'surface_grant.write_failed', { errorName: error instanceof Error ? error.name : typeof error });
    }
    if (!confirm || !owner) {
      if (!committed || !removed) return undefined; // nothing was removed: the turn routes as before
      this.log('info', 'surface_grant.pending_ended', { reason: confirm ? 'not-owner' : 'other-message' });
      return { cleared: true };
    }
    if (!committed) return { reply: renderSurfaceGrantWriteFailed(language) };
    const key = surfaceChannelKey(message.context);
    // CA P2: the pending grant belongs to its channel AND to the owner account that asked.
    if (consumed === undefined || consumed.key !== key || consumed.userId !== message.context.userId) {
      return { reply: renderSurfaceGrantNoPending(language) };
    }
    if (Date.parse(now) > Date.parse(consumed.expiresAt)) {
      this.log('info', 'surface_grant.refused', { reason: 'confirmation-expired' });
      return { reply: renderSurfaceGrantExpired(language) };
    }
    // CA suggestion / Codex P2: the kill-switch state and the grants digest are compared on the LIVE actor inside the
    // per-actor lock (a concurrent stop, or a stop → resume, voids the confirmation).
    return { reply: await this.grant(actor, message.context, consumed.groups, now, language, consumed) };
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** D4.1–D4.3: save the pending grant in this session and answer with the confirmation. Nothing is granted yet. */
  private async askToConfirm(
    message: InboundMessage,
    actor: Pick<Actor, 'metadata'>,
    record: SurfaceGrantRecord,
    groups: readonly SurfaceGroupId[],
    session: Pick<Session, 'id'>,
    now: IsoTimestamp,
    suspended: boolean,
    language: SurfaceCopyLanguage,
  ): Promise<string> {
    const key = surfaceChannelKey(message.context);
    const already = grantedSurfaceGroups(record, key);
    const wanted = groups.filter((id) => !already.includes(id));
    if (wanted.length === 0) return renderSurfaceAlreadyGranted(groups, language);
    if (record.channels[key] === undefined && Object.keys(record.channels).length >= SURFACE_GRANT_MAX_CHANNELS) {
      this.log('info', 'surface_grant.refused', { reason: 'channel-limit' });
      return renderSurfaceGrantChannelLimit(language);
    }
    const pending: SurfaceGrantPending = {
      v: 1,
      id: newId(),
      key,
      groups: SURFACE_GROUP_IDS.filter((id) => wanted.includes(id)),
      expiresAt: new Date(Date.parse(now) + SURFACE_GRANT_CONFIRM_TTL_MS).toISOString() as IsoTimestamp,
      userId: message.context.userId,
      grantsDigest: surfaceGrantsDigest(record),
      switchDigest: surfaceSwitchDigest(actor.metadata),
    };
    let saved: Session | null = null;
    try {
      saved = (await this.deps.sessions?.updateMetadataEntry(session, SURFACE_GRANT_PENDING_METADATA_KEY, () => ({ ...pending, groups: [...pending.groups] }))) ?? null;
    } catch (error) {
      this.log('warn', 'surface_grant.write_failed', { errorName: error instanceof Error ? error.name : typeof error });
    }
    if (saved === null) return renderSurfaceGrantWriteFailed(language);
    this.log('info', 'surface_grant.pending', { platform: message.context.platform, channelId: message.context.channelId, groups: pending.groups.join(',') });
    const missingWriteReadGroups = SURFACE_WRITE_READ_GROUPS.filter((id) => !already.includes(id) && !pending.groups.includes(id));
    return renderSurfaceGrantConfirm({
      groups: pending.groups,
      ...(message.audience !== undefined ? { audience: message.audience } : {}),
      missingWriteReadGroups,
      suspended,
      inThread: message.context.threadId !== undefined,
      language,
    });
  }

  /** `허용 실행`: the grant through the per-actor metadata lock (re-read inside it), logged and receipted. */
  private async grant(
    actor: Actor,
    context: ConversationContext,
    groups: readonly SurfaceGroupId[],
    now: IsoTimestamp,
    language: SurfaceCopyLanguage,
    basis: Pick<SurfaceGrantPending, 'grantsDigest' | 'switchDigest'>,
  ): Promise<string> {
    const key = surfaceChannelKey(context);
    let changed: readonly SurfaceGroupId[] = [];
    let limited = false;
    let stale = false;
    let suspended = false;
    const ok = await this.write(actor, (record, live) => {
      // Any grant change since the question (a revoke, "모든 채널 권한 해제", a seed) or a kill-switch state other than the
      // question's (stopped since, or stopped and resumed) voids the confirmation; both read on the live actor inside the
      // per-actor lock, where the switch and every revoke are written too.
      if (surfaceGrantsDigest(record) !== basis.grantsDigest || surfaceSwitchDigest(live.metadata) !== basis.switchDigest) {
        stale = true;
        return record;
      }
      const result = withSurfaceGroupsGranted(record, key, groups, 'owner', now);
      if (!result.ok) {
        limited = true;
        return record;
      }
      changed = result.changed;
      return result.record;
    }, (fresh) => {
      suspended = readActionSwitch({ metadata: fresh }).state === 'stopped';
    });
    if (!ok) return renderSurfaceGrantWriteFailed(language);
    if (stale) {
      this.log('info', 'surface_grant.refused', { reason: 'basis-changed' });
      return renderSurfaceGrantStale(language);
    }
    if (limited) {
      this.log('info', 'surface_grant.refused', { reason: 'channel-limit' });
      return renderSurfaceGrantChannelLimit(language);
    }
    if (changed.length === 0) return renderSurfaceAlreadyGranted(groups, language);
    this.log('info', 'surface_grant.changed', { op: 'grant', platform: context.platform, channelId: context.channelId, groups: changed.join(','), source: 'owner' });
    await this.receipt(context, renderSurfaceGrantReceipt(context.channelId, changed));
    return renderSurfaceGranted(changed, suspended, language);
  }

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
    change: (record: SurfaceGrantRecord, live: Actor) => SurfaceGrantRecord,
    observe?: (savedMetadata: Actor['metadata']) => void,
  ): Promise<boolean> {
    try {
      const saved = await this.deps.metadata.updateMetadataEntry(
        actor.id,
        SURFACE_GRANTS_METADATA_KEY,
        (current, live) => serializeSurfaceGrants(change(readSurfaceGrants(current), live)),
        actor,
      );
      if (saved !== null) observe?.(saved.metadata);
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

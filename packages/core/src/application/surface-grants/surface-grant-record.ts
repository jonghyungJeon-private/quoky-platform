import type { ConversationContext, IsoTimestamp } from '../../domain';
import { sha256Canonical } from '../canonical-digest';
import { SURFACE_GROUP_IDS, isGrantableSurfaceGroup, isSurfaceGroupId, type SurfaceGroupId } from './surface-groups';

/**
 * ADR-0122 D3: the channel grants, stored in `Actor.metadata['quoky.surfaceGrants']` (no table, no migration), always
 * written through `ActorMetadataStore.updateMetadataEntry` (the per-actor lock). Content-free:
 *
 *   { v: 1, channels: { "<platform>:<spaceId|->:<channelId>": { groups: { "<group>": { at, source } } } }, seeds: [digest] }
 *
 * Read rules (fail closed): a malformed record, an unknown version, an unknown or non-grantable group or a bad timestamp
 * is dropped entry by entry; a wholly malformed record means "no grants". Pure functions only.
 */

export const SURFACE_GRANTS_METADATA_KEY = 'quoky.surfaceGrants';
export const SURFACE_GRANT_RECORD_VERSION = 1;
/** Owner decision 13: at most 16 channels hold grants. */
export const SURFACE_GRANT_MAX_CHANNELS = 16;
/** Seed digests kept (oldest dropped first); a bound only, far above any real deployment history. */
export const SURFACE_GRANT_MAX_SEEDS = 32;

export type SurfaceGrantSource = 'owner' | 'seed';

export interface SurfaceGrantEntry {
  readonly at: IsoTimestamp;
  readonly source: SurfaceGrantSource;
}

export interface SurfaceGrantChannel {
  readonly groups: Readonly<Partial<Record<SurfaceGroupId, SurfaceGrantEntry>>>;
}

export interface SurfaceGrantRecord {
  readonly v: typeof SURFACE_GRANT_RECORD_VERSION;
  readonly channels: Readonly<Record<string, SurfaceGrantChannel>>;
  readonly seeds: readonly string[];
}

export const EMPTY_SURFACE_GRANT_RECORD: SurfaceGrantRecord = Object.freeze({ v: 1, channels: Object.freeze({}), seeds: Object.freeze([]) });

/**
 * The channel key of a conversation: `<platform>:<spaceId or ->:<channelId>`. A thread uses its parent channel (the
 * adapters already put the parent in `channelId`), so a thread inherits its channel's grants, as admission does.
 */
export function surfaceChannelKey(context: Pick<ConversationContext, 'platform' | 'spaceId' | 'channelId'>): string {
  return `${context.platform}:${context.spaceId ?? '-'}:${context.channelId}`;
}

/** The parts of a channel key (`undefined` for a malformed key). */
export function parseSurfaceChannelKey(key: string): { readonly platform: string; readonly spaceId?: string; readonly channelId: string } | undefined {
  const parts = key.split(':');
  if (parts.length !== 3) return undefined;
  const [platform, space, channelId] = parts as [string, string, string];
  if (platform.length === 0 || space.length === 0 || channelId.length === 0) return undefined;
  return { platform, ...(space !== '-' ? { spaceId: space } : {}), channelId };
}

const CHANNEL_KEY_SHAPE = /^[a-z0-9_-]{1,32}:(?:-|[A-Za-z0-9_.-]{1,64}):[A-Za-z0-9_.-]{1,64}$/;
const SEED_DIGEST_SHAPE = /^[0-9a-f]{64}$/;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntry(raw: unknown): SurfaceGrantEntry | undefined {
  if (!isRecordObject(raw)) return undefined;
  const { at, source } = raw;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return undefined;
  if (source !== 'owner' && source !== 'seed') return undefined;
  return { at: at as IsoTimestamp, source };
}

/** Read the stored value (fail closed, entry by entry). */
export function readSurfaceGrants(raw: unknown): SurfaceGrantRecord {
  if (!isRecordObject(raw) || raw.v !== SURFACE_GRANT_RECORD_VERSION) return EMPTY_SURFACE_GRANT_RECORD;
  const channels: Record<string, SurfaceGrantChannel> = {};
  if (isRecordObject(raw.channels)) {
    for (const [key, value] of Object.entries(raw.channels)) {
      if (Object.keys(channels).length >= SURFACE_GRANT_MAX_CHANNELS) break;
      if (!CHANNEL_KEY_SHAPE.test(key) || !isRecordObject(value) || !isRecordObject(value.groups)) continue;
      const groups: Partial<Record<SurfaceGroupId, SurfaceGrantEntry>> = {};
      for (const [id, entry] of Object.entries(value.groups)) {
        // A DM-only or always group is never grantable: a record naming one is ignored (D1).
        if (!isSurfaceGroupId(id) || !isGrantableSurfaceGroup(id)) continue;
        const read = readEntry(entry);
        if (read !== undefined) groups[id] = read;
      }
      if (Object.keys(groups).length > 0) channels[key] = { groups };
    }
  }
  const seeds = Array.isArray(raw.seeds)
    ? raw.seeds.filter((seed): seed is string => typeof seed === 'string' && SEED_DIGEST_SHAPE.test(seed)).slice(-SURFACE_GRANT_MAX_SEEDS)
    : [];
  return { v: SURFACE_GRANT_RECORD_VERSION, channels, seeds };
}

/** The groups granted to one channel key, in table order. */
export function grantedSurfaceGroups(record: SurfaceGrantRecord, key: string): readonly SurfaceGroupId[] {
  const channel = record.channels[key];
  if (channel === undefined) return [];
  return SURFACE_GROUP_IDS.filter((id) => channel.groups[id] !== undefined);
}

/** A plain JSON copy for storage (stable key order). */
export function serializeSurfaceGrants(record: SurfaceGrantRecord): Record<string, unknown> {
  const channels: Record<string, unknown> = {};
  for (const key of Object.keys(record.channels).sort()) {
    const groups: Record<string, unknown> = {};
    for (const id of grantedSurfaceGroups(record, key)) {
      const entry = record.channels[key]!.groups[id]!;
      groups[id] = { at: entry.at, source: entry.source };
    }
    channels[key] = { groups };
  }
  return { v: SURFACE_GRANT_RECORD_VERSION, channels, seeds: [...record.seeds] };
}

export type SurfaceGrantChange =
  | { readonly ok: true; readonly record: SurfaceGrantRecord; readonly changed: readonly SurfaceGroupId[] }
  | { readonly ok: false; readonly reason: 'channel-limit' };

/** Grant `groups` to `key` (grantable only; an existing grant keeps its date). Refused past the channel limit. */
export function withSurfaceGroupsGranted(
  record: SurfaceGrantRecord,
  key: string,
  groups: readonly SurfaceGroupId[],
  source: SurfaceGrantSource,
  now: IsoTimestamp,
): SurfaceGrantChange {
  const wanted = groups.filter(isGrantableSurfaceGroup);
  const current = record.channels[key];
  if (current === undefined && Object.keys(record.channels).length >= SURFACE_GRANT_MAX_CHANNELS) return { ok: false, reason: 'channel-limit' };
  const next: Partial<Record<SurfaceGroupId, SurfaceGrantEntry>> = { ...(current?.groups ?? {}) };
  const changed: SurfaceGroupId[] = [];
  for (const id of wanted) {
    if (next[id] !== undefined) continue;
    next[id] = { at: now, source };
    changed.push(id);
  }
  if (changed.length === 0) return { ok: true, record, changed };
  return { ok: true, record: { ...record, channels: { ...record.channels, [key]: { groups: next } } }, changed };
}

/** Revoke `groups` from `key`; a channel left without grants is removed. */
export function withSurfaceGroupsRevoked(
  record: SurfaceGrantRecord,
  key: string,
  groups: readonly SurfaceGroupId[],
): { readonly record: SurfaceGrantRecord; readonly changed: readonly SurfaceGroupId[] } {
  const current = record.channels[key];
  if (current === undefined) return { record, changed: [] };
  const next: Partial<Record<SurfaceGroupId, SurfaceGrantEntry>> = { ...current.groups };
  const changed: SurfaceGroupId[] = [];
  for (const id of groups) {
    if (next[id] === undefined) continue;
    delete next[id];
    changed.push(id);
  }
  if (changed.length === 0) return { record, changed };
  const channels = { ...record.channels };
  if (Object.keys(next).length === 0) delete channels[key];
  else channels[key] = { groups: next };
  return { record: { ...record, channels }, changed };
}

/** Clear one channel; `seeds` are kept, so the same seed never comes back (D6). */
export function withSurfaceChannelCleared(record: SurfaceGrantRecord, key: string): { readonly record: SurfaceGrantRecord; readonly changed: readonly SurfaceGroupId[] } {
  return withSurfaceGroupsRevoked(record, key, grantedSurfaceGroups(record, key));
}

/** Clear every channel; `seeds` are kept (D6). */
export function withAllSurfaceGrantsCleared(record: SurfaceGrantRecord): { readonly record: SurfaceGrantRecord; readonly channels: number } {
  const channels = Object.keys(record.channels).length;
  return { record: { ...record, channels: {} }, channels };
}

// ── seed (D6) ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SurfaceGrantSeedChannel {
  readonly key: string;
  readonly groups: readonly SurfaceGroupId[];
}

export interface SurfaceGrantSeed {
  readonly channels: readonly SurfaceGrantSeedChannel[];
}

/** SHA-256 of the canonical seed (channels by key, groups in table order, duplicates dropped). */
export function surfaceGrantSeedDigest(seed: SurfaceGrantSeed): string {
  const canonical = canonicalSeed(seed);
  return sha256Canonical('quoky.surfaceGrants.seed.v1', canonical.channels.map((channel) => [channel.key, [...channel.groups]]));
}

export function canonicalSeed(seed: SurfaceGrantSeed): SurfaceGrantSeed {
  const byKey = new Map<string, Set<SurfaceGroupId>>();
  for (const channel of seed.channels) {
    const groups = byKey.get(channel.key) ?? new Set<SurfaceGroupId>();
    for (const id of channel.groups) groups.add(id);
    byKey.set(channel.key, groups);
  }
  return {
    channels: [...byKey.keys()].sort().map((key) => ({ key, groups: SURFACE_GROUP_IDS.filter((id) => byKey.get(key)!.has(id)) })),
  };
}

export interface SurfaceGrantSeedResult {
  readonly digest: string;
  /** False when the digest was already applied (nothing changed). */
  readonly applied: boolean;
  readonly record: SurfaceGrantRecord;
  /** Per channel: the groups this application added. */
  readonly added: readonly SurfaceGrantSeedChannel[];
  /**
   * Per channel: added groups that a previous seed had already granted once (a changed seed value re-adding what the owner
   * revoked since); empty on the first seed of a record.
   */
  readonly reAdded: readonly SurfaceGrantSeedChannel[];
  /** Channels skipped because the 16-channel table was full. */
  readonly skippedForLimit: readonly string[];
}

/**
 * Apply a seed once per digest: adds, never removes; a group the owner revoked later is not re-added by the same seed
 * (its digest stays in `seeds`, also after "모든 채널 권한 해제"). A changed value has a new digest and is applied again.
 */
export function applySurfaceGrantSeed(record: SurfaceGrantRecord, seed: SurfaceGrantSeed, now: IsoTimestamp): SurfaceGrantSeedResult {
  const canonical = canonicalSeed(seed);
  const digest = surfaceGrantSeedDigest(canonical);
  if (record.seeds.includes(digest)) return { digest, applied: false, record, added: [], reAdded: [], skippedForLimit: [] };
  const earlierSeed = record.seeds.length > 0;
  let next = record;
  const added: SurfaceGrantSeedChannel[] = [];
  const skippedForLimit: string[] = [];
  for (const channel of canonical.channels) {
    const change = withSurfaceGroupsGranted(next, channel.key, channel.groups, 'seed', now);
    if (!change.ok) {
      skippedForLimit.push(channel.key);
      continue;
    }
    next = change.record;
    if (change.changed.length > 0) added.push({ key: channel.key, groups: change.changed });
  }
  next = { ...next, seeds: [...next.seeds, digest].slice(-SURFACE_GRANT_MAX_SEEDS) };
  return { digest, applied: true, record: next, added, reAdded: earlierSeed ? added : [], skippedForLimit };
}

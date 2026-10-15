import { describe, expect, it } from 'vitest';
import {
  EMPTY_SURFACE_GRANT_RECORD,
  SURFACE_GRANT_MAX_REVOKED_CHANNELS,
  SURFACE_GRANT_MAX_CHANNELS,
  applySurfaceGrantSeed,
  canonicalSeed,
  grantedSurfaceGroups,
  parseSurfaceChannelKey,
  readSurfaceGrants,
  serializeSurfaceGrants,
  surfaceChannelKey,
  surfaceGrantSeedDigest,
  withAllSurfaceGrantsCleared,
  withSurfaceChannelCleared,
  withSurfaceGroupsGranted,
  withSurfaceGroupsRevoked,
} from './surface-grant-record';

// ADR-0122 D3/D6: the record codec (fail closed, entry by entry), the caps and the seed's digest rules.

const T0 = '2026-10-15T09:00:00.000Z';
const T1 = '2026-10-16T09:00:00.000Z';
const KEY = 'discord:1520835639103324181:1520835639904309350';

describe('channel key', () => {
  it('is <platform>:<spaceId|->:<channelId>; a thread uses its parent channel', () => {
    expect(surfaceChannelKey({ platform: 'discord', spaceId: '1520835639103324181', channelId: '1520835639904309350' })).toBe(KEY);
    expect(surfaceChannelKey({ platform: 'telegram', channelId: '42' })).toBe('telegram:-:42');
    expect(parseSurfaceChannelKey(KEY)).toEqual({ platform: 'discord', spaceId: '1520835639103324181', channelId: '1520835639904309350' });
    expect(parseSurfaceChannelKey('telegram:-:42')).toEqual({ platform: 'telegram', channelId: '42' });
    expect(parseSurfaceChannelKey('nope')).toBeUndefined();
  });
});

describe('read rules (fail closed)', () => {
  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['an unknown version', { v: 2, channels: { [KEY]: { groups: { calendar: { at: T0, source: 'owner' } } } }, seeds: [] }],
    ['null', null],
  ])('%s means no grants', (_label, raw) => {
    expect(readSurfaceGrants(raw)).toEqual(EMPTY_SURFACE_GRANT_RECORD);
  });

  it('drops bad entries one by one and keeps the good ones', () => {
    const raw = {
      v: 1,
      channels: {
        [KEY]: {
          groups: {
            calendar: { at: T0, source: 'owner' },
            github: { at: 'not a date', source: 'owner' },
            todo: { at: T0, source: 'someone' },
            mail: { at: T0, source: 'owner' },
            help: { at: T0, source: 'owner' },
            bogus: { at: T0, source: 'owner' },
          },
        },
        'bad key with spaces': { groups: { calendar: { at: T0, source: 'owner' } } },
        'discord:1:2': { groups: { calendar: { at: T0, source: 'owner' } } },
        'discord:111111:222222': { groups: 'x' },
      },
      seeds: ['a'.repeat(64), 'short', 7],
    };
    const read = readSurfaceGrants(raw);
    expect(Object.keys(read.channels)).toEqual([KEY, 'discord:1:2']);
    expect(grantedSurfaceGroups(read, KEY)).toEqual(['calendar']);
    expect(read.seeds).toEqual(['a'.repeat(64)]);
  });

  it('round-trips through serialize (stable order, plain JSON)', () => {
    const change = withSurfaceGroupsGranted(EMPTY_SURFACE_GRANT_RECORD, KEY, ['todo', 'calendar', 'mail', 'chat'], 'owner', T0);
    if (!change.ok) throw new Error('grant');
    expect(change.changed).toEqual(['todo', 'calendar']); // DM-only and always groups are never granted
    const json = JSON.parse(JSON.stringify(serializeSurfaceGrants(change.record)));
    expect(json).toEqual({ v: 1, channels: { [KEY]: { groups: { calendar: { at: T0, source: 'owner' }, todo: { at: T0, source: 'owner' } } } }, seeds: [] });
    expect(readSurfaceGrants(json)).toEqual(change.record);
  });
});

describe('grant, revoke, clear, caps', () => {
  it('an existing grant keeps its date; revoking the last group removes the channel; clear-all keeps the seeds', () => {
    const first = withSurfaceGroupsGranted(EMPTY_SURFACE_GRANT_RECORD, KEY, ['calendar'], 'seed', T0);
    if (!first.ok) throw new Error('grant');
    const again = withSurfaceGroupsGranted({ ...first.record, seeds: ['b'.repeat(64)] }, KEY, ['calendar', 'github'], 'owner', T1);
    if (!again.ok) throw new Error('grant');
    expect(again.changed).toEqual(['github']);
    expect(again.record.channels[KEY]?.groups.calendar).toEqual({ at: T0, source: 'seed' });
    const revoked = withSurfaceGroupsRevoked(again.record, KEY, ['calendar', 'todo'], T1);
    expect(revoked.changed).toEqual(['calendar']);
    expect(withSurfaceChannelCleared(revoked.record, KEY).record.channels).toEqual({});
    const all = withAllSurfaceGrantsCleared(again.record, T1);
    expect(all).toEqual({ record: { v: 1, channels: {}, seeds: ['b'.repeat(64)], revoked: { [KEY]: { groups: ['github', 'calendar'], at: T1 } } }, channels: 1 });
    // A later grant of a revoked group removes it from `revoked` again; the note round-trips through storage.
    const regranted = withSurfaceGroupsGranted(all.record, KEY, ['github'], 'owner', T1);
    if (!regranted.ok) throw new Error('grant');
    expect(regranted.record.revoked).toEqual({ [KEY]: { groups: ['calendar'], at: T1 } });
    expect(readSurfaceGrants(JSON.parse(JSON.stringify(serializeSurfaceGrants(regranted.record))))).toEqual(regranted.record);
  });

  it('at most 16 channels: a 17th channel is refused, an existing one still changes', () => {
    let record = EMPTY_SURFACE_GRANT_RECORD;
    for (let i = 0; i < SURFACE_GRANT_MAX_CHANNELS; i += 1) {
      const change = withSurfaceGroupsGranted(record, `discord:100000:${200000 + i}`, ['todo'], 'owner', T0);
      if (!change.ok) throw new Error('grant');
      record = change.record;
    }
    expect(withSurfaceGroupsGranted(record, 'discord:100000:999999', ['todo'], 'owner', T0)).toEqual({ ok: false, reason: 'channel-limit' });
    expect(withSurfaceGroupsGranted(record, 'discord:100000:200000', ['github'], 'owner', T0).ok).toBe(true);
    // A stored record beyond the cap is read capped too.
    const over = { ...serializeSurfaceGrants(record), channels: { ...(serializeSurfaceGrants(record).channels as object), 'discord:100000:999999': { groups: { todo: { at: T0, source: 'owner' } } } } };
    expect(Object.keys(readSurfaceGrants(over).channels)).toHaveLength(SURFACE_GRANT_MAX_CHANNELS);
  });
});

describe('revoked notes are bounded and evicted by recorded time (P3)', () => {
  it('when full, the note changed longest ago is dropped, whatever the key order after a reload', () => {
    let record = EMPTY_SURFACE_GRANT_RECORD;
    const at = (i: number) => new Date(Date.parse(T0) + i * 60_000).toISOString();
    // Keys whose alphabetical order is the reverse of their time order.
    const key = (i: number) => `discord:100000:${900000 - i}`;
    for (let i = 0; i < SURFACE_GRANT_MAX_REVOKED_CHANNELS; i += 1) {
      const granted = withSurfaceGroupsGranted({ ...record, channels: {} }, key(i), ['todo'], 'owner', at(i));
      if (!granted.ok) throw new Error('grant');
      record = withSurfaceGroupsRevoked(granted.record, key(i), ['todo'], at(i)).record;
      record = readSurfaceGrants(JSON.parse(JSON.stringify(serializeSurfaceGrants(record))));
    }
    expect(Object.keys(record.revoked ?? {})).toHaveLength(SURFACE_GRANT_MAX_REVOKED_CHANNELS);
    const extra = withSurfaceGroupsGranted({ ...record, channels: {} }, 'discord:100000:111111', ['todo'], 'owner', at(99));
    if (!extra.ok) throw new Error('grant');
    const next = withSurfaceGroupsRevoked(extra.record, 'discord:100000:111111', ['todo'], at(99)).record;
    expect(Object.keys(next.revoked ?? {})).toHaveLength(SURFACE_GRANT_MAX_REVOKED_CHANNELS);
    expect(next.revoked?.[key(0)]).toBeUndefined(); // the oldest (alphabetically the LAST key) went
    expect(next.revoked?.[key(SURFACE_GRANT_MAX_REVOKED_CHANNELS - 1)]).toBeDefined(); // alphabetically first, newest: kept
    expect(next.revoked?.['discord:100000:111111']).toEqual({ groups: ['todo'], at: at(99) });
  });

  it('a malformed note (no time, bad groups) is dropped on read', () => {
    const read = readSurfaceGrants({ v: 1, channels: {}, seeds: [], revoked: { [KEY]: ['todo'], 'discord:1:2': { groups: ['mail'], at: T0 }, 'discord:1:3': { groups: ['todo'], at: 'x' } } });
    expect(read.revoked).toBeUndefined();
  });
});

describe('the seed (D6)', () => {
  const SEED = { channels: [{ key: KEY, groups: ['jira-mine', 'jira-project', 'github', 'slack-search', 'confluence', 'calendar', 'todo', 'reminder', 'memory', 'code'] as const }] };

  it('the digest is canonical (order and duplicates do not matter) and 64 hex characters', () => {
    const shuffled = { channels: [{ key: KEY, groups: ['code', 'memory', 'reminder', 'todo', 'calendar', 'confluence', 'slack-search', 'github', 'jira-project', 'jira-mine', 'code'] as const }] };
    expect(surfaceGrantSeedDigest(SEED)).toMatch(/^[0-9a-f]{64}$/);
    expect(surfaceGrantSeedDigest(shuffled)).toBe(surfaceGrantSeedDigest(SEED));
    expect(canonicalSeed(shuffled)).toEqual(canonicalSeed(SEED));
    expect(surfaceGrantSeedDigest({ channels: [{ key: KEY, groups: ['todo'] }] })).not.toBe(surfaceGrantSeedDigest(SEED));
  });

  it('applies once per digest; adds, never removes; a revoked group is not re-added by the same seed, also after clear-all', () => {
    const first = applySurfaceGrantSeed(EMPTY_SURFACE_GRANT_RECORD, SEED, T0);
    expect(first.applied).toBe(true);
    expect(first.reAdded).toEqual([]);
    expect(grantedSurfaceGroups(first.record, KEY)).toEqual([...SEED.channels[0]!.groups]);
    expect(first.record.seeds).toEqual([first.digest]);
    const revoked = withSurfaceGroupsRevoked(first.record, KEY, ['slack-search']).record;
    const again = applySurfaceGrantSeed(revoked, SEED, T1);
    expect(again.applied).toBe(false);
    expect(again.record).toBe(revoked);
    const cleared = withAllSurfaceGrantsCleared(revoked).record;
    expect(applySurfaceGrantSeed(cleared, SEED, T1).applied).toBe(false);
  });

  it('a changed value has a new digest: applied again, and the groups it re-adds are reported for the explicit DM', () => {
    const first = applySurfaceGrantSeed(EMPTY_SURFACE_GRANT_RECORD, SEED, T0);
    const revoked = withSurfaceGroupsRevoked(first.record, KEY, ['slack-search', 'code']).record;
    const changed = { channels: [{ key: KEY, groups: [...SEED.channels[0]!.groups, 'writes'] as const }] };
    const second = applySurfaceGrantSeed(revoked, changed, T1);
    expect(second.applied).toBe(true);
    expect(second.added).toEqual([{ key: KEY, groups: ['slack-search', 'code', 'writes'] }]);
    // Only what the owner had revoked is "re-added"; `writes` is new in the changed value.
    expect(second.reAdded).toEqual([{ key: KEY, groups: ['slack-search', 'code'] }]);
    expect(second.record.revoked).toBeUndefined();
    expect(second.record.seeds).toEqual([first.digest, second.digest]);
    expect(second.record.channels[KEY]?.groups.calendar).toEqual({ at: T0, source: 'seed' });
  });
});

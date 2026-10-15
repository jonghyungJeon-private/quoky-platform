import { describe, expect, it } from 'vitest';
import type { Actor, ConversationContext, Metadata } from '../../domain';
import { ACTION_SWITCH_METADATA_KEY } from '../nl-routing/action-switch';
import { SurfaceGate, allowedSurfaceGroups, decideSurface } from './surface-gate';
import {
  SURFACE_GRANTS_METADATA_KEY,
  readSurfaceGrants,
  serializeSurfaceGrants,
  surfaceChannelKey,
  withSurfaceGroupsGranted,
  withSurfaceGroupsRevoked,
  EMPTY_SURFACE_GRANT_RECORD,
} from './surface-grant-record';
import { SURFACE_GROUPS, SURFACE_GROUP_IDS, type SurfaceGroupId } from './surface-groups';

// ADR-0122 D2: the decision table of the one gate — every group × DM / channel (granted, not granted, revoked,
// suspended, `direct` absent) × enforce / off.

const T0 = '2026-10-15T09:00:00.000Z';
const CHANNEL: ConversationContext = { platform: 'discord', spaceId: '100000', channelId: '200000', userId: 'owner', direct: false };
const OTHER_CHANNEL: ConversationContext = { ...CHANNEL, channelId: '300000' };
const DM: ConversationContext = { platform: 'discord', channelId: '900000', userId: 'owner', direct: true };
const FLAGLESS: ConversationContext = { platform: 'discord', channelId: '900000', userId: 'owner' };
const THREAD: ConversationContext = { ...CHANNEL, threadId: '200001' };

function actorWith(metadata: Metadata | undefined): Pick<Actor, 'metadata'> {
  return metadata === undefined ? {} : { metadata };
}

function grantedAll(context = CHANNEL): Metadata {
  const grantable = SURFACE_GROUP_IDS.filter((id) => SURFACE_GROUPS[id].class === 'grantable');
  const change = withSurfaceGroupsGranted(EMPTY_SURFACE_GRANT_RECORD, surfaceChannelKey(context), grantable, 'seed', T0);
  if (!change.ok) throw new Error('grant failed');
  return { [SURFACE_GRANTS_METADATA_KEY]: serializeSurfaceGrants(change.record) };
}

const decide = (context: ConversationContext, metadata: Metadata | undefined, group: SurfaceGroupId, mode: 'enforce' | 'off' = 'enforce') =>
  decideSurface({ mode, context, actor: actorWith(metadata), groups: [group] });

describe('the gate decision table (D2, D1 classes)', () => {
  for (const group of SURFACE_GROUP_IDS) {
    const cls = SURFACE_GROUPS[group].class;
    it(`${group} (${cls})`, () => {
      // DM: every group passes; `off`: every group passes everywhere.
      expect(decide(DM, undefined, group)).toEqual({ allow: true });
      expect(decide(CHANNEL, undefined, group, 'off')).toEqual({ allow: true });
      const none = decide(CHANNEL, undefined, group);
      const granted = decide(CHANNEL, grantedAll(), group);
      const otherChannel = decide(OTHER_CHANNEL, grantedAll(), group);
      const thread = decide(THREAD, grantedAll(), group);
      const flagless = decide(FLAGLESS, undefined, group);
      const suspended = decide(CHANNEL, { ...grantedAll(), [ACTION_SWITCH_METADATA_KEY]: { state: 'stopped', at: T0 } }, group);
      const record = readSurfaceGrants(grantedAll()[SURFACE_GRANTS_METADATA_KEY]);
      const revoked = decide(CHANNEL, { [SURFACE_GRANTS_METADATA_KEY]: serializeSurfaceGrants(withSurfaceGroupsRevoked(record, surfaceChannelKey(CHANNEL), [group]).record) }, group);
      if (cls === 'always') {
        for (const decision of [none, granted, otherChannel, thread, flagless, suspended, revoked]) expect(decision).toEqual({ allow: true });
      } else if (cls === 'dm-only') {
        for (const decision of [none, granted, otherChannel, thread, flagless, suspended, revoked]) {
          expect(decision).toEqual({ allow: false, reason: 'dm-only', group });
        }
      } else {
        expect(none).toEqual({ allow: false, reason: 'not-granted', group });
        expect(granted).toEqual({ allow: true });
        expect(thread).toEqual({ allow: true }); // a thread inherits its parent channel's grants
        expect(otherChannel).toEqual({ allow: false, reason: 'not-granted', group });
        expect(flagless).toEqual({ allow: false, reason: 'not-granted', group }); // an absent flag is a channel (D2.8)
        expect(suspended).toEqual({ allow: false, reason: 'suspended', group });
        expect(revoked).toEqual({ allow: false, reason: 'not-granted', group });
      }
    });
  }

  it('every listed group must pass; the first failing one names the denial; no group is unclassified', () => {
    const granted = actorWith(grantedAll());
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor: granted, groups: ['writes', 'jira-mine'] })).toEqual({ allow: true });
    const onlyWrites = withSurfaceGroupsGranted(EMPTY_SURFACE_GRANT_RECORD, surfaceChannelKey(CHANNEL), ['writes'], 'owner', T0);
    if (!onlyWrites.ok) throw new Error('grant failed');
    const actor = actorWith({ [SURFACE_GRANTS_METADATA_KEY]: serializeSurfaceGrants(onlyWrites.record) });
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor, groups: ['writes', 'jira-mine'] })).toEqual({ allow: false, reason: 'not-granted', group: 'jira-mine' });
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor, groups: ['writes', 'mail'] })).toEqual({ allow: false, reason: 'dm-only', group: 'mail' });
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor, groups: [] })).toEqual({ allow: false, reason: 'unclassified' });
    expect(decideSurface({ mode: 'enforce', context: DM, actor, groups: [] })).toEqual({ allow: true });
  });

  it('a stored grant of a DM-only or always group is ignored on read (fail closed)', () => {
    const raw = { v: 1, channels: { [surfaceChannelKey(CHANNEL)]: { groups: { mail: { at: T0, source: 'owner' }, chat: { at: T0, source: 'owner' }, calendar: { at: T0, source: 'owner' } } } }, seeds: [] };
    const actor = actorWith({ [SURFACE_GRANTS_METADATA_KEY]: raw });
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor, groups: ['mail'] })).toEqual({ allow: false, reason: 'dm-only', group: 'mail' });
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor, groups: ['calendar'] })).toEqual({ allow: true });
    expect(readSurfaceGrants(raw).channels[surfaceChannelKey(CHANNEL)]?.groups).toEqual({ calendar: { at: T0, source: 'owner' } });
  });

  it('allowedSurfaceGroups: DM and off allow every group; a channel allows always + granted', () => {
    expect(allowedSurfaceGroups({ mode: 'enforce', context: DM, actor: {} }).size).toBe(SURFACE_GROUP_IDS.length);
    expect(allowedSurfaceGroups({ mode: 'off', context: CHANNEL, actor: {} }).size).toBe(SURFACE_GROUP_IDS.length);
    expect([...allowedSurfaceGroups({ mode: 'enforce', context: CHANNEL, actor: {} })].sort()).toEqual(['chat', 'control', 'help']);
  });
});

describe('SurfaceGate audit (D3): content-free, denials only, nothing in a DM or off', () => {
  it('logs only ids and closed values', () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const logger = { info: (m: string, f?: Record<string, unknown>) => lines.push([m, f ?? {}]), warn: (m: string, f?: Record<string, unknown>) => lines.push([m, f ?? {}]) };
    const gate = new SurfaceGate('enforce', logger);
    expect(gate.decide(CHANNEL, {}, ['calendar'], { path: 'grammar', handlerId: 'calendar' }).allow).toBe(false);
    expect(gate.decide(CHANNEL, {}, ['chat'], { path: 'route' }).allow).toBe(true);
    expect(gate.decide(DM, {}, ['mail'], { path: 'grammar' }).allow).toBe(true);
    new SurfaceGate('off', logger).decide(CHANNEL, {}, ['mail'], { path: 'grammar' });
    gate.logMismatch({ handlerId: 'x', claimed: 'todo', entryId: 'todo.list' });
    expect(lines).toEqual([
      ['surface_gate.denied', { platform: 'discord', channelId: '200000', path: 'grammar', handlerId: 'calendar', group: 'calendar', reason: 'not-granted' }],
      ['surface_gate.mismatch', { handlerId: 'x', claimed: 'todo', entryId: 'todo.list' }],
    ]);
  });
});

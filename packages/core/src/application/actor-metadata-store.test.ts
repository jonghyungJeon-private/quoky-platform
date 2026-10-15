import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Actor, Id } from '../domain';
import { KeyedMutex } from '../util/keyed-mutex';
import { ActorMetadataStore } from './actor-metadata-store';
import { NlActionSwitch, readActionSwitch } from './nl-routing/action-switch';
import { NlSelectionService } from './nl-routing/nl-selection-service';
import { SURFACE_GRANTS_METADATA_KEY, applySurfaceGrantSeed, readSurfaceGrants, serializeSurfaceGrants, surfaceChannelKey, withSurfaceGroupsRevoked, EMPTY_SURFACE_GRANT_RECORD } from './surface-grants/surface-grant-record';

// ADR-0122 D3 (residual risk R4): ONE per-actor metadata lock for every `Actor.metadata` writer. A preference save that
// read the actor before a grant revoke can never write the revoked grant back; a source test forbids a metadata save
// outside the store.

const T0 = '2026-10-15T09:00:00.000Z';
const KEY = surfaceChannelKey({ platform: 'discord', spaceId: '100000', channelId: '200000' });

/** An in-memory actor repository whose reads and writes can be held open (to force an interleaving). */
function slowRepo(initial: Actor) {
  let stored: Actor = structuredClone(initial);
  const gates: Array<() => void> = [];
  let hold = false;
  const pause = () => (hold ? new Promise<void>((resolve) => gates.push(resolve)) : Promise.resolve());
  return {
    repo: {
      async get(id: Id): Promise<Actor | null> {
        const snapshot = id === stored.id ? structuredClone(stored) : null;
        await pause();
        return snapshot;
      },
      async save(actor: Actor): Promise<Actor> {
        await pause();
        stored = structuredClone(actor);
        return actor;
      },
    },
    current: () => stored,
    holdAll(on: boolean) {
      hold = on;
    },
    release() {
      for (const resolve of gates.splice(0)) resolve();
    },
    pending: () => gates.length,
  };
}

const seeded = (): Actor => {
  const record = applySurfaceGrantSeed(EMPTY_SURFACE_GRANT_RECORD, { channels: [{ key: KEY, groups: ['calendar', 'todo'] }] }, T0).record;
  return { id: 'owner', displayName: 'o', identities: [], createdAt: T0, metadata: { [SURFACE_GRANTS_METADATA_KEY]: serializeSurfaceGrants(record), other: 1 } };
};

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('ActorMetadataStore (D3)', () => {
  it('replaces one key of the LIVE actor and keeps every other key; undefined removes it', async () => {
    const world = slowRepo(seeded());
    const store = new ActorMetadataStore(world.repo, new KeyedMutex());
    await store.updateMetadataEntry('owner', 'quoky.test', () => ({ a: 1 }));
    expect(world.current().metadata).toMatchObject({ other: 1, 'quoky.test': { a: 1 } });
    await store.updateMetadataEntry('owner', 'quoky.test', () => undefined);
    expect(world.current().metadata).not.toHaveProperty('quoky.test');
    expect(await store.updateMetadataEntry('missing', 'k', () => 1)).toBeNull();
  });

  it('a revoke and a preference save racing on the same actor: the revoke survives (interleaving)', async () => {
    const world = slowRepo(seeded());
    const lock = new KeyedMutex();
    const store = new ActorMetadataStore(world.repo, lock);
    world.holdAll(true);
    // The preference save starts first and reads the actor (with the grant) — then the revoke is requested.
    const preference = store.updateMetadataEntry('owner', 'quoky.interpretationPreferences', () => ({ window: { value: 'x', at: T0 } }));
    const revoke = store.updateMetadataEntry('owner', SURFACE_GRANTS_METADATA_KEY, (current) =>
      serializeSurfaceGrants(withSurfaceGroupsRevoked(readSurfaceGrants(current), KEY, ['calendar']).record),
    );
    await flush();
    // Only the first writer is inside the lock; the second has not even read yet.
    expect(world.pending()).toBe(1);
    world.holdAll(false);
    world.release();
    await Promise.all([preference, revoke]);
    const after = readSurfaceGrants(world.current().metadata?.[SURFACE_GRANTS_METADATA_KEY]);
    expect(Object.keys(after.channels[KEY]?.groups ?? {})).toEqual(['todo']);
    expect(world.current().metadata?.['quoky.interpretationPreferences']).toEqual({ window: { value: 'x', at: T0 } });
  });

  it('the production writers (kill switch, preferences) go through the shared lock: a stale preference save cannot resurrect a grant', async () => {
    const world = slowRepo(seeded());
    const logger = { info() {}, warn() {}, error() {} };
    const killSwitch = new NlActionSwitch({ actors: world.repo, logger });
    const service = new NlSelectionService({
      mode: 'active',
      router: { select: async () => { throw new Error('no provider'); } } as never,
      sessions: { updateMetadataEntry: async () => null },
      actors: world.repo,
      timeZone: 'Asia/Seoul',
      logger,
    });
    const staleActor = structuredClone(world.current());
    world.holdAll(true);
    const save = (service as unknown as { savePreference(turn: unknown, key: string, value: string): Promise<boolean> }).savePreference(
      { actor: staleActor, now: T0 },
      'window',
      'this-week',
    );
    const revoke = new ActorMetadataStore(world.repo).updateMetadataEntry('owner', SURFACE_GRANTS_METADATA_KEY, (current) =>
      serializeSurfaceGrants(withSurfaceGroupsRevoked(readSurfaceGrants(current), KEY, ['calendar', 'todo']).record),
    );
    const stop = killSwitch.set('owner', staleActor, 'stopped', T0);
    await flush();
    world.holdAll(false);
    world.release();
    await Promise.all([save, revoke, stop]);
    expect(readSurfaceGrants(world.current().metadata?.[SURFACE_GRANTS_METADATA_KEY]).channels).toEqual({});
    expect(readActionSwitch(world.current()).state).toBe('stopped');
    expect(world.current().metadata?.['quoky.interpretationPreferences']).toBeDefined();
  });
});

describe('source rule: no Actor.metadata save outside the store (D3)', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = join(here, '../../../..');
  /** The only `actors.save` callers allowed besides the store, and why. */
  const ALLOWED: Readonly<Record<string, string>> = {
    'packages/core/src/application/actor-metadata-store.ts': 'the one metadata writer (per-actor lock)',
    'packages/core/src/application/actor-manager.ts': 'creates a new Actor (no metadata)',
    'apps/quoky/src/actor-identity-provisioner.ts': 'startup identities only, before any metadata writer runs',
    // Composition only: they hand the live repository to the store-backed writers (no write of their own).
    'apps/quoky/src/features/nl-selection.providers.ts': 'binds the live repository into NlActionSwitch / NlSelectionService (both write through the store)',
    'apps/quoky/src/features/surface-grants.providers.ts': 'binds the live repository into the ActorMetadataStore',
  };

  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) sources(path, out);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(path);
    }
    return out;
  }

  it('every `actors.save(` / repository save of an Actor is in an allowed file', () => {
    const offenders: string[] = [];
    for (const root of ['packages', 'apps']) {
      for (const file of sources(join(repoRoot, root))) {
        const rel = relative(repoRoot, file);
        if (rel.startsWith('packages/storage-sqlite/')) continue; // the repository itself
        const text = readFileSync(file, 'utf8');
        if (/actors\??\.save\s*\(|\.save\(\s*\{\s*\.\.\.actor\b/.test(text) && ALLOWED[rel] === undefined) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

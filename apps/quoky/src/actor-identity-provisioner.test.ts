import { describe, expect, it } from 'vitest';
import type { Actor, ActorRepository, ConnectorProvider, Id, LogFields, Logger, StorageProvider } from '@quoky/core';
import { WorkSurfaceQuery } from '@quoky/core';
import type { ActorIdentityMapping } from './config';
import { ActorIdentityProvisioner } from './actor-identity-provisioner';

const createdAt = '2026-09-01T00:00:00.000Z';

function actor(id: string, discordId: string, identities: Actor['identities'] = []): Actor {
  return { id, displayName: id, identities: [{ platform: 'discord', externalId: discordId }, ...identities], createdAt };
}

class FakeActorRepository implements ActorRepository {
  readonly values = new Map<Id, Actor>();
  saveCount = 0;

  constructor(actors: readonly Actor[]) {
    for (const value of actors) this.values.set(value.id, structuredClone(value));
  }

  async get(id: Id): Promise<Actor | null> { return this.values.get(id) ?? null; }
  async save(value: Actor): Promise<Actor> {
    this.saveCount += 1;
    this.values.set(value.id, structuredClone(value));
    return value;
  }
  async delete(id: Id): Promise<void> { this.values.delete(id); }
  async list(): Promise<Actor[]> { return [...this.values.values()]; }
  async findByExternalIdentity(platform: string, externalId: string): Promise<Actor | null> {
    return [...this.values.values()].find((value) =>
      value.identities.some((identity) => identity.platform === platform && identity.externalId === externalId)) ?? null;
  }
}

class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: LogFields }> = [];
  info(): void { /* not asserted */ }
  warn(message: string, fields?: LogFields): void { this.warnings.push({ message, ...(fields ? { fields } : {}) }); }
  error(): void { /* not asserted */ }
}

function provisioner(
  repository: FakeActorRepository,
  mappings: readonly ActorIdentityMapping[],
  log: Logger = new RecordingLogger(),
): ActorIdentityProvisioner {
  return new ActorIdentityProvisioner({ actors: repository } as unknown as StorageProvider, mappings, log);
}

function mapping(discordId: string, identities: ActorIdentityMapping['identities']): ActorIdentityMapping {
  return { actor: { platform: 'discord', externalId: discordId }, identities };
}

function connector(source: 'jira' | 'github', available = true): ConnectorProvider {
  return {
    source,
    readOnly: true,
    async isAvailable() { return available; },
    async query(input) {
      const externalId = input.params?.actorExternalId;
      return { source, items: [{ id: `${source}-item`, title: `${source}:${String(externalId)}` }] };
    },
  };
}

describe('ActorIdentityProvisioner', () => {
  it.each([
    ['Jira-only', { jira: 'jira-user' }, ['jira:jira-item']],
    ['GitHub-only', { github: 'octocat' }, ['github:github-item']],
    ['merged', { jira: 'jira-user', github: 'octocat' }, ['github:github-item', 'jira:jira-item']],
  ] as const)('makes the %s personal Work Surface reachable offline', async (_case, identities, expected) => {
    const repository = new FakeActorRepository([actor('actor-1', 'discord-1')]);
    await provisioner(repository, [mapping('discord-1', identities)]).provision();
    const provisioned = await repository.get('actor-1');
    const surface = await new WorkSurfaceQuery({ list: () => [connector('jira'), connector('github')] })
      .forActor(provisioned!);
    expect(surface.items.map((item) => item.resource.identity)).toEqual(expected);
    expect(surface.sources.filter((source) => source.status === 'AVAILABLE').map((source) => source.source))
      .toEqual(Object.keys(identities));
  });

  it('preserves omitted and inbound identities and repeated identical provisioning is an idempotent no-op', async () => {
    const repository = new FakeActorRepository([
      actor('actor-1', 'discord-1', [{ platform: 'jira', externalId: 'stored-jira' }]),
    ]);
    const service = provisioner(repository, [mapping('discord-1', { github: 'octocat' })]);
    await service.provision();
    await service.provision();
    expect((await repository.get('actor-1'))?.identities).toEqual([
      { platform: 'discord', externalId: 'discord-1' },
      { platform: 'jira', externalId: 'stored-jira' },
      { platform: 'github', externalId: 'octocat' },
    ]);
    expect(repository.saveCount).toBe(1);
  });

  it('preflights every mapping before writes and fails closed on a same-Actor platform conflict', async () => {
    const repository = new FakeActorRepository([
      actor('actor-1', 'discord-1', [{ platform: 'jira', externalId: 'stored-jira' }]),
    ]);
    await expect(provisioner(repository, [mapping('discord-1', { jira: 'different-jira' })]).provision())
      .rejects.toThrow('ACTOR_IDENTITY_PROVISIONING_PLATFORM_CONFLICT:jira');
    expect(repository.saveCount).toBe(0);
  });

  it('fails closed when the target identity belongs to another Actor', async () => {
    const repository = new FakeActorRepository([
      actor('actor-1', 'discord-1'),
      actor('actor-2', 'discord-2', [{ platform: 'github', externalId: 'octocat' }]),
    ]);
    await expect(provisioner(repository, [mapping('discord-1', { github: 'octocat' })]).provision())
      .rejects.toThrow('ACTOR_IDENTITY_PROVISIONING_TARGET_CONFLICT:github:octocat');
    expect(repository.saveCount).toBe(0);
  });

  it('skips a mapping whose Discord Actor is absent with a warning, never creating an Actor or crashing startup', async () => {
    const repository = new FakeActorRepository([]);
    const log = new RecordingLogger();
    await expect(provisioner(repository, [mapping('missing-discord-id', { jira: 'jira-user' })], log).provision())
      .resolves.toBeUndefined();
    expect(await repository.list()).toEqual([]);
    expect(repository.saveCount).toBe(0);
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]?.fields).toEqual({ platform: 'discord', mappingIndex: 0 });
    // The warning names the mapping position only; identifiers and values never reach the log.
    expect(JSON.stringify(log.warnings)).not.toContain('missing-discord-id');
    expect(JSON.stringify(log.warnings)).not.toContain('jira-user');
  });

  it('still provisions known Actors when another mapping is skipped', async () => {
    const repository = new FakeActorRepository([actor('actor-1', 'discord-1')]);
    const log = new RecordingLogger();
    await provisioner(repository, [
      mapping('unknown', { github: 'ghost' }),
      mapping('discord-1', { github: 'octocat' }),
    ], log).provision();
    expect((await repository.get('actor-1'))?.identities).toContainEqual({ platform: 'github', externalId: 'octocat' });
    expect(log.warnings.map((w) => w.fields?.mappingIndex)).toEqual([0]);
  });

  it('keeps connector availability failures separate from identity provisioning failures', async () => {
    const repository = new FakeActorRepository([actor('actor-1', 'discord-1')]);
    await provisioner(repository, [mapping('discord-1', { jira: 'jira-user', github: 'octocat' })]).provision();
    const surface = await new WorkSurfaceQuery({ list: () => [connector('jira'), connector('github', false)] })
      .forActor((await repository.get('actor-1'))!);
    expect(surface.sources).toEqual([
      expect.objectContaining({ source: 'jira', status: 'AVAILABLE' }),
      expect.objectContaining({ source: 'github', status: 'UNAVAILABLE' }),
    ]);
    expect(surface.sources.every((source) => source.status !== 'IDENTITY_MISSING')).toBe(true);
  });
});

describe('ActorIdentityProvisioner — ADR-0114 D3 platform identity links (Telegram owner → Discord owner Actor)', () => {
  const TELEGRAM = '5550001';
  const link = (telegramId: string, discordId: string) => ({
    identity: { platform: 'telegram', externalId: telegramId },
    owner: { platform: 'discord', externalId: discordId },
  });
  const linked = (repository: FakeActorRepository, links: ReturnType<typeof link>[]) =>
    new ActorIdentityProvisioner({ actors: repository } as unknown as StorageProvider, [], new RecordingLogger(), links);

  it('adds the Telegram identity to the existing Discord owner Actor, so both resolve to one Actor; idempotent', async () => {
    const repository = new FakeActorRepository([actor('owner-actor', '111'), actor('other-actor', '222')]);
    await linked(repository, [link(TELEGRAM, '111')]).provision();
    const viaTelegram = await repository.findByExternalIdentity('telegram', TELEGRAM);
    const viaDiscord = await repository.findByExternalIdentity('discord', '111');
    expect(viaTelegram?.id).toBe('owner-actor');
    expect(viaDiscord?.id).toBe('owner-actor');
    expect(repository.values.size).toBe(2);
    const saves = repository.saveCount;
    await linked(repository, [link(TELEGRAM, '111')]).provision();
    expect(repository.saveCount).toBe(saves);
  });

  it('a fresh install creates the one owner Actor with both identities (never a second Telegram Actor)', async () => {
    const repository = new FakeActorRepository([]);
    await linked(repository, [link(TELEGRAM, '111')]).provision();
    expect(repository.values.size).toBe(1);
    const [owner] = [...repository.values.values()];
    expect(owner?.identities).toEqual([
      { platform: 'discord', externalId: '111' },
      { platform: 'telegram', externalId: TELEGRAM },
    ]);
    expect(owner?.displayName).toBe('111');
  });

  it('a Telegram identity held by ANOTHER Actor is a startup error, never a silent merge (no write)', async () => {
    const repository = new FakeActorRepository([
      actor('owner-actor', '111'),
      { id: 'stray', displayName: 'stray', identities: [{ platform: 'telegram', externalId: TELEGRAM }], createdAt },
    ]);
    await expect(linked(repository, [link(TELEGRAM, '111')]).provision()).rejects.toThrow('ACTOR_IDENTITY_PROVISIONING_TARGET_CONFLICT:telegram');
    expect(repository.saveCount).toBe(0);
  });
});

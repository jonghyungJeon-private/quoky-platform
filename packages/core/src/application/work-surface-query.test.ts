import { describe, expect, it } from 'vitest';
import type { Actor } from '../domain';
import type { ConnectorProvider } from '../ports';
import { WorkSurfaceQuery } from './work-surface-query';

const actor: Actor = {
  id: 'actor-1',
  displayName: 'Quoky',
  identities: [
    { platform: 'discord', externalId: 'discord-1' },
    { platform: 'jira', externalId: 'jira-user' },
    { platform: 'github', externalId: 'octocat' },
  ],
  createdAt: '2026-08-31T00:00:00.000Z',
};

function connector(
  source: string,
  items: Array<{ id: string; title: string; url?: string }> = [],
  options: { available?: boolean; fail?: boolean } = {},
): ConnectorProvider {
  return {
    source,
    readOnly: true,
    async isAvailable() { return options.available ?? true; },
    async query(input) {
      expect(input).toEqual({ query: 'personal-work', params: { actorExternalId: source === 'jira' ? 'jira-user' : 'octocat' } });
      if (options.fail) throw new Error('offline');
      return { source, items };
    },
  };
}

function query(connectors: readonly ConnectorProvider[]): WorkSurfaceQuery {
  return new WorkSurfaceQuery({ list: () => connectors });
}

describe('WorkSurfaceQuery', () => {
  it('normalizes and deterministically merges Jira + GitHub personal work', async () => {
    const surface = await query([
      connector('jira', [{ id: 'J-2', title: 'Zulu' }, { id: 'J-1', title: 'Alpha' }]),
      connector('github', [{ id: '20', title: 'Beta', url: 'https://github.com/o/r/issues/20' }]),
    ]).forActor(actor);

    expect(surface.status).toBe('COMPLETE');
    expect(surface.items.map((item) => item.resource.identity)).toEqual(['github:20', 'jira:J-1', 'jira:J-2']);
    expect(surface.items[0]).toMatchObject({ title: 'Beta', url: 'https://github.com/o/r/issues/20' });
    expect(surface.sources.map((source) => source.status)).toEqual(['AVAILABLE', 'AVAILABLE']);
  });

  it.each([
    ['jira', [connector('jira', [{ id: 'J-1', title: 'Jira task' }])]],
    ['github', [connector('github', [{ id: '1', title: 'GitHub task' }])]],
  ] as const)('returns a %s-only surface with explicit partial availability', async (_source, connectors) => {
    const surface = await query(connectors).forActor(actor);
    expect(surface.status).toBe('PARTIAL');
    expect(surface.items).toHaveLength(1);
    expect(surface.sources).toContainEqual(expect.objectContaining({ status: 'NOT_CONFIGURED' }));
  });

  it('does not silently report no work when one configured source is unavailable', async () => {
    const surface = await query([
      connector('jira', []),
      connector('github', [], { available: false }),
    ]).forActor(actor);
    expect(surface).toMatchObject({ status: 'PARTIAL', items: [] });
    expect(surface.sources).toContainEqual(expect.objectContaining({ source: 'github', status: 'UNAVAILABLE' }));
  });

  it('keeps the available source when the other connector query fails', async () => {
    const surface = await query([
      connector('jira', [{ id: 'J-1', title: 'Jira task' }]),
      connector('github', [], { fail: true }),
    ]).forActor(actor);
    expect(surface.status).toBe('PARTIAL');
    expect(surface.items.map((item) => item.resource.identity)).toEqual(['jira:J-1']);
    expect(surface.sources[1]).toMatchObject({ source: 'github', status: 'UNAVAILABLE' });
  });

  it('reports both sources unavailable when no connectors are configured', async () => {
    const surface = await query([]).forActor(actor);
    expect(surface.status).toBe('UNAVAILABLE');
    expect(surface.items).toEqual([]);
    expect(surface.sources.every((source) => source.status === 'NOT_CONFIGURED')).toBe(true);
  });

  it('reports a missing Actor identity without fabricating or auto-linking one', async () => {
    const withoutGithub = { ...actor, identities: actor.identities.filter((identity) => identity.platform !== 'github') };
    const github = connector('github', [{ id: '1', title: 'must not query' }]);
    const surface = await query([connector('jira'), github]).forActor(withoutGithub);
    expect(surface.status).toBe('PARTIAL');
    expect(surface.sources[1]).toMatchObject({ source: 'github', status: 'IDENTITY_MISSING' });
  });
});

describe('WorkSurfaceQuery — ADR-0122 D2.4 `sources` (P2)', () => {
  it('reads only the listed sources (a withheld connector is never queried); the status is over the sources read', async () => {
    let githubQueries = 0;
    const github = connector('github', [{ id: '1', title: 'GitHub task' }]);
    const counted: ConnectorProvider = { ...github, async query(input) { githubQueries += 1; return github.query(input); } };
    const surface = await query([connector('jira', [{ id: 'J-1', title: 'Jira task' }]), counted]).forActor(actor, { sources: ['jira'] });
    expect(githubQueries).toBe(0);
    expect(surface.status).toBe('COMPLETE');
    expect(surface.sources.map((source) => source.source)).toEqual(['jira']);
    expect(surface.items.map((item) => item.resource.identity)).toEqual(['jira:J-1']);
  });
});

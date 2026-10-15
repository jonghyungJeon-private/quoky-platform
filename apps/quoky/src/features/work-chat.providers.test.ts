import { describe, expect, it } from 'vitest';
import { WorkChatService, parseJiraReleaseLinks, type Actor, type ConnectorProvider, type ConnectorQuery } from '@quoky/core';
import { createWorkChatProviders } from './work-chat.providers';

/**
 * ADR-0120 amendment A8: the composition hands the configured Jira site host to the work desk, so a release link is used
 * only when it points at that site. Offline: a scripted connector, no network.
 */

const LINK = 'https://example.atlassian.net/projects/OP26/versions/16555/tab/release-report-all-issues';
const ACTOR = { id: 'actor-1', identities: [] } as unknown as Actor;

function deskWith(jiraSiteHost: string | undefined): { desk: WorkChatService; queries: ConnectorQuery[] } {
  const queries: ConnectorQuery[] = [];
  const jira: ConnectorProvider = {
    source: 'jira',
    readOnly: true,
    async isAvailable() {
      return true;
    },
    async query(query) {
      queries.push(query);
      return { source: 'jira', items: [] };
    },
  };
  const providers = createWorkChatProviders(() => ({ summaryEnabled: false }) as never, jiraSiteHost === undefined ? {} : { jiraSiteHost: () => jiraSiteHost });
  const factory = providers.find((provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === WorkChatService) as { useFactory: (...args: unknown[]) => WorkChatService };
  const desk = factory.useFactory({ summaryEnabled: false }, { forActor: async () => ({}) }, { list: () => [jira] }, {});
  return { desk, queries };
}

describe('work-chat composition (ADR-0120 A8): the Jira site host gates release links', () => {
  it('reads the linked release on the configured site by its key and id', async () => {
    const { desk, queries } = deskWith('https://example.atlassian.net');
    await desk.handle({ kind: 'release', source: 'jira', scope: 'all', links: parseJiraReleaseLinks(LINK) }, ACTOR);
    expect(queries.map((query) => query.query)).toEqual(['releases', 'release-items']);
    expect(queries[1]?.params).toEqual({ container: 'OP26', releaseId: '16555', limit: 20 });
  });

  it('without a configured site (or on another host) the link is ignored and nothing is read', async () => {
    for (const host of [undefined, 'other.atlassian.net']) {
      const { desk, queries } = deskWith(host);
      const outcome = await desk.handle({ kind: 'release', source: 'jira', scope: 'all', links: parseJiraReleaseLinks(LINK) }, ACTOR);
      expect(queries).toEqual([]);
      expect(outcome).toMatchObject({ kind: 'reply' });
      expect((outcome as { text: string }).text).toContain('그 링크는 열지 않았어요');
    }
  });
});
